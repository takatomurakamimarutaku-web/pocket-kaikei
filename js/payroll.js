// 給与計算（純粋関数）：従業員・給与（賞与）の金額、源泉所得税・雇用保険料の計算、検証、仕訳、源泉所得税の納付の集計
//
// 源泉所得税（給与）は「月額表の甲欄を適用する給与等に対する源泉徴収税額の電算機計算の特例」で計算する。
// 月額表の甲欄を適用する給与等は、別表第一〜第四で税額を求めることができる（10円未満の端数は四捨五入。
// 給与所得控除の額の1円未満の端数は切上げ）。税額表（月額表）の金額と数十円違うことがある
//   令和8年分：https://www.nta.go.jp/publication/pamph/gensen/zeigakuhyo2026/data/18.pdf
//   令和9年分：https://www.nta.go.jp/publication/pamph/gensen/zeigakuhyo2027/data/18.pdf
//   （令和9年分は給与所得控除の最低額と基礎控除の額が変わる。税率は防衛特別所得税を含めても102.1%のまま）
// 乙欄の給与と、計算方法が入っていない年分の給与は、税額表で求めて手で入力してもらう
//
// 賞与は「賞与に対する源泉徴収税額の算出率の表」：前月の社会保険料等控除後の給与等の金額と扶養親族等の数から
// 算出率を求め、社会保険料等控除後の賞与の金額に掛ける（1円未満切捨て）
//   令和8年分：https://www.nta.go.jp/publication/pamph/gensen/zeigakuhyo2026/data/15-16.pdf
//   令和9年分：https://www.nta.go.jp/publication/pamph/gensen/zeigakuhyo2027/data/15-16.pdf
// 前月に給与の支払が無い・前月の給与が社会保険料等以下・賞与が前月の給与の10倍を超えるときは月額表を使う：
//   賞与÷6（計算期間が6か月を超えるときは12）＋前月の給与 の月額表の税額 − 前月の給与の税額 を6（12）倍する
//   出典：No.2523 賞与に対する源泉徴収 https://www.nta.go.jp/taxes/shiraberu/taxanswer/gensen/2523.htm
//   このアプリは月額表の代わりに上の電算機計算の方法で求める（目安として出し、税額表で確かめてもらう）
//
// 納期限：支払った月の翌月10日。納期の特例（給与の支払を受ける人が常時10人未満で承認を受けた場合）は
// 1〜6月分が7月10日、7〜12月分が翌年1月20日。土日祝日などに当たるときは翌日（holidays.js）
//   出典：No.2505 https://www.nta.go.jp/taxes/shiraberu/taxanswer/gensen/2505.htm
// 所得税徴収高計算書の区分（俸給・給料等／賞与（役員賞与を除く）／役員賞与）、人員（実人員。納期の特例は実人員の合計）
//   出典：https://www.nta.go.jp/law/jimu-unei/shotoku/gensen/080623/03.htm
//
// 通勤手当（通常必要と認められるもの）は課税仕入れ（帳簿の保存だけでよい）
//   出典：No.6459 https://www.nta.go.jp/taxes/shiraberu/taxanswer/shohi/6459.htm
// 雇用保険料（被保険者負担分）を賃金から控除するときの1円未満の端数は、50銭以下を切り捨て、50銭1厘以上を切り上げる
// （厚生労働省 労働局の案内による。出典は docs/spec-phase2-payroll.md）。賃金には非課税の通勤手当も含める
import { isValidDate, addMonths } from './period.js';
import { isYen } from './money.js';
import { MAX_MEMO } from './journal.js';
import { createJournal } from './models.js';
import { toCsv } from './csv.js';
import { taxDueDate } from './holidays.js';

export const EMPLOYEE_KINDS = [
  { id: 'employee', label: '従業員', entity: 'both' },
  { id: 'officer', label: '役員', entity: 'corporation' },
  { id: 'family', label: '青色事業専従者', entity: 'individual' },
];
export const EMPLOYEE_KIND_LABEL = Object.fromEntries(EMPLOYEE_KINDS.map((k) => [k.id, k.label]));

/** 税額表の欄。甲欄：扶養控除等申告書を出している人。乙欄：出していない人 */
export const TAX_COLUMNS = [
  { id: 'kou', label: '甲欄', hint: '扶養控除等申告書を出している人' },
  { id: 'otsu', label: '乙欄', hint: '扶養控除等申告書を出していない人（ほかで甲欄の給与を受けている人など）' },
];
export const TAX_COLUMN_LABEL = { kou: '甲欄', otsu: '乙欄' };

export const PAY_KINDS = { salary: '給与', bonus: '賞与' };

export const MAX_NAME = 40;
export const MAX_ITEM_NAME = 20;
export const MAX_ITEMS = 10;
export const MAX_TITLE = 30;
export const MAX_NOTE = 200;
export const MAX_DEPENDENTS = 20;
export const MAX_ADDRESS = 120;
export const MAX_CITY = 30;
export const MAX_PHONE = 30;
/** 住民税の徴収の方法（給与支払報告書の総括表の人数に使う） */
export const RESIDENT_COLLECTIONS = [
  { id: 'special', label: '特別徴収' },
  { id: 'ordinary', label: '普通徴収' },
];
export const RESIDENT_COLLECTION_LABEL = Object.fromEntries(RESIDENT_COLLECTIONS.map((c) => [c.id, c.label]));
/** 1項目の金額の上限（1億円未満） */
export const MAX_PAY = 99_999_999;
/** 雇用保険料率の上限（千分の100）。料率は千分率の100倍の整数で持つ（千分の5.5 → 550） */
export const MAX_RATE = 10000;

// ---- 入力の読み取り ----

/** 雇用保険料率（千分率）の入力を、千分率の100倍の整数にする。空欄は null（加入していない）。不正なら NaN */
export function parseRate(value) {
  const s = String(value ?? '')
    .trim()
    .replace(/[０-９．]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0));
  if (!s) return null;
  if (!/^\d+(\.\d{1,2})?$/.test(s)) return NaN;
  const [i, f = ''] = s.split('.');
  const n = Number(i) * 100 + Number(f.padEnd(2, '0'));
  return n > 0 && n <= MAX_RATE ? n : NaN;
}

