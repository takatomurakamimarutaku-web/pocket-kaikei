import { test } from 'node:test';
import assert from 'node:assert/strict';
import { checkManifest, extractPrecacheUrls, extractCacheVersion, checkPrecache, findPathProblems, runChecks, ROOT } from '../scripts/check-pwa.js';

test('リポジトリの構成が検証を通過する', () => {
  const { errors, version } = runChecks(ROOT);
  assert.deepEqual(errors, []);
  assert.match(version, /^v\d+$/);
});

test('manifest：必須項目・アイコンの不足を検出する', () => {
  const errors = checkManifest({ name: 'x', display: 'browser', start_url: '/', scope: './', icons: [{ src: 'icons/none.png', sizes: '192x192' }] }, ROOT);
  const text = errors.join('\n');
  assert.match(text, /short_name/);
  assert.match(text, /theme_color/);
  assert.match(text, /standalone/);
  assert.match(text, /start_url が絶対パス/);
  assert.match(text, /512x512/);
  assert.match(text, /maskable/);
  assert.match(text, /アイコンファイルがありません/);
});

test('sw.js：PRECACHE_URLS と CACHE_VERSION の抽出', () => {
  const src = "const CACHE_VERSION = 'v9';\nconst PRECACHE_URLS = [\n  './',\n  \"index.html\",\n  'js/app.js',\n];";
  assert.deepEqual(extractPrecacheUrls(src), ['./', 'index.html', 'js/app.js']);
  assert.equal(extractCacheVersion(src), 'v9');
  assert.throws(() => extractPrecacheUrls('const X = 1;'));
});

test('キャッシュ対象：存在しない・絶対パス・重複・漏れを検出する', () => {
  const text = checkPrecache(['./', 'index.html', 'index.html', '/js/app.js', 'js/none.js'], ROOT).join('\n');
  assert.match(text, /重複/);
  assert.match(text, /絶対パスです \(\/js\/app\.js\)/);
  assert.match(text, /ファイルがありません \(js\/none\.js\)/);
  assert.match(text, /js\/db\.js がキャッシュ対象に含まれていません/);
  assert.match(text, /manifest\.webmanifest がキャッシュ対象/);
});

test('絶対パス・外部URLを検出する', () => {
  assert.equal(findPathProblems('<link href="/css/a.css"><script src="https://cdn.example.com/x.js"></script>', 'a.html').length, 2);
  assert.equal(findPathProblems('<a href="#/beers"><img src="icons/a.png">', 'a.html').length, 0);
  assert.equal(findPathProblems('a { background: url(/img/a.png) }', 'a.css').length, 1);
  assert.equal(findPathProblems("import x from '/js/a.js'; fetch('/data/a.json')", 'a.js').length, 2);
  assert.equal(findPathProblems("import x from './a.js'; fetch('data/a.json'); // コメント", 'a.js').length, 0);
  assert.equal(findPathProblems("const s = 'http://www.w3.org/2000/svg'", 'a.js').length, 0, 'SVG名前空間は許可');
  assert.equal(findPathProblems("const u = '//cdn.example.com/x.js'", 'a.js').length, 1, 'プロトコル相対URL');
});
