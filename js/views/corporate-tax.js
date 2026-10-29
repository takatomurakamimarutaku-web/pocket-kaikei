// 法人税の申告：納める税額の一覧と、別表四・別表一・別表五(一)・別表五(二)・別表七(一)・別表十五・住民税と事業税
// 弥生会計・freee の法人税申告ソフト（別表四から順に作り、別表五(一)で検算する流れ）を参考にした。転記用の写しを作る
import { h, put, amountCell, saveFile, segmented } from '../ui.js';
import { corporateTaxReturn, corporateTaxCsvRows, filingDeadline, RATES } from '../corporate-tax.js';
import { formatPercent } from '../enterprise-tax.js';
import { formatPeriod } from '../period.js';
import { formatYen } from '../money.js';
import { toCsv, csvFileName } from '../csv.js';
import { docHead } from '../print-forms.js';
import { corporateTaxDoc, CORPORATE_SHEETS } from '../print-tax-forms.js';

const TABS = [
  { value: 'summary', label: '概要' },
  { value: 's4', label: '別表四' },
  { value: 's1', label: '別表一' },
  { value: 's51', label: '別表五(一)' },
  { value: 's52', label: '別表五(二)' },
  { value: 's7', label: '別表七(一)' },
  { value: 's15', label: '別表十五' },
  { value: 'local', label: '住民税・事業税' },
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
  let tab = TABS.some((t) => t.value === query.tab) ? query.tab : 'summary';
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

  // ---- 住民税・事業税 ----
  const res = r.resident;
  const part = (label, x) => [
    h('tr', { class: 'ct-heading' }, h('th', { scope: 'rowgroup', colspan: 3, text: label })),
    line('法人税割額', x.taxPart, { rateText: rate(x.rate), indent: true }),
    line('均等割額', x.perCapitaPart, { rateText: '', indent: true, sub: `年${formatYen(x.perCapita)}円×${res.months}/12` }),
    line('計', x.total, { rateText: '', indent: true }),
    line('中間納付額', x.interim, { rateText: '', indent: true }),
    line(x.due >= 0 ? '差引納付税額' : '還付税額', Math.abs(x.due), { rateText: '', strong: true }),
  ];
  const ent = r.enterprise;
  sections.local = [
    h('h3', { class: 'tf-title', text: '法人住民税（法人税割・均等割）' }),
    wrap('法人住民税', 'ct-s1', ['項目', '税率', '金額'], [
      line('課税標準となる法人税額', res.base, { rateText: '', sub: '差引法人税額＋足し戻す控除額（1,000円未満切捨て）' }),
      ...part(res.tokyo ? '都民税' : '道府県民税', res.pref),
      ...(res.tokyo && !res.city.total && !res.city.interim ? [] : part('市町村民税', res.city)),
    ]),
    h('p', { class: 'muted small', text: '税率と均等割の年額は自治体ごとに違います（標準税率は法人税割 道府県民税1.0%・市町村民税6.0%、均等割は資本金等の額1,000万円以下・従業者50人以下で道府県民税2万円・市町村民税5万円）。複数の自治体に事務所がある場合の分割には対応していません。' }),
    h('h3', { class: 'tf-title', text: '事業税・特別法人事業税' }),
    wrap('事業税', 'ct-s1', ['項目', '税率', '金額'], [
      line('所得金額（課税標準）', ent.base, { rateText: '', sub: ent.fromSchedule4 ? '別表四の所得金額（1,000円未満切捨て）' : '事業税の画面で入力した所得金額' }),
      line('所得割', ent.incomeTax, { rateText: '' }),
      line('特別法人事業税', ent.special, { rateText: '37%' }),
      line('中間納付額', ent.interimTax + ent.interimSpecial, { rateText: '' }),
      line('差引納付税額', ent.total, { rateText: '', strong: true }),
    ]),
    h('div', { class: 'report-tools no-print' }, h('a', { class: 'btn', href: '#/reports/enterprise-tax', text: '事業税（第六号様式）を見る' })),
  ];

  // ---- 印刷：国税庁の様式の欄の番号と並びに合わせた別表（print-tax-forms.js）。概要・住民税と事業税の画面は全部の別表を既定にする ----
  app.printDoc = ({ printedAt }) => ({
    options: [
      { key: 'sheet', label: '印刷する別表', type: 'select', choices: [['all', '別表一〜十五（全部）'], ...CORPORATE_SHEETS.map((x) => [x.value, x.label])], value: CORPORATE_SHEETS.some((x) => x.value === tab) ? tab : 'all' },
    ],
    build: (v) => corporateTaxDoc(r, { head: docHead({ settings, period, printedAt }), sheets: v.sheet === 'all' ? CORPORATE_SHEETS.map((x) => x.value) : [v.sheet] }),
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
    h('div', { class: 'no-print ct-tools' }, segmented({ name: '別表', options: TABS, value: tab, onChange: show })),
    ...sectionEls,
    h('div', { class: 'report-tools no-print' }, h('a', { class: 'btn btn-primary', href: '#/reports/corporate-tax/input', text: '計算の条件を入力する' }), h('button', { type: 'button', class: 'btn', text: 'CSVで書き出す', onclick: csv }), h('a', { class: 'btn', href: '#/reports/schedule16', text: '別表十六（減価償却）' })),
    h(
      'div',
      { class: 'panel small muted' },
      h('p', { text: '資本金1億円以下の普通法人（青色申告）の、法人税申告書の主な別表の写しです。国税庁の様式（別表一・四・五(一)・五(二)・七(一)・十五）の行の名前に合わせて並べています。e-Tax や申告ソフト、国税庁の様式に書き写すときに使ってください。' }),
      h('p', { text: '対応していないもの：グループ通算制度、外国税額控除、受取配当等の益金不算入・寄附金の損金算入限度額などの計算（別表四の加算・減算に金額を入力）、仮払経理、申告期限の延長、複数の自治体への分割、特定同族会社の留保金課税、使途秘匿金・土地譲渡利益の税額。' }),
    ),
  );
}
