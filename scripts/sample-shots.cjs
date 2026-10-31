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
  const ids = ['individual', 'ind-freelance', 'ind-izakaya', 'ind-apartment', 'ind-delivery', 'corporation', 'corp-retail', 'corp-construction', 'corp-it', 'corp-restaurant'].filter((id) => !process.env.ONLY || id === process.env.ONLY);
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
  // 3期分：前々期・前期は締めてあり、期首残高は繰越済み（期間の画面で期首残高の食い違いの注意が出ない）
  for (const entity of ids) {
    const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, serviceWorkers: 'block', locale: 'ja-JP' });
    const page = await ctx.newPage();
    page.on('pageerror', (e) => errors.push(`${entity} 3期 pageerror: ${e.message}`));
    page.on('console', (m) => m.type() === 'error' && errors.push(`${entity} 3期 console: ${m.text()}`));
    await page.goto(BASE);
    await page.waitForSelector('form.setup');
    await page.selectOption('#sample-id', entity);
    await page.getByRole('radio', { name: '前々期から3期分' }).click();
    if (entity === 'corporation') await page.screenshot({ path: join(OUT, 'sample-3p-00-chooser.png'), fullPage: true });
    await page.getByRole('button', { name: 'このサンプルを読み込む' }).click();
    await page.waitForTimeout(800);
    await page.evaluate(() => (location.hash = '#/periods'));
    await page.waitForTimeout(600);
    if (['corporation', 'ind-izakaya'].includes(entity)) await page.screenshot({ path: join(OUT, `sample-3p-${entity}-periods.png`), fullPage: true });
    if ((await page.getByText('前期末の残高で期首残高を更新').count()) > 0) errors.push(`${entity} 3期：期首残高が繰越と食い違う`);
    await page.evaluate(() => (location.hash = '#/reports/bs'));
    await page.waitForTimeout(600);
    if (!(await page.locator('.check-line.ok').count())) errors.push(`${entity} 3期：BSが一致しない`);
    await ctx.close();
  }
  await browser.close();
  if (errors.length) {
    console.error(errors.join('\n'));
    process.exit(1);
  }
  console.log('OK: エラーなし');
})();
