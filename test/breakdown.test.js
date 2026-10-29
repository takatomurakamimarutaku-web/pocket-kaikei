import { test } from 'node:test';
import assert from 'node:assert/strict';
import { breakdownStatements, summarize } from '../js/breakdown.js';
import { fillHints } from '../js/accounts.js';
import { breakdownCsv } from '../js/csv.js';
import { buildSample } from '../js/sample.js';
import { makeBook } from './helpers.js';

const get = (forms, id) => forms.find((f) => f.id === id);

function book() {
  const b = makeBook('corporation', {
    subs: [
      ['普通預金', 'さくら銀行 本店'],
      ['普通預金', 'みどり銀行 駅前支店'],
      ['売掛金', 'A商事'],
      ['売掛金', 'B工業'],
      ['売掛金', 'C商店'],
      ['長期借入金', '日本政策金融公庫'],
      ['支払利息', '日本政策金融公庫'],
      ['役員報酬', '山田太郎'],
      ['地代家賃', '大家不動産'],
    ],
  });
  b.opening([
    ['普通預金', 3000000, 'さくら銀行 本店'],
    ['普通預金', 500000, 'みどり銀行 駅前支店'],
    ['資本金', 3500000],
  ]);
  const journals = [
    b.j('2026-03-01', [['売掛金', 800000, null, 'A商事']], [['売上高', 800000]]),
    b.j('2026-03-01', [['売掛金', 300000, null, 'B工業']], [['売上高', 300000]]),
    b.j('2026-03-01', [['売掛金', 100000, null, 'C商店']], [['売上高', 100000]]),
    b.j('2026-04-01', [['普通預金', 2000000, null, 'さくら銀行 本店']], [['長期借入金', 2000000, null, '日本政策金融公庫']]),
    b.j('2026-05-31', [['支払利息', 12000, null, '日本政策金融公庫']], [['普通預金', 12000, null, 'さくら銀行 本店']]),
    b.j('2026-05-25', [['役員報酬', 400000, null, '山田太郎'], ['給料手当', 250000], ['賞与', 50000]], [['普通預金', 700000, null, 'さくら銀行 本店']]),
    b.j('2026-05-27', [['地代家賃', 110000, null, '大家不動産']], [['普通預金', 110000, null, 'さくら銀行 本店']]),
    b.j('2026-06-10', [['現金', 150000]], [['雑収入', 150000]], '保険金の受取'),
    b.j('2026-06-11', [['現金', 3000]], [['雑収入', 3000]], '自販機手数料'),
  ];
  return { ...b, journals };
}

test('預貯金等：補助科目（金融機関）ごとの期末残高', () => {
  const { accounts, subAccounts, period, journals } = book();
  const f = get(breakdownStatements({ accounts, subAccounts, period, journals }), 'deposits');
  assert.deepEqual(f.rows.map((r) => [r.party, r.account, r.amount]), [
    ['さくら銀行 本店', '普通預金', 3000000 + 2000000 - 12000 - 700000 - 110000],
    ['みどり銀行 駅前支店', '普通預金', 500000],
  ]);
  assert.equal(f.total, 4678000);
});

test('売掛金：50万円以上は各別、未満は「その他（N件）」。すべて表示もできる', () => {
  const { accounts, subAccounts, period, journals } = book();
  const f = get(breakdownStatements({ accounts, subAccounts, period, journals }), 'receivables');
  assert.deepEqual(f.rows.map((r) => [r.account, r.party, r.amount]), [
    ['売掛金', 'A商事', 800000],
    ['売掛金', 'その他（2件）', 400000],
  ]);
  assert.equal(f.total, 1200000);
  const all = get(breakdownStatements({ accounts, subAccounts, period, journals, showAll: true }), 'receivables');
  assert.equal(all.rows.length, 3);
});

test('借入金：期末残高と、同じ名前の支払利息の補助科目の期中の支払利子', () => {
  const { accounts, subAccounts, period, journals } = book();
  const f = get(breakdownStatements({ accounts, subAccounts, period, journals }), 'borrowings');
  assert.deepEqual(f.rows.map((r) => [r.party, r.amount, r.interest, r.memo]), [['日本政策金融公庫', 2000000, 12000, '長期借入金']]);
});

test('役員給与・人件費・地代家賃は期中の発生額', () => {
  const { accounts, subAccounts, period, journals } = book();
  const forms = breakdownStatements({ accounts, subAccounts, period, journals });
  assert.deepEqual(get(forms, 'officers').rows.map((r) => [r.party, r.amount]), [['山田太郎', 400000]]);
  assert.deepEqual(get(forms, 'personnel').rows.map((r) => [r.account, r.amount]), [['役員報酬手当', 400000], ['従業員給料手当', 300000], ['従業員賃金手当', 0]]);
  assert.deepEqual(get(forms, 'rent').rows.map((r) => [r.party, r.amount]), [['大家不動産', 110000]]);
});

test('雑益・雑損失：10万円以上の仕訳は1件ずつ、未満はまとめる', () => {
  const { accounts, subAccounts, period, journals } = book();
  const f = get(breakdownStatements({ accounts, subAccounts, period, journals }), 'misc');
  assert.deepEqual(f.rows.map((r) => [r.account, r.memo, r.party, r.amount]), [
    ['雑収入', '保険金の受取', '', 150000],
    ['雑収入', '', 'その他（1件）', 3000],
  ]);
});

test('summarize：基準0ならそのまま、科目の列があれば科目ごとにまとめる', () => {
  const rows = [{ account: 'X', amount: 1 }, { account: 'Y', amount: 2 }];
  assert.equal(summarize(rows, 0), rows);
  const cols = [{ key: 'account' }, { key: 'amount', num: true }];
  assert.deepEqual(summarize(rows, 10, 'amount', cols).map((r) => [r.account, r.party, r.amount]), [['X', 'その他（1件）', 1], ['Y', 'その他（1件）', 2]]);
});

test('目印を後から増やしても、既存の法人の科目にコードで補われる', () => {
  const { accounts } = makeBook('corporation');
  const old = accounts.map((a) => (a.code === '306' ? { ...a, hint: null } : a));
  const changed = fillHints('corporation', old);
  assert.deepEqual(changed.map((a) => [a.code, a.hint]), [['306', 'deposits_received']]);
});

test('法人のサンプルデータで内訳書とCSVが作れる', () => {
  const data = buildSample('corporation');
  const period = data.periods[0];
  const forms = breakdownStatements({ accounts: data.accounts, subAccounts: data.subAccounts, period, journals: data.journals });
  assert.ok(get(forms, 'deposits').rows.length > 0);
  const csv = breakdownCsv(forms.filter((f) => f.rows.length));
  assert.match(csv, /① 預貯金等の内訳書/);
});
