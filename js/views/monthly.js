// 月次推移表：損益（月ごとの発生額）と貸借（月末残高）。損益は売上・利益のグラフ付き
import { h, put, amountCell, saveFile, segmented, showToast } from '../ui.js';
import { monthlyIncome, monthlyBalance, isAllZero } from '../monthly.js';
import { monthlyCsv, csvFileName } from '../csv.js';
import { barLineChart } from '../chart.js';
import { zeroToggle, openingWarning, unitPicker, unitPrintOptions } from './report-common.js';
import { monthlyDoc, docHead } from '../print-forms.js';
import { normalizeUnit } from '../money.js';
import { openingDiff } from '../ledger.js';

export async function render({ app, outlet, query }) {
  const { settings, period, accounts, journals } = await app.load();
  const entityType = settings.entityType;
  const individual = entityType === 'individual';
  let mode = query.mode === 'bs' ? 'bs' : 'pl';
  let showZero = false;
  const body = h('div');
  const zero = zeroToggle((v) => ((showZero = v), paint()));
  const unit = unitPicker({ key: '/reports/monthly', onChange: () => paint() });
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

  // 印刷：A4横の推移表。印刷条件：損益・貸借（両方も）・0円の科目・金額の単位
  // 両方を印刷するときは、損益計算書と貸借対照表でページを分け、それぞれの表題にする
  const toRows = (items, total) => {
    const rows = [];
    for (const item of items) {
      const tail = (x) => (total ? [...x.values, x.total] : x.values);
      if (item.type === 'group') {
        const lines = item.lines.filter((l) => !isAllZero(l.values) || printZero);
        if (!lines.length) continue;
        rows.push({ kind: 'group', label: item.label, values: tail(item) });
        for (const l of lines) rows.push({ kind: 'line', label: l.account.name, values: tail(l) });
      } else rows.push({ kind: item.strong ? 'total' : 'subtotal', label: item.label, values: tail(item) });
    }
    return rows;
  };
  let printZero = false;
  app.printDoc = ({ printedAt }) => ({
    options: [
      { key: 'mode', label: '印刷する表', type: 'select', choices: [['pl', '損益（月ごと）'], ['bs', '貸借（月末残高）'], ['both', '損益と貸借']], value: mode },
      { key: 'zero', label: '0円の科目も出す', type: 'check', value: showZero },
      ...unitPrintOptions(unit.value()),
      { key: 'orientation', label: '用紙の向き', type: 'select', choices: [['landscape', 'A4横'], ['portrait', 'A4縦']], value: 'landscape' },
    ],
    build: (v) => {
      printZero = v.zero;
      const both = v.mode === 'both';
      const sections = [];
      if (v.mode !== 'bs') sections.push({ title: both ? '月次推移表（損益計算書）' : '', caption: both ? '各月の発生額' : '', columns: [...income.months.map(monthLabel), '合計'], rows: toRows(income.items, true) });
      if (v.mode !== 'pl') {
        balance = balance || monthlyBalance(ctx);
        const columns = balance.months.map(monthLabel);
        sections.push(
          { title: both ? '月次推移表（貸借対照表）' : '', caption: '資産の部（月末残高）', columns, rows: toRows(balance.assets, false) },
          { caption: individual ? '負債・資本の部（月末残高）' : '負債・純資産の部（月末残高）', columns, rows: toRows(balance.liabilities, false) },
        );
      }
      return monthlyDoc({
        title: v.mode === 'bs' ? '月次推移表（貸借対照表）' : v.mode === 'pl' ? '月次推移表（損益計算書）' : '月次推移表',
        head: docHead({ settings, period, printedAt }),
        columns: [],
        sections,
        unit: normalizeUnit(v),
        orientation: v.orientation,
      });
    },
  });

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
      unit.el,
      zero.el,
    ),
    body,
    h('div', { class: 'actions' }, csvBtn),
  );
  paint();
}