export function formatRate(rate) {
  if (rate == null) return '';
  const i = Math.floor(rate / 100);
  const f = String(rate % 100).padStart(2, '0').replace(/0+$/, '');
  return f ? `${i}.${f}` : String(i);
}

// ---- 金額 ----

export function sumItems(items) {
  return (items || []).reduce((s, i) => s + (i.amount || 0), 0);
}

/**
 * 給与1件の合計
 * taxable：課税の支給額、gross：総支給額（＋非課税の通勤手当）、social：社会保険料等（健康保険・厚生年金・雇用保険）
 * afterSocial：社会保険料等控除後の給与等の金額（源泉所得税の計算のもと）、deductions：控除の合計、net：差引支給額
 * yearEnd：年末調整の過不足（＋は不足額の徴収、−は超過額の還付）。控除の合計に含める
 */
export function payrollTotals(p) {
  const taxable = sumItems(p.earnings);
  const commute = p.commute || 0;
  const social = (p.health || 0) + (p.pension || 0) + (p.employment || 0);
  const others = sumItems(p.deductions);
  const yearEnd = p.yearEndTax || 0;
  const deductions = social + (p.incomeTax || 0) + (p.residentTax || 0) + others + yearEnd;
  const gross = taxable + commute;
  return { taxable, commute, gross, social, afterSocial: taxable - social, others, yearEnd, deductions, net: gross - deductions };
}

/**
 * 雇用保険料（被保険者負担分）：賃金（課税の支給額＋通勤手当）×料率。50銭以下切捨て・50銭1厘以上切上げ
 * @param {number} wage 円
 * @param {number|null} rate 千分率の100倍（千分の5.5 → 550）
 */
export function employmentPremium(wage, rate) {
  if (!rate || wage <= 0) return 0;
  const product = wage * rate; // 10万分の1円
  const yen = Math.floor(product / 100000);
  return product % 100000 > 50000 ? yen + 1 : yen;
}

// ---- 源泉所得税：月額表の甲欄（電算機計算の特例） ----

/** 年分ごとの違い（別表第一の最初の区分と、別表第二の最初の区分） */
const MONTHLY_KOU = {
  2026: { fixedUpTo: 158333, fixed: 54167, basicFirst: 48334 },
  2027: { fixedUpTo: 169444, fixed: 57500, basicFirst: 51667 },
};
/** 配偶者（特別）控除・扶養控除の額（1人あたり） */
const PER_DEPENDENT = 31667;
/** 別表第三：[B の上限, 税率（10万分率）, 控除額] */
const KOU_BRACKETS = [
  [162500, 5105, 0],
  [275000, 10210, 8296],
  [579166, 20420, 36374],
  [750000, 23483, 54113],
  [1500000, 33693, 130688],
  [3333333, 40840, 237893],
  [Infinity, 45945, 408061],
];

export function supportedTaxYears() {
  return Object.keys(MONTHLY_KOU).map(Number);
}

const ceilPct = (a, pct) => Math.ceil((a * pct) / 100);

/** 別表第一：給与所得控除の額（月額） */
export function salaryDeduction(a, year) {
  const t = MONTHLY_KOU[year];
  if (a <= t.fixedUpTo) return t.fixed;
  if (a <= 299999) return ceilPct(a, 30) + 6667;
  if (a <= 549999) return ceilPct(a, 20) + 36667;
  if (a <= 708330) return ceilPct(a, 10) + 91667;
  return 162500;
}

/** 別表第二：基礎控除の額（月額） */
export function basicDeduction(a, year) {
  const t = MONTHLY_KOU[year];
  if (a <= 2120833) return t.basicFirst;
  if (a <= 2162499) return 40000;
  if (a <= 2204166) return 26667;
  if (a <= 2245833) return 13334;
  return 0;
}

/**
 * 月額表の甲欄の給与の源泉所得税（電算機計算の特例）。計算方法が入っていない年分は null
 * @param {number} a 社会保険料等控除後の給与等の金額
 * @param {number} dependents 扶養親族等の数
 */
export function monthlyKouTax(a, dependents, year) {
  if (!MONTHLY_KOU[year]) return null;
  if (a <= 0) return 0;
  const b = a - salaryDeduction(a, year) - PER_DEPENDENT * dependents - basicDeduction(a, year);
  if (b <= 0) return 0;
  const [, rate, minus] = KOU_BRACKETS.find(([max]) => b <= max);
  const num = b * rate - minus * 100000; // 10万分の1円
  return Math.max(0, Math.floor((num + 500000) / 1000000) * 10);
}

// ---- 源泉所得税：賞与の算出率の表 ----

