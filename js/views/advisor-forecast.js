// 着地見込み（決算予測）：実績の月＋残りの月の見込みで、期末の損益を予想する。科目ごとに見込みの立て方を選べる
import { h, put, amountCell, showToast, errorBox, confirmDialog } from '../ui.js';
import { formatYen, parseYen } from '../money.js';
import { GROUP_BY_ID, compareAccounts } from '../accounts.js';
import { buildStatements } from '../statements.js';
import { monthRange, formatPeriod, addMonths } from '../period.js';
import { forecastLanding, FORECAST_METHODS, RESOLVED_LABELS, cleanForecast } from '../advisor/forecast.js';
import { forecastTaxes } from '../advisor/tax-forecast.js';
import { seasonalAdvice, adviceSuggestsLastYear } from '../advisor/seasonality.js';
import { errorText } from '../errors.js';
import { loadAdvisor, estimateNote, monthLabel } from './advisor-common.js';

const clone = (o) => JSON.parse(JSON.stringify(o));
const sideOf = (account) => GROUP_BY_ID[account.group]?.side;

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
  const input = clone({ actualThrough: null, methods: {}, manual: {}, monthly: {}, ...(period.forecast || {}) });
  // 月ごとの表を開いている科目（描き直しても開いたままにする）
  const open = new Set();
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

    const isActual = new Set(landing.actualMonths);
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
      for (const r of rows) accountRows.push(...accountRow({ ...r, monthsOf: landing.months, actualSet: isActual, forecastMonthsCount: landing.forecastMonths.length }));
    }
    const table = h(
      'div',
      { class: 'table-wrap' },
      h('table', { class: 'report advisor-accounts', 'aria-label': '科目ごとの見込み' }, h('thead', {}, h('tr', {}, h('th', { text: '科目' }), h('th', { text: throughLabel }), h('th', { text: '見込み' }), h('th', { text: '着地' }), h('th', { text: '前期' }))), h('tbody', {}, accountRows)),
    );

    // ---- 月別の推移（売上と利益） ----
    const salesBy = landing.months.map((_, i) => landing.rows.filter((r) => r.account.group === 'sales').reduce((s, r) => s + r.monthly[i], 0));
    const profitBy = landing.months.map((_, i) => landing.rows.reduce((s, r) => s + (sideOf(r.account) === 'credit' ? r.monthly[i] : -r.monthly[i]), 0));
    let cum = 0;
    const monthTable = h(
      'div',
      { class: 'table-wrap' },
      h(
        'table',
        { class: 'report advisor-months-table', 'aria-label': '月別の売上と利益' },
        h('thead', {}, h('tr', {}, h('th', { text: '月' }), h('th', { text: '売上高' }), h('th', { text: entityType === 'corporation' ? '利益' : '所得' }), h('th', { text: '累計' }))),
        h(
          'tbody',
          {},
          landing.months.map((m, i) => {
            cum += profitBy[i];
            return h(
              'tr',
              { class: isActual.has(m) ? '' : 'is-plan' },
              h('th', { scope: 'row' }, monthLabel(m), isActual.has(m) ? null : h('span', { class: 'badge advisor-plan', text: '見込み' })),
              amountCell('td', salesBy[i]),
              amountCell('td', profitBy[i]),
              amountCell('td', cum),
            );
          }),
        ),
      ),
    );

    // ---- 季節変動・特別な支出の注意 ----
    const advice = seasonalAdvice({ landing });
    const rowById = new Map(landing.rows.map((r) => [r.account.id, r]));
    const adviceList = advice.map((a) => {
      const r = rowById.get(a.account.id);
      const missing = a.months.filter((x) => x.missing);
      return h(
        'li',
        { class: `advisor-advice ${a.missing ? 'is-missing' : ''}` },
        h('div', { class: 'advisor-advice-head' }, h('strong', { text: a.account.name }), h('span', { class: `badge ${a.missing ? 'badge-warn' : ''}`, text: a.kind === 'seasonal' ? '季節変動' : '特別な月' })),
        h('p', { class: 'small', text: a.message }),
        missing.length
          ? h('p', { class: 'small advisor-advice-warn', text: `いまの見込みには入っていません（${missing.map((x) => `${monthLabel(x.month)}の見込み ${formatYen(x.forecast)}円`).join('・')}）。` })
          : a.months.some((x) => !x.actual)
            ? h('p', { class: 'muted small', text: 'いまの見込みに入っています。' })
            : h('p', { class: 'muted small', text: 'その月は実績に入っています。' }),
        a.missing && r
          ? h(
              'div',
              { class: 'advisor-advice-actions' },
              adviceSuggestsLastYear(a, r) ? h('button', { type: 'button', class: 'btn btn-small', text: '前期の同じ月×伸び率で見込む', onclick: () => setMethod(r, 'last_year') }) : null,
              h('button', { type: 'button', class: 'btn btn-small', text: '月ごとに入れる', onclick: () => toMonthly(r, Object.fromEntries(missing.map((x) => [x.month, x.prev]))) }),
            )
          : null,
      );
    });

    put(
      body,
      h('div', { class: 'panel advisor-through' }, h('label', { class: 'field-label', text: '実績とみなす最後の月' }), select, h('p', { class: 'muted small', text: '記帳が終わった月までを実績にします。その後の月は、下の立て方で見込みます。' })),
      h('h2', { class: 'section-title', text: '着地の損益' }),
      summary,
      taxes.notes.filter((n) => /消費税等/.test(n)).map((n) => h('p', { class: 'muted small', text: n })),
      landing.depreciation.expected && !landing.depreciation.booked ? h('p', { class: 'muted small', text: `減価償却の仕訳がまだ無いため、固定資産台帳の当期の償却額 ${formatYen(landing.depreciation.expected)}円を期末に見込んでいます。` }) : null,
      landing.dropped ? h('p', { class: 'muted small', text: `見込みの月に入っている仕訳 ${landing.dropped}件（決算整理を除く）は着地に入れず、見込みの金額に置き換えています。実績にするときは「実績とみなす最後の月」を進めてください。` }) : null,
      landing.noCash ? h('p', { class: 'notice', text: '現金・預金の科目が無いため、見込みを計算できません。' }) : null,
      h('h2', { class: 'section-title', text: '月別の推移' }),
      monthTable,
      h('p', { class: 'muted small', text: `「見込み」の月は、下の科目ごとの見込みを足した金額です。${entityType === 'corporation' ? '利益は税引前当期純利益（法人税等を引く前）。' : '所得は青色申告特別控除の前。'}` }),
      landing.rows.some((r) => r.prevMonthly)
        ? [h('h2', { class: 'section-title', text: '季節変動・特別な支出の注意' }), advice.length ? h('ul', { class: 'plain-list advisor-advice-list' }, adviceList) : h('p', { class: 'muted small', text: '前期の推移には、目立った季節変動や特別な月はありませんでした。' }), h('p', { class: 'muted small', text: '前期の月ごとの金額から、ふだんの月の2倍以上の月（賞与・保険の年払いなど）と、売上の月ごとの差が大きい科目を挙げています。目安なので、内容は元帳で確かめてください。' })]
        : h('p', { class: 'muted small', text: '前期の帳簿があると、前期の推移から季節変動や賞与・年払いなどの特別な月を見つけて知らせます。' }),
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
          if (e.target.value === 'monthly') return toMonthly(r);
          setMethod(r, e.target.value);
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
    // 月ごとの表（実績の月は帳簿の金額、見込みの月は「月ごとに入れる」なら入力欄）
    const monthsBox = h(
      'details',
      {
        class: 'advisor-months',
        open: open.has(r.account.id),
        ontoggle: (e) => (e.target.open ? open.add(r.account.id) : open.delete(r.account.id)),
      },
      h('summary', { text: '月ごと' }),
      h(
        'div',
        { class: 'advisor-month-grid' },
        h('span', { class: 'muted small', text: '月' }),
        h('span', { class: 'muted small num', text: '当期' }),
        h('span', { class: 'muted small num', text: '前期' }),
        r.monthly.map((x, i) => {
          const m = r.monthsOf[i];
          const plan = !r.actualSet.has(m);
          const cell =
            plan && r.method === 'monthly'
              ? h('input', {
                  type: 'text',
                  inputmode: 'numeric',
                  class: 'advisor-month-input',
                  'aria-label': `${r.account.name}の${monthLabel(m)}の見込み`,
                  value: formatYen(input.monthly[r.account.id]?.[m] ?? 0),
                  onchange: (e) => {
                    const p = parseYen(e.target.value || '0', { allowZero: true, allowNegative: true });
                    if (!p.ok) return put(errorsEl, errorBox([`${r.account.name}の${monthLabel(m)}：${p.error}`]));
                    put(errorsEl);
                    input.monthly[r.account.id] = { ...(input.monthly[r.account.id] || {}), [m]: p.value };
                    dirty = true;
                    paint();
                  },
                })
              : h('span', { class: `num ${plan ? 'advisor-plan-num' : ''}`, text: formatYen(x) });
          return [h('span', { class: 'small' }, monthLabel(m), plan ? h('span', { class: 'muted', text: ' 見込み' }) : null), cell, h('span', { class: 'num muted small', text: r.prevMonthly ? formatYen(r.prevMonthly[i]) : '—' })];
        }),
      ),
      r.method !== 'monthly' && r.forecastMonthsCount ? h('button', { type: 'button', class: 'btn btn-small', text: 'この科目を月ごとに入れる', onclick: () => toMonthly(r) }) : null,
    );
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
      h('tr', { class: 'advisor-method-row' }, h('td', { colspan: '5' }, h('div', { class: 'advisor-pick' }, pick, manual), monthsBox)),
    ];
  }

  function setMethod(r, method) {
    input.methods[r.account.id] = method;
    if (method === 'manual' && !(r.account.id in input.manual)) input.manual[r.account.id] = r.forecast;
    dirty = true;
    paint();
  }

  /** 「月ごとに入れる」にする。いまの見込みの月別の金額を最初の値にし、patch の月は上書きする */
  function toMonthly(r, patch = {}) {
    input.methods[r.account.id] = 'monthly';
    input.monthly[r.account.id] = { ...(r.method === 'monthly' ? input.monthly[r.account.id] : r.forecastMonthly), ...patch };
    open.add(r.account.id);
    dirty = true;
    paint();
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
