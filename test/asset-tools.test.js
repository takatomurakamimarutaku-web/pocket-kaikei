import { test } from 'node:test';
import assert from 'node:assert/strict';
import { usedAssetLife, bookValueAt, disposalLines, canDispose, registerByAccount, LIFE_PRESETS, findDisposalJournals } from '../js/asset-tools.js';
import { assetRegister, validateAsset, CATEGORY_BY_ID } from '../js/depreciation.js';
import { validateJournal } from '../js/journal.js';
import { createJournal } from '../js/models.js';
import { makeBook } from './helpers.js';
import { fillHints } from '../js/accounts.js';

const corpPeriods = [{ id: 'p1', startDate: '2026-04-01', endDate: '2027-03-31' }];
const indPeriods = [{ id: 'p1', startDate: '2026-01-01', endDate: '2026-12-31' }];
const sum = (lines, side) => lines.filter((l) => l.side === side).reduce((s, l) => s + l.amount, 0);

test('中古資産の耐用年数（簡便法）：(法定−経過)＋経過×20%、全部経過は法定×20%、端数切り捨て・最低2年', () => {
  assert.equal(usedAssetLife(15, 60), 11); // (15−5)＋5×0.2＝11
  assert.equal(usedAssetLife(6, 24), 4); // (6−2)＋2×0.2＝4.4 → 4
  assert.equal(usedAssetLife(6, 30), 4); // 72−30×4/5＝48か月 → 4
  assert.equal(usedAssetLife(6, 72), 2); // 全部経過：6×20%＝1.2 → 2年
  assert.equal(usedAssetLife(22, 300), 4); // 全部経過：22×20%＝4.4 → 4
  assert.equal(usedAssetLife(10, 0), 10);
  assert.equal(usedAssetLife(0, 10), null);
  assert.equal(usedAssetLife(6, -1), null);
});

test('耐用年数の候補：種類があり、年数は2〜50年', () => {
  for (const p of LIFE_PRESETS) {
    assert.ok(CATEGORY_BY_ID[p.category], p.label);
    assert.ok(p.life >= 2 && p.life <= 50, p.label);
  }
  assert.equal(LIFE_PRESETS.find((p) => p.label.startsWith('パソコン')).life, 4);
  assert.equal(LIFE_PRESETS.find((p) => p.label.startsWith('軽自動車')).life, 4);
});

test('法人の売却：減価償却累計額を消し、売却額は課税売上、差額は固定資産売却益', () => {
  const b = makeBook('corporation', { startDate: '2026-04-01', endDate: '2027-03-31' });
  fillHints('corporation', b.accounts);
  const asset = { id: 'a1', name: '機械', category: 'machinery', accountId: b.byName['機械装置'].id, acquiredOn: '2026-04-01', startedOn: '2026-04-01', cost: 1000000, method: 'straight', usefulLife: 8, businessRatio: 100 };
  // 2026/4〜2027/3：125,000、2027/4〜9（6か月）：62,500
  assert.equal(bookValueAt(asset, corpPeriods, '2027-09-30'), 812500);
  const r = disposalLines({ asset, periods: corpPeriods, accounts: b.accounts, entityType: 'corporation', date: '2027-09-30', type: 'sell', price: 880000, receiptAccountId: b.byName['普通預金'].id, gainAccountId: b.byName['固定資産売却益'].id, lossAccountId: b.byName['固定資産売却損'].id });
  assert.deepEqual(r.errors, []);
  assert.deepEqual([r.book, r.accumulated, r.gain, r.loss], [812500, 187500, 67500, 0]);
  const name = (id) => b.accounts.find((a) => a.id === id).name;
  assert.deepEqual(
    r.lines.map((l) => [l.side, name(l.accountId), l.amount, l.taxCategory]),
    [
      ['debit', '減価償却累計額', 187500, 'none'],
      ['credit', '機械装置', 187500, 'none'],
      ['debit', '普通預金', 880000, 'none'],
      ['credit', '機械装置', 880000, 'sales_10'],
      ['debit', '機械装置', 67500, 'none'],
      ['credit', '固定資産売却益', 67500, 'none'],
    ],
  );
  // 資産の科目は取得価額の分だけ減る
  const assetNet = r.lines.filter((l) => l.accountId === asset.accountId).reduce((s, l) => s + (l.side === 'credit' ? l.amount : -l.amount), 0);
  assert.equal(assetNet, 1000000);
  assert.equal(sum(r.lines, 'debit'), sum(r.lines, 'credit'));
  // 仕訳として保存できる（貸借一致・科目・税区分）
  const j = createJournal({ periodId: 'p2', date: '2027-09-30', lines: r.lines });
  assert.deepEqual(validateJournal(j, { accounts: b.accounts, subAccounts: [], period: { id: 'p2', startDate: '2027-04-01', endDate: '2028-03-31' } }), []);
  // 売却額が帳簿価額より低いと売却損
  const low = disposalLines({ asset, periods: corpPeriods, accounts: b.accounts, entityType: 'corporation', date: '2027-09-30', type: 'sell', price: 500000, receiptAccountId: b.byName['普通預金'].id, gainAccountId: b.byName['固定資産売却益'].id, lossAccountId: b.byName['固定資産売却損'].id });
  assert.equal(low.loss, 312500);
  assert.ok(low.lines.some((l) => l.side === 'debit' && l.accountId === b.byName['固定資産売却損'].id && l.amount === 312500));
});

