// 決算書（法人）：貸借対照表・損益計算書・販売費及び一般管理費内訳書・製造原価報告書・株主資本等変動計算書・個別注記表
// 弥生会計・勘定奉行の「決算書」の構成を参考に、印刷して1冊にできる並びにする
import { h, put, amountCell, field, showToast, errorBox } from '../ui.js';
import { buildStatements, closingRows, manufacturingReport } from '../statements.js';
import { sgaBreakdown, condensedIncomeItems, equityStatement, companyNotes, notesLead, DEFAULT_NOTES, CARRY_NOTE_KEYS, NOTE_COMPANY_TYPES, NOTE_STANDARDS } from '../financial.js';
import { openingDiff } from '../ledger.js';
import { formatYen, unitCaption, normalizeUnit } from '../money.js';
import { ValidationError } from '../db.js';
import { errorText } from '../errors.js';
import { openingWarning, unitPicker, unitPrintOptions, formatPicker, formatPrintOption, loadPrevious } from './report-common.js';
import { fsPaper, fsPeriod, incomeStatementByFormat, balanceSheetByFormat, breakdownTable } from './fs-view.js';
import { financialStatementsDoc, FINANCIAL_PARTS, docHead } from '../print-forms.js';

export async function render({ app, outlet }) {
  const { settings, period, accounts, journals } = await app.load();
  if (settings.entityType !== 'corporation') return put(outlet, h('p', { class: 'notice' }, '法人の決算書の画面です。個人は ', h('a', { href: '#/reports/blue-return', class: 'link', text: '青色申告決算書' }), ' を使ってください。'));
  const assets = await app.db.listAssets();
  // 注記をまだ保存していない期間は、前期の注記からパターン・会計方針・株式の数を引き継ぐ（保存するまでは仮の内容）
  const previous = period.statementNotes ? null : await loadPrevious(app, period);
  const carried = previous?.period.statementNotes ? Object.fromEntries(CARRY_NOTE_KEYS.map((k) => [k, previous.period.statementNotes[k]]).filter(([, v]) => v !== undefined)) : null;
  const notes = { ...DEFAULT_NOTES, ...(carried || {}), ...(period.statementNotes || {}) };
  const { pl, bs } = buildStatements({ entityType: 'corporation', accounts, period, journals });
  const mfg = manufacturingReport(closingRows({ accounts, period, journals }));
  const equity = equityStatement({ accounts, period, journals, netIncome: pl.netIncome });
  const sga = sgaBreakdown(pl);
  const notesBody = h('div');
  const errorsEl = h('div');

  // 貸借対照表の貸借の一致（画面だけ）。純資産の部は株主資本 › 資本金・資本剰余金・利益剰余金（その他利益剰余金）の区分（fs-rows.js）
  const bsCheck = () => h('p', { class: `check-line no-print ${bs.balanced ? 'ok' : 'ng'}`, text: bs.balanced ? `資産合計 ${formatYen(bs.totalAssets)}円 ＝ 負債・純資産合計` : `資産合計と負債・純資産合計が一致しません（差額 ${formatYen(bs.totalAssets - bs.totalLiabilitiesAndEquity)}円）` });

  // 株主資本等変動計算書：科目を縦に並べ、当期首残高・当期変動額（当期純利益・その他）・当期末残高（印刷と同じ並び）
  function equityTable() {
    const cell = (n, { blank = false, rule = null } = {}) => (blank && !n ? h('td', { class: 'num' }) : amountCell('td', n, { cls: rule ? `fs-${rule}` : '' }));
    const row = (label, v, { cls = 'fs-r-line', lv = 1, rule = null } = {}) => h('tr', { class: cls }, h('th', { scope: 'row', class: `lv${lv}`, text: label }), cell(v.opening, { rule }), cell(v.netIncome, { blank: true, rule: v.netIncome ? rule : null }), cell(v.other, { blank: true, rule: v.other ? rule : null }), cell(v.closing, { rule }));
    const heading = (label, lv, cls = 'fs-r-heading') => h('tr', { class: cls }, h('th', { scope: 'row', colspan: 5, class: `lv${lv}`, text: label }));
    const rows = [heading('株主資本', 0)];
    for (const s of equity.sections) {
      const grouped = s.id !== 'capital' && s.id !== 'other';
      if (grouped) rows.push(heading(s.label, 1, 'fs-r-heading2'));
      for (const r of s.rows) {
        // 繰越利益剰余金は「その他利益剰余金」の下に書く（貸借対照表の純資産の部と同じ区分。会社計算規則 第76条）
        if (r.account.role === 'retained_earnings') rows.push(heading('その他利益剰余金', 2, 'fs-r-heading3'), row(r.account.name, r, { lv: 3 }));
        else rows.push(row(r.account.name, r, { lv: grouped ? 2 : 1 }));
      }
      if (grouped && s.rows.length > 1) rows.push(row(`${s.label}合計`, s.total, { cls: 'fs-r-total', lv: 2, rule: 'over' }));
    }
    rows.push(row('株主資本合計', equity.total, { cls: 'fs-r-total', lv: 1, rule: 'over' }), row('純資産合計', equity.total, { cls: 'fs-r-net', lv: 0, rule: 'double' }));
    const head = [
      h('tr', {}, h('th', { scope: 'col', rowspan: 2, text: '科　目' }), h('th', { scope: 'col', rowspan: 2, text: '当期首残高' }), h('th', { scope: 'colgroup', colspan: 2, text: '当期変動額' }), h('th', { scope: 'col', rowspan: 2, text: '当期末残高' })),
      h('tr', {}, h('th', { scope: 'col', text: '当期純利益' }), h('th', { scope: 'col', text: 'その他の変動' })),
    ];
    return h(
      'div',
      { class: 'table-wrap fs-wrap' },
      h('table', { class: 'fs-table fs-equity-table', 'aria-label': '株主資本等変動計算書' }, h('colgroup', {}, h('col', { class: 'fs-c-label' }), ...[0, 1, 2, 3].map(() => h('col', { class: 'fs-c-amt' }))), h('thead', {}, head), h('tbody', {}, rows)),
    );
  }

  // 一株当たり情報（公開会社）の計算に使う純資産合計と当期純利益
  const netAssets = bs.liabilities.find((it) => it.type === 'group' && it.groups?.includes('equity'))?.total ?? 0;
  const notesFor = () => companyNotes({ accounts, period, journals, assets, notes, netAssets, netIncome: pl.netIncome });

  function paintNotes() {
    const sections = notesFor();
    const lead = notesLead(notes);
    put(
      notesBody,
      notes.sharesIssued === null ? h('p', { class: 'notice no-print', text: '株主資本等変動計算書に関する注記（期末の発行済株式の数）は、この会社でも必要な注記です。下の「注記の内容を編集する」で入力してください。' }) : null,
      lead ? h('p', { class: 'fs-note-lead', text: lead }) : null,
      sections.map((s, i) =>
        h(
          'section',
          { class: 'fs-note' },
          h('h4', { text: `${i + 1}．${s.title}` }),
          s.items.length
            ? h('ol', { class: 'fs-note-list' }, s.items.map((it) => h('li', {}, it.heading ? h('span', { class: 'fs-note-head', text: it.heading }) : null, ...it.text.split('\n').map((t) => h('span', { class: 'block', text: t })))))
            : h('p', { text: '該当事項はありません。' }),
        ),
      ),
    );
    publicEls.forEach((el) => (el.hidden = notes.companyType !== 'public'));
  }

  // 個別注記表のパターン：会社の区分（公開会社は貸借対照表等・損益計算書・税効果会計・関連当事者との取引・一株当たり情報などの項目も表示）・
  // 従った会計のルール（冒頭の文）・該当の無い項目の書き方
  const choice = (key, choices, label) =>
    field(label, h('select', { id: `fs-${key}`, onchange: (e) => ((notes[key] = e.target.value), paintNotes()) }, choices.map(([v, t]) => h('option', { value: v, text: t, selected: v === notes[key] }))));
  const noneCheck = h('input', { type: 'checkbox', checked: notes.showNone, onchange: (e) => ((notes.showNone = e.target.checked), paintNotes()) });
  const patternBar = h(
    'div',
    { class: 'panel no-print fs-note-pattern' },
    h('h3', { class: 'section-title', text: '注記表のパターン' }),
    choice('companyType', NOTE_COMPANY_TYPES, '会社の区分（会計監査人を置かない会社）'),
    choice('standard', NOTE_STANDARDS, '冒頭に書く会計のルール'),
    h('label', { class: 'check small' }, noneCheck, '表示する項目で該当が無いものも「該当事項はありません。」と書く'),
    h('p', { class: 'muted small', text: '公開会社は、非公開会社の項目に加えて 貸借対照表等・損益計算書・税効果会計・リース・金融商品・賃貸等不動産・関連当事者との取引・一株当たり情報・重要な後発事象 の注記を表示します（会社計算規則 第98条）。会計のルールを選ぶと「この計算書類は、…によって作成しています。」を冒頭に書きます。パターンは「注記を保存する」で保存し、次の期間に引き継ぎます。' }),
  );

  // 個別注記表の入力
  const textarea = (key, rows = 2, placeholder = '') => h('textarea', { id: `fs-${key}`, rows, placeholder, value: notes[key], oninput: (e) => ((notes[key] = e.target.value), paintNotes()) });
  const intInput = (key) =>
    h('input', {
      id: `fs-${key}`,
      type: 'text',
      inputmode: 'numeric',
      value: notes[key] === null ? '' : String(notes[key]),
      placeholder: '未入力',
      oninput: (e) => {
        const v = e.target.value.trim().replace(/,/g, '');
        notes[key] = v === '' ? null : /^\d+$/.test(v) ? Number(v) : NaN;
        paintNotes();
      },
    });
  const accumCheck = h('input', { type: 'checkbox', checked: notes.showAccumulatedDepreciation, onchange: (e) => ((notes.showAccumulatedDepreciation = e.target.checked), paintNotes()) });
  // 公開会社だけが表示する項目の入力欄（会社の区分で出し分ける）
  const publicEls = [];
  const pub = (el) => (publicEls.push(el), el);
  const group = (title) => h('h4', { class: 'fs-editor-group', text: title });
  const editor = h(
    'details',
    { class: 'panel no-print fs-editor' },
    h('summary', { text: '注記の内容を編集する' }),
    group('重要な会計方針'),
    field('有価証券の評価基準及び評価方法', textarea('securities', 2, '例：その他有価証券　市場価格のないもの　移動平均法による原価法'), { hint: '有価証券を持っているときに書きます' }),
    field('棚卸資産の評価基準及び評価方法', textarea('inventoryMethod', 2), { hint: '棚卸資産の残高があるときだけ表示します' }),
    field('固定資産の減価償却の方法', textarea('depreciation', 3, '空欄なら固定資産台帳から作ります'), { hint: '空欄のときは、固定資産台帳の償却方法から文を作ります' }),
    field('引当金の計上基準', textarea('allowance', 2, '空欄なら貸倒引当金の残高があるときに定型文'), {}),
    field('収益及び費用の計上基準', textarea('revenue', 2, '例：商品の販売は、商品を引き渡した時点で収益を計上しています。'), {}),
    group('変更と訂正'),
    field('会計方針の変更', textarea('policyChanges', 2, '無ければ空欄')),
    field('表示方法の変更', textarea('presentationChanges', 2, '無ければ空欄')),
    field('誤謬の訂正', textarea('errorCorrections', 2, '無ければ空欄')),
    group('貸借対照表・損益計算書'),
    h('label', { class: 'check small' }, accumCheck, '有形固定資産の減価償却累計額を注記する（非公開会社は任意）'),
    pub(field('貸借対照表等に関する注記', textarea('balanceSheetNotes', 3, '例：担保に供している資産　建物 5,000,000円（長期借入金 3,000,000円の担保）'), { hint: '担保に供している資産・保証債務・関係会社に対する金銭債権債務など' })),
    pub(field('損益計算書に関する注記', textarea('incomeStatementNotes', 2, '例：関係会社との取引高　売上高 1,200,000円'))),
    group('株主資本等変動計算書'),
    h('div', { class: 'field-row' }, field('発行済株式の数（株）', intInput('sharesIssued')), field('自己株式の数（株）', intInput('treasuryShares'))),
    field('剰余金の配当に関する事項', textarea('dividends', 3, '例：令和8年6月25日の定時株主総会で、普通株式の配当金総額100,000円（1株当たり100円）')),
    pub(group('公開会社の注記')),
    pub(field('税効果会計に関する注記', textarea('taxEffect', 2, '無ければ空欄'), { hint: '繰延税金資産・負債の発生の主な原因など' })),
    pub(field('リースにより使用する固定資産に関する注記', textarea('lease', 2, '無ければ空欄'))),
    pub(field('金融商品に関する注記', textarea('financialInstruments', 2, '無ければ空欄'))),
    pub(field('賃貸等不動産に関する注記', textarea('rentalProperty', 2, '無ければ空欄'))),
    pub(field('関連当事者との取引に関する注記', textarea('relatedParty', 3, '例：役員　山田太郎　資金の借入　期末残高 2,000,000円'), {})),
    pub(field('一株当たり情報に関する注記', textarea('perShare', 2, '空欄なら株式の数から計算します'), { hint: '空欄のときは、期末の発行済株式の数（自己株式を除く）で純資産合計と当期純利益を割ります。期中に株式の数が変わったときは文を入力してください' })),
    pub(field('重要な後発事象に関する注記', textarea('subsequentEvents', 2, '無ければ空欄'))),
    group('その他'),
    field('収益認識に関する注記', textarea('revenueRecognition', 2, '無ければ空欄'), { hint: '「収益認識に関する会計基準」で収益を計上している会社が書きます' }),
    field('その他の注記', textarea('other', 3, '無ければ空欄')),
    errorsEl,
    h('button', { type: 'button', class: 'btn btn-block', text: '注記を保存する', onclick: save }),
  );

  async function save() {
    try {
      await app.db.saveStatementNotes(period.id, notes);
      put(errorsEl);
      showToast('注記を保存しました');
    } catch (e) {
      put(errorsEl, errorBox(e instanceof ValidationError ? (Array.isArray(e.errors) ? e.errors : Object.values(e.errors)) : [errorText(e, '保存')]));
    }
  }

  // 金額の表は単位を切り替えるたびに組み直す（個別注記表は入力中の内容を残すため組み直さない）
  const unit = unitPicker({ key: '/reports/financial', onChange: () => paintAmounts() });
  const at = fsPeriod.at(period.endDate);
  const range = fsPeriod.range(period);
  // 貸借対照表・損益計算書・製造原価報告書は、帳票ごとに様式（勘定式・報告式）を選べる。印刷の様式は画面で選んだものを最初に選んでおく
  const formats = {
    bs: formatPicker({ key: '/reports/financial/bs', value: 'account', onChange: () => paintAmounts() }),
    pl: formatPicker({ key: '/reports/financial/pl', value: 'report', onChange: () => paintAmounts() }),
    mfg: formatPicker({ key: '/reports/financial/mfg', value: 'report', onChange: () => paintAmounts() }),
  };
  const parts = [
    ['bs', '貸借対照表', at, () => balanceSheetByFormat(bs, { format: formats.bs.value(), entityType: 'corporation' })],
    ['pl', '損益計算書', range, () => incomeStatementByFormat(condensedIncomeItems(pl), { format: formats.pl.value(), entityType: 'corporation' })],
    ['sga', '販売費及び一般管理費内訳書', range, () => breakdownTable(sga.lines, sga.total, { label: '販売費及び一般管理費内訳書' })],
    mfg.used ? ['mfg', '製造原価報告書', range, () => incomeStatementByFormat(mfg.items, { format: formats.mfg.value(), entityType: 'corporation', label: '製造原価報告書' })] : null,
    ['equity', '株主資本等変動計算書', range, () => [equityTable(), h('p', { class: 'muted small no-print', text: '「その他の変動」は、期中の仕訳による純資産の科目の増減です（剰余金の配当・利益準備金の積立・増資など）。' })]],
    ['notes', '個別注記表', range, null],
  ].filter(Boolean);
  // 帳票ごとに紙の決算書と同じ見出し（表題・期間・会社名・単位）。個別注記表は入力中の内容を残すため組み直さない
  const bodies = parts.map(([id, title, sub]) => (id === 'notes' ? fsPaper({ title, period: sub, company: settings.businessName, unit: '', body: notesBody }) : h('div')));
  const sections = parts.map(([id], i) => h('section', { class: 'fs-section', id: `fs-${id}` }, formats[id]?.el ?? null, id === 'notes' ? patternBar : null, bodies[i], id === 'notes' ? editor : null));
  function paintAmounts() {
    const caption = unitCaption(unit.value());
    parts.forEach(([id, title, sub, content], i) => content && put(bodies[i], id === 'bs' ? bsCheck() : null, fsPaper({ title, period: sub, company: settings.businessName, unit: caption, body: content() })));
  }
  paintAmounts();

  // 印刷：帳票を選んで1冊に（帳票ごとに改ページ。体裁は貸借対照表・損益計算書を1つずつ印刷するときと同じ）
  // 表紙：期数（設定に持たないので印刷のときに入れる。空欄なら書かない）・期間・会社名・所在地（請求書の設定の住所）
  const used = FINANCIAL_PARTS.filter(([k]) => k !== 'mfg' || mfg.used);
  const address = (settings.invoice?.address || '').trim();
  app.printDoc = ({ printedAt }) => ({
    options: [
      { key: 'cover', label: '表紙', type: 'check', value: true },
      { key: 'number', label: '表紙の期数（第○期。空欄なら書かない）', type: 'number', min: 1, max: 999, placeholder: '例：5', value: '' },
      address ? { key: 'address', label: '表紙に所在地を書く（請求書の設定の住所）', type: 'check', value: true } : null,
      ...used.map(([k, t]) => ({ key: `part_${k}`, label: t, type: 'check', value: true })),
      formatPrintOption({ key: 'format', label: '貸借対照表の様式', value: formats.bs.value() }),
      formatPrintOption({ key: 'plFormat', label: '損益計算書の様式', value: formats.pl.value() }),
      mfg.used ? formatPrintOption({ key: 'mfgFormat', label: '製造原価報告書の様式', value: formats.mfg.value() }) : null,
      { key: 'zero', label: '0円の科目も出す', type: 'check', value: false },
      ...unitPrintOptions(unit.value()),
    ].filter(Boolean),
    build: (v) =>
      financialStatementsDoc(
        { bs, plItems: condensedIncomeItems(pl), sga, mfgItems: mfg.used ? mfg.items : null, equity, notes: notesFor(), notesLead: notesLead(notes) },
        {
          head: docHead({ settings, period, printedAt }),
          at,
          range,
          parts: used.map(([k]) => k).filter((k) => v[`part_${k}`]),
          bsFormat: v.format,
          plFormat: v.plFormat,
          mfgFormat: v.mfgFormat ?? 'report',
          showZero: v.zero,
          unit: normalizeUnit(v),
          cover: v.cover ? { number: v.number, from: period.startDate, to: period.endDate, address: v.address ? address : '' } : null,
        },
      ),
  });

  put(
    outlet,
    openingWarning(openingDiff(period, accounts)),
    unit.el,
    h('div', { class: 'chip-row no-print' }, parts.map(([, title], i) => h('button', { type: 'button', class: 'chip', text: title.replace('販売費及び一般管理費内訳書', '販管費内訳'), onclick: () => sections[i].scrollIntoView({ behavior: 'smooth', block: 'start' }) }))),
    sections,
    h(
      'div',
      { class: 'panel small muted no-print' },
      h('p', { text: '会社法の計算書類（貸借対照表・損益計算書・株主資本等変動計算書・個別注記表）と、法人税の申告に添付する販売費及び一般管理費の内訳・製造原価報告書をまとめています。印刷ボタンで、帳票を選んで1冊に印刷できます（帳票ごとに改ページ）。' }),
      h('p', { text: '個別注記表は、会計監査人を置かない会社が表示する項目を、パターン（非公開会社・公開会社）に合わせて並べています（会社計算規則 第98条第2項）。該当が無い項目は空欄にすると出しません（「該当事項はありません。」と書くこともできます）。' }),
      h('p', { text: '株主資本等変動計算書は科目を縦に並べる様式です。評価・換算差額等・新株予約権には対応していません。' }),
    ),
  );
  paintNotes();
}
