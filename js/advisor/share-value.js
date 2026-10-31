// 経営サポート：事業承継のための自社株の評価額の概算（純粋関数）
//
// 財産評価基本通達の「取引相場のない株式」の原則的評価方式（同族株主が取得する場合）を、帳簿の数字から簡便に計算する。
// - 会社規模（評基通178）：従業員数・総資産価額（帳簿価額）・取引金額と業種（卸売業／小売・サービス業／それ以外）で、大会社・中会社（L＝0.90／0.75／0.60）・小会社
// - 類似業種比準価額（評基通180）：A ×（b/B ＋ c/C ＋ d/D）÷ 3 × 斟酌率（大0.7・中0.6・小0.5）。1株当たりの資本金等の額を50円とした株数で計算し、最後に戻す
// - 純資産価額（評基通185）：（相続税評価額の純資産 − 評価差額 × 37%）÷ 発行済株式数
// - 評価額（評基通179）：大会社＝類似と純資産の低い方、中会社＝類似×L＋純資産×(1−L) と純資産の低い方、小会社＝純資産と（類似×0.5＋純資産×0.5）の低い方
// 端数は評価明細書の扱い（比準割合は小数点以下2位未満切捨て、50円当たりの比準価額は10銭未満切捨て など）に合わせる。
// あくまで試算：相続税評価額での資産の評価（土地・有価証券など）は「含み益」の入力だけ、特定の評価会社（株式等保有・土地保有・比準要素数1など）、
// 同族株主以外の配当還元方式、直前々期との平均の選択などは扱わない。正式な評価は税理士に依頼する前提（たかとの方針）
import { isYen } from '../money.js';

/** 業種の区分 */
export const INDUSTRIES = [
  { id: 'wholesale', label: '卸売業' },
  { id: 'retail', label: '小売・サービス業' },
  { id: 'other', label: '卸売業、小売・サービス業以外' },
];

/** 斟酌率（‰ではなく 1/10 単位：7 は 0.7） */
export const KAPPA = { large: 7, medium: 6, small: 5 };
/** 評価差額に対する法人税額等に相当する金額の割合（%） */
export const CORP_TAX_RATE_ON_GAIN = 37;
/** 大会社とする従業員数 */
export const LARGE_EMPLOYEES = 70;

// 会社規模の判定表（評基通178・179）。単位は円
// 総資産価額（帳簿価額）と従業員数：[区分, 総資産の下限, 従業員の下限（この人数を超える）]
const ASSET_TABLE = {
  wholesale: [['large', 2000000000, 35], ['m90', 400000000, 35], ['m75', 200000000, 20], ['m60', 70000000, 5]],
  retail: [['large', 1500000000, 35], ['m90', 500000000, 35], ['m75', 250000000, 20], ['m60', 40000000, 5]],
  other: [['large', 1500000000, 35], ['m90', 500000000, 35], ['m75', 250000000, 20], ['m60', 50000000, 5]],
};
// 取引金額：[区分, 下限]
const SALES_TABLE = {
  wholesale: [['large', 3000000000], ['m90', 700000000], ['m75', 350000000], ['m60', 200000000]],
  retail: [['large', 2000000000], ['m90', 500000000], ['m75', 250000000], ['m60', 60000000]],
  other: [['large', 1500000000], ['m90', 400000000], ['m75', 200000000], ['m60', 80000000]],
};
const ORDER = ['small', 'm60', 'm75', 'm90', 'large'];
const L_OF = { m90: 90, m75: 75, m60: 60 };
export const SIZE_LABELS = { large: '大会社', m90: '中会社の大（L＝0.90）', m75: '中会社の中（L＝0.75）', m60: '中会社の小（L＝0.60）', small: '小会社' };

/**
 * 会社規模の判定
 * @param {{ industry, employees, totalAssets, sales }} p 従業員数（人）、総資産価額（帳簿価額）、取引金額（直前期末以前1年間）
 * @returns {{ size: 'large'|'m90'|'m75'|'m60'|'small', kind: 'large'|'medium'|'small', L: number|null, byAssets, bySales }}
 *   L：中会社の割合（%）
 */
export function companySize({ industry, employees, totalAssets, sales }) {
  const ind = ASSET_TABLE[industry] ? industry : 'other';
  if (employees >= LARGE_EMPLOYEES) return { size: 'large', kind: 'large', L: null, byAssets: 'large', bySales: 'large' };
  // 総資産と従業員：両方を満たす区分（低い方）
  const byAssets = ASSET_TABLE[ind].find(([, min, emp]) => totalAssets >= min && employees > emp)?.[0] || 'small';
  const bySales = SALES_TABLE[ind].find(([, min]) => sales >= min)?.[0] || 'small';
  const size = ORDER[Math.max(ORDER.indexOf(byAssets), ORDER.indexOf(bySales))];
  const kind = size === 'large' ? 'large' : size === 'small' ? 'small' : 'medium';
  return { size, kind, L: L_OF[size] ?? null, byAssets, bySales };
}

