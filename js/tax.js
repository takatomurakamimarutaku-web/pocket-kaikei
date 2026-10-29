// 税区分と消費税の集計（純粋関数）
//
// 税込経理方式。割り戻しの参考値の計算は国税庁の説明による：
//   売上税額＝標準税率の対象となる税込売上額×7.8/110＋軽減税率の対象となる税込売上額×6.24/108
//   出典：タックスアンサー No.6383 課税標準額に対する消費税額の計算
//         https://www.nta.go.jp/taxes/shiraberu/taxanswer/shohi/6383.htm
//         タックスアンサー No.6391 課税仕入れに係る消費税額の計算
//         https://www.nta.go.jp/taxes/shiraberu/taxanswer/shohi/6391.htm
// これは参考値。申告書の計算（千円未満切捨て・インボイスの経過措置・簡易課税・2割特例など）は tax-return.js。

/**
 * 税区分のグループ（入力画面の選択肢の見出しと、集計表の区切り）
 * split：仕入の用途区分（個別対応方式）。設定で「使う」にしたときだけ選択肢に出す
 */
export const TAX_GROUPS = [
  { id: 'other', label: '対象外・非課税仕入' },
  { id: 'sales', label: '売上' },
  { id: 'sales_adj', label: '売上の返品・値引き・貸倒れ' },
  { id: 'purchase', label: '仕入・経費' },
  { id: 'import', label: '輸入' },
  { id: 'common', label: '仕入・経費（共通対応）', split: true },
  { id: 'exempt_use', label: '仕入・経費（非課税売上対応）', split: true },
];

const R10 = { rate: 100, national: 780 };
const R8 = { rate: 80, national: 624 };
const R0 = { rate: 0, national: 0 };

/**
 * 仕入側の税区分（用途区分ごと）。use：taxable＝課税売上対応、common＝共通対応、exempt＝非課税売上対応
 * 用途区分は課税売上割合が95%未満などで個別対応方式を使うときだけ意味を持つ（tax-return.js）
 */
function purchaseCategories(use) {
  const sfx = { taxable: '', common: '_c', exempt: '_e' }[use];
  const group = { taxable: 'purchase', common: 'common', exempt: 'exempt_use' }[use];
  const note = { taxable: '', common: '共通対応', exempt: '非課税売上対応' }[use];
  const lab = (base, extra = '') => {
    const parts = [note, extra].filter(Boolean).join('・');
    return parts ? `${base}（${parts}）` : base;
  };
  const sh = { taxable: '仕', common: '共', exempt: '非対' }[use];
  const p = { kind: 'purchase', group, use, plus: 'debit', effect: -1 };
  return [
    { ...p, code: `purchase_10${sfx}`, label: lab('課税仕入10%'), short: `${sh}10`, role: 'taxable', ...R10 },
    { ...p, code: `purchase_8r${sfx}`, label: lab('課税仕入8%', '軽減'), short: `${sh}8軽`, role: 'taxable', ...R8 },
    // インボイス（適格請求書）のない仕入（免税事業者などから）。控除できるのは日付に応じた経過措置の割合だけ（tax-return.js）
    { ...p, code: `purchase_10_ni${sfx}`, label: lab('課税仕入10%', 'インボイスなし'), short: `${sh}10無`, role: 'taxable', transitional: true, ...R10 },
    { ...p, code: `purchase_8r_ni${sfx}`, label: lab('課税仕入8%', '軽減・インボイスなし'), short: `${sh}8無`, role: 'taxable', transitional: true, ...R8 },
    // 仕入の返品・値引き・割戻し（仕入れに係る対価の返還等。No.6363）。貸方でプラス
    { ...p, code: `purchase_return_10${sfx}`, label: lab('仕入の返品・値引き10%'), short: `${sh}返10`, role: 'return', plus: 'credit', effect: 1, ...R10 },
    { ...p, code: `purchase_return_8r${sfx}`, label: lab('仕入の返品・値引き8%', '軽減'), short: `${sh}返8`, role: 'return', plus: 'credit', effect: 1, ...R8 },
    // 輸入の消費税（国税）：輸入許可書の消費税額そのものを入力する。全額が課税仕入れ等の税額（消費税のあらまし）
    { ...p, code: `import_tax${sfx}`, group: use === 'taxable' ? 'import' : group, label: lab('輸入の消費税（国税）'), short: `${sh === '仕' ? '' : sh}輸消`, role: 'import', taxOnly: true, ...R0 },
  ];
}

