// 勘定科目内訳明細書の e-Tax 用 CSV（純粋関数）
// 内訳書（breakdown.js の breakdownStatements の結果）を、国税庁の標準フォーム（令和6年3月1日以後終了事業年度分）の CSV 形式にする。
// e-Tax ソフトの「財務諸表等の組み込み」で、フォルダごと（またはファイルごと）に読み込める。
// 出典（2026-10-29 確認）
// - 作成の留意事項（ファイル名「様式ID_バージョン.csv」・Shift_JIS・JIS第1・第2水準の全角文字・項目内のカンマは全角・空の項目も「,」・金額は区切りなし、負は「-」）
//   https://www.e-tax.nta.go.jp/hojin/gimuka/csv_jyoho2.htm
// - 作成方法（標準フォームのタイトル行を削除し、データだけにして保存する）：https://www.e-tax.nta.go.jp/hojin/gimuka/csv_jyoho2/make_csv.pdf
// - 様式ID・バージョン：https://www.e-tax.nta.go.jp/hojin/gimuka/csv_jyoho2_meisai_20240325a.htm
// - レコードの内容及び留意事項（項目の並び・文字数・行区分・合計行・元号の番号）：https://www.e-tax.nta.go.jp/hojin/gimuka/csv_jyoho1/10/all2.pdf
// - 組み込みの手順（e-Tax ソフト）：https://www.e-tax.nta.go.jp/manual/manual21.pdf
// 帳簿に無い欄（所在地・登録番号・法人番号・利率・振出日など）は空欄にする。組み込んだ後に e-Tax ソフトで記入する。
// ⑭役員給与等の内訳（フォーマット区分 14-2）は、項番1〜8 の並びを国税庁の資料で確認できなかったため書き出さない（人件費の内訳 14-3 だけ書き出す）。
import { encodeShiftJis } from './sjis.js';
import { eraOf } from './property-tax.js';

// 項目：key（行の値の名前。null は常に空欄）、kind（z 全角・h 半角・n 金額）、max（文字数）、label（知らせるときの名前）
const Z = (key, max, label) => ({ key, kind: 'z', max, label });
const H = (key, max, label) => ({ key, kind: 'h', max, label });
const N = (key, label, { blankZero = key !== 'amount' } = {}) => ({ key, kind: 'n', max: 16, label, blankZero });
const EMPTY = (label) => ({ key: null, kind: 'h', max: 0, label });
const REG = [EMPTY('登録番号'), EMPTY('法人番号')];
/** 元号・年・月・日（日を省く様式もある） */
const DATE = (prefix, label, { day = true } = {}) => [H(`${prefix}Era`, 1, `${label}（元号）`), H(`${prefix}Y`, 2, `${label}（年）`), H(`${prefix}M`, 2, `${label}（月）`), ...(day ? [H(`${prefix}D`, 2, `${label}（日）`)] : [])];
const EMPTY_DATE = (label, { day = true } = {}) => DATE(null, label, { day }).map((f) => ({ ...f, key: null }));

// 元号の番号（各様式の留意事項：明治1・大正2・昭和3・平成4・令和5）
const ERA_CODE = { 明治: '1', 大正: '2', 昭和: '3', 平成: '4', 令和: '5' };
const p2 = (n) => String(n).padStart(2, '0');
/** 'YYYY/MM/DD' または 'YYYY/MM' を、元号・年・月・日の値にする */
export function eraFields(prefix, value) {
  if (!value) return {};
  const [y, m, d] = value.split(/[/-]/);
  const e = eraOf(`${y}-${m}-${d ?? '01'}`);
  return { [`${prefix}Era`]: ERA_CODE[e.era], [`${prefix}Y`]: String(e.year), [`${prefix}M`]: p2(e.month), ...(d ? { [`${prefix}D`]: p2(Number(d)) } : {}) };
}

/** 補助科目の名前「さくら銀行 本店」を、金融機関名と支店名に分ける（空白が無ければ全部を金融機関名にする） */
export function splitBankName(name) {
  const m = /^(\S+)[\s　]+(\S.*)$/.exec(String(name ?? '').trim());
  return m ? { bank: m[1], branch: m[2] } : { bank: String(name ?? '').trim(), branch: '' };
}

