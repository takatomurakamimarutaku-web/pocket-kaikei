// 所得税及び復興特別所得税の確定申告書（個人）：第一表・第二表の欄の計算（純粋関数）
//
// 出典（2026-10-29 確認）
// - 税率：国税庁 No.2260 所得税の税率（速算表。課税される所得金額は1,000円未満切捨て）
//   https://www.nta.go.jp/taxes/shiraberu/taxanswer/shotoku/2260.htm
// - 令和8年分の改正（基礎控除の引上げ・給与所得控除の最低保障額74万円・扶養親族等の所得要件62万円・勤労学生89万円・
//   特定親族特別控除と配偶者特別控除の表）：国税庁「令和８年度税制改正による所得税の基礎控除の引上げ等について」と
//   パンフレット「令和8年4月以降の源泉徴収事務の変更点」、財務省「令和８年度税制改正の大綱の概要」
//   https://www.nta.go.jp/users/gensen/2026kiso/index.htm
//   基礎控除：62万円＋特例の加算（令和8・9年分：合計所得489万円以下は42万円、655万円以下は5万円）
// - 令和7年分：基礎控除 58万円＋加算（132万円以下37万円・336万円以下30万円・489万円以下10万円・655万円以下5万円）、
//   給与所得控除の最低保障額65万円、扶養親族等の所得要件58万円、勤労学生85万円
// - 生命保険料控除：国税庁 No.1140（令和8年分から、23歳未満の扶養親族がいると新生命保険料の上限6万円）
//   https://www.nta.go.jp/taxes/shiraberu/taxanswer/shotoku/1140.htm
// - 地震保険料控除：国税庁 No.1145
//   https://www.nta.go.jp/taxes/shiraberu/taxanswer/shotoku/1145.htm
// - 復興特別所得税：基準所得税額の2.1%（確定申告の手引き）。申告納税額は100円未満切捨て
// 欄の番号は令和7年分の様式（特定親族特別控除の欄が加わり、基礎控除が㉕・控除の合計が㉚）に合わせた
import { isYen } from './money.js';

/** 対応している年分 */
export const SUPPORTED_YEARS = [2025, 2026];

const RULES = {
  2025: {
    salaryMin: 650000,
    basic: [[1320000, 950000], [3360000, 880000], [4890000, 680000], [6550000, 630000], [23500000, 580000]],
    dependentLimit: 580000,
    studentLimit: 850000,
    singleParent: 350000,
    lifeChildRule: false,
  },
  2026: {
    salaryMin: 740000,
    basic: [[4890000, 1040000], [6550000, 670000], [23500000, 620000]],
    dependentLimit: 620000,
    studentLimit: 890000,
    singleParent: 350000,
    lifeChildRule: true,
  },
};
const BASIC_HIGH = [[24000000, 480000], [24500000, 320000], [25000000, 160000]];

export function rulesFor(year) {
  return RULES[year] || null;
}

/** 速算表 */
export const TAX_TABLE = [
  [1949000, 5, 0],
  [3299000, 10, 97500],
  [6949000, 20, 427500],
  [8999000, 23, 636000],
  [17999000, 33, 1536000],
  [39999000, 40, 2796000],
  [Infinity, 45, 4796000],
];

const floor1000 = (n) => Math.floor(n / 1000) * 1000;
const floor100 = (n) => Math.floor(n / 100) * 100;

/** 課税される所得金額に対する税額 */
export function incomeTaxOn(taxable) {
  if (taxable <= 0) return 0;
  const [, rate, minus] = TAX_TABLE.find(([max]) => taxable <= max);
  return (taxable * rate) / 100 - minus;
}

/** 基礎控除 */
export function basicDeduction(totalIncome, year) {
  const r = rulesFor(year);
  const row = r.basic.find(([max]) => totalIncome <= max) || BASIC_HIGH.find(([max]) => totalIncome <= max);
  return row ? row[1] : 0;
}

/**
 * 給与所得（所得税法 第28条・別表第五。660万円未満は4,000円単位の表に合わせる）
 * 令和8・9年分は最低保障額74万円（収入219万1,000円〜220万円の特例の段を含む）
 */
