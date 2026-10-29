import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EBOOK_REQUIREMENTS, ebookProcedureText } from '../js/e-book.js';

test('優良な電子帳簿の要件：履歴・入力時期・相互関連性・検索・書類・装置をすべて説明する', () => {
  assert.deepEqual(EBOOK_REQUIREMENTS.map((r) => r.key), ['history', 'late', 'link', 'search', 'docs', 'display']);
  for (const r of EBOOK_REQUIREMENTS) assert.ok(r.title && r.basis && r.app);
});

test('事務手続のひな形：事業者名・バージョン・日付を入れ、法人は経理責任者にする', () => {
  const t = ebookProcedureText({ businessName: 'テスト商店', entityType: 'individual', version: '9.9.9', today: '2026-10-29' });
  assert.match(t, /事業者名：テスト商店/);
  assert.match(t, /バージョン 9\.9\.9/);
  assert.match(t, /制定日：2026\/10\/29/);
  assert.match(t, /管理責任者：事業主/);
  assert.match(t, /2か月を過ぎて入力する/);
  const c = ebookProcedureText({ businessName: '', entityType: 'corporation', version: '1.0.0', today: '2026-04-01' });
  assert.match(c, /管理責任者：経理責任者/);
  assert.match(c, /（事業者名）/);
});
