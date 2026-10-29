// 同期の手順（Googleドライブの窓口と Repository を受け取る。テストでは偽物を渡す）
//
// 1. ドライブの同期ファイルを探す。無ければこの端末のデータを書き出して終わり
// 2. ファイルを読み、バックアップと同じ検証（parseBackup）をする
// 3. 共通の履歴が無い（別々に始めた帳簿）なら自動ではマージせず、どちらで置き換えるかを利用者に選んでもらう
// 4. マージ → 全体を検証 → この端末を置き換え → ドライブを更新
//    書き込む直前にドライブのファイルが他の端末で更新されていたら、1回だけやり直す
import { mergeData, shareHistory, hasEntries, SyncError } from './sync.js';
import { createBackup, parseBackup, BackupError } from './backup.js';

export { SyncError };

/** 同期ファイルの中身（バックアップと同じ形式） */
function toText(data, appVersion) {
  return JSON.stringify(createBackup(data, { appVersion }));
}

/**
 * @param {{ db, drive, appVersion?: string, mode?: 'merge'|'useRemote'|'useLocal', now?: string }} p
 *   mode：useRemote＝ドライブの内容でこの端末を置き換える、useLocal＝この端末の内容でドライブを上書きする
 * @returns {Promise<{ result: 'uploaded'|'merged'|'replaced'|'needsChoice', changes?: string[] }>}
 */
export async function runSync({ db, drive, appVersion = '', mode = 'merge', now = new Date().toISOString() }) {
  for (let attempt = 0; attempt < 2; attempt++) {
    const local = await db.dumpAll();
    let fileId = await db.getMeta('syncFileId');
    let meta = fileId ? await drive.getMeta(fileId).catch((e) => (e.status === 404 ? null : Promise.reject(e))) : null;
    if (!meta) {
      meta = await drive.findFile();
      fileId = meta?.id || null;
    }
    if (!meta || mode === 'useLocal') {
      const saved = fileId ? await drive.update(fileId, toText(local, appVersion)) : await drive.create(toText(local, appVersion));
      await finish(db, saved.id, now);
      return { result: 'uploaded' };
    }
    let remote;
    try {
      remote = parseBackup(await drive.download(fileId));
    } catch (e) {
      if (e instanceof BackupError) throw new SyncError(`Googleドライブの同期ファイルを読み込めません：${e.message}`);
      throw e;
    }
    if (mode === 'useRemote') {
      await db.replaceAll(withCurrentPeriod(remote, local));
      await finish(db, fileId, now);
      return { result: 'replaced' };
    }
    if (!shareHistory(local, remote)) {
      // この端末にまだ何も入力していなければ、ドライブの内容をそのまま使う
      if (!hasEntries(local)) {
        await db.replaceAll(withCurrentPeriod(remote, local));
        await finish(db, fileId, now);
        return { result: 'replaced' };
      }
      return { result: 'needsChoice' };
    }
    const { data, changes } = mergeData(local, remote, { now });
    // 全体の検証（科目・期間・仕訳の整合）。不正なら何も書かない
    const checked = parseBackup(toText({ ...data, currentPeriodId: pickCurrent(data, local, remote) }, appVersion));
    const before = await drive.getMeta(fileId);
    if (before.modifiedTime !== meta.modifiedTime) continue;
    await db.replaceAll(checked);
    const saved = await drive.update(fileId, toText({ ...checked, deviceId: local.deviceId }, appVersion));
    await finish(db, saved.id, now);
    return { result: 'merged', changes };
  }
  throw new SyncError('ほかの端末が同時に同期しています。少し待ってからもう一度同期してください');
}

/** 表示中の会計期間は端末ごと。この端末の期間が残っていればそれ、無ければドライブ側 */
function pickCurrent(data, local, remote) {
  return data.periods.some((p) => p.id === local.currentPeriodId) ? local.currentPeriodId : remote.currentPeriodId;
}

function withCurrentPeriod(remote, local) {
  return { ...remote, currentPeriodId: pickCurrent(remote, local, remote) };
}

async function finish(db, fileId, now) {
  await db.setMeta('syncFileId', fileId);
  await db.setMeta('lastSyncAt', now);
  // ドライブに最新のデータがあるので、バックアップの催促の対象から外す
  await db.setMeta('lastBackupAt', now);
}
