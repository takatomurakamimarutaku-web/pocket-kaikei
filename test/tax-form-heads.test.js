import { test } from 'node:test';
import assert from 'node:assert/strict';
import { IDBFactory } from 'fake-indexeddb';
import { openDB, ValidationError } from '../js/db.js';
import { templateAccounts } from '../js/accounts.js';
import { createAccount, createPeriod, createSettings } from '../js/models.js';
import { cleanFiler, validateFiler, isValidCorporateNumber, filerOf, filerFields, hasFiler } from '../js/filer.js';
import { corporateTaxReturn, standardPerCapita, validateCorporateTax, cleanCorporateTax } from '../js/corporate-tax.js';
import { corporateTaxDoc, localFormRows, consumptionTaxDoc } from '../js/print-tax-forms.js';
import { formHeadBlock, settlementHead } from '../js/print-form-heads.js';
import { layoutDocument } from '../js/print-layout.js';
import { computeTaxReturn } from '../js/tax-return.js';
import { taxReturnForms } from '../js/tax-forms.js';
import { buildSample } from '../js/sample.js';
import { createBackup, parseBackup } from '../js/backup.js';

const textOf = (c) => (c && typeof c === 'object' && !Array.isArray(c) ? c.text : c);
const cellsText = (block) => block.rows.flatMap((r) => r.cells.map(textOf)).join('|');

test('法人番号の検査用数字：国税庁の計算例（700110005901 → 8700110005901）と、桁数・数字の誤り', () => {
  assert.equal(isValidCorporateNumber('8700110005901'), true);
  assert.equal(isValidCorporateNumber('1700110005901'), false);
  assert.equal(isValidCorporateNumber('870011000590'), false);
  assert.equal(isValidCorporateNumber('870011000590a'), false);
});

test('提出者の欄：全角の数字・ハイフンを半角に、郵便番号は3桁-4桁に、知らない項目は捨てる', () => {
  const f = cleanFiler({ zip: '１０２００８３', corporateNumber: '８７００ １１０ ００５９０１', phone: '０３－１２３４－５６７８', address: ' 東京都 ', evil: '<script>' });
  assert.equal(f.zip, '102-0083');
  assert.equal(f.corporateNumber, '8700110005901');
  assert.equal(f.phone, '03-1234-5678');
  assert.equal(f.address, '東京都');
  assert.equal('evil' in f, false);
  assert.deepEqual(validateFiler(f), {});
  assert.ok(validateFiler({ ...f, corporateNumber: '1234567890123' }).corporateNumber);
  assert.ok(validateFiler({ ...f, zip: '12-345' }).zip);
  assert.ok(validateFiler({ ...f, address: 'あ'.repeat(81) }).address);
  // 法人と個人で欄が違う（マイナンバーの欄は無い）
  const keys = (t) => filerFields(t).map((x) => x.key);
  assert.ok(keys('corporation').includes('corporateNumber'));
  assert.ok(!keys('individual').includes('corporateNumber'));
  assert.ok(keys('individual').includes('ownerName'));
  assert.ok(!keys('individual').some((k) => /my|個人番号/i.test(k)));
  // 屋号が空なら事業者名
  assert.equal(filerOf({ businessName: 'ポケット商店', entityType: 'individual', filer: {} }).tradeName, 'ポケット商店');
  assert.equal(hasFiler({ filer: { address: '' } }), false);
  assert.equal(hasFiler({ filer: { address: '東京' } }), true);
});

test('提出者の欄の保存：検証して設定に保存し、バックアップに入る。誤りは保存しない', async () => {
  const repo = await openDB({ indexedDB: new IDBFactory() });
  const accounts = templateAccounts('corporation').map((a) => createAccount(a));
  await repo.setup({ settings: createSettings({ businessName: 'テスト株式会社', entityType: 'corporation' }), period: createPeriod({ startDate: '2026-04-01', endDate: '2027-03-31' }), accounts });
  const saved = await repo.saveFiler({ taxOffice: '麹町', corporateNumber: '8700110005901', zip: '1020083' });
  assert.equal(saved.filer.taxOffice, '麹町');
  assert.equal(saved.filer.zip, '102-0083');
  await assert.rejects(repo.saveFiler({ corporateNumber: '1111111111111' }), ValidationError);
  assert.equal((await repo.getSettings()).filer.corporateNumber, '8700110005901');
  const back = parseBackup(JSON.stringify(createBackup(await repo.dumpAll(), { appVersion: 'test' })));
  assert.equal(back.settings.filer.taxOffice, '麹町');
});

