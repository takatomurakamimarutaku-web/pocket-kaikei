// 利益シミュレーション：着地見込みをもとに、売上・変動費率・固定費を動かしたときの利益・損益分岐点・税引後の利益を出す
import { h, put, amountCell, errorBox } from '../ui.js';
import { formatYen, parseYen } from '../money.js';
import { breakEvenChart } from '../chart.js';
import { simulateProfit, baseFromPl, taxesAtDelta, DEFAULT_SIMULATION } from '../advisor/simulation.js';
import { loadAdvisor, estimateNote, monthLabel } from './advisor-common.js';

const pctText = (p) => (p === null || p === undefined ? '—' : `${(p / 10).toFixed(1)}%`);
/** 「10」「-5.5」→ ‰（小数1桁まで） */
export function parsePercent(text) {
  const t = String(text).trim().replace('−', '-').replace('％', '').replace('%', '');
  if (t === '') return { ok: true, value: 0 };
  if (!/^-?\d{1,4}(\.\d)?$/.test(t)) return { ok: false, error: '数字（小数1桁まで）で入れてください' };
  return { ok: true, value: Math.round(Number(t) * 10) };
}

export async function render({ app, outlet, isStale }) {
  const { data, landing, taxes } = await loadAdvisor(app);
  if (isStale?.()) return;
  const { settings, period, accounts, journals } = data;
  const corp = settings.entityType === 'corporation';
  const base = baseFromPl(settings.entityType, landing.pl.profits);
  const input = { ...DEFAULT_SIMULATION };
  const body = h('div');
  const errorsEl = h('div');
  const ctx = { settings, accounts, period, journals: landing.journals, actualJournals: journals };
  const baseTax = taxes.incomeTaxes;
  const profitWord = corp ? '経常利益' : '所得（控除前）';

  function field(label, key, unit, parse, hint) {
    const show = (v) => (unit === '%' ? (v / 10).toString() : v === null ? '' : formatYen(v));
    return h(
      'label',
      { class: 'sim-field' },
      h('span', { class: 'field-label', text: label }),
      h(
        'span',
        { class: 'sim-input' },
        h('input', {
          type: 'text',
          inputmode: unit === '%' ? 'decimal' : 'numeric',
          value: show(input[key]),
          'aria-label': label,
          onchange: (e) => {
            const r = parse(e.target.value);
            if (!r.ok) return put(errorsEl, errorBox([`${label}：${r.error}`]));
            put(errorsEl);
            input[key] = r.value;
            paint();
          },
        }),
        h('span', { class: 'muted small', text: unit }),
      ),
      hint ? h('span', { class: 'muted small', text: hint }) : null,
    );
  }
  const yenParse = (allowNegative) => (t) => (String(t).trim() === '' ? { ok: true, value: allowNegative ? 0 : null } : parseYen(t, { allowZero: true, allowNegative }));

  function paint() {
    const r = simulateProfit(base, input);
    const delta = r.sim.profit - r.base.profit;
    const simTax = taxesAtDelta({ ...ctx, delta });
    const after = (profit, tax) => (tax === null ? null : profit - tax);
    const row = (label, a, b, kind = 'yen', strong = false) => {
      const cell = (v) => (kind === 'pct' ? h('td', { class: 'num', text: pctText(v) }) : v === null ? h('td', { class: 'num muted', text: '—' }) : amountCell('td', v));
      const diff = a === null || b === null ? h('td', { class: 'num muted', text: '' }) : kind === 'pct' ? h('td', { class: 'num', text: b - a ? `${b - a > 0 ? '+' : '−'}${(Math.abs(b - a) / 10).toFixed(1)}pt` : '' }) : b - a ? amountCell('td', b - a) : h('td', { class: 'num', text: '' });
      return h('tr', { class: strong ? 'mt-strong' : '' }, h('th', { scope: 'row', text: label }), cell(a), cell(b), diff);
    };
    put(
      body,
      h(
        'div',
        { class: 'table-wrap' },
        h(
          'table',
          { class: 'report advisor-sim', 'aria-label': '利益シミュレーション' },
          h('thead', {}, h('tr', {}, h('th', { text: '' }), h('th', { text: '着地' }), h('th', { text: 'シミュレーション' }), h('th', { text: '差' }))),
          h(
            'tbody',
            {},
            row(corp ? '売上高' : '売上(収入)金額', r.base.sales, r.sim.sales),
            row('変動費（売上原価）', r.base.variable, r.sim.variable),
            row('限界利益', r.base.marginal, r.sim.marginal),
            row('限界利益率', r.base.marginalRate, r.sim.marginalRate, 'pct'),
            row('固定費', r.base.fixed, r.sim.fixed),
            row(profitWord, r.base.profit, r.sim.profit, 'yen', true),
            row('損益分岐点売上高', r.base.point, r.sim.point),
            row('安全余裕率', r.base.safety, r.sim.safety, 'pct'),
            row(corp ? '法人税等' : '所得税・事業税', baseTax, simTax),
            row(corp ? '税引後の利益（目安）' : '税金を引いた所得（目安）', after(r.base.profit, baseTax), after(r.sim.profit, simTax), 'yen', true),
          ),
        ),
      ),
      r.required !== null
        ? h('p', { class: 'panel sim-required' }, `${profitWord} ${formatYen(input.targetProfit)}円に必要な売上高は `, h('strong', { class: 'num', text: `${formatYen(r.required)}円` }), r.base.sales > 0 ? `（着地の${pctText(Math.round((r.required * 1000) / r.base.sales))}、月平均 ${formatYen(Math.ceil(r.required / landing.months.length))}円）` : '', '。')
        : null,
      breakEvenChart({ ...r.sim, title: r.sim.sales === r.base.sales && r.sim.fixed === r.base.fixed && r.sim.variable === r.base.variable ? '損益分岐点図（着地）' : '損益分岐点図（シミュレーション後）', salesLabel: corp ? '売上高' : '売上(収入)金額' }),
    );
  }

  paint();
  const through = landing.actualThrough ? `${monthLabel(landing.actualThrough)}までの実績と残りの月の見込み（着地見込み）が元です。` : 'すべての月を見込みで計算しています。';
  put(
    outlet,
    h('p', { class: 'muted small', text: through }),
    h(
      'div',
      { class: 'panel sim-inputs' },
      field('売上の増減', 'salesPermille', '%', parsePercent, '例：10 で10%増、-5 で5%減（数量・単価のどちらでも）'),
      field('変動費率の変化', 'variableRateDelta', '%', parsePercent, `今の変動費率 ${pctText(base.sales > 0 ? Math.round((base.variable * 1000) / base.sales) : null)}。例：2 で仕入れ値が売上の2%分上がる`),
      field('固定費の増減', 'fixedDelta', '円', yenParse(true), '例：人を1人増やす・家賃が上がる'),
      field(`目標の${profitWord}`, 'targetProfit', '円', yenParse(false), '入れると必要な売上高を出します'),
    ),
    errorsEl,
    body,
    h('p', { class: 'muted small', text: `変動費は売上原価、固定費はそれ以外の費用（${corp ? '営業外の損益を含む' : '専従者給与を含む'}）とする簡便な分け方です（経営分析の損益分岐点と同じ）。税金は、${profitWord}の差を期末に足して納税予測と同じ計算でやり直した額です。` }),
    h('a', { class: 'btn btn-block', href: '#/advisor/forecast', text: '着地見込みを直す' }),
    estimateNote(),
  );
}
