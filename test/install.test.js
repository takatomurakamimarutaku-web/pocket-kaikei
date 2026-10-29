import { test } from 'node:test';
import assert from 'node:assert/strict';
import { installState, isDesktopApp } from '../js/install.js';

test('Windows 版（exe）はインストール済みとして扱う', () => {
  assert.equal(installState({ desktopApp: true, userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Edg/130' }), 'installed');
  assert.equal(installState({ userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Edg/130' }), 'browser');
});

test('iPhone の Safari とホーム画面のアプリを見分ける', () => {
  assert.equal(installState({ userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X)' }), 'ios-browser');
  assert.equal(installState({ standalone: true, userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X)' }), 'installed');
});

test('Tauri の目印で Windows 版を判定する', () => {
  assert.equal(isDesktopApp({ __TAURI_INTERNALS__: {} }), true);
  assert.equal(isDesktopApp({}), false);
  assert.equal(isDesktopApp(undefined), false);
});
