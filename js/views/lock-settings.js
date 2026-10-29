// 画面ロックの設定：パスコード（数字4〜8桁）、自動ロックまでの時間、Face ID・指紋など（WebAuthn）
import { h, put, field, segmented, showToast, errorBox } from '../ui.js';
import { lockSupported, createLock, verifyPasscode, validatePasscode, LOCK_TIMEOUTS, webauthnCreateOptions, checkClientData, randomBytes, bytesToBase64Url } from '../lock.js';
import { ValidationError } from '../db.js';

const TIMEOUT_LABELS = { 0: 'すぐ', 1: '1分', 5: '5分', 15: '15分' };

async function platformAuthenticator() {
  try {
    return Boolean(globalThis.PublicKeyCredential?.isUserVerifyingPlatformAuthenticatorAvailable && (await PublicKeyCredential.isUserVerifyingPlatformAuthenticatorAvailable()));
  } catch {
    return false;
  }
}

export async function render({ app, outlet }) {
  const device = app.device;
  const about = h(
    'div',
    { class: 'panel small muted' },
    h('p', { text: '画面ロックを設定すると、アプリを開いたときと、ほかのアプリから戻ったときにパスコードを聞きます。端末を手にした人に帳簿を見られないようにするためのものです（データそのものは暗号化していません）。' }),
    h('p', { text: '画面ロックはこの端末のすべての事業所に共通で、バックアップファイルには入りません。パスコードを忘れると、すべての事業所のデータを消してバックアップから復元するしかないので、バックアップを取っておいてください。' }),
  );
  if (!lockSupported()) {
    put(outlet, h('p', { class: 'notice', text: 'この環境では画面ロックを使えません（https で開いたページかホーム画面のアプリで使えます）。' }), about);
    return;
  }
  const hasPlatform = await platformAuthenticator();
  const errorsEl = h('div');
  const body = h('div');

  const passInput = (id, label, autocomplete = 'new-password') => {
    const input = h('input', { id, type: 'password', inputmode: 'numeric', autocomplete, maxlength: 8, placeholder: '数字4〜8桁' });
    return { input, el: field(label, input) };
  };
  const fail = (messages) => put(errorsEl, errorBox(Array.isArray(messages) ? messages : [messages]));
  const saveLock = async (lock, message) => {
    try {
      await device.saveLock(lock);
      await app.refreshLock();
      put(errorsEl);
      showToast(message);
      await paint();
    } catch (e) {
      fail(e instanceof ValidationError ? e.errors : ['保存できませんでした']);
    }
  };

  function setupForm() {
    const a = passInput('lock-new', '新しいパスコード');
    const b = passInput('lock-confirm', 'もう一度入力');
    return h(
      'form',
      {
        class: 'panel',
        novalidate: true,
        onsubmit: async (e) => {
          e.preventDefault();
          const err = validatePasscode(a.input.value.trim(), b.input.value.trim());
          if (err) return fail(err);
          await saveLock(await createLock(a.input.value.trim()), '画面ロックを設定しました');
        },
      },
      h('h2', { class: 'section-title', text: 'パスコードを設定する' }),
      a.el,
      b.el,
      h('button', { type: 'submit', class: 'btn btn-primary btn-block', text: '画面ロックを設定する' }),
    );
  }

  async function registerWebAuthn(lock) {
    try {
      const challenge = randomBytes(32);
      const cred = await navigator.credentials.create({ publicKey: webauthnCreateOptions({ challenge, userId: randomBytes(16) }) });
      if (!cred || !checkClientData(cred.response.clientDataJSON, challenge, 'webauthn.create', location.origin)) return fail('登録できませんでした');
      await saveLock({ ...lock, webauthn: { credentialId: bytesToBase64Url(cred.rawId), createdAt: new Date().toISOString() } }, 'Face ID・指紋などを登録しました');
    } catch (e) {
      fail(e?.name === 'NotAllowedError' ? '登録を取り消しました' : '登録できませんでした');
    }
  }

  function settingsForms(lock) {
    const cur = passInput('lock-current', '今のパスコード', 'current-password');
    const a = passInput('lock-new', '新しいパスコード');
    const b = passInput('lock-confirm', 'もう一度入力');
    const off = passInput('lock-off', '今のパスコード', 'current-password');
    return [
      h(
        'section',
        { class: 'panel' },
        h('p', { class: 'check-line ok', text: '画面ロックを使っています' }),
        field(
          '自動ロックまでの時間',
          segmented({
            name: '自動ロックまでの時間',
            options: LOCK_TIMEOUTS.map((v) => ({ value: String(v), label: TIMEOUT_LABELS[v] })),
            value: String(lock.timeout),
            onChange: (v) => saveLock({ ...lock, timeout: Number(v) }, '自動ロックの時間を保存しました'),
          }),
          { hint: 'ほかのアプリに切り替えてから戻るまでの時間。「すぐ」は戻るたびにロックし、アプリの切替画面にも帳簿を出しません' },
        ),
        hasPlatform
          ? lock.webauthn
            ? h('div', {}, h('p', { class: 'small', text: 'Face ID・指紋など（この端末の生体認証・画面ロック）で解除できます。' }), h('button', { type: 'button', class: 'btn btn-block', text: 'Face ID・指紋などを使わない', onclick: () => saveLock({ ...lock, webauthn: null }, 'Face ID・指紋などの登録を外しました') }))
            : h('button', { type: 'button', class: 'btn btn-block', text: 'Face ID・指紋などを登録する', onclick: () => registerWebAuthn(lock) })
          : h('p', { class: 'muted small', text: 'この端末・ブラウザでは Face ID・指紋などの解除を使えません（パスコードで解除します）。' }),
        h('button', { type: 'button', class: 'btn btn-block', text: '今すぐロックする', onclick: () => app.lock() }),
      ),
      h(
        'form',
        {
          class: 'panel',
          novalidate: true,
          onsubmit: async (e) => {
            e.preventDefault();
            if (!(await verifyPasscode(cur.input.value.trim(), lock))) return fail('今のパスコードが違います');
            const err = validatePasscode(a.input.value.trim(), b.input.value.trim());
            if (err) return fail(err);
            await saveLock(await createLock(a.input.value.trim(), { timeout: lock.timeout, webauthn: lock.webauthn }), 'パスコードを変更しました');
          },
        },
        h('h2', { class: 'section-title', text: 'パスコードを変更する' }),
        cur.el,
        a.el,
        b.el,
        h('button', { type: 'submit', class: 'btn btn-block', text: 'パスコードを変更する' }),
      ),
      h(
        'form',
        {
          class: 'panel',
          novalidate: true,
          onsubmit: async (e) => {
            e.preventDefault();
            if (!(await verifyPasscode(off.input.value.trim(), lock))) return fail('今のパスコードが違います');
            await device.clearLock();
            await app.refreshLock();
            put(errorsEl);
            showToast('画面ロックをやめました');
            await paint();
          },
        },
        h('h2', { class: 'section-title', text: '画面ロックをやめる' }),
        off.el,
        h('button', { type: 'submit', class: 'btn btn-danger-text btn-block', text: '画面ロックをやめる' }),
      ),
    ];
  }

  async function paint() {
    const lock = await device.getLock();
    put(body, lock ? settingsForms(lock) : setupForm());
  }

  put(outlet, errorsEl, body, about);
  await paint();
}
