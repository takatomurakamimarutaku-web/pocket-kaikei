// 青色申告決算書（一般用）の各欄の集計（純粋関数）。個人事業主だけ
// 欄の並びは国税庁「青色申告決算書（一般用）の書き方」（令和7年分）と様式（令和7年分）で確認した（2026-10-29）
//   書き方 https://www.nta.go.jp/taxes/shiraberu/shinkoku/tebiki/2025/pdf/037.pdf
//     経費（⑧〜㉛）、⑧租税公課、⑱減価償却費、⑳給料賃金、繰戻額等（㉞〜㊱）、専従者給与（㊳）、繰入額等（㊴〜㊶）、
//     貸借対照表の青色申告特別控除前の所得金額＝損益計算書の㊸
//   様式 https://www.nta.go.jp/taxes/shiraberu/shinkoku/yoshiki/01/shinkokusho/pdf/r07/10.pdf
//     経費18科目の並び（租税公課〜貸倒金・雑費）、貸借対照表の科目の並び（現金〜事業主貸、支払手形〜元入金）
// 科目と欄の対応は、テンプレートの科目コードで決める（科目名は利用者が変えられるため名前では判定しない）。
// テンプレートにない科目は、経費は空欄の行（㉕〜㉚）、資産・負債は空欄の行に入れる
import { trialBalance } from './ledger.js';
import { monthsInPeriod, monthRange } from './period.js';
import { isBsGroup } from './accounts.js';
import { assetRegister, CATEGORY_BY_ID, METHOD_BY_ID, usesLife } from './depreciation.js';

/** 損益計算書の経費の欄（テンプレートのコード → 欄番号と様式の科目名） */
export const EXPENSE_LINES = [
  ['600', 8, '租税公課'],
  ['601', 9, '荷造運賃'],
  ['602', 10, '水道光熱費'],
  ['603', 11, '旅費交通費'],
  ['604', 12, '通信費'],
  ['605', 13, '広告宣伝費'],
  ['606', 14, '接待交際費'],
  ['607', 15, '損害保険料'],
  ['608', 16, '修繕費'],
  ['609', 17, '消耗品費'],
  ['610', 18, '減価償却費'],
  ['611', 19, '福利厚生費'],
  ['612', 20, '給料賃金'],
  ['613', 21, '外注工賃'],
  ['614', 22, '利子割引料'],
  ['615', 23, '地代家賃'],
  ['616', 24, '貸倒金'],
];
const MISC_CODE = '699'; // ㉛ 雑費
const BLANK_EXPENSE_LINES = [25, 26, 27, 28, 29, 30];

/** 貸借対照表の行（テンプレートのコード → 様式の科目名）。null は空欄の行を入れる位置 */
export const BS_ASSET_LINES = [
  ['100', '現金'],
  ['110', '当座預金'],
  ['111', '定期預金'],
  ['112', 'その他の預金'],
  ['120', '受取手形'],
  ['121', '売掛金'],
  ['130', '有価証券'],
  ['140', '棚卸資産'],
  ['150', '前払金'],
  ['151', '貸付金'],
  ['200', '建物'],
  ['201', '建物附属設備'],
  ['202', '機械装置'],
  ['203', '車両運搬具'],
  ['204', '工具 器具 備品'],
  ['205', '土地'],
  [null, ''],
  ['290', '事業主貸'],
];
export const BS_LIABILITY_LINES = [
  ['300', '支払手形'],
  ['301', '買掛金'],
  ['302', '借入金'],
  ['303', '未払金'],
  ['304', '前受金'],
  ['305', '預り金'],
  [null, ''],
  ['309', '貸倒引当金'],
  ['400', '事業主借'],
  ['410', '元入金'],
];

/** 青色申告特別控除額の選択肢（令和9年分以後は75万円が加わり、10万円の対象が変わる。国税庁「青色申告特別控除の見直し」） */
export const BLUE_DEDUCTIONS = [
  { value: 650000, label: '65万円（複式簿記・e-Tax または優良な電子帳簿）' },
  { value: 550000, label: '55万円（複式簿記・書面で提出）' },
  { value: 100000, label: '10万円' },
  { value: 750000, label: '75万円（令和9年分以後・優良な電子帳簿など）' },
  { value: 0, label: '適用しない' },
];

const templateAccount = (accounts, code) => accounts.find((a) => a.template && a.code === code) || null;

/**
 * 1ページ目：損益計算書
 * @returns {{ lines: Object<number, number>, expenses: Array<{ no, label, amount, accounts }>, blankExpenses, overflow, ... }}
 *   lines[n]：欄 n の金額
 */