/**
 * 様式ごとの記録の並び。file・version：ファイル名、code：フォーマット区分、page：1ページの明細の最大数、
 * total：合計行に記録する項目（合計行の無い様式は無し）、row：内訳書の行を項目の値にする（省略時はそのまま）
 * 項目の数は、レコードの内容及び留意事項の項番の数と同じ（テストで確認）
 */
export const ETAX_LAYOUTS = {
  deposits: {
    file: 'HOI010',
    version: '4.0',
    code: '1',
    page: 23,
    total: ['amount'],
    fields: [Z('bank', 11, '金融機関名'), Z('branch', 11, '支店名'), Z('kind', 10, '種類'), EMPTY('口座番号'), N('amount', '期末現在高'), Z('memo', 30, '摘要')],
    row: (r) => ({ ...splitBankName(r.party), kind: r.account, amount: r.amount, memo: r.memo }),
  },
  notes_receivable: {
    file: 'HOI020',
    version: '4.0',
    code: '2',
    page: 23,
    total: ['amount'],
    fields: [...REG, Z('party', 30, '振出人'), ...EMPTY_DATE('振出年月日'), ...EMPTY_DATE('支払期日'), EMPTY('支払銀行名称'), EMPTY('支店名'), N('amount', '金額'), EMPTY('割引銀行名及び支店名等'), Z('memo', 50, '摘要')],
  },
  receivables: {
    file: 'HOI030',
    version: '4.0',
    code: '3',
    page: 26,
    total: ['amount'],
    fields: [Z('account', 10, '科目'), ...REG, Z('party', 30, '相手先'), EMPTY('所在地'), N('amount', '期末現在高'), Z('memo', 50, '摘要')],
  },
  advances: {
    file: 'HOI040',
    version: '4.0',
    code: '4-1',
    page: 11,
    fields: [Z('account', 10, '科目'), ...REG, Z('party', 30, '相手先'), EMPTY('所在地'), EMPTY('法人・代表者との関係'), N('amount', '期末現在高'), Z('memo', 50, '摘要')],
  },
  loans: {
    file: 'HOI040',
    version: '4.0',
    code: '4-2',
    page: 7,
    total: ['amount', 'interest'],
    fields: [...REG, Z('party', 30, '貸付先'), EMPTY('所在地'), EMPTY('法人・代表者との関係'), N('amount', '期末現在高'), N('interest', '期中の受取利息額'), EMPTY('利率'), EMPTY('担保の内容')],
  },
  inventory: {
    file: 'HOI050',
    version: '4.0',
    code: '5',
    page: 24,
    total: ['amount'],
    fields: [Z('account', 10, '科目'), Z('party', 20, '品目'), EMPTY('数量'), EMPTY('単価'), N('amount', '期末現在高'), Z('memo', 30, '摘要')],
  },
  // 区分（売買・満期・その他）は帳簿で分からないため空欄。帳簿価額は「時価及び帳簿価額」に書く（売買目的のときは組み込んだ後に直す）
  securities: {
    file: 'HOI060',
    version: '4.0',
    code: '6',
    page: 15,
    total: ['amount'],
    fields: [EMPTY('区分'), EMPTY('種類'), Z('name', 10, '銘柄'), EMPTY('期末現在高（数量）'), EMPTY('期末現在高（金額）'), N('amount', '時価及び帳簿価額'), ...EMPTY_DATE('異動年月日'), EMPTY('異動事由'), EMPTY('数量'), EMPTY('金額'), EMPTY('売却（買入）先の名称'), EMPTY('売却（買入）先の所在地'), Z('memo', 50, '摘要')],
    row: (r) => ({ name: r.party, amount: r.amount, memo: r.memo }),
  },
  // 物件（補助科目の名前）は「物件の所在地」に入れる。組み込んだ後に所在地へ直す
  real_estate: {
    file: 'HOI070',
    version: '5.0',
    code: '7',
    page: 10,
    fields: [Z('kind', 10, '種類・構造'), EMPTY('用途'), EMPTY('面積'), Z('address', 100, '物件の所在地'), N('amount', '期末現在高'), ...EMPTY_DATE('異動年月日'), EMPTY('異動事由'), EMPTY('取得（処分）価額'), EMPTY('異動直前の帳簿価額'), ...REG, EMPTY('売却（購入）先の名称'), EMPTY('売却（購入）先の所在地'), ...EMPTY_DATE('売却物件の取得年月', { day: false })],
    row: (r) => ({ kind: r.account, address: r.party, amount: r.amount }),
  },
  notes_payable: {
    file: 'HOI080',
    version: '4.0',
    code: '8',
    page: 23,
    total: ['amount'],
    fields: [...REG, Z('party', 30, '支払先'), ...EMPTY_DATE('振出年月日'), ...EMPTY_DATE('支払期日'), EMPTY('支払銀行名称'), EMPTY('支店名'), N('amount', '金額'), Z('memo', 50, '摘要')],
  },
  payables: {
    file: 'HOI090',
    version: '5.0',
    code: '9-1',
    page: 23,
    total: ['amount'],
    fields: [Z('account', 10, '科目'), ...REG, Z('party', 30, '相手先'), EMPTY('所在地'), N('amount', '期末現在高'), Z('memo', 50, '摘要')],
  },
  received: {
    file: 'HOI100',
    version: '6.0',
    code: '10-1',
    page: 12,
    fields: [Z('account', 10, '科目'), ...REG, Z('party', 30, '相手先'), EMPTY('所在地'), EMPTY('法人・代表者との関係'), N('amount', '期末現在高'), Z('memo', 50, '摘要')],
  },
  borrowings: {
    file: 'HOI110',
    version: '3.0',
    code: '11',
    page: 14,
    total: ['amount', 'interest'],
    fields: [Z('party', 30, '借入先'), EMPTY('所在地'), EMPTY('法人・代表者との関係'), N('amount', '期末現在高'), N('interest', '期中の支払利子額'), EMPTY('利率'), EMPTY('担保の内容')],
  },
  land_sales: {
    file: 'HOI120',
    version: '5.0',
    code: '12',
    page: 10,
    fields: [EMPTY('区分'), EMPTY('商品の所在地'), EMPTY('地目'), EMPTY('総面積'), ...DATE('sold', '売上（仲介）年月', { day: false }), ...REG, Z('party', 30, '売上（仲介）先'), EMPTY('売上（仲介）先の所在地'), EMPTY('売上（仲介）面積'), EMPTY('売上金額（上段）'), N('amount', '売上金額（仲介手数料）'), ...EMPTY_DATE('売上商品の取得年', { day: false }).slice(0, 2)],
    row: (r) => ({ ...eraFields('sold', r.month), party: r.party, amount: r.amount }),
  },
  offices: {
    file: 'HOI130',
    version: '5.0',
    code: '13',
    page: 14,
    total: ['amount', 'inventory'],
    fields: [Z('party', 30, '事業所の名称'), EMPTY('所在地'), EMPTY('責任者氏名'), EMPTY('代表者との関係'), EMPTY('事業等の内容'), N('amount', '売上高', { blankZero: false }), N('inventory', '期末棚卸高', { blankZero: false }), EMPTY('期末従事員数'), EMPTY('源泉所得税納付署'), Z('memo', 30, '摘要')],
  },
  // 人件費の内訳は1レコード（役員報酬手当・従業員給料手当・従業員賃金手当の総額と計。うち代表者及びその家族分は空欄）
  personnel: {
    file: 'HOI141',
    version: '5.0',
    code: '14-3',
    page: 1,
    fields: [N('officers', '役員報酬手当（総額）', { blankZero: false }), EMPTY('役員報酬手当（代表者及びその家族分）'), N('salaries', '従業員給料手当（総額）', { blankZero: false }), EMPTY('従業員給料手当（代表者及びその家族分）'), N('wages', '従業員賃金手当（総額）', { blankZero: false }), EMPTY('従業員賃金手当（代表者及びその家族分）'), N('total', '計（総額）', { blankZero: false }), EMPTY('計（代表者及びその家族分）')],
    records: (f) => {
      const [officers = 0, salaries = 0, wages = 0] = f.rows.map((r) => r.amount);
      return [{ officers, salaries, wages, total: officers + salaries + wages }];
    },
  },
  // 区分（地代・家賃）・物件の用途・所在地・支払対象期間は空欄。摘要には科目名を入れる
  rent: {
    file: 'HOI150',
    version: '4.0',
    code: '15-1',
    page: 8,
    fields: [EMPTY('区分'), EMPTY('物件の用途'), EMPTY('所在地'), ...REG, Z('party', 30, '貸主の名称'), EMPTY('貸主の所在地'), ...EMPTY_DATE('支払対象期間（自）'), ...EMPTY_DATE('支払対象期間（至）'), N('amount', '支払賃借料'), Z('memo', 40, '摘要')],
    row: (r) => ({ party: r.party, amount: r.amount, memo: r.memo || r.account }), // 同じ貸主の科目違い（地代家賃・製造の賃借料）を摘要で分かるようにする
  },
  rights: {
    file: 'HOI150',
    version: '4.0',
    code: '15-2',
    page: 3,
    fields: [...REG, Z('party', 30, '支払先の名称'), EMPTY('支払先の所在地'), ...DATE('paid', '支払年月日'), N('amount', '支払金額'), Z('content', 30, '権利金等の内容'), EMPTY('摘要')],
    row: (r) => ({ ...eraFields('paid', r.date), party: r.party, amount: r.amount, content: r.memo }),
  },
  royalties: {
    file: 'HOI150',
    version: '4.0',
    code: '15-3',
    page: 3,
    fields: [Z('name', 10, '名称'), ...REG, Z('party', 30, '支払先の名称'), EMPTY('支払先の所在地'), ...EMPTY_DATE('契約期間（自）', { day: false }), ...EMPTY_DATE('契約期間（至）', { day: false }), ...EMPTY_DATE('支払対象期間（自）', { day: false }), ...EMPTY_DATE('支払対象期間（至）', { day: false }), N('amount', '支払金額'), Z('memo', 40, '摘要')],
  },
  // 雑益等（16-1）と雑損失等（16-2）。区分は科目名、取引の内容は摘要
  misc: {
    file: 'HOI160',
    version: '4.0',
    code: (r) => (r.kind === 'loss' ? '16-2' : '16-1'),
    page: 10,
    fields: [Z('account', 10, '区分'), Z('memo', 30, '取引の内容'), ...REG, Z('party', 30, '相手先'), EMPTY('相手先の所在地'), N('amount', '金額')],
  },
};