test('均等割の標準税率：資本金等の額の区分（1,000万円以下は含む）と従業者50人超、東京23区は都と区の合計', () => {
  assert.deepEqual(standardPerCapita(10000000, 50), { pref: 20000, city: 50000 });
  assert.deepEqual(standardPerCapita(10000000, 51), { pref: 20000, city: 120000 });
  assert.deepEqual(standardPerCapita(10000001, 10), { pref: 50000, city: 130000 });
  assert.deepEqual(standardPerCapita(100000001, 100), { pref: 130000, city: 400000 });
  assert.deepEqual(standardPerCapita(5000000001, 10), { pref: 800000, city: 410000 });
  assert.deepEqual(standardPerCapita(3000000, 5, true), { pref: 70000, city: 0 });
});

function corpReturn(input = {}) {
  const s = buildSample('corporation');
  const period = s.periods[0];
  return corporateTaxReturn({ accounts: s.accounts, period, journals: s.journals, input: { ...(period.corporateTax || {}), ...input }, enterpriseInput: period.enterpriseTax || {} });
}

test('第六号様式・第二十号様式：法人税割＝課税標準×税率、納付すべき額＝法人税割＋均等割−中間納付、中間納付は均等割と法人税割に分ける', () => {
  const r = corpReturn({ interim: { corp: 0, local: 0, defense: 0, pref: 15000, city: 30000, enterprise: 0 }, interimPerCapita: { pref: 10000, city: 25000 }, employees: 8 });
  const { pref, city } = localFormRows(r);
  const at = (rows, no) => rows.find((x) => x.no === no);
  // 道府県民税：⑤課税標準・⑦法人税割額・⑬差引・⑭既に納付・⑯納付すべき法人税割額・⑱均等割・⑲・⑳・㉑
  assert.equal(at(pref, '⑤').base, r.resident.base);
  assert.equal(at(pref, '⑦').tax, r.resident.pref.taxPart);
  assert.equal(at(pref, '⑦').tax, Math.floor((r.resident.base * r.resident.pref.rate) / 100000 / 100) * 100);
  assert.equal(at(pref, '⑭').tax, 5000);
  assert.equal(at(pref, '⑲').tax, 10000);
  assert.equal(at(pref, '⑯').tax + at(pref, '⑳').tax, at(pref, '㉑').tax);
  assert.equal(at(pref, '㉑').tax, r.resident.pref.due);
  assert.equal(at(pref, '㉑').tax, r.resident.pref.total - 15000);
  // 市町村民税：⑤が課税標準と法人税割額の1行、⑮＋⑲＝⑳
  assert.equal(at(city, '⑤').tax, r.resident.city.taxPart);
  assert.equal(at(city, '⑮').tax + at(city, '⑲').tax, at(city, '⑳').tax);
  assert.equal(at(city, '⑳').tax, r.resident.city.due);
  // 事業税の所得割の区分の合計＝所得割、納める税額の一覧と一致
  const ent = r.dues.find((d) => d.key === 'enterprise');
  const dueEnt = pref.find((x) => x.label === 'この申告により納付すべき事業税額').tax + pref.find((x) => x.label === 'この申告により納付すべき特別法人事業税額').tax;
  assert.equal(dueEnt, ent.due);
  assert.equal(r.employees, 8);
  // 中間納付のうち均等割は中間納付額以下
  assert.ok(validateCorporateTax(cleanCorporateTax({ interim: { pref: 1000 }, interimPerCapita: { pref: 2000, city: 0 } })).some((e) => /均等割/.test(e)));
});

