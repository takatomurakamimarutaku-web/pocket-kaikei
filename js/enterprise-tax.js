// 事業税の計算（純粋関数）：法人事業税（所得割）・特別法人事業税と、個人事業税
//
// 出典（2026-10-29 確認）
// - 法人事業税 所得割の税率（資本金1億円以下の普通法人＝外形標準課税の対象外。令和元年10月1日以後に開始する事業年度）：
//   年400万円以下の所得 3.5%、年400万円超800万円以下 5.3%、年800万円超 7.0%。
//   3以上の都道府県に事務所等があり資本金1,000万円以上の法人は軽減税率不適用で全所得に7.0%（地方税法 第72条の24の7）
//   茨城県「法人事業税（税率）」の表で確認。東京都など超過課税をする都道府県があるため、税率は変えられるようにする
// - 特別法人事業税：基準法人所得割額（標準税率で計算した所得割額）×37%（特別法人事業税及び特別法人事業譲与税に関する法律 第7条）
// - 個人事業税（滋賀県「個人事業税」で確認）：
//   課税標準＝所得金額（青色申告特別控除前）− 損失の繰越控除等 − 事業主控除290万円（1年未満は月割）
//   税率は第1種事業5%・第2種事業4%・第3種事業5%（あん摩・はり・きゅう・装蹄師業など3%）。確定申告をすれば事業税の申告は不要
//   税額が1万円を超えると8月・11月の2回払い（第2期分の1,000円未満は第1期分に足す）
// - 課税標準は1,000円未満切捨て、税額は100円未満切捨て（地方税法 第20条の4の2）
// 率は 1/1000 % の整数で持つ（3.5% → 3500）。浮動小数点を使わない
import { isYen } from './money.js';

/** 所得割の標準税率（1/1000 %）：[年400万円以下, 400万円超800万円以下, 800万円超] */
export const STANDARD_RATES = [3500, 5300, 7000];
/** 特別法人事業税の税率（%） */
export const SPECIAL_RATE = 37;

/** 個人事業税の業種の区分 */
export const INDUSTRIES = [
  { id: 'type1', label: '第1種事業（物品販売業・飲食店業・製造業・不動産貸付業など）', rate: 5000 },
  { id: 'type3', label: '第3種事業（医業・税理士業・デザイン業・コンサルタント業・理容業など）', rate: 5000 },
  { id: 'type2', label: '第2種事業（畜産業・水産業・薪炭製造業）', rate: 4000 },
  { id: 'type3low', label: '第3種事業のうち あん摩・マッサージ・はり・きゅう・柔道整復・装蹄師業など', rate: 3000 },
  { id: 'exempt', label: '課税されない業種（文筆業・農業など法定業種に当たらない事業）', rate: 0 },
];
export const INDUSTRY_BY_ID = Object.fromEntries(INDUSTRIES.map((x) => [x.id, x]));

/** 事業主控除（1年未満は月割。滋賀県の月割額の表） */
export const OWNER_DEDUCTION = [0, 242000, 484000, 725000, 967000, 1209000, 1450000, 1692000, 1934000, 2175000, 2417000, 2659000, 2900000];

/** 入力の初期値（period.enterpriseTax） */
export const DEFAULT_ENTERPRISE_TAX = {
  // 法人
  income: null, // null なら損益計算書の税引前当期純利益
  reduced: true, // 軽減税率を適用する
  rates: STANDARD_RATES,
  interimTax: 0, // 中間納付した事業税
  interimSpecial: 0, // 中間納付した特別法人事業税
  // 個人
  industry: 'type1',
  months: 12,
  lossCarry: 0, // 損失の繰越控除・被災事業用資産の損失の繰越控除など
};

/** 入力の検証。エラーメッセージの配列を返す */
export function validateEnterpriseTax(v) {
  const errors = [];
  if (v.income !== null && !isYen(v.income)) errors.push('所得金額は整数の円で入力してください');
  if (typeof v.reduced !== 'boolean') errors.push('軽減税率を適用するかを選んでください');
  if (!Array.isArray(v.rates) || v.rates.length !== 3 || v.rates.some((r) => !Number.isInteger(r) || r < 0 || r > 20000)) errors.push('税率は0〜20%の範囲で、小数第3位まで入力してください');
  for (const k of ['interimTax', 'interimSpecial', 'lossCarry']) if (!isYen(v[k]) || v[k] < 0) errors.push('中間納付額・控除額は0以上の整数で入力してください');
  if (!INDUSTRY_BY_ID[v.industry]) errors.push('業種の区分を選んでください');
  if (!Number.isInteger(v.months) || v.months < 1 || v.months > 12) errors.push('事業を行った月数は1〜12で入力してください');
  return [...new Set(errors)];
}

