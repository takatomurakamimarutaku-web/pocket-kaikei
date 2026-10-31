// 固定資産の帳票の印刷様式（純粋関数。A4横）
// 弥生会計の「固定資産台帳 兼 減価償却計算表」「償却額推移表」、勘定奉行クラウドの「取得資産台帳」「除却資産台帳」
// 「償却予定表」「月次償却額一覧表」を参考に、資産を1行ずつ並べて集計の単位（科目・種類・設置場所・部門）ごとに小計・合計を付ける
import { fmt } from './print-layout.js';
import { CATEGORY_BY_ID, usesLife, isDisposable, methodLabel } from './depreciation.js';
import { registerDetail, groupDetails, sortDetails, sumDetails, disposalList, depreciationForecast, monthlyTable, movesIn, GROUP_KEYS } from './asset-reports.js';

const slash = (d) => (d ? d.replaceAll('-', '/') : '');
const b0 = (n) => (n ? fmt(n) : '');
const groupName = (key) => GROUP_KEYS.find((g) => g.id === key)?.label ?? '勘定科目';

/** 帳票の種類（印刷条件の選択肢） */
export const ASSET_DOCS = [
  ['register', '固定資産台帳（兼 減価償却計算表）'],
  ['movement', '固定資産増減明細表'],
  ['forecast', '償却予定表（5年）'],
  ['forecast10', '償却予定表（10年）'],
  ['monthly', '月次償却額一覧表'],
  ['acquired', '取得資産台帳（当期に取得）'],
  ['disposed', '除却資産台帳（当期に売却・除却）'],
  ['moved', '移動資産台帳（当期に部門・設置場所を移動）'],
];

/** 償却方法と耐用年数（2行） */
function methodCell(a) {
  return [methodLabel(a) || a.method || '', usesLife(a.method) && a.usefulLife ? `${a.usefulLife}年` : ''];
}

/** 摘要：売却・除却・特別償却・部門・メモ */
function noteText(d, { departmentById, groupBy }) {
  const a = d.asset;
  const disposal = a.disposedOn && isDisposable(a.method) ? `${slash(a.disposedOn)} ${{ sell: '売却', retire: '除却' }[a.disposalType] ?? '除却'}` : '';
  const dep = groupBy !== 'department' && a.departmentId ? departmentById?.get(a.departmentId)?.name : '';
  return [disposal, d.special ? `うち特別償却 ${fmt(d.special)}` : '', dep ? `部門 ${dep}` : '', a.memo || ''].filter(Boolean).join('　');
}

/**
 * 資産を集計の単位ごとに並べる：見出しの行・資産の行・小計の行、最後に合計
 * @param {Function} cellsOf 明細 → 資産の行のセル
 * @param {Function} sumCells (見出し, 合計) → 小計・合計の行のセル
 */
function groupedRows(details, { groupBy, sortBy, names, columns, cellsOf, sumCells }) {
  const rows = [];
  const groups = groupDetails(details, groupBy, names);
  for (const g of groups) {
    rows.push({ kind: 'group', cells: [{ text: g.label, span: columns.length }] });
    for (const d of sortDetails(g.items, sortBy)) rows.push({ cells: cellsOf(d) });
    if (groups.length > 1 || g.items.length > 1) rows.push({ kind: 'subtotal', cells: sumCells(`${groupName(groupBy)}計（${g.items.length}件）`, g.sum, g.items) });
  }
  rows.push({ kind: 'total', cells: sumCells(`合計（${details.length}件）`, sumDetails(details), details) });
  return rows;
}

/**
 * 固定資産台帳（兼 減価償却計算表）
 * 取得の条件（取得日・数量・取得価額・償却方法・耐用年数・償却率・月数）と、期首帳簿価額→期中増減→当期償却額→期末帳簿価額→減価償却累計額を横に並べる
 * @param {Array} register depreciation.assetRegister の結果
 * @param {{ period, accountById: Map, departmentById?: Map, individual: boolean, head: object, groupBy?: string, sortBy?: string, details?: Array }} opts
 *   details：絞り込んだ registerDetail の結果（省略すると register のすべて）
 */
