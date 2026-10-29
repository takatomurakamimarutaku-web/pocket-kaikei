import { test } from 'node:test';
import assert from 'node:assert/strict';
import { IDBFactory } from 'fake-indexeddb';
import { openDB, openDeviceStore, DB_NAME, ValidationError } from '../js/db.js';
import { validatePasscode, createLock, verifyPasscode, hashPasscode, validateLock, needsLock, failureDelay, waitRemaining, webauthnCreateOptions, webauthnGetOptions, checkClientData, bytesToBase64Url, base64UrlToBytes, lockSupported } from '../js/lock.js';
import { templateAccounts } from '../js/accounts.js';
import { createAccount, createPeriod, createSettings } from '../js/models.js';
import { createBackup, parseBackup } from '../js/backup.js';
import { buildSample, SAMPLE_NAMES } from '../js/sample.js';

test('パスコード：数字4〜8桁、確認と一致すること', () => {
  assert.equal(validatePasscode('1234'), null);
  assert.equal(validatePasscode('12345678', '12345678'), null);
  assert.match(validatePasscode('123'), /4〜8桁/);
  assert.match(validatePasscode('123456789'), /4〜8桁/);
  assert.match(validatePasscode('12a4'), /4〜8桁/);
  assert.match(validatePasscode('1234', '1235'), /一致しません/);
  assert.equal(lockSupported(), true);
});

test('パスコードはハッシュで保存し、照合できる（塩が違えば同じパスコードでも別のハッシュ）', async () => {
  const lock = await createLock('2580');
  assert.equal(lock.kind, 'passcode');
  assert.equal(lock.iterations, 100000);
  assert.ok(!JSON.stringify(lock).includes('2580'));
  assert.equal(await verifyPasscode('2580', lock), true);
  assert.equal(await verifyPasscode('2581', lock), false);
  assert.equal(await verifyPasscode('', lock), false);
  assert.equal(await verifyPasscode('2580', null), false);
  const other = await createLock('2580');
  assert.notEqual(other.salt, lock.salt);
  assert.notEqual(other.hash, lock.hash);
  // 決まった塩・回数なら同じハッシュ（PBKDF2-SHA256・256ビット）
  assert.equal(await hashPasscode('2580', 'AAAAAAAAAAAAAAAAAAAAAA', 10000), await hashPasscode('2580', 'AAAAAAAAAAAAAAAAAAAAAA', 10000));
  assert.equal(base64UrlToBytes(lock.hash).length, 32);
  await assert.rejects(createLock('12'));
  assert.deepEqual(validateLock(lock), []);
  assert.ok(validateLock({ ...lock, timeout: 3 }).length);
  assert.ok(validateLock({ ...lock, iterations: 10 }).length);
  assert.ok(validateLock({ ...lock, webauthn: { credentialId: '' } }).length);
  assert.ok(validateLock(null).length);
});

test('自動ロック：裏に回っていた時間と設定の時間で決める', () => {
  const t = Date.parse('2026-10-29T10:00:00Z');
  assert.equal(needsLock({ hiddenAt: null, now: t, timeout: 0 }), false);
  assert.equal(needsLock({ hiddenAt: t, now: t, timeout: 0 }), true);
  assert.equal(needsLock({ hiddenAt: t, now: t + 59999, timeout: 1 }), false);
  assert.equal(needsLock({ hiddenAt: t, now: t + 60000, timeout: 1 }), true);
  assert.equal(needsLock({ hiddenAt: t, now: t + 4 * 60000, timeout: 5 }), false);
});

test('続けて間違えたとき：4回までは待たない。5回目から30秒、以後2倍で最長15分', () => {
  assert.deepEqual([0, 1, 4, 5, 6, 7, 10, 20].map(failureDelay), [0, 0, 0, 30000, 60000, 120000, 900000, 900000]);
  const now = 1000000;
  assert.equal(waitRemaining({ count: 5, lastAt: now - 10000 }, now), 20000);
  assert.equal(waitRemaining({ count: 5, lastAt: now - 40000 }, now), 0);
  assert.equal(waitRemaining({ count: 0, lastAt: 0 }, now), 0);
});

