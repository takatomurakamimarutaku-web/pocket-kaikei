// 申告書の印刷様式（純粋関数）：国税庁の様式（別表）の欄の番号・行の名前・列の組み方に合わせて、印刷する帳票の内容（print-layout.js の doc）を作る
// 様式そのもの（OCR の枠や記入欄の位置）は再現しない。様式に書き写す・見比べるための写しとして、欄の番号と並びをそろえる
// 出典と、番号を様式で確かめられた欄・前年の様式から推した欄の区別は docs/spec-phase3-tax-forms.md
//   別表四（簡易様式）・別表五(一)・別表五(二)・別表七(一)：令和7年4月1日以後終了事業年度分の様式
//     https://www.nta.go.jp/taxes/tetsuzuki/shinsei/annai/hojin/shinkoku/itiran2025/01.htm
//   別表一：令和8年4月1日以後終了事業年度等分の記載要領（防衛特別法人税の次葉一が加わり、税額の内訳は次葉二の74〜）
//     https://www.nta.go.jp/taxes/tetsuzuki/shinsei/annai/hojin/shinkoku/itiran2026/pdf/01-01-ki.pdf

import { fmt, wrapText } from './print-layout.js';
import { formatRatio } from './family-company.js';
import { formatHoldingRatio } from './withholding-credit.js';
import { applicationRows } from './application-statement.js';
import { DEPENDENT_KIND_LABELS } from './income-tax.js';
import { formHeadBlock, corporateHead, applicationHead, localHead, consumptionHead, incomeHead } from './print-form-heads.js';

const blank = (n) => (n ? fmt(n) : '');
const num = (n) => (Number.isFinite(n) ? fmt(n) : '');

/** 様式の日付（R7・4・1） */
export function waDate(iso) {
  if (!iso) return '';
  const y = Number(iso.slice(0, 4));
  const m = Number(iso.slice(5, 7));
  const d = Number(iso.slice(8, 10));
  const [era, year] = iso >= '2019-05-01' ? ['R', y - 2018] : ['H', y - 1988];
  return `${era}${year}・${m}・${d}`;
}

/** 前の事業年度（12か月とみなす） */
function priorPeriod(startDate) {
  const [y, m, d] = startDate.split('-').map(Number);
  const pad = (n) => String(n).padStart(2, '0');
  const end = new Date(Date.UTC(y, m - 1, d - 1));
  const start = new Date(Date.UTC(y - 1, m - 1, d));
  const iso = (t) => `${t.getUTCFullYear()}-${pad(t.getUTCMonth() + 1)}-${pad(t.getUTCDate())}`;
  return { startDate: iso(start), endDate: iso(end) };
}

const NO = { label: '番号', align: 'center', w: 7 };
const AMT = (label) => ({ label, align: 'right', w: 27 });
const noCell = (n) => ({ text: n == null ? '' : String(n), align: 'center' });
/** 区分の見出しの行（加算・減算など） */
const groupRow = (text, n) => ({ kind: 'group', cells: [{ text, span: n, bold: true }] });

// ---- 別表四（簡易様式） ----

/**
 * 別表四の行。mark：社外流出③に印刷されている文字（その他・※・外※）。match：入力した加算・減算の行の名前で当てはめる
 * 番号の無い行（通算法人・組合等損失など）は対象外の行だが、様式の並びを見せるため名前だけ出す
 */
const S4_ADDS = [
  { no: 2, label: '損金経理をした法人税及び地方法人税（附帯税を除く。）', key: 'nationalTax' },
  { no: 3, label: '損金経理をした道府県民税及び市町村民税', key: 'residentTax' },
  { no: 4, label: '損金経理をした納税充当金', key: 'provision' },
  { no: 5, label: '損金経理をした附帯税（利子税を除く。）、加算金、延滞金（延納分を除く。）及び過怠税', mark: 'その他', match: /附帯税/ },
  { no: 6, label: '減価償却の償却超過額', match: /償却超過額$/ },
  { no: 7, label: '役員給与の損金不算入額', mark: 'その他', match: /役員給与/ },
  { no: 8, label: '交際費等の損金不算入額', mark: 'その他', key: 'entertainment' },
  { no: 9, label: '通算法人に係る加算額', mark: '外※' },
];
const S4_SUBS = [
  { no: 12, label: '減価償却超過額の当期認容額', match: /認容額/ },
  { no: 13, label: '納税充当金から支出した事業税等の金額', key: 'enterprisePaid' },
  { no: 14, label: '受取配当等の益金不算入額', mark: '※', match: /受取配当/ },
  { no: 15, label: '外国子会社から受ける剰余金の配当等の益金不算入額', mark: '※', match: /外国子会社/ },
  { no: 16, label: '受贈益の益金不算入額', mark: '※', match: /受贈益/ },
  { no: 17, label: '適格現物分配に係る益金不算入額', mark: '※', match: /適格現物分配/ },
  { no: 18, label: '法人税等の中間納付額及び過誤納に係る還付金額', match: /中間納付額及び過誤納/ },
  { no: 19, label: '所得税額等及び欠損金の繰戻しによる還付金額等', mark: '※', match: /所得税額等及び欠損金/ },
  { no: 20, label: '通算法人に係る減算額', mark: '※' },
];
const DONATION = /寄附金の損金不算入/;

/** 社外流出③を「※」（外書き）と「その他（配当）」に分けた金額 */
const zero3 = () => ({ total: 0, retained: 0, star: 0, other: 0 });
const add3 = (a, b, sign = 1) => ({ total: a.total + sign * b.total, retained: a.retained + sign * b.retained, star: a.star + sign * b.star, other: a.other + sign * b.other });

/**
 * 加算・減算の行を様式の行に当てはめる
 * @returns {{ lines: Map<number, object>, extra: object[], donation: object }} extra：番号の無い空き行（10・21）に書く行
 */
function placeItems(items, defs) {
  const lines = new Map();
  const extra = [];
  let donation = zero3();
  for (const it of items) {
    if (!it.amount) continue;
    const def = defs.find((d) => (d.key && d.key === it.key) || (d.match && it.key === 'other' && d.match.test(it.label)));
    const isStar = def?.mark === '※';
    const v = { total: it.amount, retained: it.kind === 'retained' ? it.amount : 0, star: it.kind === 'outflow' && isStar ? it.amount : 0, other: it.kind === 'outflow' && !isStar ? it.amount : 0 };
    if (DONATION.test(it.label)) donation = add3(donation, v);
    else if (def) lines.set(def.no, add3(lines.get(def.no) || zero3(), v));
    else extra.push({ label: it.label, ...v });
  }
  return { lines, extra, donation };
}

/** 別表四の1行（③は「※・外※・その他・配当」の文字と金額の2列。※の外書きとその他が両方あれば2段） */
function s4Row(no, label, v, { mark = '', strong = false, outer = false } = {}) {
  const cells = [{ text: label, bold: strong }, noCell(no), num0(v?.total, strong), num0(v?.retained, strong)];
  if (!v) return { cells: [...cells, mark, ''] };
  if (outer && v.star) return { cells: [cells[0], cells[1], cells[2], cells[3], ['外※', ''], [fmt(v.star), blank(v.other) || (strong ? '0' : '')]], kind: strong ? 'subtotal' : undefined };
  const amt = mark === '※' ? v.star : v.other + (outer ? v.star : 0);
  return { cells: [...cells, mark === '外※' ? '' : mark, strong ? num(amt) : blank(amt)], kind: strong ? 'subtotal' : undefined };
}
const num0 = (n, strong) => (strong ? num(n ?? 0) : blank(n));

/**
 * 別表四（簡易様式）の表
 * @param {object} s4 corporateTaxReturn の schedule4
 */
