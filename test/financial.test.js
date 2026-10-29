import { test } from 'node:test';
import assert from 'node:assert/strict';
import { IDBFactory } from 'fake-indexeddb';
import { buildStatements } from '../js/statements.js';
import { sgaBreakdown, condensedIncomeItems, equityStatement, companyNotes, depreciationPolicy, validateNotes, DEFAULT_NOTES } from '../js/financial.js';
import { buildSample } from '../js/sample.js';
import { makeBook } from './helpers.js';

function book() {
  const b = makeBook('corporation');
  b.opening([
    ['普通預金', 5000000],
    ['商品', 300000],
    ['資本金', 3000000],
    ['資本準備金', 500000],
    ['利益準備金', 100000],
    ['繰越利益剰余金', 1700000],
  ]);
  const journals = [
    b.j('2026-05-01', [['普通預金', 2200000]], [['売上高', 2200000]]),
    b.j('2026-05-10', [['仕入高', 1100000]], [['普通預金', 1100000]]),
    b.j('2026-05-25', [['給料手当', 300000], ['地代家賃', 110000]], [['普通預金', 410000]]),
    // 剰余金の配当 100,000、利益準備金の積立 10,000
    b.j('2026-06-25', [['繰越利益剰余金', 110000]], [['普通預金', 100000], ['利益準備金', 10000]]),
  ];
  return { ...b, journals };
}

test('株主資本等変動計算書：期首＋当期純利益＋その他の変動＝期末、純資産合計は貸借対照表と一致', () => {
  const { accounts, period, journals } = book();
  const { pl, bs } = buildStatements({ entityType: 'corporation', accounts, period, journals });
  const eq = equityStatement({ accounts, period, journals, netIncome: pl.netIncome });
  assert.deepEqual(eq.sections.map((s) => s.label), ['資本金', '資本剰余金', '利益剰余金']);
  const retained = eq.sections.find((s) => s.id === 'retained');
  const re = retained.rows.find((r) => r.account.name === '繰越利益剰余金');
  assert.deepEqual([re.opening, re.netIncome, re.other, re.closing], [1700000, pl.netIncome, -110000, 1700000 + pl.netIncome - 110000]);
  const lr = retained.rows.find((r) => r.account.name === '利益準備金');
  assert.deepEqual([lr.opening, lr.other, lr.closing], [100000, 10000, 110000]);
  for (const s of eq.sections) for (const r of s.rows) assert.equal(r.opening + r.netIncome + r.other, r.closing);
  const equityBs = bs.liabilities.find((it) => it.type === 'group' && it.groups.includes('equity'));
  assert.equal(eq.total.closing, equityBs.total);
  assert.equal(eq.total.opening, 5300000);
});

test('販売費及び一般管理費：内訳と合計、損益計算書では合計の1行にする', () => {
  const { accounts, period, journals } = book();
  const { pl } = buildStatements({ entityType: 'corporation', accounts, period, journals });
  const sga = sgaBreakdown(pl);
  assert.equal(sga.total, 410000);
  assert.deepEqual(sga.lines.filter((l) => l.amount).map((l) => [l.account.name, l.amount]), [['給料手当', 300000], ['地代家賃', 110000]]);
  const items = condensedIncomeItems(pl);
  const line = items.find((it) => it.sga);
  assert.deepEqual([line.type, line.label, line.amount], ['subtotal', '販売費及び一般管理費', 410000]);
  assert.equal(items.length, pl.items.length);
});