/** e-Tax に書き出さない内訳書（理由） */
export const ETAX_SKIPPED = { officers: '役員給与等の内訳は、e-Tax ソフトで入力してください' };

// 全角にする文字の置き換え（JIS第1・第2水準に無いもの）
const ZEN_ALIASES = {
  '"': '”',
  "'": '’',
  // 異体字（Shift_JIS の拡張文字にしか無い字）を、JIS第1・第2水準の字にする
  髙: '高',
  﨑: '崎',
  德: '徳',
  濵: '浜',
  瀨: '瀬',
  栁: '柳',
  '𠮷': '吉',
};

/** JIS X 0208（第1・第2水準と非漢字）にある文字か（Shift_JIS の2バイトの範囲で判定する） */
function isJis0208(ch) {
  const { bytes, unmappable } = encodeShiftJis(ch);
  if (unmappable.length || bytes.length !== 2) return false;
  const [lead, trail] = bytes;
  if (lead >= 0x81 && lead <= 0x84) return true; // 1〜8区（記号・英数・かな・ギリシア・キリル・罫線）
  if (lead === 0x88) return trail >= 0x9f; // 16区から第1水準
  if (lead >= 0x89 && lead <= 0x9f) return true;
  if (lead >= 0xe0 && lead <= 0xe9) return true;
  if (lead === 0xea) return trail <= 0xa4; // 84区まで（第2水準の終わり）
  return false;
}

