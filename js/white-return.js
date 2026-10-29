// 収支内訳書（白色申告の個人）：一般用・不動産所得用の各欄と事業専従者控除（純粋関数）
//
// 出典（2026-10-29 確認）
// - 国税庁「令和7年分 収支内訳書（一般用）の書き方」
//   https://www.nta.go.jp/taxes/shiraberu/shinkoku/tebiki/2025/pdf/034.pdf
//   ・経費は⑪給料賃金・⑫外注工賃・⑬減価償却費・⑭貸倒金・⑮地代家賃・⑯利子割引料と、その他の経費（㋑租税公課・㋺荷造運賃・
//     ㋩水道光熱費・㋥旅費交通費・㋭通信費・㋬広告宣伝費・㋣接待交際費・㋠損害保険料・㋷修繕費・㋦消耗品費・㋸福利厚生費・㋹雑費）
//   ・家事消費：商品などを家事のために消費・贈与したときの通常の販売価額。その他の収入：空箱の売却代金・リベートなど
//   ・事業専従者控除：1人ごとに 86万円（配偶者以外は50万円）と「⑲÷（事業専従者の数＋1）」の少ない方
// - 国税庁「令和7年分 収支内訳書（不動産所得用）の書き方」
//   https://www.nta.go.jp/taxes/shiraberu/shinkoku/tebiki/2025/pdf/019.pdf
//   ・必要経費は⑥給料賃金・⑦減価償却費・⑧貸倒金・⑨地代家賃・⑩借入金利子と、その他の経費（㋑租税公課・㋺損害保険料・㋩修繕費・㋭雑費）
//   ・⑮が赤字で必要経費に土地等を取得するための負債の利子があるときの第一表「不動産③」の書き方（青色と同じ）
//   ・不動産の貸付けが事業として行われていないときは専従者控除を適用できない
// - 国税庁 タックスアンサー No.2075 青色事業専従者給与と事業専従者控除
//   https://www.nta.go.jp/taxes/shiraberu/taxanswer/shotoku/2075.htm
//   ・控除額は「配偶者86万円、配偶者でなければ1人50万円」と「この控除をする前の事業所得等の金額を事業専従者の数に1を足した数で割った金額」の低い方
//   ・白色申告者の事業専従者である人は、同一生計配偶者や扶養親族になれない
// 科目と欄の対応は、一般用はテンプレートの科目コード、不動産所得用は目印（hint）で決める（科目名は利用者が変えられるため名前では判定しない）
import { trialBalance, bySubAccount } from './ledger.js';
import { isBsGroup } from './accounts.js';
import { hasRealEstate, realEstateIncomeStatement, RE_SCALES } from './real-estate.js';
import { isYen } from './money.js';

/** 申告の種類（個人）：青色申告・白色申告 */
export const FILING_TYPES = ['blue', 'white'];

/** 白色申告か（個人で、設定の申告の種類が白色） */
export function isWhite(settings) {
  return settings?.entityType === 'individual' && settings.filing === 'white';
}

/** 一般用の経費（テンプレートのコード → 欄番号と様式の欄名） */
export const WHITE_MAIN_EXPENSES = [
  ['612', 11, '給料賃金'],
  ['613', 12, '外注工賃'],
  ['610', 13, '減価償却費'],
  ['616', 14, '貸倒金'],
  ['615', 15, '地代家賃'],
  ['614', 16, '利子割引料'],
];
/** 一般用のその他の経費（テンプレートのコード → 記号と様式の欄名） */
export const WHITE_OTHER_EXPENSES = [
  ['600', '㋑', '租税公課'],
  ['601', '㋺', '荷造運賃'],
  ['602', '㋩', '水道光熱費'],
  ['603', '㋥', '旅費交通費'],
  ['604', '㋭', '通信費'],
  ['605', '㋬', '広告宣伝費'],
  ['606', '㋣', '接待交際費'],
  ['607', '㋠', '損害保険料'],
  ['608', '㋷', '修繕費'],
  ['609', '㋦', '消耗品費'],
  ['611', '㋸', '福利厚生費'],
];
const WHITE_BLANKS = ['㋾', '㋻', '㋕', '㋵', '㋟']; // 空欄の行（テンプレートにない科目）
const MISC_CODE = '699'; // ㋹ 雑費
const MISC_INCOME_CODE = '501'; // 雑収入 → ③その他の収入

