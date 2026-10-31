// 消費税及び地方消費税の申告書（第一表・第二表・付表）の欄に、computeTaxReturn の結果を割り当てる（純粋関数）
//
// 欄番号と転記の関係は国税庁の書き方による（2026-10-29 確認）
// - 一般用：「消費税及び地方消費税の申告書（一般用）の書き方」（令和7年10月1日以後終了課税期間）
//   https://www.nta.go.jp/publication/pamph/shohi/kaisei/yoshiki/pdf/202411_01.pdf
// - 簡易課税用：「消費税及び地方消費税の申告書（簡易課税用）の書き方」
//   https://www.nta.go.jp/publication/pamph/shohi/kaisei/yoshiki/pdf/202411_02.pdf
// - 2割特例（付表6）：国税庁 申告書の作成例（設例）https://www.nta.go.jp/taxes/tetsuzuki/shinsei/shinkoku/shohi/pdf/015.pdf
// - 様式の一覧：https://www.nta.go.jp/taxes/tetsuzuki/shinsei/shinkoku/shohi/06.htm
// 付表2-3の欄名は旧様式（付表2-1。https://www.nta.go.jp/taxes/shiraberu/zeimokubetsu/shohi/keigenzeiritsu/pdf/0018008-056_03.pdf）
// の欄名に、インボイス制度の経過措置の欄（⑪⑫）を加えた並びとして照合した。
// 旧税率（3%・4%・6.3%）と特定課税仕入れの欄は対応していないため出さない。
import { taxableRatioParts } from './tax-return.js';

const trunc = (a, b) => (a >= 0 ? Math.floor(a / b) : -Math.floor(-a / b));
const net10 = (gross) => trunc(gross * 100, 110);
const net8 = (gross) => trunc(gross * 100, 108);
const pos = (n) => (n > 0 ? n : 0);

/** 様式の種類（計算の方法ごと） */
export // 売上の税額を積上げ計算したときの「消費税額」の欄の説明
const STACKED_NOTE = '積上げ計算：明細ごとの消費税額等の合計×78/100';

const FORM_KINDS = {
  general: { first: '第一表（一般用）', sheets: ['付表1-3', '付表2-3'] },
  simplified: { first: '第一表（簡易課税用）', sheets: ['付表4-3', '付表5-3'] },
  twenty: { first: '第一表（一般用）', sheets: ['付表6'] },
  thirty: { first: '第一表（一般用）', sheets: ['付表6'] },
};

/** 1つの欄（税率別の表は a：6.24%、b：7.8%、c：合計。値が null の欄は空欄） */
const cell = (no, label, value, extra = {}) => ({ no, label, value, ...extra });
const abc = (no, label, a, b, extra = {}) => ({ no, label, a, b, c: a === null && b === null ? null : (a ?? 0) + (b ?? 0), ...extra });
const total = (no, label, c, extra = {}) => ({ no, label, a: null, b: null, c, ...extra });

/**
 * 申告書の各表
 * @param {ReturnType<import('./tax-return.js').computeTaxReturn>} r
 * @param {{ baseSales?: number|null }} opts baseSales：基準期間の課税売上高（簡易課税用の第一表⑯）
 * @returns {{ method, first: { title, rows }, second: { title, rows }, sheets: Array<{ id, title, rows, rate? }>, notes: string[] }}
 */
