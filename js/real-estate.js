// 不動産所得（個人）：青色申告決算書（不動産所得用）の各欄の集計と、青色申告特別控除の配分（純粋関数）
//
// 出典（2026-10-29 確認）
// - 国税庁「令和7年分 青色申告決算書（不動産所得用）の書き方」
//   https://www.nta.go.jp/taxes/shiraberu/shinkoku/tebiki/2025/pdf/039.pdf
//   ・青色事業専従者の給与は⑪給料賃金ではなく⑳専従者給与に書く。⑫〜⑯は⑤〜⑪に当てはまらない費目
//   ・貸借対照表の「青色申告特別控除前の所得金額」は損益計算書の㉑。事業所得がなく不動産所得のある人の貸借対照表はこの決算書に書く
//   ・㉓が赤字で、必要経費に土地等を取得するために要した負債の利子があるときはその額を書く。第一表の不動産③は、
//     赤字が利子の額以下なら0、利子の額より大きければ差額（△）にする
//   ・事業的規模でない不動産の貸付けは、ほかに事業所得がある場合を除き、55万円（65万円）の控除は受けられない
// - 国税庁「令和7年分 青色申告決算書（一般用）の書き方」
//   https://www.nta.go.jp/taxes/shiraberu/shinkoku/tebiki/2025/pdf/037.pdf
//   ・事業所得のほかに不動産所得のある人の貸借対照表は、それらの所得に係るものを合算して記入する（各別でも差し支えない）
// - 国税庁 タックスアンサー No.2072 青色申告特別控除
//   https://www.nta.go.jp/taxes/shiraberu/taxanswer/shotoku/2072.htm
//   ・控除額は不動産所得の金額、事業所得の金額から順次控除する。所得金額の合計額が限度
// - 国税庁 タックスアンサー No.1373 事業としての不動産貸付けとそれ以外の不動産貸付けとの区分
//   https://www.nta.go.jp/taxes/shiraberu/taxanswer/shotoku/1373.htm
//   ・貸間・アパート等はおおむね10室以上、独立家屋はおおむね5棟以上なら事業として行われているものとする
//   ・事業として行われていない貸付けでは、青色事業専従者給与は必要経費にならない
// 科目と欄の対応は目印（hint）で決める（科目名は利用者が変えられるため名前では判定しない）
import { trialBalance } from './ledger.js';
import { blueIncomeStatement, blueDeductionFor } from './blue-return.js';
import { isYen } from './money.js';

/** 設定の不動産所得：なし・事業所得と両方・不動産所得だけ */
export const REAL_ESTATE_MODES = ['none', 'both', 'only'];
/** 不動産の貸付けの規模：事業的規模・業務的規模（事業的規模でない） */
export const RE_SCALES = ['business', 'small'];

/** 不動産所得の決算書を作るか（個人で、設定が「事業と両方」か「不動産だけ」） */
export function hasRealEstate(settings) {
  return settings?.entityType === 'individual' && (settings.realEstate === 'both' || settings.realEstate === 'only');
}

/** 収入金額の欄（目印 → 欄番号と様式の欄名）。目印の無い不動産収入の科目は③に入れる */
export const RE_INCOME_LINES = [
  ['re_rent_income', 1, '賃貸料'],
  ['re_key_money', 2, '礼金・権利金・更新料'],
  ['re_other_income', 3, '名義書換料その他'],
];
/** 必要経費の欄。目印の無い不動産経費の科目は空欄の行（⑫〜⑯）、入りきらない分は⑰その他の経費に入れる */
export const RE_EXPENSE_LINES = [
  ['re_taxes', 5, '租税公課'],
  ['re_insurance', 6, '損害保険料'],
  ['re_repairs', 7, '修繕費'],
  ['re_depreciation', 8, '減価償却費'],
  ['re_interest', 9, '借入金利子'],
  ['re_rent', 10, '地代家賃'],
  ['re_wages', 11, '給料賃金'],
];
const RE_MISC_HINT = 're_misc'; // ⑰ その他の経費
const RE_BLANK_LINES = [12, 13, 14, 15, 16];

/** 青色申告決算書の設定（期間の blueReturn）の検証 */
export function validateBlueReturnSettings(v) {
  const e = [];
  if (v.deduction !== undefined && ![0, 100000, 550000, 650000, 750000].includes(v.deduction)) e.push('青色申告特別控除額を選んでください');
  if (v.scale !== undefined && !RE_SCALES.includes(v.scale)) e.push('不動産の貸付けの規模を選んでください');
  if (v.landInterest !== undefined && !(isYen(v.landInterest) && v.landInterest >= 0)) e.push('土地等を取得するための負債の利子は0以上の整数で入力してください');
  return e;
}

