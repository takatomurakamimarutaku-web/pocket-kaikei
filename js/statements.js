// 損益計算書・貸借対照表（純粋関数）
//
// 区分の向き（資産・費用は借方、負債・純資産・収益は貸方）をプラスとして集計する。
// 評価勘定（減価償却累計額・期末商品棚卸高など）は区分と逆の残高なので、自動的にマイナス（△）になる。
// 個人の様式は国税庁「青色申告決算書（一般用）」の損益計算書・貸借対照表の並びに合わせる。
import { GROUP_BY_ID, compareAccounts, groupLabel, MFG_GROUPS, isContra, isReGroup } from './accounts.js';
import { trialBalance } from './ledger.js';

/** 科目の期末残高（dc）を区分の向きの金額にする */
function groupAmount(row) {
  return GROUP_BY_ID[row.account.group].side === 'debit' ? row.dc : 0 - row.dc;
}

/** 区分ごとの科目の行と合計 */
function collect(rows, groupIds) {
  const lines = rows
    .filter((r) => groupIds.includes(r.account.group))
    .sort((a, b) => compareAccounts(a.account, b.account))
    .map((r) => ({ account: r.account, amount: groupAmount(r) }));
  return { lines, total: lines.reduce((s, l) => s + l.amount, 0) };
}

const section = (label, groupIds, rows, opts = {}) => ({ type: 'group', label, groups: groupIds, ...collect(rows, groupIds), ...opts });
const subtotal = (label, amount, opts = {}) => ({ type: 'subtotal', label, amount, ...opts });

/**
 * 期末時点（to）の集計の元。期間の初日から to までの全仕訳と期首残高
 */
export function closingRows({ accounts, period, journals, to = period.endDate }) {
  return trialBalance({ accounts, period, journals, from: period.startDate, to }).rows;
}

/** 損益計算書の売上原価に入れる「当期製品製造原価」の行（科目ではないが、科目の行と同じ形で並べる） */
export const MFG_COST_LINE = Object.freeze({ id: 'mfg_cost', code: '', name: '当期製品製造原価', group: 'cost_of_sales', normalSide: 'debit', synthetic: true });

/**
 * 製造原価報告書（法人）
 *   材料費＋労務費＋製造経費＝当期総製造費用
 *   当期総製造費用＋期首仕掛品棚卸高−期末仕掛品棚卸高＝当期製品製造原価
 * 様式は財務諸表等規則 第75条第2項・ガイドライン75-2の製造原価明細書の並び（他勘定振替高は扱わない）
 * @returns {{ used: boolean, items: Array, totalCost: number, cost: number }}
 *   used：製造原価の区分の科目があるか。cost：当期製品製造原価（売上原価に入る額）
 */
export function manufacturingReport(rows) {
  const used = rows.some((r) => MFG_GROUPS.includes(r.account.group));
  const materials = section('材料費', ['mfg_materials'], rows);
  const labor = section('労務費', ['mfg_labor'], rows);
  const overhead = section('製造経費', ['mfg_overhead'], rows);
  const totalCost = materials.total + labor.total + overhead.total;
  // 仕掛品：期首（借方の科目）は足し、期末（評価勘定）は区分の向きでマイナスになる
  const wip = collect(rows, ['mfg_wip']).lines;
  const opening = wip.filter((l) => !isContra(l.account)).reduce((s, l) => s + l.amount, 0);
  const closing = wip.filter((l) => isContra(l.account)).reduce((s, l) => s + l.amount, 0);
  const cost = totalCost + opening + closing;
  return {
    used,
    items: [
      materials,
      labor,
      overhead,
      subtotal('当期総製造費用', totalCost),
      subtotal('期首仕掛品棚卸高', opening, { plain: true }),
      subtotal('合計', totalCost + opening),
      subtotal('期末仕掛品棚卸高', closing, { plain: true }),
      subtotal('当期製品製造原価', cost, { strong: true }),
    ],
    totalCost,
    cost,
  };
}

