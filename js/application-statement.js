// 適用額明細書（租特透明化法）：法人税関係特別措置（租税特別措置法）の適用を受けたときに、条項・区分番号・適用額を書いて申告書に添付する（純粋関数）
// 国税庁「適用額明細書の記載の手引（令和8年4月1日以後終了事業年度分）」（2026-10-31 に PDF の文字で確認）
//   https://www.nta.go.jp/publication/pamph/hojin/tekiyougaku/r08.htm
//   - 中小企業者等の法人税率の特例：第42条の３の２第１項の表の第１号・区分番号 00380・適用額は別表一次葉二「74」欄の金額（千円未満切捨て）。
//     別表一「1」欄が0以下なら書かない。適用除外事業者・通算法人は対象外
//   - 中小企業者等の少額減価償却資産の取得価額の損金算入の特例：第67条の５第１項・区分番号 00277・適用額は別表十六(七)「8」欄の金額（年300万円が上限）
// 様式（別記様式）：https://www.nta.go.jp/law/tsutatsu/kobetsu/hojin/010705/pdf/0023005-006.pdf
// このアプリが自動で書くのは上の2つ。賃上げ促進税制などほかの措置は、利用者が条項・区分番号・適用額を入れる

import { RATES } from './corporate-tax.js';

export const MAX_APPLICATION_ROWS = 20;
const MAX_TEXT = 60;

/** 行の初期値（利用者が足す措置） */
export const emptyApplicationRow = () => ({ article: '', code: '', amount: 0 });

/** 入力の検証 */
export function validateApplicationRows(rows = []) {
  if (!Array.isArray(rows) || rows.length > MAX_APPLICATION_ROWS) return [`適用額明細書の行は${MAX_APPLICATION_ROWS}行までです`];
  const errors = [];
  for (const x of rows) {
    if (typeof x.article !== 'string' || !x.article.trim() || x.article.length > MAX_TEXT) errors.push(`適用額明細書の租税特別措置法の条項は1〜${MAX_TEXT}文字で入力してください`);
    if (!/^\d{5}$/.test(String(x.code ?? ''))) errors.push('適用額明細書の区分番号は5桁の数字で入力してください');
    if (!(Number.isInteger(x.amount) && x.amount >= 0 && x.amount <= 1e15)) errors.push('適用額明細書の適用額は0以上の整数の円で入力してください');
  }
  return [...new Set(errors)];
}

/** 保存する形にそろえる */
export function cleanApplicationRows(rows = []) {
  return (rows || []).map((x) => ({ article: String(x.article ?? '').trim(), code: String(x.code ?? '').normalize('NFKC').trim(), amount: x.amount }));
}

const floor1000 = (n) => Math.floor(n / 1000) * 1000;

/**
 * 適用額明細書の行
 * @param {object} p
 * @param {object} p.corp corporateTaxReturn の corp（tiers・income）
 * @param {boolean} p.sme 中小法人
 * @param {{ total: number, limit: number }} [p.smeAssets] 少額減価償却資産の特例を適用した取得価額の合計と上限（depreciation.js の smeUsage）
 * @param {Array} [p.rows] 利用者が足した行
 * @returns {Array<{ name, article, code, amount, auto }>}
 */
export function applicationRows({ corp, sme, smeAssets = null, rows = [] }) {
  const out = [];
  const low = sme ? corp.tiers.find((t) => t.label.startsWith('年800万円相当額以下')) : null;
  // 本則の19%（適用除外事業者など）は法人税法66条で、租税特別措置ではない
  if (low && corp.income > 0 && low.amount > 0 && low.rate !== RATES.smeBase) {
    out.push({ name: '中小企業者等の法人税率の特例', article: '第42条の３の２第１項の表の第１号', code: '00380', amount: floor1000(low.amount), auto: true });
  }
  if (sme && smeAssets && smeAssets.total > 0) {
    out.push({ name: '中小企業者等の少額減価償却資産の取得価額の損金算入の特例', article: '第67条の５第１項', code: '00277', amount: Math.min(smeAssets.total, smeAssets.limit), auto: true });
  }
  for (const x of cleanApplicationRows(rows)) out.push({ name: '', article: x.article, code: x.code, amount: x.amount, auto: false });
  return out;
}

