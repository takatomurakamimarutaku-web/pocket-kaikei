// 固定資産の登録・編集（償却の予定を表示しながら入力する）
import { h, put, field, showErrors, showToast, confirmDialog, amountCell } from '../ui.js';
import {
  ASSET_CATEGORIES,
  CATEGORY_BY_ID,
  METHODS,
  usesLife,
  methodVariant,
  ratesFor,
  NEW_METHOD_FROM,
  smeLimit,
  validateAsset,
  depreciationSchedule,
  formatRate,
  defaultAssetAccount,
  EXPENSE_GROUPS,
} from '../depreciation.js';
import { LIFE_PRESETS, usedAssetLife, canDispose, findDisposalJournals, canAddCapex, capexDefaults } from '../asset-tools.js';
import { formatYen } from '../money.js';
import { compareAccounts } from '../accounts.js';
import { parseYen } from '../money.js';
import { todayString } from '../period.js';
import { createAsset } from '../models.js';
import { ValidationError } from '../db.js';
import { errorText } from '../errors.js';

const slash = (d) => d.replaceAll('-', '/');
/** 半角・全角の数字だけの入力を整数に（それ以外は null） */
const toInt = (v) => {
  const t = String(v).trim().replace(/[０-９]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0));
  return /^\d+$/.test(t) ? Number(t) : null;
};

