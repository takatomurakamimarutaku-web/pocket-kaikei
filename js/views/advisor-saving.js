// 節税・税制の提案：着地見込みの利益から、決算までに打てる手と来期から使える制度を、減る税金の試算つきで並べる
import { hBarChart } from '../chart.js';
import { h, put, errorBox } from '../ui.js';
import { formatYen, parseYen } from '../money.js';
import { taxSavingPlan, NATURE_LABELS, TIMING_LABELS } from '../advisor/tax-saving.js';
import { loadAdvisor, estimateNote, monthLabel } from './advisor-common.js';

const yen = (n) => `${formatYen(n)}円`;

export async function render({ app, outlet, isStale }) {
  const { data, landing, assets } = await loadAdvisor(app);
  if (isStale?.()) return;
  const { settings, period, accounts, journals } = data;
  const corp = settings.entityType === 'corporation';
  // 画面で入れた金額（保存しない。画面を開いている間だけ）
  const amounts = {};
  const body = h('div');
  const errorsEl = h('div');
  const through = landing.actualThrough ? `${monthLabel(landing.actualThrough)}までの実績と、残りの月の見込み（着地見込み）から計算しています。` : 'すべての月を見込みで計算しています。';

  function paint() {
    const plan = taxSavingPlan({ settings, accounts, period, journals: landing.journals, actualJournals: journals, assets, amounts });
    const { base, marginal } = plan;
    const groups = Object.keys(TIMING_LABELS)
      .map((t) => [t, plan.proposals.filter((p) => p.timing === t)])
      .filter(([, list]) => list.length);
    put(
      body,
      h(
        'div',
        { class: 'kpi-grid' },
        h('div', { class: 'kpi' }, h('span', { class: 'kpi-label', text: corp ? '着地の法人税等' : '着地の所得税・事業税' }), h('span', { class: 'kpi-value num', text: yen(base.incomeTaxes) }), h('span', { class: 'kpi-sub', text: corp ? `所得金額 ${yen(plan.income)}` : `事業所得 ${yen(plan.income)}` })),
        h('div', { class: 'kpi' }, h('span', { class: 'kpi-label', text: '費用が100万円増えると' }), h('span', { class: 'kpi-value num', text: `−${yen(marginal.saving)}` }), h('span', { class: 'kpi-sub', text: `税金が減る割合 約${(marginal.permille / 10).toFixed(1)}%` })),
      ),
      h('p', { class: 'muted small', text: through }),
      marginal.saving > 0
        ? h('p', { class: 'notice small', text: `費用を使って税金を減らすと、減る税金（約${(marginal.permille / 10).toFixed(1)}%）より出ていくお金のほうが大きいので、手元のお金は減ります。必要な支出かどうかを先に考え、そのうえで時期と制度を選んでください。` })
        : h('p', { class: 'notice small', text: '所得が出ない見込みなので、費用を増やしても当期の税金は減りません（法人の住民税の均等割などは所得が無くてもかかります）。来期から使える制度と、消費税の計算方法を確かめてください。' }),
      plan.canSim ? null : h('p', { class: 'notice', text: '雑費または現金・預金の科目が無いため、減る税金を計算できません。' }),
      plan.proposals.some((p) => p.applicable && (p.cash > 0 || p.saving > 0))
        ? hBarChart({
            title: '使うお金と減る税金',
            rows: plan.proposals.filter((p) => p.applicable && (p.cash > 0 || p.saving > 0)).map((p) => ({ label: p.title, values: [p.cash || 0, p.saving || 0] })),
            series: [{ label: '使うお金（出ていく・積み立てる額）', cls: 'hb-4' }, { label: '減る税金', cls: 'hb-2' }],
            format: (v) => yen(v),
          })
        : null,
      groups.map(([t, list]) => [h('h2', { class: 'section-title', text: TIMING_LABELS[t] }), list.map(card)]),
      errorsEl,
    );
  }

  function card(p) {
    const input = p.editable
      ? h('input', {
          type: 'text',
          inputmode: 'numeric',
          class: 'saving-amount',
          'aria-label': `${p.title}の金額`,
          value: formatYen(p.amount),
          onchange: (e) => {
            const r = parseYen(e.target.value || '0', { allowZero: true });
            if (!r.ok) return put(errorsEl, errorBox([`${p.title}：${r.error}`]));
            put(errorsEl);
            amounts[p.id] = r.value;
            paint();
          },
        })
      : null;
    const net = p.saving - p.cash;
    const stats = p.consumption
      ? [stat('減る消費税', p.saving, 'strong')]
      : [
          p.editable || p.amount ? stat(p.nature === 'deduction' && !p.cash ? '控除が増える額' : '使う金額', p.editable ? null : p.amount, '', input) : null,
          stat('減る税金', p.saving, 'strong'),
          p.cash ? stat('手元のお金（差し引き）', net, net < 0 ? 'neg' : '') : null,
        ];
    return h(
      'section',
      { class: `panel saving-card ${p.applicable ? '' : 'is-off'}`, 'aria-label': p.title },
      h('div', { class: 'saving-head' }, h('h3', { class: 'saving-title', text: p.title }), h('span', { class: 'badge', text: NATURE_LABELS[p.nature] })),
      h('p', { class: 'small', text: p.summary }),
      p.reason ? h('p', { class: 'muted small', text: p.reason }) : null,
      p.applicable && (p.editable || p.amount || p.saving) ? h('div', { class: 'saving-stats' }, stats) : null,
      h(
        'details',
        { class: 'saving-more' },
        h('summary', { text: '条件と注意点' }),
        p.requirements.length ? [h('p', { class: 'small strong', text: '使うための条件' }), h('ul', { class: 'plain-list small' }, p.requirements.map((t) => h('li', { text: t })))] : null,
        p.cautions.length ? [h('p', { class: 'small strong', text: '注意すること' }), h('ul', { class: 'plain-list small' }, p.cautions.map((t) => h('li', { text: t })))] : null,
        p.sources.length ? h('p', { class: 'small' }, '出典：', p.sources.map((s, i) => [i ? '、' : '', h('a', { class: 'link', href: s.url, target: '_blank', rel: 'noopener noreferrer', text: s.label })])) : null,
      ),
    );
  }

  function stat(label, value, cls = '', control = null) {
    return h('div', { class: 'saving-stat' }, h('span', { class: 'muted small', text: label }), control || h('span', { class: `num ${cls}`, text: value < 0 ? `−${yen(-value)}` : yen(value) }));
  }

  paint();
  put(
    outlet,
    body,
    h('p', { class: 'muted small', text: `「減る税金」は、${corp ? '法人税・地方法人税・防衛特別法人税・住民税・事業税' : '所得税及び復興特別所得税・個人事業税'}の年税額の差です（${corp ? '' : '住民税・'}消費税は含めません）。金額を変えると計算し直します（保存はしません）。` }),
    h('p', { class: 'muted small', text: '制度の条件は令和8年10月時点で国税庁・中小機構の資料で確かめたものです。使うかどうかは、条件を満たすかも含めて税理士に相談してください。' }),
    h('a', { class: 'btn btn-block', href: '#/advisor/forecast', text: '着地見込みを直す' }),
    estimateNote(),
  );
}
