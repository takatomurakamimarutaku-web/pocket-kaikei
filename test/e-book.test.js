import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EBOOK_REQUIREMENTS, ebookProcedureText, ETRADE_REQUIREMENTS, etradeRuleText } from '../js/e-book.js';

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

test('電子取引のデータ：真実性・見読・検索・ダウンロードの要件と、事務処理規程のひな形（個人は記録、法人は申請と承認）', () => {
  assert.deepEqual(ETRADE_REQUIREMENTS.map((r) => r.key), ['integrity', 'display', 'search', 'download']);
  for (const r of ETRADE_REQUIREMENTS) assert.ok(r.title && r.basis && r.app && r.user);
  const t = etradeRuleText({ businessName: 'テスト商店', entityType: 'individual', today: '2026-10-29' });
  assert.match(t, /電子取引データの訂正及び削除の防止に関する事務処理規程/);
  assert.match(t, /テスト商店において適正に保存/);
  assert.match(t, /管理責任者は、事業主/);
  assert.match(t, /電子取引データ訂正・削除の記録/);
  assert.match(t, /2026\/10\/29から施行/);
  assert.doesNotMatch(t, /null/);
  const c = etradeRuleText({ businessName: '', entityType: 'corporation', today: '2026-04-01' });
  assert.match(c, /経理責任者/);
  assert.match(c, /申請書」を管理責任者に提出し、承認を受ける/);
  assert.match(c, /（事業者名）/);
  assert.match(c, /　3　訂正したデータ/);
});