export function salaryIncome(revenue, year) {
  const min = rulesFor(year).salaryMin;
  if (revenue <= 0) return 0;
  if (year >= 2026) {
    if (revenue < 741000) return 0;
    if (revenue < 2191000) return revenue - 740000;
    if (revenue < 2193000) return 1451000;
    if (revenue < 2196000) return 1453000;
    if (revenue < 2200000) return 1456000;
  } else {
    if (revenue < 651000) return 0;
    if (revenue < 1900000) return revenue - min;
  }
  const base = revenue < 6600000 ? Math.floor(revenue / 4000) * 4000 : revenue;
  let ded;
  if (base <= 3600000) ded = (base * 3) / 10 + 80000;
  else if (base <= 6600000) ded = (base * 2) / 10 + 440000;
  else if (base <= 8500000) ded = Math.floor(base / 10) + 1100000;
  else ded = 1950000;
  return Math.max(0, base - Math.max(min, ded));
}

/** 生命保険料の控除額（表の計算。1円未満は切り上げ） */
const newLife = (p, big = false) => {
  const k = big ? 1.5 : 1;
  if (p <= 20000 * k) return p;
  if (p <= 40000 * k) return Math.ceil(p / 2 + 10000 * k);
  if (p <= 80000 * k) return Math.ceil(p / 4 + 20000 * k);
  return 40000 * k;
};
const oldLife = (p) => (p <= 25000 ? p : p <= 50000 ? Math.ceil(p / 2 + 12500) : p <= 100000 ? Math.ceil(p / 4 + 25000) : 50000);

/**
 * 生命保険料控除（一般・介護医療・個人年金。合計12万円まで）
 * @param {{ newGeneral, oldGeneral, newMedical, newPension, oldPension }} p 年間の支払額
 * @param {boolean} childRule 令和8年分以後で23歳未満の扶養親族がいる（新生命保険料の上限6万円）
 */
export function lifeInsuranceDeduction(p, childRule = false) {
  const cap = childRule ? 60000 : 40000;
  const combine = (nw, old, big) => (old > 60000 ? Math.min(oldLife(old), big ? 60000 : 50000) : Math.min(newLife(nw, big) + oldLife(old), big ? 60000 : 40000));
  const general = p.oldGeneral || p.newGeneral ? (p.oldGeneral ? combine(p.newGeneral, p.oldGeneral, childRule) : Math.min(newLife(p.newGeneral, childRule), cap)) : 0;
  const medical = newLife(p.newMedical);
  const pension = p.oldPension || p.newPension ? (p.oldPension ? combine(p.newPension, p.oldPension, false) : newLife(p.newPension)) : 0;
  return { general, medical, pension, total: Math.min(general + medical + pension, 120000) };
}

/** 地震保険料控除（5万円まで） */
export function earthquakeDeduction({ quake = 0, oldLongTerm = 0 }) {
  const a = Math.min(quake, 50000);
  const b = oldLongTerm <= 10000 ? oldLongTerm : oldLongTerm <= 20000 ? Math.ceil(oldLongTerm / 2 + 5000) : 15000;
  return Math.min(a + b, 50000);
}

/** その年の12月31日の年齢（1月1日生まれは前日に1つ上がる） */
export function ageAtYearEnd(birthDate, year) {
  const by = Number(birthDate.slice(0, 4));
  return year - by + (birthDate.slice(5) === '01-01' ? 1 : 0);
}

/** 配偶者特別控除の表（配偶者の合計所得の上限、[本人900万円以下, 950万円以下, 1,000万円以下]） */
const SPOUSE_SPECIAL = [
  [950000, [380000, 260000, 130000]],
  [1000000, [360000, 240000, 120000]],
  [1050000, [310000, 210000, 110000]],
  [1100000, [260000, 180000, 90000]],
  [1150000, [210000, 140000, 70000]],
  [1200000, [160000, 110000, 60000]],
  [1250000, [110000, 80000, 40000]],
  [1300000, [60000, 40000, 20000]],
  [1330000, [30000, 20000, 10000]],
];
/** 特定親族特別控除の表（親族の合計所得の上限、控除額） */
const SPECIFIC_RELATIVE = [[850000, 630000], [900000, 610000], [950000, 510000], [1000000, 410000], [1050000, 310000], [1100000, 210000], [1150000, 110000], [1200000, 60000], [1230000, 30000]];