export function taxReturnForms(r, { baseSales = null } = {}) {
  const b = r.buckets;
  const method = r.method;
  const salesTaxNote = r.salesCalc === 'stacked' ? STACKED_NOTE : '①×6.24%・7.8%';
  // 付表1-3・4-3・6 の共通部分：課税資産の譲渡等の対価の額（税抜）・課税標準額・消費税額
  const sales1 = { a: net8(b.sales8), b: net10(b.sales10) };
  // 合計の欄（C）は computeTaxReturn の結果を使い、画面の計算と必ず一致させる
  const refund = pos(-r.net); // 控除不足還付税額
  const netTax = pos(r.net); // 差引税額
  const localRefund = pos(-r.local);
  const localTax = pos(r.local);
  const interimRefund = pos(r.interimNational - netTax);
  const localInterimRefund = pos(r.interimLocal - localTax);
  const payNational = pos(netTax - r.interimNational);
  const payLocal = pos(localTax - r.interimLocal);

  let rows13; // 付表1-3（または4-3）
  let extraSheets = [];
  let deductionC;
  let adjustmentC;
  if (method === 'general') {
    const g = r.generalByRate;
    const adj = { a: g.r8.over + r.recoveredByRate.r8, b: g.r10.over + r.recoveredByRate.r10 };
    const ded = { a: g.r8.deduction, b: g.r10.deduction };
    const sub = { a: ded.a + r.returnsByRate.r8 + r.badDebtByRate.r8, b: ded.b + r.returnsByRate.r10 + r.badDebtByRate.r10 };
    deductionC = ded.a + ded.b;
    adjustmentC = adj.a + adj.b;
    rows13 = [
      abc('①', '課税標準額', r.base8, r.base10, { note: '①-1 の千円未満切り捨て' }),
      abc('①-1', '課税資産の譲渡等の対価の額', sales1.a, sales1.b, { sub: true }),
      // ①-2・⑤-2 は課税売上割合95%未満かつ特定課税仕入れがある事業者だけの欄（A欄は斜線）。このアプリは扱わないので空欄
      abc('①-2', '特定課税仕入れに係る支払対価の額', null, null, { sub: true }),
      abc('②', '消費税額', r.salesTax8, r.salesTax10, { note: salesTaxNote }),
      abc('③', '控除過大調整税額', adj.a, adj.b, { note: '付表2-3 ㉗＋㉘' }),
      abc('④', '控除対象仕入税額', ded.a, ded.b, { note: '付表2-3 ㉖' }),
      abc('⑤', '返還等対価に係る税額', r.returnsByRate.r8, r.returnsByRate.r10),
      abc('⑤-1', '売上げの返還等対価に係る税額', r.returnsByRate.r8, r.returnsByRate.r10, { sub: true }),
      abc('⑤-2', '特定課税仕入れの返還等対価に係る税額', null, null, { sub: true }),
      abc('⑥', '貸倒れに係る税額', r.badDebtByRate.r8, r.badDebtByRate.r10),
      abc('⑦', '控除税額小計', sub.a, sub.b, { note: '④＋⑤＋⑥' }),
      total('⑧', '控除不足還付税額', refund, { note: '⑦−②−③' }),
      total('⑨', '差引税額', netTax, { note: '②＋③−⑦、百円未満切り捨て', strong: true }),
      total('⑩', '地方消費税の課税標準となる消費税額（控除不足還付税額）', refund),
      total('⑪', '地方消費税の課税標準となる消費税額（差引税額）', netTax),
      total('⑫', '譲渡割額（還付額）', localRefund, { note: '⑩×22/78' }),
      total('⑬', '譲渡割額（納税額）', localTax, { note: '⑪×22/78、百円未満切り捨て', strong: true }),
    ];
    extraSheets = [{ id: '付表2-3', title: '付表2-3 課税売上割合・控除対象仕入税額等の計算表', rows: sheet23(r) }];
  } else if (method === 'simplified') {
    const rate = r.businessType.rate;
    const ded = { a: trunc(r.basisByRate.r8 * rate, 100), b: trunc(r.basisByRate.r10 * rate, 100) };
    const sub = { a: ded.a + r.returnsByRate.r8 + r.badDebtByRate.r8, b: ded.b + r.returnsByRate.r10 + r.badDebtByRate.r10 };
    deductionC = ded.a + ded.b;
    adjustmentC = r.recoveredTax;
    rows13 = [
      abc('①', '課税標準額', r.base8, r.base10, { note: '①-1 の千円未満切り捨て' }),
      abc('①-1', '課税資産の譲渡等の対価の額', sales1.a, sales1.b, { sub: true }),
      abc('②', '消費税額', r.salesTax8, r.salesTax10, { note: salesTaxNote }),
      abc('③', '貸倒回収に係る消費税額', r.recoveredByRate.r8, r.recoveredByRate.r10),
      abc('④', '控除対象仕入税額', ded.a, ded.b, { note: '付表5-3 ⑤' }),
      abc('⑤', '返還等対価に係る税額', r.returnsByRate.r8, r.returnsByRate.r10),
      abc('⑥', '貸倒れに係る税額', r.badDebtByRate.r8, r.badDebtByRate.r10),
      abc('⑦', '控除税額小計', sub.a, sub.b, { note: '④＋⑤＋⑥' }),
      total('⑧', '控除不足還付税額', refund, { note: '⑦−②−③' }),
      total('⑨', '差引税額', netTax, { note: '②＋③−⑦、百円未満切り捨て', strong: true }),
      total('⑩', '地方消費税の課税標準となる消費税額（控除不足還付税額）', refund),
      total('⑪', '地方消費税の課税標準となる消費税額（差引税額）', netTax),
      total('⑫', '譲渡割額（還付額）', localRefund, { note: '⑩×22/78' }),
      total('⑬', '譲渡割額（納税額）', localTax, { note: '⑪×22/78、百円未満切り捨て', strong: true }),
    ];
    extraSheets = [
      {
        id: '付表5-3',
        title: '付表5-3 控除対象仕入税額等の計算表',
        rows: [
          abc('①', '課税標準額に対する消費税額', r.salesTax8, r.salesTax10, { note: '付表4-3 ②' }),
          abc('②', '貸倒回収に係る消費税額', r.recoveredByRate.r8, r.recoveredByRate.r10, { note: '付表4-3 ③' }),
          abc('③', '売上対価の返還等に係る消費税額', r.returnsByRate.r8, r.returnsByRate.r10, { note: '付表4-3 ⑤' }),
          abc('④', '控除対象仕入税額の計算の基礎となる消費税額', r.basisByRate.r8, r.basisByRate.r10, { note: '①＋②−③' }),
          abc('⑤', `控除対象仕入税額（${r.businessType.label}・みなし仕入率${rate}%）`, ded.a, ded.b, { note: '④×みなし仕入率（事業区分が1種類の場合）', strong: true }),
          // Ⅲ 2種類以上の事業を営む事業者の欄（⑥〜⑲）。このアプリは事業区分を1つで計算するので空欄。2枚目（⑳〜㊲の計算式区分）は出さない
          // 様式：https://www.nta.go.jp/law/tsutatsu/kobetsu/kansetsu/951225/pdf/youshiki_028.pdf（2026-10-31 に様式の画像で確認）
          abc('⑥', '事業区分別の課税売上高（税抜き）の合計額', null, null),
          ...['第一種事業（卸売業）', '第二種事業（小売業等）', '第三種事業（製造業等）', '第四種事業（その他）', '第五種事業（サービス業等）', '第六種事業（不動産業）'].map((k, i) => abc(String.fromCodePoint(0x2466 + i), k, null, null, { sub: true })),
          abc('⑬', '事業区分別の課税売上高に係る消費税額の合計額', null, null),
          ...['第一種事業（卸売業）', '第二種事業（小売業等）', '第三種事業（製造業等）', '第四種事業（その他）', '第五種事業（サービス業等）', '第六種事業（不動産業）'].map((k, i) => abc(String.fromCodePoint(0x246d + i), k, null, null, { sub: true })),
        ],
      },
    ];
  } else {
    // 2割特例・3割特例：付表6
    const pct = method === 'twenty' ? 80 : 70;
    const ded = { a: trunc(r.basisByRate.r8 * pct, 100), b: trunc(r.basisByRate.r10 * pct, 100) };
    deductionC = ded.a + ded.b;
    adjustmentC = r.recoveredTax;
    rows13 = [
      abc('①', '課税資産の譲渡等の対価の額', sales1.a, sales1.b),
      abc('②', '課税標準額', r.base8, r.base10, { note: '①の千円未満切り捨て' }),
      abc('③', '課税標準額に対する消費税額', r.salesTax8, r.salesTax10, { note: r.salesCalc === 'stacked' ? STACKED_NOTE : '②×6.24%・7.8%' }),
      abc('④', '貸倒回収に係る消費税額', r.recoveredByRate.r8, r.recoveredByRate.r10),
      abc('⑤', '売上対価の返還等に係る消費税額', r.returnsByRate.r8, r.returnsByRate.r10),
      abc('⑥', '控除対象仕入税額の計算の基礎となる消費税額', r.basisByRate.r8, r.basisByRate.r10, { note: '③＋④−⑤' }),
      abc('⑦', '特別控除税額', ded.a, ded.b, { note: `⑥×${pct}%`, strong: true }),
      abc('⑧', '貸倒れに係る税額', r.badDebtByRate.r8, r.badDebtByRate.r10),
    ];
  }

  const firstSheet = method === 'general' ? '付表1-3' : method === 'simplified' ? '付表4-3' : '付表6';
  const sheetTitle = {
    '付表1-3': '付表1-3 税率別消費税額計算表 兼 地方消費税の課税標準となる消費税額計算表',
    '付表4-3': '付表4-3 税率別消費税額計算表 兼 地方消費税の課税標準となる消費税額計算表',
    付表6: `付表6 税率別消費税額計算表（${method === 'twenty' ? '2割特例' : '3割特例'}）`,
  }[firstSheet];
  const sheets = [{ id: firstSheet, title: sheetTitle, rows: rows13 }, ...extraSheets];

  // 第二表（課税標準額等の内訳書）：国税庁の様式（令和4年4月1日以後終了課税期間分、様式ID NTAOSHA010020100）の欄を全部出す
  //   https://www.nta.go.jp/law/tsutatsu/kobetsu/kansetsu/951225/pdf/youshiki_005.pdf（2026-10-31 に様式の画像で確認）
  //   旧税率（3%・4%・6.3%）の欄と、特定課税仕入れ（⑧〜⑩・⑲。一般課税で課税売上割合95%未満の事業者のみ）の欄は、このアプリでは扱わないので空欄
  const blankRow = (no, label, extra = {}) => cell(no, label, null, extra);
  const second = {
    title: '第二表 課税標準額等の内訳書',
    rows: [
      cell('①', '課税標準額', r.base8 + r.base10, { strong: true }),
      blankRow('②', '課税資産の譲渡等の対価の額（3%適用分）'),
      blankRow('③', '課税資産の譲渡等の対価の額（4%適用分）'),
      blankRow('④', '課税資産の譲渡等の対価の額（6.3%適用分）'),
      cell('⑤', '課税資産の譲渡等の対価の額（6.24%適用分）', sales1.a),
      cell('⑥', '課税資産の譲渡等の対価の額（7.8%適用分）', sales1.b),
      cell('⑦', '課税資産の譲渡等の対価の額の合計額', sales1.a + sales1.b, { note: '②〜⑥の合計' }),
      blankRow('⑧', '特定課税仕入れに係る支払対価の額（6.3%適用分）'),
      blankRow('⑨', '特定課税仕入れに係る支払対価の額（7.8%適用分）'),
      blankRow('⑩', '特定課税仕入れに係る支払対価の額の合計額', { note: '⑧・⑨の合計' }),
      cell('⑪', '消費税額', r.salesTax, { strong: true }),
      blankRow('⑫', '消費税額（3%適用分）'),
      blankRow('⑬', '消費税額（4%適用分）'),
      blankRow('⑭', '消費税額（6.3%適用分）'),
      cell('⑮', '消費税額（6.24%適用分）', r.salesTax8),
      cell('⑯', '消費税額（7.8%適用分）', r.salesTax10),
      cell('⑰', '返還等対価に係る税額', r.returnTax),
      cell('⑱', '売上げの返還等対価に係る税額', r.returnTax),
      blankRow('⑲', '特定課税仕入れの返還等対価に係る税額'),
      cell('⑳', '地方消費税の課税標準となる消費税額', r.net, { note: '㉑〜㉓の合計' }),
      blankRow('㉑', '地方消費税の課税標準となる消費税額（4%適用分）'),
      blankRow('㉒', '地方消費税の課税標準となる消費税額（6.3%適用分）'),
      cell('㉓', '地方消費税の課税標準となる消費税額（6.24%及び7.8%適用分）', r.net),
    ],
  };

  // 第一表
  const ratio = taxableRatioParts(b);
  const salesRows =
    method === 'simplified'
      ? [
          cell('⑮', 'この課税期間の課税売上高', r.taxableSales, { note: '税抜。返品などを引き、免税売上を含む' }),
          cell('⑯', '基準期間の課税売上高', baseSales, { note: baseSales === null ? '入力してください（前々年・前々事業年度）' : '' }),
        ]
      : [
          cell('⑮', '課税資産の譲渡等の対価の額', ratio.taxable, { note: method === 'general' ? '付表2-3 ④' : '課税売上割合の計算の分子' }),
          cell('⑯', '資産の譲渡等の対価の額', ratio.all, { note: method === 'general' ? '付表2-3 ⑦' : '課税売上割合の計算の分母' }),
        ];
  const first = {
    title: `${FORM_KINDS[method].first}`,
    // 「課税標準額に対する消費税額の計算の特例の適用」欄は使わない（申告書（一般用）の書き方 令和7年10月以後終了課税期間用）
    // 付記事項・参考事項（第一表の右下の欄）。このアプリは割賦基準・延払基準・工事進行基準・現金主義を扱わないので「無」
    remarks: [
      ['割賦基準の適用', '無'],
      ['延払基準等の適用', '無'],
      ['工事進行基準の適用', '無'],
      ['現金主義会計の適用', '無'],
      ...(method === 'general' ? [['控除税額の計算方法', r.fullDeduction ? '全額控除（課税売上高5億円以下かつ課税売上割合95%以上）' : r.allocation === 'individual' ? '個別対応方式' : '一括比例配分方式']] : []),
      ['基準期間の課税売上高', baseSales === null ? '' : `${Math.floor(baseSales / 1000).toLocaleString('ja-JP')}千円`],
      ['税額控除に係る経過措置の適用（2割特例）', method === 'twenty' ? '有' : '無'],
    ],
    flags: method === 'twenty' ? ['税額控除に係る経過措置の適用（2割特例）：○'] : method === 'thirty' ? ['税額控除に係る経過措置の適用（3割特例）：○'] : [],
    rows: [
      cell('①', '課税標準額', r.base8 + r.base10, { note: '第二表 ①' }),
      cell('②', '消費税額', r.salesTax, { note: '第二表 ⑪' }),
      cell('③', method === 'general' ? '控除過大調整税額' : '貸倒回収に係る消費税額', adjustmentC),
      cell('④', '控除対象仕入税額', deductionC, { note: `${firstSheet}${method === 'general' ? ' ④' : method === 'simplified' ? ' ④' : ' ⑦'}` }),
      cell('⑤', '返還等対価に係る税額', r.returnTax, { note: '第二表 ⑰' }),
      cell('⑥', '貸倒れに係る税額', r.badDebtTax),
      cell('⑦', '控除税額小計', r.deductionTotal, { note: '④＋⑤＋⑥' }),
      cell('⑧', '控除不足還付税額', refund, { note: '⑦−②−③' }),
      cell('⑨', '差引税額', netTax, { note: '②＋③−⑦、百円未満切り捨て', strong: true }),
      cell('⑩', '中間納付税額', r.interimNational),
      cell('⑪', '納付税額', payNational, { note: '⑨−⑩', strong: true }),
      cell('⑫', '中間納付還付税額', interimRefund, { note: '⑩−⑨' }),
      // ⑬⑭・㉔㉕は「この申告書が修正申告である場合」の欄（申告書（一般用）の書き方 令和7年11月 の第一表の記載例で確認）。確定申告では空欄
      blankRow('⑬', '既確定税額', { note: '修正申告のときだけ' }),
      blankRow('⑭', '差引納付税額', { note: '修正申告のときだけ' }),
      ...salesRows,
      cell('⑰', '地方消費税の課税標準となる消費税額（控除不足還付税額）', refund),
      cell('⑱', '地方消費税の課税標準となる消費税額（差引税額）', netTax),
      cell('⑲', '譲渡割額（還付額）', localRefund),
      cell('⑳', '譲渡割額（納税額）', localTax),
      cell('㉑', '中間納付譲渡割額', r.interimLocal),
      cell('㉒', '納付譲渡割額', payLocal, { note: '⑳−㉑', strong: true }),
      cell('㉓', '中間納付還付譲渡割額', localInterimRefund, { note: '㉑−⑳' }),
      blankRow('㉔', '既確定譲渡割額', { note: '修正申告のときだけ' }),
      blankRow('㉕', '差引納付譲渡割額', { note: '修正申告のときだけ' }),
      cell('㉖', '消費税及び地方消費税の合計（納付又は還付）税額', payNational + payLocal - (refund + interimRefund + localRefund + localInterimRefund), { note: '（⑪＋㉒）−（⑧＋⑫＋⑲＋㉓）', strong: true }),
    ],
  };

  const notes = ['第一表の⑬⑭・㉔㉕（既確定税額・差引納付税額など）は修正申告のときだけ使う欄のため空欄です。第二表の旧税率（3%・4%・6.3%）と特定課税仕入れ（⑧〜⑩・⑲）の欄は、このアプリでは扱わないため空欄です。'];
  if (method === 'general') notes.push('付表1-3の①-2・⑤-2と付表2-3の⑬⑭（特定課税仕入れ）、付表2-3の③（非課税資産の輸出等）・⑯（納税義務の免除に係る調整）・㉓〜㉕（調整対象固定資産・居住用賃貸建物の調整）は対応していないため空欄です。輸入の消費税は7.8%の欄に入れています。');
  if (method === 'simplified') notes.push('付表5-3のⅢ（⑥〜⑲、2種類以上の事業を営む場合）は、事業区分を1つで計算しているため空欄です。2枚目（⑳〜㊲）は1種類の事業では使わないため出していません。');
  if (method === 'thirty') notes.push('3割特例の付表6は、2割特例の付表6と同じ並び（特別控除税額＝⑥×70%）で表示しています。');
  return { method, first, second, sheets, notes };
}