test('WebAuthn：端末内の認証器・本人確認必須で登録し、clientDataJSON の種類・チャレンジ・オリジンを確かめる', () => {
  const challenge = new Uint8Array([1, 2, 3, 250, 251, 252]);
  const create = webauthnCreateOptions({ challenge, userId: new Uint8Array([9]) });
  assert.equal(create.authenticatorSelection.authenticatorAttachment, 'platform');
  assert.equal(create.authenticatorSelection.userVerification, 'required');
  assert.deepEqual(create.pubKeyCredParams.map((p) => p.alg), [-7, -257]);
  assert.equal(create.rp.id, undefined); // 開いているページのドメインを使う
  const id = bytesToBase64Url(new Uint8Array([7, 7, 255]));
  const get = webauthnGetOptions({ challenge, credentialId: id });
  assert.deepEqual([...get.allowCredentials[0].id], [7, 7, 255]);
  assert.equal(get.userVerification, 'required');
  const json = (o) => new TextEncoder().encode(JSON.stringify(o));
  const origin = 'https://example.github.io';
  assert.equal(checkClientData(json({ type: 'webauthn.get', challenge: bytesToBase64Url(challenge), origin }), challenge, 'webauthn.get', origin), true);
  assert.equal(checkClientData(json({ type: 'webauthn.create', challenge: bytesToBase64Url(challenge), origin }), challenge, 'webauthn.get', origin), false);
  assert.equal(checkClientData(json({ type: 'webauthn.get', challenge: 'xxx', origin }), challenge, 'webauthn.get', origin), false);
  assert.equal(checkClientData(json({ type: 'webauthn.get', challenge: bytesToBase64Url(challenge), origin: 'https://evil.example' }), challenge, 'webauthn.get', origin), false);
  assert.equal(checkClientData(new Uint8Array([1, 2]), challenge, 'webauthn.get', origin), false);
  assert.deepEqual([...base64UrlToBytes(bytesToBase64Url(challenge))], [...challenge]);
});

test('帳簿：最初は従来のデータベースを1冊目にする。追加・切替・名前・削除', async () => {
  const indexedDB = new IDBFactory();
  // 帳簿の機能の前から使っている人のデータ
  const old = await openDB({ indexedDB });
  await old.setup({ settings: createSettings({ businessName: '山田商店', entityType: 'individual' }), period: createPeriod({ startDate: '2026-01-01', endDate: '2026-12-31' }), accounts: templateAccounts('individual').map((a) => createAccount(a)) });
  old.close();

  const device = await openDeviceStore({ indexedDB });
  const first = await device.currentBook();
  assert.equal(first.dbName, DB_NAME);
  assert.ok(first.id && first.createdAt && first.updatedAt);
  assert.equal((await device.currentBook()).id, first.id); // 2回目も同じ
  const repo1 = await openDB({ indexedDB, name: first.dbName });
  assert.equal((await repo1.getSettings()).businessName, '山田商店');
  await device.setBookInfo(first.id, { label: '山田商店', entityType: 'individual' });

  const second = await device.addBook();
  assert.equal(second.dbName, `${DB_NAME}-${second.id}`);
  await device.switchBook(second.id);
  assert.equal((await device.currentBook()).id, second.id);
  const repo2 = await openDB({ indexedDB, name: second.dbName });
  assert.equal(await repo2.getSettings(), null); // 新しい帳簿は初期設定から
  await repo2.setup({ settings: createSettings({ businessName: '株式会社ヤマダ', entityType: 'corporation' }), period: createPeriod({ startDate: '2026-04-01', endDate: '2027-03-31' }), accounts: templateAccounts('corporation').map((a) => createAccount(a)) });
  assert.equal((await repo1.getSettings()).businessName, '山田商店'); // 帳簿ごとにデータが分かれる
  await device.setBookInfo(second.id, { label: '株式会社ヤマダ', entityType: 'corporation' });
  assert.deepEqual((await device.listBooks()).map((b) => [b.label, b.entityType]), [['山田商店', 'individual'], ['株式会社ヤマダ', 'corporation']]);

  await assert.rejects(device.deleteBook(second.id), ValidationError); // 今の帳簿は消せない
  await assert.rejects(device.switchBook('none'), ValidationError);
  await device.switchBook(first.id);
  repo2.close();
  await device.deleteBook(second.id);
  assert.equal((await device.listBooks()).length, 1);
  const reopened = await openDB({ indexedDB, name: second.dbName });
  assert.equal(await reopened.getSettings(), null); // データベースごと消えている
  reopened.close();
  repo1.close();
  device.close();
});

