// 年末調整（純粋関数）：申告書の内容と1年分の給与から、年調年税額と過不足額を求める
//
// 対応は令和8年分だけ（令和8年度税制改正の後の金額。令和8年12月1日施行・令和8年分以後に適用）
//   令和8年分 年末調整のしかた：https://www.nta.go.jp/users/gensen/nencho/index/shikata.htm
//   昨年と比べて変わった点：https://www.nta.go.jp/publication/pamph/gensen/nencho2026/pdf/102.pdf
//   基礎控除の引上げ等 Q&A：https://www.nta.go.jp/users/gensen/2026kiso/pdf/0026005-024.pdf
// 令和9年分は、ひとり親控除が38万円になり（Q&A Q3-2）、防衛特別所得税が始まるため、国税庁の資料が出てから足す
//
// 1. 給与所得控除後の給与等の金額：「令和8年分の年末調整等のための給与所得控除後の給与等の金額の表」
//    https://www.nta.go.jp/publication/pamph/gensen/nencho2026/pdf/114.pdf
//    741,000円未満は0、2,191,000円未満は収入−740,000円、2,200,000円未満は3区分の定額、
//    6,600,000円未満は4,000円刻み（2,200,000円以上は×70%−80,000円、3,600,000円以上は×80%−440,000円）、
//    6,600,000円以上は×90%−1,100,000円（1円未満切捨て）、8,500,000円以上は−1,950,000円
// 2. 所得金額調整控除：（給与の収入金額（1,000万円が上限）−850万円）×10%（1円未満切上げ）。本人・同一生計配偶者・扶養親族が
//    特別障害者か、23歳未満の扶養親族がいるとき（109.pdf）
// 3. 所得控除
//    基礎控除（No.1199）：合計所得金額 489万円以下104万円／655万円以下67万円／2,350万円以下62万円／2,400万円以下48万円／
//      2,450万円以下32万円／2,500万円以下16万円 https://www.nta.go.jp/taxes/shiraberu/taxanswer/shotoku/1199.htm
//    配偶者控除・配偶者特別控除（No.1195）：配偶者の合計所得金額62万円以下が配偶者控除、62万円超133万円以下が配偶者特別控除
//      https://www.nta.go.jp/taxes/shiraberu/taxanswer/shotoku/1195.htm
//    扶養控除：一般38万円・特定扶養（19歳以上23歳未満）63万円・老人扶養（70歳以上）48万円・同居老親等58万円。所得要件62万円以下
//    特定親族特別控除（No.1177）：19歳以上23歳未満で合計所得金額62万円超123万円以下 https://www.nta.go.jp/taxes/shiraberu/taxanswer/shotoku/1177.htm
//    障害者控除27万円・特別障害者40万円・同居特別障害者75万円、寡婦控除27万円、ひとり親控除35万円（本人の合計所得金額500万円以下）、
//    勤労学生控除27万円（合計所得金額89万円以下で、給与所得等以外の所得が10万円以下）（105.pdf）
//    生命保険料控除（No.1140・107.pdf）：新契約は計算式Ⅰ、23歳未満の扶養親族がいる場合の一般の新生命保険料は計算式Ⅱ（上限6万円）、
//      旧契約は計算式Ⅲ。合計の上限12万円。1円未満切上げ https://www.nta.go.jp/taxes/shiraberu/taxanswer/shotoku/1140.htm
//    地震保険料控除：地震保険料は全額（上限5万円）、旧長期損害保険料は1万円以下全額・2万円以下×1/2＋5千円・超は1万5千円、合わせて上限5万円
//    年齢は12月31日現在（16歳以上＝平成23年1月1日以前生、特定扶養＝平成16年1月2日〜平成20年1月1日生、70歳以上＝昭和32年1月1日以前生）
// 4. 課税給与所得金額（1,000円未満切捨て）→ 算出所得税額（年末調整のための算出所得税額の速算表 115.pdf）
//    → 住宅借入金等特別控除（引ききれない額は切捨て）→ 年調所得税額 ×102.1% → 年調年税額（100円未満切捨て）
//    https://www.nta.go.jp/publication/pamph/gensen/nencho2026/pdf/115.pdf
//    課税給与所得金額が18,050,000円を超える人・給与の収入金額が2,000万円を超える人は年末調整をしない
import { isValidDate } from './period.js';
import { isYen } from './money.js';
import { payrollTotals, MAX_NAME, MAX_NOTE } from './payroll.js';

