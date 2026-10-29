// 証憑（領収書・請求書などの画像・PDF）の添付（純粋関数）
//
// 電子取引のデータ（メールで受け取った PDF の請求書など）は、受け取ったファイルをそのまま保存し、
// 取引年月日・取引金額・取引先で検索できるようにする（電子帳簿保存法第7条、規則第4条第1項・第2条第6項第5号）
//   国税庁「電子取引データの保存方法をご確認ください」
//   https://www.nta.go.jp/law/joho-zeikaishaku/sonota/jirei/tokusetsu/pdf/0023011-012.pdf
//   電子帳簿保存法一問一答【電子取引関係】問29（事務処理規程）・問43（検索の組合せ）
//   https://www.nta.go.jp/law/joho-zeikaishaku/sonota/jirei/pdf/0024005-113_r603.pdf
// 紙の証憑の撮影は、スキャナ保存の要件（解像度・階調・タイムスタンプ・入力期間・表示装置など）をすべて満たすとは
// 言えないため、紙の原本も保存する前提とする。撮影した画像は A4 を 200dpi 相当（約387万画素）以上で残す大きさにする
//   電子帳簿保存法一問一答【スキャナ保存関係】https://www.nta.go.jp/law/joho-zeikaishaku/sonota/jirei/pdf/0024005-113_r602.pdf
//   国税庁「スキャナ保存の要件」https://www.nta.go.jp/law/joho-zeikaishaku/sonota/jirei/07scan/02.htm
import { isValidDate } from './period.js';
import { normalize } from './search.js';

export const ATTACHMENT_KINDS = { paper: '紙の証憑（撮影）', electronic: '電子取引のデータ' };
/** 1ファイルの上限（端末の容量とバックアップの大きさを考えて） */
export const MAX_ATTACHMENT_BYTES = 10 * 1024 * 1024;
/** 撮影した画像の長辺の上限（A4 を 200dpi で読むと 2338×1654。これを下回らない大きさ） */
export const PHOTO_LONG_SIDE = 2400;
export const PHOTO_QUALITY = 0.85;
/** 一覧の縮小画像の長辺 */
export const THUMB_SIZE = 240;
const MAX_AMOUNT = 999999999999;

/** 画面で表示できる種類（それ以外は保存して開く） */
export const PREVIEW_TYPES = ['image/jpeg', 'image/png', 'image/webp', 'image/gif'];
/** 添付できるファイルの種類（拡張子は type が空のときの推定用） */
const TYPES = {
  'image/jpeg': ['jpg', 'jpeg'],
  'image/png': ['png'],
  'image/webp': ['webp'],
  'image/gif': ['gif'],
  'image/heic': ['heic'],
  'image/heif': ['heif'],
  'application/pdf': ['pdf'],
  'application/xml': ['xml'],
  'text/xml': [],
  'text/csv': ['csv'],
  'text/plain': ['txt'],
};
export const ACCEPT_TYPES = Object.keys(TYPES);
/** input[type=file] の accept */
export const ACCEPT_ATTR = [...ACCEPT_TYPES, ...Object.values(TYPES).flat().map((e) => `.${e}`)].join(',');

/** ファイルの種類（type が空や汎用のときは拡張子から推定）。添付できないものは '' */
export function attachmentType(name, type) {
  const t = String(type || '').toLowerCase();
  if (TYPES[t]) return t;
  const ext = String(name || '').toLowerCase().split('.').pop();
  return Object.entries(TYPES).find(([, exts]) => exts.includes(ext))?.[0] ?? '';
}

export const isImageType = (type) => String(type).startsWith('image/');

/** 種類の短い名前（一覧の表示用） */
export function typeLabel(type) {
  return { 'application/pdf': 'PDF', 'application/xml': 'XML', 'text/xml': 'XML', 'text/csv': 'CSV', 'text/plain': 'テキスト' }[type] || (isImageType(type) ? '画像' : 'ファイル');
}

/** 保存するときの拡張子 */
export function extensionOf(type) {
  return TYPES[type]?.[0] || (type === 'text/xml' ? 'xml' : 'bin');
}

/**
 * 添付の情報の検証
 * @returns {string[]} 誤り
 */
export function validateAttachment(a) {
  const errors = [];
  if (!ATTACHMENT_KINDS[a.kind]) errors.push('証憑の種類が不正です');
  if (typeof a.name !== 'string' || !a.name.trim() || a.name.length > 200) errors.push('ファイル名が不正です');
  if (!ACCEPT_TYPES.includes(a.type)) errors.push('添付できるのは画像・PDF・XML・CSV・テキストのファイルです');
  if (!Number.isInteger(a.size) || a.size < 1) errors.push('ファイルが空です');
  else if (a.size > MAX_ATTACHMENT_BYTES) errors.push(`ファイルが大きすぎます（${formatBytes(MAX_ATTACHMENT_BYTES)}まで）`);
  if (typeof a.sha256 !== 'string' || !/^[0-9a-f]{64}$/.test(a.sha256)) errors.push('ハッシュ値が不正です');
  if (a.date && !isValidDate(a.date)) errors.push('取引年月日が不正です');
  if (a.amount != null && (!Number.isInteger(a.amount) || a.amount < 0 || a.amount > MAX_AMOUNT)) errors.push('取引金額は0以上の整数（円）にしてください');
  if (typeof a.partner !== 'string' || a.partner.length > 100) errors.push('取引先は100文字までにしてください');
  if (typeof a.memo !== 'string' || a.memo.length > 200) errors.push('メモは200文字までにしてください');
  if (a.journalId != null && (typeof a.journalId !== 'string' || !a.journalId)) errors.push('仕訳の参照が不正です');
  if (a.thumb != null && (typeof a.thumb !== 'string' || !/^data:image\/(jpeg|png|webp);base64,[A-Za-z0-9+/=]+$/.test(a.thumb) || a.thumb.length > 200000)) errors.push('縮小画像が不正です');
  return errors;
}

