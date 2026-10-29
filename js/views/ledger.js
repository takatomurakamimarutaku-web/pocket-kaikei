// 総勘定元帳（補助科目を選ぶと補助元帳。「すべての科目」で全科目を続けて表示・印刷・CSV 出力）
import { h, put, emptyState, saveFile } from '../ui.js';
import { generalLedger, generalLedgers, subLedgers, carriedLabel } from '../ledger.js';
import { ledgerCsv, csvFileName } from '../csv.js';
import { compareAccounts, groupLabel, GROUPS, GROUP_BY_ID } from '../accounts.js';
import { monthRangePicker, ledgerSection, monthRangeOptions, printRange } from './report-common.js';
import { ledgerBookDoc, docHead } from '../print-forms.js';

export async function render({ app, outlet, query }) {
  const { settings, period, accounts, subAccounts, journals } = await app.load();
  const sorted = [...accounts].sort(compareAccounts);
  const used = new Set(journals.flatMap((j) => j.lines.map((l) => l.accountId)));
  for (const ob of period.openingBalances || []) used.add(ob.accountId);
  const ALL = 'all';
  let accountId = query.account === ALL ? ALL : accounts.some((a) => a.id === query.account) ? query.account : (sorted.find((a) => used.has(a.id)) || sorted[0]).id;
  let subId = subAccounts.some((s) => s.id === query.sub && s.accountId === accountId) ? query.sub : '';

  const accSelect = h(
    'select',
    { 'aria-label': '勘定科目', onchange: (e) => ((accountId = e.target.value), (subId = ''), paintSubs(), update()) },
    h('option', { value: ALL, text: 'すべての科目（取引・残高のある科目）', selected: accountId === ALL }),
    GROUPS.filter((g) => sorted.some((a) => a.group === g.id)).map((g) =>
      h(
        'optgroup',
        { label: groupLabel(g.id, settings.entityType) },
        sorted.filter((a) => a.group === g.id).map((a) => h('option', { value: a.id, text: `${a.code} ${a.name}${used.has(a.id) ? '' : '（取引なし）'}`, selected: a.id === accountId })),
      ),
    ),
  );
  const subSelect = h('select', { 'aria-label': '補助科目', onchange: (e) => ((subId = e.target.value), update()) });
  function paintSubs() {
    const subs = accountId === ALL ? [] : subAccounts.filter((s) => s.accountId === accountId);
    subSelect.hidden = !subs.length;
    put(subSelect, h('option', { value: '', text: 'すべての補助科目' }), ...subs.map((s) => h('option', { value: s.id, text: s.name, selected: s.id === subId })));
  }
  const extra = () => ({ account: accountId, ...(subId ? { sub: subId } : {}) });
  const picker = monthRangePicker({ period, query, path: '/reports/ledger', onChange: paint, extra });
  function update() {
    const r = picker.range();
    history.replaceState(history.state, '', `#/reports/ledger?${new URLSearchParams({ ...extra(), from: r.fromMonth, to: r.toMonth })}`);
    paint();
  }
  const body = h('div');

  function paint() {
    const { from, to } = picker.range();
    const ctx = { accounts, subAccounts, period, journals, from, to };
    const ledgers = accountId === ALL ? generalLedgers(ctx) : [generalLedger({ ...ctx, accountId, subAccountId: subId || null })];
    const subName = subId ? subAccounts.find((s) => s.id === subId)?.name ?? '' : '';
    // 印刷条件：印刷する科目（すべて・BS/PLの科目・1つの科目）・期間・補助科目ごと・月計・累計・改ページ・税区分の列
    const range = picker.range();
    app.printDoc = ({ printedAt }) => ({
      options: [
        {
          key: 'target',
          label: '印刷する科目',
          type: 'select',
          choices: [['all', 'すべての科目（取引・残高のある科目）'], ['bs', '貸借対照表の科目'], ['pl', '損益計算書の科目'], ...sorted.map((a) => [a.id, `${a.code} ${a.name}${used.has(a.id) ? '' : '（取引なし）'}`])],
          value: accountId === ALL ? 'all' : accountId,
        },
        ...monthRangeOptions(period, range.fromMonth, range.toMonth),
        { key: 'subs', label: '補助科目ごとに分ける', type: 'check', value: Boolean(subId) },
        { key: 'empty', label: '取引・残高のない科目も出す', type: 'check', value: false },
        { key: 'monthly', label: '月計を出す', type: 'check', value: true },
        { key: 'cumulative', label: '累計を出す', type: 'check', value: false },
        { key: 'pageBreak', label: '科目ごとに改ページ', type: 'check', value: true },
        { key: 'tax', label: '税区分の列', type: 'check', value: true },
      ],
      build: (v) => {
        const r = printRange(period, v);
        const ctx = { accounts, subAccounts, period, journals, from: r.from, to: r.to };
        const isBs = (a) => GROUP_BY_ID[a.group]?.section !== 'pl';
        const targets = v.target === 'all' ? sorted : v.target === 'bs' ? sorted.filter(isBs) : v.target === 'pl' ? sorted.filter((a) => !isBs(a)) : sorted.filter((a) => a.id === v.target);
        const single = targets.length === 1;
        const list = [];
        for (const a of targets) {
          const hasSubs = subAccounts.some((x) => x.accountId === a.id);
          if (v.subs && hasSubs) {
            list.push(...subLedgers({ ...ctx, accountId: a.id, includeEmpty: v.empty }));
            continue;
          }
          const lg = generalLedger({ ...ctx, accountId: a.id, subAccountId: single && subId && !v.subs ? subId : null });
          if (v.empty || single || lg.rows.length || lg.carried || lg.closing) list.push({ ...lg, subName: single && subId && !v.subs ? subName : '' });
        }
        return ledgerBookDoc(list, {
          head: docHead({ settings, period, ...r, printedAt }),
          carriedLabel: carriedLabel(period, r.from),
          title: v.subs || (single && subId) ? '補助元帳' : '総勘定元帳',
          monthly: v.monthly,
          cumulative: v.cumulative,
          pageBreak: v.pageBreak,
          taxColumn: v.tax,
        });
      },
    });
    const csv = () => saveFile(new Blob([ledgerCsv(ledgers, { carried: carriedLabel(period, from), subName })], { type: 'text/csv' }), csvFileName('ledger'));
    put(
      body,
      ledgers.map((lg) =>
        accountId === ALL
          ? ledgerSection(lg, { period, from, title: `${lg.account.code} ${lg.account.name}`, showEmpty: false })
          : ledgerSection(lg, { period, from, meta: `${lg.account.code} ${lg.account.name}${subName ? `（${subName}）` : ''}・` }),
      ),
      accountId === ALL && !ledgers.length ? emptyState('この期間の取引はありません', null, { face: null }) : null,
      h('div', { class: 'report-tools no-print' }, h('button', { type: 'button', class: 'btn', text: 'CSVで書き出す', onclick: csv })),
    );
  }

  paintSubs();
  put(outlet, h('div', { class: 'ledger-pick' }, accSelect, subSelect), picker.el, body);
  paint();
}