export function blueIncomeStatement({ accounts, period, journals, deduction = 650000 }) {
  const rows = trialBalance({ accounts, period, journals }).rows.filter((r) => !isBsGroup(r.account.group));
  const amt = (r) => r.closing; // 残高側の金額（収益は貸方、費用は借方がプラス。期末商品棚卸高は貸方がプラス）
  const byGroup = (g) => rows.filter((r) => r.account.group === g);
  const sum = (list) => list.reduce((s, r) => s + amt(r), 0);
  const L = {};
  L[1] = sum(byGroup('sales'));
  const cos = byGroup('cost_of_sales');
  L[2] = sum(cos.filter((r) => r.account.role === 'opening_inventory'));
  L[3] = sum(cos.filter((r) => r.account.role !== 'opening_inventory' && r.account.role !== 'closing_inventory'));
  L[4] = L[2] + L[3];
  L[5] = sum(cos.filter((r) => r.account.role === 'closing_inventory'));
  L[6] = L[4] - L[5];
  L[7] = L[1] - L[6];

  // 経費：テンプレートのコードで欄に割り当て、残りは空欄の行（㉕〜㉚）。入りきらない分は雑費に含める
  const sga = byGroup('sga');
  const used = new Set();
  const expenses = EXPENSE_LINES.map(([code, no, label]) => {
    const r = sga.find((x) => x.account.template && x.account.code === code);
    if (r) used.add(r.account.id);
    return { no, label, name: r?.account.name ?? label, amount: r ? amt(r) : 0 };
  });
  const misc = sga.find((x) => x.account.template && x.account.code === MISC_CODE);
  if (misc) used.add(misc.account.id);
  const rest = sga.filter((r) => !used.has(r.account.id) && (amt(r) !== 0 || r.account.active));
  const withAmount = rest.filter((r) => amt(r) !== 0);
  const blanks = BLANK_EXPENSE_LINES.map((no, i) => {
    const r = withAmount[i];
    return { no, label: r ? r.account.name : '', name: r ? r.account.name : '', amount: r ? amt(r) : 0 };
  });
  const overflow = withAmount.slice(BLANK_EXPENSE_LINES.length).map((r) => ({ name: r.account.name, amount: amt(r) }));
  const miscAmount = (misc ? amt(misc) : 0) + overflow.reduce((s, o) => s + o.amount, 0);
  const allExpenses = [...expenses, ...blanks, { no: 31, label: '雑費', name: misc?.account.name ?? '雑費', amount: miscAmount }];
  for (const e of allExpenses) L[e.no] = e.amount;
  L[32] = allExpenses.reduce((s, e) => s + e.amount, 0);
  L[33] = L[7] - L[32];

  // 各種引当金・準備金等：繰戻額等 ㉞〜㊱・計㊲、繰入額等 ㊳専従者給与・㊴〜㊶・計㊷
  const pick3 = (list, code, firstNo) => {
    const t = list.find((r) => r.account.template && r.account.code === code);
    const others = list.filter((r) => r !== t && amt(r) !== 0);
    const out = [{ no: firstNo, name: t?.account.name ?? '貸倒引当金', amount: t ? amt(t) : 0 }];
    others.slice(0, 2).forEach((r, i) => out.push({ no: firstNo + 1 + i, name: r.account.name, amount: amt(r) }));
    // 3行に入りきらない分は最後の行に含める
    const extra = others.slice(2).reduce((s, r) => s + amt(r), 0);
    if (extra) out[out.length - 1].amount += extra;
    return out;
  };
  const reversal = pick3(byGroup('reserves_reversal'), '700', 34);
  const provision = pick3(byGroup('reserves_provision'), '710', 39);
  for (const x of [...reversal, ...provision]) L[x.no] = x.amount;
  L[35] ??= 0;
  L[36] ??= 0;
  L[37] = L[34] + L[35] + L[36];
  L[38] = sum(byGroup('family_salary'));
  L[40] ??= 0;
  L[41] ??= 0;
  L[42] = L[38] + L[39] + L[40] + L[41];
  L[43] = L[33] + L[37] - L[42];
  // 青色申告特別控除額：所得（控除前）が少なければその額まで
  L[44] = Math.max(0, Math.min(deduction, L[43]));
  L[45] = L[43] - L[44];
  return { lines: L, expenses: allExpenses, overflow, reversal, provision };
}

/**
 * 2ページ目：月別売上（収入）金額及び仕入金額
 * 雑収入（テンプレートの 501）は月別ではなく「雑収入」の行に出す
 * @returns {{ months: Array<{ month, sales, purchases }>, misc: number, salesTotal, purchasesTotal }}
 */
