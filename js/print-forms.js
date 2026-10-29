// 帳票の印刷様式（純粋関数）：帳簿・集計表のデータから、印刷する帳票の内容（print-layout.js の doc）を作る
// 様式は弥生会計・勘定奉行・freee などの市販ソフトの帳票にならい、帳票ごとに変える（docs/spec-phase3-print-forms.md）
//   仕訳日記帳：A4横。日付・伝票No.・借方（科目／補助・税区分・金額）・貸方（同）・摘要。1件の仕訳はページをまたがない
//   総勘定元帳・出納帳：A4縦。科目ごとに改ページ。前期（前月）繰越・取引・月計・累計・合計。頁の繰越行
//   合計残高試算表：中央に勘定科目、左に借方残高・借方合計、右に貸方合計・貸方残高（残高試算表の様式も選べる）
//   貸借対照表：勘定式（左右2段）または報告式。損益計算書：報告式。どちらも罫線を使わない決算書の体裁

import { fmt, periodText } from './print-layout.js';
import { GROUP_BY_ID, groupLabel } from './accounts.js';
import { TAX_BY_CODE } from './tax.js';
import { linesToRows, voucherOf } from './journal.js';
import { toUnit, unitCaption, YEN_UNIT } from './money.js';

const md = (date) => `${date.slice(5, 7)}/${date.slice(8, 10)}`;
const blank = (n) => (n ? fmt(n) : '');
/**
 * 金額の単位つきの整形（試算表・決算書）。単位が円なら fmt と同じ。f：金額、b：0 は空欄
 * 合計・小計も円で計算した値をそれぞれ換算する。単位未満のマイナスは △0（money.js の formatAmount と同じ）
 */
const unitFormat = (unit = YEN_UNIT) => {
  const f = unit.unit === 'yen' ? fmt : (n) => (Number.isFinite(n) && n < 0 && toUnit(n, unit) === 0 ? '△0' : fmt(toUnit(n, unit)));
  return { f, b: (n) => (n ? f(n) : '') };
};
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

/** 決算書の表題は字間を空ける（損 益 計 算 書） */
export const spaced = (t) => [...t].join(' ');

/**
 * 仕訳日記帳（A4横）
 * @param {{ journals: Array (並べた順に印刷する), accountById: Map, subById: Map, departmentById?: Map, head: object, title?: string,
 *           monthBreak?: boolean, monthTotal?: boolean }} p monthBreak：月ごとに改ページ、monthTotal：月計の行
 */
export function journalBookDoc({ journals, accountById, subById, departmentById = new Map(), head, title = '仕訳日記帳', monthBreak = false, monthTotal = false }) {
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
  let month = null;
  let mDebit = 0;
  let mCredit = 0;
  const flushMonth = (last) => {
    if (month === null) return;
    if (monthTotal) rows.push({ kind: 'subtotal', cells: [{ text: `${Number(month.slice(5))}月計`, span: 4, align: 'center' }, fmt(mDebit), '', '', fmt(mCredit), ''] });
    if (monthBreak && !last && rows.length) rows.at(-1).breakAfter = true;
  };
  for (const j of journals) {
    const m = j.date.slice(0, 7);
    if (m !== month) {
      flushMonth(false);
      month = m;
      mDebit = 0;
      mCredit = 0;
    }
    linesToRows(j.lines).forEach((r, i) => {
      const d = side(r.debit);
      const c = side(r.credit);
      debit += d.amount;
      credit += c.amount;
      mDebit += d.amount;
      mCredit += c.amount;
      rows.push({
        keep: j.id,
        cells: [i ? '' : md(j.date), i ? '' : String(voucherOf(j)), d.name, d.tax, blank(d.amount), c.name, c.tax, blank(c.amount), r.memo],
        nums: { 4: d.amount, 7: c.amount },
      });
    });
  }
  flushMonth(true);
  rows.push({ kind: 'total', cells: [{ text: '合計', span: 4, align: 'center' }, fmt(debit), '', '', fmt(credit), ''] });
  return {
    title,
    ...head,
    orientation: 'landscape',
    blocks: [
      {
        type: 'table',
        columns: [
          { label: '日付', align: 'center', w: 12 },
          { label: '伝票\nNo.', align: 'right', w: 11 },
          { label: '借方勘定科目\n借方補助科目・部門', grow: 1, min: 30, max: 46 },
          { label: '借方税区分', w: 24 },
          { label: '借方金額', align: 'right', w: 24 },
          { label: '貸方勘定科目\n貸方補助科目・部門', grow: 1, min: 30, max: 46 },
          { label: '貸方税区分', w: 24 },
          { label: '貸方金額', align: 'right', w: 24 },
          { label: '摘要', grow: 2, min: 40 },
        ],
        rows,
        carry: { label: 2, sum: [4, 7] },
      },
    ],
  };
}

