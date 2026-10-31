// 個人のサンプル（業種・申告の種類・消費税の計算方法の違い）。sample.js の個人のサンプルと同じ作り方（sample-kit.js の assemble の spec）
// - ITフリーランス：青色申告、インボイス登録で課税事業者（2割特例）。自宅兼事務所の家事按分、少額減価償却資産の特例
// - 居酒屋：青色申告、簡易課税 第4種。青色事業専従者給与（家族）、パート、借入金、食材・酒類の在庫
// - アパート経営：不動産所得だけ（青色申告・事業的規模でない）、免税事業者。住宅の家賃（非課税）と駐車場（課税）、建物・土地、借入金の利子
// - 軽貨物の配達：白色申告、免税事業者。車両（事業90%）、ガソリン代の私用分
import { createAsset } from './models.js';
import { day, MONTH_END } from './sample-kit.js';
import { taxReturn, cardFee, season } from './sample-corporations.js';

const CALENDAR = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12];
const dates = (year) => ({ startDate: `${year}-01-01`, endDate: `${year}-12-31` });
/** 最初の期の n 年前の日付（'2024-01-01' と 5・'01-10' → '2019-01-10'） */
const yearsBefore = (firstStart, years, monthDay) => `${Number(firstStart.slice(0, 4)) - years}-${monthDay}`;

/** 前年分の消費税等（決算で未払金にした分）の納付。個人の確定申告の期限（3月末） */
function payConsumptionTax(j, period, mon, open, b) {
  const due = open('未払金');
  if (due > 0) j(period, day(mon(3), 31), [['未払金', due]], [b(due)], '前年分の消費税等の納付');
}

const FREELANCE = {
  entityType: 'individual',
  settings: { taxStatus: 'taxable' },
  book: { subs: [['普通預金', 'ネット銀行'], ['売掛金', 'テックス株式会社', MONTH_END]] },
  dates,
  taxReturn: taxReturn('twenty', 5, 8800000),
  opening: (ob) => [ob('普通預金', 2000000, 'ネット銀行'), ob('売掛金', 770000, 'テックス株式会社')],
  year({ j, byName }, { period, first, last, mon, open, g, assets }) {
    const b = (amount, tax) => ['普通預金', amount, tax, 'ネット銀行'];
    let prev = open('売掛金', 'テックス株式会社');
    for (const [i, m] of CALENDAR.map(mon).entries()) {
      const label = `${Number(m.slice(5))}月分`;
      const fee = g(770000);
      j(period, day(m, 31), [['売掛金', fee, null, 'テックス株式会社']], [['売上高', fee]], `${label} システム開発の業務委託 テックス株式会社`);
      if (prev) j(period, day(m, 31), [b(prev)], [['売掛金', prev, null, 'テックス株式会社']], 'テックス株式会社 入金（前月分）');
      prev = fee;
      // 自宅兼事務所：家賃は事業30%、通信費は50%、電気代は20%（残りは事業主貸）
      j(period, day(m, 27), [['地代家賃', 45000], ['事業主貸', 105000, 'none']], [b(150000)], '自宅の家賃（事業30%）');
      j(period, day(m, 26), [['通信費', 6600], ['水道光熱費', 4400], ['事業主貸', 24200, 'none']], [b(35200)], 'スマホ・光回線（事業50%）、電気代（事業20%）');
      j(period, day(m, 10), [['地代家賃', 11000], ['新聞図書費', 6600]], [b(17600)], 'コワーキングスペース・技術書');
      if (i % 3 === 1) j(period, day(m, 18), [['旅費交通費', 15400], ['会議費', 3300]], [b(18700)], '客先への出張・打合せ');
      j(period, day(m, 25), [['事業主貸', 360000, 'none']], [b(360000)], '生活費・国民年金・国民健康保険');
    }
    payConsumptionTax(j, period, mon, open, b);
    j(period, day(mon(3), 15), [['事業主貸', 300000, 'none']], [b(300000)], '前年分の所得税の納付（私用）');
    j(period, day(mon(6), 20), [['支払手数料', 13200]], [b(13200)], 'クラウドの利用料（年払い）');
    j(period, day(mon(9), 5), [['広告宣伝費', 22000]], [b(22000)], 'ポートフォリオサイトのドメイン・サーバー');
    // インボイスのない仕入（海外のサービスではなく、個人のデザイナーへの外注）
    if (last) j(period, day(mon(11), 20), [['外注工賃', 55000, 'purchase_10_ni']], [b(55000)], 'アイコン制作の外注（インボイスなし）');
    if (!first) return;
    j(period, day(mon(4), 10), [['工具器具備品', 297000]], [b(297000)], '開発用ノートパソコン');
    assets.push(createAsset({ name: '開発用ノートパソコン', category: 'tools', accountId: byName['工具器具備品'].id, acquiredOn: day(mon(4), 10), startedOn: day(mon(4), 12), cost: 297000, method: 'sme', businessRatio: 80, assetNo: 'A-001', location: '自宅', memo: '私用にも使うので事業80%' }));
  },
};

