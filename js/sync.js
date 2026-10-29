// 端末間の同期：2つのデータ（この端末・Googleドライブ）のマージ（純粋関数）
//
// - レコードは id で突き合わせ、updatedAt が新しい方を採る（同じなら、この端末の方）
// - 削除履歴（tombstones）は和集合。削除より後に更新されたレコードは残し、それ以外は削除する
// - 事業者の設定は updatedAt が新しい方。個人/法人が違うデータとは同期しない
// - 2台で同時に追加した結果の重複を直す：仕訳番号（期間ごと）・科目コード
// - 会計期間が重なる（2台で別々に繰り越した）場合は自動で直さず、同期を止める
// マージ後のデータは backup.parseBackup で全体を検証してから保存する

export const SYNC_STORES = ['accounts', 'subAccounts', 'periods', 'journals', 'tombstones'];

export class SyncError extends Error {}

const newer = (a, b) => (String(b.updatedAt) > String(a.updatedAt) ? b : a);

/** id で突き合わせ、新しい方を採る */
function mergeById(local = [], remote = []) {
  const map = new Map(local.map((r) => [r.id, r]));
  for (const r of remote) map.set(r.id, map.has(r.id) ? newer(map.get(r.id), r) : r);
  return [...map.values()];
}

/** 2つのデータに共通のレコードがあるか（同じ帳簿から始まったか） */
export function shareHistory(local, remote) {
  const ids = new Set(local.accounts.map((a) => a.id));
  return remote.accounts.some((a) => ids.has(a.id));
}

/** 帳簿にユーザーが入力したデータがあるか（仕訳か期首残高） */
export function hasEntries(data) {
  return data.journals.length > 0 || data.periods.some((p) => (p.openingBalances || []).length > 0);
}

/**
 * マージ
 * @param {{ settings, accounts, subAccounts, periods, journals, tombstones }} local
 * @param {{ settings, accounts, subAccounts, periods, journals, tombstones }} remote
 * @param {{ now?: string }} opts now：番号・コードを付け直したレコードの updatedAt
 * @returns {{ data, changes: string[] }} changes：付け直しなど、利用者に伝える内容
 */
export function mergeData(local, remote, { now = new Date().toISOString() } = {}) {
  if (local.settings.entityType !== remote.settings.entityType) throw new SyncError('個人/法人が違う帳簿とは同期できません');
  const changes = [];
  const settings = newer(local.settings, remote.settings);

  // 削除履歴：同じ id は新しい削除日時
  const tombMap = new Map();
  for (const t of [...(local.tombstones || []), ...(remote.tombstones || [])]) {
    const cur = tombMap.get(t.id);
    if (!cur || String(t.deletedAt) > String(cur.deletedAt)) tombMap.set(t.id, t);
  }
  const out = {};
  for (const store of ['accounts', 'subAccounts', 'periods', 'journals']) {
    const merged = mergeById(local[store], remote[store]);
    out[store] = merged.filter((r) => {
      const t = tombMap.get(r.id);
      if (!t) return true;
      if (String(r.updatedAt) > String(t.deletedAt)) {
        tombMap.delete(r.id);
        return true;
      }
      return false;
    });
  }
  out.tombstones = [...tombMap.values()];

  // 補助科目は親の科目が消えていたら除く
  const accountIds = new Set(out.accounts.map((a) => a.id));
  out.subAccounts = out.subAccounts.filter((s) => accountIds.has(s.accountId));

  // 会計期間の重なり
  const periods = [...out.periods].sort((a, b) => (a.startDate < b.startDate ? -1 : 1));
  for (let i = 1; i < periods.length; i++) {
    if (periods[i].startDate <= periods[i - 1].endDate) {
      throw new SyncError(`会計期間が重なっています（${periods[i - 1].startDate}〜 と ${periods[i].startDate}〜）。2台で別々に繰り越した可能性があります。どちらかの端末の期間を削除してから同期してください`);
    }
  }
  // 次の仕訳番号は大きい方（この後の付け直しでさらに更新する）
  const remotePeriod = new Map(remote.periods.map((p) => [p.id, p]));
  const localPeriod = new Map(local.periods.map((p) => [p.id, p]));
  out.periods = out.periods.map((p) => ({
    ...p,
    nextJournalNo: Math.max(p.nextJournalNo || 1, localPeriod.get(p.id)?.nextJournalNo || 1, remotePeriod.get(p.id)?.nextJournalNo || 1),
  }));

  out.journals = renumberJournals(out.journals, out.periods, now, changes);
  out.accounts = recodeAccounts(out.accounts, now, changes);
  return { data: { settings, ...out }, changes };
}

/** 期間ごとに仕訳番号の重複を直す。先に作られた方を残し、後の方に新しい番号を付ける */
function renumberJournals(journals, periods, now, changes) {
  const byPeriod = new Map();
  for (const j of journals) {
    if (!byPeriod.has(j.periodId)) byPeriod.set(j.periodId, []);
    byPeriod.get(j.periodId).push(j);
  }
  const result = [];
  for (const [periodId, list] of byPeriod) {
    const period = periods.find((p) => p.id === periodId);
    let next = Math.max(period?.nextJournalNo || 1, ...list.map((j) => j.no + 1));
    const seen = new Set();
    for (const j of [...list].sort((a, b) => a.no - b.no || (String(a.createdAt) < String(b.createdAt) ? -1 : 1))) {
      if (!seen.has(j.no)) {
        seen.add(j.no);
        result.push(j);
        continue;
      }
      changes.push(`仕訳 No.${j.no}（${j.date}）が重なったため No.${next} に付け直しました`);
      seen.add(next);
      result.push({ ...j, no: next++, updatedAt: now });
    }
    if (period) period.nextJournalNo = next;
  }
  return result;
}

/** 科目コードの重複を直す。先に作られた方を残し、後の方を空いている次のコードにする */
function recodeAccounts(accounts, now, changes) {
  const used = new Set();
  const result = [];
  for (const a of [...accounts].sort((x, y) => (String(x.createdAt) < String(y.createdAt) ? -1 : 1))) {
    if (!used.has(a.code)) {
      used.add(a.code);
      result.push(a);
      continue;
    }
    let n = Number(a.code) + 1;
    while (used.has(String(n)) && n < 999999) n++;
    const code = String(n);
    changes.push(`科目「${a.name}」のコード ${a.code} が重なったため ${code} に変えました`);
    used.add(code);
    result.push({ ...a, code, updatedAt: now });
  }
  return result;
}
