// 請求書・見積書（純粋関数）：金額の計算・検証・番号・売掛金の仕訳
//
// 適格請求書（インボイス）の記載事項（消費税法第57条の4第1項。国税庁 インボイス制度に関するQ&A 問54）
//   ① 適格請求書発行事業者の氏名又は名称及び登録番号
//   ② 課税資産の譲渡等を行った年月日
//   ③ 課税資産の譲渡等に係る資産又は役務の内容（軽減税率の対象品目である旨）
//   ④ 税率ごとに区分して合計した対価の額（税抜き又は税込み）及び適用税率
//   ⑤ 税率ごとに区分した消費税額等
//   ⑥ 書類の交付を受ける事業者の氏名又は名称
//   出典：https://www.nta.go.jp/taxes/shiraberu/zeimokubetsu/shohi/keigenzeiritsu/pdf/qa/01-09.pdf
// 消費税額等の端数処理は「一の適格請求書につき、税率ごとに1回」。切上げ・切捨て・四捨五入は任意で、
// 商品ごとに端数処理して合計することは認められない（同Q&A 問57）
//   出典：https://www.nta.go.jp/taxes/shiraberu/zeimokubetsu/shohi/keigenzeiritsu/pdf/qa/57.pdf
// 交付した適格請求書の写しは、交付した日の属する課税期間の末日の翌日から2月を経過した日から7年間保存する
// （消法57の4⑥、消令70の13①。同Q&A 問79）
//   出典：https://www.nta.go.jp/taxes/shiraberu/zeimokubetsu/shohi/keigenzeiritsu/pdf/qa/79.pdf
// 登録を受けていない事業者は適格請求書を交付できず、適格請求書と誤認されるおそれのある書類の交付は禁止されている
//   出典：https://www.nta.go.jp/taxes/shiraberu/zeimokubetsu/shohi/keigenzeiritsu/pdf/0020006-027.pdf
// そのため登録番号を設定していないときは登録番号の欄を出さない（ふつうの請求書になる）
import { isValidDate } from './period.js';
import { isYen, MAX_AMOUNT } from './money.js';
import { MAX_MEMO } from './journal.js';
import { createJournal } from './models.js';
import { toCsv } from './csv.js';

export const INVOICE_KINDS = {
  invoice: { id: 'invoice', label: '請求書', lead: '下記のとおりご請求申し上げます。', totalLabel: 'ご請求金額' },
  estimate: { id: 'estimate', label: '見積書', lead: '下記のとおりお見積り申し上げます。', totalLabel: 'お見積金額' },
};

/** 状態。見積書は下書き（draft）だけ。請求書は 下書き → 発行済み（売掛金を計上）→ 取消 */
export const INVOICE_STATUSES = { draft: '下書き', issued: '発行済み', void: '取消' };

/**
 * 明細の税率。taxCategory：売掛金の仕訳で売上の行に付ける税区分（tax.js）
 * reduced：軽減税率（適格請求書に「軽減税率の対象品目である旨」を書く）
 */
export const LINE_TAXES = [
  { code: '10', label: '10%', short: '10%', docLabel: '10%対象', rate: 10, taxCategory: 'sales_10' },
  { code: '8r', label: '8%（軽減）', short: '8%軽減', docLabel: '8%対象（軽減税率）', rate: 8, reduced: true, taxCategory: 'sales_8r' },
  { code: 'exempt', label: '非課税', short: '非課税', docLabel: '非課税', rate: 0, taxCategory: 'sales_exempt' },
  { code: 'none', label: '対象外', short: '対象外', docLabel: '対象外（不課税）', rate: 0, taxCategory: 'none' },
];
export const LINE_TAX_BY_CODE = Object.fromEntries(LINE_TAXES.map((t) => [t.code, t]));

/** 消費税額等の1円未満の端数処理（適格請求書ごと・税率ごとに1回） */
export const ROUNDINGS = [
  { id: 'floor', label: '切り捨て' },
  { id: 'round', label: '四捨五入' },
  { id: 'ceil', label: '切り上げ' },
];
/** 単価・金額を税抜で書くか税込で書くか */
export const PRICE_MODES = [
  { id: 'exclusive', label: '税抜' },
  { id: 'inclusive', label: '税込' },
];
export const HONORIFICS = ['御中', '様', ''];

