// ほかの会計ソフトの仕訳 CSV の取り込み（純粋関数）
//
// 対応する形式
// - 弥生会計のインポート形式（見出しなし25列。識別フラグ 2000・2111＝1行、2110〜2100〜2101＝複数行）
//   弥生会計 サポート情報「仕訳データの項目と記述形式」
// - 見出しのある CSV（freee の仕訳帳・マネーフォワードの仕訳帳など）。見出しの言葉から列を推定し、
//   同じ番号（No.・取引No・伝票番号など）の行を1つの仕訳にまとめる
//   freee ヘルプセンター「仕訳帳をCSV形式・PDF形式で出力する」
// 出典の URL は docs/spec-phase2-transfer.md（アプリのソースには国税庁以外の URL を書かない決まり）
// 科目・税区分は名前で照らし合わせ、合わないものは利用者が選ぶ。金額は整数の円
import { parseDate, parseAmount } from './bank-import.js';
import { isVoucherNo } from './journal.js';
import { normalize } from './search.js';
import { TAX_BY_CODE } from './tax.js';

export const IMPORT_FORMATS = { yayoi: '弥生会計のインポート形式', header: '見出しのある仕訳のCSV（freee・マネーフォワードなど）' };
const YAYOI_FLAGS = ['2000', '2111', '2110', '2100', '2101'];

// 見出しの言葉（正規化したもの）と列の役割。先にあるものを優先する
const HEADER_KEYS = [
  ['no', ['取引no', '伝票no', '伝票番号', '仕訳番号', '取引番号', 'no', '番号']],
  ['date', ['取引日', '取引日付', '日付', '伝票日付', '計上日', '発生日']],
  ['debitAccount', ['借方勘定科目', '借方科目']],
  ['debitSub', ['借方補助科目', '借方補助']],
  ['debitTax', ['借方税区分']],
  ['debitAmount', ['借方金額', '借方金額円']],
  ['debitPartner', ['借方取引先', '借方取引先名']],
  ['creditAccount', ['貸方勘定科目', '貸方科目']],
  ['creditSub', ['貸方補助科目', '貸方補助']],
  ['creditTax', ['貸方税区分']],
  ['creditAmount', ['貸方金額', '貸方金額円']],
  ['creditPartner', ['貸方取引先', '貸方取引先名']],
  ['memo', ['摘要', '取引内容']],
  ['partner', ['取引先', '取引先名']],
  ['adjusting', ['決算整理仕訳', '決算整理', '決算']],
];
export const COLUMN_KEYS = HEADER_KEYS.map(([k]) => k);
const headKey = (s) => normalize(s).replace(/[\s.。()（）「」[\]]/g, '');

/**
 * 形式と列を推定する
 * @param {string[][]} rows parseCsv の結果
 * @returns {{ format: 'yayoi'|'header'|null, headerRow?: number, columns?: object, error?: string }}
 */
export function detectFormat(rows) {
  if (!rows.length) return { format: null, error: 'CSVの中身が読み取れませんでした' };
  if (YAYOI_FLAGS.includes(rows[0][0]) && rows[0].length >= 20) return { format: 'yayoi' };
  for (let i = 0; i < Math.min(rows.length, 5); i++) {
    const keys = rows[i].map(headKey);
    const columns = {};
    for (const [kind, words] of HEADER_KEYS) {
      for (const w of words) {
        const idx = keys.findIndex((k, n) => k === w && !Object.values(columns).includes(n));
        if (idx >= 0) {
          columns[kind] = idx;
          break;
        }
      }
    }
    if (columns.date !== undefined && columns.debitAccount !== undefined && columns.creditAccount !== undefined && (columns.debitAmount !== undefined || columns.creditAmount !== undefined)) {
      return { format: 'header', headerRow: i, columns };
    }
  }
  return { format: null, error: '仕訳のCSVの形式がわかりませんでした。弥生会計のインポート形式か、見出し（取引日・借方勘定科目・貸方勘定科目・金額など）のあるCSVを選んでください' };
}

const truthy = (v) => /^(1|true|yes|on|○|〇|はい|決算整理|決算整理仕訳|本決|中決)$/i.test(String(v ?? '').normalize('NFKC').trim());

