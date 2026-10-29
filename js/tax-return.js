// 消費税の申告で納める税額の計算（純粋関数）。税込経理で、売上・仕入とも割戻し計算
// 出典（2026-10-29 確認。令和8年4月1日現在の法令等）
// - 割戻し計算：国税庁 No.6383 https://www.nta.go.jp/taxes/shiraberu/taxanswer/shohi/6383.htm
//               No.6391 https://www.nta.go.jp/taxes/shiraberu/taxanswer/shohi/6391.htm
// - 端数処理：No.6371（課税標準額は千円未満、差引税額は百円未満を切り捨て。税額は1円未満切り捨て）
//   https://www.nta.go.jp/taxes/shiraberu/taxanswer/shohi/6371.htm
// - 地方消費税＝差引税額×22/78（百円未満切り捨て）：国税庁「消費税及び地方消費税の申告書の書き方（個人事業者用）」
//   https://www.nta.go.jp/publication/pamph/shohi_kojin/r05/pdf/02-07.pdf
// - 簡易課税（売上の消費税額×みなし仕入率）：No.6505 https://www.nta.go.jp/taxes/shiraberu/taxanswer/shohi/6505.htm
// - 2割特例・3割特例：https://www.nta.go.jp/taxes/shiraberu/zeimokubetsu/shohi/keigenzeiritsu/invoice_2tokurei.htm
// - 返還等対価に係る税額：No.6359 https://www.nta.go.jp/taxes/shiraberu/taxanswer/shohi/6359.htm
// - 仕入れに係る対価の返還等：No.6363 https://www.nta.go.jp/taxes/shiraberu/taxanswer/shohi/6363.htm
// - 貸倒れに係る税額：No.6367 https://www.nta.go.jp/taxes/shiraberu/taxanswer/shohi/6367.htm
// - 貸倒回収に係る消費税額（控除過大調整税額）：No.6631 https://www.nta.go.jp/taxes/shiraberu/taxanswer/shohi/6631.htm
// - 個別対応方式・一括比例配分方式：No.6401 https://www.nta.go.jp/taxes/shiraberu/taxanswer/shohi/6401.htm
// - 課税売上割合（返品は引く・貸倒れは引かない・有価証券等は5%）：No.6405 https://www.nta.go.jp/taxes/shiraberu/taxanswer/shohi/6405.htm
// - 輸入の消費税（外国貨物の引取りに係る消費税額）も課税仕入れ等の税額：国税庁「消費税のあらまし」
//   https://www.nta.go.jp/publication/pamph/shohi/aramashi/pdf/010.pdf
// - 簡易課税の基礎となる消費税額＝課税標準額に対する消費税額＋貸倒回収−売上対価の返還等：
//   「消費税及び地方消費税の申告書（簡易課税用）の書き方」https://www.nta.go.jp/publication/pamph/shohi/kaisei/yoshiki/pdf/202411_02.pdf
//   2割特例の設例（貸倒回収・貸倒処理・対価返還がある場合）https://www.nta.go.jp/taxes/tetsuzuki/shinsei/shinkoku/shohi/pdf/015.pdf
// - インボイスのない仕入の経過措置（令和8年度改正後の8・7・5・3割）：
//   https://www.nta.go.jp/taxes/shiraberu/zeimokubetsu/shohi/keigenzeiritsu/invoice-review/index.htm
import { TAX_BY_CODE, signedTaxAmount } from './tax.js';

/** 計算の方法 */
export const TAX_METHODS = [
  { id: 'general', label: '一般課税（本則）', short: '一般' },
  { id: 'simplified', label: '簡易課税', short: '簡易' },
  { id: 'twenty', label: '2割特例', short: '2割' },
  { id: 'thirty', label: '3割特例（個人）', short: '3割' },
];
export const TAX_METHOD_BY_ID = Object.fromEntries(TAX_METHODS.map((m) => [m.id, m]));

