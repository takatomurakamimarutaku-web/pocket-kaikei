// 決算書の勘定式・個別注記表のパターン・帳票の期間（年・月・日）・摘要と科目の検索
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { IDBFactory } from 'fake-indexeddb';
import { buildStatements, manufacturingReport, closingRows, rangeRows, incomeStatement } from '../js/statements.js';
import { incomeStatementAccountRows } from '../js/fs-rows.js';
import { incomeStatementAccountDoc, incomeStatementFormatDoc, balanceSheetAccountBlock, financialStatementsDoc, companyNotesBlocks } from '../js/print-forms.js';
import { layoutDocument } from '../js/print-layout.js';
import { condensedIncomeItems, sgaBreakdown, equityStatement, companyNotes, notesLead, perShareText, validateNotes, DEFAULT_NOTES, NOTE_SECTIONS, CARRY_NOTE_KEYS } from '../js/financial.js';
import { rangePresets, parseRange, rangeQuery, isMonthAligned, presetKeyOf, formatRange } from '../js/period.js';
import { carriedLabel } from '../js/ledger.js';
import { searchLines, lineTotals, groupByMemo, searchAccounts, searchTokens } from '../js/search.js';
import { buildSample } from '../js/sample.js';
import { makeBook } from './helpers.js';

const find = (rows, label) => rows.find((r) => r.label === label);

function corpBook() {
  const b = makeBook('corporation', { startDate: '2026-04-01', endDate: '2027-03-31' });
  b.opening([['普通預金', 1_000_000], ['商品', 100_000], ['資本金', 1_100_000]]);
  const journals = [
    b.j('2026-04-05', [['売掛金', 550_000]], [['売上高', 550_000]], '4月分 売上 A社'),
    b.j('2026-04-20', [['仕入高', 220_000]], [['普通預金', 220_000]], '商品仕入 B社'),
    b.j('2026-05-10', [['地代家賃', 110_000]], [['普通預金', 110_000]], '5月分 家賃'),
    b.j('2026-05-25', [['普通預金', 550_000]], [['売掛金', 550_000]], 'A社 入金'),
    b.j('2026-06-10', [['普通預金', 1_000]], [['受取利息', 1_000]], '利息'),
    b.j('2026-06-30', [['通信費', 5_500]], [['普通預金', 5_500]], '電話代 6月分'),
    b.j('2027-03-31', [['商品', 80_000]], [['期末商品棚卸高', 80_000]], '期末棚卸'),
    b.j('2027-03-31', [['期首商品棚卸高', 100_000]], [['商品', 100_000]], '期首棚卸の振替'),
  ];
  return { b, journals };
}

// ---- 決算書の勘定式 ----

test('損益計算書（勘定式）：借方に費用と当期純利益金額、貸方に収益。借方合計＝貸方合計＝収益の合計', () => {
  const { b, journals } = corpBook();
  const { pl } = buildStatements({ entityType: 'corporation', accounts: b.accounts, period: b.period, journals });
  const r = incomeStatementAccountRows(pl.items, { entityType: 'corporation' });
  assert.equal(r.debit[0].kind, 'part');
  assert.equal(r.debit[0].label, '借方');
  assert.equal(r.credit[0].label, '貸方');
  assert.deepEqual(r.debit.filter((x) => x.kind === 'heading').map((x) => x.label), ['売上原価', '販売費及び一般管理費']);
  assert.deepEqual(r.credit.filter((x) => x.kind === 'heading').map((x) => x.label), ['売上高', '営業外収益']);
  // 売上原価：期首商品棚卸高 100,000＋仕入高 220,000＝合計 320,000、期末商品棚卸高 80,000 を差し引いて 240,000（区分の見出しの行）
  assert.equal(find(r.debit, '売上原価').outer, 240_000);
  assert.equal(find(r.debit, '合計').inner, 320_000);
  assert.equal(find(r.debit, '期末商品棚卸高').inner, 80_000);
  // 当期純利益：551,000 − 240,000 − 115,500 ＝ 195,500
  const net = r.debit.at(-1);
  assert.deepEqual([net.kind, net.label, net.outer], ['net', '当期純利益金額', 195_500]);
  assert.equal(r.debitTotal.amount, 551_000);
  assert.equal(r.creditTotal.amount, 551_000);
  // 段階利益は書かない
  assert.equal(find([...r.debit, ...r.credit], '売上総利益金額'), undefined);
});

