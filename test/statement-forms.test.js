// 帳票の様式：決算書の表示の行（fs-rows.js）・残高試算表の行（trial-rows.js）・決算書を1冊にする印刷
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { corporateProfit, incomeStatementRows, balanceSheetRows, singleAmount } from '../js/fs-rows.js';
import { trialRows } from '../js/trial-rows.js';
import { buildStatements, manufacturingReport, closingRows } from '../js/statements.js';
import { trialBalance } from '../js/ledger.js';
import { trialBalanceDoc, financialStatementsDoc, FINANCIAL_PARTS } from '../js/print-forms.js';
import { layoutDocument } from '../js/print-layout.js';
import { sgaBreakdown, condensedIncomeItems, equityStatement, companyNotes } from '../js/financial.js';
import { makeBook } from './helpers.js';

const find = (rows, label) => rows.find((r) => r.label === label);

// 商品販売の法人：期首商品 50,000＋仕入 200,000−期末商品 30,000＝売上原価 220,000
function tradingBook() {
  const b = makeBook('corporation');
  b.opening([['現金', 1_000_000], ['商品', 50_000], ['資本金', 500_000], ['資本準備金', 200_000], ['利益準備金', 100_000], ['繰越利益剰余金', 250_000]]);
  const journals = [
    b.j('2026-02-01', [['現金', 400_000]], [['売上高', 400_000]]),
    b.j('2026-02-02', [['仕入高', 200_000]], [['現金', 200_000]]),
    b.j('2026-02-03', [['消耗品費', 10_000]], [['現金', 10_000]]),
    b.j('2026-02-04', [['旅費交通費', 5_000]], [['現金', 5_000]]),
    b.j('2026-12-31', [['期首商品棚卸高', 50_000]], [['商品', 50_000]]),
    b.j('2026-12-31', [['商品', 30_000]], [['期末商品棚卸高', 30_000]]),
    b.j('2026-12-31', [['法人税、住民税及び事業税', 20_000]], [['未払法人税等', 20_000]]),
  ];
  return { b, journals, ...buildStatements({ entityType: 'corporation', accounts: b.accounts, period: b.period, journals }) };
}

test('法人の段階利益の名前（会社計算規則）：利益は「…金額」、零未満は「…損失金額」で正の数', () => {
  assert.deepEqual(corporateProfit('売上総利益', 1000), { label: '売上総利益金額', amount: 1000 });
  assert.deepEqual(corporateProfit('営業利益', -500), { label: '営業損失金額', amount: 500 });
  assert.deepEqual(corporateProfit('当期純利益', 0), { label: '当期純利益金額', amount: 0 });
  assert.deepEqual(corporateProfit('差引金額', -1), { label: '差引金額', amount: -1 }, '法人の段階利益でなければそのまま');
});

test('損益計算書の行：科目は左の列、区分の合計は最後の科目の行の右の列。売上原価は「合計」を入れて期末棚卸高を正の数で差し引く', () => {
  const { pl } = tradingBook();
  const rows = incomeStatementRows(pl.items, { entityType: 'corporation' });
  // 売上高の科目は1つなので右の列だけ
  const sales = rows.find((r) => r.kind === 'line' && r.label === '売上高');
  assert.deepEqual([sales.inner, sales.outer], [null, 400_000]);
  const at = rows.findIndex((r) => r.label === '売上原価');
  assert.deepEqual(
    rows.slice(at, at + 5).map((r) => [r.kind, r.label, r.inner, r.outer]),
    [
      ['heading', '売上原価', null, null],
      ['line', '期首商品棚卸高', 50_000, null],
      ['line', '仕入高', 200_000, null],
      ['calc', '合計', 250_000, null],
      ['line', '期末商品棚卸高', 30_000, 220_000],
    ],
  );
  assert.deepEqual(find(rows, '売上総利益金額'), { kind: 'profit', label: '売上総利益金額', level: 1, inner: null, outer: 180_000, rule: 'over' });
  // 販売費及び一般管理費：2科目。合計は最後の科目の行の右の列
  const sga = rows.filter((r) => r.kind === 'line' && ['消耗品費', '旅費交通費'].includes(r.label));
  assert.equal(sga.length, 2);
  assert.equal(sga[0].outer, null);
  assert.equal(sga.at(-1).outer, 15_000);
  // 法人税等は見出しを付けずに「法人税、住民税及び事業税」の行だけ
  assert.equal(find(rows, '法人税等'), undefined);
  assert.equal(find(rows, '法人税、住民税及び事業税').outer, 20_000);
  const last = rows.at(-1);
  assert.deepEqual([last.kind, last.label, last.outer, last.rule], ['net', '当期純利益金額', pl.netIncome, 'double']);
  assert.equal(pl.netIncome, 400_000 - 220_000 - 15_000 - 20_000);
});

