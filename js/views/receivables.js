// 売掛金・買掛金の管理：取引先（補助科目）ごとの残高・入金予定・消込・滞留（年齢表）
import { h, put, field, segmented, emptyState, saveFile, showToast, errorBox } from '../ui.js';
import { PARTY_KINDS, AGING_BUCKETS, STALE_DAYS, DAY_CHOICES, MONTH_CHOICES, partyAccounts, partyBalances, schedule, agingCsv, termsLabel, dayLabel, validatePaymentTerms } from '../receivables.js';
import { formatYen } from '../money.js';
import { todayString } from '../period.js';
import { csvFileName } from '../csv.js';
import { ValidationError } from '../db.js';
import { errorText } from '../errors.js';

const slash = (d) => (d ? d.replaceAll('-', '/') : '');
const short = (d) => (d ? `${Number(d.slice(5, 7))}/${Number(d.slice(8))}` : '');

function defaultAsOf(period) {
  const today = todayString();
  return today < period.startDate ? period.startDate : today > period.endDate ? period.endDate : today;
}

function context(data, query) {
  const { period } = data;
  const kind = PARTY_KINDS[query.kind] ? query.kind : 'receivable';
  const asOf = query.asOf && query.asOf >= period.startDate && query.asOf <= period.endDate ? query.asOf : defaultAsOf(period);
  return { kind, asOf, k: PARTY_KINDS[kind] };
}

const partyHref = (kind, p, asOf) => `#/receivables/party?${new URLSearchParams({ kind, account: p.accountId, sub: p.subAccountId ?? '', asOf })}`;

function badges(p, k) {
  return [
    p.overdue ? h('span', { class: 'badge badge-warn', text: `期日超過 ${formatYen(p.overdue)}` }) : null,
    p.stale ? h('span', { class: 'badge badge-warn', text: `滞留 ${formatYen(p.stale)}` }) : null,
    p.overpaid ? h('span', { class: 'badge', text: `${k.over} ${formatYen(p.overpaid)}` }) : null,
  ].filter(Boolean);
}

export function render(ctx) {
  return ctx.route.kind === 'party' ? renderParty(ctx) : renderList(ctx);
}