export const MAX_INVOICE_LINES = 30;
export const MAX_NUMBER = 20;
export const MAX_NAME = 60;
export const MAX_ITEM = 60;
export const MAX_UNIT = 8;
export const MAX_NOTE = 400;
export const MAX_ADDRESS = 120;
/** 数量は小数第2位まで。100倍した整数（qty100）で持つ */
export const MAX_QTY100 = 9_999_999; // 99,999.99
export const MAX_UNIT_PRICE = 9_999_999_999;
/** 売上の科目にできる区分 */
export const REVENUE_GROUPS = ['sales', 'non_operating_income', 're_income'];

const isStr = (v) => typeof v === 'string';
const len = (v) => String(v ?? '').length;

// ---- 入力の読み取り ----

/**
 * 数量の入力を100倍の整数にする（小数第2位まで）。全角数字・カンマも受け付ける
 * @returns {{ ok: true, value: number } | { ok: false, error: string }}
 */
export function parseQuantity(text) {
  const s = String(text ?? '').normalize('NFKC').replace(/[,\s]/g, '');
  if (!s) return { ok: false, error: '数量を入力してください' };
  const m = /^(\d+)(?:\.(\d{1,2}))?$/.exec(s);
  if (!m) return { ok: false, error: /^\d+\.\d{3,}$/.test(s) ? '数量は小数第2位までで入力してください' : '数量は0より大きい数字で入力してください' };
  const value = Number(m[1]) * 100 + Number((m[2] ?? '').padEnd(2, '0'));
  if (value <= 0) return { ok: false, error: '数量は0より大きい数字で入力してください' };
  if (value > MAX_QTY100) return { ok: false, error: '数量は99,999.99までで入力してください' };
  return { ok: true, value };
}

/** 数量の表示（150 → "1.5"、200 → "2"） */
export function formatQuantity(qty100) {
  const int = Math.trunc(qty100 / 100);
  const frac = qty100 % 100;
  const head = int.toLocaleString('ja-JP');
  if (!frac) return head;
  return `${head}.${String(frac).padStart(2, '0').replace(/0$/, '')}`;
}

/**
 * 単価の入力（1円単位の整数。値引きはマイナス）
 * @returns {{ ok: true, value: number } | { ok: false, error: string }}
 */
export function parseUnitPrice(text) {
  let s = String(text ?? '').normalize('NFKC').replace(/[,\s]/g, '').replace(/^¥|円$/g, '');
  s = s.replace(/^[△▲]/, '-');
  if (!s) return { ok: false, error: '単価を入力してください' };
  if (!/^-?\d+$/.test(s)) return { ok: false, error: /^-?\d*\.\d+$/.test(s) ? '単価は1円単位の整数で入力してください' : '単価は数字で入力してください（値引きはマイナス）' };
  const value = Number(s);
  if (!Number.isSafeInteger(value) || Math.abs(value) > MAX_UNIT_PRICE) return { ok: false, error: '単価が大きすぎます' };
  return { ok: true, value };
}

/** 登録番号の入力を整える（全角→半角、空白・ハイフンを除く、t → T）。空なら '' */
export function normalizeRegistrationNo(text) {
  return String(text ?? '')
    .normalize('NFKC')
    .replace(/[\s\-‐－]/g, '')
    .toUpperCase();
}

/** 登録番号の形式（T＋13桁の数字）。国税庁の公表サイトとの照合はしない */
export function isRegistrationNo(v) {
  return /^T\d{13}$/.test(v);
}

// ---- 金額 ----

/** 明細の金額＝数量×単価（1円未満は0の方向へ切り捨て）。大きな数でも誤差が出ないよう BigInt で計算する */
export function lineAmount(line) {
  return Number((BigInt(line.qty100) * BigInt(line.unitPrice)) / 100n);
}

/** a÷b（b>0）を端数処理する。マイナスは絶対値で処理して符号を戻す */
function roundDiv(a, b, mode) {
  const sign = a < 0 ? -1 : 1;
  const x = Math.abs(a);
  const q = Math.floor(x / b);
  const r = x - q * b;
  let v = q;
  if (mode === 'ceil' && r > 0) v = q + 1;
  else if (mode === 'round' && r * 2 >= b) v = q + 1;
  return sign * v;
}

