// 償却資産申告書（固定資産税）：固定資産台帳から申告書（種類別の集計）と種類別明細書（全資産用・減少資産用）を作る
// 弥生会計・freee の「償却資産申告書」と同じく、台帳の資産を賦課期日（1月1日）で振り分け、評価額は参考として計算する
import { h, put, amountCell, saveFile, showToast, errorBox, stackTable } from '../ui.js';
import { propertyTaxReturn, ptEligibility, ptKindOf, ptLifeOf, PT_KINDS, eraOf, fiscalYearLabel, defaultPtYear, PT_EXEMPTION } from '../property-tax.js';
import { propertyTaxCsv, csvFileName } from '../csv.js';
import { todayString } from '../period.js';
import { formatYen } from '../money.js';
import { ValidationError } from '../db.js';
import { errorText } from '../errors.js';
import { warekiText } from '../print-layout.js';
import { propertyHead } from '../print-form-heads.js';
import { filerOf } from '../filer.js';

const era = (d) => {
  const e = eraOf(d);
  return `${e.era}${e.year}.${e.month}`;
};

export async function render({ app, outlet, query }) {
  const { settings } = await app.load();
  let assets = await app.db.listAssets();
  const base = defaultPtYear(todayString());
  let year = /^\d{4}$/.test(query.year || '') ? Number(query.year) : base;
  const body = h('div');
  const errorsEl = h('div');
  // 印刷：画面の表から作る。期間の行は会計期間ではなく、申告する年度と賦課期日（1月1日現在）
  // 頭書き：所有者の欄（住所・名称・番号・事業種目）と提出先の市町村
  app.printDoc = () => ({ period: `${fiscalYearLabel(year)}　賦課期日 ${warekiText(`${year}-01-01`)}現在`, headBlocks: [propertyHead(filerOf(settings), { corporation: settings.entityType === 'corporation' })] });

  const kpi = (label, value, sub) => h('div', { class: 'kpi' }, h('span', { class: 'kpi-label', text: label }), h('span', { class: 'kpi-value num', text: value }), sub ? h('span', { class: 'kpi-sub', text: sub }) : null);
  const tableWrap = (label, head, rows, cls = '') => h('div', { class: 'table-wrap' }, h('table', { class: `report taxform pt-table ${cls}`, 'aria-label': label }, h('thead', {}, h('tr', {}, head.map((t) => h('th', { scope: 'col', text: t })))), h('tbody', {}, rows)));

  async function saveField(asset, patch) {
    try {
      const saved = await app.db.saveAsset({ ...asset, ...patch });
      assets = assets.map((a) => (a.id === saved.id ? saved : a));
      put(errorsEl);
      showToast('資産の設定を保存しました');
      paint();
    } catch (e) {
      put(errorsEl, errorBox(e instanceof ValidationError ? (Array.isArray(e.errors) ? e.errors : Object.values(e.errors)) : [errorText(e, '保存')]));
    }
  }

  function kindsTable(r) {
    const sum = (key) => r.kinds.reduce((s, k) => s + k[key], 0);
    const row = (label, v, cls = '') => h('tr', { class: cls }, h('th', { scope: 'row', text: label }), ['before', 'decrease', 'increase', 'total', 'value'].map((key) => amountCell('td', v[key], { blankZero: true })));
    const wrap = tableWrap(
      '申告書（資産の種類ごとの取得価額）',
      ['資産の種類', '前年前に取得したもの（イ）', '前年中に減少したもの（ロ）', '前年中に取得したもの（ハ）', '計（ニ）＝（イ）−（ロ）＋（ハ）', '評価額（参考）'],
      [...r.kinds.map((k) => row(`${k.id}　${k.label}`, k)), row('合計', { before: sum('before'), decrease: sum('decrease'), increase: sum('increase'), total: sum('total'), value: sum('value') }, 'st-total')],
    );
    // スマホでは種類ごとに2段（見出しは短く）
    stackTable(wrap.querySelector('table'), ['', '（イ）前年前取得', '（ロ）前年中減少', '（ハ）前年中取得', '（ニ）計', '評価額（参考）']);
    return wrap;
  }

  function itemsTable(r) {
    const rows = r.items.map((it) =>
      h(
        'tr',
        {},
        h('td', { class: 'tf-no', text: String(it.kind) }),
        h('td', { text: it.asset.name }, it.increase ? h('span', { class: 'pt-badge', text: '増' }) : null),
        h('td', { class: 'num', text: String(it.asset.quantity ?? 1) }),
        h('td', { class: 'num', text: era(it.asset.acquiredOn) }),
        amountCell('td', it.cost ?? it.asset.cost),
        h('td', { class: 'num', text: it.life ? `${it.life}年` : '未入力' }),
        h('td', { class: 'num', text: it.residual ? (it.residual / 1000).toFixed(3) : '' }),
        amountCell('td', it.value),
      ),
    );
    if (r.items.length) rows.push(h('tr', { class: 'st-total' }, h('th', { scope: 'row', colspan: 4, text: '計' }), amountCell('td', r.items.reduce((s, it) => s + (it.cost ?? it.asset.cost), 0)), h('td'), h('td'), amountCell('td', r.valueTotal)));
    return tableWrap('種類別明細書（全資産用）', ['種類', '資産の名称等', '数量', '取得年月', '取得価額', '耐用年数', '減価残存率', '評価額'], rows);
  }

  function decreasesTable(r) {
    return tableWrap(
      '種類別明細書（減少資産用）',
      ['種類', '資産の名称等', '数量', '取得年月', '取得価額', '耐用年数', '減少の事由'],
      r.decreases.map((d) => h('tr', {}, h('td', { class: 'tf-no', text: String(d.kind) }), h('td', { text: d.asset.name }), h('td', { class: 'num', text: String(d.asset.quantity ?? 1) }), h('td', { class: 'num', text: era(d.asset.acquiredOn) }), amountCell('td', d.cost ?? d.asset.cost), h('td', { class: 'num', text: d.life ? `${d.life}年` : '' }), h('td', { text: `${d.reason}（全部）` }))),
    );
  }

  // 資産ごとの設定：対象にするか・種類・耐用年数（少額特例の資産など）
  function settingsList() {
    const list = assets.filter((a) => !ptEligibility(a).fixed && a.acquiredOn <= `${year}-01-01` && !(a.disposedOn && a.disposedOn <= `${year - 1}-01-01`));
    if (!list.length) return h('p', { class: 'muted small', text: '設定できる資産がありません。' });
    return h(
      'ul',
      { class: 'pt-settings' },
      list.map((a) => {
        const el = ptEligibility(a);
        const include = h('select', { 'aria-label': `${a.name}を申告の対象にするか`, onchange: (e) => saveField(a, { ptInclude: e.target.value || null }) }, [
          h('option', { value: '', text: `自動（${el.review ? '対象外' : '対象'}）`, selected: !a.ptInclude }),
          h('option', { value: 'yes', text: '申告の対象', selected: a.ptInclude === 'yes' }),
          h('option', { value: 'no', text: '対象外', selected: a.ptInclude === 'no' }),
        ]);
        const kind = h('select', { 'aria-label': `${a.name}の資産の種類`, onchange: (e) => saveField(a, { ptKind: Number(e.target.value) }) }, PT_KINDS.map((k) => h('option', { value: String(k.id), text: `${k.id} ${k.label}`, selected: ptKindOf(a) === k.id })));
        const lifeInput = h('input', {
          type: 'text',
          inputmode: 'numeric',
          'aria-label': `${a.name}の耐用年数`,
          class: 'pt-life',
          value: ptLifeOf(a) ? String(ptLifeOf(a)) : '',
          placeholder: '年',
          onchange: (e) => {
            const v = e.target.value.trim();
            saveField(a, { ptLife: v === '' ? null : /^\d+$/.test(v) ? Number(v) : NaN });
          },
        });
        return h(
          'li',
          { class: 'pt-setting' },
          h('div', { class: 'pt-setting-name' }, h('strong', { text: a.name }), h('span', { class: 'muted small', text: `${era(a.acquiredOn)} 取得・${formatYen(a.cost)}円` })),
          h('div', { class: 'pt-setting-controls' }, include, kind, h('label', { class: 'small' }, '耐用年数 ', lifeInput)),
          el.reason ? h('p', { class: 'muted small', text: el.reason }) : null,
        );
      }),
    );
  }

  function paint() {
    const r = propertyTaxReturn({ assets, year });
    const years = [base - 2, base - 1, base, base + 1];
    put(
      body,
      h(
        'div',
        { class: 'option-bar no-print' },
        h('label', { class: 'small' }, '申告する年度 ', h('select', { 'aria-label': '申告する年度', onchange: (e) => ((year = Number(e.target.value)), history.replaceState(history.state, '', `#/reports/property-tax?year=${year}`), paint()) }, years.map((y) => h('option', { value: String(y), text: `${fiscalYearLabel(y)}（${y}年1月1日現在）`, selected: y === year })))),
      ),
      h('p', { class: 'muted small', text: `${settings.businessName}　${r.label}　賦課期日 ${year}年1月1日・申告期限 ${year}年1月31日` }),
      h(
        'div',
        { class: 'kpi-grid' },
        kpi('取得価額の合計（ニ）', `${formatYen(r.total)}円`, `資産 ${r.items.length}件`),
        kpi('評価額の合計（参考）', `${formatYen(r.valueTotal)}円`, '市区町村が決めた価格が優先'),
        kpi('課税標準額（参考）', `${formatYen(r.taxBase)}円`, r.exempt ? `免税点（${formatYen(PT_EXEMPTION)}円）未満` : '1,000円未満切捨て'),
        kpi('税額の見込み', r.exempt ? '0円' : `${formatYen(r.tax)}円`, r.exempt ? '課税されません（申告は必要）' : '標準税率 1.4%'),
      ),
      r.missingLife.length ? h('p', { class: 'notice', text: `耐用年数が入っていない資産があります（${r.missingLife.map((a) => a.name).join('・')}）。下の「資産ごとの設定」で耐用年数を入れると評価額を計算します。` }) : null,
      r.review.length ? h('p', { class: 'notice', text: `建物附属設備・車両は、申告の対象かどうかの確認が必要です（${r.review.map((x) => `${x.asset.name}：${x.include ? '対象' : '対象外'}`).join('・')}）。下の「資産ごとの設定」で変えられます。` }) : null,
      h('section', { class: 'fs-section' }, h('h3', { class: 'tf-title', text: '償却資産申告書（資産の種類ごとの集計）' }), kindsTable(r)),
      h('section', { class: 'fs-section' }, h('h3', { class: 'tf-title', text: '種類別明細書（全資産用）' }), r.items.length ? itemsTable(r) : h('p', { class: 'muted small', text: '申告する資産がありません。' }), h('p', { class: 'muted small', text: '「増」は前年中に取得した資産（増加資産用の明細書に書く資産）です。初めて申告するときは全資産を書きます。' })),
      r.decreases.length ? h('section', { class: 'fs-section' }, h('h3', { class: 'tf-title', text: '種類別明細書（減少資産用）' }), decreasesTable(r)) : null,
      r.excluded.length
        ? h('details', { class: 'panel small' }, h('summary', { text: `申告に入れていない資産（${r.excluded.length}件）` }), h('ul', { class: 'pt-excluded' }, r.excluded.map((x) => h('li', {}, h('strong', { text: x.asset.name }), `：${x.reason}`))))
        : null,
      h('details', { class: 'panel no-print', open: r.missingLife.length > 0 }, h('summary', { text: '資産ごとの設定（対象・種類・耐用年数）' }), errorsEl, settingsList()),
      h('div', { class: 'actions no-print' }, h('button', { type: 'button', class: 'btn', text: 'CSVで書き出す', onclick: () => saveFile(new Blob([propertyTaxCsv(r)], { type: 'text/csv' }), csvFileName('property-tax')) })),
    );
  }

  put(
    outlet,
    body,
    h(
      'div',
      { class: 'panel small muted' },
      h('p', { text: '固定資産台帳の資産を、賦課期日（1月1日）に持っているかどうかで振り分けます。前年1月2日〜1月1日に取得した資産が「前年中に取得したもの」、売却・除却した資産が「前年中に減少したもの」です。' }),
      h('p', { text: '評価額は 取得価額×（1−減価率÷2）（前年中の取得）、以後は 前年度の評価額×（1−減価率）で、取得価額の5%が下限です（固定資産評価基準 別表第15の減価率）。実際の税額は市区町村が決める価格と税率（標準1.4%）で計算されます。' }),
      h('p', { text: '対象外：建物・無形固定資産・自動車税等の対象の車両・一括償却資産・10万円未満で全額を経費にした資産。中小企業者等の少額減価償却資産の特例（30万円・40万円未満）で経費にした資産は申告の対象です。' }),
      h('p', { text: '対応していないもの：短縮耐用年数・増加償却・課税標準の特例・非課税・改良費の区分・中古資産の見積耐用年数（台帳の耐用年数を使います）・複数の市区町村への振り分け。個人の家事兼用の資産は取得価額の全額で計算しています。' }),
    ),
  );
  paint();
}