/** 売上原価の区分。製造原価の科目があれば「当期製品製造原価」の行を期末の棚卸高（評価勘定）の前に入れる */
function costOfSales(rows) {
  const cogs = section('売上原価', ['cost_of_sales'], rows);
  const mfg = manufacturingReport(rows);
  if (!mfg.used) return cogs;
  const at = cogs.lines.findIndex((l) => isContra(l.account));
  const line = { account: MFG_COST_LINE, amount: mfg.cost };
  const lines = at < 0 ? [...cogs.lines, line] : [...cogs.lines.slice(0, at), line, ...cogs.lines.slice(at)];
  return { ...cogs, lines, total: cogs.total + mfg.cost };
}

/**
 * 個人の所得金額（帳簿の利益）の呼び名。青色申告は青色申告特別控除の前、白色申告は事業専従者控除の前の金額
 * （白色申告では家族への給与は経費にならず、収支内訳書で専従者控除を差し引くため）
 */
export function incomeBeforeLabel(white = false) {
  return white ? { full: '専従者控除前の所得金額', short: '専従者控除前' } : { full: '青色申告特別控除前の所得金額', short: '青色申告特別控除前' };
}

/**
 * 損益計算書
 * @returns {{ items: Array, netIncome: number, profits: Record<string, number> }}
 *   profits：売上・売上原価・販管費（経費）の合計と段階利益（経営分析で使う）
 *   items：画面にそのまま並べる行（group：区分と科目、subtotal：段階利益）
 *   netIncome：法人は当期純利益、個人は青色申告特別控除前の所得金額（不動産所得があれば事業所得との合計）
 * @param {{ white?: boolean }} [opts] white：白色申告（所得金額の呼び名を「専従者控除前」にする）
 */
export function incomeStatement(entityType, rows, { white = false } = {}) {
  if (entityType === 'individual') {
    const before = incomeBeforeLabel(white);
    const sales = section(groupLabel('sales', 'individual'), ['sales'], rows);
    const cogs = section('売上原価', ['cost_of_sales'], rows);
    const diff1 = sales.total - cogs.total;
    const sga = section('経費', ['sga'], rows);
    const diff2 = diff1 - sga.total;
    const reversal = section('各種引当金・準備金等 繰戻額等', ['reserves_reversal'], rows);
    const family = section('専従者給与', ['family_salary'], rows);
    const provision = section('各種引当金・準備金等 繰入額等', ['reserves_provision'], rows);
    const business = diff2 + reversal.total - family.total - provision.total;
    const items = [sales, cogs, subtotal('差引金額', diff1), sga, subtotal('差引金額', diff2), reversal, family, provision];
    // 不動産所得の科目があれば、事業所得と分けて出す（青色申告決算書は一般用と不動産所得用に分かれる）
    if (!rows.some((r) => isReGroup(r.account.group))) {
      items.push(subtotal(before.full, business, { strong: true }));
      return { items, netIncome: business, profits: { sales: sales.total, cogs: cogs.total, diff1, sga: sga.total, diff2, income: business, businessIncome: business, realEstateIncome: 0 } };
    }
    const reIncome = section('不動産収入', ['re_income'], rows);
    const reExpenses = section('不動産経費', ['re_expenses'], rows);
    const reFamily = section('専従者給与（不動産）', ['re_family_salary'], rows);
    const realEstate = reIncome.total - reExpenses.total - reFamily.total;
    const income = business + realEstate;
    items.push(
      subtotal(`事業所得（${before.short}）`, business),
      reIncome,
      reExpenses,
      reFamily,
      subtotal(`不動産所得（${before.short}）`, realEstate),
      subtotal(`${before.full}（合計）`, income, { strong: true }),
    );
    return { items, netIncome: income, profits: { sales: sales.total, cogs: cogs.total, diff1, sga: sga.total, diff2, income, businessIncome: business, realEstateIncome: realEstate } };
  }
  const sales = section('売上高', ['sales'], rows);
  const cogs = costOfSales(rows);
  const gross = sales.total - cogs.total;
  const sga = section('販売費及び一般管理費', ['sga'], rows);
  const operating = gross - sga.total;
  const noi = section('営業外収益', ['non_operating_income'], rows);
  const noe = section('営業外費用', ['non_operating_expenses'], rows);
  const ordinary = operating + noi.total - noe.total;
  const ei = section('特別利益', ['extraordinary_income'], rows);
  const el = section('特別損失', ['extraordinary_losses'], rows);
  const pretax = ordinary + ei.total - el.total;
  const taxes = section('法人税等', ['income_taxes'], rows);
  const net = pretax - taxes.total;
  return {
    items: [
      sales,
      cogs,
      subtotal('売上総利益', gross),
      sga,
      subtotal('営業利益', operating),
      noi,
      noe,
      subtotal('経常利益', ordinary),
      ei,
      el,
      subtotal('税引前当期純利益', pretax),
      taxes,
      subtotal('当期純利益', net, { strong: true }),
    ],
    netIncome: net,
    profits: { sales: sales.total, cogs: cogs.total, gross, sga: sga.total, operating, nonOperatingIncome: noi.total, nonOperatingExpenses: noe.total, ordinary, pretax, net },
  };
}

