// 前期比較：損益計算書・貸借対照表の行を当期と前期で突き合わせ、増減額と増減率を出す（純粋関数）
//
// 貸借対照表の前期は「当期の期首残高」から作る（前期末の残高を繰り越したもの）。
// 個人の青色申告決算書の貸借対照表も、期首（1月1日）と期末（12月31日）の2列で書く様式。
import { trialBalance } from './ledger.js';

/** 期首残高だけで集計した行（貸借対照表の期首・前期末に使う） */
export function openingRows({ accounts, period }) {
  return trialBalance({ accounts, period, journals: [] }).rows;
}

/**
 * 増減率（‰、千分率の整数）。前期が0なら null
 * 率は表示のためだけに使い、金額の計算には使わない
 */
export function changeRate(current, previous) {
  if (!previous) return null;
  return Math.round(((current - previous) * 1000) / Math.abs(previous));
}

/** ‰の整数を「12.3%」「△4.5%」にする。null は「—」 */
export function formatPermille(p) {
  if (p == null) return '—';
  const abs = Math.abs(p);
  return `${p < 0 ? '△' : ''}${Math.floor(abs / 10).toLocaleString('ja-JP')}.${abs % 10}%`;
}

/**
 * 決算書の items（incomeStatement・balanceSheet の形）を、表に並べる行にする
 * @returns {Array<{ key, kind: 'group'|'line'|'note'|'total'|'subtotal', label, amount, level?, strong?, heading?, plain? }>}
 */
export function flattenStatement(items) {
  const out = [];
  const seen = new Map();
  const uniq = (key) => {
    const n = seen.get(key) || 0;
    seen.set(key, n + 1);
    return n ? `${key}#${n}` : key;
  };
  for (const it of items) {
    if (it.type === 'subtotal') {
      out.push({ key: uniq(`s:${it.label}`), kind: 'subtotal', label: it.label, amount: it.amount, strong: Boolean(it.strong), heading: Boolean(it.heading), plain: Boolean(it.plain) });
      continue;
    }
    const g = uniq(`g:${it.label}`);
    out.push({ key: g, kind: 'group', label: it.label, amount: null, level: it.level || 1 });
    for (const l of it.lines) {
      out.push({ key: `${g}|a:${l.account.id}`, kind: 'line', label: l.account.name, amount: l.amount, group: g });
      if (l.note) out.push({ key: `${g}|n:${l.account.id}`, kind: 'note', label: `（${l.note.label}）`, amount: l.note.amount, group: g });
    }
    out.push({ key: `${g}|t`, kind: 'total', label: `${it.label} 計`, amount: it.total, group: g });
  }
  return out;
}

/**
 * 当期と前期の行を突き合わせる。並びは当期のまま。前期にしか無い行は、同じ区分の合計の前に入れる
 * @param {Array} currentItems 当期の items
 * @param {Array|null} previousItems 前期の items（無ければ前期の列は null）
 * @param {{ skipPreviousNotes?: boolean }} opts 前期の注記（うち当期純利益）を比べないとき true
 * @returns {Array<{ key, kind, label, current, previous, diff, rate }>}
 */
export function compareStatement(currentItems, previousItems, { skipPreviousNotes = false } = {}) {
  const cur = flattenStatement(currentItems);
  const prev = previousItems ? flattenStatement(previousItems) : [];
  const prevByKey = new Map(prev.map((r) => [r.key, r]));
  const curKeys = new Set(cur.map((r) => r.key));
  const row = (r, p) => {
    const current = r.kind === 'group' ? null : r.amount ?? 0;
    const hasPrev = previousItems && r.kind !== 'group' && !(skipPreviousNotes && r.kind === 'note');
    const previous = hasPrev ? p?.amount ?? 0 : null;
    return { key: r.key, kind: r.kind, label: r.label, level: r.level, strong: r.strong, heading: r.heading, plain: r.plain, current, previous, diff: previous == null ? null : current - previous, rate: previous == null ? null : changeRate(current, previous) };
  };
  const out = [];
  for (const r of cur) {
    if (r.kind === 'total') {
      // 前期にしかない科目（当期に科目を無効にした・削除したなど）
      for (const p of prev) if (p.group === r.group && p.kind === 'line' && !curKeys.has(p.key)) out.push(row({ ...p, amount: 0 }, p));
    }
    out.push(row(r, prevByKey.get(r.key)));
  }
  return out;
}

/** 0円の行を隠す（当期・前期とも0の科目の行。区分は中の行も合計も無ければ隠す） */
export function hideZeroRows(rows) {
  const zero = (r) => !r.current && !r.previous;
  const out = [];
  for (let i = 0; i < rows.length; i++) {
    const r = rows[i];
    if (r.kind === 'line' || r.kind === 'note') {
      if (!zero(r)) out.push(r);
      continue;
    }
    if (r.kind === 'group') {
      // 区分の中（合計まで）を見て、すべて0なら区分ごと飛ばす
      let j = i + 1;
      while (j < rows.length && rows[j].kind !== 'total') j++;
      if (rows.slice(i + 1, j + 1).every(zero)) {
        i = j;
        continue;
      }
      out.push(r);
      continue;
    }
    if (r.kind === 'subtotal' && r.heading && zero(r)) continue;
    out.push(r);
  }
  return out;
}