/**
 * 類似業種比準価額（1株当たり）
 * @param {object} p
 * @param {number} p.capital 資本金等の額（円）
 * @param {number} p.shares 発行済株式数（自己株式を除く）
 * @param {number} p.dividends 年配当金額（直前期末以前2年間の平均。特別配当などを除く）
 * @param {number} p.profit 年利益金額（法人税の課税所得金額を基に、非経常的な利益を除いたもの）
 * @param {number} p.netAssets 純資産価額（帳簿価額。資本金等の額＋利益積立金額）
 * @param {{ A, B10, C, D }} p.peer 類似業種の株価 A（円）・配当 B（10銭単位：4.4円→44）・利益 C（円）・純資産 D（円）
 * @param {'large'|'medium'|'small'} p.kind
 * @returns {{ n50, b10, c, d, rb, rc, rd, ratio, per50x10, price } | null} ratio・rb などは100分の1単位。per50x10：50円当たりの比準価額（10銭単位）
 */
export function comparablePrice({ capital, shares, dividends, profit, netAssets, peer, kind }) {
  if (!(capital > 0 && shares > 0) || !peer || !(peer.A > 0)) return null;
  const n50 = Math.floor(capital / 50);
  if (n50 <= 0) return null;
  const b10 = Math.max(0, Math.floor((Math.max(0, dividends) * 10) / n50));
  const c = Math.max(0, Math.floor(profit / n50));
  const d = Math.max(0, Math.floor(netAssets / n50));
  const part = (x, y) => (y > 0 ? Math.floor((x * 100) / y) : 0);
  const rb = part(b10, peer.B10);
  const rc = part(c, peer.C);
  const rd = part(d, peer.D);
  const ratio = Math.floor((rb + rc + rd) / 3);
  const per50x10 = Math.floor((peer.A * ratio * KAPPA[kind]) / 100);
  // 1株当たりの資本金等の額÷50円 を掛けて戻す（円未満切捨て）
  const price = Math.floor((per50x10 * capital) / (500 * shares));
  return { n50, b10, c, d, rb, rc, rd, ratio, per50x10, price };
}

/**
 * 純資産価額（1株当たり）
 * @param {{ totalAssets, liabilities, gain, shares }} p gain：含み益（相続税評価額−帳簿価額。含み損はマイナス）
 */
export function netAssetPrice({ totalAssets, liabilities, gain = 0, shares }) {
  if (!(shares > 0)) return null;
  const evalNet = totalAssets + gain - liabilities;
  const bookNet = totalAssets - liabilities;
  const diff = evalNet - bookNet;
  const tax = diff > 0 ? Math.floor((diff * CORP_TAX_RATE_ON_GAIN) / 100) : 0;
  const price = Math.max(0, Math.floor((evalNet - tax) / shares));
  return { evalNet, bookNet, diff, tax, price };
}

/**
 * 1株当たりの評価額（原則的評価方式）と株式全体の評価額
 * @param {object} input 画面の入力（DEFAULT_SUCCESSION の形）
 * @param {object} figures 帳簿から取った数字 { totalAssets, liabilities, netAssets, profit, sales, capital }
 * @returns {{ size, comparable, net, price, total, method, notes: string[] }}
 */
