import { test } from 'node:test';
import assert from 'node:assert/strict';
import { csvCell, toCsv, journalsCsv, trialBalanceCsv, ledgerCsv, BOM } from '../js/csv.js';
import { trialBalance, generalLedgers } from '../js/ledger.js';
import { makeBook } from './helpers.js';

test('エスケープ：カンマ・ダブルクォート・改行を含む値を囲む', () => {
  assert.equal(csvCell('a,b'), '"a,b"');
  assert.equal(csvCell('say "hi"'), '"say ""hi"""');
  assert.equal(csvCell('1\n2'), '"1\n2"');
  assert.equal(csvCell(null), '');
  assert.equal(csvCell(-1000), '-1000');
  assert.ok(toCsv([['a']]).startsWith(BOM));
});

test('仕訳帳CSV：複合仕訳は同じ伝票No.で行を分け、税区分は名称で出す。最後の列は入力No.', () => {
  const b = makeBook('corporation', { subs: [['普通預金', 'A銀行']] });
  const j = { ...b.j('2026-02-01', [['消耗品費', 1100], ['通信費', 2200]], [['普通預金', 3300, undefined, 'A銀行']], '経費, まとめ'), voucherNo: 15 };
  const csv = journalsCsv([j], { accountById: new Map(b.accounts.map((a) => [a.id, a])), subById: new Map(b.subAccounts.map((s) => [s.id, s])) });
  const lines = csv.slice(1).trim().split('\r\n');
  assert.equal(lines[0], '伝票No.,日付,借方科目,借方補助,借方税区分,借方金額,貸方科目,貸方補助,貸方税区分,貸方金額,摘要,入力No.');
  assert.equal(lines[1], '15,2026/02/01,消耗品費,,課税仕入10%,1100,普通預金,A銀行,,3300,"経費, まとめ",1');
  assert.equal(lines[2], '15,2026/02/01,通信費,,課税仕入10%,2200,,,,,"経費, まとめ",1');
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

test('総勘定元帳：全科目を科目順に、繰越の行と取引の行（取引も残高もない科目は出さない）', () => {
  const b = makeBook('individual');
  b.opening([['現金', 50000], ['元入金', 50000]]);
  const journals = [b.j('2026-02-01', [['通信費', 3000]], [['現金', 3000]], '電話代'), b.j('2026-03-01', [['現金', 10000]], [['売上高', 10000]])];
  const lgs = generalLedgers({ accounts: b.accounts, period: b.period, journals });
  assert.deepEqual(lgs.map((l) => l.account.name), ['現金', '元入金', '売上高', '通信費']);
  const lines = ledgerCsv(lgs, { carried: '前期繰越' }).slice(BOM.length).trim().split('\r\n');
  assert.equal(lines[0], 'コード,勘定科目,補助科目,日付,伝票No.,相手科目,摘要,借方,貸方,残高,入力No.');
  const cash = b.byName['現金'].code;
  assert.equal(lines[1], `${cash},現金,,,,前期繰越,,,,50000,`);
  assert.equal(lines[2], `${cash},現金,,2026/02/01,1,通信費,電話代,,3000,47000,1`);
  assert.equal(lines[3], `${cash},現金,,2026/03/01,2,売上高,,10000,,57000,2`);
});
