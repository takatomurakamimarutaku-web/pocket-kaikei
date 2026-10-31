// 帳票の印刷様式（純粋関数）：帳簿・集計表のデータから、印刷する帳票の内容（print-layout.js の doc）を作る
// 様式は弥生会計・勘定奉行・freee などの市販ソフトの帳票にならい、帳票ごとに変える（docs/spec-phase3-print-forms.md）
//   仕訳日記帳：A4横。日付・伝票No.・借方（科目／補助・税区分・金額）・貸方（同）・摘要。1件の仕訳はページをまたがない
//   総勘定元帳・出納帳：A4縦。科目ごとに改ページ。前期（前月）繰越・取引・月計・累計・合計。頁の繰越行
//   合計残高試算表：中央に勘定科目、左に借方残高・借方合計、右に貸方合計・貸方残高（残高試算表の様式も選べる）
//   貸借対照表：勘定式（左右2段）または報告式。損益計算書：報告式。どちらも罫線を使わない決算書の体裁（行は fs-rows.js で画面と共通）

import { fmt, periodText, wrapText } from './print-layout.js';
import { TAX_BY_CODE } from './tax.js';
import { linesToRows, voucherOf } from './journal.js';
import { toUnit, unitCaption, YEN_UNIT } from './money.js';
import { incomeStatementRows, incomeStatementAccountRows, balanceSheetRows, singleAmount } from './fs-rows.js';
import { trialRows, totalsOf } from './trial-rows.js';
import { formatPermille } from './compare.js';

export { totalsOf };

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

