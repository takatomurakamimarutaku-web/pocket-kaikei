import { test } from 'node:test';
import assert from 'node:assert/strict';
import zlib from 'node:zlib';
import { breakdownStatements } from '../js/breakdown.js';
import { etaxBreakdownFiles, ETAX_LAYOUTS, toEtaxZenkaku, eraFields, splitBankName } from '../js/etax-csv.js';
import { createZip, crc32 } from '../js/zip.js';
import { buildSample } from '../js/sample.js';
import { makeBook } from './helpers.js';

const sjis = (bytes) => new TextDecoder('shift_jis').decode(bytes);
const fileOf = (r, name) => r.files.find((f) => f.name === name);
const lines = (f) => f.text.split('\r\n').slice(0, -1);

function book() {
  const b = makeBook('corporation', {
    subs: [
      ['普通預金', 'さくら銀行 本店'],
      ['普通預金', 'ﾐﾄﾞﾘ銀行　駅前支店'],
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
    ['普通預金', 500000, 'ﾐﾄﾞﾘ銀行　駅前支店'],
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
    b.j('2026-06-12', [['雑損失', 120000]], [['現金', 120000]], '盗難による損失,現金'),
    b.j('2026-06-13', [['雑損失', 2000]], [['現金', 2000]], '端数'),
  ];
  return { ...b, journals };
}

test('様式ごとの項目の数は、国税庁の「レコードの内容及び留意事項」の項番の数と同じ', () => {
  // フォーマット区分・行区分を含めた項番の数（令和6年3月1日以後終了事業年度分）
  const expected = {
    deposits: ['HOI010_4.0', 8],
    notes_receivable: ['HOI020_4.0', 18],
    receivables: ['HOI030_4.0', 9],
    advances: ['HOI040_4.0', 10],
    loans: ['HOI040_4.0', 11],
    inventory: ['HOI050_4.0', 8],
    securities: ['HOI060_4.0', 18],
    real_estate: ['HOI070_5.0', 21],
    notes_payable: ['HOI080_4.0', 17],
    payables: ['HOI090_5.0', 9],
    received: ['HOI100_6.0', 10],
    borrowings: ['HOI110_3.0', 9],
    land_sales: ['HOI120_5.0', 18],
    offices: ['HOI130_5.0', 12],
    personnel: ['HOI141_5.0', 10],
    rent: ['HOI150_4.0', 19],
    rights: ['HOI150_4.0', 13],
    royalties: ['HOI150_4.0', 21],
    misc: ['HOI160_4.0', 9],
  };
  assert.deepEqual(Object.keys(ETAX_LAYOUTS).sort(), Object.keys(expected).sort());
  for (const [id, [file, count]] of Object.entries(expected)) {
    const l = ETAX_LAYOUTS[id];
    assert.equal(`${l.file}_${l.version}`, file, id);
    assert.equal(l.fields.length + 2, count, id);
    // 合計行に記録する項目は、その様式の項目にある
    for (const k of l.total || []) assert.ok(l.fields.some((f) => f.key === k), `${id} の合計行 ${k}`);
  }
});

test('帳簿から e-Tax 用の CSV を作る：様式ごとのファイル、明細行と合計行、空の項目も「,」で区切る', () => {
  const { accounts, subAccounts, period, journals } = book();
  const forms = breakdownStatements({ accounts, subAccounts, period, journals });
  const r = etaxBreakdownFiles(forms);
  assert.deepEqual(
    r.files.map((f) => f.name),
    ['HOI010_4.0.csv', 'HOI030_4.0.csv', 'HOI110_3.0.csv', 'HOI130_5.0.csv', 'HOI141_5.0.csv', 'HOI150_4.0.csv', 'HOI160_4.0.csv'],
  );
  assert.deepEqual(r.skipped, ['役員給与等の内訳書']);

  // ①預貯金：補助科目の名前を金融機関名と支店名に分け、半角カナは全角にする。合計行は期末現在高だけ
  assert.deepEqual(lines(fileOf(r, 'HOI010_4.0.csv')), ['1,0,さくら銀行,本店,普通預金,,4178000,', '1,0,ミドリ銀行,駅前支店,普通預金,,500000,', '1,1,,,,,4678000,']);
  // ③売掛金：50万円未満は「その他（N件）」にまとめた行のまま
  assert.deepEqual(lines(fileOf(r, 'HOI030_4.0.csv')), ['3,0,売掛金,,,Ａ商事,,800000,', '3,0,売掛金,,,その他（２件）,,400000,', '3,1,,,,,,1200000,']);
  // ⑪借入金：期中の支払利子額。合計行は期末現在高と支払利子額
  assert.deepEqual(lines(fileOf(r, 'HOI110_3.0.csv')), ['11,0,日本政策金融公庫,,,2000000,12000,,', '11,1,,,,2000000,12000,,']);
  // ⑬事業所別：売上高と期末棚卸高（0 も書く）
  assert.deepEqual(lines(fileOf(r, 'HOI130_5.0.csv')), ['13,0,本店,,,,,1200000,0,,,', '13,1,,,,,,1200000,0,,,']);
  // ⑭人件費：役員報酬手当・従業員給料手当・従業員賃金手当と計
  assert.deepEqual(lines(fileOf(r, 'HOI141_5.0.csv')), ['14-3,0,400000,,300000,,0,,700000,']);
  // ⑮地代家賃：摘要に科目名
  assert.deepEqual(lines(fileOf(r, 'HOI150_4.0.csv')), ['15-1,0,,,,,,大家不動産,,,,,,,,,,110000,地代家賃']);
  // ⑯雑益は 16-1、雑損失は 16-2。項目内のカンマは全角。10万円未満は科目ごとにまとめた行も、雑益・雑損失の別を保つ
  assert.deepEqual(lines(fileOf(r, 'HOI160_4.0.csv')), [
    '16-1,0,雑収入,保険金の受取,,,,,150000',
    '16-1,0,雑収入,,,,その他（１件）,,3000',
    '16-2,0,雑損失,盗難による損失，現金,,,,,120000',
    '16-2,0,雑損失,,,,その他（１件）,,2000',
  ]);
  // Shift_JIS のバイト列にして、読み戻すと同じ文字列。行の区切りは CRLF
  for (const f of r.files) {
    assert.equal(sjis(f.bytes), f.text);
    assert.ok(f.text.endsWith('\r\n'));
    assert.equal(f.records, lines(f).length);
  }
  assert.deepEqual(r.truncated, []);
  assert.deepEqual(r.unsupported, []);
});

test('全角にする：半角の英数字・記号・カナ、濁点、囲み文字。JIS第1・第2水準に無い文字は「？」にして知らせる', () => {
  assert.deepEqual(toEtaxZenkaku('ｶﾞｽ代 ABC-1,2 "x" (株)'), { text: 'ガス代　ＡＢＣ－１，２　”ｘ”　（株）', unsupported: [] });
  assert.equal(toEtaxZenkaku('㈱髙橋商店①').text, '（株）高橋商店１');
  assert.equal(toEtaxZenkaku('がき').text, 'がき'); // 濁点だけの文字は1文字にまとめる
  assert.equal(toEtaxZenkaku('1行目\n2行目').text, '１行目　２行目');
  assert.deepEqual(toEtaxZenkaku('絵文字😀・𠀋'), { text: '絵文字？・？', unsupported: ['😀', '𠀋'] });
  // Shift_JIS にはあるが JIS第1・第2水準に無い文字（IBM 拡張の「昮」）
  assert.deepEqual(toEtaxZenkaku('昮'), { text: '？', unsupported: ['昮'] });
  assert.equal(toEtaxZenkaku('').text, '');
});

test('文字数の上限を超えた欄は切り詰めて知らせる。マイナスの金額は「-」を付ける', () => {
  const forms = [
    {
      id: 'deposits',
      title: '預貯金等の内訳書',
      rows: [{ party: 'とても長い名前の信用金庫ほげほげ 本店営業部', account: '普通預金', amount: -1000, memo: '' }],
    },
  ];
  const r = etaxBreakdownFiles(forms);
  assert.deepEqual(lines(r.files[0]), ['1,0,とても長い名前の信用金,本店営業部,普通預金,,-1000,', '1,1,,,,,-1000,']);
  assert.deepEqual(r.truncated, [{ title: '預貯金等の内訳書', label: '金融機関名', value: 'とても長い名前の信用金庫ほげほげ', max: 11 }]);
});

test('明細が1ページに収まらないときは合計行を付けない（合計行で改ページするため）', () => {
  const rows = Array.from({ length: 7 }, (_, i) => ({ party: `貸付先${i + 1}`, amount: 1000000, interest: 0, memo: '短期貸付金' }));
  const r = etaxBreakdownFiles([{ id: 'loans', title: '貸付金及び受取利息の内訳書', rows }]);
  assert.equal(lines(r.files[0]).length, 7);
  assert.ok(lines(r.files[0]).every((l) => l.startsWith('4-2,0,')));
  assert.deepEqual(r.noTotal, ['貸付金及び受取利息の内訳書']);
  const six = etaxBreakdownFiles([{ id: 'loans', title: '貸付金及び受取利息の内訳書', rows: rows.slice(0, 6) }]);
  assert.equal(lines(six.files[0]).at(-1), '4-2,1,,,,,,6000000,0,,');
  // 仮払金（4-1）と貸付金（4-2）は同じファイル
  const both = etaxBreakdownFiles([
    { id: 'advances', title: '仮払金（前渡金）の内訳書', rows: [{ account: '前払金', party: 'X社', amount: 600000, memo: '' }] },
    { id: 'loans', title: '貸付金及び受取利息の内訳書', rows: rows.slice(0, 1) },
  ]);
  assert.equal(both.files.length, 1);
  assert.deepEqual(lines(both.files[0]), ['4-1,0,前払金,,,Ｘ社,,,600000,', '4-2,0,,,貸付先１,,,1000000,,,', '4-2,1,,,,,,1000000,0,,']);
});

test('元号の番号（平成4・令和5）と年月日、⑫土地の売上・⑮権利金の日付', () => {
  assert.deepEqual(eraFields('x', '2019/04/30'), { xEra: '4', xY: '31', xM: '04', xD: '30' });
  assert.deepEqual(eraFields('x', '2019/05'), { xEra: '5', xY: '1', xM: '05' });
  assert.deepEqual(eraFields('x', '2026/09/01'), { xEra: '5', xY: '8', xM: '09', xD: '01' });
  const r = etaxBreakdownFiles([
    { id: 'land_sales', title: '土地の売上高等の内訳書', rows: [{ month: '2026/08', party: '佐藤', memo: '分譲地B区画', amount: 50000000 }] },
    { id: 'rights', title: '権利金等の期中支払の内訳書', rows: [{ party: '大家不動産', date: '2026/09/01', memo: '事務所の更新料', amount: 300000 }] },
  ]);
  assert.deepEqual(lines(fileOf(r, 'HOI120_5.0.csv')), ['12,0,,,,,5,8,08,,,佐藤,,,,50000000,,']);
  assert.deepEqual(lines(fileOf(r, 'HOI150_4.0.csv')), ['15-2,0,,,大家不動産,,5,8,09,01,300000,事務所の更新料,']);
});

test('金融機関名と支店名の分け方', () => {
  assert.deepEqual(splitBankName('さくら銀行 本店'), { bank: 'さくら銀行', branch: '本店' });
  assert.deepEqual(splitBankName('みどり銀行　駅前 出張所'), { bank: 'みどり銀行', branch: '駅前 出張所' });
  assert.deepEqual(splitBankName('ゆうちょ銀行'), { bank: 'ゆうちょ銀行', branch: '' });
  assert.deepEqual(splitBankName(''), { bank: '', branch: '' });
});

test('法人のサンプルデータで e-Tax 用の CSV が作れる', () => {
  const data = buildSample('corporation');
  const forms = breakdownStatements({ accounts: data.accounts, subAccounts: data.subAccounts, period: data.periods[0], journals: data.journals });
  const r = etaxBreakdownFiles(forms);
  assert.ok(r.files.some((f) => f.name === 'HOI010_4.0.csv'));
  // どの行も、その様式の項目の数だけ区切られている
  const layoutFor = (file, code) => Object.values(ETAX_LAYOUTS).find((l) => file.startsWith(`${l.file}_`) && (typeof l.code === 'string' ? l.code === code : /^16-[12]$/.test(code)));
  for (const f of r.files) for (const l of lines(f)) assert.equal(l.split(',').length, layoutFor(f.name, l.split(',')[0]).fields.length + 2, l);
});

/** ZIP を読む（中央ディレクトリから。格納のみ） */
function readZip(bytes) {
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const end = bytes.length - 22;
  assert.equal(dv.getUint32(end, true), 0x06054b50);
  const count = dv.getUint16(end + 10, true);
  let p = dv.getUint32(end + 16, true);
  const out = [];
  for (let i = 0; i < count; i++) {
    assert.equal(dv.getUint32(p, true), 0x02014b50);
    const crc = dv.getUint32(p + 16, true);
    const size = dv.getUint32(p + 24, true);
    const nameLen = dv.getUint16(p + 28, true);
    const local = dv.getUint32(p + 42, true);
    const name = new TextDecoder().decode(bytes.subarray(p + 46, p + 46 + nameLen));
    assert.equal(dv.getUint32(local, true), 0x04034b50);
    const start = local + 30 + dv.getUint16(local + 26, true) + dv.getUint16(local + 28, true);
    out.push({ name, crc, data: bytes.subarray(start, start + size), date: dv.getUint16(p + 14, true), time: dv.getUint16(p + 12, true) });
    p += 46 + nameLen;
  }
  return out;
}

test('ZIP：ファイル名・中身・CRC-32・日時を記録し、読み戻せる', () => {
  const enc = new TextEncoder();
  assert.equal(crc32(enc.encode('123456789')), 0xcbf43926); // CRC-32 の検査値
  const files = [
    { name: 'HOI010_4.0.csv', bytes: new Uint8Array([0x31, 0x2c, 0x30, 0x0d, 0x0a]) },
    { name: 'HOI030_4.0.csv', bytes: enc.encode('3,0\r\n') },
    { name: '空.txt', bytes: new Uint8Array() },
  ];
  const zip = createZip(files, '2026-10-29T13:45:12');
  const back = readZip(zip);
  assert.deepEqual(back.map((f) => f.name), files.map((f) => f.name));
  back.forEach((f, i) => {
    assert.deepEqual([...f.data], [...files[i].bytes]);
    assert.equal(f.crc, zlib.crc32(files[i].bytes));
  });
  assert.equal(back[0].date, ((2026 - 1980) << 9) | (10 << 5) | 29);
  assert.equal(back[0].time, (13 << 11) | (45 << 5) | 6);
});
