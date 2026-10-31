// 別表十六（法人）：固定資産台帳から減価償却資産の償却額の計算に関する明細書の各欄を作る（転記用）
// 弥生会計・freee の「別表十六」と同じく、資産ごとの列に欄の番号と金額を並べる
import { h, put, amountCell, saveFile } from '../ui.js';
import { schedule16, SCHEDULE16_LINES } from '../schedule16.js';
import { methodLabel } from '../depreciation.js';
import { schedule16Csv, csvFileName } from '../csv.js';
import { formatPeriod } from '../period.js';
import { formatYen } from '../money.js';

const TITLES = {
  straight: '別表十六（一）旧定額法又は定額法による減価償却資産の償却額の計算に関する明細書',
  declining: '別表十六（二）旧定率法又は定率法による減価償却資産の償却額の計算に関する明細書',
  small: '別表十六（七）少額減価償却資産の取得価額の損金算入の特例に関する明細書',
  lump: '別表十六（八）一括償却資産の損金算入に関する明細書',
};
/** このアプリでは使わない（常に0の）欄：0 は空欄で表示する */
const UNUSED = {
  straight: [8, 11, 12, 15, 22, 28, 33, 38, 39, 40, 43],
  declining: [8, 11, 12, 15, 17, 22, 32, 37, 42, 43, 44, 47],
  small: [6],
  lump: [8, 9],
};

