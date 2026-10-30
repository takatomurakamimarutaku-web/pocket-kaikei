// 管理資料の印刷様式（純粋関数）：売掛金・買掛金の残高一覧（年齢表つき）など
// 画面の表から作ると列が足りない・広がりすぎる帳票だけ、ここで専用の様式を作る
import { fmt, warekiText } from './print-layout.js';
import { PARTY_KINDS, AGING_BUCKETS, termsLabel } from './receivables.js';
import { CATEGORY_BY_ID, usesLife, methodLabel } from './depreciation.js';
import { registerByAccount } from './asset-tools.js';

const slash = (d) => (d ? d.replaceAll('-', '/') : '');

/**
 * 売掛金・買掛金の残高一覧表（年齢表つき、A4横）
 * 弥生会計の「売掛金残高一覧表」・勘定奉行の「債権年齢表」と同じく、取引先ごとに残高と経過日数の区分を横に並べ、最後に合計
 * @param {object} result receivables.partyBalances の結果
 * @param {{ head: { company, printedAt }, includeSettled?: boolean }} opts includeSettled：残高のない取引先も出す
 */
export function agingDoc(result, { head, includeSettled = false }) {
  const k = PARTY_KINDS[result.kind];
  const multi = new Set(result.parties.map((p) => p.accountId)).size > 1;
  const parties = result.parties.filter((p) => includeSettled || p.balance || p.open.length || p.overpaid);
  const b0 = (n) => (n ? fmt(n) : '');
  const columns = [
    { label: k.party, grow: 1, max: 60 },
    ...(multi ? [{ label: '科目', max: 30 }] : []),
    { label: '残高', align: 'right', w: 25 },
    ...AGING_BUCKETS.map((b) => ({ label: b.label, align: 'right', w: 22 })),
    { label: '期日超過', align: 'right', w: 22 },
    { label: k.over, align: 'right', w: 20 },
    { label: '支払条件', max: 42, grow: 0 },
    { label: `次の${k.due}`, align: 'center', w: 22 },
  ];
  const rows = parties.map((p) => ({
    cells: [p.name, ...(multi ? [p.accountName] : []), fmt(p.balance), ...AGING_BUCKETS.map((b) => b0(p.buckets[b.id])), b0(p.overdue), b0(p.overpaid), p.terms ? termsLabel(p.terms) : '未設定', slash(p.nextDue)],
  }));
  const t = result.totals;
  rows.push({ kind: 'total', cells: [{ text: '合計', span: multi ? 2 : 1 }, fmt(t.balance), ...AGING_BUCKETS.map((b) => fmt(t.buckets[b.id])), fmt(t.overdue), fmt(t.overpaid), '', ''] });
  // 構成比の行（残高に占める区分ごとの割合）
  const base = AGING_BUCKETS.reduce((s, b) => s + Math.max(0, t.buckets[b.id]), 0);
  if (base > 0) rows.push({ kind: 'subtotal', cells: [{ text: '構成比', span: multi ? 2 : 1 }, '', ...AGING_BUCKETS.map((b) => `${Math.round((Math.max(0, t.buckets[b.id]) * 1000) / base) / 10}%`), '', '', '', ''] });
  return {
    title: `${k.label}残高一覧表`,
    company: head.company,
    period: `${warekiText(result.asOf)} 現在`,
    printedAt: head.printedAt,
    orientation: 'landscape',
    blocks: [
      { type: 'table', columns, rows },
      { type: 'text', text: `・経過日数は、${k.increase}の日（発生日）から基準日までの日数です。${k.decrease}は古い${k.increase}から順に充てています（先入先出）。` },
      { type: 'text', text: `・期日超過は、支払条件から求めた${k.due}を基準日に過ぎて残っている額です。支払条件が未設定の${k.party}は期日超過を出しません。` },
    ],
  };
}

/**
 * 固定資産台帳（A4横）：勘定科目ごとに資産を1行ずつ並べ、科目計と合計を付ける
 * 弥生会計・勘定奉行の固定資産台帳（償却資産一覧）と同じく、取得・償却の条件と期首帳簿価額→当期償却額→期末帳簿価額を横に並べる
 * @param {Array} register depreciation.assetRegister の結果（{ asset, cost, opening, row, closing }）
 * @param {{ accountById: Map, individual: boolean, head: object }} opts individual：事業で使う割合と必要経費の列を出す
 */
