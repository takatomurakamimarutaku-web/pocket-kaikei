// 事業所の切替の確認（サンプルの事業所を作る・バックアップから作る・切り替える）
// 使い方：python3 -m http.server 8123 & node scripts/business-shots.cjs [バックアップファイル]
const { chromium } = require('playwright');
const { mkdirSync } = require('node:fs');
const { join } = require('node:path');

const BASE = process.env.BASE_URL || 'http://localhost:8123/';
const OUT = join(__dirname, '..', 'shots', 'business');
const BACKUP = process.argv[2];
mkdirSync(OUT, { recursive: true });

(async () => {
  const browser = await chromium.launch();
  const errors = [];
  for (const scheme of ['light', 'dark']) {
    const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, serviceWorkers: 'block', locale: 'ja-JP', colorScheme: scheme });
    const page = await ctx.newPage();
    page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
    page.on('console', (m) => m.type() === 'error' && errors.push(`console: ${m.text()}`));
    const shot = async (name, fullPage = false) => {
      await page.waitForTimeout(400);
      await page.screenshot({ path: join(OUT, `${scheme}-${name}.png`), fullPage });
    };
    const heroName = () => page.locator('.hero-name').textContent();
    await page.goto(BASE);
    await page.waitForSelector('form.setup');
    await page.getByRole('button', { name: '個人のサンプル' }).click();
    await page.waitForSelector('.hero-switch');
    await shot('01-home');
    // ホームの［切替］から、法人のサンプルを新しい事業所として作る
    await page.click('.hero-switch');
    await page.waitForSelector('.book-list');
    await shot('02-books-one', true);
    await page.getByRole('button', { name: '法人のサンプル' }).click();
    await page.waitForSelector('.hero-switch');
    await page.waitForTimeout(500);
    if ((await heroName()) !== 'サンプル製作所株式会社') errors.push(`法人に切り替わらない：${await heroName()}`);
    await shot('03-home-corporation');
    if (BACKUP) {
      await page.click('.hero-switch');
      await page.waitForSelector('.book-list');
      await page.locator('input[type=file]').setInputFiles(BACKUP);
      await page.getByText('このバックアップから事業所を作りますか？').waitFor();
      await shot('04-backup-confirm');
      await page.getByRole('button', { name: '取り込む' }).click();
      await page.waitForSelector('.hero-switch');
      await page.waitForTimeout(500);
    }
    await page.click('.hero-switch');
    await page.waitForSelector('.book-list');
    await page.waitForTimeout(300);
    const count = await page.locator('.book-item').count();
    if (count !== (BACKUP ? 3 : 2)) errors.push(`事業所の数が違う：${count}`);
    await shot('05-books', true);
    // 最初の事業所（個人）へ戻す
    await page.locator('.book-item').filter({ hasText: 'サンプル商店' }).getByRole('button', { name: 'この事業所に切り替える' }).click();
    await page.waitForSelector('.hero-switch');
    await page.waitForTimeout(500);
    if ((await heroName()) !== 'サンプル商店') errors.push(`個人に戻らない：${await heroName()}`);
    await page.evaluate(() => (location.hash = '#/more'));
    await page.waitForTimeout(500);
    await shot('06-more', true);
    // 再読み込みしても今の事業所を覚えている
    await page.evaluate(() => (location.hash = '#/home'));
    await page.reload();
    await page.waitForSelector('.hero-switch');
    if ((await heroName()) !== 'サンプル商店') errors.push('再読み込みで事業所が変わった');
    await ctx.close();
  }
  await browser.close();
  if (errors.length) {
    console.error(errors.join('\n'));
    process.exit(1);
  }
  console.log('OK: エラーなし');
})();
