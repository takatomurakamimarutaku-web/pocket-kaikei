// 法人のサンプル（業種・規模・消費税の計算方法の違い）。sample.js の製造業のサンプルと同じ形の作り方（sample-kit.js の assemble の spec）
// - 小売業：雑貨・食品の店（小規模、簡易課税 第2種、3月決算）
// - 建設業：工務店（中規模、一般課税、6月決算）。完成工事高・未成工事支出金・未成工事受入金
// - IT：受託開発の一人社長の会社（小規模、免税事業者、12月決算）
// - 飲食業：食堂の合同会社（小規模、2割特例、3月決算）。繰越利益剰余金がマイナス（欠損）
// クレジットカードの加盟店手数料は非課税（金銭債権の譲受けの対価）として purchase_exempt にしている
//   出典：国税庁 質疑応答事例「クレジット手数料」https://www.nta.go.jp/law/shitsugi/shohi/06/02.htm
import { createAsset } from './models.js';
import { day, MONTH_END } from './sample-kit.js';

/** 消費税の申告計算の設定（会計期間の taxReturn。Repository.saveTaxReturnSettings と同じ項目） */
export function taxReturn(method, businessType, baseSales) {
  return { method, businessType, allocation: 'proportional', interimNational: 0, interimLocal: 0, baseSales, salesCalc: 'gross', purchaseCalc: 'gross', salesRounding: 'floor', purchaseRounding: 'floor' };
}

/** カードの加盟店手数料（3.24%、円未満切捨て） */
export const cardFee = (amount) => Math.floor((amount * 324) / 10000);

/** 千円単位に丸めた季節の増減（3月・12月は多め、8月は少なめ） */
export const season = (amount, month) => Math.round((amount * ({ '12': 1.3, '03': 1.1, '08': 0.9 }[month.slice(5)] ?? 1)) / 1000) * 1000;

/** 期首の年をずらした日付（'2026-07-01' と -2 → '2024-08-01' のように月日を指定） */
const yearsBefore = (firstStart, years, monthDay) => `${Number(firstStart.slice(0, 4)) - years}-${monthDay}`;

/** 前期の法人税等・消費税等（期首の未払）の納付 */
function payTaxes(j, period, date, open, b) {
  const lines = [['未払法人税等', open('未払法人税等')], ['未払消費税等', open('未払消費税等')]].filter((x) => x[1] > 0);
  const total = lines.reduce((s, x) => s + x[1], 0);
  if (total) j(period, date, lines, [b(total)], '前期の法人税等・消費税等の納付');
}

const APRIL = [4, 5, 6, 7, 8, 9, 10, 11, 12, 1, 2, 3];