test('損益計算書（勘定式）：当期純損失は貸方に当期純損失金額（正の数）', () => {
  const b = makeBook('corporation', { startDate: '2026-04-01', endDate: '2027-03-31' });
  const journals = [b.j('2026-04-05', [['現金', 10_000]], [['売上高', 10_000]]), b.j('2026-04-06', [['地代家賃', 50_000]], [['現金', 50_000]])];
  const { pl } = buildStatements({ entityType: 'corporation', accounts: b.accounts, period: b.period, journals });
  const r = incomeStatementAccountRows(pl.items, { entityType: 'corporation' });
  const loss = r.credit.at(-1);
  assert.deepEqual([loss.label, loss.outer], ['当期純損失金額', 40_000]);
  assert.equal(r.debitTotal.amount, 50_000);
  assert.equal(r.creditTotal.amount, 50_000);
});

test('損益計算書（勘定式）：個人は借方に所得金額（赤字なら△のまま借方）', () => {
  const b = makeBook('individual');
  const journals = [b.j('2026-02-01', [['現金', 30_000]], [['売上高', 30_000]]), b.j('2026-02-02', [['地代家賃', 50_000]], [['現金', 50_000]])];
  const { pl } = buildStatements({ entityType: 'individual', accounts: b.accounts, period: b.period, journals });
  const r = incomeStatementAccountRows(pl.items, { entityType: 'individual' });
  const income = r.debit.at(-1);
  assert.equal(income.label, '青色申告特別控除前の所得金額');
  assert.equal(income.outer, -20_000);
  assert.equal(r.debitTotal.amount, 30_000);
  assert.equal(r.creditTotal.amount, 30_000);
});

test('製造原価報告書（勘定式）：借方に材料費・労務費・製造経費・期首仕掛品、貸方に期末仕掛品と当期製品製造原価', () => {
  const b = makeBook('corporation', { manufacturing: true });
  const journals = [
    b.j('2026-01-01', [['期首仕掛品棚卸高', 15_000]], [['仕掛品', 15_000]]),
    b.j('2026-02-01', [['材料仕入高', 100_000]], [['現金', 100_000]]),
    b.j('2026-02-02', [['賃金', 60_000]], [['現金', 60_000]]),
    b.j('2026-12-31', [['仕掛品', 10_000]], [['期末仕掛品棚卸高', 10_000]]),
  ];
  const mfg = manufacturingReport(closingRows({ accounts: b.accounts, period: b.period, journals }));
  const r = incomeStatementAccountRows(mfg.items, { entityType: 'corporation' });
  assert.deepEqual(r.debit.filter((x) => x.kind === 'heading').map((x) => x.label), ['材料費', '労務費']);
  assert.equal(find(r.debit, '期首仕掛品棚卸高').outer, 15_000);
  assert.equal(find(r.credit, '期末仕掛品棚卸高').outer, 10_000);
  assert.equal(find(r.credit, '当期製品製造原価').outer, mfg.cost);
  assert.equal(mfg.cost, 165_000);
  assert.equal(r.debitTotal.amount, 175_000);
  assert.equal(r.creditTotal.amount, 175_000);
});

test('決算書をまとめるときの損益計算書（販売費及び一般管理費を1行）も勘定式で借方・貸方が一致する', () => {
  const d = buildSample('corporation');
  const period = d.periods[0];
  const { pl } = buildStatements({ entityType: 'corporation', accounts: d.accounts, period, journals: d.journals });
  const r = incomeStatementAccountRows(condensedIncomeItems(pl), { entityType: 'corporation' });
  assert.equal(find(r.debit, '販売費及び一般管理費').outer, sgaBreakdown(pl).total);
  assert.equal(r.debitTotal.amount, r.creditTotal.amount);
});

test('印刷（勘定式）：左右2段の表、最後の行に借方・貸方の合計（二重線）。報告式との切り替え', () => {
  const { b, journals } = corpBook();
  const { pl } = buildStatements({ entityType: 'corporation', accounts: b.accounts, period: b.period, journals });
  const head = { company: '株式会社テスト', period: '自 令和8年4月1日　至 令和9年3月31日' };
  const doc = incomeStatementAccountDoc(pl.items, { head, title: '損益計算書', entityType: 'corporation' });
  const table = doc.blocks[0];
  assert.equal(table.split, 2);
  assert.equal(table.columns.length, 4);
  const last = table.rows.at(-1).cells;
  assert.equal(last[0].text, '合　　　計');
  assert.equal(last[1].text, '551,000');
  assert.equal(last[1].rule, 'double');
  assert.equal(last[3].text, '551,000');
  assert.ok(layoutDocument(doc).length >= 1);
  assert.equal(incomeStatementFormatDoc(pl.items, { format: 'report', head, title: '損益計算書', entityType: 'corporation' }).blocks[0].columns.length, 3);
  assert.equal(incomeStatementFormatDoc(pl.items, { format: 'account', head, title: '損益計算書', entityType: 'corporation' }).blocks[0].split, 2);
});

