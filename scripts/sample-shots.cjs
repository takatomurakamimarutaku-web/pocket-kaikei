// サンプルデータの読み込みの確認（初期設定の画面から個人・法人を読み込み、主な帳票を撮る）
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
  for (const entity of ['individual', 'corporation']) {
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
    await page.getByRole('button', { name: entity === 'individual' ? '個人のサンプル' : '法人のサンプル' }).click();
    await page.waitForTimeout(800);
    await shot('01-home');
    await go('#/reports/pl');
    await shot('02-pl');
    await go('#/reports/bs');
    if (!(await page.locator('.check-line.ok').count())) errors.push(`${entity} のBSが一致しない`);
    await go('#/reports/tax?view=check');
    await shot('03-tax-check');
    if (entity === 'corporation') {
      await go('#/reports/manufacturing');
      await shot('04-manufacturing');
    }
    await go('#/backup');
    await shot('05-backup');
    // 仕訳があるときは置き換えの確認が出る
    await page.getByRole('button', { name: '個人のサンプル' }).click();
    if (!(await page.getByText('サンプルデータで置き換えますか？').count())) errors.push('置き換えの確認が出ない');
    await ctx.close();
  }
  await browser.close();
  if (errors.length) {
    console.error(errors.join('\n'));
    process.exit(1);
  }
  console.log('OK: エラーなし');
})();
