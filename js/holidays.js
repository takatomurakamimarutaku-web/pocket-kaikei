// 休日（純粋関数）：国民の祝日と、国税の期限の休日（期限が延びる日）
//
// 国民の祝日に関する法律（令和4年以降の形。平成30年の改正で天皇誕生日は2月23日、体育の日はスポーツの日）
//   ・祝日が日曜日に当たるときは、その後で最も近い祝日でない日が休日（振替休日）
//   ・前日と翌日が祝日の日（祝日でない日に限る）は休日（国民の休日）
//   ・春分の日・秋分の日は前年2月の官報で決まる。ここでは1980〜2099年に当てはまる近似式で求める
//   ※令和2・3年（東京オリンピック・パラリンピックの特例）の移動は扱わない
// 国税の期限（国税通則法第10条第2項）：期限が日曜日・国民の祝日に関する法律に規定する休日・その他一般の休日
// （1月2日・3日を含む）・土曜日・12月29日〜31日に当たるときは、その翌日が期限
//   出典：国税通則法基本通達 第10条関係 https://www.nta.go.jp/law/tsutatsu/kihon/tsusoku/01/03/10.htm
//         No.2505 源泉所得税及び復興特別所得税の納付期限と納期の特例 https://www.nta.go.jp/taxes/shiraberu/taxanswer/gensen/2505.htm
import { addDays } from './period.js';

const pad = (n) => String(n).padStart(2, '0');
const ymd = (y, m, d) => `${y}-${pad(m)}-${pad(d)}`;

/** 曜日（0＝日曜） */
export function weekday(date) {
  const [y, m, d] = date.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d)).getUTCDay();
}

/** その月の第 n 月曜日の日 */
function nthMonday(y, m, n) {
  const first = weekday(ymd(y, m, 1));
  return 1 + ((8 - first) % 7) + (n - 1) * 7;
}

function equinox(y, base) {
  return Math.floor(base + 0.242194 * (y - 1980)) - Math.floor((y - 1980) / 4);
}

const cache = new Map();

/** その年の国民の祝日（振替休日・国民の休日を含む）。{ 'YYYY-MM-DD': 名前 } */
export function holidaysOf(year) {
  if (cache.has(year)) return cache.get(year);
  const y = year;
  const base = {
    [ymd(y, 1, 1)]: '元日',
    [ymd(y, 1, nthMonday(y, 1, 2))]: '成人の日',
    [ymd(y, 2, 11)]: '建国記念の日',
    [ymd(y, 2, 23)]: '天皇誕生日',
    [ymd(y, 3, equinox(y, 20.8431))]: '春分の日',
    [ymd(y, 4, 29)]: '昭和の日',
    [ymd(y, 5, 3)]: '憲法記念日',
    [ymd(y, 5, 4)]: 'みどりの日',
    [ymd(y, 5, 5)]: 'こどもの日',
    [ymd(y, 7, nthMonday(y, 7, 3))]: '海の日',
    [ymd(y, 8, 11)]: '山の日',
    [ymd(y, 9, nthMonday(y, 9, 3))]: '敬老の日',
    [ymd(y, 9, equinox(y, 23.2488))]: '秋分の日',
    [ymd(y, 10, nthMonday(y, 10, 2))]: 'スポーツの日',
    [ymd(y, 11, 3)]: '文化の日',
    [ymd(y, 11, 23)]: '勤労感謝の日',
  };
  const out = { ...base };
  for (const date of Object.keys(base)) {
    if (weekday(date) !== 0) continue;
    let d = addDays(date, 1);
    while (out[d]) d = addDays(d, 1);
    out[d] = '休日';
  }
  // 国民の休日（敬老の日と秋分の日にはさまれた日など）
  for (const date of Object.keys(base)) {
    const next = addDays(date, 1);
    if (!out[next] && base[addDays(date, 2)] && weekday(next) !== 0) out[next] = '休日';
  }
  cache.set(year, out);
  return out;
}

/** 国民の祝日・休日の名前（祝日でなければ null） */
export function holidayName(date) {
  return holidaysOf(Number(date.slice(0, 4)))[date] ?? null;
}

/** 国税の期限が延びる日か（土日・祝日・1月2日・3日・12月29日〜31日） */
export function isTaxHoliday(date) {
  const w = weekday(date);
  if (w === 0 || w === 6) return true;
  const md = date.slice(5);
  if (md === '01-02' || md === '01-03' || md >= '12-29') return true;
  return holidayName(date) != null;
}

/** 国税の期限：その日が休日なら、休日でない次の日 */
export function taxDueDate(date) {
  let d = date;
  while (isTaxHoliday(d)) d = addDays(d, 1);
  return d;
}