/**
 * 1ページ目：損益計算書（不動産所得用）の①〜㉑。㉒・㉓は blueReturnSet で控除を配分してから入れる
 *   ④＝①＋②＋③、⑱＝⑤〜⑰の計、⑲＝④−⑱、㉑＝⑲−⑳
 * @returns {{ lines: Object<number, number>, incomes: Array<{ no, label, amount }>, expenses: Array<{ no, label, name, amount }>, overflow: Array }}
 */
export function realEstateIncomeStatement({ accounts, period, journals }) {
  const rows = trialBalance({ accounts, period, journals }).rows;
  const amt = (r) => r.closing; // 収入は貸方、経費は借方がプラス
  const inGroup = (g) => rows.filter((r) => r.account.group === g);
  const sum = (list) => list.reduce((s, r) => s + amt(r), 0);
  const L = {};

  const income = inGroup('re_income');
  const incomeHints = RE_INCOME_LINES.slice(0, 2).map(([hint]) => hint);
  L[1] = sum(income.filter((r) => r.account.hint === 're_rent_income'));
  L[2] = sum(income.filter((r) => r.account.hint === 're_key_money'));
  L[3] = sum(income.filter((r) => !incomeHints.includes(r.account.hint)));
  L[4] = L[1] + L[2] + L[3];
  const incomes = RE_INCOME_LINES.map(([, no, label]) => ({ no, label, amount: L[no] }));

  const expenseRows = inGroup('re_expenses');
  const used = new Set();
  const expenses = RE_EXPENSE_LINES.map(([hint, no, label]) => {
    const list = expenseRows.filter((r) => r.account.hint === hint);
    for (const r of list) used.add(r.account.id);
    return { no, label, name: list[0]?.account.name ?? label, amount: sum(list) };
  });
  const misc = expenseRows.filter((r) => r.account.hint === RE_MISC_HINT);
  for (const r of misc) used.add(r.account.id);
  const withAmount = expenseRows.filter((r) => !used.has(r.account.id) && amt(r) !== 0);
  const blanks = RE_BLANK_LINES.map((no, i) => {
    const r = withAmount[i];
    return { no, label: r ? r.account.name : '', name: r ? r.account.name : '', amount: r ? amt(r) : 0 };
  });
  const overflow = withAmount.slice(RE_BLANK_LINES.length).map((r) => ({ name: r.account.name, amount: amt(r) }));
  const miscAmount = sum(misc) + overflow.reduce((s, o) => s + o.amount, 0);
  const all = [...expenses, ...blanks, { no: 17, label: 'その他の経費', name: misc[0]?.account.name ?? 'その他の経費', amount: miscAmount }];
  for (const e of all) L[e.no] = e.amount;
  L[18] = all.reduce((s, e) => s + e.amount, 0);
  L[19] = L[4] - L[18];
  L[20] = sum(inGroup('re_family_salary'));
  L[21] = L[19] - L[20];
  return { lines: L, incomes, expenses: all, overflow };
}

/**
 * 青色申告特別控除額の配分：不動産所得の金額、事業所得の金額から順次控除する（どちらも所得金額が限度）
 * @returns {{ realEstate: number, business: number }}
 */
export function allocateBlueDeduction({ selected, realEstateIncome = 0, businessIncome = 0 }) {
  const realEstate = Math.max(0, Math.min(selected, realEstateIncome));
  const business = Math.max(0, Math.min(selected - realEstate, businessIncome));
  return { realEstate, business };
}

/**
 * 控除額が10万円までに限られるか：不動産所得だけで、貸付けが事業的規模でない
 * （事業所得があれば、事業的規模でない不動産所得からも55万円・65万円の控除を先に引ける）
 */
export function deductionLimited(settings, scale) {
  return hasRealEstate(settings) && settings.realEstate === 'only' && scale !== 'business';
}

/**
 * 青色申告決算書（一般用・不動産所得用）をまとめて計算する
 * @param {object} p
 * @param {object} p.settings 事業者の設定（realEstate）
 * @param {object} [p.overrides] 画面で選んでまだ保存していない { deduction, scale, landInterest }
 * @returns {{ year, selected, limited, scale, landInterest, business, realEstate, incomeBeforeDeduction, familySalaryNotAllowed }}
 *   business：blueIncomeStatement の結果（㊹は不動産所得から引いた残り）。realEstate：不動産所得用の欄（不動産所得が無ければ null）
 *   incomeBeforeDeduction：貸借対照表（合算）の青色申告特別控除前の所得金額（㊸＋㉑）
 */
