// 法人税申告書の主要な別表（純粋関数）：別表一（法人税・地方法人税・防衛特別法人税）・別表四（所得の金額の計算）・
// 別表五(一)（利益積立金額・資本金等の額）・別表五(二)（租税公課の納付状況）・別表七(一)（欠損金の繰越控除）・
// 別表十五（交際費等）と、法人住民税（法人税割・均等割）・事業税の見込み
//
// 出典（2026-10-29 確認）
// - 法人税の税率（No.5759、令和8年4月1日現在法令等）：普通法人 23.2%。中小法人（期末資本金1億円以下など）の年800万円以下の部分は
//   本則19%、特例15%（平成24年4月1日から令和9年3月31日までの間に開始する事業年度。措法42の3の2）。
//   適用除外事業者（前3年以内に終了した各事業年度の所得の年平均額が15億円超）は19%。
//   令和7年4月1日以後に開始する事業年度で所得金額が年10億円を超える事業年度は17%
//   https://www.nta.go.jp/taxes/shiraberu/taxanswer/hojin/5759.htm
//   https://www.nta.go.jp/publication/pamph/hojin/aramashi2025/pdf/01-02.pdf
//   https://www.nta.go.jp/publication/pamph/hojin/kaisei_gaiyo2025/pdf/F.pdf
// - 地方法人税：令和元年10月1日以後に開始する課税事業年度は 10.3%
//   https://www.nta.go.jp/publication/pamph/hojin/chihou_hojin/01.htm
// - 防衛特別法人税：令和8年4月1日以後に開始する事業年度。基準法人税額（所得税額控除などを適用しないで計算した法人税額）から
//   基礎控除額 年500万円（1年未満は月割）を引いた課税標準法人税額×4%。税額が0でも申告が必要。中間申告は令和9年4月1日以後開始の事業年度から
//   https://www.nta.go.jp/publication/pamph/hojin/kaisei_gaiyo2025/pdf/E.pdf
//   https://www.e-tax.nta.go.jp/topics/2026/topics_20260417.htm
// - 別表一の記載要領（令和8年4月1日以後終了事業年度等分）：地方法人税・防衛特別法人税の「所得の金額に対する法人税額」は
//   法人税額−法人税額の特別控除額（＋使途秘匿金の税額など）
//   https://www.nta.go.jp/taxes/tetsuzuki/shinsei/annai/hojin/shinkoku/itiran2026/pdf/01-01-ki.pdf
// - 別表四（簡易様式）の行：損金経理をした法人税及び地方法人税・道府県民税及び市町村民税・納税充当金、交際費等の損金不算入額、
//   納税充当金から支出した事業税等の金額、法人税額から控除される所得税額、欠損金の当期控除額
//   https://www.nta.go.jp/taxes/tetsuzuki/shinsei/annai/hojin/shinkoku/itiran2025/pdf/04-k.pdf
// - 交際費等（No.5265）：中小法人は 接待飲食費の50% と 定額控除限度額 年800万円（×月数/12）の多いほう
//   https://www.nta.go.jp/taxes/shiraberu/taxanswer/hojin/5265.htm
// - 課税標準は1,000円未満切捨て、確定金額は100円未満切捨て（国税通則法 第118条・第119条）
// - 法人住民税（地方税）：法人税割の標準税率 道府県民税1.0%・市町村民税6.0%、均等割は資本金等の額と従業者数による年額×月数/12
//   （出典は docs/spec-phase2-corporate-tax.md）。税率・年額は自治体ごとに違うので入力で変えられる
// 率は 1/1000 % の整数で持つ（23.2% → 23200）。浮動小数点を使わない
import { familyCompany, validateShareholders, cleanShareholders } from './family-company.js';
import { withholdingCredit, validateWithholdingRows, cleanWithholdingRows } from './withholding-credit.js';
import { isYen } from './money.js';
import { isValidDate, periodMonths, addDays, addMonths } from './period.js';
import { taxDueDate } from './holidays.js';
import { buildStatements } from './statements.js';
import { trialBalance } from './ledger.js';
import { corporateEnterpriseTax, DEFAULT_ENTERPRISE_TAX } from './enterprise-tax.js';

/** 対応する事業年度（地方法人税 10.3% の開始日以後に開始する事業年度） */
export const SUPPORTED_FROM = '2019-10-01';
/** 中小法人の15%の特例の対象（この日までに開始する事業年度） */
export const SME_SPECIAL_UNTIL = '2027-03-31';
/** 所得が年10億円を超える事業年度の17%（この日以後に開始する事業年度） */
export const HIGH_INCOME_FROM = '2025-04-01';
/** 防衛特別法人税（この日以後に開始する事業年度） */
export const DEFENSE_FROM = '2026-04-01';
/** 防衛特別法人税の中間申告（この日以後に開始する事業年度） */
export const DEFENSE_INTERIM_FROM = '2027-04-01';

export const RATES = { standard: 23200, smeBase: 19000, smeSpecial: 15000, smeHigh: 17000, local: 10300, defense: 4000 };
export const SME_ANNUAL = 8000000;
export const HIGH_INCOME_ANNUAL = 1000000000;
export const DEFENSE_DEDUCTION = 5000000;
export const ENTERTAINMENT_ANNUAL = 8000000;

/** 住民税の標準税率（1/1000 %）と均等割の年額（資本金等の額1,000万円以下・従業者50人以下の標準税率） */
export const RESIDENT_DEFAULTS = { prefRate: 1000, cityRate: 6000, prefPerCapita: 20000, cityPerCapita: 50000 };
/**
 * 均等割の標準税率（年額）：資本金等の額の区分ごと。市町村民税は従業者数が50人を超えるかで変わる
 * 総務省「法人住民税」の均等割の表（出典の URL は docs/spec-phase3-tax-forms.md）
 * （地方税法52条・312条。自治体が超過税率を定めていることがあるので、入力で直せる）
 */