test('東京23区：市町村民税の申告書（第二十号様式）は出さず、第六号様式は都民税', () => {
  const r = corpReturn({ tokyo: true, prefRate: 7000, cityRate: 0, prefPerCapita: 70000, cityPerCapita: 0 });
  assert.equal(localFormRows(r).city, null);
  const doc = corporateTaxDoc(r, { head: {}, sheets: ['pref', 'city'] });
  const captions = doc.blocks.filter((b) => b.type === 'heading' && b.caption);
  assert.deepEqual(captions.map((b) => b.text), ['第六号様式']);
  assert.match(captions[0].title, /都民税/);
});

test('法人税申告書の印刷：提出者の欄（提出先の税務署・法人番号）を別表一の上に置き、第六号様式・第二十号様式も1枚ずつに収まる', () => {
  const r = corpReturn();
  const filer = filerOf({ businessName: 'サンプル製作所株式会社', entityType: 'corporation', filer: { taxOffice: '麹町', corporateNumber: '8700110005901', prefOffice: '千代田都税事務所長', city: '横浜市長', address: '東京都千代田区麹町1-2-3', zip: '102-0083' } });
  const doc = corporateTaxDoc(r, { head: { company: 'x' }, filer, sheets: ['s1', 'pref', 'city'] });
  const afterCaption = (label) => doc.blocks[doc.blocks.findIndex((b) => b.type === 'heading' && b.text === label) + 1];
  assert.match(cellsText(afterCaption('別表一')), /麹町税務署長殿/);
  assert.match(cellsText(afterCaption('別表一')), /8700110005901/);
  assert.match(cellsText(afterCaption('別表一')), /〒102-0083　東京都千代田区麹町1-2-3/);
  assert.match(cellsText(afterCaption('第六号様式')), /千代田都税事務所長　殿/);
  assert.match(cellsText(afterCaption('第二十号様式')), /横浜市長　殿/);
  const pages = layoutDocument(doc);
  assert.deepEqual(pages.map((p) => p.caption), ['別表一', '第六号様式', '第二十号様式']);
  // 提出者の欄が無くても印刷できる（空欄のまま）
  assert.equal(layoutDocument(corporateTaxDoc(r, { head: {}, sheets: ['pref'] })).length, 1);
});

test('消費税の申告書：第一表の上に提出者の欄、下に付記事項・参考事項（控除税額の計算方法・基準期間の課税売上高）', () => {
  const s = buildSample('corporation');
  const period = s.periods[0];
  const r = computeTaxReturn({ journals: s.journals, period, entityType: 'corporation', method: 'general', salesCalc: 'standard', purchaseCalc: 'standard', allocation: 'proportional', interimNational: 0, interimLocal: 0 });
  const forms = taxReturnForms(r, { baseSales: 12345678 });
  const remarks = Object.fromEntries(forms.first.remarks);
  assert.equal(remarks['基準期間の課税売上高'], '12,345千円');
  assert.equal(remarks['税額控除に係る経過措置の適用（2割特例）'], '無');
  assert.ok(remarks['控除税額の計算方法']);
  const filer = filerOf({ businessName: 'サンプル製作所株式会社', entityType: 'corporation', filer: { taxOffice: '麹町', corporateNumber: '8700110005901' } });
  const doc = consumptionTaxDoc(forms, { head: {}, filer, period, corporation: true, sheets: ['first'] });
  assert.match(cellsText(doc.blocks[1]), /麹町税務署長殿/);
  assert.ok(doc.blocks.some((b) => b.type === 'heading' && b.text === '付記事項・参考事項'));
});

test('頭書きの表：2組ずつ並べ、wide は1行、空の値は空欄。決算書の頭書きは住所・氏名・業種名', () => {
  const b = formHeadBlock([['A', '1'], ['B', ''], { label: 'C', value: '3', wide: true }, ['D', '4']]);
  assert.equal(b.rows.length, 3);
  assert.equal(b.rows[0].cells.length, 4);
  assert.equal(b.rows[1].cells[1].span, 3);
  assert.equal(textOf(b.rows[0].cells[3]), '');
  assert.ok(b.rows[0].cells[0].shade);
  const t = cellsText(settlementHead(filerOf({ businessName: '店', entityType: 'individual', filer: { ownerName: '山田', businessType: '小売業' } })));
  assert.match(t, /住所/);
  assert.match(t, /山田/);
  assert.match(t, /小売業/);
});
