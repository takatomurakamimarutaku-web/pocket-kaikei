import { test } from 'node:test';
import assert from 'node:assert/strict';
import { familyCompany, validateShareholders, formatRatio } from '../js/family-company.js';
import { schedule2Blocks } from '../js/print-tax-forms.js';
import { layoutDocument } from '../js/print-layout.js';

const holder = (name, shares, extra = {}) => ({ name, address: '東京都', relation: '本人', group: '', shares, votes: null, corporate: false, ...extra });

test('別表二：親族をまとめた上位3グループが50%超なら同族会社、上位1グループの割合も出す', () => {
  const fc = familyCompany({
    sharesTotal: 1000,
    sme: true,
    shareholders: [
      holder('山田太郎', 300),
      holder('山田花子', 100, { relation: '妻', group: '山田太郎' }),
      holder('佐藤一郎', 150),
      holder('鈴木商事株式会社', 100, { corporate: true }),
      holder('田中次郎', 50),
      holder('高橋三郎', 300),
    ],
  });
  const f = fc.fields;
  assert.equal(f[1], 1000);
  // グループ：山田(400)・高橋(300)・佐藤(150)・鈴木(100)・田中(50)
  assert.equal(f[2], 850);
  assert.equal(f[3], 85000);
  assert.equal(f[11], 400);
  assert.equal(f[12], 40000);
  assert.equal(f[10], 85000);
  assert.equal(f[18], '同族会社');
  assert.equal(formatRatio(f[10]), '85.0%');
  // 明細：グループの順位は最初の行だけ、本人が先
  assert.equal(fc.rows[0].name, '山田太郎');
  assert.equal(fc.rows[0].sharesRank, 1);
  assert.equal(fc.rows[1].name, '山田花子');
  assert.equal(fc.rows[1].sharesRank, null);
  assert.equal(fc.rows[2].name, '高橋三郎');
});

test('別表二：上位3グループが50%以下なら非同族会社。議決権の数が別なら議決権でも判定し、高いほう', () => {
  const many = Array.from({ length: 10 }, (_, i) => holder(`株主${i + 1}`, 100));
  assert.equal(familyCompany({ shareholders: many, sharesTotal: 1000 }).fields[18], '非同族会社');
  // 株式数では30%だが、議決権の無い株式があり議決権では60%
  const fc = familyCompany({ shareholders: [holder('A', 300, { votes: 300 }), ...Array.from({ length: 7 }, (_, i) => holder(`B${i}`, 100, { votes: 30 }))], sharesTotal: 1000, votesTotal: 510 });
  assert.equal(fc.fields[3], 30000 + 20000);
  assert.ok(fc.fields[6] > fc.fields[3]);
  assert.equal(fc.fields[10], fc.fields[6]);
});

test('別表二：上位1グループが50%超でも、資本金1億円以下（中小法人）は特定同族会社にならない', () => {
  const list = [holder('A', 600), holder('B', 400)];
  assert.equal(familyCompany({ shareholders: list, sme: true }).fields[18], '同族会社');
  assert.equal(familyCompany({ shareholders: list, sme: false }).fields[18], '特定同族会社');
  // (11) は (21)「その他の株主等」の上位1順位：被支配会社でない法人株主は特定同族会社の判定に入れない
  const corp = familyCompany({ shareholders: [holder('親会社', 600, { corporate: true }), holder('B', 400)], sme: false });
  assert.equal(corp.fields[11], 400);
  assert.equal(corp.fields[18], '同族会社');
  // 50%ちょうどは超えていない
  assert.equal(familyCompany({ shareholders: [holder('A', 500), ...Array.from({ length: 10 }, (_, i) => holder(`B${i}`, 50))], sme: false }).fields[18], '同族会社');
});

test('別表二の入力の検証：株主名は必須、株式数は整数、合計が総数を超えない', () => {
  assert.deepEqual(validateShareholders({ shareholders: [holder('A', 10)], sharesTotal: 10 }), []);
  assert.ok(validateShareholders({ shareholders: [holder('', 10)] }).length);
  assert.ok(validateShareholders({ shareholders: [holder('A', 1.5)] }).length);
  assert.ok(validateShareholders({ shareholders: [holder('A', 11)], sharesTotal: 10 }).some((e) => /超え/.test(e)));
});

test('別表二の印刷：判定の欄と株主の明細が1枚に収まり、株主が無くても空欄で出る', () => {
  const fc = familyCompany({ shareholders: [holder('山田太郎', 800), holder('鈴木商事株式会社', 200, { corporate: true })], sharesTotal: 1000 });
  const blocks = schedule2Blocks(fc);
  const pages = layoutDocument({ title: 'x', blocks, taxForm: { from: '2026-04-01', to: '2027-03-31', name: 'テスト' } });
  assert.equal(pages.length, 1);
  const detail = blocks.find((b) => b.type === 'table' && b.columns.length === 9);
  // 被支配会社でない法人株主は (19)(20)、その他は (21)(22)
  const corp = detail.rows.find((r) => r.cells[3] === '鈴木商事株式会社');
  assert.equal(corp.cells[5], '200');
  assert.equal(corp.cells[7], '');
  const empty = familyCompany({ shareholders: [] });
  assert.equal(empty.entered, false);
  assert.equal(layoutDocument({ title: 'x', blocks: schedule2Blocks(empty) }).length, 1);
});
