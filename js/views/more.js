// その他メニュー
import { h, put } from '../ui.js';
import { APP_VERSION } from '../version.js';

const GROUPS = [
  ['帳簿の設定', [
    ['#/settings', '事業者の設定', '事業者名・消費税・会計期間'],
    ['#/accounts', '勘定科目', '科目・補助科目の追加と編集'],
    ['#/opening', '期首残高', '期首時点の資産・負債・純資産'],
  ]],
  ['データ', [['#/backup', 'バックアップ', '書き出し・復元（データはこの端末の中だけにあります）']]],
];

export async function render({ outlet }) {
  put(outlet, 
    ...GROUPS.flatMap(([title, items]) => [
      h('h2', { class: 'menu-group-title', text: title }),
      h(
        'ul',
        { class: 'menu-group' },
        items.map(([href, label, sub]) =>
          h('li', {}, h('a', { class: 'menu-row', href }, h('span', { class: 'menu-icon', text: label.slice(0, 1) }), h('span', { class: 'menu-text' }, h('span', { class: 'menu-label', text: label }), h('span', { class: 'menu-sub', text: sub })))),
        ),
      ),
    ]),
    h('p', { class: 'muted small center', text: `ポケット会計 バージョン ${APP_VERSION}` }),
  );
}
