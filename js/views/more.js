// その他メニュー
import { h, put } from '../ui.js';
import { APP_VERSION } from '../version.js';
import { menuRow } from '../icons.js';

const GROUPS = [
  ['帳簿の設定', [
    ['#/settings', '事業者の設定', '事業者名・消費税・会計期間', 'settings', 'setting'],
    ['#/accounts', '勘定科目', '科目・補助科目の追加と編集', 'list', 'setting'],
    ['#/opening', '期首残高', '期首時点の資産・負債・純資産', 'flag', 'setting'],
  ]],
  ['決算', [
    ['#/closing', '決算・繰越', '期末の棚卸・減価償却・次の期間への繰越', 'closing', 'close'],
    ['#/assets', '固定資産台帳', '固定資産の登録と減価償却費の計算', 'asset', 'close'],
    ['#/periods', '会計期間', '表示する期間の切替・前期の変更の反映', 'calendar', 'close'],
  ]],
  ['データ', [['#/backup', 'バックアップ', '書き出し・復元・サンプルデータ（データはこの端末の中だけにあります）', 'backup', 'data']]],
];

export async function render({ outlet }) {
  put(outlet, 
    ...GROUPS.flatMap(([title, items]) => [
      h('h2', { class: 'menu-group-title', text: title }),
      h(
        'ul',
        { class: 'menu-group' },
        items.map(([href, label, sub, icon, tone]) => menuRow({ href, label, sub, icon, tone })),
      ),
    ]),
    h('p', { class: 'muted small center', text: `ポケット会計 バージョン ${APP_VERSION}` }),
  );
}
