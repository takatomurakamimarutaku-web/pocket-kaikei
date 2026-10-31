// 青色申告決算書（一般用）の各欄の集計（純粋関数）。個人事業主だけ
// 欄の並びは国税庁「青色申告決算書（一般用）の書き方」（令和7年分）と様式（令和7年分）で確認した（2026-10-29）
//   書き方 https://www.nta.go.jp/taxes/shiraberu/shinkoku/tebiki/2025/pdf/037.pdf
//     経費（⑧〜㉛）、⑧租税公課、⑱減価償却費、⑳給料賃金、繰戻額等（㉞〜㊱）、専従者給与（㊳）、繰入額等（㊴〜㊶）、
//     貸借対照表の青色申告特別控除前の所得金額＝損益計算書の㊸
//   様式 https://www.nta.go.jp/taxes/shiraberu/shinkoku/yoshiki/01/shinkokusho/pdf/r07/10.pdf
//     経費18科目の並び（租税公課〜貸倒金・雑費）、貸借対照表の科目の並び（現金〜事業主貸、支払手形〜元入金）
// 科目と欄の対応は、テンプレートの科目コードで決める（科目名は利用者が変えられるため名前では判定しない）。
// テンプレートにない科目は、経費は空欄の行（㉕〜㉚）、資産・負債は空欄の行に入れる
import { trialBalance, bySubAccount } from './ledger.js';
import { monthsInPeriod, monthRange } from './period.js';
import { isBsGroup } from './accounts.js';
import { assetRegister, CATEGORY_BY_ID, usesLife, methodLabel } from './depreciation.js';

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

/**
 * 青色申告特別控除額の選択肢（年分で変わる）
 *   令和8年分まで：65万円（複式簿記・期限内申告に加え e-Tax か優良な電子帳簿）／55万円（複式簿記・書面）／10万円
 *     国税庁 タックスアンサー No.2072 https://www.nta.go.jp/taxes/shiraberu/taxanswer/shotoku/2072.htm
 *   令和9年分以後（令和8年度税制改正）：55万円の控除は e-Tax が要件に加わって65万円に、65万円の控除は仕訳帳・総勘定元帳を
 *     優良な電子帳簿などで保存する場合に75万円になる。書面で提出すると10万円。簡易簿記で前々年分の収入金額が1,000万円を超える人は10万円の対象外
 *     国税庁「令和9年分から青色申告特別控除はどう変わる？」https://www.nta.go.jp/taxes/shiraberu/shinkoku/kojin_jigyo/0026004-012.pdf
 * 不動産所得だけで貸付けが事業的規模でない人は10万円まで（国税庁「青色申告決算書（不動産所得用）の書き方」）
 * @param {number} year 年分（個人の会計期間の終了日の年）
 * @param {{ limited?: boolean }} [opts] limited：10万円までに限られる
 */
export function blueDeductionOptions(year, { limited = false } = {}) {
  if (limited) {
    return [
      { value: 100000, label: '10万円（事業的規模でない不動産の貸付けだけ）' },
      { value: 0, label: '適用しない' },
    ];
  }
  if (year >= 2027) {
    return [
      { value: 750000, label: '75万円（複式簿記・e-Tax＋優良な電子帳簿）' },
      { value: 650000, label: '65万円（複式簿記・e-Tax で提出）' },
      { value: 100000, label: '10万円（書面で提出など）' },
      { value: 0, label: '適用しない' },
    ];
  }
  return [
    { value: 650000, label: '65万円（複式簿記・e-Tax または優良な電子帳簿）' },
    { value: 550000, label: '55万円（複式簿記・書面で提出）' },
    { value: 100000, label: '10万円' },
    { value: 0, label: '適用しない' },
  ];
}

/** 保存した控除額がその年分の選択肢に無いとき（令和9年分の55万円など）は65万円（10万円までのときは10万円）にする */
export function blueDeductionFor(year, saved, opts = {}) {
  const options = blueDeductionOptions(year, opts);
  if (options.some((o) => o.value === saved)) return saved;
  return options.some((o) => o.value === 650000) ? 650000 : options[0].value;
}

/** 選択肢に無い控除額を選んでいたか（画面で知らせる） */
export function blueDeductionReplaced(year, saved, opts = {}) {
  return saved != null && !blueDeductionOptions(year, opts).some((o) => o.value === saved);
}

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
 * 3ページ目：減価償却費の計算（㋭普通償却費・㋬割増（特別）償却費・㋣償却費合計）
 * filter：載せる資産（一般用は不動産所得の資産を除き、不動産所得用はその資産だけにする）
 * @returns {{ rows: Array, total: { ordinary, special, amount, business, closing } }}
 */