export const MAX_AMOUNT = 99_999_999;
export const MAX_FAMILY = 20;
export const MAX_RELATION = 10;

export const DISABILITIES = [
  { id: 'none', label: 'なし' },
  { id: 'general', label: '障害者' },
  { id: 'special', label: '特別障害者' },
  { id: 'special_cohabiting', label: '同居特別障害者' },
];
export const DISABILITY_LABEL = Object.fromEntries(DISABILITIES.map((d) => [d.id, d.label]));
export const WIDOW_KINDS = [
  { id: 'none', label: 'なし' },
  { id: 'widow', label: '寡婦' },
  { id: 'single_parent', label: 'ひとり親' },
];
export const YEAR_END_STATUS = { draft: '下書き', fixed: '確定', settled: '精算済み' };

/** 年分ごとの金額 */
const RULES = {
  2026: {
    basic: [
      [4_890_000, 1_040_000],
      [6_550_000, 670_000],
      [23_500_000, 620_000],
      [24_000_000, 480_000],
      [24_500_000, 320_000],
      [25_000_000, 160_000],
    ],
    dependentIncome: 620_000,
    specificMax: 1_230_000,
    spouseSpecialMax: 1_330_000,
    studentIncome: 890_000,
    singleParent: 350_000,
    widow: 270_000,
    salaryIncome(x) {
      if (x < 741_000) return 0;
      if (x < 2_191_000) return x - 740_000;
      if (x < 2_193_000) return 1_451_000;
      if (x < 2_196_000) return 1_453_000;
      if (x < 2_200_000) return 1_456_000;
      if (x < 6_600_000) {
        const a = Math.floor(x / 4000) * 4000;
        return x < 3_600_000 ? (a * 7) / 10 - 80_000 : (a * 8) / 10 - 440_000;
      }
      if (x < 8_500_000) return Math.floor((x * 9) / 10) - 1_100_000;
      return x - 1_950_000;
    },
  },
};

/** 扶養親族などの合計所得金額の要件（計算できない年分は null） */
export function dependentIncomeLimit(year) {
  return RULES[year]?.dependentIncome ?? null;
}

/** 年末調整を計算できる年分 */
export function supportedYearEndYears() {
  return Object.keys(RULES).map(Number);
}

/** 給与所得控除後の給与等の金額（年末調整等のための表）。計算できない年分は null */
export function salaryIncomeAfterDeduction(pay, year) {
  const r = RULES[year];
  return r ? r.salaryIncome(Math.max(0, pay)) : null;
}

/** 12月31日現在の年齢（年齢計算ニ関スル法律：誕生日の前日に年をとる） */
export function ageAtYearEnd(birthDate, year) {
  if (!isValidDate(birthDate)) return null;
  const [y, m, d] = birthDate.split('-').map(Number);
  // 1月1日生まれの人は前年の12月31日に年をとるため、12月31日現在の年齢は「年−生年」に1を足す
  return year - y + (m === 1 && d === 1 ? 1 : 0);
}

/** 基礎控除 */
export function basicDeductionYE(totalIncome, year) {
  const row = RULES[year].basic.find(([max]) => totalIncome <= max);
  return row ? row[1] : 0;
}

const SPOUSE_COLUMNS = [9_000_000, 9_500_000, 10_000_000];
const SPOUSE_DEDUCTION = [380_000, 260_000, 130_000];
const SPOUSE_ELDERLY = [480_000, 320_000, 160_000];
const SPOUSE_SPECIAL = [
  [950_000, [380_000, 260_000, 130_000]],
  [1_000_000, [360_000, 240_000, 120_000]],
  [1_050_000, [310_000, 210_000, 110_000]],
  [1_100_000, [260_000, 180_000, 90_000]],
  [1_150_000, [210_000, 140_000, 70_000]],
  [1_200_000, [160_000, 110_000, 60_000]],
  [1_250_000, [110_000, 80_000, 40_000]],
  [1_300_000, [60_000, 40_000, 20_000]],
  [1_330_000, [30_000, 20_000, 10_000]],
];

