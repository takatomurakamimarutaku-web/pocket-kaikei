// 会計期間：一覧・表示する期間の切替・前期の変更に合わせた期首残高の再計算
import { h, put, showToast, confirmDialog } from '../ui.js';
import { formatPeriod, todayString } from '../period.js';
import { errorText } from '../errors.js';
import { periodContext } from './period-common.js';
import { nextPeriod } from '../closing.js';

export async function render({ app, outlet }) {
  const data = await app.load();
  const { period } = data;
  const ctx = await periodContext(app, data);
  const today = todayString();
  const act = async (fn, done) => {
    try {
      await fn();
      showToast(done);
      app.refresh();
    } catch (e) {
      showToast(errorText(e, '変更'));
    }
  };
  const lockButton = (p) => {
    if (p.closed) {
      return h('button', {
        type: 'button',
        class: 'btn btn-small',
        text: '締めを解除',
        onclick: async () => {
          const ok = await confirmDialog({
            title: '締めを解除しますか？',
            message: 'この期間の仕訳を再び変更できるようになります。修正した後は、次の期間の期首残高を更新して、もう一度締めてください。',
            buttons: [
              { label: 'キャンセル', value: false },
              { label: '解除する', value: true, variant: 'danger' },
            ],
          });
          if (ok) act(() => app.db.reopenPeriod(p.id), '締めを解除しました');
        },
      });
    }
    if (!nextPeriod(ctx.periods, p)) return null;
    return h('button', {
      type: 'button',
      class: 'btn btn-small',
      text: '締める',
      onclick: async () => {
        const ok = await confirmDialog({
          title: `${formatPeriod(p)} を締めますか？`,
          message: '締めた期間は、仕訳・期首残高・期間の日付を変更できなくなります（表示はできます）。あとで解除することもできます。',
          buttons: [
            { label: 'キャンセル', value: false },
            { label: '締める', value: true, variant: 'primary' },
          ],
        });
        if (ok) act(() => app.db.closePeriod(p.id), '締めました');
      },
    });
  };
  const item = (p) => {
    const current = p.id === period.id;
    const state = p.closed ? '締め済み' : today < p.startDate ? '未来' : today > p.endDate ? '終了' : '進行中';
    return h(
      'li',
      { class: 'period-row' },
      h('div', { class: 'menu-text' }, h('span', { class: 'menu-label', text: formatPeriod(p) }), h('span', { class: `menu-sub ${p.closed ? 'is-closed' : ''}`, text: state })),
      h('div', { class: 'period-actions' }, lockButton(p), current
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
          })),
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
