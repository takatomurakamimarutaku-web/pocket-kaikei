import { test } from 'node:test';
import assert from 'node:assert/strict';
import { QUICK_TEMPLATES, QUICK_BY_ID, quickTemplatesFor, slotCandidates, quickDefaults, buildQuickLines, simplePair, isCashAccount } from '../js/quick.js';
import { fillHints, findByHint, HINTS, templateAccounts, TEMPLATES } from '../js/accounts.js';
import { validateJournal } from '../js/journal.js';
import { firstNegativeDate } from '../js/ledger.js';
import { createJournal } from '../js/models.js';
import { makeBook } from './helpers.js';

const names = (list) => list.map((a) => a.name);

test('テンプレートの目印：個人・法人とも使う目印の科目がそろい、1科目ずつ', () => {
  for (const entityType of ['individual', 'corporation']) {
    const accounts = templateAccounts(entityType);
    for (const hint of Object.keys(HINTS)) {
      const hits = accounts.filter((a) => a.hint === hint);
      if (hint === 'officer_loan' && entityType === 'individual') assert.equal(hits.length, 0);
      else assert.equal(hits.length, 1, `${entityType} ${hint}`);
    }
  }
});

test('すべての取引の種類で、両方の枠に候補の科目がある（個人・法人）', () => {
  for (const entityType of ['individual', 'corporation']) {
    const { accounts, byName } = makeBook(entityType);
    for (const t of quickTemplatesFor(entityType, { menu: false })) {
      for (const side of ['debit', 'credit']) {
        const c = slotCandidates(t[side], accounts, byName['現金'].id);
        assert.ok(c.length > 0, `${entityType} ${t.id} ${side}`);
      }
    }
  }
});

test('種類の絞り込み：個人は事業主貸/借、法人は役員借入、出納帳用はメニューに出さない', () => {
  const ind = quickTemplatesFor('individual').map((t) => t.id);
  const corp = quickTemplatesFor('corporation').map((t) => t.id);
  assert.ok(ind.includes('owner_out') && ind.includes('owner_in') && !ind.includes('officer_in'));
  assert.ok(corp.includes('officer_in') && !corp.includes('owner_out'));
  assert.ok(!ind.includes('cash_in') && !corp.includes('cash_out'));
  assert.equal(QUICK_TEMPLATES.length, Object.keys(QUICK_BY_ID).length);
});

test('候補：経費の支払は個人なら事業主借、法人なら役員借入金を含む。仕入は棚卸高を除く', () => {
  const ind = makeBook('individual');
  const corp = makeBook('corporation');
  assert.deepEqual(names(slotCandidates(QUICK_BY_ID.expense.credit, ind.accounts)), ['現金', '当座預金', '定期預金', '普通預金', '未払金', '事業主借']);
  assert.deepEqual(names(slotCandidates(QUICK_BY_ID.expense.credit, corp.accounts)), ['現金', '小口現金', '当座預金', '普通預金', '定期預金', '未払金', '役員借入金']);
  assert.deepEqual(names(slotCandidates(QUICK_BY_ID.purchase.debit, corp.accounts)), ['仕入高']);
});

test('候補：無効の科目は出さない。科目名を変えても目印で見つかる', () => {
  const { accounts, byName } = makeBook('individual');
  byName['当座預金'].active = false;
  byName['売掛金'].name = '未収の売上';
  const c = names(slotCandidates(QUICK_BY_ID.sale.debit, accounts));
  assert.ok(!c.includes('当座預金'));
  assert.ok(c.includes('未収の売上'));
});

test('初期値：前回の科目 → 目印 → 候補の先頭。経費の科目は空欄', () => {
  const { accounts, byName } = makeBook('individual');
  assert.deepEqual(quickDefaults(QUICK_BY_ID.sale, accounts), { debit: byName['現金'].id, credit: byName['売上高'].id });
  assert.deepEqual(quickDefaults(QUICK_BY_ID.expense, accounts), { debit: '', credit: byName['現金'].id });
  const last = { debit: byName['通信費'].id, credit: byName['普通預金'].id };
  assert.deepEqual(quickDefaults(QUICK_BY_ID.expense, accounts, { last }), last);
  // 前回の科目が無効になっていたら使わない
  byName['通信費'].active = false;
  assert.equal(quickDefaults(QUICK_BY_ID.expense, accounts, { last }).debit, '');
});

test('初期値：預金の預け入れは借方と貸方を別の科目にする。出納帳は口座を固定する', () => {
  const { accounts, byName } = makeBook('corporation');
  const d = quickDefaults(QUICK_BY_ID.transfer, accounts);
  assert.equal(d.debit, byName['現金'].id);
  assert.equal(d.credit, byName['小口現金'].id);
  const fixedId = byName['普通預金'].id;
  assert.deepEqual(quickDefaults(QUICK_BY_ID.cash_in, accounts, { fixedId }), { debit: fixedId, credit: '' });
  assert.deepEqual(quickDefaults(QUICK_BY_ID.cash_out, accounts, { fixedId, last: { credit: byName['現金'].id } }), { debit: '', credit: fixedId });
});

