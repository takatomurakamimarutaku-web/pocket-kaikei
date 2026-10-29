// 決算書（法人）：貸借対照表・損益計算書・販売費及び一般管理費内訳書・製造原価報告書・株主資本等変動計算書・個別注記表
// 弥生会計・勘定奉行の「決算書」の構成を参考に、印刷して1冊にできる並びにする
import { h, put, amountCell, field, showToast, errorBox } from '../ui.js';
import { buildStatements, closingRows, manufacturingReport } from '../statements.js';
import { sgaBreakdown, condensedIncomeItems, equityStatement, companyNotes, DEFAULT_NOTES } from '../financial.js';
import { openingDiff } from '../ledger.js';
import { formatPeriod } from '../period.js';
import { formatYen } from '../money.js';
import { ValidationError } from '../db.js';
import { errorText } from '../errors.js';
import { statementRows, openingWarning } from './report-common.js';

export async function render({ app, outlet }) {
  const { settings, period, accounts, journals } = await app.load();
  if (settings.entityType !== 'corporation') return put(outlet, h('p', { class: 'notice' }, '法人の決算書の画面です。個人は ', h('a', { href: '#/reports/blue-return', class: 'link', text: '青色申告決算書' }), ' を使ってください。'));
  const assets = await app.db.listAssets();
  const notes = { ...DEFAULT_NOTES, ...(period.statementNotes || {}) };
  const { pl, bs } = buildStatements({ entityType: 'corporation', accounts, period, journals });
  const mfg = manufacturingReport(closingRows({ accounts, period, journals }));
  const equity = equityStatement({ accounts, period, journals, netIncome: pl.netIncome });
  const sga = sgaBreakdown(pl);
  const end = period.endDate.replaceAll('-', '/');
  const notesBody = h('div');
  const errorsEl = h('div');

  const table = (label, rows, cls = 'statement') => h('div', { class: 'table-wrap' }, h('table', { class: `report ${cls}`, 'aria-label': label }, h('tbody', {}, rows)));
  const line = (label, amount, cls = 'st-line') => h('tr', { class: cls }, h('th', { text: label }), amountCell('td', amount));

  // 貸借対照表の純資産の部（株主資本 › 資本金・資本剰余金・利益剰余金）
  function equityRows() {
    const out = [h('tr', { class: 'st-group' }, h('th', { colspan: 2, text: '純資産の部' })), h('tr', { class: 'st-group level2' }, h('th', { colspan: 2, text: '株主資本' }))];
    for (const s of equity.sections) {
      if (s.id === 'capital' || s.id === 'other') {
        for (const r of s.rows) out.push(line(r.account.name, r.closing));
        continue;
      }
      out.push(line(s.label, s.total.closing, 'st-subtotal heading'));
      for (const r of s.rows) {
        if (r.account.role === 'retained_earnings') out.push(line('その他利益剰余金', r.closing, 'st-line'), line(`　${r.account.name}`, r.closing, 'st-line fs-indent'));
        else out.push(line(`　${r.account.name}`, r.closing, 'st-line fs-indent'));
      }
      out.push(line(`${s.label}合計`, s.total.closing, 'st-total'));
    }
    out.push(line('株主資本合計', equity.total.closing, 'st-total'), line('純資産合計', equity.total.closing, 'st-subtotal'));
    return out;
  }

  function bsTable() {
    const liab = bs.liabilities.filter((it) => !(it.type === 'group' && it.groups?.includes('equity')) && !(it.type === 'subtotal' && it.strong));
    return [
      h('p', { class: `check-line ${bs.balanced ? 'ok' : 'ng'}`, text: bs.balanced ? `資産合計 ${formatYen(bs.totalAssets)}円 ＝ 負債・純資産合計` : `資産合計と負債・純資産合計が一致しません（差額 ${formatYen(bs.totalAssets - bs.totalLiabilitiesAndEquity)}円）` }),
      table('資産の部', [h('tr', { class: 'st-group' }, h('th', { colspan: 2, text: '資産の部' })), ...statementRows(bs.assets)]),
      table('負債・純資産の部', [h('tr', { class: 'st-group' }, h('th', { colspan: 2, text: '負債の部' })), ...statementRows(liab), ...equityRows(), line('負債・純資産合計', bs.totalLiabilitiesAndEquity, 'st-subtotal strong')]),
    ];
  }

  function equityTable() {
    const head = h('tr', {}, ['科目', '当期首残高', '当期純利益', 'その他の変動', '当期末残高'].map((t) => h('th', { scope: 'col', text: t })));
    const row = (label, v, cls = '') => h('tr', { class: cls }, h('th', { scope: 'row', text: label }), amountCell('td', v.opening), amountCell('td', v.netIncome, { blankZero: true }), amountCell('td', v.other, { blankZero: true }), amountCell('td', v.closing));
    const rows = [];
    for (const s of equity.sections) {
      if (s.id !== 'capital' && s.id !== 'other') rows.push(h('tr', { class: 'tb-group' }, h('th', { scope: 'row', colspan: 5, text: s.label })));
      for (const r of s.rows) rows.push(row(r.account.name, r));
      if (s.id !== 'capital' && s.id !== 'other') rows.push(row(`${s.label}合計`, s.total, 'tb-subtotal'));
    }
    rows.push(row('株主資本合計', equity.total, 'tb-subtotal'), row('純資産合計', equity.total, 'mt-strong'));
    return h('div', { class: 'table-wrap' }, h('table', { class: 'report tb fs-equity', 'aria-label': '株主資本等変動計算書' }, h('thead', {}, head), h('tbody', {}, rows)));
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

  const parts = [
    ['bs', '貸借対照表', `${end} 現在`, bsTable()],
    ['pl', '損益計算書', formatPeriod(period), table('損益計算書', statementRows(condensedIncomeItems(pl)))],
    ['sga', '販売費及び一般管理費内訳書', formatPeriod(period), table('販売費及び一般管理費内訳書', [...sga.lines.filter((l) => l.amount).map((l) => line(l.account.name, l.amount)), line('合計', sga.total, 'st-subtotal strong')])],
    mfg.used ? ['mfg', '製造原価報告書', formatPeriod(period), table('製造原価報告書', statementRows(mfg.items))] : null,
    ['equity', '株主資本等変動計算書', formatPeriod(period), [equityTable(), h('p', { class: 'muted small no-print', text: '「その他の変動」は、期中の仕訳による純資産の科目の増減です（剰余金の配当・利益準備金の積立・増資など）。' })]],
    ['notes', '個別注記表', formatPeriod(period), [notesBody, editor]],
  ].filter(Boolean);
  const sections = parts.map(([id, title, sub, content]) => h('section', { class: 'fs-section', id: `fs-${id}` }, h('h3', { class: 'fs-title' }, title, h('span', { class: 'fs-sub', text: `${settings.businessName}　${sub}　（単位：円）` })), content));

  put(
    outlet,
    h('p', { class: 'muted small', text: `${settings.businessName}　${formatPeriod(period)}` }),
    openingWarning(openingDiff(period, accounts)),
    h('div', { class: 'chip-row no-print' }, parts.map(([, title], i) => h('button', { type: 'button', class: 'chip', text: title.replace('販売費及び一般管理費内訳書', '販管費内訳'), onclick: () => sections[i].scrollIntoView({ behavior: 'smooth', block: 'start' }) }))),
    sections,
    h(
      'div',
      { class: 'panel small muted no-print' },
      h('p', { text: '会社法の計算書類（貸借対照表・損益計算書・株主資本等変動計算書・個別注記表）と、法人税の申告に添付する販売費及び一般管理費の内訳・製造原価報告書をまとめています。印刷ボタンで1冊に印刷できます。' }),
      h('p', { text: '個別注記表は、会計監査人を置かない非公開会社が表示する項目（重要な会計方針・会計方針の変更・表示方法の変更・誤謬の訂正・株主資本等変動計算書・その他）を並べています（会社計算規則 第98条第2項）。該当が無い項目は空欄にすると出しません。' }),
      h('p', { text: '株主資本等変動計算書は科目を縦に並べる様式です。評価・換算差額等・新株予約権には対応していません。' }),
    ),
  );
  paintNotes();
}
