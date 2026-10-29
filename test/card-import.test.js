import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseCsv, detectCardColumns, extractTransactions, importLines, markDuplicates, matchRule } from '../js/bank-import.js';
import { validateJournal } from '../js/journal.js';
import { createJournal } from '../js/models.js';
import { makeBook } from './helpers.js';

const RAKUTEN = `カード名称,楽天カード
利用日,利用店名・商品名,利用者,支払方法,利用金額,支払手数料,支払総額,11月支払金額
2026/10/01,Amazon.co.jp,本人,1回払い,3300,0,3300,3300
2026/10/03,ENEOS 新宿SS,本人,1回払い,5500,0,5500,5500
2026/10/05,Amazon.co.jp 返品,本人,1回払い,-1100,0,-1100,-1100
`;

test('カード明細：見出しから利用日・利用先・利用金額を見つけ、利用は出金の向き、返品は入金の向きにする', () => {
  const rows = parseCsv(RAKUTEN);
  const m = detectCardColumns(rows);
  assert.equal(m.headerRow, 1);
  assert.equal(m.columns.date, 0);
  assert.equal(m.columns.memo, 1);
  assert.equal(m.columns.amount, 4); // 支払総額・支払金額より利用金額を優先
  assert.equal(m.negate, true);
  const txs = extractTransactions(rows, m);
  assert.deepEqual(txs.map((t) => [t.date, t.amount]), [['2026-10-01', -3300], ['2026-10-03', -5500], ['2026-10-05', 1100]]);
});

test('カード明細：見出しの無い形式は値から推定する', () => {
  const rows = parseCsv('2026/10/10,コンビニ,550,1,1,550\n2026/10/11,書店,1980,1,1,1980\n');
  const m = detectCardColumns(rows);
  const txs = extractTransactions(rows, m);
  assert.deepEqual(txs.map((t) => [t.memo, t.amount]), [['コンビニ', -550], ['書店', -1980]]);
});

test('カード明細の仕訳：利用は 相手科目 / 未払金、返品は 未払金 / 相手科目。重複の判定とルールも銀行と同じ', () => {
  const b = makeBook('individual', { subs: [['未払金', '楽天カード']] });
  const card = { accountId: b.byName['未払金'].id, subAccountId: b.subAccounts[0].id };
  const counter = { accountId: b.byName['消耗品費'].id, subAccountId: null, taxCategory: 'purchase_10' };
  const use = importLines({ amount: -3300, memo: 'Amazon.co.jp' }, card, counter);
  assert.deepEqual(use.map((l) => [l.side, l.accountId]), [['debit', counter.accountId], ['credit', card.accountId]]);
  assert.equal(use[1].subAccountId, card.subAccountId);
  const ret = importLines({ amount: 1100, memo: '返品' }, card, counter);
  assert.deepEqual(ret.map((l) => [l.side, l.accountId]), [['debit', card.accountId], ['credit', counter.accountId]]);
  const j = createJournal({ periodId: b.period.id, date: '2026-10-01', lines: use, source: 'card_import' });
  assert.deepEqual(validateJournal(j, { accounts: b.accounts, subAccounts: b.subAccounts, period: b.period }), []);
  const dup = markDuplicates([{ date: '2026-10-01', amount: -3300 }, { date: '2026-10-02', amount: -3300 }], [j], card);
  assert.deepEqual(dup, [true, false]);
  const rules = [{ keyword: 'ENEOS', direction: 'out', accountId: b.byName['旅費交通費'].id, subAccountId: null, taxCategory: 'purchase_10' }];
  assert.equal(matchRule({ memo: 'ENEOS 新宿SS', amount: -5500 }, rules, { accounts: b.accounts }).counter.accountId, b.byName['旅費交通費'].id);
});