export function monthlySalesPurchases({ accounts, period, journals }) {
  const miscIncome = templateAccount(accounts, '501');
  const isSales = (a) => a.group === 'sales' && a.id !== miscIncome?.id;
  const isPurchase = (a) => a.group === 'cost_of_sales' && a.role !== 'opening_inventory' && a.role !== 'closing_inventory';
  const months = monthsInPeriod(period).map((m) => {
    const { from, to } = monthRange(period, m, m);
    const rows = trialBalance({ accounts, period, journals, from, to }).rows;
    const flow = (r) => (r.account.normalSide === 'credit' ? r.credit - r.debit : r.debit - r.credit);
    return {
      month: m,
      sales: rows.filter((r) => isSales(r.account)).reduce((s, r) => s + flow(r), 0),
      purchases: rows.filter((r) => isPurchase(r.account)).reduce((s, r) => s + flow(r), 0),
    };
  });
  const total = trialBalance({ accounts, period, journals }).rows;
  const misc = miscIncome ? total.find((r) => r.account.id === miscIncome.id).closing : 0;
  const salesTotal = months.reduce((s, m) => s + m.sales, 0) + misc;
  const purchasesTotal = months.reduce((s, m) => s + m.purchases, 0);
  return { months, misc, salesTotal, purchasesTotal };
}

/**
 * 3ページ目：減価償却費の計算
 * @returns {{ rows: Array, total: { amount, business, closing } }}
 */
export function depreciationTable({ assets, periods, period }) {
  const rows = assetRegister(assets, periods, period).map(({ asset, opening, row, closing }) => {
    const method = METHOD_BY_ID[asset.method];
    const rateText = row?.rate ? (row.rate / 1000).toFixed(3) : asset.method === 'lump3' ? '1/3' : '';
    const note = { lump3: '一括償却資産', sme: '措法28条の2', small: '少額減価償却資産' }[asset.method] || (asset.disposedOn && asset.disposedOn <= period.endDate ? `${asset.disposedOn.replaceAll('-', '/')} 除却` : '');
    return {
      asset,
      name: asset.name,
      category: CATEGORY_BY_ID[asset.category]?.label ?? '',
      acquired: asset.startedOn.slice(0, 7).replace('-', '/'),
      cost: asset.cost,
      base: row?.base ?? opening,
      method: usesLife(asset.method) ? method.short : '',
      life: usesLife(asset.method) ? asset.usefulLife : null,
      rate: rateText,
      months: row ? `${row.months}/12` : '',
      amount: row?.amount ?? 0,
      ratio: asset.businessRatio ?? 100,
      business: row?.business ?? 0,
      closing,
      note,
    };
  });
  return {
    rows,
    total: {
      amount: rows.reduce((s, r) => s + r.amount, 0),
      business: rows.reduce((s, r) => s + r.business, 0),
      closing: rows.reduce((s, r) => s + r.closing, 0),
    },
  };
}

/**
 * 4ページ目：貸借対照表（資産負債調）。期首（1月1日）と期末（12月31日）
 * @param {number} incomeBeforeDeduction 青色申告特別控除前の所得金額（㊸）
 * @returns {{ assets: Array<{ label, opening, closing }>, liabilities: Array, totals, balanced }}
 */
export function blueBalanceSheet({ accounts, period, journals, incomeBeforeDeduction }) {
  const rows = trialBalance({ accounts, period, journals }).rows.filter((r) => isBsGroup(r.account.group));
  const side = (lines, groups) => {
    const used = new Set();
    const out = [];
    const extras = rows.filter((r) => groups.includes(r.account.group) && !lines.some(([code]) => code && r.account.template && r.account.code === code) && (r.opening || r.closing));
    for (const [code, label] of lines) {
      if (code === null) {
        // 空欄の行：テンプレートにない科目・テンプレートでも様式にない科目（未収入金・ソフトウェア・敷金など）
        for (const r of extras) {
          used.add(r.account.id);
          out.push({ label: r.account.name, opening: r.opening, closing: r.closing, blank: true });
        }
        continue;
      }
      const r = rows.find((x) => x.account.template && x.account.code === code);
      if (r) used.add(r.account.id);
      out.push({ label, name: r?.account.name, opening: r ? r.opening : 0, closing: r ? r.closing : 0 });
    }
    return out;
  };
  const assets = side(BS_ASSET_LINES, ['current_assets', 'tangible_fixed_assets', 'intangible_fixed_assets', 'investments', 'deferred_assets', 'owner_drawings']);
  const liabilities = side(BS_LIABILITY_LINES, ['current_liabilities', 'fixed_liabilities', 'equity']);
  liabilities.push({ label: '青色申告特別控除前の所得金額', opening: null, closing: incomeBeforeDeduction });
  const total = (list, k) => list.reduce((s, x) => s + (x[k] || 0), 0);
  const totals = { assetsOpening: total(assets, 'opening'), assetsClosing: total(assets, 'closing'), liabilitiesOpening: total(liabilities, 'opening'), liabilitiesClosing: total(liabilities, 'closing') };
  return { assets, liabilities, totals, balanced: totals.assetsOpening === totals.liabilitiesOpening && totals.assetsClosing === totals.liabilitiesClosing };
}
