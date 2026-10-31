// 事業所の切替：個人と法人、複数の会社などを、事業所ごとにデータベースを分けて持つ（弥生会計の事業所データにあたる）
import { h, put, showToast, confirmDialog } from '../ui.js';
import { ValidationError } from '../db.js';
import { createBackup, parseBackup, verifyAttachments, BackupError } from '../backup.js';
import { buildSample, SAMPLE_NAMES } from '../sample.js';
import { sampleChooser } from './sample-load.js';
import { ENTITY_LABELS } from '../models.js';
import { APP_VERSION } from '../version.js';
import { errorText } from '../errors.js';

export async function render({ app, outlet }) {
  const device = app.device;
  const listEl = h('div');
  const name = (b) => b.label || '（初期設定がまだの事業所）';
  const file = h('input', { type: 'file', accept: 'application/json,.json', hidden: true, onchange: () => file.files[0] && addFromBackup(file.files[0]) });

  async function remove(book) {
    const ok = await confirmDialog({
      title: `「${name(book)}」を削除しますか？`,
      message: 'この事業所の仕訳・科目・設定・証憑をすべて消します。元に戻せません。必要なら、先にこの事業所に切り替えてバックアップしてください。',
      buttons: [
        { label: 'キャンセル', value: false },
        { label: '削除する', value: true, variant: 'danger' },
      ],
    });
    if (ok !== true) return;
    try {
      await device.deleteBook(book.id);
      showToast('事業所を削除しました');
      await paint();
    } catch (e) {
      showToast(e instanceof ValidationError ? e.errors.join(' ') : errorText(e, '削除'));
    }
  }

  async function add() {
    const ok = await confirmDialog({
      title: '新しい事業所を作りますか？',
      message: '新しい事業所に切り替えて、初期設定（事業者名・個人/法人・会計期間）から始めます。今の事業所のデータはそのまま残り、この画面からいつでも戻れます。',
      buttons: [
        { label: 'キャンセル', value: false },
        { label: '作る', value: true, variant: 'primary' },
      ],
    });
    if (ok !== true) return;
    const book = await device.addBook();
    await app.switchBook(book.id, '#/setup');
  }

  /** 検証済みのデータで新しい事業所を作って切り替える（今の事業所は置き換えない） */
  async function addWithData(data, done) {
    try {
      const book = await device.addBookWithData(data);
      showToast(done, { duration: 6000 });
      await app.switchBook(book.id);
    } catch (e) {
      showToast(errorText(e, '事業所の作成'));
    }
  }

  async function addFromBackup(f) {
    file.value = '';
    let data;
    try {
      data = parseBackup(await f.text());
      await verifyAttachments(data);
    } catch (e) {
      showToast(e instanceof BackupError ? e.message : errorText(e, '読み込み'), { duration: 6000 });
      return;
    }
    const ok = await confirmDialog({
      title: 'このバックアップから事業所を作りますか？',
      message: `${data.settings.businessName}（${ENTITY_LABELS[data.settings.entityType]}）・仕訳 ${data.journals.length}件${data.attachments.length ? `・証憑 ${data.attachments.length}件` : ''}（${data.exportedAt ? new Date(data.exportedAt).toLocaleString('ja-JP') : '日時不明'} に作成）。新しい事業所として取り込み、切り替えます。今の事業所のデータはそのまま残ります。`,
      buttons: [
        { label: 'キャンセル', value: false },
        { label: '取り込む', value: true, variant: 'primary' },
      ],
    });
    if (ok !== true) return;
    await addWithData(data, `「${data.settings.businessName}」を取り込みました`);
  }

  async function addSample(id) {
    const data = parseBackup(JSON.stringify(createBackup(buildSample(id), { appVersion: APP_VERSION })));
    await addWithData(data, `サンプルの事業所（${SAMPLE_NAMES[id]}）を作りました`);
  }

  async function paint() {
    // 今開いている事業所を先頭に、ほかは作った順
    const books = (await device.listBooks()).sort((a, b) => (b.id === app.book.id) - (a.id === app.book.id));
    put(
      listEl,
      h(
        'ul',
        { class: 'book-list' },
        books.map((b) => {
          const current = b.id === app.book.id;
          return h(
            'li',
            { class: `book-item${current ? ' is-current' : ''}` },
            h('p', { class: 'book-name' }, name(b), current ? h('span', { class: 'book-badge', text: '使用中' }) : null),
            ENTITY_LABELS[b.entityType] ? h('p', { class: 'muted small book-type', text: ENTITY_LABELS[b.entityType] }) : null,
            current
              ? h('p', { class: 'muted small', text: '今開いている事業所です。' })
              : h(
                  'div',
                  { class: 'book-actions' },
                  h('button', { type: 'button', class: 'btn btn-small btn-primary', text: 'この事業所に切り替える', onclick: () => app.switchBook(b.id) }),
                  h('button', { type: 'button', class: 'btn btn-small btn-danger-text', text: '削除', onclick: () => remove(b) }),
                ),
          );
        }),
      ),
    );
  }

  put(
    outlet,
    listEl,
    h(
      'div',
      { class: 'panel' },
      h('h2', { class: 'section-title', text: '新しい事業所を作る' }),
      h('button', { type: 'button', class: 'btn btn-primary btn-block', text: '空の事業所を作る（初期設定から）', onclick: add }),
      h('button', { type: 'button', class: 'btn btn-block', text: 'バックアップから作る', onclick: () => file.click() }),
      h('p', { class: 'muted small', text: 'ほかの端末や会社のバックアップファイルを、新しい事業所として取り込みます。今の事業所を置き換えたいときは「バックアップ」の画面の復元を使います。' }),
      h('h3', { class: 'section-title', text: 'サンプルの事業所を作る' }),
      h('p', { class: 'muted small', text: '操作を試すための1年分のデータを、新しい事業所として作ります。法人は業種・規模・消費税の計算方法の違う5種類から選べます。' }),
      sampleChooser({ onPick: addSample, buttonLabel: 'このサンプルで事業所を作る' }),
      file,
    ),
    h(
      'div',
      { class: 'panel small muted' },
      h('p', { text: '事業所ごとに、事業者の設定・勘定科目・仕訳・固定資産・証憑が分かれます。個人事業と法人、複数の会社などを1台で管理できます。' }),
      h('p', { text: 'バックアップは事業所ごとに書き出し・復元します。画面ロックはすべての事業所に共通です。' }),
    ),
  );
  await paint();
}
