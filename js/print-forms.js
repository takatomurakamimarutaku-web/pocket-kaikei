// 帳票の印刷様式（純粋関数）：帳簿・集計表のデータから、印刷する帳票の内容（print-layout.js の doc）を作る
// 様式は弥生会計などの市販ソフトの帳票にならう（docs/spec-phase3-print-forms.md）
//   仕訳日記帳：日付・伝票No.・借方（科目／補助・税区分・金額）・貸方（同）・摘要。1件の仕訳はページをまたがない。頁の繰越行
//   総勘定元帳・出納帳：科目ごとに改ページ。前期（前月）繰越・取引・月計・合計。頁の繰越行（借方・貸方の累計と残高）
//   残高試算表：貸借対照表と損益計算書に分け、区分ごとの計と構成比

import { fmt, periodText } from './print-layout.js';
import { GROUP_BY_ID, groupLabel } from './accounts.js';
import { TAX_BY_CODE } from './tax.js';
import { linesToRows, voucherOf } from './journal.js';

const md = (date) => `${date.slice(5, 7)}/${date.slice(8, 10)}`;
const blank = (n) => (n ? fmt(n) : '');
const taxLabel = (code) => (code && code !== 'none' ? (TAX_BY_CODE[code]?.label ?? '') : '');

/** 帳票の共通の見出し（事業者名・期間・作成日） */
export function docHead({ settings, period, from = period.startDate, to = period.endDate, printedAt }) {
  return { company: settings?.businessName || '', period: periodText(from, to), printedAt };
}

/** 「売上高（得意先A）」を科目と補助に分ける（元帳の相手科目） */
export function splitSub(name) {
  const m = /^(.+)（([^（）]+)）$/.exec(name || '');
  return m ? [m[1], m[2]] : [name || ''];
}

/**
 * 仕訳日記帳
 * @param {{ journals: Array (並べた順に印刷する), accountById: Map, subById: Map, departmentById?: Map, head: object, title?: string }} p
 */
export function journalBookDoc({ journals, accountById, subById, departmentById = new Map(), head, title = '仕訳日記帳' }) {
  const side = (s) => {
    if (!s.accountId) return { name: [''], tax: '', amount: 0 };
    const acc = accountById.get(s.accountId);
    const sub = s.subAccountId ? subById.get(s.subAccountId)?.name : '';
    const dep = s.departmentId ? departmentById.get(s.departmentId)?.name : '';
    const second = [sub, dep].filter(Boolean).join('／');
    return { name: second ? [acc?.name ?? '（不明な科目）', second] : [acc?.name ?? '（不明な科目）'], tax: taxLabel(s.taxCategory), amount: Number(s.amount) || 0 };
  };
  const rows = [];
  let debit = 0;
  let credit = 0;
  for (const j of journals) {
    linesToRows(j.lines).forEach((r, i) => {
      const d = side(r.debit);
      const c = side(r.credit);
      debit += d.amount;
      credit += c.amount;
      rows.push({
        keep: j.id,
        cells: [i ? '' : md(j.date), i ? '' : String(voucherOf(j)), d.name, d.tax, blank(d.amount), c.name, c.tax, blank(c.amount), r.memo],
        nums: { 4: d.amount, 7: c.amount },
      });
    });
    // 仕訳の区切り：最後の行の下を少し太くする代わりに、keep で同じページに置く
  }
  rows.push({ kind: 'total', cells: [{ text: '合計', span: 4, align: 'center' }, fmt(debit), '', '', fmt(credit), ''] });
  return {
    title,
    ...head,
    orientation: 'portrait',
    blocks: [
      {
        type: 'table',
        columns: [
          { label: '日付', align: 'center', w: 11 },
          { label: '伝票\nNo.', align: 'right', w: 10 },
          { label: '借方勘定科目\n補助科目', grow: 1, min: 22 },
          { label: '借方\n税区分', w: 15 },
          { label: '借方金額', align: 'right', w: 20 },
          { label: '貸方勘定科目\n補助科目', grow: 1, min: 22 },
          { label: '貸方\n税区分', w: 15 },
          { label: '貸方金額', align: 'right', w: 20 },
          { label: '摘要', grow: 1.6, min: 26 },
        ],
        rows,
        carry: { label: 2, sum: [4, 7] },
      },
    ],
  };
}

/**
 * 総勘定元帳・補助元帳・出納帳（科目ごとに改ページ）
 * @param {Array} ledgers ledger.js の generalLedger の結果（subName を付けると見出しに出す）
 * @param {{ head, carriedLabel: string, title?: string, debitLabel?: string, creditLabel?: string, monthly?: boolean }} opts
 */
