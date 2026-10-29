// バックアップの書き出し・検証（純粋関数）。復元は検証済みのデータを Repository.replaceAll に渡す
import { validateJournal } from './journal.js';
import { GROUP_BY_ID } from './accounts.js';
import { isValidDate } from './period.js';
import { isYen } from './money.js';
import { missingRoles } from './db.js';
import { openingDiff } from './ledger.js';
import { validateAsset } from './depreciation.js';

export const BACKUP_FORMAT = 'pocket-kaikei-backup';
export const BACKUP_VERSION = 2;
/** 最後のバックアップからこの日数が過ぎ、その後に仕訳を入力していたら催促する */
export const BACKUP_REMIND_DAYS = 14;

export class BackupError extends Error {}

const STORES = ['accounts', 'subAccounts', 'periods', 'journals', 'assets', 'tombstones'];

/** バックアップの内容（JSON にする前のオブジェクト） */
export function createBackup(data, { appVersion = '', exportedAt = new Date() } = {}) {
  const counts = Object.fromEntries(STORES.map((n) => [n, (data[n] || []).length]));
  return {
    format: BACKUP_FORMAT,
    version: BACKUP_VERSION,
    exportedAt: exportedAt.toISOString(),
    appVersion,
    deviceId: data.deviceId ?? null,
    counts,
    settings: data.settings,
    currentPeriodId: data.currentPeriodId,
    ...Object.fromEntries(STORES.map((n) => [n, data[n] || []])),
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
};

/**
 * テキストを検証してデータにする。不正なら BackupError（部分的な取り込みはしない）
 * @returns {{ settings, currentPeriodId, accounts, subAccounts, periods, journals, assets, tombstones, exportedAt }}
 */
export function parseBackup(text) {
  let obj;
  try {
    obj = JSON.parse(text);
  } catch {
    throw new BackupError('JSONとして読み込めません。バックアップファイルを選んでください');
  }
  if (!isObj(obj) || obj.format !== BACKUP_FORMAT) throw new BackupError('ポケット会計のバックアップファイルではありません');
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
    if (!hasBase(sa) || !isStr(sa.name) || !accountIds.has(sa.accountId)) bad('補助科目');
    unique(sa, '補助科目');
  }
  const subById = new Map(obj.subAccounts.map((x) => [x.id, x]));
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
    const errors = validateJournal(j, { accounts: obj.accounts, subAccounts: obj.subAccounts, period: periodById.get(j.periodId), original: j });
    if (errors.length) throw new BackupError(`仕訳 No.${j.no}（${j.date}）が不正です：${errors[0]}`);
    unique(j, '仕訳');
  });
  for (const a of obj.assets) {
    if (!hasBase(a) || Object.keys(validateAsset(a, { entityType: s.entityType, accounts: obj.accounts })).length) bad('固定資産');
    unique(a, '固定資産');
  }
  for (const t of obj.tombstones) if (!isObj(t) || !isStr(t.id) || !STORES.includes(t.store)) bad('削除履歴');

  return {
    settings: s,
    currentPeriodId: obj.currentPeriodId,
    ...Object.fromEntries(STORES.map((n) => [n, obj[n]])),
    exportedAt: obj.exportedAt,
  };
}

/** バックアップを催促するか */
export function shouldRemindBackup({ lastBackupAt, latestJournalUpdatedAt, now = new Date() }) {
  if (!latestJournalUpdatedAt) return false;
  if (!lastBackupAt) return true;
  if (latestJournalUpdatedAt <= lastBackupAt) return false;
  return now.getTime() - new Date(lastBackupAt).getTime() >= BACKUP_REMIND_DAYS * 86400000;
}
