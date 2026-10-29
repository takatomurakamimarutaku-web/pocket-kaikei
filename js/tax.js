// 税区分と消費税の集計（純粋関数）
//
// 税込経理方式。割り戻しの参考値の計算は国税庁の説明による：
//   売上税額＝標準税率の対象となる税込売上額×7.8/110＋軽減税率の対象となる税込売上額×6.24/108
//   出典：タックスアンサー No.6383 課税標準額に対する消費税額の計算
//         https://www.nta.go.jp/taxes/shiraberu/taxanswer/shohi/6383.htm
//         タックスアンサー No.6391 課税仕入れに係る消費税額の計算
//         https://www.nta.go.jp/taxes/shiraberu/taxanswer/shohi/6391.htm
// これは申告書の計算ではない（課税標準額の千円未満切捨て・インボイスの経過措置・簡易課税などは第2弾）。

/**
 * 税区分の定義。kind：sales（貸方でプラス）／purchase（借方でプラス）／none
 * rate：税率（%×10 の整数。10%→100、8%→80）、national：うち国税（%×100 の整数。7.8%→780、6.24%→624）
 * 第2弾で経過措置などを足すときは、ここに行を追加する
 */
export const TAX_CATEGORIES = [
  { code: 'none', label: '対象外', short: '', kind: 'none', rate: 0, national: 0 },
  { code: 'sales_10', label: '課税売上10%', short: '売10', kind: 'sales', rate: 100, national: 780 },
  { code: 'sales_8r', label: '課税売上8%（軽減）', short: '売8軽', kind: 'sales', rate: 80, national: 624 },
  { code: 'sales_export', label: '輸出売上（免税）', short: '輸出', kind: 'sales', rate: 0, national: 0 },
  { code: 'sales_exempt', label: '非課税売上', short: '非売', kind: 'sales', rate: 0, national: 0 },
  { code: 'purchase_10', label: '課税仕入10%', short: '仕10', kind: 'purchase', rate: 100, national: 780 },
  { code: 'purchase_8r', label: '課税仕入8%（軽減）', short: '仕8軽', kind: 'purchase', rate: 80, national: 624 },
  { code: 'purchase_exempt', label: '非課税仕入', short: '非仕', kind: 'purchase', rate: 0, national: 0 },
];

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
 * 売上系：貸方＋・借方−、仕入系：借方＋・貸方−
 */
export function signedTaxAmount(line) {
  const cat = TAX_BY_CODE[line.taxCategory];
  if (!cat || cat.kind === 'none') return 0;
  const plusSide = cat.kind === 'sales' ? 'credit' : 'debit';
  return line.side === plusSide ? line.amount : -line.amount;
}

/**
 * 税区分別の集計
 * @param {Array} journals 仕訳（lines を持つ）
 * @param {{from?:string, to?:string}} range 日付範囲（両端を含む）
 * @returns {{ rows: Array<{code,label,kind,count,gross,net,tax,national,local}>, sales, purchase }}
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
    rows.push({ code: cat.code, label: cat.label, kind: cat.kind, count: t.count, ...backCalc(t.gross, cat) });
  }
  const sum = (kind) =>
    rows
      .filter((r) => r.kind === kind)
      .reduce((a, r) => ({ gross: a.gross + r.gross, tax: a.tax + r.tax, national: a.national + r.national }), { gross: 0, tax: 0, national: 0 });
  return { rows, sales: sum('sales'), purchase: sum('purchase') };
}