export function schedule4Blocks(s4) {
  const adds = placeItems(s4.adds, S4_ADDS);
  const subs = placeItems(s4.subs, S4_SUBS);
  const profit = { total: s4.profit.total, retained: s4.profit.retained, star: 0, other: s4.profit.outflow };
  const sum = (p) => [...p.lines.values(), ...p.extra].reduce((a, b) => add3(a, b), zero3());
  const addTotal = sum(adds);
  const subTotal = sum(subs);
  const prov = add3(add3(profit, addTotal), subTotal, -1); // 23 仮計（寄附金は27へ）
  const withholding = { total: s4.withholding, retained: 0, star: 0, other: s4.withholding };
  const total34 = add3(add3(prov, adds.donation), add3(withholding, subs.donation, -1));
  const lossRow = { total: -s4.lossDeducted, retained: 0, star: -s4.lossDeducted, other: 0 };
  const total45 = add3(total34, lossRow);
  const rows = [
    { cells: [{ text: '当期利益又は当期欠損の額', bold: true }, noCell(1), num(profit.total), num(profit.retained), ['配当', 'その他'], [blank(profit.other), '']] },
    groupRow('加　算', 6),
    ...S4_ADDS.map((d) => s4Row(d.no, d.label, adds.lines.get(d.no), { mark: d.mark })),
    ...(adds.extra.length ? adds.extra.map((x, i) => s4Row(i === 0 ? 10 : null, x.label, x, { mark: x.star ? '※' : x.other ? 'その他' : '' })) : [s4Row(10, '', null)]),
    s4Row(11, '小計', addTotal, { strong: true, outer: true }),
    groupRow('減　算', 6),
    ...S4_SUBS.map((d) => s4Row(d.no, d.label, subs.lines.get(d.no), { mark: d.mark })),
    ...(subs.extra.length ? subs.extra.map((x, i) => s4Row(i === 0 ? 21 : null, x.label, x, { mark: x.star ? '※' : x.other ? 'その他' : '' })) : [s4Row(21, '', null)]),
    s4Row(22, '小計', subTotal, { strong: true, outer: true }),
    s4Row(23, '仮計　(1)＋(11)－(22)', prov, { strong: true, outer: true }),
    s4Row(24, '対象純支払利子等の損金不算入額', null, { mark: 'その他' }),
    s4Row(25, '超過利子額の損金算入額', null, { mark: '※' }),
    s4Row(26, '仮計　((23)から(25)までの計)', prov, { strong: true, outer: true }),
    s4Row(27, '寄附金の損金不算入額', adds.donation.total ? adds.donation : null, { mark: 'その他' }),
    s4Row(29, '法人税額から控除される所得税額', withholding.total ? withholding : null, { mark: 'その他' }),
    s4Row(30, '税額控除の対象となる外国法人税の額', null, { mark: 'その他' }),
    s4Row(31, '分配時調整外国税相当額及び外国関係会社等に係る控除対象所得税額等相当額', null, { mark: 'その他' }),
    s4Row(32, '組合等損失額の損金不算入額又は組合等損失超過合計額の損金算入額', null, { mark: 'その他' }),
    s4Row(34, '合計　(26)＋(27)＋(29)＋(30)＋(31)＋(32)', total34, { strong: true, outer: true }),
    s4Row(37, '中間申告における繰戻しによる還付に係る災害損失欠損金額の益金算入額', null, { mark: '※' }),
    s4Row(38, '非適格合併又は残余財産の全部分配等による移転資産等の譲渡利益額又は譲渡損失額', null, { mark: '※' }),
    s4Row(39, '差引計　(34)＋(37)＋(38)', total34, { strong: true, outer: true }),
    s4Row(40, '更生欠損金又は民事再生等評価換えが行われる場合の再生等欠損金の損金算入額', null, { mark: '※' }),
    s4Row(41, '通算対象欠損金額の損金算入額又は通算対象所得金額の益金算入額', null, { mark: '※' }),
    s4Row(43, '差引計　(39)＋(40)±(41)', total34, { strong: true, outer: true }),
    s4Row(44, '欠損金等の当期控除額', s4.lossDeducted ? lossRow : null, { mark: '※' }),
    s4Row(45, '総計　(43)＋(44)', total45, { strong: true, outer: true }),
    s4Row(51, '残余財産の確定の日の属する事業年度に係る事業税及び特別法人事業税の損金算入額', null),
    { ...s4Row(52, '所得金額又は欠損金額　(45)＋(51)', total45, { strong: true, outer: true }), kind: 'total' },
  ];
  // 減算の※は社外流出から引く（様式の③の外書きは「※」の欄の金額をそのまま書く）
  return [
    {
      type: 'table',
      columns: [{ label: '区　　分', grow: 1, min: 40 }, NO, AMT('総　額\n①'), AMT('留　保\n②'), { label: '社外流出\n③', align: 'center', w: 9, headSpan: 2 }, { label: '', align: 'right', w: 25, joinLeft: true }],
      headGroups: [{ label: '処　　分', from: 3, span: 3 }],
      rows,
    },
    { type: 'text', text: '総額①＝留保②＋社外流出③（「※」の金額を含む）です。(1)の③の配当は当期に支払った剰余金の配当の額です。加算・減算で様式に無い行は、空き行(10)・(21)とその下に書いています。' },
  ];
}

// ---- 別表五(一) ----

/** 別表五(一)：Ⅰ 利益積立金額（1〜31）、Ⅱ 資本金等の額（32〜36） */
export function schedule51Blocks(s51, { defense = false } = {}) {
  const cols = [{ label: '区　　分', grow: 1, min: 40 }, NO, AMT('期首現在\n利益積立金額\n①'), AMT('減\n②'), { label: '増\n③', align: 'center', w: 9, headSpan: 2 }, { label: '', align: 'right', w: 24, joinLeft: true }, AMT('差引翌期首現在\n利益積立金額\n①－②＋③　④')];
  const r4 = (no, label, x, { strong = false } = {}) => ({ kind: strong ? 'total' : undefined, cells: [{ text: label, bold: strong }, noCell(no), strong ? num(x?.opening ?? 0) : blank(x?.opening), strong ? num(x?.decrease ?? 0) : blank(x?.decrease), '', strong ? num(x?.increase ?? 0) : blank(x?.increase), strong ? num(x?.closing ?? 0) : blank(x?.closing)] });
  const rows = s51.rows;
  const legal = rows.filter((x) => !x.unpaid && !x.adjustment && x.label !== '納税充当金' && !x.label.startsWith('繰越損益金'));
  const adjust = rows.filter((x) => x.adjustment);
  const retained = rows.find((x) => x.label.startsWith('繰越損益金'));
  const provision = rows.find((x) => x.label === '納税充当金');
  const unpaid = rows.filter((x) => x.unpaid);
  // 1 利益準備金・2 積立金・3〜24 そのほか（任意積立金・調整項目）。3〜24 は空き行も出して様式の並びにする
  const legalIdx = legal.findIndex((x) => x.label.includes('利益準備金'));
  const legalRow = legalIdx >= 0 ? legal[legalIdx] : null;
  const reserves = legal.filter((_, i) => i !== legalIdx);
  const body = [r4(1, '利益準備金', legalRow), r4(2, reserves[0] ? reserves[0].label : '積立金', reserves[0])];
  const free = [...reserves.slice(1), ...adjust];
  for (let no = 3; no <= 24; no++) {
    const x = free.shift();
    body.push(r4(no, x ? x.label : '', x));
  }
  for (const x of free) body.push(r4(null, x.label, x)); // 22行に入りきらない分
  body.push(r4(25, '繰越損益金（損は赤）', retained));
  body.push(r4(26, '納税充当金', provision));
  const unpaidRow = (no, label, x) => {
    if (!x) return [r4(no, label, null)];
    return [
      { cells: [label, noCell(no), blank(x.opening), blank(x.decrease), '中間', blank(x.interim) || '', blank(x.closing)] },
      { cells: ['', '', '', '', '確定', blank(x.final) || '', ''] },
    ];
  };
  const [national, pref, city] = [unpaid[0], unpaid[1], unpaid[2]];
  body.push(...unpaidRow(27, defense ? '未納法人税及び未納地方法人税（附帯税を除く。）※防衛特別法人税を含む' : '未納法人税及び未納地方法人税（附帯税を除く。）', national));
  body.push(...unpaidRow(28, '未払通算税効果額（附帯税の額に係る部分の金額を除く。）', null));
  body.push(...unpaidRow(29, `未納${pref && pref.label.includes('都民税') ? '都民税' : '道府県民税'}（均等割を含む。）`, pref));
  body.push(...unpaidRow(30, '未納市町村民税（均等割を含む。）', city));
  body.push(r4(31, '差引合計額', s51.total, { strong: true }));

  const cap = s51.capitalRows;
  const capStock = cap[0];
  const capRest = cap.slice(1);
  const capBody = [r4(32, '資本金又は出資金', capStock), r4(33, capRest[0] ? capRest[0].label : '資本準備金', capRest[0]), r4(34, capRest[1]?.label ?? '', capRest[1]), r4(35, capRest[2]?.label ?? '', capRest[2])];
  for (const x of capRest.slice(3)) capBody.push(r4(null, x.label, x));
  capBody.push(r4(36, '差引合計額', s51.capitalTotal, { strong: true }));
  const capCols = cols.map((c, i) => (i === 2 ? AMT('期首現在\n資本金等の額\n①') : i === 6 ? AMT('差引翌期首現在\n資本金等の額\n①－②＋③　④') : c));
  const chk = s51.check;
  return [
    { type: 'heading', text: 'Ⅰ　利益積立金額の計算に関する明細書' },
    { type: 'table', columns: cols, headGroups: [{ label: '当期の増減', from: 3, span: 3 }], rows: body },
    { type: 'text', text: `検算：期首現在利益積立金額合計 ${fmt(chk.opening)} ＋ 別表四の留保所得金額 ${fmt(chk.retained)} － 中間分・確定分の法人税等・道府県民税・市町村民税の合計額 ${fmt(chk.taxes)} ＝ ${fmt(chk.expected)}（差引翌期首現在利益積立金額合計 ${fmt(chk.closing)}${chk.ok ? '　一致' : `　差 ${fmt(chk.diff)}`}）` },
    { type: 'heading', text: 'Ⅱ　資本金等の額の計算に関する明細書' },
    { type: 'table', columns: capCols, headGroups: [{ label: '当期の増減', from: 3, span: 3 }], rows: capBody },
  ];
}

// ---- 別表五(二) ----

