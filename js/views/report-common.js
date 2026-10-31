// 帳票の共通部品（期間の範囲の選択・0の科目を隠す切替・金額の単位・決算書の様式・期首残高の警告）
import { h, put, amountCell, emptyState, segmented, setAmountUnit } from '../ui.js';
import { monthsInPeriod, monthRange, addDays, rangePresets, parseRange, rangeQuery, presetKeyOf, isMonthAligned, formatRange, isValidDate } from '../period.js';
import { formatYen, AMOUNT_UNITS, ROUNDINGS, YEN_UNIT, normalizeUnit, unitCaption } from '../money.js';
import { carriedLabel } from '../ledger.js';

const monthText = (m) => `${m.slice(0, 4)}年${Number(m.slice(5))}月`;

/** 範囲の結果：日付の範囲・含まれる月・URL に書く形・表示・期間全体か */
function rangeResult(period, r) {
  return { from: r.from, to: r.to, fromMonth: r.from.slice(0, 7), toMonth: r.to.slice(0, 7), query: rangeQuery(period, r), label: formatRange(r), whole: r.from === period.startDate && r.to === period.endDate };
}

/**
 * 帳票の期間の選択（年・月・日を自由に）：期間全体・各月・四半期・半期の候補と、「月で指定」（開始月〜終了月）・「日付で指定」（開始日〜終了日）。
 * 変更するとハッシュの from/to（月の区切りなら 'YYYY-MM'、そうでなければ 'YYYY-MM-DD'）を書き換えて onChange を呼ぶ
 * @param {{ period, query, path: string, onChange: () => void, extra?: () => object, monthsOnly?: boolean }} opts
 *   monthsOnly：月の単位だけ選べる（月次推移・予算実績など、列が月の帳票）
 * @returns {{ el, refreshUrl, range: () => { from, to, fromMonth, toMonth, query: { from, to }, label: string, whole: boolean } }}
 */
export function monthRangePicker({ period, query, path, onChange, extra = () => ({}), monthsOnly = false }) {
  const months = monthsInPeriod(period);
  let r = parseRange(period, query.from, query.to);
  if (monthsOnly) r = monthRange(period, r.from.slice(0, 7), r.to.slice(0, 7));
  const presets = rangePresets(period);
  let mode = presetKeyOf(period, r) ?? (monthsOnly || isMonthAligned(period, r) ? 'months' : 'dates');
  const option = (value, text) => h('option', { value, text, selected: value === mode });
  const groups = ['月', '四半期', '半期'].map((g) => [g, presets.filter((p) => p.group === g)]).filter(([, list]) => list.length);
  const presetSel = h(
    'select',
    { class: 'range-preset', 'aria-label': '期間', onchange: (e) => choose(e.target.value) },
    option('all', '期間全体'),
    groups.map(([g, list]) => h('optgroup', { label: g }, list.map((p) => option(p.key, p.label)))),
    h('optgroup', { label: '範囲を指定' }, option('months', '月で指定…'), monthsOnly ? null : option('dates', '日付で指定…')),
  );
  const monthSel = (label, pick) => h('select', { 'aria-label': label, onchange: (e) => (pick(e.target.value), update()) }, months.map((m) => h('option', { value: m, text: monthText(m) })));
  const fromMonthSel = monthSel('開始月', (v) => (r = parseRange(period, v, r.to.slice(0, 7))));
  const toMonthSel = monthSel('終了月', (v) => (r = parseRange(period, r.from.slice(0, 7), v)));
  const dateInput = (label, pick) =>
    h('input', {
      type: 'date',
      'aria-label': label,
      min: period.startDate,
      max: period.endDate,
      onchange: (e) => {
        // 消したとき・期間の外の日は期間の初日・末日に寄せる（parseRange）
        pick(e.target.value);
        update();
      },
    });
  const fromDate = dateInput('開始日', (v) => (r = parseRange(period, v || period.startDate, r.to)));
  const toDate = dateInput('終了日', (v) => (r = parseRange(period, r.from, v || period.endDate)));
  const monthsRow = h('div', { class: 'range-custom' }, fromMonthSel, h('span', { class: 'muted', text: '〜' }), toMonthSel);
  const datesRow = h('div', { class: 'range-custom' }, fromDate, h('span', { class: 'muted', text: '〜' }), toDate);
  const label = h('span', { class: 'range-label muted small' });

  function choose(key) {
    mode = key;
    const p = presets.find((x) => x.key === key);
    if (p) r = { from: p.from, to: p.to };
    update();
  }
  function sync() {
    monthsRow.hidden = mode !== 'months';
    datesRow.hidden = mode !== 'dates';
    fromMonthSel.value = r.from.slice(0, 7);
    toMonthSel.value = r.to.slice(0, 7);
    fromDate.value = r.from;
    toDate.value = r.to;
    label.textContent = formatRange(r);
  }
  function refreshUrl() {
    const params = new URLSearchParams({ ...extra(), ...rangeQuery(period, r) });
    history.replaceState(history.state, '', `#${path}?${params}`);
  }
  function update() {
    sync();
    refreshUrl();
    onChange();
  }
  sync();
  const el = h('div', { class: 'range-bar' }, h('div', { class: 'range-row' }, presetSel, label), monthsRow, datesRow);
  return { el, refreshUrl, range: () => rangeResult(period, r) };
}