test('事業所：バックアップ・サンプルのデータで新しい事業所を作る。今の事業所は残す。失敗したら何も残さない', async () => {
  const indexedDB = new IDBFactory();
  const device = await openDeviceStore({ indexedDB });
  const first = await device.currentBook();
  const repo1 = await openDB({ indexedDB, name: first.dbName });
  await repo1.setup({ settings: createSettings({ businessName: '山田商店', entityType: 'individual' }), period: createPeriod({ startDate: '2026-01-01', endDate: '2026-12-31' }), accounts: templateAccounts('individual').map((a) => createAccount(a)) });

  const data = parseBackup(JSON.stringify(createBackup(buildSample('corporation'), { appVersion: '0.0.0' })));
  const book = await device.addBookWithData(data);
  assert.equal(book.label, SAMPLE_NAMES.corporation);
  assert.equal(book.entityType, 'corporation');
  assert.equal((await device.currentBook()).id, first.id); // 切り替えは画面の側で行う
  const repo2 = await openDB({ indexedDB, name: book.dbName });
  assert.equal((await repo2.getSettings()).businessName, SAMPLE_NAMES.corporation);
  assert.equal((await repo2.listJournals((await repo2.getCurrentPeriod()).id)).length, data.journals.length);
  assert.equal((await repo1.getSettings()).businessName, '山田商店'); // 今の事業所はそのまま
  repo2.close();

  // 壊れたデータ（設定が無い）なら、作りかけの事業所を残さない
  await assert.rejects(device.addBookWithData({ ...data, settings: null }));
  assert.deepEqual((await device.listBooks()).map((b) => b.id), [first.id, book.id]);
  repo1.close();
  device.close();
});

test('画面ロックの設定は端末の設定に保存し、間違えた回数を数える。すべて消す', async () => {
  const indexedDB = new IDBFactory();
  const device = await openDeviceStore({ indexedDB });
  const book = await device.currentBook();
  assert.equal(await device.getLock(), null);
  const lock = await createLock('1357', { timeout: 5 });
  const saved = await device.saveLock(lock);
  assert.ok(saved.id && saved.createdAt && saved.updatedAt);
  assert.equal((await device.getLock()).timeout, 5);
  await assert.rejects(device.saveLock({ ...lock, timeout: 2 }), ValidationError);
  assert.equal((await device.recordFailure(1000)).count, 1);
  assert.deepEqual(await device.recordFailure(2000), { count: 2, lastAt: 2000 });
  await device.resetFailures();
  assert.equal((await device.getFailures()).count, 0);
  await device.recordFailure();
  await device.clearLock();
  assert.equal(await device.getLock(), null);
  assert.equal((await device.getFailures()).count, 0);

  // パスコードを忘れたとき：すべての帳簿と端末の設定を消す
  await device.saveLock(lock);
  const repo = await openDB({ indexedDB, name: book.dbName });
  await repo.setup({ settings: createSettings({ businessName: '山田商店', entityType: 'individual' }), period: createPeriod({ startDate: '2026-01-01', endDate: '2026-12-31' }), accounts: templateAccounts('individual').map((a) => createAccount(a)) });
  repo.close();
  await device.eraseAll();
  assert.equal(await device.getLock(), null);
  assert.equal((await device.listBooks()).length, 0);
  const after = await openDB({ indexedDB, name: book.dbName });
  assert.equal(await after.getSettings(), null);
  after.close();
  device.close();
});
