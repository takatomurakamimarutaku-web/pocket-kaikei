import { test } from 'node:test';
import assert from 'node:assert/strict';
import { duplicateJournals, negativeCashDays, abnormalBalances, suspenseBalances, futureJournals } from '../js/journal-checks.js';
import { makeBook } from './helpers.js';

test('重複の可能性：同じ日付・同じ明細の仕訳を組にする（行の順序は問わない）', () => {
  const b = makeBook('individual');
  const a = b.j('2026-03-01', [['消耗品費', 3300]], [['現金', 3300]]);
  const c = b.j('2026-03-01', [['消耗品費', 3300]], [['現金', 3300]]);
  const other = b.j('2026-03-02', [['消耗品費', 3300]], [['現金', 3300]]);
  const diff = b.j('2026-03-01', [['消耗品費', 3301]], [['現金', 3301]]);
  const reversed = { ...c, id: 'r', no: 99, lines: [...c.lines].reverse() };
  const groups = duplicateJournals([a, c, other, diff, reversed]);
  assert.equal(groups.length, 1);
  assert.deepEqual(groups[0].map((j) => j.no), [a.no, c.no, 99]);
});

test('現金の残高がマイナスになった日：その日の終わりの残高で判定し、最初の日と最小の残高を出す', () => {
  const b = makeBook('individual');
  b.opening([['現金', 10000], ['元入金', 10000]]);
  const journals = [
    // 同じ日に入金と出金：入力の順序によらず、日の終わりは +1,000
    b.j('2026-01-05', [['消耗品費', 12000]], [['現金', 12000]]),
    b.j('2026-01-05', [['現金', 3000]], [['売上高', 3000]]),
    b.j('2026-01-10', [['消耗品費', 5000]], [['現金', 5000]]), // -4,000
    b.j('2026-01-12', [['消耗品費', 1000]], [['現金', 1000]]), // -5,000
    b.j('2026-01-20', [['現金', 10000]], [['売上高', 10000]]), // +5,000
  ];
  const res = negativeCashDays({ accounts: b.accounts, period: b.period, journals });
  assert.equal(res.length, 1);
  assert.deepEqual([res[0].firstDate, res[0].days, res[0].minBalance, res[0].minDate], ['2026-01-10', 2, -5000, '2026-01-12']);
});

test('逆残高・未来の日付（個人）', () => {
  const b = makeBook('individual');
  const journals = [
    b.j('2026-02-01', [['普通預金', 1000]], [['売掛金', 1000]]), // 売掛金がマイナス
    b.j('2026-02-02', [['消耗品費', 20000]], [['現金', 20000]]), // 現金がマイナス
    b.j('2026-12-30', [['消耗品費', 500]], [['事業主借', 500]]),
  ];
  const ab = abnormalBalances({ accounts: b.accounts, period: b.period, journals });
  assert.deepEqual(ab.map((x) => [x.account.name, x.closing]).sort(), [['売掛金', -1000], ['現金', -20000]]);
  assert.deepEqual(futureJournals(journals, '2026-10-29').map((j) => j.date), ['2026-12-30']);
});

test('評価勘定は逆残高にしない・仮払金の残り（法人）', () => {
  const b = makeBook('corporation');
  const journals = [
    b.j('2026-03-31', [['減価償却費', 30000]], [['減価償却累計額', 30000]]),
    b.j('2026-04-01', [['仮払金', 20000]], [['現金', 20000]]),
    b.j('2026-04-02', [['現金', 50000]], [['資本金', 50000]]),
  ];
  const ab = abnormalBalances({ accounts: b.accounts, period: b.period, journals });
  assert.deepEqual(ab, []);
  assert.deepEqual(suspenseBalances({ accounts: b.accounts, period: b.period, journals }).map((x) => [x.account.name, x.closing]), [['仮払金', 20000]]);
});