const RETAIL = {
  entityType: 'corporation',
  settings: { taxStatus: 'taxable' },
  book: { subs: [['普通預金', 'ひかり銀行'], ['売掛金', 'カード会社', { closingDay: 31, months: 1, payDay: 15 }], ['買掛金', '丸山商事', MONTH_END], ['買掛金', '北の食品', MONTH_END], ['役員報酬', '鈴木花子'], ['長期借入金', 'ひかり銀行']] },
  dates: (year) => ({ startDate: `${year}-04-01`, endDate: `${year + 1}-03-31` }),
  taxReturn: taxReturn('simplified', 2, 34500000),
  opening: (ob) => [
    ob('現金', 300000),
    ob('普通預金', 5000000, 'ひかり銀行'),
    ob('売掛金', 1900000, 'カード会社'),
    ob('商品', 1800000),
    ob('敷金', 600000),
    ob('買掛金', 1100000, '丸山商事'),
    ob('買掛金', 1100000, '北の食品'),
    ob('未払法人税等', 250000),
    ob('未払消費税等', 600000),
    ob('長期借入金', 2400000, 'ひかり銀行'),
    ob('資本金', 3000000),
  ],
  inventory: ({ k }) => ({ goods: 1800000 + 50000 * (k + 1) }),
  year({ j, byName }, { period, first, last, mon, open, g, assets }) {
    const b = (amount, tax) => ['普通預金', amount, tax, 'ひかり銀行'];
    let prevCard = open('売掛金', 'カード会社');
    let prevCash = Math.max(0, open('現金') - 300000);
    let prevGoods = [open('買掛金', '丸山商事'), open('買掛金', '北の食品')];
    for (const [i, m] of APRIL.map(mon).entries()) {
      const label = `${Number(m.slice(5))}月分`;
      // 店頭の売上：雑貨（10%）と食品（軽減8%）。現金4割・カード6割
      const cash10 = g(season(660000, m));
      const cash8 = g(season(648000, m));
      const card10 = g(season(990000, m));
      const card8 = g(season(972000, m));
      j(period, day(m, 31), [['現金', cash10 + cash8]], [['売上高', cash10, 'sales_10'], ['売上高', cash8, 'sales_8r']], `${label} 店頭売上（現金）`);
      j(period, day(m, 31), [['売掛金', card10 + card8, null, 'カード会社']], [['売上高', card10, 'sales_10'], ['売上高', card8, 'sales_8r']], `${label} 店頭売上（カード）`);
      const fee = cardFee(prevCard);
      if (prevCard) j(period, day(m, 15), [b(prevCard - fee), ['支払手数料', fee, 'purchase_exempt']], [['売掛金', prevCard, null, 'カード会社']], 'カード会社 入金（前月分・手数料3.24%）');
      prevCard = card10 + card8;
      // 前月の現金売上を預け入れる（現金で払う経費の分を残す）
      if (prevCash) j(period, day(m, 2), [b(prevCash - 30000)], [['現金', prevCash - 30000]], '売上金の預け入れ（前月分）');
      prevCash = cash10 + cash8;
      // 仕入：雑貨は丸山商事、食品は北の食品（掛け、翌月末払い）
      const goods10 = g(season(1078000, m));
      const goods8 = g(season(1058400, m));
      j(period, day(m, 10), [['仕入高', goods10, 'purchase_10']], [['買掛金', goods10, null, '丸山商事']], `${label} 雑貨の仕入 丸山商事`);
      j(period, day(m, 12), [['仕入高', goods8, 'purchase_8r']], [['買掛金', goods8, null, '北の食品']], `${label} 食品の仕入 北の食品`);
      j(period, day(m, 31), [['買掛金', prevGoods[0], null, '丸山商事'], ['買掛金', prevGoods[1], null, '北の食品']], [b(prevGoods[0] + prevGoods[1])], '仕入代金の支払（前月分）');
      prevGoods = [goods10, goods8 - (i === 7 ? 21600 : 0)]; // 11月は返品の分を差し引いて支払
      j(period, day(m, 25), [['役員報酬', 250000, null, '鈴木花子'], ['給料手当', 240000]], [b(420000), ['預り金', 70000]], `${label} 給与（パート2名、源泉・社会保険料控除後）`);
      j(period, day(m, 31), [['法定福利費', 60000], ['預り金', 70000]], [b(130000)], '社会保険料・源泉所得税の納付');
      j(period, day(m, 27), [['地代家賃', 220000]], [b(220000)], '店舗の家賃');
      j(period, day(m, 26), [['水道光熱費', 44000], ['通信費', 11000]], [b(55000)], '電気・水道、電話・ネット');
      j(period, day(m, 8), [['消耗品費', 22000], ['荷造運賃', 8800]], [['現金', 30800]], '包装資材・配送料');
      j(period, day(m, 20), [['長期借入金', 50000, null, 'ひかり銀行'], ['支払利息', 3000]], [b(53000)], '借入金の返済（元金・利息）');
      if (i % 3 === 1) j(period, day(m, 18), [['広告宣伝費', 55000]], [b(55000)], 'チラシの印刷・配布');
    }
    payTaxes(j, period, day(mon(5), 31), open, b);
    j(period, day(mon(7), 10), [['保険料', 72000, 'purchase_exempt']], [b(72000)], '店舗総合保険（非課税）');
    j(period, day(mon(9), 20), [['仕入高', 33000, 'purchase_10_ni']], [['現金', 33000]], '手作り雑貨の仕入（インボイスのない個人の作家）');
    j(period, day(mon(11), 15), [['買掛金', 21600, null, '北の食品']], [['仕入高', 21600, 'purchase_return_8r']], '賞味期限の近い食品の返品 北の食品');
    if (last) j(period, day(mon(1), 10), [['雑収入', 11000]], [['現金', 11000]], '（誤り）レジの過不足：雑収入の借方に入れた例');
    if (!first) return;
    j(period, day(mon(6), 15), [['工具器具備品', 880000]], [b(880000)], '冷蔵ショーケース');
    assets.push(createAsset({ name: '冷蔵ショーケース', category: 'tools', accountId: byName['工具器具備品'].id, acquiredOn: day(mon(6), 15), startedOn: day(mon(6), 20), cost: 880000, method: 'straight', usefulLife: 6, assetNo: 'S-001', location: '店舗', detail: '冷凍機付・冷蔵機付陳列棚' }));
  },
};

