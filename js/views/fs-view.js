// 決算書の画面の部品：紙の決算書と同じ配置（fs-rows.js の行）で、損益計算書・貸借対照表を表示する
//   損益計算書・製造原価報告書：科目｜金額（内訳）｜金額（合計）。区分の合計は区分の最後の科目の行の右の列
//   貸借対照表：勘定式（広い画面は左右、スマホは上下）。区分の合計は区分の見出しの行、最後に資産合計と負債・純資産合計
import { h, amountCell } from '../ui.js';
import { incomeStatementRows, balanceSheetRows, singleAmount } from '../fs-rows.js';
import { periodText, warekiText } from '../print-layout.js';

const spaced = (t) => [...t].join(' ');
const labelOf = (r) => (r.kind === 'heading' ? `【${r.label}】` : r.kind === 'note' ? `（${r.label}）` : r.label);

/** 金額のセル（rule：上の線・二重線。paren：括弧で囲む） */
function amount(n, { rule = null, paren = false } = {}) {
  if (n == null) return h('td', { class: 'num' });
  const cell = amountCell('td', n, { cls: rule ? `fs-${rule}` : '' });
  if (paren) cell.textContent = `(${cell.textContent})`;
  return cell;
}

/**
 * 決算書の用紙（表題・期間・事業者名・単位と本文）
 * @param {{ title: string, period: string, company: string, unit: string, body, id?: string }} p period は「自 令和…　至 令和…」など
 */
export function fsPaper({ title, period, company, unit, body, id = null, cls = '' }) {
  return h(
    'section',
    { class: `fs-paper ${cls}`.trim(), id, 'aria-label': title },
    h('header', { class: 'fs-head' }, h('h2', { class: title.length > 7 ? 'fs-ptitle is-long' : 'fs-ptitle', text: title.length > 7 ? title : spaced(title) }), period ? h('p', { class: 'fs-period', text: period }) : null, h('div', { class: 'fs-meta' }, h('span', { class: 'fs-company', text: company }), h('span', { class: 'fs-unit', text: unit }))),
    body,
  );
}

/** 期間の見出し（損益計算書：自・至、貸借対照表：現在） */
export const fsPeriod = {
  range: (period) => periodText(period.startDate, period.endDate),
  at: (date) => `${warekiText(date)} 現在`,
};

/**
 * 損益計算書・製造原価報告書の表
 * @param {Array} items statements.js の items
 */
export function incomeStatementTable(items, { entityType, showZero = false, label = '損益計算書' }) {
  const rows = incomeStatementRows(items, { entityType, showZero });
  return h(
    'div',
    { class: 'fs-wrap' },
    h(
      'table',
      { class: 'fs-table fs-pl', 'aria-label': label },
      h('colgroup', {}, h('col', { class: 'fs-c-label' }), h('col', { class: 'fs-c-amt' }), h('col', { class: 'fs-c-amt' })),
      h('thead', {}, h('tr', {}, h('th', { scope: 'col', text: '科　目' }), h('th', { scope: 'col', colspan: 2, class: 'fs-amt-head', text: '金　額' }))),
      h(
        'tbody',
        {},
        rows.map((r) => h('tr', { class: `fs-r-${r.kind}` }, h('th', { scope: 'row', class: `lv${r.level}`, text: labelOf(r) }), amount(r.inner, { paren: r.paren }), amount(r.outer, { rule: r.rule }))),
      ),
    ),
  );
}

/**
 * 内訳書（販売費及び一般管理費内訳書など）の表：科目｜金額、最後に合計（二重線）
 * @param {Array<{ account, amount }>} lines
 */
export function breakdownTable(lines, total, { showZero = false, label = '内訳書' } = {}) {
  return h(
    'div',
    { class: 'fs-wrap' },
    h(
      'table',
      { class: 'fs-table fs-pl fs-breakdown', 'aria-label': label },
      h('colgroup', {}, h('col', { class: 'fs-c-label' }), h('col', { class: 'fs-c-amt' })),
      h('thead', {}, h('tr', {}, h('th', { scope: 'col', text: '科　目' }), h('th', { scope: 'col', class: 'fs-amt-head', text: '金　額' }))),
      h(
        'tbody',
        {},
        lines.filter((l) => showZero || l.amount).map((l) => h('tr', { class: 'fs-r-line' }, h('th', { scope: 'row', class: 'lv1', text: l.account.name }), amount(l.amount))),
        h('tr', { class: 'fs-r-net' }, h('th', { scope: 'row', text: '合　計' }), amount(total, { rule: 'double' })),
      ),
    ),
  );
}

/**
 * 貸借対照表（勘定式）。広い画面では左右、狭い画面では上下に並べる
 * @param {object} bs statements.js の balanceSheet の結果
 */
export function balanceSheetView(bs, { entityType, showZero = false }) {
  const b = balanceSheetRows(bs, { entityType, showZero });
  const side = (rows, total, label) =>
    h(
      'div',
      { class: 'fs-side' },
      h(
        'table',
        { class: 'fs-table fs-bs-table', 'aria-label': label },
        h('colgroup', {}, h('col', { class: 'fs-c-label' }), h('col', { class: 'fs-c-amt' })),
        h(
          'tbody',
          {},
          rows.map((r) =>
            r.kind === 'part'
              ? h('tr', { class: 'fs-r-part' }, h('th', { scope: 'colgroup', colspan: 2, text: spaced(r.label) }))
              : h('tr', { class: `fs-r-${r.kind}` }, h('th', { scope: 'row', class: `lv${r.level}`, text: labelOf(r) }), amount(singleAmount(r), { rule: r.kind === 'total' ? 'over' : null, paren: r.paren })),
          ),
        ),
      ),
      h('table', { class: 'fs-table fs-bs-table fs-grand-table', 'aria-label': `${label}の合計` }, h('colgroup', {}, h('col', { class: 'fs-c-label' }), h('col', { class: 'fs-c-amt' })), h('tbody', {}, h('tr', { class: 'fs-r-grand' }, h('th', { scope: 'row', text: total.label }), amount(total.amount, { rule: 'double' })))),
    );
  return h('div', { class: 'fs-bs' }, side(b.assets, b.assetTotal, '資産の部'), side(b.liabilities, b.liabilityTotal, entityType === 'individual' ? '負債・資本の部' : '負債・純資産の部'));
}
