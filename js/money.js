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

// ---- 金額の表示単位（円・千円・百万円）。帳簿の金額は円のまま、表示するときだけ換算する ----
// 端数は既定で切り捨て（有価証券報告書などで一般的な「千円未満切捨て」）。四捨五入も選べる。
// 合計・小計は円で計算した値をそれぞれ換算する（内訳を換算してから足さない）。
// そのため内訳の和と合計が単位未満のずれで合わないことがあるが、帳簿の金額は変えない（docs/spec-phase3-amount-unit.md）

/** 単位：div は割る数。label は見出しの表記 */
export const AMOUNT_UNITS = Object.freeze({
  yen: { div: 1, label: '円' },
  thousand: { div: 1_000, label: '千円' },
  million: { div: 1_000_000, label: '百万円' },
});

/** 端数の処理：truncate＝切り捨て（0 の側へ）、round＝四捨五入（0.5 は 0 から遠い側へ） */
export const ROUNDINGS = Object.freeze({ truncate: '切り捨て', round: '四捨五入' });

/** 円単位の表示（既定） */
export const YEN_UNIT = Object.freeze({ unit: 'yen', rounding: 'truncate' });

/** 文字列（URL の値など）から表示単位にする。分からない値は円・切り捨て */
export function normalizeUnit({ unit, rounding } = {}) {
  return {
    unit: Object.hasOwn(AMOUNT_UNITS, unit ?? '') ? unit : 'yen',
    rounding: Object.hasOwn(ROUNDINGS, rounding ?? '') ? rounding : 'truncate',
  };
}

/**
 * 円の整数を表示単位の整数にする（整数の剰余だけで計算し、浮動小数点の割り算はしない）
 * 例：1,234,567円 → 千円・切り捨て 1,234／四捨五入 1,235。△1,234,567円 → △1,234／△1,235
 */
export function toUnit(n, { unit = 'yen', rounding = 'truncate' } = {}) {
  const div = AMOUNT_UNITS[unit]?.div ?? 1;
  if (div === 1 || !Number.isSafeInteger(n)) return n;
  const abs = Math.abs(n);
  const rest = abs % div;
  let q = (abs - rest) / div;
  if (rounding === 'round' && rest * 2 >= div) q += 1;
  return n < 0 ? -q : q;
}

/**
 * 表示単位で整形する。マイナスは「△」。単位未満のマイナス（△400円を千円・切り捨て）は「△0」と出し、
 * マイナスであることを残す（有価証券報告書の表記にならう）
 */
export function formatAmount(n, u = YEN_UNIT) {
  if (!Number.isFinite(n)) return '';
  const v = toUnit(n, u);
  return v === 0 && n < 0 ? '△0' : formatYen(v);
}

/** 帳票の右上に出す単位の表記：（単位：円）／（単位：千円・千円未満切り捨て） */
export function unitCaption(u = YEN_UNIT) {
  const { unit, rounding } = normalizeUnit(u);
  const label = AMOUNT_UNITS[unit].label;
  return unit === 'yen' ? '（単位：円）' : `（単位：${label}・${label}未満${ROUNDINGS[rounding]}）`;
}
