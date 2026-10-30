// 決算書（法人）：貸借対照表・損益計算書・販売費及び一般管理費内訳書・製造原価報告書・株主資本等変動計算書・個別注記表
// 弥生会計・勘定奉行の「決算書」の構成を参考に、印刷して1冊にできる並びにする
import { h, put, amountCell, field, showToast, errorBox } from '../ui.js';
import { buildStatements, closingRows, manufacturingReport } from '../statements.js';
import { sgaBreakdown, condensedIncomeItems, equityStatement, companyNotes, DEFAULT_NOTES } from '../financial.js';
import { openingDiff } from '../ledger.js';
import { formatYen, unitCaption, normalizeUnit } from '../money.js';
import { ValidationError } from '../db.js';
import { errorText } from '../errors.js';
import { openingWarning, unitPicker, unitPrintOptions } from './report-common.js';
import { fsPaper, fsPeriod, incomeStatementTable, balanceSheetView, breakdownTable } from './fs-view.js';
import { financialStatementsDoc, FINANCIAL_PARTS, docHead } from '../print-forms.js';

export async function render({ app, outlet }) {
  const { settings, period, accounts, journals } = await app.load();
  if (settings.entityType !== 'corporation') return put(outlet, h('p', { class: 'notice' }, '法人の決算書の画面です。個人は ', h('a', { href: '#/reports/blue-return', class: 'link', text: '青色申告決算書' }), ' を使ってください。'));
  const assets = await app.db.listAssets();
  const notes = { ...DEFAULT_NOTES, ...(period.statementNotes || {}) };
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

  function paintNotes() {
    const sections = companyNotes({ accounts, period, journals, assets, notes });
    put(
      notesBody,
      notes.sharesIssued === null ? h('p', { class: 'notice no-print', text: '株主資本等変動計算書に関する注記（期末の発行済株式の数）は、この会社でも必要な注記です。下の「注記の内容を編集する」で入力してください。' }) : null,
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
  }

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
  const editor = h(
    'details',
    { class: 'panel no-print fs-editor' },
    h('summary', { text: '注記の内容を編集する' }),
    field('棚卸資産の評価基準及び評価方法', textarea('inventoryMethod', 2), { hint: '棚卸資産の残高があるときだけ表示します' }),
    field('固定資産の減価償却の方法', textarea('depreciation', 3, '空欄なら固定資産台帳から作ります'), { hint: '空欄のときは、固定資産台帳の償却方法から文を作ります' }),
    field('引当金の計上基準', textarea('allowance', 2, '空欄なら貸倒引当金の残高があるときに定型文'), {}),
    h('label', { class: 'check small' }, accumCheck, '有形固定資産の減価償却累計額を注記する（任意）'),
    h('div', { class: 'field-row' }, field('発行済株式の数（株）', intInput('sharesIssued')), field('自己株式の数（株）', intInput('treasuryShares'))),
    field('剰余金の配当に関する事項', textarea('dividends', 3, '例：令和8年6月25日の定時株主総会で、普通株式の配当金総額100,000円（1株当たり100円）')),
    field('会計方針の変更', textarea('policyChanges', 2, '無ければ空欄')),
    field('表示方法の変更', textarea('presentationChanges', 2, '無ければ空欄')),
    field('誤謬の訂正', textarea('errorCorrections', 2, '無ければ空欄')),
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
  const parts = [
    ['bs', '貸借対照表', at, () => balanceSheetView(bs, { entityType: 'corporation' })],
    ['pl', '損益計算書', range, () => incomeStatementTable(condensedIncomeItems(pl), { entityType: 'corporation' })],
    ['sga', '販売費及び一般管理費内訳書', range, () => breakdownTable(sga.lines, sga.total, { label: '販売費及び一般管理費内訳書' })],
    mfg.used ? ['mfg', '製造原価報告書', range, () => incomeStatementTable(mfg.items, { entityType: 'corporation', label: '製造原価報告書' })] : null,
    ['equity', '株主資本等変動計算書', range, () => [equityTable(), h('p', { class: 'muted small no-print', text: '「その他の変動」は、期中の仕訳による純資産の科目の増減です（剰余金の配当・利益準備金の積立・増資など）。' })]],
    ['notes', '個別注記表', range, null],
  ].filter(Boolean);
  // 帳票ごとに紙の決算書と同じ見出し（表題・期間・会社名・単位）。個別注記表は入力中の内容を残すため組み直さない
  const bodies = parts.map(([id, title, sub]) => (id === 'notes' ? fsPaper({ title, period: sub, company: settings.businessName, unit: '', body: notesBody }) : h('div')));
  const sections = parts.map(([id], i) => h('section', { class: 'fs-section', id: `fs-${id}` }, bodies[i], id === 'notes' ? editor : null));
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
      { key: 'format', label: '貸借対照表の様式', type: 'select', choices: [['account', '勘定式（左右に並べる）'], ['report', '報告式（上下に並べる）']], value: 'account' },
      { key: 'zero', label: '0円の科目も出す', type: 'check', value: false },
      ...unitPrintOptions(unit.value()),
    ].filter(Boolean),
    build: (v) =>
      financialStatementsDoc(
        { bs, plItems: condensedIncomeItems(pl), sga, mfgItems: mfg.used ? mfg.items : null, equity, notes: companyNotes({ accounts, period, journals, assets, notes }) },
        {
          head: docHead({ settings, period, printedAt }),
          at,
          range,
          parts: used.map(([k]) => k).filter((k) => v[`part_${k}`]),
          bsFormat: v.format,
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
      h('p', { text: '個別注記表は、会計監査人を置かない非公開会社が表示する項目（重要な会計方針・会計方針の変更・表示方法の変更・誤謬の訂正・株主資本等変動計算書・その他）を並べています（会社計算規則 第98条第2項）。該当が無い項目は空欄にすると出しません。' }),
      h('p', { text: '株主資本等変動計算書は科目を縦に並べる様式です。評価・換算差額等・新株予約権には対応していません。' }),
    ),
  );
  paintNotes();
}