test('決算書を1冊に：損益計算書・製造原価報告書の様式を選べる。貸借対照表の勘定式は今までどおり', () => {
  const d = buildSample('corporation');
  const period = d.periods[0];
  const { pl, bs } = buildStatements({ entityType: 'corporation', accounts: d.accounts, period, journals: d.journals });
  const mfg = manufacturingReport(closingRows({ accounts: d.accounts, period, journals: d.journals }));
  const equity = equityStatement({ accounts: d.accounts, period, journals: d.journals, netIncome: pl.netIncome });
  const data = { bs, plItems: condensedIncomeItems(pl), sga: sgaBreakdown(pl), mfgItems: mfg.items, equity, notes: [], notesLead: 'この計算書類は、「中小企業の会計に関する指針」によって作成しています。' };
  const opts = { head: { company: 'テスト' }, at: '現在', range: '自至', parts: ['bs', 'pl', 'mfg', 'notes'] };
  const tables = (doc) => doc.blocks.filter((x) => x.type === 'table');
  const report = financialStatementsDoc(data, opts);
  assert.deepEqual(tables(report).map((t) => t.split ?? 1), [2, 1, 1]);
  const account = financialStatementsDoc(data, { ...opts, plFormat: 'account', mfgFormat: 'account', bsFormat: 'report' });
  assert.deepEqual(tables(account).map((t) => t.split ?? 1), [1, 2, 2]);
  // 個別注記表の冒頭の文
  assert.equal(account.blocks.at(-1).text, data.notesLead);
  assert.equal(balanceSheetAccountBlock(bs, { entityType: 'corporation' }).rows.at(-1).cells[0].text, '資産合計');
});

// ---- 個別注記表のパターン ----

function notesBook() {
  const b = makeBook('corporation', { startDate: '2026-04-01', endDate: '2027-03-31' });
  b.opening([['普通預金', 1_000_000], ['資本金', 1_000_000]]);
  const journals = [b.j('2026-05-01', [['普通預金', 500_000]], [['売上高', 500_000]])];
  return { accounts: b.accounts, period: b.period, journals };
}

test('個別注記表（非公開会社）：会社計算規則 第98条第2項第1号の項目だけ。該当の無い項目は出さない', () => {
  const ctx = notesBook();
  const s = companyNotes({ ...ctx, notes: { sharesIssued: 100, taxEffect: '入れても非公開会社では出さない', other: 'メモ' } });
  assert.deepEqual(s.map((x) => x.title), ['重要な会計方針に係る事項に関する注記', '株主資本等変動計算書に関する注記', 'その他の注記']);
  // 該当事項はありませんと書く
  const all = companyNotes({ ...ctx, notes: { showNone: true } });
  assert.deepEqual(all.map((x) => x.id), ['policy', 'policyChanges', 'presentationChanges', 'errorCorrections', 'equity', 'revenueRecognition', 'other']);
  assert.deepEqual(all.find((x) => x.id === 'policyChanges').items, []);
});

test('個別注記表（公開会社）：貸借対照表等・損益計算書・税効果会計・関連当事者・一株当たり情報・後発事象なども表示する', () => {
  const ctx = notesBook();
  const all = companyNotes({ ...ctx, notes: { companyType: 'public', showNone: true } });
  assert.deepEqual(
    all.map((x) => x.id),
    NOTE_SECTIONS.map((x) => x.id),
  );
  assert.equal(all.length, 16);
  // 一株当たり情報：発行済株式 1,000株・自己株式 100株 → 900株で割る
  const s = companyNotes({ ...ctx, notes: { companyType: 'public', sharesIssued: 1000, treasuryShares: 100, relatedParty: '役員からの借入 1,000,000円' }, netAssets: 1_500_000, netIncome: 500_000 });
  const per = s.find((x) => x.id === 'perShare').items[0].text;
  assert.equal(per, '1株当たり純資産額　1,666.67円\n1株当たり当期純利益　555.56円');
  assert.equal(s.find((x) => x.id === 'relatedParty').items[0].text, '役員からの借入 1,000,000円');
  // 文を入れたときはその文
  const custom = companyNotes({ ...ctx, notes: { companyType: 'public', sharesIssued: 1000, perShare: '期中平均株式数で計算' }, netAssets: 1, netIncome: 1 });
  assert.equal(custom.find((x) => x.id === 'perShare').items[0].text, '期中平均株式数で計算');
});

