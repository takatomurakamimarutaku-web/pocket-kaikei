// 経営サポート：納税予測（純粋関数）
//
// 着地見込みの仕訳（実績＋予測）を、申告の画面と同じ計算にそのまま渡して税額を出す。
// 税率・控除などの判断は既存の計算（corporate-tax.js・income-tax.js・enterprise-tax.js・tax-return.js）に任せ、ここでは持たない。
// 1. 消費税（課税事業者のとき）：消費税の申告計算の設定（period.taxReturn）で計算する。
//    決算整理の消費税等の仕訳がまだ無ければ、納める額を租税公課（決算整理）として利益から引く（税込経理の前提）
// 2. 法人：法人税・地方法人税・防衛特別法人税・住民税・事業税（法人税の申告の条件 period.corporateTax・period.enterpriseTax）
//    個人：所得税及び復興特別所得税（確定申告書の入力 period.incomeTaxReturn）・個人事業税（period.enterpriseTax）
// 住民税（個人）は所得控除が所得税と違うため、まだ計算しない（画面で案内する）
import { computeTaxReturn, consumptionTaxLines } from '../tax-return.js';
import { corporateTaxReturn, filingDeadline } from '../corporate-tax.js';
import { computeIncomeTax, rulesFor } from '../income-tax.js';
import { individualEnterpriseTax, DEFAULT_ENTERPRISE_TAX } from '../enterprise-tax.js';
import { blueReturnSet, realEstateForFirstTable } from '../real-estate.js';
import { isWhite, whiteReturnSet } from '../white-return.js';
import { buildStatements } from '../statements.js';
import { taxDueDate } from '../holidays.js';

/** 消費税の申告計算の設定（views/tax-return.js と同じ既定値） */
function taxReturnState(period) {
  const s = period.taxReturn || {};
  return {
    method: s.method || 'general',
    businessType: s.businessType || 5,
    allocation: s.allocation || 'proportional',
    interimNational: s.interimNational || 0,
    interimLocal: s.interimLocal || 0,
    salesCalc: s.salesCalc === 'stacked' ? 'stacked' : 'gross',
    purchaseCalc: s.salesCalc === 'stacked' || s.purchaseCalc === 'stacked' ? 'stacked' : 'gross',
    salesRounding: s.salesRounding || 'floor',
    purchaseRounding: s.purchaseRounding || 'floor',
  };
}

/** 確定申告書の第一表に入れる事業・不動産の数字（views/income-tax.js と同じ取り方） */
export function incomeSources({ settings, accounts, period, journals }) {
  if (isWhite(settings)) {
    const w = whiteReturnSet({ settings, accounts, period, journals });
    const re = w.realEstate;
    return {
      white: true,
      business: { revenue: w.general ? w.general.lines[4] : 0, income: w.general ? w.general.lines[21] : 0, familySalary: w.familyTotal, blueDeduction: 0 },
      realEstate: re ? { revenue: re.income, income: realEstateForFirstTable(re.lines[15], w.landInterest) } : null,
    };
  }
  const blue = blueReturnSet({ settings, accounts, period, journals });
  const is = blue.business;
  const re = blue.realEstate;
  return {
    white: false,
    business: { revenue: is.lines[1], income: is.lines[45], familySalary: is.lines[38] + (re ? re.lines[20] : 0), blueDeduction: is.lines[44] + (re ? re.lines[22] : 0) },
    realEstate: re ? { revenue: re.lines[4], income: realEstateForFirstTable(re.lines[23], blue.landInterest) } : null,
  };
}

/**
 * 納税予測
 * @param {object} p
 * @param {object} p.settings
 * @param {Array} p.accounts
 * @param {object} p.period
 * @param {Array} p.journals 着地見込みの仕訳（forecastLanding の journals）
 * @param {Array} p.actualJournals 帳簿の仕訳（決算整理の消費税等の仕訳があるかを見る）
 * @returns {{ items: Array<{ key, label, annual, interim, due, deadline, note? }>, total, consumption, journals, pl, pretax, afterTax, notes: string[] }}
 *   annual：年税額、interim：中間納付額、due：差引納付額（マイナスは還付）、deadline：納期限
 *   journals：消費税等の決算整理の見込みまで足した仕訳。pl：その損益計算書
 */