/** 簡易課税の事業区分とみなし仕入率（No.6505） */
export const BUSINESS_TYPES = [
  { id: 1, label: '第1種（卸売業）', rate: 90 },
  { id: 2, label: '第2種（小売業など）', rate: 80 },
  { id: 3, label: '第3種（製造業・建設業など）', rate: 70 },
  { id: 4, label: '第4種（飲食店業など、ほかに当たらない事業）', rate: 60 },
  { id: 5, label: '第5種（サービス業・運輸通信業・金融保険業）', rate: 50 },
  { id: 6, label: '第6種（不動産業）', rate: 40 },
];

/** 2割特例の対象：令和5年10月1日〜令和8年9月30日の日を含む課税期間 */
export const TWENTY_FROM = '2023-10-01';
export const TWENTY_UNTIL = '2026-09-30';
/** 3割特例の対象：個人事業者の令和9年分・令和10年分 */
export const THIRTY_YEARS = [2027, 2028];

/**
 * インボイスのない課税仕入れで控除できる割合（%）。課税仕入れの日で決まる
 * 令和5年10月1日〜令和8年9月30日：80%、〜令和10年9月30日：70%、〜令和12年9月30日：50%、〜令和13年9月30日：30%、以後0%
 * 令和5年9月30日以前はインボイス制度の前なので100%
 */
export function transitionalRate(date) {
  if (date < '2023-10-01') return 100;
  if (date <= '2026-09-30') return 80;
  if (date <= '2028-09-30') return 70;
  if (date <= '2030-09-30') return 50;
  if (date <= '2031-09-30') return 30;
  return 0;
}

/** その方法をこの期間に使えるか（使えなければ理由） */
export function methodAvailability(method, period, entityType) {
  if (method === 'twenty' && !(period.startDate <= TWENTY_UNTIL && period.endDate >= TWENTY_FROM)) return '2割特例は令和5年10月1日〜令和8年9月30日の日を含む課税期間だけです';
  if (method === 'thirty') {
    if (entityType !== 'individual') return '3割特例は個人事業者だけです';
    if (!THIRTY_YEARS.includes(Number(period.startDate.slice(0, 4))) || period.startDate.slice(0, 4) !== period.endDate.slice(0, 4)) return '3割特例は令和9年分・令和10年分だけです';
  }
  return null;
}

const floorTo = (n, unit) => (n >= 0 ? Math.floor(n / unit) * unit : -Math.floor(-n / unit) * unit);
const trunc = (a, b) => (a >= 0 ? Math.floor(a / b) : -Math.floor(-a / b)); // 整数の割り算（0方向）
// 税込金額から国税の消費税額：10%は×7.8/110、8%（軽減）は×6.24/108（1円未満切り捨て）
const tax10 = (gross) => trunc(gross * 78, 1100);
const tax8 = (gross) => trunc(gross * 624, 10800);
// 税込金額から税抜金額
const net10 = (gross) => trunc(gross * 100, 110);
const net8 = (gross) => trunc(gross * 100, 108);

/** 仕入の用途区分（個別対応方式の区分） */
export const PURCHASE_USES = ['taxable', 'common', 'exempt'];

/** 課税売上割合が95%未満などのときの計算の方法（No.6401） */
export const ALLOCATIONS = [
  { id: 'individual', label: '個別対応方式', short: '個別対応' },
  { id: 'proportional', label: '一括比例配分方式', short: '一括比例' },
];

/**
 * 期間の税区分別の税込金額（売上・返品などはそれぞれプラスの金額）。インボイスのない仕入は控除割合ごとに分ける
 * @returns {{ sales10, sales8, export, exemptSales, securities, salesReturn10, salesReturn8, exportReturn, exemptReturn,
 *   badDebt10, badDebt8, recovered10, recovered8, purchase10, purchase8, importLocal,
 *   uses: { taxable|common|exempt: { p10, p8, ret10, ret8, import } },
 *   transitional: Array<{ code, use, pct, gross }> }}
 */