/** 事業専従者控除の上限（所得税法第57条第3項。国税庁 No.2075） */
export const WORKER_CAPS = { spouse: 860000, other: 500000 };
/** 専従者が従事する事業：事業所得（一般用）・不動産所得（不動産所得用） */
export const WORKER_WORKS = ['business', 'realEstate'];
const WORKER_MAX = 10;
const TEXT_MAX = 40;

/** 収支内訳書の設定（期間の whiteReturn）の検証 */
export function validateWhiteReturnSettings(v) {
  const e = [];
  if (v.scale !== undefined && !RE_SCALES.includes(v.scale)) e.push('不動産の貸付けの規模を選んでください');
  if (v.landInterest !== undefined && !(isYen(v.landInterest) && v.landInterest >= 0)) e.push('土地等を取得するための負債の利子は0以上の整数で入力してください');
  if (v.workers !== undefined) {
    if (!Array.isArray(v.workers) || v.workers.length > WORKER_MAX) e.push(`事業専従者は${WORKER_MAX}人までです`);
    else {
      for (const w of v.workers) {
        if (!w || typeof w.name !== 'string' || !w.name.trim() || w.name.length > TEXT_MAX) e.push(`事業専従者の氏名を${TEXT_MAX}文字以内で入力してください`);
        if (typeof w?.spouse !== 'boolean') e.push('配偶者かどうかを選んでください');
        if (!WORKER_WORKS.includes(w?.work)) e.push('従事する事業を選んでください');
      }
      if (v.workers.filter((w) => w?.spouse).length > 1) e.push('配偶者は1人だけです');
    }
  }
  return [...new Set(e)];
}

/**
 * 収支内訳書（一般用）1ページの①〜⑲（⑳・㉑は whiteReturnSet で専従者控除を計算してから入れる）
 *   ④＝①＋②＋③、⑦＝⑤＋⑥、⑨＝⑦−⑧、⑩＝④−⑨、⑰＝その他の経費の計、⑱＝⑪〜⑯＋⑰、⑲＝⑩−⑱
 *   ②家事消費は帳簿で区別できないので0（売上の科目で記帳していれば①に入る）
 * 専従者給与・貸倒引当金の繰入額等は収支内訳書の経費に入れない（familySalary・reserves で知らせる）
 * @returns {{ lines, main: Array<{ no, label, name, amount }>, others: Array<{ mark, label, name, amount }>, overflow, familySalary, reserves }}
 */
export function whiteIncomeStatement({ accounts, period, journals }) {
  const rows = trialBalance({ accounts, period, journals }).rows.filter((r) => !isBsGroup(r.account.group));
  const amt = (r) => r.closing; // 収益は貸方、費用は借方がプラス（期末商品棚卸高は貸方がプラス）
  const byGroup = (g) => rows.filter((r) => r.account.group === g);
  const sum = (list) => list.reduce((s, r) => s + amt(r), 0);
  const isCode = (r, code) => r.account.template && r.account.code === code;
  const L = {};
  const sales = byGroup('sales');
  L[1] = sum(sales.filter((r) => !isCode(r, MISC_INCOME_CODE)));
  L[2] = 0;
  L[3] = sum(sales.filter((r) => isCode(r, MISC_INCOME_CODE)));
  L[4] = L[1] + L[2] + L[3];
  const cos = byGroup('cost_of_sales');
  L[5] = sum(cos.filter((r) => r.account.role === 'opening_inventory'));
  L[6] = sum(cos.filter((r) => r.account.role !== 'opening_inventory' && r.account.role !== 'closing_inventory'));
  L[7] = L[5] + L[6];
  L[8] = sum(cos.filter((r) => r.account.role === 'closing_inventory'));
  L[9] = L[7] - L[8];
  L[10] = L[4] - L[9];

  const sga = byGroup('sga');
  const used = new Set();
  const take = (code) => {
    const r = sga.find((x) => isCode(x, code));
    if (r) used.add(r.account.id);
    return r;
  };
  const main = WHITE_MAIN_EXPENSES.map(([code, no, label]) => {
    const r = take(code);
    return { no, label, name: r?.account.name ?? label, amount: r ? amt(r) : 0 };
  });
  const listed = WHITE_OTHER_EXPENSES.map(([code, mark, label]) => {
    const r = take(code);
    return { mark, label, name: r?.account.name ?? label, amount: r ? amt(r) : 0 };
  });
  const misc = take(MISC_CODE);
  const withAmount = sga.filter((r) => !used.has(r.account.id) && amt(r) !== 0);
  const blanks = WHITE_BLANKS.map((mark, i) => {
    const r = withAmount[i];
    return { mark, label: r ? r.account.name : '', name: r ? r.account.name : '', amount: r ? amt(r) : 0 };
  });
  const overflow = withAmount.slice(WHITE_BLANKS.length).map((r) => ({ name: r.account.name, amount: amt(r) }));
  const others = [...listed, ...blanks, { mark: '㋹', label: '雑費', name: misc?.account.name ?? '雑費', amount: (misc ? amt(misc) : 0) + overflow.reduce((s, o) => s + o.amount, 0) }];
  for (const m of main) L[m.no] = m.amount;
  L[17] = others.reduce((s, o) => s + o.amount, 0);
  L[18] = main.reduce((s, m) => s + m.amount, 0) + L[17];
  L[19] = L[10] - L[18];
  return {
    lines: L,
    main,
    others,
    overflow,
    familySalary: sum(byGroup('family_salary')),
    reserves: { reversal: sum(byGroup('reserves_reversal')), provision: sum(byGroup('reserves_provision')) },
  };
}