/** 賞与の金額に乗ずべき率（10万分率） */
const BONUS_RATES = [0, 2042, 4084, 6126, 8168, 10210, 12252, 14294, 16336, 18378, 20420, 22462, 24504, 26546, 28588, 30630, 32672, 35735, 38798, 41861, 45945];
/** 甲欄：扶養親族等の数（0〜7人以上）ごとの、前月の社会保険料等控除後の給与等の金額の区切り（千円）。i 番目の区切り以上で BONUS_RATES[i+1] */
const BONUS_KOU = {
  2026: [
    [82, 94, 260, 309, 342, 372, 402, 433, 520, 605, 684, 715, 752, 795, 854, 922, 1318, 1521, 2621, 3495],
    [107, 250, 289, 346, 373, 401, 430, 463, 520, 621, 705, 739, 778, 821, 882, 952, 1342, 1526, 2645, 3527],
    [143, 276, 321, 377, 400, 426, 457, 492, 525, 636, 728, 764, 804, 848, 910, 983, 1367, 1526, 2669, 3559],
    [181, 300, 354, 405, 424, 452, 484, 517, 550, 651, 751, 788, 830, 876, 938, 1013, 1391, 1538, 2693, 3590],
    [218, 300, 387, 431, 452, 477, 509, 540, 577, 666, 774, 813, 856, 903, 966, 1044, 1416, 1555, 2716, 3622],
    [251, 304, 412, 457, 479, 503, 531, 564, 604, 681, 798, 838, 881, 930, 994, 1074, 1440, 1555, 2740, 3654],
    [284, 343, 438, 483, 505, 527, 553, 589, 630, 697, 821, 862, 907, 957, 1022, 1104, 1464, 1555, 2764, 3685],
    [317, 383, 463, 508, 529, 552, 578, 614, 657, 708, 845, 887, 933, 985, 1051, 1135, 1489, 1583, 2788, 3717],
  ],
  2027: [
    [87, 100, 263, 313, 346, 375, 405, 436, 520, 607, 686, 717, 755, 797, 857, 925, 1321, 1521, 2621, 3495],
    [112, 253, 292, 349, 376, 404, 432, 466, 520, 622, 707, 742, 781, 824, 885, 956, 1345, 1526, 2645, 3527],
    [147, 279, 325, 380, 402, 429, 460, 495, 528, 637, 730, 766, 807, 851, 913, 986, 1369, 1526, 2669, 3559],
    [185, 300, 357, 408, 427, 454, 487, 519, 553, 653, 753, 791, 832, 878, 941, 1016, 1394, 1538, 2693, 3590],
    [222, 300, 390, 434, 455, 480, 511, 542, 580, 668, 777, 816, 858, 906, 969, 1047, 1418, 1555, 2716, 3622],
    [255, 308, 415, 460, 482, 505, 533, 567, 607, 683, 800, 840, 884, 933, 997, 1077, 1443, 1555, 2740, 3654],
    [287, 347, 440, 486, 508, 530, 555, 592, 633, 698, 824, 865, 910, 960, 1025, 1108, 1467, 1555, 2764, 3685],
    [320, 387, 466, 510, 532, 555, 580, 617, 660, 710, 847, 889, 936, 988, 1054, 1138, 1491, 1583, 2788, 3717],
  ],
};
/** 乙欄：区切り（千円）と率 */
const BONUS_OTSU = { 2026: [224, 295, 527, 1118], 2027: [224, 296, 528, 1118] };
const OTSU_RATES = [10210, 20420, 30630, 38798, 45945];

/**
 * 賞与の算出率（10万分率）。計算方法が入っていない年分は null
 * @param {number} prev 前月の社会保険料等控除後の給与等の金額
 */
export function bonusRate(prev, dependents, column, year) {
  const count = (bounds) => bounds.filter((k) => prev >= k * 1000).length;
  if (column === 'otsu') return BONUS_OTSU[year] ? OTSU_RATES[count(BONUS_OTSU[year])] : null;
  const table = BONUS_KOU[year];
  return table ? BONUS_RATES[count(table[Math.min(dependents, 7)])] : null;
}

/**
 * 賞与の源泉所得税
 * @param {{ amount, prev, dependents, column, year, longPeriod }} o amount：社会保険料等控除後の賞与の金額、prev：前月の社会保険料等控除後の給与等の金額（無ければ0）
 * @returns {{ tax: number|null, method: 'rate'|'special', rate?, divisor?, reason? }} tax が null なら手で入力してもらう
 */
export function bonusTax({ amount, prev, dependents, column, year, longPeriod = false }) {
  if (amount <= 0) return { tax: 0, method: 'rate', rate: 0 };
  const special = prev <= 0 || amount > prev * 10;
  if (!special) {
    const rate = bonusRate(prev, dependents, column, year);
    if (rate == null) return { tax: null, method: 'rate', reason: 'year' };
    return { tax: Math.floor((amount * rate) / 100000), method: 'rate', rate };
  }
  if (column !== 'kou') return { tax: null, method: 'special', reason: 'otsu' };
  const n = longPeriod ? 12 : 6;
  const base = Math.max(prev, 0);
  const t1 = monthlyKouTax(Math.floor(amount / n) + base, dependents, year);
  if (t1 == null) return { tax: null, method: 'special', reason: 'year' };
  const t0 = monthlyKouTax(base, dependents, year);
  return { tax: Math.max(0, (t1 - t0) * n), method: 'special', divisor: n };
}

/**
 * 給与1件の源泉所得税の自動計算
 * @returns {{ tax: number|null, method: 'monthly'|'rate'|'special'|null, reason?, rate?, divisor? }}
 *   reason：'otsu'（乙欄の月額表）・'year'（計算方法が入っていない年分）のときは tax が null
 */
export function autoIncomeTax(p) {
  const year = Number(String(p.payDate).slice(0, 4));
  const { afterSocial } = payrollTotals(p);
  const dependents = p.taxColumn === 'kou' ? p.dependents || 0 : 0;
  if (p.kind === 'bonus') return bonusTax({ amount: afterSocial, prev: p.prevAfterSocial || 0, dependents, column: p.taxColumn, year, longPeriod: !!p.longPeriod });
  if (p.taxColumn !== 'kou') return { tax: null, method: null, reason: 'otsu' };
  const tax = monthlyKouTax(afterSocial, dependents, year);
  return tax == null ? { tax: null, method: null, reason: 'year' } : { tax, method: 'monthly' };
}

/** 自動計算の項目（雇用保険料・源泉所得税）を計算し直した給与。自動にできないときは今の金額のまま */
export function applyAuto(p) {
  const next = { ...p };
  if (next.employmentAuto) next.employment = employmentPremium(payrollTotals({ ...next, health: 0, pension: 0, employment: 0 }).gross, next.employmentRate);
  if (next.incomeTaxAuto) {
    const r = autoIncomeTax(next);
    if (r.tax != null) next.incomeTax = r.tax;
  }
  return next;
}

/**
 * 前月中に支払った給与（賞与を除く）の社会保険料等控除後の金額の合計
 * @returns {{ amount: number, count: number, month: string }} month：前月（YYYY-MM）
 */