test('buildQuickLines：2行の仕訳になり、validateJournal を通る', () => {
  const { accounts, subAccounts, period, byName } = makeBook('individual');
  const { lines, errors } = buildQuickLines({
    amount: '1,100',
    memo: ' 電車代 ',
    debit: { accountId: byName['旅費交通費'].id, taxCategory: 'purchase_10' },
    credit: { accountId: byName['現金'].id, taxCategory: 'none' },
  });
  assert.deepEqual(errors, []);
  assert.deepEqual(
    lines.map((l) => [l.side, l.accountId, l.amount, l.taxCategory, l.memo]),
    [
      ['debit', byName['旅費交通費'].id, 1100, 'purchase_10', '電車代'],
      ['credit', byName['現金'].id, 1100, 'none', '電車代'],
    ],
  );
  const j = createJournal({ periodId: period.id, date: '2026-03-01', lines });
  assert.deepEqual(validateJournal(j, { accounts, subAccounts, period }), []);
});

test('buildQuickLines：金額の誤り・科目なし・同じ科目を拒否する（補助科目が違えばよい）', () => {
  const { byName, subAccounts } = makeBook('individual', { subs: [['普通預金', 'A銀行'], ['普通預金', 'B銀行']] });
  const cash = { accountId: byName['現金'].id };
  assert.match(buildQuickLines({ amount: '12.5', debit: cash, credit: { accountId: byName['普通預金'].id } }).errors[0], /金額/);
  assert.match(buildQuickLines({ amount: '0', debit: cash, credit: { accountId: byName['普通預金'].id } }).errors[0], /金額/);
  assert.deepEqual(buildQuickLines({ amount: '100', debit: cash, credit: {} }).errors, ['貸方の科目を選んでください']);
  assert.deepEqual(buildQuickLines({ amount: '100', debit: cash, credit: cash }).errors, ['借方と貸方に同じ科目は使えません']);
  const bank = byName['普通預金'].id;
  const [a, b] = subAccounts;
  assert.deepEqual(buildQuickLines({ amount: '100', debit: { accountId: bank, subAccountId: a.id }, credit: { accountId: bank, subAccountId: b.id } }).errors, []);
});

test('simplePair：借方1行・貸方1行だけ組にする', () => {
  const { j } = makeBook('individual');
  assert.ok(simplePair(j('2026-01-05', [['現金', 1000]], [['売上高', 1000]]).lines));
  assert.equal(simplePair(j('2026-01-05', [['現金', 900], ['支払手数料', 100]], [['売上高', 1000]]).lines), null);
});

test('isCashAccount：役割が現金・預金の科目だけ', () => {
  const { byName } = makeBook('corporation');
  assert.ok(isCashAccount(byName['小口現金']) && isCashAccount(byName['定期預金']));
  assert.ok(!isCashAccount(byName['売掛金']) && !isCashAccount(null));
});

test('fillHints：目印の導入前の科目にコードで補い、2回目は何もしない', () => {
  for (const entityType of ['individual', 'corporation']) {
    const { accounts } = makeBook(entityType);
    for (const a of accounts) delete a.hint;
    // 利用者が追加した科目（template:false）は対象外
    accounts.push({ id: 'x', code: '999', name: '自分の科目', group: 'sga', template: false });
    const filled = fillHints(entityType, accounts);
    assert.equal(filled.length, TEMPLATES[entityType].length);
    const merged = accounts.map((a) => filled.find((f) => f.id === a.id) || a);
    assert.equal(findByHint(merged, 'receivable').name, '売掛金');
    assert.equal(findByHint(merged, 'sales').name, '売上高');
    assert.equal(merged.find((a) => a.id === 'x').hint, undefined);
    assert.deepEqual(fillHints(entityType, merged), []);
  }
});

test('fillHints：既に同じ目印を持つ科目があれば重ねて付けない', () => {
  const { accounts, byName } = makeBook('individual');
  delete byName['売掛金'].hint;
  byName['未収入金'].hint = 'receivable';
  const filled = fillHints('individual', accounts);
  assert.deepEqual(filled.map((a) => [a.name, a.hint]), [['売掛金', null]]);
});

test('firstNegativeDate：日末の残高がマイナスの最初の日。同じ日に入金があれば問題にしない', () => {
  const { accounts, period, byName, j, opening } = makeBook('individual');
  opening([['現金', 1000]]);
  const cash = byName['現金'].id;
  const journals = [
    j('2026-02-01', [['消耗品費', 1500]], [['現金', 1500]]),
    j('2026-02-01', [['現金', 2000]], [['売上高', 2000]]),
    j('2026-03-01', [['消耗品費', 2000]], [['現金', 2000]]),
    j('2026-03-05', [['現金', 5000]], [['売上高', 5000]]),
  ];
  assert.equal(firstNegativeDate({ accountId: cash, accounts, period, journals }), '2026-03-01');
  assert.equal(firstNegativeDate({ accountId: cash, accounts, period, journals: journals.slice(0, 2) }), null);
  opening([['現金', 0]]);
  assert.equal(firstNegativeDate({ accountId: cash, accounts, period, journals: [] }), null);
});