const IZAKAYA = {
  entityType: 'individual',
  settings: { taxStatus: 'taxable' },
  book: { subs: [['普通預金', 'みどり信金'], ['売掛金', 'カード会社', { closingDay: 31, months: 1, payDay: 15 }], ['買掛金', '青果の丸八', MONTH_END], ['買掛金', '酒のやまだ', MONTH_END], ['専従者給与', '妻 さくら'], ['借入金', 'みどり信金']] },
  dates,
  taxReturn: taxReturn('simplified', 4, 15800000),
  opening: (ob) => [
    ob('現金', 200000),
    ob('普通預金', 1500000, 'みどり信金'),
    ob('売掛金', 400000, 'カード会社'),
    ob('商品', 250000),
    ob('買掛金', 324000, '青果の丸八'),
    ob('買掛金', 220000, '酒のやまだ'),
    ob('借入金', 1800000, 'みどり信金'),
  ],
  inventory: () => ({ goods: 280000 }),
  year({ j, byName }, { period, first, mon, open, g, assets }) {
    const b = (amount, tax) => ['普通預金', amount, tax, 'みどり信金'];
    let prevCard = open('売掛金', 'カード会社');
    let prevCash = Math.max(0, open('現金') - 200000);
    let prevFood = open('買掛金', '青果の丸八');
    let prevDrink = open('買掛金', '酒のやまだ');
    for (const m of CALENDAR.map(mon)) {
      const label = `${Number(m.slice(5))}月分`;
      // 店内の飲食（10%）。現金が7割・カードが3割。12月・3月は宴会で多い
      const cash = g(season(1100000, m));
      const card = g(season(440000, m));
      j(period, day(m, 31), [['現金', cash]], [['売上高', cash, 'sales_10']], `${label} 売上（現金）`);
      j(period, day(m, 31), [['売掛金', card, null, 'カード会社']], [['売上高', card, 'sales_10']], `${label} 売上（カード）`);
      const fee = cardFee(prevCard);
      if (prevCard) j(period, day(m, 15), [b(prevCard - fee), ['支払手数料', fee, 'purchase_exempt']], [['売掛金', prevCard, null, 'カード会社']], 'カード会社 入金（前月分・手数料3.24%）');
      prevCard = card;
      if (prevCash) j(period, day(m, 2), [b(prevCash - 30000)], [['現金', prevCash - 30000]], '売上金の預け入れ（前月分）');
      prevCash = cash;
      // 食材（軽減8%）と酒類（10%）は掛けで仕入れ、翌月末に払う
      const food = g(season(324000, m));
      const drink = g(season(220000, m));
      j(period, day(m, 20), [['仕入高', food, 'purchase_8r']], [['買掛金', food, null, '青果の丸八']], `${label} 食材の仕入 青果の丸八`);
      j(period, day(m, 22), [['仕入高', drink, 'purchase_10']], [['買掛金', drink, null, '酒のやまだ']], `${label} 酒類の仕入 酒のやまだ`);
      j(period, day(m, 31), [['買掛金', prevFood, null, '青果の丸八'], ['買掛金', prevDrink, null, '酒のやまだ']], [b(prevFood + prevDrink)], '仕入代金の支払（前月分）');
      prevFood = food;
      prevDrink = drink;
      j(period, day(m, 25), [['専従者給与', 150000, null, '妻 さくら'], ['給料賃金', 180000]], [b(330000)], `${label} 給与（妻・パート2名）`);
      j(period, day(m, 27), [['地代家賃', 198000]], [b(198000)], '店舗の家賃');
      j(period, day(m, 26), [['水道光熱費', 66000]], [b(66000)], 'ガス・電気・水道');
      j(period, day(m, 6), [['消耗品費', 22000]], [['現金', 22000]], 'おしぼり・洗剤・割り箸');
      j(period, day(m, 20), [['借入金', 50000, null, 'みどり信金'], ['利子割引料', 5000]], [b(55000)], '借入金の返済（元金・利息）');
      j(period, day(m, 28), [['事業主貸', 180000, 'none']], [b(180000)], '生活費');
    }
    payConsumptionTax(j, period, mon, open, b);
    j(period, day(mon(5), 10), [['損害保険料', 54000, 'purchase_exempt']], [b(54000)], '店舗の火災保険（非課税）');
    j(period, day(mon(8), 25), [['修繕費', 66000]], [b(66000)], '換気扇の修理');
    j(period, day(mon(10), 15), [['租税公課', 30000, 'none']], [['現金', 30000]], '食品衛生責任者の講習・印紙');
    if (!first) return;
    j(period, day(mon(2), 10), [['工具器具備品', 450000]], [b(450000)], '業務用冷蔵庫');
    assets.push(createAsset({ name: '業務用冷蔵庫', category: 'tools', accountId: byName['工具器具備品'].id, acquiredOn: day(mon(2), 10), startedOn: day(mon(2), 12), cost: 450000, method: 'straight', usefulLife: 6, assetNo: 'A-001', location: '厨房' }));
  },
};