/**
 * 貸借対照表
 * @param {number} netIncome incomeStatement の netIncome
 * @param {{ white?: boolean }} [opts]
 * @returns {{ assets: Array, liabilities: Array, totalAssets: number, totalLiabilitiesAndEquity: number, balanced: boolean }}
 */
export function balanceSheet(entityType, rows, netIncome, { white = false } = {}) {
  if (entityType === 'individual') {
    const current = section('流動資産', ['current_assets'], rows);
    const fixed = section('固定資産', ['tangible_fixed_assets', 'intangible_fixed_assets', 'investments', 'deferred_assets'], rows);
    const drawings = section('事業主貸', ['owner_drawings'], rows);
    const totalAssets = current.total + fixed.total + drawings.total;
    const liabilities = section('負債', ['current_liabilities', 'fixed_liabilities'], rows);
    const capital = section('資本', ['equity'], rows);
    const totalLE = liabilities.total + capital.total + netIncome;
    return {
      assets: [current, fixed, drawings, subtotal('資産合計', totalAssets, { strong: true })],
      liabilities: [
        liabilities,
        capital,
        subtotal(incomeBeforeLabel(white).full, netIncome),
        subtotal('負債・資本合計', totalLE, { strong: true }),
      ],
      totalAssets,
      totalLiabilitiesAndEquity: totalLE,
      balanced: totalAssets === totalLE,
    };
  }
  const current = section('流動資産', ['current_assets'], rows);
  const tangible = section('有形固定資産', ['tangible_fixed_assets'], rows, { level: 2 });
  const intangible = section('無形固定資産', ['intangible_fixed_assets'], rows, { level: 2 });
  const investments = section('投資その他の資産', ['investments'], rows, { level: 2 });
  const fixedTotal = tangible.total + intangible.total + investments.total;
  const deferred = section('繰延資産', ['deferred_assets'], rows);
  const totalAssets = current.total + fixedTotal + deferred.total;
  const curLiab = section('流動負債', ['current_liabilities'], rows);
  const fixLiab = section('固定負債', ['fixed_liabilities'], rows);
  const totalLiab = curLiab.total + fixLiab.total;
  // 繰越利益剰余金に当期純利益を含めて表示し、その下に「うち当期純利益」を出す
  const equity = section('純資産', ['equity'], rows);
  equity.lines = equity.lines.map((l) =>
    l.account.role === 'retained_earnings' ? { ...l, amount: l.amount + netIncome, note: { label: 'うち当期純利益', amount: netIncome } } : l,
  );
  equity.total += netIncome;
  const totalLE = totalLiab + equity.total;
  return {
    assets: [
      current,
      subtotal('固定資産', fixedTotal, { heading: true }),
      tangible,
      intangible,
      investments,
      deferred,
      subtotal('資産合計', totalAssets, { strong: true }),
    ],
    liabilities: [
      curLiab,
      fixLiab,
      subtotal('負債合計', totalLiab),
      equity,
      subtotal('負債・純資産合計', totalLE, { strong: true }),
    ],
    totalAssets,
    totalLiabilitiesAndEquity: totalLE,
    balanced: totalAssets === totalLE,
  };
}

/** PL と BS をまとめて作る */
export function buildStatements({ entityType, accounts, period, journals, to, white = false }) {
  const rows = closingRows({ accounts, period, journals, to });
  const pl = incomeStatement(entityType, rows, { white });
  const bs = balanceSheet(entityType, rows, pl.netIncome, { white });
  return { pl, bs };
}