export async function render({ app, outlet, params, query = {} }) {
  const { settings, period, accounts, journals } = await app.load();
  const [assets, periods] = await Promise.all([app.db.listAssets(), app.db.listPeriods()]);
  const individual = settings.entityType === 'individual';
  const original = params.id ? assets.find((a) => a.id === params.id) : null;
  if (params.id && !original) {
    put(outlet, h('p', { class: 'empty', text: '固定資産が見つかりません' }));
    return;
  }
  const today = todayString();
  const defaultDate = today >= period.startDate && today <= period.endDate ? today : period.endDate;
  // 資本的支出の追加（#/asset/new?parent=元の資産）：元の資産と種類・耐用年数・科目を同じにする
  const capexParent = !original && query.parent ? assets.find((a) => a.id === query.parent && canAddCapex(a)) : null;
  const state = original
    ? { ...original }
    : capexParent
      ? createAsset(capexDefaults(capexParent, defaultDate))
      : createAsset({ acquiredOn: defaultDate, startedOn: defaultDate, method: individual ? 'straight' : 'declining', usefulLife: 4, businessRatio: 100 });
  const byId = new Map(assets.map((a) => [a.id, a]));
  const parent = state.parentId ? byId.get(state.parentId) : null;
  const children = original ? assets.filter((a) => a.parentId === original.id) : [];
  // 一部を売却・除却した資産（分けた元・分けた資産）は、償却の計算に使う項目を変えられない
  const splitLocked = Boolean(original && (original.splits?.length || original.splitFrom));

  const accountsFor = (catId) => {
    const group = CATEGORY_BY_ID[catId]?.intangible ? 'intangible_fixed_assets' : 'tangible_fixed_assets';
    return accounts.filter((a) => a.group === group && a.normalSide === 'debit' && (a.active || a.id === state.accountId)).sort(compareAccounts);
  };

  const name = h('input', { id: 'f-name', type: 'text', maxlength: 40, value: state.name, placeholder: '例：ノートパソコン、軽自動車' });
  const category = h('select', { id: 'f-category' }, ASSET_CATEGORIES.map((c) => h('option', { value: c.id, text: c.label, selected: c.id === state.category })));
  const account = h('select', { id: 'f-account' });
  const acquiredOn = h('input', { id: 'f-acquired', type: 'date', value: state.acquiredOn });
  const startedOn = h('input', { id: 'f-started', type: 'date', value: state.startedOn });
  const cost = h('input', { id: 'f-cost', type: 'text', inputmode: 'numeric', class: 'amount-input', value: state.cost ? String(state.cost) : '', placeholder: '0' });
  const method = h('select', { id: 'f-method' }, METHODS.map((m) => h('option', { value: m.id, text: m.label, selected: m.id === state.method })));
  const life = h('input', { id: 'f-life', type: 'text', inputmode: 'numeric', maxlength: 2, value: state.usefulLife ?? '' });
  const ratio = h('input', { id: 'f-ratio', type: 'text', inputmode: 'numeric', maxlength: 3, value: state.businessRatio ?? 100 });
  const disposedOn = h('input', { id: 'f-disposed', type: 'date', value: state.disposedOn || '' });
  const firstStart = periods[0]?.startDate ?? period.startDate; // アプリで最初の会計期間の期首
  const carryOn = state.carryOn || firstStart;
  const carryBook = h('input', { id: 'f-carry-book', type: 'text', inputmode: 'numeric', class: 'amount-input', value: state.carryBook ?? '', placeholder: '空欄なら計算した額' });
  const carryRevised = h('input', { id: 'f-carry-revised', type: 'text', inputmode: 'numeric', class: 'amount-input', value: state.carryRevisedBase ?? '', placeholder: '切り替えていなければ空欄' });
  const memo = h('input', { id: 'f-memo', type: 'text', maxlength: 100, value: state.memo || '' });
  const assetNo = h('input', { id: 'f-no', type: 'text', maxlength: 20, value: state.assetNo || '', placeholder: '例：A-001' });
  const quantity = h('input', { id: 'f-qty', type: 'text', inputmode: 'numeric', maxlength: 5, value: state.quantity ?? 1 });
  const location = h('input', { id: 'f-location', type: 'text', maxlength: 40, value: state.location || '', placeholder: '例：本店、倉庫' });
  // 特別償却（事業供用年度に 取得価額×率。即時償却は100）
  const specialRate = h('input', { id: 'f-special-rate', type: 'text', inputmode: 'numeric', maxlength: 3, value: state.specialRate ?? '', placeholder: '例：30' });
  const specialName = h('input', { id: 'f-special-name', type: 'text', maxlength: 40, value: state.specialName || '', placeholder: '例：中小企業投資促進税制' });
  // 償却費の科目（製造原価を使うときか、選んであるときだけ出す）
  const showExpense = Boolean(settings.manufacturing || state.expenseAccountId);
  const expense = showExpense
    ? h(
        'select',
        { id: 'f-expense' },
        h('option', { value: '', text: '減価償却費（販売費及び一般管理費）', selected: !state.expenseAccountId }),
        accounts
          .filter((a) => EXPENSE_GROUPS.includes(a.group) && a.normalSide === 'debit' && a.hint !== 'depreciation' && (a.active || a.id === state.expenseAccountId))
          .sort(compareAccounts)
          .map((a) => h('option', { value: a.id, text: `${a.code} ${a.name}`, selected: a.id === state.expenseAccountId })),
      )
    : null;
  // 耐用年数表から選ぶ：種類と耐用年数を入れる
  const preset = h(
    'select',
    { id: 'f-preset', 'aria-label': '耐用年数表から選ぶ' },
    h('option', { value: '', text: '耐用年数表から選ぶ（任意）' }),
    ASSET_CATEGORIES.map((c) => {
      const items = LIFE_PRESETS.map((p, i) => [p, i]).filter(([p]) => p.category === c.id);
      return items.length ? h('optgroup', { label: c.label }, items.map(([p, i]) => h('option', { value: String(i), text: `${p.label}　${p.life}年` }))) : null;
    }),
  );
  // 中古資産の耐用年数（簡便法）
  const usedLegal = h('input', { id: 'f-used-legal', type: 'text', inputmode: 'numeric', maxlength: 2, placeholder: '例：6' });
  const usedYears = h('input', { id: 'f-used-years', type: 'text', inputmode: 'numeric', maxlength: 2, placeholder: '0' });
  const usedMonths = h('input', { id: 'f-used-months', type: 'text', inputmode: 'numeric', maxlength: 2, placeholder: '0' });
  const usedResult = h('p', { class: 'field-hint', 'aria-live': 'polite' });
  const methodHint = h('p', { class: 'field-hint' });
  const rateHint = h('p', { class: 'field-hint' });
  const preview = h('div');
  let startedTouched = Boolean(original);

  function paintAccounts(fromCategory = false) {
    const list = accountsFor(category.value);
    if (fromCategory || !list.some((a) => a.id === state.accountId)) state.accountId = defaultAssetAccount(settings.entityType, category.value, list);
    put(account, list.length ? list.map((a) => h('option', { value: a.id, text: `${a.code} ${a.name}`, selected: a.id === state.accountId })) : h('option', { value: '', text: '科目がありません（勘定科目の画面で追加）' }));
  }

  /** 入力欄から資産のレコードを作る（金額が不正なら cost は NaN） */
  function read() {
    const p = parseYen(cost.value || '0');
    return {
      ...state,
      name: name.value.trim(),
      category: category.value,
      accountId: account.value,
      acquiredOn: acquiredOn.value,
      startedOn: startedOn.value,
      cost: p.ok ? p.value : NaN,
      method: method.value,
      usefulLife: usesLife(method.value) ? toInt(life.value) : null,
      businessRatio: individual ? toInt(ratio.value) : 100,
      disposedOn: disposedOn.value || null,
      ...readCarry(),
      memo: memo.value.trim(),
      assetNo: assetNo.value.trim(),
      quantity: toInt(quantity.value) ?? NaN,
      location: location.value.trim(),
      expenseAccountId: expense ? expense.value || null : (state.expenseAccountId ?? null),
      ...readSpecial(),
    };
  }

  /** 特別償却の入力（率が空欄なら受けない。数字でなければ NaN にして検証で止める） */
  function readSpecial() {
    if (specialWrap.hidden || (!specialRate.value.trim() && !specialName.value.trim())) return { specialRate: null, specialName: null };
    return { specialRate: specialRate.value.trim() === '' ? null : (toInt(specialRate.value) ?? NaN), specialName: specialName.value.trim() || null };
  }

  /** 引き継ぎの入力（空欄なら引き継がない。数字でなければ NaN にして検証で止める） */
  function readCarry() {
    const none = { carryOn: null, carryBook: null, carryRevisedBase: null };
    if (carryWrap.hidden || !carryBook.value.trim()) return none;
    const yen = (v) => (v.trim() === '' ? null : (toInt(v) ?? NaN));
    return { carryOn, carryBook: yen(carryBook.value), carryRevisedBase: method.value === 'declining' ? yen(carryRevised.value) : null };
  }

  function paint() {
    carryWrap.hidden = !usesLife(method.value) || !(startedOn.value && startedOn.value < firstStart);
    revisedWrap.hidden = method.value !== 'declining';
    const a = read();
    lifeWrap.hidden = !usesLife(a.method);
    usedWrap.hidden = !usesLife(a.method);
    specialWrap.hidden = !usesLife(a.method) || Boolean(a.startedOn && a.startedOn < NEW_METHOD_FROM);
    const limit = smeLimit(a.acquiredOn || today);
    const variant = a.startedOn && a.acquiredOn ? methodVariant(a) : a.method;
    const hints = {
      straight: '毎年同じ額を償却します。届出をしていない個人は定額法です。',
      declining: '最初の年ほど多く償却します（200%定率法）。届出をしていない法人の機械・車両・器具備品は定率法です。個人は届出が必要です。',
      old_straight: '平成19年3月31日以前に使い始めた資産は旧定額法です：（取得価額−残存価額10%）×償却率。償却費の累計が取得価額の95%に達したら、翌年から5年間で1円まで均等に償却します。',
      old_declining: '平成19年3月31日以前に使い始めた資産は旧定率法です：期首の帳簿価額×償却率。償却費の累計が取得価額の95%に達したら、翌年から5年間で1円まで均等に償却します。',
      declining250: '平成19年4月1日〜平成24年3月31日に取得した資産は250%定率法です。最初の年ほど多く償却し、償却保証額を下回った年から改定償却率で償却します。',
      lump3: '取得価額20万円未満のものを、使い始めた年から3年間、1/3ずつ経費にします（月数で按分しません）。',
      small: '取得価額10万円未満（または使える期間が1年未満）のものは、使い始めた年に全額を経費にします。',
      sme: `青色申告の中小企業者等が、取得価額${limit / 10000}万円未満のものを使い始めた年に全額を経費にできます（年300万円まで。令和8年4月以後の取得は40万円未満）。`,
    };
    methodHint.textContent = hints[variant] || hints[a.method] || '';
    const rates = usesLife(a.method) && a.startedOn && a.acquiredOn ? ratesFor(a) : null;
    const variantName = { old_straight: '旧定額法', old_declining: '旧定率法', declining250: '250%定率法', declining200: '200%定率法', straight: '定額法' }[variant] ?? '';
    rateHint.textContent = rates
      ? variant === 'declining250' || variant === 'declining200'
        ? `${variantName}：償却率 ${formatRate(rates.rate)}・改定償却率 ${rates.revised ? formatRate(rates.revised) : '－'}・保証率 ${rates.guarantee ? formatRate(rates.guarantee, 5) : '－'}`
        : `${variantName}：償却率 ${formatRate(rates.rate)}`
      : '耐用年数は国税庁の耐用年数表で確認してください（例：パソコン4年、普通自動車6年、軽自動車4年）';
    const errors = validateAsset(a, { entityType: settings.entityType, accounts });
    if (Object.keys(errors).length) {
      put(preview, h('p', { class: 'muted small', text: '入力を終えると、年ごとの償却費を表示します。' }));
      return;
    }
    const rows = depreciationSchedule(a, periods);
    const hasSpecial = rows.some((r) => r.special);
    put(
      preview,
      h('h2', { class: 'section-title', text: '償却の予定' }),
      h(
        'div',
        { class: 'table-wrap' },
        h(
          'table',
          { class: 'report' },
          h('thead', {}, h('tr', {}, h('th', { scope: 'col', text: '期間' }), h('th', { scope: 'col', text: '月数' }), h('th', { scope: 'col', text: '償却費' }), hasSpecial ? h('th', { scope: 'col', text: 'うち特別償却' }) : null, individual ? h('th', { scope: 'col', text: '経費' }) : null, h('th', { scope: 'col', text: '期末残高' }))),
          h(
            'tbody',
            {},
            rows.map((r) =>
              h(
                'tr',
                { class: r.startDate === period.startDate ? 'mt-strong' : '' },
                h('th', { scope: 'row', class: 'nowrap', text: `${slash(r.startDate).slice(0, 7)}〜${slash(r.endDate).slice(0, 7)}${r.switched ? ' ※' : ''}${r.equal ? ' ＊' : ''}` }),
                h('td', { class: 'num', text: String(r.months) }),
                amountCell('td', r.amount),
                hasSpecial ? (r.special ? amountCell('td', r.special) : h('td')) : null,
                individual ? amountCell('td', r.business) : null,
                amountCell('td', r.closing),
              ),
            ),
          ),
        ),
      ),
      rows.some((r) => r.switched) ? h('p', { class: 'muted small', text: '※ 償却保証額を下回ったため、改定取得価額×改定償却率で計算しています。' }) : null,
      rows.some((r) => r.equal) ? h('p', { class: 'muted small', text: '＊ 償却費の累計が取得価額の95%に達した翌年から、5年間で1円まで均等に償却しています（（取得価額×5%−1円）÷5。5年で1円になるよう1円未満は切り上げ）。' }) : null,
      hasSpecial ? h('p', { class: 'muted small', text: `特別償却（${a.specialName}）は、使い始めた期間に取得価額×${a.specialRate}%（即時償却は取得価額−普通償却費）を普通償却に加えています。月数では按分しません。` }) : null,
      a.startedOn < firstStart && !a.carryBook ? h('p', { class: 'muted small', text: 'アプリで帳簿をつける前の年分も、同じ方法で計算した額としています。前の会計ソフトや前年の決算書と帳簿価額が違うときは、「前の帳簿からの引き継ぎ」に期首の帳簿価額を入れてください。' }) : null,
    );
  }

  const lifeWrap = h('div', {}, field('耐用年数（年）', life, { name: 'usefulLife' }), rateHint);
  const specialWrap = h(
    'details',
    { class: 'used-box', open: state.specialRate ? true : null },
    h('summary', { text: '特別償却を受ける（任意）' }),
    h('div', { class: 'field-row' }, field('特別償却の率（%）', specialRate, { name: 'specialRate', hint: '即時償却は100' }), field('制度の名前', specialName, { name: 'specialName' })),
    h('p', { class: 'muted small', text: '使い始めた期間に 取得価額×率 を普通償却に加えます（中小企業投資促進税制は30%、中小企業経営強化税制の即時償却は100：取得価額−普通償却費。国税庁 No.5433・No.5434）。対象の資産・期限・中小企業者等の要件は、制度ごとに確かめてください。特別償却不足額の繰越し・準備金方式には対応していません。' }),
  );
  const usedWrap = h(
    'details',
    { class: 'used-box' },
    h('summary', { text: '中古で買った資産の耐用年数を計算する' }),
    h('div', { class: 'field-row' }, field('新品の耐用年数（年）', usedLegal), h('div', { class: 'field' }, h('span', { class: 'field-label', text: '経過した期間' }), h('div', { class: 'inline-inputs' }, usedYears, h('span', { text: '年' }), usedMonths, h('span', { text: 'か月' })))),
    usedResult,
    h('button', { type: 'button', class: 'btn btn-block', text: '計算して耐用年数に入れる', onclick: () => applyUsedLife() }),
    h('p', { class: 'muted small', text: '簡便法：（新品の耐用年数−経過年数）＋経過年数×20%（全部経過していれば新品の耐用年数×20%）。1年未満は切り捨て、2年未満は2年。使い始めた年にだけ使えます。改良費が取得価額の50%を超えるときは使えません（国税庁 No.5404）。' }),
  );
  function usedLife() {
    const y = toInt(usedYears.value || '0');
    const m = toInt(usedMonths.value || '0');
    return y === null || m === null || m > 11 ? null : usedAssetLife(toInt(usedLegal.value), y * 12 + m);
  }
  function applyUsedLife() {
    const n = usedLife();
    if (n === null) {
      usedResult.textContent = '新品の耐用年数と経過した期間（年・0〜11か月）を数字で入れてください';
      return;
    }
    life.value = String(n);
    usedResult.textContent = `耐用年数を${n}年にしました`;
    paint();
  }
  for (const el of [usedLegal, usedYears, usedMonths]) {
    el.addEventListener('input', (e) => {
      e.stopPropagation();
      const n = usedLife();
      usedResult.textContent = n === null ? '' : `計算した耐用年数：${n}年`;
    });
  }
  // 売却・除却：仕訳も作る画面へ。売却・除却の処理済みなら内容と取り消し
  const disposals = original ? findDisposalJournals(journals, original.id) : [];
  const disposedField = field('除却・売却した日（任意）', disposedOn, { name: 'disposedOn', hint: 'その月までの月数で償却し、以後は償却しません。仕訳も作るときは「売却・除却する」から処理してください' });
  const disposalBox = original?.disposalType
    ? h(
        'section',
        { class: 'panel disposal-done' },
        h('h3', { class: 'section-title', text: original.disposalType === 'sell' ? '売却済み' : '除却済み' }),
        h('p', { class: 'small', text: `${slash(original.disposedOn)} に${original.disposalType === 'sell' ? `${(original.salePrice ?? 0).toLocaleString('ja-JP')}円で売却` : '除却'}しました。` }),
        disposals.length ? h('p', { class: 'small' }, '仕訳：', disposals.map((j) => h('a', { class: 'link', href: `#/journal/${encodeURIComponent(j.id)}/edit`, text: `No.${j.no} ` }))) : h('p', { class: 'muted small', text: '仕訳はありません（この期間に登録していない、または帳簿価額が0円）。' }),
        h('button', { type: 'button', class: 'btn btn-danger-text', text: '売却・除却を取り消す', onclick: undoDisposal }),
      )
    : h('div', {}, splitLocked ? null : disposedField, original && canDispose(original) ? h('a', { class: 'btn btn-block', href: `#/asset/${encodeURIComponent(original.id)}/dispose`, text: '売却・除却する（全部・一部。仕訳も作る）' }) : null);
  const revisedWrap = h('div', {}, field('改定取得価額（定率法で切り替え済みのとき）', carryRevised, { name: 'carryRevisedBase', hint: '前の帳簿で改定償却率に切り替えていれば、切り替えた年の期首帳簿価額。空欄なら、引き継いだ年に償却保証額を下回ったときにその年の期首帳簿価額で切り替えます' }));
  const carryWrap = h(
    'fieldset',
    { class: 'carry-box' },
    h('legend', { text: '前の帳簿からの引き継ぎ（任意）' }),
    field(`${slash(carryOn)} の期首の帳簿価額（円）`, carryBook, { name: 'carryBook', hint: 'アプリを使う前から持っている資産は、前の会計ソフトや前年の決算書（減価償却費の計算の「未償却残高」）の金額を入れると、そこから償却を続けます' }),
    revisedWrap,
  );
  const link = (a) => h('a', { class: 'link', href: `#/asset/${encodeURIComponent(a.id)}`, text: a.name });
  // 資本的支出・一部の売却除却の関係
  const relationBox = h(
    'div',
    { class: 'field', dataset: { field: 'parentId' } },
    parent ? h('p', { class: 'notice' }, h('span', {}, link(parent), ' の資本的支出です。元の資産と同じ種類・耐用年数で、使い始めた日から新たな資産として償却します（国税庁 No.2107）。')) : null,
    state.parentId && !parent ? h('p', { class: 'notice', text: '資本的支出の元の資産が見つかりません。' }) : null,
    original?.splitFrom ? h('p', { class: 'notice' }, h('span', {}, byId.get(original.splitFrom) ? link(byId.get(original.splitFrom)) : '元の資産', ` から ${original.carryOn ? `${slash(original.carryOn)} の期首に` : ''}分けた一部です。取り消すと元の資産に戻ります。`)) : null,
    original?.splits?.length
      ? h(
          'div',
          { class: 'notice block' },
          h('p', { text: `一部を売却・除却しています（取得価額は今の額 ${formatYen(original.cost)}円）。` }),
          h('ul', { class: 'small' }, original.splits.map((sp) => h('li', {}, `${slash(sp.date)}：取得価額 ${formatYen(sp.cost)}円${sp.quantity ? `・${sp.quantity}個` : ''} `, byId.get(sp.id) ? link(byId.get(sp.id)) : null))),
          h('p', { class: 'small', text: '取得価額・日付・償却の方法などは変えられません。直すときは、分けた資産の画面で売却・除却を取り消してください。' }),
        )
      : null,
    h('p', { class: 'field-error', role: 'alert' }),
  );
  const capexBox =
    original && (children.length || canAddCapex(original))
      ? h(
          'section',
          { class: 'panel' },
          h('h3', { class: 'section-title', text: '資本的支出' }),
          children.length ? h('ul', { class: 'small' }, children.map((c) => h('li', {}, link(c), ` ${slash(c.startedOn)}・${formatYen(c.cost)}円`))) : h('p', { class: 'muted small', text: '使える期間を延ばしたり価値を高めたりする改良の支出（資本的支出）は、新たな資産として償却します。通常の修理・維持は修繕費です。' }),
          canAddCapex(original) ? h('a', { class: 'btn btn-block', href: `#/asset/new?parent=${encodeURIComponent(original.id)}`, text: '資本的支出を追加する' }) : null,
        )
      : null;
  const form = h(
    'form',
    { novalidate: true, onsubmit: (e) => (e.preventDefault(), save()), oninput: paint, onchange: paint },
    relationBox,
    field('名前', name, { name: 'name' }),
    h('div', { class: 'field' }, preset),
    h('div', { class: 'field-row' }, field('種類', category, { name: 'category' }), field('勘定科目', account, { name: 'accountId' })),
    h('div', { class: 'field-row' }, field('取得日', acquiredOn, { name: 'acquiredOn' }), field('使い始めた日', startedOn, { name: 'startedOn' })),
    field('取得価額（円）', cost, { name: 'cost', hint: 'このアプリは税込経理なので、消費税を含んだ金額で入力します（10万円・20万円などの判定も税込）' }),
    h('div', { class: 'field', dataset: { field: 'method' } }, h('label', { class: 'field-label', for: 'f-method', text: '償却の方法' }), method, methodHint, h('p', { class: 'field-error', role: 'alert' })),
    lifeWrap,
    usedWrap,
    specialWrap,
    expense ? field('償却費の科目', expense, { name: 'expenseAccountId', hint: '工場の機械など、製品を作るために使う資産は製造経費の「減価償却費（製造）」にすると、製造原価報告書に入ります' }) : null,
    individual ? field('事業で使う割合（%）', ratio, { name: 'businessRatio', hint: '車などを私用にも使うときは、事業で使う割合を入れます。残りは事業主貸になります' }) : null,
    carryWrap,
    disposalBox,
    h('div', { class: 'field-row' }, field('資産番号（任意）', assetNo, { name: 'assetNo' }), field('数量', quantity, { name: 'quantity' })),
    field('設置場所（任意）', location, { name: 'location' }),
    field('メモ（任意）', memo, { name: 'memo' }),
    h('button', { type: 'submit', class: 'btn btn-primary btn-block', text: original ? '保存する' : '登録する' }),
  );
  category.addEventListener('change', () => paintAccounts(true));
  preset.addEventListener('change', () => {
    const p = LIFE_PRESETS[Number(preset.value)];
    if (!preset.value || !p) return;
    category.value = p.category;
    paintAccounts(true);
    if (!usesLife(method.value)) method.value = individual ? 'straight' : CATEGORY_BY_ID[p.category].decliningUntil ? 'straight' : 'declining';
    life.value = String(p.life);
    usedLegal.value = String(p.life);
    if (!name.value.trim()) name.value = p.label.replace(/（.*$/, '').slice(0, 40);
    paint();
  });
  account.addEventListener('change', () => (state.accountId = account.value));
  startedOn.addEventListener('input', () => (startedTouched = true));
  acquiredOn.addEventListener('input', () => {
    if (!startedTouched) startedOn.value = acquiredOn.value;
  });

  paintAccounts();
  if (state.parentId) {
    category.disabled = true;
    life.disabled = true;
    preset.hidden = true;
  }
  if (splitLocked) {
    for (const el of [category, acquiredOn, startedOn, cost, method, life, carryBook, carryRevised, specialRate, preset]) el.disabled = true;
    usedWrap.hidden = true;
  }
  put(
    outlet,
    form,
    h('section', { class: 'panel' }, preview),
    capexBox,
    original ? h('div', { class: 'actions' }, h('button', { type: 'button', class: 'btn btn-danger-text', text: 'この固定資産を削除', onclick: remove })) : null,
  );
  paint();

  async function save() {
    const record = read();
    try {
      await app.db.saveAsset(record);
      showToast(original ? '保存しました' : `「${record.name}」を登録しました`);
      app.goBack('#/assets');
    } catch (e) {
      if (e instanceof ValidationError && !Array.isArray(e.errors)) showErrors(form, e.errors);
      else showToast(errorText(e, '保存'));
    }
  }

  async function undoDisposal() {
    const ok = await confirmDialog({
      title: '売却・除却を取り消しますか？',
      message: original.splitFrom ? '売却・除却の仕訳を削除し、この資産を元の資産に戻します（取得価額・数量を元の資産に足します）。' : '売却・除却の仕訳を削除し、売却・除却した日を空にします。',
      buttons: [{ label: 'キャンセル', value: false }, { label: '取り消す', value: true, variant: 'danger' }],
    });
    if (!ok) return;
    try {
      await app.db.undoDisposal(original.id);
      showToast(original.splitFrom ? '取り消して、元の資産に戻しました' : '取り消しました');
      if (original.splitFrom) app.navigate(`#/asset/${encodeURIComponent(original.splitFrom)}`, { replace: true });
      else app.refresh();
    } catch (e) {
      showToast(e instanceof ValidationError && Array.isArray(e.errors) ? e.errors.join(' ') : errorText(e, '取り消し'));
    }
  }

  async function remove() {
    const ok = await confirmDialog({
      title: `「${original.name}」を削除しますか？`,
      message: '台帳から削除します。登録済みの減価償却・売却・除却の仕訳は残ります（必要なら仕訳帳で直してください）。',
      buttons: [{ label: 'キャンセル', value: false }, { label: '削除する', value: true, variant: 'danger' }],
    });
    if (!ok) return;
    try {
      await app.db.deleteAsset(original.id);
      showToast('削除しました');
      app.goBack('#/assets');
    } catch (e) {
      showToast(e instanceof ValidationError && Array.isArray(e.errors) ? e.errors.join(' ') : errorText(e, '削除'));
    }
  }
}

