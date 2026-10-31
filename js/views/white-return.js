// 収支内訳書（白色申告）：一般用・不動産所得用の各欄を様式の並びで表示する（確定申告書等作成コーナー・e-Tax に転記する数字）
import { h, put, field, segmented, amountCell, showToast, errorBox } from '../ui.js';
import { depreciationTable } from '../blue-return.js';
import { hasRealEstate, isRealEstateAsset, realEstateDetails, realEstateForFirstTable } from '../real-estate.js';
import { isWhite, whiteReturnSet, whiteDetails, WORKER_CAPS } from '../white-return.js';
import { depreciationTableView, brFrame, fillRows, partnerFrame } from './blue-return.js';
import { tenantFrame } from './real-estate.js';
import { formatYen, parseYen } from '../money.js';
import { formatPeriod } from '../period.js';
import { ValidationError } from '../db.js';

const MARU = '⓪①②③④⑤⑥⑦⑧⑨⑩⑪⑫⑬⑭⑮⑯⑰⑱⑲⑳㉑';
const maru = (n) => (typeof n === 'number' ? MARU[n] || String(n) : n || '');
const clone = (o) => JSON.parse(JSON.stringify(o));

export async function render({ app, outlet, query }) {
  const { settings, period, accounts, subAccounts, journals } = await app.load();
  if (settings.entityType !== 'individual') {
    put(outlet, h('p', { class: 'empty', text: '収支内訳書は個人事業主（白色申告）の様式です。' }), h('a', { href: '#/reports', class: 'btn', text: '帳票へ' }));
    return;
  }
  if (!isWhite(settings)) {
    put(outlet, h('p', { class: 'empty', text: '設定の申告の種類が青色申告です。青色申告では収支内訳書の代わりに青色申告決算書を提出します。白色申告なら設定の「申告の種類」を変えてください。' }), h('a', { href: '#/settings', class: 'btn', text: '設定へ' }));
    return;
  }
  const [assets, periods] = await Promise.all([app.db.listAssets(), app.db.listPeriods()]);
  const accountById = new Map(accounts.map((a) => [a.id, a]));
  const hasGeneral = settings.realEstate !== 'only';
  const hasRe = hasRealEstate(settings);
  const saved = period.whiteReturn || {};
  const state = { workers: clone(saved.workers || []), scale: saved.scale === 'business' ? 'business' : 'small', landInterest: saved.landInterest ?? 0 };
  let set = whiteReturnSet({ settings, accounts, period, journals, overrides: state });
  const pages = [...(hasGeneral ? [['g1', '一般 1'], ['g2', '一般 2']] : []), ...(hasRe ? [['r1', '不動産 1'], ['r2', '不動産 2']] : [])];
  let page = pages.some(([v]) => v === query.page) ? query.page : pages[0][0];
  const details = whiteDetails({ accounts, subAccounts, period, journals });
  const reDetails = hasRe ? realEstateDetails({ accounts, subAccounts, period, journals }) : null;
  const body = h('div');
  const controls = h('div');
  const editor = h('div');
  const editorErrors = h('div');

  const row = (no, label, amount, { strong = false, sub = '' } = {}) =>
    h('tr', { class: strong ? 'mt-strong' : '' }, h('td', { class: 'br-no', text: maru(no) }), h('th', { scope: 'row' }, label, sub ? h('span', { class: 'muted small block', text: sub }) : null), amountCell('td', amount));
  const table = (caption, rows, head = null) => h('div', { class: 'table-wrap' }, h('table', { class: 'report blue-return' }, caption ? h('caption', { text: caption }) : null, head, h('tbody', {}, rows)));
  // 帳簿の科目名が様式の欄名と違うときだけ出す
  const groupRow = (text) => h('tr', { class: 'st-group level2' }, h('th', { colspan: 3, scope: 'colgroup', text }));
  const named = (e) => (e.name && e.label && !e.name.startsWith(e.label) ? `帳簿の科目：${e.name}` : '');

  /** 専従者控除の内訳（その収支内訳書に書く人） */
  function workerTable(work) {
    const list = set.workers.filter((w) => w.work === work);
    if (!list.length) return null;
    return table(
      '専従者控除の内訳',
      [
        ...list.map((w) => h('tr', {}, h('th', { scope: 'row', text: w.name }), h('td', { text: w.spouse ? '配偶者' : '親族' }), amountCell('td', w.amount))),
        h('tr', { class: 'mt-strong' }, h('th', { scope: 'row', text: '計' }), h('td'), amountCell('td', list.reduce((s, w) => s + w.amount, 0))),
      ],
      h('thead', {}, h('tr', {}, h('th', { scope: 'col', text: '氏名' }), h('th', { scope: 'col', text: '続柄' }), h('th', { scope: 'col', text: '控除額' }))),
    );
  }

  function deductionNote() {
    if (!set.workers.length) return null;
    const per = set.base > 0 ? Math.floor(set.base / (set.workers.length + 1)) : 0;
    return h('p', { class: 'muted small', text: `専従者控除は1人ごとに、${formatYen(WORKER_CAPS.spouse)}円（配偶者以外は${formatYen(WORKER_CAPS.other)}円）と「専従者控除前の事業所得等の金額 ${formatYen(set.base)}円 ÷（専従者${set.workers.length}人＋1）＝${formatYen(per)}円」の少ない方です。` });
  }

  function pageG1() {
    const g = set.general;
    const L = g.lines;
    return [
      table('収入金額', [row(1, '売上（収入）金額', L[1], { sub: '雑収入を除く売上の科目' }), row(2, '家事消費', L[2], { sub: '帳簿では区別していません。家事消費を売上の科目で記帳していれば①に入っています' }), row(3, 'その他の収入', L[3], { sub: '雑収入の科目' }), row(4, '計（①＋②＋③）', L[4], { strong: true })]),
      table('売上原価', [row(5, '期首商品（製品）棚卸高', L[5]), row(6, '仕入金額（製品製造原価）', L[6]), row(7, '小計（⑤＋⑥）', L[7]), row(8, '期末商品（製品）棚卸高', L[8]), row(9, '差引原価（⑦−⑧）', L[9], { strong: true })]),
      table('', [row(10, '差引金額（④−⑨）', L[10], { strong: true })]),
      table('経費', [
        ...g.main.map((m) => row(m.no, m.label, m.amount, { sub: named(m) })),
        groupRow('その他の経費'),
        ...g.others.map((o) => row(o.mark, o.label || '（空欄）', o.amount, { sub: o.mark === '㋹' && g.overflow.length ? `空欄の行に入りきらない ${g.overflow.map((x) => x.name).join('・')} を含む` : named(o) })),
        row(17, 'その他の経費の計', L[17]),
        row(18, '経費の計（⑪〜⑯＋⑰）', L[18], { strong: true }),
      ]),
      table('所得金額', [row(19, '専従者控除前の所得金額（⑩−⑱）', L[19]), row(20, '専従者控除', L[20]), row(21, '所得金額（⑲−⑳）', L[21], { strong: true })]),
      workerTable('business'),
      deductionNote(),
      ...g1Details(L),
      g.familySalary ? h('p', { class: 'notice', text: `帳簿に専従者給与が ${formatYen(g.familySalary)}円あります。白色申告では家族への給与は必要経費にならず、代わりに専従者控除を差し引くので、上の経費には含めていません。仕訳の科目を事業主貸に直してください。` }) : null,
      g.reserves.reversal || g.reserves.provision ? h('p', { class: 'notice', text: `帳簿の貸倒引当金の繰戻額（${formatYen(g.reserves.reversal)}円）・繰入額（${formatYen(g.reserves.provision)}円）は、収支内訳書に欄が無いので含めていません（一括評価の貸倒引当金は青色申告者だけです）。` }) : null,
    ];
  }

  // 1ページ目の右側の枠：給料賃金の内訳（3行）・税理士・弁護士等の報酬・料金の内訳（2行）・事業専従者の氏名等（3行）
  function g1Details(L) {
    const wages = details.wages.slice(0, 3);
    const wageOthers = details.wages.slice(3);
    const sum = (list) => list.reduce((s, x) => s + x.amount, 0);
    const family = set.workers.filter((w) => w.work === 'business');
    return [
      brFrame('給料賃金の内訳', ['氏名', '年齢', '従事月数', '支給額（給料賃金）', '支給額（賞与）', '支給額（合計）', '源泉徴収税額'], [...fillRows(wages, 3, (x) => [x.name, '', '', '', '', x.amount, ''], 7), [`その他（${wageOthers.length || '　'}人分）`, '', '', '', '', wageOthers.length ? sum(wageOthers) : '', '']], { total: ['計（延べ従事月数）', '', '', '', '', L[11], ''] }),
      brFrame('税理士・弁護士等の報酬・料金の内訳', ['支払先の住所・氏名', '本年中の報酬等の金額', '左のうち必要経費算入額', '源泉徴収税額'], fillRows([], 2, () => [], 4)),
      brFrame('事業専従者の氏名等', ['氏名', '年齢', '続柄', '従事月数'], fillRows(family, 3, (w) => [w.name, '', w.spouse ? '配偶者' : '親族', ''], 4), { total: ['延べ従事月数', '', '', ''] }),
      h('p', { class: 'muted small no-print', text: '給料賃金の内訳の氏名は給料賃金の科目の補助科目の名前で、金額の多い順に3人まで（残りと補助科目の無い分は「その他」）。帳簿では給料と賞与を区別しないので合計の欄だけ入れています。年齢・従事月数・源泉徴収税額、税理士・弁護士等の報酬・料金の内訳は空欄です。' }),
    ];
  }

  function pageG2() {
    const t = depreciationTable({ assets, periods, period, filter: (a) => !isRealEstateAsset(a, accountById) });
    const L = set.general.lines;
    return [
      partnerFrame('売上（収入）金額の明細', details.sales, '売上（収入）金額', '計（①）', L[1], { extraRows: [['右記①のうち軽減税率対象', '', '', '']] }),
      partnerFrame('仕入金額の明細', details.purchases, '仕入金額', '計（⑥）', L[6], { extraRows: [['右記⑥のうち軽減税率対象', '', '', '']] }),
      h('p', { class: 'muted small no-print', text: '売上先・仕入先は科目の補助科目の名前で、金額の多い順に4つまで。残りと補助科目の無い分は「上記以外の計」です。所在地・登録番号・軽減税率対象の金額は空欄です。' }),
      t.rows.length ? depreciationTableView(t) : h('p', { class: 'muted small' }, '減価償却する固定資産はありません。', h('a', { class: 'link', href: '#/assets', text: '固定資産台帳' })),
      t.total.business !== L[13] ? h('p', { class: 'notice', text: `必要経費算入額の計（${formatYen(t.total.business)}円）と1ページの⑬減価償却費（${formatYen(L[13])}円）が違います。決算・繰越の画面で減価償却の仕訳を確かめてください。` }) : null,
      brFrame('利子割引料の内訳（金融機関を除く）', ['支払先の住所・氏名', '期末現在の借入金等の金額', '本年中の利子割引料', '左のうち必要経費算入額'], fillRows(details.interest, 2, (x) => [x.name, '', x.amount, x.amount], 4)),
      brFrame('地代家賃の内訳', ['支払先の住所・氏名', '賃借物件', '本年中の賃借料・権利金等', '左の賃借料のうち必要経費算入額'], fillRows(details.rent, 2, (x) => [x.name, '', x.amount, x.amount], 4)),
      brFrame('本年中における特殊事情', [''], [[''], [''], ['']]),
      h('p', { class: 'muted small no-print', text: '利子割引料・地代家賃の支払先は補助科目の名前で、多い順に2つまで。利子割引料の内訳は金融機関以外からの借入れの分だけを書くので、金融機関の分は手で消してください。借入金の金額・賃借物件・特殊事情は空欄です。' }),
    ];
  }

  function landInterestField() {
    return h(
      'div',
      { class: 'panel no-print' },
      field(
        '土地等を取得するために要した負債の利子の額',
        h('input', {
          id: 'wr-land-interest',
          type: 'text',
          inputmode: 'numeric',
          value: state.landInterest ? String(state.landInterest) : '',
          placeholder: '0',
          onchange: async (e) => {
            const r = e.target.value.trim() === '' ? { ok: true, value: 0 } : parseYen(e.target.value, { allowZero: true });
            if (!r.ok) return showToast(r.error);
            state.landInterest = r.value;
            paint();
            await save({ landInterest: r.value });
          },
        }),
        { hint: '⑩借入金利子のうち、土地（借地権を含む）を買うための借入金の利子' },
      ),
    );
  }

  function pageR1() {
    const r = set.realEstate;
    const L = r.lines;
    const first = realEstateForFirstTable(L[15], set.landInterest);
    return [
      table('収入金額', [
        row(1, r.incomes[0].label, r.incomes[0].amount),
        groupRow('その他の収入'),
        row(2, r.incomes[1].label, r.incomes[1].amount),
        row(3, r.incomes[2].label, r.incomes[2].amount),
        row(4, '小計（②＋③）', r.incomes[1].amount + r.incomes[2].amount),
        row(5, '計（①＋④）', r.income, { strong: true }),
      ]),
      table('必要経費', [
        ...r.main.map((m) => row(m.no, m.label, m.amount, { sub: m.no === 8 ? '不動産の貸倒れは空欄の行（㋥）に入ります' : '' })),
        groupRow('その他の経費'),
        ...r.others.map((o) => row(o.mark, o.label || '（空欄）', o.amount, { sub: o.mark === '㋭' && r.overflow.length ? `${r.overflow.map((x) => x.name).join('・')} を含む` : '' })),
        row(11, '小計（㋑〜㋭までの計）', L[11]),
        row(12, '経費計（⑥〜⑩までの計＋⑪）', L[12], { strong: true }),
      ]),
      table('所得金額', [
        row(13, '専従者控除前の所得金額（⑤−⑫）', L[13]),
        row(14, '専従者控除', L[14], { sub: set.scale === 'business' ? '' : '事業的規模でない貸付けには適用できません' }),
        row(15, '所得金額（⑬−⑭）', L[15], { strong: true }),
        h('tr', {}, h('td', { class: 'br-no' }), h('th', { scope: 'row', text: '土地等を取得するために要した負債の利子の額' }), set.landInterest ? amountCell('td', set.landInterest) : h('td')),
        L[15] < 0 ? row('', '確定申告書 第一表の「不動産③」', first, { strong: true, sub: '赤字のうち土地等を取得するための負債の利子の分は、ほかの所得と損益通算できません' }) : null,
      ]),
      L[15] < 0 ? landInterestField() : null,
      workerTable('realEstate'),
      tenantFrame(reDetails.tenants, 10),
      brFrame('給料賃金の内訳', ['氏名', '年齢', '従事月数', '給料賃金', '賞与', '合計', '源泉徴収税額'], [...fillRows(reDetails.wages.slice(0, 1), 1, (x) => [x.name, '', '', '', '', x.amount, ''], 7), [`その他（${reDetails.wages.length > 1 ? reDetails.wages.length - 1 : '　'}人分）`, '', '', '', '', reDetails.wages.length > 1 ? reDetails.wages.slice(1).reduce((s, x) => s + x.amount, 0) : '', '']], { total: ['計（延べ従事月数）', '', '', '', '', L[6], ''] }),
      brFrame('事業専従者の氏名等', ['氏名', '年齢', '続柄', '従事月数'], fillRows(set.workers.filter((w) => w.work === 'realEstate'), 2, (w) => [w.name, '', w.spouse ? '配偶者' : '親族', ''], 4), { total: ['延べ従事月数', '', '', ''] }),
      h('p', { class: 'muted small no-print', text: '賃借人・氏名は科目の補助科目の名前です。帳簿では給料と賞与を区別しないので合計の欄だけ入れています。貸家・貸地等の別、用途、所在地、賃貸契約期間、貸付面積、賃貸料の月額、保証金・敷金、年齢・従事月数・源泉徴収税額は空欄です。' }),
      r.familySalary ? h('p', { class: 'notice', text: `帳簿に専従者給与（不動産）が ${formatYen(r.familySalary)}円あります。白色申告では必要経費にならないので含めていません。仕訳の科目を事業主貸に直してください。` }) : null,
    ];
  }

  // 不動産 2ページ：減価償却費の計算・借入金利子（2行）・修繕費（3行）・貸付不動産の保有状況・地代家賃（2行）・税理士等の報酬（2行）・特殊事情
  function pageR2() {
    const t = depreciationTable({ assets, periods, period, filter: (a) => isRealEstateAsset(a, accountById) });
    const L = set.realEstate.lines;
    return [
      t.rows.length ? depreciationTableView(t) : h('p', { class: 'muted small' }, '償却費の科目を「減価償却費（不動産）」にした固定資産はありません。', h('a', { class: 'link', href: '#/assets', text: '固定資産台帳' })),
      t.total.business !== L[7] ? h('p', { class: 'notice', text: `必要経費算入額の計（${formatYen(t.total.business)}円）と1ページの⑦減価償却費（${formatYen(L[7])}円）が違います。` }) : null,
      brFrame('借入金利子の内訳（金融機関を除く）', ['支払先の住所・氏名', '期末現在の借入金等の金額', '本年中の借入金利子', '左のうち必要経費算入額'], fillRows(reDetails.interest, 2, (x) => [x.name, '', x.amount, x.amount], 4)),
      brFrame('修繕費の内訳', ['支払先の住所・氏名', '工事名又は資材の品名', '支払年月日', '支払金額', '左のうち必要経費算入額'], fillRows(reDetails.repairs, 3, (x) => [x.name, '', '', x.amount, x.amount], 5)),
      brFrame('貸付不動産の保有状況（空家（空室）、空地を含む）', ['用途・種類等', '数量'], [['住宅用 建物（一戸建）', ''], ['住宅用 建物（一戸建以外）', ''], ['住宅用 土地（契約件数・総面積）', ''], ['住宅用以外 建物（一戸建）', ''], ['住宅用以外 建物（一戸建以外）', ''], ['住宅用以外 土地（契約件数・総面積）', ''], ['駐車場（屋根付・青空）', '']]),
      brFrame('地代家賃の内訳', ['支払先の住所・氏名', '賃借物件', '本年中の賃借料・権利金等', '左の賃借料のうち必要経費算入額'], fillRows(reDetails.rent, 2, (x) => [x.name, '', x.amount, x.amount], 4)),
      brFrame('税理士・弁護士等の報酬・料金の内訳', ['支払先の住所・氏名', '本年中の報酬等の金額', '左のうち必要経費算入額', '源泉徴収税額'], fillRows([], 2, () => [], 4)),
      brFrame('本年中における特殊事情・保証金等の運用状況', [''], [[''], [''], ['']]),
      h('p', { class: 'muted small no-print', text: '支払先は科目の補助科目の名前です（修繕費は1行に科目ごとの合計）。借入金利子の内訳は金融機関以外からの借入れの分だけを書くので、金融機関の分は手で消してください。工事名・支払年月日・保有状況・税理士等の報酬・特殊事情は空欄です。' }),
    ];
  }

  async function save(patch, message) {
    if (period.closed) return false;
    try {
      await app.db.saveWhiteReturnSettings(period.id, patch);
      put(editorErrors);
      if (message) showToast(message);
      return true;
    } catch (e) {
      const errors = e instanceof ValidationError ? (Array.isArray(e.errors) ? e.errors : Object.values(e.errors)) : ['保存できませんでした'];
      put(editorErrors, errorBox(errors));
      return false;
    }
  }

  /** 事業専従者の入力（氏名・配偶者か・従事する事業） */
  function paintEditor() {
    const chooseWork = hasGeneral && hasRe && state.scale === 'business';
    put(
      editor,
      state.workers.map((w, i) =>
        h(
          'div',
          { class: 'it-item' },
          field(
            '氏名',
            h('input', {
              id: `wr-worker-${i}-name`,
              type: 'text',
              maxlength: 40,
              value: w.name,
              oninput: (e) => {
                w.name = e.target.value;
                paint();
              },
            }),
          ),
          h('label', { class: 'check small' }, h('input', { type: 'checkbox', checked: w.spouse, onchange: (e) => ((w.spouse = e.target.checked), paint()) }), '配偶者（上限86万円。配偶者以外の親族は50万円）'),
          chooseWork
            ? field('従事する事業', h('select', { id: `wr-worker-${i}-work`, onchange: (e) => ((w.work = e.target.value), paint()) }, [['business', '事業所得（一般用）'], ['realEstate', '不動産所得（不動産所得用）']].map(([v, t]) => h('option', { value: v, text: t, selected: w.work === v }))))
            : null,
          h('button', { type: 'button', class: 'btn btn-small btn-danger-text', text: 'この人を削除', onclick: () => (state.workers.splice(i, 1), paintEditor(), paint()) }),
        ),
      ),
      state.workers.length < 10 ? h('button', { type: 'button', class: 'btn btn-small', text: '専従者を追加', onclick: () => (state.workers.push({ name: '', spouse: false, work: hasGeneral ? 'business' : 'realEstate' }), paintEditor(), paint()) }) : null,
    );
  }

  function paintControls() {
    put(
      controls,
      hasRe
        ? field(
            '貸付けの規模',
            segmented({
              name: '貸付けの規模',
              options: [
                { value: 'business', label: '事業的規模' },
                { value: 'small', label: '事業的規模でない' },
              ],
              value: state.scale,
              onChange: async (v) => {
                state.scale = v;
                paintEditor();
                paint();
                await save({ scale: v });
              },
            }),
            { hint: 'おおむね5棟10室以上なら事業的規模（国税庁 No.1373）。事業的規模でない貸付けには専従者控除を適用できません' },
          )
        : null,
      pages.length > 1
        ? segmented({
            name: 'ページ',
            options: pages.map(([value, label]) => ({ value, label })),
            value: page,
            onChange: (v) => {
              page = v;
              paint();
            },
          })
        : null,
    );
  }

  function paint() {
    history.replaceState(history.state, '', `#/reports/white-return?page=${page}`);
    set = whiteReturnSet({ settings, accounts, period, journals, overrides: { ...state, workers: state.workers.filter((w) => w.name.trim()) } });
    const fns = { g1: pageG1, g2: pageG2, r1: pageR1, r2: pageR2 };
    const titles = { g1: '収支内訳書（一般用）1ページ', g2: '収支内訳書（一般用）2ページ', r1: '収支内訳書（不動産所得用）1ページ', r2: '収支内訳書（不動産所得用）2ページ' };
    put(
      body,
      set.workersNotAllowed ? h('p', { class: 'notice', text: '事業的規模でない不動産の貸付けだけなので、事業専従者控除は受けられません。' }) : null,
      pages.map(([key]) => h('section', { class: `br-page${key === page ? '' : ' is-off'}` }, h('h2', { class: 'print-only br-page-title', text: titles[key] }), fns[key]())),
    );
  }

  put(
    outlet,
    h('p', { class: 'muted small no-print', text: `${formatPeriod(period)}・${settings.businessName}` }),
    h('section', { class: 'panel no-print' }, controls),
    h(
      'details',
      { class: 'panel no-print', open: !saved.workers },
      h('summary', { text: `事業専従者（専従者控除）${state.workers.length ? `　${state.workers.length}人` : ''}` }),
      h('p', { class: 'muted small', text: '生計を一にする配偶者や15歳以上の親族で、その年に6か月を超えて事業に専ら従事した人です。専従者は配偶者控除・扶養控除の対象になりません（確定申告書の画面で「事業専従者」に印を付けてください）。' }),
      editor,
      editorErrors,
      h('button', {
        type: 'button',
        class: 'btn btn-block',
        text: '専従者を保存する',
        disabled: period.closed,
        onclick: async () => {
          if (await save({ workers: state.workers }, '事業専従者を保存しました')) paint();
        },
      }),
      period.closed ? h('p', { class: 'muted small', text: 'この期間は締めてあるので保存できません。' }) : null,
    ),
    body,
    h(
      'div',
      { class: 'panel small muted no-print' },
      h('p', { text: '国税庁の収支内訳書（一般用・不動産所得用）の欄の並びで集計しています。確定申告書等作成コーナーや e-Tax に転記するときの数字としてお使いください。' }),
      h('p', { text: '一般用の経費は勘定科目テンプレートの科目で欄に割り当て、自分で追加した科目は空欄の行（㋾〜㋟）に入ります。不動産所得用は科目の目印で割り当てます。' }),
      h('p', { text: '出典：国税庁「令和7年分 収支内訳書（一般用）の書き方」「収支内訳書（不動産所得用）の書き方」、タックスアンサー No.2075（事業専従者控除）・No.1373（事業としての不動産貸付け）' }),
    ),
  );
  paintEditor();
  paintControls();
  paint();
}