/**
 * 配偶者控除・配偶者特別控除
 * @returns {{ kind: 'spouse'|'special'|null, amount: number, elderly: boolean, sameLiving: boolean }}
 *   sameLiving：同一生計配偶者（所得要件を満たす。本人の所得が1,000万円を超えて控除が無いときも障害者控除の対象）
 */
export function spouseDeduction(ownIncome, spouse, year) {
  const none = { kind: null, amount: 0, elderly: false, sameLiving: false };
  if (!spouse) return none;
  const r = RULES[year];
  const income = spouse.income || 0;
  const elderly = (ageAtYearEnd(spouse.birthDate, year) ?? 0) >= 70;
  const sameLiving = income <= r.dependentIncome;
  const col = SPOUSE_COLUMNS.findIndex((max) => ownIncome <= max);
  if (col < 0) return { ...none, elderly, sameLiving };
  if (sameLiving) return { kind: 'spouse', amount: (elderly ? SPOUSE_ELDERLY : SPOUSE_DEDUCTION)[col], elderly, sameLiving };
  const row = SPOUSE_SPECIAL.find(([max]) => income <= max);
  return row ? { kind: 'special', amount: row[1][col], elderly, sameLiving } : { ...none, elderly };
}

const SPECIFIC_RELATIVE = [
  [850_000, 630_000],
  [900_000, 610_000],
  [950_000, 510_000],
  [1_000_000, 410_000],
  [1_050_000, 310_000],
  [1_100_000, 210_000],
  [1_150_000, 110_000],
  [1_200_000, 60_000],
  [1_230_000, 30_000],
];

/** 特定親族特別控除（合計所得金額が62万円超123万円以下の19歳以上23歳未満の親族） */
export function specificRelativeDeduction(income, year) {
  const r = RULES[year];
  if (income <= r.dependentIncome || income > r.specificMax) return 0;
  return SPECIFIC_RELATIVE.find(([max]) => income <= max)[1];
}

/**
 * 扶養親族の区分
 * @returns {'young'|'general'|'specific'|'elderly'|'elderly_cohabiting'|'specific_relative'|'over'|'other'}
 *   young：16歳未満（扶養控除なし）、specific_relative：特定親族（特定親族特別控除）、over：所得が多く対象外、
 *   other：他の人の扶養控除の対象にしている
 */
export function dependentClass(d, year) {
  const r = RULES[year];
  const age = ageAtYearEnd(d.birthDate, year) ?? 0;
  const income = d.income || 0;
  if (d.claimedByOther) return 'other';
  if (income > r.dependentIncome) return age >= 19 && age < 23 && income <= r.specificMax ? 'specific_relative' : 'over';
  if (age < 16) return 'young';
  if (age >= 19 && age < 23) return 'specific';
  if (age >= 70) return d.parentCohabiting ? 'elderly_cohabiting' : 'elderly';
  return 'general';
}

export const DEPENDENT_CLASS_LABEL = {
  young: '16歳未満（扶養控除なし）',
  general: '一般の控除対象扶養親族',
  specific: '特定扶養親族',
  elderly: '老人扶養親族',
  elderly_cohabiting: '老人扶養親族（同居老親等）',
  specific_relative: '特定親族（特定親族特別控除）',
  over: '所得が多いため対象外',
  other: '他の人の扶養控除の対象',
};
const DEPENDENT_AMOUNT = { general: 380_000, specific: 630_000, elderly: 480_000, elderly_cohabiting: 580_000 };
const DISABILITY_AMOUNT = { general: 270_000, special: 400_000, special_cohabiting: 750_000 };

/** 23歳未満の扶養親族（所得要件を満たす。他の人の扶養控除の対象にしている子も含む） */
function under23(d, year) {
  return (ageAtYearEnd(d.birthDate, year) ?? 99) < 23 && (d.income || 0) <= RULES[year].dependentIncome;
}