test('個別注記表：会計のルールの冒頭の文・1株当たりの金額の端数・検証・前期から引き継ぐ項目', () => {
  assert.equal(notesLead({ standard: 'none' }), '');
  assert.equal(notesLead({ standard: 'youryou' }), 'この計算書類は、「中小企業の会計に関する基本要領」によって作成しています。');
  assert.equal(notesLead({ standard: 'shishin' }), 'この計算書類は、「中小企業の会計に関する指針」によって作成しています。');
  assert.equal(perShareText(1000, 3), '333.33円');
  assert.equal(perShareText(2000, 3), '666.67円');
  assert.equal(perShareText(-1000, 3), '△333.33円');
  assert.equal(perShareText(12_345_678_900, 1000), '12,345,678.90円');
  assert.deepEqual(validateNotes({ ...DEFAULT_NOTES }), []);
  assert.match(validateNotes({ ...DEFAULT_NOTES, companyType: 'big' }).join(), /会社の区分/);
  assert.match(validateNotes({ ...DEFAULT_NOTES, standard: 'ifrs' }).join(), /会計のルール/);
  assert.match(validateNotes({ ...DEFAULT_NOTES, showNone: 'yes' }).join(), /該当の無い項目/);
  assert.match(validateNotes({ ...DEFAULT_NOTES, relatedParty: 'あ'.repeat(2001) }).join(), /2000文字/);
  for (const k of ['companyType', 'standard', 'inventoryMethod', 'sharesIssued']) assert.ok(CARRY_NOTE_KEYS.includes(k));
  for (const k of ['dividends', 'policyChanges', 'subsequentEvents']) assert.equal(CARRY_NOTE_KEYS.includes(k), false);
  // 印刷：冒頭の文 → 項目の見出し
  const blocks = companyNotesBlocks([{ title: '重要な会計方針に係る事項に関する注記', items: [] }], { lead: 'この計算書類は…' });
  assert.deepEqual(blocks.slice(0, 2).map((x) => x.text), ['この計算書類は…', '1．重要な会計方針に係る事項に関する注記']);
});

test('Repository：注記のパターンを保存し、古い保存内容は初期値で補う。不正なパターンは保存しない', async () => {
  const { openDB, ValidationError } = await import('../js/db.js');
  const { createPeriod, createSettings, createAccount } = await import('../js/models.js');
  const { templateAccounts } = await import('../js/accounts.js');
  const repo = await openDB({ indexedDB: new IDBFactory() });
  const p = createPeriod({ startDate: '2026-04-01', endDate: '2027-03-31' });
  await repo.setup({ settings: createSettings({ businessName: 'テスト株式会社', entityType: 'corporation' }), period: p, accounts: templateAccounts('corporation').map((a) => createAccount(a)) });
  const saved = await repo.saveStatementNotes(p.id, { companyType: 'public', standard: 'shishin', showNone: true, relatedParty: '役員からの借入' });
  assert.equal(saved.statementNotes.companyType, 'public');
  assert.equal(saved.statementNotes.standard, 'shishin');
  assert.equal(saved.statementNotes.relatedParty, '役員からの借入');
  // 前の版で保存した注記（パターンの項目が無い）は、非公開会社・冒頭の文なしとして扱う
  const old = companyNotes({ ...notesBook(), notes: { inventoryMethod: '総平均法', other: '' } });
  assert.equal(old[0].id, 'policy');
  await assert.rejects(repo.saveStatementNotes(p.id, { companyType: 'listed' }), ValidationError);
});

// ---- 帳票の期間（年・月・日） ----