async function renderList({ app, outlet, query }) {
  const data = await app.load();
  const { period, accounts, subAccounts, journals } = data;
  let { kind, asOf } = context(data, query);

  const syncUrl = () => history.replaceState(history.state, '', `#/receivables?${new URLSearchParams({ kind, asOf })}`);
  const body = h('div');
  const asOfInput = h('input', {
    id: 'ar-asof',
    type: 'date',
    value: asOf,
    min: period.startDate,
    max: period.endDate,
    onchange: (e) => {
      if (!e.target.value) return;
      asOf = e.target.value < period.startDate ? period.startDate : e.target.value > period.endDate ? period.endDate : e.target.value;
      e.target.value = asOf;
      syncUrl();
      paint();
    },
  });

  function paint() {
    const k = PARTY_KINDS[kind];
    if (!partyAccounts(kind, accounts).length) {
      put(body, emptyState(`${k.label}の科目がありません`, null));
      return;
    }
    const result = partyBalances(kind, { accounts, subAccounts, journals, period, asOf });
    const t = result.totals;
    const active = result.parties.filter((p) => p.balance || p.open.length || p.overpaid);
    const settled = result.parties.filter((p) => !active.includes(p));
    if (!result.parties.length) {
      put(body, emptyState(`${k.label}の動きはまだありません`, null, { title: `${k.party}ごとの残高` }));
      return;
    }
    const sch = schedule(result);
    const next = sch.days[0];
    const stat = (label, value, sub, warn = false) => h('div', { class: `stat ${warn ? 'is-warn' : ''}` }, h('span', { class: 'stat-label', text: label }), h('span', { class: 'stat-value num', text: value }), sub ? h('span', { class: 'muted small', text: sub }) : null);
    const total = Math.max(1, AGING_BUCKETS.reduce((s, b) => s + Math.max(0, t.buckets[b.id]), 0));

    const row = (p) =>
      h(
        'li',
        {},
        h(
          'a',
          { class: 'menu-row ar-row', href: partyHref(kind, p, asOf) },
          h(
            'span',
            { class: 'menu-text' },
            h('span', { class: 'ar-head' }, h('span', { class: 'menu-label', text: p.name }), h('span', { class: 'num ar-amount', text: formatYen(p.balance) })),
            h('span', { class: 'menu-sub', text: [result.parties.some((x) => x.accountId !== p.accountId) ? p.accountName : '', p.terms ? termsLabel(p.terms) : '支払条件 未設定', p.nextDue ? `次の${k.due} ${slash(p.nextDue)}` : ''].filter(Boolean).join('・') }),
            badges(p, k).length ? h('span', { class: 'bi-tags' }, badges(p, k)) : null,
          ),
        ),
      );

    const schedRow = (label, amount, items, warn) =>
      h(
        'li',
        { class: 'ar-sched-row' },
        h('div', { class: 'ar-head' }, h('span', { class: warn ? 'ar-warn' : '', text: label }), h('span', { class: 'num', text: formatYen(amount) })),
        h('span', { class: 'muted small', text: [...new Set(items.map((it) => it.party.name))].join('・') }),
      );

    put(
      body,
      h(
        'div',
        { class: 'stat-grid' },
        stat(`${k.label}の残高`, formatYen(t.balance), `${active.length}件の${k.party}`),
        stat('期日超過', formatYen(t.overdue), t.overdue ? `${k.due}を過ぎて残っている額` : 'ありません', t.overdue > 0),
        stat(`滞留（${STALE_DAYS + 1}日以上）`, formatYen(t.stale), '発生から日数がたった残り', t.stale > 0),
        stat(`次の${k.schedule}`, next ? formatYen(next.amount) : '—', next ? slash(next.date) : '支払条件を設定すると出ます'),
      ),
      h(
        'section',
        { class: 'panel' },
        h('h2', { class: 'section-title', text: '年齢表（発生日からの日数）' }),
        h(
          'table',
          { class: 'report ar-aging' },
          h('thead', {}, h('tr', {}, h('th', { text: '経過日数' }), h('th', { text: '金額' }), h('th', { text: '割合' }))),
          h(
            'tbody',
            {},
            AGING_BUCKETS.map((b) => {
              const v = t.buckets[b.id];
              const pct = Math.round((Math.max(0, v) / total) * 100);
              return h('tr', {}, h('th', {}, b.label, h('span', { class: 'ar-bar', 'aria-hidden': 'true' }, h('span', { style: `width:${pct}%` }))), h('td', { class: 'num', text: formatYen(v) }), h('td', { class: 'num', text: `${pct}%` }));
            }),
          ),
          h('tfoot', {}, h('tr', {}, h('th', { text: '合計' }), h('td', { class: 'num', text: formatYen(AGING_BUCKETS.reduce((s, b) => s + t.buckets[b.id], 0)) }), h('td'))),
        ),
        t.overpaid ? h('p', { class: 'muted small', text: `${k.over}が${formatYen(t.overpaid)}円あります（残高はそれを差し引いた額）。` }) : null,
        h('button', { type: 'button', class: 'btn btn-block', text: '年齢表をCSVで書き出す', onclick: exportCsv }),
      ),
      h('h2', { class: 'menu-group-title', text: `${k.party}ごとの残高` }),
      active.length ? h('ul', { class: 'menu-group' }, active.map(row)) : h('p', { class: 'muted small', text: `残高のある${k.party}はありません。` }),
      settled.length ? h('details', { class: 'ar-settled' }, h('summary', { class: 'small', text: `残高のない${k.party}（${settled.length}件）` }), h('ul', { class: 'menu-group' }, settled.map(row))) : null,
      h(
        'section',
        { class: 'panel' },
        h('h2', { class: 'section-title', text: `${k.schedule}` }),
        sch.overdue.items.length || sch.days.length
          ? h(
              'ul',
              { class: 'plain-list ar-sched' },
              sch.overdue.items.length ? schedRow(`期日を過ぎたもの（${sch.overdue.items.length}件）`, sch.overdue.amount, sch.overdue.items, true) : null,
              sch.days.slice(0, 12).map((d) => schedRow(slash(d.date), d.amount, d.items, false)),
            )
          : h('p', { class: 'muted small', text: `${k.due}のある残りはありません。` }),
        t.noTerms ? h('p', { class: 'muted small', text: `支払条件が未設定の${k.party}が${t.noTerms}件あります。${k.party}を開いて設定すると、${k.due}を出せます。` }) : null,
      ),
      h(
        'ul',
        { class: 'muted small plain-list ti-points' },
        h('li', { text: `${k.party}は${k.label}の補助科目です。補助科目を使っていない分は「（補助科目なし）」にまとめます。` }),
        h('li', { text: `${k.decrease}は古い${k.increase}から順に消し込みます（先入先出）。前期からの繰越は期首の前日に発生したものとして数えます。` }),
        h('li', { text: `基準日（${slash(asOf)}）までの仕訳で計算します。` }),
      ),
    );

    async function exportCsv() {
      const r = await saveFile(new Blob([agingCsv(result)], { type: 'text/csv' }), csvFileName(kind === 'receivable' ? 'receivables-aging' : 'payables-aging'));
      if (r !== 'cancelled') showToast('年齢表を書き出しました');
    }
  }

  put(
    outlet,
    h(
      'div',
      { class: 'report-tools' },
      segmented({
        name: '科目',
        options: Object.values(PARTY_KINDS).map((x) => ({ value: x.id, label: x.label })),
        value: kind,
        onChange: (v) => {
          kind = v;
          syncUrl();
          paint();
        },
      }),
      field('基準日', asOfInput),
    ),
    body,
  );
  paint();
}