/** 利用者が直せる項目 */
export const EDITABLE_FIELDS = ['kind', 'date', 'amount', 'partner', 'memo'];

/**
 * 仕訳から、取引年月日・取引金額・取引先の初期値を作る
 * 金額は借方の合計。取引先は現金・預金以外の科目の補助科目名、なければ最初の摘要
 * @param {object} journal { date, lines }
 * @param {{ subById: Map, isCash: (accountId) => boolean }} ctx
 */
export function attachmentDefaults(journal, { subById, isCash = () => false }) {
  const lines = journal?.lines || [];
  const amount = lines.filter((l) => l.side === 'debit').reduce((s, l) => s + (Number.isInteger(l.amount) ? l.amount : 0), 0);
  const subLine = lines.find((l) => l.subAccountId && subById.get(l.subAccountId) && !isCash(l.accountId));
  const partner = subLine ? subById.get(subLine.subAccountId).name : lines.find((l) => l.memo)?.memo || '';
  return { date: journal?.date || '', amount: amount || null, partner: partner.slice(0, 100) };
}

/** 空欄の項目だけ初期値で補う（新規の仕訳に先に添付したとき、登録した仕訳の内容で補う） */
export function fillBlank(meta, defaults) {
  return {
    ...meta,
    date: meta.date || defaults.date || '',
    amount: meta.amount ?? defaults.amount ?? null,
    partner: meta.partner || defaults.partner || '',
  };
}

/**
 * 証憑の検索（取引年月日・取引金額の範囲、取引先、種類を組み合わせる）
 * 範囲を指定したとき、日付・金額が空欄の証憑は外す。新しい日付順
 * @param {Array} list
 * @param {{ from?, to?, min?, max?, party?, kind?, unlinked?, journalIds?: Set }} c
 *   unlinked：仕訳がない（削除された）証憑だけ。journalIds で今ある仕訳の id を渡す
 */
export function searchAttachments(list, { from = '', to = '', min = null, max = null, party = '', kind = '', unlinked = false, journalIds = null } = {}) {
  const q = normalize(party);
  return list
    .filter((a) => {
      if (from && (!a.date || a.date < from)) return false;
      if (to && (!a.date || a.date > to)) return false;
      if (min != null && (a.amount == null || a.amount < min)) return false;
      if (max != null && (a.amount == null || a.amount > max)) return false;
      if (kind && a.kind !== kind) return false;
      if (q && ![a.partner, a.memo, a.name].some((s) => normalize(s).includes(q))) return false;
      if (unlinked && a.journalId && journalIds?.has(a.journalId)) return false;
      return true;
    })
    .sort((a, b) => (a.date === b.date ? (a.createdAt < b.createdAt ? 1 : -1) : (a.date || '') < (b.date || '') ? 1 : -1));
}

/**
 * 保存するときのファイル名（国税庁の例「20221031_㈱国税商事_110000.pdf」と同じ並び）
 * 日付・取引先・金額がなければ元のファイル名
 */
export function attachmentFileName(a) {
  const parts = [a.date ? a.date.replaceAll('-', '') : '', String(a.partner || '').replace(/[\\/:*?"<>|\s]+/g, '').slice(0, 40), a.amount != null ? String(a.amount) : ''];
  if (!parts[0] && !parts[1] && !parts[2]) return a.name;
  return `${parts.filter(Boolean).join('_')}.${extensionOf(a.type)}`;
}

/** 長辺を maxSide 以下に縮める大きさ（拡大はしない） */
export function fitSize(width, height, maxSide) {
  const long = Math.max(width, height);
  if (long <= maxSide) return { width, height, scaled: false };
  const r = maxSide / long;
  return { width: Math.max(1, Math.round(width * r)), height: Math.max(1, Math.round(height * r)), scaled: true };
}

export function formatBytes(n) {
  if (n >= 1024 * 1024) return `${(Math.round((n / 1024 / 1024) * 10) / 10).toFixed(1)}MB`;
  if (n >= 1024) return `${Math.round(n / 1024)}KB`;
  return `${n}B`;
}

// ---- バイト列と base64（バックアップの JSON に入れるため） ----

/** @param {ArrayBuffer|Uint8Array} data */
export function bytesToBase64(data) {
  const bytes = data instanceof Uint8Array ? data : new Uint8Array(data);
  let bin = '';
  // 大きな配列を一度に String.fromCharCode へ渡すとスタックがあふれるため分けて変換する
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  return btoa(bin);
}

/** base64 をバイト列にする。不正な文字列は null */
export function base64ToBytes(text) {
  if (typeof text !== 'string' || !/^[A-Za-z0-9+/]*={0,2}$/.test(text) || text.length % 4) return null;
  try {
    const bin = atob(text);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  } catch {
    return null;
  }
}

/** SHA-256 のハッシュ値（16進の小文字） */
export async function sha256Hex(data) {
  const digest = await crypto.subtle.digest('SHA-256', data instanceof Uint8Array ? data : new Uint8Array(data));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** ArrayBuffer に揃える（Uint8Array の一部を指すときはその範囲だけ複製） */
export function toArrayBuffer(data) {
  if (data instanceof ArrayBuffer) return data;
  if (ArrayBuffer.isView(data)) return data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength);
  throw new TypeError('バイト列ではありません');
}
