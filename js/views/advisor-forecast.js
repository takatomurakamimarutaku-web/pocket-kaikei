// 着地見込み（決算予測）：実績の月＋残りの月の見込みで、期末の損益を予想する。科目ごとに見込みの立て方を選べる
import { h, put, amountCell, showToast, errorBox, confirmDialog } from '../ui.js';
import { formatYen, parseYen } from '../money.js';
import { GROUP_BY_ID, compareAccounts } from '../accounts.js';
import { buildStatements } from '../statements.js';
import { monthRange, formatPeriod, addMonths } from '../period.js';
import { forecastLanding, FORECAST_METHODS, RESOLVED_LABELS, cleanForecast } from '../advisor/forecast.js';
import { forecastTaxes } from '../advisor/tax-forecast.js';
import { errorText } from '../errors.js';
import { loadAdvisor, estimateNote, monthLabel } from './advisor-common.js';

const clone = (o) => JSON.parse(JSON.stringify(o));

/** 段階利益の行（法人：売上高〜税引前当期純利益、個人：売上(収入)金額〜所得金額） */
function profitLines(entityType) {
  if (entityType === 'corporation') {
    return [
      ['sales', '売上高'],
      ['gross', '売上総利益'],
      ['operating', '営業利益'],
      ['ordinary', '経常利益'],
      ['pretax', '税引前当期純利益'],
    ];
  }
  return [
    ['sales', '売上(収入)金額'],
    ['diff1', '差引金額（売上−売上原価）'],
    ['income', '所得金額（青色申告特別控除前）'],
  ];
}