// アパート（木造・定額法22年、最初の期の5年前の1月に取得）：5年分を償却した帳簿価額を引き継ぐ
const BUILDING_COST = 40000000;
const BUILDING_BOOK = BUILDING_COST - 1840000 * 5;
const LAND = 20000000;

const APARTMENT = {
  entityType: 'individual',
  settings: { taxStatus: 'exempt', realEstate: 'only' },
  book: { realEstate: true, subs: [['普通預金', 'ふれあい銀行'], ['借入金', 'ふれあい銀行']] },
  dates,
  opening: (ob) => [ob('普通預金', 3000000, 'ふれあい銀行'), ob('建物', BUILDING_BOOK), ob('土地', LAND), ob('借入金', 30000000, 'ふれあい銀行'), ob('預り敷金・保証金', 520000)],
  year({ j, byName }, { period, first, firstStart, mon, g, assets }) {
    const b = (amount, tax) => ['普通預金', amount, tax, 'ふれあい銀行'];
    for (const [i, m] of CALENDAR.map(mon).entries()) {
      const label = `${Number(m.slice(5))}月分`;
      // 8室の家賃（住宅：非課税）と駐車場4台（課税）。管理会社が5%の管理料を差し引いて送金する
      const rent = g(520000);
      const parking = 44000;
      const fee = Math.floor(((rent + parking) * 5) / 100) + Math.floor(((rent + parking) * 5 * 10) / 1000);
      j(period, day(m, 28), [b(rent + parking - fee), ['管理費（不動産）', fee]], [['賃貸料', rent, 'sales_exempt'], ['賃貸料', parking, 'sales_10']], `${label} 家賃・駐車場代（管理料を差し引いて入金）`);
      j(period, day(m, 26), [['借入金', 100000, null, 'ふれあい銀行'], ['借入金利子（不動産）', 30000]], [b(130000)], 'アパートローンの返済（元金・利息）');
      j(period, day(m, 27), [['事業主貸', 250000, 'none']], [b(250000)], '生活費');
      if ([3, 9].includes(i)) j(period, day(m, 15), [b(65000)], [['礼金・権利金・更新料', 65000, 'sales_exempt']], '更新料（住宅）');
    }
    for (const n of [4, 7, 12, 2]) j(period, day(mon(n), 30), [['租税公課（不動産）', 120000, 'none']], [b(120000)], '固定資産税・都市計画税');
    j(period, day(mon(5), 10), [['損害保険料（不動産）', 80000, 'purchase_exempt']], [b(80000)], 'アパートの火災保険（非課税）');
    j(period, day(mon(6), 20), [['修繕費（不動産）', 110000]], [b(110000)], '退去後の原状回復');
    j(period, day(mon(11), 20), [['修繕費（不動産）', 110000]], [b(110000)], '共用部の照明の交換');
    j(period, day(mon(3), 15), [['事業主貸', 200000, 'none']], [b(200000)], '前年分の所得税の納付（私用）');
    if (!first) return;
    assets.push(
      createAsset({ name: 'アパート（木造2階建て・8室）', category: 'building', accountId: byName['建物'].id, acquiredOn: yearsBefore(firstStart, 5, '01-05'), startedOn: yearsBefore(firstStart, 5, '01-10'), cost: BUILDING_COST, method: 'straight', usefulLife: 22, carryOn: firstStart, carryBook: BUILDING_BOOK, assetNo: 'R-001', location: 'サンプル町1-2-3', structure: '木造', detail: '住宅用', expenseAccountId: byName['減価償却費（不動産）'].id, memo: '前の会計ソフトの帳簿価額を引き継ぎ' }),
      createAsset({ name: 'アパートの土地', category: 'land', accountId: byName['土地'].id, acquiredOn: yearsBefore(firstStart, 5, '01-05'), startedOn: yearsBefore(firstStart, 5, '01-10'), cost: LAND, method: 'none', assetNo: 'R-002', location: 'サンプル町1-2-3' }),
    );
  },
};