export function assetRegisterDoc(register, { period, accountById, departmentById, individual, head, groupBy = 'account', sortBy = 'no', details }) {
  const list = details ?? register.map((x) => registerDetail(x, period));
  const columns = [
    { label: '資産番号', w: 15 },
    { label: '資産の名称\n種類', grow: 1, max: 60 },
    { label: '取得日\n使用開始日', align: 'center', w: 19 },
    { label: '数量', align: 'right', w: 8 },
    { label: '取得価額', align: 'right', w: 22 },
    { label: '償却方法\n耐用年数', align: 'center', w: 16 },
    { label: '償却率', align: 'right', w: 11 },
    { label: '月数', align: 'right', w: 8 },
    ...(individual ? [{ label: '事業\n割合', align: 'right', w: 10 }] : []),
    { label: '期首帳簿価額', align: 'right', w: 22 },
    { label: '期中増加\n期中減少', align: 'right', w: 21 },
    { label: '当期償却額', align: 'right', w: 21 },
    ...(individual ? [{ label: '必要経費\n算入額', align: 'right', w: 21 }] : []),
    { label: '期末帳簿価額', align: 'right', w: 22 },
    { label: '減価償却\n累計額', align: 'right', w: 22 },
    { label: '摘要', max: 36 },
  ];
  const names = { accountById, departmentById };
  const cellsOf = (d) => {
    const a = d.asset;
    return [
      a.assetNo || '',
      [a.name, CATEGORY_BY_ID[a.category]?.label ?? ''],
      [slash(a.acquiredOn), a.startedOn && a.startedOn !== a.acquiredOn ? slash(a.startedOn) : ''],
      String(a.quantity ?? 1),
      fmt(d.cost),
      methodCell(a),
      d.row?.rate ? (d.row.rate / 1000).toFixed(3) : '',
      d.months ? String(d.months) : '',
      ...(individual ? [`${a.businessRatio ?? 100}%`] : []),
      fmt(d.bookOpening),
      [d.bookIncrease ? fmt(d.bookIncrease) : '', d.bookDecrease ? fmt(-d.bookDecrease) : ''],
      fmt(d.amount),
      ...(individual ? [fmt(d.business)] : []),
      fmt(d.bookClosing),
      fmt(d.accumulatedClosing),
      noteText(d, { departmentById, groupBy }),
    ];
  };
  const sumCells = (label, s) => [
    { text: label, span: 4 },
    fmt(s.costClosing + s.costDecrease),
    { text: '', span: individual ? 4 : 3 },
    fmt(s.bookOpening),
    [s.bookIncrease ? fmt(s.bookIncrease) : '', s.bookDecrease ? fmt(-s.bookDecrease) : ''],
    fmt(s.amount),
    ...(individual ? [fmt(s.business)] : []),
    fmt(s.bookClosing),
    fmt(s.accumulatedClosing),
    '',
  ];
  const rows = groupedRows(list, { groupBy, sortBy, names, columns, cellsOf, sumCells });
  return {
    title: '固定資産台帳',
    ...head,
    orientation: 'landscape',
    blocks: [
      { type: 'table', columns, rows, font: 7 },
      { type: 'text', text: '・期首帳簿価額＋期中増加−当期償却額−期中減少＝期末帳簿価額。期中減少（△）は売却・除却した日の帳簿価額です。減価償却累計額＝取得価額−期末帳簿価額。' },
      { type: 'text', text: '・月数は当期に償却した月数です。償却率は定額法・定率法の率（改定償却率に切り替えた年は改定償却率）です。' },
    ],
  };
}

/**
 * 固定資産増減明細表：取得価額と帳簿価額の 期首・増加・減少・期末、当期償却額、減価償却累計額
 */
