// 画面ロック：パスコードの検証・ハッシュ、自動ロックの判定、Face ID など（WebAuthn）の引数（純粋関数と Web Crypto）
//
// 画面ロックは、端末を手にした人に帳簿を見られないようにするためのもの。データ（IndexedDB）は暗号化しない
// パスコードはそのまま保存せず、PBKDF2（SHA-256）でハッシュにして保存する
// Face ID・Touch ID・Windows Hello は WebAuthn（端末内の認証器・本人確認必須）で、登録した資格情報で本人確認できたら解除する。
// サーバーが無いので署名の検証はしない（clientDataJSON の種類・チャレンジ・オリジンだけ確かめる）

/** パスコード：数字4〜8桁 */
export const PASSCODE_RE = /^\d{4,8}$/;
/** 自動ロックまでの時間（分）。0 はアプリに戻るたびにロック */
export const LOCK_TIMEOUTS = [0, 1, 5, 15];
export const PBKDF2_ITERATIONS = 100000;
const SALT_BYTES = 16;
/** 続けて間違えたときの待ち時間：5回目から30秒、以後2倍（最長15分） */
const FREE_FAILURES = 4;
const FIRST_DELAY = 30 * 1000;
const MAX_DELAY = 15 * 60 * 1000;

const subtle = () => {
  const s = globalThis.crypto?.subtle;
  if (!s) throw new Error('この環境では画面ロックを使えません（暗号の機能がありません）');
  return s;
};

/** 画面ロックを使える環境か（Web Crypto が使える安全な接続） */
export function lockSupported() {
  return Boolean(globalThis.crypto?.subtle && globalThis.crypto.getRandomValues);
}

/** パスコードの検証。エラーメッセージか null */
export function validatePasscode(code, confirm) {
  if (typeof code !== 'string' || !PASSCODE_RE.test(code)) return 'パスコードは数字4〜8桁で入力してください';
  if (confirm !== undefined && code !== confirm) return '確認のパスコードが一致しません';
  return null;
}

export function bytesToBase64Url(bytes) {
  let s = '';
  for (const b of new Uint8Array(bytes)) s += String.fromCharCode(b);
  return btoa(s).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '');
}

export function base64UrlToBytes(text) {
  const b64 = text.replaceAll('-', '+').replaceAll('_', '/');
  const bin = atob(b64 + '='.repeat((4 - (b64.length % 4)) % 4));
  return Uint8Array.from(bin, (c) => c.charCodeAt(0));
}

export function randomBytes(n) {
  return globalThis.crypto.getRandomValues(new Uint8Array(n));
}

/** PBKDF2（SHA-256）で256ビットのハッシュを作る（base64url） */
export async function hashPasscode(code, salt, iterations = PBKDF2_ITERATIONS) {
  const key = await subtle().importKey('raw', new TextEncoder().encode(code), 'PBKDF2', false, ['deriveBits']);
  const bits = await subtle().deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt: base64UrlToBytes(salt), iterations }, key, 256);
  return bytesToBase64Url(bits);
}

/**
 * パスコードからロックの設定を作る
 * @returns {Promise<{ kind: 'passcode', salt, iterations, hash, timeout, webauthn }>}
 */
export async function createLock(code, { timeout = 0, webauthn = null } = {}) {
  const err = validatePasscode(code);
  if (err) throw new Error(err);
  const salt = bytesToBase64Url(randomBytes(SALT_BYTES));
  return { kind: 'passcode', salt, iterations: PBKDF2_ITERATIONS, hash: await hashPasscode(code, salt, PBKDF2_ITERATIONS), timeout, webauthn };
}

/** パスコードが合っているか（長さの違う文字列も最後まで比べる） */
export async function verifyPasscode(code, lock) {
  if (!lock || typeof code !== 'string' || !PASSCODE_RE.test(code)) return false;
  const hash = await hashPasscode(code, lock.salt, lock.iterations);
  let diff = hash.length ^ lock.hash.length;
  for (let i = 0; i < Math.max(hash.length, lock.hash.length); i++) diff |= (hash.charCodeAt(i) || 0) ^ (lock.hash.charCodeAt(i) || 0);
  return diff === 0;
}

/** 保存するロックの設定の検証（壊れた値で締め出されないように） */
export function validateLock(lock) {
  const e = [];
  if (!lock || lock.kind !== 'passcode') e.push('ロックの種類が正しくありません');
  else {
    if (typeof lock.salt !== 'string' || !lock.salt || typeof lock.hash !== 'string' || !lock.hash) e.push('パスコードのデータが正しくありません');
    if (!Number.isInteger(lock.iterations) || lock.iterations < 10000) e.push('パスコードのデータが正しくありません');
    if (!LOCK_TIMEOUTS.includes(lock.timeout)) e.push('自動ロックの時間を選んでください');
    if (lock.webauthn !== null && (typeof lock.webauthn !== 'object' || typeof lock.webauthn.credentialId !== 'string' || !lock.webauthn.credentialId)) e.push('Face ID などのデータが正しくありません');
  }
  return [...new Set(e)];
}

/** アプリが裏に回っていた時間から、ロックするかを決める */
export function needsLock({ hiddenAt, now, timeout }) {
  if (hiddenAt == null) return false;
  return now - hiddenAt >= timeout * 60 * 1000;
}

/** 続けて間違えた回数に応じた待ち時間（ミリ秒） */
export function failureDelay(count) {
  if (count <= FREE_FAILURES) return 0;
  return Math.min(MAX_DELAY, FIRST_DELAY * 2 ** (count - FREE_FAILURES - 1));
}

/** 次に入力できるまでの残り時間（ミリ秒） */
export function waitRemaining(failures, now) {
  if (!failures?.count) return 0;
  return Math.max(0, failures.lastAt + failureDelay(failures.count) - now);
}

/** WebAuthn の登録の引数（端末内の認証器で本人確認を必須にする） */
export function webauthnCreateOptions({ challenge, userId, rpName = 'Pocket会計', userName = 'Pocket会計' }) {
  return {
    rp: { name: rpName },
    user: { id: userId, name: userName, displayName: userName },
    challenge,
    pubKeyCredParams: [
      { type: 'public-key', alg: -7 },
      { type: 'public-key', alg: -257 },
    ],
    authenticatorSelection: { authenticatorAttachment: 'platform', userVerification: 'required', residentKey: 'discouraged' },
    attestation: 'none',
    timeout: 60000,
  };
}

/** WebAuthn の本人確認の引数 */
export function webauthnGetOptions({ challenge, credentialId }) {
  return {
    challenge,
    allowCredentials: [{ type: 'public-key', id: base64UrlToBytes(credentialId) }],
    userVerification: 'required',
    timeout: 60000,
  };
}

/**
 * 認証器が返した clientDataJSON を確かめる（種類・チャレンジ・オリジン）
 * @param {ArrayBuffer|Uint8Array} clientDataJSON
 * @param {Uint8Array} challenge こちらで作ったチャレンジ
 * @param {'webauthn.create'|'webauthn.get'} type
 * @param {string} origin location.origin
 */
export function checkClientData(clientDataJSON, challenge, type, origin) {
  try {
    const data = JSON.parse(new TextDecoder().decode(clientDataJSON));
    return data.type === type && data.challenge === bytesToBase64Url(challenge) && data.origin === origin;
  } catch {
    return false;
  }
}
