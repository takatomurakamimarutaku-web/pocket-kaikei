// 固定資産の売却・除却：日付・売却額・科目を選ぶと、帳簿価額と仕訳を表示し、資産と仕訳を一緒に登録する
import { h, put, field, segmented, showToast, errorBox, amountCell } from '../ui.js';
import { disposalLines, bookValueAt, canDispose, canSplit, splitAsset } from '../asset-tools.js';
import { CATEGORY_BY_ID, METHOD_BY_ID, methodLabel } from '../depreciation.js';
import { compareAccounts } from '../accounts.js';
import { validateJournal, journalLabel } from '../journal.js';
import { TAX_BY_CODE } from '../tax.js';
import { parseYen, formatYen } from '../money.js';
import { todayString } from '../period.js';
import { createJournal } from '../models.js';
import { ValidationError } from '../db.js';
import { errorText } from '../errors.js';

const slash = (d) => d.replaceAll('-', '/');

export async function render({ app, outlet, params, query = {} }) {
  const { settings, period, accounts, subAccounts, accountById } = await app.load();
  const [asset, periods] = await Promise.all([app.db.getAsset(params.id), app.db.listPeriods()]);
  if (!asset) return put(outlet, h('p', { class: 'empty', text: '固定資産が見つかりません' }));
  const individual = settings.entityType === 'individual';
  if (asset.disposalType) return put(outlet, h('p', { class: 'notice', text: 'この資産は売却・除却の処理済みです。取り消すときは固定資産の編集画面から行います。' }));
  if (!canDispose(asset)) {
    return put(outlet, h('p', { class: 'notice', text: `${METHOD_BY_ID[asset.method]?.short ?? ''}の資産は、売却・除却の仕訳を作りません（一括償却資産は除却後も3年で償却し、少額の資産は取得した年に全額を費用にしています）。編集画面で除却した日を入れ、仕訳は振替伝票で入力してください。` }));
  }

  const active = (pred) => accounts.filter((a) => a.active && pred(a)).sort(compareAccounts);
  const hinted = (list, hint) => (list.find((a) => a.hint === hint) || list[0])?.id || '';
  const receipts = active((a) => a.group === 'current_assets' && a.normalSide === 'debit');
  const gains = active((a) => ['extraordinary_income', 'non_operating_income'].includes(a.group));
  const sellLosses = active((a) => ['extraordinary_losses', 'non_operating_expenses'].includes(a.group));
  const retireLosses = individual ? active((a) => a.group === 'sga' || a.group === 're_expenses') : sellLosses;
  const today = todayString();
  const splittable = canSplit(asset);
  const totalQty = asset.quantity ?? 1;
  const state = {
    scope: query.scope === 'part' && splittable ? 'part' : 'all', // all：全部、part：一部
    partQty: null,
    partCost: NaN,
    type: 'sell',
    date: today >= period.startDate && today <= period.endDate ? today : period.endDate,
    price: 0,
    receiptAccountId: (receipts.find((a) => a.role === 'deposit') || receipts[0])?.id || '',
    gainAccountId: hinted(gains, 'asset_sale_gain'),
    lossAccountId: hinted(sellLosses, 'asset_sale_loss'),
    retireAccountId: hinted(retireLosses, individual ? 'misc_expense' : 'asset_retirement_loss'),
  };

  const select = (id, list, key) =>
    h(
      'select',
      { id, onchange: (e) => ((state[key] = e.target.value), paint()) },
      list.length ? list.map((a) => h('option', { value: a.id, text: `${a.code} ${a.name}`, selected: a.id === state[key] })) : h('option', { value: '', text: '科目がありません' }),
    );
  const date = h('input', { id: 'd-date', type: 'date', value: state.date, onchange: (e) => ((state.date = e.target.value), paint()) });
  const price = h('input', {
    id: 'd-price',
    type: 'text',
    inputmode: 'numeric',
    class: 'amount-input',
    placeholder: '0',
    oninput: (e) => {
      const p = parseYen(e.target.value || '0', { allowZero: true });
      state.price = p.ok ? p.value : NaN;
      paint();
    },
  });
  const sellBox = h(
    'div',
    {},
    field('売却額（税込）', price, { hint: CATEGORY_BY_ID[asset.category]?.nonDepreciable ? '土地の売却は消費税の非課税売上です' : '消費税を含んだ金額。事業用の資産の売却は消費税の課税売上になります' }),
    field('入金先（後で受け取るなら未収入金）', select('d-receipt', receipts, 'receiptAccountId')),
    individual ? null : h('div', { class: 'field-row' }, field('売却益の科目', select('d-gain', gains, 'gainAccountId')), field('売却損の科目', select('d-loss', sellLosses, 'lossAccountId'))),
  );
  const retireBox = field(individual ? '除却損を計上する経費の科目' : '除却損の科目', select('d-retire', retireLosses, 'retireAccountId'), { hint: individual ? '業務用資産の除却の損失は必要経費になります（国税庁 No.2210）。決算書では雑費などに含めます' : '' });
  // 一部の売却・除却：数量（2個以上のとき）と、その分の取得価額
  const partQty = h('input', {
    id: 'd-qty',
    type: 'text',
    inputmode: 'numeric',
    maxlength: 5,
    placeholder: '例：1',
    oninput: (e) => {
      const t = e.target.value.trim();
      state.partQty = t === '' ? null : /^\d+$/.test(t) ? Number(t) : NaN;
      // 数量を入れたら、取得価額を数量の割合で入れる（変えてもよい）
      if (Number.isInteger(state.partQty) && state.partQty > 0 && state.partQty < totalQty) {
        state.partCost = Math.floor((asset.cost * state.partQty) / totalQty);
        partCost.value = state.partCost.toLocaleString('ja-JP');
      }
      paint();
    },
  });
  const partCost = h('input', {
    id: 'd-part-cost',
    type: 'text',
    inputmode: 'numeric',
    class: 'amount-input',
    placeholder: '0',
    oninput: (e) => {
      const p = parseYen(e.target.value || '0');
      state.partCost = p.ok ? p.value : NaN;
      paint();
    },
  });
  const partBox = h(
    'div',
    {},
    totalQty > 1 ? field(`売却・除却する数量（全部で${totalQty}個）`, partQty) : null,
    field('売却・除却する分の取得価額（円）', partCost, { hint: `今の取得価額 ${formatYen(asset.cost)}円 のうち、売却・除却する分。帳簿価額はこの割合で分けます${totalQty > 1 ? '（数量を入れると割合で入れます）' : ''}` }),
  );
  const preview = h('div');
  const errorsEl = h('div');

  /** 一部のときは、元の資産から分けた資産（splitAsset）。全部のときは null */
  function split() {
    if (state.scope !== 'part') return null;
    return splitAsset(asset, periods, { date: state.date, cost: state.partCost, quantity: totalQty > 1 && state.partQty !== null ? state.partQty : null });
  }

  function compute(sp = split()) {
    if (sp?.errors.length) return { lines: [], book: 0, accumulated: 0, gain: 0, loss: 0, errors: sp.errors };
    return disposalLines({
      asset: sp ? sp.part : asset,
      periods,
      accounts,
      entityType: settings.entityType,
      date: state.date,
      type: state.type,
      price: state.price,
      receiptAccountId: state.receiptAccountId,
      gainAccountId: state.gainAccountId,
      lossAccountId: state.type === 'sell' ? state.lossAccountId : state.retireAccountId,
    });
  }

  function paint() {
    sellBox.hidden = state.type !== 'sell';
    retireBox.hidden = state.type !== 'retire';
    partBox.hidden = state.scope !== 'part';
    put(errorsEl);
    if (!state.date) return put(preview, h('p', { class: 'muted small', text: '日付を入れてください。' }));
    if (state.scope === 'part' && !Number.isInteger(state.partCost)) return put(preview, h('p', { class: 'muted small', text: '売却・除却する分の取得価額を入れてください。' }));
    const sp = split();
    const r = compute(sp);
    const target = sp && !sp.errors.length ? sp.part : asset;
    const name = (id) => accountById.get(id)?.name ?? '';
    put(
      preview,
      h(
        'div',
        { class: 'table-wrap' },
        h(
          'table',
          { class: 'report taxsum' },
          h('caption', { text: '帳簿価額' }),
          h(
            'tbody',
            {},
            h('tr', {}, h('th', { scope: 'row', text: sp ? '売却・除却する分の取得価額' : '取得価額' }), amountCell('td', target.cost)),
            h('tr', {}, h('th', { scope: 'row' }, `${slash(state.date)} の帳簿価額`, h('span', { class: 'muted small block', text: sp ? 'その期間の期首の帳簿価額を割合で分け、その月までの償却費を引いた額' : 'その月までの償却費を引いた額' })), amountCell('td', sp?.errors.length ? 0 : bookValueAt(target, periods, state.date))),
            sp && !sp.errors.length ? h('tr', {}, h('th', { scope: 'row', text: '残る資産の取得価額' }), amountCell('td', sp.original.cost)) : null,
            state.type === 'sell' ? h('tr', {}, h('th', { scope: 'row', text: r.gain ? (individual ? '売却益（譲渡所得）' : '固定資産売却益') : individual ? '売却損（譲渡所得）' : '固定資産売却損' }), amountCell('td', r.gain || r.loss)) : null,
          ),
        ),
      ),
      r.errors.length
        ? errorBox(r.errors)
        : r.lines.length
          ? h(
              'div',
              { class: 'table-wrap' },
              h(
                'table',
                { class: 'report' },
                h('caption', { text: `仕訳（${slash(state.date)}）` }),
                h('thead', {}, h('tr', {}, ['借方', '貸方', '金額'].map((t) => h('th', { scope: 'col', text: t })))),
                h(
                  'tbody',
                  {},
                  r.lines.map((l) =>
                    h(
                      'tr',
                      {},
                      h('td', { text: l.side === 'debit' ? name(l.accountId) : '' }),
                      h('td', {}, l.side === 'credit' ? name(l.accountId) : '', l.taxCategory !== 'none' ? h('span', { class: 'muted small block', text: TAX_BY_CODE[l.taxCategory].label }) : null),
                      amountCell('td', l.amount),
                    ),
                  ),
                ),
              ),
            )
          : h('p', { class: 'muted small', text: '帳簿価額が0円のため、仕訳はありません（資産の記録だけを更新します）。' }),
    );
  }

  async function save() {
    const sp = split();
    const r = compute(sp);
    if (r.errors.length) return put(errorsEl, errorBox(r.errors));
    const target = periods.find((p) => p.startDate <= state.date && state.date <= p.endDate);
    if (r.lines.length && !target) return put(errorsEl, errorBox(['その日を含む会計期間がありません（決算・繰越の画面で次の期間を作ってから処理してください）']));
    if (target?.closed) return put(errorsEl, errorBox(['その日を含む会計期間は締めてあります']));
    let journal = null;
    if (r.lines.length) {
      journal = createJournal({ periodId: target.id, date: state.date, lines: r.lines });
      const v = validateJournal(journal, { accounts, subAccounts, period: target });
      if (v.length) return put(errorsEl, errorBox(v));
    }
    try {
      const disposal = { disposedOn: state.date, disposalType: state.type, salePrice: state.type === 'sell' ? state.price : null };
      const res = sp ? await app.db.partialDisposeAsset(sp.original, { ...sp.part, ...disposal }, journal) : await app.db.disposeAsset({ ...asset, ...disposal }, journal);
      showToast(res.journal ? `${state.type === 'sell' ? '売却' : '除却'}の仕訳（${journalLabel(res.journal)}）を登録しました` : '登録しました');
      app.goBack('#/assets');
    } catch (e) {
      put(errorsEl, errorBox(e instanceof ValidationError ? (Array.isArray(e.errors) ? e.errors : Object.values(e.errors)) : [errorText(e, '保存')]));
    }
  }

  put(
    outlet,
    h(
      'section',
      { class: 'panel' },
      h('h2', { class: 'section-title', text: asset.name }),
      h('p', { class: 'muted small', text: `${CATEGORY_BY_ID[asset.category]?.label ?? ''}・${accountById.get(asset.accountId)?.name ?? ''}・${methodLabel(asset)}${asset.usefulLife ? ` ${asset.usefulLife}年` : ''}・取得価額 ${formatYen(asset.cost)}円・${slash(asset.startedOn)} から使用${individual && asset.businessRatio < 100 ? `・事業${asset.businessRatio}%` : ''}` }),
    ),
    h(
      'form',
      { class: 'panel', novalidate: true, onsubmit: (e) => (e.preventDefault(), save()) },
      field(
        '処理',
        segmented({
          name: '処理',
          options: [{ value: 'sell', label: '売却' }, { value: 'retire', label: '除却・廃棄' }],
          value: state.type,
          onChange: (v) => ((state.type = v), paint()),
        }),
      ),
      splittable
        ? field(
            '範囲',
            segmented({
              name: '範囲',
              options: [{ value: 'all', label: '全部' }, { value: 'part', label: '一部だけ' }],
              value: state.scope,
              onChange: (v) => ((state.scope = v), paint()),
            }),
          )
        : null,
      partBox,
      field('売却・除却した日', date),
      sellBox,
      retireBox,
      preview,
      errorsEl,
      h('button', { type: 'submit', class: 'btn btn-primary btn-block', text: '資産と仕訳を登録する' }),
    ),
    h(
      'div',
      { class: 'panel small muted' },
      asset.method === 'none' ? h('p', { text: '償却しない資産なので、帳簿価額は取得価額のままです。' }) : h('p', { text: 'その年の減価償却費は、売却・除却した月までの月数で計算し、決算・繰越の画面で期末日の仕訳として登録します（登録済みなら差額の注意が出ます）。' }),
      splittable ? h('p', { text: '一部だけのときは、売却・除却する分を別の資産に分けます。その期間の期首の取得価額・帳簿価額を割合で分け、分けた資産はその月まで償却します。残る資産は取得価額を減らして償却を続けます（前の期間の台帳は変わりません）。' }) : null,
      individual
        ? h('p', { text: '個人事業の機械・車両などの売却益・売却損は事業所得ではなく譲渡所得になるため、事業主借・事業主貸で処理します（国税庁 No.3105）。譲渡所得の申告は別に行ってください。私用にも使っていた資産は、売却額のうち事業で使う割合の分だけを消費税の課税売上にしています。' })
        : asset.method === 'none' ? null : h('p', { text: '減価償却累計額の科目で償却していた有形固定資産は、累計額（取得価額−帳簿価額）を消してから処理します。' }),
      CATEGORY_BY_ID[asset.category]?.nonDepreciable
        ? h('p', { text: '土地の売却は消費税の非課税売上です（国税庁 No.6225）。課税売上割合の計算に入ります。個人の土地の売却は分離課税の譲渡所得になるので、譲渡所得の申告は別に行ってください。' })
        : h('p', { text: '事業用の資産の売却は、消費税の課税売上になります（国税庁 質疑応答「事業者の事業用固定資産の売却」）。' }),
    ),
  );
  paint();
}