// 前の会計ソフトから引き継いだダンプ（定率法4年、取得は最初の期の2年前の8月）：最初の期首の帳簿価額
const TRUCK_BOOK = 1083334;

const CONSTRUCTION = {
  entityType: 'corporation',
  settings: { taxStatus: 'taxable' },
  book: {
    subs: [['普通預金', '中央信用金庫'], ['売掛金', 'ひまわりハウス', MONTH_END], ['売掛金', '施主（個人）'], ['買掛金', '中央建材', MONTH_END], ['買掛金', '田中工業', MONTH_END], ['役員報酬', '山田太郎'], ['長期借入金', '中央信用金庫']],
    rename: { 売上高: '完成工事高' },
    extra: [
      ['145', '未成工事支出金', 'current_assets', 'none'],
      ['310', '未成工事受入金', 'current_liabilities', 'none'],
      ['512', '材料費', 'cost_of_sales', 'purchase_10'],
      ['513', '労務費', 'cost_of_sales', 'none'],
      ['514', '外注工事費', 'cost_of_sales', 'purchase_10'],
    ],
  },
  dates: (year) => ({ startDate: `${year}-07-01`, endDate: `${year + 1}-06-30` }),
  taxReturn: taxReturn('general', 3, 118000000),
  opening: (ob) => [
    ob('現金', 200000),
    ob('普通預金', 22000000, '中央信用金庫'),
    ob('売掛金', 8800000, 'ひまわりハウス'),
    ob('未成工事支出金', 1500000),
    ob('車両運搬具', TRUCK_BOOK),
    ob('差入保証金', 500000),
    ob('買掛金', 2750000, '中央建材'),
    ob('買掛金', 3300000, '田中工業'),
    ob('預り金', 435000),
    ob('未払法人税等', 2000000),
    ob('未払消費税等', 1500000),
    ob('長期借入金', 12000000, '中央信用金庫'),
    ob('資本金', 10000000),
  ],
  year({ j, byName }, { period, first, firstStart, mon, open, g, assets }) {
    const b = (amount, tax) => ['普通預金', amount, tax, '中央信用金庫'];
    const works = [7700000, 8800000, 9900000].map(g);
    let prevWork = open('売掛金', 'ひまわりハウス');
    let prevMat = open('買掛金', '中央建材');
    let prevSub = open('買掛金', '田中工業');
    // 期首：前期末の未成工事支出金を当期の材料費に戻す（この工事は7月に完成する）
    const wip = open('未成工事支出金');
    if (wip) j(period, period.startDate, [['材料費', wip, 'none']], [['未成工事支出金', wip]], '前期の未成工事支出金の振戻し');
    const months = [7, 8, 9, 10, 11, 12, 1, 2, 3, 4, 5, 6].map(mon);
    for (const [i, mo] of months.entries()) {
      const label = `${Number(mo.slice(5))}月分`;
      const w = works[i % 3];
      j(period, day(mo, 25), [['売掛金', w, null, 'ひまわりハウス']], [['完成工事高', w]], `${label} 完成工事 ひまわりハウス（元請）`);
      if (prevWork) j(period, day(mo, 31), [b(prevWork)], [['売掛金', prevWork, null, 'ひまわりハウス']], 'ひまわりハウス 入金（前月分）');
      prevWork = w - (i === 9 ? 110000 : 0); // 4月は値引きの分を差し引いて入金
      // 個人のお客様の改修工事：着手時に着手金、翌月に完成・引渡し、その翌月に残金
      if (i % 3 === 0) {
        j(period, day(mo, 5), [b(2200000)], [['未成工事受入金', 2200000]], '改修工事の着手金（施主）');
        j(period, day(months[i + 1], 28), [['未成工事受入金', 2200000], ['売掛金', 3300000, null, '施主（個人）']], [['完成工事高', 5500000]], '改修工事の完成・引渡し（施主）');
        j(period, day(months[i + 2], 10), [b(3300000)], [['売掛金', 3300000, null, '施主（個人）']], '改修工事の残金 入金（施主）');
      }
      const mat = g(2750000);
      const sub = g(3300000);
      j(period, day(mo, 10), [['材料費', mat]], [['買掛金', mat, null, '中央建材']], `${label} 資材の仕入 中央建材`);
      j(period, day(mo, 20), [['外注工事費', sub]], [['買掛金', sub, null, '田中工業']], `${label} 外注工事 田中工業`);
      j(period, day(mo, 31), [['買掛金', prevMat, null, '中央建材'], ['買掛金', prevSub, null, '田中工業']], [b(prevMat + prevSub)], '中央建材・田中工業 支払（前月分）');
      prevMat = mat;
      prevSub = sub;
      if (i % 3 === 2) j(period, day(mo, 22), [['外注工事費', 330000, 'purchase_10_ni']], [b(330000)], '内装工事の応援（インボイスのない一人親方）');
      j(period, day(mo, 25), [['労務費', 1200000], ['役員報酬', 1000000, null, '山田太郎'], ['給料手当', 700000]], [b(2465000), ['預り金', 435000]], `${label} 給与（現場4名・事務営業2名、源泉・社会保険料控除後）`);
      j(period, day(mo, 31), [['法定福利費', 430000], ['預り金', 435000]], [b(865000)], '社会保険料・源泉所得税の納付（前月分）');
      j(period, day(mo, 27), [['地代家賃', 330000]], [b(330000)], '事務所・資材置場の家賃');
      j(period, day(mo, 15), [['車両費', 110000], ['通信費', 33000]], [b(143000)], 'ガソリン代・電話');
      j(period, day(mo, 26), [['長期借入金', 250000, null, '中央信用金庫'], ['支払利息', 25000]], [b(275000)], '借入金の返済（元金・利息）');
    }
    j(period, day(mon(7), 10), [['保険料', 360000, 'purchase_exempt']], [b(360000)], '請負業者賠償責任保険・車両保険（非課税）');
    j(period, day(mon(7), 1), [['現金', 100000]], [b(100000)], '小口現金の補充');
    payTaxes(j, period, day(mon(8), 31), open, b);
    j(period, day(mon(12), 20), [['接待交際費', 55000], ['会議費', 13200]], [['現金', 68200]], '協力会社との忘年会・打合せ');
    j(period, day(mon(2), 10), [['租税公課', 33000, 'none']], [['現金', 33000]], '建設業許可の更新手数料・印紙');
    j(period, day(mon(4), 15), [['完成工事高', 110000, 'sales_return_10']], [['売掛金', 110000, null, 'ひまわりハウス']], 'ひまわりハウス 手直しの値引き');
    // 期末：引渡し前の工事の材料費を未成工事支出金へ（決算の手続きの例）
    j(period, period.endDate, [['未成工事支出金', 1650000]], [['材料費', 1650000, 'none']], '期末の未成工事支出金（7月完成予定の工事の材料費）', { adjusting: true });
    if (!first) return;
    j(period, day(mon(9), 15), [['車両運搬具', 4400000]], [b(4400000)], '2tダンプ（新車）');
    assets.push(
      createAsset({ name: 'ダンプ（前期取得）', category: 'vehicle', accountId: byName['車両運搬具'].id, acquiredOn: yearsBefore(firstStart, 2, '08-01'), startedOn: yearsBefore(firstStart, 2, '08-05'), cost: 4000000, method: 'declining', usefulLife: 4, carryOn: firstStart, carryBook: TRUCK_BOOK, assetNo: 'V-001', location: '資材置場', memo: '前の会計ソフトの帳簿価額を引き継ぎ' }),
      createAsset({ name: '2tダンプ', category: 'vehicle', accountId: byName['車両運搬具'].id, acquiredOn: day(mon(9), 15), startedOn: day(mon(9), 20), cost: 4400000, method: 'declining', usefulLife: 4, assetNo: 'V-002', location: '資材置場' }),
    );
  },
};