export function blueReturnSet({ settings, accounts, period, journals, overrides = {} }) {
  const year = Number(period.endDate.slice(0, 4));
  const br = { ...(period.blueReturn || {}), ...overrides };
  const scale = br.scale === 'business' ? 'business' : 'small';
  const limited = deductionLimited(settings, scale);
  const selected = blueDeductionFor(year, br.deduction ?? (limited ? 100000 : 650000), { limited });
  const realEstate = hasRealEstate(settings) ? realEstateIncomeStatement({ accounts, period, journals }) : null;
  let reDeduction = 0;
  if (realEstate) {
    reDeduction = allocateBlueDeduction({ selected, realEstateIncome: realEstate.lines[21] }).realEstate;
    realEstate.lines[22] = reDeduction;
    realEstate.lines[23] = realEstate.lines[21] - reDeduction;
  }
  const business = blueIncomeStatement({ accounts, period, journals, deduction: selected - reDeduction });
  return {
    year,
    selected,
    limited,
    scale,
    landInterest: br.landInterest ?? 0,
    business,
    realEstate,
    incomeBeforeDeduction: business.lines[43] + (realEstate ? realEstate.lines[21] : 0),
    familySalaryNotAllowed: Boolean(realEstate && scale !== 'business' && realEstate.lines[20] !== 0),
  };
}

/**
 * 確定申告書 第一表の「不動産③」：㉓が赤字のときは、土地等を取得するための負債の利子に相当する部分を除く
 * @param {number} income ㉓所得金額
 * @param {number} landInterest 土地等を取得するために要した負債の利子の額
 */
export function realEstateForFirstTable(income, landInterest = 0) {
  if (income >= 0) return income;
  return -income <= landInterest ? 0 : income + landInterest;
}

/** 補助科目（相手先）ごとの金額。補助科目の無い科目は科目名の行にする */
function subRows(rows, label = (r) => r.account.name) {
  const out = [];
  for (const r of rows) {
    if (!r.subs.length) {
      if (r.closing) out.push({ name: label(r), amount: r.closing });
      continue;
    }
    for (const s of r.subs) if (s.closing) out.push({ name: s.subAccount ? s.subAccount.name : `${r.account.name}（補助科目なし）`, amount: s.closing });
  }
  return out;
}

/**
 * 2・3ページ目の内訳のうち帳簿から作れるもの（補助科目を相手先として使う）
 *   tenants：不動産所得の収入の内訳（賃借人ごとの賃貸料・礼金等・名義書換料その他。補助科目の名前でまとめる）
 *   wages：給料賃金の内訳、family：専従者給与の内訳、rent：地代家賃の内訳、interest：借入金利子の内訳
 */
export function realEstateDetails({ accounts, subAccounts = [], period, journals }) {
  const rows = trialBalance({ accounts, subAccounts, period, journals }).rows;
  const tenants = new Map();
  for (const r of rows.filter((x) => x.account.group === 're_income')) {
    const col = r.account.hint === 're_rent_income' ? 'rent' : r.account.hint === 're_key_money' ? 'key' : 'other';
    const parts = r.subs.length ? r.subs.map((s) => [s.subAccount ? s.subAccount.name : '（補助科目なし）', s.closing]) : [['（補助科目なし）', r.closing]];
    for (const [name, amount] of parts) {
      if (!amount) continue;
      if (!tenants.has(name)) tenants.set(name, { name, rent: 0, key: 0, other: 0, total: 0 });
      const t = tenants.get(name);
      t[col] += amount;
      t.total += amount;
    }
  }
  const byHint = (hint) => rows.filter((r) => r.account.group === 're_expenses' && r.account.hint === hint);
  return {
    tenants: [...tenants.values()],
    wages: subRows(byHint('re_wages')),
    family: subRows(rows.filter((r) => r.account.group === 're_family_salary')),
    rent: subRows(byHint('re_rent')),
    interest: subRows(byHint('re_interest')),
  };
}

/** 不動産所得の資産か（償却費の科目が不動産経費） */
export function isRealEstateAsset(asset, accountById) {
  return accountById.get(asset.expenseAccountId)?.group === 're_expenses';
}