export const PER_CAPITA_TABLE = [
  { upTo: 10000000, pref: 20000, cityOver50: 120000, city: 50000 },
  { upTo: 100000000, pref: 50000, cityOver50: 150000, city: 130000 },
  { upTo: 1000000000, pref: 130000, cityOver50: 400000, city: 160000 },
  { upTo: 5000000000, pref: 540000, cityOver50: 1750000, city: 410000 },
  { upTo: Infinity, pref: 800000, cityOver50: 3000000, city: 410000 },
];

/**
 * 均等割の標準税率の年額
 * @param {number} capital 資本金等の額（資本金＋資本準備金と比べて大きいほう）
 * @param {number} employees 従業者数（その市町村の事務所等の従業者）
 * @param {boolean} tokyo 東京都の特別区：都が道府県分と市町村分をあわせて課税する
 */
export function standardPerCapita(capital, employees, tokyo = false) {
  const row = PER_CAPITA_TABLE.find((r) => capital <= r.upTo);
  const city = employees > 50 ? row.cityOver50 : row.city;
  return tokyo ? { pref: row.pref + city, city: 0 } : { pref: row.pref, city };
}

/** 東京都の特別区（23区）：都が道府県分と市町村分をあわせて課税する */
export const TOKYO_DEFAULTS = { prefRate: 7000, cityRate: 0, prefPerCapita: 70000, cityPerCapita: 0 };

/** 税の種類（前期分の確定額・当期の中間納付額の入力） */
export const TAX_KINDS = [
  { key: 'corp', label: '法人税' },
  { key: 'local', label: '地方法人税' },
  { key: 'defense', label: '防衛特別法人税' },
  { key: 'pref', label: '道府県民税' },
  { key: 'city', label: '市町村民税' },
  { key: 'enterprise', label: '事業税・特別法人事業税' },
];
const zeroTaxes = () => Object.fromEntries(TAX_KINDS.map((k) => [k.key, 0]));

/** 別表四の「その他」の加算・減算でよく使う行（side：add 加算・sub 減算、kind：retained 留保・outflow 社外流出） */
export const ADJUSTMENT_PRESETS = [
  { label: '役員給与の損金不算入額', side: 'add', kind: 'outflow' },
  { label: '減価償却の償却超過額', side: 'add', kind: 'retained' },
  { label: '損金経理をした附帯税（利子税を除く）、加算金、延滞金及び過怠税', side: 'add', kind: 'outflow' },
  { label: '損金経理をした罰金等', side: 'add', kind: 'outflow' },
  { label: '寄附金の損金不算入額', side: 'add', kind: 'outflow' },
  { label: '貸倒引当金の繰入限度超過額', side: 'add', kind: 'retained' },
  { label: '減価償却超過額の当期認容額', side: 'sub', kind: 'retained' },
  { label: '受取配当等の益金不算入額', side: 'sub', kind: 'outflow' },
  { label: '法人税等の中間納付額及び過誤納に係る還付金額', side: 'sub', kind: 'retained' },
  { label: '所得税額等及び欠損金の繰戻しによる還付金額等', side: 'sub', kind: 'outflow' },
];

export const MAX_ROWS = 20;
export const MAX_LOSS_ROWS = 12;
export const MAX_LABEL = 60;

/** 入力の初期値（period.corporateTax） */
export const DEFAULT_CORPORATE_TAX = {
  sme: true, // 中小法人（期末の資本金1億円以下で、大法人の100%子会社などではない）
  excluded: false, // 適用除外事業者
  dividends: 0, // 当期に支払った剰余金の配当（別表四の社外流出「配当」）
  entertainment: null, // 支出交際費等の額。null なら交際費の科目（目印 entertainment）の当期の額
  dining: 0, // うち接待飲食費の額
  withholding: 0, // 法人税額から控除される所得税額（復興特別所得税を含む）。withholdingRows があればその合計を使う
  withholdingRows: [], // 別表六(一)の明細 [{ kind, payer, address, date, income, tax, periodMonths, heldMonths }]（withholding-credit.js）
  credits: 0, // 法人税額の特別控除額（賃上げ促進税制など）
  residentAddBack: 0, // 法人税割の課税標準に足し戻す控除額（中小企業者等の賃上げ促進税制など）
  adjustments: [], // 別表四の「その他」の行 [{ label, side, kind, amount }]
  losses: [], // 控除未済欠損金額 [{ endDate, amount }]（青色申告の事業年度の欠損金）
  prior: zeroTaxes(), // 前期分の確定税額（当期に納税充当金を取り崩して納めたもの）
  interim: zeroTaxes(), // 当期の中間納付額（損金経理）。事業税は事業税の画面の中間納付額を使う
  tokyo: false, // 東京都の特別区（23区）
  ...RESIDENT_DEFAULTS,
  residentMonths: null, // 均等割の月数（null なら事業年度の月数）
  employees: null, // 期末の従業者数（第六号様式・第二十号様式の欄。均等割の区分に使う）
  interimPerCapita: { pref: 0, city: 0 }, // 中間納付額のうち均等割（残りは法人税割）
  openingAdjustments: [], // 別表五(一)の期首現在の調整項目 [{ label, amount }]
  shareholders: [], // 別表二の株主 [{ name, address, relation, group, shares, votes, corporate }]（family-company.js）
  sharesTotal: null, // 期末現在の発行済株式の総数又は出資の総額（null なら株主の合計）
  votesTotal: null, // 期末現在の議決権の総数（null なら発行済株式の総数）
};

const isNonNeg = (n) => isYen(n) && n >= 0;
const okRate = (r) => Number.isInteger(r) && r >= 0 && r <= 20000;