test('損益計算書の行：損失のときは「営業損失金額」「当期純損失金額」と書き、金額は正の数', () => {
  const b = makeBook('corporation');
  const journals = [b.j('2026-02-01', [['消耗品費', 8_000]], [['現金', 8_000]])];
  const { pl } = buildStatements({ entityType: 'corporation', accounts: b.accounts, period: b.period, journals });
  const rows = incomeStatementRows(pl.items, { entityType: 'corporation' });
  assert.equal(find(rows, '営業損失金額').outer, 8_000);
  assert.equal(rows.at(-1).label, '当期純損失金額');
  assert.equal(rows.at(-1).outer, 8_000);
  assert.equal(find(rows, '売上総利益金額').outer, 0, '0円は利益の名前のまま');
});

test('貸借対照表の行（法人）：純資産の部は株主資本 › 資本金・資本剰余金・利益剰余金（その他利益剰余金）、資産合計＝負債・純資産合計', () => {
  const { bs, pl } = tradingBook();
  const b = balanceSheetRows(bs, { entityType: 'corporation' });
  assert.equal(b.assets[0].label, '資産の部');
  assert.equal(b.liabilities[0].label, '負債の部');
  const right = b.liabilities.map((r) => [r.kind, r.label, singleAmount(r)]);
  const at = right.findIndex(([, l]) => l === '純資産の部');
  assert.deepEqual(right.slice(at), [
    ['part', '純資産の部', null],
    ['heading', '株主資本', 1_050_000 + pl.netIncome],
    ['line', '資本金', 500_000],
    ['heading2', '資本剰余金', 200_000],
    ['line', '資本準備金', 200_000],
    ['heading2', '利益剰余金', 350_000 + pl.netIncome],
    ['line', '利益準備金', 100_000],
    ['heading3', 'その他利益剰余金', 250_000 + pl.netIncome],
    ['line', '繰越利益剰余金', 250_000 + pl.netIncome],
    ['note', 'うち当期純利益', pl.netIncome],
    ['total', '純資産合計', 1_050_000 + pl.netIncome],
  ]);
  assert.equal(b.assetTotal.label, '資産合計');
  assert.equal(b.liabilityTotal.label, '負債・純資産合計');
  assert.equal(b.assetTotal.amount, b.liabilityTotal.amount, '資産合計＝負債・純資産合計');
  assert.equal(b.assetTotal.amount, bs.totalAssets);
  // 区分の合計は見出しの行の右の列、科目は左の列
  const current = find(b.assets, '流動資産');
  assert.equal(current.outer, 1_000_000 + 400_000 - 215_000 + 30_000);
  assert.equal(find(b.assets, '現金').inner, 1_185_000);
});

