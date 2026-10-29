// Google ドライブ同期：接続・今すぐ同期・別々に始めた帳簿の選択・接続の解除
import { h, put, showToast, confirmDialog, field, errorBox } from '../ui.js';
import { createDrive, SYNC_FILE_NAME } from '../gdrive.js';
import { runSync, SyncError } from '../sync-run.js';
import { GOOGLE_CLIENT_ID } from '../config.js';
import { APP_VERSION } from '../version.js';
import { errorText } from '../errors.js';

const CLIENT_ID_PATTERN = /^[0-9]+-[0-9a-z]+\.apps\.googleusercontent\.com$/;
let drive = null; // トークンをメモリに保つため、画面を移っても同じ窓口を使う
let driveClientId = '';

export async function render({ app, outlet }) {
  const clientId = GOOGLE_CLIENT_ID || (await app.db.getMeta('googleClientId')) || '';
  const lastSyncAt = await app.db.getMeta('lastSyncAt');
  const fileId = await app.db.getMeta('syncFileId');
  const status = h('div', { 'aria-live': 'polite' });
  if (clientId && driveClientId !== clientId) {
    drive = createDrive({ clientId });
    driveClientId = clientId;
  }
  drive?.preload();

  const about = h(
    'div',
    { class: 'panel' },
    h('h2', { class: 'section-title', text: 'Googleドライブ同期' }),
    h('p', { class: 'small', text: `あなたの Googleドライブに「${SYNC_FILE_NAME}」を1つ作り、複数の端末の帳簿をそろえます。` }),
    h('ul', { class: 'plain-list small' }, [
      h('li', { text: 'このアプリが作ったファイルだけを読み書きします。ドライブのほかのファイルは見えません' }),
      h('li', { text: '同期を押したときだけ通信します。ログインの情報は端末に保存しません' }),
      h('li', { text: '2台で入力した内容は、更新日時と削除の記録をもとにまとめます' }),
    ]),
  );

  if (!clientId) {
    const input = h('input', { id: 'f-client-id', type: 'text', inputmode: 'url', autocomplete: 'off', placeholder: '123456789-xxxx.apps.googleusercontent.com' });
    const form = h(
      'form',
      {
        class: 'panel',
        novalidate: true,
        onsubmit: async (e) => {
          e.preventDefault();
          const v = input.value.trim();
          if (!CLIENT_ID_PATTERN.test(v)) return put(status, errorBox(['クライアントIDの形式が正しくありません（…apps.googleusercontent.com）']));
          await app.db.setMeta('googleClientId', v);
          app.refresh();
        },
      },
      h('h2', { class: 'section-title', text: '準備' }),
      h('p', { class: 'small', text: 'Google Cloud で作成した OAuth クライアントIDを入力してください（初回だけ）。' }),
      field('OAuth クライアントID', input, { name: 'clientId' }),
      h('button', { type: 'submit', class: 'btn btn-primary btn-block', text: '保存する' }),
    );
    put(outlet, about, form, status);
    return;
  }

  const syncBtn = h('button', { type: 'button', class: 'btn btn-primary btn-block', text: fileId ? '今すぐ同期' : 'Googleに接続して同期', onclick: () => sync('merge') });
  put(
    outlet,
    about,
    h(
      'div',
      { class: 'panel' },
      h('p', { class: 'small', text: lastSyncAt ? `前回の同期：${new Date(lastSyncAt).toLocaleString('ja-JP')}` : 'まだ同期していません' }),
      syncBtn,
      status,
    ),
    h(
      'div',
      { class: 'panel' },
      h('h2', { class: 'section-title', text: '接続の管理' }),
      h('button', {
        type: 'button',
        class: 'btn btn-block',
        text: '接続を解除',
        onclick: async () => {
          const ok = await confirmDialog({
            title: '接続を解除しますか？',
            message: 'この端末の同期をやめます。Googleドライブのファイルと、この端末の帳簿はそのまま残ります。',
            buttons: [
              { label: 'キャンセル', value: false },
              { label: '解除する', value: true, variant: 'danger' },
            ],
          });
          if (!ok) return;
          await drive.revoke();
          await app.db.setMeta('syncFileId', null);
          await app.db.setMeta('lastSyncAt', null);
          showToast('接続を解除しました');
          app.refresh();
        },
      }),
      GOOGLE_CLIENT_ID
        ? null
        : h('button', {
            type: 'button',
            class: 'link small',
            text: 'クライアントIDを入力し直す',
            onclick: async () => {
              await app.db.setMeta('googleClientId', null);
              app.refresh();
            },
          }),
    ),
  );

  async function sync(mode) {
    syncBtn.disabled = true;
    put(status, h('p', { class: 'muted small', text: '同期しています…' }));
    try {
      // ポップアップがブロックされないよう、ボタンを押した直後にログインを始める
      await drive.getToken();
      const r = await runSync({ db: app.db, drive, appVersion: APP_VERSION, mode });
      if (r.result === 'needsChoice') return chooseSide();
      const msg = { uploaded: 'Googleドライブに保存しました', replaced: 'Googleドライブの内容を取り込みました', merged: '同期しました' }[r.result];
      showToast(msg, { duration: 5000 });
      if (r.changes?.length) {
        await confirmDialog({ title: '同期で調整した内容', body: h('ul', { class: 'plain-list small' }, r.changes.map((c) => h('li', { text: c }))), buttons: [{ label: 'OK', value: true, variant: 'primary' }] });
      }
      app.refresh();
    } catch (e) {
      put(status, errorBox([e instanceof SyncError || e.name === 'DriveError' ? e.message : errorText(e, '同期')]));
    } finally {
      syncBtn.disabled = false;
    }
  }

  async function chooseSide() {
    put(status);
    const choice = await confirmDialog({
      title: '別々に始めた帳簿です',
      message: 'Googleドライブの帳簿と、この端末の帳簿は別々に作られたため、自動ではまとめられません。どちらを残しますか？選ばなかった方の内容は消えます（先にバックアップを取ると安心です）。',
      buttons: [
        { label: 'やめる', value: null },
        { label: 'この端末の内容でドライブを上書き', value: 'useLocal', variant: 'danger' },
        { label: 'ドライブの内容でこの端末を置き換え', value: 'useRemote', variant: 'danger' },
      ],
    });
    if (choice) await sync(choice);
  }
}
