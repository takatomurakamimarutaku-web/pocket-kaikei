// PWA のファイルを desktop/web/ に写す（Tauri はこのフォルダを exe に同梱する）
// 同梱するのは sw.js の PRECACHE_URLS と同じもの＝アプリの動作に必要なファイルだけ。
// sw.js は写さない（exe では Service Worker を使わず、更新は新しい exe を入れて行う）
import { readFileSync, rmSync, mkdirSync, copyFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ROOT, extractPrecacheUrls } from '../../scripts/check-pwa.js';

const OUT = join(dirname(fileURLToPath(import.meta.url)), '..', 'web');

const urls = extractPrecacheUrls(readFileSync(join(ROOT, 'sw.js'), 'utf8')).filter((u) => u !== './');
rmSync(OUT, { recursive: true, force: true });
for (const u of urls) {
  const to = join(OUT, u);
  mkdirSync(dirname(to), { recursive: true });
  copyFileSync(join(ROOT, u), to);
}
console.log(`desktop/web に ${urls.length} ファイルを写しました`);