/** 別表五(二)：租税公課の納付状況（1〜29）と納税充当金の計算（30〜41） */
export function schedule52Blocks(s52, { startDate }) {
  const prev = priorPeriod(startDate);
  const prevLabel = `${waDate(prev.startDate)}〜${waDate(prev.endDate)}`;
  const cols = [{ label: '税目及び事業年度', grow: 1, min: 46 }, NO, AMT('期首現在\n未納税額\n①'), AMT('当期発生\n税額\n②'), AMT('充当金取崩し\nによる納付\n③'), AMT('仮払経理\nによる納付\n④'), AMT('損金経理\nによる納付\n⑤'), AMT('期末現在未納税額\n①＋②－③－④－⑤\n⑥')];
  const cells6 = (x, strong) => ['opening', 'accrued', 'provisionPaid', 'prepaidPaid', 'expensePaid', 'closing'].map((k) => (strong ? num(x?.[k] ?? 0) : blank(x?.[k])));
  const line = (no, label, x, { strong = false, indent = true } = {}) => ({ kind: strong ? 'subtotal' : undefined, cells: [{ text: label, indent: indent ? 3 : 0, bold: strong }, noCell(no), ...cells6(x, strong)] });
  const rows = [];
  const [national, pref, city, enterprise] = s52.blocks.length === 4 ? s52.blocks : [s52.blocks[0], s52.blocks[1], null, s52.blocks.at(-1)];
  const taxGroup = (b, label, start) => {
    rows.push(groupRow(label, 8));
    const [p, mid, fin] = b ? b.rows : [];
    rows.push(line(start, prevLabel, p), line(start + 1, '・　・', null), line(start + 2, '当期分　中間', mid), line(start + 3, '当期分　確定', fin), line(start + 4, '計', b?.total, { strong: true }));
  };
  taxGroup(national, national?.label ?? '法人税及び地方法人税', 1);
  taxGroup(pref, pref?.label ?? '道府県民税', 6);
  taxGroup(city, '市町村民税', 11);
  rows.push(groupRow(enterprise?.label ?? '事業税及び特別法人事業税', 8));
  rows.push(line(16, prevLabel, enterprise?.rows[0]), line(17, '・　・', null), line(18, '当期中間分', enterprise?.rows[1]), line(19, '計', enterprise?.total, { strong: true }));
  rows.push(groupRow('そ　の　他', 8));
  rows.push(line(20, '損金算入のもの　利子税', null), line(21, '損金算入のもの　延滞金（延納に係るもの）', null), line(22, '', null), line(23, '', null));
  rows.push(line(24, '損金不算入のもの　加算税及び加算金', null), line(25, '損金不算入のもの　延滞税', null), line(26, '損金不算入のもの　延滞金（延納分を除く。）', null), line(27, '損金不算入のもの　過怠税', null), line(28, '', null), line(29, '', null));

  const p = s52.provision;
  const provLeft = [
    { no: 30, label: '期首納税充当金', amount: p.opening, strong: true },
    { head: '繰入額' },
    { no: 31, label: '損金経理をした納税充当金', amount: p.added, indent: true },
    { no: 32, label: '', amount: null, indent: true },
    { no: 33, label: '計　(31)＋(32)', amount: p.added, strong: true },
    { no: 41, label: '期末納税充当金　(30)＋(33)－(40)', amount: p.closing, strong: true },
  ];
  const provRight = [
    { head: '取崩額' },
    { no: 34, label: '法人税額等　(5の③)＋(10の③)＋(15の③)', amount: p.usedTaxes },
    { no: 35, label: '事業税及び特別法人事業税　(19の③)', amount: p.usedEnterprise },
    { no: 36, label: 'その他　損金算入のもの', amount: null },
    { no: 37, label: 'その他　損金不算入のもの', amount: null },
    { no: 38, label: 'その他', amount: p.usedOther },
    { no: 39, label: '仮払税金消却', amount: null },
    { no: 40, label: '計　(34)から(39)までの計', amount: p.used, strong: true },
  ];
  return [
    { type: 'table', columns: cols, headGroups: [{ label: '当期中の納付税額', from: 4, span: 3 }], rows },
    { type: 'heading', text: '納税充当金の計算' },
    twoSide(provLeft, provRight),
    { type: 'text', text: '前期分は納税充当金（未払法人税等）を取り崩して納め、当期の中間分は損金経理で納めた前提です。仮払経理・利子税・延滞金などは計算に入れていません。' },
  ];
}

// ---- 別表七(一) ----

/** 別表七(一)：控除前所得金額（1）・損金算入限度額（2）と、事業年度ごとの欠損金（3〜5） */
export function schedule7Blocks(r) {
  const loss = r.loss;
  const before = Math.max(0, r.schedule4.total.total);
  const pct = r.input.sme ? 100 : 50;
  const top = [
    { cells: [{ text: '控除前所得金額　(別表四「43の①」)' }, noCell(1), num(before), { text: '損金算入限度額　(1)×50又は100／100', }, noCell(2), num(loss.limit)] },
  ];
  const past = loss.rows.filter((x) => !x.current);
  const current = loss.rows.find((x) => x.current);
  const rows = past.map((x) => ({ cells: [`${waDate(x.start)}〜${waDate(x.endDate)}`, x.expired ? '青色欠損（期限切れ）' : x.future ? '（当期より後）' : '青色欠損', blank(x.opening), blank(x.deducted), blank(x.carry)] }));
  while (rows.length < 10) rows.push({ cells: ['・　・〜・　・', '', '', '', ''] });
  const sumPast = (k) => past.reduce((s, x) => s + x[k], 0);
  rows.push({ kind: 'subtotal', cells: ['計', '', num(sumPast('opening')), num(sumPast('deducted')), num(sumPast('carry'))] });
  rows.push({ cells: ['当期分　欠損金額　(別表四「52の①」)', '', '', '', blank(current?.carry)] });
  rows.push({ cells: [{ text: '同上のうち　災害損失金', indent: 6 }, '', '', '', ''] });
  rows.push({ cells: [{ text: '同上のうち　青色欠損金', indent: 6 }, '', '', '', blank(current?.carry)] });
  rows.push({ kind: 'total', cells: ['合計', '', '', num(loss.deducted), num(loss.carry)] });
  return [
    { type: 'table', columns: [{ label: '', grow: 1, min: 40 }, { ...NO, label: '' }, AMT(''), { label: '', grow: 1, min: 40 }, { ...NO, label: '' }, AMT('')], rows: top, split: 3 },
    { type: 'table', columns: [{ label: '事　業　年　度', grow: 1, min: 40 }, { label: '区　分', w: 34 }, AMT('控除未済欠損金額\n3'), AMT('当期控除額\n4'), AMT('翌期繰越額\n5\n((3)－(4))')], rows },
    { type: 'text', text: '当期控除額(4)：当該事業年度の(3)と、((2)－当該事業年度前の(4)の合計額)のうち少ない金額。' },
    { type: 'text', text: `中小法人等は所得金額の100%、それ以外は50%まで控除できます（この計算は${pct}%）。平成30年4月1日以後に開始した事業年度の欠損金は10年、それより前は9年繰り越せます。` },
  ];
}

// ---- 別表十五 ----

/** 別表十五：交際費等の損金算入に関する明細書（1〜5）と支出交際費等の額の明細（6〜9） */
export function schedule15Blocks(e, { months, sme }) {
  const rows = [
    { cells: ['支出交際費等の額　(8の計)', noCell(1), num(e.amount)] },
    { cells: ['支出接待飲食費損金算入基準額　(9の計)×50／100', noCell(2), num(e.diningBase)] },
    { cells: [`中小法人等の定額控除限度額　((1)と(800万円×${months}／12)のうち少ない金額)`, noCell(3), num(e.fixedLimit)] },
    { cells: ['損金算入限度額　(2)又は(3)', noCell(4), num(e.limit)] },
    { kind: 'total', cells: ['損金不算入額　(1)－(4)', noCell(5), num(e.disallowed)] },
  ];
  const detail = [
    { cells: ['交際費等', blank(e.amount), '', blank(e.amount), blank(e.dining)] },
    ...Array.from({ length: 6 }, () => ({ cells: ['', '', '', '', ''] })),
    { kind: 'total', cells: ['計', num(e.amount), num(0), num(e.amount), num(e.dining)] },
  ];
  return [
    { type: 'table', columns: [{ label: '区　　分', grow: 1, min: 60 }, NO, AMT('金　額')], rows },
    { type: 'heading', text: '支出交際費等の額の明細' },
    { type: 'table', columns: [{ label: '科　　目', grow: 1, min: 30 }, AMT('支　出　額\n6'), AMT('交際費等の額から\n控除される費用の額\n7'), AMT('差引交際費等の額\n8'), AMT('(8)のうち接待飲食費の額\n9')], rows: detail },
    { type: 'text', text: sme ? '中小法人等は、定額控除限度額（年800万円）と接待飲食費の50%のどちらか多いほうまで損金に算入できます。' : '中小法人等以外は、接待飲食費の50%まで損金に算入できます。' },
  ];
}

// ---- 別表一 ----

/** 2つの列の項目（左右に並べる）を、[番号・名前・金額]×2 の表にする */
function twoSide(left, right) {
  const n = Math.max(left.length, right.length);
  const side = (it) => {
    if (!it) return ['', '', ''];
    if (it.head) return [{ text: it.head, span: 3, bold: true, align: 'center' }];
    return [{ text: it.label, bold: it.strong, indent: it.indent ? 3 : 0 }, noCell(it.no), it.amount === undefined ? '' : { text: it.amount === null ? '' : typeof it.amount === 'string' ? it.amount : num(it.amount), bold: it.strong }];
  };
  const rows = [];
  for (let i = 0; i < n; i++) rows.push({ cells: [...side(left[i]), ...side(right[i])] });
  const col = [{ label: '区　　分', grow: 1, min: 30 }, { ...NO, w: 9 }, { label: '金　額', align: 'right', w: 24 }];
  return { type: 'table', columns: [...col, ...col], rows, split: 3 };
}

