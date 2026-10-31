// 法人税の申告：納める税額の一覧と、別表四・別表一・別表五(一)・別表五(二)・別表七(一)・別表十五・住民税と事業税
// 弥生会計・freee の法人税申告ソフト（別表四から順に作り、別表五(一)で検算する流れ）を参考にした。転記用の写しを作る
import { h, put, amountCell, saveFile, segmented, stackTable } from '../ui.js';
import { corporateTaxReturn, corporateTaxCsvRows, filingDeadline, RATES } from '../corporate-tax.js';
import { formatPercent } from '../enterprise-tax.js';
import { formatPeriod } from '../period.js';
import { formatYen } from '../money.js';
import { toCsv, csvFileName } from '../csv.js';
import { docHead } from '../print-forms.js';
import { corporateTaxDoc, CORPORATE_SHEETS, localFormRows } from '../print-tax-forms.js';
import { filerOf, hasFiler } from '../filer.js';
import { formatRatio } from '../family-company.js';
import { formatHoldingRatio } from '../withholding-credit.js';
import { applicationRows } from '../application-statement.js';
import { smeUsage } from '../depreciation.js';
import { businessOverview, thousand } from '../business-overview.js';

const TABS = [
  { value: 'summary', label: '概要' },
  { value: 's4', label: '別表四' },
  { value: 's1', label: '別表一' },
  { value: 's2', label: '別表二' },
  { value: 's51', label: '別表五(一)' },
  { value: 's52', label: '別表五(二)' },
  { value: 's61', label: '別表六(一)' },
  { value: 's7', label: '別表七(一)' },
  { value: 's15', label: '別表十五' },
  { value: 'tekiyo', label: '適用額明細書' },
  { value: 'gaikyo', label: '事業概況説明書' },
  { value: 'pref', label: '県民税・事業税' },
  { value: 'city', label: '市民税' },
];

const jpDate = (iso) => `${Number(iso.slice(0, 4))}年${Number(iso.slice(5, 7))}月${Number(iso.slice(8, 10))}日`;
const rate = (r) => `${formatPercent(r)}%`;
const cell = (n, { blank = false } = {}) => amountCell('td', n, { blankZero: blank });

function wrap(label, cls, head, rows) {
  return h('div', { class: 'table-wrap' }, h('table', { class: `report ct-table ${cls}`, 'aria-label': label }, h('thead', {}, h('tr', {}, head.map((t) => h('th', { scope: 'col', text: t })))), h('tbody', {}, rows)));
}

/** 行見出し（補足を下に小さく） */
function rowHead(label, sub) {
  return h('th', { scope: 'row' }, label, sub ? h('span', { class: 'muted small block', text: sub }) : null);
}

/** 項目・金額の2列の行 */
function line(label, amount, { sub = '', strong = false, indent = false, rateText = null } = {}) {
  return h('tr', { class: `${strong ? 'mt-strong' : ''} ${indent ? 'tf-sub' : ''}`.trim() }, rowHead(label, sub), rateText === null ? null : h('td', { class: 'num', text: rateText }), cell(amount));
}

