// PWA の構成を検証する: node scripts/check-pwa.js
// 1. manifest の必須項目  2. キャッシュ対象ファイルの存在と漏れ  3. 絶対パス・外部URLが無いこと  4. バージョンと更新履歴
import { readFileSync, existsSync, readdirSync, statSync } from 'node:fs';
import { join, dirname, extname, relative } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

// キャッシュ対象に含めるべきディレクトリと、対象外とするファイル
const APP_DIRS = ['js', 'css', 'icons', 'img'];
// 外部URLのうち許可するもの：SVG の名前空間と、税法の出典として載せる国税庁・e-Tax のページ（読み込みはしない）
const ALLOWED_URLS = ['http://www.w3.org/2000/svg', 'https://www.nta.go.jp/', 'https://www.e-tax.nta.go.jp/', 'https://kyosai-web.smrj.go.jp/', 'https://www.chusho.meti.go.jp/'];
// 外部のライブラリ（同梱したもの）。キャッシュ対象には含めるが、ソースの検査はしない
const VENDOR_DIR = 'vendor/';

/** manifest の検証。エラーメッセージの配列を返す */
export function checkManifest(manifest, root = ROOT) {
  const errors = [];
  for (const key of ['name', 'short_name', 'start_url', 'scope', 'display', 'theme_color', 'background_color', 'icons']) {
    if (manifest[key] === undefined || manifest[key] === '') errors.push(`manifest: ${key} がありません`);
  }
  if (manifest.display && manifest.display !== 'standalone') errors.push('manifest: display は standalone にしてください');
  for (const key of ['start_url', 'scope']) {
    if (typeof manifest[key] === 'string' && isAbsolutePath(manifest[key])) errors.push(`manifest: ${key} が絶対パスです (${manifest[key]})`);
  }
  const icons = Array.isArray(manifest.icons) ? manifest.icons : [];
  const has = (size, purpose) =>
    icons.some((i) => String(i.sizes || '').split(/\s+/).includes(size) && String(i.purpose || 'any').split(/\s+/).includes(purpose));
  if (!has('192x192', 'any')) errors.push('manifest: 192x192 のアイコンがありません');
  if (!has('512x512', 'any')) errors.push('manifest: 512x512 のアイコンがありません');
  if (!icons.some((i) => String(i.purpose || '').split(/\s+/).includes('maskable'))) errors.push('manifest: maskable のアイコンがありません');
  for (const i of icons) {
    if (!i.src) errors.push('manifest: src の無いアイコンがあります');
    else if (isAbsolutePath(i.src)) errors.push(`manifest: アイコンが絶対パスです (${i.src})`);
    else if (!existsSync(join(root, i.src))) errors.push(`manifest: アイコンファイルがありません (${i.src})`);
  }
  return errors;
}

/** "/" で始まる（"//" は除く）パス、または http(s) の URL */
function isAbsolutePath(p) {
  return /^\/(?!\/)/.test(p) || /^[a-z]+:\/\//i.test(p);
}

