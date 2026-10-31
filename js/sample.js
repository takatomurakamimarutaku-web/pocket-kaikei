// 動作確認用のサンプルデータ（純粋関数）。バックアップと同じ形のデータを作り、復元と同じ方法で読み込む
// 個人：小売・デザインの個人事業（課税事業者、2026年）。法人：製造業の会社（課税事業者、2026/4〜2027/3、製造原価を使う）
// 法人はほかに業種・規模・消費税の計算方法の違うサンプルがある（sample-corporations.js。一覧は SAMPLES）
// 期末の棚卸・減価償却・消費税の決算整理は入れていない（決算・繰越の画面で試すため）
import { findByRole } from './accounts.js';
import { createPeriod, createAsset, createSettings } from './models.js';
import { monthsInPeriod } from './period.js';
import { day, MONTH_END, book, finish } from './sample-kit.js';
import { CORPORATION_SAMPLE_BUILDERS } from './sample-corporations.js';

/**
 * 選べるサンプルの一覧（画面の並び順）。id は buildSample に渡す。individual・corporation は最初からある2つ
 * size：規模の目安、tax：消費税、summary：画面に出す説明
 */
export const SAMPLES = [
  { id: 'individual', entityType: 'individual', name: 'サンプル商店', industry: '小売・デザイン', size: '個人事業', tax: '課税（一般）', fiscal: '12月決算', summary: '家賃の家事按分、インボイスのない外注、中古の軽自動車（事業70%）、部門（デザイン・店舗）など' },
  { id: 'corporation', entityType: 'corporation', name: 'サンプル製作所株式会社', industry: '製造業', size: '中小（年商約4,000万円・従業員5名）', tax: '課税（一般）', fiscal: '3月決算', summary: '製造原価、工場の機械（定率法）、輸出売上、仕入の返品、税区分の誤りの例など' },
  { id: 'corp-retail', entityType: 'corporation', name: 'サンプルストア株式会社', industry: '小売業（雑貨・食品）', size: '小規模（年商約4,000万円・パート2名）', tax: '課税（簡易課税 第2種）', fiscal: '3月決算', summary: '現金とカードの売上、カード手数料（非課税）、軽減税率の食品、季節の売上の増減、借入金の返済、レジ過不足の誤りの例など' },
  { id: 'corp-construction', entityType: 'corporation', name: 'サンプル建設株式会社', industry: '建設業（工務店）', size: '中規模（年商約1.3億円・従業員6名）', tax: '課税（一般）', fiscal: '6月決算', summary: '完成工事高、着手金（未成工事受入金）、未成工事支出金、外注工事、ダンプ（前のソフトから帳簿価額を引き継ぎ）、借入金など' },
  { id: 'corp-it', entityType: 'corporation', name: 'サンプルシステム株式会社', industry: 'IT（受託開発・保守）', size: '一人社長（年商約900万円）', tax: '免税事業者', fiscal: '12月決算', summary: '設立2期目、役員借入金の返済、ソフトウェア（無形固定資産）、少額減価償却資産の特例のパソコンなど' },
  { id: 'corp-restaurant', entityType: 'corporation', name: 'サンプル食堂合同会社', industry: '飲食業（食堂）', size: '小規模（年商約1,300万円・パート2名）', tax: '課税（2割特例）', fiscal: '3月決算', summary: '店内飲食（10%）と持ち帰り（8%）、繰越利益剰余金がマイナス（欠損）、内装（前のソフトから引き継ぎ）、10万円未満の備品など' },
];

/** サンプルの事業所名（id → 名前） */
export const SAMPLE_NAMES = Object.fromEntries(SAMPLES.map((x) => [x.id, x.name]));

