// 決算検討会の資料：着地見込み・納税予測・月別の見込み・節税の提案・季節変動の注意・年計を1冊にまとめ、印刷（PDF 保存）する
// 古田土会計の「決算前検討会」（決算の2〜3か月前に、着地の利益と納税額を見て対策を決める）を参考にした。
// 画面の表を印刷の帳票にする仕組み（print-capture.js）で印刷するので、入力欄は置かず、表と文章だけで組む
import { h, put, amountCell } from '../ui.js';
import { formatYen } from '../money.js';
import { GROUP_BY_ID, compareAccounts } from '../accounts.js';
import { buildStatements } from '../statements.js';
import { formatPeriod, todayString, monthRange } from '../period.js';
import { taxSavingPlan, TIMING_LABELS } from '../advisor/tax-saving.js';
import { seasonalAdvice } from '../advisor/seasonality.js';
import { movingAnnual } from '../advisor/simulation.js';
import { loadAdvisor, estimateNote, monthLabel } from './advisor-common.js';

const slash = (d) => d.replaceAll('-', '/');
const pct = (p) => (p === null || p === undefined ? '—' : `${p > 0 ? '+' : p < 0 ? '−' : ''}${(Math.abs(p) / 10).toFixed(1)}%`);

export async function render({ app, outlet, isStale }) {
  const { data, landing, taxes, previous, assets } = await loadAdvisor(app);
  if (isStale?.()) return;
  const { settings, period, accounts, journals } = data;
  const entityType = settings.entityType;
  const corp = entityType === 'corporation';
  const side = (a) => GROUP_BY_ID[a.group]?.side;
  const actual = new Set(landing.actualMonths);
  const prevPl = previous ? buildStatements({ entityType, accounts, period: previous.period, journals: previous.journals }).pl : null;

  // ---- 1. 着地の損益と税金 ----
  const lines = corp
    ? [['sales', '売上高'], ['gross', '売上総利益'], ['operating', '営業利益'], ['ordinary', '経常利益'], ['pretax', '税引前当期純利益']]
    : [['sales', '売上(収入)金額'], ['diff1', '差引金額'], ['income', '所得金額（青色申告特別控除前）']];
  const actualPl = landing.actualThrough ? buildStatements({ entityType, accounts, period, journals, to: monthRange(period, null, landing.actualThrough).to }).pl : null;
  const yoy = (now, before) => (before ? pct(Math.round(((now - before) * 1000) / Math.abs(before))) : '—');
  const summary = h(
    'table',
    { class: 'report', 'aria-label': '着地の損益' },
    h('thead', {}, h('tr', {}, h('th', { text: '' }), h('th', { text: landing.actualThrough ? `実績（${monthLabel(landing.actualThrough)}まで）` : '実績' }), h('th', { text: '着地' }), h('th', { text: '前期' }), h('th', { text: '前期比' }))),
    h(
      'tbody',
      {},
      lines.map(([k, label]) => h('tr', {}, h('th', { scope: 'row', text: label }), amountCell('td', actualPl ? actualPl.profits[k] : 0), amountCell('td', taxes.pl.profits[k]), prevPl ? amountCell('td', prevPl.profits[k]) : h('td', { class: 'num', text: '—' }), h('td', { class: 'num', text: prevPl ? yoy(taxes.pl.profits[k], prevPl.profits[k]) : '—' }))),
      h('tr', {}, h('th', { scope: 'row', text: corp ? '法人税等（見込み）' : '所得税・事業税（見込み）' }), h('td', {}), amountCell('td', taxes.incomeTaxes), h('td', {}), h('td', {})),
      h('tr', { class: 'total' }, h('th', { scope: 'row', text: corp ? '当期純利益（税引後の見込み）' : '税金を引いた所得（目安）' }), h('td', {}), amountCell('td', taxes.afterTax), corp && prevPl ? amountCell('td', prevPl.profits.net) : h('td', {}), h('td', {})),
    ),
  );
  const taxTable = h(
    'table',
    { class: 'report', 'aria-label': '納める税金の見込み' },
    h('thead', {}, h('tr', {}, h('th', { text: '税目' }), h('th', { text: '年税額' }), h('th', { text: '中間納付' }), h('th', { text: '差引納付額' }), h('th', { text: '納期限' }))),
    h(
      'tbody',
      {},
      taxes.items.map((i) => h('tr', {}, h('th', { scope: 'row', text: i.label }), amountCell('td', i.annual), amountCell('td', i.interim), amountCell('td', i.due), h('td', { class: 'num', text: slash(i.deadline) }))),
      h('tr', { class: 'total' }, h('th', { scope: 'row', text: '合計' }), amountCell('td', taxes.items.reduce((s, i) => s + i.annual, 0)), amountCell('td', taxes.items.reduce((s, i) => s + i.interim, 0)), amountCell('td', taxes.total), h('td', {})),
    ),
  );

  // ---- 2. 月別の見込み（区分ごと） ----
  const byGroup = new Map();
  for (const r of [...landing.rows].sort((a, b) => compareAccounts(a.account, b.account))) {
    if (!r.monthly.some((x) => x) && !r.landing) continue;
    if (!byGroup.has(r.account.group)) byGroup.set(r.account.group, []);
    byGroup.get(r.account.group).push(r);
  }
  const months = landing.months;
  const profit = months.map((_, i) => landing.rows.reduce((t, r) => t + (side(r.account) === 'credit' ? r.monthly[i] : -r.monthly[i]), 0));
  let cum = 0;
  const monthly = h(
    'table',
    { class: 'report', 'aria-label': '月別の見込み' },
    h('thead', {}, h('tr', {}, h('th', { text: '区分' }), months.map((m) => h('th', { text: `${monthLabel(m)}${actual.has(m) ? '' : '見'}` })), h('th', { text: '着地' }))),
    h(
      'tbody',
      {},
      [...byGroup].map(([g, list]) => h('tr', {}, h('th', { scope: 'row', text: GROUP_BY_ID[g]?.label || g }), months.map((_, i) => amountCell('td', list.reduce((t, r) => t + r.monthly[i], 0))), amountCell('td', list.reduce((t, r) => t + r.landing, 0)))),
      h('tr', { class: 'total' }, h('th', { scope: 'row', text: corp ? '利益（税引前）' : '所得（控除前）' }), profit.map((x) => amountCell('td', x)), amountCell('td', profit.reduce((a, b) => a + b, 0))),
      h('tr', { class: 'subtotal' }, h('th', { scope: 'row', text: '累計' }), profit.map((x) => amountCell('td', (cum += x))), h('td', {})),
    ),
  );

  // ---- 3. 節税・税制の提案 ----
  const plan = taxSavingPlan({ settings, accounts, period, journals: landing.journals, actualJournals: journals, assets });
  const usable = plan.proposals.filter((p) => p.applicable);
  const savingTable = h(
    'table',
    { class: 'report', 'aria-label': '節税・税制の提案' },
    h('thead', {}, h('tr', {}, h('th', { text: '提案' }), h('th', { text: '時期' }), h('th', { text: '使う金額' }), h('th', { text: '減る税金' }), h('th', { text: '検討' }))),
    h(
      'tbody',
      {},
      usable.map((p) => h('tr', {}, h('th', { scope: 'row', text: p.title }), h('td', { text: TIMING_LABELS[p.timing] }), p.cash ? amountCell('td', p.cash) : h('td', { class: 'num', text: '—' }), p.saving ? amountCell('td', p.saving) : h('td', { class: 'num', text: '—' }), h('td', { text: '□する □しない' }))),
    ),
  );

  // ---- 4. 季節変動・特別な支出 ----
  const advice = seasonalAdvice({ landing });

  // ---- 5. 年計 ----
  const annual = movingAnnual({ accounts, landing, prev: previous });
  const lastIdx = annual.sales.length - 1;

  put(
    outlet,
    h(
      'div',
      { class: 'fs-section' },
      // 会社名・期間・作成日は印刷の見出しに入るので、画面だけに出す
      h('p', { class: 'muted small', text: `${settings.businessName}　${formatPeriod(period)}　作成日 ${slash(todayString())}` }),
      h('p', { text: landing.actualThrough ? `${slash(landing.actualThrough)}までの実績と、残りの月の見込みから期末の着地を予想しています。` : 'すべての月を見込みで計算しています。' }),
      h('h3', { text: '1. 着地の損益' }),
      summary,
      h('h3', { text: '2. 納める税金の見込み' }),
      taxes.items.length ? taxTable : h('p', { text: '納める税金の見込みはありません。' }),
      h('p', { text: `費用が100万円増えると、税金は約${formatYen(plan.marginal.saving)}円（約${(plan.marginal.permille / 10).toFixed(1)}%）減ります。` }),
    ),
    h('div', { class: 'fs-section' }, h('h2', { text: '3. 月別の見込み' }), monthly, h('p', { text: '「見」の付いた月は見込みです。' })),
    h(
      'div',
      { class: 'fs-section' },
      h('h2', { text: '4. 節税・税制の提案' }),
      usable.length ? savingTable : h('p', { text: '使える提案はありません。' }),
      h('p', { text: '減る税金は、着地見込みの数字で納税予測を計算し直した差です。使うための条件は「節税・税制の提案」の画面で確かめてください。' }),
      advice.length
        ? [h('h3', { text: '5. 季節変動・特別な支出の注意' }), h('ul', {}, advice.map((a) => h('li', { text: `${a.account.name}：${a.message}${a.missing ? '（いまの見込みに入っていません）' : ''}` })))]
        : null,
      annual.sales[lastIdx] !== null
        ? [
            h('h3', { text: '6. 年計（12か月の合計）' }),
            h('p', { text: `${monthLabel(months.at(-1))}の年計：${corp ? '売上高' : '売上(収入)金額'} ${formatYen(annual.sales[lastIdx])}円、${corp ? '利益' : '所得'} ${formatYen(annual.profit[lastIdx])}円${annual.change ? `（年計がそろった最初の月から ${pct(annual.change.sales)}・${pct(annual.change.profit)}）` : ''}。` }),
          ]
        : null,
      h('h3', { text: '決めたこと・やること' }),
      h('table', { class: 'report', 'aria-label': '決めたこと' }, h('thead', {}, h('tr', {}, h('th', { text: 'やること' }), h('th', { text: '担当' }), h('th', { text: '期限' }))), h('tbody', {}, [1, 2, 3, 4, 5].map(() => h('tr', {}, h('td', { text: ' ' }), h('td', { text: ' ' }), h('td', { text: ' ' }))))),
    ),
    h('p', { class: 'print-only', text: '帳簿と入力した見込みから求めた試算です。申告の金額は、決算を終えてから申告の画面で確かめてください。' }),
    h('p', { class: 'muted small no-print', text: '右上の印刷のボタンで、この資料を印刷・PDFに保存できます。見込みは「着地見込み」、提案の金額は「節税・税制の提案」で直してから印刷してください。' }),
    estimateNote(),
  );
}