export function depreciationTable({ assets, periods, period, filter = () => true }) {
  // 償却しない資産（土地など）は減価償却費の計算に載せない
  const rows = assetRegister(assets, periods, period).filter(({ asset }) => asset.method !== 'none' && filter(asset)).map(({ asset, cost, opening, row, closing }) => {
    const rateText = row?.rate ? (row.rate / 1000).toFixed(3) : asset.method === 'lump3' ? '1/3' : '';
    // 摘要：一括償却・少額の区分、95%到達後の「均等償却」、特別償却の制度の名前、除却した日
    const note = [
      { lump3: '一括償却資産', sme: '措法28条の2', small: '少額減価償却資産' }[asset.method],
      row?.equal ? '均等償却' : '',
      row?.special ? asset.specialName : '',
      asset.disposedOn && asset.disposedOn <= period.endDate && usesLife(asset.method) ? `${asset.disposedOn.replaceAll('-', '/')} 除却` : '',
    ]
      .filter(Boolean)
      .join('・');
    return {
      asset,
      name: asset.name,
      category: CATEGORY_BY_ID[asset.category]?.label ?? '',
      acquired: asset.startedOn.slice(0, 7).replace('-', '/'),
      cost,
      base: row?.base ?? opening,
      method: usesLife(asset.method) ? methodLabel(asset) : '',
      life: usesLife(asset.method) ? asset.usefulLife : null,
      rate: rateText,
      months: row ? `${row.months}/12` : '',
      ordinary: row ? (row.ordinary ?? row.amount) : 0,
      special: row?.special ?? 0,
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
      ordinary: rows.reduce((s, r) => s + r.ordinary, 0),
      special: rows.reduce((s, r) => s + r.special, 0),
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

/**
 * 2・3ページ目の内訳と明細のうち帳簿から作れるもの（補助科目を相手先・氏名として使う）
 * 様式（令和5年分以降用）https://www.nta.go.jp/taxes/shiraberu/shinkoku/yoshiki/01/shinkokusho/pdf/r07/10.pdf （2026-10-31 に様式の画像で確認）
 *   2ページ：給料賃金の内訳（4行＋その他）・専従者給与の内訳（4行）・地代家賃の内訳（2行）・貸倒引当金繰入額の計算（①〜⑤）・青色申告特別控除額の計算（⑥〜⑨）
 *   3ページ：売上（収入）金額の明細（4行＋上記以外）・仕入金額の明細（4行＋上記以外）・利子割引料の内訳（金融機関を除く）・税理士等の報酬・料金の内訳
 * 科目はテンプレートのコード（給料賃金 612・利子割引料 614・地代家賃 615・雑収入 501）と区分・目印で決める
 * @param {{ accounts, subAccounts?, period, journals }} p
 */
export function blueDetails({ accounts, subAccounts = [], period, journals }) {
  const rows = trialBalance({ accounts, subAccounts, period, journals }).rows;
  const byCode = (code) => rows.filter((r) => r.account.template && r.account.code === code);
  // 補助科目のある分だけを相手先として並べ、補助科目の無い分は「上記以外」に入れる
  const partners = (list, max = 4) => {
    const named = [];
    let others = 0;
    for (const r of list) {
      if (!r.subs.length) {
        others += r.closing;
        continue;
      }
      for (const x of r.subs) if (x.subAccount && x.closing) named.push({ name: x.subAccount.name, amount: x.closing });
      else if (x.closing) others += x.closing;
    }
    named.sort((a, b) => b.amount - a.amount);
    const top = named.slice(0, max);
    others += named.slice(max).reduce((t, x) => t + x.amount, 0);
    return { rows: top, others, total: top.reduce((t, x) => t + x.amount, 0) + others };
  };
  const miscIncome = templateAccount(accounts, '501');
  const sales = rows.filter((r) => r.account.group === 'sales' && r.account.id !== miscIncome?.id);
  const purchases = rows.filter((r) => r.account.group === 'cost_of_sales' && r.account.hint === 'purchases');
  return {
    sales: partners(sales),
    purchases: partners(purchases),
    wages: bySubAccount(byCode('612')),
    family: bySubAccount(rows.filter((r) => r.account.group === 'family_salary')),
    rent: bySubAccount(byCode('615')),
    interest: bySubAccount(byCode('614')),
  };
}

/**
 * 2ページ目「青色申告特別控除額の計算」⑥〜⑨（書き方：⑨ は1ページの㊹へ転記）
 *   65万円又は55万円（令和9年分以後は75万円・65万円も）の控除：⑧＝控除額と⑥の少ない方、⑨＝（控除額−⑧）と⑦の少ない方
 *   上記以外（10万円）：⑧＝10万円と⑥の少ない方、⑨＝（10万円−⑧）と⑦の少ない方
 * ⑥・⑦ は赤字のときは0
 * @param {{ deduction: number, businessIncome: number, realEstateIncome?: number }} p
 */
export function blueDeductionCalc({ deduction, businessIncome, realEstateIncome = 0 }) {
  const six = Math.max(0, realEstateIncome);
  const seven = Math.max(0, businessIncome);
  const eight = Math.min(deduction, six);
  const nine = Math.min(deduction - eight, seven);
  return { large: deduction > 100000, six, seven, eight, nine };
}
