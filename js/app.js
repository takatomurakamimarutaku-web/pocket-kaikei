// 起動処理
import { openDB } from './db.js';
import { createRouter } from './router.js';
import { h, showToast } from './ui.js';
import { friendlyError } from './errors.js';
import { APP_VERSION } from './version.js';
import * as setupView from './views/setup.js';
import * as homeView from './views/home.js';
import * as journalsView from './views/journals.js';
import * as journalFormView from './views/journal-form.js';
import * as entryView from './views/entry.js';
import * as quickEntryView from './views/quick-entry.js';
import * as cashbookView from './views/cashbook.js';
import * as reportsView from './views/reports.js';
import * as ledgerView from './views/ledger.js';
import * as trialView from './views/trial.js';
import * as monthlyView from './views/monthly.js';
import * as statementsView from './views/statements.js';
import * as taxView from './views/tax.js';
import * as moreView from './views/more.js';
import * as settingsView from './views/settings.js';
import * as accountsView from './views/accounts.js';
import * as accountEditView from './views/account-edit.js';
import * as openingView from './views/opening.js';
import * as backupView from './views/backup.js';

// back: 戻るボタンを表示し、アプリ内の履歴が無いときに戻る先
const routes = [
  { path: '/setup', view: setupView, title: '初期設定', tab: null, setup: true },
  { path: '/home', view: homeView, title: 'ホーム', tab: 'home' },
  { path: '/journals', view: journalsView, title: '仕訳帳', tab: 'journals' },
  { path: '/entry', view: entryView, title: '入力', tab: 'entry' },
  { path: '/quick/:kind', view: quickEntryView, title: 'かんたん入力', tab: 'entry', back: '#/entry' },
  { path: '/cashbook', view: cashbookView, title: '出納帳', tab: 'entry', back: '#/entry' },
  { path: '/journal/new', view: journalFormView, title: '振替伝票の入力', tab: 'entry', back: '#/entry' },
  { path: '/journal/:id/edit', view: journalFormView, title: '仕訳の編集', tab: 'journals', back: '#/journals' },
  { path: '/reports', view: reportsView, title: '帳票', tab: 'reports' },
  { path: '/reports/ledger', view: ledgerView, title: '総勘定元帳', tab: 'reports', back: '#/reports' },
  { path: '/reports/trial', view: trialView, title: '残高試算表', tab: 'reports', back: '#/reports' },
  { path: '/reports/monthly', view: monthlyView, title: '月次推移表', tab: 'reports', back: '#/reports' },
  { path: '/reports/pl', view: statementsView, kind: 'pl', title: '損益計算書', tab: 'reports', back: '#/reports' },
  { path: '/reports/bs', view: statementsView, kind: 'bs', title: '貸借対照表', tab: 'reports', back: '#/reports' },
  { path: '/reports/tax', view: taxView, title: '消費税集計', tab: 'reports', back: '#/reports' },
  { path: '/more', view: moreView, title: 'その他', tab: 'more' },
  { path: '/settings', view: settingsView, title: '事業者の設定', tab: 'more', back: '#/more' },
  { path: '/accounts', view: accountsView, title: '勘定科目', tab: 'more', back: '#/more' },
  { path: '/account/new', view: accountEditView, title: '科目の追加', tab: 'more', back: '#/accounts' },
  { path: '/account/:id', view: accountEditView, title: '科目の編集', tab: 'more', back: '#/accounts' },
  { path: '/opening', view: openingView, title: '期首残高', tab: 'more', back: '#/more' },
  { path: '/backup', view: backupView, title: 'バックアップ', tab: 'more', back: '#/more' },
];

const outlet = document.getElementById('view');
const titleEl = document.getElementById('title');
const backBtn = document.getElementById('back');
const headerEl = document.querySelector('.app-header');
const tabbar = document.querySelector('.tabbar');

