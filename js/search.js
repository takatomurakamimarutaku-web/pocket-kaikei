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

/** 検索語を空白で分けた語（正規化済み）。すべての語を含むものを探す */
export function searchTokens(query) {
  const q = normalize(query);
  return q ? q.split(' ') : [];
}

/**
 * 摘要の検索：仕訳の明細（行）を、摘要・補助科目（取引先など）・部門の名前・金額で探す。語を空白で区切ると、すべての語を含む行だけ
 * 金額は語が数字だけ（カンマ・円は無視）のとき、行の金額と同じなら一致とする
 * @param {Array} journals
 * @param {{ query?: string, accountId?: string, from?: string, to?: string }} cond accountId：その科目の行だけ。from・to：日付の範囲
 * @param {{ accountById: Map, subById: Map, departmentById?: Map }} ctx
 * @returns {Array<{ journal, line, account, sub }>} 日付・伝票番号の順
 */
export function searchLines(journals, { query = '', accountId = '', from = '', to = '' } = {}, { accountById, subById, departmentById = new Map() }) {
  const tokens = searchTokens(query);
  const hits = [];
  for (const j of journals) {
    if ((from && j.date < from) || (to && j.date > to)) continue;
    for (const l of j.lines) {
      if (accountId && l.accountId !== accountId) continue;
      const sub = l.subAccountId ? subById.get(l.subAccountId) : null;
      const text = [l.memo, sub?.name, departmentById.get(l.departmentId)?.name].filter(Boolean).map(normalize).join('\n');
      const ok = tokens.every((t) => {
        const digits = t.replace(/[,円¥]/g, '');
        return text.includes(t) || (/^\d+$/.test(digits) && l.amount === Number(digits));
      });
      if (ok) hits.push({ journal: j, line: l, account: accountById.get(l.accountId), sub });
    }
  }
  return hits.sort((a, b) => a.journal.date.localeCompare(b.journal.date) || (a.journal.voucherNo ?? a.journal.no ?? 0) - (b.journal.voucherNo ?? b.journal.no ?? 0));
}

/** 摘要の検索の合計：件数・借方合計・貸方合計 */
export function lineTotals(hits) {
  return hits.reduce((t, x) => ({ count: t.count + 1, debit: t.debit + (x.line.side === 'debit' ? x.line.amount : 0), credit: t.credit + (x.line.side === 'credit' ? x.line.amount : 0) }), { count: 0, debit: 0, credit: 0 });
}

/**
 * 摘要ごとにまとめる（同じ摘要の使われ方を見る）：件数・借方合計・貸方合計・使った科目・最後の日付。件数の多い順
 * 摘要は正規化して同じものを1つにまとめ、表示は最初に出てきた書き方。摘要の無い行は「（摘要なし）」
 * @returns {Array<{ memo: string, count: number, debit: number, credit: number, accounts: string[], lastDate: string }>}
 */
export function groupByMemo(hits) {
  const map = new Map();
  for (const x of hits) {
    const key = normalize(x.line.memo) || '';
    let g = map.get(key);
    if (!g) map.set(key, (g = { memo: (x.line.memo || '').trim() || '（摘要なし）', count: 0, debit: 0, credit: 0, accounts: [], lastDate: '' }));
    g.count += 1;
    if (x.line.side === 'debit') g.debit += x.line.amount;
    else g.credit += x.line.amount;
    const name = x.account?.name ?? '（不明な科目）';
    if (!g.accounts.includes(name)) g.accounts.push(name);
    if (x.journal.date > g.lastDate) g.lastDate = x.journal.date;
  }
  return [...map.values()].sort((a, b) => b.count - a.count || b.lastDate.localeCompare(a.lastDate));
}

/**
 * 科目の検索：コードの前方一致・科目名・区分の名前の部分一致（ひらがなとカタカナ、全角と半角は同じとみなす）。
 * 科目名の前方一致・コードの一致を先に並べる
 * @param {Array} accounts
 * @param {string} query
 * @param {(account) => string} [labelOf] 区分の名前（流動資産など）
 */
export function searchAccounts(accounts, query, labelOf = () => '') {
  const tokens = searchTokens(query);
  if (!tokens.length) return [...accounts];
  const score = (a) => {
    const name = normalize(a.name);
    const code = normalize(a.code);
    const group = normalize(labelOf(a));
    if (!tokens.every((t) => name.includes(t) || code.startsWith(t) || group.includes(t))) return -1;
    return name.startsWith(tokens[0]) || code.startsWith(tokens[0]) ? 0 : name.includes(tokens[0]) ? 1 : 2;
  };
  return accounts
    .map((a, i) => ({ a, i, s: score(a) }))
    .filter((x) => x.s >= 0)
    .sort((x, y) => x.s - y.s || x.i - y.i)
    .map((x) => x.a);
}

