// 固定資産台帳：この会計期間の期首帳簿価額・償却費・期末帳簿価額
import { h, put, emptyState, amountCell, saveFile } from '../ui.js';
import { assetRegister, smeUsage, depreciationSchedule, methodLabel, CATEGORY_BY_ID } from '../depreciation.js';
import { formatYen } from '../money.js';
import { formatPeriod } from '../period.js';
import { registerByAccount } from '../asset-tools.js';
import { assetsCsv, csvFileName } from '../csv.js';

const slash = (d) => d.replaceAll('-', '/');

export async function render({ app, outlet }) {
  const { settings, period, accountById } = await app.load();
  const [assets, periods] = await Promise.all([app.db.listAssets(), app.db.listPeriods()]);
  const individual = settings.entityType === 'individual';
  const register = assetRegister(assets, periods, period);
  const shown = new Set(register.map((x) => x.asset.id));
  const byId = new Map(assets.map((a) => [a.id, a]));
  // 台帳に出ない資産（償却が終わった・除却した・まだ使っていない）。一部の売却・除却で分けた資産は、分けた期間より前は元の資産に含まれるので出さない
  const others = assets.filter((a) => !shown.has(a.id) && !(a.splitFrom && a.carryOn && period.startDate < a.carryOn)).sort((a, b) => (a.startedOn < b.startedOn ? 1 : -1));
  const total = register.reduce((s, x) => s + (x.row?.amount || 0), 0);
  const business = register.reduce((s, x) => s + (x.row?.business || 0), 0);
  const sme = smeUsage(assets, period);
  const DISPOSAL = { sell: '売却', retire: '除却' };
  const byAccount = registerByAccount(register);
  const csv = () => saveFile(new Blob([assetsCsv(register, { accountById, individual })], { type: 'text/csv' }), csvFileName('assets'));
  const summary = () =>
    h(
      'div',
      { class: 'table-wrap' },
      h(
        'table',
        { class: 'report asset-sum' },
        h('caption', { text: '科目別の合計' }),
        h('thead', {}, h('tr', {}, ['科目', '取得価額', '期首', '償却費', '期末'].map((t) => h('th', { scope: 'col', text: t })))),
        h(
          'tbody',
          {},
          byAccount.map((s) => h('tr', {}, h('th', { scope: 'row' }, accountById.get(s.accountId)?.name ?? '', h('span', { class: 'muted small block', text: `${s.count}件` })), amountCell('td', s.cost), amountCell('td', s.opening), amountCell('td', s.amount), amountCell('td', s.closing))),
        ),
        byAccount.length > 1
          ? h(
              'tfoot',
              {},
              h('tr', {}, h('th', { text: '計' }), ...['cost', 'opening', 'amount', 'closing'].map((k) => amountCell('td', byAccount.reduce((t, s) => t + s[k], 0)))),
            )
          : null,
      ),
    );

  // 資本的支出・一部の売却除却の関係（元の資産の名前）
  const relation = (a) => (a.parentId ? `「${byId.get(a.parentId)?.name ?? '元の資産'}」の資本的支出` : a.splitFrom ? `「${byId.get(a.splitFrom)?.name ?? '元の資産'}」から分けた一部` : '');
  const card = ({ asset, cost, opening, row, closing }) =>
    h(
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
            h('span', { class: 'badge', text: methodLabel(asset) || asset.method }),
            asset.specialRate ? h('span', { class: 'badge', text: asset.specialRate === 100 ? '即時償却' : `特別償却${asset.specialRate}%` }) : null,
            asset.usefulLife && (asset.method === 'straight' || asset.method === 'declining') ? h('span', { class: 'muted small', text: `${asset.usefulLife}年` }) : null,
            individual && asset.businessRatio < 100 ? h('span', { class: 'badge', text: `事業${asset.businessRatio}%` }) : null,
            asset.disposedOn ? h('span', { class: 'badge badge-warn', text: `${DISPOSAL[asset.disposalType] ?? '除却'} ${slash(asset.disposedOn)}` }) : null,
            asset.quantity > 1 ? h('span', { class: 'muted small', text: `${asset.quantity}個` }) : null,
            asset.parentId ? h('span', { class: 'badge', text: '資本的支出' }) : null,
            asset.splitFrom ? h('span', { class: 'badge', text: '一部' }) : null,
            asset.splits?.length && cost !== asset.cost + asset.splits.reduce((t, sp) => t + sp.cost, 0) ? h('span', { class: 'badge', text: '一部を売却・除却' }) : null,
          ),
          relation(asset) ? h('span', { class: 'muted small', text: relation(asset) }) : null,
          h('span', { class: 'muted small', text: `${accountById.get(asset.accountId)?.name ?? ''}・${slash(asset.startedOn)} から使用・取得価額 ${formatYen(cost ?? asset.cost)}円` }),
          h(
            'span',
            { class: 'asset-flow small' },
            h('span', { text: `期首 ${formatYen(opening)}` }),
            h('span', { class: 'asset-dep', text: `償却 ${formatYen(row?.amount || 0)}` }),
            h('span', { text: `期末 ${formatYen(closing)}` }),
          ),
        ),
      ),
    );

  put(
    outlet,
    h('p', { class: 'muted small', text: `会計期間 ${formatPeriod(period)}` }),
    h('div', { class: 'actions no-print' }, h('a', { href: '#/asset/new', class: 'btn btn-primary', text: '＋ 固定資産を追加' })),
    assets.length
      ? h(
          'section',
          { class: 'panel' },
          h('div', { class: 'stat-grid' },
            h('div', { class: 'stat' }, h('span', { class: 'stat-label', text: 'この期間の償却費' }), h('span', { class: 'stat-value num', text: `${formatYen(total)}円` })),
            individual ? h('div', { class: 'stat' }, h('span', { class: 'stat-label', text: 'うち経費になる額' }), h('span', { class: 'stat-value num', text: `${formatYen(business)}円` })) : null,
          ),
          h('p', { class: 'small' }, '決算整理の仕訳は ', h('a', { href: '#/closing', class: 'link', text: '決算・繰越' }), ' の画面から期末日の日付で登録します。'),
        )
      : null,
    sme.over ? h('p', { class: 'notice', text: `少額減価償却資産の特例の合計（${formatYen(sme.total)}円）が、この期間の上限 ${formatYen(sme.limit)}円 を超えています。超える分は通常の減価償却か一括償却にしてください。` }) : null,
    register.length
      ? [
          summary(),
          h('div', { class: 'actions no-print' }, h('button', { type: 'button', class: 'btn', text: 'CSVで書き出す', onclick: csv }), settings.entityType === 'corporation' ? h('a', { class: 'btn', href: '#/reports/schedule16', text: '別表十六を見る' }) : null),
          h('h2', { class: 'menu-group-title', text: 'この期間の固定資産' }),
          h('ul', { class: 'menu-group' }, register.map(card)),
        ]
      : assets.length
        ? h('p', { class: 'muted small', text: 'この期間に償却する固定資産はありません。' })
        : emptyState('パソコン・車・設備など、長く使う高額なものを登録すると、減価償却費を毎年計算します。', h('a', { href: '#/asset/new', class: 'btn btn-primary', text: '固定資産を追加' }), { title: '固定資産はまだありません' }),
    others.length
      ? [
          h('h2', { class: 'menu-group-title', text: 'そのほかの資産（償却済み・除却済み・これから使う）' }),
          h(
            'ul',
            { class: 'menu-group' },
            others.map((a) => {
              const last = depreciationSchedule(a, periods).at(-1);
              const state = a.startedOn > period.endDate ? `${slash(a.startedOn)} から使用` : a.disposedOn && a.disposedOn < period.startDate ? `${slash(a.disposedOn)} に${DISPOSAL[a.disposalType] ?? '除却'}` : '償却済み';
              return h(
                'li',
                {},
                h(
                  'a',
                  { class: 'acc-row asset-plain', href: `#/asset/${encodeURIComponent(a.id)}` },
                  h('span', { class: 'acc-main' }, h('span', { class: 'acc-title', text: a.name }), h('span', { class: 'muted small', text: `${CATEGORY_BY_ID[a.category]?.label ?? ''}・${state}・帳簿価額 ${formatYen(last && a.startedOn <= period.endDate ? last.closing : a.cost)}円` })),
                ),
              );
            }),
          ),
        ]
      : null,
    h('p', { class: 'muted small', text: '償却費は国税庁の償却率表（旧定額法・旧定率法・定額法・250%定率法・200%定率法）で計算します。1円未満は切り捨てます。' }),
  );
}
