// キャッシュフロー計算書（間接法）と資金繰り表（月別の実績と予定）
import { h, put, amountCell } from '../ui.js';
import { cashFlowStatement, cashPlan, CASH_PLAN_ROWS } from '../cash-flow.js';
import { barLineChart } from '../chart.js';
import { openingDiff } from '../ledger.js';
import { formatPeriod, todayString } from '../period.js';
import { formatYen } from '../money.js';
import { zeroToggle, openingWarning, unitPicker } from './report-common.js';
import { isWhite } from '../white-return.js';

export async function render({ app, outlet, route, query }) {
  const { settings, period, accounts, journals } = await app.load();
  const individual = settings.entityType === 'individual';
  const head = [
    h('p', { class: 'muted small', text: `${settings.businessName}　${formatPeriod(period)}` }),
    openingWarning(individual ? 0 : openingDiff(period, accounts)),
  ];
  if (route.kind === 'plan') return renderPlan({ app, outlet, period, accounts, journals, head, query });

  const white = isWhite(settings);
  const cf = cashFlowStatement({ entityType: settings.entityType, accounts, period, journals, white });
  let showZero = false;
  const body = h('div');
  const zero = zeroToggle((v) => ((showZero = v), paint()));
  const unit = unitPicker({ key: '/reports/cash-flow', onChange: () => paint() });
  const line = (l) => (showZero || l.amount || l.key === 'profit' ? h('tr', { class: 'st-line' }, h('th', { text: l.label }), amountCell('td', l.amount)) : null);
  function paint() {
    put(
      body,
      h(
        'div',
        { class: 'table-wrap' },
        h(
          'table',
          { class: 'report statement' },
          h('caption', { text: 'キャッシュフロー計算書（間接法）' }),
          h(
            'tbody',
            {},
            cf.sections.map((sec) => [
              h('tr', { class: 'st-group' }, h('th', { colspan: 2, text: sec.title })),
              sec.lines.map(line),
              sec.subtotal != null ? h('tr', { class: 'st-total' }, h('th', { text: '小計' }), amountCell('td', sec.subtotal)) : null,
              (sec.after || []).map(line),
              h('tr', { class: 'st-subtotal' }, h('th', { text: sec.title.replace(/^[ⅠⅡⅢ] /, '') }), amountCell('td', sec.total)),
            ]),
            h('tr', { class: 'st-subtotal strong' }, h('th', { text: 'Ⅳ 資金の増減額' }), amountCell('td', cf.net)),
            h('tr', { class: 'st-line' }, h('th', { text: 'Ⅴ 資金の期首残高' }), amountCell('td', cf.opening)),
            h('tr', { class: 'st-subtotal strong' }, h('th', { text: 'Ⅵ 資金の期末残高' }), amountCell('td', cf.closing)),
          ),
        ),
      ),
    );
  }
  put(
    outlet,
    head,
    h(
      'p',
      { class: `check-line ${cf.matches ? 'ok no-print' : 'ng'}` },
      cf.matches ? `資金の増減 ${formatYen(cf.net)}円 ＝ 期末残高 − 期首残高` : `資金の増減と残高の差が合いません（差額 ${formatYen(cf.net - (cf.closing - cf.opening))}円）。期首残高の貸借を確かめてください。`,
    ),
    // 要約：期首残高 → 営業・投資・財務 → 増減 → 期末残高（市販ソフトのキャッシュフローの要約と同じ流れ）
    h(
      'div',
      { class: 'lg-stats cf-stats' },
      cfStat('期首の資金', cf.opening),
      cfStat('営業活動', cf.sections[0].total),
      cfStat('投資活動', cf.sections[1].total),
      cfStat('財務活動', cf.sections[2].total),
      cfStat('フリーCF（営業＋投資）', cf.freeCashFlow),
      cfStat('期末の資金', cf.closing),
    ),
    unit.el,
    zero.el,
    body,
    h(
      'ul',
      { class: 'plain-list small muted' },
      h('li', { text: '資金は現金と預金（定期預金を含む）です。期首と期末の貸借対照表の差額と、損益計算書から作っています（間接法）。' }),
      h('li', { text: individual ? (white ? '所得金額は専従者控除前の金額です。' : '所得金額は青色申告特別控除前の金額です。') + '生活費などの引出し・入金は「事業主との出し入れ」に入ります。' : '法人税等の支払額は、法人税等の費用から未払法人税等の増加を差し引いた額です。中間納付を仮払金で処理した場合は「その他の資産の増減」に入ります。' }),
      h('li', { text: '利息の受取・支払は営業活動に含めています（中小企業向けの簡便な形）。' }),
    ),
  );
  paint();
}

