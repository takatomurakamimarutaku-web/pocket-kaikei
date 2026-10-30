// 残高試算表の行（純粋関数）。画面と印刷で同じ行を使う
//
// 市販の会計ソフトの残高試算表と同じく、科目を貸借対照表・損益計算書・製造原価に分け、決算書と同じ順に並べる：
//   貸借対照表の科目：区分（流動資産など）ごとに科目と区分の合計、部（資産・負債・純資産）の合計
//     部に区分が1つだけなら区分の合計は部の合計と同じ額になり、科目が1つだけの区分は科目と同じ額になるので省く
//     純資産（個人は資本）の最後に損益の科目から計算した当期純損益金額（個人は青色申告特別控除前の所得金額）を入れ、
//     最後に負債・純資産合計（個人は負債・資本合計）を書く。資産合計＝負債・純資産合計になり、貸借対照表だけで貸借が一致する
//     （弥生会計などの残高試算表の貸借対照表と同じく、期中でも利益を含めた純資産で見る）
//   損益計算書の科目：損益計算書（statements.js の incomeStatement）の区分の順に並べ、段階利益の行を入れる
//     （法人は売上総損益金額〜当期純損益金額、個人は差引金額・青色申告特別控除前の所得金額）。決算書と同じ額になる
//   製造原価の科目（法人で製造原価の科目があるとき）：材料費・労務費・製造経費・当期総製造費用・仕掛品棚卸高・当期製品製造原価
// 試算表は期の途中でも見るので、法人の段階利益は「損益」と書き、マイナスは△で表す
//
// 行（kind）：
//   group    { label }                         区分の見出し
//   account  { label, row, sign }              科目（row：ledger.js の trialBalance の行。sign：区分の向きなら 1、評価勘定は -1）
//   subtotal { label, sum }                    区分の合計
//   total    { label, sum, grand? }            部の合計（資産合計など）。grand：負債・純資産合計
//   calc     { label, amount, side }           売上原価の中の当期製品製造原価など、科目ではない残高だけの行
//   income   { label, opening, closing, side }  貸借対照表の純資産の中の当期純損益金額（損益の科目の残高から計算。opening：繰越の時点）
//   profit   { label, amount, side, strong }   段階利益・当期製品製造原価（残高だけ）。strong：最後の行
//   side：金額がプラスのときの残高の側（利益は貸方、製造原価は借方）。合計残高試算表で借方・貸方のどちらの欄に書くか
// sum：{ opening, debit, credit, closing, debitTotal, creditTotal, debitBalance, creditBalance }
//   opening・closing は区分の向きで足す（評価勘定は差し引く）。借方・貸方とその合計・残高はそのまま足す
import { GROUP_BY_ID, groupLabel, isMfgGroup } from './accounts.js';
import { incomeStatement, manufacturingReport, incomeBeforeLabel } from './statements.js';
import { NEUTRAL_PROFIT } from './fs-rows.js';

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

const SECTIONS = ['bs_asset', 'bs_liability', 'bs_equity'];

const sectionOf = (r) => GROUP_BY_ID[r.account.group]?.section ?? 'pl';
const signOf = (account) => (account.normalSide === GROUP_BY_ID[account.group]?.side ? 1 : -1);
const moved = (r) => r.opening || r.debit || r.credit || r.closing;
const emptySum = () => ({ opening: 0, debit: 0, credit: 0, closing: 0, debitTotal: 0, creditTotal: 0, debitBalance: 0, creditBalance: 0 });

function addRow(sum, r, sign) {
  const t = totalsOf(r);
  sum.opening += sign * r.opening;
  sum.debit += r.debit;
  sum.credit += r.credit;
  sum.closing += sign * r.closing;
  sum.debitTotal += t.debitTotal;
  sum.creditTotal += t.creditTotal;
  sum.debitBalance += t.debitBalance;
  sum.creditBalance += t.creditBalance;
}

// 残高だけの行（当期製品製造原価）：side の残高として足す
function addAmount(sum, amount, side) {
  sum.closing += amount;
  const dc = side === 'debit' ? amount : -amount;
  if (dc >= 0) {
    sum.debitTotal += dc;
    sum.debitBalance += dc;
  } else {
    sum.creditTotal -= dc;
    sum.creditBalance -= dc;
  }
}

