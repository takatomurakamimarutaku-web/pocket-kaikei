// 仕訳の訂正・削除の履歴と、優良な電子帳簿の検索（純粋関数）
//
// 優良な電子帳簿の要件（電子帳簿保存法施行規則 第5条第5項第1号。国税庁「優良な電子帳簿の要件」・電子帳簿保存法一問一答 Q15〜Q33 で確認）
//   イ 訂正・削除の事実と内容を確認できる。通常の業務処理期間（最長2か月）を過ぎた後の入力の事実を確認できる
//   ロ 帳簿間の記録事項の相互関連性（仕訳帳の番号で総勘定元帳と結びつける）
//   ハ 取引年月日・取引金額・取引先で検索でき、日付・金額は範囲指定、2つ以上の項目の組合せで検索できる
//   https://www.nta.go.jp/law/joho-zeikaishaku/sonota/jirei/05.htm
// 令和9年分以後の青色申告特別控除75万円の要件（令和8年度税制改正）
import { newId } from './models.js';
import { addMonths } from './period.js';

/** 通常の業務処理期間（一問一答 Q29・Q30：最長2か月の業務サイクルまでは通常の期間） */
export const LATE_INPUT_MONTHS = 2;

export const HISTORY_ACTIONS = { create: '登録', update: '訂正', delete: '削除', restore: '削除の取消' };

/** 比べる項目（updatedAt など保存のたびに変わる項目は比べない） */
const snapshot = (j) => (j ? { date: j.date, voucherNo: j.voucherNo ?? null, lines: j.lines, source: j.source ?? null } : null);

/** 内容が変わったか */
export function journalChanged(before, after) {
  return JSON.stringify(snapshot(before)) !== JSON.stringify(snapshot(after));
}

/**
 * 履歴の1件
 * @param {'create'|'update'|'delete'|'restore'} action
 * @param {object|null} before 変更前の仕訳
 * @param {object|null} after 変更後の仕訳
 */
export function historyEntry(action, before, after, at = new Date().toISOString()) {
  const j = after || before;
  return { id: newId(), journalId: j.id, periodId: j.periodId, journalNo: j.no ?? null, action, at, before: before || null, after: after || null, createdAt: at, updatedAt: at };
}

/** 取引日から通常の業務処理期間（2か月）を過ぎてから入力したか */
export function isLateInput(journalDate, inputAt) {
  if (!journalDate || !inputAt) return false;
  return inputAt.slice(0, 10) > addMonths(journalDate, LATE_INPUT_MONTHS);
}

/** 仕訳の借方合計（取引金額） */
export function journalAmount(j) {
  return j.lines.filter((l) => l.side === 'debit').reduce((s, l) => s + l.amount, 0);
}

/**
 * 組合せ検索（すべての条件を満たす仕訳）
 * @param {Array} journals
 * @param {{ dateFrom?, dateTo?, amountMin?, amountMax?, accountId?, party?, text?, voucherFrom?, voucherTo? }} c
 *   金額は仕訳の借方合計か、いずれかの行の金額が範囲に入れば当てはまる
 *   取引先（party）は補助科目の名前か摘要に含まれる文字
 * @param {{ subById: Map, normalize: Function, accountById: Map }} ctx
 */
export function searchJournals(journals, c, { subById, normalize, accountById }) {
  const party = c.party ? normalize(c.party) : '';
  const text = c.text ? normalize(c.text) : '';
  const inRange = (n) => (c.amountMin == null || n >= c.amountMin) && (c.amountMax == null || n <= c.amountMax);
  return journals.filter((j) => {
    if (c.dateFrom && j.date < c.dateFrom) return false;
    if (c.dateTo && j.date > c.dateTo) return false;
    if ((c.amountMin != null || c.amountMax != null) && !(inRange(journalAmount(j)) || j.lines.some((l) => inRange(l.amount)))) return false;
    if (c.accountId && !j.lines.some((l) => l.accountId === c.accountId)) return false;
    const voucher = j.voucherNo ?? j.no;
    if ((c.voucherFrom != null && voucher < c.voucherFrom) || (c.voucherTo != null && voucher > c.voucherTo)) return false;
    if (party && !j.lines.some((l) => [subById.get(l.subAccountId)?.name, l.memo].some((t) => t && normalize(t).includes(party)))) return false;
    if (text && !j.lines.some((l) => [l.memo, accountById.get(l.accountId)?.name, subById.get(l.subAccountId)?.name].some((t) => t && normalize(t).includes(text)))) return false;
    return true;
  });
}

/** 検索条件が1つでも入っているか */
export function hasCriteria(c) {
  return Boolean(c.dateFrom || c.dateTo || c.amountMin != null || c.amountMax != null || c.accountId || c.party || c.text || c.voucherFrom != null || c.voucherTo != null);
}

/**
 * 変更の内容（行ごとの差分の説明）
 * @returns {string[]} 例：「日付 2026-05-01 → 2026-05-02」「借方 消耗品費 3,300 → 4,400」
 */
export function describeChange(before, after, { accountById, subById, formatYen, departmentById = new Map() }) {
  if (!before || !after) return [];
  const out = [];
  if (before.date !== after.date) out.push(`日付 ${before.date.replaceAll('-', '/')} → ${after.date.replaceAll('-', '/')}`);
  if ((before.voucherNo ?? before.no) !== (after.voucherNo ?? after.no)) out.push(`伝票No ${before.voucherNo ?? before.no} → ${after.voucherNo ?? after.no}`);
  const dep = (l) => (l.departmentId ? `［${departmentById.get(l.departmentId)?.name ?? '部門'}］` : '');
  const line = (l) => `${l.side === 'debit' ? '借方' : '貸方'} ${accountById.get(l.accountId)?.name ?? '（不明）'}${l.subAccountId ? `・${subById.get(l.subAccountId)?.name ?? ''}` : ''}${dep(l)} ${formatYen(l.amount)}${l.memo ? `「${l.memo}」` : ''}`;
  const a = before.lines.map(line);
  const b = after.lines.map(line);
  for (const s of a) if (!b.includes(s)) out.push(`削除した行：${s}`);
  for (const s of b) if (!a.includes(s)) out.push(`追加した行：${s}`);
  return out;
}
