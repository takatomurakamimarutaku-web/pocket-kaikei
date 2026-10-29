// 会計期間：一覧・表示する期間の切替・前期の変更に合わせた期首残高の再計算
import { h, put, showToast } from '../ui.js';
import { formatPeriod, todayString } from '../period.js';
import { errorText } from '../errors.js';
import { periodContext } from './period-common.js';

export async function render({ app, outlet }) {
  const data = await app.load();
  const { period } = data;
  const ctx = await periodContext(app, data);
  const today = todayString();
  const item = (p) => {
    const current = p.id === period.id;
    const state = today < p.startDate ? '未来' : today > p.endDate ? '終了' : '進行中';
    return h(
      'li',
      { class: 'period-row' },
      h('div', { class: 'menu-text' }, h('span', { class: 'menu-label', text: formatPeriod(p) }), h('span', { class: 'menu-sub', text: state })),
      current
        ? h('span', { class: 'badge', text: '表示中' })
        : h('button', {
            type: 'button',
            class: 'btn btn-small',
            text: '表示する',
            onclick: async () => {
              await app.db.setCurrentPeriod(p.id);
              showToast(`${formatPeriod(p)} を表示します`);
              app.navigate('#/home');
            },
          }),
    );
  };
  put(
    outlet,
    ctx.stale
      ? h(
          'div',
          { class: 'notice' },
          h('span', { text: '繰越の後に前期の帳簿が変更されたため、この期間の期首残高が前期末の残高と合っていません。' }),
          h('button', {
            type: 'button',
            class: 'btn btn-small btn-primary',
            text: '前期末の残高で期首残高を更新',
            onclick: async () => {
              try {
                await ctx.recompute();
                showToast('期首残高を更新しました');
                app.refresh();
              } catch (e) {
                showToast(errorText(e, '更新'));
              }
            },
          }),
        )
      : null,
    h('ul', { class: 'menu-group period-list' }, [...ctx.periods].reverse().map(item)),
    h('p', { class: 'muted small', text: '帳簿を入力・集計するのは「表示中」の期間です。過去の期間に切り替えて修正することもできます。' }),
    ctx.next ? null : h('div', { class: 'actions' }, h('a', { href: '#/closing', class: 'btn btn-primary', text: '決算整理・次の期間への繰越' })),
  );
}
