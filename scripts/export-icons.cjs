// SVG アイコンから PNG を書き出す（開発時のみ）: node scripts/export-icons.cjs
const { chromium } = require('playwright');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');
(async () => {
  const root = join(__dirname, '..');
  const browser = await chromium.launch();
  const page = await browser.newPage();
  const jobs = [
    ['icon.svg', 'icon-192.png', 192],
    ['icon.svg', 'icon-512.png', 512],
    ['icon.svg', 'apple-touch-icon.png', 180],
    ['icon-maskable.svg', 'icon-maskable-512.png', 512],
  ];
  for (const [src, out, size] of jobs) {
    const svg = readFileSync(join(root, 'icons', src), 'utf8');
    await page.setViewportSize({ width: size, height: size });
    await page.setContent(`<html><body style="margin:0">${svg.replace('<svg ', `<svg width="${size}" height="${size}" `)}</body></html>`);
    await page.screenshot({ path: join(root, 'icons', out), omitBackground: false });
  }
  await browser.close();
})();