/** 別表一：法人税額の計算（1〜27）・地方法人税額の計算（28〜44）・防衛特別法人税（次葉一）・税額の内訳（次葉二 74〜） */
export function schedule1Blocks(r) {
  const c = r.corp;
  const L = r.local;
  const D = r.defense;
  const low = c.tiers.find((t) => t.label.startsWith('年800万円相当額以下'));
  const high = c.tiers.find((t) => t !== low);
  const pos = (n) => Math.max(0, n);
  const left = [
    { head: '法人税額の計算' },
    { no: 1, label: '所得金額又は欠損金額　(別表四「52の①」)', amount: c.income },
    { no: 2, label: '法人税額　(77)＋(78)＋(79)', amount: c.tax },
    { no: 3, label: '法人税額の特別控除額', amount: c.credits },
    { no: 4, label: '税額控除超過額相当額等の加算額', amount: null },
    { no: 5, label: '課税土地譲渡利益金額', amount: null },
    { no: 6, label: '同上に対する税額', amount: null },
    { no: 7, label: '課税留保金額', amount: null },
    { no: 8, label: '同上に対する税額', amount: null },
    { no: 9, label: '法人税額計　(2)－(3)＋(4)＋(6)＋(8)', amount: c.afterCredits, strong: true },
    { no: 10, label: '分配時調整外国税相当額等の控除額', amount: null },
    { no: 11, label: '仮装経理に基づく過大申告の更正に伴う控除法人税額', amount: null },
    { no: 12, label: '控除税額', amount: c.withholdingUsed },
    { no: 13, label: '差引所得に対する法人税額　(100円未満切捨て)', amount: c.annual, strong: true },
    { no: 14, label: '中間申告分の法人税額', amount: c.interim },
    { no: 15, label: '差引確定法人税額　(13)－(14)', amount: pos(c.due), strong: true },
    { head: '控除税額の計算' },
    { no: 16, label: '所得税の額', amount: r.input.withholding },
    { no: 17, label: '外国税額', amount: null },
    { no: 18, label: '計　(16)＋(17)', amount: r.input.withholding },
    { no: 19, label: '控除した金額　(12)', amount: c.withholdingUsed },
    { no: 20, label: '控除しきれなかった金額　(18)－(19)', amount: c.refundWithholding },
    { head: 'この申告による還付金額' },
    { no: 21, label: '所得税額等の還付金額　(20)', amount: c.refundWithholding },
    { no: 22, label: '中間納付額　(14)－(13)', amount: pos(-c.due) },
    { no: 23, label: '欠損金の繰戻しによる還付請求税額', amount: null },
    { no: 24, label: '計　(21)＋(22)＋(23)', amount: c.refundWithholding + pos(-c.due), strong: true },
    { head: '欠損金等' },
    { no: 26, label: '欠損金等の当期控除額', amount: r.loss.deducted },
    { no: 27, label: '翌期へ繰り越す欠損金額', amount: r.loss.carry },
  ];
  const right = [
    { head: '地方法人税額の計算' },
    { no: 28, label: '所得の金額に対する法人税額　(9)－(6)－(8)', amount: L.standard },
    { no: 29, label: '課税留保金額に対する法人税額', amount: null },
    { no: 30, label: '課税標準法人税額　(28)＋(29)　(1,000円未満切捨て)', amount: L.base },
    { no: 31, label: '地方法人税額　(82)＋(83)', amount: applyLocal(L) },
    { no: 34, label: '所得地方法人税額', amount: applyLocal(L) },
    { no: 38, label: '差引地方法人税額　(100円未満切捨て)', amount: L.annual, strong: true },
    { no: 39, label: '中間申告分の地方法人税額', amount: L.interim },
    { no: 40, label: '差引確定地方法人税額　(38)－(39)', amount: pos(L.due), strong: true },
    { no: 42, label: '中間納付額　(39)－(38)', amount: pos(-L.due) },
    { no: 43, label: '計　(還付金額)', amount: pos(-L.due) },
  ];
  if (D.applies) {
    right.push(
      { head: '防衛特別法人税額の計算（次葉一）' },
      { no: 45, label: '所得の金額に対する法人税額', amount: D.standard },
      { no: 47, label: '基礎控除額　(500万円×月数／12)', amount: D.deduction },
      { no: null, label: '課税標準法人税額　(1,000円未満切捨て)', amount: D.base },
      { no: null, label: '防衛特別法人税額　(100円未満切捨て)', amount: D.annual, strong: true },
      { no: null, label: '中間申告分の防衛特別法人税額', amount: D.interim },
      { no: null, label: '差引確定防衛特別法人税額', amount: pos(D.due), strong: true },
    );
  }
  right.push(
    { head: '法人税額の内訳（次葉二）' },
    { no: 74, label: '(1)のうち中小法人等の年800万円相当額以下の金額', amount: low ? low.amount : null },
    { no: 75, label: '(1)のうち特例税率の適用がある協同組合等の年10億円相当額を超える金額', amount: null },
    { no: 76, label: 'その他の所得金額　(1)－(74)－(75)', amount: high ? high.amount : null },
    { no: 77, label: `(74)の15%、17%又は19%相当額${low ? `（${low.rate / 1000}%）` : ''}`, amount: low ? low.tax : null },
    { no: 78, label: '(75)の22%相当額', amount: null },
    { no: 79, label: `(76)の19%又は23.2%相当額${high ? `（${high.rate / 1000}%）` : ''}`, amount: high ? high.tax : null },
  );
  return [
    twoSide(left, right),
    { type: 'text', text: '番号は令和8年4月1日以後終了事業年度等分の様式の欄の番号です。番号の空欄は様式で番号を確かめられなかった欄です（防衛特別法人税は次葉一に記入）。所得税額の控除・欠損金の繰戻し還付・土地譲渡利益・留保金課税は対象外の欄です。' },
  ];
}
// ---- 別表二：同族会社等の判定に関する明細書 ----

/**
 * 別表二：上に判定（1〜6・10〜14・17・18）、下に判定基準となる株主等の株式数等の明細（19〜22）
 * @param {object} fc family-company.js の familyCompany の結果
 */
export function schedule2Blocks(fc) {
  const f = fc.fields;
  const pct = (r) => formatRatio(r);
  const left = [
    { head: '同族会社の判定' },
    { no: 1, label: '期末現在の発行済株式の総数又は出資の総額', amount: f[1] },
    { no: 2, label: '(19)と(21)の上位3順位の株式数又は出資の金額', amount: f[2] },
    { no: 3, label: '株式数等による判定　(2)／(1)', amount: pct(f[3]) },
    { no: 4, label: '期末現在の議決権の総数', amount: f[4] },
    { no: 5, label: '(20)と(22)の上位3順位の議決権の数', amount: f[5] },
    { no: 6, label: '議決権の数による判定　(5)／(4)', amount: pct(f[6]) },
    { no: 7, label: '期末現在の社員の総数', amount: null },
    { no: 8, label: '社員の3人以下及びこれらの同族関係者の合計人数のうち最も多い数', amount: null },
    { no: 9, label: '社員の数による判定　(8)／(7)', amount: null },
    { no: 10, label: '同族会社の判定割合　((3)、(6)又は(9)のうち最も高い割合)', amount: pct(f[10]), strong: true },
  ];
  const right = [
    { head: '特定同族会社の判定' },
    { no: 11, label: '(19)と(21)の上位1順位の株式数又は出資の金額', amount: f[11] },
    { no: 12, label: '株式数等による判定　(11)／(1)', amount: pct(f[12]) },
    { no: 13, label: '(20)と(22)の上位1順位の議決権の数', amount: f[13] },
    { no: 14, label: '議決権の数による判定　(13)／(4)', amount: pct(f[14]) },
    { no: 15, label: '社員の1人及びその同族関係者の合計人数のうち最も多い数', amount: null },
    { no: 16, label: '社員の数による判定　(15)／(7)', amount: null },
    { no: 17, label: '特定同族会社の判定割合　((12)、(14)又は(16)のうち最も高い割合)', amount: pct(f[17]), strong: true },
    { head: '判定結果' },
    { no: 18, label: '特定同族会社・同族会社・非同族会社', amount: f[18], strong: true },
  ];
  const cnt = (n) => (n ? fmt(n) : '');
  const rows = fc.rows.map((x) => ({
    cells: [
      { text: x.sharesRank ?? '', align: 'center' },
      { text: x.votesRank ?? '', align: 'center' },
      x.address,
      x.name,
      x.relation,
      x.corporate ? cnt(x.shares) : '',
      x.corporate ? cnt(x.votes ?? x.shares) : '',
      x.corporate ? '' : cnt(x.shares),
      x.corporate ? '' : cnt(x.votes ?? x.shares),
    ],
  }));
  while (rows.length < 10) rows.push({ cells: ['', '', '', '', '', '', '', '', ''] });
  const n = (label, no) => ({ label: `${label}\n${no}`, align: 'right', w: 19 });
  return [
    twoSide(left, right),
    { type: 'heading', text: '判定基準となる株主等の株式数等の明細' },
    {
      type: 'table',
      font: 7.5,
      columns: [
        { label: '株式数等', align: 'center', w: 10 },
        { label: '議決権数', align: 'center', w: 10 },
        { label: '住所又は所在地', grow: 1, min: 30 },
        { label: '氏名又は法人名', w: 30 },
        { label: '判定基準と\nなる株主等\nとの続柄', w: 15 },
        n('株式数又は\n出資の金額', '(19)'),
        n('議決権の数', '(20)'),
        n('株式数又は\n出資の金額', '(21)'),
        n('議決権の数', '(22)'),
      ],
      headGroups: [
        { label: '順位', from: 0, span: 2 },
        { label: '被支配会社でない\n法人株主等', from: 5, span: 2 },
        { label: 'その他の株主等', from: 7, span: 2 },
      ],
      rows,
    },
    { type: 'text', text: fc.entered ? '株主グループは、判定基準となる株主とその同族関係者（親族・支配する会社など）をまとめたものです。順位はグループの合計で付け、グループの最初の行に書いています。社員の数による判定（7〜9・15・16）は持分会社の欄で、このアプリでは使っていません。資本金1億円以下の法人は特定同族会社に当たりません（大法人の100%子会社などを除く）。' : '株主が入力されていません。「計算の条件」の株主（別表二）に、期末の株主と株式数を入力してください。' },
  ];
}

