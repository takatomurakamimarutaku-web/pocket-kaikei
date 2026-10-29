// 帳票メニュー（帳簿・決算書・消費税・申告に分けて並べる）
import { hasRealEstate } from '../real-estate.js';
import { isWhite } from '../white-return.js';
import { h, put } from '../ui.js';
import { menuRow } from '../icons.js';

// [リンク, 名前, 説明, アイコン, 出す条件]
const GROUPS = [
  ['帳簿', 'report', [
    ['#/reports/trial', '残高試算表', '繰越残高・借方・貸方・残高。CSV 出力', 'trial'],
    ['#/reports/trial-monthly', '月次推移試算表', '科目ごとに月の数字を横に並べる。四半期・半期の合計、決算整理の列', 'grid'],
    ['#/reports/ledger', '総勘定元帳', '科目別・補助科目別の明細と残高の推移', 'ledger'],
    ['#/reports/sub-ledger', '補助元帳', '取引先・口座など補助科目ごとの明細と残高の一覧。まとめて印刷・CSV', 'ledger'],
    ['#/cashbook', '現金出納帳・預金出納帳', '口座ごとの入金・出金と残高', 'cashbook'],
    ['#/receivables', '売掛金・買掛金', '取引先ごとの残高・入金予定日・消込・滞留（年齢表）', 'receive'],
    ['#/assets', '固定資産台帳', '資産ごとの取得価額・償却費・期末帳簿価額。登録・売却・除却', 'asset'],
    ['#/reports/checks', '仕訳のチェック', '重複の可能性・残高のマイナス・逆残高・仮払金の残り・税区分', 'check'],
  ]],
  ['決算書・分析', 'close', [
    ['#/reports/financial', '決算書（計算書類）', '貸借対照表・損益計算書・販管費内訳・株主資本等変動計算書・個別注記表を1冊に', 'form', 'corporation'],
    ['#/reports/pl', '損益計算書', '売上から利益（所得）まで。前期との比較も', 'pl'],
    ['#/reports/bs', '貸借対照表', '期末の資産・負債・純資産。期首（前期末）との比較も', 'bs'],
    ['#/reports/cash-flow', 'キャッシュフロー計算書', '営業・投資・財務の資金の動き（間接法）', 'cashbook'],
    ['#/reports/cash-plan', '資金繰り表', '月ごとの収入・支出と残高。来月からは定型仕訳から予定を出す', 'calendar'],
    ['#/reports/budget', '予算と実績', '科目ごとの予算と実績の差異・達成率。前期の実績から予算を作れる', 'flag'],
    ['#/reports/departments', '部門別損益', '店舗・事業などの部門ごとの売上と利益。共通費の配賦も', 'dept'],
    ['#/reports/analysis', '経営分析', '利益率・流動比率・自己資本比率・回転期間・損益分岐点を前期と並べる', 'chart'],
    ['#/reports/manufacturing', '製造原価報告書', '材料費・労務費・製造経費から当期製品製造原価まで。月次推移も', 'factory', 'manufacturing'],
    ['#/reports/monthly', '月次推移表', '月ごとの損益・月末残高と売上・利益のグラフ', 'chart'],
  ]],
  ['消費税', 'tax', [
    ['#/reports/tax', '消費税集計', '税区分別・科目別税区分集計表・月別推移・税区分のチェック', 'tax'],
    ['#/reports/tax-return', '消費税の申告計算', '一般・簡易・2割特例・3割特例で納める税額', 'calc'],
  ]],
  ['申告', 'data', [
    ['#/reports/income-tax', '所得税の確定申告書', '第一表・第二表・医療費控除の明細書・添付書類の確認', 'calc', 'individual'],
    ['#/reports/blue-return', '青色申告決算書', '個人の決算書4ページの各欄（転記用）', 'form', 'business'],
    ['#/reports/blue-return-re', '青色申告決算書（不動産所得用）', '賃貸料・不動産経費から不動産所得まで。控除は不動産所得から先に', 'form', 'realEstate'],
    ['#/reports/white-return', '収支内訳書', '白色申告の一般用・不動産所得用の各欄。事業専従者控除の計算も', 'form', 'white'],
    ['#/reports/schedule16', '別表十六（減価償却の明細書）', '固定資産台帳から（一）定額法・（二）定率法・（七）少額・（八）一括償却の各欄', 'asset', 'corporation'],
    ['#/reports/breakdown', '勘定科目内訳明細書', '預貯金・売掛金・買掛金・借入金・役員給与・地代家賃など。補助科目ごと', 'list', 'corporation'],
    ['#/reports/enterprise-tax', '事業税', '法人：第六号様式の所得割・特別法人事業税／個人：個人事業税の見込み', 'calc'],
    ['#/reports/property-tax', '償却資産申告書', '固定資産台帳から種類別明細書と申告書の集計。評価額・税額の見込み', 'asset'],
  ]],
];

export async function render({ app, outlet }) {
  const { settings } = await app.load();
  const corp = settings.entityType === 'corporation';
  // 製造原価報告書は法人で「製造原価を使う」にしたときだけ、青色申告決算書は青色申告の個人だけ（一般用は不動産所得だけの人には出さない）、
  // 収支内訳書は白色申告の個人だけ出す
  const re = hasRealEstate(settings);
  const white = isWhite(settings);
  const show = (need) =>
    !need ||
    (need === 'manufacturing' && corp && settings.manufacturing) ||
    (need === 'individual' && !corp) ||
    (need === 'corporation' && corp) ||
    (need === 'business' && !corp && !white && settings.realEstate !== 'only') ||
    (need === 'realEstate' && re && !white) ||
    (need === 'white' && white);
  put(
    outlet,
    GROUPS.map(([title, tone, items]) => {
      const list = items.filter(([, , , , need]) => show(need));
      if (!list.length) return null;
      return [h('h2', { class: 'menu-group-title', text: title }), h('ul', { class: 'menu-group' }, list.map(([href, label, sub, icon]) => menuRow({ href, label, sub, icon, tone })))];
    }),
  );
}