/**
 * 収支内訳書（不動産所得用）1ページの収入金額と⑥〜⑬（⑭・⑮は whiteReturnSet で入れる）
 * 青色申告決算書（不動産所得用）と同じ目印で集計し、白色の様式の欄に並べ替える
 *   ⑥給料賃金・⑦減価償却費・⑧貸倒金（目印が無いので0。貸倒れは空欄の行に入る）・⑨地代家賃・⑩借入金利子
 *   その他の経費：㋑租税公課・㋺損害保険料・㋩修繕費・㋥空欄（目印の無い科目の1つ目）・㋭雑費（その他の経費と、入りきらない科目）
 *   ⑪＝その他の経費の計、⑫＝⑥〜⑩＋⑪、⑬＝収入金額の計−⑫
 * @returns {{ lines, incomes: Array<{ label, amount }>, income, main: Array<{ no, label, amount }>, others: Array<{ mark, label, name, amount }>, overflow, familySalary }}
 */
export function whiteRealEstateStatement({ accounts, period, journals }) {
  const blue = realEstateIncomeStatement({ accounts, period, journals });
  const B = blue.lines;
  const blanks = blue.expenses.filter((e) => e.no >= 12 && e.no <= 16 && e.amount !== 0);
  const extra = [...blanks.slice(1).map((e) => ({ name: e.name, amount: e.amount })), ...blue.overflow];
  const L = {};
  const incomes = [
    { label: '賃貸料', amount: B[1] },
    { label: '礼金・権利金・更新料', amount: B[2] },
    { label: '名義書換料・その他', amount: B[3] },
  ];
  const income = B[4];
  const main = [
    { no: 6, label: '給料賃金', amount: B[11] },
    { no: 7, label: '減価償却費', amount: B[8] },
    { no: 8, label: '貸倒金', amount: 0 },
    { no: 9, label: '地代家賃', amount: B[10] },
    { no: 10, label: '借入金利子', amount: B[9] },
  ];
  const miscRow = blue.expenses.find((e) => e.no === 17);
  const others = [
    { mark: '㋑', label: '租税公課', name: '', amount: B[5] },
    { mark: '㋺', label: '損害保険料', name: '', amount: B[6] },
    { mark: '㋩', label: '修繕費', name: '', amount: B[7] },
    { mark: '㋥', label: blanks[0]?.name ?? '', name: blanks[0]?.name ?? '', amount: blanks[0]?.amount ?? 0 },
    // B[17] は「その他の経費」の目印の科目と、青色の空欄の行（⑫〜⑯）に入りきらなかった科目の合計
    { mark: '㋭', label: '雑費', name: miscRow?.name ?? '', amount: B[17] + blanks.slice(1).reduce((s, e) => s + e.amount, 0) },
  ];
  for (const m of main) L[m.no] = m.amount;
  L[11] = others.reduce((s, o) => s + o.amount, 0);
  L[12] = main.reduce((s, m) => s + m.amount, 0) + L[11];
  L[13] = income - L[12];
  return { lines: L, incomes, income, main, others, overflow: extra, familySalary: B[20] };
}

/**
 * 事業専従者控除（白色申告）：1人ごとに min(86万円（配偶者）・50万円（配偶者以外）, 事業所得等の金額 ÷ (専従者の数＋1))
 * 割り算の1円未満は切り捨てる。事業所得等の金額が0以下なら控除は0
 * @param {Array<{ name, spouse, work }>} workers
 * @param {number} base この控除をする前の事業所得等の金額
 */