function individualSample(year) {
  // 部門：デザインの仕事と店舗の物販。家賃・通信費などは部門を付けない（共通）
  const { accounts, byName, subAccounts, subId, departments, journals, j } = book('individual', { subs: [['普通預金', 'みらい銀行'], ['売掛金', 'A社', { closingDay: 31, months: 1, payDay: 25 }], ['売掛金', 'B社', MONTH_END]], departmentNames: ['デザイン', '店舗'] });
  const period = createPeriod({ startDate: `${year}-01-01`, endDate: `${year}-12-31` });
  const ob = (name, amount, sub) => ({ accountId: byName[name].id, subAccountId: sub ? subId(name, sub) : null, amount });
  const assets = 50000 + 1200000 + 330000 + 150000;
  const liabilities = 220000;
  period.openingBalances = [ob('現金', 50000), ob('普通預金', 1200000, 'みらい銀行'), ob('売掛金', 220000, 'A社'), ob('売掛金', 110000, 'B社'), ob('商品', 150000), ob('買掛金', 220000), ob('元入金', assets - liabilities)];
  const bank = ['普通預金', null, null, 'みらい銀行'];
  const b = (amount, tax) => [bank[0], amount, tax, bank[3]];
  for (const [i, m] of monthsInPeriod(period).entries()) {
    const busy = [2, 6, 11].includes(i) ? 1.5 : 1; // 3・7・12月は売上が多い
    const a = Math.round(330000 * busy);
    j(period, day(m, 5), [['売掛金', a, null, 'A社']], [['売上高', a, null, null, 'デザイン']], `${Number(m.slice(5))}月分 デザイン料 A社`);
    j(period, day(m, 10), [['売掛金', 110000, null, 'B社']], [['売上高', 110000, null, null, 'デザイン']], `${Number(m.slice(5))}月分 デザイン料 B社`);
    j(period, day(m, 25), [b(i === 0 ? 220000 : 330000)], [['売掛金', i === 0 ? 220000 : 330000, null, 'A社']], 'A社 入金');
    j(period, day(m, 28), [b(110000)], [['売掛金', 110000, null, 'B社']], 'B社 入金');
    // 店頭の物販：雑貨（10%）と焼き菓子（軽減8%）
    j(period, day(m, 15), [['現金', 55000 + 21600]], [['売上高', 55000, 'sales_10', null, '店舗'], ['売上高', 21600, 'sales_8r', null, '店舗']], '店頭売上（雑貨・焼き菓子）');
    j(period, day(m, 8), [['仕入高', 44000, 'purchase_10', null, '店舗'], ['仕入高', 10800, 'purchase_8r', null, '店舗']], [['買掛金', 54800]], '商品仕入（雑貨・焼き菓子）');
    j(period, day(m, 30), [['買掛金', i === 0 ? 220000 : 54800]], [b(i === 0 ? 220000 : 54800)], '仕入代金の支払');
    // 家賃は自宅兼事務所：事業60%・私用40%
    j(period, day(m, 27), [['地代家賃', 66000], ['事業主貸', 44000, 'none']], [b(110000)], '家賃（事業60%）');
    j(period, day(m, 26), [['通信費', 8800], ['水道光熱費', 6600]], [b(15400)], '携帯・インターネット・電気');
    if (i % 2 === 0) j(period, day(m, 12), [['消耗品費', 5500], ['新聞図書費', 3300]], [['現金', 8800]], '文具・資料');
    if (i % 3 === 1) j(period, day(m, 18), [['旅費交通費', 4400], ['会議費', 2160, 'purchase_8r']], [['現金', 6560]], '打合せの交通費・飲み物');
    // インボイスのない外注（免税事業者のイラストレーター）：経過措置の対象
    if (i % 3 === 2) j(period, day(m, 20), [['外注工賃', 55000, 'purchase_10_ni', null, 'デザイン']], [b(55000)], 'イラスト制作（インボイスなし）');
    j(period, day(m, 25), [['事業主貸', 150000, 'none']], [b(150000)], '生活費');
  }
  const m = (n) => `${year}-${String(n).padStart(2, '0')}`;
  j(period, day(m(4), 3), [['損害保険料', 36000, 'purchase_exempt']], [b(36000)], '火災保険（非課税）');
  j(period, day(m(6), 20), [['広告宣伝費', 33000], ['支払手数料', 660]], [b(33660)], 'Web広告・振込手数料');
  j(period, day(m(8), 10), [['売上高', 11000, 'sales_return_10', null, 'デザイン']], [['売掛金', 11000, null, 'B社']], 'B社 値引き（修正対応）');
  j(period, day(m(9), 1), [b(30000)], [['事業主借', 30000, 'none']], '私用口座から入金');
  j(period, day(m(10), 15), [['租税公課', 12000, 'none']], [['現金', 12000]], '収入印紙・登録免許税');
  j(period, day(m(11), 5), [['接待交際費', 16500]], [['現金', 16500]], '取引先との会食');
  // 固定資産：パソコン（新品）と中古の軽自動車（事業70%）
  j(period, day(m(3), 10), [['工具器具備品', 264000]], [b(264000)], 'ノートパソコン');
  j(period, day(m(5), 20), [['車両運搬具', 660000]], [b(660000)], '中古の軽自動車');
  const assetsList = [
    createAsset({ name: 'ノートパソコン', category: 'tools', accountId: byName['工具器具備品'].id, acquiredOn: day(m(3), 10), startedOn: day(m(3), 12), cost: 264000, method: 'straight', usefulLife: 4, assetNo: 'A-001', location: '事務所' }),
    createAsset({ name: '中古の軽自動車', category: 'vehicle', accountId: byName['車両運搬具'].id, acquiredOn: day(m(5), 20), startedOn: day(m(5), 25), cost: 660000, method: 'straight', usefulLife: 2, businessRatio: 70, assetNo: 'A-002', memo: '新車登録から4年経過（中古の簡便法で2年）' }),
  ];
  finish(period, journals);
  return { settings: createSettings({ businessName: SAMPLE_NAMES.individual, entityType: 'individual', taxStatus: 'taxable' }), period, accounts, subAccounts, departments, journals, assets: assetsList };
}