const IT = {
  entityType: 'corporation',
  settings: { taxStatus: 'exempt' },
  book: { subs: [['普通預金', 'ネット銀行'], ['売掛金', 'ABCソフト', MONTH_END], ['売掛金', 'みどり商会', MONTH_END], ['役員報酬', '高橋健'], ['役員借入金', '高橋健']] },
  dates: (year) => ({ startDate: `${year}-01-01`, endDate: `${year}-12-31` }),
  opening: (ob) => [ob('普通預金', 2500000, 'ネット銀行'), ob('売掛金', 660000, 'ABCソフト'), ob('未払法人税等', 70000), ob('役員借入金', 1500000, '高橋健'), ob('資本金', 1000000)],
  year({ j, byName }, { period, first, mon, open, g, assets }) {
    const b = (amount, tax) => ['普通預金', amount, tax, 'ネット銀行'];
    let prevAbc = open('売掛金', 'ABCソフト');
    let prevMidori = open('売掛金', 'みどり商会');
    for (const [i, m] of [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12].map(mon).entries()) {
      const label = `${Number(m.slice(5))}月分`;
      const abc = g(660000);
      j(period, day(m, 31), [['売掛金', abc, null, 'ABCソフト']], [['売上高', abc]], `${label} システム開発（準委任） ABCソフト`);
      if (prevAbc) j(period, day(m, 31), [b(prevAbc)], [['売掛金', prevAbc, null, 'ABCソフト']], 'ABCソフト 入金（前月分）');
      prevAbc = abc;
      // みどり商会の保守は最初の期の4月から
      if (!first || i >= 3) {
        if (prevMidori) j(period, day(m, 31), [b(prevMidori)], [['売掛金', prevMidori, null, 'みどり商会']], 'みどり商会 入金（前月分）');
        j(period, day(m, 31), [['売掛金', 110000, null, 'みどり商会']], [['売上高', 110000]], `${label} 保守・運用 みどり商会`);
        prevMidori = 110000;
      }
      j(period, day(m, 25), [['役員報酬', 400000, null, '高橋健']], [b(340000), ['預り金', 60000]], `${label} 役員報酬（源泉・社会保険料控除後）`);
      j(period, day(m, 31), [['法定福利費', 52000], ['預り金', 60000]], [b(112000)], '社会保険料・源泉所得税の納付');
      j(period, day(m, 5), [['通信費', 24200], ['支払手数料', 4400]], [b(28600)], 'クラウドサーバー・開発ツールの利用料');
      j(period, day(m, 27), [['地代家賃', 33000]], [b(33000)], 'コワーキングスペースの利用料');
      if (i % 2 === 1) j(period, day(m, 20), [['外注費', 165000]], [b(165000)], 'デザインの外注（フリーランス）');
      if (i % 3 === 2) j(period, day(m, 12), [['旅費交通費', 22000], ['新聞図書費', 5500]], [b(27500)], '客先への交通費・技術書');
      if (i % 3 === 0) j(period, day(m, 28), [['役員借入金', 100000, null, '高橋健']], [b(100000)], '役員借入金の返済');
    }
    if (open('未払法人税等')) j(period, day(mon(2), 28), [['未払法人税等', open('未払法人税等')]], [b(open('未払法人税等'))], '前期の法人税等の納付');
    j(period, day(mon(9), 10), [['諸会費', 12000, 'none']], [b(12000)], '商工会の会費');
    if (!first) return;
    j(period, day(mon(5), 15), [['工具器具備品', 297000]], [b(297000)], '開発用パソコン');
    j(period, day(mon(7), 1), [['ソフトウェア', 880000]], [b(880000)], '自社利用の業務システム（開発委託）');
    assets.push(
      createAsset({ name: '開発用パソコン', category: 'tools', accountId: byName['工具器具備品'].id, acquiredOn: day(mon(5), 15), startedOn: day(mon(5), 16), cost: 297000, method: 'sme', assetNo: 'T-001', location: '本店' }),
      createAsset({ name: '業務システム', category: 'intangible', accountId: byName['ソフトウェア'].id, acquiredOn: day(mon(7), 1), startedOn: day(mon(7), 1), cost: 880000, method: 'straight', usefulLife: 5, assetNo: 'S-001', detail: '自社利用のソフトウエア' }),
    );
  },
};

