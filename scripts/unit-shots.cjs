// 金額の単位（円・千円・百万円）の確認：サンプルデータで帳票ごとに千円へ切り替えて撮り、印刷プレビューも撮る
// 使い方：python3 -m http.server 8123 & node scripts/unit-shots.cjs [出力先]
const { chromium } = require('playwright');
const { mkdirSync } = require('node:fs');
const { join } = require('node:path');

const BASE = process.env.BASE_URL || 'http://localhost:8123/';
const OUT = process.argv[2] || join(__dirname, '..', 'shots', 'amount-unit');
mkdirSync(OUT, { recursive: true });

const ROUTES = [
  ['trial', '#/reports/trial'],
  ['trial-monthly', '#/reports/trial-monthly'],
  ['monthly', '#/reports/monthly'],
  ['departments', '#/reports/departments'],
  ['pl', '#/reports/pl'],
  ['bs', '#/reports/bs'],
  ['financial', '#/reports/financial'],
  ['manufacturing', '#/reports/manufacturing'],
  ['cash-flow', '#/reports/cash-flow'],
  ['cash-plan', '#/reports/cash-plan'],
  ['budget', '#/reports/budget'],
];

(async () => {
  const browser = await chromium.launch();
  const errors = [];
  for (const scheme of ['light', 'dark']) {
    const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, serviceWorkers: 'block', locale: 'ja-JP', colorScheme: scheme });
    const page = await ctx.newPage();
    page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
    page.on('console', (m) => m.type() === 'error' && errors.push(`console: ${m.text()}`));
    await page.goto(BASE);
    await page.waitForSelector('form.setup');
    await page.getByRole('button', { name: '法人のサンプル' }).click();
    await page.waitForTimeout(800);
    for (const [name, hash] of scheme === 'light' ? ROUTES : ROUTES.slice(0, 1)) {
      await page.evaluate((h) => (location.hash = h), hash);
      await page.waitForTimeout(700);
      const seg = page.locator('.unit-bar .seg', { hasText: /^千円$/ });
      if (!(await seg.count())) {
        // 部門・予算が無いサンプルでは、表の代わりに案内が出る（単位の切替も出さない）
        if (await page.locator('main table').count()) errors.push(`${name}: 単位の切替が無い`);
        else console.log(`${name}: 表が無いので飛ばす`);
        continue;
      }
      const before = await page.locator('main td.num').first().textContent().catch(() => null);
      await seg.click();
      await page.waitForTimeout(200);
      const after = await page.locator('main td.num').first().textContent().catch(() => null);
      console.log(`${name}: ${before} → ${after}`);
      await page.locator('.unit-bar').scrollIntoViewIfNeeded();
      await page.screenshot({ path: join(OUT, `${scheme}-${name}-thousand.png`) });
    }
    if (scheme === 'light') {
      // 仕訳帳は円のまま（単位は画面ごと）。試算表へ戻ると千円を覚えている
      await page.evaluate(() => (location.hash = '#/journals'));
      await page.waitForTimeout(600);
      if (await page.locator('.unit-bar').count()) errors.push('仕訳帳に単位の切替が出ている');
      await page.evaluate(() => (location.hash = '#/reports/trial'));
      await page.waitForTimeout(600);
      const checked = await page.locator('.unit-bar .seg[aria-checked="true"]').textContent();
      if (checked !== '千円') errors.push(`試算表に戻ったときの単位：${checked}`);
      // 四捨五入に変える
      await page.selectOption('.unit-round', 'round');
      await page.waitForTimeout(200);
      await page.screenshot({ path: join(OUT, `${scheme}-trial-round.png`) });
      // 印刷プレビュー：印刷条件に単位がある
      await page.click('#print');
      await page.locator('.print-preview').waitFor();
      await page.waitForTimeout(300);
      await page.screenshot({ path: join(OUT, `${scheme}-trial-print.png`) });
      await page.selectOption('#pp-opt-unit', 'million');
      await page.waitForTimeout(300);
      await page.screenshot({ path: join(OUT, `${scheme}-trial-print-million.png`) });
      await page.getByRole('button', { name: '閉じる' }).click();
      // 画面の表から作る帳票：月次推移を千円にして印刷
      await page.evaluate(() => (location.hash = '#/reports/monthly'));
      await page.waitForTimeout(600);
      await page.locator('.unit-bar .seg', { hasText: /^千円$/ }).click();
      await page.click('#print');
      await page.locator('.print-preview').waitFor();
      await page.waitForTimeout(300);
      const svgText = await page.locator('.pp-sheet').first().textContent();
      if (!svgText.includes('（単位：千円・千円未満切り捨て）')) errors.push('月次推移の印刷に単位の表記が無い');
      await page.screenshot({ path: join(OUT, `${scheme}-monthly-print.png`) });
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