/** 取引先の詳細：消し込んだあとの残り・入金の履歴・支払条件 */
async function renderParty({ app, outlet, query }) {
  const data = await app.load();
  const { period, accounts, subAccounts, journals, accountById, subById } = data;
  const { kind, asOf, k } = context(data, query);
  const result = partyBalances(kind, { accounts, subAccounts, journals, period, asOf });
  const p = result.parties.find((x) => x.accountId === query.account && (x.subAccountId ?? '') === (query.sub ?? ''));
  const back = `#/receivables?${new URLSearchParams({ kind, asOf })}`;
  if (!p) {
    const acc = accountById.get(query.account);
    const sub = subById.get(query.sub);
    if (!acc || !partyAccounts(kind, accounts).includes(acc) || (query.sub && sub?.accountId !== acc.id)) {
      put(outlet, emptyState('取引先が見つかりません', h('a', { href: back, class: 'btn', text: '一覧へ' })));
      return;
    }
  }
  const party = p ?? { accountId: query.account, subAccountId: query.sub || null, name: subById.get(query.sub)?.name ?? '（補助科目なし）', accountName: accountById.get(query.account).name, terms: subById.get(query.sub)?.paymentTerms ?? null, opening: 0, increase: 0, decrease: 0, balance: 0, open: [], payments: [], overdue: 0, stale: 0, overpaid: 0, nextDue: null };
  app.setTitle(party.name);
  const sub = party.subAccountId ? subById.get(party.subAccountId) : null;

  // 支払条件
  const termsEl = h('div');
  function paintTerms(editing = false) {
    if (!sub) {
      put(termsEl, h('p', { class: 'muted small', text: `支払条件は補助科目に設定します。「勘定科目」の画面で${party.accountName}に補助科目（${k.party}）を作ってください。` }));
      return;
    }
    if (!editing) {
      put(
        termsEl,
        h('div', { class: 'kv' }, h('span', { class: 'muted', text: '支払条件' }), h('span', { text: sub.paymentTerms ? termsLabel(sub.paymentTerms) : '未設定' })),
        h('button', { type: 'button', class: 'btn btn-block ar-terms-edit', text: sub.paymentTerms ? '支払条件を変える' : '支払条件を設定する', onclick: () => paintTerms(true) }),
      );
      return;
    }
    const cur = sub.paymentTerms ?? { closingDay: 31, months: 1, payDay: 31 };
    const sel = (id, choices, value, label) => h('select', { id, 'aria-label': label }, choices.map(([v, t]) => h('option', { value: v, text: t, selected: v === value })));
    const closing = sel('ar-closing', DAY_CHOICES.map((d) => [d, dayLabel(d)]), cur.closingDay, '締め日');
    const months = sel('ar-months', MONTH_CHOICES.map((m) => [m, ['当月', '翌月', '翌々月', '3か月後'][m]]), cur.months, '支払月');
    const pay = sel('ar-pay', DAY_CHOICES.map((d) => [d, dayLabel(d)]), cur.payDay, '支払日');
    const errorsEl = h('div');
    const save = async (terms) => {
      const err = validatePaymentTerms(terms);
      if (err) return put(errorsEl, errorBox([err]));
      try {
        await app.db.saveSubAccount({ ...sub, paymentTerms: terms });
        app.refresh();
        showToast(terms ? `支払条件を「${termsLabel(terms)}」にしました` : '支払条件を外しました');
      } catch (e) {
        put(errorsEl, errorBox(e instanceof ValidationError ? Object.values(e.errors) : [errorText(e, '保存')]));
      }
    };
    put(
      termsEl,
      h('p', { class: 'muted small', text: `締め日までの${k.increase}を、何か月後の何日に${k.decrease}するか。${k.due}は月末を超えたら月末にします。` }),
      h('div', { class: 'ar-terms' }, [['締め日', closing], ['支払月', months], ['支払日', pay]].map(([label, el]) => h('label', { class: 'ar-term' }, h('span', { class: 'muted small', text: label }), el))),
      errorsEl,
      h(
        'div',
        { class: 'field-row' },
        h('button', { type: 'button', class: 'btn', text: sub.paymentTerms ? '設定しない' : 'キャンセル', onclick: () => (sub.paymentTerms ? save(null) : paintTerms(false)) }),
        h('button', { type: 'button', class: 'btn btn-primary', text: '保存する', onclick: () => save({ closingDay: Number(closing.value), months: Number(months.value), payDay: Number(pay.value) }) }),
      ),
    );
  }
  paintTerms();

  const openRow = (it) =>
    h(
      'li',
      {},
      h(
        it.journalId ? 'a' : 'div',
        { class: 'menu-row ar-row ar-item', href: it.journalId ? `#/journal/${encodeURIComponent(it.journalId)}/edit` : null },
        h(
          'span',
          { class: 'menu-text' },
          h('span', { class: 'ar-head' }, h('span', { class: 'muted small nowrap', text: it.opening ? '前期から繰越' : slash(it.date) }), h('span', { class: 'num ar-amount', text: formatYen(it.remaining) })),
          h('span', { class: 'menu-sub', text: [it.opening ? '' : it.memo, it.remaining !== it.amount ? `${formatYen(it.amount)}円のうち${formatYen(it.amount - it.remaining)}円は消込済み` : ''].filter(Boolean).join('・') || '—' }),
          h(
            'span',
            { class: 'bi-tags' },
            h('span', { class: 'badge', text: it.dueDate ? `${k.due} ${short(it.dueDate)}` : `${k.due} 未設定` }),
            it.overdueDays ? h('span', { class: 'badge badge-warn', text: `期日超過 ${it.overdueDays}日` }) : null,
            it.stale ? h('span', { class: 'badge badge-warn', text: `滞留 ${it.days}日` }) : h('span', { class: 'badge', text: `${it.days}日経過` }),
          ),
        ),
      ),
    );
  const payRow = (x) =>
    h(
      'li',
      {},
      h(
        'a',
        { class: 'menu-row ar-row', href: `#/journal/${encodeURIComponent(x.journalId)}/edit` },
        h('span', { class: 'menu-text' }, h('span', { class: 'ar-head' }, h('span', { class: 'muted small nowrap', text: slash(x.date) }), h('span', { class: 'num ar-amount', text: formatYen(x.amount) })), h('span', { class: 'menu-sub', text: x.memo || '—' })),
      ),
    );
  const remaining = party.open.reduce((s, it) => s + it.remaining, 0);
  const quickHref = `#/quick/${k.quick}?${new URLSearchParams({ partyAccount: party.accountId, partySub: party.subAccountId ?? '', ...(remaining > 0 ? { amount: String(party.open[0].remaining) } : {}), ...(sub ? { memo: `${sub.name} ${k.decrease}` } : {}) })}`;

  put(
    outlet,
    h(
      'section',
      { class: 'panel' },
      h('div', { class: 'kv' }, h('span', { class: 'muted', text: '科目' }), h('span', { text: party.accountName })),
      h('div', { class: 'kv' }, h('span', { class: 'muted', text: '期首残高' }), h('span', { class: 'num', text: formatYen(party.opening) })),
      h('div', { class: 'kv' }, h('span', { class: 'muted', text: `${k.increase}（発生）` }), h('span', { class: 'num', text: formatYen(party.increase) })),
      h('div', { class: 'kv' }, h('span', { class: 'muted', text: `${k.decrease}など（減少）` }), h('span', { class: 'num', text: formatYen(party.decrease) })),
      h('div', { class: 'kv ar-total' }, h('span', { text: `残高（${slash(asOf)}）` }), h('span', { class: 'num', text: formatYen(party.balance) })),
      party.overpaid ? h('p', { class: 'muted small', text: `${k.over}が${formatYen(party.overpaid)}円あります。次の${k.increase}から差し引きます。` }) : null,
      termsEl,
    ),
    period.closed ? null : h('a', { class: 'btn btn-primary btn-block', href: quickHref, text: `${k.decrease}を記録する` }),
    h('h2', { class: 'menu-group-title', text: `残っている${k.increase}（${party.open.length}件）` }),
    party.open.length ? h('ul', { class: 'menu-group' }, party.open.map(openRow)) : h('p', { class: 'muted small', text: 'すべて消し込みました。' }),
    h('h2', { class: 'menu-group-title', text: `${k.decrease}などの履歴（${party.payments.length}件）` }),
    party.payments.length ? h('ul', { class: 'menu-group' }, [...party.payments].reverse().map(payRow)) : h('p', { class: 'muted small', text: `${k.decrease}はまだありません。` }),
    h('a', { class: 'btn btn-block', href: `#/reports/ledger?${new URLSearchParams({ account: party.accountId, ...(party.subAccountId ? { sub: party.subAccountId } : {}) })}`, text: '総勘定元帳で見る' }),
    h('p', { class: 'muted small', text: `${k.decrease}は古い${k.increase}から順に消し込んでいます（先入先出）。` }),
  );
}
