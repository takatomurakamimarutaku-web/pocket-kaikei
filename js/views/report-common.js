// 帳票の共通部品（月範囲の選択・0の科目を隠す切替・金額の単位・期首残高の警告）
import { h, put, amountCell, emptyState, segmented, setAmountUnit } from '../ui.js';
import { monthsInPeriod, monthRange, addDays } from '../period.js';
import { formatYen, AMOUNT_UNITS, ROUNDINGS, YEN_UNIT, normalizeUnit, unitCaption } from '../money.js';
import { carriedLabel } from '../ledger.js';

const monthText = (m) => `${m.slice(0, 4)}年${Number(m.slice(5))}月`;

/**
 * 月範囲の選択。変更するとハッシュの from/to を書き換えて onChange を呼ぶ
 * @returns {{ el, range: () => {from,to,fromMonth,toMonth} }}
 */
export function monthRangePicker({ period, query, path, onChange, extra = () => ({}) }) {
  const months = monthsInPeriod(period);
  let fromMonth = months.includes(query.from) ? query.from : months[0];
  let toMonth = months.includes(query.to) ? query.to : months.at(-1);
  if (toMonth < fromMonth) toMonth = fromMonth;
  const sel = (value, label, set) =>
    h(
      'select',
      { 'aria-label': label, onchange: (e) => (set(e.target.value), update()) },
      months.map((m) => h('option', { value: m, text: monthText(m), selected: m === value })),
    );
  const fromSel = sel(fromMonth, '開始月', (v) => (fromMonth = v));
  const toSel = sel(toMonth, '終了月', (v) => (toMonth = v));
  function refreshUrl() {
    const params = new URLSearchParams({ ...extra(), from: fromMonth, to: toMonth });
    history.replaceState(history.state, '', `#${path}?${params}`);
  }
  function update() {
    if (toMonth < fromMonth) {
      toMonth = fromMonth;
      toSel.value = toMonth;
    }
    refreshUrl();
    onChange();
  }
  const el = h('div', { class: 'range-bar' }, fromSel, h('span', { class: 'muted', text: '〜' }), toSel);
  return { el, refreshUrl, range: () => ({ ...monthRange(period, fromMonth, toMonth), fromMonth, toMonth }) };
}

// 画面ごとに選んだ金額の単位（アプリを開いている間だけ覚える。帳簿のデータではないので保存しない）
const chosenUnits = new Map();

/**
 * 金額の単位（円・千円・百万円）と端数の処理（切り捨て・四捨五入）の切替。
 * 選ぶと ui.js の表示単位を設定して onChange を呼ぶ。金額は円のまま集計し、表のセルを出すときだけ換算する
 * @param {{ key: string, onChange: () => void }} opts key：画面ごとに覚えるための名前（ルートのパスなど）
 * @returns {{ el, value: () => { unit, rounding } }}
 */
export function unitPicker({ key, onChange }) {
  let u = normalizeUnit(chosenUnits.get(key) ?? YEN_UNIT);
  setAmountUnit(u);
  const roundSel = h(
    'select',
    { class: 'unit-round', 'aria-label': '単位未満の端数', onchange: (e) => apply({ rounding: e.target.value }) },
    Object.entries(ROUNDINGS).map(([v, label]) => h('option', { value: v, text: label, selected: v === u.rounding })),
  );
  const note = h('span', { class: 'unit-note muted small' });
  function refresh() {
    roundSel.hidden = u.unit === 'yen';
    note.textContent = u.unit === 'yen' ? '' : `${unitCaption(u)} 合計は円で計算してから換算するため、内訳の和と合わないことがあります`;
  }
  function apply(change) {
    u = normalizeUnit({ ...u, ...change });
    chosenUnits.set(key, u);
    setAmountUnit(u);
    refresh();
    onChange();
  }
  const seg = segmented({
    name: '金額の単位',
    options: Object.entries(AMOUNT_UNITS).map(([value, { label }]) => ({ value, label })),
    value: u.unit,
    onChange: (v) => apply({ unit: v }),
  });
  refresh();
  const el = h('div', { class: 'unit-bar no-print' }, h('div', { class: 'unit-row' }, h('span', { class: 'unit-label small', text: '金額' }), seg, roundSel), note);
  return { el, value: () => u };
}

/** 印刷条件：金額の単位（画面で選んだ単位を最初に選んでおく） */
export function unitPrintOptions(u = YEN_UNIT) {
  return [
    { key: 'unit', label: '金額の単位', type: 'select', choices: Object.entries(AMOUNT_UNITS).map(([v, { label }]) => [v, label]), value: u.unit },
    { key: 'rounding', label: '単位未満の端数', type: 'select', choices: Object.entries(ROUNDINGS), value: u.rounding },
  ];
}

/** 0円の科目を表示するかの切替 */
export function zeroToggle(onChange) {
  const input = h('input', { type: 'checkbox', onchange: () => onChange(input.checked) });
  return { el: h('label', { class: 'check small' }, input, '0円の科目も表示'), value: () => input.checked };
}

/** 期首残高が一致していないときの警告 */
export function openingWarning(diff) {
  if (!diff) return null;
  return h(
    'div',
    { class: 'notice' },
    h('span', { text: `期首残高が一致していません（差額 ${formatYen(Math.abs(diff))}円）。帳票の合計が合いません。` }),
    h('a', { href: '#/opening', class: 'link', text: '期首残高を確認' }),
  );
}