/**
 * 税率ごとの合計と消費税額等。端数処理は税率ごとに1回（問57）
 * 税抜：消費税額＝税抜合計×税率、税込合計＝税抜合計＋消費税額
 * 税込：消費税額＝税込合計×税率/(100＋税率)、税抜合計＝税込合計−消費税額
 * @returns {{ groups: Array<{ code, label, docLabel, rate, reduced, count, sum, net, tax, gross }>, net, tax, total, hasReduced: boolean }}
 *   sum：明細の金額の合計（税抜か税込かは priceMode のまま）。groups は明細のある税率だけ（10%・8%・非課税・対象外の順）
 */
export function invoiceTotals(invoice) {
  const mode = invoice.rounding || 'floor';
  const inclusive = invoice.priceMode === 'inclusive';
  const groups = [];
  for (const t of LINE_TAXES) {
    const lines = (invoice.lines || []).filter((l) => l.tax === t.code);
    if (!lines.length) continue;
    const sum = lines.reduce((s, l) => s + lineAmount(l), 0);
    let net = sum;
    let tax = 0;
    let gross = sum;
    if (t.rate) {
      if (inclusive) {
        tax = roundDiv(sum * t.rate, 100 + t.rate, mode);
        net = sum - tax;
      } else {
        tax = roundDiv(sum * t.rate, 100, mode);
        gross = sum + tax;
      }
    }
    groups.push({ code: t.code, label: t.label, docLabel: t.docLabel, rate: t.rate, reduced: Boolean(t.reduced), count: lines.length, sum, net, tax, gross });
  }
  return {
    groups,
    net: groups.reduce((s, g) => s + g.net, 0),
    tax: groups.reduce((s, g) => s + g.tax, 0),
    total: groups.reduce((s, g) => s + g.gross, 0),
    hasReduced: groups.some((g) => g.reduced),
  };
}

// ---- 検証 ----

/**
 * 請求書の設定（発行元の情報）。settings.invoice に持つ（バックアップに入る）
 * @returns {string[]} 誤りの一覧
 */
export function validateInvoiceSettings(s) {
  if (s === undefined || s === null) return [];
  if (typeof s !== 'object' || Array.isArray(s)) return ['請求書の設定が正しくありません'];
  const errors = [];
  if (s.registrationNo && !isRegistrationNo(s.registrationNo)) errors.push('登録番号は「T」と13桁の数字で入力してください');
  if (len(s.issuerName) > MAX_NAME) errors.push(`発行元の名前は${MAX_NAME}文字以内にしてください`);
  for (const [k, label] of [['address', '住所'], ['phone', '電話番号'], ['email', 'メールアドレス']]) if (len(s[k]) > MAX_ADDRESS) errors.push(`${label}は${MAX_ADDRESS}文字以内にしてください`);
  if (len(s.bank) > MAX_NOTE) errors.push(`振込先は${MAX_NOTE}文字以内にしてください`);
  if (len(s.note) > MAX_NOTE) errors.push(`備考の初期値は${MAX_NOTE}文字以内にしてください`);
  if (s.rounding !== undefined && !ROUNDINGS.some((r) => r.id === s.rounding)) errors.push('端数処理を選んでください');
  if (s.priceMode !== undefined && !PRICE_MODES.some((m) => m.id === s.priceMode)) errors.push('税抜・税込を選んでください');
  for (const k of ['registrationNo', 'issuerName', 'address', 'phone', 'email', 'bank', 'note']) if (s[k] !== undefined && !isStr(s[k])) errors.push('請求書の設定が正しくありません');
  return [...new Set(errors)];
}

/** 売上の科目にできるか */
export function isRevenueAccount(account) {
  return Boolean(account) && REVENUE_GROUPS.includes(account.group);
}

/**
 * 請求書・見積書の検証
 * @param {object} inv
 * @param {{ accounts, subAccounts, original?: object|null }} ctx original：保存済みのもの（無効にした科目・取引先をそのまま使える）
 * @returns {string[]}
 */
