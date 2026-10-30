// 決算書（損益計算書・貸借対照表・製造原価報告書）の表示の行（純粋関数）。画面と印刷で同じ行を使う
//
// 配置は日本の決算書の慣行による（市販の会計ソフトの決算書、金融機関の損益計算書の様式例）：
//   - 金額は2列。科目の金額は左（内訳）の列、区分の合計は区分の最後の科目と同じ行の右の列、段階利益は右の列
//   - 区分の科目が1つだけなら、その金額を右の列に書く（内訳と合計が同じになるため）
//   - 売上原価・材料費に期末の棚卸高（評価勘定）があれば、その前に「合計」（個人は「小計」）の行を入れ、
//     期末の棚卸高は差し引く金額として正の数で書く
// 法人の段階利益の名前は会社計算規則 第89条〜第94条の表示（売上総利益金額・営業利益金額・経常利益金額・
// 税引前当期純利益金額・当期純利益金額）。零未満のときは「売上総損失金額」などとし、金額は零から差し引いた額（正の数）で書く
// 貸借対照表の純資産の部（法人）は会社計算規則 第76条の区分（株主資本 › 資本金・資本剰余金・利益剰余金〔その他利益剰余金〕）
//
// 行：{ kind, label, level, inner, outer, rule }
//   kind：part（資産の部などの見出し）・heading（【区分】）・heading2・heading3（区分の中の区分）・line（科目）・note（うち当期純利益）・
//         calc（合計・期首棚卸高などの計算の行）・profit（段階利益）・net（当期純利益金額などの最後の行）・total（負債合計など）・grand（資産合計など）
//   level：字下げの段（0〜3）。inner：左の列の金額、outer：右の列の金額（無ければ null）。rule：右の列の金額の上の線（over）・二重線（double）
import { isContra } from './accounts.js';

// 期の途中・前期と比べる表の段階利益の名前（利益と損失のどちらにもなるので「損益」と書き、マイナスは△）
export const NEUTRAL_PROFIT = { 売上総利益: '売上総損益金額', 営業利益: '営業損益金額', 経常利益: '経常損益金額', 税引前当期純利益: '税引前当期純損益金額', 当期純利益: '当期純損益金額' };

// 会社計算規則の段階利益の名前：[利益のとき, 損失のとき]
const CORP_PROFIT = {
  売上総利益: ['売上総利益金額', '売上総損失金額'],
  営業利益: ['営業利益金額', '営業損失金額'],
  経常利益: ['経常利益金額', '経常損失金額'],
  税引前当期純利益: ['税引前当期純利益金額', '税引前当期純損失金額'],
  当期純利益: ['当期純利益金額', '当期純損失金額'],
};

/** 法人の段階利益の名前と金額（損失なら名前を変えて正の数） */
export function corporateProfit(label, amount) {
  const names = CORP_PROFIT[label];
  if (!names) return { label, amount };
  return amount < 0 ? { label: names[1], amount: -amount } : { label: names[0], amount };
}

// 期末の棚卸高を差し引く前に「合計」を入れる区分（売上原価・材料費・仕掛品）
const COST_GROUPS = ['cost_of_sales', 'mfg_materials', 'mfg_wip'];
// 見出しを付けない区分（法人税等は「法人税、住民税及び事業税」の行だけを書く）
const HEADLESS_GROUPS = ['income_taxes'];

const row = (kind, label, level, inner = null, outer = null, rule = null) => ({ kind, label, level, inner, outer, rule });

/**
 * 区分の科目の行。最後の行の右の列に区分の合計（科目が1つなら右の列だけ）
 * @param {{ lines, total, groups?, label }} it statements.js の区分
 */