/**
 * 全角の項目の文字にする：NFKC で半角カナ・濁点を整え、英数字・記号・空白を全角にし、改行は空白にする。
 * JIS第1・第2水準に無い文字は「？」にして返す
 * @returns {{ text: string, unsupported: string[] }}
 */
export function toEtaxZenkaku(value) {
  const unsupported = new Set();
  const s = String(value ?? '')
    .replace(/[\r\n\t]+/g, ' ')
    .normalize('NFKC')
    .trim();
  let out = '';
  for (const c of s) {
    const ch = ZEN_ALIASES[c] ?? (c === ' ' ? '　' : c >= '!' && c <= '~' ? String.fromCharCode(c.charCodeAt(0) + 0xfee0) : c);
    if (isJis0208(ch)) out += ch;
    else {
      unsupported.add(c);
      out += '？';
    }
  }
  return { text: out, unsupported: [...unsupported] };
}

/**
 * 内訳書を e-Tax 用の CSV ファイルにする
 * @param {Array} forms breakdownStatements の結果
 * @returns {{
 *   files: Array<{ name, text, bytes: Uint8Array, titles: string[], records: number }>,
 *   truncated: Array<{ title, label, value, max }>, unsupported: string[], skipped: string[], noTotal: string[]
 * }}
 * noTotal：明細が1ページに収まらないため合計行を付けなかった内訳書（合計行で改ページするため）
 */