test('貸借対照表の行（個人）：負債・資本の部、事業主貸は見出しを付けない。資産合計＝負債・資本合計', () => {
  const b = makeBook('individual');
  b.opening([['現金', 300_000], ['元入金', 300_000]]);
  const journals = [b.j('2026-02-01', [['現金', 120_000]], [['売上高', 120_000]]), b.j('2026-02-02', [['事業主貸', 20_000]], [['現金', 20_000]])];
  const { bs } = buildStatements({ entityType: 'individual', accounts: b.accounts, period: b.period, journals });
  const r = balanceSheetRows(bs, { entityType: 'individual' });
  assert.equal(r.liabilities[0].label, '負債・資本の部');
  assert.equal(find(r.assets, '事業主貸').kind, 'line');
  assert.ok(!r.assets.some((x) => x.kind === 'heading' && x.label === '事業主貸'));
  assert.equal(find(r.liabilities, '青色申告特別控除前の所得金額').outer, 120_000);
  assert.equal(r.assetTotal.amount, r.liabilityTotal.amount);
});

test('製造原価報告書の行：期首仕掛品が無ければ「合計」を省き、あれば入れる。期末仕掛品棚卸高は正の数で差し引く', () => {
  const run = (withOpening) => {
    const b = makeBook('corporation', { manufacturing: true });
    const journals = [
      b.j('2026-02-01', [['材料仕入高', 100_000]], [['現金', 100_000]]),
      b.j('2026-02-02', [['賃金', 60_000]], [['現金', 60_000]]),
      b.j('2026-12-31', [['仕掛品', 10_000]], [['期末仕掛品棚卸高', 10_000]]),
      ...(withOpening ? [b.j('2026-12-31', [['期首仕掛品棚卸高', 5_000]], [['仕掛品', 5_000]])] : []),
    ];
    const mfg = manufacturingReport(closingRows({ accounts: b.accounts, period: b.period, journals }));
    return { mfg, rows: incomeStatementRows(mfg.items, { entityType: 'corporation' }) };
  };
  const a = run(false);
  assert.equal(find(a.rows, '合計'), undefined, '当期総製造費用と同じ額になる「合計」は省く');
  assert.equal(find(a.rows, '当期総製造費用').outer, 160_000);
  assert.equal(find(a.rows, '期末仕掛品棚卸高').outer, 10_000);
  assert.equal(a.rows.at(-1).label, '当期製品製造原価');
  assert.equal(a.rows.at(-1).outer, 150_000);
  const b = run(true);
  assert.equal(find(b.rows, '期首仕掛品棚卸高').outer, 5_000);
  assert.equal(find(b.rows, '合計').outer, 165_000);
  assert.equal(b.rows.at(-1).outer, b.mfg.cost);
});

test('残高試算表の行：損益計算書の科目は決算書の順に並べ、段階利益（損益）を入れる。当期純損益金額は損益計算書と同じ', () => {
  const { b, journals, pl } = tradingBook();
  const tb = trialBalance({ accounts: b.accounts, period: b.period, journals });
  const t = trialRows(tb, { entityType: 'corporation' });
  const profits = t.pl.rows.filter((r) => r.kind === 'profit').map((r) => [r.label, r.amount]);
  assert.deepEqual(profits, [
    ['売上総損益金額', 180_000],
    ['営業損益金額', 165_000],
    ['経常損益金額', 165_000],
    ['税引前当期純損益金額', 165_000],
    ['当期純損益金額', pl.netIncome],
  ]);
  assert.equal(t.pl.rows.at(-1).strong, true);
  // 売上原価の合計は評価勘定（期末商品棚卸高）を差し引く
  const cogs = t.pl.rows.find((r) => r.kind === 'subtotal' && r.label === '売上原価合計');
  assert.equal(cogs.sum.closing, 220_000);
  assert.equal(t.pl.base, 400_000, '構成比の分母は売上高');
  // 部に区分が1つだけ（純資産）なら、区分の合計は部の合計と同じなので省く
  assert.equal(t.bs.rows.filter((r) => r.kind === 'subtotal' && r.label === '純資産合計').length, 0);
  assert.deepEqual(t.bs.rows.filter((r) => r.kind === 'total').map((r) => r.label), ['資産合計', '負債合計', '純資産合計']);
  assert.equal(t.bs.base, find(t.bs.rows, '資産合計').sum.closing);
  assert.equal(t.grand.debitTotal, t.grand.creditTotal, '全科目の借方合計＝貸方合計');
  assert.equal(t.grand.debitBalance, t.grand.creditBalance, '全科目の借方残高＝貸方残高');
  assert.equal(t.mfg.rows.length, 0, '製造原価の科目が無ければ製造原価の表は出さない');
});

