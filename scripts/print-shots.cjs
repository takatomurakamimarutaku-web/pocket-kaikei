// 帳票の印刷プレビューと PDF の確認：サンプルデータを読み込み、帳票ごとにプレビューを開いて撮り、PDF を保存する
// 使い方：python3 -m http.server 8123 & node scripts/print-shots.cjs [出力先]
// PDF の見た目は pdftoppm（poppler）で画像にして確かめる
const { chromium } = require('playwright');
const { mkdirSync } = require('node:fs');
const { join } = require('node:path');

const BASE = process.env.BASE_URL || 'http://localhost:8123/';
const OUT = process.argv[2] || join(__dirname, '..', 'shots', 'print');
mkdirSync(OUT, { recursive: true });

const ROUTES = {
  corporation: [
    ['journals', '#/journals?month=all'],
    ['ledger-all', '#/reports/ledger?account=all'],
    ['cashbook', '#/cashbook?month=all'],
    ['trial', '#/reports/trial'],
    ['trial-monthly', '#/reports/trial-monthly'],
    ['monthly', '#/reports/monthly'],
    ['pl', '#/reports/pl'],
    ['bs', '#/reports/bs'],
    ['tax', '#/reports/tax'],
    ['financial', '#/reports/financial'],
    ['assets', '#/assets'],
    ['breakdown', '#/reports/breakdown'],
    ['corporate-tax', '#/reports/corporate-tax'],
  ],
  individual: [
    ['trial', '#/reports/trial'],
    ['pl', '#/reports/pl'],
    ['blue-return', '#/reports/blue-return'],
  ],
};

(async () => {
  const browser = await chromium.launch();
  const errors = [];
  for (const entity of Object.keys(ROUTES)) {
    const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, serviceWorkers: 'block', locale: 'ja-JP', acceptDownloads: true });
    const page = await ctx.newPage();
    page.on('pageerror', (e) => errors.push(`${entity} pageerror: ${e.message}`));
    page.on('console', (m) => m.type() === 'error' && errors.push(`${entity} console: ${m.text()}`));
    await page.goto(BASE);
    await page.waitForSelector('form.setup');
    await page.getByRole('button', { name: entity === 'individual' ? '個人のサンプル' : '法人のサンプル' }).click();
    await page.waitForTimeout(800);
    for (const [name, hash] of ROUTES[entity]) {
      await page.evaluate((h) => (location.hash = h), hash);
      await page.waitForTimeout(700);
      await page.click('#print');
      const pv = page.locator('.print-preview');
      try {
        await pv.waitFor({ timeout: 3000 });
      } catch {
        errors.push(`${entity} ${name}: プレビューが開かない`);
        continue;
      }
      await page.waitForTimeout(300);
      await page.screenshot({ path: join(OUT, `${entity}-${name}-preview.png`) });
      const [download] = await Promise.all([page.waitForEvent('download'), page.getByRole('button', { name: 'PDFを保存・共有' }).click()]);
      await download.saveAs(join(OUT, `${entity}-${name}.pdf`));
      await page.getByRole('button', { name: '閉じる' }).click();
      if (await pv.count()) errors.push(`${entity} ${name}: 閉じない`);
    }
    await ctx.close();
  }
  await browser.close();
  if (errors.length) {
    console.error(errors.join('\n'));
    process.exit(1);
  }
  console.log(`OK: ${OUT}`);
})();