/** 入力の検証。エラーメッセージの配列を返す */
export function validateCorporateTax(v) {
  const errors = [];
  for (const k of ['sme', 'excluded', 'tokyo']) if (typeof v[k] !== 'boolean') errors.push('法人の区分を選んでください');
  for (const k of ['dividends', 'dining', 'withholding', 'credits', 'residentAddBack', 'prefPerCapita', 'cityPerCapita']) if (!isNonNeg(v[k])) errors.push('金額は0以上の整数の円で入力してください');
  if (v.entertainment !== null && !isNonNeg(v.entertainment)) errors.push('支出交際費等の額は0以上の整数の円で入力してください');
  for (const k of ['prefRate', 'cityRate']) if (!okRate(v[k])) errors.push('法人税割の税率は0〜20%の範囲で、小数第3位まで入力してください');
  if (v.employees !== null && !(Number.isInteger(v.employees) && v.employees >= 0 && v.employees <= 1000000)) errors.push('従業者数は0以上の整数で入力してください');
  for (const k of ['pref', 'city']) {
    const n = v.interimPerCapita?.[k] ?? 0;
    if (!isNonNeg(n)) errors.push('中間納付額のうち均等割は0以上の整数の円で入力してください');
    else if (n > (v.interim?.[k] ?? 0)) errors.push('中間納付額のうち均等割は、その税の中間納付額以下にしてください');
  }
  if (v.residentMonths !== null && !(Number.isInteger(v.residentMonths) && v.residentMonths >= 0 && v.residentMonths <= 12)) errors.push('均等割の月数は0〜12で入力してください');
  for (const g of ['prior', 'interim']) {
    if (!v[g] || typeof v[g] !== 'object') errors.push('前期分・中間納付の税額を入力してください');
    else for (const k of TAX_KINDS) if (!isNonNeg(v[g][k.key] ?? 0)) errors.push('前期分・中間納付の税額は0以上の整数の円で入力してください');
  }
  const label = (s) => typeof s === 'string' && s.trim() !== '' && s.length <= MAX_LABEL;
  if (!Array.isArray(v.adjustments) || v.adjustments.length > MAX_ROWS) errors.push(`加算・減算は${MAX_ROWS}行までです`);
  else
    for (const a of v.adjustments) {
      if (!label(a.label)) errors.push(`加算・減算の項目名は1〜${MAX_LABEL}文字で入力してください`);
      if (!['add', 'sub'].includes(a.side) || !['retained', 'outflow'].includes(a.kind)) errors.push('加算・減算と、留保・社外流出を選んでください');
      if (!isNonNeg(a.amount)) errors.push('加算・減算の金額は0以上の整数の円で入力してください');
    }
  if (!Array.isArray(v.losses) || v.losses.length > MAX_LOSS_ROWS) errors.push(`欠損金は${MAX_LOSS_ROWS}行までです`);
  else
    for (const l of v.losses) {
      if (!isValidDate(l.endDate)) errors.push('欠損金が生じた事業年度の終了日を入力してください');
      if (!(isYen(l.amount) && l.amount > 0)) errors.push('控除未済欠損金額は1円以上の整数の円で入力してください');
    }
  if (!Array.isArray(v.openingAdjustments) || v.openingAdjustments.length > MAX_ROWS) errors.push(`期首の調整項目は${MAX_ROWS}行までです`);
  else
    for (const a of v.openingAdjustments) {
      if (!label(a.label)) errors.push(`期首の調整項目の名前は1〜${MAX_LABEL}文字で入力してください`);
      if (!isYen(a.amount)) errors.push('期首の調整項目の金額は整数の円で入力してください（マイナスは「-」か「△」）');
    }
  errors.push(...validateShareholders(v));
  errors.push(...validateWithholdingRows(v.withholdingRows));
  return [...new Set(errors)];
}

/** 保存用に入力を整える（余計な項目を落とし、文字の前後の空白を取る） */
export function cleanCorporateTax(input) {
  const v = { ...DEFAULT_CORPORATE_TAX, ...input };
  const taxes = (t) => Object.fromEntries(TAX_KINDS.map((k) => [k.key, t?.[k.key] ?? 0]));
  return {
    ...Object.fromEntries(Object.keys(DEFAULT_CORPORATE_TAX).map((k) => [k, v[k]])),
    prior: taxes(v.prior),
    interim: taxes(v.interim),
    interimPerCapita: { pref: v.interimPerCapita?.pref ?? 0, city: v.interimPerCapita?.city ?? 0 },
    adjustments: (v.adjustments || []).map((a) => ({ label: String(a.label ?? '').trim(), side: a.side, kind: a.kind, amount: a.amount })),
    losses: (v.losses || []).map((l) => ({ endDate: l.endDate, amount: l.amount })).sort((a, b) => (a.endDate < b.endDate ? -1 : a.endDate > b.endDate ? 1 : 0)),
    openingAdjustments: (v.openingAdjustments || []).map((a) => ({ label: String(a.label ?? '').trim(), amount: a.amount })),
    shareholders: cleanShareholders(v.shareholders),
    withholdingRows: cleanWithholdingRows(v.withholdingRows),
  };
}

const floor1000 = (n) => (n > 0 ? Math.floor(n / 1000) * 1000 : 0);
const floor100 = (n) => (n >= 0 ? Math.floor(n / 100) * 100 : -Math.floor(-n / 100) * 100);
/** 金額×率（1/1000 %）の1円未満切捨て（大きな金額でも誤差が出ないよう BigInt で計算） */
export const applyRate = (amount, rate) => (amount > 0 ? Number((BigInt(amount) * BigInt(rate)) / 100000n) : 0);
/** 年額×月数/12（1円未満切捨て） */
const monthly = (annual, months) => Math.floor((annual * months) / 12);