const ceilDiv = (a, b) => Math.ceil(a / b);
const lifeNew = (x) => (x <= 20_000 ? x : x <= 40_000 ? ceilDiv(x, 2) + 10_000 : x <= 80_000 ? ceilDiv(x, 4) + 20_000 : 40_000);
const lifeNewU23 = (x) => (x <= 30_000 ? x : x <= 60_000 ? ceilDiv(x, 2) + 15_000 : x <= 120_000 ? ceilDiv(x, 4) + 30_000 : 60_000);
const lifeOld = (x) => (x <= 25_000 ? x : x <= 50_000 ? ceilDiv(x, 2) + 12_500 : x <= 100_000 ? ceilDiv(x, 4) + 25_000 : 50_000);
/** 新契約と旧契約の両方があるときは、合計（上限 cap）か旧契約だけの額の大きい方 */
const combine = (n, o, cap, hasNew, hasOld) => (hasNew && hasOld ? Math.max(o, Math.min(n + o, cap)) : hasNew ? n : o);

/**
 * 生命保険料控除
 * @param {{ lifeNew, lifeOld, care, pensionNew, pensionOld }} ins 年間の保険料（円）
 * @param {{ under23: boolean }} o 23歳未満の扶養親族がいる（一般の新生命保険料に計算式Ⅱ）
 * @returns {{ general, care, pension, total }}
 */
export function lifeInsuranceDeduction(ins, { under23: u23 = false } = {}) {
  const ln = ins.lifeNew || 0;
  const lo = ins.lifeOld || 0;
  const pn = ins.pensionNew || 0;
  const po = ins.pensionOld || 0;
  const general = combine((u23 ? lifeNewU23 : lifeNew)(ln), lifeOld(lo), u23 ? 60_000 : 40_000, ln > 0, lo > 0);
  const care = lifeNew(ins.care || 0);
  const pension = combine(lifeNew(pn), lifeOld(po), 40_000, pn > 0, po > 0);
  return { general, care, pension, total: Math.min(general + care + pension, 120_000) };
}

/** 地震保険料控除 */
export function earthquakeDeduction(ins) {
  const e = Math.min(ins.earthquake || 0, 50_000);
  const o = ins.oldLongTerm || 0;
  const old = o <= 10_000 ? o : o <= 20_000 ? ceilDiv(o, 2) + 5_000 : 15_000;
  return Math.min(e + old, 50_000);
}

const TAX_TABLE = [
  [1_950_000, 5, 0],
  [3_300_000, 10, 97_500],
  [6_950_000, 20, 427_500],
  [9_000_000, 23, 636_000],
  [18_000_000, 33, 1_536_000],
  [18_050_000, 40, 2_796_000],
];

/** 算出所得税額（年末調整のための速算表）。18,050,000円を超えるときは null（年末調整の対象外） */
export function calculatedIncomeTax(taxable) {
  const row = TAX_TABLE.find(([max]) => taxable <= max);
  return row ? (taxable * row[1]) / 100 - row[2] : null;
}

/** 年調年税額：年調所得税額×102.1%（100円未満切捨て） */
export function annualTaxWithSurtax(incomeTax) {
  return Math.floor((incomeTax * 1021) / 100_000) * 100;
}

/**
 * その年の給与の集計（支給日がその年の給与・賞与。仕訳を登録していないものも含める）
 * 年末調整の過不足（yearEndTax）は含めない
 */
export function yearPayTotals(payrolls, employeeId, year) {
  const list = payrolls.filter((p) => p.employeeId === employeeId && p.payDate.startsWith(`${year}-`));
  let pay = 0;
  let social = 0;
  let tax = 0;
  for (const p of list) {
    const t = payrollTotals(p);
    pay += t.taxable;
    social += t.social;
    tax += p.incomeTax || 0;
  }
  return {
    pay,
    social,
    tax,
    count: list.length,
    salaryCount: list.filter((p) => p.kind === 'salary').length,
    bonusCount: list.filter((p) => p.kind === 'bonus').length,
    unposted: list.filter((p) => !p.journalId).length,
    otsu: list.filter((p) => p.taxColumn === 'otsu').length,
  };
}