export function etaxBreakdownFiles(forms) {
  const byFile = new Map();
  const truncated = [];
  const unsupported = new Set();
  const skipped = [];
  const noTotal = [];

  const cell = (field, value, title) => {
    if (!field.key) return '';
    if (field.kind === 'n') {
      if (value === null || value === undefined || value === '' || (field.blankZero && value === 0)) return '';
      return String(Math.trunc(Number(value)));
    }
    if (field.kind === 'h') return value === null || value === undefined ? '' : String(value).slice(0, field.max);
    const r = toEtaxZenkaku(value);
    r.unsupported.forEach((c) => unsupported.add(c));
    const chars = [...r.text];
    if (chars.length <= field.max) return r.text;
    truncated.push({ title, label: field.label, value: String(value), max: field.max });
    return chars.slice(0, field.max).join('');
  };

  for (const f of forms) {
    if (!f.rows.length) continue;
    if (ETAX_SKIPPED[f.id]) {
      skipped.push(f.title);
      continue;
    }
    const layout = ETAX_LAYOUTS[f.id];
    if (!layout) continue;
    const name = `${layout.file}_${layout.version}.csv`;
    const entry = byFile.get(name) || { name, lines: [], titles: [], records: 0 };
    byFile.set(name, entry);
    entry.titles.push(f.title);
    const code = (r) => (typeof layout.code === 'function' ? layout.code(r) : layout.code);
    // フォーマット区分が行で変わる様式（雑益等・雑損失等）は、区分ごとにまとめて並べる（同じ区分の中の並びは変えない）
    const rows = typeof layout.code === 'function' ? [...f.rows].sort((a, b) => code(a).localeCompare(code(b))) : f.rows;
    const values = layout.records ? layout.records(f) : rows.map((r) => (layout.row ? layout.row(r) : r));
    const lines = values.map((v, i) => [code(rows[i] ?? v), '0', ...layout.fields.map((fd) => cell(fd, v[fd.key], f.title))]);
    if (layout.total && values.length) {
      if (values.length < layout.page) {
        const sums = Object.fromEntries(layout.total.map((k) => [k, values.reduce((s, v) => s + (Number(v[k]) || 0), 0)]));
        lines.push([code(values[0]), '1', ...layout.fields.map((fd) => (layout.total.includes(fd.key) ? String(sums[fd.key]) : ''))]);
      } else noTotal.push(f.title);
    }
    for (const l of lines) entry.lines.push(l.join(','));
    entry.records += lines.length;
  }

  const files = [...byFile.values()].map((e) => {
    const text = e.lines.join('\r\n') + '\r\n';
    return { name: e.name, text, bytes: encodeShiftJis(text).bytes, titles: e.titles, records: e.records };
  });
  return { files, truncated, unsupported: [...unsupported], skipped, noTotal };
}
