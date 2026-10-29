// 会計期間（純粋関数）。日付は 'YYYY-MM-DD' の文字列で扱う（時差の影響を受けないよう Date は UTC でだけ使う）

const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

/** 実在する日付の 'YYYY-MM-DD' か */
export function isValidDate(s) {
  const m = DATE_RE.exec(String(s ?? ''));
  if (!m) return false;
  const d = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3]));
  return d.getUTCFullYear() === +m[1] && d.getUTCMonth() === +m[2] - 1 && d.getUTCDate() === +m[3];
}

function toUTC(s) {
  const m = DATE_RE.exec(s);
  return new Date(Date.UTC(+m[1], +m[2] - 1, +m[3]));
}

function fromUTC(d) {
  return d.toISOString().slice(0, 10);
}

/** 日付に日数を足す */
export function addDays(s, days) {
  const d = toUTC(s);
  d.setUTCDate(d.getUTCDate() + days);
  return fromUTC(d);
}

/** from から to までの日数（to のほうが後なら正） */
export function daysBetween(from, to) {
  return Math.round((toUTC(to) - toUTC(from)) / 86400000);
}

/**
 * n か月後の同じ日（無い日は月末）。例：2026-01-31 + 1か月 → 2026-02-28
 */
export function addMonths(s, n) {
  const m = DATE_RE.exec(s);
  const y = +m[1];
  const mo = +m[2] - 1 + n;
  const ty = y + Math.floor(mo / 12);
  const tm = ((mo % 12) + 12) % 12;
  const last = new Date(Date.UTC(ty, tm + 1, 0)).getUTCDate();
  return fromUTC(new Date(Date.UTC(ty, tm, Math.min(+m[3], last))));
}

/** 個人事業主の会計期間（暦年固定） */
export function individualPeriod(year) {
  return { startDate: `${year}-01-01`, endDate: `${year}-12-31` };
}

/** 法人の既定の期末：開始日の12か月後の前日 */
export function defaultCorporateEnd(startDate) {
  return addDays(addMonths(startDate, 12), -1);
}

/**
 * 会計期間の検証。
 * 個人：1/1〜12/31 のみ。法人：開始日〜終了日が1日以上・12か月以内
 * @returns {Record<string,string>} 項目ごとのエラー（空なら正常）
 */
export function validatePeriod({ startDate, endDate }, entityType) {
  const errors = {};
  if (!isValidDate(startDate)) errors.startDate = '開始日を正しく入力してください';
  if (!isValidDate(endDate)) errors.endDate = '終了日を正しく入力してください';
  if (Object.keys(errors).length) return errors;
  if (entityType === 'individual') {
    const y = startDate.slice(0, 4);
    if (startDate !== `${y}-01-01` || endDate !== `${y}-12-31`) {
      errors.startDate = '個人事業主の会計期間は1月1日〜12月31日です';
    }
    return errors;
  }
  if (endDate < startDate) errors.endDate = '終了日は開始日以降にしてください';
  else if (endDate > defaultCorporateEnd(startDate)) errors.endDate = '会計期間は12か月以内にしてください';
  return errors;
}

/** 期間内の日付か */
export function isInPeriod(date, period) {
  return isValidDate(date) && date >= period.startDate && date <= period.endDate;
}

/** 期間に含まれる月（'YYYY-MM'）の一覧 */
export function monthsInPeriod(period) {
  const months = [];
  let cur = `${period.startDate.slice(0, 7)}-01`;
  const end = period.endDate.slice(0, 7);
  while (cur.slice(0, 7) <= end) {
    months.push(cur.slice(0, 7));
    cur = addMonths(cur, 1);
  }
  return months;
}

/**
 * 月範囲（'YYYY-MM'）を期間内の日付範囲にする。省略時は期間全体
 * @returns {{ from: string, to: string }}
 */
export function monthRange(period, fromMonth, toMonth) {
  let from = period.startDate;
  let to = period.endDate;
  if (fromMonth && `${fromMonth}-01` > from) from = `${fromMonth}-01`;
  if (toMonth) {
    const last = addDays(addMonths(`${toMonth}-01`, 1), -1);
    if (last < to) to = last;
  }
  return { from, to };
}

/** 期間の表示（2026/01/01〜2026/12/31） */
export function formatPeriod(period) {
  return `${period.startDate.replaceAll('-', '/')}〜${period.endDate.replaceAll('-', '/')}`;
}

/** ローカル時刻での今日 */
export function todayString(now = new Date()) {
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, '0');
  const d = String(now.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}