export async function render({ app, outlet }) {
  const { settings, period, journals } = await app.load();
  if (settings.entityType !== 'corporation') return put(outlet, h('p', { class: 'notice', text: '別表十六は法人の申告書です。個人は青色申告決算書の「減価償却費の計算」を使います。' }));
  const [assets, periods] = await Promise.all([app.db.listAssets(), app.db.listPeriods()]);
  const r = schedule16({ assets, periods, period, journals });

  const kpi = (label, value, sub) => h('div', { class: 'kpi' }, h('span', { class: 'kpi-label', text: label }), h('span', { class: 'kpi-value num', text: value }), sub ? h('span', { class: 'kpi-sub', text: sub }) : null);

  /** 値のセル（金額・率・年数・文字） */
  function cell(def, value, form) {
    if (value === undefined || value === null || value === '') return h('td', { class: def.kind === 'text' ? 's16-text' : 'num' });
    if (def.kind === 'yen') return amountCell('td', value, { blankZero: UNUSED[form].includes(def.no) });
    if (def.kind === 'years') return h('td', { class: 'num', text: `${value}年` });
    if (def.kind === 'text') return h('td', { class: 's16-text', text: String(value) });
    return h('td', { class: 'num', text: String(value) });
  }

  /** 欄を行、資産（事業年度）を列にした表 */
  function formTable(form, columns, heads) {
    const defs = SCHEDULE16_LINES[form];
    const rows = [];
    for (const def of defs) {
      if (def.section) rows.push(h('tr', { class: 's16-section' }, h('th', { scope: 'rowgroup', colspan: columns.length + 1, text: def.section })));
      rows.push(
        h(
          'tr',
          {},
          h('th', { scope: 'row' }, h('span', { class: 's16-no', text: String(def.no) }), def.label, def.formula ? h('span', { class: 'block', text: def.formula }) : null),
          columns.map((c) => cell(def, c.lines[def.no], form)),
        ),
      );
    }
    if (columns.some((c) => c.notes?.length)) rows.push(h('tr', { class: 's16-notes' }, h('th', { scope: 'row', text: '注記' }), columns.map((c) => h('td', { text: (c.notes || []).join('。') }))));
    return h(
      'div',
      { class: 'table-wrap' },
      h('table', { class: 'report taxform s16-table', 'aria-label': TITLES[form] }, h('thead', {}, h('tr', {}, h('th', { scope: 'col', text: '欄・項目' }), heads.map((t) => h('th', { scope: 'col' }, ...t)))), h('tbody', {}, rows)),
    );
  }

  const assetHead = (c) => [c.asset.name, h('span', { class: 'block', text: c.variant ? methodLabel(c.asset) : '' })];
  const sections = [];
  const section = (id, title, content) => {
    const el = h('section', { class: 'fs-section', id: `s16-${id}` }, h('h3', { class: 'tf-title', text: title }), content);
    sections.push([id, el]);
    return el;
  };
  const none = (text) => h('p', { class: 'muted small', text });

  const straightEl = section('straight', TITLES.straight, r.straight.length ? formTable('straight', r.straight, r.straight.map(assetHead)) : none('定額法・旧定額法で償却する資産はありません。'));
  const decliningEl = section('declining', TITLES.declining, r.declining.length ? formTable('declining', r.declining, r.declining.map(assetHead)) : none('定率法・旧定率法で償却する資産はありません。'));
  const smallEl = section(
    'small',
    TITLES.small,
    r.small.items.length
      ? [
          formTable('small', r.small.items, r.small.items.map((x) => [x.asset.name])),
          h(
            'table',
            { class: 'report taxform s16-sum', 'aria-label': '当期の少額減価償却資産の取得価額の合計額' },
            h('tbody', {}, h('tr', {}, h('th', { scope: 'row' }, h('span', { class: 's16-no', text: '8' }), '当期の少額減価償却資産の取得価額の合計額', h('span', { class: 'block', text: `(7)の計　限度 ${formatYen(r.small.limit)}円（年300万円。1年未満の事業年度は月数で按分）` })), amountCell('td', r.small.total))),
          ),
        ]
      : none('当期に使い始めた少額減価償却資産（中小企業者等の特例）はありません。'),
  );
  const lumpEl = section('lump', TITLES.lump, r.lump.length ? formTable('lump', r.lump, r.lump.map((c) => [c.current ? '当期分' : '前期以前分'])) : none('一括償却資産はありません。'));

  const diff = r.posted - r.expected;
  put(
    outlet,
    h('p', { class: 'muted small', text: `${settings.businessName}　事業年度 ${formatPeriod(period)}` }),
    h(
      'div',
      { class: 'kpi-grid' },
      kpi('当期償却額（一）（二）', `${formatYen(r.totals.amount)}円`, r.totals.special ? `うち特別償却 ${formatYen(r.totals.special)}円` : `資産 ${r.straight.length + r.declining.length}件`),
      kpi('償却超過額', `${formatYen(r.totals.excess)}円`, '台帳の計算どおりに計上'),
      kpi('一括償却資産の損金算入額', `${formatYen(r.totals.lump)}円`, '別表十六（八）'),
      kpi('少額減価償却資産（特例）', `${formatYen(r.totals.small)}円`, `限度 ${formatYen(r.small.limit)}円`),
    ),
    r.expected && !r.posted
      ? h('div', { class: 'notice' }, h('span', { text: `この期の減価償却の仕訳がまだありません（台帳の計算 ${formatYen(r.expected)}円）。` }), h('a', { href: '#/assets', class: 'link', text: '固定資産台帳で作る' }))
      : r.posted && diff
        ? h('p', { class: 'notice', text: `減価償却の仕訳の合計（${formatYen(r.posted)}円）が台帳の計算（${formatYen(r.expected)}円）と${formatYen(Math.abs(diff))}円違います。別表の「当期償却額」は台帳の計算で書いているので、損金経理した額に直して記入してください。` })
        : null,
    r.small.over ? h('p', { class: 'notice', text: `少額減価償却資産の特例の合計（${formatYen(r.small.total)}円）が限度額（${formatYen(r.small.limit)}円）を超えています。超えた資産は通常の減価償却にしてください。` }) : null,
    h(
      'div',
      { class: 'chip-row no-print' },
      sections.map(([id, el]) => h('button', { type: 'button', class: 'chip', text: { straight: '（一）定額法', declining: '（二）定率法', small: '（七）少額', lump: '（八）一括償却' }[id], onclick: () => el.scrollIntoView({ behavior: 'smooth', block: 'start' }) })),
    ),
    straightEl,
    decliningEl,
    smallEl,
    lumpEl,
    h(
      'ul',
      { class: 'muted small s16-help' },
      h('li', { text: '「当期償却額」「損金に計上した当期償却額」は固定資産台帳の計算額（このアプリが作る減価償却の仕訳と同じ額）で書いています。償却限度額どおりなので、償却不足額・償却超過額は0です。' }),
      h('li', { text: '「構造」「細目」は資産の画面の「構造又は用途」「細目」です（耐用年数表から選ぶと入ります）。機械及び装置の「構造」には、耐用年数省令の別表第二の番号を書きます。' }),
      h('li', { text: '圧縮記帳（直接減額方式）をした資産の取得価額は圧縮後の額です（明細は別表十三（一））。積立金方式・増加償却・償却超過額の繰越し・特別償却不足額の繰越しには対応していません（その欄は空欄）。前期から繰り越した額がある場合は、手で記入してください。' }),
      h('li', { text: '特別償却・少額減価償却資産の特例を使うときは、適用額明細書にも記載します。' }),
      h('li', { text: '一括償却資産は、36か月目を含む事業年度の限度額を「取得価額の合計−前期までの損金算入額」（端数の調整）にしています。' }),
    ),
    h('div', { class: 'actions no-print' }, h('button', { type: 'button', class: 'btn', text: 'CSVで書き出す', onclick: () => saveFile(new Blob([schedule16Csv(r)], { type: 'text/csv' }), csvFileName('schedule16')) })),
  );
}
