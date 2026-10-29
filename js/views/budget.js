// 予算と実績（対比の表・売上のグラフ）と、予算の入力（科目ごとの年額・月別）
import { h, put, amountCell, field, showToast, errorBox, emptyState, confirmDialog } from '../ui.js';
import { budgetVsActual, monthlySales, isBudgetable, spreadAnnual, budgetTotal, budgetFromActuals } from '../budget.js';
import { hideZeroRows, formatPermille } from '../compare.js';
import { barLineChart } from '../chart.js';
import { compareAccounts, groupLabel } from '../accounts.js';
import { formatPeriod, monthsInPeriod } from '../period.js';
import { formatYen, parseYen } from '../money.js';
import { errorText } from '../errors.js';
import { monthRangePicker, zeroToggle, loadPrevious } from './report-common.js';

const monthLabel = (m) => `${Number(m.slice(5))}月`;
const shown = (v) => (v ? formatYen(v) : '');

export async function render(ctx) {
  return ctx.route.kind === 'edit' ? renderEdit(ctx) : renderReport(ctx);
}

async function renderReport({ app, outlet, query }) {
  const { settings, period, accounts, journals } = await app.load();
  const budgets = await app.db.listBudgets(period.id);
  const head = h('p', { class: 'muted small', text: `${settings.businessName}　${formatPeriod(period)}` });
  const editLink = h('a', { href: '#/budget', class: 'btn btn-block', text: budgets.length ? '予算を入力・修正する' : '予算を入力する' });
  if (!budgets.length) {
    return put(outlet, head, emptyState('予算はまだありません', h('p', { class: 'muted small', text: '科目ごとに年額か月別の予算を入れると、実績と比べて差異と達成率を出します。前期の帳簿があれば、その実績から作ることもできます。' })), editLink);
  }
  let showZero = false;
  const body = h('div');
  const zero = zeroToggle((v) => ((showZero = v), paint()));
  const picker = monthRangePicker({ period, query, path: '/reports/budget', onChange: () => paint() });
  const series = monthlySales({ accounts, period, journals, budgets });
  const chart = barLineChart({
    labels: series.map((s) => monthLabel(s.month)),
    bar: { label: '売上の実績', values: series.map((s) => s.actual) },
    line: { label: '売上の予算', values: series.map((s) => s.budget) },
    title: '売上の予算と実績',
  });
  const dash = () => h('td', { class: 'num muted', text: '—' });

  function paint() {
    const { fromMonth, toMonth } = picker.range();
    const res = budgetVsActual({ entityType: settings.entityType, accounts, period, journals, budgets, fromMonth, toMonth });
    const rows = showZero ? res.rows : hideZeroRows(res.rows.map((r) => ({ ...r, current: r.actual, previous: r.budget })));
    const sales = res.rows.find((r) => r.kind === 'total' && r.key.startsWith(`g:${res.actualPl.items[0].label}`));
    const profitRow = res.rows.filter((r) => r.kind === 'subtotal').at(-1);
    const kv = (label, budget, actual, achievement) =>
      h(
        'div',
        { class: 'budget-summary' },
        h('span', { class: 'muted small', text: label }),
        h('strong', { class: `num ${actual < 0 ? 'neg' : ''}`, text: `${formatYen(actual)}円` }),
        h('span', { class: 'muted small', text: `予算 ${formatYen(budget)}円・達成率 ${achievement == null ? '—' : formatPermille(achievement)}` }),
      );
    put(
      body,
      h('div', { class: 'panel budget-summaries' }, kv('売上の実績', sales?.budget ?? 0, sales?.actual ?? 0, sales?.achievement), kv(settings.entityType === 'individual' ? '所得（控除前）の実績' : `${profitRow?.label ?? '利益'}の実績`, profitRow?.budget ?? 0, profitRow?.actual ?? 0, profitRow?.achievement)),
      h(
        'div',
        { class: 'table-wrap' },
        h(
          'table',
          { class: 'report statement compare' },
          h('caption', { text: `予算と実績（${monthLabel(res.months[0])}〜${monthLabel(res.months.at(-1))}）` }),
          h('thead', {}, h('tr', {}, h('th', { text: '科目' }), h('th', { class: 'num', text: '予算' }), h('th', { class: 'num', text: '実績' }), h('th', { class: 'num', text: '差異（達成率）' }))),
          h(
            'tbody',
            {},
            rows.map((r) => {
              if (r.kind === 'group') return h('tr', { class: `st-group ${r.level === 2 ? 'level2' : ''}` }, h('th', { colspan: 4, text: r.label }));
              const cls = { subtotal: `st-subtotal ${r.strong ? 'strong' : ''} ${r.heading ? 'heading' : ''}`, total: 'st-total', note: 'st-note', line: 'st-line' }[r.kind];
              return h(
                'tr',
                { class: cls },
                h('th', { text: r.label }),
                r.budget == null ? dash() : amountCell('td', r.budget),
                amountCell('td', r.actual),
                r.diff == null ? dash() : h('td', { class: `num diff ${r.diff < 0 ? 'neg' : ''}` }, h('span', { text: formatYen(r.diff) }), h('span', { class: 'rate', text: r.achievement == null ? '—' : formatPermille(r.achievement) })),
              );
            }),
          ),
        ),
      ),
    );
  }
  put(
    outlet,
    head,
    chart,
    picker.el,
    zero.el,
    body,
    h('p', { class: 'muted small', text: '差異＝実績−予算、達成率＝実績÷予算。費用は達成率が100%を超えると予算オーバーです。' }),
    editLink,
  );
  paint();
}

