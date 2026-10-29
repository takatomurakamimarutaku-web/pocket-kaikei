// 補助元帳：1つの科目の補助科目（取引先・口座など）ごとの元帳。補助科目の残高一覧と、すべての補助科目を続けて表示・印刷・CSV 出力
import { h, put, amountCell, emptyState, saveFile } from '../ui.js';
import { subLedgers, generalLedger, carriedLabel, NO_SUB } from '../ledger.js';
import { ledgerCsv, csvFileName } from '../csv.js';
import { compareAccounts } from '../accounts.js';
import { formatPeriod } from '../period.js';
import { monthRangePicker, ledgerSection } from './report-common.js';

export async function render({ app, outlet, query }) {
  const { settings, period, accounts, subAccounts, journals } = await app.load();
  const head = h('p', { class: 'muted small', text: `${settings.businessName}　${formatPeriod(period)}` });
  const withSubs = accounts.filter((a) => subAccounts.some((s) => s.accountId === a.id)).sort(compareAccounts);
  if (!withSubs.length) {
    return put(
      outlet,
      head,
      emptyState('補助科目はまだありません', h('p', { class: 'muted small', text: '売掛金の取引先や普通預金の口座などを補助科目に登録して仕訳に付けると、補助科目ごとの元帳（補助元帳）と残高の一覧をここで見られます。' }), { title: '補助元帳' }),
      h('a', { href: '#/accounts', class: 'btn btn-block', text: '勘定科目・補助科目を設定する' }),
    );
  }
  const used = new Set(journals.flatMap((j) => j.lines.filter((l) => l.subAccountId).map((l) => l.accountId)));
  let accountId = withSubs.some((a) => a.id === query.account) ? query.account : (withSubs.find((a) => used.has(a.id)) || withSubs[0]).id;
  const subsOf = (id) => subAccounts.filter((s) => s.accountId === id);
  let subId = query.sub === NO_SUB || subsOf(accountId).some((s) => s.id === query.sub) ? query.sub : '';
  let includeEmpty = false;

  const accSelect = h(
    'select',
    { 'aria-label': '勘定科目', onchange: (e) => ((accountId = e.target.value), (subId = ''), paintSubs(), update()) },
    withSubs.map((a) => h('option', { value: a.id, text: `${a.code} ${a.name}`, selected: a.id === accountId })),
  );
  const subSelect = h('select', { 'aria-label': '補助科目', onchange: (e) => ((subId = e.target.value), update()) });
  function paintSubs() {
    put(
      subSelect,
      h('option', { value: '', text: 'すべての補助科目（続けて表示）', selected: !subId }),
      ...subsOf(accountId)
        .sort((a, b) => (a.sortOrder ?? 0) - (b.sortOrder ?? 0))
        .map((s) => h('option', { value: s.id, text: s.active ? s.name : `${s.name}（無効）`, selected: s.id === subId })),
      h('option', { value: NO_SUB, text: '補助科目なし', selected: subId === NO_SUB }),
    );
  }
  const extra = () => ({ account: accountId, ...(subId ? { sub: subId } : {}) });
  const picker = monthRangePicker({ period, query, path: '/reports/sub-ledger', onChange: paint, extra });
  function update() {
    picker.refreshUrl();
    paint();
  }
  const emptyToggle = h('label', { class: 'check small' }, h('input', { type: 'checkbox', onchange: (e) => ((includeEmpty = e.target.checked), paint()) }), '残高も取引もない補助科目も表示');
  const body = h('div');

  /** 補助科目の残高一覧（繰越・借方・貸方・残高）。名前を押すとその補助元帳へ移る */
  function summary(ledgers, total, sections) {
    return h(
      'div',
      { class: 'table-wrap' },
      h(
        'table',
        { class: 'report sl-summary' },
        h('caption', { text: '補助科目の残高一覧' }),
        h('thead', {}, h('tr', {}, ['補助科目', '繰越', '借方', '貸方', '残高'].map((t) => h('th', { scope: 'col', text: t })))),
        h(
          'tbody',
          {},
          ledgers.map((lg, i) =>
            h(
              'tr',
              {},
              h('th', { scope: 'row' }, h('button', { type: 'button', class: 'link', text: lg.subName, onclick: () => sections[i].scrollIntoView({ behavior: 'smooth', block: 'start' }) })),
              amountCell('td', lg.carried),
              amountCell('td', lg.debit, { blankZero: true }),
              amountCell('td', lg.credit, { blankZero: true }),
              amountCell('td', lg.closing),
            ),
          ),
        ),
        h('tfoot', {}, h('tr', {}, h('th', { text: '合計' }), amountCell('td', total.carried), amountCell('td', total.debit), amountCell('td', total.credit), amountCell('td', total.closing))),
      ),
    );
  }

  function paint() {
    const { from, to } = picker.range();
    const ctx = { accountId, accounts, subAccounts, period, journals, from, to };
    const account = accounts.find((a) => a.id === accountId);
    let ledgers;
    if (subId) {
      const name = subId === NO_SUB ? '補助科目なし' : subAccounts.find((s) => s.id === subId)?.name ?? '';
      ledgers = [{ ...generalLedger({ ...ctx, subAccountId: subId }), subName: name }];
    } else ledgers = subLedgers({ ...ctx, includeEmpty });
    const csv = () => saveFile(new Blob([ledgerCsv(ledgers, { carried: carriedLabel(period, from) })], { type: 'text/csv' }), csvFileName('sub-ledger'));
    emptyToggle.hidden = Boolean(subId);
    if (subId) {
      put(body, ledgerSection(ledgers[0], { period, from, meta: `${account.code} ${account.name}（${ledgers[0].subName}）・` }), tools(csv));
      return;
    }
    if (!ledgers.length) {
      put(body, emptyState('この期間に補助科目の取引・残高はありません', null, { face: null }), tools(csv));
      return;
    }
    // 合計は科目の総勘定元帳と同じ（補助科目なしの明細も含む）
    const total = generalLedger(ctx);
    const sections = ledgers.map((lg, i) => ledgerSection(lg, { period, from, title: lg.subName, id: `sl-${i}` }));
    put(body, summary(ledgers, total, sections), sections, tools(csv));
  }
  const tools = (csv) => h('div', { class: 'report-tools no-print' }, h('button', { type: 'button', class: 'btn', text: 'CSVで書き出す', onclick: csv }));

  paintSubs();
  put(outlet, head, h('div', { class: 'ledger-pick' }, accSelect, subSelect), picker.el, emptyToggle, body);
  paint();
}
