// 検索・正規化（DOM に依存しない純粋関数）

/**
 * 検索用の正規化キーを作る。
 * NFKC → 小文字化 → ひらがなをカタカナへ → 前後の空白除去 → 連続空白を1つに
 * 例: 「ｉｐａ」「IPA」「ipa」→ "ipa"、「ゆかい」→「ユカイ」
 */
export function normalize(value) {
  if (value === null || value === undefined) return '';
  let s = String(value).normalize('NFKC').toLowerCase();
  // ぁ(3041)〜ゖ(3096)、ゝゞ(309D-309E) をカタカナ (+0x60) に寄せる
  s = s.replace(/[ぁ-ゖゝゞ]/g, (ch) => String.fromCharCode(ch.charCodeAt(0) + 0x60));
  return s.trim().replace(/\s+/g, ' ');
}

/** 正規化済みキーに、クエリ（未正規化可）が部分一致するか。空のクエリは常に一致 */
export function includesKey(key, query) {
  const q = normalize(query);
  if (!q) return true;
  return (key || '').includes(q);
}

/**
 * 候補の抽出。前方一致を優先し、次に部分一致。
 * @param {Array} items
 * @param {string} query
 * @param {(item) => string} getKey 正規化済みキーを返す関数
 * @param {number} limit
 */
export function suggest(items, query, getKey, limit = 8) {
  const q = normalize(query);
  if (!q) return [];
  const prefix = [];
  const partial = [];
  for (const item of items) {
    const key = getKey(item) || '';
    const pos = key.indexOf(q);
    if (pos === 0) prefix.push(item);
    else if (pos > 0) partial.push(item);
  }
  return prefix.concat(partial).slice(0, limit);
}

// ---- Phase 3: 検索・絞り込み・並べ替え ----