export function previousMonthSalary(payrolls, employeeId, payDate, exceptId = null) {
  const month = addMonths(`${payDate.slice(0, 7)}-01`, -1).slice(0, 7);
  const list = payrolls.filter((x) => x.employeeId === employeeId && x.kind === 'salary' && x.id !== exceptId && x.payDate.slice(0, 7) === month);
  return { amount: list.reduce((s, x) => s + payrollTotals(x).afterSocial, 0), count: list.length, month };
}

// ---- 検証 ----

const isNonNegYen = (n) => isYen(n) && n >= 0 && n <= MAX_PAY;
const len = (v) => String(v ?? '').length;

function validateItems(items, what, errors, { allowNegative = false } = {}) {
  if (!Array.isArray(items)) {
    errors.push(`${what}が不正です`);
    return;
  }
  if (items.length > MAX_ITEMS) errors.push(`${what}は${MAX_ITEMS}行までです`);
  items.forEach((it, i) => {
    const at = `${what}${i + 1}行目`;
    if (!it || typeof it !== 'object') return errors.push(`${at}が不正です`);
    if (!String(it.name ?? '').trim()) errors.push(`${at}：名前を入力してください`);
    else if (len(it.name) > MAX_ITEM_NAME) errors.push(`${at}：名前は${MAX_ITEM_NAME}文字以内にしてください`);
    if (!isYen(it.amount) || Math.abs(it.amount) > MAX_PAY || (!allowNegative && it.amount < 0)) errors.push(`${at}：金額は${allowNegative ? '' : '0以上の'}整数で入力してください`);
  });
}

/** 従業員の検証。{ 項目: メッセージ } */
export function validateEmployee(e, { entityType } = {}) {
  const errors = {};
  const name = String(e.name ?? '').trim();
  if (!name) errors.name = '名前を入力してください';
  else if (name.length > MAX_NAME) errors.name = `名前は${MAX_NAME}文字以内にしてください`;
  if (len(e.kana) > MAX_NAME) errors.kana = `ふりがなは${MAX_NAME}文字以内にしてください`;
  const kind = EMPLOYEE_KINDS.find((k) => k.id === e.kind);
  if (!kind) errors.kind = '区分を選んでください';
  else if (entityType && kind.entity !== 'both' && kind.entity !== entityType) errors.kind = `${kind.label}は${entityType === 'individual' ? '法人' : '個人事業主'}だけで選べます`;
  if (!TAX_COLUMN_LABEL[e.taxColumn]) errors.taxColumn = '税額表の欄を選んでください';
  if (!Number.isInteger(e.dependents) || e.dependents < 0 || e.dependents > MAX_DEPENDENTS) errors.dependents = `扶養親族等の数は0〜${MAX_DEPENDENTS}人で入力してください`;
  const list = [];
  validateItems(e.earnings, '支給', list, { allowNegative: true });
  validateItems(e.deductions, 'その他の控除', list);
  if (list.length) errors.items = list.join('\n');
  for (const [k, label] of [
    ['commute', '通勤手当'],
    ['health', '健康保険料'],
    ['pension', '厚生年金保険料'],
    ['residentTax', '住民税'],
  ]) {
    if (!isNonNegYen(e[k] ?? 0)) errors[k] = `${label}は0以上の整数で入力してください`;
  }
  if (e.employmentRate != null && (!Number.isInteger(e.employmentRate) || e.employmentRate <= 0 || e.employmentRate > MAX_RATE)) errors.employmentRate = '雇用保険料率は千分率（例：5.5）で入力してください';
  if (len(e.note) > MAX_NOTE) errors.note = `メモは${MAX_NOTE}文字以内にしてください`;
  if (typeof e.active !== 'boolean') errors.active = '在籍かどうかが不正です';
  // 源泉徴収票・給与支払報告書に使う項目（任意）
  if (len(e.address) > MAX_ADDRESS) errors.address = `住所は${MAX_ADDRESS}文字以内にしてください`;
  for (const [k, label] of [
    ['birthDate', '生年月日'],
    ['joinedOn', '就職した日'],
    ['retiredOn', '退職した日'],
  ]) {
    if (e[k] && !isValidDate(e[k])) errors[k] = `${label}が正しくありません`;
  }
  if (!errors.joinedOn && !errors.retiredOn && e.joinedOn && e.retiredOn && e.retiredOn < e.joinedOn) errors.retiredOn = '退職した日は就職した日より後の日にしてください';
  if (len(e.residentCity) > MAX_CITY) errors.residentCity = `市区町村は${MAX_CITY}文字以内にしてください`;
  if (e.residentCollection != null && !RESIDENT_COLLECTION_LABEL[e.residentCollection]) errors.residentCollection = '住民税の徴収の方法を選んでください';
  if ((e.foreigner != null && typeof e.foreigner !== 'boolean') || (e.deceased != null && typeof e.deceased !== 'boolean')) errors.flags = '外国人・死亡退職の設定が不正です';
  return errors;
}

/**
 * 給与（賞与）1件の検証。エラーメッセージの配列
 * @param {object} p
 * @param {{ employees?: Array }} ctx employees を渡すと従業員がいるかも確かめる
 */
