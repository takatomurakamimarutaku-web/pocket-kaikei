// キャッシュフロー計算書（間接法）と資金繰り表（月別の実績と予定）
import { h, put, amountCell } from '../ui.js';
import { cashFlowStatement, cashPlan, CASH_PLAN_ROWS } from '../cash-flow.js';
import { barLineChart } from '../chart.js';
import { openingDiff } from '../ledger.js';
import { formatPeriod, todayString } from '../period.js';
import { formatYen } from '../money.js';
import { zeroToggle, openingWarning } from './report-common.js';

export async function render({ app, outlet, route }) {
  const { settings, period, accounts, journals } = await app.load();
  const individual = settings.entityType === 'individual';
  const head = [
    h('p', { class: 'muted small', text: `${settings.businessName}　${formatPeriod(period)}` }),
    openingWarning(individual ? 0 : openingDiff(period, accounts)),
  ];
  if (route.kind === 'plan') return renderPlan({ app, outlet, period, accounts, journals, head });

  const cf = cashFlowStatement({ entityType: settings.entityType, accounts, period, journals });
  let showZero = false;
  const body = h('div');
  const zero = zeroToggle((v) => ((showZero = v), paint()));
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
      { class: `check-line ${cf.matches ? 'ok' : 'ng'}` },
      cf.matches ? `資金の増減 ${formatYen(cf.net)}円 ＝ 期末残高 − 期首残高` : `資金の増減と残高の差が合いません（差額 ${formatYen(cf.net - (cf.closing - cf.opening))}円）。期首残高の貸借を確かめてください。`,
    ),
    h(
      'div',
      { class: 'panel' },
      h('div', { class: 'kv' }, h('span', { text: '営業活動' }), h('span', { class: `num ${cf.sections[0].total < 0 ? 'neg' : ''}`, text: `${formatYen(cf.sections[0].total)}円` })),
      h('div', { class: 'kv' }, h('span', { text: 'フリーキャッシュフロー（営業＋投資）' }), h('strong', { class: `num ${cf.freeCashFlow < 0 ? 'neg' : ''}`, text: `${formatYen(cf.freeCashFlow)}円` })),
    ),
    zero.el,
    body,
    h(
      'ul',
      { class: 'plain-list small muted' },
      h('li', { text: '資金は現金と預金（定期預金を含む）です。期首と期末の貸借対照表の差額と、損益計算書から作っています（間接法）。' }),
      h('li', { text: individual ? '所得金額は青色申告特別控除前の金額です。生活費などの引出し・入金は「事業主との出し入れ」に入ります。' : '法人税等の支払額は、法人税等の費用から未払法人税等の増加を差し引いた額です。中間納付を仮払金で処理した場合は「その他の資産の増減」に入ります。' }),
      h('li', { text: '利息の受取・支払は営業活動に含めています（中小企業向けの簡便な形）。' }),
    ),
  );
  paint();
}

function renderPlan({ outlet, period, accounts, journals, head, app }) {
  return app.db.listTemplates().then((templates) => {
    const today = todayString();
    const plan = cashPlan({ accounts, period, journals, templates, today });
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
    put(
      outlet,
      head,
      minPlan && minPlan.closing < 0 ? h('p', { class: 'check-line ng', text: `${Number(minPlan.month.slice(5))}月末に資金が不足する見込みです（${formatYen(minPlan.closing)}円）` }) : null,
      chart,
      table,
      h(
        'ul',
        { class: 'plain-list small muted' },
        h('li', { text: '今月までは登録した仕訳の実績、来月からは予定です。予定は、先の日付で登録した仕訳と、まだ作っていない毎月の定型仕訳（現金・預金を使うもの）から作ります。' }),
        h('li', {}, '家賃・給料・借入金の返済などは ', h('a', { href: '#/templates', class: 'link', text: '定型仕訳' }), ' で「毎月作る」にすると予定に入ります。'),
        h('li', { text: '行は仕訳の相手科目で分けています（売上・売掛金・前受金→売上の入金、仕入・外注（製造）・買掛金→仕入の支払、経費・未払金→経費の支払、事業主貸・事業主借・資本金→事業主・資本など）。' }),
        h('li', { text: '設備・財務の行は、入金（借入れ・売却）がプラス、支払（返済・購入・引出し）がマイナスです。' }),
      ),
    );
  });
}
