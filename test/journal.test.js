import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validateJournal, journalTotals, rowsToLines, linesToRows, rowsTotals, emptyRow, memoCandidates, matchJournal, copyForNew } from '../js/journal.js';
import { normalize } from '../js/search.js';
import { makeBook } from './helpers.js';

const book = () => makeBook('corporation', { subs: [['普通預金', 'A銀行'], ['売掛金', '甲社']] });

test('貸借一致の仕訳は通り、一致しない仕訳は差額付きで拒否する', () => {
  const b = book();
  const ok = b.j('2026-01-10', [['消耗品費', 1100]], [['現金', 1100]]);
  assert.deepEqual(validateJournal(ok, b), []);
  const ng = b.j('2026-01-10', [['消耗品費', 1100]], [['現金', 1000]]);
  assert.match(validateJournal(ng, b).join(), /一致しません（差額 100円）/);
  assert.deepEqual(journalTotals(ng.lines), { debit: 1100, credit: 1000, diff: 100 });
});

test('複合仕訳（借方2行・貸方1行）を受け付ける', () => {
  const b = book();
  const jn = b.j('2026-02-01', [['消耗品費', 1100], ['通信費', 2200]], [['普通預金', 3300, undefined, 'A銀行']]);
  assert.deepEqual(validateJournal(jn, b), []);
});

test('片側だけ・金額不正・期間外・無効科目・他科目の補助・不正な税区分を拒否する', () => {
  const b = book();
  const onlyDebit = b.j('2026-01-10', [['現金', 100]], []);
  assert.match(validateJournal(onlyDebit, b).join(), /貸方を1行以上/);
  const zero = b.j('2026-01-10', [['現金', 0]], [['売上高', 0]]);
  assert.match(validateJournal(zero, b).join(), /1円以上/);
  const frac = b.j('2026-01-10', [['現金', 10.5]], [['売上高', 10.5]]);
  assert.match(validateJournal(frac, b).join(), /整数/);
  const outside = b.j('2027-01-01', [['現金', 100]], [['売上高', 100]]);
  assert.match(validateJournal(outside, b).join(), /会計期間内/);
  b.byName['雑費'].active = false;
  const inactive = b.j('2026-01-10', [['雑費', 100]], [['現金', 100]]);
  assert.match(validateJournal(inactive, b).join(), /無効/);
  assert.deepEqual(validateJournal(inactive, { ...b, original: inactive }), [], '元から使っていた明細の編集は可');
  const wrongSub = b.j('2026-01-10', [['現金', 100]], [['売上高', 100]]);
  wrongSub.lines[0].subAccountId = b.subAccounts[0].id; // 普通預金の補助を現金に
  assert.match(validateJournal(wrongSub, b).join(), /補助科目/);
  const badTax = b.j('2026-01-10', [['現金', 100, 'xxx']], [['売上高', 100]]);
  assert.match(validateJournal(badTax, b).join(), /税区分/);
});

test('振替伝票の行⇔明細の変換、空の側は捨て、金額の誤りは行番号付き', () => {
  const b = book();
  const rows = [
    { debit: { accountId: b.byName['消耗品費'].id, subAccountId: '', amount: '1,100', taxCategory: 'purchase_10' }, credit: { accountId: b.byName['現金'].id, subAccountId: '', amount: '１１００', taxCategory: 'none' }, memo: ' 文具 ' },
    emptyRow(),
  ];
  const { lines, errors } = rowsToLines(rows);
  assert.deepEqual(errors, []);
  assert.equal(lines.length, 2);
  assert.equal(lines[1].amount, 1100);
  assert.equal(lines[0].memo, '文具');
  assert.deepEqual(rowsTotals(rows), { debit: 1100, credit: 1100, diff: 0 });
  const back = linesToRows(lines);
  assert.equal(back.length, 1);
  assert.equal(back[0].debit.amount, '1100');
  assert.equal(back[0].memo, '文具');
  const bad = rowsToLines([{ ...rows[0], debit: { ...rows[0].debit, amount: '1.5' } }]);
  assert.match(bad.errors[0], /^1行目（借方）：.*1円単位/);
});

test('摘要の候補：使用回数順、同数なら新しい順。直近の明細を返す', () => {
  const b = book();
  const js = [
    b.j('2026-01-05', [['通信費', 5000]], [['普通預金', 5000]], '携帯電話代'),
    b.j('2026-01-10', [['消耗品費', 800]], [['現金', 800]], '文具'),
    b.j('2026-02-05', [['通信費', 5200]], [['普通預金', 5200]], '携帯電話代'),
    b.j('2026-02-07', [['旅費交通費', 300]], [['現金', 300]], '電車代'),
  ];
  const c = memoCandidates(js);
  assert.deepEqual(c.map((x) => x.memo), ['携帯電話代', '電車代', '文具']);
  assert.equal(c[0].count, 2);
  assert.equal(c[0].lines[0].amount, 5200);
});

test('仕訳帳の検索：摘要・科目名・補助科目名・金額', () => {
  const b = book();
  const jn = b.j('2026-03-01', [['売掛金', 110000, 'none', '甲社']], [['売上高', 110000]], '３月分 請求');
  const ctx = { accountById: new Map(b.accounts.map((a) => [a.id, a])), subById: new Map(b.subAccounts.map((s) => [s.id, s])), normalize };
  assert.ok(matchJournal(jn, '3月分', ctx));
  assert.ok(matchJournal(jn, '売上', ctx));
  assert.ok(matchJournal(jn, '甲社', ctx));
  assert.ok(matchJournal(jn, '110,000', ctx));
  assert.ok(!matchJournal(jn, '1100', ctx));
  assert.ok(!matchJournal(jn, '乙社', ctx));
  assert.ok(matchJournal(jn, '', ctx));
});

test('複製は明細だけを写し、元の仕訳と共有しない', () => {
  const b = book();
  const jn = b.j('2026-03-01', [['現金', 100]], [['売上高', 100]]);
  const copy = copyForNew(jn);
  copy.lines[0].amount = 999;
  assert.equal(jn.lines[0].amount, 100);
  assert.equal(copy.id, undefined);
});