async function renderEdit({ app, outlet }) {
  const { settings, period, accounts } = await app.load();
  const budgets = await app.db.listBudgets(period.id);
  const months = monthsInPeriod(period);
  const targets = accounts.filter(isBudgetable).sort(compareAccounts);
  // 科目ごとの月別の金額（編集中）
  const values = new Map(targets.map((a) => [a.id, { ...(budgets.find((b) => b.accountId === a.id)?.months || {}) }]));
  let dirty = false;
  const errorsEl = h('div');
  const rowEls = new Map();

  function rowFor(account) {
    const annual = h('input', {
      id: `bud-${account.id}`,
      type: 'text',
      inputmode: 'numeric',
      class: 'budget-input',
      'aria-label': `${account.name}の年間の予算`,
      value: shown(budgetTotal({ months: values.get(account.id) })),
      placeholder: '0',
      onchange: (e) => {
        const r = parseYen(e.target.value || '0', { allowZero: true });
        if (!r.ok) return put(errorsEl, errorBox([`${account.name}：${r.error}`]));
        put(errorsEl);
        values.set(account.id, r.value ? spreadAnnual(r.value, months) : {});
        dirty = true;
        paintMonths();
      },
    });
    const monthsEl = h('div', { class: 'budget-months', hidden: true });
    function paintMonths() {
      const v = values.get(account.id);
      put(
        monthsEl,
        months.map((m) =>
          h(
            'label',
            { class: 'budget-month' },
            h('span', { class: 'muted small', text: monthLabel(m) }),
            h('input', {
              type: 'text',
              inputmode: 'numeric',
              class: 'budget-input',
              'aria-label': `${account.name}の${monthLabel(m)}の予算`,
              value: shown(v[m]),
              placeholder: '0',
              onchange: (e) => {
                const r = parseYen(e.target.value || '0', { allowZero: true });
                if (!r.ok) return put(errorsEl, errorBox([`${account.name} ${monthLabel(m)}：${r.error}`]));
                put(errorsEl);
                v[m] = r.value;
                e.target.value = shown(r.value);
                dirty = true;
                annual.value = shown(budgetTotal({ months: v }));
              },
            }),
          ),
        ),
      );
      annual.value = shown(budgetTotal({ months: v }));
    }
    paintMonths();
    const toggle = h('button', {
      type: 'button',
      class: 'link small',
      text: '月別',
      'aria-expanded': 'false',
      onclick: () => {
        monthsEl.hidden = !monthsEl.hidden;
        toggle.setAttribute('aria-expanded', String(!monthsEl.hidden));
      },
    });
    const el = h('li', { class: 'budget-row' }, h('div', { class: 'budget-head' }, h('span', { class: 'budget-name', text: account.name }), annual, toggle), monthsEl);
    rowEls.set(account.id, { el, paintMonths });
    return el;
  }

  const groups = [...new Set(targets.map((a) => a.group))];
  const list = h(
    'div',
    {},
    groups.map((g) => [h('h2', { class: 'section-title', text: groupLabel(g, settings.entityType) }), h('ul', { class: 'budget-list panel' }, targets.filter((a) => a.group === g).map(rowFor))]),
  );

  // 前期の実績から作る
  const previous = await loadPrevious(app, period);
  const ratioInput = h('input', { id: 'bud-ratio', type: 'number', inputmode: 'numeric', min: 1, max: 999, value: 100, class: 'ratio-input' });
  const fromPrev = previous
    ? h(
        'section',
        { class: 'panel' },
        h('h2', { class: 'section-title', text: '前期の実績から作る' }),
        h('p', { class: 'muted small', text: `前期（${formatPeriod(previous.period)}）の同じ月の実績に割合を掛けて、すべての科目の予算を入れ直します。保存するまでは確定しません。` }),
        field('前期の実績に対する割合（%）', ratioInput),
        h('button', {
          type: 'button',
          class: 'btn btn-block',
          text: '前期の実績を入れる',
          onclick: async () => {
            const ratio = Number(ratioInput.value);
            if (!Number.isInteger(ratio) || ratio < 1 || ratio > 999) return put(errorsEl, errorBox(['割合は1〜999の整数で入れてください']));
            const ok = await confirmDialog({ title: '入力中の予算を入れ直しますか？', buttons: [{ label: 'やめる', value: false }, { label: '入れ直す', value: true, variant: 'primary' }] });
            if (!ok) return;
            const made = new Map(budgetFromActuals({ accounts, prevPeriod: previous.period, prevJournals: previous.journals, period, ratio }).map((e) => [e.accountId, e.months]));
            for (const a of targets) values.set(a.id, { ...(made.get(a.id) || {}) });
            for (const { paintMonths } of rowEls.values()) paintMonths();
            dirty = true;
            showToast('前期の実績を入れました。内容を確かめて保存してください');
          },
        }),
      )
    : null;

  const save = async () => {
    try {
      const entries = targets.map((a) => ({ accountId: a.id, months: values.get(a.id) }));
      const res = await app.db.saveBudgets(period.id, entries);
      dirty = false;
      app.leaveGuard = null;
      showToast(`予算を保存しました（${res.saved}科目）`);
      app.navigate('#/reports/budget');
    } catch (e) {
      put(errorsEl, errorBox(Array.isArray(e.errors) ? e.errors : [errorText(e, '保存')]));
    }
  };

  put(
    outlet,
    h('p', { class: 'muted small', text: `${formatPeriod(period)}　年額を入れると月に均等に割ります（端数は最後の月）。「月別」で月ごとに直せます。` }),
    fromPrev,
    list,
    errorsEl,
    h('button', { type: 'button', class: 'btn btn-primary btn-block', text: '予算を保存する', onclick: save }),
  );
  app.leaveGuard = async () =>
    !dirty ||
    (await confirmDialog({
      title: '入力中の予算を破棄しますか？',
      buttons: [
        { label: '入力を続ける', value: false },
        { label: '破棄する', value: true, variant: 'danger' },
      ],
    }));
}
