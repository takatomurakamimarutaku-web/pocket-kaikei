import { test } from 'node:test';
import assert from 'node:assert/strict';
import { csvCell, toCsv, journalsCsv, trialBalanceCsv, BOM } from '../js/csv.js';
import { trialBalance } from '../js/ledger.js';
import { makeBook } from './helpers.js';

test('エスケープ：カンマ・ダブルクォート・改行を含む値を囲む', () => {
  assert.equal(csvCell('a,b'), '"a,b"');
  assert.equal(csvCell('say "hi"'), '"say ""hi"""');
  assert.equal(csvCell('1\n2'), '"1\n2"');
  assert.equal(csvCell(null), '');
  assert.equal(csvCell(-1000), '-1000');
  assert.ok(toCsv([['a']]).startsWith(BOM));
});

test('仕訳帳CSV：複合仕訳は同じNo.で行を分け、税区分は名称で出す', () => {
  const b = makeBook('corporation', { subs: [['普通預金', 'A銀行']] });
  const j = b.j('2026-02-01', [['消耗品費', 1100], ['通信費', 2200]], [['普通預金', 3300, undefined, 'A銀行']], '経費, まとめ');
  const csv = journalsCsv([j], { accountById: new Map(b.accounts.map((a) => [a.id, a])), subById: new Map(b.subAccounts.map((s) => [s.id, s])) });
  const lines = csv.slice(1).trim().split('\r\n');
  assert.equal(lines[0], 'No.,日付,借方科目,借方補助,借方税区分,借方金額,貸方科目,貸方補助,貸方税区分,貸方金額,摘要');
  assert.equal(lines[1], '1,2026/02/01,消耗品費,,課税仕入10%,1100,普通預金,A銀行,,3300,"経費, まとめ"');
  assert.equal(lines[2], '1,2026/02/01,通信費,,課税仕入10%,2200,,,,,"経費, まとめ"');
});

test('試算表CSV：動きのない科目は出さず、合計行を付ける。マイナスは -', () => {
  const b = makeBook('corporation');
  b.opening([['現金', 1000], ['資本金', 1000]]);
  const js = [b.j('2026-02-01', [['地代家賃', 5000]], [['現金', 5000]])];
  const csv = trialBalanceCsv(trialBalance({ ...b, journals: js }), 'corporation');
  const lines = csv.slice(1).trim().split('\r\n');
  assert.equal(lines[1], '100,現金,流動資産,1000,0,5000,-4000');
  assert.ok(lines.some((l) => l.startsWith('621,地代家賃,販売費及び一般管理費,0,5000,0,5000')));
  assert.equal(lines.at(-1), ',合計,,,5000,5000,');
  assert.equal(lines.length, 5);
});