export function movementDoc(details, { accountById, departmentById, head, groupBy = 'account', sortBy = 'no' }) {
  const columns = [
    { label: '資産の名称', grow: 1, max: 60 },
    { label: '期首', align: 'right', w: 22 },
    { label: '増加', align: 'right', w: 20 },
    { label: '減少', align: 'right', w: 20 },
    { label: '期末', align: 'right', w: 22 },
    { label: '期首', align: 'right', w: 22 },
    { label: '増加', align: 'right', w: 20 },
    { label: '減少', align: 'right', w: 20 },
    { label: '償却額', align: 'right', w: 21 },
    { label: '期末', align: 'right', w: 22 },
    { label: '期首', align: 'right', w: 22 },
    { label: '期末', align: 'right', w: 22 },
  ];
  const nums = (s) => [b0(s.costOpening), b0(s.costIncrease), b0(s.costDecrease), b0(s.costClosing), b0(s.bookOpening), b0(s.bookIncrease), b0(s.bookDecrease), b0(s.amount), b0(s.bookClosing), b0(s.accumulatedOpening), b0(s.accumulatedClosing)];
  const rows = groupedRows(details, {
    groupBy,
    sortBy,
    names: { accountById, departmentById },
    columns,
    cellsOf: (d) => [d.asset.assetNo ? `${d.asset.assetNo}　${d.asset.name}` : d.asset.name, ...nums(d)],
    sumCells: (label, s) => [label, ...nums(s)],
  });
  return {
    title: '固定資産増減明細表',
    ...head,
    orientation: 'landscape',
    blocks: [
      {
        type: 'table',
        columns,
        rows,
        font: 7.5,
        headGroups: [
          { label: '取得価額', from: 1, span: 4 },
          { label: '帳簿価額', from: 5, span: 5 },
          { label: '減価償却累計額', from: 10, span: 2 },
        ],
      },
      { type: 'text', text: '・取得価額の減少は売却・除却した資産の取得価額、帳簿価額の減少は売却・除却した日の帳簿価額です。減価償却累計額＝取得価額−帳簿価額。' },
    ],
  };
}

/** 期間の見出し（12か月なら年度、1月始まりなら年） */
export function rangeLabel(r) {
  return r.startDate.slice(5) === '01-01' ? `${r.startDate.slice(0, 4)}年` : `${r.startDate.slice(0, 4)}/${r.startDate.slice(5, 7)}期`;
}

/**
 * 償却予定表（償却額推移表）：当期から years 年分の償却費と、最後の期間の期末帳簿価額
 */
export function forecastDoc(assets, periods, period, { accountById, departmentById, head, groupBy = 'account', sortBy = 'no', years = 5, filter = () => true }) {
  const f = depreciationForecast(assets, periods, period, years);
  const rows0 = f.rows.filter((r) => filter(r.asset));
  // groupDetails・sortDetails に渡すため、明細の形（asset・cost）にする
  const details = rows0.map((r) => ({ ...r, cost: r.asset.cost }));
  const columns = [
    { label: '資産の名称', grow: 1, max: 60 },
    { label: '取得価額', align: 'right', w: 21 },
    { label: '償却方法\n耐用年数', align: 'center', w: 16 },
    ...f.ranges.map((r) => ({ label: rangeLabel(r), align: 'right', w: years > 5 ? 17 : 21 })),
    { label: `${rangeLabel(f.ranges.at(-1))}末\n帳簿価額`, align: 'right', w: 21 },
  ];
  const sumOf = (items) => ({ cost: items.reduce((s, r) => s + r.cost, 0), amounts: f.ranges.map((_, i) => items.reduce((s, r) => s + r.amounts[i], 0)), closing: items.reduce((s, r) => s + r.closing.at(-1), 0) });
  const rows = [];
  const groups = groupDetails(details.map((d) => ({ ...d, ...ZERO })), groupBy, { accountById, departmentById });
  for (const g of groups) {
    rows.push({ kind: 'group', cells: [{ text: g.label, span: columns.length }] });
    for (const r of sortDetails(g.items, sortBy)) rows.push({ cells: [r.asset.assetNo ? `${r.asset.assetNo}　${r.asset.name}` : r.asset.name, fmt(r.cost), methodCell(r.asset), ...r.amounts.map(b0), fmt(r.closing.at(-1))] });
    if (groups.length > 1 || g.items.length > 1) {
      const s = sumOf(g.items);
      rows.push({ kind: 'subtotal', cells: [`${groupName(groupBy)}計（${g.items.length}件）`, fmt(s.cost), '', ...s.amounts.map(fmt), fmt(s.closing)] });
    }
  }
  const t = sumOf(details);
  rows.push({ kind: 'total', cells: [`合計（${details.length}件）`, fmt(t.cost), '', ...t.amounts.map(fmt), fmt(t.closing)] });
  return {
    title: '償却予定表',
    ...head,
    orientation: 'landscape',
    blocks: [
      { type: 'table', columns, rows, font: years > 5 ? 6.5 : 7.5 },
      { type: 'text', text: '・登録済みの資産を今の条件のまま償却したときの予定額です。これから取得・売却する資産は含みません。' },
      { type: 'text', text: '・登録していない先の年分は、会計期間を12か月として計算しています。' },
    ],
  };
}
const ZERO = Object.fromEntries(['costOpening', 'costIncrease', 'costDecrease', 'costClosing', 'bookOpening', 'bookIncrease', 'bookDecrease', 'ordinary', 'special', 'amount', 'business', 'bookClosing', 'accumulatedOpening', 'accumulatedClosing'].map((k) => [k, 0]));

