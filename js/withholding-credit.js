// 所得税額の控除（法人税 別表六(一)）：預金の利子・配当などから源泉徴収された所得税（復興特別所得税を含む）のうち、
// 法人税額から控除を受ける額を区分ごとに集計する（純粋関数）
// 国税庁 別表六(一)の様式（令和7年4月1日以後終了事業年度分）：
//   https://www.nta.go.jp/taxes/tetsuzuki/shinsei/annai/hojin/shinkoku/itiran2025/pdf/06(01).pdf （2026-10-31 に PDF の文字で確認）
// - 区分 1 利子等・2 剰余金の配当等・3 集団投資信託の収益の分配・4 割引債の償還差益・5 その他、6 計。欄は ①収入金額 ②所得税額 ③控除を受ける所得税額
// - 2〜4 は元本の所有期間に応じて控除する（個別法：(11) 所有期間割合＝(10)/(9)、小数点以下3位未満切上げ、(12)＝(8)×(11)）。
//   このアプリは個別法だけを計算する。簡便法（13〜19）は使わない（欄は空欄）
// - 1 と 5 は全額を控除する。5 は支払者ごとの明細（20・21）を書く

export const MAX_WITHHOLDING_ROWS = 20;
const MAX_TEXT = 60;

/** 区分（様式の 1〜5） */
export const WITHHOLDING_KINDS = [
  { no: 1, short: '預貯金・公社債の利子など', label: '公社債及び預貯金の利子、合同運用信託、公社債投資信託及び公社債等運用投資信託（特定公社債等運用投資信託を除く。）の収益の分配並びに特定公社債等運用投資信託の受益権及び特定目的信託の社債的受益権に係る剰余金の配当' },
  { no: 2, short: '株式の配当など', label: '剰余金の配当（特定公社債等運用投資信託の受益権及び特定目的信託の社債的受益権に係るものを除く。）、利益の配当、剰余金の分配及び金銭の分配（みなし配当等を除く。）', prorate: true },
  { no: 3, short: '投資信託の収益の分配', label: '集団投資信託（合同運用信託、公社債投資信託及び公社債等運用投資信託（特定公社債等運用投資信託を除く。）を除く。）の収益の分配', prorate: true },
  { no: 4, short: '割引債の償還差益', label: '割引債の償還差益', prorate: true },
  { no: 5, short: 'その他', label: 'その他' },
];

const kindOf = (no) => WITHHOLDING_KINDS.find((k) => k.no === no);

/** 行の初期値 */
export const emptyWithholdingRow = () => ({ kind: 1, payer: '', address: '', date: '', income: 0, tax: 0, periodMonths: null, heldMonths: null });

const isYen = (n) => Number.isInteger(n) && n >= 0 && n <= 1e13;
const isMonths = (n) => Number.isInteger(n) && n >= 1 && n <= 600;

/** 入力の検証。エラーメッセージの配列 */
export function validateWithholdingRows(rows = []) {
  if (!Array.isArray(rows) || rows.length > MAX_WITHHOLDING_ROWS) return [`所得税額の明細は${MAX_WITHHOLDING_ROWS}行までです`];
  const errors = [];
  for (const x of rows) {
    if (!kindOf(x.kind)) errors.push('所得税額の明細の区分を選んでください');
    if (typeof x.payer !== 'string' || !x.payer.trim() || x.payer.length > MAX_TEXT) errors.push(`所得税額の明細の支払者（銘柄）は1〜${MAX_TEXT}文字で入力してください`);
    if (typeof (x.address ?? '') !== 'string' || (x.address ?? '').length > MAX_TEXT) errors.push(`支払者の住所は${MAX_TEXT}文字までです`);
    if (x.date && !/^\d{4}-\d{2}-\d{2}$/.test(x.date)) errors.push('支払を受けた年月日の形が正しくありません');
    if (!isYen(x.income) || !isYen(x.tax)) errors.push('収入金額・所得税額は0以上の整数の円で入力してください');
    else if (x.tax > x.income) errors.push('所得税額が収入金額を超えています');
    const p = x.periodMonths ?? null;
    const held = x.heldMonths ?? null;
    if ((p === null) !== (held === null)) errors.push('配当などの計算期間と所有期間は、両方入れるか両方空欄にしてください');
    else if (p !== null) {
      if (!isMonths(p) || !isMonths(held)) errors.push('計算期間・所有期間は1以上の整数の月数で入力してください');
      else if (held > p) errors.push('所有期間は計算期間以下にしてください');
    }
  }
  return [...new Set(errors)];
}

/** 保存する形にそろえる */
export function cleanWithholdingRows(rows = []) {
  return (rows || []).map((x) => {
    const prorate = kindOf(x.kind)?.prorate;
    return {
      kind: x.kind,
      payer: String(x.payer ?? '').trim(),
      address: String(x.address ?? '').trim(),
      date: String(x.date ?? ''),
      income: x.income,
      tax: x.tax,
      periodMonths: prorate ? (x.periodMonths ?? null) : null,
      heldMonths: prorate ? (x.heldMonths ?? null) : null,
    };
  });
}

/** 所有期間割合（1/1000 単位、小数点以下3位未満切上げ、1を超えない） */
export function holdingRatio(period, held) {
  if (!period) return 1000;
  return Math.min(1000, Math.ceil((held * 1000) / period));
}

/**
 * 別表六(一)の計算
 * @param {Array} rows 明細の行
 * @returns {{ kinds, total, lines, prorated, others, credit, entered }} kinds は区分1〜5の①②③、prorated は個別法の行、others は区分5の明細
 */
export function withholdingCredit(rows = []) {
  const list = cleanWithholdingRows(rows);
  const lines = list.map((x) => {
    const prorate = kindOf(x.kind)?.prorate && x.periodMonths;
    const ratio = prorate ? holdingRatio(x.periodMonths, x.heldMonths) : 1000;
    // (12)＝(8)×(11)。円未満は切り捨て（控除を受ける額を多くしない）
    const credit = ratio === 1000 ? x.tax : Math.floor((x.tax * ratio) / 1000);
    return { ...x, ratio, credit };
  });
  const kinds = WITHHOLDING_KINDS.map((k) => {
    const of = lines.filter((x) => x.kind === k.no);
    return { ...k, income: of.reduce((s, x) => s + x.income, 0), tax: of.reduce((s, x) => s + x.tax, 0), credit: of.reduce((s, x) => s + x.credit, 0), count: of.length };
  });
  const total = { income: kinds.reduce((s, k) => s + k.income, 0), tax: kinds.reduce((s, k) => s + k.tax, 0), credit: kinds.reduce((s, k) => s + k.credit, 0) };
  return {
    kinds,
    total,
    lines,
    prorated: lines.filter((x) => kindOf(x.kind)?.prorate),
    others: lines.filter((x) => x.kind === 5),
    credit: total.credit,
    entered: lines.length > 0,
  };
}

/** 所有期間割合の表示（0.834） */
export const formatHoldingRatio = (r) => (r / 1000).toFixed(3);
