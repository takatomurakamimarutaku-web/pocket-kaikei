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
    await page.selectOption('#sample-id', entity);
    await page.getByRole('button', { name: 'このサンプルを読み込む' }).click();
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
      // 月別の見込みの表のマスに入れると、その科目が「月ごとに入れる」になる
      const cell = page.locator('input.grid-input').nth(1);
      if (!(await cell.count())) errors.push(`${entity}: 月別の見込みのマスが出ない`);
      else {
        await cell.fill('2,000,000');
        await cell.press('Tab');
        await page.waitForTimeout(400);
        const label = await cell.getAttribute('aria-label');
        if ((await page.getByLabel(label).inputValue()) !== '2,000,000') errors.push(`${entity}: マスの金額が残らない`);
        const focused = await page.evaluate(() => document.activeElement?.dataset?.cell || '');
        if (!focused) errors.push(`${entity}: Tab で次のマスに移らない`);
      }
      await shot('04b-forecast-monthly');
    }
    await go('#/advisor/tax');
    await shot('05-tax');
    await go('#/advisor/simulation');
    if (!pc) {
      const f = page.getByLabel('売上の増減');
      await f.fill('10');
      await f.dispatchEvent('change');
      const t = page.getByLabel(/^目標の/);
      await t.fill('5,000,000');
      await t.dispatchEvent('change');
      await page.waitForTimeout(300);
      if (!(await page.locator('.sim-required').count())) errors.push(`${entity}: 必要売上高が出ない`);
    }
    await shot('07-simulation');
    await go('#/advisor/annual');
    await shot('08-annual');
    if (entity === 'corporation') {
      await go('#/advisor/succession');
      if (!pc) {
        const fill = async (label, v) => { const f = page.getByLabel(label, { exact: true }); await f.fill(v); await f.dispatchEvent('change'); await page.waitForTimeout(150); };
        await fill('従業員数', '12');
        await fill('発行済株式数', '200');
        await fill('A 株価', '320');
        await fill('B 配当金額', '5.2');
        await fill('C 利益金額', '35');
        await fill('D 簿価純資産価額', '310');
        await fill('含み益（土地・有価証券などの相続税評価額 − 帳簿価額）', '40,000,000');
        if ((await page.getByLabel('D 簿価純資産価額', { exact: true }).inputValue()) !== '310') errors.push('入力中の欄が描き直しで消える');
        await fill('利益を下げる額（役員退職金など）', '3,000,000');
        if ((await page.locator('.kpi-value').first().innerText()) === '—') errors.push('株価が出ない');
        await page.getByRole('button', { name: '入力を保存する' }).click();
        await page.waitForTimeout(600);
        if ((await page.getByLabel('発行済株式数', { exact: true }).inputValue()) !== '200') errors.push('事業承継の入力が保存されない');
        await fill('株式以外の財産（相続税の計算用）', '80,000,000');
        await fill('暦年贈与を分ける年数', '5');
        if ((await page.locator('.st-option').count()) !== 4) errors.push('子への承継の選択肢が4つ出ない');
      }
      await shot('09-succession');
      if (!pc) {
        await page.getByLabel('誰に引き継ぐか').selectOption('employee');
        await page.waitForTimeout(300);
        if (!(await page.getByLabel('売る値段', { exact: true }).isVisible())) errors.push('親族外のとき売る値段の欄が出ない');
        await shot('09b-succession-employee');
        await page.getByLabel('誰に引き継ぐか').selectOption('third');
        await page.waitForTimeout(300);
        if ((await page.locator('.st-option').count()) !== 1) errors.push('第三者のとき売却だけにならない');
      }
    }
    await go('#/advisor/meeting');
    await shot('10-meeting');
    if (pc) {
      // 印刷プレビューを開いて PDF を保存する
      await page.click('#print');
      const pv = page.locator('.print-preview');
      await pv.waitFor({ timeout: 5000 }).catch(() => errors.push(`${entity}: 検討会資料のプレビューが開かない`));
      if (await pv.count()) {
        await page.waitForTimeout(400);
        await page.screenshot({ path: join(OUT, `${entity}${pc}-10-meeting-preview.png`) });
        const [download] = await Promise.all([page.waitForEvent('download'), page.getByRole('button', { name: 'PDFを保存・共有' }).click()]);
        await download.saveAs(join(OUT, `${entity}${pc}-10-meeting.pdf`));
        await page.getByRole('button', { name: '閉じる' }).click();
      }
    }
    await go('#/advisor/saving');
    await shot('06-saving');
    // 利益が出ない見込み（法人のサンプル）では金額の入力欄が出ない
    if (!pc && (await page.locator('input.saving-amount').count())) {
      const inp = page.locator('input.saving-amount').first();
      await inp.fill('1,200,000');
      await inp.dispatchEvent('change');
      await page.waitForTimeout(300);
      if ((await page.locator('input.saving-amount').first().inputValue()) !== '1,200,000') errors.push(`${entity}: 節税の金額が反映されない`);
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
