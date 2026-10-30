// Windows 版の起動確認（GitHub Actions の Windows で使う）
// インストール済みの exe を WebView2 のリモートデバッグ付きで起動し、Playwright で接続して
// 画面の様子・コンソールのエラー・読み込みに失敗したファイルをログに出す。スクリーンショットは JPEG を base64 で出す
// 使い方: node scripts/smoke.mjs <exe のパス>
import { spawn } from 'node:child_process';
import { chromium } from 'playwright-core';

const exe = process.argv[2];
if (!exe) throw new Error('exe のパスを指定してください');
const PORT = 9222;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const child = spawn(exe, [], {
  env: { ...process.env, WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${PORT}` },
  stdio: 'inherit',
});
child.on('exit', (code) => console.log(`[smoke] exe が終了しました（code ${code}）`));

async function waitForDebugger() {
  for (let i = 0; i < 60; i++) {
    try {
      const res = await fetch(`http://127.0.0.1:${PORT}/json/version`);
      if (res.ok) return;
    } catch {}
    await sleep(1000);
  }
  throw new Error('WebView2 のデバッグポートに接続できませんでした');
}

function dumpShot(name, buf) {
  const b64 = buf.toString('base64');
  console.log(`[shot-begin ${name}] ${b64.length}`);
  for (let i = 0; i < b64.length; i += 4000) console.log(`[shot ${name}] ${b64.slice(i, i + 4000)}`);
  console.log(`[shot-end ${name}]`);
}

async function report(page, name) {
  const info = await page.evaluate(() => ({
    href: location.href,
    started: document.documentElement.hasAttribute('data-started'),
    inner: [innerWidth, innerHeight],
    outer: [outerWidth, outerHeight],
    screen: [screen.width, screen.height, devicePixelRatio],
    styleSheets: [...document.styleSheets].map((s) => s.href && s.href.split('/').slice(-2).join('/')),
    bodyBg: getComputedStyle(document.body).backgroundColor,
    text: document.body.innerText.slice(0, 600),
    ua: navigator.userAgent,
  }));
  console.log(`[smoke] ${name}: ${JSON.stringify(info, null, 1)}`);
  dumpShot(name, await page.screenshot({ type: 'jpeg', quality: 45 }));
}

let exitCode = 0;
try {
  await waitForDebugger();
  const browser = await chromium.connectOverCDP(`http://127.0.0.1:${PORT}`);
  const page = browser.contexts()[0].pages()[0];
  page.on('console', (m) => console.log(`[console ${m.type()}] ${m.text()}`));
  page.on('pageerror', (e) => console.log(`[pageerror] ${e.message}`));
  page.on('requestfailed', (r) => console.log(`[requestfailed] ${r.url()} ${r.failure()?.errorText}`));
  page.on('response', (r) => r.status() >= 400 && console.log(`[http ${r.status()}] ${r.url()}`));
  // 起動直後のエラーも拾うため、接続してから読み込み直す
  await page.reload();
  await sleep(12000);
  await report(page, 'start');
  for (const hash of ['#/journal/new', '#/home']) {
    await page.evaluate((h) => (location.hash = h), hash);
    await sleep(3000);
    await report(page, hash);
  }
  await browser.close();
} catch (e) {
  console.log(`[smoke] 失敗: ${e.stack || e}`);
  exitCode = 1;
} finally {
  child.kill();
}
process.exit(exitCode);
