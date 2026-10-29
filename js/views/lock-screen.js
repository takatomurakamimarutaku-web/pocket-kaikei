// 画面ロックの解除画面：アプリの画面の上に重ね、解除するまで帳簿の画面を見せない
import { h, confirmDialog } from '../ui.js';
import { verifyPasscode, waitRemaining, webauthnGetOptions, checkClientData, randomBytes, bytesToBase64Url } from '../lock.js';

let active = null;

/** ロック中か */
export function isLocked() {
  return Boolean(active);
}

/**
 * ロックする。解除されたら resolve する（すでにロック中なら同じ Promise を返す）
 * @param {{ device: import('../db.js').DeviceStore, lock: object, onErase: () => Promise<void> }} p
 */
export function lockScreen({ device, lock, onErase }) {
  if (active) return active;
  document.body.classList.add('is-locked');
  let finish;
  active = new Promise((resolve) => (finish = resolve));
  const prevFocus = document.activeElement;

  const message = h('p', { class: 'lock-message', role: 'alert' });
  const input = h('input', { id: 'lock-code', type: 'password', inputmode: 'numeric', autocomplete: 'off', maxlength: 8, 'aria-label': 'パスコード', placeholder: 'パスコード' });
  const submit = h('button', { type: 'submit', class: 'btn btn-primary btn-block', text: '解除する' });

  function unlock() {
    overlay.remove();
    document.body.classList.remove('is-locked');
    active = null;
    if (prevFocus?.focus) prevFocus.focus();
    finish();
  }

  async function tryPasscode() {
    const failures = await device.getFailures();
    const wait = waitRemaining(failures, Date.now());
    if (wait > 0) {
      message.textContent = `続けて間違えたため、あと${Math.ceil(wait / 1000)}秒待ってください`;
      return;
    }
    submit.disabled = true;
    const ok = await verifyPasscode(input.value.trim(), lock).catch(() => false);
    submit.disabled = false;
    if (ok) {
      await device.resetFailures();
      unlock();
      return;
    }
    const next = await device.recordFailure();
    input.value = '';
    message.textContent = next.count >= 5 ? `パスコードが違います（${next.count}回目）。しばらく入力できません` : 'パスコードが違います';
    input.focus();
  }

  async function tryWebAuthn() {
    message.textContent = '';
    try {
      const challenge = randomBytes(32);
      const cred = await navigator.credentials.get({ publicKey: webauthnGetOptions({ challenge, credentialId: lock.webauthn.credentialId }) });
      if (cred && bytesToBase64Url(cred.rawId) === lock.webauthn.credentialId && checkClientData(cred.response.clientDataJSON, challenge, 'webauthn.get', location.origin)) {
        await device.resetFailures();
        unlock();
        return;
      }
      message.textContent = '本人確認できませんでした。パスコードを入力してください';
    } catch {
      message.textContent = '本人確認できませんでした。パスコードを入力してください';
    }
  }

  async function forgot() {
    const ok = await confirmDialog({
      title: 'パスコードを忘れたとき',
      message: 'パスコードは取り出せません。この端末のすべての帳簿のデータと画面ロックを消して、初期設定からやり直します。バックアップファイルがあれば、初期設定のあとに「バックアップ」から復元できます。元に戻せません。',
      buttons: [
        { label: 'キャンセル', value: false },
        { label: 'すべて消す', value: true, variant: 'danger' },
      ],
    });
    if (ok === true) await onErase();
  }

  const canWebAuthn = Boolean(lock.webauthn && globalThis.PublicKeyCredential && navigator.credentials);
  const overlay = h(
    'div',
    { class: 'lock-screen', role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': 'lock-title' },
    h(
      'div',
      { class: 'lock-box' },
      h('img', { class: 'lock-icon', src: 'icons/icon.svg', alt: '' }),
      h('h2', { id: 'lock-title', text: 'Pocket会計はロックされています' }),
      h('form', { class: 'lock-form', novalidate: true, onsubmit: (e) => (e.preventDefault(), tryPasscode()) }, input, submit),
      canWebAuthn ? h('button', { type: 'button', class: 'btn btn-block', text: 'Face ID・指紋などで解除する', onclick: tryWebAuthn }) : null,
      message,
      h('button', { type: 'button', class: 'btn btn-small btn-link lock-forgot', text: 'パスコードを忘れたとき', onclick: forgot }),
    ),
  );
  document.body.append(overlay);
  input.focus();
  return active;
}