export function ledgerBookDoc(ledgers, { head, carriedLabel, title = '総勘定元帳', debitLabel = '借方金額', creditLabel = '貸方金額', monthly = true }) {
  const blocks = [];
  for (const lg of ledgers) {
    const a = lg.account;
    const side = a.normalSide === 'debit' ? '借方残' : '貸方残';
    blocks.push({ type: 'heading', caption: true, text: `${a.code ? `[${a.code}] ` : ''}${a.name}${lg.subName ? `　${lg.subName}` : ''}（${side}）` });
    const rows = [{ sum: false, cells: ['', '', { text: carriedLabel, span: 3, align: 'center' }, '', '', fmt(lg.carried)], nums: { 7: lg.carried } }];
    let month = null;
    let mDebit = 0;
    let mCredit = 0;
    const months = new Set(lg.rows.map((r) => r.date.slice(0, 7)));
    const flush = () => {
      if (month === null || !monthly || months.size < 2) return;
      rows.push({ kind: 'subtotal', cells: ['', '', '', { text: `${Number(month.slice(5))}月計`, align: 'center' }, '', fmt(mDebit), fmt(mCredit), ''] });
    };
    for (const r of lg.rows) {
      const m = r.date.slice(0, 7);
      if (m !== month) {
        flush();
        month = m;
        mDebit = 0;
        mCredit = 0;
      }
      mDebit += r.debit;
      mCredit += r.credit;
      rows.push({ cells: [md(r.date), String(r.voucherNo ?? r.no), splitSub(r.counterpart), r.memo, taxLabel(r.taxCategory), blank(r.debit), blank(r.credit), fmt(r.balance)], nums: { 5: r.debit, 6: r.credit, 7: r.balance } });
    }
    flush();
    rows.push({ kind: 'total', cells: [{ text: '合計', span: 5, align: 'center' }, fmt(lg.debit), fmt(lg.credit), fmt(lg.closing)] });
    blocks.push({
      type: 'table',
      columns: [
        { label: '日付', align: 'center', w: 11 },
        { label: '伝票\nNo.', align: 'right', w: 10 },
        { label: '相手勘定科目\n相手補助科目', grow: 1, min: 24, max: 40 },
        { label: '摘要', grow: 2.2, min: 30 },
        { label: '税区分', w: 17 },
        { label: debitLabel, align: 'right', w: 21 },
        { label: creditLabel, align: 'right', w: 21 },
        { label: '残高', align: 'right', w: 22 },
      ],
      rows,
      carry: { label: 3, sum: [5, 6], balance: 7 },
    });
  }
  if (!ledgers.length) blocks.push({ type: 'text', text: 'この期間の取引はありません。' });
  return { title, ...head, orientation: 'portrait', blocks };
}

/** 構成比（千分率を四捨五入した 12.3%） */
export function ratioText(n, base) {
  if (!base) return '';
  const permille = Math.round((n * 1000) / base);
  const s = (Math.abs(permille) / 10).toFixed(1);
  return permille < 0 ? `△${s}%` : `${s}%`;
}

/**
 * 残高試算表（貸借対照表の科目と損益計算書の科目に分ける）
 * @param {object} tb ledger.js の trialBalance の結果
 * @param {{ head, entityType, carriedLabel: string, showZero?: boolean, title?: string }} opts
 */
