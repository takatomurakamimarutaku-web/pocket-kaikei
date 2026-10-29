// 入力メニュー：かんたん入力の種類・振替伝票・出納帳
import { h, put } from '../ui.js';
import { quickTemplatesFor } from '../quick.js';
import { menuRow, QUICK_ICONS } from '../icons.js';

export async function render({ app, outlet }) {
  const settings = await app.db.getSettings();
  const row = (href, label, sub, icon, tone = 'entry') => menuRow({ href, label, sub, icon, tone });
  put(
    outlet,
    h('h2', { class: 'section-title', text: 'かんたん入力' }),
    h(
      'ul',
      { class: 'menu-group' },
      quickTemplatesFor(settings.entityType).map((t) => row(`#/quick/${t.id}`, t.label, t.desc, QUICK_ICONS[t.id] ?? 'journal')),
    ),
    h('h2', { class: 'section-title', text: 'そのほかの入力' }),
    h(
      'ul',
      { class: 'menu-group' },
      row('#/journal/new', '振替伝票で入力', '借方・貸方を自由に。複合仕訳もこちら', 'journal', 'report'),
      row('#/invoices', '請求書・見積書', '適格請求書（インボイス）の作成と印刷・PDF。発行すると売掛金を計上', 'invoice', 'entry'),
      row('#/templates', '定型仕訳・毎月の仕訳', 'よく使う仕訳の呼び出し。家賃・給与などを毎月まとめて登録', 'list', 'report'),
      row('#/cashbook', '現金出納帳・預金出納帳', '口座ごとの入金・出金と残高', 'cashbook', 'report'),
      row('#/import/bank', '銀行明細の取り込み', 'ネットバンキングのCSVから仕訳をまとめて作る', 'bank', 'data'),
      row('#/import/card', 'クレジットカード明細の取り込み', '利用明細のCSVから未払金の仕訳をまとめて作る', 'expense', 'data'),
      row('#/transfer', 'ほかの会計ソフトの仕訳の取り込み', '弥生会計・freee・マネーフォワードの仕訳のCSVから', 'transfer', 'data'),
      row('#/assets', '固定資産台帳', 'パソコン・車・設備などの登録と減価償却費の計算', 'asset', 'close'),
      row('#/attachments', '証憑の一覧', '添付した領収書・請求書を日付・金額・取引先で探す', 'attach', 'data'),
    ),
  );
}