// ---- 別表六(一)：所得税額の控除に関する明細書 ----

/**
 * 別表六(一)：区分ごとの①収入金額 ②所得税額 ③控除を受ける所得税額（1〜6）、個別法（7〜12）、簡便法（13〜19、空欄）、その他の明細（20・21）
 * @param {object} w withholding-credit.js の withholdingCredit の結果
 * @param {number} withholding 明細が無いときの「法人税額から控除される所得税額」（入力した額）
 */
export function schedule61Blocks(w, withholding = 0) {
  // 区分の名前は様式どおりの長い文なので、列の幅（約90mm）で折り返す
  const kindRows = w.kinds.map((k) => ({ cells: [{ text: wrapText(k.label, 8, 90), subSmall: false }, noCell(k.no), blank(k.income), blank(k.tax), blank(k.credit)] }));
  // 明細が無く、控除する所得税額だけを入れているときは、計の③に出す（内訳は様式に書く）
  const total = w.entered ? w.total : { income: 0, tax: 0, credit: withholding };
  kindRows.push({ kind: 'total', cells: [{ text: '計', bold: true }, noCell(6), num(total.income), num(total.tax), num(total.credit)] });
  const pad = (rows, n, width) => {
    while (rows.length < n) rows.push({ cells: Array(width).fill('') });
    return rows;
  };
  const pr = w.prorated.map((x) => ({
    cells: [x.payer, blank(x.income), blank(x.tax), x.periodMonths ? `${x.periodMonths}月` : '', x.heldMonths ? `${x.heldMonths}月` : '', x.periodMonths ? formatHoldingRatio(x.ratio) : '', blank(x.credit)],
  }));
  const n = (label, no, w2 = 20) => ({ label: `${label}\n${no}`, align: 'right', w: w2 });
  const others = w.others.map((x) => ({ cells: [x.payer, x.address, waDate(x.date), blank(x.income), blank(x.tax), ''] }));
  const otherTotal = { income: w.others.reduce((s, x) => s + x.income, 0), tax: w.others.reduce((s, x) => s + x.tax, 0) };
  return [
    {
      type: 'table',
      columns: [{ label: '区　　分', grow: 1, min: 60 }, NO, AMT('収入金額\n①'), AMT('①について課される\n所得税額\n②'), AMT('②のうち控除を\n受ける所得税額\n③')],
      rows: kindRows,
    },
    { type: 'heading', text: '剰余金の配当、集団投資信託の収益の分配又は割引債の償還差益に係る控除を受ける所得税額の計算' },
    {
      type: 'table',
      font: 7.5,
      columns: [
        { label: '銘　柄', grow: 1, min: 30 },
        n('収入金額', '7'),
        n('所得税額', '8'),
        n('配当等の計算期間\n(9)', '9', 16),
        n('(9)のうち元本\n所有期間', '10', 16),
        n('所有期間割合\n(10)/(9)', '11', 16),
        n('控除を受ける\n所得税額\n(8)×(11)', '12'),
      ],
      headGroups: [{ label: '個別法による場合', from: 0, span: 7 }],
      rows: pad(pr, 4, 7),
    },
    {
      type: 'table',
      font: 7.5,
      columns: [{ label: '銘　柄', grow: 1, min: 30 }, n('収入金額', '13'), n('所得税額', '14'), n('期末の所有\n元本数等', '15', 16), n('期首の所有\n元本数等', '16', 16), n('(15)-(16)\n2又は12', '17', 16), n('所有元本割合\n(16)+(17)\n/(15)', '18', 16), n('控除を受ける\n所得税額\n(14)×(18)', '19')],
      headGroups: [{ label: '銘柄別簡便法による場合', from: 0, span: 8 }],
      rows: pad([], 2, 8),
    },
    { type: 'heading', text: 'その他に係る控除を受ける所得税額の明細' },
    {
      type: 'table',
      font: 7.5,
      columns: [{ label: '支払者の氏名\n又は法人名', w: 34 }, { label: '支払者の住所\n又は所在地', grow: 1, min: 30 }, { label: '支払を受けた\n年月日', w: 20, align: 'center' }, n('収入金額', '20', 22), n('控除を受ける\n所得税額', '21', 22), { label: '参　考', w: 18 }],
      rows: [...pad(others, 4, 6), { kind: 'total', cells: [{ text: '計', bold: true }, '', '', num(otherTotal.income), num(otherTotal.tax), ''] }],
    },
    {
      type: 'text',
      text: w.entered
        ? '②・③は復興特別所得税を含みます。2〜4は元本を所有していた期間に応じて控除し（個別法。所有期間割合は小数点以下3位未満を切上げ）、計算期間を入れていない行は全額を控除しています。銘柄別簡便法は使っていません。③の計（6）は別表一の「控除税額」の計算と、別表四の「法人税額から控除される所得税額」に使います。'
        : '明細が入力されていません。「計算の条件」の「所得税額の控除（別表六(一)）」に、預金の利子・配当などの支払者・収入金額・源泉徴収された所得税額を入力してください。',
    },
  ];
}

// ---- 適用額明細書 ----

/**
 * 適用額明細書：租税特別措置法の条項・区分番号・適用額（様式は1枚20行）
 * @param {Array} rows application-statement.js の applicationRows の結果
 */
export function applicationBlocks(rows) {
  const body = rows.map((x) => ({ cells: [x.article, { text: x.code, align: 'center' }, fmt(x.amount), x.name] }));
  while (body.length < 20) body.push({ cells: ['', '', '', ''] });
  return [
    {
      type: 'table',
      columns: [{ label: '租税特別措置法の条項', w: 62 }, { label: '区分番号', w: 18, align: 'center' }, AMT('適用額'), { label: '（参考）措置の名前', grow: 1, min: 30 }],
      rows: body,
    },
    {
      type: 'text',
      text: rows.length
        ? '中小企業者等の法人税率の特例（別表一次葉二「74」欄、千円未満切捨て）と少額減価償却資産の特例（別表十六(七)「8」欄、年300万円が上限）は帳簿から書いています。ほかの租税特別措置（賃上げ促進税制・特別償却など）は「計算の条件」で足してください。区分番号は国税庁「適用額明細書の記載の手引」の区分番号一覧表で確かめてください。「（参考）措置の名前」は様式に無い欄です。'
        : '法人税関係特別措置の適用がありません（所得金額が0以下のときは法人税率の特例を書きません）。適用を受けない場合、適用額明細書の提出は不要です。',
    },
  ];
}

// 地方法人税額（10.3%、100円未満切捨ての前）
const applyLocal = (L) => (L.base > 0 ? Math.floor((L.base * L.rate) / 100000) : 0);

// ---- 地方税の申告書：第六号様式（事業税・特別法人事業税・道府県民税）・第二十号様式（市町村民税） ----
// 欄の番号は、令和7年4月1日以後開始事業年度分の第六号様式（山梨県の様式の計算式「⑦−⑧＋⑨−⑩−⑪−⑫」など）と、
// 第二十号様式の記載の手引（名古屋市）から読み取ったもの。推定を含むので、出典の URL と一緒に docs/spec-phase3-tax-forms.md に分けて書く
// 事業税の欄は、番号を確かめられた所得割の区分（㉙〜㉛）のほかは番号を書かない

const pct = (rate) => (rate == null ? '' : `${Number((rate / 1000).toFixed(3))}`);

/**
 * 第六号様式・第二十号様式の行（画面と印刷で使う）
 * 行：{ group } か { no, label, base?, rate?, tax?, strong?, sub? }。base：課税標準の列（金額か「12月」などの文字）、tax：税額の列
 * @param {object} r corporateTaxReturn の結果
 * @returns {{ pref: object[], city: object[] | null }} city：東京23区で市町村民税が無ければ null
 */