/**
 * 貸借対照表の時点の選択：期末・各月末と「日付で指定」。変更するとハッシュの at（期末なら書かない）を書き換えて onChange を呼ぶ
 * @param {{ period, query, path: string, onChange: () => void, extra?: () => object }} opts
 * @returns {{ el, refreshUrl, value: () => string }} value：時点の日付（'YYYY-MM-DD'）
 */
export function asOfPicker({ period, query, path, onChange, extra = () => ({}) }) {
  const clamp = (d) => (d < period.startDate ? period.startDate : d > period.endDate ? period.endDate : d);
  const ends = monthsInPeriod(period)
    .map((m) => monthRange(period, m, m).to)
    .filter((d) => d !== period.endDate);
  let at = isValidDate(query.at) ? clamp(query.at) : period.endDate;
  let mode = at === period.endDate ? 'end' : ends.includes(at) ? at : 'date';
  const option = (value, text) => h('option', { value, text, selected: value === mode });
  const sel = h(
    'select',
    { class: 'range-preset', 'aria-label': '時点', onchange: (e) => ((mode = e.target.value), mode !== 'date' && (at = mode === 'end' ? period.endDate : mode), update()) },
    option('end', '期末'),
    ends.length ? h('optgroup', { label: '月末' }, ends.map((d) => option(d, `${d.slice(0, 4)}年${Number(d.slice(5, 7))}月末`))) : null,
    h('optgroup', { label: '時点を指定' }, option('date', '日付で指定…')),
  );
  const input = h('input', { type: 'date', 'aria-label': '時点の日付', min: period.startDate, max: period.endDate, onchange: (e) => ((at = clamp(e.target.value || period.endDate)), update()) });
  const row = h('div', { class: 'range-custom' }, input);
  const label = h('span', { class: 'range-label muted small' });
  function sync() {
    row.hidden = mode !== 'date';
    input.value = at;
    label.textContent = `${at.replaceAll('-', '/')} 現在`;
  }
  function refreshUrl() {
    const params = new URLSearchParams({ ...extra(), ...(at === period.endDate ? {} : { at }) });
    const qs = String(params);
    history.replaceState(history.state, '', `#${path}${qs ? `?${qs}` : ''}`);
  }
  function update() {
    sync();
    refreshUrl();
    onChange();
  }
  sync();
  return { el: h('div', { class: 'range-bar' }, h('div', { class: 'range-row' }, sel, label), row), refreshUrl, value: () => at };
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

// 画面ごとに選んだ決算書の様式（アプリを開いている間だけ覚える。帳簿のデータではないので保存しない）
const chosenFormats = new Map();
const FORMAT_CHOICES = { report: '報告式（上下に並べる）', account: '勘定式（左右に並べる）' };

/**
 * 決算書の様式（報告式・勘定式）の切替。選ぶと onChange を呼ぶ。印刷条件の様式は画面で選んだものを最初に選んでおく
 * @param {{ key: string, value: 'report'|'account', onChange: (v) => void }} opts key：画面ごとに覚えるための名前。value：初めの様式
 * @returns {{ el, value: () => 'report'|'account' }}
 */
export function formatPicker({ key, value = 'report', onChange }) {
  let v = chosenFormats.get(key) ?? value;
  const seg = segmented({
    name: '決算書の様式',
    options: [
      { value: 'report', label: '報告式' },
      { value: 'account', label: '勘定式' },
    ],
    value: v,
    onChange: (x) => {
      v = x;
      chosenFormats.set(key, x);
      onChange(x);
    },
  });
  const el = h('div', { class: 'unit-bar format-bar no-print' }, h('div', { class: 'unit-row' }, h('span', { class: 'unit-label small', text: '様式' }), seg));
  return { el, value: () => v };
}

/** 印刷条件：決算書の様式（報告式・勘定式） */
export function formatPrintOption({ key = 'format', label = '様式', value = 'report' } = {}) {
  return { key, label, type: 'select', choices: Object.entries(FORMAT_CHOICES), value };
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

/** 金額のセルに見出し（スマホの2段表示で金額の前に出す）を付ける */
export function labelCell(n, label, opts) {
  const el = amountCell('td', n, opts);
  el.dataset.label = label;
  return el;
}

/**
 * 元帳・出納帳の表の行：取引の行（row(r) で作る）と、月が変わるところに「N月計」（借方・貸方・月末残高）と「累計」の行
 * @param {object} lg ledger.generalLedger の結果
 * @param {{ row: (r) => Element, monthly?: boolean, labels?: [string, string] }} opts labels：借方・貸方の見出し（出納帳は入金・出金）
 */
export function ledgerBodyRows(lg, { row, monthly = true, labels = ['借方', '貸方'] }) {
  const [dl, cl] = labels;
  const rows = [];
  let month = '';
  let md = 0;
  let mc = 0;
  let cd = 0;
  let cc = 0;
  let last = lg.carried;
  const monthEnd = () => {
    if (!month || !monthly) return;
    rows.push(h('tr', { class: 'lg-month' }, h('td'), h('td', { text: `${Number(month.slice(5))}月計` }), labelCell(md, dl), labelCell(mc, cl), labelCell(last, '残高')));
    rows.push(h('tr', { class: 'lg-cum' }, h('td'), h('td', { text: '累計' }), labelCell(cd, dl), labelCell(cc, cl), h('td')));
  };
  for (const r of lg.rows) {
    const m = r.date.slice(0, 7);
    if (m !== month) {
      monthEnd();
      month = m;
      md = 0;
      mc = 0;
    }
    md += r.debit;
    mc += r.credit;
    cd += r.debit;
    cc += r.credit;
    last = r.balance;
    rows.push(row(r));
  }
  monthEnd();
  return rows;
}

/**
 * 元帳の1科目（総勘定元帳・補助元帳）：上に繰越・借方合計・貸方合計・残高の要約、表は月ごとに「月計」と「累計」の行を入れる
 * （弥生会計・勘定奉行の元帳と同じ並び）。スマホでは1件を2段（日付・相手科目／金額・残高）にして横にはみ出さない
 * @param {object} lg ledger.generalLedger の結果
 * @param {{ period, from, title?: string, meta?: string, id?: string, showEmpty?: boolean, monthly?: boolean }} opts
 *   title：見出し（続けて表示するとき）。meta：件数の行の先頭に付ける文字。monthly：月計・累計の行
 */
export function ledgerSection(lg, { period, from, title = '', meta = '', id = null, showEmpty = true, monthly = true }) {
  const side = lg.account.normalSide === 'debit' ? '借方残' : '貸方残';
  const cell = labelCell;
  const rows = ledgerBodyRows(lg, {
    monthly,
    row: (r) =>
      h(
        'tr',
        { class: 'lg-row' },
        h('td', { class: 'nowrap lg-date' }, h('a', { href: `#/journal/${encodeURIComponent(r.journal.id)}/edit`, text: r.date.slice(5).replace('-', '/') }), h('span', { class: 'lg-no', text: `No.${r.voucherNo ?? r.no}` })),
        h('td', { class: 'lg-desc' }, h('span', { class: 'lg-counter', text: r.counterpart }), r.memo ? h('span', { class: 'lg-memo', text: r.memo }) : null),
        cell(r.debit, '借方', { blankZero: true }),
        cell(r.credit, '貸方', { blankZero: true }),
        cell(r.balance, '残高'),
      ),
  });
  const stat = (label, n) => h('div', { class: 'lg-stat' }, h('span', { class: 'lg-stat-label', text: label }), amountCell('span', n));
  return h(
    'section',
    { class: 'lg-section', id },
    title ? h('h2', { class: 'section-title', text: title }) : null,
    h('p', { class: 'list-meta', text: `${meta}${side}・${lg.rows.length}件` }),
    h('div', { class: 'lg-stats' }, stat(carriedLabel(period, from), lg.carried), stat('借方合計', lg.debit), stat('貸方合計', lg.credit), stat('残高', lg.closing)),
    h(
      'div',
      { class: 'table-wrap' },
      h(
        'table',
        { class: 'report ledger' },
        h('thead', {}, h('tr', {}, ['日付／伝票No.', '相手科目／摘要', '借方', '貸方', '残高'].map((t) => h('th', { scope: 'col', text: t })))),
        h('tbody', {}, h('tr', { class: 'carried' }, h('td'), h('td', { text: carriedLabel(period, from) }), h('td', { class: 'lg-blank' }), h('td', { class: 'lg-blank' }), cell(lg.carried, '残高')), rows),
        h('tfoot', {}, h('tr', {}, h('th', { colspan: 2, text: '合計' }), cell(lg.debit, '借方'), cell(lg.credit, '貸方'), cell(lg.closing, '残高'))),
      ),
    ),
    lg.rows.length || !showEmpty ? null : emptyState('この期間の取引はありません', null, { face: null }),
  );
}

/** 印刷条件の月の選択肢（[['2026-04', '2026年4月'], …]） */
export function monthChoices(period) {
  return monthsInPeriod(period).map((m) => [m, monthText(m)]);
}

/** 印刷条件：開始月・終了月（月の単位の帳票） */
export function monthRangeOptions(period, fromMonth, toMonth) {
  const choices = monthChoices(period);
  return [
    { key: 'from', label: '開始月', type: 'select', choices, value: fromMonth ?? choices[0][0] },
    { key: 'to', label: '終了月', type: 'select', choices, value: toMonth ?? choices.at(-1)[0] },
  ];
}

/**
 * 印刷条件：開始日・終了日（日の単位で選べる帳票）。初めは画面で選んだ範囲
 * @param {{ from?: string, to?: string }} [range] 画面の範囲（省略時は期間全体）
 */
export function dateRangeOptions(period, range = {}) {
  return [
    { key: 'from', label: '開始日', type: 'date', min: period.startDate, max: period.endDate, value: range.from ?? period.startDate },
    { key: 'to', label: '終了日', type: 'date', min: period.startDate, max: period.endDate, value: range.to ?? period.endDate },
  ];
}

/** 印刷条件の開始・終了（月 'YYYY-MM' または日 'YYYY-MM-DD'）から日付の範囲（期間の外は寄せ、前後が逆なら入れ替える） */
export function printRange(period, v) {
  return rangeResult(period, parseRange(period, v.from, v.to));
}
