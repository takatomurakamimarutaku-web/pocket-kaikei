// 金額の整数化と表示（純粋関数）
// 金額はすべて整数の円で扱い、浮動小数点の計算はしない

/** 1仕訳行の金額の上限（1兆円未満）。合計しても Number.MAX_SAFE_INTEGER に十分収まる */
export const MAX_AMOUNT = 999_999_999_999;

/**
 * 入力文字列を整数の円にする。全角数字・カンマ・「円」「¥」を受け付ける。
 * @param {string|number} value
 * @param {{ allowNegative?: boolean, allowZero?: boolean }} opts
 * @returns {{ ok: true, value: number } | { ok: false, error: string }}
 */
export function parseYen(value, { allowNegative = false, allowZero = false } = {}) {
  if (typeof value === 'number') {
    return checkRange(value, { allowNegative, allowZero });
  }
  let s = String(value ?? '').normalize('NFKC').trim();
  s = s.replace(/[,\s]/g, '').replace(/^¥|^\\|円$/g, '');
  // 「△」「▲」もマイナスとして受け付ける
  s = s.replace(/^[△▲]/, '-');
  if (s === '') return { ok: false, error: '金額を入力してください' };
  if (!/^-?\d+$/.test(s)) {
    return { ok: false, error: /^-?\d*\.\d+$/.test(s) ? '金額は1円単位の整数で入力してください' : '金額は数字で入力してください' };
  }
  if (s.replace('-', '').length > 13) return { ok: false, error: '金額が大きすぎます' };
  return checkRange(Number(s), { allowNegative, allowZero });
}

function checkRange(n, { allowNegative, allowZero }) {
  if (!Number.isSafeInteger(n)) return { ok: false, error: '金額は1円単位の整数で入力してください' };
  if (n === 0 && !allowZero) return { ok: false, error: '金額は1円以上で入力してください' };
  if (n < 0 && !allowNegative) return { ok: false, error: '金額は1円以上で入力してください' };
  if (Math.abs(n) > MAX_AMOUNT) return { ok: false, error: '金額は1兆円未満で入力してください' };
  return { ok: true, value: n };
}

/** 整数か（金額として保存できる値か） */
export function isYen(n) {
  return Number.isSafeInteger(n);
}

/** 3桁区切り。マイナスは「△1,000」 */
export function formatYen(n) {
  if (!Number.isFinite(n)) return '';
  const abs = Math.abs(n).toLocaleString('ja-JP');
  return n < 0 ? `△${abs}` : abs;
}

/** 0 のときは空にする表示（帳票の借方・貸方欄など） */
export function formatYenBlank(n) {
  return n ? formatYen(n) : '';
}

/** 合計（整数のみを足す） */
export function sumYen(values) {
  let total = 0;
  for (const v of values) total += v;
  return total;
}
