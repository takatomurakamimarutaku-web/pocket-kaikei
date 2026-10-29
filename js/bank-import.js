// 銀行明細CSVの取り込み（純粋関数）
// 銀行ごとに形式が違うため、見出しの言葉から列を推定し、利用者が直せるようにする。
// 1行の明細を「口座 ⇔ 相手科目」の2行の仕訳にする。金額は整数の円
import { parseYen } from './money.js';
import { normalize } from './search.js';
import { isValidDate } from './period.js';
import { simplePair } from './quick.js';

/**
 * バイト列を文字列にする。BOM付き・正しいUTF-8ならUTF-8、そうでなければShift_JIS（多くの銀行の形式）
 * @param {Uint8Array} bytes
 * @returns {{ text: string, encoding: 'utf-8'|'shift_jis' }}
 */
export function decodeBytes(bytes) {
  if (bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) return { text: new TextDecoder('utf-8').decode(bytes.subarray(3)), encoding: 'utf-8' };
  try {
    return { text: new TextDecoder('utf-8', { fatal: true }).decode(bytes), encoding: 'utf-8' };
  } catch {
    return { text: new TextDecoder('shift_jis').decode(bytes), encoding: 'shift_jis' };
  }
}

/**
 * CSV（またはタブ区切り）を行の配列にする。ダブルクォート・セル内の改行に対応。空行は除く
 * @returns {string[][]}
 */
export function parseCsv(text) {
  const src = text.replace(/^﻿/, '');
  const firstLine = src.split(/\r?\n/, 1)[0] || '';
  const delim = (firstLine.match(/\t/g) || []).length > (firstLine.match(/,/g) || []).length ? '\t' : ',';
  const rows = [];
  let row = [];
  let cell = '';
  let quoted = false;
  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    if (quoted) {
      if (c === '"') {
        if (src[i + 1] === '"') {
          cell += '"';
          i++;
        } else quoted = false;
      } else cell += c;
    } else if (c === '"' && cell === '') quoted = true;
    else if (c === delim) {
      row.push(cell);
      cell = '';
    } else if (c === '\n' || c === '\r') {
      if (c === '\r' && src[i + 1] === '\n') i++;
      row.push(cell);
      rows.push(row);
      row = [];
      cell = '';
    } else cell += c;
  }
  if (cell !== '' || row.length) {
    row.push(cell);
    rows.push(row);
  }
  return rows.map((r) => r.map((v) => v.trim())).filter((r) => r.some((v) => v !== ''));
}

const ERAS = { 令和: 2018, R: 2018, 平成: 1988, H: 1988 };

/**
 * 日付の文字列を YYYY-MM-DD にする。読めなければ null
 * 2026/4/1・2026-04-01・2026.4.1・20260401・2026年4月1日・令和8年4月1日・R8.4.1（時刻が付いていても可）
 */
