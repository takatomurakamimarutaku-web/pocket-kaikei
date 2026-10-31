// 経営サポートのホーム：着地見込み（売上・利益）と納める税金の見込み、月別のグラフ、経営の画面への入口
import { h, put } from '../ui.js';
import { formatYen } from '../money.js';
import { daysBetween } from '../period.js';
import { monthlyIncome } from '../monthly.js';
import { barLineChart } from '../chart.js';
import { menuRow } from '../icons.js';
import { modeSwitch, loadAdvisor, estimateNote, monthLabel } from './advisor-common.js';

const slash = (d) => d.replaceAll('-', '/');

function kpi(label, value, sub, href) {
  return h('a', { class: 'kpi', href }, h('span', { class: 'kpi-label', text: label }), h('span', { class: `kpi-value num ${value < 0 ? 'neg' : ''}`, text: `${formatYen(value)}円` }), sub ? h('span', { class: 'kpi-sub', text: sub }) : null);
}

const menu = (href, label, sub, icon, tone = 'close') => menuRow({ href, label, sub, icon, tone });

export async function render({ app, outlet }) {
  const { data, landing, taxes, previous, today } = await loadAdvisor(app);
  const { settings, period, accounts } = data;
  const individual = settings.entityType === 'individual';
  const pl = taxes.pl;
  const prevSales = previous ? landing.rows.filter((r) => r.account.group === 'sales').reduce((s, r) => s + (r.previous || 0), 0) : null;
  const left = today > period.endDate ? 0 : daysBetween(today, period.endDate);
  const nextDue = taxes.items.filter((i) => i.due > 0).map((i) => i.deadline).sort()[0];
  const monthly = monthlyIncome({ entityType: settings.entityType, accounts, period, journals: taxes.journals });
  const through = landing.actualThrough ? `${monthLabel(landing.actualThrough)}まで実績` : 'まだ実績の月なし';

  put(
    outlet,
    modeSwitch('advisor'),
    h(
      'section',
      { class: 'hero advisor-hero' },
      h('div', { class: 'hero-top' }, h('h2', { class: 'hero-name', text: settings.businessName })),
      h('p', { class: 'hero-lead', text: today > period.endDate ? `会計期間（${slash(period.endDate)}まで）が終わりました。決算の数字と納める税金を確かめましょう。` : `決算（${slash(period.endDate)}）まであと${left}日。${through}、残りの月は見込みで計算しています。` }),
    ),
    h(
      'section',
      { class: 'kpi-grid' },
      kpi(individual ? '着地の売上(収入)金額' : '着地の売上高', pl.profits.sales, prevSales !== null ? `前期 ${formatYen(prevSales)}円` : through, '#/advisor/forecast'),
      individual ? kpi('着地の所得金額（控除前）', pl.netIncome, `税金を引いた目安 ${formatYen(taxes.afterTax)}円`, '#/advisor/forecast') : kpi('着地の税引前当期純利益', taxes.pretax, `税引後 ${formatYen(taxes.afterTax)}円`, '#/advisor/forecast'),
      kpi('納める税金の見込み', taxes.total, nextDue ? `最初の納期限 ${slash(nextDue)}` : '納める税金はありません', '#/advisor/tax'),
      h('a', { class: 'kpi', href: '#/advisor/forecast' }, h('span', { class: 'kpi-label', text: '決算まで' }), h('span', { class: 'kpi-value num', text: left ? `${left}日` : '期間終了' }), h('span', { class: 'kpi-sub', text: through })),
    ),
    h(
      'section',
      { class: 'card-section advisor-chart' },
      h('div', { class: 'card-title-row' }, h('h2', { class: 'card-title', text: '月別の売上と利益（実績と見込み）' }), h('a', { href: '#/advisor/forecast', class: 'link small', text: '着地見込み' })),
      barLineChart({
        labels: monthly.months.map(monthLabel),
        bar: { label: individual ? '売上(収入)金額' : '売上高', values: monthly.sales },
        line: { label: individual ? '所得金額（控除前）' : '当期純利益', values: monthly.netIncome },
        title: '月別の売上と利益',
        planFrom: landing.actualMonths.length,
      }),
      h('p', { class: 'muted small', text: '薄い棒と破線が見込みの月です。法人の当期純利益は、法人税等を見込む前の金額です。' }),
    ),
    h('h2', { class: 'menu-group-title', text: '決算の見込み' }),
    h(
      'ul',
      { class: 'menu-group' },
      menu('#/advisor/forecast', '着地見込み', '残りの月の売上・経費を見込んで、期末の利益を予想する', 'chart'),
      menu('#/advisor/tax', '納税予測', '着地の利益から、納める税金と納期限を出す', 'tax', 'tax'),
      menu('#/advisor/saving', '節税・税制の提案', '決算までに打てる手と来期の制度を、減る税金の試算つきで', 'flag', 'tax'),
    ),
    h('h2', { class: 'menu-group-title', text: '計画と分析' }),
    h(
      'ul',
      { class: 'menu-group' },
      menu('#/advisor/simulation', '利益シミュレーション', '売上・変動費率・固定費を動かして、利益と損益分岐点を見る', 'chart', 'report'),
      menu('#/advisor/annual', '年計（移動年計）', '12か月の合計の推移で、伸びているか落ちているかを見る', 'chart', 'report'),
      menu('#/budget', '予算の入力', '着地見込みの「予算」で使う月別の金額', 'flag', 'report'),
      menu('#/reports/cash-plan', '資金繰り表', '入金・支払の予定から、資金の残りを見る', 'calendar', 'report'),
      menu('#/reports/analysis', '経営分析', '収益性・安全性・損益分岐点', 'chart', 'report'),
    ),
    individual
      ? null
      : [
          h('h2', { class: 'menu-group-title', text: '事業承継' }),
          h('ul', { class: 'menu-group' }, menu('#/advisor/succession', '自社株の評価（概算）', '会社規模・類似業種比準・純資産から株価を試算し、対策の効果を見る', 'bs', 'report')),
        ],
    estimateNote(),
  );
}
