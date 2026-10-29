// 部門別損益（純粋関数）
//
// 仕訳の明細に部門（departmentId）を付け、損益の科目を部門ごとに集計する。
// 弥生会計の「部門」、freee の「部門タグ」に当たる。貸借対照表の科目に付けた部門は集計しない。
// 区分・段階利益は statements.js の incomeStatement をそのまま使い、部門の列の合計が損益計算書と一致するようにする。
import { isBsGroup } from './accounts.js';
import { incomeStatement } from './statements.js';
import { mergeItems } from './monthly.js';

export const MAX_DEPARTMENT_NAME = 20;
/** 部門を付けていない明細（共通）の列のキー */
export const COMMON_KEY = '';
/**
 * 共通の金額の配賦の基準
 *   none：配賦しない（「共通」の列に出す）
 *   sales：各部門の売上高の割合で配る
 *   equal：部門の数で均等に配る
 */
export const ALLOCATIONS = ['none', 'sales', 'equal'];

/** 部門の検証。エラーは項目ごと（{ name: '…' }） */
export function validateDepartment(dep, all = []) {
  const errors = {};
  const name = String(dep?.name ?? '').trim();
  if (!name) errors.name = '部門名を入力してください';
  else if (name.length > MAX_DEPARTMENT_NAME) errors.name = `部門名は${MAX_DEPARTMENT_NAME}文字以内にしてください`;
  else if (all.some((d) => d.id !== dep.id && d.name === name)) errors.name = '同じ名前の部門があります';
  if (typeof dep?.active !== 'boolean') errors.active = '使う・使わないの指定が不正です';
  if (!Number.isInteger(dep?.sortOrder) || dep.sortOrder < 0) errors.sortOrder = '並び順が不正です';
  return errors;
}

/** 並び順（sortOrder → 名前） */
export function compareDepartments(a, b) {
  return (a.sortOrder ?? 0) - (b.sortOrder ?? 0) || String(a.name).localeCompare(String(b.name), 'ja');
}

/** 仕訳・定型仕訳の明細で使っている部門の id */
export function usedDepartmentIds(records) {
  const ids = new Set();
  for (const r of records) for (const l of r.lines || []) if (l.departmentId) ids.add(l.departmentId);
  return ids;
}

/**
 * 金額を重みの割合で配る（最大剰余法）。端数は余りの大きい順に1円ずつ足し、合計は必ず amount に一致する
 * 重みが0の相手には配らない。重みの合計が0なら全部0
 * @param {number} amount 整数（マイナス可）
 * @param {number[]} weights 0以上の整数
 * @returns {number[]}
 */
export function allocateYen(amount, weights) {
  const total = weights.reduce((s, w) => s + w, 0);
  if (!total || !amount) return weights.map(() => 0);
  const sign = amount < 0 ? -1 : 1;
  // 金額×重みが Number の精度（2^53）を超えうるので BigInt で計算する
  const abs = BigInt(Math.abs(amount));
  const sumW = BigInt(total);
  const shares = weights.map((w) => (abs * BigInt(w)) / sumW);
  let left = abs - shares.reduce((s, x) => s + x, 0n);
  const order = weights.map((w, i) => ({ i, r: (abs * BigInt(w)) % sumW })).sort((a, b) => (b.r > a.r ? 1 : b.r < a.r ? -1 : a.i - b.i));
  for (const { i } of order) {
    if (left <= 0n) break;
    shares[i] += 1n;
    left -= 1n;
  }
  return shares.map((x) => sign * Number(x));
}

const sum = (values) => values.reduce((s, v) => s + v, 0);

/**
 * 部門別損益計算書
 * @param {{ entityType, accounts, period, journals, departments, from?, to?, allocation?, white? }} p
 *   from/to：集計する日付の範囲（省略時は期間全体）。allocation：共通の金額の配賦（ALLOCATIONS）
 * @returns {{
 *   columns: Array<{ key, label, department }>,
 *   items: Array,           incomeStatement の items に values（列ごと）と total（合計）を付けたもの
 *   statements: Array,      列ごとの incomeStatement の結果（profits で段階利益・売上を見る）
 *   total: object,          合計の incomeStatement（部門を付けない損益計算書と同じ）
 *   allocation: { basis, applied, note }
 * }}
 */
