// 経営サポート（着地見込み・納税予測）の確認：サンプルデータを読み込み、スマホ幅とPC幅で撮る
// 使い方：python3 -m http.server 8123 & node scripts/advisor-shots.cjs
const { chromium } = require('playwright');
const { mkdirSync } = require('node:fs');
const { join } = require('node:path');

const BASE = process.env.BASE_URL || 'http://localhost:8123/';
const OUT = join(__dirname, '..', 'shots', 'advisor');
mkdirSync(OUT, { recursive: true });

(async () => {
  const browser = await chromium.launch();
  const errors = [];
  for (const [entity, width, height] of [['individual', 390, 844], ['corporation', 390, 844], ['corporation', 1280, 900]]) {
    const pc = width > 1000 ? '-pc' : '';
    const ctx = await browser.newContext({ viewport: { width, height }, deviceScaleFactor: 2, serviceWorkers: 'block', locale: 'ja-JP' });
    const page = await ctx.newPage();
    page.on('pageerror', (e) => errors.push(`${entity} pageerror: ${e.message}`));
    page.on('console', (m) => m.type() === 'error' && errors.push(`${entity} console: ${m.text()}`));
    const shot = async (name) => {
      await page.waitForTimeout(400);
      await page.screenshot({ path: join(OUT, `${entity}${pc}-${name}.png`), fullPage: true });
    };
    const go = async (hash) => {
      await page.evaluate((h) => (location.hash = h), hash);
      await page.waitForTimeout(600);
    };
    await page.goto(BASE);
    await page.waitForSelector('form.setup');
    await page.getByRole('button', { name: entity === 'individual' ? '個人のサンプル' : '法人のサンプル' }).click();
    await page.waitForTimeout(900);
    if (!pc) await shot('01-home-switch');
    await page.getByRole('radio', { name: '経営' }).click();
    await page.waitForTimeout(700);
    await shot('02-advisor-home');
    await go('#/advisor/forecast');
    await shot('03-forecast');
    // 売上高の立て方を「金額を入れる」にして保存できるか
    if (!pc) {
      const sel = page.locator('select.advisor-method').first();
      await sel.selectOption('manual');
      await page.waitForTimeout(300);
      await page.locator('input.advisor-manual').first().fill('5,000,000');
      await page.locator('input.advisor-manual').first().dispatchEvent('change');
      await page.waitForTimeout(300);
      await page.getByRole('button', { name: '見込みの設定を保存する' }).click();
      await page.waitForTimeout(800);
      if ((await page.locator('select.advisor-method').first().inputValue()) !== 'manual') errors.push(`${entity}: 立て方が保存されない`);
      await shot('04-forecast-manual');
    }
    await go('#/advisor/tax');
    await shot('05-tax');
    await ctx.close();
  }
  await browser.close();
  if (errors.length) {
    console.error(errors.join('\n'));
    process.exit(1);
  }
  console.log('OK: エラーなし');
})();