/** sw.js から PRECACHE_URLS の配列を取り出す */
export function extractPrecacheUrls(swSource) {
  const m = swSource.match(/const\s+PRECACHE_URLS\s*=\s*\[([\s\S]*?)\];/);
  if (!m) throw new Error('sw.js に PRECACHE_URLS が見つかりません');
  return [...m[1].matchAll(/(['"`])([^'"`]+)\1/g)].map((x) => x[2]);
}

/** sw.js から CACHE_VERSION を取り出す */
export function extractCacheVersion(swSource) {
  const m = swSource.match(/const\s+CACHE_VERSION\s*=\s*['"`]([^'"`]+)['"`]/);
  return m ? m[1] : null;
}

/** キャッシュ対象の検証（存在・絶対パス・重複・漏れ） */
export function checkPrecache(urls, root = ROOT) {
  const errors = [];
  const seen = new Set();
  for (const u of urls) {
    if (seen.has(u)) errors.push(`sw.js: ${u} が重複しています`);
    seen.add(u);
    if (isAbsolutePath(u)) {
      errors.push(`sw.js: 絶対パスです (${u})`);
      continue;
    }
    if (u === './') {
      if (!existsSync(join(root, 'index.html'))) errors.push('sw.js: index.html がありません');
      continue;
    }
    if (!existsSync(join(root, u))) errors.push(`sw.js: キャッシュ対象のファイルがありません (${u})`);
  }
  for (const f of listAppFiles(root)) {
    if (!seen.has(f)) errors.push(`sw.js: ${f} がキャッシュ対象に含まれていません`);
  }
  for (const f of ['index.html', 'manifest.webmanifest']) {
    if (!seen.has(f)) errors.push(`sw.js: ${f} がキャッシュ対象に含まれていません`);
  }
  return errors;
}

function walk(dir) {
  if (!existsSync(dir)) return [];
  return readdirSync(dir).flatMap((name) => {
    const p = join(dir, name);
    return statSync(p).isDirectory() ? walk(p) : [p];
  });
}

/** アプリが使うファイル（キャッシュ対象に含めるべきもの） */
export function listAppFiles(root = ROOT) {
  return APP_DIRS.flatMap((d) => walk(join(root, d)))
    .map((p) => relative(root, p).split('\\').join('/'))
    .filter((p) => !p.split('/').some((s) => s.startsWith('.')))
    .sort();
}

/**
 * ソースに絶対パス参照・外部URLの読み込みが無いか検証する。
 * @param {string} source
 * @param {string} file ファイル名（拡張子で検査内容を変える）
 */
export function findPathProblems(source, file) {
  const errors = [];
  const ext = extname(file);
  const patterns = [];
  if (ext === '.html' || ext === '.svg') patterns.push(/\b(?:src|href|action|content)\s*=\s*["'](\/(?!\/)[^"']*)["']/g);
  if (ext === '.css' || ext === '.html') patterns.push(/url\(\s*["']?(\/(?!\/)[^)"']*)/g, /@import\s+["'](\/(?!\/)[^"']*)/g);
  if (ext === '.js') {
    patterns.push(
      /\bimport\s*(?:[\w*{}\s,]+from\s*)?["'](\/(?!\/)[^"']*)["']/g,
      /\bimport\(\s*["'](\/(?!\/)[^"']*)["']/g,
      /\bfetch\(\s*["'`](\/(?!\/)[^"'`]*)/g,
      /\bregister\(\s*["'`](\/(?!\/)[^"'`]*)/g,
      /\bnew\s+URL\(\s*["'`](\/(?!\/)[^"'`]*)/g,
      /\b(?:src|href)\s*[:=]\s*["'`](\/(?!\/)[^"'`]*)/g,
    );
  }
  for (const re of patterns) {
    for (const m of source.matchAll(re)) errors.push(`${file}: 絶対パスが使われています (${m[1]})`);
  }
  for (const m of source.matchAll(/(?:https?:)?\/\/[a-z0-9.-]+\.[a-z]{2,}[^\s"'`)<>]*/gi)) {
    const url = m[0];
    if (!/^https?:/i.test(url)) {
      // "//" から始まるプロトコル相対URL。コメント（// ...）との誤検知を避けるため、引用符・括弧の直後のみ検査
      const before = source[m.index - 1];
      if (!['"', "'", '`', '('].includes(before)) continue;
    }
    if (ALLOWED_URLS.some((a) => url.startsWith(a))) continue;
    errors.push(`${file}: 外部URLが含まれています (${url})`);
  }
  return errors;
}

/** 検査対象のソース（HTML・CSS・JS・SVG・manifest） */
export function listSourceFiles(root = ROOT) {
  return ['index.html', 'sw.js', 'manifest.webmanifest', ...listAppFiles(root)].filter(
    (f) => !f.startsWith(VENDOR_DIR) && ['.html', '.css', '.js', '.svg', '.webmanifest'].includes(extname(f)),
  );
}

export function runChecks(root = ROOT) {
  const errors = [];
  const manifestPath = join(root, 'manifest.webmanifest');
  if (!existsSync(manifestPath)) errors.push('manifest.webmanifest がありません');
  else {
    try {
      errors.push(...checkManifest(JSON.parse(readFileSync(manifestPath, 'utf8')), root));
    } catch (e) {
      errors.push(`manifest.webmanifest を読み込めません: ${e.message}`);
    }
  }
  const html = existsSync(join(root, 'index.html')) ? readFileSync(join(root, 'index.html'), 'utf8') : '';
  if (!/<link[^>]+rel=["']manifest["']/.test(html)) errors.push('index.html: manifest へのリンクがありません');
  if (!/<link[^>]+rel=["']apple-touch-icon["']/.test(html)) errors.push('index.html: apple-touch-icon へのリンクがありません');
  if (!/viewport-fit=cover/.test(html)) errors.push('index.html: viewport-fit=cover がありません');

  const sw = readFileSync(join(root, 'sw.js'), 'utf8');
  const version = extractCacheVersion(sw);
  if (!version) errors.push('sw.js: CACHE_VERSION がありません');
  const urls = extractPrecacheUrls(sw);
  errors.push(...checkPrecache(urls, root));

  for (const f of listSourceFiles(root)) {
    errors.push(...findPathProblems(readFileSync(join(root, f), 'utf8'), f));
  }
  return { errors, version, urls };
}

/**
 * バージョンの食い違いと更新履歴の抜けを検証する（package.json・js/version.js・js/changelog.js）。
 * 版を上げたのに更新履歴を書き忘れると、ここで止まる
 */
export async function checkVersions(root = ROOT) {
  const errors = [];
  const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
  const { APP_VERSION } = await import(pathToFileURL(join(root, 'js/version.js')).href);
  const { CHANGELOG, checkChangelog } = await import(pathToFileURL(join(root, 'js/changelog.js')).href);
  if (pkg.version !== APP_VERSION) errors.push(`package.json の version（${pkg.version}）と js/version.js の APP_VERSION（${APP_VERSION}）が違います`);
  errors.push(...checkChangelog(CHANGELOG, APP_VERSION));
  return { errors, appVersion: APP_VERSION };
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const { errors, version, urls } = runChecks();
  const versions = await checkVersions();
  errors.push(...versions.errors);
  if (errors.length) {
    console.error(`NG: ${errors.length}件の問題があります`);
    for (const e of errors) console.error(`  - ${e}`);
    process.exit(1);
  }
  console.log(`OK: manifest / キャッシュ対象 ${urls.length}件（${version}）/ 絶対パス・外部URLなし / 更新履歴 ${versions.appVersion}`);
}