test('残高試算表の行（製造業）：売上原価に当期製品製造原価の行、製造原価の表は当期製品製造原価で終わる', () => {
  const b = makeBook('corporation', { manufacturing: true });
  const journals = [
    b.j('2026-02-01', [['材料仕入高', 100_000]], [['現金', 100_000]]),
    b.j('2026-02-02', [['賃金', 60_000]], [['現金', 60_000]]),
    b.j('2026-02-03', [['現金', 300_000]], [['売上高', 300_000]]),
  ];
  const tb = trialBalance({ accounts: b.accounts, period: b.period, journals });
  const t = trialRows(tb, { entityType: 'corporation' });
  const calc = t.pl.rows.find((r) => r.kind === 'calc');
  assert.deepEqual([calc.label, calc.amount], ['当期製品製造原価', 160_000]);
  assert.equal(find(t.pl.rows, '売上総損益金額').amount, 140_000);
  assert.deepEqual(t.mfg.rows.at(-1), { kind: 'profit', label: '当期製品製造原価', amount: 160_000, side: 'debit', strong: true });
  assert.equal(find(t.mfg.rows, '当期総製造費用').amount, 160_000);
  assert.equal(t.mfg.base, 160_000);
  // 製造原価の科目は損益計算書の表に重ねて出さない
  assert.ok(!t.pl.rows.some((r) => r.kind === 'account' && r.label === '材料仕入高'));
  // 印刷：合計残高試算表は 貸借対照表・損益計算書・製造原価・全科目の合計 の順。全科目の合計は貸借が一致する
  const doc = trialBalanceDoc(tb, { head: {}, entityType: 'corporation', carriedLabel: '前期繰越' });
  assert.deepEqual(doc.blocks.filter((x) => x.type === 'heading').map((x) => x.text), ['貸借対照表', '損益計算書', '製造原価', '全科目の合計']);
  const total = doc.blocks.at(-1).rows[0].cells;
  assert.equal(total[1], total[3]);
  // 当期製品製造原価（売上原価の中の行）は借方合計・借方残高の欄、段階利益は貸方残高の欄
  const pl = doc.blocks[3].rows;
  const cell = (row, i) => (typeof row.cells[i] === 'object' ? row.cells[i].text : row.cells[i]);
  const mfgLine = pl.find((r) => cell(r, 2) === '当期製品製造原価');
  assert.deepEqual([cell(mfgLine, 0), cell(mfgLine, 1), cell(mfgLine, 3), cell(mfgLine, 4)], ['160,000', '160,000', '', '']);
  const gross = pl.find((r) => cell(r, 2) === '売上総損益金額');
  assert.deepEqual([cell(gross, 0), cell(gross, 4)], ['', '140,000']);
});

test('合計残高試算表：損失の段階利益は借方残高の欄に正の数で書く', () => {
  const b = makeBook('corporation');
  const journals = [b.j('2026-02-01', [['消耗品費', 8_000]], [['現金', 8_000]])];
  const tb = trialBalance({ accounts: b.accounts, period: b.period, journals });
  const doc = trialBalanceDoc(tb, { head: {}, entityType: 'corporation', carriedLabel: '前期繰越' });
  const net = doc.blocks[3].rows.find((r) => r.cells[2]?.text === '当期純損益金額');
  assert.deepEqual([net.cells[0], net.cells[4]], ['8,000', '']);
  assert.equal(net.kind, 'total');
  const bal = trialBalanceDoc(tb, { head: {}, entityType: 'corporation', carriedLabel: '前期繰越', format: 'balance' });
  const netBal = bal.blocks[3].rows.find((r) => r.cells[0] === '当期純損益金額');
  assert.equal(netBal.cells[4], '△8,000', '残高試算表は残高の欄に△で書く');
});

