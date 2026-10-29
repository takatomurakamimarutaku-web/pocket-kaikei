// 月次推移表：損益（月ごとの発生額）と貸借（月末残高）。損益は売上・利益のグラフ付き
import { h, put, amountCell, saveFile, segmented, showToast } from '../ui.js';
import { monthlyIncome, monthlyBalance, isAllZero } from '../monthly.js';
import { monthlyCsv, csvFileName } from '../csv.js';
import { barLineChart } from '../chart.js';
import { zeroToggle, openingWarning } from './report-common.js';
import { openingDiff } from '../ledger.js';

export async function render({ app, outlet, query }) {
  const { settings, period, accounts, journals } = await app.load();
  const entityType = settings.entityType;
  const individual = entityType === 'individual';
  let mode = query.mode === 'bs' ? 'bs' : 'pl';
  let showZero = false;
  const body = h('div');
  const zero = zeroToggle((v) => ((showZero = v), paint()));
  const ctx = { entityType, accounts, period, journals };
  const income = monthlyIncome(ctx);
  let balance = null;
  const monthLabel = (m) => `${Number(m.slice(5))}月`;

  function table(items, months, { total }) {
    const head = h('tr', {}, h('th', { scope: 'col', text: '科目' }), months.map((m) => h('th', { scope: 'col', text: monthLabel(m) })), total ? h('th', { scope: 'col', text: '合計' }) : null);
    const rows = [];
    for (const item of items) {
      if (item.type === 'group') {
        const lines = item.lines.filter((l) => showZero || !isAllZero(l.values));
        if (!lines.length) continue;
        rows.push(h('tr', { class: 'tb-group' }, h('th', { scope: 'row', title: item.label, text: item.label }), item.values.map((v) => amountCell('td', v)), total ? amountCell('td', item.total) : null));
        for (const l of lines) {
          rows.push(h('tr', {}, h('th', { scope: 'row', class: 'mt-acc', text: l.account.name }), l.values.map((v) => amountCell('td', v, { blankZero: true })), total ? amountCell('td', l.total) : null));
        }
      } else {
        rows.push(h('tr', { class: item.strong ? 'mt-strong' : 'tb-subtotal' }, h('th', { scope: 'row', title: item.label, text: item.label }), item.values.map((v) => amountCell('td', v)), total ? amountCell('td', item.total) : null));
      }
    }
    return h('div', { class: 'table-wrap' }, h('table', { class: 'report monthly' }, h('thead', {}, head), h('tbody', {}, rows)));
  }

  function paint() {
    history.replaceState(history.state, '', `#/reports/monthly?mode=${mode}`);
    if (mode === 'pl') {
      put(
        body,
        journals.length
          ? barLineChart({
              labels: income.months.map(monthLabel),
              bar: { label: individual ? '売上(収入)金額' : '売上高', values: income.sales },
              line: { label: individual ? '所得金額（控除前）' : '当期純利益', values: income.netIncome },
              title: '月別の売上と利益',
            })
          : null,
        table(income.items, income.months, { total: true }),
      );
    } else {
      balance = balance || monthlyBalance(ctx);
      const bad = balance.months.filter((_, i) => !balance.balanced[i]);
      put(
        body,
        openingWarning(individual ? 0 : openingDiff(period, accounts)),
        bad.length ? h('p', { class: 'notice', text: `資産合計と負債・純資産合計が一致しない月があります（${bad.map(monthLabel).join('・')}）` }) : null,
        h('p', { class: 'muted small', text: '各月末時点の残高です' }),
        table(balance.assets, balance.months, { total: false }),
        table(balance.liabilities, balance.months, { total: false }),
      );
    }
  }

  const csvBtn = h('button', {
    type: 'button',
    class: 'btn',
    text: 'CSVで書き出す',
    onclick: async () => {
      if (!journals.length && mode === 'pl') return showToast('書き出す取引がありません');
      let text;
      if (mode === 'pl') text = monthlyCsv(income.items, income.months, { total: true, includeZero: showZero });
      else {
        balance = balance || monthlyBalance(ctx);
        text = monthlyCsv([...balance.assets, ...balance.liabilities], balance.months, { includeZero: showZero });
      }
      await saveFile(new Blob([text], { type: 'text/csv' }), csvFileName(mode === 'pl' ? 'monthly-pl' : 'monthly-bs'));
    },
  });

  put(
    outlet,
    h(
      'div',
      { class: 'report-tools' },
      segmented({
        name: '表示',
        options: [
          { value: 'pl', label: '損益（月ごと）' },
          { value: 'bs', label: '貸借（月末残高）' },
        ],
        value: mode,
        onChange: (v) => ((mode = v), paint()),
      }),
      zero.el,
    ),
    body,
    h('div', { class: 'actions' }, csvBtn),
  );
  paint();
}