export function taxBuckets(journals, { from, to }) {
  const b = {
    sales10: 0, sales8: 0, export: 0, exemptSales: 0, securities: 0,
    salesReturn10: 0, salesReturn8: 0, exportReturn: 0, exemptReturn: 0,
    badDebt10: 0, badDebt8: 0, recovered10: 0, recovered8: 0,
    purchase10: 0, purchase8: 0, importLocal: 0,
  };
  const uses = Object.fromEntries(PURCHASE_USES.map((u) => [u, { p10: 0, p8: 0, ret10: 0, ret8: 0, import: 0 }]));
  const transitional = new Map();
  const r = (cat, k10, k8) => (cat.rate === 100 ? k10 : k8);
  const salesKey = {
    taxable: (c) => r(c, 'sales10', 'sales8'),
    export: () => 'export',
    exempt: () => 'exemptSales',
    securities: () => 'securities',
    return: (c) => r(c, 'salesReturn10', 'salesReturn8'),
    export_return: () => 'exportReturn',
    exempt_return: () => 'exemptReturn',
    baddebt: (c) => r(c, 'badDebt10', 'badDebt8'),
    recovered: (c) => r(c, 'recovered10', 'recovered8'),
  };
  for (const j of journals) {
    if (j.date < from || j.date > to) continue;
    for (const l of j.lines) {
      const cat = TAX_BY_CODE[l.taxCategory];
      if (!cat || cat.kind === 'none') continue;
      const v = signedTaxAmount(l);
      if (cat.kind === 'sales') {
        b[salesKey[cat.role](cat)] += v;
        continue;
      }
      if (cat.role === 'import_local') b.importLocal += v;
      if (!cat.use) continue; // 非課税仕入・地方消費税貨物割は国税の計算に使わない
      const u = uses[cat.use];
      if (cat.role === 'taxable') {
        b[r(cat, 'purchase10', 'purchase8')] += v;
        if (cat.transitional) {
          const k = `${cat.code}|${transitionalRate(j.date)}`;
          transitional.set(k, (transitional.get(k) || 0) + v);
        } else u[r(cat, 'p10', 'p8')] += v;
      } else if (cat.role === 'return') u[r(cat, 'ret10', 'ret8')] += v;
      else if (cat.role === 'import') u.import += v;
    }
  }
  return {
    ...b,
    uses,
    transitional: [...transitional].map(([k, gross]) => {
      const [code, pct] = k.split('|');
      return { code, use: TAX_BY_CODE[code].use, pct: Number(pct), gross };
    }),
  };
}

/** 課税売上割合の分子（課税売上高・税抜）と分母（総売上高・税抜）。No.6405 */
export function taxableRatioParts(b) {
  // 返品・値引きは分子・分母から引き、貸倒れは引かない。有価証券等の譲渡は譲渡対価の5%を分母に入れる
  const taxable = net10(b.sales10) + net8(b.sales8) - net10(b.salesReturn10) - net8(b.salesReturn8) + b.export - b.exportReturn;
  const all = taxable + b.exemptSales - b.exemptReturn + trunc(b.securities * 5, 100);
  return { taxable, all };
}

/**
 * 納める消費税額の計算
 * @param {{ journals, period, entityType, method, businessType?, allocation?, interimNational?, interimLocal? }} input
 *   allocation：課税売上割合が95%未満などのときの方法（individual／proportional）
 *   interim*：中間納付税額（国税・地方）
 * @returns 申告書の主な欄（すべて整数の円）と注意
 */