function mergeSum(to, from) {
  for (const k of Object.keys(to)) to[k] += from[k];
}

/**
 * 損益の科目（製造原価を含む）の残高から計算した当期純損益（利益をプラス）。opening：繰越の時点、closing：期間の末日
 * 収益（貸方の科目）から費用（借方の科目）を引く。決算書の当期純利益（個人は青色申告特別控除前の所得金額）と同じ額になる
 */
export function netIncomeOf(tb) {
  const net = { opening: 0, closing: 0 };
  for (const r of tb.rows) {
    if (sectionOf(r) !== 'pl') continue;
    const s = r.account.normalSide === 'credit' ? 1 : -1;
    net.opening += s * r.opening;
    net.closing += s * r.closing;
  }
  return net;
}

// 当期純損益の行を純資産の合計に足す：繰越・残高に足し、合計残高試算表では残高の欄（利益は貸方、損失は借方）だけに足す
function addIncome(sum, { opening, closing }) {
  sum.opening += opening;
  sum.closing += closing;
  if (closing >= 0) sum.creditBalance += closing;
  else sum.debitBalance -= closing;
}

/**
 * 区分の見出し・科目・区分の合計
 * @param {Array<{ row } | { label, amount }>} lines 科目（row）か残高だけの行
 */
function groupRows(label, lines, { withSubtotal = true } = {}) {
  const sum = emptySum();
  const rows = [{ kind: 'group', label }];
  for (const l of lines) {
    if (l.row) {
      const sign = signOf(l.row.account);
      addRow(sum, l.row, sign);
      rows.push({ kind: 'account', label: l.row.account.name, row: l.row, sign });
    } else {
      addAmount(sum, l.amount, 'debit');
      rows.push({ kind: 'calc', label: l.label, amount: l.amount, side: 'debit' });
    }
  }
  if (withSubtotal && lines.length > 1) rows.push({ kind: 'subtotal', label: `${label}合計`, sum });
  return { rows, sum };
}

/** 区分ごとにまとめる（trialBalance の行は科目の並び順なので、同じ区分は続いている） */
function byGroup(list) {
  const groups = [];
  for (const r of list) {
    const last = groups.at(-1);
    if (last && last.group === r.account.group) last.rows.push(r);
    else groups.push({ group: r.account.group, rows: [r] });
  }
  return groups;
}

function balanceSheetPart(tb, { entityType, white, showZero }) {
  const individual = entityType === 'individual';
  const list = tb.rows.filter((r) => sectionOf(r) !== 'pl' && (showZero || moved(r)));
  const totalLabel = { bs_asset: '資産合計', bs_liability: '負債合計', bs_equity: individual ? '資本合計' : '純資産合計' };
  const net = netIncomeOf(tb);
  const income = { kind: 'income', label: individual ? incomeBeforeLabel(white).full : '当期純損益金額', ...net, side: 'credit' };
  const withIncome = showZero || net.opening || net.closing;
  const rows = [];
  let assets = 0;
  const right = emptySum(); // 負債・純資産合計
  for (const sec of SECTIONS) {
    const groups = byGroup(list.filter((r) => sectionOf(r) === sec));
    const hasIncome = sec === 'bs_equity' && withIncome;
    if (!groups.length && !hasIncome) continue;
    const sum = emptySum();
    for (const g of groups) {
      const b = groupRows(groupLabel(g.group, entityType), g.rows.map((row) => ({ row })), { withSubtotal: groups.length > 1 });
      rows.push(...b.rows);
      mergeSum(sum, b.sum);
    }
    if (hasIncome) {
      if (!groups.length) rows.push({ kind: 'group', label: groupLabel('equity', entityType) });
      rows.push(income);
      addIncome(sum, net);
    }
    rows.push({ kind: 'total', label: totalLabel[sec], sum });
    if (sec === 'bs_asset') assets = sum.closing;
    else mergeSum(right, sum);
  }
  if (rows.length) rows.push({ kind: 'total', label: individual ? '負債・資本合計' : '負債・純資産合計', sum: right, grand: true });
  return { rows, base: assets };
}

