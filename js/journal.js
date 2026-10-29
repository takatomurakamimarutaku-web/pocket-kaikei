// 仕訳の検証・貸借差額・振替伝票との変換（純粋関数）
import { parseYen, isYen, MAX_AMOUNT } from './money.js';
import { isInPeriod } from './period.js';
import { isTaxCategory } from './tax.js';

export const MAX_LINES = 100;
export const MAX_MEMO = 100;

/** 借方合計・貸方合計・差額（借方−貸方） */
export function journalTotals(lines) {
  let debit = 0;
  let credit = 0;
  for (const l of lines) {
    const n = isYen(l.amount) ? l.amount : 0;
    if (l.side === 'debit') debit += n;
    else if (l.side === 'credit') credit += n;
  }
  return { debit, credit, diff: debit - credit };
}

/**
 * 仕訳の検証。保存前に画面と Repository の両方で呼ぶ
 * @param {object} journal { date, periodId, lines }
 * @param {{ accounts: Array, subAccounts: Array, period: object, original?: object }} ctx
 *   original：編集前の仕訳（無効化された科目でも、元から使っていた明細は残してよい）
 * @returns {string[]} エラー（空なら正常）
 */
export function validateJournal(journal, { accounts, subAccounts, period, original = null }) {
  const errors = [];
  if (!period || journal.periodId !== period.id) errors.push('会計期間が正しくありません');
  if (period && !isInPeriod(journal.date, period)) errors.push('日付は会計期間内で入力してください');
  const lines = Array.isArray(journal.lines) ? journal.lines : [];
  if (!lines.some((l) => l.side === 'debit')) errors.push('借方を1行以上入力してください');
  if (!lines.some((l) => l.side === 'credit')) errors.push('貸方を1行以上入力してください');
  if (lines.length > MAX_LINES) errors.push(`明細は${MAX_LINES}行までです`);
  const accountById = new Map(accounts.map((a) => [a.id, a]));
  const subById = new Map(subAccounts.map((s) => [s.id, s]));
  const usedBefore = new Set((original?.lines || []).map((l) => `${l.accountId}|${l.subAccountId || ''}`));
  lines.forEach((l, i) => {
    const at = `${i + 1}行目（${l.side === 'debit' ? '借方' : l.side === 'credit' ? '貸方' : '?'}）`;
    if (l.side !== 'debit' && l.side !== 'credit') errors.push(`${at}：貸借が不正です`);
    const acc = accountById.get(l.accountId);
    if (!acc) errors.push(`${at}：勘定科目を選んでください`);
    else if (!acc.active && !usedBefore.has(`${l.accountId}|${l.subAccountId || ''}`)) errors.push(`${at}：「${acc.name}」は無効になっています`);
    if (l.subAccountId) {
      const sub = subById.get(l.subAccountId);
      if (!sub || sub.accountId !== l.accountId) errors.push(`${at}：補助科目が勘定科目と合っていません`);
      else if (!sub.active && !usedBefore.has(`${l.accountId}|${l.subAccountId}`)) errors.push(`${at}：補助科目「${sub.name}」は無効になっています`);
    }
    if (!isYen(l.amount) || l.amount <= 0 || l.amount > MAX_AMOUNT) errors.push(`${at}：金額は1円以上1兆円未満の整数で入力してください`);
    if (!isTaxCategory(l.taxCategory)) errors.push(`${at}：税区分が不正です`);
    if (String(l.memo ?? '').length > MAX_MEMO) errors.push(`${at}：摘要は${MAX_MEMO}文字以内にしてください`);
  });
  if (journal.adjusting !== undefined && typeof journal.adjusting !== 'boolean') errors.push('決算整理仕訳の指定が不正です');
  const { diff } = journalTotals(lines);
  if (diff !== 0) errors.push(`借方と貸方の合計が一致しません（差額 ${Math.abs(diff).toLocaleString('ja-JP')}円）`);
  return errors;
}

// ---- 振替伝票（画面の行）との変換 ----
// 画面の1行：{ debit: {accountId, subAccountId, amount(文字列), taxCategory}, credit: {...}, memo }

export function emptySide() {
  return { accountId: '', subAccountId: '', amount: '', taxCategory: 'none' };
}

export function emptyRow() {
  return { debit: emptySide(), credit: emptySide(), memo: '' };
}