// 元帳の摘要の列のおよその幅（mm）。長い摘要は省略せず2行に折り返す（3行目からは縮めて収める）
const MEMO_W = 52;
const MEMO_W_WIDE = 64;
function memoLines(memo, w) {
  const lines = wrapText(memo || '', 8, w);
  return lines.length <= 1 ? memo || '' : { text: [lines[0], lines.slice(1).join('')], subSmall: false };
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
    let mBalance = lg.carried;
    const months = new Set(lg.rows.map((r) => r.date.slice(0, 7)));
    const flush = () => {
      if (month === null || !monthly || months.size < 2) return;
      rows.push({ kind: 'subtotal', cells: pick(['', '', '', { text: `${Number(month.slice(5))}月計`, align: 'center' }, '', fmt(mDebit), fmt(mCredit), fmt(mBalance)]) });
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
      mBalance = r.balance;
      rows.push({ cells: pick([md(r.date), String(r.voucherNo ?? r.no), splitSub(r.counterpart), memoLines(r.memo, taxColumn ? MEMO_W : MEMO_W_WIDE), taxLabel(r.taxCategory), blank(r.debit), blank(r.credit), fmt(r.balance)]), nums: { [D]: r.debit, [D + 1]: r.credit, [D + 2]: r.balance } });
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

/** 試算表の部（貸借対照表・損益計算書・製造原価）の名前。印刷では部ごとに改ページし、表題を「残高試算表（貸借対照表）」にする */
export const TRIAL_PARTS = [
  ['bs', '貸借対照表'],
  ['pl', '損益計算書'],
  ['mfg', '製造原価'],
];

/**
 * 試算表（貸借対照表・損益計算書・製造原価の科目に分け、部ごとに改ページする。行は trial-rows.js）
 * 市販の会計ソフト（弥生会計・freee・マネーフォワード）と同じく、勘定科目を左端に置く
 * format：'balance'＝残高試算表（勘定科目｜繰越｜借方金額｜貸方金額｜当期残高｜構成比）
 *         'total'＝合計残高試算表（勘定科目｜合計〔借方・貸方〕｜残高〔借方・貸方〕）
 * 貸借対照表は純資産に当期純損益金額を入れ、負債・純資産合計で終わる（資産合計と一致する）
 * 損益計算書の科目には段階利益（売上総損益金額など）の行を入れる。合計残高試算表では利益を貸方残高、損失を借方残高の欄に書く
 * 最後の部の後に全科目の合計（借方・貸方の一致を確かめる行）を書く
 * @param {object} tb ledger.js の trialBalance の結果
 * @param {{ head, entityType, white?: boolean, carriedLabel: string, showZero?: boolean, subs?: boolean, format?: 'total'|'balance', ratio?: boolean, title?: string,
 *           parts?: string[] }} opts parts：印刷する部（'bs'・'pl'・'mfg'。既定はすべて）
 */
export function trialBalanceDoc(tb, { head, entityType, white = false, carriedLabel, showZero = false, subs = false, format = 'balance', ratio = true, title, unit = YEN_UNIT, parts = ['bs', 'pl', 'mfg'] }) {
  const { f: fmt, b: blank } = unitFormat(unit);
  const isTotal = format === 'total';
  const t = trialRows(tb, { entityType, white, showZero });
  const docTitle = title ?? (isTotal ? '合計残高試算表' : '残高試算表');
  // 合計残高試算表の金額の欄（借方合計・貸方合計・借方残高・貸方残高）：残高だけの行は side の残高（マイナスなら反対の側）に書く。
  // 売上原価の中の当期製品製造原価（calc）は区分の合計に借方合計・借方残高として足すので、合計の欄にも書く
  const sideCells = (amount, side, withTotal) => {
    const debit = side === 'debit' ? amount >= 0 : amount < 0;
    const v = fmt(Math.abs(amount));
    const tv = withTotal ? v : '';
    return debit ? [tv, '', v, ''] : ['', tv, '', v];
  };
  const make = (key, { rows: list, base }) => {
    const pct = (n) => (ratio ? ratioText(n, base) : '');
    // 繰越の欄：0は空欄（損益計算書の科目は期首から見ると繰越が無い）。貸借対照表の部の合計だけは0も書く
    const open = (n, always) => (always ? fmt(n) : blank(n));
    const sumCells = (label, s, always = false) =>
      isTotal ? [label, blank(s.debitTotal), blank(s.creditTotal), blank(s.debitBalance), blank(s.creditBalance)] : [label, open(s.opening, always), blank(s.debit), blank(s.credit), fmt(s.closing), pct(s.closing)];
    const accountCells = (label, r, sign) => (isTotal ? sumCells(label, { ...r, ...totalsOf(r) }) : [label, open(r.opening), blank(r.debit), blank(r.credit), fmt(r.closing), pct(sign * r.closing)]);
    const amountCells = (label, amount, side, { withTotal = false, opening = 0 } = {}) => {
      if (!isTotal) return [label, open(opening), '', '', fmt(amount), pct(amount)];
      return [label, ...sideCells(amount, side, withTotal)];
    };
    const rows = [];
    for (const r of list) {
      if (r.kind === 'group') rows.push({ kind: 'group', keepNext: true, cells: [{ text: `【${r.label}】`, span: isTotal ? 5 : 6 }] });
      else if (r.kind === 'account') {
        rows.push({ cells: accountCells({ text: r.label, indent: 3 }, r.row, r.sign) });
        if (subs && r.row.subs.length) {
          for (const s2 of r.row.subs) {
            if (!showZero && !(s2.opening || s2.debit || s2.credit || s2.closing)) continue;
            rows.push({ cells: accountCells({ text: s2.subAccount ? s2.subAccount.name : '補助なし', indent: 7 }, { ...s2, account: r.row.account }, r.sign), sub: true });
          }
        }
      } else if (r.kind === 'subtotal') rows.push({ kind: 'subtotal', cells: sumCells({ text: r.label, indent: 2 }, r.sum) });
      else if (r.kind === 'total') rows.push({ kind: 'total', cells: sumCells({ text: r.label, bold: true }, r.sum, key === 'bs') });
      else if (r.kind === 'calc') rows.push({ cells: amountCells({ text: r.label, indent: 3 }, r.amount, r.side, { withTotal: true }) });
      else if (r.kind === 'income') rows.push({ cells: amountCells({ text: r.label, indent: 3 }, r.closing, r.side, { opening: r.opening }) });
      else rows.push({ kind: r.strong ? 'total' : 'subtotal', cells: amountCells({ text: r.label, bold: true }, r.amount, r.side) });
    }
    return rows;
  };
  const columns = isTotal
    ? [
        { label: '勘定科目', grow: 1, min: 44 },
        { label: '借方', align: 'right', w: 30 },
        { label: '貸方', align: 'right', w: 30 },
        { label: '借方', align: 'right', w: 30 },
        { label: '貸方', align: 'right', w: 30 },
      ]
    : [
        { label: '勘定科目', grow: 1, min: 44 },
        { label: carriedLabel, align: 'right', w: 27 },
        { label: '借方金額', align: 'right', w: 27 },
        { label: '貸方金額', align: 'right', w: 27 },
        { label: '当期残高', align: 'right', w: 27 },
        { label: '構成比', align: 'right', w: 15 },
      ];
  const headGroups = isTotal
    ? [
        { label: '合　計', from: 1, span: 2 },
        { label: '残　高', from: 3, span: 2 },
      ]
    : undefined;
  const shown = TRIAL_PARTS.filter(([key]) => parts.includes(key) && (key === 'bs' || t[key].rows.length));
  const blocks = [];
  for (const [key, name] of shown) {
    blocks.push({ type: 'heading', caption: true, text: '', title: `${docTitle}（${name}）` });
    const rows = make(key, t[key]);
    if (rows.length) blocks.push({ type: 'table', columns, headGroups, rows });
    else blocks.push({ type: 'text', text: '残高・取引のある科目がありません。' });
  }
  // 最後に、全科目の借方・貸方の合計（貸借の一致を確かめる行）。段階利益の行と続かないよう別の表にする
  if (shown.length === TRIAL_PARTS.filter(([key]) => key === 'bs' || t[key].rows.length).length) {
    const g = t.grand;
    const grandRow = {
      kind: 'total',
      cells: isTotal ? [{ text: '合計', bold: true }, fmt(g.debitTotal), fmt(g.creditTotal), fmt(g.debitBalance), fmt(g.creditBalance)] : [{ text: '借方・貸方の合計', bold: true }, '', fmt(tb.totals.debit), fmt(tb.totals.credit), '', ''],
    };
    blocks.push({ type: 'heading', text: '全科目の合計' }, { type: 'table', columns: columns.map((c) => ({ ...c, label: '' })), rows: [grandRow] });
  }
  if (tb.totals.debit !== tb.totals.credit) blocks.push({ type: 'text', text: '※ 借方と貸方の合計が一致していません。' });
  return { title: docTitle, ...head, unit: unitCaption(unit), orientation: 'portrait', blocks };
}

// 決算書の体裁（罫線を使わない表）の文字と行の高さ：試算表・元帳（8pt）より大きくし、行の間を空けて読みやすくする
const FS_TABLE = { style: 'open', font: 9.5, headFont: 9, rowH: 5.9, headH: 7 };
// 字下げ（mm）：段（level）ごと。段階利益は科目より深く下げて目立たせる
const FS_INDENT = { part: 0, heading: 0, heading2: 3.5, heading3: 7, line: [0, 4, 7.5, 11], note: [0, 8, 11.5, 15], calc: [0, 8, 10, 12], profit: 12, net: 12, total: 4, grand: 0 };
const indentOf = (r) => {
  const v = FS_INDENT[r.kind];
  return Array.isArray(v) ? v[Math.min(r.level, v.length - 1)] : (v ?? 0);
};
const boldKinds = new Set(['part', 'heading', 'heading2', 'heading3', 'profit', 'net', 'total', 'grand']);

/** 決算書の行（fs-rows.js）の科目の欄 */
function fsLabel(r) {
  if (r.kind === 'heading') return `【${r.label}】`;
  if (r.kind === 'note') return `（${r.label}）`;
  return r.label;
}

/**
 * 損益計算書・製造原価報告書（報告式）。科目｜金額（内訳）｜金額（合計）の3列で、表は用紙の中央に置く
 * @param {Array} items statements.js の items（または condensedIncomeItems）
 * @param {{ head, title: string, entityType: string, showZero?: boolean, unit?, orientation? }} opts
 */
export function incomeStatementDoc(items, { head, title, entityType, showZero = false, unit = YEN_UNIT, orientation = 'portrait' }) {
  return { title: spaced(title), ...head, unit: unitCaption(unit), orientation, formal: true, blocks: [incomeStatementBlock(items, { entityType, showZero, unit, orientation })] };
}

/** 損益計算書の表（決算書をまとめて印刷するときにも使う） */
export function incomeStatementBlock(items, { entityType, showZero = false, unit = YEN_UNIT, orientation = 'portrait' }) {
  const { f } = unitFormat(unit);
  const rows = incomeStatementRows(items, { entityType, showZero }).map((r) => ({
    keepNext: r.kind === 'heading' && r.outer == null,
    cells: [
      { text: fsLabel(r), indent: indentOf(r), bold: boldKinds.has(r.kind) },
      r.inner == null ? '' : r.paren ? `(${f(r.inner)})` : f(r.inner),
      r.outer == null ? '' : { text: f(r.outer), bold: boldKinds.has(r.kind), rule: r.rule },
    ],
  }));
  return {
    type: 'table',
    ...FS_TABLE,
    width: orientation === 'landscape' ? 200 : 144,
    columns: [
      { label: '科　　　目', grow: 1, min: 60 },
      { label: '金　　　額', align: 'right', w: 34, headSpan: 2 },
      { label: '', align: 'right', w: 34 },
    ],
    rows,
  };
}

/**
 * 前期と比べる表（比較損益計算書・比較貸借対照表）：科目｜当期｜前期｜増減額｜増減率。決算書と同じ体裁（罫線を使わない表）
 * @param {Array} rows compare.js の compareIncomeRows・compareBalanceRows の行
 * @param {{ head, title: string, labels: [string, string], period?: string, period2?: string, unit?, orientation? }} opts
 *   period：期間の行（「自…至…」「…現在」）。period2：2行目（前期の期間）
 */
export function compareStatementDoc(rows, { head, title, labels, period = head.period, period2 = null, unit = YEN_UNIT, orientation = 'portrait' }) {
  const { f } = unitFormat(unit);
  const money = (n, r) => (n == null ? '' : { text: r.paren ? `(${f(n)})` : f(n), bold: boldKinds.has(r.kind), rule: r.rule });
  const body = rows.flatMap((r, i) =>
    r.kind === 'part'
      ? [
          // 資産合計（二重線）の次の部の見出しは1行空ける
          ...(rows[i - 1]?.kind === 'grand' ? [{ cells: ['', '', '', '', ''] }] : []),
          { keepNext: true, cells: [{ text: spaced(r.label), span: 5, align: 'center', bold: true }] },
        ]
      : {
          keepNext: r.kind.startsWith('heading') && r.current == null,
          cells: [{ text: fsLabel(r), indent: indentOf(r), bold: boldKinds.has(r.kind) }, money(r.current, r), money(r.previous, r), money(r.diff, r), r.diff == null ? '' : formatPermille(r.rate)],
        },
  );
  const wide = orientation === 'landscape';
  return {
    title: spaced(title),
    ...head,
    period,
    period2,
    unit: unitCaption(unit),
    orientation,
    formal: true,
    blocks: [
      {
        type: 'table',
        ...FS_TABLE,
        width: wide ? 230 : 186,
        columns: [
          { label: '科　　　目', grow: 1, min: 56 },
          { label: labels[0], align: 'right', w: wide ? 38 : 31 },
          { label: labels[1], align: 'right', w: wide ? 38 : 31 },
          { label: '増 減 額', align: 'right', w: wide ? 38 : 31 },
          { label: '増減率', align: 'right', w: wide ? 22 : 19 },
        ],
        rows: body,
      },
    ],
  };
}

/**
 * 貸借対照表（報告式）：資産の部・負債の部・純資産の部を上から並べる。区分の合計は区分の見出しの右の列、科目は左の列
 * @param {object} bs statements.js の balanceSheet の結果
 */
export function balanceSheetReportDoc(bs, { head, title = '貸借対照表', entityType, showZero = false, unit = YEN_UNIT, orientation = 'portrait' }) {
  return { title: spaced(title), ...head, unit: unitCaption(unit), orientation, formal: true, blocks: [balanceSheetReportBlock(bs, { entityType, showZero, unit, orientation })] };
}

/** 報告式の貸借対照表の表（決算書をまとめて印刷するときにも使う） */
export function balanceSheetReportBlock(bs, { entityType, showZero = false, unit = YEN_UNIT, orientation = 'portrait' }) {
  const { f } = unitFormat(unit);
  const b = balanceSheetRows(bs, { entityType, showZero });
  const toRow = (r) =>
    r.kind === 'part'
      ? { keepNext: true, cells: [{ text: spaced(r.label), span: 3, align: 'center', bold: true }] }
      : {
          keepNext: r.kind === 'heading' && r.outer == null,
          cells: [
            { text: fsLabel(r), indent: indentOf(r), bold: boldKinds.has(r.kind) },
            r.inner == null ? '' : r.paren ? `(${f(r.inner)})` : f(r.inner),
            r.outer == null ? '' : { text: f(r.outer), bold: boldKinds.has(r.kind), rule: r.rule },
          ],
        };
  const grand = (t) => ({ cells: [{ text: t.label, bold: true }, '', { text: f(t.amount), bold: true, rule: 'double' }] });
  const rows = [...b.assets.map(toRow), grand(b.assetTotal), { cells: ['', '', ''] }, ...b.liabilities.map(toRow), grand(b.liabilityTotal)];
  return { type: 'table', ...FS_TABLE, width: orientation === 'landscape' ? 200 : 144, columns: [{ label: '科　　　目', grow: 1, min: 60 }, { label: '金　　　額', align: 'right', w: 34, headSpan: 2 }, { label: '', align: 'right', w: 34 }], rows };
}

/**
 * 貸借対照表（勘定式）：左に資産の部、右に負債の部・純資産の部。区分の合計は区分の見出しの行に書き、
 * 最後の行で資産合計と負債・純資産合計をそろえて二重線を引く
 * @param {object} bs statements.js の balanceSheet の結果
 * @param {{ head, title?: string, entityType: string, showZero?: boolean, unit?, orientation? }} opts
 */
export function balanceSheetAccountDoc(bs, { head, title = '貸借対照表', entityType, showZero = false, unit = YEN_UNIT, orientation = 'portrait' }) {
  return { title: spaced(title), ...head, unit: unitCaption(unit), orientation, formal: true, blocks: [balanceSheetAccountBlock(bs, { entityType, showZero, unit, orientation })] };
}

/** 勘定式の貸借対照表の表（決算書をまとめて印刷するときにも使う） */
export function balanceSheetAccountBlock(bs, { entityType, showZero = false, unit = YEN_UNIT, orientation = 'portrait' }) {
  const b = balanceSheetRows(bs, { entityType, showZero });
  return accountFormBlock({ left: b.assets, right: b.liabilities, leftTotal: b.assetTotal, rightTotal: b.liabilityTotal }, { unit, orientation });
}

/**
 * 損益計算書・製造原価報告書（勘定式）：左に借方（費用・当期純利益金額）、右に貸方（収益）。
 * 区分の合計は区分の見出しの行に書き、最後の行で借方と貸方の合計をそろえて二重線を引く（行は fs-rows.js の incomeStatementAccountRows）
 * @param {Array} items statements.js の items（または condensedIncomeItems）
 */
export function incomeStatementAccountDoc(items, { head, title, entityType, showZero = false, unit = YEN_UNIT, orientation = 'portrait' }) {
  return { title: spaced(title), ...head, unit: unitCaption(unit), orientation, formal: true, blocks: [incomeStatementAccountBlock(items, { entityType, showZero, unit, orientation })] };
}

/** 勘定式の損益計算書・製造原価報告書の表（決算書をまとめて印刷するときにも使う） */
export function incomeStatementAccountBlock(items, { entityType, showZero = false, unit = YEN_UNIT, orientation = 'portrait' }) {
  const r = incomeStatementAccountRows(items, { entityType, showZero });
  return accountFormBlock({ left: r.debit, right: r.credit, leftTotal: r.debitTotal, rightTotal: r.creditTotal }, { unit, orientation });
}

/** 様式（report：報告式、account：勘定式）を選べる損益計算書・製造原価報告書 */
export function incomeStatementFormatDoc(items, { format = 'report', ...opts }) {
  return format === 'account' ? incomeStatementAccountDoc(items, opts) : incomeStatementDoc(items, opts);
}

/**
 * 勘定式の表：左右に「科目｜金額」を並べ、最後の行で左右の合計をそろえて二重線を引く（貸借対照表・損益計算書・製造原価報告書で共通）
 * @param {{ left: Array, right: Array, leftTotal: {label, amount}, rightTotal: {label, amount} }} sides fs-rows.js の行
 */
function accountFormBlock({ left, right, leftTotal, rightTotal }, { unit = YEN_UNIT, orientation = 'portrait' }) {
  const { f } = unitFormat(unit);
  const half = orientation === 'landscape' ? 125 : 93;
  const strong = (r) => boldKinds.has(r.kind) || (r.kind === 'calc' && r.level === 0);
  const side = (r) => {
    if (!r) return ['', ''];
    if (r.kind === 'part') return [{ text: spaced(r.label), span: 2, align: 'center', bold: true }];
    const v = singleAmount(r);
    return [
      { text: fsLabel(r), indent: indentOf(r) * 0.8, bold: strong(r) },
      v == null ? '' : { text: r.paren ? `(${f(v)})` : f(v), bold: strong(r), rule: r.kind === 'total' ? 'over' : null },
    ];
  };
  const n = Math.max(left.length, right.length);
  const rows = [];
  for (let i = 0; i < n; i++) rows.push({ cells: [...side(left[i]), ...side(right[i])] });
  // 合計の行は左右とも同じ位置（最後の行）に書く。合計の名前が「合計」だけなら字を空けて中央寄りにする
  const totalLabel = (t) => ({ text: t.label === '合計' ? '合　　　計' : t.label, bold: true, indent: t.label === '合計' ? 12 : 0 });
  rows.push({
    cells: [totalLabel(leftTotal), { text: f(leftTotal.amount), bold: true, rule: 'double' }, totalLabel(rightTotal), { text: f(rightTotal.amount), bold: true, rule: 'double' }],
  });
  return {
    type: 'table',
    ...FS_TABLE,
    font: 9,
    rowH: 5.6,
    width: half * 2,
    split: 2,
    // 左右の幅は同じにする（科目の名前の長さで片側だけ広がらないように）
    columns: [
      { label: '科　　　目', w: half - 31 },
      { label: '金　　　額', align: 'right', w: 31 },
      { label: '科　　　目', w: half - 31 },
      { label: '金　　　額', align: 'right', w: 31 },
    ],
    rows,
  };
}

/** 販売費及び一般管理費内訳書などの内訳の表：科目｜金額、最後に合計（二重線） */
export function breakdownBlock(lines, total, { showZero = false, unit = YEN_UNIT, orientation = 'portrait', totalLabel = '合　　計' } = {}) {
  const { f } = unitFormat(unit);
  const rows = lines.filter((l) => showZero || l.amount).map((l) => ({ cells: [{ text: l.account.name, indent: 4 }, f(l.amount)] }));
  rows.push({ cells: [{ text: totalLabel, bold: true, indent: 12 }, { text: f(total), bold: true, rule: 'double' }] });
  return { type: 'table', ...FS_TABLE, width: orientation === 'landscape' ? 160 : 120, columns: [{ label: '科　　　目', grow: 1, min: 60 }, { label: '金　　　額', align: 'right', w: 36 }], rows };
}

/**
 * 株主資本等変動計算書の表（科目を縦に並べ、当期首残高・当期変動額・当期末残高の列）
 * @param {object} equity financial.js の equityStatement の結果
 */
export function equityStatementBlock(equity, { unit = YEN_UNIT, orientation = 'portrait' } = {}) {
  const { f, b: blank } = unitFormat(unit);
  const cells = (label, v, { indent = 0, bold = false, rule = null } = {}) => [{ text: label, indent, bold }, ...[f(v.opening), blank(v.netIncome), blank(v.other), f(v.closing)].map((t, i) => (i === 3 || rule ? { text: t, bold, rule: t ? rule : null } : t))];
  const rows = [{ keepNext: true, cells: [{ text: '株主資本', bold: true }, '', '', '', ''] }];
  for (const s of equity.sections) {
    const grouped = s.id !== 'capital' && s.id !== 'other';
    if (grouped) rows.push({ keepNext: true, cells: [{ text: s.label, indent: 4, bold: true }, '', '', '', ''] });
    for (const r of s.rows) {
      // 繰越利益剰余金は「その他利益剰余金」の下に書く（貸借対照表の純資産の部と同じ区分。会社計算規則 第76条）
      if (r.account.role === 'retained_earnings') rows.push({ keepNext: true, cells: [{ text: 'その他利益剰余金', indent: 8, bold: true }, '', '', '', ''] }, { cells: cells(r.account.name, r, { indent: 12 }) });
      else rows.push({ cells: cells(r.account.name, r, { indent: grouped ? 8 : 4 }) });
    }
    if (grouped && s.rows.length > 1) rows.push({ cells: cells(`${s.label}合計`, s.total, { indent: 8, bold: true, rule: 'over' }) });
  }
  rows.push({ cells: cells('株主資本合計', equity.total, { indent: 4, bold: true, rule: 'over' }) });
  rows.push({ cells: cells('純資産合計', equity.total, { bold: true, rule: 'double' }) });
  const w = orientation === 'landscape' ? 31 : 27;
  return {
    type: 'table',
    ...FS_TABLE,
    font: 9,
    width: orientation === 'landscape' ? 230 : 178,
    headGroups: [{ label: '当期変動額', from: 2, span: 2 }],
    columns: [
      { label: '科　　目', grow: 1, min: 50 },
      { label: '当期首残高', align: 'right', w },
      { label: '当期純利益', align: 'right', w },
      { label: 'その他の変動', align: 'right', w },
      { label: '当期末残高', align: 'right', w },
    ],
    rows,
  };
}

/**
 * 個別注記表の文（financial.js の companyNotes の結果）
 * @param {Array<{ title, items: Array<{ heading?, text }> }>} sections
 * @param {{ lead?: string }} [opts] lead：冒頭の文（中小会計要領・中小会計指針で作ったとき）
 */
export function companyNotesBlocks(sections, { lead = '' } = {}) {
  const out = lead ? [{ type: 'text', text: lead, size: 9 }] : [];
  sections.forEach((s, i) => {
    out.push({ type: 'heading', text: `${i + 1}．${s.title}` });
    if (!s.items.length) out.push({ type: 'text', text: '　該当事項はありません。', size: 9 });
    s.items.forEach((it, j) => {
      const lines = it.text.split('\n');
      if (it.heading) out.push({ type: 'text', text: `（${j + 1}）${it.heading}`, size: 9 }, { type: 'text', text: lines.map((l) => `　　${l}`).join('\n'), size: 9 });
      else out.push({ type: 'text', text: lines.map((l) => `　${l}`).join('\n'), size: 9 });
    });
  });
  return out;
}

// 決算書（法人）を1冊にするときの帳票：[キー, 表題]
export const FINANCIAL_PARTS = [
  ['bs', '貸借対照表'],
  ['pl', '損益計算書'],
  ['sga', '販売費及び一般管理費内訳書'],
  ['mfg', '製造原価報告書'],
  ['equity', '株主資本等変動計算書'],
  ['notes', '個別注記表'],
];

/** 期数の表示（1〜999 の整数なら「第5期」、それ以外は書かない） */
export function periodNumberText(n) {
  const v = Number(n);
  return Number.isInteger(v) && v >= 1 && v <= 999 ? `第 ${v} 期` : '';
}

/**
 * 決算報告書の表紙：期数・表題・期間（自・至）・事業者名・所在地
 * @param {{ number?: number|string, from: string, to: string, company?: string, address?: string, title?: string }} p number：期数（空なら書かない）
 */
export function coverBlock({ number = '', from, to, company = '', address = '', title = '決算報告書' }) {
  return { type: 'cover', number: periodNumberText(number), title: spaced(title), from, to, company, address };
}

/**
 * 決算書（法人）を1冊にする：貸借対照表・損益計算書・販売費及び一般管理費内訳書・製造原価報告書・株主資本等変動計算書・個別注記表
 * 帳票ごとに改ページし、各ページに表題と期間（貸借対照表は「…現在」）を出す。体裁は1つずつ印刷するときと同じ
 * @param {{ bs, plItems: Array, sga: { lines, total }, mfgItems: Array|null, equity, notes: Array, notesLead?: string }} data
 * @param {{ head, at: string, range: string, parts?: string[], bsFormat?: 'account'|'report', plFormat?: 'account'|'report', mfgFormat?: 'account'|'report', showZero?: boolean, unit?, orientation? }} opts
 *   at：貸借対照表の日付の行（令和9年3月31日 現在）。range：期間の行（自…至…）。parts：印刷する帳票のキー
 *   bsFormat・plFormat・mfgFormat：貸借対照表・損益計算書・製造原価報告書の様式（account：勘定式、report：報告式）
 *   cover：表紙（{ number, from, to, address }。事業者名は head.company。null なら付けない）
 */
export function financialStatementsDoc(data, { head, at, range, parts = FINANCIAL_PARTS.map(([k]) => k), bsFormat = 'account', plFormat = 'report', mfgFormat = 'report', showZero = false, unit = YEN_UNIT, orientation = 'portrait', cover = null }) {
  const o = { entityType: 'corporation', showZero, unit, orientation };
  const caption = (key, title, period, extra = {}) => ({ type: 'heading', text: title, caption: true, title: title.length <= 7 ? spaced(title) : title, period, ...extra });
  const blocks = cover ? [coverBlock({ ...cover, company: head.company })] : [];
  for (const [key, title] of FINANCIAL_PARTS) {
    if (!parts.includes(key)) continue;
    if (key === 'bs') blocks.push(caption(key, title, at), bsFormat === 'report' ? balanceSheetReportBlock(data.bs, o) : balanceSheetAccountBlock(data.bs, o));
    if (key === 'pl') blocks.push(caption(key, title, range), plFormat === 'account' ? incomeStatementAccountBlock(data.plItems, o) : incomeStatementBlock(data.plItems, o));
    if (key === 'sga') blocks.push(caption(key, title, range), breakdownBlock(data.sga.lines, data.sga.total, o));
    if (key === 'mfg' && data.mfgItems) blocks.push(caption(key, title, range), mfgFormat === 'account' ? incomeStatementAccountBlock(data.mfgItems, o) : incomeStatementBlock(data.mfgItems, o));
    if (key === 'equity') blocks.push(caption(key, title, range), equityStatementBlock(data.equity, o));
    if (key === 'notes') blocks.push(caption(key, title, range, { unit: '' }), ...companyNotesBlocks(data.notes, { lead: data.notesLead }));
  }
  return { title: '決算報告書', ...head, unit: unitCaption(unit), orientation, formal: true, blocks };
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
 * 部（貸借対照表・損益計算書など）の section に title を付けると、改ページしてそのページの表題にする（部ごとに列を変えられる）
 * 行（kind）：group（区分。values があれば区分の計を書き、無ければ見出しだけ）・line（科目。0は空欄）・calc・income（計算の行）・
 *   subtotal（区分の合計）・total（部の合計）・profit（段階利益。strong は最後の利益）
 * @param {{ title, head, columns: string[] (金額の列の見出し), sections: Array<{ caption?: string, title?: string, columns?: string[], rows: Array<{ kind, label, values?: number[], strong? }> }>,
 *           unit?, orientation?, notes?: string[] }} p
 */
export function monthlyDoc({ title, head, columns, sections, unit = YEN_UNIT, orientation = 'landscape', notes = [] }) {
  const { f, b } = unitFormat(unit);
  const blocks = [];
  for (const sec of sections) {
    const labels = sec.columns ?? columns;
    const cols = [{ label: '勘定科目', grow: 1, min: 30, max: 46 }, ...labels.map((label) => ({ label, align: 'right' }))];
    if (sec.title) blocks.push({ type: 'heading', caption: true, text: '', title: sec.title });
    if (sec.caption) blocks.push({ type: 'heading', text: sec.caption });
    const rows = sec.rows.map((r) => {
      if (r.kind === 'line') return { cells: [{ text: r.label, indent: 3 }, ...r.values.map((v) => b(v))] };
      if (r.kind === 'group') return r.values ? { kind: 'group', cells: [`【${r.label}】`, ...r.values.map((v) => f(v))] } : { kind: 'group', keepNext: true, cells: [{ text: `【${r.label}】`, span: cols.length }] };
      if (r.kind === 'calc' || r.kind === 'income') return { cells: [{ text: r.label, indent: 3 }, ...r.values.map((v) => f(v))] };
      const kind = r.kind === 'total' || r.strong ? 'total' : 'subtotal';
      return { kind, cells: [{ text: r.label, indent: r.kind === 'subtotal' ? 2 : 0, bold: true }, ...r.values.map((v) => f(v))] };
    });
    if (rows.length) blocks.push({ type: 'table', columns: cols, rows });
    else blocks.push({ type: 'text', text: 'この期間の金額はありません。' });
  }
  for (const n of notes) blocks.push({ type: 'text', text: n });
  return { title, ...head, unit: unitCaption(unit), orientation, blocks };
}