export function validateInvoice(inv, { accounts, subAccounts, original = null }) {
  const errors = [];
  const kind = INVOICE_KINDS[inv.kind];
  if (!kind) return ['請求書か見積書かが正しくありません'];
  if (!Object.hasOwn(INVOICE_STATUSES, inv.status) || (inv.kind === 'estimate' && inv.status !== 'draft')) errors.push('状態が正しくありません');
  if (!isStr(inv.number) || !inv.number.trim()) errors.push(`${kind.label}の番号を入力してください`);
  else if (inv.number.length > MAX_NUMBER) errors.push(`番号は${MAX_NUMBER}文字以内にしてください`);
  if (!isValidDate(inv.issueDate)) errors.push('発行日を入力してください');
  const customer = inv.customer;
  if (!customer || typeof customer !== 'object') errors.push('宛先を入力してください');
  else {
    if (!isStr(customer.name) || !customer.name.trim()) errors.push('宛先（相手の名前）を入力してください');
    else if (customer.name.length > MAX_NAME) errors.push(`宛先は${MAX_NAME}文字以内にしてください`);
    if (!HONORIFICS.includes(customer.honorific ?? '')) errors.push('敬称を選んでください');
    if (customer.subAccountId) {
      const sub = subAccounts.find((s) => s.id === customer.subAccountId);
      const acc = sub && accounts.find((a) => a.id === sub.accountId);
      if (!sub || acc?.hint !== 'receivable') errors.push('取引先（売掛金の補助科目）が見つかりません');
      else if (!sub.active && original?.customer?.subAccountId !== sub.id) errors.push(`取引先「${sub.name}」は無効になっています`);
    }
  }
  if (len(inv.subject) > MAX_NAME) errors.push(`件名は${MAX_NAME}文字以内にしてください`);
  if (len(inv.note) > MAX_NOTE) errors.push(`備考は${MAX_NOTE}文字以内にしてください`);
  if (!PRICE_MODES.some((m) => m.id === inv.priceMode)) errors.push('税抜・税込を選んでください');
  if (!ROUNDINGS.some((r) => r.id === inv.rounding)) errors.push('端数処理を選んでください');
  if (inv.kind === 'invoice') {
    // ② 取引年月日（一定期間の取引をまとめるときは期間）
    if (!isValidDate(inv.deliveryFrom)) errors.push('取引年月日を入力してください');
    if (inv.deliveryTo != null && inv.deliveryTo !== '' && (!isValidDate(inv.deliveryTo) || inv.deliveryTo < inv.deliveryFrom)) errors.push('取引年月日の終わりは始めより後の日付にしてください');
    if (inv.dueDate != null && inv.dueDate !== '' && !isValidDate(inv.dueDate)) errors.push('支払期限の日付が正しくありません');
    const acc = accounts.find((a) => a.id === inv.revenueAccountId);
    if (!isRevenueAccount(acc)) errors.push('売上の科目を選んでください');
    else if (!acc.active && original?.revenueAccountId !== acc.id) errors.push(`「${acc.name}」は無効になっています`);
  } else if (inv.validUntil != null && inv.validUntil !== '' && !isValidDate(inv.validUntil)) errors.push('有効期限の日付が正しくありません');
  const lines = Array.isArray(inv.lines) ? inv.lines : [];
  if (!lines.length) errors.push('明細を1行以上入力してください');
  if (lines.length > MAX_INVOICE_LINES) errors.push(`明細は${MAX_INVOICE_LINES}行までです`);
  let linesOk = true;
  lines.forEach((l, i) => {
    const at = `明細${i + 1}行目`;
    const before = errors.length;
    if (!isStr(l.name) || !l.name.trim()) errors.push(`${at}：品名・内容を入力してください`);
    else if (l.name.length > MAX_ITEM) errors.push(`${at}：品名は${MAX_ITEM}文字以内にしてください`);
    if (len(l.unit) > MAX_UNIT) errors.push(`${at}：単位は${MAX_UNIT}文字以内にしてください`);
    if (!Number.isInteger(l.qty100) || l.qty100 <= 0 || l.qty100 > MAX_QTY100) errors.push(`${at}：数量は0より大きく99,999.99までにしてください`);
    if (!Number.isSafeInteger(l.unitPrice) || Math.abs(l.unitPrice) > MAX_UNIT_PRICE) errors.push(`${at}：単価は1円単位の整数にしてください`);
    if (!LINE_TAX_BY_CODE[l.tax]) errors.push(`${at}：税率を選んでください`);
    if (errors.length === before && Math.abs(lineAmount(l)) > MAX_AMOUNT) errors.push(`${at}：金額が大きすぎます`);
    if (errors.length !== before) linesOk = false;
  });
  if (linesOk && lines.length) {
    const totals = invoiceTotals(inv);
    if (totals.groups.some((g) => g.gross < 0)) errors.push('税率ごとの合計がマイナスになっています（値引きは同じ税率の明細の金額までにしてください）');
    if (totals.total <= 0) errors.push('合計金額は1円以上にしてください');
    if (totals.total > MAX_AMOUNT) errors.push('合計金額が大きすぎます');
  }
  for (const k of ['issuedAt', 'voidedAt']) if (inv[k] != null && !isStr(inv[k])) errors.push('状態が正しくありません');
  if (inv.status === 'issued' && !isStr(inv.issuedAt)) errors.push('状態が正しくありません');
  return [...new Set(errors)];
}

