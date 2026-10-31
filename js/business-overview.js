// 法人事業概況説明書（税務署所管法人用）：帳簿から書ける欄（10 主要科目・18 月別の売上高等の状況・4 期末従事員数など）を集計する（純粋関数）
// 国税庁 法人事業概況説明書（令和6年3月1日以後終了事業年度分）の記載要領（2026-10-31 に PDF の文字で確認）
//   https://www.nta.go.jp/taxes/tetsuzuki/shinsei/annai/hojin/shinkoku/pdf/0021004-100.pdf
//   様式（画像の PDF のため、主要科目の欄の並びは令和2年版の様式の文字で確認）：
//   https://www.nta.go.jp/law/tsutatsu/kobetsu/hojin/010705/pdf/0020004-110.pdf
// - 金額は千円単位（千円未満切捨て）。マイナスは「△」
// - 主要科目は決算額（申告調整の加減算は入れていない。交際費は交際費等の支出額）
// - 「受取手形」「売掛金」は貸倒引当金の控除前、「建物」「機械装置」「車両・船舶」は減価償却累計額の控除後（固定資産台帳の期末帳簿価額）
// - 「個人借入金」は銀行など以外からの借入金（このアプリでは役員借入金）、「その他借入金」はそれ以外の借入金
// 科目は名前でなく、区分（group）・役割（role）・目印（hint）・テンプレートのコードで判定する

import { GROUP_BY_ID } from './accounts.js';
import { closingRows, rangeRows, incomeStatement, balanceSheet } from './statements.js';
import { assetRegister } from './depreciation.js';
import { monthsInPeriod, monthRange } from './period.js';

/** 千円単位（千円未満切捨て。マイナスは絶対値を切り捨てる） */
export const thousand = (n) => (n < 0 ? -Math.floor(-n / 1000) : Math.floor(n / 1000));

const amountOf = (r) => (GROUP_BY_ID[r.account.group]?.side === 'debit' ? r.dc : 0 - r.dc);
const sumWhere = (rows, pred) => rows.filter((r) => pred(r.account)).reduce((s, r) => s + amountOf(r), 0);
const hintIn = (...hints) => (a) => hints.includes(a.hint);
// テンプレートの科目のコード（法人）：外注加工費（製造経費）
const OUTSOURCING_CODES = ['820'];
const PAYROLL_HINTS = ['officer_compensation', 'salaries', 'bonuses', 'wages'];

/**
 * 主要科目（10）と月別の売上高等（18）
 * @param {{ accounts, period, journals, assets?, periods?, entertainment?: number }} p entertainment：支出交際費等の額（別表十五）
 */
export function businessOverview({ accounts, period, journals, assets = [], periods = [], entertainment = null }) {
  const rows = closingRows({ accounts, period, journals });
  const pl = incomeStatement('corporation', rows);
  const bs = balanceSheet('corporation', rows, pl.netIncome);
  const p = pl.profits;
  const cogsRows = rows.filter((r) => ['cost_of_sales', 'mfg_materials', 'mfg_labor', 'mfg_overhead', 'mfg_wip'].includes(r.account.group));
  // 固定資産台帳の期末帳簿価額（種類ごと）
  const register = assetRegister(assets, periods, period);
  const book = (...cats) => register.filter((x) => cats.includes(x.asset.category)).reduce((s, x) => s + (x.closing ?? 0), 0);
  const equity = bs.liabilities.find((s) => s.type === 'group' && s.groups?.includes('equity'))?.total ?? 0;
  const totalLiabilities = bs.totalLiabilitiesAndEquity - equity;

  const items = {
    sales: p.sales,
    cogs: p.cogs,
    openingInventory: sumWhere(cogsRows, (a) => a.role === 'opening_inventory' || ['opening_finished', 'opening_materials', 'opening_wip'].includes(a.hint)),
    purchases: sumWhere(cogsRows, hintIn('purchases', 'material_purchases')),
    labor: sumWhere(cogsRows, (a) => a.group === 'mfg_labor' && a.hint !== 'legal_welfare'),
    outsourcing: sumWhere(cogsRows, (a) => a.template && OUTSOURCING_CODES.includes(a.code)),
    // 期末棚卸高は評価勘定（区分の向きでマイナス）なので、符号を戻して正の額にする
    closingInventory: 0 - sumWhere(cogsRows, (a) => a.role === 'closing_inventory' || ['closing_finished', 'closing_materials', 'closing_wip'].includes(a.hint)),
    cogsDepreciation: sumWhere(cogsRows, hintIn('mfg_depreciation')),
    cogsRent: sumWhere(cogsRows, hintIn('mfg_rent')),
    gross: p.gross,
    officerCompensation: sumWhere(rows, (a) => a.group === 'sga' && a.hint === 'officer_compensation'),
    salaries: sumWhere(rows, (a) => a.group === 'sga' && ['salaries', 'bonuses'].includes(a.hint)),
    entertainment: entertainment ?? sumWhere(rows, (a) => a.group === 'sga' && a.hint === 'entertainment'),
    depreciation: sumWhere(rows, (a) => a.group === 'sga' && a.hint === 'depreciation'),
    rent: sumWhere(rows, (a) => a.group === 'sga' && a.hint === 'rent'),
    operating: p.operating,
    extraordinaryIncome: sumWhere(rows, (a) => a.group === 'extraordinary_income'),
    extraordinaryLoss: sumWhere(rows, (a) => a.group === 'extraordinary_losses'),
    pretax: p.pretax,
    totalAssets: bs.totalAssets,
    cash: sumWhere(rows, (a) => a.role === 'cash' || a.role === 'deposit'),
    notesReceivable: sumWhere(rows, hintIn('notes_receivable')),
    receivable: sumWhere(rows, hintIn('receivable')),
    inventory: sumWhere(rows, (a) => a.group === 'current_assets' && ['inventory', 'finished_goods', 'work_in_process', 'raw_materials', 'supplies'].includes(a.hint)),
    loans: sumWhere(rows, hintIn('short_loan', 'long_loan')),
    building: book('building', 'building_equipment'),
    machinery: book('machinery'),
    vehicles: book('vehicle'),
    land: sumWhere(rows, hintIn('land')),
    totalLiabilities,
    notesPayable: sumWhere(rows, hintIn('notes_payable')),
    payable: sumWhere(rows, hintIn('payable')),
    personalBorrowings: sumWhere(rows, hintIn('officer_loan')),
    otherBorrowings: sumWhere(rows, hintIn('short_borrowings', 'long_borrowings')),
    netAssets: equity,
  };

  // 18 月別の売上高等の状況：売上（収入）金額・仕入金額・外注費・人件費（役員を含む給与・賞与の支給総額）
  const months = monthsInPeriod(period).map((ym) => {
    const { from, to } = monthRange(period, ym, ym);
    const mr = rangeRows({ accounts, period, journals, from, to });
    return {
      month: ym,
      sales: sumWhere(mr, (a) => a.group === 'sales'),
      purchases: sumWhere(mr, hintIn('purchases', 'material_purchases')),
      outsourcing: sumWhere(mr, (a) => a.template && OUTSOURCING_CODES.includes(a.code)),
      payroll: sumWhere(mr, (a) => PAYROLL_HINTS.includes(a.hint) && a.group !== 'family_salary'),
    };
  });
  const monthTotal = Object.fromEntries(['sales', 'purchases', 'outsourcing', 'payroll'].map((k) => [k, months.reduce((s, m) => s + m[k], 0)]));
  return { items, months, monthTotal, balanced: bs.balanced };
}
