// サンプルデータ：バックアップの検証を通り、決算書が一致し、現金・預金がマイナスにならない
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { IDBFactory } from 'fake-indexeddb';
import { buildSample } from '../js/sample.js';
import { createBackup, parseBackup } from '../js/backup.js';
import { buildStatements, closingRows, manufacturingReport } from '../js/statements.js';
import { firstNegativeDate } from '../js/ledger.js';
import { taxChecks } from '../js/tax-reports.js';
import { summarizeTax } from '../js/tax.js';
import { depreciationLines } from '../js/depreciation.js';
import { openDB } from '../js/db.js';

for (const entityType of ['individual', 'corporation']) {
  test(`サンプルデータ（${entityType}）：検証を通り、BSが一致し、現金・預金がマイナスにならない`, () => {
    const data = parseBackup(JSON.stringify(createBackup(buildSample(entityType))));
    const period = data.periods[0];
    assert.equal(data.currentPeriodId, period.id);
    assert.ok(data.journals.length > 100);
    assert.equal(period.nextJournalNo, data.journals.length + 1);
    const { pl, bs } = buildStatements({ entityType, accounts: data.accounts, period, journals: data.journals });
    assert.equal(bs.balanced, true);
    assert.ok(pl.netIncome > 0);
    for (const a of data.accounts.filter((x) => x.role === 'cash' || x.role === 'deposit')) {
      for (const sub of [null, ...data.subAccounts.filter((s) => s.accountId === a.id).map((s) => s.id)]) {
        assert.equal(firstNegativeDate({ accountId: a.id, subAccountId: sub, accounts: data.accounts, subAccounts: data.subAccounts, period, journals: data.journals }), null, a.name);
      }
    }
    // 減価償却の仕訳を作れる
    assert.deepEqual(depreciationLines({ assets: data.assets, periods: data.periods, period, accounts: data.accounts, entityType }).errors, []);
    // 消費税：課税売上・課税仕入があり、インボイスのない仕入もある
    const tax = summarizeTax(data.journals);
    const gross = (code) => tax.rows.find((r) => r.code === code).gross;
    assert.ok(gross('sales_10') > 0 && gross('purchase_10') > 0 && gross('purchase_10_ni') > 0);
  });
}

test('法人のサンプル：製造原価を使い、製造原価報告書が出る。税区分のチェックの例が1件', () => {
  const data = buildSample('corporation');
  assert.equal(data.settings.manufacturing, true);
  const r = manufacturingReport(closingRows({ accounts: data.accounts, period: data.periods[0], journals: data.journals }));
  assert.equal(r.used, true);
  assert.ok(r.cost > 0);
  assert.deepEqual(taxChecks({ journals: data.journals, accounts: data.accounts }).map((x) => x.type), ['expense_sales']);
  assert.ok(data.assets.some((a) => a.expenseAccountId));
});

test('サンプルデータを Repository に読み込める', async () => {
  const repo = await openDB({ indexedDB: new IDBFactory() });
  const data = parseBackup(JSON.stringify(createBackup(buildSample('individual'))));
  await repo.replaceAll(data);
  assert.equal((await repo.getSettings()).entityType, 'individual');
  assert.equal((await repo.counts()).journals, data.journals.length);
  repo.close();
});

// 業種・規模・消費税の計算方法の違う法人のサンプル（一覧の全部）
import { SAMPLES, SAMPLE_NAMES } from '../js/sample.js';
import { validateAsset } from '../js/depreciation.js';
import { computeTaxReturn, methodAvailability } from '../js/tax-return.js';
import { validateJournal } from '../js/journal.js';

test('サンプルの一覧：id・名前が重ならず、どれも作れる', () => {
  assert.equal(new Set(SAMPLES.map((x) => x.id)).size, SAMPLES.length);
  assert.equal(new Set(SAMPLES.map((x) => x.name)).size, SAMPLES.length);
  assert.ok(SAMPLES.filter((x) => x.entityType === 'corporation').length >= 5);
  for (const x of SAMPLES) assert.equal(buildSample(x.id).settings.businessName, SAMPLE_NAMES[x.id]);
  assert.throws(() => buildSample('nothing'), /不明なサンプル/);
});