// ---- 番号 ----

/**
 * 次の番号。同じ種類の番号のうち末尾の数字が最大のものに1を足す（前の部分と桁数はそのまま。例 INV-0012 → INV-0013）
 * 1件も無ければ 0001
 */
export function nextInvoiceNumber(invoices, kind) {
  let best = null;
  for (const inv of invoices) {
    if (inv.kind !== kind) continue;
    const m = /^(.*?)(\d+)$/.exec(String(inv.number ?? ''));
    if (!m) continue;
    const n = BigInt(m[2]);
    if (!best || n > best.n) best = { prefix: m[1], digits: m[2].length, n };
  }
  if (!best) return '0001';
  return `${best.prefix}${String(best.n + 1n).padStart(best.digits, '0')}`;
}

/** 同じ種類で番号が重なっているか */
export function isDuplicateNumber(invoices, inv) {
  const key = String(inv.number ?? '').trim();
  return invoices.some((x) => x.id !== inv.id && x.kind === inv.kind && String(x.number).trim() === key);
}

// ---- 売掛金の仕訳 ----

/** 売上の計上日：取引年月日（期間のときは最後の日） */
export function postingDate(inv) {
  return inv.deliveryTo || inv.deliveryFrom;
}

/** 宛名の表示（〇〇株式会社 御中） */
export function customerLabel(customer) {
  return [customer?.name ?? '', customer?.honorific ?? ''].filter(Boolean).join(' ');
}

const clip = (s) => (s.length > MAX_MEMO ? s.slice(0, MAX_MEMO) : s);

/**
 * 発行した請求書の仕訳：借方 売掛金（取引先の補助科目）／貸方 売上の科目（税率ごとに1行・税込）
 * 税率ごとに1行にするのは、積上げ計算（明細1行を1枚の適格請求書とみなす。tax-return.js）で請求書の消費税額と一致させるため。
 * 税込経理なので売上は税込合計（税抜で書いた請求書は税抜合計＋消費税額）
 * @param {object} inv 請求書
 * @param {{ accounts, subAccounts, periodId: string }} ctx
 */
export function invoiceJournal(inv, { accounts, subAccounts, periodId }) {
  const totals = invoiceTotals(inv);
  const sub = inv.customer?.subAccountId ? subAccounts.find((s) => s.id === inv.customer.subAccountId) : null;
  const receivable = sub ? accounts.find((a) => a.id === sub.accountId) : accounts.find((a) => a.hint === 'receivable' && a.active) || accounts.find((a) => a.hint === 'receivable');
  if (!receivable) throw new Error('売掛金の科目がありません');
  const ref = `請求書No.${inv.number}`;
  const memo = clip(`${inv.customer.name} ${ref}${inv.subject ? ` ${inv.subject}` : ''}`);
  const lines = [{ side: 'debit', accountId: receivable.id, subAccountId: sub?.id ?? null, amount: totals.total, taxCategory: 'none', memo }];
  for (const g of totals.groups) {
    if (g.gross <= 0) continue;
    lines.push({ side: 'credit', accountId: inv.revenueAccountId, subAccountId: null, amount: g.gross, taxCategory: LINE_TAX_BY_CODE[g.code].taxCategory, memo });
  }
  return createJournal({ periodId, date: postingDate(inv), lines, source: 'invoice', sourceId: inv.id });
}

// ---- 作成・複製 ----