export function validatePayroll(p, { employees = null } = {}) {
  const errors = [];
  if (!p || typeof p !== 'object') return ['給与のデータが不正です'];
  if (!PAY_KINDS[p.kind]) errors.push('給与か賞与かを選んでください');
  if (!p.employeeId || typeof p.employeeId !== 'string') errors.push('従業員を選んでください');
  else if (employees && !employees.some((e) => e.id === p.employeeId)) errors.push('従業員が見つかりません');
  const name = String(p.name ?? '').trim();
  if (!name || name.length > MAX_NAME) errors.push('従業員の名前が不正です');
  if (!EMPLOYEE_KIND_LABEL[p.employeeKind]) errors.push('従業員の区分が不正です');
  if (!isValidDate(p.payDate)) errors.push('支給日を入力してください');
  if (len(p.title) > MAX_TITLE) errors.push(`題名は${MAX_TITLE}文字以内にしてください`);
  if (!TAX_COLUMN_LABEL[p.taxColumn]) errors.push('税額表の欄を選んでください');
  if (!Number.isInteger(p.dependents) || p.dependents < 0 || p.dependents > MAX_DEPENDENTS) errors.push(`扶養親族等の数は0〜${MAX_DEPENDENTS}人で入力してください`);
  if (p.employmentRate != null && (!Number.isInteger(p.employmentRate) || p.employmentRate <= 0 || p.employmentRate > MAX_RATE)) errors.push('雇用保険料率が不正です');
  validateItems(p.earnings, '支給', errors, { allowNegative: true });
  validateItems(p.deductions, 'その他の控除', errors);
  for (const [k, label] of [
    ['commute', '通勤手当'],
    ['health', '健康保険料'],
    ['pension', '厚生年金保険料'],
    ['employment', '雇用保険料'],
    ['incomeTax', '源泉所得税'],
    ['residentTax', '住民税'],
  ]) {
    if (!isNonNegYen(p[k] ?? 0)) errors.push(`${label}は0以上の整数で入力してください`);
  }
  if (p.kind === 'bonus' && !isNonNegYen(p.prevAfterSocial ?? 0)) errors.push('前月の給与（社会保険料等を引いた後）は0以上の整数で入力してください');
  if (!isYen(p.yearEndTax ?? 0) || Math.abs(p.yearEndTax ?? 0) > MAX_PAY) errors.push('年末調整の過不足額が不正です');
  if ((p.yearEndTax ?? 0) !== 0 && !p.yearEndId) errors.push('年末調整の過不足額に年末調整の記録がありません');
  if (len(p.note) > MAX_NOTE) errors.push(`メモは${MAX_NOTE}文字以内にしてください`);
  if (errors.length) return errors;
  const t = payrollTotals(p);
  if (t.taxable < 0) errors.push('支給の合計がマイナスになっています');
  if (t.gross <= 0) errors.push('支給する金額を入力してください');
  if (t.net < 0) errors.push(`控除の合計が支給額を超えています（差引支給額 △${(-t.net).toLocaleString('ja-JP')}円）`);
  return errors;
}

// ---- 設定と仕訳 ----

/** 給与の設定で選ぶ科目 */
export const PAYROLL_ACCOUNT_FIELDS = [
  { key: 'salary', label: '給与（従業員）', groups: ['sga', 'mfg_labor', 're_expenses'] },
  { key: 'bonus', label: '賞与（従業員）', groups: ['sga', 'mfg_labor', 're_expenses'] },
  { key: 'officer', label: '役員報酬', groups: ['sga'], entity: 'corporation' },
  { key: 'officerBonus', label: '役員賞与', groups: ['sga'], entity: 'corporation' },
  { key: 'family', label: '専従者給与', groups: ['family_salary', 're_family_salary'], entity: 'individual' },
  { key: 'commute', label: '通勤手当', groups: ['sga', 'mfg_labor', 'mfg_overhead', 're_expenses'] },
  { key: 'deposit', label: '天引きした税・保険料（預り金）', groups: ['current_liabilities'] },
  { key: 'payment', label: '支払口座', groups: ['current_assets'] },
  { key: 'welfare', label: '社会保険料の会社負担', groups: ['sga', 'mfg_labor', 're_expenses'] },
];

/** 預り金の補助科目を分けて使える控除の種類 */
export const DEPOSIT_KINDS = [
  { key: 'social', label: '社会保険料（健康保険・厚生年金）' },
  { key: 'employment', label: '雇用保険料' },
  { key: 'incomeTax', label: '源泉所得税' },
  { key: 'residentTax', label: '住民税' },
  { key: 'other', label: 'その他の控除' },
];

/** 源泉徴収票の支払者の欄 */
export const PAYER_FIELDS = [
  { key: 'name', label: '支払者の氏名又は名称', max: MAX_ADDRESS },
  { key: 'address', label: '支払者の住所又は所在地', max: MAX_ADDRESS },
  { key: 'phone', label: '支払者の電話番号', max: MAX_PHONE },
];

/**
 * 設定の科目（空なら目印・区分から初期値を探す）
 * @returns {{ accounts: Record<string,string>, subs: Record<string,string|null>, special: boolean, payer: {name, address, phone} }}
 */
export function resolvePayrollSettings(payroll, accounts) {
  const cfg = payroll || {};
  const active = accounts.filter((a) => a.active);
  const byHint = (hint) => active.find((a) => a.hint === hint)?.id ?? '';
  const exists = (id) => (id && accounts.some((a) => a.id === id) ? id : '');
  const pick = (key, fallback) => exists(cfg.accounts?.[key]) || fallback;
  const salary = pick('salary', byHint('salaries'));
  const officer = pick('officer', byHint('officer_compensation'));
  const out = {
    salary,
    bonus: pick('bonus', byHint('bonuses') || salary),
    officer,
    officerBonus: pick('officerBonus', officer),
    family: pick('family', active.find((a) => a.group === 'family_salary')?.id ?? ''),
    commute: pick('commute', byHint('travel')),
    deposit: pick('deposit', byHint('deposits_received')),
    payment: pick('payment', active.find((a) => a.role === 'deposit')?.id ?? active.find((a) => a.role === 'cash')?.id ?? ''),
    welfare: pick('welfare', byHint('legal_welfare')),
  };
  const subs = Object.fromEntries(DEPOSIT_KINDS.map((k) => [k.key, cfg.subs?.[k.key] || null]));
  const payer = Object.fromEntries(PAYER_FIELDS.map((f) => [f.key, typeof cfg.payer?.[f.key] === 'string' ? cfg.payer[f.key] : '']));
  return { accounts: out, subs, special: cfg.special === true, payer };
}