// 開業時の内装（定額法15年、最初の期の3年前の4月に取得）：3年分を償却した帳簿価額を引き継ぐ
const INTERIOR_BOOK = 3300000 - 221100 * 3;

const RESTAURANT = {
  entityType: 'corporation',
  settings: { taxStatus: 'taxable' },
  book: { subs: [['普通預金', 'みなと銀行'], ['売掛金', 'カード会社', { closingDay: 31, months: 1, payDay: 15 }], ['買掛金', '港の市場', MONTH_END], ['役員報酬', '伊藤まり'], ['長期借入金', '日本政策金融公庫']] },
  dates: (year) => ({ startDate: `${year}-04-01`, endDate: `${year + 1}-03-31` }),
  taxReturn: taxReturn('twenty', 4, 8400000),
  opening: (ob) => [
    ob('現金', 200000),
    ob('普通預金', 1800000, 'みなと銀行'),
    ob('売掛金', 520000, 'カード会社'),
    ob('建物附属設備', INTERIOR_BOOK),
    ob('敷金', 1000000),
    ob('買掛金', 357400, '港の市場'),
    ob('未払法人税等', 70000),
    ob('未払消費税等', 160000),
    ob('長期借入金', 3600000, '日本政策金融公庫'),
    ob('資本金', 3000000),
  ],
  year({ j, byName }, { period, first, firstStart, mon, open, g, assets }) {
    const b = (amount, tax) => ['普通預金', amount, tax, 'みなと銀行'];
    let prevCard = open('売掛金', 'カード会社');
    let prevCash = Math.max(0, open('現金') - 200000);
    let prevFood = open('買掛金', '港の市場');
    for (const m of APRIL.map(mon)) {
      const label = `${Number(m.slice(5))}月分`;
      // 店内飲食（10%）と持ち帰り（軽減8%）。現金とカードが半分ずつ
      const eat = g(season(440000, m));
      const take = g(season(108000, m));
      j(period, day(m, 31), [['現金', eat + take]], [['売上高', eat, 'sales_10'], ['売上高', take, 'sales_8r']], `${label} 売上（現金）`);
      j(period, day(m, 31), [['売掛金', eat + take, null, 'カード会社']], [['売上高', eat, 'sales_10'], ['売上高', take, 'sales_8r']], `${label} 売上（カード）`);
      const fee = cardFee(prevCard);
      if (prevCard) j(period, day(m, 15), [b(prevCard - fee), ['支払手数料', fee, 'purchase_exempt']], [['売掛金', prevCard, null, 'カード会社']], 'カード会社 入金（前月分・手数料3.24%）');
      prevCard = eat + take;
      // 前月の現金売上を預け入れる（酒類・消耗品を現金で払う分を残す）
      if (prevCash) j(period, day(m, 2), [b(prevCash - 80000)], [['現金', prevCash - 80000]], '売上金の預け入れ（前月分）');
      prevCash = eat + take;
      // 食材（軽減8%）は港の市場から掛けで、酒類（10%）は酒店から現金で
      const food = g(season(302400, m));
      j(period, day(m, 20), [['仕入高', food, 'purchase_8r']], [['買掛金', food, null, '港の市場']], `${label} 食材の仕入 港の市場`);
      if (prevFood) j(period, day(m, 31), [['買掛金', prevFood, null, '港の市場']], [b(prevFood)], '港の市場 支払（前月分）');
      prevFood = food;
      j(period, day(m, 9), [['仕入高', 55000, 'purchase_10']], [['現金', 55000]], '酒類の仕入');
      j(period, day(m, 25), [['役員報酬', 150000, null, '伊藤まり'], ['給料手当', 160000]], [b(270000), ['預り金', 40000]], `${label} 給与（パート2名、源泉・社会保険料控除後）`);
      j(period, day(m, 31), [['法定福利費', 25000], ['預り金', 40000]], [b(65000)], '社会保険料・源泉所得税の納付');
      j(period, day(m, 27), [['地代家賃', 165000]], [b(165000)], '店舗の家賃');
      j(period, day(m, 26), [['水道光熱費', 55000], ['通信費', 8800]], [b(63800)], 'ガス・電気・水道、電話');
      j(period, day(m, 6), [['消耗品費', 22000]], [['現金', 22000]], '持ち帰り容器・洗剤');
      j(period, day(m, 20), [['長期借入金', 50000, null, '日本政策金融公庫'], ['支払利息', 4000]], [b(54000)], '借入金の返済（元金・利息）');
    }
    payTaxes(j, period, day(mon(5), 31), open, b);
    j(period, day(mon(6), 10), [['修繕費', 88000]], [b(88000)], '厨房の排気ダクトの清掃・修理');
    j(period, day(mon(8), 5), [['仕入高', 21600, 'purchase_8r_ni']], [['現金', 21600]], '野菜の仕入（インボイスのない近所の農家）');
    j(period, day(mon(12), 15), [['広告宣伝費', 33000]], [b(33000)], 'グルメサイトの掲載料');
    if (first) assets.push(createAsset({ name: '店舗の内装', category: 'building_equipment', accountId: byName['建物附属設備'].id, acquiredOn: yearsBefore(firstStart, 3, '04-01'), startedOn: yearsBefore(firstStart, 3, '04-10'), cost: 3300000, method: 'straight', usefulLife: 15, carryOn: firstStart, carryBook: INTERIOR_BOOK, assetNo: 'B-001', location: '店舗', memo: '開業時の内装工事。前の会計ソフトの帳簿価額を引き継ぎ' }));
    if (!first) return;
    // 10万円未満の備品（全額を経費にする少額減価償却資産）
    j(period, day(mon(10), 1), [['工具器具備品', 99000]], [['現金', 99000]], '業務用炊飯器（10万円未満）');
    assets.push(createAsset({ name: '業務用炊飯器', category: 'tools', accountId: byName['工具器具備品'].id, acquiredOn: day(mon(10), 1), startedOn: day(mon(10), 1), cost: 99000, method: 'small', assetNo: 'T-001', location: '厨房' }));
  },
};

/** 法人のサンプル（製造業は sample.js）。id → assemble の spec */
export const CORPORATION_SPECS = {
  'corp-retail': RETAIL,
  'corp-construction': CONSTRUCTION,
  'corp-it': IT,
  'corp-restaurant': RESTAURANT,
};
