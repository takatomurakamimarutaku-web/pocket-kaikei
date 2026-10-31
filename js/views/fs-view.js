// 決算書の画面の部品：紙の決算書と同じ配置（fs-rows.js の行）で、損益計算書・貸借対照表を表示する
//   損益計算書・製造原価報告書：科目｜金額（内訳）｜金額（合計）。区分の合計は区分の最後の科目の行の右の列
//   貸借対照表：勘定式（広い画面は左右、スマホは上下）。区分の合計は区分の見出しの行、最後に資産合計と負債・純資産合計
//     報告式は資産の部・負債の部・純資産の部を上から並べ、科目｜金額（内訳）｜金額（合計）
//   損益計算書・製造原価報告書の勘定式：左に借方（費用）、右に貸方（収益）。区分の合計は区分の見出しの行、最後に借方・貸方の合計
//   前期と比べる表：科目｜当期｜前期｜増減額｜増減率（行は compare.js の compareIncomeRows・compareBalanceRows）
import { h, amountCell } from '../ui.js';
import { incomeStatementRows, incomeStatementAccountRows, balanceSheetRows, singleAmount } from '../fs-rows.js';
import { formatPermille } from '../compare.js';
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
 * @param {{ title: string, period: string, period2?: string, company: string, unit: string, body, id?: string }} p
 *   period は「自 令和…　至 令和…」など。period2 は2行目（前期と比べる表の前期の期間）
 */
