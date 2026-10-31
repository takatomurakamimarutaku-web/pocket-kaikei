// 摘要・科目の検索：摘要（取引先・金額も）で仕訳の明細を探す・摘要ごとにまとめる、科目をコード・名前・区分で探して元帳へ
// 期間は年・月・日で選べる（帳票と同じ部品）。結果は CSV に書き出せる
import { h, put, amountCell, emptyState, saveFile, segmented } from '../ui.js';
import { searchLines, lineTotals, groupByMemo, searchAccounts, normalize } from '../search.js';
import { counterpartName, trialBalance } from '../ledger.js';
import { groupLabel, compareAccounts } from '../accounts.js';
import { formatYen } from '../money.js';
import { toCsv, csvFileName } from '../csv.js';
import { monthRangePicker, labelCell } from './report-common.js';
import { pickAccount } from './account-picker.js';

// 画面に並べる明細の上限（多すぎると重くなるため。CSV にはすべて書き出す）
const SHOW_MAX = 300;

export async function render({ app, outlet, query }) {
  const { settings, period, accounts, subAccounts, journals, accountById, subById, departmentById } = await app.load();
  const entityType = settings.entityType;
  let tab = query.tab === 'account' ? 'account' : 'memo';
  let q = query.q || '';
  let accountId = accountById.has(query.account) ? query.account : '';
  let view = query.view === 'memo' ? 'memo' : 'lines';
  const extra = () => ({ ...(tab === 'account' ? { tab } : {}), ...(q ? { q } : {}), ...(accountId && tab === 'memo' ? { account: accountId } : {}), ...(view === 'memo' && tab === 'memo' ? { view } : {}) });
  const picker = monthRangePicker({ period, query, path: '/reports/search', onChange: () => paint(), extra });
  const body = h('div');
  const meta = h('p', { class: 'list-meta' });

  const input = h('input', {
    type: 'search',
    value: q,
    enterkeyhint: 'search',
    'aria-label': '検索する語',
    oninput: (e) => {
      q = e.target.value;
      picker.refreshUrl();
      paint();
    },
  });
  // 科目で絞り込む（摘要の検索）。選ぶ画面は仕訳の入力と同じ（コード・科目名で探せる）
  const accountBtn = h('button', { type: 'button', class: 'btn btn-small find-account', onclick: chooseAccount });
  const clearBtn = h('button', { type: 'button', class: 'btn btn-small', text: '解除', onclick: () => ((accountId = ''), changed()) });
  async function chooseAccount() {
    const id = await pickAccount({ accounts, entityType, currentId: accountId, title: '絞り込む科目を選ぶ' });
    if (id) (accountId = id), changed();
  }
  const changed = () => (picker.refreshUrl(), paint());
  const viewSeg = segmented({
    name: '表示',
    options: [
      { value: 'lines', label: '明細' },
      { value: 'memo', label: '摘要ごとにまとめる' },
    ],
    value: view,
    onChange: (v) => ((view = v), changed()),
  });
  const memoTools = h('div', { class: 'find-tools' }, h('div', { class: 'find-account-row' }, h('span', { class: 'small muted', text: '科目' }), accountBtn, clearBtn), viewSeg);

  const ctx = { accountById, subById, departmentById };
  const accountName = (a, sub) => `${a?.name ?? '（不明な科目）'}${sub ? `（${sub.name}）` : ''}`;
  const jLink = (j) => `#/journal/${encodeURIComponent(j.id)}/edit`;

  /** 摘要の検索：明細（日付・伝票No｜科目・相手科目・摘要｜借方｜貸方） */
  function linesTable(hits) {
    const shown = hits.slice(0, SHOW_MAX);
    const rows = shown.map((x) =>
      h(
        'tr',
        { class: 'lg-row' },
        h('td', { class: 'nowrap lg-date' }, h('a', { href: jLink(x.journal), text: x.journal.date.slice(5).replace('-', '/') }), h('span', { class: 'lg-no', text: `No.${x.journal.voucherNo ?? x.journal.no}` })),
        h(
          'td',
          { class: 'lg-desc' },
          h('span', { class: 'lg-counter', text: `${accountName(x.account, x.sub)} ／ ${counterpartName(x.journal, x.line, accountById, subById)}` }),
          x.line.memo ? h('span', { class: 'lg-memo', text: x.line.memo }) : null,
        ),
        labelCell(x.line.side === 'debit' ? x.line.amount : 0, '借方', { blankZero: true }),
        labelCell(x.line.side === 'credit' ? x.line.amount : 0, '貸方', { blankZero: true }),
      ),
    );
    const t = lineTotals(hits);
    return [
      h(
        'div',
        { class: 'table-wrap' },
        h(
          'table',
          { class: 'report ledger find-lines', 'aria-label': '摘要の検索の結果' },
          h('thead', {}, h('tr', {}, ['日付／伝票No.', '科目 ／ 相手科目・摘要', '借方', '貸方'].map((t) => h('th', { scope: 'col', text: t })))),
          h('tbody', {}, rows),
          h('tfoot', {}, h('tr', {}, h('th', { colspan: 2, text: '合計' }), labelCell(t.debit, '借方'), labelCell(t.credit, '貸方'))),
        ),
      ),
      hits.length > SHOW_MAX ? h('p', { class: 'muted small', text: `画面には最初の${SHOW_MAX}件を表示しています。条件を足して絞り込むか、CSVで書き出すとすべての明細を見られます。` }) : null,
    ];
  }

  /** 摘要ごとにまとめる：摘要｜件数｜借方合計｜貸方合計。摘要を押すとその摘要で探し直す */
  function memoTable(hits) {
    const groups = groupByMemo(hits);
    return h(
      'div',
      { class: 'table-wrap' },
      h(
        'table',
        { class: 'report find-memo', 'aria-label': '摘要ごとの件数と金額' },
        h('thead', {}, h('tr', {}, ['摘要（使った科目）', '件数', '借方合計', '貸方合計'].map((t) => h('th', { scope: 'col', text: t })))),
        h(
          'tbody',
          {},
          groups.map((g) =>
            h(
              'tr',
              {},
              h(
                'th',
                { scope: 'row' },
                g.memo === '（摘要なし）' ? h('span', { text: g.memo }) : h('button', { type: 'button', class: 'link', text: g.memo, onclick: () => ((q = g.memo), (input.value = q), (view = 'lines'), viewSeg.querySelectorAll('.seg').forEach((b, i) => b.setAttribute('aria-checked', String(i === 0))), changed()) }),
                h('span', { class: 'muted small block', text: `${g.accounts.join('・')}　最後 ${g.lastDate.replaceAll('-', '/')}` }),
              ),
              h('td', { class: 'num', text: `${g.count}件` }),
              amountCell('td', g.debit, { blankZero: true }),
              amountCell('td', g.credit, { blankZero: true }),
            ),
          ),
        ),
      ),
    );
  }

  function memoCsv(hits) {
    const rows = [['日付', '伝票No', '科目', '補助科目', '相手科目', '借方', '貸方', '摘要']];
    for (const x of hits) rows.push([x.journal.date, x.journal.voucherNo ?? x.journal.no, x.account?.name ?? '', x.sub?.name ?? '', counterpartName(x.journal, x.line, accountById, subById), x.line.side === 'debit' ? x.line.amount : '', x.line.side === 'credit' ? x.line.amount : '', x.line.memo ?? '']);
    saveFile(new Blob([toCsv(rows)], { type: 'text/csv' }), csvFileName('memo-search'));
  }

  /** 科目の検索：コード・科目名・区分｜期末残高（選んだ期間の終わり）・件数。押すと元帳を開く */
  function accountList(r) {
    const tb = trialBalance({ accounts, subAccounts, period, journals, from: r.from, to: r.to });
    const rowById = new Map(tb.rows.map((x) => [x.account.id, x]));
    const count = new Map();
    for (const j of journals) if (j.date >= r.from && j.date <= r.to) for (const l of j.lines) count.set(l.accountId, (count.get(l.accountId) ?? 0) + 1);
    const list = searchAccounts([...accounts].sort(compareAccounts), q, (a) => groupLabel(a.group, entityType));
    meta.textContent = `${list.length}科目（${r.label}）`;
    if (!list.length) return emptyState('条件に合う科目はありません', null, { face: null });
    const range = r.query;
    return h(
      'ul',
      { class: 'find-accounts' },
      list.map((a) => {
        const row = rowById.get(a.id);
        const hasSubs = subAccounts.some((s) => s.accountId === a.id);
        return h(
          'li',
          { class: 'find-account-item' },
          h(
            'a',
            { class: 'find-account-main', href: `#/reports/ledger?${new URLSearchParams({ account: a.id, ...range })}` },
            h('span', { class: 'picker-code', text: a.code }),
            h('span', { class: 'find-account-name' }, h('span', { text: a.name }), h('span', { class: 'muted small block', text: `${groupLabel(a.group, entityType)}${a.active ? '' : '・無効'}・${count.get(a.id) ?? 0}件` })),
            amountCell('span', row?.closing ?? 0, { cls: 'find-account-balance' }),
          ),
          h(
            'div',
            { class: 'find-account-links' },
            hasSubs ? h('a', { class: 'link small', href: `#/reports/sub-ledger?${new URLSearchParams({ account: a.id, ...range })}`, text: '補助元帳' }) : null,
            h('button', { type: 'button', class: 'link small', text: 'この科目の摘要を探す', onclick: () => switchTab('memo', a.id) }),
          ),
        );
      }),
    );
  }

  const tabSeg = segmented({
    name: '探すもの',
    options: [
      { value: 'memo', label: '摘要で探す' },
      { value: 'account', label: '科目で探す' },
    ],
    value: tab,
    onChange: (v) => switchTab(v),
  });
  function switchTab(v, id = accountId) {
    // 科目の検索の語（科目名など）は摘要の検索に持ち越さない
    if (tab === 'account' && v === 'memo') q = '';
    tab = v;
    accountId = id;
    tabSeg.querySelectorAll('.seg').forEach((b, i) => b.setAttribute('aria-checked', String((i === 0) === (v === 'memo'))));
    input.value = q;
    changed();
  }

  function paint() {
    const r = picker.range();
    input.placeholder = tab === 'memo' ? '摘要・取引先・金額で探す' : 'コード・科目名・区分で探す';
    memoTools.hidden = tab !== 'memo';
    if (tab === 'account') return put(body, accountList(r));
    const a = accountById.get(accountId);
    accountBtn.textContent = a ? `${a.code} ${a.name}` : 'すべての科目';
    clearBtn.hidden = !a;
    if (!normalize(q) && !a) {
      meta.textContent = '';
      return put(body, h('p', { class: 'muted small find-hint', text: '摘要・補助科目（取引先など）・部門の名前・金額で、仕訳の明細を探します。空白で区切って複数の語を入れると、すべての語を含む明細だけを出します。「摘要ごとにまとめる」にすると、同じ摘要が何回・いくら使われたかを一覧にします。科目だけを選んで、その科目の明細を見ることもできます。' }));
    }
    const hits = searchLines(journals, { query: q, accountId, from: r.from, to: r.to }, ctx);
    const t = lineTotals(hits);
    meta.textContent = `${t.count}件・借方合計 ${formatYen(t.debit)}円・貸方合計 ${formatYen(t.credit)}円（${r.label}）`;
    if (!hits.length) return put(body, emptyState('条件に合う明細はありません', null, { face: null }));
    put(body, view === 'memo' ? memoTable(hits) : linesTable(hits), h('div', { class: 'report-tools no-print' }, h('button', { type: 'button', class: 'btn', text: 'CSVで書き出す', onclick: () => memoCsv(hits) })));
  }

  put(outlet, h('div', { class: 'no-print' }, tabSeg), h('div', { class: 'search-bar' }, input), picker.el, memoTools, meta, body);
  paint();
}