/** 給与の設定の検証（保存する形：{ accounts: {key: id}, subs: {key: id|null}, special, payer?: {name, address, phone} }） */
export function validatePayrollSettings(payroll, { accounts = null, subAccounts = null } = {}) {
  if (payroll === undefined) return [];
  const errors = [];
  if (!payroll || typeof payroll !== 'object') return ['給与の設定が不正です'];
  if (typeof payroll.special !== 'boolean') errors.push('納期の特例の設定が不正です');
  const acc = payroll.accounts || {};
  if (typeof acc !== 'object') errors.push('給与の設定の科目が不正です');
  for (const f of PAYROLL_ACCOUNT_FIELDS) {
    const id = acc[f.key];
    if (id == null || id === '') continue;
    if (typeof id !== 'string') errors.push(`${f.label}の科目が不正です`);
    else if (accounts) {
      const a = accounts.find((x) => x.id === id);
      if (!a) errors.push(`${f.label}の科目が見つかりません`);
      else if (!f.groups.includes(a.group)) errors.push(`${f.label}に「${a.name}」は選べません`);
    }
  }
  if (payroll.payer != null) {
    if (typeof payroll.payer !== 'object') errors.push('支払者の設定が不正です');
    else
      for (const f of PAYER_FIELDS) {
        const v = payroll.payer[f.key];
        if (v != null && typeof v !== 'string') errors.push(`${f.label}が不正です`);
        else if (len(v) > f.max) errors.push(`${f.label}は${f.max}文字以内にしてください`);
      }
  }
  const subs = payroll.subs || {};
  for (const k of DEPOSIT_KINDS) {
    const id = subs[k.key];
    if (id == null || id === '') continue;
    if (typeof id !== 'string') errors.push(`${k.label}の補助科目が不正です`);
    else if (subAccounts && accounts) {
      const s = subAccounts.find((x) => x.id === id);
      const deposit = acc.deposit || resolvePayrollSettings(payroll, accounts).accounts.deposit;
      if (!s || s.accountId !== deposit) errors.push(`${k.label}の補助科目は預り金の科目の補助科目を選んでください`);
    }
  }
  return errors;
}

/** 給与の費用の科目の設定の名前（従業員の区分と給与・賞与で決まる） */
export function expenseKey(p) {
  if (p.employeeKind === 'officer') return p.kind === 'bonus' ? 'officerBonus' : 'officer';
  if (p.employeeKind === 'family') return 'family';
  return p.kind === 'bonus' ? 'bonus' : 'salary';
}

/** 給与の題名（空なら「給与」「賞与」） */
export function payrollTitle(p) {
  return String(p.title ?? '').trim() || PAY_KINDS[p.kind];
}

const clip = (s) => (s.length > MAX_MEMO ? s.slice(0, MAX_MEMO) : s);

/**
 * 給与の仕訳：借方 給与の科目＝課税の支給額・通勤手当の科目＝通勤手当／貸方 預り金（社会保険料・雇用保険料・源泉所得税・住民税・その他）・支払口座＝差引支給額
 * 給与の行の税区分は対象外。通勤手当は科目の税区分（通常は課税仕入れ10%）
 */
export function payrollJournal(p, { accounts, settings, periodId }) {
  const cfg = resolvePayrollSettings(settings?.payroll, accounts);
  const t = payrollTotals(p);
  const accountOf = (key) => {
    const id = cfg.accounts[key];
    const a = id && accounts.find((x) => x.id === id);
    if (!a) throw new PayrollSetupError(PAYROLL_ACCOUNT_FIELDS.find((f) => f.key === key).label);
    return a;
  };
  const base = `${p.name} ${payrollTitle(p)}`;
  const lines = [];
  if (t.taxable > 0) lines.push({ side: 'debit', accountId: accountOf(expenseKey(p)).id, subAccountId: null, amount: t.taxable, taxCategory: 'none', memo: clip(base) });
  if (t.commute > 0) {
    const a = accountOf('commute');
    lines.push({ side: 'debit', accountId: a.id, subAccountId: null, amount: t.commute, taxCategory: a.defaultTaxCategory || 'purchase_10', memo: clip(`${base} 通勤手当`) });
  }
  const deposit = (kind, amount, label) => {
    if (amount > 0) lines.push({ side: 'credit', accountId: accountOf('deposit').id, subAccountId: cfg.subs[kind], amount, taxCategory: 'none', memo: clip(`${base} ${label}`) });
  };
  deposit('social', (p.health || 0) + (p.pension || 0), '社会保険料');
  deposit('employment', p.employment || 0, '雇用保険料');
  deposit('incomeTax', p.incomeTax || 0, '源泉所得税');
  // 年末調整：不足額は預り金に足し、超過額（還付）は預り金から払う
  const yearEnd = p.yearEndTax || 0;
  if (yearEnd > 0) deposit('incomeTax', yearEnd, '年末調整 不足額');
  if (yearEnd < 0) lines.push({ side: 'debit', accountId: accountOf('deposit').id, subAccountId: cfg.subs.incomeTax, amount: -yearEnd, taxCategory: 'none', memo: clip(`${base} 年末調整 還付`) });
  deposit('residentTax', p.residentTax || 0, '住民税');
  for (const d of p.deductions || []) deposit('other', d.amount, d.name);
  if (t.net > 0) lines.push({ side: 'credit', accountId: accountOf('payment').id, subAccountId: null, amount: t.net, taxCategory: 'none', memo: clip(`${base} 差引支給額`) });
  return createJournal({ periodId, date: p.payDate, lines, source: 'payroll', sourceId: p.id });
}

/** 給与の設定で科目が決まっていないとき */
export class PayrollSetupError extends Error {
  constructor(label) {
    super(`給与の設定で「${label}」の科目を選んでください`);
    this.label = label;
  }
}

// ---- 作成 ----

/** 従業員の初期値 */
export function employeeDraft() {
  return {
    name: '',
    kana: '',
    kind: 'employee',
    taxColumn: 'kou',
    dependents: 0,
    earnings: [{ name: '基本給', amount: 0 }],
    commute: 0,
    health: 0,
    pension: 0,
    employmentRate: null,
    residentTax: 0,
    deductions: [],
    note: '',
    active: true,
    address: '',
    birthDate: '',
    joinedOn: '',
    retiredOn: '',
    residentCity: '',
    residentCollection: 'special',
    foreigner: false,
    deceased: false,
  };
}

