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

/**
 * 期間の税区分別の税込金額。インボイスのない仕入は控除割合ごとに分ける
 * @returns {{ sales10, sales8, export, exemptSales, purchase10, purchase8, transitional: Array<{ code, pct, gross }> }}
 */
export function taxBuckets(journals, { from, to }) {
  const b = { sales10: 0, sales8: 0, export: 0, exemptSales: 0, purchase10: 0, purchase8: 0, transitional: new Map() };
  const key = { sales_10: 'sales10', sales_8r: 'sales8', sales_export: 'export', sales_exempt: 'exemptSales', purchase_10: 'purchase10', purchase_8r: 'purchase8' };
  for (const j of journals) {
    if (j.date < from || j.date > to) continue;
    for (const l of j.lines) {
      const cat = TAX_BY_CODE[l.taxCategory];
      if (!cat || cat.kind === 'none') continue;
      const v = signedTaxAmount(l);
      if (cat.transitional) {
        const k = `${cat.code}|${transitionalRate(j.date)}`;
        b.transitional.set(k, (b.transitional.get(k) || 0) + v);
      } else if (key[cat.code]) b[key[cat.code]] += v;
    }
  }
  return {
    ...b,
    transitional: [...b.transitional].map(([k, gross]) => {
      const [code, pct] = k.split('|');
      return { code, pct: Number(pct), gross };
    }),
  };
}

/**
 * 納める消費税額の計算
 * @param {{ journals, period, entityType, method, businessType?, interimNational?, interimLocal? }} input
 *   interim*：中間納付税額（国税・地方）
 * @returns 申告書の主な欄（すべて整数の円）と注意
 */
export function computeTaxReturn({ journals, period, entityType, method = 'general', businessType = 5, interimNational = 0, interimLocal = 0 }) {
  const b = taxBuckets(journals, { from: period.startDate, to: period.endDate });
  // 課税標準額：税率ごとに 税込×100/110（軽減は100/108）、千円未満切り捨て
  const base10 = floorTo(trunc(b.sales10 * 100, 110), 1000);
  const base8 = floorTo(trunc(b.sales8 * 100, 108), 1000);
  // 課税標準額に対する消費税額（国税）：7.8%・6.24%、1円未満切り捨て
  const salesTax10 = trunc(base10 * 78, 1000);
  const salesTax8 = trunc(base8 * 624, 10000);
  const salesTax = salesTax10 + salesTax8;

  // 控除対象仕入税額
  const purchaseTax10 = trunc(b.purchase10 * 78, 1100); // ×7.8/110
  const purchaseTax8 = trunc(b.purchase8 * 624, 10800); // ×6.24/108
  const transitional = b.transitional.map((t) => {
    const cat = TAX_BY_CODE[t.code];
    const full = trunc(t.gross * cat.national, (1000 + cat.rate) * 10);
    return { ...t, label: cat.label, tax: trunc(full * t.pct, 100) };
  });
  const generalDeduction = purchaseTax10 + purchaseTax8 + transitional.reduce((s, t) => s + t.tax, 0);
  const type = BUSINESS_TYPES.find((x) => x.id === Number(businessType)) || BUSINESS_TYPES[4];
  const deductionByMethod = {
    general: generalDeduction,
    simplified: trunc(Math.max(0, salesTax) * type.rate, 100),
    twenty: trunc(Math.max(0, salesTax) * 80, 100),
    thirty: trunc(Math.max(0, salesTax) * 70, 100),
  };
  const calc = (m) => {
    const deduction = deductionByMethod[m];
    const diff = salesTax - deduction;
    // 差引税額は百円未満切り捨て。控除しきれないとき（還付）は1円単位
    const net = diff > 0 ? floorTo(diff, 100) : diff;
    const local = net > 0 ? floorTo(trunc(net * 22, 78), 100) : trunc(net * 22, 78);
    return { deduction, net, local, total: net + local };
  };
  const result = calc(method);
  const payableNational = result.net - interimNational;
  const payableLocal = result.local - interimLocal;

  // 課税売上割合（一般課税で全額控除できるのは95%以上・課税売上高5億円以下のとき）
  const taxableNet = trunc(b.sales10 * 100, 110) + trunc(b.sales8 * 100, 108) + b.export;
  const allSales = taxableNet + b.exemptSales;
  const warnings = [];
  if (method === 'general' && allSales > 0 && taxableNet * 100 < allSales * 95) warnings.push('課税売上割合が95%未満のため、仕入税額の全額は控除できません（個別対応方式・一括比例配分方式には対応していません）');
  if (method === 'general' && taxableNet > 500000000) warnings.push('課税売上高が5億円を超えるため、仕入税額の全額は控除できません（対応していません）');
  if (period.endDate >= '2027-04-01' && b.sales8) warnings.push('令和9年4月1日以後の飲食料品の税率の引き下げには、まだ対応していません');
  if (method !== 'general' && transitional.length) warnings.push('インボイスのない仕入の経過措置は一般課税だけで使います（この方法では仕入の税額を使いません）');
  const unavailable = methodAvailability(method, period, entityType);

  return {
    method,
    businessType: type,
    buckets: b,
    base10,
    base8,
    salesTax10,
    salesTax8,
    salesTax,
    purchaseTax10,
    purchaseTax8,
    transitional,
    ...result,
    interimNational,
    interimLocal,
    payableNational,
    payableLocal,
    payable: payableNational + payableLocal,
    taxableRatio: allSales > 0 ? taxableNet / allSales : null,
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