export function computeTaxReturn({ journals, period, entityType, method = 'general', businessType = 5, allocation = 'proportional', interimNational = 0, interimLocal = 0 }) {
  const b = taxBuckets(journals, { from: period.startDate, to: period.endDate });
  // 課税標準額：税率ごとに 税込×100/110（軽減は100/108）、千円未満切り捨て
  const base10 = floorTo(net10(b.sales10), 1000);
  const base8 = floorTo(net8(b.sales8), 1000);
  // 課税標準額に対する消費税額（国税）：7.8%・6.24%、1円未満切り捨て
  const salesTax10 = trunc(base10 * 78, 1000);
  const salesTax8 = trunc(base8 * 624, 10000);
  const salesTax = salesTax10 + salesTax8;
  // 貸倒回収に係る消費税額（控除過大調整税額に加算。No.6631）、返還等対価に係る税額（No.6359）、貸倒れに係る税額（No.6367）
  const recovered = { r10: tax10(b.recovered10), r8: tax8(b.recovered8) };
  const returns = { r10: tax10(b.salesReturn10), r8: tax8(b.salesReturn8) };
  const recoveredTax = recovered.r10 + recovered.r8;
  const returnTax = returns.r10 + returns.r8;
  const badDebtTax = tax10(b.badDebt10) + tax8(b.badDebt8);

  // 課税仕入れ等の税額（用途区分ごと）＝課税仕入れ＋インボイスなしの経過措置分＋輸入の消費税−仕入の返品・値引き（No.6363）
  const transitional = b.transitional.map((t) => {
    const cat = TAX_BY_CODE[t.code];
    const full = trunc(t.gross * cat.national, (1000 + cat.rate) * 10);
    return { ...t, label: cat.label, tax: trunc(full * t.pct, 100) };
  });
  const useTax = Object.fromEntries(
    PURCHASE_USES.map((use) => {
      const u = b.uses[use];
      const trans = transitional.filter((t) => t.use === use).reduce((s, t) => s + t.tax, 0);
      return [use, tax10(u.p10) + tax8(u.p8) + trans + u.import - tax10(u.ret10) - tax8(u.ret8)];
    }),
  );
  const sumUses = (f) => PURCHASE_USES.reduce((s, use) => s + f(b.uses[use]), 0);
  const purchaseTax10 = sumUses((u) => tax10(u.p10));
  const purchaseTax8 = sumUses((u) => tax8(u.p8));
  const importTax = sumUses((u) => u.import);
  const purchaseReturnTax = sumUses((u) => tax10(u.ret10) + tax8(u.ret8));
  const totalPurchaseTax = PURCHASE_USES.reduce((s, use) => s + useTax[use], 0);

  // 課税売上割合。全額控除できるのは95%以上かつ課税売上高5億円以下のとき（No.6401）
  const ratio = taxableRatioParts(b);
  const byRatio = (x) => (ratio.all > 0 ? Number((BigInt(x) * BigInt(Math.max(0, ratio.taxable))) / BigInt(ratio.all)) : x); // 1円未満切り捨て（0方向）
  const fullDeduction = ratio.all <= 0 || (ratio.taxable * 100 >= ratio.all * 95 && ratio.taxable <= 500000000);
  const allocated = {
    individual: useTax.taxable + byRatio(useTax.common),
    proportional: byRatio(totalPurchaseTax),
  };
  const alloc = ALLOCATIONS.some((a) => a.id === allocation) ? allocation : 'proportional';
  let generalDeduction = fullDeduction ? totalPurchaseTax : allocated[alloc];
  // 仕入の返品などが多く控除しきれないときは、その分を売上の税額に加算する（No.6363）
  const overReturn = generalDeduction < 0 ? -generalDeduction : 0;
  if (overReturn) generalDeduction = 0;

  const type = BUSINESS_TYPES.find((x) => x.id === Number(businessType)) || BUSINESS_TYPES[4];
  // 簡易課税・2割特例・3割特例：税率ごとに（課税標準額に対する消費税額＋貸倒回収に係る消費税額−返還等対価に係る税額）×割合
  // 国税庁 申告書（簡易課税用）の書き方 付表5-3 ④、2割特例の設例（付表6 ⑥⑦）
  const basis10 = Math.max(0, salesTax10 + recovered.r10 - returns.r10);
  const basis8 = Math.max(0, salesTax8 + recovered.r8 - returns.r8);
  const byRate = (pct) => trunc(basis10 * pct, 100) + trunc(basis8 * pct, 100);
  const deductionByMethod = { general: generalDeduction, simplified: byRate(type.rate), twenty: byRate(80), thirty: byRate(70) };
  const calc = (m) => {
    const deduction = deductionByMethod[m];
    const adjustment = recoveredTax + (m === 'general' ? overReturn : 0); // 控除過大調整税額
    const deductionTotal = deduction + returnTax + badDebtTax; // 控除税額小計
    const diff = salesTax + adjustment - deductionTotal;
    // 差引税額は百円未満切り捨て。控除しきれないとき（還付）は1円単位
    const net = diff > 0 ? floorTo(diff, 100) : diff;
    const local = net > 0 ? floorTo(trunc(net * 22, 78), 100) : trunc(net * 22, 78);
    return { deduction, adjustment, deductionTotal, net, local, total: net + local };
  };
  const result = calc(method);
  const payableNational = result.net - interimNational;
  const payableLocal = result.local - interimLocal;

  const warnings = [];
  const usesSplit = PURCHASE_USES.some((use) => use !== 'taxable' && (useTax[use] || b.uses[use].p10 || b.uses[use].p8 || b.transitional.some((t) => t.use === use)));
  if (method === 'general' && !fullDeduction) {
    warnings.push(`課税売上割合が95%未満（または課税売上高が5億円超）のため、${ALLOCATIONS.find((a) => a.id === alloc).label}で仕入の税額の一部だけを控除しています`);
    if (alloc === 'individual' && !usesSplit) warnings.push('個別対応方式は、仕入を「課税売上対応・共通対応・非課税売上対応」に分けて記帳している場合だけ使えます（共通対応・非課税売上対応の税区分の仕訳がありません）');
    if (alloc === 'proportional') warnings.push('一括比例配分方式を選ぶと、2年間以上続けて使った後でなければ個別対応方式に変えられません');
  }
  if (method === 'general' && ratio.taxable > 500000000) warnings.push('課税売上高が5億円を超えています（課税期間が1年未満の場合の年換算はしていません）');
  if (period.endDate >= '2027-04-01' && (b.sales8 || b.purchase8)) warnings.push('令和9年4月1日以後の飲食料品の税率の引き下げには、まだ対応していません');
  if (method !== 'general' && transitional.length) warnings.push('インボイスのない仕入の経過措置は一般課税だけで使います（この方法では仕入の税額を使いません）');
  const unavailable = methodAvailability(method, period, entityType);

  return {
    method,
    businessType: type,
    allocation: alloc,
    buckets: b,
    base10,
    base8,
    salesTax10,
    salesTax8,
    salesTax,
    recoveredTax,
    returnTax,
    badDebtTax,
    purchaseTax10,
    purchaseTax8,
    importTax,
    purchaseReturnTax,
    transitional,
    useTax,
    totalPurchaseTax,
    fullDeduction,
    allocated,
    ...result,
    interimNational,
    interimLocal,
    payableNational,
    payableLocal,
    payable: payableNational + payableLocal,
    taxableRatio: ratio.all > 0 ? ratio.taxable / ratio.all : null,
    taxableSales: ratio.taxable,
    totalSales: ratio.all,
    compare: Object.fromEntries(TAX_METHODS.map((m) => [m.id, { ...calc(m.id), unavailable: methodAvailability(m.id, period, entityType) }])),
    warnings: unavailable ? [unavailable, ...warnings] : warnings,
  };
}

/**
 * 税込経理で、納める消費税等を期末に費用にする仕訳の明細（租税公課 / 未払消費税等。個人で未払消費税等の科目が無ければ未払金）
 * 中間納付した分は支払ったときに租税公課にしている前提で、残りの納付税額だけを計上する
 * @returns {{ lines: Array, errors: string[] }}
 */
export function consumptionTaxLines({ amount, accounts }) {
  const expense = accounts.find((a) => a.hint === 'taxes_dues' && a.active);
  const payable = accounts.find((a) => a.hint === 'consumption_tax_payable' && a.active) || accounts.find((a) => a.hint === 'accrued' && a.active);
  const errors = [];
  if (!expense) errors.push('租税公課の科目が見つかりません');
  if (!payable) errors.push('未払消費税等（または未払金）の科目が見つかりません');
  if (!(amount > 0)) errors.push('納める税額がないため、仕訳は不要です');
  if (errors.length) return { lines: [], errors };
  const memo = '決算整理 消費税等';
  return {
    lines: [
      { side: 'debit', accountId: expense.id, subAccountId: null, amount, taxCategory: 'none', memo },
      { side: 'credit', accountId: payable.id, subAccountId: null, amount, taxCategory: 'none', memo },
    ],
    errors,
  };
}