/** 支給日の月の「◯月分」 */
export function defaultTitle(kind, payDate) {
  return kind === 'bonus' ? '賞与' : `${Number(payDate.slice(5, 7))}月分`;
}

/**
 * 従業員の登録内容から給与（賞与）の下書きを作る。賞与は支給の内容を空にし、前月の給与を payrolls から探す
 * 雇用保険料・源泉所得税は自動計算にする
 */
export function payrollDraft(employee, { kind = 'salary', payDate, title, payrolls = [] }) {
  const p = {
    employeeId: employee.id,
    kind,
    payDate,
    title: title ?? defaultTitle(kind, payDate),
    name: employee.name,
    employeeKind: employee.kind,
    taxColumn: employee.taxColumn,
    dependents: employee.dependents,
    employmentRate: employee.employmentRate ?? null,
    earnings: kind === 'bonus' ? [{ name: '賞与', amount: 0 }] : (employee.earnings || []).map((x) => ({ name: x.name, amount: x.amount })),
    commute: kind === 'bonus' ? 0 : employee.commute || 0,
    health: kind === 'bonus' ? 0 : employee.health || 0,
    pension: kind === 'bonus' ? 0 : employee.pension || 0,
    employment: 0,
    employmentAuto: employee.employmentRate != null,
    incomeTax: 0,
    incomeTaxAuto: true,
    residentTax: kind === 'bonus' ? 0 : employee.residentTax || 0,
    deductions: kind === 'bonus' ? [] : (employee.deductions || []).map((x) => ({ name: x.name, amount: x.amount })),
    note: '',
    journalId: null,
    ...(kind === 'bonus' ? { prevAfterSocial: previousMonthSalary(payrolls, employee.id, payDate).amount, longPeriod: false } : {}),
  };
  return applyAuto(p);
}

/**
 * 給与の複製（翌月の給与を前の月から作るときなど）。支給日・題名を新しくし、仕訳の登録は外す。自動計算の項目は計算し直す
 */
export function copyPayroll(src, { payDate, payrolls = [] }) {
  const p = structuredClone(src);
  for (const k of ['id', 'postedAt', 'createdAt', 'updatedAt', 'yearEndTax', 'yearEndId']) delete p[k];
  Object.assign(p, { payDate, title: src.kind === 'salary' ? defaultTitle('salary', payDate) : src.title, journalId: null });
  if (p.kind === 'bonus') p.prevAfterSocial = previousMonthSalary(payrolls, src.employeeId, payDate).amount;
  return applyAuto(p);
}

/** 給与の並び：支給日の新しい順、同じ日は種類（給与→賞与）・従業員の並び・名前 */
export function comparePayrolls(order = new Map()) {
  return (a, b) => (a.payDate < b.payDate ? 1 : a.payDate > b.payDate ? -1 : 0) || (a.kind === b.kind ? 0 : a.kind === 'salary' ? -1 : 1) || (order.get(a.employeeId) ?? 0) - (order.get(b.employeeId) ?? 0) || a.name.localeCompare(b.name, 'ja');
}

/** 従業員の並び：在籍→退職、並び順、名前 */
export function compareEmployees(a, b) {
  return (a.active === b.active ? 0 : a.active ? -1 : 1) || (a.sortOrder ?? 0) - (b.sortOrder ?? 0) || a.name.localeCompare(b.name, 'ja');
}

// ---- 源泉所得税の納付 ----

export const WITHHOLDING_ROWS = [
  { id: 'salary', label: '俸給・給料等' },
  { id: 'bonus', label: '賞与（役員賞与を除く）' },
  { id: 'officer_bonus', label: '役員賞与' },
];

/** 所得税徴収高計算書の区分 */
export function withholdingCategory(p) {
  if (p.kind === 'salary') return 'salary';
  return p.employeeKind === 'officer' ? 'officer_bonus' : 'bonus';
}

/**
 * その年の納付の区切り。毎月：支払った月ごと（納期限は翌月10日）。納期の特例：1〜6月（7月10日）と7〜12月（翌年1月20日）
 * @returns {Array<{ key, label, months: string[], from, to, nominalDue, due }>}
 */
export function withholdingPeriods(year, special) {
  const ym = (m) => `${year}-${String(m).padStart(2, '0')}`;
  const make = (key, label, months, nominalDue) => ({ key, label, months, from: `${months[0]}-01`, to: lastDay(months[months.length - 1]), nominalDue, due: taxDueDate(nominalDue) });
  if (special) {
    return [make(`${year}-H1`, `${year}年1月〜6月支払分`, [1, 2, 3, 4, 5, 6].map(ym), `${year}-07-10`), make(`${year}-H2`, `${year}年7月〜12月支払分`, [7, 8, 9, 10, 11, 12].map(ym), `${year + 1}-01-20`)];
  }
  return Array.from({ length: 12 }, (_, i) => make(ym(i + 1), `${year}年${i + 1}月支払分`, [ym(i + 1)], `${addMonths(`${ym(i + 1)}-01`, 1).slice(0, 8)}10`));
}

function lastDay(ym) {
  const [y, m] = ym.split('-').map(Number);
  return `${ym}-${String(new Date(Date.UTC(y, m, 0)).getUTCDate()).padStart(2, '0')}`;
}