const floor1000 = (n) => Math.floor(n / 1000) * 1000;
const floor100 = (n) => Math.floor(n / 100) * 100;
/** 金額×率（1/1000 %）の1円未満切捨て */
const applyRate = (amount, rate) => Math.floor((amount * rate) / 100000);

/** 率の表示（3500 → "3.5"、5665 → "5.665"） */
export function formatPercent(rate) {
  return String(rate / 1000);
}

/** "3.75" → 3750。小数第3位まで。不正なら NaN */
export function parsePercent(text) {
  const s = String(text).trim();
  const m = /^(\d{1,2})(?:\.(\d{1,3}))?$/.exec(s);
  if (!m) return NaN;
  return Number(m[1]) * 1000 + Number((m[2] || '').padEnd(3, '0'));
}

/** 所得を税率の区分に分ける。月数が12未満なら区分の金額を月割にする（1,000円未満切捨て） */
function brackets(base, months, reduced) {
  if (!reduced) return [0, 0, base];
  const t1 = floor1000(Math.floor((4000000 * months) / 12));
  const t2 = floor1000(Math.floor((8000000 * months) / 12));
  return [Math.min(base, t1), Math.min(Math.max(base - t1, 0), t2 - t1), Math.max(base - t2, 0)];
}

/**
 * 法人事業税（所得割）と特別法人事業税
 * @param {{ income: number, months: number, reduced: boolean, rates: number[], interimTax: number, interimSpecial: number }}
 * @returns {{ base, months, limits, rows: Array<{ label, amount, rate, tax }>, incomeTax, standardTax, special, interimTax, interimSpecial, dueTax, dueSpecial, total }}
 */
export function corporateEnterpriseTax({ income, months = 12, reduced = true, rates = STANDARD_RATES, interimTax = 0, interimSpecial = 0 }) {
  const base = income > 0 ? floor1000(income) : 0;
  const parts = brackets(base, months, reduced);
  const labels = reduced ? ['年400万円以下の金額', '年400万円を超え年800万円以下の金額', '年800万円を超える金額'] : ['', '', '軽減税率不適用法人の所得'];
  const rows = parts.map((amount, i) => ({ label: labels[i], amount, rate: rates[i], tax: applyRate(amount, rates[i]) })).filter((r, i) => reduced || i === 2);
  const incomeTax = floor100(rows.reduce((s, r) => s + r.tax, 0));
  const standardTax = floor100(parts.reduce((s, a, i) => s + applyRate(a, STANDARD_RATES[i]), 0));
  const special = floor100(Math.floor((standardTax * SPECIAL_RATE) / 100));
  const dueTax = incomeTax - interimTax;
  const dueSpecial = special - interimSpecial;
  const limits = [floor1000(Math.floor((4000000 * months) / 12)), floor1000(Math.floor((8000000 * months) / 12))];
  return { base, months, limits, reduced, rows, incomeTax, standardTax, special, interimTax, interimSpecial, dueTax, dueSpecial, total: dueTax + dueSpecial };
}

/**
 * 個人事業税
 * @param {{ income: number, industry: string, months: number, lossCarry: number }}
 * @returns {{ income, lossCarry, deduction, base, rate, tax, first, second, exempt }}
 */
export function individualEnterpriseTax({ income, industry = 'type1', months = 12, lossCarry = 0 }) {
  const ind = INDUSTRY_BY_ID[industry] || INDUSTRY_BY_ID.type1;
  const deduction = OWNER_DEDUCTION[months];
  const base = floor1000(Math.max(0, income - lossCarry - deduction));
  const tax = ind.rate ? floor100(applyRate(base, ind.rate)) : 0;
  // 1万円を超えると2回払い（第2期分の1,000円未満は第1期分へ）
  const second = tax > 10000 ? floor1000(Math.floor(tax / 2)) : 0;
  return { income, lossCarry, deduction, base, rate: ind.rate, industry: ind, tax, first: tax - second, second, exempt: ind.rate === 0 };
}