export function parseDate(value) {
  const s = String(value ?? '').normalize('NFKC').trim();
  let y;
  let m;
  let d;
  let r = /^(\d{4})[/.-](\d{1,2})[/.-](\d{1,2})(?:\D|$)/.exec(s) || /^(\d{4})年(\d{1,2})月(\d{1,2})日/.exec(s);
  if (r) [, y, m, d] = r.map(Number);
  else if ((r = /^(\d{4})(\d{2})(\d{2})$/.exec(s))) [, y, m, d] = r.map(Number);
  else if ((r = /^(令和|平成|R|H)\s*(\d{1,2}|元)[年./-](\d{1,2})[月./-](\d{1,2})/i.exec(s))) {
    const era = ERAS[r[1].toUpperCase()] ?? ERAS[r[1]];
    y = era + (r[2] === '元' ? 1 : Number(r[2]));
    m = Number(r[3]);
    d = Number(r[4]);
  } else return null;
  const out = `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
  return isValidDate(out) ? out : null;
}

/** 金額のセルを整数にする。空欄は null、読めなければ NaN（「+」「円」「¥」「,」も可） */
export function parseAmount(value) {
  const s = String(value ?? '').normalize('NFKC').trim().replace(/^\+/, '');
  if (s === '' || s === '-' || s === '−') return null;
  const p = parseYen(s, { allowNegative: true, allowZero: true });
  return p.ok ? p.value : NaN;
}

/** 列の役割 */
export const COLUMN_KINDS = [
  { id: 'date', label: '日付' },
  { id: 'memo', label: '摘要（内容）' },
  { id: 'memo2', label: '摘要2（あれば）' },
  { id: 'deposit', label: '入金額' },
  { id: 'withdrawal', label: '出金額' },
  { id: 'amount', label: '金額（入金＋・出金−）' },
  { id: 'balance', label: '残高' },
];

const HEADER_WORDS = {
  date: /日付|取引日|年月日|日時|勘定日|お取引日|お取扱日/,
  memo: /摘要|内容|明細|詳細|備考|取扱|取り扱い|取引先|振込依頼人|相手/,
  deposit: /入金|預入|預け入れ|預かり|預り|受入|受け入れ/,
  withdrawal: /出金|引出|引き出し|払出|払い出し|支払/,
  amount: /^(取引|お取引|入出)?金額(\(円\))?$|^入出金(\(円\))?$/,
  balance: /残高|現在.*高/,
};

/**
 * 見出し行と列を推定する
 * @returns {{ headerRow: number, columns: { date, memo, memo2, deposit, withdrawal, amount, balance } }} 列番号（無ければ -1）
 */
export function detectColumns(rows) {
  for (let i = 0; i < Math.min(rows.length, 15); i++) {
    const cols = guessFromHeader(rows[i]);
    if (cols.date >= 0 && (cols.deposit >= 0 || cols.withdrawal >= 0 || cols.amount >= 0)) return { headerRow: i, columns: cols };
  }
  return { headerRow: -1, columns: guessFromValues(rows) };
}

function guessFromHeader(header) {
  const cols = { date: -1, memo: -1, memo2: -1, deposit: -1, withdrawal: -1, amount: -1, balance: -1 };
  const used = new Set();
  // 残高を先に決める（「お預り残高」などが入金に当たらないように）。摘要が2列あれば2つ目を摘要2にする
  for (const kind of ['balance', 'date', 'amount', 'withdrawal', 'deposit', 'memo', 'memo2']) {
    // 金額が1列（符号つき）なら入金・出金の列は探さない（「入出金内容」を出金と取り違えないように）
    if ((kind === 'deposit' || kind === 'withdrawal') && cols.amount >= 0) continue;
    const words = HEADER_WORDS[kind === 'memo2' ? 'memo' : kind];
    const i = header.findIndex((h, k) => !used.has(k) && words.test(String(h).normalize('NFKC').replace(/\s/g, '')));
    if (i >= 0) {
      cols[kind] = i;
      used.add(i);
    }
  }
  return cols;
}

function guessFromValues(rows) {
  const cols = { date: -1, memo: -1, memo2: -1, deposit: -1, withdrawal: -1, amount: -1, balance: -1 };
  const sample = rows.slice(0, 30);
  const width = Math.max(0, ...sample.map((r) => r.length));
  const rate = (k, test) => sample.filter((r) => test(r[k])).length / Math.max(1, sample.length);
  const numeric = [];
  for (let k = 0; k < width; k++) {
    if (cols.date < 0 && rate(k, (v) => parseDate(v)) > 0.6) cols.date = k;
    else if (rate(k, (v) => v !== '' && v !== undefined && Number.isFinite(parseAmount(v))) > 0.6) numeric.push(k);
    else if (cols.memo < 0 && rate(k, (v) => v && !Number.isFinite(parseAmount(v))) > 0.6) cols.memo = k;
  }
  if (numeric.length >= 2) cols.balance = numeric[numeric.length - 1];
  if (numeric.length) cols.amount = numeric[0];
  return cols;
}

/**
 * 明細を取り出す
 * @param {string[][]} rows
 * @param {{ headerRow: number, columns: object }} mapping
 * @returns {Array<{ row: number, date: string|null, memo: string, amount: number, balance: number|null, error: string|null }>}
 *   row：CSVの行番号（1始まり）、amount：入金はプラス・出金はマイナス
 */
export function extractTransactions(rows, { headerRow, columns: c }) {
  const out = [];
  for (let i = headerRow + 1; i < rows.length; i++) {
    const r = rows[i];
    const get = (k) => (k >= 0 ? r[k] ?? '' : '');
    const date = parseDate(get(c.date));
    let amount = null;
    let bad = false;
    if (c.amount >= 0) {
      amount = parseAmount(get(c.amount));
      bad = Number.isNaN(amount);
    } else {
      const dep = parseAmount(get(c.deposit));
      const wd = parseAmount(get(c.withdrawal));
      bad = Number.isNaN(dep) || Number.isNaN(wd);
      if (!bad && (dep || wd)) amount = (dep || 0) - Math.abs(wd || 0);
    }
    const balance = c.balance >= 0 ? parseAmount(get(c.balance)) : null;
    // 日付が読めない行（合計行・注記など）は飛ばす。金額の無い行（繰越など）も飛ばす
    if (!date) continue;
    if (!bad && !amount) continue;
    const memo = [get(c.memo), get(c.memo2)].filter(Boolean).join(' ').normalize('NFKC').replace(/\s+/g, ' ').trim().slice(0, 100);
    out.push({ row: i + 1, date, memo, amount: bad ? 0 : amount, balance: Number.isFinite(balance) ? balance : null, error: bad ? '金額が読めません' : null });
  }
  // 新しい順のCSVは古い順に並べ替える（同じ日付の中の順序は保つ）
  if (out.length > 1 && out[0].date > out[out.length - 1].date) out.reverse();
  return out;
}

/**
 * 残高の列があるとき、前の行の残高＋金額＝その行の残高 になっているか（列の割り当て違いに気づくため）
 * @returns {number[]} 合わない明細の CSV 行番号
 */
export function balanceMismatches(txs) {
  const bad = [];
  for (let i = 1; i < txs.length; i++) {
    const prev = txs[i - 1].balance;
    const cur = txs[i].balance;
    if (prev === null || cur === null) continue;
    if (prev + txs[i].amount !== cur) bad.push(txs[i].row);
  }
  return bad;
}

/**
 * 過去の仕訳から「摘要 → 相手科目」の対応を作る（口座の科目を使った借方1行・貸方1行の仕訳から。新しい仕訳を優先）
 * @returns {Map<string, { accountId, subAccountId, taxCategory }>} キーは正規化した摘要
 */
export function buildCounterIndex(journals, isBankAccount) {
  const index = new Map();
  const sorted = [...journals].sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : a.updatedAt < b.updatedAt ? 1 : -1));
  for (const j of sorted) {
    const pair = simplePair(j.lines);
    if (!pair) continue;
    const bankLine = [pair.debit, pair.credit].find((l) => isBankAccount(l.accountId));
    if (!bankLine) continue;
    const other = bankLine === pair.debit ? pair.credit : pair.debit;
    if (isBankAccount(other.accountId)) continue;
    const key = normalize(bankLine.memo || other.memo);
    if (key && !index.has(key)) index.set(key, { accountId: other.accountId, subAccountId: other.subAccountId || null, taxCategory: other.taxCategory });
  }
  return index;
}

/**
 * 摘要から相手科目の候補を探す。同じ摘要 → 摘要がその言葉を含む（3文字以上・長い方を優先）
 * @returns {{ accountId, subAccountId, taxCategory } | null}
 */
export function suggestCounter(memo, index) {
  const key = normalize(memo);
  if (!key) return null;
  if (index.has(key)) return index.get(key);
  let best = null;
  for (const [k, v] of index) {
    if (k.length >= 3 && key.includes(k) && (!best || k.length > best.k.length)) best = { k, v };
  }
  return best ? best.v : null;
}

/**
 * 登録済みの仕訳と同じ明細（同じ日付・口座・入出金の向き・金額）に印を付ける。同じ内容が複数あれば件数まで
 * @returns {boolean[]} 明細ごとに重複の可能性があるか
 */
export function markDuplicates(txs, journals, { accountId, subAccountId = null }) {
  const counts = new Map();
  const keyOf = (date, side, amount) => `${date}|${side}|${amount}`;
  for (const j of journals) {
    for (const l of j.lines) {
      if (l.accountId !== accountId || (l.subAccountId || null) !== (subAccountId || null)) continue;
      const k = keyOf(j.date, l.side, l.amount);
      counts.set(k, (counts.get(k) || 0) + 1);
    }
  }
  return txs.map((t) => {
    const k = keyOf(t.date, t.amount > 0 ? 'debit' : 'credit', Math.abs(t.amount));
    const n = counts.get(k) || 0;
    if (!n) return false;
    counts.set(k, n - 1);
    return true;
  });
}

/**
 * 明細を仕訳の明細にする。入金：口座 / 相手科目、出金：相手科目 / 口座
 * @param {{ amount: number, memo: string }} tx
 * @param {{ accountId, subAccountId? }} bank
 * @param {{ accountId, subAccountId?, taxCategory? }} counter
 */
export function importLines(tx, bank, counter) {
  const amount = Math.abs(tx.amount);
  const memo = tx.memo || '';
  const bankLine = { accountId: bank.accountId, subAccountId: bank.subAccountId || null, amount, taxCategory: 'none', memo };
  const otherLine = { accountId: counter.accountId, subAccountId: counter.subAccountId || null, amount, taxCategory: counter.taxCategory || 'none', memo };
  return tx.amount > 0
    ? [{ side: 'debit', ...bankLine }, { side: 'credit', ...otherLine }]
    : [{ side: 'debit', ...otherLine }, { side: 'credit', ...bankLine }];
}

/** 見出しの並びのキー（同じ銀行の形式なら同じ。列の割り当てを覚えておくため） */
export function headerSignature(rows, headerRow) {
  return headerRow >= 0 ? normalize((rows[headerRow] || []).join('|')) : `cols:${Math.max(0, ...rows.slice(0, 5).map((r) => r.length))}`;
}