function groupLines(it, { showZero, level, individual }) {
  const lines = it.lines.filter((l) => showZero || l.amount);
  const out = [];
  const isCost = it.groups?.some((g) => COST_GROUPS.includes(g));
  const firstContra = isCost ? lines.findIndex((l) => isContra(l.account)) : -1;
  // 売上原価：期首棚卸高・仕入高（製造原価）→ 合計 → 期末棚卸高（正の数で書いて差し引く）
  const withCalc = firstContra > 0;
  lines.forEach((l, i) => {
    if (withCalc && i === firstContra) {
      const sum = lines.slice(0, firstContra).reduce((s, x) => s + x.amount, 0);
      out.push(row('calc', individual ? '小計' : '合計', level + 1, sum));
    }
    const amount = withCalc && i >= firstContra ? 0 - l.amount : l.amount;
    out.push({ ...row('line', l.account.name, level, amount), id: l.account.id });
    if (l.note) out.push({ ...row('note', l.note.label, level + 1, l.note.amount), paren: true });
  });
  const items = out.filter((r) => r.kind === 'line');
  if (items.length === 1 && !withCalc) {
    items[0].outer = it.total;
    items[0].inner = null;
  } else if (items.length) {
    items.at(-1).outer = it.total;
    // 前期と比べる表（金額を期ごとに1列にする）で、区分の合計を別の行にするときの名前（個人の売上原価は青色申告決算書の「差引原価」）
    items.at(-1).sumLabel = isCost && individual ? '差引原価' : `${it.label}合計`;
  }
  return out;
}

/**
 * 損益計算書・製造原価報告書の行
 * @param {Array} items statements.js の incomeStatement・manufacturingReport の items（または financial.js の condensedIncomeItems）
 * @param {{ entityType: string, showZero?: boolean, neutral?: boolean }} opts neutral：法人の段階利益を「売上総損益金額」などにし、損失はマイナスのまま（前期と比べる表）
 */
export function incomeStatementRows(items, { entityType, showZero = false, neutral = false }) {
  const individual = entityType === 'individual';
  const rows = [];
  for (const it of items) {
    if (it.type === 'subtotal') {
      // 販売費及び一般管理費を合計の1行にしたもの（内訳は販売費及び一般管理費内訳書）
      if (it.sga) {
        rows.push(row('heading', it.label, 0, null, it.amount));
        continue;
      }
      // 期首仕掛品棚卸高・期末仕掛品棚卸高（deduct：差し引く額。正の数で書く）
      if (it.plain) {
        if (showZero || it.amount) rows.push(row('calc', it.label, 1, null, it.deduct ? -it.amount : it.amount));
        continue;
      }
      // 製造原価報告書の「合計」（当期総製造費用＋期首仕掛品棚卸高）。期首が無く同じ額になるときは省く
      if (it.calc) {
        if (showZero || rows.at(-1)?.kind === 'calc') rows.push(row('calc', it.label, 2, null, it.amount, 'over'));
        continue;
      }
      const p = individual ? { label: it.label, amount: it.amount } : neutral ? { label: NEUTRAL_PROFIT[it.label] ?? it.label, amount: it.amount } : corporateProfit(it.label, it.amount);
      rows.push({ ...row(it.strong ? 'net' : 'profit', p.label, 1, null, p.amount, it.strong ? 'double' : 'over'), base: it.label });
      continue;
    }
    const visible = it.lines.some((l) => showZero || l.amount);
    if (!visible && !showZero && !it.total) continue;
    const headless = it.groups?.some((g) => HEADLESS_GROUPS.includes(g));
    if (!headless) rows.push(row('heading', it.label, 0, null, visible ? null : it.total));
    if (visible) rows.push(...groupLines(it, { showZero, level: 1, individual }));
  }
  return rows;
}

// 純資産の科目の区分（法人）：role・目印で分ける（名前では判定しない）
const equityKind = (a) => (a.role === 'capital_stock' ? 'capital' : a.hint === 'capital_reserve' ? 'capital_surplus' : a.hint === 'legal_reserve' ? 'legal' : a.role === 'retained_earnings' ? 'retained' : 'other');

