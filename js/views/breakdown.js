// 勘定科目内訳明細書（法人）：帳簿の残高・補助科目から各内訳書を作る。弥生会計・勘定奉行の内訳書作成を参考にした
// 帳簿に無い欄（所在地・利率など）は、CSV に書き出してから記入する前提
import { h, put, amountCell, saveFile } from '../ui.js';
import { breakdownStatements } from '../breakdown.js';
import { breakdownCsv, csvFileName } from '../csv.js';
import { formatPeriod } from '../period.js';

export async function render({ app, outlet }) {
  const { settings, period, accounts, subAccounts, journals } = await app.load();
  if (settings.entityType !== 'corporation') return put(outlet, h('p', { class: 'notice', text: '勘定科目内訳明細書は法人だけで使えます。' }));
  let showAll = false;
  let showEmpty = false;
  const body = h('div');
  const index = h('div', { class: 'chip-row no-print' });

  const check = (label, onChange) => {
    const input = h('input', { type: 'checkbox', onchange: () => onChange(input.checked) });
    return h('label', { class: 'check small' }, input, label);
  };

  function table(f) {
    const head = h('tr', {}, f.columns.map((c) => h('th', { scope: 'col', class: c.num ? 'num' : '', text: c.label })));
    const rows = f.rows.map((r) =>
      h(
        'tr',
        { class: r.other ? 'bd-other' : '' },
        f.columns.map((c) => (c.num ? amountCell('td', r[c.key] ?? 0, { blankZero: c.key !== 'amount' }) : h('td', { text: r[c.key] ?? '' }))),
      ),
    );
    const first = f.columns.findIndex((c) => c.num);
    const totalRow = h(
      'tr',
      { class: 'st-total' },
      h('th', { scope: 'row', colspan: first, text: '計' }),
      f.columns.slice(first).map((c) => (c.num ? amountCell('td', c.key === 'amount' ? f.total : f.rows.reduce((s, r) => s + (r[c.key] || 0), 0)) : h('td', {}))),
    );
    return h('div', { class: 'table-wrap' }, h('table', { class: 'report breakdown', 'aria-label': f.title }, h('thead', {}, head), h('tbody', {}, rows, f.rows.length ? totalRow : null)));
  }

  function paint() {
    const forms = breakdownStatements({ accounts, subAccounts, period, journals, showAll });
    const visible = forms.filter((f) => showEmpty || f.rows.length);
    const sections = visible.map((f) =>
      h(
        'section',
        { class: 'bd-section', id: `bd-${f.id}` },
        h('h3', { class: 'tf-title' }, h('span', { class: 'bd-no', text: f.no }), f.title),
        f.rows.length ? table(f) : h('p', { class: 'muted small', text: '残高・発生額がありません。' }),
        f.note ? h('p', { class: 'muted small', text: f.note }) : null,
      ),
    );
    put(
      index,
      visible.map((f, i) => h('button', { type: 'button', class: 'chip', text: `${f.no}${f.title.replace(/の内訳書$/, '').replace(/（.*?）/g, '')}`, onclick: () => sections[i].scrollIntoView({ behavior: 'smooth', block: 'start' }) })),
    );
    put(
      body,
      sections.length ? sections : h('p', { class: 'empty', text: '内訳書に出す残高がありません。' }),
      h('div', { class: 'actions no-print' }, h('button', { type: 'button', class: 'btn', text: 'CSVで書き出す', onclick: () => saveFile(new Blob([breakdownCsv(visible)], { type: 'text/csv' }), csvFileName('breakdown')) })),
    );
  }

  put(
    outlet,
    h('p', { class: 'muted small', text: `${settings.businessName}　${formatPeriod(period)}（期末 ${period.endDate.replaceAll('-', '/')} 現在）` }),
    h(
      'div',
      { class: 'option-bar no-print' },
      check('金額基準でまとめずにすべて表示', (v) => ((showAll = v), paint())),
      check('残高の無い内訳書も表示', (v) => ((showEmpty = v), paint())),
    ),
    index,
    body,
    h(
      'div',
      { class: 'panel small muted' },
      h('p', { text: '相手先・金融機関・銘柄・氏名・貸主は、各科目の補助科目で分けて出します。補助科目を使っていない科目は科目の合計の1行になります。' }),
      h('p', {}, '補助科目は ', h('a', { href: '#/accounts', class: 'link', text: '勘定科目' }), ' の画面で追加できます。所在地・法人との関係・利率など帳簿に無い欄は、CSV に書き出してから記入してください。'),
      h('p', { text: '対応していない内訳書：⑫土地の売上高等、⑬売上高等の事業所別、⑮-2・⑮-3（権利金等・工業所有権等の使用料）。テンプレートにない科目を追加した場合、その科目は内訳書に入りません。' }),
      h('p', { text: '出典：国税庁 勘定科目内訳明細書の標準フォーム（令和6年3月1日以後終了事業年度分）、記載内容の簡素化（e-Tax）' }),
    ),
  );
  paint();
}