function incomePart(tb, { entityType, white, showZero }) {
  const visible = (r) => showZero || moved(r);
  const { items } = incomeStatement(entityType, tb.rows, { white });
  const byId = new Map(tb.rows.map((r) => [r.account.id, r]));
  const placed = new Set();
  const rows = [];
  for (const it of items) {
    if (it.type === 'subtotal') {
      // 法人の段階利益（試算表では利益・損失のどちらにもなるので「損益」）
      const label = entityType === 'individual' ? it.label : (NEUTRAL_PROFIT[it.label] ?? it.label);
      rows.push({ kind: 'profit', label, amount: it.amount, side: 'credit', strong: Boolean(it.strong) });
      continue;
    }
    const lines = [];
    for (const l of it.lines) {
      // 当期製品製造原価（製造原価の科目の合計）は残高だけの行
      if (l.account.synthetic) {
        if (showZero || l.amount) lines.push({ label: l.account.name, amount: l.amount });
        continue;
      }
      placed.add(l.account.id);
      const r = byId.get(l.account.id);
      if (r && visible(r)) lines.push({ row: r });
    }
    if (lines.length) rows.push(...groupRows(it.label, lines).rows);
  }
  // 損益計算書の様式に無い区分の科目（事業者の種類を変えた後など）も落とさずに最後に書く
  const rest = tb.rows.filter((r) => sectionOf(r) === 'pl' && !isMfgGroup(r.account.group) && !placed.has(r.account.id) && visible(r));
  for (const g of byGroup(rest)) rows.push(...groupRows(groupLabel(g.group, entityType), g.rows.map((row) => ({ row }))).rows);
  if (!rows.some((r) => r.kind === 'account' || r.kind === 'calc')) return { rows: [], base: 0 };
  return { rows, base: items[0]?.total ?? 0 };
}

function manufacturingPart(tb, { entityType, showZero }) {
  const mfg = manufacturingReport(tb.rows);
  const visible = (r) => showZero || moved(r);
  if (!mfg.used || !tb.rows.some((r) => isMfgGroup(r.account.group) && visible(r))) return { rows: [], base: 0 };
  const byId = new Map(tb.rows.map((r) => [r.account.id, r]));
  const rows = [];
  for (const it of mfg.items) {
    if (it.type === 'group') {
      const lines = it.lines.map((l) => byId.get(l.account.id)).filter((r) => r && visible(r));
      if (lines.length) rows.push(...groupRows(it.label, lines.map((row) => ({ row }))).rows);
      continue;
    }
    // 期首・期末の仕掛品棚卸高は科目の行で書く（期首仕掛品棚卸高の位置に、仕掛品棚卸高の区分としてまとめる）
    if (it.plain) {
      if (it.deduct) continue;
      const wip = tb.rows.filter((r) => r.account.group === 'mfg_wip' && visible(r));
      if (wip.length) rows.push(...groupRows(groupLabel('mfg_wip', entityType), wip.map((row) => ({ row }))).rows);
      continue;
    }
    if (it.calc) continue;
    rows.push({ kind: 'profit', label: it.label, amount: it.amount, side: 'debit', strong: Boolean(it.strong) });
  }
  return { rows, base: mfg.totalCost };
}

/**
 * 残高試算表の行
 * @param {object} tb ledger.js の trialBalance の結果
 * @param {{ entityType: string, white?: boolean, showZero?: boolean }} opts white：白色申告（個人の所得金額の呼び名）
 * @returns {{ bs: {rows, base}, pl: {rows, base}, mfg: {rows, base}, grand: object }}
 *   base：構成比の分母（貸借対照表は資産合計、損益計算書は売上高、製造原価は当期総製造費用）
 *   grand：全科目の借方・貸方の合計と残高（合計残高試算表の最後の行。貸借が一致する）
 *   貸借対照表の最後の行（grand: true）は負債・純資産合計で、残高は資産合計と一致する
 */
export function trialRows(tb, { entityType, white = false, showZero = false }) {
  const grand = emptySum();
  for (const r of tb.rows) addRow(grand, r, 1);
  return {
    bs: balanceSheetPart(tb, { entityType, white, showZero }),
    pl: incomePart(tb, { entityType, white, showZero }),
    mfg: manufacturingPart(tb, { entityType, showZero }),
    grand,
  };
}