for (const sample of SAMPLES) {
  test(`サンプル（${sample.name}）：検証を通り、仕訳は貸借一致、BSが一致、現金・預金がマイナスにならない`, () => {
    const data = parseBackup(JSON.stringify(createBackup(buildSample(sample.id))));
    const period = data.periods[0];
    const { entityType } = data.settings;
    assert.equal(entityType, sample.entityType);
    assert.ok(data.journals.length > 100);
    assert.equal(period.nextJournalNo, data.journals.length + 1);
    // 科目のコードが重ならない
    assert.equal(new Set(data.accounts.map((a) => a.code)).size, data.accounts.length);
    // 仕訳はすべて貸借一致し、期間内
    for (const jr of data.journals) {
      assert.deepEqual(validateJournal(jr, { accounts: data.accounts, subAccounts: data.subAccounts, period }), [], `${jr.date} ${jr.lines[0].memo}`);
      const debit = jr.lines.filter((l) => l.side === 'debit').reduce((s, l) => s + l.amount, 0);
      const credit = jr.lines.filter((l) => l.side === 'credit').reduce((s, l) => s + l.amount, 0);
      assert.equal(debit, credit);
      assert.ok(jr.lines.every((l) => Number.isInteger(l.amount) && l.amount > 0));
    }
    const { pl, bs } = buildStatements({ entityType, accounts: data.accounts, period, journals: data.journals });
    assert.equal(bs.balanced, true);
    assert.equal(bs.totalAssets, bs.totalLiabilitiesAndEquity);
    assert.ok(pl.netIncome > 0);
    for (const a of data.accounts.filter((x) => x.role === 'cash' || x.role === 'deposit')) {
      for (const sub of [null, ...data.subAccounts.filter((s) => s.accountId === a.id).map((s) => s.id)]) {
        assert.equal(firstNegativeDate({ accountId: a.id, subAccountId: sub, accounts: data.accounts, subAccounts: data.subAccounts, period, journals: data.journals }), null, a.name);
      }
    }
    // 固定資産は台帳の検証を通り、減価償却の仕訳を作れる
    for (const asset of data.assets) assert.deepEqual(validateAsset(asset, { entityType, accounts: data.accounts }), {}, asset.name);
    assert.deepEqual(depreciationLines({ assets: data.assets, periods: data.periods, period, accounts: data.accounts, entityType }).errors, []);
    // 消費税の計算方法：設定した方法がこの期間に使え、計算できる
    if (period.taxReturn) {
      assert.equal(methodAvailability(period.taxReturn.method, period, entityType), null);
      const r = computeTaxReturn({ journals: data.journals, period, entityType, ...period.taxReturn });
      assert.ok(r.salesTax > 0);
    }
  });
}

test('法人のサンプルの違い：消費税の計算方法・決算月・規模がばらける', () => {
  const corp = SAMPLES.filter((x) => x.entityType === 'corporation').map((x) => buildSample(x.id));
  const methods = corp.map((d) => (d.settings.taxStatus === 'exempt' ? 'exempt' : d.periods[0].taxReturn?.method || 'general'));
  for (const m of ['general', 'simplified', 'twenty', 'exempt']) assert.ok(methods.includes(m), m);
  assert.ok(new Set(corp.map((d) => d.periods[0].endDate.slice(5))).size >= 3);
  const sales = corp.map((d) => buildStatements({ entityType: 'corporation', accounts: d.accounts, period: d.periods[0], journals: d.journals }).pl.profits.sales);
  assert.ok(Math.min(...sales) < 10000000 && Math.max(...sales) > 100000000);
  // 免税事業者のサンプルは課税売上高が1,000万円以下
  const it = buildSample('corp-it');
  assert.equal(it.settings.taxStatus, 'exempt');
  // 欠損（繰越利益剰余金がマイナス）の会社が1つある
  const rest = buildSample('corp-restaurant');
  const re = rest.accounts.find((a) => a.role === 'retained_earnings');
  assert.ok(rest.periods[0].openingBalances.find((o) => o.accountId === re.id).amount < 0);
});

test('業種別のサンプルも Repository に読み込める', async () => {
  for (const x of SAMPLES.filter((s) => s.id.startsWith('corp-'))) {
    const repo = await openDB({ indexedDB: new IDBFactory() });
    await repo.replaceAll(parseBackup(JSON.stringify(createBackup(buildSample(x.id)))));
    assert.equal((await repo.getSettings()).businessName, x.name);
    assert.equal((await repo.listPeriods())[0].taxReturn?.method, buildSample(x.id).periods[0].taxReturn?.method);
    repo.close();
  }
});
