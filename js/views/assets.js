// 固定資産台帳：台帳・増減明細・償却予定・月次償却・取得と除売却を切り替えて見る。状態・科目・種類・部門・文字で絞り込み、集計の単位と並び順を選ぶ
import { h, put, emptyState, amountCell, saveFile, stackTable, segmented, showToast, confirmDialog, errorBox } from '../ui.js';
import { assetRegister, smeUsage, depreciationSchedule, methodLabel, usesLife, CATEGORY_BY_ID, ASSET_CATEGORIES } from '../depreciation.js';
import {
  registerDetail,
  otherStatus,
  matchAsset,
  groupDetails,
  sortDetails,
  sumDetails,
  depreciationForecast,
  monthlyTable,
  disposalList,
  bookedDepreciation,
  monthlyDepreciationLines,
  monthEnd,
  ASSET_STATUSES,
  STATUS_BY_ID,
  GROUP_KEYS,
  SORT_KEYS,
} from '../asset-reports.js';
import { formatYen } from '../money.js';
import { formatPeriod } from '../period.js';
import { createJournal } from '../models.js';
import { validateJournal, journalLabel } from '../journal.js';
import { errorText } from '../errors.js';
import { compareAccounts } from '../accounts.js';
import { compareDepartments } from '../departments.js';
import { toCsv, csvFileName, assetsCsv } from '../csv.js';
import { assetRegisterDoc, movementDoc, forecastDoc, monthlyDoc, acquiredDoc, disposedDoc, rangeLabel, ASSET_DOCS } from '../print-assets.js';

const slash = (d) => (d ? d.replaceAll('-', '/') : '');
const DISPOSAL = { sell: '売却', retire: '除却' };
const VIEWS = [
  { value: 'register', label: '台帳' },
  { value: 'movement', label: '増減明細' },
  { value: 'forecast', label: '償却予定' },
  { value: 'monthly', label: '月次償却' },
  { value: 'changes', label: '取得・除売却' },
];