test('期間の候補：期間全体・各月・四半期・半期（会計期間の最初の月から数える）', () => {
  const p = { startDate: '2026-04-01', endDate: '2027-03-31' };
  const presets = rangePresets(p);
  assert.equal(presets[0].key, 'all');
  assert.equal(presets.filter((x) => x.group === '月').length, 12);
  assert.deepEqual(
    presets.filter((x) => x.group === '四半期').map((x) => [x.label, x.from, x.to]),
    [
      ['第1四半期（4月〜6月）', '2026-04-01', '2026-06-30'],
      ['第2四半期（7月〜9月）', '2026-07-01', '2026-09-30'],
      ['第3四半期（10月〜12月）', '2026-10-01', '2026-12-31'],
      ['第4四半期（1月〜3月）', '2027-01-01', '2027-03-31'],
    ],
  );
  assert.deepEqual(presets.filter((x) => x.group === '半期').map((x) => x.label), ['上半期（4月〜9月）', '下半期（10月〜3月）']);
  // 月の途中から始まる期間：最初の月は期間の初日から
  const short = rangePresets({ startDate: '2026-06-15', endDate: '2026-09-30' });
  assert.deepEqual([short[1].from, short[1].to], ['2026-06-15', '2026-06-30']);
  assert.deepEqual(short.filter((x) => x.group === '四半期').map((x) => [x.from, x.to]), [['2026-06-15', '2026-08-31'], ['2026-09-01', '2026-09-30']]);
  assert.equal(short.filter((x) => x.group === '半期').length, 0, '6か月以下なら半期は出さない');
});

test('期間の読み取り：月・日のどちらも。期間の外は寄せ、前後が逆なら入れ替える。URL には月の区切りなら月で書く', () => {
  const p = { startDate: '2026-04-01', endDate: '2027-03-31' };
  assert.deepEqual(parseRange(p, '2026-05', '2026-06'), { from: '2026-05-01', to: '2026-06-30' });
  assert.deepEqual(parseRange(p, '2026-06', '2026-05'), { from: '2026-05-01', to: '2026-06-30' });
  assert.deepEqual(parseRange(p, '2026-05-10', '2026-05-20'), { from: '2026-05-10', to: '2026-05-20' });
  assert.deepEqual(parseRange(p, '2026-05-20', '2026-05-10'), { from: '2026-05-10', to: '2026-05-20' });
  assert.deepEqual(parseRange(p, '2020-01-01', '2030-12-31'), { from: '2026-04-01', to: '2027-03-31' });
  assert.deepEqual(parseRange(p, undefined, 'abc'), { from: '2026-04-01', to: '2027-03-31' });
  assert.deepEqual(parseRange(p, '2026-02-30', '2026-05'), { from: '2026-04-01', to: '2026-05-31' }, '無い日付は期間の初日');
  assert.deepEqual(rangeQuery(p, { from: '2026-04-01', to: '2026-06-30' }), { from: '2026-04', to: '2026-06' });
  assert.deepEqual(rangeQuery(p, { from: '2026-04-02', to: '2026-06-30' }), { from: '2026-04-02', to: '2026-06-30' });
  assert.equal(isMonthAligned({ startDate: '2026-06-15', endDate: '2027-03-31' }, { from: '2026-06-15', to: '2026-07-31' }), true);
  assert.equal(presetKeyOf(p, { from: '2026-07-01', to: '2026-09-30' }), 'q2');
  assert.equal(presetKeyOf(p, { from: '2026-07-02', to: '2026-09-30' }), null);
  assert.equal(formatRange({ from: '2026-04-01', to: '2026-04-30' }), '2026/04/01〜2026/04/30');
  assert.equal(formatRange({ from: '2026-04-01', to: '2026-04-01' }), '2026/04/01');
  assert.equal(carriedLabel(p, '2026-04-01'), '前期繰越');
  assert.equal(carriedLabel(p, '2026-05-01'), '前月繰越');
  assert.equal(carriedLabel(p, '2026-05-10'), '前日繰越');
});