/**
 * 月次償却額一覧表：資産ごとに月別の償却費、月ごとの合計
 * @param {Array} register depreciation.assetRegister の結果（絞り込み後）
 */
export function monthlyDoc(register, period, { accountById, departmentById, head, groupBy = 'account', sortBy = 'no', individual = false }) {
  const m = monthlyTable(register, period);
  const details = m.rows.map((r) => ({ ...ZERO, ...r, cost: r.asset.cost }));
  const columns = [
    { label: '資産の名称', grow: 1, max: 48 },
    ...m.months.map((mm) => ({ label: `${Number(mm.slice(5))}月`, align: 'right', w: 16 })),
    { label: '合計', align: 'right', w: 19 },
  ];
  const sumOf = (items) => m.months.map((_, i) => items.reduce((s, r) => s + r.amounts[i], 0));
  const rows = [];
  const groups = groupDetails(details, groupBy, { accountById, departmentById });
  for (const g of groups) {
    rows.push({ kind: 'group', cells: [{ text: g.label, span: columns.length }] });
    for (const r of sortDetails(g.items, sortBy)) rows.push({ cells: [r.asset.name, ...r.amounts.map(b0), fmt(r.total)] });
    if (groups.length > 1 || g.items.length > 1) {
      const s = sumOf(g.items);
      rows.push({ kind: 'subtotal', cells: [`${groupName(groupBy)}計`, ...s.map(fmt), fmt(s.reduce((a, b) => a + b, 0))] });
    }
  }
  rows.push({ kind: 'total', cells: ['合計', ...m.totals.map(fmt), fmt(m.total)] });
  if (individual && m.businessTotals.some((v, i) => v !== m.totals[i])) rows.push({ kind: 'subtotal', cells: ['うち必要経費', ...m.businessTotals.map(fmt), fmt(m.businessTotals.reduce((a, b) => a + b, 0))] });
  return {
    title: '月次償却額一覧表',
    ...head,
    orientation: 'landscape',
    blocks: [
      { type: 'table', columns, rows, font: 6.5 },
      { type: 'text', text: '・当期の償却費を、償却する月（使い始めた月から、売却・除却した月まで）に均等に割り振っています。1円未満の端数は後の月に寄せ、特別償却は最後の月に入れています。' },
    ],
  };
}

/**
 * 取得資産台帳（当期に取得した資産）
 */
export function acquiredDoc(details, { accountById, departmentById, head, groupBy = 'account', sortBy = 'date' }) {
  const list = details.filter((d) => d.costIncrease);
  const columns = [
    { label: '資産番号', w: 15 },
    { label: '資産の名称\n種類', grow: 1, max: 60 },
    { label: '取得日\n使用開始日', align: 'center', w: 19 },
    { label: '数量', align: 'right', w: 9 },
    { label: '取得価額', align: 'right', w: 23 },
    { label: '償却方法\n耐用年数', align: 'center', w: 17 },
    { label: '当期償却額', align: 'right', w: 22 },
    { label: '期末帳簿価額', align: 'right', w: 22 },
    { label: '購入先\n設置場所', max: 40 },
  ];
  const rows = groupedRows(list, {
    groupBy,
    sortBy,
    names: { accountById, departmentById },
    columns,
    cellsOf: (d) => [d.asset.assetNo || '', [d.asset.name, CATEGORY_BY_ID[d.asset.category]?.label ?? ''], [slash(d.asset.acquiredOn), d.asset.startedOn !== d.asset.acquiredOn ? slash(d.asset.startedOn) : ''], String(d.asset.quantity ?? 1), fmt(d.cost), methodCell(d.asset), fmt(d.amount), fmt(d.bookClosing), [d.asset.supplier || '', d.asset.location || '']],
    sumCells: (label, s) => [{ text: label, span: 4 }, fmt(s.costIncrease), '', fmt(s.amount), fmt(s.bookClosing), ''],
  });
  return { title: '取得資産台帳', ...head, orientation: 'landscape', blocks: [{ type: 'table', columns, rows, font: 7.5 }] };
}

