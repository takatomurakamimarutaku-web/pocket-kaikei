import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { CHANGELOG, checkChangelog, changesSince, compareVersions, isVersion } from '../js/changelog.js';
import { APP_VERSION } from '../js/version.js';
import { checkVersions, ROOT } from '../scripts/check-pwa.js';

test('更新履歴：先頭が今のバージョンで、新しい順・内容の抜けがない', () => {
  assert.deepEqual(checkChangelog(CHANGELOG, APP_VERSION), []);
  assert.equal(CHANGELOG[0].version, APP_VERSION);
});

test('バージョン：package.json と APP_VERSION と更新履歴がそろっている', async () => {
  const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
  assert.equal(pkg.version, APP_VERSION);
  const { errors } = await checkVersions(ROOT);
  assert.deepEqual(errors, []);
});

test('更新履歴：版を上げて書き忘れたとき・並びの誤り・空の内容を検出する', () => {
  const base = [
    { version: '1.1.0', date: '2026-11-01', title: 'b', items: ['x'] },
    { version: '1.0.0', date: '2026-10-01', title: 'a', items: ['y'] },
  ];
  assert.deepEqual(checkChangelog(base, '1.1.0'), []);
  assert.match(checkChangelog(base, '1.2.0').join('\n'), /先頭が 1\.1\.0.*1\.2\.0/);
  assert.match(checkChangelog([base[1], base[0]], '1.0.0').join('\n'), /新しい順/);
  assert.match(checkChangelog([base[0], { ...base[0] }], '1.1.0').join('\n'), /新しい順/);
  assert.match(checkChangelog([{ version: '1.1', date: '2026/11/01', title: '', items: [] }], '1.1').join('\n'), /0\.1\.0 の形[\s\S]*YYYY-MM-DD[\s\S]*題名[\s\S]*更新内容/);
  assert.match(checkChangelog([{ version: '1.1.0', date: '2026-09-01', title: 'b', items: ['x'] }, base[1]], '1.1.0').join('\n'), /日付が次の版/);
  assert.deepEqual(checkChangelog([], '1.0.0'), ['更新履歴がありません']);
});

test('バージョンの比較は数値で行う（0.10.0 は 0.9.0 より新しい）', () => {
  assert.ok(compareVersions('0.10.0', '0.9.0') > 0);
  assert.ok(compareVersions('0.4.1', '0.4.0') > 0);
  assert.equal(compareVersions('1.2.3', '1.2.3'), 0);
  assert.ok(compareVersions('0.9.9', '1.0.0') < 0);
  assert.ok(isVersion('0.41.0'));
  assert.ok(!isVersion('v0.41.0'));
});

test('前に使っていた版から新しくなった分だけを取り出す', () => {
  const list = [
    { version: '0.12.0' }, { version: '0.11.0' }, { version: '0.10.0' }, { version: '0.9.0' },
  ];
  assert.deepEqual(changesSince(list, '0.9.0', '0.11.0').map((e) => e.version), ['0.11.0', '0.10.0']);
  assert.deepEqual(changesSince(list, '0.9.0').map((e) => e.version), ['0.12.0', '0.11.0', '0.10.0']);
  assert.deepEqual(changesSince(list, '0.12.0'), []);
  assert.deepEqual(changesSince(list, null), []);
  assert.deepEqual(changesSince(list, 'abc'), []);
});

test('過去の版がすべて載っている（0.1.0 から）', () => {
  assert.equal(CHANGELOG.at(-1).version, '0.1.0');
  assert.ok(CHANGELOG.length >= 42);
});