/**
 * 年末調整の計算
 * @param {object} ye 年末調整の入力（yearEndDraft の形）
 * @param {{ payrolls: Array, employee: object }} ctx
 * @returns {object} 計算の結果。eligible が false のときは reasons に理由
 */
export function yearEndCalc(ye, { payrolls, employee }) {
  const year = ye.year;
  const r = RULES[year];
  const sum = yearPayTotals(payrolls, ye.employeeId, year);
  const prev = ye.previous || {};
  const pay = sum.pay + (prev.pay || 0);
  const withheld = sum.tax + (prev.tax || 0);
  const reasons = [];
  const warnings = [];
  if (!r) return { year, eligible: false, reasons: [`${year}年分の年末調整には対応していません`], warnings, sum, pay, withheld };
  if (employee?.taxColumn === 'otsu') reasons.push('乙欄の人（扶養控除等申告書を出していない人）は年末調整をしません');
  if (pay > 20_000_000) reasons.push('給与の収入金額が2,000万円を超える人は年末調整をしません（本人が確定申告をします）');
  if (pay <= 0) reasons.push(`${year}年に支払った給与がありません`);
  if (sum.otsu) warnings.push(`乙欄で計算した給与が${sum.otsu}件あります。扶養控除等申告書を出した後の給与だけで年末調整をするときは、前職分の欄などで調整してください`);
  if (sum.unposted) warnings.push(`仕訳を登録していない給与が${sum.unposted}件あります（年末調整には含めています）`);
  if (employee && employee.active === false) warnings.push('年の中途で退職した人は、原則として年末調整をしません（死亡退職や、12月の給与を受け取ってからの退職などは対象です）');

  const salaryIncome = r.salaryIncome(pay);
  const person = ye.person || {};
  const spouse = ye.spouse || null;
  const deps = ye.dependents || [];
  const classes = deps.map((d) => dependentClass(d, year));
  const deductible = deps.filter((_, i) => !['over', 'other', 'specific_relative'].includes(classes[i]));
  const hasUnder23 = deps.some((d) => under23(d, year));
  const spouseSameLiving = !!spouse && (spouse.income || 0) <= r.dependentIncome;
  // 所得金額調整控除は、扶養控除を他の人（配偶者など）が受けている扶養親族でも対象になる
  const lowIncome = deps.filter((d) => (d.income || 0) <= r.dependentIncome);
  const adjustEligible = person.disability === 'special' || (spouseSameLiving && spouse.disability?.startsWith('special')) || lowIncome.some((d) => d.disability?.startsWith('special')) || hasUnder23;
  const adjustment = adjustEligible && pay > 8_500_000 ? ceilDiv(Math.min(pay, 10_000_000) - 8_500_000, 10) : 0;
  const afterAdjust = salaryIncome - adjustment;
  const otherIncome = person.otherIncome || 0;
  const totalIncome = afterAdjust + otherIncome;

  // 所得控除
  const ins = ye.insurance || {};
  const socialPay = sum.social + (prev.social || 0);
  const social = socialPay + (ins.socialDeclared || 0);
  const smallBusiness = ins.smallBusiness || 0;
  const life = lifeInsuranceDeduction(ins, { under23: hasUnder23 });
  const earthquake = earthquakeDeduction(ins);
  const sp = spouseDeduction(totalIncome, spouse, year);
  const dep = { general: 0, specific: 0, elderly: 0, elderly_cohabiting: 0, young: 0 };
  let dependentsAmount = 0;
  let specificRelative = 0;
  let specificRelativeCount = 0;
  deps.forEach((d, i) => {
    const c = classes[i];
    if (c in dep) dep[c] += 1;
    dependentsAmount += DEPENDENT_AMOUNT[c] || 0;
    if (c === 'specific_relative') {
      specificRelative += specificRelativeDeduction(d.income || 0, year);
      specificRelativeCount += 1;
    }
  });
  // 障害者控除：本人・同一生計配偶者・扶養親族（16歳未満を含む）
  const disabledPeople = [person.disability === 'special_cohabiting' ? 'special' : person.disability, spouseSameLiving ? spouse.disability : 'none', ...deductible.map((d) => d.disability)];
  const disability = disabledPeople.reduce((s, k) => s + (DISABILITY_AMOUNT[k] || 0), 0);
  let widow = 0;
  if (person.widow && person.widow !== 'none') {
    if (totalIncome > 5_000_000) warnings.push('本人の合計所得金額が500万円を超えるため、寡婦控除・ひとり親控除は受けられません');
    else widow = person.widow === 'single_parent' ? r.singleParent : r.widow;
  }
  let student = 0;
  if (person.student) {
    if (totalIncome > r.studentIncome || otherIncome > 100_000) warnings.push(`本人の合計所得金額が${r.studentIncome / 10_000}万円を超えるか、給与以外の所得が10万円を超えるため、勤労学生控除は受けられません`);
    else student = 270_000;
  }
  if (spouse && !sp.kind && !sp.sameLiving) warnings.push(spouse.income > r.spouseSpecialMax ? '配偶者の合計所得金額が133万円を超えるため、配偶者（特別）控除は受けられません' : '本人の合計所得金額が1,000万円を超えるため、配偶者（特別）控除は受けられません');
  else if (spouse && !sp.kind && sp.sameLiving) warnings.push('本人の合計所得金額が1,000万円を超えるため、配偶者控除は受けられません（障害者控除は受けられます）');
  deps.forEach((d, i) => {
    if (classes[i] === 'over') warnings.push(`${d.name || `扶養親族${i + 1}`}：合計所得金額が多いため、扶養控除・特定親族特別控除の対象になりません`);
  });
  const basic = basicDeductionYE(totalIncome, year);
  const lines = { social, socialPay, socialDeclared: ins.socialDeclared || 0, smallBusiness, life: life.total, earthquake, spouse: sp.amount, dependents: dependentsAmount, specificRelative, disability, widow, student, basic };
  const totalDeductions = social + smallBusiness + life.total + earthquake + sp.amount + dependentsAmount + specificRelative + disability + widow + student + basic;
  const taxable = Math.max(0, Math.floor((afterAdjust - totalDeductions) / 1000) * 1000);
  const calculated = calculatedIncomeTax(taxable);
  if (calculated == null) reasons.push('課税給与所得金額が18,050,000円を超える人は年末調整をしません');
  const housingPossible = ye.housingLoan || 0;
  const housing = Math.min(housingPossible, calculated ?? 0);
  const incomeTax = (calculated ?? 0) - housing;
  const annualTax = annualTaxWithSurtax(incomeTax);
  const counts = {
    specific: dep.specific,
    elderlyCohabiting: dep.elderly_cohabiting,
    elderly: dep.elderly + dep.elderly_cohabiting,
    general: dep.general,
    young: dep.young,
    specificRelative: specificRelativeCount,
    disabledSpecial: [spouseSameLiving ? spouse : null, ...deductible].filter((x) => x && x.disability?.startsWith('special')).length,
    disabledSpecialCohabiting: [spouseSameLiving ? spouse : null, ...deductible].filter((x) => x && x.disability === 'special_cohabiting').length,
    disabledOther: [spouseSameLiving ? spouse : null, ...deductible].filter((x) => x && x.disability === 'general').length,
    nonResident: [sp.kind ? spouse : null, ...deductible].filter((x) => x && x.nonResident).length,
  };
  return {
    year,
    eligible: reasons.length === 0,
    reasons,
    warnings,
    sum,
    pay,
    withheld,
    salaryIncome,
    adjustment,
    afterAdjust,
    otherIncome,
    totalIncome,
    hasUnder23,
    lifeDetail: life,
    spouseKind: sp.kind,
    spouseElderly: sp.elderly,
    spouseSameLiving,
    classes,
    counts,
    lines,
    totalDeductions,
    taxable,
    calculated: calculated ?? 0,
    housingPossible,
    housing,
    incomeTax,
    annualTax,
    diff: annualTax - withheld,
  };
}

