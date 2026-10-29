// 消費税の集計表：科目別税区分集計表・税区分別の月別推移・税区分のチェックリスト
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { taxByAccount, taxMonthly, taxChecks } from '../js/tax-reports.js';
import { summarizeTax } from '../js/tax.js';
import { taxByAccountCsv, taxMonthlyCsv } from '../js/csv.js';
import { monthsInPeriod } from '../js/period.js';
import { makeBook } from './helpers.js';

function book() {
  const b = makeBook('corporation', { startDate: '2026-04-01', endDate: '2027-03-31' });
  const { j } = b;
  const journals = [
    j('2026-04-05', [['売掛金', 110000]], [['売上高', 110000]]), // 売10
    j('2026-04-06', [['現金', 10800]], [['売上高', 10800, 'sales_8r']]),
    j('2026-04-10', [['消耗品費', 3300], ['通信費', 5500]], [['現金', 8800]]),
    j('2026-05-01', [['会議費', 2200, 'none']], [['現金', 2200]]), // 経費が対象外
    j('2026-05-15', [['現金', 1100]], [['消耗品費', 1100]]), // 経費の返金を貸方で（仕入の税区分のまま）
    j('2026-05-20', [['売上高', 11000]], [['売掛金', 11000]]), // 売上の返品を借方で（売上の税区分のまま）
    j('2026-06-01', [['普通預金', 50000, 'sales_10']], [['雑収入', 50000, 'purchase_10']]), // 誤り2つ
    j('2026-06-30', [['工具器具備品', 220000]], [['普通預金', 220000]]), // 固定資産の取得（課税仕入）
  ];
  return { ...b, journals };
}

test('科目別税区分集計表：科目ごとに税区分の税込・税抜・消費税等。対象外を除いた合計は税区分別集計と一致する', () => {
  const { accounts, journals, byName } = book();
  const r = taxByAccount({ journals, accounts });
  const row = (name) => r.rows.find((x) => x.account.id === byName[name].id);
  const sales = row('売上高');
  assert.deepEqual(sales.items.map((x) => [x.code, x.gross, x.tax]), [
    ['sales_10', 110000 - 11000, 9000],
    ['sales_8r', 10800, 800],
  ]);
  assert.equal(sales.total.gross, 109800);
  // 消耗品費：3,300 − 返金 1,100
  assert.equal(row('消耗品費').items[0].gross, 2200);
  // 損益の科目の対象外は出す（会議費）。貸借の科目の対象外（現金など）は出さない
  assert.deepEqual(row('会議費').items.map((x) => [x.code, x.gross]), [['none', 2200]]);
  assert.equal(row('現金'), undefined);
  // 固定資産の課税仕入は出る
  assert.equal(row('工具器具備品').items[0].tax, 20000);
  // 並びは科目の順（売上高 → 費用）
  assert.ok(r.rows.findIndex((x) => x.account.name === '売上高') < r.rows.findIndex((x) => x.account.name === '消耗品費'));
  const s = summarizeTax(journals);
  for (const x of r.byCode.filter((c) => c.code !== 'none')) assert.equal(x.gross, s.rows.find((y) => y.code === x.code).gross, x.code);
});

test('科目別税区分集計表：期間と決算整理の仕訳の除外', () => {
  const { accounts, journals, j } = book();
  const adj = { ...j('2027-03-31', [['消耗品費', 5500]], [['未払金', 5500]]), adjusting: true };
  const all = [...journals, adj];
  const gross = (opts) => taxByAccount({ journals: all, accounts, ...opts }).rows.find((x) => x.account.name === '消耗品費').items[0].gross;
  assert.equal(gross({}), 2200 + 5500);
  assert.equal(gross({ includeAdjusting: false }), 2200);
  assert.equal(taxByAccount({ journals: all, accounts, from: '2026-04-01', to: '2026-04-30' }).rows.find((x) => x.account.name === '消耗品費').items[0].gross, 3300);
});

test('税区分別の月別推移：月ごとの税込金額と消費税等、差引の参考値', () => {
  const { journals, period } = book();
  const months = monthsInPeriod(period);
  const r = taxMonthly({ journals, period, months });
  const s10 = r.rows.find((x) => x.code === 'sales_10');
  assert.equal(s10.gross[0], 110000);
  assert.equal(s10.gross[1], -11000);
  assert.equal(s10.gross[2], -50000); // 普通預金の借方に売10（誤り）は売上のマイナス
  assert.equal(s10.total.gross, 49000);
  assert.equal(s10.tax[0], 10000);
  assert.equal(r.netTax.length, 12);
  // 期間の差引は税区分別集計の netTax と同じ
  assert.equal(r.netTaxTotal, summarizeTax(journals).netTax);
  assert.ok(!r.rows.some((x) => x.code === 'none'));
});

test('税区分のチェックリスト：収益に仕入、現金・預金に税区分、返品を逆側で処理、初期値との違い', () => {
  const { accounts, journals } = book();
  const list = taxChecks({ journals, accounts });
  const types = list.map((x) => `${x.journal.date}:${x.account.name}:${x.type}`);
  assert.ok(types.includes('2026-06-01:普通預金:bs_taxed'));
  assert.ok(types.includes('2026-06-01:雑収入:income_purchase'));
  assert.ok(types.includes('2026-05-15:消耗品費:purchase_credit'));
  assert.ok(types.includes('2026-05-20:売上高:sales_debit'));
  // 正しい仕訳・固定資産の取得は出ない
  assert.ok(!list.some((x) => ['2026-04-05', '2026-04-10', '2026-06-30'].includes(x.journal.date)));
  assert.equal(list.filter((x) => x.level === 'warn').length, 2);
  // 初期値との違い（会議費の対象外、売上高の8%）は指定したときだけ
  assert.ok(!types.some((t) => t.endsWith('default_diff')));
  const more = taxChecks({ journals, accounts, includeDefaultDiff: true }).map((x) => `${x.account.name}:${x.type}`);
  assert.ok(more.includes('会議費:default_diff'));
  assert.ok(more.includes('売上高:default_diff'));
});

test('費用の科目で売上の返品・貸倒れの税区分は誤りにしない（売上値引・貸倒損失など）', () => {
  const { accounts, j } = book();
  const list = taxChecks({ accounts, journals: [j('2026-07-01', [['雑費', 11000, 'sales_baddebt_10']], [['売掛金', 11000]]), j('2026-07-02', [['雑費', 1100, 'sales_10']], [['現金', 1100]])] });
  assert.deepEqual(list.map((x) => `${x.journal.date}:${x.type}`), ['2026-07-02:expense_sales']);
});

test('CSV：科目別税区分集計表と月別推移', () => {
  const { accounts, journals, period } = book();
  const a = taxByAccountCsv(taxByAccount({ journals, accounts }));
  assert.match(a, /コード,科目,税区分,件数,税込金額/);
  assert.match(a, /500,売上高,課税売上10%,2,99000,90000,9000/);
  assert.match(a, /,合計,課税売上10%,/);
  const m = taxMonthlyCsv(taxMonthly({ journals, period, months: monthsInPeriod(period).slice(0, 3) }));
  assert.match(m, /課税売上10%,税込金額,110000,-11000,-50000,49000/);
  assert.match(m, /差引,消費税等（参考）/);
});
