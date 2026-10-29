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
