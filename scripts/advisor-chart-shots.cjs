// グラフの確認：法人のサンプル（前々期から3期分）を読み込み、利益シミュレーション・経営分析・納税予測・節税の提案のグラフを撮る
// 使い方：python3 -m http.server 8123 & node scripts/advisor-chart-shots.cjs
const { chromium } = require('playwright');
const { join } = require('node:path');

const BASE = process.env.BASE_URL || 'http://localhost:8123/';
const OUT = join(__dirname, '..', 'shots', 'advisor');

(async () => {
  const browser = await chromium.launch();
  const errors = [];
  for (const [id, width] of [['corporation', 390], ['corp-retail', 390], ['individual', 390], ['corporation', 1280]]) {
    const tag = `${id}${width > 1000 ? '-pc' : ''}`;
    const ctx = await browser.newContext({ viewport: { width, height: 900 }, deviceScaleFactor: 2, serviceWorkers: 'block', locale: 'ja-JP' });
    const page = await ctx.newPage();
    page.on('pageerror', (e) => errors.push(`${tag} pageerror: ${e.message}`));
    page.on('console', (m) => m.type() === 'error' && errors.push(`${tag} console: ${m.text()}`));
    await page.goto(BASE);
    await page.waitForSelector('form.setup');
    await page.selectOption('#sample-id', id);
    await page.getByRole('radio', { name: '前々期から3期分' }).click();
    await page.getByRole('button', { name: 'このサンプルを読み込む' }).click();
    await page.waitForTimeout(1500);
    const go = async (hash, name, sel) => {
      await page.evaluate((h) => (location.hash = h), hash);
      await page.waitForTimeout(900);
      if (sel && !(await page.locator(sel).count())) errors.push(`${tag} ${name}: ${sel} が出ない`);
      await page.screenshot({ path: join(OUT, `${tag}-chart-${name}.png`), fullPage: true });
    };
    await go('#/advisor/simulation', 'simulation', '.chart-svg');
    await go('#/reports/analysis', 'analysis', '.bsbox-grid');
    await go('#/advisor/tax', 'tax');
    await go('#/advisor/saving', 'saving');
    await ctx.close();
  }
  await browser.close();
  if (errors.length) {
    console.log(errors.join('\n'));
    process.exit(1);
  }
  console.log('OK: エラーなし');
})();
