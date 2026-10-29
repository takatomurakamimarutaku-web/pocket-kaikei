// Service Worker
// ファイルを変更したら CACHE_VERSION を上げる。ファイルを追加・削除したら PRECACHE_URLS も更新する（npm run check で検出）
const CACHE_VERSION = 'v31';
const CACHE_NAME = `pocket-kaikei-${CACHE_VERSION}`;

// 事前にキャッシュするファイル（相対パス）
const PRECACHE_URLS = [
  './',
  'index.html',
  'manifest.webmanifest',
  'css/style.css',
  'icons/apple-touch-icon.png',
  'icons/icon-192.png',
  'icons/icon-512.png',
  'icons/icon-maskable-512.png',
  'icons/icon-maskable.svg',
  'icons/icon.svg',
  'img/chara/family.svg',
  'img/chara/kai-cheer.svg',
  'img/chara/keily-caution.svg',
  'img/chara/keily-normal.svg',
  'js/accounts.js',
  'js/app.js',
  'js/backup.js',
  'js/csv.js',
  'js/db.js',
  'js/errors.js',
  'js/install.js',
  'js/journal.js',
  'js/ledger.js',
  'js/quick.js',
  'js/monthly.js',
  'js/chart.js',
  'js/closing.js',
  'js/bank-import.js',
  'js/depreciation.js',
  'js/asset-tools.js',
  'js/models.js',
  'js/money.js',
  'js/period.js',
  'js/router.js',
  'js/search.js',
  'js/statements.js',
  'js/tax.js',
  'js/tax-return.js',
  'js/tax-forms.js',
  'js/breakdown.js',
  'js/financial.js',
  'js/property-tax.js',
  'js/enterprise-tax.js',
  'js/income-tax.js',
  'js/tax-reports.js',
  'js/sample.js',
  'js/blue-return.js',
  'js/ui.js',
  'js/icons.js',
  'js/version.js',
  'js/views/account-edit.js',
  'js/views/account-picker.js',
  'js/views/accounts.js',
  'js/views/backup.js',
  'js/views/home.js',
  'js/views/journal-form.js',
  'js/views/entry.js',
  'js/views/quick-entry.js',
  'js/views/cashbook.js',
  'js/views/bank-import.js',
  'js/views/bank-rules.js',
  'js/views/monthly.js',
  'js/views/trial-monthly.js',
  'js/views/manufacturing.js',
  'js/views/sample-load.js',
  'js/views/period-common.js',
  'js/views/periods.js',
  'js/views/closing.js',
  'js/views/assets.js',
  'js/views/asset-form.js',
  'js/views/asset-dispose.js',
  'js/views/journals.js',
  'js/views/ledger.js',
  'js/views/more.js',
  'js/views/opening.js',
  'js/views/report-common.js',
  'js/views/reports.js',
  'js/views/settings.js',
  'js/views/setup.js',
  'js/views/statements.js',
  'js/views/tax.js',
  'js/views/tax-return.js',
  'js/views/blue-return.js',
  'js/views/breakdown.js',
  'js/views/financial.js',
  'js/views/property-tax.js',
  'js/views/enterprise-tax.js',
  'js/views/income-tax.js',
  'js/views/trial.js',
];

self.addEventListener('install', (event) => {
  // 更新時はすぐに切り替えず、画面の［更新］ボタンを待つ
  event.waitUntil(caches.open(CACHE_NAME).then((cache) => cache.addAll(PRECACHE_URLS.map((u) => new Request(u, { cache: 'reload' })))));
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k.startsWith('pocket-kaikei-') && k !== CACHE_NAME).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('message', (event) => {
  if (event.data && event.data.type === 'SKIP_WAITING') self.skipWaiting();
});

// キャッシュ優先（オフラインでも動く）。外部への通信は一切しない
self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;
  event.respondWith(
    (async () => {
      const cache = await caches.open(CACHE_NAME);
      if (req.mode === 'navigate') {
        const cached = await cache.match('index.html');
        if (cached) return cached;
      }
      const hit = await cache.match(req, { ignoreSearch: true });
      if (hit) return hit;
      try {
        return await fetch(req);
      } catch (e) {
        if (req.mode === 'navigate') {
          const fallback = await cache.match('index.html');
          if (fallback) return fallback;
        }
        throw e;
      }
    })(),
  );
});