const DELIVERY = {
  entityType: 'individual',
  settings: { taxStatus: 'exempt', filing: 'white' },
  book: { subs: [['普通預金', 'ゆうちょ銀行'], ['売掛金', 'はやて物流', MONTH_END]] },
  dates,
  opening: (ob) => [ob('現金', 30000), ob('普通預金', 1800000, 'ゆうちょ銀行'), ob('売掛金', 450000, 'はやて物流')],
  year({ j, byName }, { period, first, mon, open, g, assets }) {
    const b = (amount, tax) => ['普通預金', amount, tax, 'ゆうちょ銀行'];
    let prev = open('売掛金', 'はやて物流');
    for (const [i, m] of CALENDAR.map(mon).entries()) {
      const label = `${Number(m.slice(5))}月分`;
      const fee = g(season(450000, m));
      j(period, day(m, 31), [['売掛金', fee, null, 'はやて物流']], [['売上高', fee]], `${label} 配達料 はやて物流`);
      if (prev) j(period, day(m, 31), [b(prev)], [['売掛金', prev, null, 'はやて物流']], 'はやて物流 入金（前月分）');
      prev = fee;
      // ガソリン代：休日の私用分（1割）は事業主貸
      j(period, day(m, 20), [['車両費', 39600], ['事業主貸', 4400, 'none']], [b(44000)], 'ガソリン代（事業90%）');
      j(period, day(m, 26), [['通信費', 8800]], [b(8800)], 'スマホ（配達アプリ）');
      if (i % 2 === 0) j(period, day(m, 12), [['消耗品費', 5500]], [b(5500)], '軍手・台車の部品（カード払い）');
      j(period, day(m, 28), [['事業主貸', 250000, 'none']], [b(250000)], '生活費');
    }
    j(period, day(mon(5), 31), [['租税公課', 10800, 'none']], [b(10800)], '軽自動車税');
    j(period, day(mon(7), 10), [['損害保険料', 120000, 'purchase_exempt']], [b(120000)], '任意保険（非課税）');
    j(period, day(mon(10), 15), [['修繕費', 88000]], [b(88000)], '車検・タイヤ交換');
    if (!first) return;
    j(period, day(mon(2), 5), [['車両運搬具', 1320000]], [b(1320000)], '軽バン（新車）');
    assets.push(createAsset({ name: '軽バン', category: 'vehicle', accountId: byName['車両運搬具'].id, acquiredOn: day(mon(2), 5), startedOn: day(mon(2), 10), cost: 1320000, method: 'straight', usefulLife: 4, businessRatio: 90, assetNo: 'A-001', memo: '休日の私用分を除いて事業90%' }));
  },
};

/** 個人のサンプル（小売・デザインは sample.js）。id → assemble の spec */
export const INDIVIDUAL_SPECS = {
  'ind-freelance': FREELANCE,
  'ind-izakaya': IZAKAYA,
  'ind-apartment': APARTMENT,
  'ind-delivery': DELIVERY,
};
