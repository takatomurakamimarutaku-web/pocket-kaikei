// 定型仕訳と毎月の繰り返し仕訳（純粋関数）
// 弥生会計の「仕訳辞書・定型仕訳」、freee の「自動で経理・取引テンプレート」に当たる機能
import { createJournal } from './models.js';
import { isInPeriod } from './period.js';

export const TEMPLATE_SOURCE = 'template';
export const MAX_TEMPLATE_NAME = 30;

/**
 * 定型仕訳の検証
 * 金額は0（呼び出したときに入れる）も可。毎月作る定型仕訳は、全行の金額が入っていて貸借が一致していること
 * @returns {string[]}
 */
export function validateTemplate(t, { accounts, subAccounts }) {
  const errors = [];
  const name = String(t.name ?? '').trim();
  if (!name) errors.push('名前を入力してください');
  else if (name.length > MAX_TEMPLATE_NAME) errors.push(`名前は${MAX_TEMPLATE_NAME}文字以内にしてください`);
  const lines = Array.isArray(t.lines) ? t.lines : [];
  if (!lines.some((l) => l.side === 'debit') || !lines.some((l) => l.side === 'credit')) errors.push('借方と貸方を1行以上入力してください');
  const accountIds = new Set(accounts.map((a) => a.id));
  const subById = new Map(subAccounts.map((s) => [s.id, s]));
  lines.forEach((l, i) => {
    const at = `${i + 1}行目`;
    if (l.side !== 'debit' && l.side !== 'credit') errors.push(`${at}：貸借が不正です`);
    if (!accountIds.has(l.accountId)) errors.push(`${at}：勘定科目を選んでください`);
    if (l.subAccountId && subById.get(l.subAccountId)?.accountId !== l.accountId) errors.push(`${at}：補助科目が科目と合っていません`);
    if (!Number.isInteger(l.amount) || l.amount < 0) errors.push(`${at}：金額は0以上の整数（円）にしてください`);
  });
  if (t.repeatDay != null) {
    if (!Number.isInteger(t.repeatDay) || t.repeatDay < 1 || t.repeatDay > 31) errors.push('毎月作る日は1〜31日（31は月末）で選んでください');
    if (lines.some((l) => !(l.amount > 0))) errors.push('毎月作る定型仕訳は、すべての行に金額を入れてください');
    const sum = (side) => lines.filter((l) => l.side === side).reduce((s, l) => s + (Number.isInteger(l.amount) ? l.amount : 0), 0);
    if (sum('debit') !== sum('credit')) errors.push('毎月作る定型仕訳は、借方と貸方の合計を一致させてください');
  }
  return errors;
}

/** 仕訳から定型仕訳の明細を作る（日付・番号などは持たない） */
export function linesForTemplate(lines) {
  return lines.map((l) => ({ side: l.side, accountId: l.accountId, subAccountId: l.subAccountId || null, amount: l.amount, taxCategory: l.taxCategory || 'none', memo: l.memo || '' }));
}

/** その月の日（月末を超える日は月末にする）。month は 'YYYY-MM' */
export function dayInMonth(month, day) {
  const [y, m] = month.split('-').map(Number);
  const last = new Date(Date.UTC(y, m, 0)).getUTCDate();
  return `${month}-${String(Math.min(day, last)).padStart(2, '0')}`;
}

/** 毎月の日の表示 */
export function repeatLabel(day) {
  if (day == null) return '';
  return day >= 31 ? '毎月末日' : `毎月${day}日`;
}

/**
 * ある月の繰り返し仕訳の状況
 * @returns {Array<{ template, date, done: object|null, inPeriod: boolean }>} done：その月に作成済みの仕訳
 */
export function recurringStatus({ templates, journals, month, period }) {
  return templates
    .filter((t) => t.repeatDay != null)
    .sort((a, b) => a.repeatDay - b.repeatDay || String(a.name).localeCompare(String(b.name)))
    .map((template) => {
      const date = dayInMonth(month, template.repeatDay);
      const done = journals.find((j) => j.source === TEMPLATE_SOURCE && j.sourceId === template.id && j.date.startsWith(month)) || null;
      return { template, date, done, inPeriod: isInPeriod(date, period) };
    });
}

/** 定型仕訳から仕訳を作る */
export function journalFromTemplate(template, { periodId, date }) {
  return createJournal({ periodId, date, lines: linesForTemplate(template.lines), source: TEMPLATE_SOURCE, sourceId: template.id });
}

/** 定型仕訳の金額の合計（借方） */
export function templateAmount(t) {
  return t.lines.filter((l) => l.side === 'debit').reduce((s, l) => s + (l.amount || 0), 0);
}