/**
 * 税区分の定義
 * kind：sales／purchase／none（集計表のどちら側か）
 * plus：符号付きの金額でプラスになる側（売上は貸方、売上の返品・貸倒れは借方、仕入は借方、仕入の返品は貸方）
 * role：計算での役割（tax-return.js）、effect：納める税額を増やす（1）・減らす（-1）・関係しない（0）
 * rate：税率（%×10 の整数。10%→100、8%→80）、national：うち国税（%×100 の整数。7.8%→780、6.24%→624）
 * taxOnly：金額そのものが税額（輸入の消費税・地方消費税）
 * 参考：弥生会計・freee の税区分（課税売上・輸出売上・非課税売上・有価証券譲渡・売上返還・貸倒れ・貸倒回収、
 *       課税対応／共通対応／非課税対応の課税仕入・仕入返還・輸入消費税・地方消費税貨物割）
 */
const S = { kind: 'sales', plus: 'credit', effect: 0 };
export const TAX_CATEGORIES = [
  { code: 'none', group: 'other', label: '対象外（不課税）', short: '', kind: 'none', role: 'none', plus: 'debit', effect: 0, ...R0 },
  { code: 'purchase_exempt', group: 'other', label: '非課税仕入', short: '非仕', kind: 'purchase', role: 'exempt', plus: 'debit', effect: 0, ...R0 },
  { ...S, code: 'sales_10', group: 'sales', label: '課税売上10%', short: '売10', role: 'taxable', effect: 1, ...R10 },
  { ...S, code: 'sales_8r', group: 'sales', label: '課税売上8%（軽減）', short: '売8軽', role: 'taxable', effect: 1, ...R8 },
  { ...S, code: 'sales_export', group: 'sales', label: '輸出売上（免税）', short: '輸出', role: 'export', ...R0 },
  { ...S, code: 'sales_exempt', group: 'sales', label: '非課税売上', short: '非売', role: 'exempt', ...R0 },
  // 有価証券・金銭債権の譲渡：非課税。課税売上割合の分母には譲渡対価の5%だけを入れる（No.6405）
  { ...S, code: 'sales_securities', group: 'sales', label: '有価証券等の譲渡（非課税）', short: '有価', role: 'securities', ...R0 },
  // 売上の返品・値引き・割戻し（売上げに係る対価の返還等。No.6359）。借方でプラス
  { ...S, code: 'sales_return_10', group: 'sales_adj', label: '売上の返品・値引き10%', short: '売返10', role: 'return', plus: 'debit', effect: -1, ...R10 },
  { ...S, code: 'sales_return_8r', group: 'sales_adj', label: '売上の返品・値引き8%（軽減）', short: '売返8', role: 'return', plus: 'debit', effect: -1, ...R8 },
  { ...S, code: 'sales_export_return', group: 'sales_adj', label: '輸出売上の返品・値引き', short: '輸返', role: 'export_return', plus: 'debit', ...R0 },
  { ...S, code: 'sales_exempt_return', group: 'sales_adj', label: '非課税売上の返品・値引き', short: '非返', role: 'exempt_return', plus: 'debit', ...R0 },
  // 貸倒れ（No.6367）：借方でプラス。貸倒れの回収（No.6631）：貸方でプラス
  { ...S, code: 'sales_baddebt_10', group: 'sales_adj', label: '貸倒れ10%', short: '倒10', role: 'baddebt', plus: 'debit', effect: -1, ...R10 },
  { ...S, code: 'sales_baddebt_8r', group: 'sales_adj', label: '貸倒れ8%（軽減）', short: '倒8', role: 'baddebt', plus: 'debit', effect: -1, ...R8 },
  { ...S, code: 'sales_recovered_10', group: 'sales_adj', label: '貸倒れの回収10%', short: '回10', role: 'recovered', effect: 1, ...R10 },
  { ...S, code: 'sales_recovered_8r', group: 'sales_adj', label: '貸倒れの回収8%（軽減）', short: '回8', role: 'recovered', effect: 1, ...R8 },
  ...purchaseCategories('taxable'),
  // 輸入の地方消費税（貨物割）：控除は地方消費税の計算の中で行われるため、国税の計算には使わない（記録と集計だけ）
  { code: 'import_local', group: 'import', label: '輸入の地方消費税（貨物割）', short: '輸地', kind: 'purchase', role: 'import_local', plus: 'debit', effect: -1, taxOnly: true, ...R0 },
  ...purchaseCategories('common'),
  ...purchaseCategories('exempt'),
];