export function trialBalanceDoc(tb, { head, entityType, carriedLabel, showZero = false, title = '残高試算表' }) {
  const sectionOf = (r) => GROUP_BY_ID[r.account.group]?.section ?? 'pl';
  const make = (isBs) => {
    const list = tb.rows.filter((r) => (sectionOf(r) === 'pl') !== isBs && (showZero || r.opening || r.debit || r.credit || r.closing));
    // 構成比の分母：貸借対照表は資産合計、損益計算書は売上高（個人は売上(収入)金額）の合計
    const signed = (r) => (r.account.normalSide === GROUP_BY_ID[r.account.group].side ? 1 : -1);
    const base = list.filter((r) => (isBs ? sectionOf(r) === 'bs_asset' : r.account.group === 'sales')).reduce((s, r) => s + signed(r) * r.closing, 0);
    const rows = [];
    let group = null;
    let sub = null;
    let sec = null;
    let secSum = null;
    const flushGroup = () => sub && rows.push({ kind: 'subtotal', cells: [`${groupLabel(sub.group, entityType)} 計`, fmt(sub.opening), blank(sub.debit), blank(sub.credit), fmt(sub.closing), ratioText(sub.closing, base)] });
    const SECTION_TOTAL = { bs_asset: '資産合計', bs_liability: '負債合計', bs_equity: entityType === 'individual' ? '資本合計' : '純資産合計' };
    const flushSection = () => secSum && SECTION_TOTAL[sec] && rows.push({ kind: 'total', cells: [SECTION_TOTAL[sec], fmt(secSum.opening), blank(secSum.debit), blank(secSum.credit), fmt(secSum.closing), ratioText(secSum.closing, base)] });
    for (const r of list) {
      const s = sectionOf(r);
      if (r.account.group !== group) {
        flushGroup();
        if (s !== sec) {
          flushSection();
          sec = s;
          secSum = { opening: 0, debit: 0, credit: 0, closing: 0 };
        }
        group = r.account.group;
        sub = { group, opening: 0, debit: 0, credit: 0, closing: 0 };
        rows.push({ kind: 'group', cells: [{ text: `【${groupLabel(group, entityType)}】`, span: 6 }] });
      }
      // 区分の小計は区分の向きで足す（評価勘定は差し引く）
      const sign = signed(r);
      for (const t of [sub, secSum]) {
        t.opening += sign * r.opening;
        t.debit += r.debit;
        t.credit += r.credit;
        t.closing += sign * r.closing;
      }
      rows.push({ cells: [{ text: r.account.name, indent: 3 }, fmt(r.opening), blank(r.debit), blank(r.credit), fmt(r.closing), ratioText(sign * r.closing, base)] });
    }
    flushGroup();
    flushSection();
    return rows;
  };
  const columns = [
    { label: '勘定科目', grow: 1, min: 40 },
    { label: carriedLabel, align: 'right', w: 27 },
    { label: '借方', align: 'right', w: 27 },
    { label: '貸方', align: 'right', w: 27 },
    { label: '残高', align: 'right', w: 27 },
    { label: '構成比', align: 'right', w: 15 },
  ];
  const plRows = make(false);
  const ok = tb.totals.debit === tb.totals.credit;
  plRows.push({ kind: 'total', cells: ['借方・貸方の合計', '', fmt(tb.totals.debit), fmt(tb.totals.credit), '', ''] });
  return {
    title,
    ...head,
    orientation: 'portrait',
    blocks: [
      { type: 'heading', text: '貸借対照表の科目' },
      { type: 'table', columns, rows: make(true) },
      { type: 'heading', text: '損益計算書の科目' },
      { type: 'table', columns, rows: plRows },
      ok ? null : { type: 'text', text: '※ 借方と貸方の合計が一致していません。' },
    ].filter(Boolean),
  };
}

/**
 * 損益計算書・貸借対照表（報告式）。科目の金額は左の列、区分の計と段階利益は右の列に出す（市販ソフトの決算書の並び）
 * @param {Array<{ caption: string, items: Array }>} parts statements.js の items（損益計算書は1つ、貸借対照表は資産の部と負債・純資産の部）
 * @param {{ head, title: string, showZero?: boolean, footer?: string }} opts
 */
export function statementDoc(parts, { head, title, showZero = false, footer = '' }) {
  const columns = [
    { label: '科目', grow: 1, min: 60 },
    { label: '金額', align: 'right', w: 32 },
    { label: '金額', align: 'right', w: 32 },
  ];
  const blocks = [];
  for (const part of parts) {
    const rows = [];
    for (const it of part.items) {
      if (it.type === 'subtotal') {
        if (it.heading && !showZero && !it.amount) continue;
        rows.push(it.plain ? { cells: [{ text: it.label, indent: 3 }, fmt(it.amount), ''] } : { kind: it.strong ? 'total' : 'subtotal', cells: [it.label, '', fmt(it.amount)] });
        continue;
      }
      const lines = it.lines.filter((l) => showZero || l.amount);
      if (!showZero && !lines.length && !it.total) continue;
      rows.push({ kind: 'group', cells: [{ text: `【${it.label}】`, span: 3, indent: it.level === 2 ? 3 : 0 }] });
      for (const l of lines) {
        rows.push({ cells: [{ text: l.account.name, indent: it.level === 2 ? 6 : 3 }, fmt(l.amount), ''] });
        if (l.note) rows.push({ cells: [{ text: `（${l.note.label}）`, indent: 9 }, fmt(l.note.amount), ''] });
      }
      rows.push({ cells: [{ text: `${it.label} 計`, indent: it.level === 2 ? 3 : 0 }, '', fmt(it.total)], bold: true });
    }
    if (part.caption) blocks.push({ type: 'heading', text: part.caption });
    blocks.push({ type: 'table', columns, rows });
  }
  if (footer) blocks.push({ type: 'text', text: footer });
  return { title, ...head, orientation: 'portrait', blocks };
}