async function start() {
  let db;
  try {
    db = await openDB();
  } catch (e) {
    outlet.replaceChildren(errorView(friendlyError(e, 'データを開くことが')));
    return;
  }
  let current = null;

  const app = {
    db,
    navigate: (hash, opts) => router.navigate(hash, opts),
    goBack: (fallback) => router.goBack(fallback),
    refresh: () => router.refresh(),
    setTitle: (t) => {
      titleEl.textContent = t;
      document.title = `${t} | ポケット会計`;
    },
    /**
     * 画面で使うデータをまとめて読む（第1弾は件数が少ない前提で、画面ごとに読み直す）
     * @returns {{ settings, period, accounts, subAccounts, journals, accountById, subById }}
     */
    async load() {
      const settings = await db.getSettings();
      const period = await db.getCurrentPeriod();
      const [accounts, subAccounts, journals] = await Promise.all([db.listAccounts(), db.listSubAccounts(), period ? db.listJournals(period.id) : []]);
      return {
        settings,
        period,
        accounts,
        subAccounts,
        journals,
        accountById: new Map(accounts.map((a) => [a.id, a])),
        subById: new Map(subAccounts.map((s) => [s.id, s])),
      };
    },
  };

  const router = createRouter({
    routes,
    defaultHash: '#/home',
    onRoute: async ({ route, params, query }, isStale) => {
      // 初期設定が済んでいなければ、初期設定の画面へ
      const settings = await db.getSettings().catch(() => null);
      if (!settings && !route.setup) {
        router.navigate('#/setup', { replace: true });
        return null;
      }
      if (settings && route.setup) {
        router.navigate('#/home', { replace: true });
        return null;
      }
      current = route;
      app.leaveGuard = null;
      app.setTitle(route.title);
      backBtn.hidden = !route.back;
      headerEl.classList.toggle('is-root', !route.back);
      tabbar.hidden = Boolean(route.setup);
      for (const a of document.querySelectorAll('.tabbar a')) {
        if (a.dataset.tab === route.tab) a.setAttribute('aria-current', 'page');
        else a.removeAttribute('aria-current');
      }
      outlet.replaceChildren(h('p', { class: 'loading', text: '読み込み中…' }));
      window.scrollTo(0, 0);
      outlet.classList.remove('view-enter');
      try {
        const result = await route.view.render({ app, outlet, params, query, route, isStale });
        if (!isStale()) {
          void outlet.offsetWidth;
          outlet.classList.add('view-enter');
        }
        return result;
      } catch (e) {
        console.error(e);
        if (!isStale()) outlet.replaceChildren(errorView(friendlyError(e, '画面を表示')));
        return null;
      }
    },
  });

  const onScroll = () => headerEl.classList.toggle('is-scrolled', window.scrollY > 4);
  window.addEventListener('scroll', onScroll, { passive: true });

  backBtn.addEventListener('click', () => leaveIfAllowed(() => router.goBack(current?.back)));
  // 入力途中の画面から、タブ・リンクで離れるときに確認する
  document.addEventListener(
    'click',
    (e) => {
      const a = e.target.closest?.('a[href^="#"]');
      if (!a || !app.leaveGuard || a.getAttribute('href') === location.hash) return;
      e.preventDefault();
      leaveIfAllowed(() => router.navigate(a.getAttribute('href')));
    },
    true,
  );
  async function leaveIfAllowed(go) {
    if (app.leaveGuard && !(await app.leaveGuard())) return;
    app.leaveGuard = null;
    go();
  }

  await fillAccountHints(db);
  router.start();
  requestPersistence();
  notifyUpdated(db);
}

/** エラー画面（何が起きたか・次にすること・再読み込み） */
function errorView({ message, hint, detail }) {
  return h(
    'div',
    { class: 'empty error-view', role: 'alert' },
    h('p', { class: 'error-title', text: message }),
    h('p', { class: 'small', text: hint }),
    h('button', { type: 'button', class: 'btn', text: '再読み込み', onclick: () => location.reload() }),
    detail ? h('p', { class: 'small muted error-detail', text: `詳細：${detail}` }) : null,
  );
}

/** 更新後の初回起動で、新しいバージョンになったことを知らせる */
async function notifyUpdated(db) {
  try {
    const seen = await db.getMeta('seenVersion');
    if (seen === APP_VERSION) return;
    await db.setMeta('seenVersion', APP_VERSION);
    if (seen) showToast(`バージョン${APP_VERSION}に更新しました`, { duration: 5000 });
  } catch (e) {
    console.warn('seenVersion', e);
  }
}

/** 目印（hint）の導入前に作った科目に目印を補う（失敗しても使えるので止めない） */
async function fillAccountHints(db) {
  try {
    await db.fillAccountHints();
  } catch (e) {
    console.warn('fillAccountHints', e);
  }
}

/** 対応環境ではストレージの永続化を要求する（非対応・拒否でも止めない） */
async function requestPersistence() {
  try {
    if (navigator.storage?.persist && !(await navigator.storage.persisted())) await navigator.storage.persist();
  } catch (e) {
    console.warn('persist', e);
  }
}

// ---- Service Worker と更新の通知 ----

function registerServiceWorker() {
  if (!('serviceWorker' in navigator)) return;
  const banner = document.getElementById('update-banner');
  let updateRequested = false;
  let reloading = false;
  const showUpdate = (worker) => {
    banner.hidden = false;
    banner.querySelector('button').onclick = () => {
      banner.querySelector('button').disabled = true;
      updateRequested = true;
      worker.postMessage({ type: 'SKIP_WAITING' });
    };
  };
  // 初回インストール時の clients.claim() でも発火するため、［更新］を押した場合だけ再読み込みする
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (!updateRequested || reloading) return;
    reloading = true;
    location.reload();
  });
  navigator.serviceWorker
    .register('sw.js')
    .then((reg) => {
      if (reg.waiting && navigator.serviceWorker.controller) showUpdate(reg.waiting);
      reg.addEventListener('updatefound', () => {
        const w = reg.installing;
        if (!w) return;
        w.addEventListener('statechange', () => {
          if (w.state === 'installed' && navigator.serviceWorker.controller) showUpdate(w);
        });
      });
      document.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'visible') reg.update().catch(() => {});
      });
    })
    .catch((e) => {
      console.warn('SW登録に失敗', e);
      if (location.protocol === 'https:') showToast('オフライン機能を有効にできませんでした');
    });
}

registerServiceWorker();
start();