/** 確定申告・納付の期限：事業年度終了の日の翌日から2か月以内（休日なら翌日。申告期限の延長の特例は考えない） */
export function filingDeadline(endDate) {
  return taxDueDate(addDays(addMonths(addDays(endDate, 1), 2), -1));
}

/** 中小法人の年800万円以下の部分の税率 */
export function smeRate({ startDate, income, months, excluded }) {
  if (excluded || startDate > SME_SPECIAL_UNTIL) return RATES.smeBase;
  if (startDate >= HIGH_INCOME_FROM && income > monthly(HIGH_INCOME_ANNUAL, months)) return RATES.smeHigh;
  return RATES.smeSpecial;
}

/**
 * 法人税額（別表一の税額計算）
 * @returns {{ base, tiers: Array<{ label, amount, rate, tax }>, tax }}
 */
export function corporationTaxAmount({ income, months, startDate, sme = true, excluded = false }) {
  const base = floor1000(income);
  if (!sme) return { base, tiers: [{ label: '所得金額（課税標準）', amount: base, rate: RATES.standard, tax: applyRate(base, RATES.standard) }], tax: applyRate(base, RATES.standard) };
  const limit = floor1000(monthly(SME_ANNUAL, months));
  const low = Math.min(base, limit);
  const high = base - low;
  const lowRate = smeRate({ startDate, income: base, months, excluded });
  const tiers = [
    { label: '年800万円相当額以下の金額', amount: low, rate: lowRate, tax: applyRate(low, lowRate) },
    { label: '年800万円相当額を超える金額', amount: high, rate: RATES.standard, tax: applyRate(high, RATES.standard) },
  ];
  return { base, limit, tiers, tax: tiers[0].tax + tiers[1].tax };
}

/** 別表十五：交際費等の損金不算入額 */
export function entertainmentCalc({ amount, dining, months, sme = true }) {
  const diningBase = Math.floor(Math.min(dining, amount) / 2);
  const fixedLimit = sme ? Math.min(amount, monthly(ENTERTAINMENT_ANNUAL, months)) : 0;
  const limit = Math.max(diningBase, fixedLimit);
  return { amount, dining: Math.min(dining, amount), diningBase, fixedLimit, limit, disallowed: Math.max(0, amount - limit), method: fixedLimit >= diningBase ? 'fixed' : 'dining' };
}

/** 欠損金の繰越期間（平成30年4月1日以後に開始した事業年度の欠損金は10年、それより前は9年） */
export function lossCarryYears(endDate) {
  return endDate >= '2019-03-31' ? 10 : 9;
}

/** 欠損金が生じた事業年度の開始日（終了日から12か月の事業年度とみなす） */
function lossStart(endDate) {
  const [y, m, d] = endDate.split('-').map(Number);
  return addDays(`${y - 1}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`.replace(/-02-29$/, '-02-28'), 1);
}

/**
 * 別表七(一)：欠損金の当期控除額と翌期繰越額
 * 控除限度額は中小法人等は所得の100%、それ以外は50%。古い事業年度の欠損金から控除する
 */