test('法人の除却：累計額を消し、帳簿価額を固定資産除却損に', () => {
  const b = makeBook('corporation', { startDate: '2026-04-01', endDate: '2027-03-31' });
  fillHints('corporation', b.accounts);
  const asset = { id: 'a1', name: 'エアコン', category: 'tools', accountId: b.byName['工具器具備品'].id, acquiredOn: '2026-04-01', startedOn: '2026-04-01', cost: 600000, method: 'straight', usefulLife: 6, businessRatio: 100 };
  const r = disposalLines({ asset, periods: corpPeriods, accounts: b.accounts, entityType: 'corporation', date: '2027-03-31', type: 'retire', lossAccountId: b.byName['固定資産除却損'].id });
  assert.deepEqual(r.errors, []);
  assert.equal(r.book, 499800); // 600,000×0.167（定額法6年）＝100,200
  assert.equal(sum(r.lines, 'debit'), 600000); // 累計額 100,200＋除却損 499,800
  assert.equal(r.lines.find((l) => l.accountId === b.byName['固定資産除却損'].id).amount, 499800);
});

test('個人の除却：事業で使う割合の分を経費、残りを事業主貸', () => {
  const b = makeBook('individual');
  fillHints('individual', b.accounts);
  const asset = { id: 'a1', name: '車', category: 'vehicle', accountId: b.byName['車両運搬具'].id, acquiredOn: '2026-01-01', startedOn: '2026-01-01', cost: 300000, method: 'straight', usefulLife: 4, businessRatio: 80 };
  const r = disposalLines({ asset, periods: indPeriods, accounts: b.accounts, entityType: 'individual', date: '2027-06-30', type: 'retire', lossAccountId: b.byName['雑費'].id });
  assert.deepEqual(r.errors, []);
  assert.equal(r.book, 187500); // 300,000 − 75,000 − 37,500
  const name = (id) => b.accounts.find((a) => a.id === id).name;
  assert.deepEqual(r.lines.map((l) => [l.side, name(l.accountId), l.amount]), [['debit', '雑費', 150000], ['debit', '事業主貸', 37500], ['credit', '車両運搬具', 187500]]);
});

test('個人の売却：譲渡所得なので差額は事業主貸・事業主借。私用割合の売却額は消費税の対象外', () => {
  const b = makeBook('individual');
  const asset = { id: 'a1', name: '車', category: 'vehicle', accountId: b.byName['車両運搬具'].id, acquiredOn: '2026-01-01', startedOn: '2026-01-01', cost: 300000, method: 'straight', usefulLife: 4, businessRatio: 80 };
  const r = disposalLines({ asset, periods: indPeriods, accounts: b.accounts, entityType: 'individual', date: '2027-06-30', type: 'sell', price: 110000, receiptAccountId: b.byName['普通預金'].id });
  assert.deepEqual(r.errors, []);
  const name = (id) => b.accounts.find((a) => a.id === id).name;
  assert.deepEqual(
    r.lines.map((l) => [l.side, name(l.accountId), l.amount, l.taxCategory]),
    [
      ['debit', '普通預金', 110000, 'none'],
      ['credit', '車両運搬具', 88000, 'sales_10'],
      ['credit', '車両運搬具', 22000, 'none'],
      ['debit', '事業主貸', 77500, 'none'],
      ['credit', '車両運搬具', 77500, 'none'],
    ],
  );
  const gain = disposalLines({ asset, periods: indPeriods, accounts: b.accounts, entityType: 'individual', date: '2027-06-30', type: 'sell', price: 220000, receiptAccountId: b.byName['普通預金'].id });
  assert.ok(gain.lines.some((l) => l.side === 'credit' && name(l.accountId) === '事業主借' && l.amount === 32500));
});