export function departmentIncome({ entityType, accounts, period, journals, departments = [], from = period.startDate, to = period.endDate, allocation = 'none', white = false }) {
  const pl = accounts.filter((a) => !isBsGroup(a.group));
  const plIds = new Set(pl.map((a) => a.id));
  const known = new Set(departments.map((d) => d.id));
  // 列のキーごと・科目ごとの借方−貸方
  const dc = new Map();
  const add = (key, accountId, v) => {
    let m = dc.get(key);
    if (!m) dc.set(key, (m = new Map()));
    m.set(accountId, (m.get(accountId) || 0) + v);
  };
  for (const j of journals) {
    if (j.date < from || j.date > to) continue;
    for (const l of j.lines) {
      if (!plIds.has(l.accountId)) continue;
      // 消された部門（通常は起きない）は共通に入れる
      const key = l.departmentId && known.has(l.departmentId) ? l.departmentId : COMMON_KEY;
      add(key, l.accountId, l.side === 'debit' ? l.amount : -l.amount);
    }
  }
  const hasAmount = (key) => [...(dc.get(key)?.values() || [])].some((v) => v);
  // 使っている部門と、金額のある部門（使わないにした部門も、その期間に金額があれば出す）
  const shown = [...departments].sort(compareDepartments).filter((d) => d.active || hasAmount(d.id));
  const rowsOf = (key, extra = null) => pl.map((account) => ({ account, dc: (dc.get(key)?.get(account.id) || 0) + (extra?.get(account.id) || 0) }));

  // 共通の金額の配賦
  const basis = ALLOCATIONS.includes(allocation) ? allocation : 'none';
  let applied = false;
  let note = '';
  const allocated = new Map(shown.map((d) => [d.id, new Map()]));
  if (basis !== 'none' && hasAmount(COMMON_KEY)) {
    let weights = null;
    if (!shown.length) note = '部門がないため、共通の金額を配賦していません';
    else if (basis === 'equal') weights = shown.map(() => 1);
    else {
      const salesOf = (key) => sum(pl.filter((a) => a.group === 'sales').map((a) => -(dc.get(key)?.get(a.id) || 0)));
      weights = shown.map((d) => Math.max(0, salesOf(d.id)));
      if (!sum(weights)) {
        weights = null;
        note = '売上高のある部門がないため、共通の金額を配賦していません';
      }
    }
    if (weights) {
      for (const [accountId, v] of dc.get(COMMON_KEY)) {
        allocateYen(v, weights).forEach((x, i) => {
          if (!x) return;
          const m = allocated.get(shown[i].id);
          m.set(accountId, (m.get(accountId) || 0) + x);
        });
      }
      applied = true;
    }
  }

  const columns = shown.map((d) => ({ key: d.id, label: d.name, department: d }));
  // 配賦しないときは共通の列を出す（部門が1つも無いときは共通だけ）
  if (!applied && (hasAmount(COMMON_KEY) || !columns.length)) columns.push({ key: COMMON_KEY, label: '共通（部門なし）', department: null });
  const statements = columns.map((c) => incomeStatement(entityType, rowsOf(c.key, applied ? allocated.get(c.key) : null), { white }));
  const totalRows = pl.map((account) => ({ account, dc: sum([...dc.values()].map((m) => m.get(account.id) || 0)) }));
  const total = incomeStatement(entityType, totalRows, { white });
  const items = mergeItems(statements.map((s) => s.items)).map((item, i) => {
    const t = total.items[i];
    return item.type === 'group' ? { ...item, total: t.total, lines: item.lines.map((l, k) => ({ ...l, total: t.lines[k].amount })) } : { ...item, total: t.amount };
  });
  return { columns, items, statements, total, allocation: { basis, applied, note } };
}
