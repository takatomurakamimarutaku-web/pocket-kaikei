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
import { isOpeningStale } from '../js/closing.js';

test('サンプルの一覧：id・名前が重ならず、どれも作れる', () => {
  assert.equal(new Set(SAMPLES.map((x) => x.id)).size, SAMPLES.length);
  assert.equal(new Set(SAMPLES.map((x) => x.name)).size, SAMPLES.length);
  assert.ok(SAMPLES.filter((x) => x.entityType === 'corporation').length >= 5);
  for (const x of SAMPLES) assert.equal(buildSample(x.id).settings.businessName, SAMPLE_NAMES[x.id]);
  assert.throws(() => buildSample('nothing'), /不明なサンプル/);
});

for (const sample of SAMPLES) {
  for (const periods of [1, 3]) {
    test(`サンプル（${sample.name}・${periods}期）：検証を通り、仕訳は貸借一致、どの期もBSが一致、現金・預金がマイナスにならない`, () => {
      const data = parseBackup(JSON.stringify(createBackup(buildSample(sample.id, { periods }))));
      const { entityType } = data.settings;
      assert.equal(entityType, sample.entityType);
      assert.equal(data.periods.length, periods);
      const sorted = [...data.periods].sort((a, b) => (a.startDate < b.startDate ? -1 : 1));
      assert.equal(data.currentPeriodId, sorted.at(-1).id);
      // 科目のコードが重ならない
      assert.equal(new Set(data.accounts.map((a) => a.code)).size, data.accounts.length);
      for (const [k, period] of sorted.entries()) {
        const own = data.journals.filter((x) => x.periodId === period.id);
        assert.ok(own.length > 40, period.startDate);
        assert.equal(period.nextJournalNo, own.length + 1);
        // 当期は開いていて、過去の期は締めてある
        assert.equal(Boolean(period.closed), k < periods - 1, period.startDate);
        for (const jr of own) {
          assert.deepEqual(validateJournal(jr, { accounts: data.accounts, subAccounts: data.subAccounts, period }), [], `${jr.date} ${jr.lines[0].memo}`);
          const debit = jr.lines.filter((l) => l.side === 'debit').reduce((t, l) => t + l.amount, 0);
          const credit = jr.lines.filter((l) => l.side === 'credit').reduce((t, l) => t + l.amount, 0);
          assert.equal(debit, credit);
          assert.ok(jr.lines.every((l) => Number.isInteger(l.amount) && l.amount > 0));
        }
        const { bs } = buildStatements({ entityType, accounts: data.accounts, period, journals: own });
        assert.equal(bs.balanced, true, period.startDate);
        assert.equal(bs.totalAssets, bs.totalLiabilitiesAndEquity);
        for (const a of data.accounts.filter((x) => x.role === 'cash' || x.role === 'deposit')) {
          for (const sub of [null, ...data.subAccounts.filter((s) => s.accountId === a.id).map((s) => s.id)]) {
            assert.equal(firstNegativeDate({ accountId: a.id, subAccountId: sub, accounts: data.accounts, subAccounts: data.subAccounts, period, journals: own }), null, `${period.startDate} ${a.name}`);
          }
        }
        // 消費税の計算方法：設定した方法がこの期間に使え、計算できる
        if (period.taxReturn) {
          assert.equal(methodAvailability(period.taxReturn.method, period, entityType), null);
          assert.ok(computeTaxReturn({ journals: own, period, entityType, ...period.taxReturn }).salesTax > 0);
        }
        if (k === 0) continue;
        // 前の期の期末残高がこの期の期首残高に繰り越してある（アプリの「繰越をやり直す」の判定と同じ）
        const prev = sorted[k - 1];
        assert.equal(isOpeningStale({ entityType, accounts: data.accounts, subAccounts: data.subAccounts, prevPeriod: prev, prevJournals: data.journals.filter((x) => x.periodId === prev.id), period }), false);
      }
      const current = sorted.at(-1);
      const { pl } = buildStatements({ entityType, accounts: data.accounts, period: current, journals: data.journals.filter((x) => x.periodId === current.id) });
      assert.ok(pl.netIncome > 0);
      // 過去の期は決算整理済み：減価償却（資産があれば）・消費税等（課税事業者）・法人税等（法人）の仕訳が期末日にある
      for (const prev of sorted.slice(0, -1)) {
        const closing = data.journals.filter((x) => x.periodId === prev.id && x.date === prev.endDate);
        if (depreciationLines({ assets: data.assets, periods: data.periods, period: prev, accounts: data.accounts, entityType }).lines.length) assert.ok(closing.some((x) => x.source === 'depreciation'), `${prev.startDate} 減価償却`);
        if (data.settings.taxStatus === 'taxable') assert.ok(closing.some((x) => x.source === 'consumption_tax'), `${prev.startDate} 消費税等`);
        if (entityType === 'corporation') assert.ok(closing.some((x) => x.adjusting && x.lines.some((l) => data.accounts.find((a) => a.id === l.accountId).group === 'income_taxes')), `${prev.startDate} 法人税等`);
      }
      // 当期はまだ決算整理をしていない（決算の画面で試すため）
      assert.ok(!data.journals.some((x) => x.periodId === current.id && ['depreciation', 'consumption_tax', 'inventory'].includes(x.source)));
      // 固定資産は台帳の検証を通り、当期の減価償却の仕訳を作れる
      for (const asset of data.assets) assert.deepEqual(validateAsset(asset, { entityType, accounts: data.accounts, filing: data.settings.filing }), {}, asset.name);
      assert.deepEqual(depreciationLines({ assets: data.assets, periods: data.periods, period: current, accounts: data.accounts, entityType }).errors, []);
    });
  }
}

