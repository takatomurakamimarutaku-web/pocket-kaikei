// 帳簿の切替：個人と法人、家族の帳簿などを、帳簿ごとにデータベースを分けて持つ
import { h, put, showToast, confirmDialog } from '../ui.js';
import { ValidationError } from '../db.js';
import { errorText } from '../errors.js';

export async function render({ app, outlet }) {
  const device = app.device;
  const listEl = h('div');
  const name = (b) => b.label || '（初期設定がまだの帳簿）';

  async function remove(book) {
    const ok = await confirmDialog({
      title: `「${name(book)}」を削除しますか？`,
      message: 'この帳簿の仕訳・科目・設定・証憑をすべて消します。元に戻せません。必要なら、先にこの帳簿に切り替えてバックアップしてください。',
      buttons: [
        { label: 'キャンセル', value: false },
        { label: '削除する', value: true, variant: 'danger' },
      ],
    });
    if (ok !== true) return;
    try {
      await device.deleteBook(book.id);
      showToast('帳簿を削除しました');
      await paint();
    } catch (e) {
      showToast(e instanceof ValidationError ? e.errors.join(' ') : errorText(e, '削除'));
    }
  }

  async function add() {
    const ok = await confirmDialog({
      title: '帳簿を追加しますか？',
      message: '新しい帳簿に切り替えて、初期設定（事業者名・個人/法人・会計期間）から始めます。今の帳簿のデータはそのまま残り、この画面からいつでも戻れます。',
      buttons: [
        { label: 'キャンセル', value: false },
        { label: '追加する', value: true, variant: 'primary' },
      ],
    });
    if (ok !== true) return;
    const book = await device.addBook();
    await app.switchBook(book.id, '#/setup');
  }

  async function paint() {
    const books = await device.listBooks();
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
            current
              ? h('p', { class: 'muted small', text: '今開いている帳簿です。' })
              : h(
                  'div',
                  { class: 'book-actions' },
                  h('button', { type: 'button', class: 'btn btn-small btn-primary', text: 'この帳簿に切り替える', onclick: () => app.switchBook(b.id) }),
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
    h('button', { type: 'button', class: 'btn btn-block', text: '帳簿を追加する', onclick: add }),
    h(
      'div',
      { class: 'panel small muted' },
      h('p', { text: '帳簿ごとに、事業者の設定・勘定科目・仕訳・固定資産・証憑が分かれます。個人事業と法人、家族の事業などを1台で管理できます。' }),
      h('p', { text: 'バックアップは帳簿ごとに書き出し・復元します。画面ロックはすべての帳簿に共通です。' }),
    ),
  );
  await paint();
}