test('残高試算表の行（個人）：差引金額と青色申告特別控除前の所得金額（白色申告は専従者控除前）', () => {
  const b = makeBook('individual');
  const journals = [b.j('2026-02-01', [['現金', 120_000]], [['売上高', 120_000]]), b.j('2026-02-02', [['消耗品費', 20_000]], [['現金', 20_000]])];
  const tb = trialBalance({ accounts: b.accounts, period: b.period, journals });
  const blue = trialRows(tb, { entityType: 'individual' });
  assert.deepEqual(blue.pl.rows.filter((r) => r.kind === 'profit').map((r) => [r.label, r.amount]), [['差引金額', 120_000], ['差引金額', 100_000], ['青色申告特別控除前の所得金額', 100_000]]);
  assert.equal(trialRows(tb, { entityType: 'individual', white: true }).pl.rows.at(-1).label, '専従者控除前の所得金額');
  assert.equal(find(blue.bs.rows, '資本合計')?.kind ?? 'total', 'total');
});

test('決算書を1冊にする印刷：帳票ごとに改ページし、各ページに表題と期間。個別注記表のページは単位を書かない', () => {
  const { b, journals, pl, bs } = tradingBook();
  const data = {
    bs,
    plItems: condensedIncomeItems(pl),
    sga: sgaBreakdown(pl),
    mfgItems: null,
    equity: equityStatement({ accounts: b.accounts, period: b.period, journals, netIncome: pl.netIncome }),
    notes: companyNotes({ accounts: b.accounts, period: b.period, journals }),
  };
  const doc = financialStatementsDoc(data, { head: { company: '株式会社テスト' }, at: '令和8年12月31日 現在', range: '自 令和8年1月1日　至 令和8年12月31日' });
  assert.equal(doc.formal, true);
  const captions = doc.blocks.filter((x) => x.type === 'heading' && x.caption);
  assert.deepEqual(
    captions.map((x) => x.text),
    FINANCIAL_PARTS.map(([, t]) => t).filter((t) => t !== '製造原価報告書'),
    '製造原価の科目が無ければ製造原価報告書は出さない',
  );
  assert.equal(captions[0].title, '貸 借 対 照 表');
  assert.equal(captions[0].period, '令和8年12月31日 現在');
  assert.equal(captions[1].period, '自 令和8年1月1日　至 令和8年12月31日');
  const pages = layoutDocument(doc);
  assert.equal(pages.length, captions.length, '帳票ごとに1ページ');
  assert.deepEqual(pages.map((p) => p.title), captions.map((x) => x.title));
  const texts = (p) => p.items.filter((i) => i.t === 'text').map((i) => i.text);
  assert.ok(texts(pages[0]).includes('（単位：円）'));
  assert.ok(!texts(pages.at(-1)).includes('（単位：円）'), '個別注記表は単位を書かない');
  assert.ok(texts(pages[1]).includes('- 2 -'), '2ページ以上ならページ番号');
  // 販売費及び一般管理費内訳書：最後に合計
  const sga = doc.blocks[doc.blocks.findIndex((x) => x.text === '販売費及び一般管理費内訳書') + 1];
  assert.equal(sga.rows.at(-1).cells[1].text, '15,000');
  // 印刷する帳票を選べる
  const only = financialStatementsDoc(data, { head: {}, at: '', range: '', parts: ['pl'] });
  assert.deepEqual(only.blocks.filter((x) => x.caption).map((x) => x.text), ['損益計算書']);
});
