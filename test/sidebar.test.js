import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sidebarSections, activeHref } from '../js/sidebar.js';

test('PC のサイドメニュー：法人は決算書（計算書類）、個人は青色申告決算書を出す', () => {
  const hrefs = (settings) => sidebarSections(settings).flatMap((s) => s.items.map((i) => i.href));
  const corp = hrefs({ entityType: 'corporation' });
  assert.ok(corp.includes('#/reports/financial'));
  assert.ok(!corp.includes('#/reports/blue-return'));
  const ind = hrefs({ entityType: 'individual', filing: 'blue' });
  assert.ok(ind.includes('#/reports/blue-return'));
  assert.ok(!ind.includes('#/reports/financial'));
  // 出納帳は「日々の入力」にだけ出す（重複させない）
  assert.equal(corp.filter((h) => h === '#/cashbook').length, 1);
  assert.equal(new Set(corp).size, corp.length);
});

test('今の画面に当たる項目', () => {
  const hrefs = ['#/home', '#/journals', '#/journal/new', '#/reports/trial', '#/assets', '#/invoices'];
  assert.equal(activeHref(hrefs, '#/journals?month=2026-10'), '#/journals');
  assert.equal(activeHref(hrefs, '#/reports/trial'), '#/reports/trial');
  assert.equal(activeHref(hrefs, '#/invoices/abc'), '#/invoices');
  assert.equal(activeHref(hrefs, '#/asset/abc'), null);
  assert.equal(activeHref(hrefs, '#/journal/abc/edit'), null);
});
