// 残高試算表
import { h, put, amountCell, saveFile } from '../ui.js';
import { trialBalance, carriedLabel } from '../ledger.js';
import { trialBalanceDoc, docHead } from '../print-forms.js';
import { groupLabel, GROUP_BY_ID } from '../accounts.js';
import { trialBalanceCsv, csvFileName } from '../csv.js';
import { monthRangePicker, zeroToggle, openingWarning, monthRangeOptions, printRange } from './report-common.js';

export async function render({ app, outlet, query }) {
  const { settings, period, accounts, subAccounts, journals } = await app.load();
  const body = h('div');
  let showZero = false;
  const expanded = new Set();
  const picker = monthRangePicker({ period, query, path: '/reports/trial', onChange: paint });
  const zero = zeroToggle((v) => ((showZero = v), paint()));
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
      ],
      build: (v) => {
        const r = printRange(period, v);
        const t = trialBalance({ accounts, subAccounts, period, journals, from: r.from, to: r.to });
        return trialBalanceDoc(t, { head: docHead({ settings, period, ...r, printedAt }), entityType: settings.entityType, carriedLabel: carriedLabel(period, r.from), showZero: v.zero, subs: v.subs, format: v.format, ratio: v.ratio });
      },
    });
    const rows = [];
    let group = null;
    let sub = null;
    const flush = () => {
      if (!sub) return;
      rows.push(h('tr', { class: 'tb-subtotal' }, h('th', { text: `${groupLabel(sub.group, settings.entityType)} 計` }), amountCell('td', sub.opening), amountCell('td', sub.debit, { blankZero: true }), amountCell('td', sub.credit, { blankZero: true }), amountCell('td', sub.closing)));
    };
    for (const r of tb.rows) {
      const moved = r.opening || r.debit || r.credit || r.closing;
      if (!moved && !showZero) continue;
      if (r.account.group !== group) {
        flush();
        group = r.account.group;
        sub = { group, opening: 0, debit: 0, credit: 0, closing: 0 };
        rows.push(h('tr', { class: 'tb-group' }, h('th', { colspan: 5, text: groupLabel(group, settings.entityType) })));
      }
      // 区分の小計は区分の向きで足す（評価勘定は差し引く）
      const sign = r.account.normalSide === GROUP_BY_ID[r.account.group].side ? 1 : -1;
      sub.opening += sign * r.opening;
      sub.debit += r.debit;
      sub.credit += r.credit;
      sub.closing += sign * r.closing;
      const hasSubs = r.subs.length > 0;
      rows.push(
        h(
          'tr',
          { class: hasSubs ? 'tb-has-subs' : '' },
          h(
            'th',
            {},
            hasSubs
              ? h('button', { type: 'button', class: 'link tb-toggle', 'aria-expanded': String(expanded.has(r.account.id)), text: `${expanded.has(r.account.id) ? '▾' : '▸'} ${r.account.name}`, onclick: () => (expanded.has(r.account.id) ? expanded.delete(r.account.id) : expanded.add(r.account.id), paint()) })
              : h('a', { href: `#/reports/ledger?account=${r.account.id}&from=${picker.range().fromMonth}&to=${picker.range().toMonth}`, text: r.account.name }),
          ),
          amountCell('td', r.opening),
          amountCell('td', r.debit, { blankZero: true }),
          amountCell('td', r.credit, { blankZero: true }),
          amountCell('td', r.closing),
        ),
      );
      if (hasSubs && expanded.has(r.account.id)) {
        for (const s of r.subs) {
          rows.push(
            h(
              'tr',
              { class: 'tb-sub' },
              h('th', {}, s.subAccount ? h('a', { href: `#/reports/ledger?account=${r.account.id}&sub=${s.subAccount.id}`, text: s.subAccount.name }) : '補助なし'),
              amountCell('td', s.opening),
              amountCell('td', s.debit, { blankZero: true }),
              amountCell('td', s.credit, { blankZero: true }),
              amountCell('td', s.closing),
            ),
          );
        }
      }
    }
    flush();
    const ok = tb.totals.debit === tb.totals.credit && tb.totals.closingDebit === tb.totals.closingCredit;
    put(body, 
      openingWarning(settings.entityType === 'individual' ? 0 : tb.openingDiff),
      h(
        'div',
        { class: 'table-wrap' },
        h(
          'table',
          { class: 'report tb' },
          h('thead', {}, h('tr', {}, ['勘定科目', '繰越残高', '借方', '貸方', '残高'].map((t) => h('th', { scope: 'col', text: t })))),
          h('tbody', {}, rows),
          h('tfoot', {}, h('tr', {}, h('th', { text: '合計' }), h('td'), amountCell('td', tb.totals.debit), amountCell('td', tb.totals.credit), h('td'))),
        ),
      ),
      h('p', { class: `check-line ${ok ? 'ok' : 'ng'}`, text: ok ? `借方合計＝貸方合計（${tb.totals.debit.toLocaleString('ja-JP')}円）。残高の借方・貸方も一致しています` : '借方と貸方の合計が一致していません' }),
    );
  }

  put(outlet, 
    picker.el,
    zero.el,
    body,
    h(
      'div',
      { class: 'actions' },
      h('button', { type: 'button', class: 'btn', text: 'CSVで書き出す', onclick: () => saveFile(new Blob([trialBalanceCsv(tb, settings.entityType)], { type: 'text/csv' }), csvFileName('trial-balance')) }),
    ),
  );
  paint();
}
