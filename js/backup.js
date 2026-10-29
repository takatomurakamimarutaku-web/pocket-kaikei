// バックアップの書き出し・検証（純粋関数）。復元は検証済みのデータを Repository.replaceAll に渡す
import { validateJournal } from './journal.js';
import { GROUP_BY_ID } from './accounts.js';
import { isValidDate } from './period.js';
import { isYen } from './money.js';
import { missingRoles } from './db.js';
import { openingDiff } from './ledger.js';
import { validateAsset } from './depreciation.js';
import { validateTemplate } from './templates.js';
import { validateBudget } from './budget.js';
import { validateAttachment, bytesToBase64, base64ToBytes, sha256Hex, toArrayBuffer } from './attachments.js';
import { validatePaymentTerms } from './receivables.js';
import { validateBreakdownTargets } from './breakdown.js';
import { REAL_ESTATE_MODES } from './real-estate.js';
import { FILING_TYPES } from './white-return.js';
import { validateDepartment } from './departments.js';

export const BACKUP_FORMAT = 'pocket-kaikei-backup';
export const BACKUP_VERSION = 7;
/** 最後のバックアップからこの日数が過ぎ、その後に仕訳を入力していたら催促する */
export const BACKUP_REMIND_DAYS = 14;

export class BackupError extends Error {}

const STORES = ['accounts', 'subAccounts', 'periods', 'journals', 'assets', 'tombstones', 'journalHistory', 'templates', 'budgets', 'attachments', 'attachmentData', 'departments'];

/**
 * バックアップの内容（JSON にする前のオブジェクト）
 * 証憑の中身（attachmentData の data）は base64 の文字列にする。includeAttachments を偽にすると証憑を含めず、
 * attachmentsOmitted を付ける（復元したとき、その端末の証憑を残す）
 */
export function createBackup(data, { appVersion = '', exportedAt = new Date(), includeAttachments = true } = {}) {
  const stores = {
    ...Object.fromEntries(STORES.map((n) => [n, data[n] || []])),
    attachments: includeAttachments ? data.attachments || [] : [],
    attachmentData: includeAttachments ? (data.attachmentData || []).map((r) => ({ ...r, data: typeof r.data === 'string' ? r.data : bytesToBase64(r.data) })) : [],
  };
  const counts = Object.fromEntries(STORES.map((n) => [n, stores[n].length]));
  return {
    format: BACKUP_FORMAT,
    version: BACKUP_VERSION,
    exportedAt: exportedAt.toISOString(),
    appVersion,
    deviceId: data.deviceId ?? null,
    counts,
    settings: data.settings,
    currentPeriodId: data.currentPeriodId,
    ...(includeAttachments ? {} : { attachmentsOmitted: true }),
    ...stores,
  };
}

export function backupFileName(date = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  return `pocket-kaikei-${date.getFullYear()}${p(date.getMonth() + 1)}${p(date.getDate())}-${p(date.getHours())}${p(date.getMinutes())}.json`;
}

const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const isStr = (v) => typeof v === 'string';
const hasBase = (r) => isObj(r) && isStr(r.id) && r.id && isStr(r.createdAt) && isStr(r.updatedAt);

/** 旧形式からの変換。BACKUP_VERSION を上げたらここに追加する */
const UPGRADES = {
  // 1 → 2：固定資産台帳（assets）を追加
  1: (obj) => ({ ...obj, version: 2, assets: [] }),
  // 2 → 3：仕訳の訂正・削除の履歴（journalHistory）を追加
  2: (obj) => ({ ...obj, version: 3, journalHistory: [] }),
  // 3 → 4：定型仕訳（templates）を追加
  3: (obj) => ({ ...obj, version: 4, templates: [] }),
  // 4 → 5：予算（budgets）を追加
  4: (obj) => ({ ...obj, version: 5, budgets: [] }),
  // 5 → 6：証憑の添付（attachments・attachmentData）を追加
  5: (obj) => ({ ...obj, version: 6, attachments: [], attachmentData: [] }),
  // 6 → 7：部門（departments）を追加
  6: (obj) => ({ ...obj, version: 7, departments: [] }),
};

/**
 * テキストを検証してデータにする。不正なら BackupError（部分的な取り込みはしない）
 * 証憑の中身は base64 から ArrayBuffer に戻す（ハッシュ値の照合は非同期のため verifyAttachments で行う）
 * @returns {{ settings, currentPeriodId, accounts, subAccounts, periods, journals, assets, tombstones, journalHistory, templates, budgets, attachments, attachmentData, departments, attachmentsOmitted, exportedAt }}
 */