/** 1行の借方・貸方を明細にする（金額がマイナスなら反対側にする。0・空欄は明細にしない） */
function rowLines(cells, memo, rowNo, errors) {
  const out = [];
  for (const side of ['debit', 'credit']) {
    const c = cells[side];
    if (!c.account && !c.amount) continue;
    const amount = parseAmount(c.amount);
    if (Number.isNaN(amount)) {
      errors.push(`${rowNo}行目：${side === 'debit' ? '借方' : '貸方'}の金額「${c.amount}」が読めません`);
      continue;
    }
    if (!amount) continue;
    if (!c.account) {
      errors.push(`${rowNo}行目：${side === 'debit' ? '借方' : '貸方'}の科目がありません`);
      continue;
    }
    const flip = amount < 0;
    // 取引先（freee など）は摘要の先頭に付ける（摘要に含まれていれば付けない）
    const text = c.partner && !memo.includes(c.partner) ? `${c.partner} ${memo}`.trim() : memo;
    out.push({ side: flip ? (side === 'debit' ? 'credit' : 'debit') : side, account: c.account, sub: c.sub || '', tax: c.tax || '', amount: Math.abs(amount), memo: text, row: rowNo });
  }
  return out;
}

/**
 * CSV の行を仕訳の単位（entries）にする。科目・税区分は CSV の名前のまま
 * @returns {Array<{ key, date, adjusting, rows: number[], lines: Array<{ side, account, sub, tax, amount, memo, row }>, errors: string[] }>}
 */
export function parseEntries(rows, detected) {
  return detected.format === 'yayoi' ? yayoiEntries(rows) : headerEntries(rows, detected);
}

/** CSV の番号（伝票No など）が数字だけなら伝票No にする。それ以外（英字入りなど）は付けない（保存のときに次の番号） */
function voucherFrom(text) {
  const s = String(text ?? '').trim();
  if (!/^\d+$/.test(s)) return null;
  const n = Number(s);
  return isVoucherNo(n) ? n : null;
}

function yayoiEntries(rows) {
  const entries = [];
  let open = null;
  rows.forEach((r, i) => {
    const rowNo = i + 1;
    const flag = r[0];
    const cells = {
      debit: { account: r[4], sub: r[5], tax: r[7], amount: r[8] },
      credit: { account: r[10], sub: r[11], tax: r[13], amount: r[14] },
    };
    const errors = [];
    if (!YAYOI_FLAGS.includes(flag)) {
      entries.push({ key: `row${rowNo}`, date: null, adjusting: false, rows: [rowNo], lines: [], errors: [`${rowNo}行目：識別フラグ「${flag}」が弥生会計の形式ではありません`] });
      return;
    }
    const starts = flag === '2000' || flag === '2111' || flag === '2110' || !open;
    if (starts) {
      open = { key: `row${rowNo}`, date: parseDate(r[3]), dateText: r[3], voucherNo: voucherFrom(r[1]), adjusting: Boolean(r[2]?.trim()), rows: [], lines: [], errors: [] };
      if (!open.date) open.errors.push(`${rowNo}行目：取引日付「${r[3] ?? ''}」が読めません`);
      if (flag === '2100' || flag === '2101') open.errors.push(`${rowNo}行目：複数行の仕訳の1行目（2110）がありません`);
      entries.push(open);
    }
    open.rows.push(rowNo);
    open.lines.push(...rowLines(cells, r[16] || '', rowNo, errors));
    open.errors.push(...errors);
    if (flag === '2000' || flag === '2111' || flag === '2101') open = null;
  });
  return entries.map(({ dateText: _d, ...e }) => e);
}

function headerEntries(rows, { headerRow, columns: c }) {
  const get = (r, k) => (c[k] === undefined ? '' : (r[c[k]] ?? '').trim());
  const entries = [];
  let open = null;
  for (let i = headerRow + 1; i < rows.length; i++) {
    const r = rows[i];
    const rowNo = i + 1;
    const no = get(r, 'no');
    const dateText = get(r, 'date');
    const date = parseDate(dateText);
    // 番号の列があれば、同じ番号・日付が続く行を1つの仕訳にする（番号が空の行は1行で1つの仕訳）
    const key = no ? `${no}|${date || dateText}` : `row${rowNo}`;
    if (!open || open.key !== key) {
      open = { key, date, voucherNo: voucherFrom(no), adjusting: false, rows: [], lines: [], errors: [] };
      if (!date) open.errors.push(`${rowNo}行目：取引日「${dateText}」が読めません`);
      entries.push(open);
    }
    open.rows.push(rowNo);
    if (truthy(get(r, 'adjusting'))) open.adjusting = true;
    const partner = get(r, 'partner');
    const errors = [];
    open.lines.push(
      ...rowLines(
        {
          debit: { account: get(r, 'debitAccount'), sub: get(r, 'debitSub'), tax: get(r, 'debitTax'), amount: get(r, 'debitAmount') || (c.debitAmount === undefined ? get(r, 'creditAmount') : ''), partner: get(r, 'debitPartner') || partner },
          credit: { account: get(r, 'creditAccount'), sub: get(r, 'creditSub'), tax: get(r, 'creditTax'), amount: get(r, 'creditAmount') || (c.creditAmount === undefined ? get(r, 'debitAmount') : ''), partner: get(r, 'creditPartner') || partner },
        },
        get(r, 'memo'),
        rowNo,
        errors,
      ),
    );
    open.errors.push(...errors);
  }
  return entries;
}