export async function render({ app, outlet, query = {} }) {
  const { settings, period, accounts, subAccounts, journals, accountById, departments, departmentById } = await app.load();
  const [assets, periods] = await Promise.all([app.db.listAssets(), app.db.listPeriods()]);
  const individual = settings.entityType === 'individual';
  const register = assetRegister(assets, periods, period);
  const allDetails = register.map((x) => registerDetail(x, period));
  const shown = new Set(register.map((x) => x.asset.id));
  const byId = new Map(assets.map((a) => [a.id, a]));
  // 台帳に出ない資産（償却が終わった・除却した・まだ使っていない）。一部の売却・除却で分けた資産は、分けた期間より前は元の資産に含まれるので出さない
  const others = assets.filter((a) => !shown.has(a.id) && !(a.splitFrom && a.carryOn && period.startDate < a.carryOn)).map((a) => ({ asset: a, status: otherStatus(a, period) }));
  const sme = smeUsage(assets, period);
  const names = { accountById, departmentById };

  // 表示の条件（URL に残して、編集から戻ったときも同じ条件で開く）
  const st = {
    view: VIEWS.some((v) => v.value === query.view) ? query.view : 'register',
    status: query.status && (STATUS_BY_ID[query.status] || query.status === 'all') ? query.status : '',
    q: query.q || '',
    group: GROUP_KEYS.some((g) => g.id === query.group) ? query.group : 'account',
    sort: SORT_KEYS.some((s) => s.id === query.sort) ? query.sort : 'no',
    accountId: query.account || '',
    category: query.category || '',
    departmentId: query.department || '',
    years: query.years === '10' ? 10 : 5,
  };
  const filterOf = () => ({ statuses: st.status && st.status !== 'all' ? [st.status] : [], q: st.q, accountId: st.accountId, category: st.category, departmentId: st.departmentId });
  const details = () => allDetails.filter((d) => matchAsset(d.asset, d.status, filterOf()));
  const otherList = () => others.filter((o) => (st.status === '' || st.status === 'all' || st.status === o.status) && matchAsset(o.asset, o.status, { ...filterOf(), statuses: [] }));
  function syncUrl() {
    const p = new URLSearchParams();
    if (st.view !== 'register') p.set('view', st.view);
    if (st.status) p.set('status', st.status);
    if (st.q) p.set('q', st.q);
    if (st.group !== 'account') p.set('group', st.group);
    if (st.sort !== 'no') p.set('sort', st.sort);
    if (st.accountId) p.set('account', st.accountId);
    if (st.category) p.set('category', st.category);
    if (st.departmentId) p.set('department', st.departmentId);
    if (st.years !== 5) p.set('years', String(st.years));
    const s = p.toString();
    history.replaceState(history.state, '', `#/assets${s ? `?${s}` : ''}`);
  }
  const set = (k, v) => {
    st[k] = v;
    syncUrl();
    paint();
  };

  // ---- 絞り込み・集計・並び順 ----
  const select = (id, label, value, choices, onChange) =>
    h('label', { class: 'asset-filter', for: id }, h('span', { class: 'muted small', text: label }), h('select', { id, onchange: (e) => onChange(e.target.value) }, choices.map(([v, t]) => h('option', { value: v, text: t, selected: v === value }))));
  const usedAccounts = accounts.filter((a) => assets.some((x) => x.accountId === a.id)).sort(compareAccounts);
  const usedCats = ASSET_CATEGORIES.filter((c) => assets.some((x) => x.category === c.id));
  const usedDeps = departments.filter((d) => assets.some((x) => x.departmentId === d.id)).sort(compareDepartments);
  const search = h('input', { type: 'search', class: 'search-input', id: 'asset-q', placeholder: '名前・資産番号・設置場所・購入先・メモ', 'aria-label': '固定資産を検索', value: st.q, enterkeyhint: 'search', oninput: (e) => set('q', e.target.value) });
  const filters = h(
    'div',
    { class: 'asset-filters no-print' },
    search,
    h(
      'details',
      { class: 'asset-more', open: Boolean(st.status || st.accountId || st.category || st.departmentId || st.group !== 'account' || st.sort !== 'no') },
      h('summary', { text: '絞り込み・集計の単位・並び順' }),
      h(
      'div',
      { class: 'asset-filter-row' },
      select('asset-status', '状態', st.status, [['', '当期の台帳（すべて）'], ...ASSET_STATUSES.map((s) => [s.id, s.label])], (v) => set('status', v)),
      usedAccounts.length > 1 ? select('asset-account', '勘定科目', st.accountId, [['', 'すべて'], ...usedAccounts.map((a) => [a.id, a.name])], (v) => set('accountId', v)) : null,
      usedCats.length > 1 ? select('asset-category', '種類', st.category, [['', 'すべて'], ...usedCats.map((c) => [c.id, c.label])], (v) => set('category', v)) : null,
      usedDeps.length ? select('asset-department', '部門', st.departmentId, [['', 'すべて'], ...usedDeps.map((d) => [d.id, d.name])], (v) => set('departmentId', v)) : null,
      select('asset-group', '集計の単位', st.group, GROUP_KEYS.filter((g) => g.id !== 'department' || departments.length).map((g) => [g.id, `${g.label}ごと`]), (v) => set('group', v)),
      select('asset-sort', '並び順', st.sort, SORT_KEYS.map((s) => [s.id, s.label]), (v) => set('sort', v)),
      ),
    ),
  );
  const tabs = h('div', { class: 'asset-tabs no-print' }, segmented({ name: '固定資産の帳票', options: VIEWS, value: st.view, onChange: (v) => set('view', v) }));
  const body = h('div');

  // ---- 印刷：帳票の種類・集計の単位・並び順を選ぶ（初めは画面で見ている帳票）----
  const docKey = () => ({ register: 'register', movement: 'movement', forecast: st.years === 10 ? 'forecast10' : 'forecast', monthly: 'monthly', changes: 'acquired' })[st.view];
  app.printDoc = ({ head }) =>
    assets.length
      ? {
          options: [
            { key: 'doc', label: '帳票', type: 'select', choices: ASSET_DOCS, value: docKey() },
            { key: 'group', label: '集計の単位', type: 'select', choices: GROUP_KEYS.map((g) => [g.id, `${g.label}ごと`]), value: st.group },
            { key: 'sort', label: '並び順', type: 'select', choices: SORT_KEYS.map((s) => [s.id, s.label]), value: st.sort },
            { key: 'filtered', label: '画面の絞り込みを使う', type: 'check', value: true },
          ],
          build: (v) => {
            const list = v.filtered ? details() : allDetails;
            const ids = new Set(list.map((d) => d.asset.id));
            const opts = { accountById, departmentById, individual, head, groupBy: v.group, sortBy: v.sort };
            if (v.doc === 'movement') return movementDoc(list, opts);
            if (v.doc === 'forecast' || v.doc === 'forecast10') return forecastDoc(assets, periods, period, { ...opts, years: v.doc === 'forecast10' ? 10 : 5, filter: (a) => !v.filtered || matchAsset(a, '', { ...filterOf(), statuses: [] }) });
            if (v.doc === 'monthly') return monthlyDoc(register.filter((x) => ids.has(x.asset.id)), period, opts);
            if (v.doc === 'acquired') return acquiredDoc(list, opts);
            if (v.doc === 'disposed') return disposedDoc(list, opts);
            return assetRegisterDoc(register, { ...opts, period, details: list });
          },
        }
      : null;

  // ---- 共通の部品 ----
  const cell = (n, opts) => amountCell('td', n, opts);
  const nameCell = (a) => h('th', { scope: 'row' }, h('a', { class: 'link', href: `#/asset/${encodeURIComponent(a.id)}`, text: a.assetNo ? `${a.assetNo}　${a.name}` : a.name }));
  const tableOf = (caption, heads, rows, foot, { labels, cls = '' } = {}) =>
    h(
      'div',
      { class: 'table-wrap' },
      stackTable(
        h('table', { class: `report asset-table ${cls}` }, caption ? h('caption', { text: caption }) : null, h('thead', {}, h('tr', {}, heads.map((t) => h('th', { scope: 'col', text: t })))), h('tbody', {}, rows), foot ? h('tfoot', {}, foot) : null),
        labels,
      ),
    );
  const csvButton = (label, make, kind) => h('button', { type: 'button', class: 'btn', text: label, onclick: () => saveFile(new Blob([make()], { type: 'text/csv' }), csvFileName(kind)) });
  const relation = (a) => (a.parentId ? `「${byId.get(a.parentId)?.name ?? '元の資産'}」の資本的支出` : a.splitFrom ? `「${byId.get(a.splitFrom)?.name ?? '元の資産'}」から分けた一部` : '');
  const empty = () => h('p', { class: 'muted small', text: '条件に合う固定資産はありません。' });

  // ---- 台帳：集計の単位ごとの合計と、資産のカード ----
  function registerView(list) {
    const groups = groupDetails(list, st.group, names);
    const total = sumDetails(list);
    const label = GROUP_KEYS.find((g) => g.id === st.group).label;
    const sumRow = (head, s, count) => h('tr', {}, h('th', { scope: 'row' }, head, count != null ? h('span', { class: 'muted small block', text: `${count}件` }) : null), cell(s.costClosing + s.costDecrease), cell(s.bookOpening), cell(s.bookIncrease - s.bookDecrease), cell(s.amount), cell(s.bookClosing), cell(s.accumulatedClosing));
    const summary = tableOf(
      `${label}ごとの合計`,
      [label, '取得価額', '期首', '増減', '償却費', '期末', '累計額'],
      groups.map((g) => sumRow(g.label, g.sum, g.items.length)),
      groups.length > 1 ? sumRow('計', total) : null,
      { cls: 'asset-sum' },
    );
    const card = (d) => {
      const { asset, cost } = d;
      return h(
        'li',
        {},
        h(
          'a',
          { class: 'acc-row asset-row', href: `#/asset/${encodeURIComponent(asset.id)}` },
          h(
            'span',
            { class: 'acc-main' },
            h('span', { class: 'acc-title', text: asset.assetNo ? `${asset.assetNo}　${asset.name}` : asset.name }),
            h(
              'span',
              { class: 'acc-tags' },
              d.status !== 'active' && d.status !== 'nondep' ? h('span', { class: d.status === 'disposed' ? 'badge badge-warn' : 'badge', text: d.status === 'disposed' ? `${DISPOSAL[asset.disposalType] ?? '除却'} ${slash(asset.disposedOn)}` : STATUS_BY_ID[d.status].label }) : null,
              h('span', { class: 'badge', text: methodLabel(asset) || asset.method }),
              asset.specialRate ? h('span', { class: 'badge', text: asset.specialRate === 100 ? '即時償却' : `特別償却${asset.specialRate}%` }) : null,
              usesLife(asset.method) && asset.usefulLife ? h('span', { class: 'muted small', text: `${asset.usefulLife}年${d.row?.rate ? `・${(d.row.rate / 1000).toFixed(3)}` : ''}${d.months && d.months < 12 ? `・${d.months}か月` : ''}` }) : null,
              individual && asset.businessRatio < 100 ? h('span', { class: 'badge', text: `事業${asset.businessRatio}%` }) : null,
              asset.quantity > 1 ? h('span', { class: 'muted small', text: `${asset.quantity}個` }) : null,
              asset.parentId ? h('span', { class: 'badge', text: '資本的支出' }) : null,
              asset.splitFrom ? h('span', { class: 'badge', text: '一部' }) : null,
              asset.splits?.length && cost !== asset.cost + asset.splits.reduce((t, sp) => t + sp.cost, 0) ? h('span', { class: 'badge', text: '一部を売却・除却' }) : null,
            ),
            relation(asset) ? h('span', { class: 'muted small', text: relation(asset) }) : null,
            h('span', { class: 'muted small', text: [accountById.get(asset.accountId)?.name ?? '', `${slash(asset.startedOn)} から使用`, `取得価額 ${formatYen(cost)}円`, asset.location, asset.departmentId ? departmentById.get(asset.departmentId)?.name : ''].filter(Boolean).join('・') }),
            h(
              'span',
              { class: 'asset-flow small' },
              h('span', { text: `期首 ${formatYen(d.bookOpening)}` }),
              d.bookIncrease ? h('span', { text: `取得 ${formatYen(d.bookIncrease)}` }) : null,
              h('span', { class: 'asset-dep', text: `償却 ${formatYen(d.amount)}` }),
              d.bookDecrease ? h('span', { text: `${DISPOSAL[asset.disposalType] ?? '除却'} ${formatYen(-d.bookDecrease)}` }) : null,
              h('span', { text: `期末 ${formatYen(d.bookClosing)}` }),
              h('span', { class: 'muted', text: `累計 ${formatYen(d.accumulatedClosing)}` }),
            ),
          ),
        ),
      );
    };
    return [
      list.length ? summary : null,
      list.length ? h('div', { class: 'actions no-print' }, csvButton('CSVで書き出す', () => assetsCsv(list, { accountById, departmentById, individual }), 'assets'), settings.entityType === 'corporation' ? h('a', { class: 'btn', href: '#/reports/schedule16', text: '別表十六を見る' }) : null) : null,
      ...groups.map((g) => [h('h2', { class: 'menu-group-title', text: `${g.label}（${g.items.length}件・償却費 ${formatYen(g.sum.amount)}円）` }), h('ul', { class: 'menu-group' }, sortDetails(g.items, st.sort).map(card))]),
      list.length ? null : st.status === '' || ['active', 'new', 'disposed'].includes(st.status) ? empty() : null,
    ];
  }

  /** 台帳に出ない資産（償却済み・除却済み・これから使う） */
  function othersView() {
    const list = otherList();
    if (!list.length || !['', 'all', 'done', 'future', 'gone'].includes(st.status)) return null;
    return [
      h('h2', { class: 'menu-group-title', text: 'そのほかの資産（償却済み・除却済み・これから使う）' }),
      h(
        'ul',
        { class: 'menu-group' },
        list
          .sort((a, b) => (a.asset.startedOn < b.asset.startedOn ? 1 : -1))
          .map(({ asset: a, status }) => {
            const last = depreciationSchedule(a, periods).at(-1);
            const state = status === 'future' ? `${slash(a.startedOn)} から使用` : status === 'gone' ? `${slash(a.disposedOn)} に${DISPOSAL[a.disposalType] ?? '除却'}` : '償却済み';
            return h(
              'li',
              {},
              h(
                'a',
                { class: 'acc-row asset-plain', href: `#/asset/${encodeURIComponent(a.id)}` },
                h('span', { class: 'acc-main' }, h('span', { class: 'acc-title', text: a.assetNo ? `${a.assetNo}　${a.name}` : a.name }), h('span', { class: 'muted small', text: `${CATEGORY_BY_ID[a.category]?.label ?? ''}・${state}・帳簿価額 ${formatYen(status === 'gone' ? 0 : last && a.startedOn <= period.endDate ? last.closing : a.cost)}円` })),
              ),
            );
          }),
      ),
    ];
  }

  // ---- 増減明細：取得価額と帳簿価額の 期首・増加・減少・期末 ----
  function movementView(list) {
    if (!list.length) return empty();
    const heads = ['資産', '取得価額 期首', '取得価額 増加', '取得価額 減少', '取得価額 期末', '帳簿価額 期首', '帳簿価額 増加', '帳簿価額 減少', '償却費', '帳簿価額 期末', '累計額 期末'];
    const nums = (s) => [s.costOpening, s.costIncrease, s.costDecrease, s.costClosing, s.bookOpening, s.bookIncrease, s.bookDecrease, s.amount, s.bookClosing, s.accumulatedClosing].map((n) => cell(n, { blankZero: true }));
    const rows = [];
    const groups = groupDetails(list, st.group, names);
    for (const g of groups) {
      rows.push(h('tr', { class: 'tb-group' }, h('th', { colspan: heads.length, scope: 'colgroup', text: g.label })));
      for (const d of sortDetails(g.items, st.sort)) rows.push(h('tr', {}, nameCell(d.asset), ...nums(d)));
      if (groups.length > 1) rows.push(h('tr', { class: 'mt-strong' }, h('th', { scope: 'row', text: `${g.label} 計` }), ...nums(g.sum)));
    }
    const total = sumDetails(list);
    const csv = () =>
      toCsv([
        ['資産番号', '資産名', '勘定科目', '取得価額（期首）', '取得価額（増加）', '取得価額（減少）', '取得価額（期末）', '帳簿価額（期首）', '帳簿価額（増加）', '帳簿価額（減少）', '償却費', '帳簿価額（期末）', '減価償却累計額（期首）', '減価償却累計額（期末）'],
        ...sortDetails(list, st.sort).map((d) => [d.asset.assetNo || '', d.asset.name, accountById.get(d.asset.accountId)?.name ?? '', d.costOpening, d.costIncrease, d.costDecrease, d.costClosing, d.bookOpening, d.bookIncrease, d.bookDecrease, d.amount, d.bookClosing, d.accumulatedOpening, d.accumulatedClosing]),
      ]);
    return [
      h('p', { class: 'muted small', text: '期首帳簿価額＋増加−償却費−減少＝期末帳簿価額。減少は売却・除却した日の帳簿価額、累計額は取得価額−帳簿価額です。' }),
      tableOf('', heads, rows, h('tr', { class: 'mt-strong' }, h('th', { scope: 'row', text: '合計' }), ...nums(total)), { labels: ['資産', '取得 期首', '取得 増加', '取得 減少', '取得 期末', '帳簿 期首', '帳簿 増加', '帳簿 減少', '償却費', '帳簿 期末', '累計額'], cls: 'asset-wide' }),
      h('div', { class: 'actions no-print' }, csvButton('CSVで書き出す', csv, 'asset-movement')),
    ];
  }

  // ---- 償却予定：当期から5年（10年）分 ----
  function forecastView() {
    const f = depreciationForecast(assets, periods, period, st.years);
    const rows0 = f.rows.filter((r) => matchAsset(r.asset, '', { ...filterOf(), statuses: [] }));
    const yearsSel = segmented({ name: '予定の年数', options: [{ value: 5, label: '5年' }, { value: 10, label: '10年' }], value: st.years, onChange: (v) => set('years', v) });
    if (!rows0.length) return [yearsSel, empty()];
    const heads = ['資産', ...f.ranges.map(rangeLabel), `${rangeLabel(f.ranges.at(-1))}末の帳簿価額`];
    const items = rows0.map((r) => ({ ...r, cost: r.asset.cost, status: '' }));
    const sorted = sortDetails(items, st.sort);
    const rows = sorted.map((r) => h('tr', {}, nameCell(r.asset), ...r.amounts.map((n) => cell(n, { blankZero: true })), cell(r.closing.at(-1))));
    const tot = f.ranges.map((_, i) => rows0.reduce((s, r) => s + r.amounts[i], 0));
    const csv = () => toCsv([['資産番号', '資産名', '勘定科目', '取得価額', ...f.ranges.map(rangeLabel), '期末帳簿価額（最後の年）'], ...sorted.map((r) => [r.asset.assetNo || '', r.asset.name, accountById.get(r.asset.accountId)?.name ?? '', r.asset.cost, ...r.amounts, r.closing.at(-1)])]);
    return [
      yearsSel,
      h('p', { class: 'muted small', text: '登録済みの資産を今の条件のまま償却したときの予定額です（これから取得・売却する資産は含みません）。' }),
      tableOf('', heads, rows, h('tr', { class: 'mt-strong' }, h('th', { scope: 'row', text: '合計' }), ...tot.map((n) => cell(n)), cell(rows0.reduce((s, r) => s + r.closing.at(-1), 0))), { cls: 'asset-wide' }),
      h('div', { class: 'actions no-print' }, csvButton('CSVで書き出す', csv, 'asset-forecast')),
    ];
  }

  // ---- 月次償却：当期の償却費を月に割り振る ----
  function monthlyView(list) {
    const ids = new Set(list.map((d) => d.asset.id));
    const m = monthlyTable(register.filter((x) => ids.has(x.asset.id)), period);
    if (!m.rows.length) return empty();
    const mLabel = (mm) => `${mm.slice(0, 4)}年${Number(mm.slice(5))}月`;
    const booked = bookedDepreciation(journals);
    const mark = (mm) => (booked.annual ? '年1回で登録済み' : booked.months.has(mm) ? '登録済み' : '');
    const monthRows = m.months.map((mm, i) => h('tr', {}, h('th', { scope: 'row', text: mLabel(mm) }), cell(m.totals[i]), individual ? cell(m.businessTotals[i]) : null, h('td', { class: 'small', text: mark(mm) })));
    const items = sortDetails(m.rows.map((r) => ({ ...r, cost: r.asset.cost })), st.sort);
    const csv = () => toCsv([['資産番号', '資産名', '勘定科目', ...m.months.map(mLabel), '合計'], ...items.map((r) => [r.asset.assetNo || '', r.asset.name, accountById.get(r.asset.accountId)?.name ?? '', ...r.amounts, r.total]), ['', '合計', '', ...m.totals, m.total]]);
    return [
      h('p', { class: 'muted small', text: '当期の償却費を、償却する月（使い始めた月から、売却・除却した月まで）に均等に割り振った額です。月次決算で月割りの償却費を見積もるときに使います。端数は後の月に寄せ、特別償却は最後の月に入れています。' }),
      tableOf('月ごとの合計', ['月', '償却費', ...(individual ? ['うち経費'] : []), '仕訳'], monthRows, h('tr', { class: 'mt-strong' }, h('th', { scope: 'row', text: '合計' }), cell(m.total), individual ? cell(m.businessTotals.reduce((a, b) => a + b, 0)) : null, h('td'))),
      postPanel(booked),
      tableOf('資産ごとの月別', ['資産', ...m.months.map((mm) => `${Number(mm.slice(5))}月`), '合計'], items.map((r) => h('tr', {}, nameCell(r.asset), ...r.amounts.map((n) => cell(n, { blankZero: true })), cell(r.total))), null, { cls: 'asset-wide asset-monthly' }),
      h('div', { class: 'actions no-print' }, csvButton('CSVで書き出す', csv, 'asset-monthly')),
    ];
  }

  /**
   * 月次償却の仕訳の登録：選んだ月までの、まだ登録していない月を、月ごとに月末日の仕訳で登録する（決算整理にはしない）
   * 期末に「決算・繰越」で残りの月の分を登録する。絞り込みにかかわらず、すべての資産で計算する
   */
  function postPanel(booked) {
    if (booked.annual) return h('p', { class: 'muted small', text: 'この期間の減価償却は、決算・繰越で年1回の仕訳を登録済みです。月次で登録するときは、その仕訳を削除してから登録してください。' });
    const all = monthlyTable(register, period);
    const open = all.months.filter((mm, i) => !booked.months.has(mm) && all.totals[i]);
    if (!open.length) return h('p', { class: 'muted small', text: booked.months.size ? 'すべての月の減価償却を登録済みです。' : 'この期間に償却費はありません。' });
    const errorsEl = h('div');
    const label = (mm) => `${mm.slice(0, 4)}年${Number(mm.slice(5))}月`;
    const until = h('select', { id: 'dep-until', 'aria-label': '登録する月' }, open.map((mm) => h('option', { value: mm, text: `${label(mm)}まで` })));
    const post = async () => {
      const targets = open.filter((mm) => mm <= until.value);
      const plans = targets.map((mm) => ({ month: mm, ...monthlyDepreciationLines({ assets, periods, period, accounts, entityType: settings.entityType, departments, months: [mm] }) }));
      const errors = [...new Set(plans.flatMap((p) => p.errors))];
      if (errors.length) return put(errorsEl, errorBox(errors));
      const total = plans.reduce((t, p) => t + p.total, 0);
      const ok = await confirmDialog({
        title: '月次償却の仕訳を登録',
        message: `${targets.map((mm) => `${Number(mm.slice(5))}月`).join('・')} の減価償却（合計 ${formatYen(total)}円）を、月ごとに月末日の仕訳で登録します。`,
        buttons: [{ label: 'キャンセル', value: false }, { label: '登録する', value: true, variant: 'primary' }],
      });
      if (!ok) return;
      try {
        let last = null;
        for (const p of plans) {
          if (!p.total) continue;
          // 月次の償却は決算整理ではない（月次推移で各月に入れる）。depMonths で計上済みの月を残し、期末は残りの月だけを登録する
          const journal = createJournal({ periodId: period.id, date: monthEnd(p.month, period), lines: p.lines, source: 'depreciation', depMonths: [p.month], adjusting: false });
          const v = validateJournal(journal, { accounts, subAccounts, period, departments });
          if (v.length) return put(errorsEl, errorBox(v));
          last = await app.db.saveJournal(journal);
        }
        showToast(last ? `月次償却の仕訳を${plans.filter((p) => p.total).length}件登録しました（最後は${journalLabel(last)}）` : '登録する償却費はありませんでした');
        app.refresh();
      } catch (e) {
        put(errorsEl, errorBox([errorText(e, '保存')]));
      }
    };
    return h(
      'section',
      { class: 'panel no-print' },
      h('h2', { class: 'section-title', text: '月次償却の仕訳' }),
      h('p', { class: 'small', text: '毎月の試算表に減価償却費を入れるときは、月ごとに月末日の仕訳で登録します。残りの月の分は、期末に「決算・繰越」でまとめて登録します。資産を直したら、登録した仕訳を削除して登録し直してください。' }),
      h('div', { class: 'inline-inputs' }, until, h('button', { type: 'button', class: 'btn btn-primary', text: 'まだの月を登録する', onclick: post })),
      errorsEl,
    );
  }

  // ---- 取得・除売却：当期に取得した資産と、売却・除却した資産 ----
  function changesView(list) {
    const acquired = sortDetails(list.filter((d) => d.costIncrease), 'date');
    const disposed = disposalList(list);
    const acqTable = acquired.length
      ? tableOf(
          `当期に取得した資産（${acquired.length}件）`,
          ['資産', '使い始めた日', '取得価額', '償却方法', '当期償却費', '購入先'],
          acquired.map((d) => h('tr', {}, nameCell(d.asset), h('td', { class: 'nowrap', text: slash(d.asset.startedOn) }), cell(d.cost), h('td', { text: `${methodLabel(d.asset) || d.asset.method}${usesLife(d.asset.method) && d.asset.usefulLife ? ` ${d.asset.usefulLife}年` : ''}` }), cell(d.amount), h('td', { text: d.asset.supplier || '' }))),
          h('tr', { class: 'mt-strong' }, h('th', { scope: 'row', text: '合計' }), h('td'), cell(acquired.reduce((s, d) => s + d.cost, 0)), h('td'), cell(acquired.reduce((s, d) => s + d.amount, 0)), h('td')),
        )
      : h('p', { class: 'muted small', text: '当期に取得した資産はありません。' });
    const dispTable = disposed.length
      ? tableOf(
          `当期に売却・除却した資産（${disposed.length}件）`,
          ['資産', '日付', '区分', '取得価額', '帳簿価額', '売却額', '売却益（△損）'],
          disposed.map((d) => h('tr', {}, nameCell(d.asset), h('td', { class: 'nowrap', text: slash(d.date) }), h('td', { text: DISPOSAL[d.type] }), cell(d.cost), cell(d.bookDecrease), d.type === 'sell' ? cell(d.price) : h('td'), cell(d.gainLoss))),
          h('tr', { class: 'mt-strong' }, h('th', { scope: 'row', text: '合計' }), h('td'), h('td'), cell(disposed.reduce((s, d) => s + d.cost, 0)), cell(disposed.reduce((s, d) => s + d.bookDecrease, 0)), cell(disposed.reduce((s, d) => s + d.price, 0)), cell(disposed.reduce((s, d) => s + d.gainLoss, 0))),
        )
      : h('p', { class: 'muted small', text: '当期に売却・除却した資産はありません。' });
    return [acqTable, dispTable, disposed.length ? h('p', { class: 'muted small', text: '売却益（△損）＝売却額−売却した日の帳簿価額。除却は帳簿価額がそのまま除却損です。' }) : null];
  }

  function paint() {
    const list = details();
    const total = list.reduce((s, d) => s + d.amount, 0);
    const business = list.reduce((s, d) => s + d.business, 0);
    const closing = list.reduce((s, d) => s + d.bookClosing, 0);
    const filtered = Boolean(st.q || st.status || st.accountId || st.category || st.departmentId);
    put(
      body,
      h(
        'section',
        { class: 'panel' },
        h(
          'div',
          { class: 'stat-grid' },
          h('div', { class: 'stat' }, h('span', { class: 'stat-label', text: 'この期間の償却費' }), h('span', { class: 'stat-value num', text: `${formatYen(total)}円` })),
          individual ? h('div', { class: 'stat' }, h('span', { class: 'stat-label', text: 'うち経費になる額' }), h('span', { class: 'stat-value num', text: `${formatYen(business)}円` })) : null,
          h('div', { class: 'stat' }, h('span', { class: 'stat-label', text: '期末の帳簿価額' }), h('span', { class: 'stat-value num', text: `${formatYen(closing)}円` })),
          h('div', { class: 'stat' }, h('span', { class: 'stat-label', text: filtered ? '条件に合う資産' : '当期の台帳の資産' }), h('span', { class: 'stat-value num', text: `${list.length}件` })),
        ),
        h('p', { class: 'small' }, '決算整理の仕訳は ', h('a', { href: '#/closing', class: 'link', text: '決算・繰越' }), ' の画面から期末日の日付で登録します。'),
      ),
      sme.over ? h('p', { class: 'notice', text: `少額減価償却資産の特例の合計（${formatYen(sme.total)}円）が、この期間の上限 ${formatYen(sme.limit)}円 を超えています。超える分は通常の減価償却か一括償却にしてください。` }) : null,
      st.view === 'register' ? [registerView(list), othersView()] : null,
      st.view === 'movement' ? movementView(list) : null,
      st.view === 'forecast' ? forecastView() : null,
      st.view === 'monthly' ? monthlyView(list) : null,
      st.view === 'changes' ? changesView(list) : null,
    );
  }

  put(
    outlet,
    h('p', { class: 'muted small', text: `会計期間 ${formatPeriod(period)}` }),
    h('div', { class: 'actions no-print' }, h('a', { href: '#/asset/new', class: 'btn btn-primary', text: '＋ 固定資産を追加' })),
    assets.length ? [tabs, filters, body] : emptyState('パソコン・車・設備など、長く使う高額なものを登録すると、減価償却費を毎年計算します。', h('a', { href: '#/asset/new', class: 'btn btn-primary', text: '固定資産を追加' }), { title: '固定資産はまだありません' }),
    h('p', { class: 'muted small', text: '償却費は国税庁の償却率表（旧定額法・旧定率法・定額法・250%定率法・200%定率法）で計算します。1円未満は切り捨てます。' }),
  );
  if (assets.length) paint();
}