export async function render({ app, outlet, isStale }) {
  const loaded = await loadAdvisor(app);
  const { data, previous, today, budgets, assets, periods } = loaded;
  const { settings, period, accounts, journals } = data;
  const entityType = settings.entityType;
  if (isStale?.()) return;
  const input = clone({ actualThrough: null, methods: {}, manual: {}, ...(period.forecast || {}) });
  let dirty = false;
  const body = h('div');
  const errorsEl = h('div');
  const prevPl = previous ? buildStatements({ entityType, accounts, period: previous.period, journals: previous.journals }).pl : null;

  function compute() {
    const landing = forecastLanding({ entityType, accounts, period, journals, budgets, prev: previous, assets, periods, input, today });
    const taxes = forecastTaxes({ settings, accounts, period, journals: landing.journals, actualJournals: journals });
    return { landing, taxes };
  }

  function paint() {
    const { landing, taxes } = compute();
    const actualPl = landing.actualThrough ? buildStatements({ entityType, accounts, period, journals, to: monthRange(period, null, landing.actualThrough).to }).pl : null;
    const throughLabel = landing.actualThrough ? `実績（${monthLabel(landing.actualThrough)}まで）` : '実績';

    // ---- 実績とみなす月 ----
    const select = h(
      'select',
      {
        'aria-label': '実績とみなす最後の月',
        onchange: (e) => {
          // 「まだ無し」は期間の前の月を保存する（期間の最初の月より前＝実績の月なし）
          input.actualThrough = e.target.value === 'none' ? addMonths(`${landing.months[0]}-01`, -1).slice(0, 7) : e.target.value;
          dirty = true;
          paint();
        },
      },
      h('option', { value: 'none', text: 'まだ無し（すべて見込み）', selected: !landing.actualThrough }),
      landing.months.map((m) => h('option', { value: m, text: `${m.slice(0, 4)}年${monthLabel(m)}まで`, selected: m === landing.actualThrough })),
    );

    // ---- 段階利益の着地 ----
    const lines = profitLines(entityType);
    const summaryRows = lines.map(([key, label]) =>
      h('tr', { class: key === lines.at(-1)[0] ? 'mt-strong' : '' }, h('th', { scope: 'row', text: label }), amountCell('td', actualPl ? actualPl.profits[key] : 0), amountCell('td', taxes.pl.profits[key]), prevPl ? amountCell('td', prevPl.profits[key]) : h('td', { class: 'num muted', text: '—' })),
    );
    if (entityType === 'corporation') {
      summaryRows.push(
        h('tr', {}, h('th', { scope: 'row', text: '法人税等の見込み' }), h('td', { class: 'num muted', text: '' }), amountCell('td', taxes.incomeTaxes), h('td', { class: 'num muted', text: '' })),
        h('tr', { class: 'mt-strong' }, h('th', { scope: 'row', text: '当期純利益（税引後の見込み）' }), h('td', { class: 'num muted', text: '' }), amountCell('td', taxes.afterTax), prevPl ? amountCell('td', prevPl.profits.net) : h('td', { class: 'num muted', text: '—' })),
      );
    }
    const summary = h('div', { class: 'table-wrap' }, h('table', { class: 'report advisor-summary', 'aria-label': '着地の損益' }, h('thead', {}, h('tr', {}, h('th', { text: '' }), h('th', { text: throughLabel }), h('th', { text: '着地' }), h('th', { text: '前期' }))), h('tbody', {}, summaryRows)));

    // ---- 科目ごとの見込み ----
    const shown = landing.rows.filter((r) => r.actual || r.forecast || r.previous || r.budget || r.method !== 'auto').sort((a, b) => compareAccounts(a.account, b.account));
    const byGroup = new Map();
    for (const r of shown) {
      if (!byGroup.has(r.account.group)) byGroup.set(r.account.group, []);
      byGroup.get(r.account.group).push(r);
    }
    const accountRows = [];
    for (const [group, rows] of byGroup) {
      accountRows.push(h('tr', { class: 'fs-r-group' }, h('th', { colspan: '5', scope: 'rowgroup', text: GROUP_BY_ID[group]?.label || group })));
      for (const r of rows) accountRows.push(...accountRow(r));
    }
    const table = h(
      'div',
      { class: 'table-wrap' },
      h('table', { class: 'report advisor-accounts', 'aria-label': '科目ごとの見込み' }, h('thead', {}, h('tr', {}, h('th', { text: '科目' }), h('th', { text: throughLabel }), h('th', { text: '見込み' }), h('th', { text: '着地' }), h('th', { text: '前期' }))), h('tbody', {}, accountRows)),
    );

    put(
      body,
      h('div', { class: 'panel advisor-through' }, h('label', { class: 'field-label', text: '実績とみなす最後の月' }), select, h('p', { class: 'muted small', text: '記帳が終わった月までを実績にします。その後の月は、下の立て方で見込みます。' })),
      h('h2', { class: 'section-title', text: '着地の損益' }),
      summary,
      taxes.notes.filter((n) => /消費税等/.test(n)).map((n) => h('p', { class: 'muted small', text: n })),
      landing.depreciation.expected && !landing.depreciation.booked ? h('p', { class: 'muted small', text: `減価償却の仕訳がまだ無いため、固定資産台帳の当期の償却額 ${formatYen(landing.depreciation.expected)}円を期末に見込んでいます。` }) : null,
      landing.dropped ? h('p', { class: 'muted small', text: `見込みの月に入っている仕訳 ${landing.dropped}件（決算整理を除く）は着地に入れず、見込みの金額に置き換えています。実績にするときは「実績とみなす最後の月」を進めてください。` }) : null,
      landing.noCash ? h('p', { class: 'notice', text: '現金・預金の科目が無いため、見込みを計算できません。' }) : null,
      h('h2', { class: 'section-title', text: '科目ごとの見込み' }),
      shown.length ? table : h('p', { class: 'muted', text: 'まだ損益の取引がありません。' }),
      h('p', { class: 'muted small', text: '期末の棚卸高は、決算整理の仕訳が無ければ期首と同じと見なしています（売上原価＝仕入）。見込みの金額は帳簿には登録しません。' }),
    );
  }

  function accountRow(r) {
    const pick = h(
      'select',
      {
        class: 'advisor-method',
        'aria-label': `${r.account.name}の見込みの立て方`,
        onchange: (e) => {
          input.methods[r.account.id] = e.target.value;
          if (e.target.value === 'manual' && !(r.account.id in input.manual)) input.manual[r.account.id] = r.forecast;
          dirty = true;
          paint();
        },
      },
      FORECAST_METHODS.map((m) => h('option', { value: m.id, text: m.id === 'auto' && r.method === 'auto' ? `おまかせ：${RESOLVED_LABELS[r.resolved]}${r.growth ? ` ${(r.growth / 10).toFixed(1)}%` : ''}` : m.label, selected: m.id === r.method })),
    );
    const manual =
      r.method === 'manual'
        ? h('input', {
            type: 'text',
            inputmode: 'numeric',
            class: 'advisor-manual',
            'aria-label': `${r.account.name}の残りの月の合計`,
            value: formatYen(input.manual[r.account.id] ?? 0),
            onchange: (e) => {
              const p = parseYen(e.target.value || '0', { allowZero: true, allowNegative: true });
              if (!p.ok) return put(errorsEl, errorBox([`${r.account.name}：${p.error}`]));
              put(errorsEl);
              input.manual[r.account.id] = p.value;
              dirty = true;
              paint();
            },
          })
        : null;
    // 立て方の選択は科目の行の下に、表の幅いっぱいで置く（スマホで切れないように）
    return [
      h(
        'tr',
        { class: 'advisor-row' },
        h('th', { scope: 'row' }, h('span', { class: 'advisor-account', text: r.account.name })),
        amountCell('td', r.actual),
        amountCell('td', r.forecast),
        amountCell('td', r.landing, { cls: 'strong' }),
        r.previous === null ? h('td', { class: 'num muted', text: '—' }) : amountCell('td', r.previous),
      ),
      h('tr', { class: 'advisor-method-row' }, h('td', { colspan: '5' }, h('div', { class: 'advisor-pick' }, pick, manual))),
    ];
  }

  async function save() {
    try {
      await app.db.saveForecast(period.id, cleanForecast(input));
      dirty = false;
      showToast('見込みの設定を保存しました');
      app.refresh();
    } catch (e) {
      put(errorsEl, errorBox(errorText(e)));
    }
  }

  paint();
  put(
    outlet,
    h('p', { class: 'muted small', text: `${settings.businessName}　${formatPeriod(period)}${previous ? `／前期 ${formatPeriod(previous.period)}` : ''}` }),
    body,
    errorsEl,
    h('button', { type: 'button', class: 'btn btn-primary btn-block', text: '見込みの設定を保存する', onclick: save }),
    h('a', { class: 'btn btn-block', href: '#/advisor/tax', text: '納税予測を見る' }),
    estimateNote(),
  );
  app.leaveGuard = async () =>
    !dirty ||
    (await confirmDialog({
      title: '見込みの設定を保存せずに離れますか？',
      buttons: [
        { label: '続ける', value: false },
        { label: '保存せずに離れる', value: true, variant: 'danger' },
      ],
    }));
}