/**
 * 損益計算書・貸借対照表の行（区分の見出し・科目・区分の計・段階利益）
 * @param {Array} items statements.js の items
 * @param {boolean} showZero 0円の科目も出す
 */
export function statementRows(items, showZero = false) {
  const out = [];
  for (const it of items) {
    if (it.type === 'subtotal') {
      if (it.heading && !showZero && !it.amount) continue;
      out.push(h('tr', { class: it.plain ? 'st-line' : `st-subtotal ${it.strong ? 'strong' : ''} ${it.heading ? 'heading' : ''}` }, h('th', { text: it.label }), amountCell('td', it.amount)));
      continue;
    }
    const lines = it.lines.filter((l) => showZero || l.amount);
    // 0円の科目を隠すときは、科目も合計も無い区分ごと隠す
    if (!showZero && !lines.length && !it.total) continue;
    out.push(h('tr', { class: `st-group ${it.level === 2 ? 'level2' : ''}` }, h('th', { colspan: 2, text: it.label })));
    for (const l of lines) {
      out.push(h('tr', { class: 'st-line' }, h('th', { text: l.account.name }), amountCell('td', l.amount)));
      if (l.note) out.push(h('tr', { class: 'st-note' }, h('th', { text: `（${l.note.label}）` }), amountCell('td', l.note.amount)));
    }
    out.push(h('tr', { class: 'st-total' }, h('th', { text: `${it.label} 計` }), amountCell('td', it.total)));
  }
  return out;
}

/** 前期（当期の開始日の前日に終わる期間）とその仕訳。アプリに前期が無ければ null */
export async function loadPrevious(app, period) {
  const periods = await app.db.listPeriods();
  const prev = periods.find((p) => p.endDate === addDays(period.startDate, -1));
  if (!prev) return null;
  return { period: prev, journals: await app.db.listJournals(prev.id) };
}

/**
 * 元帳の表（総勘定元帳・補助元帳）。繰越の行・取引の行（日付・伝票No・相手科目・摘要・借方・貸方・残高）・期間計
 * 日付の下の No. は伝票No.（見出しに書く。列の幅を取らないよう短くする）
 * @param {object} lg ledger.generalLedger の結果
 * @param {{ period, from, title?: string, meta?: string, id?: string, showEmpty?: boolean }} opts
 *   title：見出し（続けて表示するとき）。meta：件数の行の先頭に付ける文字
 */
export function ledgerSection(lg, { period, from, title = '', meta = '', id = null, showEmpty = true }) {
  const side = lg.account.normalSide === 'debit' ? '借方残' : '貸方残';
  return h(
    'section',
    { class: 'lg-section', id },
    title ? h('h2', { class: 'section-title', text: title }) : null,
    h('p', { class: 'list-meta', text: `${meta}${side}・${lg.rows.length}件` }),
    h(
      'div',
      { class: 'table-wrap' },
      h(
        'table',
        { class: 'report ledger' },
        h('thead', {}, h('tr', {}, ['日付／伝票No.', '相手科目／摘要', '借方', '貸方', '残高'].map((t) => h('th', { scope: 'col', text: t })))),
        h(
          'tbody',
          {},
          h('tr', { class: 'carried' }, h('td'), h('td', { text: carriedLabel(period, from) }), h('td'), h('td'), amountCell('td', lg.carried)),
          lg.rows.map((r) =>
            h(
              'tr',
              {},
              h('td', { class: 'nowrap' }, h('a', { href: `#/journal/${encodeURIComponent(r.journal.id)}/edit`, text: r.date.slice(5).replace('-', '/') }), h('span', { class: 'lg-no', text: `No.${r.voucherNo ?? r.no}` })),
              h('td', {}, h('span', { class: 'lg-counter', text: r.counterpart }), r.memo ? h('span', { class: 'lg-memo', text: r.memo }) : null),
              amountCell('td', r.debit, { blankZero: true }),
              amountCell('td', r.credit, { blankZero: true }),
              amountCell('td', r.balance),
            ),
          ),
        ),
        h('tfoot', {}, h('tr', {}, h('th', { colspan: 2, text: '期間計' }), amountCell('td', lg.debit), amountCell('td', lg.credit), amountCell('td', lg.closing))),
      ),
    ),
    lg.rows.length || !showEmpty ? null : emptyState('この期間の取引はありません', null, { face: null }),
  );
}

/** 印刷条件の月の選択肢（[['2026-04', '2026年4月'], …]） */
export function monthChoices(period) {
  return monthsInPeriod(period).map((m) => [m, monthText(m)]);
}

/** 印刷条件：開始月・終了月 */
export function monthRangeOptions(period, fromMonth, toMonth) {
  const choices = monthChoices(period);
  return [
    { key: 'from', label: '開始月', type: 'select', choices, value: fromMonth ?? choices[0][0] },
    { key: 'to', label: '終了月', type: 'select', choices, value: toMonth ?? choices.at(-1)[0] },
  ];
}

/** 印刷条件の開始月・終了月から日付の範囲（終了月が前なら入れ替える） */
export function printRange(period, v) {
  const [a, b] = v.from <= v.to ? [v.from, v.to] : [v.to, v.from];
  return { ...monthRange(period, a, b), fromMonth: a, toMonth: b };
}