export function lossCarryforward({ losses, income, startDate, endDate, sme = true }) {
  const limit = income > 0 ? (sme ? income : Math.floor(income / 2)) : 0;
  let room = limit;
  const rows = [...losses]
    .sort((a, b) => (a.endDate < b.endDate ? -1 : 1))
    .map((l) => {
      const years = lossCarryYears(l.endDate);
      const start = lossStart(l.endDate);
      const [y, m, d] = startDate.split('-').map(Number);
      const oldest = `${y - years}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
      const expired = start < oldest;
      const future = l.endDate >= startDate;
      const deducted = expired || future ? 0 : Math.min(room, l.amount);
      room -= deducted;
      return { endDate: l.endDate, start, opening: l.amount, deducted, carry: expired ? 0 : l.amount - deducted, expired, future, years };
    });
  const deducted = limit - room;
  const current = income < 0 ? -income : 0;
  if (current) rows.push({ endDate, start: startDate, opening: 0, deducted: 0, carry: current, expired: false, future: false, years: 10, current: true });
  return { limit, deducted, rows, carry: rows.reduce((s, r) => s + r.carry, 0), available: rows.filter((r) => !r.current && !r.expired && !r.future).reduce((s, r) => s + r.opening, 0) };
}

/** 法人住民税（法人税割・均等割）の1つの自治体の分 */
function residentPart({ base, rate, perCapita, months, interim, interimPerCapita = 0 }) {
  const taxPart = floor100(applyRate(base, rate));
  const perCapitaPart = floor100(monthly(perCapita, months));
  const total = taxPart + perCapitaPart;
  // 中間納付額を法人税割と均等割に分ける（第六号様式・第二十号様式の「既に納付の確定した当期分」の欄）
  const interimPC = Math.min(interimPerCapita, interim);
  const interimTaxPart = interim - interimPC;
  return { rate, taxPart, perCapita, perCapitaPart, total, interim, interimTaxPart, interimPerCapita: interimPC, dueTaxPart: taxPart - interimTaxPart, duePerCapita: perCapitaPart - interimPC, due: total - interim };
}

const sumBy = (list, f) => list.reduce((s, x) => s + f(x), 0);

/**
 * 法人税・地方法人税・防衛特別法人税・住民税・事業税と、別表一・四・五(一)・五(二)・七(一)・十五
 * @param {{ accounts, period, journals, input?: object, enterpriseInput?: object }}
 */
export function corporateTaxReturn({ accounts, period, journals, input = {}, enterpriseInput = {} }) {
  const v = cleanCorporateTax(input);
  // 別表六(一)の明細があれば、控除を受ける所得税額はその計（6の③）
  const schedule61 = withholdingCredit(v.withholdingRows);
  if (schedule61.entered) v.withholding = schedule61.credit;
  const ent = { ...DEFAULT_ENTERPRISE_TAX, ...enterpriseInput };
  const { startDate, endDate } = period;
  const months = periodMonths(period);
  const supported = startDate >= SUPPORTED_FROM;
  const defenseApplies = startDate >= DEFENSE_FROM;
  const warnings = [];

  const { pl } = buildStatements({ entityType: 'corporation', accounts, period, journals });
  const tb = trialBalance({ accounts, period, journals });
  const netIncome = pl.netIncome;
  const plTaxes = pl.profits.pretax - pl.profits.net;

  // 納税充当金（未払法人税等）：期首・繰入（貸方）・取崩（借方）・期末
  const payableRows = tb.rows.filter((r) => r.account.hint === 'income_taxes_payable');
  const provision = {
    opening: sumBy(payableRows, (r) => r.opening),
    added: sumBy(payableRows, (r) => r.credit),
    used: sumBy(payableRows, (r) => r.debit),
    closing: sumBy(payableRows, (r) => r.closing),
  };
  if (!payableRows.length) warnings.push('未払法人税等の科目が見つかりません。納税充当金は0として計算しています');

  // 交際費等（別表十五）
  const entRows = tb.rows.filter((r) => r.account.hint === 'entertainment');
  const entAuto = sumBy(entRows, (r) => r.debit - r.credit);
  const entertainment = entertainmentCalc({ amount: v.entertainment ?? Math.max(0, entAuto), dining: v.dining, months, sme: v.sme });
  entertainment.auto = v.entertainment === null;
  if (v.dining > entertainment.amount) warnings.push('接待飲食費の額が支出交際費等の額より多くなっています（交際費等の額までで計算しています）');

  // 中間納付額（事業税・特別法人事業税は事業税の画面の入力）
  const interim = { ...v.interim, enterprise: (ent.interimTax || 0) + (ent.interimSpecial || 0) };
  const prior = v.prior;
  const interimNational = interim.corp + interim.local + interim.defense;
  const interimResident = interim.pref + interim.city;
  const priorNational = prior.corp + prior.local + prior.defense;
  const priorResident = prior.pref + prior.city;

  // ---- 別表四 ----
  const adds = [
    { key: 'nationalTax', label: '損金経理をした法人税及び地方法人税（附帯税を除く。）', amount: interimNational, kind: 'retained', note: defenseApplies ? '防衛特別法人税を含む' : '' },
    { key: 'residentTax', label: '損金経理をした道府県民税及び市町村民税', amount: interimResident, kind: 'retained' },
    { key: 'provision', label: '損金経理をした納税充当金', amount: provision.added, kind: 'retained' },
    { key: 'entertainment', label: '交際費等の損金不算入額', amount: entertainment.disallowed, kind: 'outflow' },
    ...v.adjustments.filter((a) => a.side === 'add').map((a) => ({ key: 'other', label: a.label, amount: a.amount, kind: a.kind })),
  ];
  const subs = [
    { key: 'enterprisePaid', label: '納税充当金から支出した事業税等の金額', amount: prior.enterprise, kind: 'retained' },
    ...v.adjustments.filter((a) => a.side === 'sub').map((a) => ({ key: 'other', label: a.label, amount: a.amount, kind: a.kind })),
  ];
  const split = (list) => ({ total: sumBy(list, (x) => x.amount), retained: sumBy(list.filter((x) => x.kind === 'retained'), (x) => x.amount), outflow: sumBy(list.filter((x) => x.kind === 'outflow'), (x) => x.amount) });
  const addTotal = split(adds);
  const subTotal = split(subs);
  const profitRow = { total: netIncome, retained: netIncome - v.dividends, outflow: v.dividends };
  const provisional = { total: profitRow.total + addTotal.total - subTotal.total, retained: profitRow.retained + addTotal.retained - subTotal.retained, outflow: profitRow.outflow + addTotal.outflow - subTotal.outflow };
  const total = { total: provisional.total + v.withholding, retained: provisional.retained, outflow: provisional.outflow + v.withholding };
  const loss = lossCarryforward({ losses: v.losses, income: total.total, startDate, endDate, sme: v.sme });
  const income = { total: total.total - loss.deducted, retained: total.retained, outflow: total.outflow - loss.deducted };
  const schedule4 = { profit: profitRow, adds, addTotal, subs, subTotal, provisional, withholding: v.withholding, total, lossDeducted: loss.deducted, income };

  // ---- 別表一：法人税 ----
  const taxable = Math.max(0, income.total);
  const amount = corporationTaxAmount({ income: taxable, months, startDate, sme: v.sme, excluded: v.excluded });
  const credits = Math.min(v.credits, amount.tax);
  if (v.credits > amount.tax) warnings.push('法人税額の特別控除額が法人税額より多くなっています（法人税額までで計算しています）');
  const afterCredits = amount.tax - credits; // 差引法人税額＝所得の金額に対する法人税額
  const withholdingUsed = Math.min(v.withholding, afterCredits);
  const corpTax = floor100(afterCredits - withholdingUsed); // 差引所得に対する法人税額
  const corp = {
    income: income.total,
    base: amount.base,
    limit: amount.limit,
    tiers: amount.tiers,
    tax: amount.tax,
    credits,
    afterCredits,
    withholdingUsed,
    refundWithholding: v.withholding - withholdingUsed,
    annual: corpTax,
    interim: interim.corp,
    due: corpTax - interim.corp,
  };

  // 地方法人税
  const localBase = floor1000(afterCredits);
  const localTax = floor100(applyRate(localBase, RATES.local));
  const local = { standard: afterCredits, base: localBase, rate: RATES.local, annual: localTax, interim: interim.local, due: localTax - interim.local };

  // 防衛特別法人税
  const defenseDeduction = monthly(DEFENSE_DEDUCTION, months);
  const defenseBase = defenseApplies ? floor1000(afterCredits - defenseDeduction) : 0;
  const defenseTax = defenseApplies ? floor100(applyRate(defenseBase, RATES.defense)) : 0;
  const defense = { applies: defenseApplies, standard: afterCredits, deduction: defenseDeduction, base: defenseBase, rate: RATES.defense, annual: defenseTax, interim: interim.defense, due: defenseTax - interim.defense, interimRequired: startDate >= DEFENSE_INTERIM_FROM };

  // ---- 法人住民税 ----
  const residentBase = floor1000(afterCredits + v.residentAddBack);
  const residentMonths = v.residentMonths ?? Math.min(12, months);
  const resident = {
    tokyo: v.tokyo,
    taxAmount: afterCredits, // 法人税法の規定によって計算した法人税額（第六号様式・第二十号様式の①）
    addBack: v.residentAddBack, // 試験研究費の額等に係る法人税額の特別控除額（②）
    base: residentBase,
    months: residentMonths,
    pref: residentPart({ base: residentBase, rate: v.prefRate, perCapita: v.prefPerCapita, months: residentMonths, interim: interim.pref, interimPerCapita: v.interimPerCapita.pref }),
    city: residentPart({ base: residentBase, rate: v.cityRate, perCapita: v.cityPerCapita, months: residentMonths, interim: interim.city, interimPerCapita: v.interimPerCapita.city }),
  };
  if (v.credits && !v.residentAddBack && v.sme) warnings.push('中小企業者等の賃上げ促進税制・試験研究費の税額控除などは、住民税の法人税割の計算では引かないことがあります。足し戻す額を確かめてください');

  // ---- 事業税（所得は別表四の所得金額。事業税の画面で入力した所得があればそれを使う） ----
  const enterpriseIncome = Number.isInteger(ent.income) ? ent.income : income.total;
  const enterprise = { ...corporateEnterpriseTax({ ...ent, income: enterpriseIncome, months: Math.min(12, months) }), fromSchedule4: !Number.isInteger(ent.income) };

  // ---- 納める税額の一覧 ----
  const dues = [
    { key: 'corp', label: '法人税', annual: corp.annual, interim: corp.interim, due: corp.due },
    { key: 'local', label: '地方法人税', annual: local.annual, interim: local.interim, due: local.due },
    defenseApplies ? { key: 'defense', label: '防衛特別法人税', annual: defense.annual, interim: defense.interim, due: defense.due } : null,
    { key: 'pref', label: v.tokyo ? '都民税' : '道府県民税', annual: resident.pref.total, interim: resident.pref.interim, due: resident.pref.due },
    v.tokyo && !resident.city.total && !interim.city ? null : { key: 'city', label: '市町村民税', annual: resident.city.total, interim: resident.city.interim, due: resident.city.due },
    { key: 'enterprise', label: '事業税・特別法人事業税', annual: enterprise.incomeTax + enterprise.special, interim: enterprise.interimTax + enterprise.interimSpecial, due: enterprise.total },
  ].filter(Boolean);
  const dueTotal = sumBy(dues, (d) => d.due);
  // 未払法人税等に計上する額の目安（還付になる税は含めない）
  const payableTarget = sumBy(dues, (d) => Math.max(0, d.due));

  // 法人税等の内訳の確かめ：損益計算書の法人税等＝中間納付（損金経理）＋納税充当金への繰入（＋法人税等で処理した源泉所得税）
  const interimAll = interimNational + interimResident + interim.enterprise;
  const taxesRest = plTaxes - interimAll - provision.added;
  if (taxesRest !== 0 && taxesRest !== v.withholding) warnings.push(`損益計算書の法人税等（${plTaxes.toLocaleString('ja-JP')}円）と、中間納付額＋未払法人税等への繰入額（${(interimAll + provision.added).toLocaleString('ja-JP')}円）が合いません。中間納付額の入力と、法人税等の仕訳を確かめてください`);
  if (provision.closing !== payableTarget && supported) warnings.push(`期末の未払法人税等（${provision.closing.toLocaleString('ja-JP')}円）が、この計算で納める税額（${payableTarget.toLocaleString('ja-JP')}円）と違います。決算整理で未払法人税等を計上し直すと、決算書と申告書がそろいます`);

  // ---- 別表五(二)：租税公課の納付状況等 ----
  // 列：期首現在未納税額・当期発生税額・充当金取崩しによる納付・仮払経理による納付・損金経理による納付・期末現在未納税額
  const taxRow = (label, { opening = 0, accrued = 0, provisionPaid = 0, expensePaid = 0 }) => ({ label, opening, accrued, provisionPaid, prepaidPaid: 0, expensePaid, closing: opening + accrued - provisionPaid - expensePaid });
  const taxBlock = (label, priorAmt, interimAmt, annual) => {
    const rows = [taxRow('前期分', { opening: priorAmt, provisionPaid: priorAmt }), taxRow('当期分 中間', { accrued: interimAmt, expensePaid: interimAmt }), taxRow('当期分 確定', { accrued: annual - interimAmt })];
    const keys = ['opening', 'accrued', 'provisionPaid', 'prepaidPaid', 'expensePaid', 'closing'];
    return { label, rows, total: Object.fromEntries(keys.map((k) => [k, sumBy(rows, (r) => r[k])])) };
  };
  const nationalAnnual = corp.annual + local.annual + defense.annual;
  const provisionOther = provision.used - priorNational - priorResident - prior.enterprise;
  if (provisionOther < 0) warnings.push('前期分の確定税額の入力が、当期に未払法人税等を取り崩した額より多くなっています。前期分の入力か、納付の仕訳を確かめてください');
  const enterpriseRows = [taxRow('前期分', { accrued: prior.enterprise, provisionPaid: prior.enterprise }), taxRow('当期分 中間', { accrued: interim.enterprise, expensePaid: interim.enterprise })];
  const schedule52 = {
    blocks: [
      taxBlock(defenseApplies ? '法人税、地方法人税及び防衛特別法人税' : '法人税及び地方法人税', priorNational, interimNational, nationalAnnual),
      taxBlock(v.tokyo ? '都民税' : '道府県民税', prior.pref, interim.pref, resident.pref.total),
      ...(v.tokyo && !prior.city && !interim.city && !resident.city.total ? [] : [taxBlock('市町村民税', prior.city, interim.city, resident.city.total)]),
      { label: '事業税及び特別法人事業税', rows: enterpriseRows, total: Object.fromEntries(['opening', 'accrued', 'provisionPaid', 'prepaidPaid', 'expensePaid', 'closing'].map((k) => [k, sumBy(enterpriseRows, (r) => r[k])])) },
    ],
    provision: { opening: provision.opening, added: provision.added, usedTaxes: priorNational + priorResident, usedEnterprise: prior.enterprise, usedOther: provisionOther, used: provision.used, closing: provision.closing },
  };

  // ---- 別表五(一)：利益積立金額・資本金等の額 ----
  const equityRows = tb.rows.filter((r) => r.account.group === 'equity');
  // 貸方残の科目は残高のまま、借方残の科目（自己株式など）はマイナスで書く。減＝借方、増＝貸方
  const flow = (r) => {
    const sign = r.account.normalSide === 'debit' ? -1 : 1;
    return { opening: sign * r.opening, decrease: r.debit, increase: r.credit, closing: sign * r.closing };
  };
  const retainedRow = equityRows.find((r) => r.account.role === 'retained_earnings');
  const reserveRows = equityRows.filter((r) => r.account.role !== 'retained_earnings' && r.account.role !== 'capital_stock' && r.account.hint !== 'capital_reserve' && (r.opening || r.debit || r.credit));
  const otherEquity = reserveRows.filter((r) => r.account.hint !== 'legal_reserve');
  if (otherEquity.length) warnings.push(`純資産の科目（${otherEquity.map((r) => r.account.name).join('・')}）は利益積立金額に入れています。資本剰余金・自己株式などのときは別表五(一)を直してください`);
  // 調整項目：期首の入力と当期の留保の加算・減算を、名前で突き合わせる
  const adjMap = new Map();
  const adj = (label) => {
    if (!adjMap.has(label)) adjMap.set(label, { label, opening: 0, decrease: 0, increase: 0 });
    return adjMap.get(label);
  };
  for (const a of v.openingAdjustments) adj(a.label).opening += a.amount;
  for (const a of v.adjustments.filter((x) => x.kind === 'retained')) {
    if (a.side === 'add') adj(a.label).increase += a.amount;
    else adj(a.label).decrease += a.amount;
  }
  const adjustRows = [...adjMap.values()].map((r) => ({ ...r, closing: r.opening - r.decrease + r.increase }));
  const retainedOpening = retainedRow ? retainedRow.opening : 0;
  const retainedClosing = (retainedRow ? retainedRow.closing : 0) + netIncome;
  const unpaid = (priorAmt, interimAmt, annual) => ({ opening: -priorAmt, decrease: -(priorAmt + interimAmt), increase: -annual, closing: -(annual - interimAmt), interim: -interimAmt, final: -(annual - interimAmt) });
  const rows51 = [
    ...reserveRows.map((r) => ({ label: r.account.name, ...flow(r) })),
    ...adjustRows.map((r) => ({ ...r, adjustment: true })),
    { label: '繰越損益金（損は赤）', opening: retainedOpening, decrease: retainedOpening, increase: retainedClosing, closing: retainedClosing },
    { label: '納税充当金', opening: provision.opening, decrease: provision.used, increase: provision.added, closing: provision.closing },
    { label: defenseApplies ? '未納法人税等（法人税・地方法人税・防衛特別法人税）' : '未納法人税及び未納地方法人税（附帯税を除く。）', unpaid: true, ...unpaid(priorNational, interimNational, nationalAnnual) },
    { label: `未納${v.tokyo ? '都民税' : '道府県民税'}（均等割を含む。）`, unpaid: true, ...unpaid(prior.pref, interim.pref, resident.pref.total) },
    ...(v.tokyo && !prior.city && !interim.city && !resident.city.total ? [] : [{ label: '未納市町村民税（均等割を含む。）', unpaid: true, ...unpaid(prior.city, interim.city, resident.city.total) }]),
  ];
  const keys4 = ['opening', 'decrease', 'increase', 'closing'];
  const total51 = Object.fromEntries(keys4.map((k) => [k, sumBy(rows51, (r) => r[k])]));
  // 検算：期首現在利益積立金額＋別表四の留保所得−中間分・確定分の法人税・地方法人税・住民税＝差引翌期首現在利益積立金額
  const annualTaxes = nationalAnnual + resident.pref.total + resident.city.total;
  const expected = total51.opening + income.retained - annualTaxes;
  const check = { opening: total51.opening, retained: income.retained, taxes: annualTaxes, expected, closing: total51.closing, diff: total51.closing - expected, ok: total51.closing === expected };
  if (!check.ok) warnings.push(`別表五(一)の検算が${Math.abs(check.diff).toLocaleString('ja-JP')}円合いません。配当の額、前期分の確定税額、期首の調整項目（前期の別表五(一)の期末）を確かめてください`);
  const capitalRows = equityRows.filter((r) => (r.account.role === 'capital_stock' || r.account.hint === 'capital_reserve') && (r.opening || r.debit || r.credit || r.account.role === 'capital_stock')).map((r) => ({ label: r.account.name, ...flow(r) }));
  const capitalTotal = Object.fromEntries(keys4.map((k) => [k, sumBy(capitalRows, (r) => r[k])]));
  // 期末現在の資本金の額（申告書の頭書き）と、資本金等の額（均等割の区分。ここでは資本金＋資本準備金）
  const capital = { stock: sumBy(equityRows.filter((r) => r.account.role === 'capital_stock'), (r) => flow(r).closing), total: capitalTotal.closing };
  const schedule51 = { rows: rows51, total: total51, check, capitalRows, capitalTotal, adjustRows };

  if (!supported) warnings.unshift(`${SUPPORTED_FROM.slice(0, 4)}年10月1日より前に開始した事業年度には対応していません（地方法人税の税率が違います）`);
  if (v.sme && capitalTotal.closing > 100000000) warnings.push('資本金等が1億円を超えています。中小法人に当たるか確かめてください');

  return {
    supported,
    period: { startDate, endDate, months },
    input: v,
    netIncome,
    plTaxes,
    provision,
    entertainment,
    schedule4,
    loss,
    corp,
    local,
    defense,
    resident,
    enterprise,
    capital,
    employees: v.employees,
    schedule61,
    family: familyCompany({ shareholders: v.shareholders, sharesTotal: v.sharesTotal, votesTotal: v.votesTotal, sme: v.sme }),
    dues,
    dueTotal,
    payableTarget,
    schedule52,
    schedule51,
    warnings,
  };
}

/**
 * 前期の計算から当期の入力に引き継ぐもの：欠損金の翌期繰越額・別表五(一)の調整項目の期末・前期分の確定税額
 * @param {object} prev 前期の corporateTaxReturn の結果
 */
export function carryOverInput(prev) {
  const pos = (n) => Math.max(0, n);
  return {
    losses: prev.loss.rows.filter((r) => r.carry > 0).map((r) => ({ endDate: r.endDate, amount: r.carry })),
    openingAdjustments: prev.schedule51.adjustRows.filter((r) => r.closing !== 0).map((r) => ({ label: r.label, amount: r.closing })),
    // 株主・発行済株式の総数は前期末のものを引き継ぐ（変わっていれば直す）
    shareholders: prev.input.shareholders,
    sharesTotal: prev.input.sharesTotal,
    votesTotal: prev.input.votesTotal,
    prior: {
      corp: pos(prev.corp.due),
      local: pos(prev.local.due),
      defense: pos(prev.defense.due),
      pref: pos(prev.resident.pref.due),
      city: pos(prev.resident.city.due),
      enterprise: pos(prev.enterprise.dueTax) + pos(prev.enterprise.dueSpecial),
    },
  };
}

/** CSV の行（別表ごとの行と金額） */
export function corporateTaxCsvRows(r) {
  const out = [['別表', '項目', '総額', '留保', '社外流出']];
  const s4 = r.schedule4;
  out.push(['別表四', '当期利益又は当期欠損の額', s4.profit.total, s4.profit.retained, s4.profit.outflow]);
  for (const a of s4.adds) if (a.amount) out.push(['別表四', `加算：${a.label}`, a.amount, a.kind === 'retained' ? a.amount : '', a.kind === 'outflow' ? a.amount : '']);
  out.push(['別表四', '加算 小計', s4.addTotal.total, s4.addTotal.retained, s4.addTotal.outflow]);
  for (const a of s4.subs) if (a.amount) out.push(['別表四', `減算：${a.label}`, a.amount, a.kind === 'retained' ? a.amount : '', a.kind === 'outflow' ? a.amount : '']);
  out.push(['別表四', '減算 小計', s4.subTotal.total, s4.subTotal.retained, s4.subTotal.outflow]);
  out.push(['別表四', '仮計', s4.provisional.total, s4.provisional.retained, s4.provisional.outflow]);
  out.push(['別表四', '法人税額から控除される所得税額', s4.withholding, '', s4.withholding]);
  out.push(['別表四', '合計', s4.total.total, s4.total.retained, s4.total.outflow]);
  out.push(['別表四', '欠損金の当期控除額', -s4.lossDeducted, '', -s4.lossDeducted]);
  out.push(['別表四', '所得金額又は欠損金額', s4.income.total, s4.income.retained, s4.income.outflow]);
  const one = (label, n) => out.push(['別表一', label, n, '', '']);
  one('所得金額又は欠損金額', r.corp.income);
  for (const t of r.corp.tiers) one(`${t.label}（${t.rate / 1000}%）`, t.amount), one(`${t.label}の税額`, t.tax);
  one('法人税額', r.corp.tax);
  one('法人税額の特別控除額', r.corp.credits);
  one('差引法人税額', r.corp.afterCredits);
  one('控除税額（所得税額）', r.corp.withholdingUsed);
  one('差引所得に対する法人税額', r.corp.annual);
  one('中間申告分の法人税額', r.corp.interim);
  one('差引確定法人税額', r.corp.due);
  one('地方法人税 課税標準法人税額', r.local.base);
  one('地方法人税額', r.local.annual);
  one('差引確定地方法人税額', r.local.due);
  if (r.defense.applies) {
    one('防衛特別法人税 基礎控除額', r.defense.deduction);
    one('防衛特別法人税 課税標準法人税額', r.defense.base);
    one('防衛特別法人税額', r.defense.annual);
    one('差引確定防衛特別法人税額', r.defense.due);
  }
  const e = r.entertainment;
  out.push(['別表十五', '支出交際費等の額', e.amount, '', ''], ['別表十五', '支出接待飲食費損金算入基準額', e.diningBase, '', ''], ['別表十五', '中小法人等の定額控除限度額', e.fixedLimit, '', ''], ['別表十五', '損金算入限度額', e.limit, '', ''], ['別表十五', '損金不算入額', e.disallowed, '', '']);
  for (const d of r.dues) out.push(['納める税額', d.label, d.due, '', '']);
  return out;
}