/**
 * 除却資産台帳（当期に売却・除却した資産）：売却・除却した日の帳簿価額と売却損益
 */
export function disposedDoc(details, { head }) {
  const list = disposalList(details);
  const columns = [
    { label: '売却・除却日', align: 'center', w: 20 },
    { label: '区分', align: 'center', w: 11 },
    { label: '資産の名称\n種類', grow: 1, max: 60 },
    { label: '取得日', align: 'center', w: 19 },
    { label: '取得価額', align: 'right', w: 23 },
    { label: '減価償却\n累計額', align: 'right', w: 23 },
    { label: '当期償却額', align: 'right', w: 22 },
    { label: '売却・除却時\n帳簿価額', align: 'right', w: 23 },
    { label: '売却額', align: 'right', w: 22 },
    { label: '売却益\n（△損）', align: 'right', w: 22 },
  ];
  const rows = list.map((d) => ({
    cells: [slash(d.date), d.type === 'sell' ? '売却' : '除却', [d.asset.name, CATEGORY_BY_ID[d.asset.category]?.label ?? ''], slash(d.asset.acquiredOn), fmt(d.cost), fmt(d.accumulatedAtDisposal), fmt(d.amount), fmt(d.bookDecrease), d.type === 'sell' ? fmt(d.price) : '', fmt(d.gainLoss)],
  }));
  const sum = (k) => list.reduce((s, d) => s + d[k], 0);
  rows.push({ kind: 'total', cells: [{ text: `合計（${list.length}件）`, span: 4 }, fmt(sum('cost')), fmt(sum('accumulatedAtDisposal')), fmt(sum('amount')), fmt(sum('bookDecrease')), fmt(sum('price')), fmt(sum('gainLoss'))] });
  return {
    title: '除却資産台帳',
    ...head,
    orientation: 'landscape',
    blocks: [
      { type: 'table', columns, rows, font: 7.5 },
      { type: 'text', text: '・売却益（△損）＝売却額−売却した日の帳簿価額。除却は帳簿価額がそのまま除却損です（個人の事業用資産の売却は譲渡所得になり、帳簿では事業主借・事業主貸で処理します）。' },
    ],
  };
}

/**
 * 移動資産台帳（当期に部門・設置場所を移動した資産）：移動した日・移動前と移動後の部門・設置場所・移動した日の帳簿価額の目安として期末帳簿価額
 */
export function movedDoc(details, { period, departmentById, head }) {
  const byAsset = new Map(details.map((d) => [d.asset.id, d]));
  const list = movesIn(details.map((d) => d.asset), period);
  const dep = (id) => (id ? (departmentById?.get(id)?.name ?? '（削除した部門）') : '');
  const columns = [
    { label: '移動日', align: 'center', w: 19 },
    { label: '資産番号', w: 15 },
    { label: '資産の名称\n種類', grow: 1, max: 60 },
    { label: '取得価額', align: 'right', w: 23 },
    { label: '期末帳簿価額', align: 'right', w: 23 },
    { label: '移動前\n部門・設置場所', max: 45 },
    { label: '移動後\n部門・設置場所', max: 45 },
    { label: 'メモ', max: 40 },
  ];
  const rows = list.map(({ asset, move }) => {
    const d = byAsset.get(asset.id);
    return {
      cells: [slash(move.date), asset.assetNo || '', [asset.name, CATEGORY_BY_ID[asset.category]?.label ?? ''], fmt(d?.cost ?? asset.cost), fmt(d?.bookClosing ?? 0), [dep(move.fromDepartmentId), move.fromLocation], [dep(move.toDepartmentId), move.toLocation], move.memo || ''],
    };
  });
  rows.push({ kind: 'total', cells: [{ text: `合計（${list.length}件）`, span: 8 }] });
  return {
    title: '移動資産台帳',
    ...head,
    orientation: 'landscape',
    blocks: [
      { type: 'table', columns, rows, font: 7.5 },
      { type: 'text', text: '・移動した月から移動後の部門の償却費になります。期中に部門を移した資産の償却費は、月数で部門に分けて仕訳します。' },
    ],
  };
}