// ---- 科目の照らし合わせ ----

const accountKey = (s) => normalize(s).replace(/[\s・]/g, '').replace(/ウエ/g, 'ウェ').replace(/等$/, '');
// 名前が違っても同じ科目として扱う組（ほかのソフトとの表記の違い）
const ALIASES = [
  ['売上高', '売上'],
  ['仕入高', '仕入', '仕入金額', '商品仕入高'],
  ['期首商品棚卸高', '期首棚卸高', '期首商品たな卸高'],
  ['期末商品棚卸高', '期末棚卸高', '期末商品たな卸高'],
  ['支払利息', '支払利息割引料'],
  ['前払金', '前渡金'],
  ['未払法人税等', '未払法人税'],
  ['減価償却累計額', '償却累計額'],
  ['事業主貸', '事業主貸勘定'],
  ['事業主借', '事業主借勘定'],
];

/**
 * CSV の科目名を、この帳簿の科目に照らし合わせる（保存した対応 → 同じ名前 → 表記の違い）
 * @param {string[]} names CSV の科目名
 * @param {Array} accounts
 * @param {object} saved 前回選んだ対応 { CSVの名前: accountId }
 * @returns {Map<string, string|null>}
 */
export function suggestAccounts(names, accounts, saved = {}) {
  const usable = accounts.filter((a) => a.active !== false);
  const byKey = new Map(usable.map((a) => [accountKey(a.name), a.id]));
  const out = new Map();
  for (const name of names) {
    if (saved[name] && accounts.some((a) => a.id === saved[name])) {
      out.set(name, saved[name]);
      continue;
    }
    const key = accountKey(name);
    let id = byKey.get(key) ?? null;
    if (!id) {
      const group = ALIASES.find((g) => g.some((n) => accountKey(n) === key));
      id = group?.map((n) => byKey.get(accountKey(n))).find(Boolean) ?? null;
    }
    out.set(name, id);
  }
  return out;
}

// ---- 税区分の照らし合わせ ----

/**
 * CSV の税区分の名前を Pocket会計の税区分にする
 * 弥生（課税売上込10%・課対仕入込軽減8%・課対仕入込10%区分80%）、freee（課対仕入8%(軽)・課対仕入(控80)10%）、
 * マネーフォワード（課税仕入 10%・共-課仕 10%）などの表記を言葉で判定する
 * @param {string} label CSV の税区分（空欄なら fallback）
 * @param {string} fallback 空欄のときの税区分（科目の既定の税区分）
 * @returns {{ code: string, note?: string }}
 */
export function suggestTax(label, fallback = 'none') {
  const s = normalize(label).replace(/\s/g, '');
  if (!s) return { code: fallback };
  if (/対象外|不課税|^不明$|^-$|^なし$/.test(s)) return { code: 'none' };
  const unsupported = (why) => ({ code: 'none', note: `「${label}」：${why}。対象外にしたので、必要なら直してください` });
  const reduced = /軽/.test(s);
  const rate = reduced ? '8r' : /10%/.test(s) ? '10' : /8%|5%|3%/.test(s) ? 'old' : null;
  const use = /^共|共対|共通/.test(s) ? '_c' : /^非対|^非-|非課税売上対応/.test(s) ? '_e' : '';
  if (/輸税|輸入消費税|輸入の消費税/.test(s)) return { code: `import_tax${use}` };
  if (/地消貨割|貨物割/.test(s)) return { code: 'import_local' };
  if (/輸本|輸入本体/.test(s)) return unsupported('輸入の本体です（消費税額は別の行で取り込みます）');
  if (/対外/.test(s)) return { code: 'none' };
  if (/非資輸/.test(s)) return { code: 'sales_export', note: `「${label}」（非課税資産の輸出）は輸出売上（免税）にしました` };
  if (/輸出|免税売上/.test(s)) {
    if (/倒/.test(s)) return unsupported('輸出売上の貸倒れの税区分はありません');
    return { code: /返|値引/.test(s) ? 'sales_export_return' : 'sales_export' };
  }
  if (/有価/.test(s)) return { code: 'sales_securities' };
  if (/非課/.test(s)) {
    if (/仕/.test(s) && !/売/.test(s)) return { code: 'purchase_exempt' };
    if (/倒/.test(s)) return unsupported('非課税売上の貸倒れの税区分はありません');
    return { code: /返|値引/.test(s) ? 'sales_exempt_return' : 'sales_exempt' };
  }
  const isSales = /売/.test(s) && !/仕/.test(s);
  const isPurchase = /仕/.test(s);
  if (!isSales && !isPurchase) return unsupported('どの税区分か判定できません');
  if (rate === 'old') return unsupported('旧税率（8%・5%など）の税区分は扱えません');
  if (!rate) return unsupported('税率がわかりません');
  if (isSales) {
    if (/回/.test(s)) return { code: `sales_recovered_${rate}` };
    if (/倒/.test(s)) return { code: `sales_baddebt_${rate}` };
    if (/返|値引|戻/.test(s)) return { code: `sales_return_${rate}` };
    return { code: `sales_${rate}` };
  }
  if (/控不|控除不可/.test(s)) return unsupported('仕入税額控除ができない仕入れです');
  if (/返|値引|戻/.test(s)) return { code: `purchase_return_${rate}${use}` };
  const transitional = /区分|控80|控70|控50|控30|80%控除|70%控除|50%控除|30%控除|経過|インボイスなし|適格請求書なし|適格外|免税事業者/.test(s);
  return { code: `purchase_${rate}${transitional ? '_ni' : ''}${use}` };
}