/** 確定のときに残す結果（源泉徴収票などに使う）。給与が変わったかを比べるための値を含む */
export function yearEndSnapshot(result) {
  const keys = ['pay', 'withheld', 'salaryIncome', 'adjustment', 'afterAdjust', 'totalIncome', 'spouseKind', 'spouseElderly', 'spouseSameLiving', 'counts', 'lines', 'lifeDetail', 'totalDeductions', 'taxable', 'calculated', 'housingPossible', 'housing', 'incomeTax', 'annualTax', 'diff'];
  return structuredClone(Object.fromEntries(keys.map((k) => [k, result[k]])));
}

/** 確定した結果と、今の給与で計算し直した結果の違い（違いが無ければ空の配列） */
export function snapshotChanges(snapshot, result) {
  if (!snapshot) return [];
  const out = [];
  for (const [k, label] of [
    ['pay', '給与の支払額'],
    ['withheld', '徴収した税額'],
    ['totalDeductions', '所得控除の合計'],
    ['annualTax', '年調年税額'],
  ]) {
    if (snapshot[k] !== result[k]) out.push({ key: k, label, before: snapshot[k], after: result[k] });
  }
  return out;
}

// ---- 入力 ----

const isAmount = (n) => isYen(n) && n >= 0 && n <= MAX_AMOUNT;
const len = (v) => String(v ?? '').length;