test('法人のサンプルの違い：消費税の計算方法・決算月・規模がばらける', () => {
  const corp = SAMPLES.filter((x) => x.entityType === 'corporation').map((x) => buildSample(x.id));
  assert.ok(corp.length >= 5);
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

test('業種別・3期分のサンプルも Repository に読み込める', async () => {
  for (const x of SAMPLES) {
    const repo = await openDB({ indexedDB: new IDBFactory() });
    const data = parseBackup(JSON.stringify(createBackup(buildSample(x.id, { periods: 3 }))));
    await repo.replaceAll(data);
    assert.equal((await repo.getSettings()).businessName, x.name);
    const periods = await repo.listPeriods();
    assert.equal(periods.length, 3);
    assert.equal(periods.filter((p) => p.closed).length, 2);
    assert.equal(periods[0].taxReturn?.method, data.periods[0].taxReturn?.method);
    repo.close();
  }
});

test('個人のサンプルの違い：申告の種類・消費税・不動産所得がばらける', () => {
  const ind = SAMPLES.filter((x) => x.entityType === 'individual').map((x) => buildSample(x.id));
  assert.ok(ind.length >= 5);
  assert.ok(ind.some((d) => d.settings.filing === 'white'));
  assert.ok(ind.some((d) => d.settings.realEstate === 'only'));
  const methods = ind.map((d) => (d.settings.taxStatus === 'exempt' ? 'exempt' : d.periods[0].taxReturn?.method || 'general'));
  for (const m of ['general', 'simplified', 'twenty', 'exempt']) assert.ok(methods.includes(m), m);
  // 青色事業専従者給与の科目を使う
  assert.ok(ind.some((d) => d.journals.some((x) => x.lines.some((l) => d.accounts.find((a) => a.id === l.accountId).group === 'family_salary'))));
});

test('3期分のサンプル：前の期より当期の売上が多く、年度は1年ずつ続く', () => {
  const d = buildSample('corporation', { periods: 3 });
  const sorted = [...d.periods].sort((a, b) => (a.startDate < b.startDate ? -1 : 1));
  assert.deepEqual(sorted.map((p) => p.startDate), ['2024-04-01', '2025-04-01', '2026-04-01']);
  const sales = sorted.map((p) => buildStatements({ entityType: 'corporation', accounts: d.accounts, period: p, journals: d.journals.filter((x) => x.periodId === p.id) }).pl.profits.sales);
  assert.ok(sales[0] < sales[1] && sales[1] < sales[2]);
  // 当期だけのときと当期の中身は同じ（1期分のサンプルの当期を3期分の最後の期にしている）
  const one = buildSample('corporation');
  assert.equal(sales[2], buildStatements({ entityType: 'corporation', accounts: one.accounts, period: one.periods[0], journals: one.journals }).pl.profits.sales);
});