/** 付表2-3（一般課税） */
function sheet23(r) {
  const b = r.buckets;
  const g = r.generalByRate;
  const sumUses = (f) => Object.values(b.uses).reduce((s, u) => s + f(u), 0);
  const p8 = sumUses((u) => u.p8 - u.ret8);
  const p10 = sumUses((u) => u.p10 - u.ret10);
  const tax8 = (x) => trunc(x * 624, 10800);
  const tax10 = (x) => trunc(x * 78, 1100);
  // 課税仕入れの税額は computeTaxReturn の値（割戻し計算か積上げ計算）から、返品・値引きの税額を引く
  const t8 = r.purchaseTax8 - sumUses((u) => tax8(u.ret8));
  const t10 = r.purchaseTax10 - sumUses((u) => tax10(u.ret10));
  const trans = (rate, k) => r.transitional.filter((t) => t.rate === rate).reduce((s, t) => s + t[k], 0);
  const taxableNet = { a: net8(b.sales8) - net8(b.salesReturn8), b: net10(b.sales10) - net10(b.salesReturn10) };
  const exportNet = b.export - b.exportReturn;
  const exemptNet = b.exemptSales - b.exemptReturn + trunc(b.securities * 5, 100);
  const four = taxableNet.a + taxableNet.b + exportNet;
  const seven = four + exemptNet;
  const pct = seven > 0 ? `${(Math.floor((four / seven) * 10000) / 100).toFixed(2)}%` : '－';
  const full = r.fullDeduction;
  const ind = !full && r.allocation === 'individual';
  const prop = !full && r.allocation === 'proportional';
  const u8 = r.useTaxByRate.r8;
  const u10 = r.useTaxByRate.r10;
  return [
    abc('①', '課税売上額（税抜き）', taxableNet.a, taxableNet.b),
    total('②', '免税売上額', exportNet),
    total('③', '非課税資産の輸出等の金額、海外支店等へ移送した資産の価額', null),
    total('④', '課税資産の譲渡等の対価の額', four, { note: '①＋②＋③' }),
    total('⑤', '課税資産の譲渡等の対価の額（④の金額）', four),
    total('⑥', '非課税売上額', exemptNet, { note: '有価証券等の譲渡は対価の5%' }),
    total('⑦', '資産の譲渡等の対価の額', seven, { note: '⑤＋⑥' }),
    { no: '⑧', label: '課税売上割合', text: pct, note: '④／⑦（小数点以下2桁未満切り捨てで表示）' },
    abc('⑨', '課税仕入れに係る支払対価の額（税込み）', p8, p10, { note: '返品などを引いた額' }),
    abc('⑩', '課税仕入れに係る消費税額', t8, t10),
    abc('⑪', '適格請求書発行事業者以外の者から行った課税仕入れに係る経過措置の適用を受ける課税仕入れに係る支払対価の額（税込み）', trans(80, 'gross'), trans(100, 'gross')),
    abc('⑫', '適格請求書発行事業者以外の者から行った課税仕入れに係る経過措置により課税仕入れに係る消費税額とみなされる額', trans(80, 'tax'), trans(100, 'tax')),
    abc('⑬', '特定課税仕入れに係る支払対価の額', null, null),
    abc('⑭', '特定課税仕入れに係る消費税額', null, null),
    abc('⑮', '課税貨物に係る消費税額', 0, r.importTax),
    abc('⑯', '納税義務の免除を受けない（受ける）こととなった場合における消費税額の調整（加算又は減算）額', null, null),
    abc('⑰', '課税仕入れ等の税額の合計額', g.r8.total, g.r10.total, { note: '⑩＋⑫＋⑭＋⑮±⑯' }),
    abc('⑱', '課税売上高が5億円以下、かつ、課税売上割合が95%以上の場合', full ? g.r8.total : null, full ? g.r10.total : null, { note: '⑰の金額' }),
    abc('⑲', '⑰のうち、課税売上げにのみ要するもの', full ? null : u8.taxable, full ? null : u10.taxable),
    abc('⑳', '⑰のうち、課税売上げと非課税売上げに共通して要するもの', full ? null : u8.common, full ? null : u10.common),
    abc('㉑', '個別対応方式により控除する課税仕入れ等の税額', ind ? g.r8.allocated.individual : null, ind ? g.r10.allocated.individual : null, { note: '⑲＋（⑳×④／⑦）' }),
    abc('㉒', '一括比例配分方式により控除する課税仕入れ等の税額', prop ? g.r8.allocated.proportional : null, prop ? g.r10.allocated.proportional : null, { note: '⑰×④／⑦' }),
    abc('㉓', '課税売上割合変動時の調整対象固定資産に係る消費税額の調整（加算又は減算）額', null, null),
    abc('㉔', '調整対象固定資産を課税業務用（非課税業務用）に転用した場合の調整（加算又は減算）額', null, null),
    abc('㉕', '居住用賃貸建物を課税賃貸用に供した（譲渡した）場合の加算額', null, null),
    abc('㉖', '差引 控除対象仕入税額', g.r8.deduction, g.r10.deduction, { note: '（⑱、㉑又は㉒）±㉓±㉔＋㉕ がプラスの時', strong: true }),
    abc('㉗', '差引 控除過大調整税額', g.r8.over, g.r10.over, { note: '同 がマイナスの時' }),
    abc('㉘', '貸倒回収に係る消費税額', r.recoveredByRate.r8, r.recoveredByRate.r10),
  ];
}