/**
 * 総勘定元帳・補助元帳・出納帳
 * @param {Array} ledgers ledger.js の generalLedger の結果（subName を付けると見出しに出す）
 * @param {{ head, carriedLabel: string, title?: string, debitLabel?: string, creditLabel?: string,
 *           monthly?: boolean, cumulative?: boolean, pageBreak?: boolean, taxColumn?: boolean }} opts
 *   monthly：月計の行、cumulative：月計の下に累計の行、pageBreak：科目ごとに改ページ（しないときは科目名を見出しにして続ける）
 */
export function ledgerBookDoc(ledgers, { head, carriedLabel, title = '総勘定元帳', debitLabel = '借方金額', creditLabel = '貸方金額', monthly = true, cumulative = false, pageBreak = true, taxColumn = true }) {
  const blocks = [];
  // 税区分の列を出さないときは、その列を除いた並びにする
  const cols = [
    { label: '日付', align: 'center', w: 11 },
    { label: '伝票\nNo.', align: 'right', w: 10 },
    { label: '相手勘定科目\n相手補助科目', grow: 1, min: 24, max: 40 },
    { label: '摘要', grow: 2.2, min: 30 },
    taxColumn ? { label: '税区分', w: 17 } : null,
    { label: debitLabel, align: 'right', w: 21 },
    { label: creditLabel, align: 'right', w: 21 },
    { label: '残高', align: 'right', w: 22 },
  ];
  const columns = cols.filter(Boolean);
  const pick = (cells) => cells.filter((_, i) => cols[i]);
  const D = taxColumn ? 5 : 4;
  for (const lg of ledgers) {
    const a = lg.account;
    const side = a.normalSide === 'debit' ? '借方残' : '貸方残';
    const name = `${a.code ? `[${a.code}] ` : ''}${a.name}${lg.subName ? `　${lg.subName}` : ''}（${side}）`;
    blocks.push(pageBreak ? { type: 'heading', caption: true, text: name } : { type: 'heading', text: name });
    const rows = [{ sum: false, cells: ['', '', { text: carriedLabel, span: taxColumn ? 3 : 2, align: 'center' }, '', '', fmt(lg.carried)], nums: { [D + 2]: lg.carried } }];
    let month = null;
    let mDebit = 0;
    let mCredit = 0;
    let cDebit = 0;
    let cCredit = 0;
    const months = new Set(lg.rows.map((r) => r.date.slice(0, 7)));
    const flush = () => {
      if (month === null || !monthly || months.size < 2) return;
      rows.push({ kind: 'subtotal', cells: pick(['', '', '', { text: `${Number(month.slice(5))}月計`, align: 'center' }, '', blank(mDebit), blank(mCredit), '']) });
      if (cumulative) rows.push({ cells: pick(['', '', '', { text: '累計', align: 'center' }, '', blank(cDebit), blank(cCredit), '']), sum: false, bold: true });
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
      cDebit += r.debit;
      cCredit += r.credit;
      rows.push({ cells: pick([md(r.date), String(r.voucherNo ?? r.no), splitSub(r.counterpart), r.memo, taxLabel(r.taxCategory), blank(r.debit), blank(r.credit), fmt(r.balance)]), nums: { [D]: r.debit, [D + 1]: r.credit, [D + 2]: r.balance } });
    }
    flush();
    rows.push({ kind: 'total', cells: [{ text: '合計', span: D, align: 'center' }, fmt(lg.debit), fmt(lg.credit), fmt(lg.closing)] });
    blocks.push({ type: 'table', columns, rows, carry: { label: 3, sum: [D, D + 1], balance: D + 2 } });
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
 * 合計残高の金額（借方合計・貸方合計は繰越残高を含む累計。残高は借方・貸方のどちらか）
 * @param {{ account, opening, debit, credit }} r trialBalance の行（opening は残高側の金額）
 */
export function totalsOf(r) {
  const openDc = r.account.normalSide === 'debit' ? r.opening : -r.opening;
  const debitTotal = r.debit + Math.max(openDc, 0);
  const creditTotal = r.credit + Math.max(-openDc, 0);
  const dc = debitTotal - creditTotal;
  return { debitTotal, creditTotal, debitBalance: Math.max(dc, 0), creditBalance: Math.max(-dc, 0) };
}

/**
 * 試算表（貸借対照表の科目と損益計算書の科目に分ける）
 * format：'total'＝合計残高試算表（借方残高｜借方合計｜勘定科目｜貸方合計｜貸方残高）、'balance'＝残高試算表（繰越・借方・貸方・残高・構成比）
 * @param {object} tb ledger.js の trialBalance の結果
 * @param {{ head, entityType, carriedLabel: string, showZero?: boolean, subs?: boolean, format?: 'total'|'balance', ratio?: boolean, title?: string }} opts
 */
export function trialBalanceDoc(tb, { head, entityType, carriedLabel, showZero = false, subs = false, format = 'total', ratio = true, title, unit = YEN_UNIT }) {
  const { f: fmt, b: blank } = unitFormat(unit);
  const isTotal = format === 'total';
  const sectionOf = (r) => GROUP_BY_ID[r.account.group]?.section ?? 'pl';
  const signed = (r) => (r.account.normalSide === GROUP_BY_ID[r.account.group].side ? 1 : -1);
  const moved = (r) => r.opening || r.debit || r.credit || r.closing;
  const grand = { debitTotal: 0, creditTotal: 0, debitBalance: 0, creditBalance: 0 };
  const make = (isBs) => {
    const list = tb.rows.filter((r) => (sectionOf(r) === 'pl') !== isBs && (showZero || moved(r)));
    // 構成比の分母：貸借対照表は資産合計、損益計算書は売上高（個人は売上(収入)金額）の合計
    const base = list.filter((r) => (isBs ? sectionOf(r) === 'bs_asset' : r.account.group === 'sales')).reduce((s, r) => s + signed(r) * r.closing, 0);
    const rows = [];
    let group = null;
    let sub = null;
    let sec = null;
    let secSum = null;
    const zero = () => ({ opening: 0, debit: 0, credit: 0, closing: 0, debitTotal: 0, creditTotal: 0, debitBalance: 0, creditBalance: 0 });
    const line = (label, t, opts = {}) =>
      isTotal
        ? [blank(t.debitBalance), blank(t.debitTotal), label, blank(t.creditTotal), blank(t.creditBalance)]
        : [label, fmt(t.opening), blank(t.debit), blank(t.credit), fmt(t.closing), ratio ? ratioText(opts.ratioOf ?? t.closing, base) : ''];
    const flushGroup = () => sub && rows.push({ kind: 'subtotal', cells: line(isTotal ? { text: `${groupLabel(sub.group, entityType)}計`, align: 'center' } : `${groupLabel(sub.group, entityType)} 計`, sub) });
    const SECTION_TOTAL = { bs_asset: '資産合計', bs_liability: '負債合計', bs_equity: entityType === 'individual' ? '資本合計' : '純資産合計' };
    const flushSection = () => secSum && SECTION_TOTAL[sec] && rows.push({ kind: 'total', cells: line(isTotal ? { text: SECTION_TOTAL[sec], align: 'center' } : SECTION_TOTAL[sec], secSum) });
    for (const r of list) {
      const s = sectionOf(r);
      if (r.account.group !== group) {
        flushGroup();
        if (s !== sec) {
          flushSection();
          sec = s;
          secSum = zero();
        }
        group = r.account.group;
        sub = { ...zero(), group };
        rows.push({ kind: 'group', cells: isTotal ? ['', '', { text: `【${groupLabel(group, entityType)}】` }, '', ''] : [{ text: `【${groupLabel(group, entityType)}】`, span: 6 }] });
      }
      // 区分の小計：残高試算表は区分の向きで足す（評価勘定は差し引く）。合計残高試算表は借方・貸方をそのまま足す
      const sign = signed(r);
      const t = totalsOf(r);
      for (const x of [sub, secSum, grand]) {
        if (x !== grand) {
          x.opening += sign * r.opening;
          x.debit += r.debit;
          x.credit += r.credit;
          x.closing += sign * r.closing;
        }
        x.debitTotal += t.debitTotal;
        x.creditTotal += t.creditTotal;
        x.debitBalance += t.debitBalance;
        x.creditBalance += t.creditBalance;
      }
      rows.push({ cells: line({ text: r.account.name, indent: 3 }, { ...r, ...t }, { ratioOf: sign * r.closing }) });
      if (subs && r.subs.length) {
        for (const s2 of r.subs) {
          if (!showZero && !(s2.opening || s2.debit || s2.credit || s2.closing)) continue;
          const st = totalsOf({ ...s2, account: r.account });
          rows.push({ cells: line({ text: s2.subAccount ? s2.subAccount.name : '補助なし', indent: 7 }, { ...s2, ...st }, { ratioOf: sign * s2.closing }), sub: true });
        }
      }
    }
    flushGroup();
    flushSection();
    return rows;
  };
  const columns = isTotal
    ? [
        { label: '借方残高', align: 'right', w: 30 },
        { label: '借方合計', align: 'right', w: 30 },
        { label: '勘定科目', grow: 1, min: 40 },
        { label: '貸方合計', align: 'right', w: 30 },
        { label: '貸方残高', align: 'right', w: 30 },
      ]
    : [
        { label: '勘定科目', grow: 1, min: 40 },
        { label: carriedLabel, align: 'right', w: 27 },
        { label: '借方', align: 'right', w: 27 },
        { label: '貸方', align: 'right', w: 27 },
        { label: '残高', align: 'right', w: 27 },
        { label: '構成比', align: 'right', w: 15 },
      ];
  const bsRows = make(true);
  const plRows = make(false);
  const ok = tb.totals.debit === tb.totals.credit;
  plRows.push({
    kind: 'total',
    cells: isTotal
      ? [fmt(grand.debitBalance), fmt(grand.debitTotal), { text: '合計', align: 'center' }, fmt(grand.creditTotal), fmt(grand.creditBalance)]
      : ['借方・貸方の合計', '', fmt(tb.totals.debit), fmt(tb.totals.credit), '', ''],
  });
  return {
    title: title ?? (isTotal ? '合計残高試算表' : '残高試算表'),
    ...head,
    unit: unitCaption(unit),
    orientation: 'portrait',
    blocks: [
      { type: 'heading', text: '貸借対照表' },
      { type: 'table', columns, rows: bsRows },
      { type: 'heading', text: '損益計算書' },
      { type: 'table', columns, rows: plRows },
      ok ? null : { type: 'text', text: '※ 借方と貸方の合計が一致していません。' },
    ].filter(Boolean),
  };
}

/**
 * 決算書の1区分を行にする（科目・区分の計・段階利益）。金額は2列：科目は左、区分の計と段階利益は右
 * @returns {Array} 行（cells は [科目, 内訳の金額, 計の金額]）
 */
function statementRows(items, showZero, fmt) {
  const rows = [];
  for (const it of items) {
    if (it.type === 'subtotal') {
      if (it.heading && !showZero && !it.amount) continue;
      if (it.plain) rows.push({ cells: [{ text: it.label, indent: 4 }, fmt(it.amount), ''] });
      else rows.push({ cells: [{ text: it.label, bold: true, indent: it.heading ? 2 : 0 }, '', { text: fmt(it.amount), bold: true, rule: it.strong ? 'double' : 'over' }] });
      continue;
    }
    const lines = it.lines.filter((l) => showZero || l.amount);
    if (!showZero && !lines.length && !it.total) continue;
    const ind = it.level === 2 ? 2 : 0;
    rows.push({ cells: [{ text: `【${it.label}】`, bold: true, indent: ind }, '', ''] });
    for (const l of lines) {
      rows.push({ cells: [{ text: l.account.name, indent: ind + 4 }, fmt(l.amount), ''] });
      if (l.note) rows.push({ cells: [{ text: `（${l.note.label}　${fmt(l.note.amount)}）`, indent: ind + 8 }, '', ''] });
    }
    rows.push({ cells: [{ text: `${it.label}合計`, indent: ind + 2 }, '', { text: fmt(it.total), rule: 'over' }] });
  }
  return rows;
}

/**
 * 損益計算書・貸借対照表（報告式）。罫線を使わない決算書の体裁で、科目の金額は左の列、区分の計と段階利益は右の列
 * @param {Array<{ caption: string, items: Array }>} parts statements.js の items
 * @param {{ head, title: string, showZero?: boolean, footer?: string }} opts
 */
export function statementDoc(parts, { head, title, showZero = false, footer = '', unit = YEN_UNIT, orientation = 'portrait' }) {
  const { f } = unitFormat(unit);
  const columns = [
    { label: '科　　目', grow: 1, min: 70 },
    { label: '金　　額', align: 'right', w: 34 },
    { label: '', align: 'right', w: 34 },
  ];
  const blocks = [];
  for (const part of parts) {
    if (part.caption) blocks.push({ type: 'heading', text: part.caption });
    blocks.push({ type: 'table', style: 'open', columns: columns.map((c, i) => (i === 2 ? { ...c, label: '金　　額' } : c)), rows: statementRows(part.items, showZero, f) });
  }
  if (footer) blocks.push({ type: 'text', text: footer });
  return { title: spaced(title), ...head, unit: unitCaption(unit), orientation, blocks };
}

/** 勘定式の片側：区分の見出し（区分の計を右に）・科目。最後の合計（strong）は別に返す */
function accountSide(items, showZero, fmt) {
  const rows = [];
  let total = null;
  for (const it of items) {
    if (it.type === 'subtotal') {
      if (it.strong) {
        total = it;
        continue;
      }
      if (it.heading && !showZero && !it.amount) continue;
      rows.push([{ text: it.heading ? `【${it.label}】` : it.label, bold: true, indent: it.plain ? 4 : 0 }, { text: fmt(it.amount), bold: true, rule: it.heading || it.plain ? null : 'over' }]);
      continue;
    }
    const lines = it.lines.filter((l) => showZero || l.amount);
    if (!showZero && !lines.length && !it.total) continue;
    const ind = it.level === 2 ? 2 : 0;
    rows.push([{ text: `【${it.label}】`, bold: true, indent: ind }, { text: fmt(it.total), bold: true }]);
    for (const l of lines) {
      rows.push([{ text: l.account.name, indent: ind + 4 }, fmt(l.amount)]);
      if (l.note) rows.push([{ text: `（${l.note.label}）`, indent: ind + 8 }, `(${fmt(l.note.amount)})`]);
    }
  }
  return { rows, total };
}

/**
 * 貸借対照表（勘定式）：左に資産の部、右に負債・純資産の部。最後の行で資産合計と負債・純資産合計をそろえる
 * @param {{ assets: Array, liabilities: Array }} bs statements.js の balanceSheet の結果
 * @param {{ head, title?: string, showZero?: boolean, rightLabel: string }} opts
 */
export function balanceSheetAccountDoc(bs, { head, title = '貸借対照表', showZero = false, rightLabel = '負債・純資産の部', unit = YEN_UNIT, orientation = 'portrait' }) {
  const { f: fmt } = unitFormat(unit);
  const L = accountSide(bs.assets, showZero, fmt);
  const R = accountSide(bs.liabilities, showZero, fmt);
  const n = Math.max(L.rows.length, R.rows.length);
  const rows = [{ cells: [{ text: spaced('資産の部'), span: 2, align: 'center', bold: true }, { text: [...rightLabel.replace('の部', '')].join(' ') + ' の 部', span: 2, align: 'center', bold: true }] }];
  for (let i = 0; i < n; i++) rows.push({ cells: [...(L.rows[i] || ['', '']), ...(R.rows[i] || ['', ''])] });
  rows.push({
    cells: [
      { text: L.total?.label ?? '資産合計', bold: true },
      { text: fmt(L.total?.amount ?? 0), bold: true, rule: 'double' },
      { text: R.total?.label ?? '', bold: true },
      { text: fmt(R.total?.amount ?? 0), bold: true, rule: 'double' },
    ],
  });
  return {
    title: spaced(title),
    ...head,
    unit: unitCaption(unit),
    orientation,
    blocks: [
      {
        type: 'table',
        style: 'open',
        split: 2,
        columns: [
          { label: '科　　目', grow: 1, min: 40 },
          { label: '金　　額', align: 'right', w: 28 },
          { label: '科　　目', grow: 1, min: 40 },
          { label: '金　　額', align: 'right', w: 28 },
        ],
        rows,
      },
    ],
  };
}

const firstLine = (c) => {
  const t = c !== null && typeof c === 'object' && !Array.isArray(c) ? c.text : c;
  return Array.isArray(t) ? t[0] : t;
};
const MARU_RE = /^[①-⑳㉑-㉟㊱-㊿]$/;
const textOf = (c) => {
  const t = c !== null && typeof c === 'object' && !Array.isArray(c) ? c.text : c;
  return Array.isArray(t) ? t.join(' ') : String(t ?? '');
};

/**
 * 申告書の様式に近づける（青色申告決算書・収支内訳書）。画面から作った帳票（print-capture.js）を組み替える
 *   - 欄の番号（①〜㊿）・項目・金額の表だけのページ：国税庁の様式のように、欄を3列のマス目に上から順に並べる
 *   - 資産の部・負債（資本）の部の2つの表があるページ：勘定式（左右2段）にし、最後の合計の行をそろえる
 * @param {Array} blocks captureBlocks の blocks
 */
export function formLayoutBlocks(blocks, { columns: nCols = 3 } = {}) {
  const segments = [];
  for (const b of blocks) {
    if (!segments.length || (b.type === 'heading' && b.caption)) segments.push([]);
    segments.at(-1).push(b);
  }
  const out = [];
  for (const seg of segments) {
    const tables = seg.filter((b) => b.type === 'table');
    const isNumbered = (t) => t.columns.length === 3 && t.rows.every((r) => r.cells.length === 3 && (MARU_RE.test(textOf(r.cells[0])) || textOf(r.cells[0]) === ''));
    // 欄の番号の表だけ → 3列のマス目
    if (tables.length >= 2 && tables.every(isNumbered) && tables.some((t) => t.rows.some((r) => MARU_RE.test(textOf(r.cells[0]))))) {
      const items = [];
      for (const b of seg) {
        if (b.type === 'heading' && !b.caption) items.push({ head: b.text });
        // 項目の2行目（帳簿の科目名などの補足）は様式に無いので出さない
        if (b.type === 'table') for (const r of b.rows) items.push({ cells: r.cells.map((c, i) => (i === 1 ? textOf(firstLine(c)) : textOf(c))), strong: r.kind === 'total' || r.kind === 'subtotal' });
      }
      const per = Math.ceil(items.length / nCols);
      const rows = [];
      for (let i = 0; i < per; i++) {
        const cells = [];
        for (let c = 0; c < nCols; c++) {
          const it = items[c * per + i];
          if (!it) cells.push('', '', '');
          else if (it.head) cells.push({ text: it.head, span: 3, bold: true, align: 'center' });
          else cells.push({ text: it.cells[0], align: 'center' }, { text: it.cells[1], bold: it.strong }, { text: it.cells[2], align: 'right', bold: it.strong });
        }
        rows.push({ cells });
      }
      const group = [{ label: '欄', align: 'center', w: 7 }, { label: '科目', grow: 1, min: 20 }, { label: '金額（円）', align: 'right', w: 22 }];
      out.push(...seg.filter((b) => b.type === 'heading' && b.caption), { type: 'table', columns: Array.from({ length: nCols }, () => group).flat(), rows, split: Array.from({ length: nCols - 1 }, (_, i) => (i + 1) * 3) });
      out.push(...seg.filter((b) => b.type === 'text'));
      continue;
    }
    // 資産の部と負債の部の2つの表 → 勘定式
    const heads = seg.filter((b) => b.type === 'heading' && !b.caption).map((b) => b.text);
    if (tables.length === 2 && heads.some((t) => t.startsWith('資産')) && heads.some((t) => t.startsWith('負債')) && tables[0].columns.length === tables[1].columns.length) {
      const [L, R] = tables;
      const w = L.columns.length;
      const body = (t) => t.rows.slice(0, -1);
      const n = Math.max(body(L).length, body(R).length);
      const pad = () => Array.from({ length: w }, () => '');
      const rows = [{ cells: [{ text: spaced(heads[0]), span: w, align: 'center', bold: true }, { text: spaced(heads[1]), span: w, align: 'center', bold: true }] }];
      for (let i = 0; i < n; i++) rows.push({ cells: [...(body(L)[i]?.cells ?? pad()), ...(body(R)[i]?.cells ?? pad())] });
      rows.push({ kind: 'total', cells: [...L.rows.at(-1).cells, ...R.rows.at(-1).cells] });
      out.push(...seg.filter((b) => b.type === 'heading' && b.caption), { type: 'table', columns: [...L.columns, ...R.columns], rows, split: w });
      out.push(...seg.filter((b) => b.type === 'text'));
      continue;
    }
    out.push(...seg);
  }
  return out;
}

/**
 * 推移表（月次推移表・月次推移試算表）：A4横。勘定科目と月ごとの列（繰越・四半期計・半期計・決算整理・合計を含む）
 * 区分の行は区分の計を出して太字、段階利益・合計の行は上に線
 * @param {{ title, head, columns: string[] (金額の列の見出し), sections: Array<{ caption?: string, rows: Array<{ kind: 'group'|'line'|'subtotal'|'total', label, values: number[] }> }>,
 *           unit?, orientation?, notes?: string[] }} p
 */
export function monthlyDoc({ title, head, columns, sections, unit = YEN_UNIT, orientation = 'landscape', notes = [] }) {
  const { f, b } = unitFormat(unit);
  const cols = [{ label: '勘定科目', grow: 1, min: 30, max: 46 }, ...columns.map((label) => ({ label, align: 'right' }))];
  const blocks = [];
  for (const sec of sections) {
    if (sec.caption) blocks.push({ type: 'heading', text: sec.caption });
    const rows = sec.rows.map((r) => {
      if (r.kind === 'line') return { cells: [{ text: r.label, indent: 3 }, ...r.values.map((v) => b(v))] };
      if (r.kind === 'group') return { kind: 'group', cells: [`【${r.label}】`, ...r.values.map((v) => f(v))] };
      return { kind: r.kind === 'total' ? 'total' : 'subtotal', cells: [r.label, ...r.values.map((v) => f(v))] };
    });
    blocks.push({ type: 'table', columns: cols, rows });
  }
  for (const n of notes) blocks.push({ type: 'text', text: n });
  return { title, ...head, unit: unitCaption(unit), orientation, blocks };
}
