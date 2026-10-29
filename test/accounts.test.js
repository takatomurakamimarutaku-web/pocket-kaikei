import { test } from 'node:test';
import assert from 'node:assert/strict';
import { templateAccounts, GROUP_BY_ID, REQUIRED_ROLES, groupsFor, validateAccount, isContra, findByRole } from '../js/accounts.js';
import { isTaxCategory } from '../js/tax.js';

for (const entity of ['individual', 'corporation']) {
  test(`テンプレート（${entity}）：コード・名前が重複せず、区分・税区分が正しく、必須の役割がそろう`, () => {
    const list = templateAccounts(entity);
    assert.equal(new Set(list.map((a) => a.code)).size, list.length);
    assert.equal(new Set(list.map((a) => a.name)).size, list.length);
    const allowed = new Set(groupsFor(entity).map((g) => g.id));
    for (const a of list) {
      assert.ok(allowed.has(a.group), `${a.name} の区分 ${a.group}`);
      assert.ok(isTaxCategory(a.defaultTaxCategory), a.name);
    }
    for (const role of REQUIRED_ROLES[entity]) assert.ok(findByRole(list, role), role);
  });
}

test('評価勘定は残高側が区分と逆', () => {
  const corp = templateAccounts('corporation');
  const contra = corp.filter(isContra).map((a) => a.name).sort();
  assert.deepEqual(contra, ['期末商品棚卸高', '減価償却累計額', '貸倒引当金'].sort());
  assert.equal(corp.find((a) => a.name === '減価償却累計額').normalSide, 'credit');
  assert.equal(GROUP_BY_ID.tangible_fixed_assets.side, 'debit');
});

test('個人のテンプレート：事業主貸・事業主借・元入金、専従者給与を持ち、法人の区分は使わない', () => {
  const ind = templateAccounts('individual');
  assert.equal(findByRole(ind, 'owner_drawings').group, 'owner_drawings');
  assert.equal(findByRole(ind, 'owner_borrowings').normalSide, 'credit');
  assert.ok(ind.some((a) => a.group === 'family_salary'));
  assert.ok(!ind.some((a) => a.group === 'income_taxes' || a.group === 'non_operating_income'));
});

test('validateAccount：コード重複・区分の誤り・役割科目の変更を拒否する', () => {
  const others = [{ id: 'a', code: '100' }];
  assert.ok(validateAccount({ id: 'b', code: '100', name: 'X', group: 'sga', normalSide: 'debit' }, others, { entityType: 'corporation' }).code);
  assert.ok(validateAccount({ id: 'b', code: 'A1', name: 'X', group: 'sga', normalSide: 'debit' }, others, { entityType: 'corporation' }).code);
  assert.ok(validateAccount({ id: 'b', code: '900', name: '', group: 'sga', normalSide: 'debit' }, others, { entityType: 'corporation' }).name);
  assert.ok(validateAccount({ id: 'b', code: '900', name: 'X', group: 'family_salary', normalSide: 'debit' }, others, { entityType: 'corporation' }).group, '法人は専従者給与の区分を使えない');
  assert.deepEqual(validateAccount({ id: 'b', code: '900', name: 'X', group: 'sga', normalSide: 'debit' }, others, { entityType: 'corporation' }), {});
  const before = { id: 'c', code: '410', name: '元入金', group: 'equity', normalSide: 'credit', role: 'owner_capital', active: true };
  assert.ok(validateAccount({ ...before, group: 'current_liabilities' }, [], { entityType: 'individual' }, before).group);
  assert.ok(validateAccount({ ...before, active: false }, [], { entityType: 'individual' }, before).active);
  assert.deepEqual(validateAccount({ ...before, name: '元入金（変更）' }, [], { entityType: 'individual' }, before), {}, '名前は変えられる');
  const used = { id: 'd', code: '613', name: '消耗品費', group: 'sga', normalSide: 'debit', role: null };
  assert.ok(validateAccount({ ...used, group: 'cost_of_sales' }, [], { entityType: 'corporation', used: true }, used).group);
  assert.deepEqual(validateAccount({ ...used, group: 'cost_of_sales' }, [], { entityType: 'corporation', used: false }, used), {});
});