export function localFormRows(r) {
  const res = r.resident;
  const ent = r.enterprise;
  const prefName = res.tokyo ? '都民税' : '道府県民税';
  const pref = [
    { group: '事業税（所得割）' },
    { label: '所得金額総額', base: ent.base, sub: ent.fromSchedule4 ? '別表四の所得金額（1,000円未満切捨て）' : '事業税の画面で入力した所得金額' },
    ...ent.rows.map((x, i) => ({ no: ent.reduced ? ['㉙', '㉚', '㉛'][i] : null, label: x.label, base: x.amount, rate: x.rate, tax: x.tax })),
    { label: '計', base: ent.rows.reduce((t, x) => t + x.amount, 0), tax: ent.incomeTax, sub: '100円未満切捨て' },
    { label: '合計事業税額', tax: ent.incomeTax, strong: true },
    { label: '既に納付の確定した当期分の事業税額', tax: ent.interimTax },
    { label: 'この申告により納付すべき事業税額', tax: ent.dueTax, strong: true },
    { group: '特別法人事業税' },
    { label: '所得割に係る特別法人事業税額', base: ent.standardTax, rate: 37000, tax: ent.special, sub: '課税標準は基準法人所得割額（標準税率で計算した所得割額）' },
    { label: '合計特別法人事業税額', tax: ent.special, strong: true },
    { label: '既に納付の確定した当期分の特別法人事業税額', tax: ent.interimSpecial },
    { label: 'この申告により納付すべき特別法人事業税額', tax: ent.dueSpecial, strong: true },
    ...residentRows(res, res.pref, { name: prefName, kind: 'pref' }),
  ];
  const city = res.tokyo && !res.city.total && !res.city.interim ? null : residentRows(res, res.city, { name: '市町村民税', kind: 'city' });
  return { pref, city };
}

/** 道府県民税（第六号様式の①〜㉓）・市町村民税（第二十号様式の①〜㉑）の行 */
function residentRows(res, x, { name, kind }) {
  const P = kind === 'pref';
  // 第二十号様式は⑤が「課税標準となる法人税額及びその法人税割額」の1行。第六号様式は⑤課税標準・⑦法人税割額に分かれる
  const n = (pref, city) => (P ? pref : city);
  const short = P ? '道府県民税' : '市町村民税';
  return [
    { group: `${name}（法人税割）` },
    { no: '①', label: '法人税法の規定によって計算した法人税額', base: res.taxAmount, sub: '別表一の法人税額計（土地譲渡・留保金の税額を除く）' },
    { no: '②', label: '試験研究費の額等に係る法人税額の特別控除額', base: res.addBack },
    { no: '③', label: '還付法人税額等の控除額', base: null },
    { no: '④', label: '退職年金等積立金に係る法人税額', base: null },
    P
      ? { no: '⑤', label: '課税標準となる法人税額　①＋②−③＋④', base: res.base, sub: '1,000円未満切捨て' }
      : { no: '⑤', label: '課税標準となる法人税額及びその法人税割額', base: res.base, rate: x.rate, tax: x.taxPart, sub: '①＋②−③＋④（1,000円未満切捨て）' },
    { no: '⑥', label: `2以上の${P ? '道府県' : '市町村'}に事務所等を有する法人の課税標準となる法人税額`, base: null },
    ...(P ? [{ no: '⑦', label: '法人税割額', base: res.base, rate: x.rate, tax: x.taxPart }] : []),
    { no: n('⑧', '⑦'), label: `${short}の特定寄附金税額控除額`, tax: null },
    { no: n('⑨', '⑧'), label: '税額控除超過額相当額の加算額', tax: null },
    { no: n('⑩', '⑨'), label: '外国関係会社等に係る控除対象所得税額等相当額の控除額', tax: null },
    { no: n('⑪', '⑩'), label: '外国の法人税等の額の控除額', tax: null },
    { no: n('⑫', '⑪'), label: '仮装経理に基づく法人税割額の控除額', tax: null },
    { no: n('⑬', '⑫'), label: '差引法人税割額', tax: x.taxPart },
    { no: n('⑭', '⑬'), label: '既に納付の確定した当期分の法人税割額', tax: x.interimTaxPart },
    { no: n('⑮', '⑭'), label: '租税条約の実施に係る法人税割額の控除額', tax: null },
    { no: n('⑯', '⑮'), label: 'この申告により納付すべき法人税割額', tax: x.dueTaxPart, strong: true },
    { group: `${name}（均等割）` },
    { no: n('⑰', '⑯'), label: '算定期間中において事務所等を有していた月数', base: `${res.months}月` },
    { no: n('⑱', '⑰'), label: '均等割額', base: `年${fmt(x.perCapita)}円×${res.months}/12`, tax: x.perCapitaPart },
    { no: n('⑲', '⑱'), label: '既に納付の確定した当期分の均等割額', tax: x.interimPerCapita },
    { no: n('⑳', '⑲'), label: 'この申告により納付すべき均等割額', tax: x.duePerCapita, strong: true },
    { group: '合計' },
    { no: n('㉑', '⑳'), label: `この申告により納付すべき${short}額`, tax: x.due, strong: true },
    { no: n('㉒', '㉑'), label: `${n('㉑', '⑳')}のうち見込納付額`, tax: null },
    { no: P ? '㉓' : null, label: '差引', tax: x.due, strong: true },
  ];
}

/** 第六号様式・第二十号様式の表（区分・番号・課税標準・税率・税額） */
export function localFormBlock(rows) {
  const amount = (v) => (v === null || v === undefined ? '' : typeof v === 'string' ? v : num(v));
  return {
    type: 'table',
    columns: [{ label: '区　　分', grow: 1, min: 70 }, { ...NO, w: 8 }, { label: '課 税 標 準', align: 'right', w: 34 }, { label: '税率（%）', align: 'right', w: 15 }, { label: '税　額', align: 'right', w: 27 }],
    font: 7.5,
    rowH: 4.15,
    rows: rows.map((x) =>
      x.group
        ? groupRow(x.group, 5)
        : { kind: x.strong ? 'subtotal' : undefined, cells: [{ text: x.label, bold: x.strong }, noCell(x.no), amount(x.base), x.rate == null ? '' : pct(x.rate), { text: amount(x.tax), bold: x.strong }] },
    ),
  };
}

const LOCAL_NOTE = '欄の番号は、令和7年4月1日以後開始事業年度分の様式と記載の手引から読み取ったものです（推定を含みます）。法人税割の税率・均等割の年額は事務所のある自治体の条例で確かめてください。2以上の自治体に事務所がある場合の分割、事業税の付加価値割・資本割（外形標準課税）には対応していません。';

// ---- 申告書一式 ----

export const CORPORATE_SHEETS = [
  { value: 's1', label: '別表一', title: '法人税・地方法人税・防衛特別法人税の申告書' },
  { value: 's2', label: '別表二', title: '同族会社等の判定に関する明細書' },
  { value: 's4', label: '別表四（簡易様式）', title: '所得の金額の計算に関する明細書（簡易様式）' },
  { value: 's51', label: '別表五(一)', title: '利益積立金額及び資本金等の額の計算に関する明細書' },
  { value: 's52', label: '別表五(二)', title: '租税公課の納付状況等に関する明細書' },
  { value: 's61', label: '別表六(一)', title: '所得税額の控除に関する明細書' },
  { value: 's7', label: '別表七(一)', title: '欠損金の損金算入等に関する明細書' },
  { value: 's15', label: '別表十五', title: '交際費等の損金算入に関する明細書' },
  { value: 'tekiyo', label: '適用額明細書', title: '適用額明細書' },
  { value: 'pref', label: '第六号様式', title: '事業税・特別法人事業税・道府県民税の確定申告書' },
  { value: 'city', label: '第二十号様式', title: '市町村民税の確定申告書' },
];

/**
 * 法人税の申告書（別表）の印刷：別表ごとに改ページし、ページの表題を別表の名前にする
 * @param {object} r corporateTaxReturn の結果
 * @param {{ head: object, sheets?: string[] }} p sheets：印刷する別表（CORPORATE_SHEETS の value）
 */
export function corporateTaxDoc(r, { head, filer = null, sheets = CORPORATE_SHEETS.map((s) => s.value), smeAssets = null }) {
  const blocks = [];
  const local = localFormRows(r);
  const p = { startDate: r.period.startDate, endDate: r.period.endDate, capital: r.capital.stock, capitalTotal: r.capital.total, employees: r.employees, months: r.resident.months, sme: r.input.sme };
  const build = {
    s1: () => [...(filer ? [corporateHead(filer, p)] : []), ...schedule1Blocks(r)],
    pref: () => [...(filer ? [localHead(filer, { ...p, kind: 'pref' })] : []), localFormBlock(local.pref), { type: 'text', text: LOCAL_NOTE }],
    city: () => [...(filer ? [localHead(filer, { ...p, kind: 'city' })] : []), localFormBlock(local.city), { type: 'text', text: LOCAL_NOTE }],
    s2: () => schedule2Blocks(r.family),
    s61: () => schedule61Blocks(r.schedule61, r.input.withholding),
    s4: () => schedule4Blocks(r.schedule4),
    s51: () => schedule51Blocks(r.schedule51, { defense: r.defense.applies }),
    s52: () => schedule52Blocks(r.schedule52, { startDate: r.period.startDate }),
    s7: () => schedule7Blocks(r),
    s15: () => schedule15Blocks(r.entertainment, { months: r.period.months, sme: r.input.sme }),
    tekiyo: () => [...(filer ? [applicationHead(filer, { capital: r.capital.stock, income: r.schedule4.income.total })] : []), ...applicationBlocks(applicationRows({ corp: r.corp, sme: r.input.sme, smeAssets, rows: r.input.applicationRows }))],
  };
  for (const s of CORPORATE_SHEETS) {
    if (!sheets.includes(s.value)) continue;
    if (s.value === 'city' && !local.city) continue;
    const title = s.value === 'pref' && r.resident.tokyo ? '事業税・特別法人事業税・都民税の確定申告書' : s.title;
    blocks.push({ type: 'heading', caption: true, text: s.label, title });
    blocks.push(...build[s.value]());
  }
  return { title: '法人税申告書', ...head, orientation: 'portrait', blocks, taxForm: { from: r.period.startDate, to: r.period.endDate, name: head.company } };
}

