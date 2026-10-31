// 総勘定元帳（補助科目を選ぶと補助元帳。「すべての科目」で全科目を続けて表示・印刷・CSV 出力）
// 科目はコード・名前で探して選べる。摘要（相手科目・金額も）で明細を絞り込める
import { h, put, emptyState, saveFile } from '../ui.js';
import { searchTokens, normalize } from '../search.js';
import { formatYen } from '../money.js';
import { pickAccount } from './account-picker.js';
import { icon } from '../icons.js';
import { generalLedger, generalLedgers, subLedgers, carriedLabel } from '../ledger.js';
import { ledgerCsv, csvFileName } from '../csv.js';
import { compareAccounts, groupLabel, GROUPS, GROUP_BY_ID } from '../accounts.js';
import { monthRangePicker, ledgerSection, dateRangeOptions, printRange } from './report-common.js';
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
  const extra = () => ({ account: accountId, ...(subId ? { sub: subId } : {}), ...(memoQuery ? { q: memoQuery } : {}) });
  const picker = monthRangePicker({ period, query, path: '/reports/ledger', onChange: paint, extra });
  function update() {
    picker.refreshUrl();
    paint();
  }
  const body = h('div');
  // 摘要で絞り込む：摘要・相手科目に語をすべて含む明細（語が数字だけなら金額が同じ明細も）。残高は絞り込む前の残高のまま
  let memoQuery = query.q || '';
  const memoInput = h('input', {
    type: 'search',
    value: memoQuery,
    placeholder: '摘要・相手科目・金額で絞り込む',
    'aria-label': '摘要で絞り込む',
    enterkeyhint: 'search',
    oninput: (e) => ((memoQuery = e.target.value), picker.refreshUrl(), paint()),
  });
  const filterMeta = h('p', { class: 'list-meta' });
  const matchRow = (tokens) => (r) => {
    const text = normalize(`${r.memo ?? ''}\n${r.counterpart ?? ''}`);
    return tokens.every((t) => {
      const digits = t.replace(/[,円¥]/g, '');
      return text.includes(t) || (/^\d+$/.test(digits) && (r.debit === Number(digits) || r.credit === Number(digits)));
    });
  };

  function paint() {
    const { from, to } = picker.range();
    const ctx = { accounts, subAccounts, period, journals, from, to };
    const tokens = searchTokens(memoQuery);
    const all = accountId === ALL ? generalLedgers(ctx) : [generalLedger({ ...ctx, accountId, subAccountId: subId || null })];
    const ledgers = tokens.length ? all.map((lg) => ({ ...lg, rows: lg.rows.filter(matchRow(tokens)) })).filter((lg) => accountId !== ALL || lg.rows.length) : all;
    const shownRows = ledgers.flatMap((lg) => lg.rows);
    filterMeta.hidden = !tokens.length;
    filterMeta.textContent = tokens.length ? `摘要で絞り込み：${shownRows.length}件・借方 ${formatYen(shownRows.reduce((s, r) => s + r.debit, 0))}円・貸方 ${formatYen(shownRows.reduce((s, r) => s + r.credit, 0))}円（月計は出しません。残高は絞り込む前の残高）` : '';
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
        ...dateRangeOptions(period, range),
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
          ? ledgerSection(lg, { period, from, title: `${lg.account.code} ${lg.account.name}`, showEmpty: false, monthly: !tokens.length })
          : ledgerSection(lg, { period, from, meta: `${lg.account.code} ${lg.account.name}${subName ? `（${subName}）` : ''}・`, monthly: !tokens.length }),
      ),
      accountId === ALL && !ledgers.length ? emptyState(tokens.length ? '条件に合う明細はありません' : 'この期間の取引はありません', null, { face: null }) : null,
      h('div', { class: 'report-tools no-print' }, h('button', { type: 'button', class: 'btn', text: 'CSVで書き出す', onclick: csv })),
    );
  }

  // 前・次の科目へ（取引・残高のある科目だけを順に。弥生会計の元帳の「前の科目」「次の科目」）
  const stepList = sorted.filter((a) => used.has(a.id));
  const step = (d) => {
    const list = stepList.length ? stepList : sorted;
    const i = list.findIndex((a) => a.id === accountId);
    const next = list[(i < 0 ? 0 : i + d + list.length) % list.length];
    accountId = next.id;
    subId = '';
    accSelect.value = accountId;
    paintSubs();
    update();
  };
  const stepBtn = (d, label) => h('button', { type: 'button', class: 'btn btn-step', 'aria-label': label, text: d < 0 ? '‹' : '›', onclick: () => step(d) });
  const prevBtn = stepBtn(-1, '前の科目');
  const nextBtn = stepBtn(1, '次の科目');
  const syncStep = () => (prevBtn.hidden = nextBtn.hidden = accountId === ALL);
  accSelect.addEventListener('change', syncStep);
  prevBtn.addEventListener('click', syncStep);
  nextBtn.addEventListener('click', syncStep);
  syncStep();

  // 科目を探して選ぶ（コード・科目名。仕訳の入力と同じ選ぶ画面）
  const findBtn = h('button', {
    type: 'button',
    class: 'btn btn-step',
    'aria-label': '科目を探す',
    title: '科目を探す',
    onclick: async () => {
      const id = await pickAccount({ accounts, entityType: settings.entityType, currentId: accountId === ALL ? '' : accountId, title: '元帳を見る科目を選ぶ' });
      if (!id) return;
      accountId = id;
      subId = '';
      accSelect.value = accountId;
      paintSubs();
      syncStep();
      update();
    },
  }, icon('search'));

  paintSubs();
  put(outlet, h('div', { class: 'ledger-pick' }, prevBtn, accSelect, nextBtn, findBtn, subSelect), picker.el, h('div', { class: 'ledger-filter no-print' }, memoInput), filterMeta, body);
  paint();
}
