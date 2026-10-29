// バックアップ（JSON の書き出し）と復元（置き換え）
import { h, put, showToast, confirmDialog, saveFile } from '../ui.js';
import { createBackup, parseBackup, backupFileName, BackupError } from '../backup.js';
import { APP_VERSION } from '../version.js';
import { errorText } from '../errors.js';

export async function render({ app, outlet }) {
  const counts = await app.db.counts();
  const lastBackupAt = await app.db.getMeta('lastBackupAt');
  const file = h('input', { type: 'file', accept: 'application/json,.json', hidden: true, onchange: () => file.files[0] && restore(file.files[0]) });

  put(outlet, 
    h(
      'div',
      { class: 'panel' },
      h('h2', { class: 'section-title', text: '書き出し' }),
      h('p', { class: 'small', text: `仕訳 ${counts.journals}件・勘定科目 ${counts.accounts}件・補助科目 ${counts.subAccounts}件` }),
      h('p', { class: 'muted small', text: lastBackupAt ? `前回のバックアップ：${new Date(lastBackupAt).toLocaleString('ja-JP')}` : 'まだバックアップしていません' }),
      h('p', { class: 'muted small', text: 'iPhone では共有シートが開きます。「“ファイル”に保存」で iCloud Drive などに保存してください。' }),
      h('button', { type: 'button', class: 'btn btn-primary btn-block', text: 'バックアップを書き出す', onclick: exportBackup }),
    ),
    h(
      'div',
      { class: 'panel' },
      h('h2', { class: 'section-title', text: '復元' }),
      h('p', { class: 'small', text: 'バックアップファイルの内容で、この端末のデータをすべて置き換えます。' }),
      h('p', { class: 'muted small', text: 'ファイルの内容（貸借の一致・科目の参照など）をすべて確認してから置き換えます。問題があれば何も変更しません。' }),
      h('button', { type: 'button', class: 'btn btn-block', text: 'ファイルを選んで復元', onclick: () => file.click() }),
      file,
    ),
  );

  async function exportBackup() {
    try {
      const data = await app.db.dumpAll();
      const now = new Date();
      const blob = new Blob([JSON.stringify(createBackup(data, { appVersion: APP_VERSION, exportedAt: now }))], { type: 'application/json' });
      const result = await saveFile(blob, backupFileName(now));
      if (result === 'cancelled') return;
      await app.db.setMeta('lastBackupAt', now.toISOString());
      showToast('バックアップを書き出しました');
      app.refresh();
    } catch (e) {
      showToast(errorText(e, 'バックアップを書き出すことが'));
    }
  }

  async function restore(f) {
    file.value = '';
    let data;
    try {
      data = parseBackup(await f.text());
    } catch (e) {
      showToast(e instanceof BackupError ? e.message : errorText(e, '読み込み'), { duration: 6000 });
      return;
    }
    const ok = await confirmDialog({
      title: 'このバックアップで置き換えますか？',
      message: `${data.settings.businessName}・仕訳 ${data.journals.length}件（${data.exportedAt ? new Date(data.exportedAt).toLocaleString('ja-JP') : '日時不明'} に作成）。現在のデータ（仕訳 ${counts.journals}件）は消えます。`,
      buttons: [
        { label: 'キャンセル', value: false },
        { label: '置き換える', value: true, variant: 'danger' },
      ],
    });
    if (!ok) return;
    try {
      await app.db.replaceAll(data);
      showToast('復元しました');
      app.navigate('#/home', { replace: true });
    } catch (e) {
      showToast(errorText(e, '復元'));
    }
  }
}