/** 集計表で、件数が0でも出す税区分 */
export const CORE_TAX_CODES = ['sales_10', 'sales_8r', 'purchase_10', 'purchase_8r'];

export const TAX_BY_CODE = Object.fromEntries(TAX_CATEGORIES.map((t) => [t.code, t]));

export function isTaxCategory(code) {
  return Object.hasOwn(TAX_BY_CODE, code);
}

/**
 * 税込金額から割り戻した参考値。端数は1円未満切り捨て（0 方向）。
 * 整数どうしの掛け算・割り算なので、x が 1兆円未満なら途中の値も安全な整数に収まる
 * @param {number} gross 税込金額（整数。マイナス可）
 * @param {{rate:number, national:number}} cat
 */
export function backCalc(gross, cat) {
  if (cat.taxOnly) return { gross, net: 0, tax: gross, national: cat.role === 'import' ? gross : 0, local: cat.role === 'import_local' ? gross : 0 };
  if (!cat.rate) return { gross, net: gross, tax: 0, national: 0, local: 0 };
  const base = 1000 + cat.rate; // 110% → 1100、108% → 1080
  const net = Math.trunc((gross * 1000) / base);
  const tax = gross - net;
  // 国税：gross × 7.8/110 ＝ gross × 780 / 11000
  const national = Math.trunc((gross * cat.national) / (base * 10));
  return { gross, net, tax, national, local: tax - national };
}

/**
 * 明細の税込金額を、税区分の向きに合わせた符号付きにする
 * 売上系：貸方＋・借方−、仕入系：借方＋・貸方−。返品・貸倒れなどは逆（税区分の plus）
 */
export function signedTaxAmount(line) {
  const cat = TAX_BY_CODE[line.taxCategory];
  if (!cat || cat.kind === 'none') return 0;
  return line.side === cat.plus ? line.amount : -line.amount;
}

/**
 * 税区分別の集計
 * @param {Array} journals 仕訳（lines を持つ）
 * @param {{from?:string, to?:string}} range 日付範囲（両端を含む）
 * @returns {{ rows: Array<{code,label,group,kind,effect,count,gross,net,tax,national,local}>,
 *   groups: Array<{ id, label, rows, total: {gross,tax,national} }>, netTax: number }}
 *   netTax：納める消費税等の参考値（税額を増やす区分の合計−減らす区分の合計。経過措置・按分は考えない）
 */
export function summarizeTax(journals, { from = '', to = '9999-12-31' } = {}) {
  const totals = new Map(TAX_CATEGORIES.filter((c) => c.kind !== 'none').map((c) => [c.code, { gross: 0, count: 0 }]));
  for (const j of journals) {
    if (j.date < from || j.date > to) continue;
    for (const line of j.lines) {
      const t = totals.get(line.taxCategory);
      if (!t) continue;
      t.gross += signedTaxAmount(line);
      t.count += 1;
    }
  }
  const rows = [];
  for (const cat of TAX_CATEGORIES) {
    if (cat.kind === 'none') continue;
    const t = totals.get(cat.code);
    rows.push({ code: cat.code, label: cat.label, group: cat.group, kind: cat.kind, effect: cat.effect, count: t.count, ...backCalc(t.gross, cat) });
  }
  const groups = TAX_GROUPS.map((g) => {
    const rs = rows.filter((r) => r.group === g.id);
    const total = rs.reduce((a, r) => ({ gross: a.gross + r.gross, tax: a.tax + r.tax, national: a.national + r.national }), { gross: 0, tax: 0, national: 0 });
    return { id: g.id, label: g.label, rows: rs, total };
  });
  const netTax = rows.reduce((s, r) => s + r.effect * r.tax, 0);
  return { rows, groups, netTax };
}
