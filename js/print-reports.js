// 管理資料の印刷様式（純粋関数）：売掛金・買掛金の残高一覧（年齢表つき）など
// 画面の表から作ると列が足りない・広がりすぎる帳票だけ、ここで専用の様式を作る
import { fmt, warekiText } from './print-layout.js';
import { PARTY_KINDS, AGING_BUCKETS, termsLabel } from './receivables.js';

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