const isBlankSide = (s) => !s.accountId && String(s.amount ?? '').trim() === '';

/**
 * 画面の行を明細にする。空の側は捨てる
 * @returns {{ lines: Array, errors: string[] }} errors：金額の入力ミス（行番号付き）
 */
export function rowsToLines(rows) {
  const lines = [];
  const errors = [];
  rows.forEach((row, i) => {
    for (const side of ['debit', 'credit']) {
      const s = row[side];
      if (isBlankSide(s)) continue;
      const parsed = parseYen(s.amount);
      if (!parsed.ok) errors.push(`${i + 1}行目（${side === 'debit' ? '借方' : '貸方'}）：${parsed.error}`);
      lines.push({
        side,
        accountId: s.accountId,
        subAccountId: s.subAccountId || null,
        amount: parsed.ok ? parsed.value : NaN,
        taxCategory: s.taxCategory || 'none',
        memo: String(row.memo ?? '').trim(),
      });
    }
  });
  return { lines, errors };
}

/** 明細を画面の行にする（借方・貸方をそれぞれ上から順に並べる） */
export function linesToRows(lines) {
  const debits = lines.filter((l) => l.side === 'debit');
  const credits = lines.filter((l) => l.side === 'credit');
  const n = Math.max(debits.length, credits.length, 1);
  const toSide = (l) =>
    l ? { accountId: l.accountId, subAccountId: l.subAccountId || '', amount: String(l.amount), taxCategory: l.taxCategory } : emptySide();
  const rows = [];
  for (let i = 0; i < n; i++) {
    rows.push({ debit: toSide(debits[i]), credit: toSide(credits[i]), memo: debits[i]?.memo || credits[i]?.memo || '' });
  }
  return rows;
}

/** 画面の行の合計（入力途中でも表示できるよう、読めない金額は0とする） */
export function rowsTotals(rows) {
  let debit = 0;
  let credit = 0;
  for (const r of rows) {
    const d = parseYen(r.debit.amount);
    const c = parseYen(r.credit.amount);
    if (d.ok) debit += d.value;
    if (c.ok) credit += c.value;
  }
  return { debit, credit, diff: debit - credit };
}

/** 仕訳の代表の摘要（最初の空でない摘要） */
export function journalMemo(journal) {
  return journal.lines.find((l) => l.memo)?.memo || '';
}

/** 複製用：日付・番号・id 以外を写した入力内容 */
export function copyForNew(journal) {
  return { lines: journal.lines.map((l) => ({ ...l })) };
}

/**
 * 摘要の入力候補（使用回数の多い順、同数なら新しい順）
 * @returns {Array<{ memo, count, lastDate, lines }>} lines：その摘要を使った直近の仕訳の明細
 */
export function memoCandidates(journals) {
  const map = new Map();
  for (const j of journals) {
    const seen = new Set();
    for (const l of j.lines) {
      const memo = (l.memo || '').trim();
      if (!memo || seen.has(memo)) continue;
      seen.add(memo);
      const e = map.get(memo);
      const key = `${j.date}|${String(j.no).padStart(8, '0')}`;
      if (!e) map.set(memo, { memo, count: 1, key, lastDate: j.date, lines: j.lines });
      else {
        e.count += 1;
        if (key > e.key) Object.assign(e, { key, lastDate: j.date, lines: j.lines });
      }
    }
  }
  return [...map.values()].sort((a, b) => b.count - a.count || (a.key < b.key ? 1 : -1));
}

/** 仕訳の並び：日付 → 番号 */
export function compareJournals(a, b) {
  return a.date < b.date ? -1 : a.date > b.date ? 1 : a.no - b.no;
}

/**
 * 仕訳帳の検索。摘要・科目名・補助科目名の部分一致、または金額の一致
 * @param {(s:string)=>string} normalize
 */
export function matchJournal(journal, query, { accountById, subById, normalize }) {
  const q = normalize(query);
  if (!q) return true;
  const digits = q.replace(/[,円¥]/g, '');
  const amount = /^\d+$/.test(digits) ? Number(digits) : null;
  return journal.lines.some((l) => {
    if (amount !== null && l.amount === amount) return true;
    const texts = [l.memo, accountById.get(l.accountId)?.name, subById.get(l.subAccountId)?.name];
    return texts.some((t) => t && normalize(t).includes(q));
  });
}
