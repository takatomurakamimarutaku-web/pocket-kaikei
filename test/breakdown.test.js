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

test('⑫・⑮：選んだ科目（補助科目）の仕訳から作る。⑬は売上高と期末棚卸高の合計の1行', async () => {
  const { makeBook } = await import('./helpers.js');
  const b = makeBook('corporation', { startDate: '2026-04-01', endDate: '2027-03-31', subs: [['売上高', '土地売上'], ['売上高', '一般'], ['支払手数料', '特許事務所'], ['支払手数料', '銀行']] });
  const sub = (name) => b.subAccounts.find((s) => s.name === name).id;
  const journals = [
    b.j('2026-05-10', [['普通預金', 30000000]], [['売上高', 30000000, 'sales_exempt', '土地売上']], '分譲地A区画 山田'),
    b.j('2026-08-20', [['普通預金', 50000000]], [['売上高', 50000000, 'sales_exempt', '土地売上']], '分譲地B区画 佐藤'),
    b.j('2026-06-01', [['普通預金', 2000000]], [['売上高', 2000000, null, '一般']], '一般の売上'),
    b.j('2026-07-01', [['支払手数料', 110000, null, '特許事務所']], [['普通預金', 110000]], '商標権の使用料 7月分'),
    b.j('2026-10-01', [['支払手数料', 110000, null, '特許事務所']], [['普通預金', 110000]], '商標権の使用料 10月分'),
    b.j('2026-07-02', [['支払手数料', 660, null, '銀行']], [['普通預金', 660]], '振込手数料'),
    b.j('2026-09-01', [['地代家賃', 300000]], [['普通預金', 300000]], '事務所の更新料'),
    b.j('2027-03-31', [['商品', 1200000]], [['期末商品棚卸高', 1200000]], '期末棚卸'),
  ];
  const targets = {
    land_sales: [{ accountId: b.byName['売上高'].id, subAccountId: sub('土地売上') }],
    royalties: [{ accountId: b.byName['支払手数料'].id, subAccountId: sub('特許事務所') }],
    rights: [{ accountId: b.byName['地代家賃'].id, subAccountId: null }, { accountId: b.byName['普通預金'].id, subAccountId: null }], // 選べない区分の科目は除く
  };
  const forms = breakdownStatements({ accounts: b.accounts, subAccounts: b.subAccounts, period: b.period, journals, targets });
  const land = get(forms, 'land_sales');
  assert.equal(land.no, '⑫');
  assert.deepEqual(land.rows.map((r) => [r.month, r.party, r.amount]), [['2026/08', '土地売上', 50000000], ['2026/05', '土地売上', 30000000]]);
  assert.equal(land.total, 80000000);
  const offices = get(forms, 'offices');
  assert.deepEqual(offices.rows, [{ party: '本店', amount: 82000000, inventory: 1200000, memo: '' }]);
  const rights = get(forms, 'rights');
  assert.deepEqual(rights.rows.map((r) => [r.date, r.memo, r.amount]), [['2026/09/01', '事務所の更新料', 300000]]);
  const roy = get(forms, 'royalties');
  assert.deepEqual(roy.rows, [{ name: '商標権の使用料 7月分', party: '特許事務所', amount: 220000, memo: '支払手数料' }]);
  // 並び：⑪の次に⑫⑬、地代家賃の次に⑮の2つ
  const ids = forms.map((f) => f.id);
  assert.deepEqual(ids.slice(ids.indexOf('borrowings'), ids.indexOf('borrowings') + 3), ['borrowings', 'land_sales', 'offices']);
  assert.deepEqual(ids.slice(ids.indexOf('rent'), ids.indexOf('rent') + 3), ['rent', 'rights', 'royalties']);
  // 対象を選んでいなければ空
  const none = breakdownStatements({ accounts: b.accounts, subAccounts: b.subAccounts, period: b.period, journals });
  assert.deepEqual(get(none, 'land_sales').rows, []);
  assert.match(get(none, 'rights').note, /対象の科目を選ぶと/);
  assert.match(breakdownCsv([land]), /⑫ 土地の売上高等の内訳書/);
});

test('内訳書の対象の科目：設定に保存し（バックアップに入る）、形の誤りは保存も読み込みもしない', async () => {
  const { IDBFactory } = await import('fake-indexeddb');
  const { openDB, ValidationError } = await import('../js/db.js');
  const { createAccount, createPeriod, createSettings } = await import('../js/models.js');
  const { templateAccounts } = await import('../js/accounts.js');
  const { createBackup, parseBackup, BackupError } = await import('../js/backup.js');
  const { validateBreakdownTargets, cleanBreakdownTargets } = await import('../js/breakdown.js');

  assert.equal(validateBreakdownTargets(undefined), null);
  assert.equal(validateBreakdownTargets({ royalties: [{ accountId: 'a', subAccountId: null }] }), null);
  assert.match(validateBreakdownTargets({ unknown: [] }), /正しくありません/);
  assert.match(validateBreakdownTargets({ rights: [{ accountId: '' }] }), /正しくありません/);
  assert.match(validateBreakdownTargets({ rights: 'x' }), /正しくありません/);

  const repo = await openDB({ indexedDB: new IDBFactory() });
  const accounts = templateAccounts('corporation').map((a) => createAccount(a));
  const period = createPeriod({ startDate: '2026-04-01', endDate: '2027-03-31' });
  await repo.setup({ settings: createSettings({ businessName: 'テスト株式会社', entityType: 'corporation' }), period, accounts });
  const fee = accounts.find((a) => a.name === '支払手数料');
  const saved = await repo.saveBreakdownTargets({ royalties: [{ accountId: fee.id }] });
  assert.deepEqual(saved.breakdownTargets, { royalties: [{ accountId: fee.id, subAccountId: null }] });
  await assert.rejects(repo.saveBreakdownTargets({ royalties: [{ subAccountId: 'x' }] }), ValidationError);
  assert.deepEqual((await repo.getSettings()).breakdownTargets, { royalties: [{ accountId: fee.id, subAccountId: null }] });

  // バックアップに入り、復元すると戻る。消えた科目は使うときに外す
  const data = await repo.dumpAll();
  const back = parseBackup(JSON.stringify(createBackup(data, { appVersion: 'test' })));
  assert.deepEqual(back.settings.breakdownTargets, { royalties: [{ accountId: fee.id, subAccountId: null }] });
  assert.deepEqual(cleanBreakdownTargets(back.settings.breakdownTargets, { accounts: accounts.filter((a) => a.id !== fee.id) }).royalties, []);
  const broken = createBackup(data, { appVersion: 'test' });
  broken.settings.breakdownTargets = { royalties: [{ accountId: 1 }] };
  assert.throws(() => parseBackup(JSON.stringify(broken)), (e) => e instanceof BackupError && /内訳書の対象/.test(e.message));
  repo.close();
});