test('売却・除却できない資産と入力の誤り', () => {
  const b = makeBook('individual');
  const lump = { id: 'a1', name: '棚', category: 'tools', accountId: b.byName['工具器具備品'].id, acquiredOn: '2026-01-01', startedOn: '2026-01-01', cost: 150000, method: 'lump3', usefulLife: null, businessRatio: 100 };
  assert.equal(canDispose(lump), false);
  assert.match(disposalLines({ asset: lump, periods: indPeriods, accounts: b.accounts, entityType: 'individual', date: '2026-06-30', type: 'retire' }).errors.join(), /定額法・定率法/);
  const pc = { ...lump, method: 'straight', usefulLife: 4 };
  assert.match(disposalLines({ asset: pc, periods: indPeriods, accounts: b.accounts, entityType: 'individual', date: '2026-06-30', type: 'sell', price: 1000 }).errors.join(), /入金先/);
  assert.match(disposalLines({ asset: pc, periods: indPeriods, accounts: b.accounts, entityType: 'individual', date: '2025-12-31', type: 'retire', lossAccountId: b.byName['雑費'].id }).errors.join(), /使い始めた日/);
});

test('資産の新しい項目の検証と、売却・除却の仕訳の検索', () => {
  const b = makeBook('individual');
  const base = { id: 'a1', name: 'パソコン', category: 'tools', accountId: b.byName['工具器具備品'].id, acquiredOn: '2026-01-01', startedOn: '2026-01-01', cost: 200000, method: 'straight', usefulLife: 4, businessRatio: 100 };
  const v = (f) => validateAsset({ ...base, ...f }, { entityType: 'individual', accounts: b.accounts });
  assert.deepEqual(v({ assetNo: 'A-001', quantity: 2, location: '本店' }), {});
  assert.ok(v({ quantity: 0 }).quantity);
  assert.ok(v({ assetNo: 'x'.repeat(21) }).assetNo);
  assert.ok(v({ disposalType: 'sell', salePrice: 1000 }).disposedOn); // 日付なし
  assert.deepEqual(v({ disposedOn: '2026-06-30', disposalType: 'sell', salePrice: 1000 }), {});
  assert.ok(v({ disposedOn: '2026-06-30', disposalType: 'retire', salePrice: 1000 }).disposedOn);
  const js = [{ id: 'j1', source: 'asset_disposal', sourceId: 'a1' }, { id: 'j2', source: 'depreciation' }, { id: 'j3', source: 'asset_disposal', sourceId: 'a2' }];
  assert.deepEqual(findDisposalJournals(js, 'a1').map((j) => j.id), ['j1']);
});

test('科目別の合計：取得価額・期首・償却費・期末', () => {
  const b = makeBook('individual');
  const tools = b.byName['工具器具備品'].id;
  const car = b.byName['車両運搬具'].id;
  const a = (id, accountId, cost, life) => ({ id, name: id, category: accountId === car ? 'vehicle' : 'tools', accountId, acquiredOn: '2026-01-01', startedOn: '2026-01-01', cost, method: 'straight', usefulLife: life, businessRatio: 100 });
  const reg = assetRegister([a('pc', tools, 200000, 4), a('desk', tools, 100000, 8), a('car', car, 1200000, 6)], indPeriods, indPeriods[0]);
  const s = registerByAccount(reg);
  const t = s.find((x) => x.accountId === tools);
  assert.deepEqual([t.count, t.cost, t.opening, t.amount, t.closing], [2, 300000, 300000, 50000 + 12500, 300000 - 62500]);
  assert.equal(s.find((x) => x.accountId === car).amount, 200400); // 1,200,000×0.167
});

test('固定資産台帳のCSV：1資産1行、個人は事業割合と経費の列', async () => {
  const { assetsCsv } = await import('../js/csv.js');
  const b = makeBook('individual');
  const car = { id: 'car', name: '車, 営業用', category: 'vehicle', accountId: b.byName['車両運搬具'].id, acquiredOn: '2026-01-01', startedOn: '2026-01-01', cost: 1200000, method: 'straight', usefulLife: 6, businessRatio: 80, assetNo: 'V-1', quantity: 1, location: '本店' };
  const reg = assetRegister([car], indPeriods, indPeriods[0]);
  const csv = assetsCsv(reg, { accountById: new Map(b.accounts.map((a) => [a.id, a])), individual: true });
  const lines = csv.replace('﻿', '').trim().split('\r\n');
  assert.equal(lines.length, 2);
  assert.ok(lines[0].startsWith('資産番号,資産名,種類,勘定科目,数量,設置場所'));
  assert.match(lines[0], /期首帳簿価額,償却費,うち特別償却,うち経費/);
  assert.equal(lines[1], 'V-1,"車, 営業用",車両運搬具,車両運搬具,1,本店,2026/01/01,2026/01/01,1200000,定額法,6,0.167,80%,1200000,200400,0,160320,999600,,,,');
});
