// 仕訳の訂正・削除の履歴（優良な電子帳簿の要件：訂正・削除の事実と内容、通常の業務処理期間を過ぎた入力の事実を確認できる）
import { h, put, emptyState, saveFile, showToast } from '../ui.js';
import { HISTORY_ACTIONS, describeChange, isLateInput, LATE_INPUT_MONTHS } from '../journal-history.js';
import { formatYen } from '../money.js';
import { formatPeriod } from '../period.js';
import { toCsv, csvFileName } from '../csv.js';

/** ISO の日時を端末の時刻で「2026/10/29 16:20」にする */
export function formatDateTime(iso) {
  const d = new Date(iso);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}/${p(d.getMonth() + 1)}/${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

/** 履歴1件の表示 */
export function historyItem(e, { accountById, subById, departmentById = new Map() }) {
  const j = e.after || e.before;
  const changes = e.action === 'update' ? describeChange(e.before, e.after, { accountById, subById, formatYen, departmentById }) : [];
  const late = e.action === 'create' && isLateInput(j.date, e.at);
  // 伝票No（変えられる）と入力No（変わらない）。伝票No を持たない古い履歴は入力No だけ
  const voucher = j.voucherNo ?? e.journalNo;
  const label = voucher != null && voucher !== e.journalNo ? `伝票No.${voucher}（入力No.${e.journalNo ?? '-'}）` : `伝票No.${e.journalNo ?? '-'}`;
  const lineText = (l) => `${l.side === 'debit' ? '借方' : '貸方'} ${accountById.get(l.accountId)?.name ?? '（不明な科目）'} ${formatYen(l.amount)}${l.memo ? `「${l.memo}」` : ''}`;
  return h(
    'li',
    { class: 'history-item' },
    h(
      'div',
      { class: 'history-head' },
      h('span', { class: `history-badge ${e.action}`, text: HISTORY_ACTIONS[e.action] }),
      e.action === 'delete' ? h('strong', { text: label }) : h('a', { href: `#/journal/${encodeURIComponent(e.journalId)}/edit`, class: 'link', text: label }),
      h('span', { class: 'muted small', text: `取引日 ${j.date.replaceAll('-', '/')}` }),
      h('span', { class: 'muted small', text: `${HISTORY_ACTIONS[e.action]}日時 ${formatDateTime(e.at)}` }),
      late ? h('span', { class: 'late-flag', text: `取引日から${LATE_INPUT_MONTHS}か月を過ぎた入力` }) : null,
    ),
    changes.length ? h('ul', { class: 'history-change' }, changes.map((t) => h('li', { text: t }))) : null,
    e.action === 'delete' ? h('ul', { class: 'history-change' }, e.before.lines.map((l) => h('li', { text: `削除した内容：${lineText(l)}` }))) : null,
  );
}

export async function render({ app, outlet, query }) {
  const { period, accountById, subById, departmentById } = await app.load();
  const all = await app.db.listJournalHistory(period.id);
  let action = Object.keys(HISTORY_ACTIONS).includes(query.action) ? query.action : '';
  const list = h('div');

  const select = h(
    'select',
    {
      'aria-label': '履歴の種類',
      onchange: (e) => {
        action = e.target.value;
        history.replaceState(history.state, '', action ? `#/journals/history?action=${action}` : '#/journals/history');
        paint();
      },
    },
    [h('option', { value: '', text: 'すべての履歴', selected: !action }), ...Object.entries(HISTORY_ACTIONS).map(([k, label]) => h('option', { value: k, text: `${label}だけ`, selected: action === k }))],
  );

  function csv() {
    const rows = [['日時', '種類', '入力No.', '伝票No.', '取引日', '変更前', '変更後']];
    const text = (j) => (j ? `${j.date} ${j.lines.map((l) => `${l.side === 'debit' ? '借' : '貸'}:${accountById.get(l.accountId)?.name ?? ''}:${l.amount}${l.memo ? `:${l.memo}` : ''}`).join(' / ')}` : '');
    for (const e of visible()) rows.push([e.at, HISTORY_ACTIONS[e.action], e.journalNo ?? '', (e.after || e.before).voucherNo ?? e.journalNo ?? '', (e.after || e.before).date, text(e.before), text(e.after)]);
    if (rows.length === 1) return showToast('書き出す履歴がありません');
    saveFile(new Blob([toCsv(rows)], { type: 'text/csv' }), csvFileName('journal-history'));
  }

  const visible = () => all.filter((e) => !action || e.action === action);

  function paint() {
    const items = visible();
    put(
      list,
      h('p', { class: 'list-meta', text: `${items.length}件（新しい順）` }),
      items.length ? h('ul', { class: 'history-list' }, items.map((e) => historyItem(e, { accountById, subById, departmentById }))) : emptyState(all.length ? '条件に合う履歴はありません' : 'この期間の履歴はまだありません', null, { face: null }),
    );
  }

  put(
    outlet,
    h('p', { class: 'muted small', text: `${formatPeriod(period)}　仕訳の登録・訂正・削除を自動で記録しています（履歴は変更・削除できません）` }),
    h('div', { class: 'option-bar no-print' }, select),
    list,
    h('div', { class: 'actions no-print' }, h('button', { type: 'button', class: 'btn', text: '履歴をCSVで書き出す', onclick: csv })),
    h('p', { class: 'muted small', text: 'v0.26.0 より前に入力した仕訳には登録の履歴がありません（入力日は仕訳の作成日時として残っています）。バックアップから復元すると、履歴もバックアップの時点の内容に置き換わります。' }),
  );
  paint();
}