/** 配偶者控除・配偶者特別控除 */
export function spouseDeduction({ ownIncome, spouseIncome, spouseAge, year }) {
  const r = rulesFor(year);
  if (ownIncome > 10000000 || spouseIncome > 1330000) return { kind: null, amount: 0 };
  const col = ownIncome <= 9000000 ? 0 : ownIncome <= 9500000 ? 1 : 2;
  if (spouseIncome <= r.dependentLimit) {
    const elderly = spouseAge >= 70;
    return { kind: 'spouse', amount: (elderly ? [480000, 320000, 160000] : [380000, 260000, 130000])[col], elderly };
  }
  return { kind: 'special', amount: SPOUSE_SPECIAL.find(([max]) => spouseIncome <= max)[1][col] };
}

/**
 * 扶養控除・特定親族特別控除（親族1人ごと）
 * @returns {{ kind: 'none'|'general'|'specific'|'elderly'|'elderly_parent'|'specific_relative'|'child', amount }}
 */
export function dependentDeduction({ birthDate, income, livingWithParent = false }, year) {
  const r = rulesFor(year);
  const age = ageAtYearEnd(birthDate, year);
  if (income > r.dependentLimit) {
    if (age >= 19 && age < 23 && income <= 1230000) return { kind: 'specific_relative', amount: SPECIFIC_RELATIVE.find(([max]) => income <= max)[1], age };
    return { kind: 'none', amount: 0, age };
  }
  if (age < 16) return { kind: 'child', amount: 0, age };
  if (age >= 19 && age < 23) return { kind: 'specific', amount: 630000, age };
  if (age >= 70) return livingWithParent ? { kind: 'elderly_parent', amount: 580000, age } : { kind: 'elderly', amount: 480000, age };
  return { kind: 'general', amount: 380000, age };
}

export const DEPENDENT_KIND_LABELS = { none: '対象外（所得超過）', child: '16歳未満（控除なし・住民税の欄に記入）', general: '一般の扶養親族', specific: '特定扶養親族', elderly: '老人扶養親族', elderly_parent: '老人扶養親族（同居老親等）', specific_relative: '特定親族特別控除' };

/** 入力の初期値（period.incomeTaxReturn） */
export const DEFAULT_INCOME_TAX = {
  salaryRevenue: 0,
  salaryWithholding: 0,
  salaryPayer: '',
  miscBusinessRevenue: 0,
  miscBusinessExpenses: 0,
  miscOtherRevenue: 0,
  miscOtherExpenses: 0,
  miscWithholding: 0, // 雑所得・事業所得の源泉徴収税額
  socialInsurance: 0,
  smallBusinessAid: 0,
  life: { newGeneral: 0, oldGeneral: 0, newMedical: 0, newPension: 0, oldPension: 0 },
  earthquake: { quake: 0, oldLongTerm: 0 },
  widow: 'none', // none | widow | single_parent
  workingStudent: false,
  disabled: { normal: 0, special: 0, specialLiving: 0 }, // 人数
  spouse: null, // { name, birthDate, income }
  dependents: [], // [{ name, relation, birthDate, income, livingWithParent }]
  medical: [], // [{ name, payee, kind, paid, reimbursed }]
  donations: 0,
  housingLoanCredit: 0,
  prepaid1: 0,
  prepaid2: 0,
};

const TEXT_MAX = 40;
const yen0 = (v) => isYen(v) && v >= 0;
const isDate = (s) => typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s);