/** 年末調整の入力の初期値。前の年の記録があれば、本人・配偶者・扶養親族の内容を引き継ぐ（保険料などは毎年入れ直す） */
export function yearEndDraft(employee, year, prev = null) {
  return {
    employeeId: employee.id,
    year,
    status: 'draft',
    person: prev ? structuredClone(prev.person) : { disability: 'none', widow: 'none', student: false, otherIncome: 0 },
    spouse: prev?.spouse ? structuredClone(prev.spouse) : null,
    dependents: prev ? structuredClone(prev.dependents || []) : [],
    insurance: { lifeNew: 0, lifeOld: 0, care: 0, pensionNew: 0, pensionOld: 0, earthquake: 0, oldLongTerm: 0, socialDeclared: 0, nationalPension: 0, smallBusiness: 0 },
    housingLoan: 0,
    previous: { name: '', pay: 0, social: 0, tax: 0, retiredOn: '' },
    note: '',
    result: null,
    settledPayrollId: null,
  };
}

/** 配偶者・扶養親族の初期値 */
export function familyDraft() {
  return { name: '', relation: '', birthDate: '', income: 0, disability: 'none', parentCohabiting: false, nonResident: false, claimedByOther: false };
}

const INSURANCE_KEYS = [
  ['lifeNew', '一般の生命保険料（新）'],
  ['lifeOld', '一般の生命保険料（旧）'],
  ['care', '介護医療保険料'],
  ['pensionNew', '個人年金保険料（新）'],
  ['pensionOld', '個人年金保険料（旧）'],
  ['earthquake', '地震保険料'],
  ['oldLongTerm', '旧長期損害保険料'],
  ['socialDeclared', '申告による社会保険料'],
  ['nationalPension', '国民年金保険料等'],
  ['smallBusiness', '小規模企業共済等掛金'],
];

/**
 * 年末調整の入力の検証。エラーメッセージの配列
 */
