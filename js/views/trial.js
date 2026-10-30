// 残高試算表
import { h, put, amountCell, saveFile } from '../ui.js';
import { trialBalance, carriedLabel } from '../ledger.js';
import { trialBalanceDoc, docHead } from '../print-forms.js';
import { trialRows } from '../trial-rows.js';
import { trialBalanceCsv, csvFileName } from '../csv.js';
import { monthRangePicker, zeroToggle, openingWarning, monthRangeOptions, printRange, unitPicker, unitPrintOptions } from './report-common.js';
import { normalizeUnit, formatAmount } from '../money.js';
import { isWhite } from '../white-return.js';

export async function render({ app, outlet, query }) {
  const { settings, period, accounts, subAccounts, journals } = await app.load();
  const body = h('div');
  let showZero = false;
  const expanded = new Set();
  const picker = monthRangePicker({ period, query, path: '/reports/trial', onChange: paint });
  const zero = zeroToggle((v) => ((showZero = v), paint()));
  const unit = unitPicker({ key: '/reports/trial', onChange: () => paint() });
  // スマホの幅では、まず科目・繰越・残高だけを出す（借方・貸方の列は切り替えで出す）
  let compact = typeof matchMedia === 'function' && matchMedia('(max-width: 560px)').matches;
  const compactInput = h('input', { type: 'checkbox', checked: !compact, onchange: (e) => ((compact = !e.target.checked), paint()) });
  let tb;

  function paint() {
    const { from, to } = picker.range();
    tb = trialBalance({ accounts, subAccounts, period, journals, from, to });
    // 印刷：貸借対照表と損益計算書の科目に分けた残高試算表の様式
    // 印刷条件：様式（合計残高試算表・残高試算表）・期間・補助科目の内訳・0円の科目・構成比
    const range = picker.range();
    app.printDoc = ({ printedAt }) => ({
      options: [
        { key: 'format', label: '様式', type: 'select', choices: [['total', '合計残高試算表'], ['balance', '残高試算表（繰越・借方・貸方・残高）']], value: 'total' },
        ...monthRangeOptions(period, range.fromMonth, range.toMonth),
        { key: 'subs', label: '補助科目の内訳を出す', type: 'check', value: false },
        { key: 'zero', label: '0円の科目も出す', type: 'check', value: showZero },
        { key: 'ratio', label: '構成比（残高試算表）', type: 'check', value: true },
        ...unitPrintOptions(unit.value()),
      ],
      build: (v) => {
        const r = printRange(period, v);
        const t = trialBalance({ accounts, subAccounts, period, journals, from: r.from, to: r.to });
        return trialBalanceDoc(t, { head: docHead({ settings, period, ...r, printedAt }), entityType: settings.entityType, white: isWhite(settings), carriedLabel: carriedLabel(period, r.from), showZero: v.zero, subs: v.subs, format: v.format, ratio: v.ratio, unit: normalizeUnit(v) });
      },
    });
    const carried = carriedLabel(period, range.from);
    const parts = trialRows(tb, { entityType: settings.entityType, white: isWhite(settings), showZero });
    const cell = (n, opts) => amountCell('td', n, opts);
    const sumCells = (t, withOpening) => [withOpening ? cell(t.opening, { blankZero: true }) : null, cell(t.debit, { blankZero: true }), cell(t.credit, { blankZero: true }), cell(t.closing)];
    // 残高だけの行（段階利益など）：繰越・借方・貸方の欄は空けて、列の数をそろえる（スマホで借方・貸方の列を隠すため）
    const amountOnly = (n, withOpening) => [withOpening ? h('td') : null, h('td'), h('td'), cell(n)];

    /** 貸借対照表・損益計算書・製造原価の科目の表（区分の見出し・科目・区分の合計・部の合計・段階利益） */
    function sectionTable(caption, list) {
      // 損益計算書の科目は期首の残高が無いので、期間の途中から見るとき（前月繰越）だけ繰越の列を出す
      const withOpening = caption === '貸借対照表の科目' || list.some((r) => r.kind === 'account' && r.row.opening);
      const cols = withOpening ? 5 : 4;
      const rows = [];
      for (const r of list) {
        if (r.kind === 'group') rows.push(h('tr', { class: 'tb-group' }, h('th', { colspan: cols, scope: 'colgroup', text: r.label })));
        else if (r.kind === 'account') {
          const a = r.row.account;
          const hasSubs = r.row.subs.length > 0;
          const open = expanded.has(a.id);
          rows.push(
            h(
              'tr',
              { class: hasSubs ? 'tb-has-subs' : '' },
              h(
                'th',
                { scope: 'row' },
                hasSubs
                  ? h('button', { type: 'button', class: 'link tb-toggle', 'aria-expanded': String(open), text: `${open ? '▾' : '▸'} ${a.name}`, onclick: () => (open ? expanded.delete(a.id) : expanded.add(a.id), paint()) })
                  : h('a', { href: `#/reports/ledger?account=${a.id}&from=${range.fromMonth}&to=${range.toMonth}`, text: a.name }),
              ),
              ...sumCells(r.row, withOpening),
            ),
          );
          if (hasSubs && open) {
            for (const sa of r.row.subs) {
              rows.push(h('tr', { class: 'tb-sub' }, h('th', { scope: 'row' }, sa.subAccount ? h('a', { href: `#/reports/ledger?account=${a.id}&sub=${sa.subAccount.id}`, text: sa.subAccount.name }) : '補助なし'), ...sumCells(sa, withOpening)));
            }
          }
        } else if (r.kind === 'subtotal' || r.kind === 'total') rows.push(h('tr', { class: `tb-${r.kind}` }, h('th', { scope: 'row', text: r.label }), ...sumCells(r.sum, withOpening)));
        else if (r.kind === 'calc') rows.push(h('tr', { class: 'tb-calc' }, h('th', { scope: 'row', text: r.label }), ...amountOnly(r.amount, withOpening)));
        else rows.push(h('tr', { class: r.strong ? 'tb-net' : 'tb-profit' }, h('th', { scope: 'row', text: r.label }), ...amountOnly(r.amount, withOpening)));
      }
      const head = h('tr', {}, h('th', { scope: 'col', text: '勘定科目' }), withOpening ? h('th', { scope: 'col', text: carried }) : null, h('th', { scope: 'col', text: '借方' }), h('th', { scope: 'col', text: '貸方' }), h('th', { scope: 'col', text: '残高' }));
      return h(
        'section',
        { class: 'tb-section' },
        h('h2', { class: 'tb-caption', text: caption }),
        list.length
          ? h('div', { class: 'table-wrap' }, h('table', { class: `report tb tb-trial ${compact ? 'tb-compact' : ''} ${withOpening ? '' : 'tb-no-open'}`.trim(), 'aria-label': caption }, h('thead', {}, head), h('tbody', {}, rows)))
          : h('p', { class: 'muted small', text: '残高・取引のある科目がありません。' }),
      );
    }

    const ok = tb.totals.debit === tb.totals.credit && tb.totals.closingDebit === tb.totals.closingCredit;
    put(
      body,
      openingWarning(settings.entityType === 'individual' ? 0 : tb.openingDiff),
      sectionTable('貸借対照表の科目', parts.bs.rows),
      sectionTable('損益計算書の科目', parts.pl.rows),
      parts.mfg.rows.length ? sectionTable('製造原価の科目', parts.mfg.rows) : null,
      h(
        'div',
        { class: 'tb-grand' },
        h('span', { class: 'tb-grand-label', text: '借方合計' }),
        h('span', { class: 'num', text: formatAmount(tb.totals.debit, unit.value()) }),
        h('span', { class: 'tb-grand-label', text: '貸方合計' }),
        h('span', { class: 'num', text: formatAmount(tb.totals.credit, unit.value()) }),
      ),
      h('p', { class: `check-line ${ok ? 'ok' : 'ng'}`, text: ok ? `借方合計＝貸方合計（${tb.totals.debit.toLocaleString('ja-JP')}円）。残高の借方・貸方も一致しています` : '借方と貸方の合計が一致していません' }),
    );
  }

  put(
    outlet,
    picker.el,
    unit.el,
    h('div', { class: 'toggles' }, zero.el, h('label', { class: 'check small' }, compactInput, '借方・貸方の列も表示')),
    body,
    h(
      'div',
      { class: 'actions' },
      h('button', { type: 'button', class: 'btn', text: 'CSVで書き出す', onclick: () => saveFile(new Blob([trialBalanceCsv(tb, settings.entityType)], { type: 'text/csv' }), csvFileName('trial-balance')) }),
    ),
  );
  paint();
}