test('個別注記表：棚卸資産・減価償却・消費税・株式数・その他。空欄の項目は出さない', () => {
  const { accounts, period, journals } = book();
  const assets = [
    { category: 'machinery', method: 'declining', acquiredOn: '2025-04-01', disposedOn: null },
    { category: 'tools', method: 'sme', acquiredOn: '2026-05-01', disposedOn: null },
  ];
  const sections = companyNotes({ accounts, period, journals, assets, notes: { sharesIssued: 1000, other: '特記事項なし' } });
  assert.deepEqual(sections.map((s) => s.title), ['重要な会計方針に係る事項に関する注記', '株主資本等変動計算書に関する注記', 'その他の注記']);
  const policy = sections[0].items.map((i) => i.heading);
  assert.deepEqual(policy, ['棚卸資産の評価基準及び評価方法', '固定資産の減価償却の方法', '消費税等の会計処理']);
  assert.match(sections[0].items[1].text, /定率法/);
  assert.match(sections[0].items[1].text, /少額減価償却資産/);
  assert.equal(sections[1].items[0].text, '普通株式　1,000株');
});

test('減価償却の方法：定額法だけ・無形・期間外の資産は使わない', () => {
  const period = { startDate: '2026-04-01', endDate: '2027-03-31' };
  assert.deepEqual(depreciationPolicy([{ category: 'vehicle', method: 'straight', acquiredOn: '2026-05-01' }], period), ['有形固定資産　定額法']);
  assert.deepEqual(depreciationPolicy([{ category: 'intangible', method: 'straight', acquiredOn: '2026-05-01' }], period), ['無形固定資産　定額法']);
  assert.deepEqual(depreciationPolicy([{ category: 'tools', method: 'straight', acquiredOn: '2027-05-01' }], period), []);
  assert.deepEqual(depreciationPolicy([{ category: 'tools', method: 'straight', acquiredOn: '2020-05-01', disposedOn: '2026-01-10' }], period), []);
});

test('注記の検証：文字数・株式数・真偽値', () => {
  assert.deepEqual(validateNotes({ ...DEFAULT_NOTES }), []);
  assert.match(validateNotes({ ...DEFAULT_NOTES, other: 'あ'.repeat(2001) }).join(), /2000文字/);
  assert.match(validateNotes({ ...DEFAULT_NOTES, sharesIssued: -1 }).join(), /株式の数/);
  assert.match(validateNotes({ ...DEFAULT_NOTES, sharesIssued: 1.5 }).join(), /株式の数/);
});

test('法人のサンプル：変動計算書の期末は貸借対照表の純資産、減価償却累計額の注記', () => {
  const d = buildSample('corporation');
  const period = d.periods[0];
  const { pl, bs } = buildStatements({ entityType: 'corporation', accounts: d.accounts, period, journals: d.journals });
  const eq = equityStatement({ accounts: d.accounts, period, journals: d.journals, netIncome: pl.netIncome });
  assert.equal(eq.total.closing, bs.liabilities.find((it) => it.type === 'group' && it.groups.includes('equity')).total);
  const sections = companyNotes({ accounts: d.accounts, period, journals: d.journals, assets: d.assets });
  assert.ok(sections.some((s) => s.title === '重要な会計方針に係る事項に関する注記'));
});

test('Repository：注記を期間に保存し、不正な値は保存しない', async () => {
  const { openDB, ValidationError } = await import('../js/db.js');
  const { createPeriod, createSettings, createAccount } = await import('../js/models.js');
  const { templateAccounts } = await import('../js/accounts.js');
  const repo = await openDB({ indexedDB: new IDBFactory() });
  const p = createPeriod({ startDate: '2026-04-01', endDate: '2027-03-31' });
  await repo.setup({ settings: createSettings({ businessName: 'テスト株式会社', entityType: 'corporation' }), period: p, accounts: templateAccounts('corporation').map((a) => createAccount(a)) });
  const saved = await repo.saveStatementNotes(p.id, { sharesIssued: 200, other: 'メモ', extra: 'x' });
  assert.equal(saved.statementNotes.sharesIssued, 200);
  assert.equal(saved.statementNotes.inventoryMethod, DEFAULT_NOTES.inventoryMethod);
  assert.equal('extra' in saved.statementNotes, false);
  await assert.rejects(repo.saveStatementNotes(p.id, { sharesIssued: 'abc' }), ValidationError);
});
