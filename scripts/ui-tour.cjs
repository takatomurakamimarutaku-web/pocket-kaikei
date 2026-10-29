// 主な画面を一通り撮る（サンプルデータを読み込んで）。デザイン確認用
// 使い方：python3 -m http.server 8123 & node scripts/ui-tour.cjs [individual|corporation] [light|dark]
// FULL=1 でページ全体、ONLY=19,20 で番号を絞る
const { chromium } = require('playwright');
const { mkdirSync } = require('node:fs');
const { join } = require('node:path');

const BASE = process.env.BASE_URL || 'http://localhost:8123/';
const entity = process.argv[2] || 'corporation';
const scheme = process.argv[3] || 'light';
const OUT = join(__dirname, '..', 'shots', 'tour');
mkdirSync(OUT, { recursive: true });

const PAGES = [
  ['01-home', '#/home'],
  ['02-entry', '#/entry'],
  ['03-journal-new', '#/journal/new'],
  ['04-journals', '#/journals'],
  ['05-reports', '#/reports'],
  ['06-trial', '#/reports/trial'],
  ['07-pl', '#/reports/pl'],
  ['08-bs', '#/reports/bs'],
  ['09-monthly', '#/reports/monthly'],
  ['10-tax', '#/reports/tax'],
  ['11-more', '#/more'],
  ['12-accounts', '#/accounts'],
  ['13-assets', '#/assets'],
  ['14-closing', '#/closing'],
  ['15-quick', '#/quick/expense'],
  ['16-cashbook', '#/cashbook'],
  ['17-ledger', '#/reports/ledger'],
  ['18-trial-monthly', '#/reports/trial-monthly'],
  ['19-tax-return', '#/reports/tax-return'],
  ['21-breakdown', '#/reports/breakdown'],
  ['20-tax-return-form', '#/reports/tax-return?view=form'],
].filter(([name]) => !process.env.ONLY || process.env.ONLY.split(',').some((p) => name.startsWith(p)));

(async () => {
  const browser = await chromium.launch();
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, serviceWorkers: 'block', locale: 'ja-JP', colorScheme: scheme });
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
  page.on('console', (m) => m.type() === 'error' && errors.push(`console: ${m.text()}`));
  await page.goto(BASE);
  await page.waitForSelector('form.setup');
  await page.screenshot({ path: join(OUT, `${entity}-${scheme}-00-setup.png`) });
  await page.getByRole('button', { name: entity === 'individual' ? '個人のサンプル' : '法人のサンプル' }).click();
  await page.waitForTimeout(3500); // トーストが消えるまで
  for (const [name, hash] of PAGES) {
    await page.evaluate((h) => (location.hash = h), hash);
    await page.waitForTimeout(600);
    await page.screenshot({ path: join(OUT, `${entity}-${scheme}-${name}.png`), fullPage: process.env.FULL === '1' });
  }
  await browser.close();
  if (errors.length) console.error(errors.join('\n'));
  console.log(`OK: ${PAGES.length + 1} 枚`);
})();
