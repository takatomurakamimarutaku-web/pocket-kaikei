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

/**
 * 期間の月数。暦に従って数え、1か月に満たない端数は1か月とする（消費税の課税期間の月数の数え方）
 * 例：2026-04-01〜2027-03-31 → 12、2026-06-15〜2027-03-31 → 10、2026-01-31〜2026-02-28 → 1（民法143条）
 */
export function periodMonths({ startDate, endDate }) {
  const end = addDays(endDate, 1);
  // n か月後の応当日（その月に応当日がなければ月末で満了するので、翌月1日）
  const after = (n) => {
    const t = addMonths(startDate, n);
    return t.slice(8) === startDate.slice(8) ? t : addDays(t, 1);
  };
  let n = 0;
  while (after(n + 1) <= end) n++;
  return after(n) < end ? n + 1 : n;
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

const MONTH_RE = /^\d{4}-\d{2}$/;
const monthLabel = (m) => `${Number(m.slice(5))}月`;

/**
 * 帳票の期間の候補：期間全体・各月・四半期・半期（会計期間の最初の月から3か月・6か月ずつ数える。月次推移試算表と同じ数え方）
 * @returns {Array<{ key: string, label: string, group: string, from: string, to: string }>} group：選択肢のまとまり（''・月・四半期・半期）
 */
export function rangePresets(period) {
  const months = monthsInPeriod(period);
  const out = [{ key: 'all', label: '期間全体', group: '', ...monthRange(period) }];
  for (const m of months) out.push({ key: `m:${m}`, label: `${m.slice(0, 4)}年${Number(m.slice(5))}月`, group: '月', ...monthRange(period, m, m) });
  const chunk = (size, name) => {
    if (months.length <= size) return;
    for (let i = 0; i < months.length; i += size) {
      const list = months.slice(i, i + size);
      const n = i / size + 1;
      out.push({ key: `${size === 3 ? 'q' : 'h'}${n}`, label: `${name(n)}（${monthLabel(list[0])}〜${monthLabel(list.at(-1))}）`, group: size === 3 ? '四半期' : '半期', ...monthRange(period, list[0], list.at(-1)) });
    }
  };
  chunk(3, (n) => `第${n}四半期`);
  chunk(6, (n) => (n === 1 ? '上半期' : n === 2 ? '下半期' : `第${n}半期`));
  return out;
}

/**
 * 帳票の期間（URL の from・to）を期間内の日付の範囲にする。'YYYY-MM'（月）と 'YYYY-MM-DD'（日）のどちらも受け付け、
 * 期間の外は期間の初日・末日に寄せ、前後が逆なら入れ替える。読めない値は期間全体
 * @returns {{ from: string, to: string }}
 */
export function parseRange(period, from, to) {
  const start = (v) => (MONTH_RE.test(v ?? '') ? monthRange(period, v, null).from : isValidDate(v) ? v : period.startDate);
  const end = (v) => (MONTH_RE.test(v ?? '') ? monthRange(period, null, v).to : isValidDate(v) ? v : period.endDate);
  const clamp = (d) => (d < period.startDate ? period.startDate : d > period.endDate ? period.endDate : d);
  const a = clamp(start(from));
  const b = clamp(end(to));
  // 前後が逆なら入れ替える（月なら入れ替えてから月の初日・末日にする）
  return b < a ? { from: clamp(start(to)), to: clamp(end(from)) } : { from: a, to: b };
}

/** 範囲が月の区切り（期間の初日・末日を含む）にそろっているか */
export function isMonthAligned(period, { from, to }) {
  const r = monthRange(period, from.slice(0, 7), to.slice(0, 7));
  return r.from === from && r.to === to;
}

/**
 * 帳票の期間を URL に書く形：月の区切りなら 'YYYY-MM'（今までのリンクと同じ）、そうでなければ 'YYYY-MM-DD'
 * @returns {{ from: string, to: string }}
 */
export function rangeQuery(period, range) {
  return isMonthAligned(period, range) ? { from: range.from.slice(0, 7), to: range.to.slice(0, 7) } : { from: range.from, to: range.to };
}

/** 範囲に当たる候補のキー（無ければ null） */
export function presetKeyOf(period, { from, to }) {
  return rangePresets(period).find((p) => p.from === from && p.to === to)?.key ?? null;
}

/** 範囲の表示（2026/04/01〜2026/06/30。1日だけなら 2026/04/01） */
export function formatRange({ from, to }) {
  const f = (d) => d.replaceAll('-', '/');
  return from === to ? f(from) : `${f(from)}〜${f(to)}`;
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
