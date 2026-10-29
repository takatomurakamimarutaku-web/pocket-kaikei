// 定型仕訳：よく使う仕訳の呼び出しと、毎月の繰り返し仕訳のまとめて登録
import { h, put, field, showToast, errorBox, emptyState } from '../ui.js';
import { recurringStatus, journalFromTemplate, repeatLabel, templateAmount } from '../templates.js';
import { formatYen } from '../money.js';
import { monthsInPeriod, todayString } from '../period.js';
import { errorText } from '../errors.js';
import { closedNotice } from './period-common.js';
import { journalLabel, voucherOf } from '../journal.js';

export async function render({ app, outlet, query }) {
  const { period, journals, accountById } = await app.load();
  const templates = await app.db.listTemplates();
  const months = monthsInPeriod(period);
  const thisMonth = todayString().slice(0, 7);
  let month = months.includes(query.month) ? query.month : months.includes(thisMonth) ? thisMonth : months[0];

  const lineSummary = (t) => {
    const side = (s) => [...new Set(t.lines.filter((l) => l.side === s).map((l) => accountById.get(l.accountId)?.name ?? '（不明な科目）'))].join('・');
    return `${side('debit')} ／ ${side('credit')}`;
  };

  // ---- 毎月の仕訳を作る ----
  const recurringEl = h('div');
  const errorsEl = h('div');
  function paintRecurring() {
    const status = recurringStatus({ templates, journals, month, period });
    if (!status.length) {
      put(recurringEl, h('p', { class: 'muted small', text: '毎月作る定型仕訳はまだありません。定型仕訳の「毎月作る」で日を選ぶと、ここからまとめて登録できます。' }));
      return;
    }
    const checks = new Map();
    const items = status.map((s) => {
      const disabled = Boolean(s.done) || !s.inPeriod || period.closed;
      const box = h('input', { type: 'checkbox', checked: !disabled, disabled, 'aria-label': `${s.template.name}を登録する` });
      checks.set(s.template.id, box);
      return h(
        'li',
        { class: 'recurring-item' },
        h('label', { class: 'check' }, box, h('span', { class: 'recurring-name', text: s.template.name })),
        h('span', { class: 'muted small', text: `${s.date.replaceAll('-', '/')}・${formatYen(templateAmount(s.template))}円` }),
        s.done ? h('a', { href: `#/journal/${encodeURIComponent(s.done.id)}/edit`, class: 'link small', text: `登録済み ${journalLabel(s.done)}` }) : !s.inPeriod ? h('span', { class: 'muted small', text: '会計期間の外' }) : null,
      );
    });
    const create = async () => {
      const targets = status.filter((s) => checks.get(s.template.id)?.checked);
      if (!targets.length) return showToast('登録する仕訳を選んでください');
      try {
        const saved = await app.db.saveJournals(targets.map((s) => journalFromTemplate(s.template, { periodId: period.id, date: s.date })));
        showToast(`${saved.length}件の仕訳を登録しました（伝票No.${voucherOf(saved[0])}〜）`);
        app.refresh();
      } catch (e) {
        put(errorsEl, errorBox(Array.isArray(e.errors) ? e.errors : [errorText(e, '登録')]));
      }
    };
    put(
      recurringEl,
      h('ul', { class: 'recurring-list' }, items),
      errorsEl,
      h('button', { type: 'button', class: 'btn btn-primary btn-block', text: '選んだ仕訳を登録する', onclick: create, disabled: period.closed }),
    );
  }
  const monthSelect = h(
    'select',
    {
      id: 'tpl-month',
      onchange: (e) => {
        month = e.target.value;
        history.replaceState(history.state, '', `#/templates?month=${month}`);
        paintRecurring();
      },
    },
    months.map((m) => h('option', { value: m, text: `${m.slice(0, 4)}年${Number(m.slice(5))}月`, selected: m === month })),
  );

  put(
    outlet,
    closedNotice(period),
    h('section', { class: 'panel' }, h('h2', { class: 'section-title', text: '毎月の仕訳を作る' }), field('月', monthSelect), recurringEl),
    h('h2', { class: 'section-title', text: '定型仕訳' }),
    templates.length
      ? h(
          'ul',
          { class: 'template-list' },
          templates.map((t) =>
            h(
              'li',
              { class: 'template-item panel' },
              h('div', { class: 'template-head' }, h('strong', { text: t.name }), t.repeatDay ? h('span', { class: 'badge', text: repeatLabel(t.repeatDay) }) : null),
              h('p', { class: 'muted small', text: `${lineSummary(t)}　${templateAmount(t) ? `${formatYen(templateAmount(t))}円` : '金額は入力時'}` }),
              h(
                'div',
                { class: 'actions' },
                h('a', { href: `#/journal/new?template=${encodeURIComponent(t.id)}`, class: 'btn btn-small btn-primary', text: '使う' }),
                h('a', { href: `#/template/${encodeURIComponent(t.id)}`, class: 'btn btn-small', text: '編集' }),
              ),
            ),
          ),
        )
      : emptyState('定型仕訳はまだありません', h('p', { class: 'muted small', text: '仕訳の編集画面の「定型仕訳に登録」か、下のボタンから登録できます。' })),
    h('a', { href: '#/template/new', class: 'btn btn-block', text: '＋ 定型仕訳を追加' }),
  );
  paintRecurring();
}
