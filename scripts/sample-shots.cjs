// サンプルデータの読み込みの確認（初期設定の画面から各サンプルを選んで読み込み、主な帳票を撮る）
// ONLY=corp-retail のように1つだけ撮れる
// 使い方：python3 -m http.server 8123 & node scripts/sample-shots.cjs
const { chromium } = require('playwright');
const { mkdirSync } = require('node:fs');
const { join } = require('node:path');

const BASE = process.env.BASE_URL || 'http://localhost:8123/';
const OUT = join(__dirname, '..', 'shots');
mkdirSync(OUT, { recursive: true });

(async () => {
  const browser = await chromium.launch();
  const errors = [];
  const ids = ['individual', 'corporation', 'corp-retail', 'corp-construction', 'corp-it', 'corp-restaurant'].filter((id) => !process.env.ONLY || id === process.env.ONLY);
  for (const entity of ids) {
    const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, serviceWorkers: 'block', locale: 'ja-JP' });
    const page = await ctx.newPage();
    page.on('pageerror', (e) => errors.push(`${entity} pageerror: ${e.message}`));
    page.on('console', (m) => m.type() === 'error' && errors.push(`${entity} console: ${m.text()}`));
    const shot = async (name) => {
      await page.waitForTimeout(400);
      await page.screenshot({ path: join(OUT, `sample-${entity}-${name}.png`), fullPage: true });
    };
    const go = async (hash) => {
      await page.evaluate((h) => (location.hash = h), hash);
      await page.waitForTimeout(500);
    };
    await page.goto(BASE);
    await page.waitForSelector('form.setup');
    if (entity === 'individual') await shot('00-setup');
    await page.selectOption('#sample-id', entity);
    if (entity === 'corp-construction') await shot('00-chooser');
    await page.getByRole('button', { name: 'このサンプルを読み込む' }).click();
    await page.waitForTimeout(800);
    await shot('01-home');
    await go('#/reports/pl');
    await shot('02-pl');
    await go('#/reports/bs');
    if (!(await page.locator('.check-line.ok').count())) errors.push(`${entity} のBSが一致しない`);
    await shot('02-bs');
    await go('#/reports/tax?view=check');
    await shot('03-tax-check');
    if (entity.startsWith('corp-')) {
      await go('#/reports/tax-return');
      await shot('04-tax-return');
    }
    if (entity === 'corporation') {
      await go('#/reports/manufacturing');
      await shot('04-manufacturing');
    }
    await go('#/backup');
    await shot('05-backup');
    // 仕訳があるときは置き換えの確認が出る
    await page.selectOption('#sample-id', 'individual');
    await page.getByRole('button', { name: 'このサンプルを読み込む' }).click();
    if (!(await page.getByText('サンプルデータで置き換えますか？').count())) errors.push('置き換えの確認が出ない');
    if (entity === 'individual') {
      await page.keyboard.press('Escape');
      await go('#/books');
      await shot('06-books');
    }
    await ctx.close();
  }
  await browser.close();
  if (errors.length) {
    console.error(errors.join('\n'));
    process.exit(1);
  }
  console.log('OK: エラーなし');
})();