async function renderPlan({ outlet, period, accounts, journals, head, app, query }) {
  const [templates, budgets] = await Promise.all([app.db.listTemplates(), app.db.listBudgets(period.id)]);
  const today = todayString();
  let useBudget = budgets.length > 0 && query.budget !== '0';
  const body = h('div');
  const unit = unitPicker({ key: '/reports/cash-plan', onChange: () => paint() });
  const budgetToggle = budgets.length
    ? h(
        'label',
        { class: 'check small' },
        h('input', {
          type: 'checkbox',
          checked: useBudget,
          onchange: (e) => {
            useBudget = e.target.checked;
            history.replaceState(history.state, '', `#/reports/cash-plan${useBudget ? '' : '?budget=0'}`);
            paint();
          },
        }),
        '予定に予算を使う',
      )
    : null;

  function paint() {
    const plan = cashPlan({ accounts, period, journals, templates, budgets: useBudget ? budgets : [], today });
    const label = (m) => `${Number(m.month.slice(5))}月`;
    const planFrom = plan.months.findIndex((m) => m.plan);
    const chart = barLineChart({
      labels: plan.months.map(label),
      bar: { label: '月の収支', values: plan.months.map((m) => m.net) },
      line: { label: '月末残高', values: plan.months.map((m) => m.closing) },
      title: '資金の推移',
      planFrom: planFrom === -1 ? plan.months.length : planFrom,
    });
    const cells = (f, opts) => plan.months.map((m) => amountCell('td', f(m), { ...opts, cls: m.plan ? 'is-plan' : '' }));
    const row = (cls, text, f, opts) => h('tr', { class: cls }, h('th', { scope: 'row', text }), cells(f, opts));
    const rowsOf = (kind) => CASH_PLAN_ROWS.filter((r) => r.kind === kind).map((r) => row('', r.label, (m) => m.values[r.key], { blankZero: true }));
    const table = h(
      'div',
      { class: 'table-wrap' },
      h(
        'table',
        { class: 'report monthly cash-plan' },
        h(
          'thead',
          {},
          h('tr', {}, h('th', { scope: 'col', text: '' }), plan.months.map((m) => h('th', { scope: 'col', class: m.plan ? 'is-plan' : '' }, label(m), h('span', { class: 'cp-kind', text: m.plan ? '予定' : '実績' })))),
        ),
        h(
          'tbody',
          {},
          row('mt-strong', '月初の残高', (m) => m.opening),
          h('tr', { class: 'tb-group' }, h('th', { scope: 'row', text: '収入' }), cells((m) => m.income)),
          rowsOf('in'),
          h('tr', { class: 'tb-group' }, h('th', { scope: 'row', text: '支出' }), cells((m) => m.outgo)),
          rowsOf('out'),
          row('tb-subtotal', '経常の収支', (m) => m.operating),
          h('tr', { class: 'tb-group' }, h('th', { scope: 'row', text: '設備・財務' }), cells((m) => m.finance)),
          rowsOf('fin'),
          row('mt-strong', '月末の残高', (m) => m.closing),
        ),
      ),
    );
    const minPlan = plan.months.filter((m) => m.plan).reduce((min, m) => (min == null || m.closing < min.closing ? m : min), null);
    put(body, minPlan && minPlan.closing < 0 ? h('p', { class: 'check-line ng', text: `${Number(minPlan.month.slice(5))}月末に資金が不足する見込みです（${formatYen(minPlan.closing)}円）` }) : null, chart, table);
  }

  put(
    outlet,
    head,
    unit.el,
    budgetToggle,
    body,
    h(
      'ul',
      { class: 'plain-list small muted' },
      h('li', { text: '今月までは登録した仕訳の実績、来月からは予定です。予定は、先の日付で登録した仕訳と、まだ作っていない毎月の定型仕訳（現金・預金を使うもの）から作ります。' }),
      h('li', {}, '家賃・給料・借入金の返済などは ', h('a', { href: '#/templates', class: 'link', text: '定型仕訳' }), ' で「毎月作る」にすると予定に入ります。'),
      budgets.length
        ? h('li', { text: '「予定に予算を使う」では、予算を入れた科目は予算の額をその月に入出金する前提で予定にします（掛けの期間は考えません。減価償却費など資金の動かない科目は除きます）。' })
        : h('li', {}, h('a', { href: '#/budget', class: 'link', text: '予算' }), ' を入れると、売上や経費の予定にも使えます。'),
      h('li', { text: '行は仕訳の相手科目で分けています（売上・売掛金・前受金→売上の入金、仕入・外注（製造）・買掛金→仕入の支払、経費・未払金→経費の支払、事業主貸・事業主借・資本金→事業主・資本など）。' }),
      h('li', { text: '設備・財務の行は、入金（借入れ・売却）がプラス、支払（返済・購入・引出し）がマイナスです。' }),
    ),
  );
  paint();
}

function cfStat(label, n) {
  return h('div', { class: 'lg-stat' }, h('span', { class: 'lg-stat-label', text: label }), amountCell('span', n));
}