// ---- 仕訳にする ----

/** 重複を見つけるための仕訳の目印（日付・科目・補助科目・金額） */
export function journalSignature(j) {
  return `${j.date}|${j.lines
    .map((l) => `${l.side}:${l.accountId}:${l.subAccountId || ''}:${l.amount}`)
    .sort()
    .join(',')}`;
}

/**
 * entries を Pocket会計の仕訳の内容にする
 * @param {Array} entries parseEntries の結果
 * @param {{ accountMap: Map, taxMap: Map, subAccounts: Array, accountById: Map }} ctx
 *   accountMap：CSVの科目名 → accountId、taxMap：CSVの税区分名 → 税区分（空欄は科目の既定）
 * @returns {{ items: Array<{ entry, date, voucherNo, adjusting, lines, errors }>, newSubs: Array<{ accountId, name }> }}
 *   voucherNo：CSV の番号が数字だけならその番号（伝票No）、なければ null
 *   lines の subAccountId は既存の補助科目の id か、新しく作る補助科目の 'new:科目id:名前'
 */
export function buildImport(entries, { accountMap, taxMap, subAccounts, accountById }) {
  const subKey = (accountId, name) => `${accountId}|${normalize(name)}`;
  const existing = new Map(subAccounts.map((s) => [subKey(s.accountId, s.name), s.id]));
  const newSubs = new Map();
  const items = entries.map((entry) => {
    const errors = [...entry.errors];
    const lines = [];
    for (const l of entry.lines) {
      const accountId = accountMap.get(l.account);
      if (!accountId) {
        errors.push(`科目「${l.account}」の対応を選んでください`);
        continue;
      }
      let subAccountId = null;
      const subName = l.sub.trim().slice(0, 30);
      if (subName) {
        subAccountId = existing.get(subKey(accountId, subName)) ?? `new:${accountId}:${subName}`;
        if (subAccountId.startsWith('new:') && !newSubs.has(subAccountId)) newSubs.set(subAccountId, { key: subAccountId, accountId, name: subName });
      }
      const fallback = accountById.get(accountId)?.defaultTaxCategory ?? 'none';
      const taxCategory = l.tax ? (taxMap.get(l.tax) ?? 'none') : fallback;
      lines.push({ side: l.side, accountId, subAccountId, amount: l.amount, taxCategory: TAX_BY_CODE[taxCategory] ? taxCategory : 'none', memo: l.memo.slice(0, 200) });
    }
    if (!entry.lines.length && !entry.errors.length) errors.push('金額のある明細がありません');
    return { entry, date: entry.date, voucherNo: entry.voucherNo ?? null, adjusting: entry.adjusting, lines, errors };
  });
  return { items, newSubs: [...newSubs.values()] };
}

/** CSV に出てくる科目名・税区分名（出てくる順） */
export function namesIn(entries) {
  const accounts = new Set();
  const taxes = new Set();
  for (const e of entries) {
    for (const l of e.lines) {
      accounts.add(l.account);
      if (l.tax) taxes.add(l.tax);
    }
  }
  return { accounts: [...accounts], taxes: [...taxes] };
}