export function forecastTaxes({ settings, accounts, period, journals, actualJournals }) {
  const entityType = settings.entityType;
  const items = [];
  const notes = [];
  let all = journals;
  let consumption = null;

  // ---- 消費税 ----
  if (settings.taxStatus === 'taxable') {
    const state = taxReturnState(period);
    const r = computeTaxReturn({ journals, period, entityType, ...state });
    consumption = { method: r.method, total: r.total, payable: r.payable, warnings: r.warnings, compare: r.compare };
    const deadline = entityType === 'corporation' ? filingDeadline(period.endDate) : taxDueDate(`${Number(period.endDate.slice(0, 4)) + 1}-03-31`);
    items.push({ key: 'consumption', label: '消費税及び地方消費税', annual: r.total, interim: state.interimNational + state.interimLocal, due: r.payable, deadline });
    const booked = actualJournals.some((j) => j.source === 'consumption_tax');
    if (!booked && r.payable > 0) {
      const { lines } = consumptionTaxLines({ amount: r.payable, accounts });
      if (lines.length) all = [...journals, { id: 'forecast:consumption_tax', periodId: period.id, date: period.endDate, source: 'forecast', adjusting: true, lines }];
      notes.push('決算整理の消費税等の仕訳がまだ無いため、納める消費税等を租税公課として利益から引いて計算しています（税込経理）。');
    }
  } else {
    notes.push('免税事業者の設定なので、消費税は計算していません。');
  }
  const { pl } = buildStatements({ entityType, accounts, period, journals: all });

  // ---- 法人 ----
  if (entityType === 'corporation') {
    const r = corporateTaxReturn({ accounts, period, journals: all, input: period.corporateTax || {}, enterpriseInput: period.enterpriseTax || {} });
    const deadline = filingDeadline(period.endDate);
    for (const d of r.dues) items.push({ key: d.key, label: d.label, annual: d.annual, interim: d.interim, due: d.due, deadline });
    if (!r.supported) notes.push(...r.warnings.slice(0, 1));
    const incomeTaxes = r.dues.reduce((s, d) => s + d.annual, 0);
    const pretax = pl.profits.pretax;
    return { items, total: items.reduce((s, i) => s + i.due, 0), consumption, journals: all, pl, pretax, incomeTaxes, afterTax: pretax - incomeTaxes, taxableIncome: r.schedule4.income.total, notes };
  }

  // ---- 個人 ----
  const year = Number(period.endDate.slice(0, 4));
  const src = incomeSources({ settings, accounts, period, journals: all });
  let incomeTaxes = 0;
  if (rulesFor(year) && period.startDate.slice(0, 4) === period.endDate.slice(0, 4)) {
    const it = computeIncomeTax({ year, business: src.business, realEstate: src.realEstate, input: period.incomeTaxReturn || {}, white: src.white });
    const L = it.lines;
    // 年税額＝申告納税額㊿＋源泉徴収税額㊾。予定納税（㊿の内訳）を中間納付として引く
    items.push({ key: 'income', label: '所得税及び復興特別所得税', annual: L[46], interim: L[49] + L[51], due: L[52] - L[53], deadline: taxDueDate(`${year + 1}-03-15`) });
    incomeTaxes += L[46];
  } else {
    notes.push(`令和${year - 2018}年分の所得税の計算にはまだ対応していません。`);
  }
  const ent = { ...DEFAULT_ENTERPRISE_TAX, ...(period.enterpriseTax || {}) };
  const et = individualEnterpriseTax({ income: pl.profits.businessIncome, industry: ent.industry, months: ent.months, lossCarry: ent.lossCarry });
  if (!et.exempt) {
    items.push({ key: 'enterprise', label: '個人事業税', annual: et.tax, interim: 0, due: et.tax, deadline: `${year + 1}-08-31`, note: et.second ? `8月と11月の2回払い（第1期 ${et.first.toLocaleString('ja-JP')}円）` : '8月に納付（都道府県で日付が違う）' });
    incomeTaxes += et.tax;
  }
  notes.push('住民税はまだ計算していません（翌年6月から納付）。');
  const pretax = pl.netIncome;
  return { items, total: items.reduce((s, i) => s + i.due, 0), consumption, journals: all, pl, pretax, incomeTaxes, afterTax: pretax - incomeTaxes, taxableIncome: null, notes };
}
