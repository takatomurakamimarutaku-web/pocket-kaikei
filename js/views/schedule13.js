// 別表十三（一）Ⅰ（法人）：国庫補助金等で取得した固定資産等の圧縮額等の損金算入に関する明細書（転記用）
// 固定資産台帳で圧縮記帳をした資産を列に、欄を行に並べる（別表十六の画面と同じ形）
import { h, put, amountCell } from '../ui.js';
import { schedule13, SCHEDULE13_LINES } from '../schedule13.js';
import { formatPeriod } from '../period.js';
import { formatYen } from '../money.js';

const TITLE = '別表十三（一）Ⅰ 国庫補助金等で取得した固定資産等の圧縮額等の損金算入に関する明細書';
const slash = (d) => (d ? d.replaceAll('-', '/') : '');

export async function render({ app, outlet }) {
  const { settings, period } = await app.load();
  if (settings.entityType !== 'corporation') return put(outlet, h('p', { class: 'notice', text: '別表十三（一）は法人の申告書です。個人は確定申告書に「国庫補助金等の総収入金額不算入に関する明細書」を付けます（国税庁 No.2202）。' }));
  const assets = await app.db.listAssets();
  const r = schedule13({ assets, period });
  const kpi = (label, value, sub) => h('div', { class: 'kpi' }, h('span', { class: 'kpi-label', text: label }), h('span', { class: 'kpi-value num', text: value }), sub ? h('span', { class: 'kpi-sub', text: sub }) : null);

  const cell = (def, x) => {
    const v = x[def.key];
    if (def.kind === 'yen') return amountCell('td', v);
    if (def.kind === 'date') return h('td', { class: 'num', text: slash(v) });
    return h('td', { class: 's16-text', text: v || '' });
  };
  const table = r.items.length
    ? h(
        'div',
        { class: 'table-wrap' },
        h(
          'table',
          { class: 'report taxform s16-table', 'aria-label': TITLE },
          h('thead', {}, h('tr', {}, h('th', { scope: 'col', text: '項目' }), r.items.map((x) => h('th', { scope: 'col' }, h('a', { class: 'link', href: `#/asset/${encodeURIComponent(x.asset.id)}`, text: x.asset.name }))))),
          h(
            'tbody',
            {},
            SCHEDULE13_LINES.map((def) => h('tr', {}, h('th', { scope: 'row' }, def.label, def.formula ? h('span', { class: 'block', text: def.formula }) : null), r.items.map((x) => cell(def, x)))),
          ),
        ),
      )
    : h('p', { class: 'muted small' }, 'この事業年度に圧縮記帳をした資産はありません。圧縮記帳は ', h('a', { class: 'link', href: '#/assets', text: '固定資産台帳' }), ' の資産の画面で入力します。');

  const noSubsidy = r.items.filter((x) => !x.subsidyGiven);
  put(
    outlet,
    h('p', { class: 'muted small', text: `${settings.businessName}　事業年度 ${formatPeriod(period)}` }),
    h(
      'div',
      { class: 'kpi-grid' },
      kpi('圧縮額（損金算入額）', `${formatYen(r.totals.reduced - r.totals.excess)}円`, `資産 ${r.items.length}件`),
      kpi('圧縮限度超過額', `${formatYen(r.totals.excess)}円`, r.totals.excess ? '別表四で加算' : '超過なし'),
    ),
    r.totals.excess ? h('p', { class: 'notice', text: `圧縮額が圧縮限度額を${formatYen(r.totals.excess)}円超えています。超えた額は損金になりません（別表四で加算し、別表五(一)に記載します）。圧縮額か補助金等の額を確かめてください。` }) : null,
    noSubsidy.length ? h('p', { class: 'notice', text: `${noSubsidy.map((x) => `「${x.asset.name}」`).join('')}は交付を受けた補助金等の額が空欄なので、圧縮額と同じ額にしています。資産の画面の圧縮記帳の欄で入力してください。` }) : null,
    h('section', { class: 'fs-section' }, h('h3', { class: 'tf-title', text: TITLE }), table),
    h(
      'ul',
      { class: 'muted small s16-help' },
      h('li', { text: '固定資産台帳で圧縮記帳（直接減額方式）をした資産のうち、圧縮記帳をした日がこの事業年度のものを載せています。欄の番号は様式の改正で変わるので、国税庁の様式で確かめて転記してください。' }),
      h('li', { text: '圧縮限度額は、交付を受けた補助金等の額です。補助金等で取得価額の全部をまかなったときは、帳簿価額を1円残すため「取得価額−1円」になります。' }),
      h('li', { text: '補助金等の交付が先で資産の取得が翌期以後になる場合（特別勘定）、返還を要するかが未確定の場合、前期以前に取得した資産の既償却額の調整には対応していません。' }),
      h('li', { text: '補助金等の入金（普通預金 / 国庫補助金受贈益）は益金に、圧縮損（固定資産圧縮損 / 資産）は損金になります。資産の取得価額は圧縮後の額で別表十六に載ります。' }),
    ),
  );
}
