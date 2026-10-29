// CSV の作成（純粋関数）。UTF-8・BOM 付き（Excel で文字化けしないように）。金額は -1000 形式
import { linesToRows } from './journal.js';
import { TAX_BY_CODE } from './tax.js';
import { groupLabel } from './accounts.js';
import { METHOD_BY_ID, CATEGORY_BY_ID, usesLife } from './depreciation.js';

export const BOM = '﻿';

/** 1つの値をエスケープする（カンマ・ダブルクォート・改行を含むときは囲む） */
export function csvCell(v) {
  const s = v === null || v === undefined ? '' : String(v);
  return /[",\r\n]/.test(s) ? `"${s.replaceAll('"', '""')}"` : s;
}

export function toCsv(rows) {
  return BOM + rows.map((r) => r.map(csvCell).join(',')).join('\r\n') + '\r\n';
}

/**
 * 仕訳帳。振替伝票の行単位（複合仕訳は同じ No. で複数行）
 */
export function journalsCsv(journals, { accountById, subById }) {
  const header = ['No.', '日付', '借方科目', '借方補助', '借方税区分', '借方金額', '貸方科目', '貸方補助', '貸方税区分', '貸方金額', '摘要'];
  const side = (s) => {
    if (!s.accountId) return ['', '', '', ''];
    const cat = TAX_BY_CODE[s.taxCategory];
    return [accountById.get(s.accountId)?.name ?? '', subById.get(s.subAccountId)?.name ?? '', cat && cat.kind !== 'none' ? cat.label : '', s.amount];
  };
  const rows = [header];
  for (const j of journals) {
    for (const r of linesToRows(j.lines)) rows.push([j.no, j.date.replaceAll('-', '/'), ...side(r.debit), ...side(r.credit), r.memo]);
  }
  return toCsv(rows);
}

/** 残高試算表（ledger.trialBalance の結果）。補助科目は科目の下に「　補助名」で出す */
export function trialBalanceCsv(tb, entityType, { includeSubs = true } = {}) {
  const rows = [['コード', '勘定科目', '区分', '繰越残高', '借方', '貸方', '残高']];
  for (const r of tb.rows) {
    if (!r.opening && !r.debit && !r.credit && !r.closing) continue;
    rows.push([r.account.code, r.account.name, groupLabel(r.account.group, entityType), r.opening, r.debit, r.credit, r.closing]);
    if (!includeSubs) continue;
    for (const s of r.subs) {
      if (!s.opening && !s.debit && !s.credit) continue;
      rows.push(['', `　${s.subAccount ? s.subAccount.name : '補助なし'}`, '', s.opening, s.debit, s.credit, s.closing]);
    }
  }
  rows.push(['', '合計', '', '', tb.totals.debit, tb.totals.credit, '']);
  return toCsv(rows);
}

/**
 * 総勘定元帳・出納帳（ledger.generalLedger の結果の配列）。科目ごとに繰越の行、取引の行を続ける
 * @param {{ carried: string, debitLabel?: string, creditLabel?: string, subName?: string }} opts carried：繰越行の名前（前期繰越・前月繰越）
 */
export function ledgerCsv(ledgers, { carried, debitLabel = '借方', creditLabel = '貸方', subName = '' }) {
  const rows = [['コード', '勘定科目', '補助科目', '日付', 'No.', '相手科目', '摘要', debitLabel, creditLabel, '残高']];
  for (const lg of ledgers) {
    const head = [lg.account.code, lg.account.name, subName];
    rows.push([...head, '', '', carried, '', '', '', lg.carried]);
    for (const r of lg.rows) rows.push([...head, r.date.replaceAll('-', '/'), r.no, r.counterpart, r.memo, r.debit || '', r.credit || '', r.balance]);
  }
  return toCsv(rows);
}

export function csvFileName(kind, date = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  return `pocket-kaikei-${kind}-${date.getFullYear()}${p(date.getMonth() + 1)}${p(date.getDate())}.csv`;
}

/**
 * 月次推移表（monthly.js の items）。区分の行・科目の行（「　科目名」）・段階利益の行
 * @param {{ total?: boolean, includeZero?: boolean }} opts total：期間合計の列を付ける（損益のみ）
 */
export function monthlyCsv(items, months, { total = false, includeZero = false } = {}) {
  const head = ['項目', ...months.map((m) => `${m.slice(0, 4)}/${m.slice(5)}`)];
  if (total) head.push('合計');
  const row = (label, values, t) => [label, ...values, ...(total ? [t ?? values.reduce((s, v) => s + v, 0)] : [])];
  const rows = [head];
  for (const item of items) {
    if (item.type === 'group') {
      if (!includeZero && !item.lines.some((l) => l.values.some((v) => v))) continue;
      rows.push(row(`【${item.label}】`, item.values, item.total));
      for (const l of item.lines) if (includeZero || l.values.some((v) => v)) rows.push(row(`　${l.account.name}`, l.values, l.total));
    } else {
      rows.push(row(item.label, item.values, item.total));
    }
  }
  return toCsv(rows);
}

/**
 * 固定資産台帳（depreciation.assetRegister の結果）。1資産1行
 * @param {{ accountById: Map, individual: boolean }} opts individual：事業で使う割合・経費になる額の列を付ける
 */
export function assetsCsv(register, { accountById, individual }) {
  const slash = (d) => (d ? d.replaceAll('-', '/') : '');
  const head = ['資産番号', '資産名', '種類', '勘定科目', '数量', '設置場所', '取得日', '使い始めた日', '取得価額', '償却方法', '耐用年数', '償却率'];
  if (individual) head.push('事業で使う割合');
  head.push('期首帳簿価額', '償却費');
  if (individual) head.push('うち経費');
  head.push('期末帳簿価額', '売却・除却日', '売却・除却', '売却額', 'メモ');
  const rows = [head];
  for (const { asset: a, opening, row, closing } of register) {
    const r = [a.assetNo || '', a.name, CATEGORY_BY_ID[a.category]?.label ?? '', accountById.get(a.accountId)?.name ?? '', a.quantity ?? 1, a.location || '', slash(a.acquiredOn), slash(a.startedOn), a.cost, METHOD_BY_ID[a.method]?.short ?? a.method, usesLife(a.method) ? a.usefulLife : '', row?.rate ? (row.rate / 1000).toFixed(3) : ''];
    if (individual) r.push(`${a.businessRatio ?? 100}%`);
    r.push(opening ?? '', row?.amount ?? 0);
    if (individual) r.push(row?.business ?? 0);
    r.push(closing ?? '', slash(a.disposedOn), { sell: '売却', retire: '除却' }[a.disposalType] ?? '', a.disposalType === 'sell' ? a.salePrice : '', a.memo || '');
    rows.push(r);
  }
  return toCsv(rows);
}

/**
 * 月次推移の試算表（monthly.monthlyTrialBalance の結果）。区分の行は【区分名】、科目の行は先頭に全角空白
 * @param {{ entityType: string, includeZero?: boolean }} opts
 */
export function monthlyTrialCsv(mtb, { entityType, includeZero = false }) {
  const rows = [['勘定科目', ...mtb.columns.map((c) => c.label)]];
  for (const g of mtb.groups) {
    const lines = g.rows.filter((r) => includeZero || r.values.some((v) => v !== 0));
    if (!lines.length) continue;
    rows.push([`【${groupLabel(g.group, entityType)}】`, ...g.values]);
    for (const r of lines) rows.push([`　${r.account.name}`, ...r.values]);
  }
  return toCsv(rows);
}
