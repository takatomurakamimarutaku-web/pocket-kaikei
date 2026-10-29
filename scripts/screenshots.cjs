// スマホ幅（390×844）で主な画面を操作してスクリーンショットを撮る（開発時のみ）
//   python3 -m http.server 8123 & node scripts/screenshots.cjs [entityType]
const { chromium } = require('playwright');
const { mkdirSync } = require('node:fs');
const { join } = require('node:path');

const BASE = process.env.BASE_URL || 'http://localhost:8123/';
const entity = process.argv[2] || 'individual';
const OUT = join(__dirname, '..', 'shots');
mkdirSync(OUT, { recursive: true });

(async () => {
  const browser = await chromium.launch();
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, serviceWorkers: 'block', locale: 'ja-JP' });
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
  page.on('console', (m) => m.type() === 'error' && errors.push(`console: ${m.text()}`));
  const shot = async (name, full = false) => {
    await page.waitForTimeout(350);
    await page.screenshot({ path: join(OUT, `${entity}-${name}.png`), fullPage: full });
  };
  const go = async (hash) => {
    await page.evaluate((h) => (location.hash = h), hash);
    await page.waitForTimeout(400);
  };
  const pick = async (index, side, name) => {
    await page.locator('.jrow').nth(index).locator(`.jside-${side} .acc-btn`).click();
    await page.fill('.sheet input[type=search]', name);
    await page.locator('.picker-item', { hasText: name }).first().click();
  };
  const amount = (index, side, v) => page.locator('.jrow').nth(index).locator(`.jside-${side} .amount-input`).fill(String(v));

  await page.goto(BASE);
  await page.waitForSelector('form.setup');
  await shot('01-setup');
  await page.fill('#f-name', entity === 'individual' ? 'むらかみ商店' : '株式会社ポケット');
  if (entity === 'corporation') {
    await page.getByRole('radio', { name: '法人' }).click();
    await page.fill('#f-start', '2026-04-01');
    await page.dispatchEvent('#f-start', 'change');
    await page.getByRole('radio', { name: '課税事業者' }).click();
  }
  await page.click('button[type=submit]');
  await page.waitForSelector('.stat-grid');

  // 期首残高
  await go('#/opening');
  const ob = entity === 'individual'
    ? [['現金', 30000], ['普通預金', 500000], ['売掛金', 110000], ['買掛金', 50000]]
    : [['現金', 30000], ['普通預金', 2000000], ['資本金', 1500000], ['繰越利益剰余金', 530000]];
  for (const [n, v] of ob) await page.getByLabel(n, { exact: true }).fill(String(v));
  await page.getByRole('button', { name: '保存する' }).click();
  await shot('02-opening', true);

  // 仕訳の入力（単一・複合）
  const entries = [
    ['2026-04-05', [[['売掛金', 220000]], [['売上高', 220000]]], '4月分 売上'],
    ['2026-04-10', [[['消耗品費', 3300], ['通信費', 5500]], [['現金', 8800]]], '文具・携帯代'],
    ['2026-04-25', [[['地代家賃', 88000]], [['普通預金', 88000]]], '事務所家賃'],
    ['2026-04-28', [[['普通預金', 110000]], [['売掛金', 110000]]], '入金'],
  ];
  for (const [date, [debits, credits], memo] of entries) {
    await go('#/journal/new');
    await page.fill('#j-date', date);
    await page.dispatchEvent('#j-date', 'change');
    const n = Math.max(debits.length, credits.length);
    for (let i = 1; i < n; i++) await page.getByRole('button', { name: '＋ 行を追加（複合仕訳）' }).click();
    for (let i = 0; i < n; i++) {
      if (debits[i]) {
        await pick(i, 'debit', debits[i][0]);
        await amount(i, 'debit', debits[i][1]);
      }
      if (credits[i]) {
        await pick(i, 'credit', credits[i][0]);
        await amount(i, 'credit', credits[i][1]);
      }
    }
    await page.locator('.jrow').nth(0).getByLabel('1行目の摘要').fill(memo);
    if (memo === '文具・携帯代') await shot('03-entry-compound', true);
    await page.getByRole('button', { name: '登録する' }).click();
    await page.waitForTimeout(300);
  }
  // 貸借不一致では登録できない
  await go('#/journal/new');
  await pick(0, 'debit', '旅費交通費');
  await amount(0, 'debit', 1000);
  await pick(0, 'credit', '現金');
  await amount(0, 'credit', 900);
  const disabled = await page.getByRole('button', { name: '登録する' }).isDisabled();
  if (!disabled) errors.push('貸借不一致なのに登録ボタンが押せる');
  await shot('04-entry-unbalanced');
  await page.locator('.jrow').nth(0).locator('.jside-credit .amount-input').fill('1000');
  // 摘要の候補
  await page.getByLabel('1行目の摘要').fill('事務');
  await shot('05-entry-suggest');
  await page.getByLabel('1行目の摘要').fill('電車代');
  await page.getByRole('button', { name: '登録する' }).click();
  await page.waitForTimeout(300);

  // かんたん入力
  const slot = (label) => page.locator('.qslot').filter({ hasText: label });
  const quick = async (kind, date, amountValue, memo, choose) => {
    await go(`#/quick/${kind}`);
    await page.fill('#q-date', date);
    await page.dispatchEvent('#q-date', 'change');
    await page.fill('#q-amount', String(amountValue));
    await page.fill('#q-memo', memo);
    await choose();
  };
  const register = async () => {
    await page.getByRole('button', { name: '登録する' }).click();
    await page.waitForTimeout(300);
  };
  await go('#/entry');
  await shot('17-entry-menu', true);
  await quick('sale', '2026-04-15', 33000, '〇〇様 デザイン料', () => slot('受け取り方').getByRole('radio', { name: '普通預金', exact: true }).click());
  await page.locator('#q-memo').blur();
  await shot('18-quick-sale', true);
  await register();
  await quick('expense', '2026-04-16', 1200, '電車代 打合せ', async () => {
    await slot('経費の科目').locator('.acc-btn').click();
    await page.fill('.sheet input[type=search]', '旅費');
    await page.locator('.picker-item', { hasText: '旅費交通費' }).first().click();
  });
  await page.locator('#q-memo').blur();
  await shot('19-quick-expense', true);
  await register();
  await quick('transfer', '2026-04-20', 20000, 'ATM 引き出し', () => slot('出した元').getByRole('radio', { name: '普通預金', exact: true }).click());
  await register();
  // 同じ科目どうしは登録できない
  await quick('transfer', '2026-04-20', 100, '', () => slot('出した元').getByRole('radio', { name: '現金', exact: true }).click());
  await page.getByRole('button', { name: '登録する' }).click();
  await page.waitForTimeout(200);
  if (!(await page.locator('.errors-wrap').innerText()).includes('同じ科目')) errors.push('同じ科目の預け入れが拒否されない');
  // 出納帳
  await go('#/cashbook?month=2026-04');
  await shot('20-cashbook', true);
  await page.getByRole('link', { name: '− 出金を記録' }).click();
  await page.waitForTimeout(400);
  await page.fill('#q-date', '2026-04-30');
  await page.dispatchEvent('#q-date', 'change');
  await page.fill('#q-amount', '50000');
  await slot('相手の科目').locator('.acc-btn').click();
  await page.fill('.sheet input[type=search]', '消耗品');
  await page.locator('.picker-item', { hasText: '消耗品費' }).first().click();
  await page.locator('#q-amount').blur();
  await shot('21-quick-cash-out', true);
  await register();
  await go('#/cashbook?month=2026-04');
  await shot('22-cashbook-negative', true);
  if (!(await page.locator('.notice').count())) errors.push('現金のマイナス残高の注意が出ない');

  await go('#/journals?month=2026-04');
  await shot('06-journals', true);
  await go('#/reports');
  await shot('07-reports');
  await go('#/reports/trial');
  await shot('08-trial', true);
  await go(`#/reports/ledger?account=${await page.evaluate(async () => '')}`);
  await go('#/reports/ledger');
  await page.locator('.ledger-pick select').first().selectOption({ label: '100 現金' });
  await shot('09-ledger', true);
  await page.locator('.ledger-pick select').first().selectOption('all');
  await page.waitForTimeout(300);
  await shot('09b-ledger-all', true);
  if ((await page.locator('.lg-section').count()) < 3) errors.push('すべての科目の元帳が出ない');
  const [dl] = await Promise.all([page.waitForEvent('download', { timeout: 5000 }).catch(() => null), page.getByRole('button', { name: 'CSVで書き出す' }).click()]);
  if (!dl || !(await require('node:fs').promises.readFile(await dl.path(), 'utf8')).includes('前期繰越')) errors.push('元帳のCSVを書き出せない');
  await go('#/reports/pl');
  await shot('10-pl', true);
  await go('#/reports/bs');
  await shot('11-bs', true);
  const bsText = await page.locator('.check-line').innerText();
  if (!bsText.includes('＝')) errors.push(`BSが一致しない: ${bsText}`);
  await go('#/reports/tax');
  await shot('12-tax', true);
  await go('#/reports/monthly');
  await page.locator('.ch-hit').nth(entity === 'individual' ? 3 : 0).click();
  await shot('23-monthly-pl', true);
  await page.emulateMedia({ colorScheme: 'dark' });
  await shot('24-monthly-pl-dark');
  await page.emulateMedia({ colorScheme: 'light' });
  await page.getByRole('radio', { name: '貸借（月末残高）' }).click();
  await shot('25-monthly-bs', true);
  if (await page.locator('.notice').count()) errors.push('月次貸借で一致しない月がある');
  await go('#/accounts');
  await shot('13-accounts');
  await go('#/home');
  await shot('14-home', true);
  await go('#/backup');
  await shot('15-backup');
  await go('#/more');
  await shot('16-more');

  // 固定資産台帳
  await go('#/assets');
  await shot('33-assets-empty');
  const addAsset = async (fill, shotName) => {
    await go('#/asset/new');
    await fill();
    await page.waitForTimeout(200);
    if (shotName) await shot(shotName, true);
    await page.getByRole('button', { name: '登録する' }).click();
    await page.waitForTimeout(500);
  };
  await addAsset(async () => {
    await page.fill('#f-name', 'ノートパソコン');
    await page.fill('#f-acquired', '2026-04-15');
    await page.dispatchEvent('#f-acquired', 'input');
    await page.fill('#f-cost', '264000');
    await page.fill('#f-life', '4');
    if (entity === 'individual') {
      await page.selectOption('#f-method', 'straight');
      await page.fill('#f-ratio', '80');
    }
  }, '34-asset-form');
  await addAsset(async () => {
    await page.fill('#f-name', entity === 'individual' ? 'デスク' : '会計ソフト');
    await page.fill('#f-acquired', '2026-05-20');
    await page.dispatchEvent('#f-acquired', 'input');
    if (entity === 'individual') {
      await page.fill('#f-cost', '150000');
      await page.selectOption('#f-method', 'lump3');
    } else {
      await page.selectOption('#f-category', 'intangible');
      await page.fill('#f-cost', '300000');
      await page.selectOption('#f-method', 'straight');
      await page.fill('#f-life', '5');
    }
  });
  // アプリを使う前からある資産：前の帳簿の期首帳簿価額を引き継ぐ
  await addAsset(async () => {
    await page.fill('#f-name', '軽自動車');
    await page.selectOption('#f-category', 'vehicle');
    await page.fill('#f-acquired', '2023-04-01');
    await page.dispatchEvent('#f-acquired', 'input');
    await page.fill('#f-cost', '1200000');
    await page.selectOption('#f-method', 'straight');
    await page.fill('#f-life', '4');
    if (!(await page.locator('.carry-box').isVisible())) errors.push('前の帳簿からの引き継ぎ欄が出ない');
    await page.fill('#f-carry-book', '400000');
    await page.dispatchEvent('#f-carry-book', 'input');
    await page.waitForTimeout(200);
    const first = await page.locator('.report tbody tr').first().innerText();
    if (!first.includes('2026') || !first.includes('300,000')) errors.push(`引き継いだ帳簿価額から償却していない：${first}`);
  }, '35a-asset-carry');
  if ((await page.locator('.asset-row').count()) !== 3) errors.push('固定資産を登録できない');
  // 耐用年数表から選び、中古資産の耐用年数を計算する。資産番号・設置場所も入れる
  await addAsset(async () => {
    await page.selectOption('#f-preset', { label: '自動車（普通車など）　6年' });
    if ((await page.inputValue('#f-life')) !== '6' || (await page.inputValue('#f-category')) !== 'vehicle') errors.push('耐用年数表から選んでも種類・年数が入らない');
    await page.fill('#f-name', '中古の営業車');
    await page.fill('#f-acquired', '2026-07-01');
    await page.dispatchEvent('#f-acquired', 'input');
    await page.fill('#f-cost', '880000');
    await page.locator('.used-box summary').click();
    await page.fill('#f-used-years', '2');
    await page.fill('#f-used-months', '6');
    await page.getByRole('button', { name: '計算して耐用年数に入れる' }).click();
    if ((await page.inputValue('#f-life')) !== '4') errors.push('中古資産の耐用年数が4年にならない');
    await page.fill('#f-no', 'V-002');
    await page.fill('#f-location', '本店駐車場');
  }, '35b-asset-used');
  await shot('35-assets-list', true);
  // 売却：ノートパソコンを売り、仕訳を作る
  await page.locator('.asset-row', { hasText: 'ノートパソコン' }).click();
  await page.waitForTimeout(400);
  await page.getByRole('link', { name: '売却・除却する（仕訳も作る）' }).click();
  await page.waitForTimeout(400);
  await page.fill('#d-date', '2026-12-31');
  await page.dispatchEvent('#d-date', 'change');
  await page.fill('#d-price', '110000');
  await page.waitForTimeout(300);
  await shot('35c-asset-dispose', true);
  if (!(await page.getByText('課税売上10%').count())) errors.push('売却の仕訳に課税売上が付かない');
  await page.getByRole('button', { name: '資産と仕訳を登録する' }).click();
  await page.waitForTimeout(600);
  if (!(await page.getByText('売却済み').count())) errors.push('売却後の編集画面に売却済みが出ない');
  await go('#/assets');
  if (!(await page.locator('.asset-row', { hasText: '売却 2026/12/31' }).count())) errors.push('売却した資産に印が付かない');
  await shot('35d-assets-after-sale', true);

  // 振り分けルール（ひらがなで登録しても半角カナの摘要に当たる）
  await go('#/import/bank/rules');
  await page.fill('#rule-keyword', 'どこも');
  await page.locator('#rule-account').click();
  await page.fill('.sheet input[type=search]', '通信費');
  await page.locator('.picker-item', { hasText: '通信費' }).first().click();
  await page.waitForTimeout(200);
  await shot('36a-bank-rules-form', true);
  await page.getByRole('button', { name: '追加する' }).click();
  await page.waitForTimeout(500);
  await shot('36b-bank-rules', true);
  if (!(await page.locator('.rule-row', { hasText: 'どこも' }).count())) errors.push('振り分けルールを登録できない');

  // 銀行明細CSVの取り込み（Shift_JIS・三菱UFJ銀行に似せた形式）
  await go('#/import/bank');
  await page.selectOption('#bi-account', { label: '普通預金' });
  await page.setInputFiles('#bi-file', join(__dirname, '..', 'test', 'fixtures', 'bank-sample-sjis.csv'));
  await page.waitForTimeout(500);
  await shot('36-bank-import', true);
  if (!(await page.locator('.bi-row', { hasText: 'ドコモ' }).getByText('ルール「どこも」').count())) errors.push('振り分けルールが取り込みに使われない');
  const pickFor = async (memo, name) => {
    await page.locator('.bi-row', { hasText: memo }).first().locator('.acc-btn').click();
    await page.fill('.sheet input[type=search]', name);
    await page.locator('.picker-item', { hasText: name }).first().click();
    await page.waitForTimeout(200);
  };
  await pickFor('マルタク', '売上高');
  await pickFor('ドコモ', '通信費');
  await pickFor('アマゾン', '消耗品費');
  await pickFor('振込手数料', '支払手数料');
  await page.waitForTimeout(300);
  await shot('37-bank-import-ready', true);
  if ((await page.locator('.bi-row', { hasText: 'マルタク' }).locator('.acc-btn', { hasText: '売上高' }).count()) !== 2) errors.push('同じ摘要の明細に科目が入らない');
  await page.getByRole('button', { name: /件を仕訳として登録する/ }).click();
  await page.waitForTimeout(700);
  await shot('38-bank-import-done', true);
  if (!(await page.locator('table.cashbook').innerText()).includes('フリコミ')) errors.push('取り込んだ明細が出納帳に出ない');
  // 同じファイルをもう一度読むと、登録済みの印が付き、初期状態で外れる
  await go('#/import/bank');
  await page.selectOption('#bi-account', { label: '普通預金' });
  await page.setInputFiles('#bi-file', join(__dirname, '..', 'test', 'fixtures', 'bank-sample-sjis.csv'));
  await page.waitForTimeout(500);
  if ((await page.getByText('登録済みかも').count()) !== 5) errors.push('取り込み済みの明細を重複として示さない');

  // 詳しい税区分（法人）：仕入の用途区分を使い、非課税売上・共通対応の仕入・売上の返品を入力する
  if (entity === 'corporation') {
    await go('#/settings');
    await page.getByRole('radio', { name: '使う' }).click();
    await page.getByRole('button', { name: '保存する' }).click();
    await page.waitForTimeout(400);
    const taxEntry = async (date, [dn, dt], [cn, ct], v, memo) => {
      await go('#/journal/new');
      await page.fill('#j-date', date);
      await page.dispatchEvent('#j-date', 'change');
      await pick(0, 'debit', dn);
      await amount(0, 'debit', v);
      await pick(0, 'credit', cn);
      await amount(0, 'credit', v);
      if (dt) await page.selectOption('[aria-label="1行目の借方税区分"]', dt);
      if (ct) await page.selectOption('[aria-label="1行目の貸方税区分"]', ct);
      await page.getByLabel('1行目の摘要').fill(memo);
      if (memo === '共用部分の家賃') {
        const groups = await page.locator('[aria-label="1行目の借方税区分"] optgroup').count();
        if (groups !== 7) errors.push(`税区分のグループが${groups}個（7個のはず）`);
        await shot('46-entry-tax-detail', true);
      }
      await page.getByRole('button', { name: '登録する' }).click();
      await page.waitForTimeout(300);
    };
    await taxEntry('2026-05-01', ['普通預金'], ['売上高', 'sales_exempt'], 3000000, '住宅の家賃収入');
    await taxEntry('2026-05-02', ['地代家賃', 'purchase_10_c'], ['普通預金'], 110000, '共用部分の家賃');
    await taxEntry('2026-05-03', ['売上高', 'sales_return_10'], ['売掛金'], 11000, '返品');
    await go('#/reports/tax?from=2026-04&to=2027-03');
    await shot('47-tax-detail', true);
    if (!(await page.getByText('売上の返品・値引き・貸倒れ').count())) errors.push('集計に売上の返品のグループが出ない');
    await go('#/reports/tax-return');
    await page.getByRole('radio', { name: '個別対応' }).click();
    await page.waitForTimeout(200);
    await shot('48-tax-return-individual', true);
    if (!(await page.getByText('返還等対価に係る税額').count())) errors.push('申告計算に返還等対価に係る税額が出ない');
    if (!(await page.getByText(/個別対応方式で仕入の税額の一部/).count())) errors.push('95%未満の按分の注意が出ない');
  }

  // 消費税の申告計算
  await go('#/reports/tax-return');
  await shot('39-tax-return', true);
  await page.getByRole('radio', { name: '簡易' }).click();
  await page.selectOption('#tr-type', '5');
  await page.waitForTimeout(200);
  await shot('40-tax-return-simplified', true);
  await page.getByRole('radio', { name: '2割' }).click();
  await page.waitForTimeout(200);
  if (entity === 'corporation') {
    await page.getByRole('button', { name: '消費税等の仕訳を登録する' }).click();
    await page.waitForTimeout(600);
    if (!(await page.getByText('消費税等の仕訳は登録済みです').count())) errors.push('消費税等の仕訳を登録できない');
    await shot('41-tax-return-booked', true);
    await go('#/reports/tax-return');
    if ((await page.getByRole('radio', { name: '2割' }).getAttribute('aria-checked')) !== 'true') errors.push('計算の方法が保存されない');
  }

  // 月次推移試算表（四半期・半期・決算整理の列）
  await go('#/reports/trial-monthly');
  await shot('49-trial-monthly', true);
  for (const label of ['四半期の合計', '半期の合計', '決算整理を別の列に']) await page.getByLabel(label, { exact: true }).check();
  await page.waitForTimeout(300);
  await shot('49b-trial-monthly-options', true);
  for (const col of ['第1四半期', '上半期', '決算整理', '合計']) if (!(await page.locator('table.mtb thead th', { hasText: col }).count())) errors.push(`月次推移試算表に「${col}」の列が出ない`);
  if (!(await page.evaluate(() => location.hash.includes('adj=1')))) errors.push('月次推移試算表のオプションがURLに残らない');

  // 青色申告決算書（個人のみ）
  if (entity === 'individual') {
    await go('#/reports/blue-return?page=1');
    await shot('42-blue-return-1', true);
    for (const n of ['2', '3', '4']) {
      await page.getByRole('radio', { name: new RegExp(`^${n} `) }).click();
      await page.waitForTimeout(200);
      await shot(`4${Number(n) + 1}-blue-return-${n}`, true);
    }
    if (!(await page.locator('.check-line.ok').count())) errors.push('青色申告決算書の貸借対照表が一致しない');
  }

  // 印刷/PDF：帳票はヘッダーに印刷ボタンが出る。印刷用の表示で PDF にして、ページ数と操作部品が消えることを確かめる
  const printPdf = async (hash, name, minPages = 1) => {
    await go(hash);
    if (!(await page.locator('#print').isVisible())) errors.push(`${hash} に印刷ボタンがない`);
    await page.emulateMedia({ media: 'print' });
    if (await page.locator('.tabbar').isVisible()) errors.push(`${hash} の印刷にタブが出る`);
    if (!(await page.locator('#print-head').isVisible())) errors.push(`${hash} の印刷に見出しがない`);
    const pdf = await page.pdf({ path: join(OUT, `${entity}-print-${name}.pdf`), format: 'A4', printBackground: true });
    await page.emulateMedia({ media: null });
    const pages = (pdf.toString('latin1').match(/\/Type\s*\/Page[^s]/g) || []).length;
    if (pages < minPages) errors.push(`${hash} の PDF が ${pages} ページ（${minPages} ページ以上のはず）`);
  };
  await printPdf('#/reports/trial', 'trial');
  await printPdf('#/reports/bs', 'bs');
  await printPdf('#/reports/ledger?account=all', 'ledger-all', 2);
  if (entity === 'individual') await printPdf('#/reports/blue-return?page=1', 'blue-return', 4);
  await go('#/settings');
  if (await page.locator('#print').isVisible()) errors.push('帳票以外の画面に印刷ボタンが出る');

  // 決算・繰越
  await go('#/closing');
  await shot('26-closing', true);
  await page.fill('#inv-amount', '45000');
  await page.getByRole('button', { name: '棚卸の仕訳を登録する' }).click();
  await page.waitForTimeout(500);
  await page.getByRole('button', { name: '減価償却の仕訳を登録する' }).click();
  await page.waitForTimeout(500);
  if (!(await page.getByText('減価償却の仕訳は登録済みです').count())) errors.push('減価償却の仕訳を登録できない');
  await go('#/reports/bs');
  if (!(await page.locator('.check-line').innerText()).includes('＝')) errors.push('減価償却後のBSが一致しない');
  await go('#/closing');
  await page.getByRole('button', { name: '繰り越して次の期間を始める' }).scrollIntoViewIfNeeded();
  await shot('27-closing-after-inventory', true);
  await page.getByRole('button', { name: '繰り越して次の期間を始める' }).click();
  await shot('28-closing-confirm');
  await page.getByRole('button', { name: '繰り越す', exact: true }).click();
  await page.waitForTimeout(600);
  await shot('29-home-next-period', true);
  await go('#/reports/bs');
  if (!(await page.locator('.check-line').innerText()).includes('＝')) errors.push('繰越後の期首BSが一致しない');
  // 前の期間に切り替えて仕訳を追加すると、次の期間で期首残高の更新を促す
  await go('#/periods');
  await page.getByRole('button', { name: '表示する' }).click();
  await page.waitForTimeout(500);
  await quick('expense', '2026-04-21', 500, '切手', async () => {
    await slot('経費の科目').locator('.acc-btn').click();
    await page.fill('.sheet input[type=search]', '通信');
    await page.locator('.picker-item', { hasText: '通信費' }).first().click();
  });
  await register();
  await go('#/periods');
  await page.getByRole('button', { name: '表示する' }).click();
  await page.waitForTimeout(500);
  await go('#/periods');
  await shot('30-periods-stale', true);
  if (!(await page.locator('.notice').count())) errors.push('前期変更後に期首残高の更新を促さない');
  await page.getByRole('button', { name: '前期末の残高で期首残高を更新' }).click();
  await page.waitForTimeout(600);
  if (await page.locator('.notice').count()) errors.push('期首残高の更新後も注意が残る');
  // 前期を締めると、その期間の仕訳は表示のみになる
  await page.getByRole('button', { name: '締める', exact: true }).click();
  await page.getByRole('button', { name: '締める', exact: true }).last().click();
  await page.waitForTimeout(500);
  await shot('31-periods-closed', true);
  await page.getByRole('button', { name: '表示する' }).click();
  await page.waitForTimeout(500);
  await go('#/journals?month=all');
  await page.locator('.jcard').first().click();
  await page.waitForTimeout(500);
  await shot('32-journal-locked', true);
  if (await page.getByRole('button', { name: '保存する' }).count()) errors.push('締めた期間の仕訳が編集できる');
  await go('#/quick/sale');
  if (!(await page.locator('.notice').count())) errors.push('締めた期間でかんたん入力ができる');

  console.log(errors.length ? `NG\n${errors.join('\n')}` : 'OK: エラーなし');
  await browser.close();
  process.exit(errors.length ? 1 : 0);
})();