function corporationSample(year) {
  const { accounts, byName, subAccounts, subId, journals, j } = book('corporation', { manufacturing: true, subs: [['普通預金', 'さくら銀行'], ['売掛金', '東和機工', MONTH_END], ['売掛金', '北斗精密', MONTH_END], ['買掛金', '中央金属', MONTH_END], ['役員報酬', '佐藤一郎'], ['地代家賃', '城南不動産'], ['地代家賃（製造）', '城南不動産']] });
  const period = createPeriod({ startDate: `${year}-04-01`, endDate: `${year + 1}-03-31` });
  const ob = (name, amount, sub) => ({ accountId: byName[name].id, subAccountId: sub ? subId(name, sub) : null, amount });
  const debit = 4000000 + 3080000 + 300000 + 200000 + 400000 + 50000;
  const credit = 660000 + 300000 + 3000000;
  period.openingBalances = [
    ob('現金', 50000),
    ob('普通預金', 4000000, 'さくら銀行'),
    ob('売掛金', 2200000, '東和機工'),
    ob('売掛金', 880000, '北斗精密'),
    ob('原材料', 300000),
    ob('仕掛品', 200000),
    ob('製品', 400000),
    ob('買掛金', 660000, '中央金属'),
    ob('未払法人税等', 300000),
    ob('資本金', 3000000),
    ob('繰越利益剰余金', debit - credit),
  ];
  const b = (amount, tax) => ['普通預金', amount, tax, 'さくら銀行'];
  for (const [i, m] of monthsInPeriod(period).entries()) {
    const label = `${Number(m.slice(5))}月分`;
    const s1 = [2200000, 2420000, 2640000][i % 3];
    j(period, day(m, 20), [['売掛金', s1, null, '東和機工']], [['売上高', s1]], `${label} 部品売上 東和機工`);
    j(period, day(m, 25), [['売掛金', 880000, null, '北斗精密']], [['売上高', 880000]], `${label} 部品売上 北斗精密`);
    const prev1 = i === 0 ? 2200000 : [2200000, 2420000, 2640000][(i - 1) % 3];
    j(period, day(m, 31), [b(prev1)], [['売掛金', prev1, null, '東和機工']], '東和機工 入金（前月分）');
    j(period, day(m, 31), [b(880000)], [['売掛金', 880000, null, '北斗精密']], '北斗精密 入金（前月分）');
    j(period, day(m, 10), [['材料仕入高', 550000]], [['買掛金', 550000, null, '中央金属']], `${label} 材料仕入 中央金属`);
    j(period, day(m, 31), [['買掛金', i === 0 ? 660000 : 550000, null, '中央金属']], [b(i === 0 ? 660000 : 550000)], '中央金属 支払（前月分）');
    j(period, day(m, 25), [['賃金', 600000], ['役員報酬', 400000, null, '佐藤一郎'], ['給料手当', 250000]], [b(1100000), ['預り金', 150000]], `${label} 給与（源泉・社会保険料控除後）`);
    j(period, day(m, 31), [['法定福利費（製造）', 90000], ['法定福利費', 95000], ['預り金', 150000]], [b(335000)], '社会保険料・源泉所得税の納付');
    j(period, day(m, 27), [['外注加工費', 220000]], [b(220000)], 'めっき加工（外注）');
    j(period, day(m, 26), [['電力費', 77000], ['水道光熱費（製造）', 11000], ['水道光熱費', 5500]], [b(93500)], '電気・水道');
    j(period, day(m, 27), [['地代家賃（製造）', 198000, null, '城南不動産'], ['地代家賃', 66000, null, '城南不動産']], [b(264000)], '工場・事務所の家賃');
    j(period, day(m, 15), [['消耗品費（製造）', 33000], ['通信費', 13200]], [b(46200)], '工具・刃物、電話・ネット');
    if (i % 2 === 1) j(period, day(m, 12), [['福利厚生費', 5400, 'purchase_8r'], ['会議費', 3300]], [['現金', 8700]], 'お茶・菓子（軽減8%）、打合せ');
    if (i % 3 === 0) {
      j(period, day(m, 1), [['現金', 40000]], [b(40000)], '小口現金の補充');
      j(period, day(m, 18), [['旅費交通費', 26400]], [['現金', 26400]], '営業の出張');
    }
  }
  const m = (y, n) => `${y}-${String(n).padStart(2, '0')}`;
  // 固定資産：工場の機械（製造経費に償却）と事務のパソコン
  j(period, day(m(year, 4), 15), [['機械装置', 1650000]], [b(1650000)], 'NC旋盤');
  j(period, day(m(year, 7), 1), [['工具器具備品', 198000]], [b(198000)], '事務用パソコン');
  j(period, day(m(year, 5), 31), [['未払法人税等', 300000]], [b(300000)], '前期の法人税等の納付');
  j(period, day(m(year, 6), 10), [['保険料（製造）', 120000, 'purchase_exempt'], ['保険料', 48000, 'purchase_exempt']], [b(168000)], '工場の火災保険・自動車保険');
  j(period, day(m(year, 9), 20), [['普通預金', 330000, null, 'さくら銀行']], [['売上高', 330000, 'sales_export']], '台湾向け部品の輸出（免税）');
  j(period, day(m(year, 10), 5), [['修繕費（製造）', 165000]], [b(165000)], '旋盤の修理');
  j(period, day(m(year, 11), 15), [['売上高', 55000, 'sales_return_10']], [['売掛金', 55000, null, '北斗精密']], '北斗精密 不良品の値引き');
  j(period, day(m(year, 12), 10), [['外注加工費', 110000, 'purchase_10_ni']], [b(110000)], '研磨加工（インボイスのない個人の外注先）');
  j(period, day(m(year + 1, 1), 20), [['買掛金', 22000, null, '中央金属']], [['材料仕入高', 22000, 'purchase_return_10']], '材料の返品 中央金属');
  j(period, day(m(year + 1, 2), 28), [b(1200, 'none')], [['受取利息', 1200]], '普通預金の利息（非課税）');
  // 税区分のチェックの確認用：雑費に売上の税区分（誤り）
  j(period, day(m(year + 1, 3), 5), [['雑費', 3300, 'sales_10']], [['現金', 3300]], '事務用品（税区分の誤りの例：チェック画面で確認）');
  const assets = [
    createAsset({ name: 'NC旋盤', category: 'machinery', accountId: byName['機械装置'].id, acquiredOn: day(m(year, 4), 15), startedOn: day(m(year, 4), 20), cost: 1650000, method: 'declining', usefulLife: 10, assetNo: 'M-001', location: '本社工場', expenseAccountId: byName['減価償却費（製造）'].id }),
    createAsset({ name: '事務用パソコン', category: 'tools', accountId: byName['工具器具備品'].id, acquiredOn: day(m(year, 7), 1), startedOn: day(m(year, 7), 1), cost: 198000, method: 'lump3', assetNo: 'T-001', location: '事務所' }),
  ];
  finish(period, journals);
  return { settings: createSettings({ businessName: SAMPLE_NAMES.corporation, entityType: 'corporation', taxStatus: 'taxable', manufacturing: true }), period, accounts, subAccounts, journals, assets };
}

/**
 * サンプルデータ（Repository.replaceAll に渡せる形。バックアップと同じ項目）
 * @param {string} id SAMPLES の id（'individual'・'corporation'・'corp-retail' など）
 * @param {{ year?: number }} opts year：個人は暦年、法人は期首の年（既定 2026）
 */
export function buildSample(id, { year = 2026 } = {}) {
  const more = CORPORATION_SAMPLE_BUILDERS[id];
  if (!more && id !== 'individual' && id !== 'corporation') throw new Error(`不明なサンプルです: ${id}`);
  const s = more ? more(year, SAMPLE_NAMES[id]) : id === 'corporation' ? corporationSample(year) : individualSample(year);
  if (!findByRole(s.accounts, 'cash')) throw new Error('サンプルの科目が不正です');
  return { settings: s.settings, currentPeriodId: s.period.id, accounts: s.accounts, subAccounts: s.subAccounts, departments: s.departments || [], periods: [s.period], journals: s.journals, assets: s.assets, tombstones: [] };
}