// ---- 消費税及び地方消費税の申告書 ----
// 欄の番号と名前は tax-forms.js（taxReturnForms）が国税庁の書き方に合わせて作ったもの。ここでは様式の列の組み方（付表の A・B・C）に並べる

/** 欄の名前に、短い計算式（⑦−②−③ など）を添える */
const withNote = (it) => (it.note && it.note.length <= 18 ? `${it.label}　(${it.note})` : it.label);

/** 第一表：左に消費税の税額の計算（①〜⑫）と課税売上割合など（⑮⑯）、右に地方消費税（⑰〜㉓）と合計（㉖） */
export function consumptionFirstBlocks(first) {
  const byNo = new Map(first.rows.map((x) => [x.no, x]));
  const item = (no) => {
    const x = byNo.get(no);
    return x ? { no, label: withNote(x), amount: x.value, strong: x.strong } : null;
  };
  const pick = (nos) => nos.map(item).filter(Boolean);
  const left = [{ head: 'この申告書による消費税の税額の計算' }, ...pick(['①', '②', '③', '④', '⑤', '⑥', '⑦', '⑧', '⑨', '⑩', '⑪', '⑫']), { head: '課税売上割合など' }, ...pick(['⑮', '⑯'])];
  const right = [{ head: 'この申告書による地方消費税の税額の計算' }, ...pick(['⑰', '⑱', '⑲', '⑳', '㉑', '㉒', '㉓']), { head: '消費税及び地方消費税の合計税額' }, ...pick(['㉖'])];
  const remarks = first.remarks?.length ? [{ type: 'heading', text: '付記事項・参考事項' }, formHeadBlock(first.remarks)] : [];
  return [...first.flags.map((t) => ({ type: 'text', text: t })), twoSide(left, right), ...remarks];
}

/** 第二表：課税標準額の内訳（左）と消費税額・返還等対価・地方消費税の課税標準（右） */
export function consumptionSecondBlocks(second) {
  const items = second.rows.map((x) => ({ no: x.no, label: withNote(x), amount: x.value, strong: x.strong }));
  const split = items.findIndex((x) => x.no === '⑪');
  return [twoSide([{ head: '課税標準額の内訳' }, ...items.slice(0, split)], [{ head: '消費税額・返還等対価に係る税額' }, ...items.slice(split)])];
}

/** 付表：税率6.24%適用分 A・税率7.8%適用分 B・合計 C の3列 */
export function consumptionSheetBlocks(sheet) {
  const rows = sheet.rows.map((x) => {
    const strong = Boolean(x.strong);
    const v = (n) => (n === null || n === undefined ? '' : num(n));
    return { kind: strong ? 'subtotal' : undefined, cells: [{ text: withNote(x), bold: strong }, noCell(x.no), v(x.a), v(x.b), x.text !== undefined ? { text: x.text, align: 'right' } : v(x.c)] };
  });
  return [{ type: 'table', columns: [{ label: '区　　分', grow: 1, min: 50 }, NO, AMT('税率6.24%適用分\nA'), AMT('税率7.8%適用分\nB'), AMT('合計 C\n(A＋B)')], rows }];
}

/** 付表の題（「付表2-3 課税売上割合…」）を番号と名前に分ける */
const splitSheetTitle = (t) => {
  const m = /^(\S+)\s+(.+)$/.exec(t);
  return m ? [m[1], m[2]] : [t, t];
};

/**
 * 消費税の申告書の選べる帳票
 * @param {ReturnType<import('./tax-forms.js').taxReturnForms>} forms
 */
export function consumptionSheets(forms) {
  return [
    { value: 'first', label: forms.first.title },
    { value: 'second', label: '第二表' },
    ...forms.sheets.map((s) => ({ value: s.id, label: s.id })),
  ];
}

/**
 * 消費税及び地方消費税の申告書（第一表・第二表・付表）の印刷：表ごとに改ページ
 * @param {ReturnType<import('./tax-forms.js').taxReturnForms>} forms
 * @param {{ head: object, sheets?: string[] }} p
 */
export function consumptionTaxDoc(forms, { head, filer = null, period = null, corporation = false, sheets = consumptionSheets(forms).map((s) => s.value) }) {
  const blocks = [];
  const top = filer && period ? [consumptionHead(filer, { startDate: period.startDate, endDate: period.endDate, corporation })] : [];
  if (sheets.includes('first')) blocks.push({ type: 'heading', caption: true, text: forms.first.title, title: '消費税及び地方消費税の申告書' }, ...top, ...consumptionFirstBlocks(forms.first));
  if (sheets.includes('second')) blocks.push({ type: 'heading', caption: true, text: '第二表', title: '課税標準額等の内訳書' }, ...consumptionSecondBlocks(forms.second));
  for (const s of forms.sheets) {
    if (!sheets.includes(s.id)) continue;
    const [caption, title] = splitSheetTitle(s.title);
    blocks.push({ type: 'heading', caption: true, text: caption, title }, ...consumptionSheetBlocks(s));
  }
  if (blocks.length) for (const n of forms.notes) blocks.push({ type: 'text', text: n });
  return { title: '消費税及び地方消費税の申告書', ...head, orientation: 'portrait', blocks, ...(period ? { taxForm: { kind: 'consumption', from: period.startDate, to: period.endDate, name: (corporation ? filer?.name : filer?.tradeName || filer?.name) || head.company } } : {}) };
}

// ---- 所得税及び復興特別所得税の確定申告書 ----
// 欄の番号は income-tax.js（computeIncomeTax の lines）と画面（views/income-tax.js）で使っている第一表の番号

const MARU = '⓪①②③④⑤⑥⑦⑧⑨⑩⑪⑫⑬⑭⑮⑯⑰⑱⑲⑳㉑㉒㉓㉔㉕㉖㉗㉘㉙㉚㉛㉜㉝㉞㉟㊱㊲㊳㊴㊵㊶㊷㊸㊹㊺㊻㊼㊽㊾㊿';
const maru = (n) => (typeof n === 'number' ? MARU[n] || `(${n})` : n);

/**
 * 第一表：左に収入金額等・所得金額等・所得から差し引かれる金額、右に税金の計算・その他（様式と同じ左右の並び）
 * @param {object} r computeIncomeTax の結果
 */
export function incomeFirstBlocks(r, { white = false, realEstate = false } = {}) {
  const L = r.lines;
  const it = (no, label, amount, strong = false) => ({ no: maru(no), label, amount, strong });
  const left = [
    { head: '収入金額等' },
    it('㋐', '事業　営業等', r.rev.a),
    ...(realEstate ? [it('㋒', '不動産', r.rev.c)] : []),
    it('㋔', '給与', r.rev.e),
    it('㋖', '雑　業務', r.rev.g),
    it('㋗', '雑　その他', r.rev.h),
    { head: '所得金額等' },
    it(1, '事業　営業等', L[1]),
    ...(realEstate ? [it(3, '不動産', L[3])] : []),
    it(6, '給与', L[6]),
    it(8, '雑　業務', L[8]),
    it(9, '雑　その他', L[9]),
    it(10, '雑の計　(⑧＋⑨)', L[10]),
    it(12, '合計', L[12], true),
    { head: '所得から差し引かれる金額' },
    it(13, '社会保険料控除', L[13]),
    it(14, '小規模企業共済等掛金控除', L[14]),
    it(15, '生命保険料控除', L[15]),
    it(16, '地震保険料控除', L[16]),
    it('⑰⑱', '寡婦、ひとり親控除', L[17]),
    it(19, '勤労学生控除', L[19]),
    it(20, '障害者控除', L[20]),
    it('㉑㉒', r.spouse?.kind === 'special' ? '配偶者特別控除' : '配偶者（特別）控除', L[21]),
    it(23, '扶養控除', L[23]),
    it(24, '特定親族特別控除', L[24]),
    it(25, '基礎控除', L[25]),
    it(26, '⑬から㉕までの計', L[26], true),
    it(28, '医療費控除', L[28]),
    it(29, '寄附金控除', L[29]),
    it(30, '合計　(㉖＋㉗＋㉘＋㉙)', L[30], true),
  ];
  const right = [
    { head: '税金の計算' },
    it(31, '課税される所得金額　(⑫－㉚)　1,000円未満切捨て', L[31]),
    it(32, '上の㉛に対する税額', L[32]),
    it(35, '住宅借入金等特別控除', L[35]),
    it(42, '差引所得税額', L[42]),
    it(44, '再差引所得税額（基準所得税額）', L[44]),
    it(45, '復興特別所得税額　(㊹×2.1%)', L[45]),
    it(46, '所得税及び復興特別所得税の額　(㊹＋㊺)', L[46], true),
    it(49, '源泉徴収税額', L[49]),
    it(50, '申告納税額　(㊻－㊼－㊽－㊾)', L[50], true),
    it(51, '予定納税額（第1期分・第2期分）', L[51]),
    it(52, '第3期分の税額　納める税金', L[52], true),
    it(53, '第3期分の税額　還付される税金', L[53], true),
    { head: 'そ　の　他' },
    { no: '', label: '配偶者の合計所得金額', amount: r.other.spouseIncome ?? 0 },
    { no: '', label: white ? '専従者控除額の合計額' : '専従者給与額の合計額', amount: r.other.familySalary },
    ...(white ? [] : [{ no: '', label: '青色申告特別控除額', amount: r.other.blueDeduction }]),
    { no: '', label: '雑所得・一時所得等の源泉徴収税額の合計額', amount: r.other.miscWithholding },
  ];
  return [twoSide(left, right), { type: 'text', text: '番号の無い欄（配当控除・政党等寄附金等特別控除・外国税額控除など）は対象外のため出していません。' }];
}

