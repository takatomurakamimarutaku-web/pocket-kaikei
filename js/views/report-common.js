// 帳票の共通部品（月範囲の選択・0の科目を隠す切替・期首残高の警告）
import { h, put, amountCell } from '../ui.js';
import { monthsInPeriod, monthRange } from '../period.js';
import { formatYen } from '../money.js';

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
