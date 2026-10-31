// 年計（移動年計）：各月から過去12か月の売上・利益の合計。季節変動をならして、伸びているか落ちているかを見る
import { h, put, amountCell } from '../ui.js';
import { barLineChart } from '../chart.js';
import { movingAnnual } from '../advisor/simulation.js';
import { loadAdvisor, estimateNote, monthLabel } from './advisor-common.js';

const sign = (p) => (p === null ? '—' : `${p > 0 ? '+' : p < 0 ? '−' : ''}${(Math.abs(p) / 10).toFixed(1)}%`);

export async function render({ app, outlet, isStale }) {
  const { data, landing, previous } = await loadAdvisor(app);
  if (isStale?.()) return;
  const { settings, accounts } = data;
  const corp = settings.entityType === 'corporation';
  const r = movingAnnual({ accounts, landing, prev: previous });
  const salesWord = corp ? '売上高' : '売上(収入)金額';
  const profitWord = corp ? '利益（税引前）' : '所得（控除前）';
  // 年計が2か月以上そろわないと線にならないので、グラフは出さない
  const ready = r.sales.filter((x) => x !== null).length >= 2;
  const filled = (xs) => xs.map((x) => x ?? 0);
  put(
    outlet,
    h('p', { class: 'muted small', text: '年計（移動年計）は、その月までの12か月の合計です。毎月1か月分ずつ入れ替わるので、季節の変動が消え、事業が伸びているか落ちているかが線の向きで分かります。' }),
    previous ? null : h('p', { class: 'notice small', text: '前期の帳簿が無いため、12か月そろうのは期間の最後の月だけです。前期の帳簿があると、毎月の年計を出せます。' }),
    ready
      ? h(
          'div',
          { class: 'card advisor-chart' },
          barLineChart({ labels: r.months.map(monthLabel), bar: { label: `年計の${salesWord}`, values: filled(r.sales) }, line: { label: `年計の${profitWord}`, values: filled(r.profit) }, title: '年計の推移', planFrom: r.planFrom }),
          h('p', { class: 'muted small', text: '薄い棒と破線は、見込みの月を含む年計です。' }),
        )
      : null,
    r.change ? h('p', { class: 'panel small' }, `年計の${salesWord}は、${monthLabel(r.months[r.sales.findIndex((x) => x !== null)])}から${monthLabel(r.months.at(-1))}で `, h('strong', { text: sign(r.change.sales) }), `、${profitWord}は `, h('strong', { text: sign(r.change.profit) }), '。') : null,
    h(
      'div',
      { class: 'table-wrap' },
      h(
        'table',
        { class: 'report advisor-annual', 'aria-label': '年計' },
        h('thead', {}, h('tr', {}, h('th', { text: '月' }), h('th', { text: corp ? '月の売上' : '月の収入' }), h('th', { text: corp ? '年計 売上' : '年計 収入' }), h('th', { text: corp ? '年計 利益' : '年計 所得' }))),
        h(
          'tbody',
          {},
          r.months.map((m, i) =>
            h(
              'tr',
              { class: i >= r.planFrom ? 'is-plan' : '' },
              h('th', { scope: 'row' }, monthLabel(m), i >= r.planFrom ? h('span', { class: 'badge advisor-plan', text: '見込み' }) : null),
              amountCell('td', r.monthlySales[i]),
              r.sales[i] === null ? h('td', { class: 'num muted', text: '—' }) : amountCell('td', r.sales[i]),
              r.profit[i] === null ? h('td', { class: 'num muted', text: '—' }) : amountCell('td', r.profit[i]),
            ),
          ),
        ),
      ),
    ),
    estimateNote(),
  );
}