export function fsPaper({ title, period, period2 = null, company, unit, body, id = null, cls = '' }) {
  return h(
    'section',
    { class: `fs-paper ${cls}`.trim(), id, 'aria-label': title },
    h(
      'header',
      { class: 'fs-head' },
      h('h2', { class: title.length > 7 ? 'fs-ptitle is-long' : 'fs-ptitle', text: title.length > 7 ? title : spaced(title) }),
      period ? h('p', { class: 'fs-period', text: period }) : null,
      period2 ? h('p', { class: 'fs-period fs-period2', text: period2 }) : null,
      h('div', { class: 'fs-meta' }, h('span', { class: 'fs-company', text: company }), h('span', { class: 'fs-unit', text: unit })),
    ),
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
 * 勘定式の表：左右の2つの表（広い画面では左右、狭い画面では上下）と、それぞれの最後の合計（二重線）
 * @param {{ left: Array, right: Array, leftTotal: {label, amount}, rightTotal: {label, amount}, labels: [string, string] }} p
 */
function accountFormView({ left, right, leftTotal, rightTotal, labels, cls = '' }) {
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
      h('table', { class: 'fs-table fs-bs-table fs-grand-table', 'aria-label': `${label}の合計` }, h('colgroup', {}, h('col', { class: 'fs-c-label' }), h('col', { class: 'fs-c-amt' })), h('tbody', {}, h('tr', { class: 'fs-r-grand' }, h('th', { scope: 'row', text: total.label === '合計' ? '合　　計' : total.label }), amount(total.amount, { rule: 'double' })))),
    );
  return h('div', { class: `fs-bs ${cls}`.trim() }, side(left, leftTotal, labels[0]), side(right, rightTotal, labels[1]));
}

/**
 * 貸借対照表（勘定式）。広い画面では左右、狭い画面では上下に並べる
 * @param {object} bs statements.js の balanceSheet の結果
 */
export function balanceSheetView(bs, { entityType, showZero = false }) {
  const b = balanceSheetRows(bs, { entityType, showZero });
  return accountFormView({ left: b.assets, right: b.liabilities, leftTotal: b.assetTotal, rightTotal: b.liabilityTotal, labels: ['資産の部', entityType === 'individual' ? '負債・資本の部' : '負債・純資産の部'] });
}

/**
 * 貸借対照表（報告式）：資産の部・負債の部・純資産の部を上から並べる。科目｜金額（内訳）｜金額（合計）
 * 区分の合計は区分の見出しの右の列、科目は左の列。資産合計・負債・純資産合計は二重線
 */
export function balanceSheetReportTable(bs, { entityType, showZero = false }) {
  const b = balanceSheetRows(bs, { entityType, showZero });
  const line = (r) =>
    r.kind === 'part'
      ? h('tr', { class: 'fs-r-part' }, h('th', { scope: 'colgroup', colspan: 3, text: spaced(r.label) }))
      : h('tr', { class: `fs-r-${r.kind}` }, h('th', { scope: 'row', class: `lv${r.level}`, text: labelOf(r) }), amount(r.inner, { paren: r.paren }), amount(r.outer, { rule: r.rule }));
  const grand = (t) => h('tr', { class: 'fs-r-grand' }, h('th', { scope: 'row', text: t.label }), amount(null), amount(t.amount, { rule: 'double' }));
  return h(
    'div',
    { class: 'fs-wrap' },
    h(
      'table',
      { class: 'fs-table fs-pl fs-bs-report', 'aria-label': '貸借対照表' },
      h('colgroup', {}, h('col', { class: 'fs-c-label' }), h('col', { class: 'fs-c-amt' }), h('col', { class: 'fs-c-amt' })),
      h('thead', {}, h('tr', {}, h('th', { scope: 'col', text: '科　目' }), h('th', { scope: 'col', colspan: 2, class: 'fs-amt-head', text: '金　額' }))),
      h('tbody', {}, b.assets.map(line), grand(b.assetTotal), b.liabilities.map(line), grand(b.liabilityTotal)),
    ),
  );
}

/**
 * 損益計算書・製造原価報告書（勘定式）：左に借方（費用・当期純利益）、右に貸方（収益）。最後に借方・貸方の合計
 * @param {Array} items statements.js の items
 */
export function incomeStatementAccountView(items, { entityType, showZero = false, label = '損益計算書' }) {
  const r = incomeStatementAccountRows(items, { entityType, showZero });
  return accountFormView({ left: r.debit, right: r.credit, leftTotal: r.debitTotal, rightTotal: r.creditTotal, labels: [`${label}（借方）`, `${label}（貸方）`], cls: 'fs-account-pl' });
}

/** 様式（報告式・勘定式）に合わせた損益計算書・製造原価報告書の表 */
export function incomeStatementByFormat(items, { format = 'report', ...opts }) {
  return format === 'account' ? incomeStatementAccountView(items, opts) : incomeStatementTable(items, opts);
}

/** 様式（勘定式・報告式）に合わせた貸借対照表の表 */
export function balanceSheetByFormat(bs, { format = 'account', ...opts }) {
  return format === 'report' ? balanceSheetReportTable(bs, opts) : balanceSheetView(bs, opts);
}

/**
 * 前期と比べる表（比較損益計算書・比較貸借対照表）：科目｜当期｜前期｜増減額｜増減率。
 * スマホでは増減率の列を隠し、増減額の下に小さく書く
 * @param {Array} rows compare.js の compareIncomeRows・compareBalanceRows の行
 * @param {{ labels: [string, string], label: string }} opts labels：当期・前期の列の名前
 */
export function compareTable(rows, { labels, label }) {
  const opts = (r) => ({ rule: r.rule, paren: r.paren });
  const rateText = (r) => (r.diff == null ? '' : formatPermille(r.rate));
  const diffCell = (r) => {
    const cell = amount(r.diff, opts(r));
    if (r.diff != null) cell.append(h('span', { class: 'fs-rate-inline', text: rateText(r) }));
    return cell;
  };
  return h(
    'div',
    { class: 'fs-wrap fs-cmp-wrap' },
    h(
      'table',
      { class: 'fs-table fs-cmp', 'aria-label': label },
      h('colgroup', {}, h('col', { class: 'fs-c-label' }), h('col', { class: 'fs-c-amt' }), h('col', { class: 'fs-c-amt' }), h('col', { class: 'fs-c-amt' })),
      h('thead', {}, h('tr', {}, h('th', { scope: 'col', text: '科　目' }), h('th', { scope: 'col', text: labels[0] }), h('th', { scope: 'col', text: labels[1] }), h('th', { scope: 'col', text: '増減額' }), h('th', { scope: 'col', class: 'fs-c-rate', text: '増減率' }))),
      h(
        'tbody',
        {},
        rows.map((r) =>
          r.kind === 'part'
            ? // 増減率の列はスマホで隠すので、部の見出しは4列にまたがらせ、増減率の列は空のセルにする（隠した列が幅を取らないように）
              h('tr', { class: 'fs-r-part' }, h('th', { scope: 'colgroup', colspan: 4, text: spaced(r.label) }), h('td', { class: 'fs-rate' }))
            : h('tr', { class: `fs-r-${r.kind}` }, h('th', { scope: 'row', class: `lv${r.level}`, text: labelOf(r) }), amount(r.current, opts(r)), amount(r.previous, opts(r)), diffCell(r), h('td', { class: 'fs-rate', text: rateText(r) })),
        ),
      ),
    ),
  );
}