export function shareValuation(input, figures) {
  const v = { ...DEFAULT_SUCCESSION, ...input };
  const notes = [];
  const capital = v.capital ?? figures.capital;
  const sales = figures.sales;
  const size = companySize({ industry: v.industry, employees: v.employees, totalAssets: figures.totalAssets, sales });
  const profit = figures.profit - (v.profitCut || 0);
  const netAssetsBook = figures.netAssets - (v.profitCut || 0);
  const liabilities = figures.liabilities;
  const totalAssets = figures.totalAssets - (v.profitCut || 0);
  const peer = v.peer && v.peer.A > 0 ? v.peer : null;
  const comparable = peer ? comparablePrice({ capital, shares: v.shares, dividends: v.dividends, profit, netAssets: netAssetsBook, peer, kind: size.kind }) : null;
  const net = netAssetPrice({ totalAssets, liabilities, gain: v.gain, shares: v.shares });
  if (!peer) notes.push('類似業種の株価などが未入力なので、純資産価額だけで計算しています。');
  if (!net) return { size, comparable, net, price: null, total: null, method: null, notes: ['発行済株式数を入れてください。'] };
  let price;
  let method;
  if (!comparable) {
    price = net.price;
    method = '純資産価額';
  } else if (size.kind === 'large') {
    price = Math.min(comparable.price, net.price);
    method = comparable.price <= net.price ? '類似業種比準価額' : '純資産価額（低い方）';
  } else if (size.kind === 'medium') {
    const mixed = Math.floor((comparable.price * size.L + net.price * (100 - size.L)) / 100);
    price = Math.min(mixed, net.price);
    method = mixed <= net.price ? `類似業種比準価額×${size.L / 100}＋純資産価額×${(100 - size.L) / 100}` : '純資産価額（低い方）';
  } else {
    const mixed = Math.floor((comparable.price * 50 + net.price * 50) / 100);
    price = Math.min(mixed, net.price);
    method = mixed < net.price ? '類似業種比準価額×0.5＋純資産価額×0.5' : '純資産価額';
  }
  if (comparable && comparable.c === 0) notes.push('利益が0以下です。比準要素数が少ない会社（比準要素数1の会社など）は、純資産価額で評価することがあります（この試算では判定していません）。');
  return { size, comparable, net, price, total: price * v.shares, method, notes };
}

/** 入力の初期値（period.succession に保存） */
export const DEFAULT_SUCCESSION = {
  basis: 'landing', // landing：当期の着地見込み／previous：前期の決算
  industry: 'other',
  employees: 0,
  shares: 0,
  capital: null, // 資本金等の額（null なら帳簿の資本金＋資本剰余金）
  dividends: 0, // 年配当金額（直前2年の平均）
  gain: 0, // 含み益（相続税評価額−帳簿価額）
  peer: { A: 0, B10: 0, C: 0, D: 0 },
  profitCut: 0, // 対策の試算：利益を下げる額（役員退職金など）
};

const isInt = (n, min = 0) => Number.isInteger(n) && n >= min;

/** 入力の検証 */
export function validateSuccession(v) {
  const e = [];
  if (!v || typeof v !== 'object') return ['事業承継の入力が不正です'];
  if (!['landing', 'previous'].includes(v.basis)) e.push('評価の元にする決算を選んでください');
  if (!INDUSTRIES.some((i) => i.id === v.industry)) e.push('業種を選んでください');
  if (!isInt(v.employees) || v.employees > 100000) e.push('従業員数は0以上の整数で入れてください');
  if (!isInt(v.shares) || v.shares > 1e12) e.push('発行済株式数は0以上の整数で入れてください');
  if (v.capital !== null && !(isYen(v.capital) && v.capital >= 0)) e.push('資本金等の額は0以上の整数の円で入れてください');
  if (!(isYen(v.dividends) && v.dividends >= 0)) e.push('配当金額は0以上の整数の円で入れてください');
  if (!isYen(v.gain)) e.push('含み益は整数の円で入れてください');
  if (!(isYen(v.profitCut) && v.profitCut >= 0)) e.push('利益を下げる額は0以上の整数の円で入れてください');
  const p = v.peer || {};
  for (const k of ['A', 'B10', 'C', 'D']) if (!isInt(p[k]) || p[k] > 1e9) e.push('類似業種の数字は0以上で入れてください');
  return [...new Set(e)];
}

/**
 * 帳簿（貸借対照表・損益計算書）から評価に使う数字を取る
 * @param {object} p
 * @param {object} p.bs buildStatements の bs（法人）
 * @param {object} p.pl buildStatements の pl
 * @param {number} p.taxableIncome 法人税の所得金額（類似業種比準の利益に使う）
 * @param {number} [p.incomeTaxes] 着地見込みのときの法人税等（まだ仕訳が無いので負債に足し、純資産から引く）
 * @returns {{ totalAssets, liabilities, netAssets, capital, profit, sales }}
 */
export function figuresFrom({ bs, pl, taxableIncome, incomeTaxes = 0 }) {
  const equity = bs.liabilities.find((s) => Array.isArray(s.lines) && s.lines.some((l) => l.account?.group === 'equity')) || { lines: [], total: 0 };
  const isCapital = (a) => a.role === 'capital_stock' || a.hint === 'capital_reserve' || /資本金|資本剰余金|資本準備金/.test(a.name);
  const capital = equity.lines.filter((l) => isCapital(l.account)).reduce((s, l) => s + l.amount, 0);
  const netAssets = equity.total - incomeTaxes;
  return { totalAssets: bs.totalAssets, liabilities: bs.totalAssets - netAssets, netAssets, capital, profit: Math.max(0, taxableIncome || 0), sales: pl.profits.sales };
}