export function validateYearEnd(ye) {
  const errors = [];
  if (!ye || typeof ye !== 'object') return ['年末調整のデータが不正です'];
  if (!ye.employeeId || typeof ye.employeeId !== 'string') errors.push('従業員が不正です');
  if (!Number.isInteger(ye.year) || ye.year < 2000 || ye.year > 2100) errors.push('年分が不正です');
  if (!YEAR_END_STATUS[ye.status]) errors.push('年末調整の状態が不正です');
  const p = ye.person || {};
  if (!['none', 'general', 'special'].includes(p.disability)) errors.push('本人の障害者の区分が不正です');
  if (!WIDOW_KINDS.some((w) => w.id === p.widow)) errors.push('寡婦・ひとり親の区分が不正です');
  if (!isAmount(p.otherIncome ?? 0)) errors.push('給与以外の所得の見積額は0以上の整数で入力してください');
  const family = (x, who) => {
    if (len(String(x.name ?? '').trim()) === 0 || len(x.name) > MAX_NAME) errors.push(`${who}の氏名を${MAX_NAME}文字以内で入力してください`);
    if (len(x.relation) > MAX_RELATION) errors.push(`${who}の続柄は${MAX_RELATION}文字以内にしてください`);
    if (!isValidDate(x.birthDate)) errors.push(`${who}の生年月日を入力してください`);
    if (!isAmount(x.income ?? 0)) errors.push(`${who}の合計所得金額の見積額は0以上の整数で入力してください`);
    if (!DISABILITY_LABEL[x.disability]) errors.push(`${who}の障害者の区分が不正です`);
  };
  if (ye.spouse) family(ye.spouse, '配偶者');
  if (!Array.isArray(ye.dependents)) errors.push('扶養親族のデータが不正です');
  else {
    if (ye.dependents.length > MAX_FAMILY) errors.push(`扶養親族などは${MAX_FAMILY}人までです`);
    ye.dependents.forEach((d, i) => family(d, d?.name ? String(d.name) : `扶養親族${i + 1}`));
  }
  const ins = ye.insurance || {};
  for (const [k, label] of INSURANCE_KEYS) if (!isAmount(ins[k] ?? 0)) errors.push(`${label}は0以上の整数で入力してください`);
  // 国民年金保険料等（所得税法第196条第2項の書類を添付した社会保険料）は、申告による社会保険料の内数（源泉徴収票の「国民年金保険料等の金額」）
  if (isAmount(ins.nationalPension ?? 0) && (ins.nationalPension ?? 0) > (ins.socialDeclared ?? 0)) errors.push('国民年金保険料等は申告による社会保険料のうちの金額です（申告による社会保険料以下にしてください）');
  if (!isAmount(ye.housingLoan ?? 0)) errors.push('住宅借入金等特別控除の額は0以上の整数で入力してください');
  const prev = ye.previous || {};
  for (const [k, label] of [
    ['pay', '前職の支払金額'],
    ['social', '前職の社会保険料'],
    ['tax', '前職の源泉徴収税額'],
  ]) {
    if (!isAmount(prev[k] ?? 0)) errors.push(`${label}は0以上の整数で入力してください`);
  }
  if (len(prev.name) > MAX_NAME) errors.push(`前職の支払者の名前は${MAX_NAME}文字以内にしてください`);
  if (prev.retiredOn && !isValidDate(prev.retiredOn)) errors.push('前職を辞めた日が不正です');
  if (len(ye.note) > MAX_NOTE) errors.push(`メモは${MAX_NOTE}文字以内にしてください`);
  if (ye.status !== 'draft' && !ye.result) errors.push('確定した年末調整に計算の結果がありません');
  if (ye.status === 'settled' && !ye.settledPayrollId) errors.push('精算した給与がありません');
  return errors;
}

/** 年末調整の一覧の CSV */
export function yearEndCsvRows(list) {
  const rows = [['年分', '氏名', '状態', '給与の支払額', '給与所得控除後の金額（調整控除後）', '社会保険料等', '生命保険料控除', '地震保険料控除', '配偶者（特別）控除', '扶養控除', '特定親族特別控除', '障害者等の控除', '基礎控除', '所得控除の合計', '課税給与所得金額', '算出所得税額', '住宅借入金等特別控除', '年調年税額', '徴収した税額', '過不足額（＋は徴収・△は還付）']];
  for (const { ye, name, result: r } of list) {
    if (!r || r.lines == null) continue;
    const l = r.lines;
    rows.push([ye.year, name, YEAR_END_STATUS[ye.status], r.pay, r.afterAdjust, l.social + l.smallBusiness, l.life, l.earthquake, l.spouse, l.dependents, l.specificRelative, l.disability + l.widow + l.student, l.basic, r.totalDeductions, r.taxable, r.calculated, r.housing, r.annualTax, r.withheld, r.diff]);
  }
  return rows;
}