/** 純資産の部（法人）：株主資本 › 資本金・資本剰余金・利益剰余金（利益準備金・その他利益剰余金 › 繰越利益剰余金）・その他 */
function corporateEquityRows(group, { showZero }) {
  const lines = group.lines.filter((l) => showZero || l.amount || l.account.role === 'retained_earnings' || l.account.role === 'capital_stock');
  const of = (kind) => lines.filter((l) => equityKind(l.account) === kind);
  const sum = (list) => list.reduce((s, l) => s + l.amount, 0);
  const lineRows = (list, level) => list.flatMap((l) => [{ ...row('line', l.account.name, level, l.amount), id: l.account.id }, ...(l.note ? [{ ...row('note', l.note.label, level + 1, l.note.amount), paren: true }] : [])]);
  const out = [row('heading', '株主資本', 0, null, group.total)];
  out.push(...lineRows(of('capital'), 1));
  const surplus = of('capital_surplus');
  if (surplus.length) out.push(row('heading2', '資本剰余金', 1, null, sum(surplus)), ...lineRows(surplus, 2));
  const legal = of('legal');
  const retained = of('retained');
  if (legal.length || retained.length) {
    out.push(row('heading2', '利益剰余金', 1, null, sum(legal) + sum(retained)), ...lineRows(legal, 2));
    if (retained.length) out.push(row('heading3', 'その他利益剰余金', 2, null, sum(retained)), ...lineRows(retained, 3));
  }
  out.push(...lineRows(of('other'), 1));
  return out;
}

/**
 * 貸借対照表の行。区分の見出しの右の列に区分の合計、科目は左の列（勘定式では1列にまとめて書く）
 * @param {{ assets: Array, liabilities: Array }} bs statements.js の balanceSheet の結果
 * @param {{ entityType: string, showZero?: boolean }} opts
 * @returns {{ assets: Array, liabilities: Array, assetTotal: {label, amount}, liabilityTotal: {label, amount}, rightLabel: string }}
 *   assets・liabilities：左（資産の部）・右（負債・純資産の部）の行。最後の合計は含めず assetTotal・liabilityTotal で返す
 */
export function balanceSheetRows(bs, { entityType, showZero = false }) {
  const individual = entityType === 'individual';
  const side = (items, { equityPart }) => {
    const out = [];
    let grand = null;
    for (const it of items) {
      if (it.type === 'subtotal') {
        if (it.strong) {
          grand = { label: it.label, amount: it.amount };
          continue;
        }
        // 固定資産（有形・無形・投資その他の合計）
        if (it.heading) {
          if (showZero || it.amount) out.push(row('heading', it.label, 0, null, it.amount));
          continue;
        }
        // 負債合計（線の下に合計）・個人の青色申告特別控除前の所得金額
        out.push(it.label.endsWith('合計') ? row('total', it.label, 0, null, it.amount, 'over') : row('calc', it.label, 0, null, it.amount));
        continue;
      }
      const lines = it.lines.filter((l) => showZero || l.amount);
      if (!showZero && !lines.length && !it.total) continue;
      if (!individual && it.groups?.includes('equity')) {
        if (equityPart) out.push(row('part', '純資産の部', 0));
        out.push(...corporateEquityRows(it, { showZero }));
        out.push(row('total', '純資産合計', 0, null, it.total, 'over'));
        continue;
      }
      // 個人の事業主貸は見出しを付けずに科目を書く（青色申告決算書の貸借対照表の並び）
      if (it.groups?.includes('owner_drawings')) {
        out.push(...lines.map((l) => ({ ...row('line', l.account.name, 0, l.amount), id: l.account.id })));
        continue;
      }
      const level = it.level === 2 ? 1 : 0;
      out.push(row(level ? 'heading2' : 'heading', it.label, level, null, it.total));
      for (const l of lines) {
        out.push({ ...row('line', l.account.name, level + 1, l.amount), id: l.account.id });
        if (l.note) out.push({ ...row('note', l.note.label, level + 2, l.note.amount), paren: true });
      }
    }
    return { rows: out, grand };
  };
  const left = side(bs.assets, { equityPart: false });
  const right = side(bs.liabilities, { equityPart: true });
  const rightLabel = individual ? '負債・資本の部' : '負債の部';
  return {
    assets: [row('part', '資産の部', 0), ...left.rows],
    liabilities: [row('part', rightLabel, 0), ...right.rows],
    assetTotal: left.grand ?? { label: '資産合計', amount: bs.totalAssets },
    liabilityTotal: right.grand ?? { label: individual ? '負債・資本合計' : '負債・純資産合計', amount: bs.totalLiabilitiesAndEquity },
  };
}

/** 勘定式などで1列にまとめるときの金額（右の列が無ければ左の列） */
export const singleAmount = (r) => r.outer ?? r.inner;
