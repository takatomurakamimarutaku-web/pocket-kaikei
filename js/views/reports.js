// 帳票メニュー
import { h, put } from '../ui.js';

const ITEMS = [
  ['#/reports/trial', '残高試算表', '繰越残高・借方・貸方・残高。CSV 出力'],
  ['#/reports/ledger', '総勘定元帳', '科目別・補助科目別の明細と残高の推移'],
  ['#/cashbook', '現金出納帳・預金出納帳', '口座ごとの入金・出金と残高'],
  ['#/reports/monthly', '月次推移表', '月ごとの損益・月末残高と売上・利益のグラフ'],
  ['#/reports/pl', '損益計算書', '売上から利益（所得）まで'],
  ['#/reports/bs', '貸借対照表', '期末の資産・負債・純資産'],
  ['#/reports/tax', '消費税集計', '税区分別の集計と割り戻しの参考値'],
  ['#/reports/tax-return', '消費税の申告計算', '一般・簡易・2割特例・3割特例で納める税額'],
];

export async function render({ outlet }) {
  put(outlet, 
    h(
      'ul',
      { class: 'menu-group' },
      ITEMS.map(([href, label, sub]) =>
        h(
          'li',
          {},
          h('a', { class: 'menu-row', href }, h('span', { class: 'menu-icon', text: label.slice(0, 1) }), h('span', { class: 'menu-text' }, h('span', { class: 'menu-label', text: label }), h('span', { class: 'menu-sub', text: sub }))),
        ),
      ),
    ),
  );
}