/** 1年分の納付の集計。carry：前の年から引ききれずに残った年末調整の超過税額 */
function yearSummary(payrolls, year, special, carry) {
  const list = withholdingPeriods(year, special).map((per) => {
    const inRange = payrolls.filter((p) => per.from <= p.payDate && p.payDate <= per.to);
    const posted = inRange.filter((p) => p.journalId);
    const rows = WITHHOLDING_ROWS.map((r) => {
      const items = posted.filter((p) => withholdingCategory(p) === r.id);
      const persons = per.months.reduce((s, m) => s + new Set(items.filter((p) => p.payDate.startsWith(m)).map((p) => p.employeeId)).size, 0);
      return { ...r, persons, amount: items.reduce((s, p) => s + payrollTotals(p).taxable, 0), tax: items.reduce((s, p) => s + (p.incomeTax || 0), 0) };
    });
    const tax = rows.reduce((s, r) => s + r.tax, 0);
    const shortage = posted.reduce((s, p) => s + Math.max(0, p.yearEndTax || 0), 0);
    const excess = posted.reduce((s, p) => s + Math.max(0, -(p.yearEndTax || 0)), 0);
    const carryIn = carry;
    const net = tax + shortage - excess - carryIn;
    carry = Math.max(0, -net);
    const dates = posted.map((p) => p.payDate).sort();
    return { ...per, rows, tax, shortage, excess, carryIn, payable: Math.max(0, net), carry, first: dates[0] ?? null, last: dates[dates.length - 1] ?? null, posted: posted.length, drafts: inRange.length - posted.length };
  });
  return { list, carry };
}

/**
 * 源泉所得税の納付の集計（所得税徴収高計算書に書く内容）。仕訳を登録した給与だけを数える
 * 年末調整の不足税額は足し、超過税額は引く。引ききれない超過税額は、その後に納付する税額から順に引く（年をまたいでも続ける。残りは carry）
 *   出典：令和8年分 年末調整のしかた（過納額の還付）https://www.nta.go.jp/publication/pamph/gensen/nencho2026/pdf/110.pdf
 * @returns {Array<{ ...period, rows: Array<{id,label,persons,amount,tax}>, tax, shortage, excess, carryIn, payable, carry, first, last, posted, drafts }>}
 *   amount：支給額（課税の支給額。非課税の通勤手当を含めない）、persons：実人員（納期の特例は月ごとの実人員の合計）
 *   tax：徴収税額の計、payable：納付する税額（本税）
 */
export function withholdingSummary(payrolls, { year, special }) {
  const years = payrolls.filter((p) => p.journalId).map((p) => Number(p.payDate.slice(0, 4)));
  let carry = 0;
  for (let y = years.length ? Math.min(...years) : year; y < year; y++) carry = yearSummary(payrolls, y, special, carry).carry;
  return yearSummary(payrolls, year, special, carry).list;
}

/**
 * 住民税・社会保険料（健康保険・厚生年金）の天引きの月ごとの合計（仕訳を登録した給与だけ）
 * @returns {Array<{ key: 'YYYY-MM', residentTax, social, employment }>}
 */
export function monthlyDeductions(payrolls, year) {
  return Array.from({ length: 12 }, (_, i) => {
    const key = `${year}-${String(i + 1).padStart(2, '0')}`;
    const list = payrolls.filter((p) => p.journalId && p.payDate.startsWith(key));
    return {
      key,
      residentTax: list.reduce((s, p) => s + (p.residentTax || 0), 0),
      social: list.reduce((s, p) => s + (p.health || 0) + (p.pension || 0), 0),
      employment: list.reduce((s, p) => s + (p.employment || 0), 0),
    };
  });
}

/** 預り金の納付の種類 */
export const PAYMENT_KINDS = {
  incomeTax: { label: '源泉所得税', sub: 'incomeTax' },
  residentTax: { label: '住民税', sub: 'residentTax' },
  social: { label: '社会保険料', sub: 'social' },
};

/** 納付の仕訳の sourceId */
export const paymentSourceId = (kind, key) => `${kind}:${key}`;

/**
 * 預り金の納付の仕訳：借方 預り金（天引きした額）・会社負担の科目（社会保険料の会社負担）／貸方 支払口座
 * @param {{ kind, key, date, amount, companyShare, paymentAccountId, label }} o
 */
export function paymentJournal({ kind, key, date, amount, companyShare = 0, paymentAccountId, label }, { accounts, settings, periodId }) {
  const cfg = resolvePayrollSettings(settings?.payroll, accounts);
  const need = (k) => {
    const a = cfg.accounts[k] && accounts.find((x) => x.id === cfg.accounts[k]);
    if (!a) throw new PayrollSetupError(PAYROLL_ACCOUNT_FIELDS.find((f) => f.key === k).label);
    return a;
  };
  const memo = clip(`${PAYMENT_KINDS[kind].label}の納付 ${label}`);
  const lines = [];
  if (amount > 0) lines.push({ side: 'debit', accountId: need('deposit').id, subAccountId: cfg.subs[PAYMENT_KINDS[kind].sub], amount, taxCategory: 'none', memo });
  if (companyShare > 0) {
    const w = need('welfare');
    lines.push({ side: 'debit', accountId: w.id, subAccountId: null, amount: companyShare, taxCategory: 'none', memo: clip(`${memo}（会社負担）`) });
  }
  lines.push({ side: 'credit', accountId: paymentAccountId || need('payment').id, subAccountId: null, amount: amount + companyShare, taxCategory: 'none', memo });
  return createJournal({ periodId, date, lines, source: 'payroll_payment', sourceId: paymentSourceId(kind, key) });
}

// ---- CSV ----

export function payrollsCsv(list) {
  const rows = [['支給日', '氏名', '区分', '種類', '題名', '課税支給額', '通勤手当（非課税）', '総支給額', '健康保険料', '厚生年金保険料', '雇用保険料', '源泉所得税', '住民税', 'その他の控除', '年末調整（＋徴収・－還付）', '控除合計', '差引支給額', '仕訳']];
  for (const p of list) {
    const t = payrollTotals(p);
    rows.push([p.payDate, p.name, EMPLOYEE_KIND_LABEL[p.employeeKind], PAY_KINDS[p.kind], payrollTitle(p), t.taxable, t.commute, t.gross, p.health || 0, p.pension || 0, p.employment || 0, p.incomeTax || 0, p.residentTax || 0, t.others, t.yearEnd, t.deductions, t.net, p.journalId ? '登録済み' : '未登録']);
  }
  return toCsv(rows);
}
