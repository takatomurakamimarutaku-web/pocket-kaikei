// CSV の作成（純粋関数）。UTF-8・BOM 付き（Excel で文字化けしないように）。金額は -1000 形式
import { linesToRows } from './journal.js';
import { TAX_BY_CODE } from './tax.js';
import { groupLabel } from './accounts.js';
import { METHOD_BY_ID, CATEGORY_BY_ID, usesLife } from './depreciation.js';
import { eraOf } from './property-tax.js';

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
 * 製造原価報告書（statements.manufacturingReport の items）。区分の行・科目の行（「　科目名」）・合計の行
 */
export function manufacturingCsv(items, { includeZero = false } = {}) {
  const rows = [['項目', '金額']];
  for (const item of items) {
    if (item.type === 'group') {
      rows.push([`【${item.label}】`, '']);
      for (const l of item.lines) if (includeZero || l.amount) rows.push([`　${l.account.name}`, l.amount]);
      rows.push([`${item.label} 計`, item.total]);
    } else rows.push([item.label, item.amount]);
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

/**
 * 科目別税区分集計表（tax-reports.taxByAccount）。科目×税区分で1行、最後に税区分ごとの合計
 */
export function taxByAccountCsv({ rows, byCode }) {
  const out = [['コード', '科目', '税区分', '件数', '税込金額', '税抜金額（参考）', '消費税等（参考）']];
  for (const r of rows) for (const x of r.items) out.push([r.account.code, r.account.name, x.label, x.count, x.gross, x.net, x.tax]);
  for (const x of byCode) out.push(['', '合計', x.label, x.count, x.gross, x.net, x.tax]);
  return toCsv(out);
}

/**
 * 税区分別の月別推移（tax-reports.taxMonthly）。税区分ごとに税込金額と消費税等の2行
 */
export function taxMonthlyCsv({ months, rows, netTax, netTaxTotal }) {
  const out = [['税区分', '項目', ...months.map((m) => `${m.slice(0, 4)}/${m.slice(5)}`), '合計']];
  for (const r of rows) {
    out.push([r.label, '税込金額', ...r.gross, r.total.gross]);
    out.push([r.label, '消費税等（参考）', ...r.tax, r.total.tax]);
  }
  out.push(['差引', '消費税等（参考）', ...netTax, netTaxTotal]);
  return toCsv(out);
}

/** 消費税申告書の欄（表・欄・項目・金額。付表は6.24%・7.8%・合計） */
export function taxFormsCsv(f) {
  const out = [['表', '欄', '項目', '6.24%（A）', '7.8%（B）', '金額・合計（C）']];
  const v = (n) => (n === null || n === undefined ? '' : n);
  for (const t of [f.first, f.second]) for (const r of t.rows) out.push([t.title, r.no, r.label, '', '', v(r.value)]);
  for (const t of f.sheets) for (const r of t.rows) out.push([t.title, r.no, r.label, v(r.a), v(r.b), r.text ?? v(r.c)]);
  return toCsv(out);
}

/** 勘定科目内訳明細書（内訳書ごとに見出し行・列名・行・計） */
export function breakdownCsv(forms) {
  const out = [];
  for (const f of forms) {
    out.push([`${f.no} ${f.title}`]);
    out.push(f.columns.map((c) => c.label));
    for (const r of f.rows) out.push(f.columns.map((c) => (c.num ? r[c.key] ?? 0 : r[c.key] ?? '')));
    const first = f.columns.findIndex((c) => c.num);
    out.push(f.columns.map((c, i) => (i === 0 ? '計' : i < first ? '' : c.num ? (c.key === 'amount' ? f.total : f.rows.reduce((s, r) => s + (r[c.key] || 0), 0)) : '')));
    out.push([]);
  }
  return toCsv(out);
}

/** 償却資産申告書：申告書（種類別の集計）・種類別明細書（全資産用・減少資産用） */
export function propertyTaxCsv(r) {
  const era = (d) => {
    const e = eraOf(d);
    return `${e.era}${e.year}年${e.month}月`;
  };
  const out = [[`償却資産申告書（${r.label}　${r.year}年1月1日現在）`], ['資産の種類', '前年前に取得したもの(イ)', '前年中に減少したもの(ロ)', '前年中に取得したもの(ハ)', '計(ニ)', '評価額(参考)']];
  for (const k of r.kinds) out.push([`${k.id} ${k.label}`, k.before, k.decrease, k.increase, k.total, k.value]);
  out.push(['合計', ...['before', 'decrease', 'increase', 'total', 'value'].map((key) => r.kinds.reduce((s, k) => s + k[key], 0))]);
  out.push(['課税標準額（参考）', r.taxBase], ['税額（参考・1.4%）', r.tax], []);
  out.push(['種類別明細書（全資産用）'], ['資産の種類', '資産番号', '資産の名称等', '数量', '取得年月', '取得価額', '耐用年数', '減価残存率', '評価額', '増加資産']);
  for (const it of r.items) out.push([it.kind, it.asset.assetNo || '', it.asset.name, it.asset.quantity ?? 1, era(it.asset.acquiredOn), it.asset.cost, it.life ?? '', it.residual ? (it.residual / 1000).toFixed(3) : '', it.value, it.increase ? '増' : '']);
  out.push([]);
  out.push(['種類別明細書（減少資産用）'], ['資産の種類', '資産番号', '資産の名称等', '数量', '取得年月', '取得価額', '耐用年数', '減少の事由']);
  for (const d of r.decreases) out.push([d.kind, d.asset.assetNo || '', d.asset.name, d.asset.quantity ?? 1, era(d.asset.acquiredOn), d.asset.cost, d.life ?? '', d.reason]);
  return toCsv(out);
}

/**
 * 証憑の索引（国税庁の「索引簿の作成例」と同じく、取引年月日・取引金額・取引先とファイルを対応させる一覧）
 * @param {Array} list 証憑の情報
 * @param {{ journalById: Map }} ctx
 */
export function attachmentsCsv(list, { journalById, kindLabels, fileName }) {
  const slash = (d) => (d ? d.replaceAll('-', '/') : '');
  const rows = [['取引年月日', '取引金額', '取引先', '種類', '保存用のファイル名', '元のファイル名', '大きさ（バイト）', 'SHA-256', '仕訳No.', '仕訳の日付', 'メモ', '登録日時']];
  for (const a of list) {
    const j = a.journalId ? journalById.get(a.journalId) : null;
    rows.push([slash(a.date), a.amount ?? '', a.partner, kindLabels[a.kind] ?? a.kind, fileName(a), a.name, a.size, a.sha256, j ? j.no : '', j ? slash(j.date) : '', a.memo, a.createdAt]);
  }
  return toCsv(rows);
}