export function familyWorkerDeductions(workers, base) {
  const per = base > 0 ? Math.floor(base / (workers.length + 1)) : 0;
  return workers.map((w) => ({ ...w, cap: w.spouse ? WORKER_CAPS.spouse : WORKER_CAPS.other, amount: Math.min(w.spouse ? WORKER_CAPS.spouse : WORKER_CAPS.other, per) }));
}

/**
 * 収支内訳書（一般用・不動産所得用）をまとめて計算する
 * 事業専従者控除の「事業所得等の金額」は、事業所得（一般用の⑲）と、事業として行う不動産の貸付けの不動産所得（不動産所得用の⑬）の合計にする
 * （所得税法第57条第3項「事業に係る不動産所得の金額、事業所得の金額又は山林所得の金額の合計額」）。各人の控除額は従事する事業の収支内訳書に書く
 * @param {object} p
 * @param {object} [p.overrides] 画面で選んでまだ保存していない { workers, scale, landInterest }
 * @returns {{ year, scale, landInterest, general, realEstate, workers, base, familyTotal, workersNotAllowed }}
 *   general：一般用（不動産所得だけなら null）。lines[20]＝専従者控除、lines[21]＝所得金額
 *   realEstate：不動産所得用（不動産所得が無ければ null）。lines[14]＝専従者控除、lines[15]＝所得金額
 *   workers：控除額を付けた専従者（work は実際に書く収支内訳書）。workersNotAllowed：控除できない専従者がいる（事業的規模でない貸付けだけ）
 */
export function whiteReturnSet({ settings, accounts, period, journals, overrides = {} }) {
  const year = Number(period.endDate.slice(0, 4));
  const wr = { ...(period.whiteReturn || {}), ...overrides };
  const scale = wr.scale === 'business' ? 'business' : 'small';
  const general = settings.realEstate !== 'only' ? whiteIncomeStatement({ accounts, period, journals }) : null;
  const realEstate = hasRealEstate(settings) ? whiteRealEstateStatement({ accounts, period, journals }) : null;
  const reBusiness = Boolean(realEstate) && scale === 'business';
  // 従事する事業：一般用が無ければ不動産所得、不動産の貸付けが事業でなければ事業所得
  const placed = (wr.workers || []).map((w) => ({ ...w, work: !general ? 'realEstate' : !reBusiness ? 'business' : w.work }));
  const eligible = placed.filter((w) => w.work === 'business' || reBusiness);
  const base = (general ? general.lines[19] : 0) + (reBusiness ? realEstate.lines[13] : 0);
  const workers = familyWorkerDeductions(eligible, base);
  const total = (work) => workers.filter((w) => w.work === work).reduce((s, w) => s + w.amount, 0);
  if (general) {
    general.lines[20] = total('business');
    general.lines[21] = general.lines[19] - general.lines[20];
  }
  if (realEstate) {
    realEstate.lines[14] = total('realEstate');
    realEstate.lines[15] = realEstate.lines[13] - realEstate.lines[14];
  }
  return {
    year,
    scale,
    landInterest: wr.landInterest ?? 0,
    general,
    realEstate,
    workers,
    base,
    familyTotal: total('business') + total('realEstate'),
    workersNotAllowed: placed.length > eligible.length,
  };
}

/**
 * 2ページ目の内訳のうち帳簿から作れるもの（補助科目を相手先として使う）
 *   sales：売上（収入）金額の明細（雑収入を除く）、purchases：仕入金額の明細、rent：地代家賃、interest：利子割引料、wages：給料賃金
 */
export function whiteDetails({ accounts, subAccounts = [], period, journals }) {
  const rows = trialBalance({ accounts, subAccounts, period, journals }).rows;
  const code = (c) => rows.filter((r) => r.account.group === 'sga' && r.account.template && r.account.code === c);
  return {
    sales: bySubAccount(rows.filter((r) => r.account.group === 'sales' && !(r.account.template && r.account.code === MISC_INCOME_CODE))),
    purchases: bySubAccount(rows.filter((r) => r.account.group === 'cost_of_sales' && r.account.role !== 'opening_inventory' && r.account.role !== 'closing_inventory')),
    rent: bySubAccount(code('615')),
    interest: bySubAccount(code('614')),
    wages: bySubAccount(code('612')),
  };
}
