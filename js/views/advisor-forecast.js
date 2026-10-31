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
import { ValidationError } from '../db.js';
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
  // 月別の見込みの表に前期を並べるか（画面を開いている間だけ）
  let showPrev = false;
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
    const shown = shownRows(landing);
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

    // ---- 月別の見込み（縦に科目・横に月）。見込みの月はマスで直接入れる ----
    const monthTable = monthGrid(landing, shownRows(landing));

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
      h('div', { class: 'card-title-row advisor-grid-head' }, h('h2', { class: 'section-title', text: '月別の見込み' }), h('label', { class: 'small advisor-prev-toggle' }, h('input', { type: 'checkbox', checked: showPrev, disabled: !landing.rows.some((r) => r.prevMonthly), onchange: (e) => { showPrev = e.target.checked; paint(); } }), ' 前期を並べる')),
      monthTable,
      h('p', { class: 'muted small', text: `色の付いた列が見込みの月です。マスに金額を入れると、その科目は「月ごとに入れる」になり、ほかの見込みの月は今の金額のまま残ります。${entityType === 'corporation' ? '利益は税引前当期純利益（法人税等を引く前）。' : '所得は青色申告特別控除の前。'}` }),
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

  /** 表に出す科目（金額か設定がある科目）を科目の順に */
  function shownRows(landing) {
    return landing.rows.filter((r) => r.actual || r.forecast || r.previous || r.budget || r.method !== 'auto').sort((a, b) => compareAccounts(a.account, b.account));
  }

  /** 見込みの月のマスに金額を入れる（その科目は「月ごとに入れる」にし、ほかの月は今の見込みを引き継ぐ） */
  function setCell(r, m, value) {
    if (r.method !== 'monthly') {
      input.methods[r.account.id] = 'monthly';
      input.monthly[r.account.id] = { ...r.forecastMonthly };
    }
    input.monthly[r.account.id] = { ...(input.monthly[r.account.id] || {}), [m]: value };
    dirty = true;
  }

  /** 月別の見込みの表：縦に科目（区分ごとの小計つき）、横に月・着地・前期。下に利益と累計 */
  function monthGrid(landing, rows) {
    const months = landing.months;
    const actual = new Set(landing.actualMonths);
    const sum = (list, i) => list.reduce((t, r) => t + r.monthly[i], 0);
    const head = h(
      'tr',
      {},
      h('th', { class: 'grid-account', text: '科目' }),
      months.map((m) => h('th', { class: actual.has(m) ? '' : 'is-plan' }, monthLabel(m), h('span', { class: 'grid-kind', text: actual.has(m) ? '実績' : '見込み' }))),
      h('th', { text: '着地' }),
      h('th', { text: '前期' }),
    );
    const body = [];
    const byGroup = new Map();
    for (const r of rows) {
      if (!byGroup.has(r.account.group)) byGroup.set(r.account.group, []);
      byGroup.get(r.account.group).push(r);
    }
    const prevTotal = (list) => (list.some((r) => r.previous !== null) ? list.reduce((t, r) => t + (r.previous || 0), 0) : null);
    const numCell = (v, cls = '') => (v === null ? h('td', { class: 'num muted', text: '—' }) : amountCell('td', v, { cls }));
    for (const [group, list] of byGroup) {
      body.push(h('tr', { class: 'fs-r-group' }, h('th', { class: 'grid-account', scope: 'rowgroup', text: GROUP_BY_ID[group]?.label || group }), h('td', { colspan: String(months.length + 2) })));
      for (const r of list) {
        body.push(
          h(
            'tr',
            {},
            h('th', { class: 'grid-account', scope: 'row', text: r.account.name }),
            months.map((m, i) => {
              if (actual.has(m)) return amountCell('td', r.monthly[i]);
              const key = `${r.account.id}:${m}`;
              return h(
                'td',
                { class: 'is-plan' },
                h('input', {
                  type: 'text',
                  inputmode: 'numeric',
                  class: 'grid-input',
                  'data-cell': key,
                  'aria-label': `${r.account.name}の${monthLabel(m)}の見込み`,
                  value: formatYen(r.forecastMonthly[m] || 0),
                  onchange: (e) => {
                    const p = parseYen(e.target.value || '0', { allowZero: true, allowNegative: true });
                    if (!p.ok) return put(errorsEl, errorBox([`${r.account.name}の${monthLabel(m)}：${p.error}`]));
                    put(errorsEl);
                    setCell(r, m, p.value);
                    // Tab で次のマスに移るのを待ってから描き直し、移った先のマスにフォーカスを戻す
                    setTimeout(() => {
                      const next = document.activeElement?.dataset?.cell;
                      paint();
                      if (next) outlet.querySelector(`[data-cell="${next}"]`)?.focus();
                    }, 0);
                  },
                }),
              );
            }),
            numCell(r.landing, 'strong'),
            numCell(r.previous),
          ),
        );
        if (showPrev && r.prevMonthly) body.push(h('tr', { class: 'grid-prev' }, h('th', { class: 'grid-account', scope: 'row', text: '前期' }), r.prevMonthly.map((x) => amountCell('td', x)), h('td', {}), h('td', {})));
      }
      body.push(h('tr', { class: 'grid-subtotal' }, h('th', { class: 'grid-account', scope: 'row', text: `${GROUP_BY_ID[group]?.label || group} 計` }), months.map((_, i) => amountCell('td', sum(list, i))), numCell(list.reduce((t, r) => t + r.landing, 0)), numCell(prevTotal(list))));
    }
    const profit = months.map((_, i) => rows.reduce((t, r) => t + (sideOf(r.account) === 'credit' ? r.monthly[i] : -r.monthly[i]), 0));
    let cum = 0;
    const cumulative = profit.map((x) => (cum += x));
    const profitWord = entityType === 'corporation' ? '利益（税引前）' : '所得（控除前）';
    const prevProfit = rows.some((r) => r.previous !== null) ? rows.reduce((t, r) => t + (sideOf(r.account) === 'credit' ? r.previous || 0 : -(r.previous || 0)), 0) : null;
    body.push(
      h('tr', { class: 'mt-strong' }, h('th', { class: 'grid-account', scope: 'row', text: profitWord }), profit.map((x) => amountCell('td', x)), numCell(cum), numCell(prevProfit)),
      h('tr', { class: 'grid-cum' }, h('th', { class: 'grid-account', scope: 'row', text: '累計' }), cumulative.map((x) => amountCell('td', x)), h('td', {}), h('td', {})),
    );
    return h('div', { class: 'table-wrap advisor-grid-wrap' }, h('table', { class: 'report advisor-grid', 'aria-label': '月別の見込み' }, h('thead', {}, head), h('tbody', {}, body)));
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
      put(errorsEl, errorBox(e instanceof ValidationError ? [].concat(Object.values(e.errors)) : [errorText(e, '保存')]));
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
