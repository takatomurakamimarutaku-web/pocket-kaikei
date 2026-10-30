// 前期比較：損益計算書・貸借対照表の行を当期と前期で突き合わせ、増減額と増減率を出す（純粋関数）
//
// 貸借対照表の前期は「当期の期首残高」から作る（前期末の残高を繰り越したもの）。
// 個人の青色申告決算書の貸借対照表も、期首（1月1日）と期末（12月31日）の2列で書く様式。
import { trialBalance } from './ledger.js';
import { incomeStatementRows, balanceSheetRows } from './fs-rows.js';

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

// ---- 前期と比べる表（比較損益計算書・比較貸借対照表）の表示の行 ----
// 決算書の表示の行（fs-rows.js）を当期・前期それぞれ作り、行の目印（key）で突き合わせる。区分・科目の並びと名前は決算書と同じ。
// 金額は期ごとに1列（当期｜前期｜増減額｜増減率）にするので、損益計算書の区分の合計（決算書では右の列）は「〇〇合計」の行に分ける。
// 法人の段階利益は「売上総損益金額」などと書く（当期と前期で利益・損失が分かれても同じ行に並べられるように。マイナスは△）

/** 2列（内訳・合計）の行を金額1列の行にする。区分の最後の科目の右の列（区分の合計）は「〇〇合計」の行に分ける */
function oneColumn(rows) {
  const out = [];
  for (const r of rows) {
    if (r.kind === 'line' && r.inner != null && r.outer != null && r.sumLabel) {
      out.push({ ...r, amount: r.inner });
      out.push({ kind: 'total', label: r.sumLabel, level: r.level, amount: r.outer, rule: 'over' });
      continue;
    }
    out.push({ ...r, amount: r.outer ?? r.inner });
  }
  return out;
}

/** 行の目印：科目は科目の id、段階利益は元の名前（法人は損益で名前が変わるため）、そのほかは種類と名前（同じ目印が続くときは番号を付ける） */
function withKeys(rows) {
  const seen = new Map();
  let lastId = null;
  return rows.map((r) => {
    let base;
    if (r.kind === 'line') base = `l:${(lastId = r.id)}`;
    else if (r.kind === 'note') base = `n:${lastId}`;
    else if (r.kind === 'profit' || r.kind === 'net') base = `p:${r.base ?? r.label}`;
    else base = `${r.kind}:${r.label}`;
    const n = seen.get(base) || 0;
    seen.set(base, n + 1);
    return { ...r, key: n ? `${base}#${n}` : base };
  });
}

/**
 * 当期と前期の行を突き合わせる。並びは当期のまま、前期にしか無い行は前期の並びで直前の行の後に入れる
 * @param {Array} cur 当期の行（0円の行も含む）
 * @param {Array|null} prev 前期の行（無ければ前期の列は null）
 * @param {{ visible: Set|null, skipPreviousNotes?: boolean }} opts visible：表に出す行の目印（null はすべて）
 */
function mergeCompare(cur, prev, { visible, skipPreviousNotes = false }) {
  const out = cur.map((r) => ({ row: r, current: r.amount, previous: undefined }));
  const byKey = new Map(out.map((e) => [e.row.key, e]));
  let at = -1;
  for (const p of prev ?? []) {
    let e = byKey.get(p.key);
    if (e) e.previous = p.amount;
    else {
      e = { row: p, current: p.amount == null ? null : 0, previous: p.amount };
      out.splice(at + 1, 0, e);
      byKey.set(p.key, e);
    }
    at = out.indexOf(e);
  }
  return out
    .filter((e) => !visible || visible.has(e.row.key))
    .map(({ row: r, current, previous }) => {
      const amountless = current == null;
      const prevAmount = amountless || !prev || (skipPreviousNotes && r.kind === 'note') ? null : (previous ?? 0);
      const diff = prevAmount == null ? null : current - prevAmount;
      // 増減率は、利益と損失（プラスとマイナス）が入れ替わったときは意味を持たないので出さない
      const rate = diff == null || current * prevAmount < 0 ? null : changeRate(current, prevAmount);
      return { key: r.key, kind: r.kind, label: r.label, level: r.level, paren: Boolean(r.paren), rule: r.rule ?? null, current, previous: prevAmount, diff, rate };
    });
}

/**
 * 比較損益計算書の行
 * @param {Array} curItems 当期の incomeStatement の items
 * @param {Array|null} prevItems 前期の items（前期の帳簿が無ければ null）
 * @returns {Array<{ key, kind, label, level, paren, rule, current, previous, diff, rate }>} kind は fs-rows.js と同じ（区分の合計は total）
 */
export function compareIncomeRows(curItems, prevItems, { entityType, showZero = false }) {
  const build = (items, zero) => withKeys(oneColumn(incomeStatementRows(items, { entityType, showZero: zero, neutral: true })));
  const visible = showZero ? null : new Set([...build(curItems, false), ...(prevItems ? build(prevItems, false) : [])].map((r) => r.key));
  return mergeCompare(build(curItems, true), prevItems ? build(prevItems, true) : null, { visible });
}

/**
 * 比較貸借対照表の行（報告式：資産の部・資産合計・負債の部・純資産の部・負債純資産合計）。前期の「うち当期純利益」は比べない
 * @param {object} curBs 当期の balanceSheet の結果
 * @param {object} prevBs 前期末（当期の期首残高）の balanceSheet の結果
 */
export function compareBalanceRows(curBs, prevBs, { entityType, showZero = false }) {
  const grand = (t) => ({ kind: 'grand', label: t.label, level: 0, inner: null, outer: t.amount, rule: 'double' });
  const build = (bs, zero) => {
    const b = balanceSheetRows(bs, { entityType, showZero: zero });
    return withKeys(oneColumn([...b.assets, grand(b.assetTotal), ...b.liabilities, grand(b.liabilityTotal)]));
  };
  const visible = showZero ? null : new Set([...build(curBs, false), ...build(prevBs, false)].map((r) => r.key));
  return mergeCompare(build(curBs, true), build(prevBs, true), { visible, skipPreviousNotes: true });
}
