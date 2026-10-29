// 入力メニュー：かんたん入力の種類・振替伝票・出納帳
import { h, put } from '../ui.js';
import { quickTemplatesFor } from '../quick.js';

export async function render({ app, outlet }) {
  const settings = await app.db.getSettings();
  const row = (href, label, sub, icon) =>
    h(
      'li',
      {},
      h('a', { class: 'menu-row', href }, h('span', { class: 'menu-icon', text: icon }), h('span', { class: 'menu-text' }, h('span', { class: 'menu-label', text: label }), h('span', { class: 'menu-sub', text: sub }))),
    );
  put(
    outlet,
    h('h2', { class: 'section-title', text: 'かんたん入力' }),
    h(
      'ul',
      { class: 'menu-group' },
      quickTemplatesFor(settings.entityType).map((t) => row(`#/quick/${t.id}`, t.label, t.desc, t.label.slice(0, 1))),
    ),
    h('h2', { class: 'section-title', text: 'そのほかの入力' }),
    h(
      'ul',
      { class: 'menu-group' },
      row('#/journal/new', '振替伝票で入力', '借方・貸方を自由に。複合仕訳もこちら', '伝'),
      row('#/cashbook', '現金出納帳・預金出納帳', '口座ごとの入金・出金と残高', '出'),
      row('#/import/bank', '銀行明細の取り込み', 'ネットバンキングのCSVから仕訳をまとめて作る', '銀'),
    ),
  );
}