export async function render({ app, outlet, query }) {
  const { settings, period, accounts, journals } = await app.load();
  if (settings.entityType !== 'corporation') return put(outlet, h('p', { class: 'notice', text: '法人税の申告は法人で使います。個人は「所得税の確定申告書」を使ってください。' }), h('a', { class: 'btn', href: '#/reports', text: '帳票へ' }));
  const r = corporateTaxReturn({ accounts, period, journals, input: period.corporateTax || {}, enterpriseInput: period.enterpriseTax || {} });
  // 適用額明細書の少額減価償却資産の特例（その期間に使い始めた資産の取得価額の合計）
  const [assets, periods] = await Promise.all([app.db.listAssets(), app.db.listPeriods()]);
  const smeAssets = smeUsage(assets, period);
  // 法人事業概況説明書の主要科目・月別の売上高等（交際費は別表十五の支出交際費等の額）
  const overview = businessOverview({ accounts, period, journals, assets, periods, entertainment: r.entertainment.amount });
  const tekiyo = applicationRows({ corp: r.corp, sme: r.input.sme, smeAssets, rows: r.input.applicationRows });
  // 以前の「住民税・事業税」のタブ（tab=local）は県民税・事業税のタブで開く
  const asked = query.tab === 'local' ? 'pref' : query.tab;
  let tab = TABS.some((t) => t.value === asked) ? asked : 'summary';
  const sections = {};

  // ---- 概要 ----
  const dueRows = r.dues.map((d) => h('tr', {}, rowHead(d.label), cell(d.annual), cell(d.interim, { blank: true }), cell(d.due)));
  sections.summary = [
    h(
      'div',
      { class: 'kpi-grid' },
      h('div', { class: 'kpi' }, h('span', { class: 'kpi-label', text: r.dueTotal >= 0 ? '納める税額の合計' : '還付される税額の合計' }), h('span', { class: 'kpi-value num', text: `${formatYen(Math.abs(r.dueTotal))}円` }), h('span', { class: 'kpi-sub', text: `期限 ${jpDate(filingDeadline(period.endDate))}` })),
      h('div', { class: 'kpi' }, h('span', { class: 'kpi-label', text: r.schedule4.income.total >= 0 ? '所得金額' : '欠損金額' }), h('span', { class: 'kpi-value num', text: `${formatYen(r.schedule4.income.total)}円` }), h('span', { class: 'kpi-sub', text: `当期純利益 ${formatYen(r.netIncome)}円` })),
    ),
    h('h3', { class: 'tf-title', text: '納める税額' }),
    wrap('納める税額', 'ct-dues', ['税目', '年税額', '中間納付額', '差引納付額'], [...dueRows, h('tr', { class: 'mt-strong' }, rowHead('合計'), cell(r.dues.reduce((s, d) => s + d.annual, 0)), cell(r.dues.reduce((s, d) => s + d.interim, 0), { blank: true }), cell(r.dueTotal))]),
    h('p', { class: 'muted small', text: '差引納付額のマイナス（△）は還付される税額です。法人税・地方法人税・防衛特別法人税は税務署、住民税は都道府県と市町村、事業税・特別法人事業税は都道府県に、事業年度終了の日の翌日から2か月以内に申告して納めます。' }),
    h('h3', { class: 'tf-title', text: '未払法人税等' }),
    wrap('未払法人税等', 'ct-s1', ['項目', '金額'], [line('帳簿の期末残高', r.provision.closing), line('申告で納める税額（計上する額の目安）', r.payableTarget, { sub: '還付になる税は含めない' })]),
    r.provision.closing !== r.payableTarget
      ? h('p', { class: 'small notice', text: `決算整理で「法人税、住民税及び事業税／未払法人税等」を${formatYen(r.payableTarget - r.provision.closing)}円計上すると、未払法人税等が申告で納める税額と一致します（所得金額は変わりません）。` })
      : h('p', { class: 'small muted', text: '未払法人税等は申告で納める税額と一致しています。' }),
  ];

  // ---- 別表四 ----
  const s4 = r.schedule4;
  const s4row = (label, x, { strong = false, sub = '', outflowNote = '', indent = false } = {}) =>
    h('tr', { class: `${strong ? 'mt-strong' : ''} ${indent ? 'tf-sub' : ''}`.trim() }, rowHead(label, sub), cell(x.total), cell(x.retained, { blank: !strong }), h('td', { class: `num ${x.outflow < 0 ? 'neg' : ''}` }, outflowNote ? h('span', { class: 'ct-note', text: outflowNote }) : null, x.outflow || strong ? formatYen(x.outflow) : ''));
  const itemRow = (a) => s4row(a.label, { total: a.amount, retained: a.kind === 'retained' ? a.amount : 0, outflow: a.kind === 'outflow' ? a.amount : 0 }, { indent: true, sub: a.note || '', outflowNote: a.kind === 'outflow' && a.amount ? 'その他' : '' });
  const heading = (t) => h('tr', { class: 'ct-heading' }, h('th', { scope: 'rowgroup', colspan: 4, text: t }));
  sections.s4 = [
    h('h3', { class: 'tf-title', text: '別表四 所得の金額の計算に関する明細書（簡易様式）' }),
    wrap('別表四', 'ct-s4', ['区分', '総額①', '留保②', '社外流出③'], [
      s4row('当期利益又は当期欠損の額', s4.profit, { strong: true, outflowNote: s4.profit.outflow ? '配当' : '' }),
      heading('加算'),
      ...s4.adds.map(itemRow),
      s4row('小計', s4.addTotal, { strong: true }),
      heading('減算'),
      ...s4.subs.map(itemRow),
      s4row('小計', s4.subTotal, { strong: true }),
      s4row('仮計', s4.provisional, { strong: true }),
      s4row('法人税額から控除される所得税額', { total: s4.withholding, retained: 0, outflow: s4.withholding }, { outflowNote: s4.withholding ? 'その他' : '' }),
      s4row('合計', s4.total, { strong: true }),
      s4row('欠損金又は災害損失金等の当期控除額', { total: -s4.lossDeducted, retained: 0, outflow: -s4.lossDeducted }, { outflowNote: s4.lossDeducted ? '※' : '' }),
      s4row('所得金額又は欠損金額', s4.income, { strong: true }),
    ]),
    h('p', { class: 'muted small', text: `損金経理をした納税充当金＝当期に未払法人税等へ繰り入れた額（${formatYen(r.provision.added)}円）。中間納付の税は「法人税、住民税及び事業税」で処理した（損金経理）として計算しています。社外流出の「※」は、留保にも社外流出にも入らない減算です。` }),
  ];

  // ---- 別表一 ----
  const c = r.corp;
  const oneTable = (label, rows) => wrap(label, 'ct-s1', ['項目', '税率', '金額'], rows);
  sections.s1 = [
    h('h3', { class: 'tf-title', text: '別表一 法人税額の計算' }),
    oneTable('法人税額の計算', [
      line('所得金額又は欠損金額', c.income, { rateText: '', strong: true }),
      ...c.tiers.flatMap((t) => [line(t.label, t.amount, { rateText: '', indent: true, sub: t.label.startsWith('年800万円相当額以下') && c.limit !== 8000000 ? `800万円×月数/12＝${formatYen(c.limit)}円` : '1,000円未満切捨て' }), line(`${t.label}の税額`, t.tax, { rateText: rate(t.rate), indent: true })]),
      line('法人税額', c.tax, { rateText: '' }),
      line('法人税額の特別控除額', c.credits, { rateText: '' }),
      line('差引法人税額', c.afterCredits, { rateText: '' }),
      line('控除税額（所得税額）', c.withholdingUsed, { rateText: '' }),
      line('差引所得に対する法人税額', c.annual, { rateText: '', strong: true, sub: '100円未満切捨て' }),
      line('中間申告分の法人税額', c.interim, { rateText: '' }),
      line(c.due >= 0 ? '差引確定法人税額' : '中間申告分の還付税額', Math.abs(c.due), { rateText: '', strong: true }),
      c.refundWithholding ? line('所得税額等の還付金額', c.refundWithholding, { rateText: '', sub: '法人税額から控除しきれなかった所得税額' }) : null,
    ]),
    h('h3', { class: 'tf-title', text: '地方法人税額の計算' }),
    oneTable('地方法人税額の計算', [
      line('所得の金額に対する法人税額（基準法人税額）', r.local.standard, { rateText: '', sub: '差引法人税額（所得税額を控除する前）' }),
      line('課税標準法人税額', r.local.base, { rateText: '', sub: '1,000円未満切捨て' }),
      line('地方法人税額', r.local.annual, { rateText: rate(r.local.rate), strong: true, sub: '100円未満切捨て' }),
      line('中間申告分の地方法人税額', r.local.interim, { rateText: '' }),
      line(r.local.due >= 0 ? '差引確定地方法人税額' : '中間申告分の還付税額', Math.abs(r.local.due), { rateText: '', strong: true }),
    ]),
    r.defense.applies
      ? [
          h('h3', { class: 'tf-title', text: '防衛特別法人税額の計算' }),
          oneTable('防衛特別法人税額の計算', [
            line('所得の金額に対する法人税額（基準法人税額）', r.defense.standard, { rateText: '' }),
            line('基礎控除額', r.defense.deduction, { rateText: '', sub: r.period.months < 12 ? `500万円×${r.period.months}/12` : '年500万円' }),
            line('課税標準法人税額', r.defense.base, { rateText: '', sub: '1,000円未満切捨て' }),
            line('防衛特別法人税額', r.defense.annual, { rateText: rate(r.defense.rate), strong: true, sub: '100円未満切捨て' }),
            line('中間申告分の防衛特別法人税額', r.defense.interim, { rateText: '' }),
            line(r.defense.due >= 0 ? '差引確定防衛特別法人税額' : '中間申告分の還付税額', Math.abs(r.defense.due), { rateText: '', strong: true }),
          ]),
          h('p', { class: 'muted small', text: '令和8年4月1日以後に開始する事業年度から課税されます。税額が0円でも申告が必要です（国税庁）。中間申告は令和9年4月1日以後に開始する事業年度からです。' }),
        ]
      : null,
    h('p', { class: 'muted small', text: `税率：中小法人の年800万円以下の部分は15%（令和9年3月31日までに開始する事業年度。所得が年10億円を超える事業年度は17%、適用除外事業者・それより後に開始する事業年度は19%）、それを超える部分と中小法人以外は${rate(RATES.standard)}。` }),
  ];

  // ---- 別表五(一) ----
  const s51 = r.schedule51;
  const fourCols = (label, x, { strong = false } = {}) => h('tr', { class: strong ? 'mt-strong' : '' }, rowHead(label), cell(x.opening, { blank: !strong }), cell(x.decrease, { blank: !strong }), cell(x.increase, { blank: !strong }), cell(x.closing, { blank: !strong }));
  const chk = s51.check;
  sections.s51 = [
    h('h3', { class: 'tf-title', text: '別表五(一) Ⅰ 利益積立金額の計算に関する明細書' }),
    wrap('利益積立金額', 'ct-s5', ['区分', '期首現在①', '減②', '増③', '差引翌期首現在④'], [...s51.rows.map((x) => fourCols(x.label, x)), fourCols('差引合計額', s51.total, { strong: true })]),
    h(
      'div',
      { class: `panel small ct-check ${chk.ok ? 'ok' : 'ng'}` },
      h('p', { class: 'strong', text: chk.ok ? '検算 ✓ 合っています' : `検算 ✗ ${formatYen(chk.diff)}円 合いません` }),
      h('p', { class: 'ct-formula', text: `期首 ${formatYen(chk.opening)} ＋ 別表四の留保所得 ${formatYen(chk.retained)} − 中間分・確定分の法人税等 ${formatYen(chk.taxes)} ＝ ${formatYen(chk.expected)}（差引翌期首現在 ${formatYen(chk.closing)}）` }),
    ),
    h('h3', { class: 'tf-title', text: '別表五(一) Ⅱ 資本金等の額の計算に関する明細書' }),
    wrap('資本金等の額', 'ct-s5', ['区分', '期首現在①', '減②', '増③', '差引翌期首現在④'], [...s51.capitalRows.map((x) => fourCols(x.label, x)), fourCols('差引合計額', s51.capitalTotal, { strong: true })]),
    h('p', { class: 'muted small', text: '繰越損益金の減②には期首、増③には期末の残高を書きます。未納法人税等の増③は中間分と確定分の合計（マイナス）です。期首の調整項目（減価償却の償却超過額など）は計算の条件で入力します。' }),
  ];

  // ---- 別表五(二) ----
  const s52 = r.schedule52;
  const taxCols = (label, x, { strong = false, indent = false } = {}) =>
    h('tr', { class: `${strong ? 'mt-strong' : ''} ${indent ? 'tf-sub' : ''}`.trim() }, rowHead(label), cell(x.opening, { blank: true }), cell(x.accrued, { blank: true }), cell(x.provisionPaid, { blank: true }), cell(x.expensePaid, { blank: true }), cell(x.closing, { blank: !strong }));
  const p = s52.provision;
  sections.s52 = [
    h('h3', { class: 'tf-title', text: '別表五(二) 租税公課の納付状況等に関する明細書' }),
    wrap('租税公課の納付状況', 'ct-s52', ['税目・事業年度', '期首現在未納税額', '当期発生税額', '充当金取崩しによる納付', '損金経理による納付', '期末現在未納税額'], s52.blocks.flatMap((b) => [h('tr', { class: 'ct-heading' }, h('th', { scope: 'rowgroup', colspan: 6, text: b.label })), ...b.rows.map((x) => taxCols(x.label, x, { indent: true })), taxCols('計', b.total, { strong: true })])),
    h('h3', { class: 'tf-title', text: '納税充当金の計算' }),
    wrap('納税充当金の計算', 'ct-s1', ['項目', '金額'], [
      line('期首納税充当金', p.opening),
      line('繰入額 損金経理をした納税充当金', p.added),
      line('取崩額 法人税額等', p.usedTaxes, { indent: true }),
      line('取崩額 事業税及び特別法人事業税', p.usedEnterprise, { indent: true }),
      line('取崩額 その他', p.usedOther, { indent: true, sub: p.usedOther ? '前期分の確定税額の入力と、未払法人税等を取り崩した額の差' : '' }),
      line('取崩額 計', p.used),
      line('期末納税充当金', p.closing, { strong: true }),
    ]),
    h('p', { class: 'muted small', text: '前期分は納税充当金（未払法人税等）を取り崩して納め、中間分は損金経理で納めた前提です。仮払経理（仮払税金）には対応していません。期末までに法人税等の科目に振り替えてください。' }),
  ];

  // ---- 別表七(一) ----
  const loss = r.loss;
  // ---- 別表二：同族会社等の判定 ----
  const fc = r.family;
  const ff = fc.fields;
  const textRow = (label, value, { strong = false, sub = '' } = {}) => h('tr', { class: strong ? 'mt-strong' : '' }, rowHead(label, sub), h('td', { class: 'num', text: value }));
  const count = (n) => (n == null ? '' : n.toLocaleString('ja-JP'));
  sections.s2 = [
    h('div', { class: 'kpi-grid' }, h('div', { class: 'kpi' }, h('span', { class: 'kpi-label', text: '判定結果' }), h('span', { class: 'kpi-value', text: ff[18] }), h('span', { class: 'kpi-sub', text: `上位3グループ ${formatRatio(ff[10]) || '－'}・上位1グループ ${formatRatio(ff[17]) || '－'}` }))),
    !fc.entered ? h('p', { class: 'notice small', text: '株主がまだ入力されていません。「計算の条件を入力する」の株主（別表二）に、期末の株主と株式数を入れてください。' }) : null,
    h('h3', { class: 'tf-title', text: '同族会社の判定' }),
    wrap('同族会社の判定', 'ct-s1', ['項目', '値'], [
      textRow('(1) 期末現在の発行済株式の総数又は出資の総額', count(ff[1])),
      textRow('(2) 上位3順位の株式数又は出資の金額', count(ff[2])),
      textRow('(3) 株式数等による判定', formatRatio(ff[3]), { sub: '(2)／(1)' }),
      textRow('(4) 期末現在の議決権の総数', count(ff[4])),
      textRow('(5) 上位3順位の議決権の数', count(ff[5])),
      textRow('(6) 議決権の数による判定', formatRatio(ff[6]), { sub: '(5)／(4)' }),
      textRow('(10) 同族会社の判定割合', formatRatio(ff[10]), { strong: true, sub: '50%を超えると同族会社' }),
      textRow('(11) 上位1順位の株式数又は出資の金額', count(ff[11])),
      textRow('(12) 株式数等による判定', formatRatio(ff[12]), { sub: '(11)／(1)' }),
      textRow('(13) 上位1順位の議決権の数', count(ff[13])),
      textRow('(14) 議決権の数による判定', formatRatio(ff[14]), { sub: '(13)／(4)' }),
      textRow('(17) 特定同族会社の判定割合', formatRatio(ff[17]), { strong: true, sub: '資本金1億円以下の法人は特定同族会社に当たりません' }),
      textRow('(18) 判定結果', ff[18], { strong: true }),
    ]),
    h('h3', { class: 'tf-title', text: '判定基準となる株主等の株式数等の明細' }),
    fc.rows.length
      ? wrap('株主の明細', 'ct-s1', ['順位', '株主', '株式数等', '議決権'], fc.rows.map((x) => h('tr', {}, h('td', { class: 'num', text: x.sharesRank ?? '' }), rowHead(x.name, [x.relation, x.address].filter(Boolean).join('・')), h('td', { class: 'num', text: count(x.shares) }), h('td', { class: 'num', text: count(x.votes ?? x.shares) }))))
      : h('p', { class: 'muted small', text: '株主の入力がありません。' }),
  ];

  // ---- 別表六(一)：所得税額の控除 ----
  const w61 = r.schedule61;
  sections.s61 = [
    h('dl', { class: 'pay-summary' }, h('div', {}, h('dt', { text: '源泉徴収された所得税額（②の計）' }), h('dd', { class: 'num', text: formatYen(w61.entered ? w61.total.tax : r.input.withholding) })), h('div', {}, h('dt', { text: '控除を受ける所得税額（③の計）' }), h('dd', { class: 'num', text: formatYen(r.input.withholding) })), h('div', {}, h('dt', { text: 'うち法人税額から控除' }), h('dd', { class: 'num', text: formatYen(r.corp.withholdingUsed) })), h('div', {}, h('dt', { text: 'うち還付' }), h('dd', { class: 'num', text: formatYen(r.corp.refundWithholding) }))),
    !w61.entered ? h('p', { class: 'notice small', text: '明細がまだ入力されていません。「計算の条件を入力する」の「所得税額の控除（別表六(一)）」に、預金の利子・配当などの明細を入れると、区分ごとに集計します。' }) : null,
    wrap('区分ごとの所得税額', 'ct-s1', ['区分', '収入金額', '所得税額', '控除を受ける額'], [
      ...w61.kinds.map((k) => h('tr', {}, rowHead(`(${k.no}) ${k.short}`, k.prorate ? '元本の所有期間で按分' : ''), cell(k.income, { blank: true }), cell(k.tax, { blank: true }), cell(k.credit, { blank: true }))),
      h('tr', { class: 'mt-strong' }, rowHead('(6) 計'), cell(w61.total.income), cell(w61.total.tax), cell(w61.entered ? w61.total.credit : r.input.withholding)),
    ]),
    w61.entered
      ? wrap('明細', 'ct-s1', ['支払者（銘柄）', '収入金額', '所得税額', '控除を受ける額'], w61.lines.map((x) => h('tr', {}, rowHead(x.payer, [`(${x.kind})`, x.periodMonths ? `所有期間 ${x.heldMonths}/${x.periodMonths}月＝${formatHoldingRatio(x.ratio)}` : ''].filter(Boolean).join('・')), cell(x.income), cell(x.tax), cell(x.credit))))
      : null,
  ];

  // ---- 法人事業概況説明書 ----
  const ov = overview.items;
  const kText = (n) => (thousand(n) ? `${n < 0 ? '△' : ''}${Math.abs(thousand(n)).toLocaleString('ja-JP')}` : '');
  const kRow = (label, n, sub = '') => h('tr', {}, rowHead(label, sub), h('td', { class: 'num', text: kText(n) }));
  sections.gaikyo = [
    h('p', { class: 'small muted', text: '申告書に添付する書類です。帳簿から書ける「10 主要科目」「18 月別の売上高等」などを千円単位（千円未満切捨て）で集計しています。そのほかの欄は印刷して手で書いてください。' }),
    h('h3', { class: 'tf-title', text: '10 主要科目（単位：千円）' }),
    wrap('主要科目', 'ct-s1', ['科目', '千円'], [
      kRow('売上（収入）高', ov.sales),
      kRow('売上（収入）原価', ov.cogs),
      kRow('売上（収入）総利益', ov.gross),
      kRow('役員報酬', ov.officerCompensation, '販・管費のうち'),
      kRow('従業員給料', ov.salaries, '販・管費のうち'),
      kRow('交際費', ov.entertainment, '交際費等の支出額'),
      kRow('減価償却費', ov.depreciation, '販・管費のうち'),
      kRow('地代家賃', ov.rent, '販・管費のうち'),
      kRow('営業損益', ov.operating),
      kRow('税引前当期損益', ov.pretax),
      kRow('資産の部合計', ov.totalAssets),
      kRow('負債の部合計', ov.totalLiabilities),
      kRow('純資産の部合計', ov.netAssets),
    ]),
    h('h3', { class: 'tf-title', text: '18 月別の売上高等（単位：千円）' }),
    wrap('月別', 'ct-s1', ['月', '売上', '仕入', '人件費'], [
      ...overview.months.map((m) => h('tr', {}, rowHead(`${Number(m.month.slice(5, 7))}月`), ...['sales', 'purchases', 'payroll'].map((key) => h('td', { class: 'num', text: kText(m[key]) })))),
      h('tr', { class: 'mt-strong' }, rowHead('計'), ...['sales', 'purchases', 'payroll'].map((key) => h('td', { class: 'num', text: kText(overview.monthTotal[key]) }))),
    ]),
  ];

  // ---- 適用額明細書 ----
  sections.tekiyo = [
    h('p', { class: 'small muted', text: '租税特別措置（法人税率の特例・少額減価償却資産の特例など）の適用を受けるときに、申告書に添付する明細書です。添付しないと特例を受けられません。' }),
    tekiyo.length
      ? wrap('適用額明細書', 'ct-s1', ['条項・区分番号', '適用額'], tekiyo.map((x) => h('tr', {}, rowHead(x.article, [x.code, x.name, x.auto ? '帳簿から' : '入力'].filter(Boolean).join('・')), cell(x.amount))))
      : h('p', { class: 'notice small', text: '適用を受ける租税特別措置がありません（所得金額が0以下のときは法人税率の特例を書きません）。適用がなければ提出は不要です。' }),
    h('p', { class: 'small muted', text: '賃上げ促進税制・特別償却など、ほかの措置は「計算の条件を入力する」の「適用額明細書に足す措置」に、条項・区分番号・適用額を入れてください。区分番号は国税庁「適用額明細書の記載の手引」の一覧で確かめられます。' }),
  ];

  sections.s7 = [
    h('h3', { class: 'tf-title', text: '別表七(一) 欠損金の損金算入等に関する明細書' }),
    h('dl', { class: 'pay-summary' }, h('div', {}, h('dt', { text: '控除前所得金額' }), h('dd', { class: 'num', text: formatYen(Math.max(0, s4.total.total)) })), h('div', {}, h('dt', { text: '損金算入限度額' }), h('dd', { class: 'num', text: formatYen(loss.limit) })), h('div', {}, h('dt', { text: '当期控除額' }), h('dd', { class: 'num', text: formatYen(loss.deducted) }))),
    loss.rows.length
      ? wrap('欠損金', 'ct-s7', ['事業年度', '控除未済欠損金額', '当期控除額', '翌期繰越額'], [
          ...loss.rows.map((x) =>
            h('tr', { class: x.current ? 'tf-sub' : '' }, rowHead(`${jpDate(x.start)}〜${jpDate(x.endDate)}`, x.current ? '当期の欠損金（青色申告）' : x.expired ? `繰越期間（${x.years}年）が過ぎたため控除できません` : x.future ? '当期より後の事業年度です' : `青色欠損（${x.years}年）`), cell(x.opening, { blank: true }), cell(x.deducted, { blank: true }), cell(x.carry)),
          ),
          h('tr', { class: 'mt-strong' }, rowHead('計'), cell(loss.rows.reduce((s, x) => s + x.opening, 0)), cell(loss.deducted), cell(loss.carry)),
        ])
      : h('p', { class: 'small muted', text: '繰り越した欠損金はありません。前期以前の欠損金は計算の条件で入力します。' }),
    h('p', { class: 'muted small', text: `中小法人等は所得金額の100%、それ以外は50%まで控除できます。平成30年4月1日以後に開始した事業年度の欠損金は10年、それより前は9年繰り越せます（事業年度は12か月とみなして判定）。` }),
  ];

  // ---- 別表十五 ----
  const e = r.entertainment;
  sections.s15 = [
    h('h3', { class: 'tf-title', text: '別表十五 交際費等の損金算入に関する明細書' }),
    wrap('交際費等', 'ct-s1', ['項目', '金額'], [
      line('支出交際費等の額', e.amount, { sub: e.auto ? '「接待交際費」の科目の当期の額' : '入力した額' }),
      line('うち接待飲食費の額', e.dining, { indent: true }),
      line('支出接待飲食費損金算入基準額', e.diningBase, { sub: '接待飲食費の額×50%' }),
      line('中小法人等の定額控除限度額', e.fixedLimit, { sub: r.input.sme ? `交際費等の額と 800万円×${r.period.months}/12 の少ないほう` : '中小法人以外は0' }),
      line('損金算入限度額', e.limit, { sub: '基準額と定額控除限度額の多いほう' }),
      line('損金不算入額', e.disallowed, { strong: true, sub: '別表四の「交際費等の損金不算入額」へ' }),
    ]),
    h('p', { class: 'muted small', text: '1人あたり1万円以下の飲食費（社内の役員・従業員だけの飲食を除く）は、書類を保存すれば交際費等に含めません（国税庁 No.5265）。会議費など他の科目に交際費等があるときは、支出交際費等の額を入力で直してください。' }),
  ];

  // ---- 県民税・事業税（第六号様式）・市民税（第二十号様式）：様式の欄の番号と並びで、課税標準・税率・税額の列 ----
  const local = localFormRows(r);
  // スマホでは区分を1行目、課税標準・税率・税額を2行目に並べる（stackTable）
  const localTable = (label, rows) =>
    h(
      'div',
      { class: 'table-wrap' },
      stackTable(
        h(
          'table',
          { class: 'report ct-local', 'aria-label': label },
          h('thead', {}, h('tr', {}, ['区分', '課税標準', '税率', '税額'].map((t) => h('th', { scope: 'col', text: t })))),
          h(
            'tbody',
            {},
            rows.map((x) =>
              x.group
                ? h('tr', { class: 'tb-group ct-heading' }, h('th', { scope: 'rowgroup', colspan: 4, text: x.group }))
                : h(
                    'tr',
                    { class: x.strong ? 'mt-strong tb-subtotal' : '' },
                    rowHead(`${x.no ? `${x.no} ` : ''}${x.label}`, x.sub),
                    typeof x.base === 'string' ? h('td', { class: 'num', text: x.base }) : x.base == null ? h('td', {}) : cell(x.base),
                    h('td', { class: 'num', text: x.rate == null ? '' : rate(x.rate) }),
                    x.tax == null ? h('td', {}) : cell(x.tax),
                  ),
            ),
          ),
        ),
      ),
    );
  const localNote = h('p', { class: 'muted small', text: '税率と均等割の年額は自治体ごとに違います（標準税率は法人税割 道府県民税1.0%・市町村民税6.0%）。均等割は「計算の条件」で資本金等の額と従業者数から標準税率で入れられます。欄の番号は様式の目安です（推定を含みます）。2以上の自治体に事務所がある場合の分割、外形標準課税には対応していません。' });
  sections.pref = [
    h('h3', { class: 'tf-title', text: `第六号様式　事業税・特別法人事業税・${r.resident.tokyo ? '都民税' : '道府県民税'}の確定申告書` }),
    localTable('第六号様式', local.pref),
    localNote,
    h('div', { class: 'report-tools no-print' }, h('a', { class: 'btn', href: '#/reports/enterprise-tax', text: '事業税の税率・中間納付額を変える' })),
  ];
  sections.city = local.city
    ? [h('h3', { class: 'tf-title', text: '第二十号様式　市町村民税の確定申告書' }), localTable('第二十号様式', local.city), localNote]
    : [h('p', { class: 'notice small', text: '東京都の特別区（23区）では、市町村民税の分も都民税として第六号様式で申告します。' })];

  // ---- 印刷：国税庁の様式の欄の番号と並びに合わせた別表（print-tax-forms.js）。概要・住民税と事業税の画面は全部の別表を既定にする ----
  app.printDoc = ({ printedAt }) => ({
    options: [
      { key: 'sheet', label: '印刷する別表', type: 'select', choices: [['all', '別表一〜十五（全部）'], ...CORPORATE_SHEETS.map((x) => [x.value, x.label])], value: CORPORATE_SHEETS.some((x) => x.value === tab) ? tab : 'all' },
    ],
    build: (v) => corporateTaxDoc(r, { head: docHead({ settings, period, printedAt }), filer: filerOf(settings), smeAssets, overview, sheets: v.sheet === 'all' ? CORPORATE_SHEETS.map((x) => x.value) : [v.sheet] }),
  });

  // ---- 画面 ----
  const csv = () => saveFile(new Blob([toCsv(corporateTaxCsvRows(r))], { type: 'text/csv' }), csvFileName('corporate-tax'));
  const sectionEls = TABS.map((t) => h('section', { class: 'ct-section', 'data-tab': t.value, hidden: t.value !== tab }, sections[t.value]));
  const show = (v) => {
    tab = v;
    history.replaceState(history.state, '', `#/reports/corporate-tax${v === 'summary' ? '' : `?tab=${v}`}`);
    for (const el of sectionEls) el.hidden = el.dataset.tab !== v;
  };
  put(
    outlet,
    h('p', { class: 'muted small', text: `${settings.businessName}　${formatPeriod(period)}（${r.period.months}か月）` }),
    r.warnings.length ? h('div', { class: 'notice small ws-warn' }, h('p', { class: 'ws-warn-title', text: '確かめること' }), h('ul', {}, r.warnings.map((w) => h('li', { text: w })))) : null,
    !period.corporateTax ? h('p', { class: 'notice small', text: '計算の条件がまだ保存されていません。中小法人・前期分の税額・中間納付額などを入力すると正確になります。' }) : null,
    !hasFiler(settings) ? h('p', { class: 'notice small no-print' }, '申告書の上の欄（納税地・法人番号・代表者・提出先）がまだ空欄です。', h('a', { href: '#/settings/filer?back=%23%2Freports%2Fcorporate-tax', text: '提出者の欄を入力する' })) : null,
    h('div', { class: 'no-print ct-tools' }, segmented({ name: '別表', options: TABS, value: tab, onChange: show })),
    ...sectionEls,
    h('div', { class: 'report-tools no-print' }, h('a', { class: 'btn btn-primary', href: '#/reports/corporate-tax/input', text: '計算の条件を入力する' }), h('button', { type: 'button', class: 'btn', text: 'CSVで書き出す', onclick: csv }), h('a', { class: 'btn', href: '#/reports/schedule16', text: '別表十六（減価償却）' }), h('a', { class: 'btn', href: '#/settings/filer?back=%23%2Freports%2Fcorporate-tax', text: '提出者の欄' })),
    h(
      'div',
      { class: 'panel small muted' },
      h('p', { text: '資本金1億円以下の普通法人（青色申告）の、法人税申告書の主な別表と、都道府県・市町村に出す申告書（第六号様式・第二十号様式）の写しです。様式の行の名前と欄の番号に合わせて並べています。e-Tax・eLTAX や申告ソフト、様式に書き写すときに使ってください。' }),
      h('p', { text: '対応していないもの：グループ通算制度、外国税額控除、受取配当等の益金不算入・寄附金の損金算入限度額などの計算（別表四の加算・減算に金額を入力）、仮払経理、申告期限の延長、複数の自治体への分割、特定同族会社の留保金課税、使途秘匿金・土地譲渡利益の税額。' }),
    ),
  );
}
