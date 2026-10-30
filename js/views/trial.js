// 残高試算表
import { h, put, amountCell, saveFile, segmented } from '../ui.js';
import { trialBalance, carriedLabel } from '../ledger.js';
import { trialBalanceDoc, docHead, ratioText, TRIAL_PARTS } from '../print-forms.js';
import { trialRows } from '../trial-rows.js';
import { trialBalanceCsv, csvFileName } from '../csv.js';
import { monthRangePicker, zeroToggle, openingWarning, monthRangeOptions, printRange, unitPicker, unitPrintOptions } from './report-common.js';
import { normalizeUnit, formatAmount } from '../money.js';
import { isWhite } from '../white-return.js';

export async function render({ app, outlet, query }) {
  const { settings, period, accounts, subAccounts, journals } = await app.load();
  const entityType = settings.entityType;
  const individual = entityType === 'individual';
  const body = h('div');
  let showZero = false;
  const expanded = new Set();
  // 部（貸借対照表・損益計算書・製造原価）はタブで切り替える。製造原価のタブは製造原価の科目を使っているときだけ
  const full = trialRows(trialBalance({ accounts, subAccounts, period, journals }), { entityType, white: isWhite(settings), showZero: false });
  const partList = TRIAL_PARTS.filter(([key]) => key !== 'mfg' || full.mfg.rows.length);
  let part = partList.some(([key]) => key === query.part) ? query.part : 'bs';
  const picker = monthRangePicker({ period, query, path: '/reports/trial', onChange: paint, extra: () => (part === 'bs' ? {} : { part }) });
  const zero = zeroToggle((v) => ((showZero = v), paint()));
  const unit = unitPicker({ key: '/reports/trial', onChange: () => paint() });
  // スマホの幅では、まず科目・繰越・残高だけを出す（借方・貸方・構成比の列は切り替えで出す）
  let compact = typeof matchMedia === 'function' && matchMedia('(max-width: 560px)').matches;
  const compactInput = h('input', { type: 'checkbox', checked: !compact, onchange: (e) => ((compact = !e.target.checked), paint()) });
  let tb;

  function paint() {
    const { from, to } = picker.range();
    tb = trialBalance({ accounts, subAccounts, period, journals, from, to });
    // 印刷：勘定科目を左端に置き、貸借対照表・損益計算書・製造原価の部ごとに改ページする
    // 印刷条件：様式（残高試算表・合計残高試算表）・印刷する部・期間・補助科目の内訳・0円の科目・構成比
    const range = picker.range();
    app.printDoc = ({ printedAt }) => ({
      options: [
        { key: 'format', label: '様式', type: 'select', choices: [['balance', '残高試算表（繰越・借方・貸方・残高・構成比）'], ['total', '合計残高試算表（合計・残高の借方・貸方）']], value: 'balance' },
        { key: 'parts', label: '印刷する部', type: 'select', choices: [['all', 'すべて（部ごとに改ページ）'], ...partList.map(([key, name]) => [key, `${name}だけ`])], value: 'all' },
        ...monthRangeOptions(period, range.fromMonth, range.toMonth),
        { key: 'subs', label: '補助科目の内訳を出す', type: 'check', value: false },
        { key: 'zero', label: '0円の科目も出す', type: 'check', value: showZero },
        { key: 'ratio', label: '構成比（残高試算表）', type: 'check', value: true },
        ...unitPrintOptions(unit.value()),
      ],
      build: (v) => {
        const r = printRange(period, v);
        const t = trialBalance({ accounts, subAccounts, period, journals, from: r.from, to: r.to });
        return trialBalanceDoc(t, {
          head: docHead({ settings, period, ...r, printedAt }),
          entityType,
          white: isWhite(settings),
          carriedLabel: carriedLabel(period, r.from),
          showZero: v.zero,
          subs: v.subs,
          format: v.format,
          ratio: v.ratio,
          unit: normalizeUnit(v),
          parts: v.parts === 'all' ? undefined : [v.parts],
        });
      },
    });
    const carried = carriedLabel(period, range.from);
    const parts = trialRows(tb, { entityType, white: isWhite(settings), showZero });
    const cell = (n, opts) => amountCell('td', n, opts);
    const rate = (n, base) => h('td', { class: 'num tb-rate', text: ratioText(n, base) });
    const lineCells = (t, withOpening) => [withOpening ? cell(t.opening, { blankZero: true }) : null, cell(t.debit, { blankZero: true }), cell(t.credit, { blankZero: true }), cell(t.closing)];
    const sumCells = (t, withOpening, base) => [...lineCells(t, withOpening), rate(t.closing, base)];
    // 残高だけの行（段階利益など）：借方・貸方の欄は空けて、列の数をそろえる（スマホで借方・貸方の列を隠すため）
    const amountOnly = (n, withOpening, base, opening = 0) => [withOpening ? cell(opening, { blankZero: true }) : null, h('td'), h('td'), cell(n), rate(n, base)];

    /** 部（貸借対照表・損益計算書・製造原価）の表（区分の見出し・科目・区分の合計・部の合計・段階利益） */
    function partTable(key, { rows: list, base }) {
      const caption = TRIAL_PARTS.find(([k]) => k === key)[1];
      // 損益計算書の科目は期首の残高が無いので、期間の途中から見るとき（前月繰越）だけ繰越の列を出す
      const withOpening = key === 'bs' || list.some((r) => r.kind === 'account' && r.row.opening);
      const cols = withOpening ? 6 : 5;
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
              ...lineCells(r.row, withOpening),
              rate(r.sign * r.row.closing, base),
            ),
          );
          if (hasSubs && open) {
            for (const sa of r.row.subs) {
              rows.push(h('tr', { class: 'tb-sub' }, h('th', { scope: 'row' }, sa.subAccount ? h('a', { href: `#/reports/ledger?account=${a.id}&sub=${sa.subAccount.id}`, text: sa.subAccount.name }) : '補助なし'), ...lineCells(sa, withOpening), h('td', { class: 'tb-rate' })));
            }
          }
        } else if (r.kind === 'subtotal' || r.kind === 'total') rows.push(h('tr', { class: `tb-${r.kind}${r.grand ? ' tb-lte' : ''}` }, h('th', { scope: 'row', text: r.label }), ...sumCells(r.sum, withOpening, base)));
        else if (r.kind === 'calc') rows.push(h('tr', { class: 'tb-calc' }, h('th', { scope: 'row', text: r.label }), ...amountOnly(r.amount, withOpening, base)));
        else if (r.kind === 'income') rows.push(h('tr', { class: 'tb-calc tb-income' }, h('th', { scope: 'row', text: r.label }), ...amountOnly(r.closing, withOpening, base, r.opening)));
        else rows.push(h('tr', { class: r.strong ? 'tb-net' : 'tb-profit' }, h('th', { scope: 'row', text: r.label }), ...amountOnly(r.amount, withOpening, base)));
      }
      const th = (text, cls) => h('th', { scope: 'col', class: cls, text });
      const head = h('tr', {}, th('勘定科目'), withOpening ? th(carried) : null, th('借方金額'), th('貸方金額'), th('当期残高'), th('構成比', 'tb-rate'));
      return list.length
        ? h('div', { class: 'table-wrap' }, h('table', { class: `report tb tb-trial ${compact ? 'tb-compact' : ''} ${withOpening ? '' : 'tb-no-open'}`.trim(), 'aria-label': `残高試算表（${caption}）` }, h('thead', {}, head), h('tbody', {}, rows)))
        : h('p', { class: 'empty', text: '残高・取引のある科目がありません。' });
    }

    const assets = parts.bs.rows.find((r) => r.kind === 'total' && r.label === '資産合計')?.sum.closing ?? 0;
    const right = parts.bs.rows.find((r) => r.grand)?.sum.closing ?? 0;
    const ok = tb.totals.debit === tb.totals.credit && tb.totals.closingDebit === tb.totals.closingCredit;
    const lteLabel = individual ? '負債・資本合計' : '負債・純資産合計';
    put(
      body,
      openingWarning(individual ? 0 : tb.openingDiff),
      partTable(part, parts[part]),
      part === 'bs' && parts.bs.rows.length
        ? h('p', { class: `check-line ${assets === right ? 'ok' : 'ng'}`, text: assets === right ? `資産合計＝${lteLabel}（${formatAmount(assets, unit.value())}）` : `資産合計と${lteLabel}が一致していません` })
        : null,
      h(
        'div',
        { class: 'tb-grand' },
        h('span', { class: 'tb-grand-label', text: '借方合計' }),
        h('span', { class: 'num', text: formatAmount(tb.totals.debit, unit.value()) }),
        h('span', { class: 'tb-grand-label', text: '貸方合計' }),
        h('span', { class: 'num', text: formatAmount(tb.totals.credit, unit.value()) }),
      ),
      h('p', { class: `check-line ${ok ? 'ok' : 'ng'}`, text: ok ? `全科目の借方合計＝貸方合計（${tb.totals.debit.toLocaleString('ja-JP')}円）。残高の借方・貸方も一致しています` : '借方と貸方の合計が一致していません' }),
    );
  }

  put(
    outlet,
    h(
      'div',
      { class: 'report-tools' },
      segmented({
        name: '表示する部',
        options: partList.map(([value, label]) => ({ value, label })),
        value: part,
        onChange: (v) => {
          part = v;
          picker.refreshUrl();
          paint();
        },
      }),
      picker.el,
      unit.el,
      h('div', { class: 'toggles' }, zero.el, h('label', { class: 'check small' }, compactInput, '借方・貸方・構成比の列も表示')),
    ),
    body,
    h(
      'div',
      { class: 'actions' },
      h('button', { type: 'button', class: 'btn', text: 'CSVで書き出す', onclick: () => saveFile(new Blob([trialBalanceCsv(tb, entityType)], { type: 'text/csv' }), csvFileName('trial-balance')) }),
    ),
  );
  paint();
}
