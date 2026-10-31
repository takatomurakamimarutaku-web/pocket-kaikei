// 仕訳のチェック：重複の可能性・残高のマイナス・逆残高・仮払金などの残り・未来の日付・税区分・10万円以上の消耗品
import { h, put } from '../ui.js';
import { duplicateJournals, negativeCashDays, abnormalBalances, suspenseBalances, futureJournals, assetLikeExpenses } from '../journal-checks.js';
import { taxChecks } from '../tax-reports.js';
import { formatYen } from '../money.js';
import { formatPeriod, todayString } from '../period.js';
import { journalLabel } from '../journal.js';

const slash = (d) => d.replaceAll('-', '/');

export async function render({ app, outlet }) {
  const { settings, period, accounts, subAccounts, journals, accountById, subById } = await app.load();
  const ctx = { accounts, subAccounts, period, journals };
  const name = (accountId, subAccountId) => `${accountById.get(accountId)?.name ?? '（不明な科目）'}${subAccountId ? `／${subById.get(subAccountId)?.name ?? ''}` : ''}`;
  const jlink = (j) => h('a', { href: `#/journal/${encodeURIComponent(j.id)}/edit`, class: 'link', text: journalLabel(j) });
  const amountOf = (j) => j.lines.filter((l) => l.side === 'debit').reduce((s, l) => s + l.amount, 0);
  const memoOf = (j) => j.lines.find((l) => l.memo)?.memo ?? '';

  const dups = duplicateJournals(journals);
  const negatives = negativeCashDays(ctx);
  const abnormal = abnormalBalances(ctx);
  const suspense = suspenseBalances(ctx);
  const future = futureJournals(journals, todayString());
  const assetLike = assetLikeExpenses({ ...ctx, entityType: settings.entityType });
  const tax = taxChecks({ journals, accounts });
  const taxWarn = tax.filter((x) => x.level === 'warn').length;

  const section = (title, count, level, body, help) =>
    h(
      'section',
      { class: `panel check-section ${count ? `has-${level}` : 'is-ok'}` },
      h('div', { class: 'check-head' }, h('h2', { class: 'section-title', text: title }), h('span', { class: `check-count ${count ? level : 'ok'}`, text: count ? `${count}件` : 'なし' })),
      help ? h('p', { class: 'muted small', text: help }) : null,
      count ? body() : null,
    );

  // 見出しの件数は誤りの可能性が高いものだけ。仮払金の残りと未来の日付は参考として別に数える
  const total = dups.length + negatives.length + abnormal.length + taxWarn;
  const info = suspense.length + future.length + assetLike.length;
  const FUTURE_MAX = 10;
  put(
    outlet,
    h('p', { class: 'muted small', text: `${formatPeriod(period)}　入力の誤りの可能性を探します。誤りと決まったわけではないので、内容を確かめてください。` }),
    h('p', { class: `check-line ${total ? 'ng' : 'ok'}`, text: total ? `確かめる項目が${total}件あります${info ? `（ほかに参考${info}件）` : ''}` : `誤りの可能性が高い項目は見つかりませんでした${info ? `（参考${info}件）` : ''}` }),
    section('重複の可能性', dups.length, 'warn', () =>
      h('ul', { class: 'plain-list small' }, dups.map((g) => h('li', {}, `${slash(g[0].date)}　${formatYen(amountOf(g[0]))}円　${memoOf(g[0])}　`, ...g.flatMap((j, i) => [i ? '・' : '', jlink(j)])))),
      '同じ日付で、科目・金額がまったく同じ仕訳です。二重に入力していないか確かめてください。',
    ),
    section('現金・預金の残高がマイナスになった日', negatives.length, 'warn', () =>
      h('ul', { class: 'plain-list small' }, negatives.map((n) => h('li', {}, h('a', { class: 'link', href: `#/cashbook?account=${encodeURIComponent(n.accountId)}${n.subAccountId ? `&sub=${encodeURIComponent(n.subAccountId)}` : ''}&month=${n.firstDate.slice(0, 7)}`, text: name(n.accountId, n.subAccountId) }), `　${slash(n.firstDate)} から ${n.days}日。いちばん少ないのは ${slash(n.minDate)} の ${formatYen(n.minBalance)}円`))),
      '現金や預金の残高はマイナスになりません。入力漏れ（入金・引出し）や日付の誤り、事業主借での立替えの入れ忘れが考えられます。',
    ),
    section('残高が通常と逆の科目', abnormal.length, 'warn', () =>
      h('ul', { class: 'plain-list small' }, abnormal.map((x) => h('li', {}, h('a', { class: 'link', href: `#/reports/ledger?account=${encodeURIComponent(x.account.id)}${x.subAccount ? `&sub=${encodeURIComponent(x.subAccount.id)}` : ''}`, text: name(x.account.id, x.subAccount?.id) }), `　${formatYen(x.closing)}円`))),
      '資産・費用は借方、負債・純資産・収益は貸方に残るのが通常です。逆になっている科目は、貸借の入れ違いや科目の選び間違いが考えられます。',
    ),
    section('仮払金・仮受金の残高', suspense.length, 'info', () =>
      h('ul', { class: 'plain-list small' }, suspense.map((x) => h('li', {}, h('a', { class: 'link', href: `#/reports/ledger?account=${encodeURIComponent(x.account.id)}`, text: x.account.name }), `　${formatYen(x.closing)}円`))),
      '仮の科目は、内容が分かったら正しい科目へ振り替えます。決算までに残高を0にするのが一般的です。',
    ),
    section('今日より後の日付の仕訳', future.length, 'info', () =>
      h(
        'div',
        {},
        h('ul', { class: 'plain-list small' }, future.slice(0, FUTURE_MAX).map((j) => h('li', {}, `${slash(j.date)}　`, jlink(j), `　${formatYen(amountOf(j))}円　${memoOf(j)}`))),
        future.length > FUTURE_MAX ? h('p', { class: 'muted small', text: `ほか${future.length - FUTURE_MAX}件（${slash(future.at(-1).date)} まで）。仕訳帳で日付順に確かめられます。` }) : null,
      ),
      '予定を先に入力した場合は問題ありません。年の打ち間違いがないか確かめてください。',
    ),
    section('固定資産にあたるかもしれない消耗品', assetLike.length, 'info', () =>
      h(
        'ul',
        { class: 'plain-list small' },
        assetLike.map(({ journal: j, line: l, account: a }) =>
          h('li', {}, `${slash(j.date)}　${a.name}　${formatYen(l.amount)}円　${l.memo || memoOf(j)}　`, jlink(j), '　', h('a', { class: 'link', href: `#/asset/new?${new URLSearchParams({ cost: String(l.amount), date: j.date, name: l.memo || memoOf(j) })}`, text: '固定資産に登録' })),
        ),
      ),
      '1つ（1組）10万円以上の物は、全額をその年の経費にできません。固定資産台帳に登録して、一括償却（20万円未満）・少額減価償却資産の特例（青色の中小企業者等。令和8年4月以後の取得は40万円未満）・通常の減価償却から選びます。登録したら、この仕訳の科目を資産の科目（工具器具備品など）に直してください。1つ10万円未満の物をまとめて買った場合はこのままで構いません。',
    ),
    section('税区分の確認', taxWarn, 'warn', () => h('p', { class: 'small' }, h('a', { class: 'link', href: '#/reports/tax?view=check', text: '消費税集計の「税区分のチェック」を開く' })), '売上の科目に仕入の税区分が付いているなど、誤りやすい組み合わせです（参考の項目は消費税集計の画面に出ます）。'),
  );
}
