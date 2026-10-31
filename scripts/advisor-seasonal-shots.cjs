// 季節変動・特別な支出の注意と年計の確認：法人のサンプルを読み込み、前期（当期の仕訳を1年前にずらして88%にし、12月の賞与・3月の保険料を足す）を作って撮る
// 使い方：python3 -m http.server 8123 & node scripts/advisor-seasonal-shots.cjs
const { chromium } = require('playwright');
(async () => {
  const b = await chromium.launch(); const ctx = await b.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, serviceWorkers: 'block' }); const p = await ctx.newPage();
  p.on('console', (m) => m.type() === 'error' && console.log('CON', m.text()));
  await p.goto('http://localhost:8123/'); await p.waitForSelector('form.setup');
  await p.selectOption('#sample-id', 'corporation'); await p.getByRole('button', { name: 'このサンプルを読み込む' }).click();
  await p.waitForTimeout(1200);
  await p.evaluate(async () => {
    const db = await new Promise((res, rej) => { const r = indexedDB.open('pocket-kaikei'); r.onsuccess = () => res(r.result); r.onerror = rej; });
    const all = (s) => new Promise((res) => { const r = db.transaction(s).objectStore(s).getAll(); r.onsuccess = () => res(r.result); });
    const periods = await all('periods'); const journals = await all('journals'); const accs = await all('accounts');
    const cur = periods[0];
    const back = (d) => `${Number(d.slice(0, 4)) - 1}${d.slice(4)}`;
    const prev = { ...cur, id: 'prev-demo', startDate: back(cur.startDate), endDate: back(cur.endDate), forecast: undefined };
    const tx = db.transaction(['periods', 'journals'], 'readwrite');
    tx.objectStore('periods').put(prev);
    let n = 0;
    for (const j of journals.filter((x) => x.periodId === cur.id)) tx.objectStore('journals').put({ ...j, id: `prevj-${n++}`, periodId: prev.id, date: back(j.date), lines: j.lines.map((l) => ({ ...l, amount: Math.round(l.amount * 0.88) })) }); // 前期は今期の88%（年計が伸びる形にする）
    // 前期の12月に賞与、3月に保険料の年払い
    const by = (name) => accs.find((a) => a.name === name);
    const mk = (date, dr, amt) => ({ ...journals[0], id: `prevx-${n++}`, periodId: prev.id, date, lines: [{ side: 'debit', accountId: by(dr).id, subAccountId: null, amount: amt, taxCategory: 'none', memo: '' }, { side: 'credit', accountId: by('普通預金').id, subAccountId: null, amount: amt, taxCategory: 'none', memo: '' }] });
    tx.objectStore('journals').put(mk(back(cur.startDate).slice(0, 4) + '-12-10', '賞与', 2400000));
    tx.objectStore('journals').put(mk(`${Number(cur.endDate.slice(0, 4)) - 1}-03-10`, '保険料', 600000));
    await new Promise((res) => (tx.oncomplete = res));
  });
  await p.reload(); await p.waitForTimeout(1200);
  await p.evaluate(() => (location.hash = '#/advisor/forecast')); await p.waitForTimeout(1500);
  const el = p.locator('.advisor-advice-list');
  console.log('advice count', await p.locator('.advisor-advice').count());
  await p.screenshot({ path: 'shots/advisor/corporation-07-seasonal.png', fullPage: true });
  await p.getByLabel('賞与の見込みの立て方').selectOption('average'); await p.waitForTimeout(500);
  await p.screenshot({ path: 'shots/advisor/corporation-08-seasonal-missing.png', fullPage: true });
  const btn = p.getByRole('button', { name: '月ごとに入れる' }).first();
  if (await btn.count()) { await btn.click(); await p.waitForTimeout(500); await p.screenshot({ path: 'shots/advisor/corporation-09-seasonal-fixed.png', fullPage: true }); }
  await p.getByLabel('前期を並べる').check(); await p.waitForTimeout(400);
  await p.screenshot({ path: 'shots/advisor/corporation-11-grid-prev.png', fullPage: true });
  await p.evaluate(() => (location.hash = '#/advisor/annual')); await p.waitForTimeout(1200);
  await p.screenshot({ path: 'shots/advisor/corporation-10-annual-with-prev.png', fullPage: true });
  await p.getByLabel('グラフにする項目').selectOption({ label: '賞与' });
  await p.waitForTimeout(300);
  await p.getByRole('radio', { name: '各月の金額' }).click(); await p.waitForTimeout(300);
  await p.screenshot({ path: 'shots/advisor/corporation-12-annual-account.png', fullPage: true });
  await p.setViewportSize({ width: 1280, height: 900 }); await p.waitForTimeout(400);
  await p.getByRole('radio', { name: '年計' }).click(); await p.waitForTimeout(300);
  await p.screenshot({ path: 'shots/advisor/corporation-pc-12-annual.png', fullPage: true });
  await b.close();
})();