export function parseBackup(text) {
  let obj;
  try {
    obj = JSON.parse(text);
  } catch {
    throw new BackupError('JSONとして読み込めません。バックアップファイルを選んでください');
  }
  if (!isObj(obj) || obj.format !== BACKUP_FORMAT) throw new BackupError('Pocket会計のバックアップファイルではありません');
  if (!Number.isInteger(obj.version) || obj.version < 1) throw new BackupError('バックアップのバージョンが不正です');
  if (obj.version > BACKUP_VERSION) throw new BackupError('新しいバージョンのアプリで作成されたファイルです。アプリを更新してから読み込んでください');
  while (obj.version < BACKUP_VERSION) {
    const up = UPGRADES[obj.version];
    if (!up) throw new BackupError(`バージョン${obj.version}のバックアップには対応していません`);
    obj = up(obj);
  }
  for (const n of STORES) if (!Array.isArray(obj[n])) throw new BackupError(`${n} がありません`);

  const s = obj.settings;
  if (!isObj(s) || !isStr(s.businessName) || !['individual', 'corporation'].includes(s.entityType) || !['taxable', 'exempt'].includes(s.taxStatus)) {
    throw new BackupError('事業者の設定が不正です');
  }
  // 銀行明細の振り分けルール（v0.12.0 で追加。無いファイルはルールなし）。科目が無いルールは使うときに無視する
  if (s.bankRules !== undefined && (!Array.isArray(s.bankRules) || s.bankRules.some((r) => !isObj(r) || !isStr(r.id) || !isStr(r.keyword) || !isStr(r.accountId)))) {
    throw new BackupError('振り分けルールのデータが不正です');
  }
  if (s.taxUseSplit !== undefined && typeof s.taxUseSplit !== 'boolean') throw new BackupError('事業者の設定が不正です');
  // 製造原価を使うか（v0.16.0 で追加。法人だけ）
  if (s.manufacturing !== undefined && (typeof s.manufacturing !== 'boolean' || (s.manufacturing && s.entityType !== 'corporation'))) throw new BackupError('事業者の設定が不正です');
  // 不動産所得（v0.39.0 で追加。個人だけ）
  if (s.realEstate !== undefined && (!REAL_ESTATE_MODES.includes(s.realEstate) || (s.realEstate !== 'none' && s.entityType !== 'individual'))) throw new BackupError('事業者の設定が不正です');
  // 申告の種類（v0.40.0 で追加。白色申告は個人だけ。無いファイルは青色）
  if (s.filing !== undefined && (!FILING_TYPES.includes(s.filing) || (s.filing === 'white' && s.entityType !== 'individual'))) throw new BackupError('事業者の設定が不正です');
  // 内訳書の対象の科目（v0.35.0 で追加）。消えた科目は使うときに外す
  if (validateBreakdownTargets(s.breakdownTargets)) throw new BackupError('内訳書の対象の科目のデータが不正です');
  const bad = (what) => {
    throw new BackupError(`${what}のデータが不正です`);
  };
  const ids = new Set();
  const unique = (r, what) => {
    if (ids.has(r.id)) bad(what);
    ids.add(r.id);
  };
  for (const a of obj.accounts) {
    if (!hasBase(a) || !isStr(a.code) || !isStr(a.name) || !GROUP_BY_ID[a.group] || !['debit', 'credit'].includes(a.normalSide)) bad('勘定科目');
    unique(a, '勘定科目');
  }
  if (new Set(obj.accounts.map((a) => a.code)).size !== obj.accounts.length) throw new BackupError('勘定科目のコードが重複しています');
  const missing = missingRoles(s.entityType, obj.accounts);
  if (missing.length) throw new BackupError('必要な勘定科目（元入金・資本金など）がありません');
  const accountIds = new Set(obj.accounts.map((a) => a.id));
  for (const sa of obj.subAccounts) {
    if (!hasBase(sa) || !isStr(sa.name) || !accountIds.has(sa.accountId) || validatePaymentTerms(sa.paymentTerms)) bad('補助科目');
    unique(sa, '補助科目');
  }
  const subById = new Map(obj.subAccounts.map((x) => [x.id, x]));
  for (const d of obj.departments) {
    if (!hasBase(d) || Object.keys(validateDepartment(d, obj.departments)).length) bad('部門');
    unique(d, '部門');
  }
  for (const p of obj.periods) {
    if (!hasBase(p) || !isValidDate(p.startDate) || !isValidDate(p.endDate) || !Array.isArray(p.openingBalances)) bad('会計期間');
    for (const ob of p.openingBalances) {
      if (!accountIds.has(ob.accountId) || !isYen(ob.amount)) bad('期首残高');
      if (ob.subAccountId && subById.get(ob.subAccountId)?.accountId !== ob.accountId) bad('期首残高');
    }
    unique(p, '会計期間');
  }
  if (s.entityType === 'corporation') {
    for (const p of obj.periods) if (openingDiff(p, obj.accounts)) throw new BackupError('期首残高の借方と貸方が一致していません');
  }
  const sortedPeriods = [...obj.periods].sort((a, b) => (a.startDate < b.startDate ? -1 : 1));
  if (sortedPeriods.some((p, i) => i > 0 && p.startDate <= sortedPeriods[i - 1].endDate)) throw new BackupError('会計期間が重なっています');
  const periodById = new Map(obj.periods.map((p) => [p.id, p]));
  if (!periodById.has(obj.currentPeriodId)) throw new BackupError('現在の会計期間が見つかりません');
  obj.journals.forEach((j) => {
    if (!hasBase(j) || !Number.isInteger(j.no) || !Array.isArray(j.lines)) bad('仕訳');
    // 無効化された科目を使った過去の仕訳も正しいので、仕訳自身を original として渡す
    const errors = validateJournal(j, { accounts: obj.accounts, subAccounts: obj.subAccounts, period: periodById.get(j.periodId), original: j, departments: obj.departments });
    if (errors.length) throw new BackupError(`仕訳 No.${j.no}（${j.date}）が不正です：${errors[0]}`);
    unique(j, '仕訳');
  });
  for (const a of obj.assets) {
    if (!hasBase(a) || Object.keys(validateAsset(a, { entityType: s.entityType, accounts: obj.accounts })).length) bad('固定資産');
    unique(a, '固定資産');
  }
  for (const t of obj.tombstones) if (!isObj(t) || !isStr(t.id) || !STORES.includes(t.store)) bad('削除履歴');
  for (const e of obj.journalHistory) {
    if (!hasBase(e) || !isStr(e.journalId) || !isStr(e.at) || !['create', 'update', 'delete', 'restore'].includes(e.action) || !(isObj(e.before) || isObj(e.after))) bad('仕訳の変更履歴');
    unique(e, '仕訳の変更履歴');
  }
  for (const t of obj.templates) {
    if (!hasBase(t) || validateTemplate(t, { accounts: obj.accounts, subAccounts: obj.subAccounts, departments: obj.departments }).length) bad('定型仕訳');
    unique(t, '定型仕訳');
  }
  for (const b of obj.budgets) {
    if (!hasBase(b) || validateBudget(b, { accounts: obj.accounts, periods: obj.periods }).length) bad('予算');
    unique(b, '予算');
  }
  if (obj.attachmentsOmitted !== undefined && typeof obj.attachmentsOmitted !== 'boolean') bad('証憑');
  const omitted = obj.attachmentsOmitted === true;
  if (omitted && (obj.attachments.length || obj.attachmentData.length)) bad('証憑');
  const attachmentById = new Map();
  for (const a of obj.attachments) {
    if (!hasBase(a) || validateAttachment(a).length) bad('証憑');
    unique(a, '証憑');
    attachmentById.set(a.id, a);
  }
  // 中身は証憑と同じ id。証憑1件に中身が1件ずつあり、大きさが一致すること
  const dataIds = new Set();
  const attachmentData = obj.attachmentData.map((r) => {
    const a = isObj(r) ? attachmentById.get(r.id) : null;
    if (!a || dataIds.has(r.id) || !isStr(r.createdAt) || !isStr(r.updatedAt)) bad('証憑の中身');
    const bytes = base64ToBytes(r.data);
    if (!bytes || bytes.length !== a.size) bad('証憑の中身');
    dataIds.add(r.id);
    return { ...r, data: toArrayBuffer(bytes) };
  });
  if (dataIds.size !== attachmentById.size) bad('証憑の中身');

  return {
    settings: s,
    currentPeriodId: obj.currentPeriodId,
    ...Object.fromEntries(STORES.map((n) => [n, obj[n]])),
    attachmentData,
    attachmentsOmitted: omitted,
    exportedAt: obj.exportedAt,
  };
}

/** 証憑の中身のハッシュ値（SHA-256）が記録と一致するか確かめる。一致しなければ BackupError */
export async function verifyAttachments(data) {
  const byId = new Map(data.attachments.map((a) => [a.id, a]));
  for (const r of data.attachmentData) {
    const a = byId.get(r.id);
    if (!a || (await sha256Hex(r.data)) !== a.sha256) throw new BackupError(`証憑「${a?.name ?? r.id}」の中身が記録（ハッシュ値）と一致しません。ファイルが壊れている可能性があります`);
  }
}

/** バックアップを催促するか */
export function shouldRemindBackup({ lastBackupAt, latestJournalUpdatedAt, now = new Date() }) {
  if (!latestJournalUpdatedAt) return false;
  if (!lastBackupAt) return true;
  if (latestJournalUpdatedAt <= lastBackupAt) return false;
  return now.getTime() - new Date(lastBackupAt).getTime() >= BACKUP_REMIND_DAYS * 86400000;
}
