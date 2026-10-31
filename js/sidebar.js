// PC 幅のサイドメニュー（css/desktop.css で 1024px 以上のときだけ表示する。スマホは下部タブのまま）
import { h, put } from './ui.js';
import { icon } from './icons.js';
import { formatPeriod } from './period.js';
import { visibleReportGroups } from './views/reports.js';

// [リンク, 名前, アイコン]
const DAILY = [
  ['#/entry', '取引を入力', 'expense'],
  ['#/journal/new', '振替伝票', 'journal'],
  ['#/journals', '仕訳帳', 'list'],
  ['#/cashbook', '出納帳', 'cashbook'],
  ['#/import/bank', '明細の取り込み', 'bank'],
  ['#/invoices', '請求書・見積書', 'invoice'],
  ['#/payroll', '給与計算', 'payroll'],
  ['#/templates', '定型仕訳', 'history'],
];
const SETTINGS = [
  ['#/closing', '決算・繰越', 'closing'],
  ['#/periods', '会計期間', 'calendar'],
  ['#/settings', '事業者の設定', 'settings'],
  ['#/accounts', '勘定科目', 'list'],
  ['#/opening', '期首残高', 'flag'],
  ['#/backup', 'バックアップ', 'backup'],
  ['#/more', 'その他', 'books'],
];
// 帳票のグループのうち、サイドメニューで最初から開いておくもの
const OPEN_REPORT_GROUPS = new Set(['帳簿', '決算書・分析']);
// 帳簿の出納帳・固定資産台帳は「日々の入力」「決算」と重なるので、帳票側からは外す
const SKIP = new Set(['#/cashbook']);

/**
 * サイドメニューの項目（純粋関数）
 * @returns {{ title: string|null, open: boolean, items: { href, label, icon }[] }[]}
 */
export function sidebarSections(settings) {
  const reports = visibleReportGroups(settings).map(([title, , items]) => ({
    title,
    open: OPEN_REPORT_GROUPS.has(title),
    items: items.filter(([href]) => !SKIP.has(href)).map(([href, label, , name]) => ({ href, label, icon: name })),
  }));
  const toItems = (list) => list.map(([href, label, name]) => ({ href, label, icon: name }));
  return [{ title: null, open: true, items: [{ href: '#/home', label: 'ホーム', icon: 'chart' }, { href: '#/advisor', label: '経営サポート', icon: 'pl' }] }, { title: '日々の入力', open: true, items: toItems(DAILY) }, ...reports, { title: '決算・設定', open: true, items: toItems(SETTINGS) }];
}

/**
 * 今の画面に当たる項目のリンク。完全一致がなければ、パスの先頭が一番長く一致するもの（#/asset/1 → #/assets は当てない）
 * @param {string[]} hrefs
 * @param {string} hash location.hash（? 以降は無視）
 */
export function activeHref(hrefs, hash) {
  const path = hash.split('?')[0];
  if (hrefs.includes(path)) return path;
  let best = null;
  for (const href of hrefs) {
    if (path.startsWith(`${href}/`) && (!best || href.length > best.length)) best = href;
  }
  return best;
}

/** サイドメニューを描く。開閉の状態は描き直しても保つ */
export function renderSidebar(el, { settings, period, hash }) {
  const opened = new Map([...el.querySelectorAll('details[data-group]')].map((d) => [d.dataset.group, d.open]));
  const sections = sidebarSections(settings);
  const current = activeHref(
    sections.flatMap((s) => s.items.map((i) => i.href)),
    hash,
  );
  const link = (item) =>
    h('a', { class: 'side-link', href: item.href, 'aria-current': item.href === current ? 'page' : null }, h('span', { class: 'side-icon' }, icon(item.icon)), h('span', { text: item.label }));
  put(
    el,
    h('div', { class: 'side-brand' }, h('img', { src: 'icons/icon.svg', alt: '', width: 28, height: 28 }), h('span', { class: 'side-brand-name', text: 'Pocket会計' })),
    h(
      'a',
      { class: 'side-book', href: '#/periods', title: '会計期間を切り替える' },
      h('span', { class: 'side-book-name', text: settings.businessName }),
      h('span', { class: 'side-book-period', text: period ? formatPeriod(period) : '' }),
    ),
    h('a', { class: 'btn btn-primary side-new', href: '#/journal/new' }, icon('journal'), h('span', { text: '仕訳を入力' })),
    h(
      'nav',
      { class: 'side-nav', 'aria-label': 'メインメニュー' },
      sections.map((s) => {
        const list = h('ul', { class: 'side-list' }, s.items.map((i) => h('li', {}, link(i))));
        if (!s.title) return list;
        const hasCurrent = s.items.some((i) => i.href === current);
        const open = hasCurrent || (opened.has(s.title) ? opened.get(s.title) : s.open);
        return h('details', { class: 'side-group', 'data-group': s.title, open: open || null }, h('summary', { text: s.title }), list);
      }),
    ),
  );
}