/**
 * 新しい請求書・見積書の下書き
 * @param {{ kind, number, today, settings, accounts }} opts
 */
export function invoiceDraft({ kind, number, today, settings, accounts }) {
  const inv = settings?.invoice || {};
  const sales = accounts.find((a) => a.hint === 'sales' && a.active) || accounts.find((a) => isRevenueAccount(a) && a.active);
  return {
    kind,
    status: 'draft',
    number,
    issueDate: today,
    customer: { name: '', honorific: '御中', subAccountId: null },
    subject: '',
    priceMode: inv.priceMode || 'exclusive',
    rounding: inv.rounding || 'floor',
    lines: [{ name: '', qty100: 100, unit: '', unitPrice: 0, tax: settings?.taxStatus === 'exempt' && !inv.registrationNo ? 'none' : '10' }],
    note: inv.note || '',
    ...(kind === 'invoice' ? { deliveryFrom: today, deliveryTo: '', dueDate: '', revenueAccountId: sales?.id ?? '', estimateId: null } : { validUntil: '' }),
  };
}

/**
 * 複製（見積書から請求書を作るときも使う）。番号・日付は新しくし、状態は下書きに戻す
 * @param {object} src 元の請求書・見積書
 * @param {{ kind, number, today, accounts }} opts
 */
export function copyInvoice(src, { kind = src.kind, number, today, accounts }) {
  const base = invoiceDraft({ kind, number, today, settings: null, accounts });
  return {
    ...base,
    customer: { ...src.customer },
    subject: src.subject || '',
    priceMode: src.priceMode,
    rounding: src.rounding,
    lines: src.lines.map((l) => ({ name: l.name, qty100: l.qty100, unit: l.unit || '', unitPrice: l.unitPrice, tax: l.tax })),
    note: src.note || '',
    ...(kind === 'invoice' ? { revenueAccountId: src.kind === 'invoice' ? src.revenueAccountId : base.revenueAccountId, estimateId: src.kind === 'estimate' ? src.id : null } : {}),
  };
}

// ---- 一覧 ----

/** 一覧の並び：発行日の新しい順、同じ日は番号の大きい順 */
export function compareInvoices(a, b) {
  if (a.issueDate !== b.issueDate) return a.issueDate < b.issueDate ? 1 : -1;
  return String(b.number).localeCompare(String(a.number), 'ja', { numeric: true });
}

/** 一覧の CSV の行（発行日・番号・宛先・件名・税率ごとの合計・消費税・合計・状態） */
export function invoiceRows(invoices) {
  return invoices.map((inv) => {
    const t = invoiceTotals(inv);
    const by = (code) => t.groups.find((g) => g.code === code);
    return {
      inv,
      totals: t,
      gross10: by('10')?.gross ?? 0,
      tax10: by('10')?.tax ?? 0,
      gross8: by('8r')?.gross ?? 0,
      tax8: by('8r')?.tax ?? 0,
      other: (by('exempt')?.gross ?? 0) + (by('none')?.gross ?? 0),
    };
  });
}

/** 一覧の CSV（交付した請求書の控えの索引として使う）。金額は -1000 形式 */
export function invoicesCsv(invoices) {
  const header = ['種類', '番号', '発行日', '取引年月日', '支払期限・有効期限', '宛先', '件名', '10%対象（税込）', '10%の消費税', '8%対象（税込）', '8%の消費税', '非課税・対象外', '合計（税込）', '状態'];
  const d = (v) => (v ? v.replaceAll('-', '/') : '');
  return toCsv([
    header,
    ...invoiceRows(invoices).map(({ inv, totals, gross10, tax10, gross8, tax8, other }) => [
      INVOICE_KINDS[inv.kind].label,
      inv.number,
      d(inv.issueDate),
      inv.kind === 'invoice' ? [d(inv.deliveryFrom), d(inv.deliveryTo)].filter(Boolean).join('〜') : '',
      d(inv.kind === 'invoice' ? inv.dueDate : inv.validUntil),
      customerLabel(inv.customer),
      inv.subject || '',
      gross10,
      tax10,
      gross8,
      tax8,
      other,
      totals.total,
      inv.kind === 'estimate' ? (inv.invoiceId ? '請求書を作成済み' : '') : INVOICE_STATUSES[inv.status],
    ]),
  ]);
}