/** 第二表：所得の内訳・保険料控除等・配偶者や親族に関する事項 */
export function incomeSecondBlocks(r, input) {
  const blocks = [];
  if (input.salaryRevenue) {
    blocks.push({ type: 'heading', text: '所得の内訳（所得税及び復興特別所得税の源泉徴収税額）' });
    blocks.push({ type: 'table', columns: [{ label: '所得の種類', w: 24 }, { label: '種目・所得の生ずる場所又は給与などの支払者の氏名・名称', grow: 1 }, AMT('収入金額'), AMT('源泉徴収税額')], rows: [{ cells: ['給与', input.salaryPayer || '', num(input.salaryRevenue), num(input.salaryWithholding)] }] });
  }
  const life = input.life;
  blocks.push({ type: 'heading', text: '保険料控除等に関する事項' });
  blocks.push({
    type: 'table',
    columns: [{ label: '区　　分', grow: 1 }, NO, AMT('支払保険料等の計')],
    rows: [
      ['⑬', '社会保険料', input.socialInsurance],
      ['⑭', '小規模企業共済等掛金', input.smallBusinessAid],
      ['⑮', '新生命保険料', life.newGeneral],
      ['', '旧生命保険料', life.oldGeneral],
      ['', '新個人年金保険料', life.newPension],
      ['', '旧個人年金保険料', life.oldPension],
      ['', '介護医療保険料', life.newMedical],
      ['⑯', '地震保険料', input.earthquake.quake],
      ['', '旧長期損害保険料', input.earthquake.oldLongTerm],
    ].map(([no, label, n]) => ({ cells: [label, noCell(no), num(n)] })),
  });
  const people = [
    ...(r.spouse ? [[r.spouse.name, '配偶者', r.spouse.birthDate, r.spouse.familyWorker ? '事業専従者（控除の対象外）' : r.spouse.kind === 'special' ? '配偶者特別控除' : r.spouse.kind ? (r.spouse.elderly ? '老人控除対象配偶者' : '控除対象配偶者') : '対象外']] : []),
    ...r.dependents.map((d) => [d.name, d.relation || '親族', d.birthDate, DEPENDENT_KIND_LABELS[d.kind] ?? '']),
  ];
  if (people.length) {
    blocks.push({ type: 'heading', text: '配偶者や親族に関する事項' });
    blocks.push({ type: 'table', columns: [{ label: '氏　　名', grow: 1 }, { label: '続柄', w: 22 }, { label: '生年月日', w: 26, align: 'center' }, { label: '控除の区分', grow: 1 }], rows: people.map(([a, b, c, d]) => ({ cells: [a, b, (c || '').replaceAll('-', '/'), d] })) });
  }
  return blocks;
}

/** 確定申告書 第四表（損失申告用）：経常所得と繰越損失の計算 */
export function incomeLossBlocks(r, { white = false, year }) {
  const lo = r.loss;
  const reiwa = (y) => `令和${y - 2018}年分`;
  const rows = [{ cells: ['経常所得（①〜⑥・⑩の合計）', noCell('A'), num(lo.ordinary)] }];
  if (lo.netLoss) rows.push({ cells: ['本年分の純損失の金額', noCell(''), num(lo.netLoss)] }, { kind: 'subtotal', cells: [white ? '翌年以後に繰り越す損失額' : '翌年以後に繰り越す損失額（青色申告者の損失の金額）', noCell(''), num(lo.carryForward)] });
  const carry = lo.carry.filter((c) => c.available > 0);
  const carryRows = carry.flatMap((c) => [
    { kind: 'group', cells: [{ text: `${reiwa(c.year)}の純損失`, span: 3 }] },
    { cells: ['前年分までに引ききれなかった損失額', noCell('Ⓐ'), num(c.available)] },
    { cells: ['本年分で差し引く損失額', noCell('Ⓑ'), num(c.used)] },
    { cells: ['翌年分以後に繰り越して差し引かれる損失額　(Ⓐ－Ⓑ)', noCell('Ⓒ'), num(c.remaining)] },
  ]);
  const cols = [{ label: '区　　分', grow: 1 }, NO, AMT('金　額')];
  return [
    { type: 'heading', text: '1 損失額又は所得金額・2 損益の通算・3 翌年以後に繰り越す損失額' },
    { type: 'table', columns: cols, rows },
    ...(carryRows.length ? [{ type: 'heading', text: '4 繰越損失を差し引く計算' }, { type: 'table', columns: cols, rows: carryRows }] : []),
    { type: 'heading', text: '所得金額' },
    { type: 'table', columns: cols, rows: [{ cells: ['合計所得金額（繰越控除の前）', noCell(''), num(r.totalIncome)] }, { kind: 'total', cells: ['雑損控除、医療費控除及び寄附金控除の計算で使用する所得金額の合計額', noCell('M'), num(r.lines[12])] }] },
    { type: 'text', text: `来年（${reiwa(year + 1)}）に繰り越す損失：3年前の分 ${fmt(lo.next.y3)}円・2年前の分 ${fmt(lo.next.y2)}円・前年の分 ${fmt(lo.next.y1)}円。経常所得だけの計算で、譲渡・山林・退職・分離課税の所得は対象外です。` },
  ];
}

/** 医療費控除の明細書 */
export function medicalBlocks(r, input, kindLabel = (id) => id) {
  return [
    { type: 'table', columns: [{ label: '医療を受けた方の氏名', grow: 1 }, { label: '病院・薬局などの支払先の名称', grow: 1 }, { label: '医療費の区分', w: 34 }, AMT('支払った医療費の額'), AMT('左のうち、補填される金額')], rows: [...input.medical.map((m) => ({ cells: [m.name, m.payee, kindLabel(m.kind), num(m.paid), blank(m.reimbursed)] })), { kind: 'total', cells: ['合計', '', '', num(r.medical.paid), num(r.medical.reimbursed)] }] },
    { type: 'heading', text: '控除額の計算' },
    {
      type: 'table',
      columns: [{ label: '区　　分', grow: 1 }, NO, AMT('金　額')],
      rows: [
        { cells: ['支払った医療費', noCell('A'), num(r.medical.paid)] },
        { cells: ['保険金などで補填される金額', noCell('B'), num(r.medical.reimbursed)] },
        { cells: ['差引金額　(A－B)', noCell('C'), num(r.medical.net)] },
        { cells: ['所得金額の合計額', noCell('D'), num(r.lines[12])] },
        { cells: ['D×0.05 と 10万円のいずれか少ない金額', noCell('E'), num(r.medical.threshold)] },
        { kind: 'total', cells: ['医療費控除額　(C－E)　最高200万円', noCell('F'), num(r.lines[28])] },
      ],
    },
  ];
}

/** 所得税の確定申告書で選べる帳票 */
export function incomeSheets(r, input) {
  return [
    { value: 'first', label: '第一表' },
    { value: 'second', label: '第二表' },
    ...(r.loss.needed ? [{ value: 'loss', label: '第四表（損失申告用）' }] : []),
    ...(input.medical.length ? [{ value: 'medical', label: '医療費控除の明細書' }] : []),
  ];
}

/**
 * 所得税及び復興特別所得税の確定申告書（第一表・第二表・第四表・医療費控除の明細書）の印刷
 * @param {object} r computeIncomeTax の結果
 * @param {{ head, input, year, white?, realEstate?, kindLabel?, sheets?: string[] }} p
 */
export function incomeTaxDoc(r, { head, filer = null, input, year, white = false, realEstate = false, kindLabel, sheets = incomeSheets(r, input).map((s) => s.value) }) {
  const reiwa = `令和${year - 2018}年分`;
  const blocks = [];
  const add = (key, caption, title, list) => sheets.includes(key) && blocks.push({ type: 'heading', caption: true, text: caption, title }, ...list());
  add('first', `第一表（${reiwa}）`, '所得税及び復興特別所得税の申告書', () => [...(filer ? [incomeHead(filer, { year, white })] : []), ...incomeFirstBlocks(r, { white, realEstate })]);
  add('second', `第二表（${reiwa}）`, '所得税及び復興特別所得税の申告書', () => incomeSecondBlocks(r, input));
  if (r.loss.needed) add('loss', `第四表（${reiwa}）`, '所得税及び復興特別所得税の申告書（損失申告用）', () => incomeLossBlocks(r, { white, year }));
  if (input.medical.length) add('medical', `医療費控除の明細書（${reiwa}）`, '医療費控除の明細書', () => medicalBlocks(r, input, kindLabel));
  return { title: '所得税及び復興特別所得税の申告書', ...head, orientation: 'portrait', blocks, taxForm: { kind: 'individual', yearText: reiwa, name: filer?.ownerName || head.company } };
}