/** 入力の検証。エラーメッセージの配列を返す */
export function validateIncomeTax(v) {
  const e = [];
  const amounts = ['salaryRevenue', 'salaryWithholding', 'miscBusinessRevenue', 'miscBusinessExpenses', 'miscOtherRevenue', 'miscOtherExpenses', 'miscWithholding', 'socialInsurance', 'smallBusinessAid', 'donations', 'housingLoanCredit', 'prepaid1', 'prepaid2'];
  for (const k of amounts) if (!yen0(v[k])) e.push('金額は0以上の整数で入力してください');
  for (const k of Object.keys(DEFAULT_INCOME_TAX.life)) if (!yen0(v.life?.[k])) e.push('生命保険料は0以上の整数で入力してください');
  for (const k of Object.keys(DEFAULT_INCOME_TAX.earthquake)) if (!yen0(v.earthquake?.[k])) e.push('地震保険料は0以上の整数で入力してください');
  for (const k of Object.keys(DEFAULT_INCOME_TAX.disabled)) if (!(Number.isInteger(v.disabled?.[k]) && v.disabled[k] >= 0 && v.disabled[k] <= 20)) e.push('障害者の人数は0〜20で入力してください');
  if (!['none', 'widow', 'single_parent'].includes(v.widow)) e.push('寡婦・ひとり親を選んでください');
  if (typeof v.workingStudent !== 'boolean') e.push('勤労学生かどうかを選んでください');
  if (typeof v.salaryPayer !== 'string' || v.salaryPayer.length > TEXT_MAX) e.push(`支払者の名前は${TEXT_MAX}文字以内にしてください`);
  const person = (p, label) => {
    if (typeof p.name !== 'string' || !p.name.trim() || p.name.length > TEXT_MAX) e.push(`${label}の氏名を${TEXT_MAX}文字以内で入力してください`);
    if (!isDate(p.birthDate)) e.push(`${label}の生年月日を入力してください`);
    if (!isYen(p.income)) e.push(`${label}の合計所得金額は整数で入力してください`);
  };
  if (v.spouse !== null) {
    if (typeof v.spouse !== 'object') e.push('配偶者の入力が正しくありません');
    else person(v.spouse, '配偶者');
  }
  if (!Array.isArray(v.dependents) || v.dependents.length > 20) e.push('扶養親族は20人までです');
  else
    for (const d of v.dependents) {
      person(d, '親族');
      if (typeof d.relation !== 'string' || d.relation.length > 10) e.push('続柄は10文字以内にしてください');
      if (typeof d.livingWithParent !== 'boolean') e.push('同居老親等かどうかを選んでください');
    }
  if (!Array.isArray(v.medical) || v.medical.length > 200) e.push('医療費は200件までです');
  else
    for (const m of v.medical) {
      if (typeof m.name !== 'string' || m.name.length > TEXT_MAX || typeof m.payee !== 'string' || m.payee.length > TEXT_MAX) e.push(`医療費の名前・支払先は${TEXT_MAX}文字以内にしてください`);
      if (!MEDICAL_KINDS.some((k) => k.id === m.kind)) e.push('医療費の区分を選んでください');
      if (!yen0(m.paid) || !yen0(m.reimbursed)) e.push('医療費の金額は0以上の整数で入力してください');
    }
  return [...new Set(e)];
}

/** 医療費控除の明細書の区分 */
export const MEDICAL_KINDS = [
  { id: 'treatment', label: '診療・治療' },
  { id: 'medicine', label: '医薬品購入' },
  { id: 'care', label: '介護保険サービス' },
  { id: 'other', label: 'その他の医療費' },
];

/**
 * 確定申告書の計算
 * @param {object} p
 * @param {number} p.year 年分
 * @param {object} p.business 青色申告決算書の { revenue（㋐）, income（①）, familySalary, blueDeduction }
 * @param {object} p.input period.incomeTaxReturn
 */