export function assetRegisterDoc(register, { accountById, individual, head }) {
  const order = (x) => accountById.get(x.asset.accountId)?.code ?? '';
  const list = [...register].sort((a, b) => (order(a) < order(b) ? -1 : order(a) > order(b) ? 1 : (a.asset.assetNo || '') < (b.asset.assetNo || '') ? -1 : 1));
  const columns = [
    { label: '資産番号', w: 16 },
    { label: '資産の名称\n種類', grow: 1, max: 70 },
    { label: '取得日\n使用開始日', align: 'center', w: 20 },
    { label: '数量', align: 'right', w: 9 },
    { label: '取得価額', align: 'right', w: 23 },
    { label: '償却方法', align: 'center', w: 18 },
    { label: '耐用\n年数', align: 'right', w: 10 },
    { label: '償却率', align: 'right', w: 13 },
    ...(individual ? [{ label: '事業\n割合', align: 'right', w: 11 }] : []),
    { label: '期首帳簿価額', align: 'right', w: 23 },
    { label: '当期償却額', align: 'right', w: 22 },
    ...(individual ? [{ label: '必要経費\n算入額', align: 'right', w: 22 }] : []),
    { label: '期末帳簿価額', align: 'right', w: 23 },
    { label: '摘要', max: 40 },
  ];
  const sumCells = (label, s) => [{ text: label, span: 4 }, fmt(s.cost), { text: '', span: individual ? 4 : 3 }, fmt(s.opening), fmt(s.amount), ...(individual ? [fmt(s.business)] : []), fmt(s.closing), ''];
  const rows = [];
  const sums = new Map(registerByAccount(register).map((s) => [s.accountId, s]));
  let current = null;
  for (const { asset: a, cost, opening, row, closing } of list) {
    if (a.accountId !== current) {
      if (current != null) rows.push({ kind: 'subtotal', cells: sumCells('科目計', sums.get(current)) });
      current = a.accountId;
      rows.push({ kind: 'group', cells: [{ text: accountById.get(a.accountId)?.name ?? '', span: columns.length }], });
    }
    const disposal = a.disposedOn ? `${slash(a.disposedOn)} ${{ sell: '売却', retire: '除却' }[a.disposalType] ?? ''}` : '';
    rows.push({
      cells: [
        a.assetNo || '',
        [a.name, CATEGORY_BY_ID[a.category]?.label ?? ''],
        [slash(a.acquiredOn), a.startedOn && a.startedOn !== a.acquiredOn ? slash(a.startedOn) : ''],
        String(a.quantity ?? 1),
        fmt(cost ?? a.cost),
        methodLabel(a) || a.method || '',
        usesLife(a.method) && a.usefulLife ? `${a.usefulLife}年` : '',
        row?.rate ? (row.rate / 1000).toFixed(3) : '',
        ...(individual ? [`${a.businessRatio ?? 100}%`] : []),
        opening == null ? '' : fmt(opening),
        fmt(row?.amount ?? 0),
        ...(individual ? [fmt(row?.business ?? 0)] : []),
        closing == null ? '' : fmt(closing),
        [disposal, row?.special ? `うち特別償却 ${fmt(row.special)}` : ''].filter(Boolean).join('　'),
      ],
    });
  }
  if (current != null) rows.push({ kind: 'subtotal', cells: sumCells('科目計', sums.get(current)) });
  const all = [...sums.values()].reduce((t, s) => ({ cost: t.cost + s.cost, opening: t.opening + s.opening, amount: t.amount + s.amount, business: t.business + s.business, closing: t.closing + s.closing }), { cost: 0, opening: 0, amount: 0, business: 0, closing: 0 });
  rows.push({ kind: 'total', cells: sumCells('合計', all) });
  return { title: '固定資産台帳', ...head, orientation: 'landscape', blocks: [{ type: 'table', columns, rows, font: 7.5 }] };
}