test('期間の途中の損益計算書：損益の科目は範囲の中の発生額。貸借対照表は時点の残高で資産合計＝負債・純資産合計', () => {
  const { b, journals } = corpBook();
  const ctx = { accounts: b.accounts, period: b.period, journals };
  // 5月10日〜6月30日：家賃 110,000・利息 1,000・通信費 5,500（4月の売上・仕入は入らない）
  const pl = incomeStatement('corporation', rangeRows({ ...ctx, from: '2026-05-10', to: '2026-06-30' }));
  assert.equal(pl.profits.sales, 0);
  assert.equal(pl.profits.sga, 115_500);
  assert.equal(pl.profits.nonOperatingIncome, 1_000);
  assert.equal(pl.netIncome, -114_500);
  // 期首からなら closingRows と同じ
  assert.deepEqual(incomeStatement('corporation', rangeRows({ ...ctx, from: '2026-04-01', to: '2026-06-30' })).profits, incomeStatement('corporation', closingRows({ ...ctx, to: '2026-06-30' })).profits);
  // 範囲を分けて足すと期間全体と一致する
  const whole = incomeStatement('corporation', rangeRows(ctx)).netIncome;
  const a = incomeStatement('corporation', rangeRows({ ...ctx, to: '2026-09-30' })).netIncome;
  const c = incomeStatement('corporation', rangeRows({ ...ctx, from: '2026-10-01' })).netIncome;
  assert.equal(a + c, whole);
  for (const to of ['2026-04-30', '2026-05-15', '2026-06-30', '2027-03-31']) {
    const { bs } = buildStatements({ entityType: 'corporation', ...ctx, to });
    assert.equal(bs.balanced, true, `${to} で貸借が一致`);
    assert.equal(bs.totalAssets, bs.totalLiabilitiesAndEquity);
  }
});

// ---- 摘要と科目の検索 ----

test('摘要の検索：語をすべて含む明細・金額・科目・日付の範囲。合計と摘要ごとのまとめ', () => {
  const { b, journals } = corpBook();
  const accountById = new Map(b.accounts.map((a) => [a.id, a]));
  const ctx = { accountById, subById: new Map() };
  const byName = (n) => b.accounts.find((a) => a.name === n);
  assert.deepEqual(searchTokens('  Ａ社　入金 '), ['a社', '入金']);
  // 「A社」は売上（2行）と入金（2行）の明細
  const hits = searchLines(journals, { query: 'ａ社' }, ctx);
  assert.equal(hits.length, 4);
  assert.deepEqual(searchLines(journals, { query: 'A社 入金' }, ctx).map((x) => x.journal.date), ['2026-05-25', '2026-05-25']);
  // 金額（カンマ・円は無視）
  assert.equal(searchLines(journals, { query: '110,000円' }, ctx).length, 2);
  // 科目で絞り込む・日付の範囲
  assert.equal(searchLines(journals, { query: 'A社', accountId: byName('売掛金').id }, ctx).length, 2);
  assert.equal(searchLines(journals, { query: '', from: '2026-06-01', to: '2026-06-30' }, ctx).length, 4);
  const t = lineTotals(hits);
  assert.deepEqual(t, { count: 4, debit: 1_100_000, credit: 1_100_000 });
  const groups = groupByMemo(searchLines(journals, { query: '' }, ctx));
  assert.equal(groups[0].count, 2);
  const sales = groupByMemo(hits).find((g) => g.memo === '4月分 売上 A社');
  assert.deepEqual([sales.count, sales.debit, sales.credit, sales.lastDate], [2, 550_000, 550_000, '2026-04-05']);
  assert.deepEqual(sales.accounts, ['売掛金', '売上高']);
});

test('科目の検索：コードの前方一致・科目名・区分の名前。前方一致を先に並べる', () => {
  const accounts = [
    { id: '1', code: '110', name: '当座預金', group: 'current_assets' },
    { id: '2', code: '111', name: '普通預金', group: 'current_assets' },
    { id: '3', code: '510', name: '預け金', group: 'current_assets' },
    { id: '4', code: '720', name: '地代家賃', group: 'sga' },
  ];
  const label = (a) => ({ current_assets: '流動資産', sga: '販売費及び一般管理費' })[a.group];
  assert.deepEqual(searchAccounts(accounts, '預金', label).map((a) => a.name), ['当座預金', '普通預金']);
  assert.deepEqual(searchAccounts(accounts, '11', label).map((a) => a.id), ['1', '2']);
  assert.deepEqual(searchAccounts(accounts, 'はんばい', label).map((a) => a.id), [], 'ひらがなは区分の名前（漢字）には一致しない');
  assert.deepEqual(searchAccounts(accounts, '販売費', label).map((a) => a.id), ['4']);
  assert.deepEqual(searchAccounts(accounts, '預', label).map((a) => a.name), ['預け金', '当座預金', '普通預金'], '科目名の前方一致を先に');
  assert.equal(searchAccounts(accounts, '', label).length, 4);
});