export function computeIncomeTax({ year, business, input }) {
  const r = rulesFor(year);
  if (!r) return { supported: false, year };
  const v = { ...DEFAULT_INCOME_TAX, ...input };
  const L = {};
  // 収入金額等・所得金額等
  const rev = { a: business.revenue, e: v.salaryRevenue, g: v.miscBusinessRevenue, h: v.miscOtherRevenue };
  L[1] = business.income;
  L[6] = salaryIncome(v.salaryRevenue, year);
  L[8] = v.miscBusinessRevenue - v.miscBusinessExpenses;
  L[9] = Math.max(0, v.miscOtherRevenue - v.miscOtherExpenses);
  L[7] = 0;
  // 雑所得の赤字は他の所得と通算しない（業務・その他の合計がマイナスなら0）
  L[10] = Math.max(0, L[7] + L[8] + L[9]);
  L[11] = 0;
  // 事業所得の赤字は給与所得などと損益通算する
  L[12] = Math.max(0, L[1] + L[6] + L[10] + L[11]);
  const total = L[12]; // 合計所得金額（分離課税なし）

  // 所得から差し引かれる金額
  // 生年月日が入っていない人（入力の途中）は計算に入れない
  const complete = (p) => p && /^\d{4}-\d{2}-\d{2}$/.test(p.birthDate) && isYen(p.income);
  const dependents = v.dependents.filter(complete).map((d) => ({ ...d, ...dependentDeduction(d, year) }));
  const childRule = r.lifeChildRule && dependents.some((d) => d.age < 23 && d.income <= r.dependentLimit);
  const life = lifeInsuranceDeduction(v.life, childRule);
  L[13] = v.socialInsurance;
  L[14] = v.smallBusinessAid;
  L[15] = life.total;
  L[16] = earthquakeDeduction(v.earthquake);
  L[17] = total <= 5000000 ? (v.widow === 'widow' ? 270000 : v.widow === 'single_parent' ? r.singleParent : 0) : 0;
  L[19] = v.workingStudent && total <= r.studentLimit ? 270000 : 0;
  L[20] = v.disabled.normal * 270000 + v.disabled.special * 400000 + v.disabled.specialLiving * 750000;
  const spouse = complete(v.spouse) ? { ...v.spouse, ...spouseDeduction({ ownIncome: total, spouseIncome: v.spouse.income, spouseAge: ageAtYearEnd(v.spouse.birthDate, year), year }) } : null;
  L[21] = spouse?.kind ? spouse.amount : 0;
  // 扶養控除・特定親族特別控除には本人の所得の要件がない
  L[23] = dependents.filter((d) => d.kind !== 'specific_relative').reduce((s, d) => s + d.amount, 0);
  L[24] = dependents.filter((d) => d.kind === 'specific_relative').reduce((s, d) => s + d.amount, 0);
  L[25] = basicDeduction(total, year);
  L[26] = L[13] + L[14] + L[15] + L[16] + L[17] + L[19] + L[20] + L[21] + L[23] + L[24] + L[25];
  L[27] = 0;
  const medicalPaid = v.medical.reduce((s, m) => s + m.paid, 0);
  const medicalReimbursed = v.medical.reduce((s, m) => s + Math.min(m.reimbursed, m.paid), 0);
  const medicalNet = medicalPaid - medicalReimbursed;
  const medicalThreshold = Math.min(100000, Math.floor((total * 5) / 100));
  L[28] = Math.min(Math.max(0, medicalNet - medicalThreshold), 2000000);
  L[29] = v.donations ? Math.max(0, Math.min(v.donations, Math.floor((total * 40) / 100)) - 2000) : 0;
  L[30] = L[26] + L[27] + L[28] + L[29];

  // 税金の計算
  L[31] = floor1000(Math.max(0, L[12] - L[30]));
  L[32] = incomeTaxOn(L[31]);
  L[33] = 0;
  L[35] = Math.min(v.housingLoanCredit, L[32]);
  L[42] = Math.max(0, L[32] - L[33] - L[35]);
  L[43] = 0;
  L[44] = L[42] - L[43];
  L[45] = Math.floor((L[44] * 21) / 1000);
  L[46] = L[44] + L[45];
  L[47] = 0;
  L[49] = v.salaryWithholding + v.miscWithholding;
  const due = L[46] - L[47] - L[49];
  L[50] = due >= 0 ? floor100(due) : due;
  L[51] = v.prepaid1 + v.prepaid2;
  const third = L[50] - L[51];
  L[52] = third > 0 ? third : 0;
  L[53] = third < 0 ? -third : 0;

  return {
    supported: true,
    year,
    rev,
    lines: L,
    life,
    spouse,
    dependents,
    childRule,
    medical: { paid: medicalPaid, reimbursed: medicalReimbursed, net: medicalNet, threshold: medicalThreshold },
    totalIncome: total,
    other: { spouseIncome: v.spouse?.income ?? null, familySalary: business.familySalary, blueDeduction: business.blueDeduction, miscWithholding: v.miscWithholding },
  };
}
