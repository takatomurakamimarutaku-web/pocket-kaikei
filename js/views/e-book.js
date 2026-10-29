// 電子帳簿保存：優良な電子帳簿の要件とこのアプリの対応、事務手続の書類のひな形、令和9年分以後の青色申告特別控除75万円
import { h, put, saveFile, showToast } from '../ui.js';
import { EBOOK_REQUIREMENTS, ebookProcedureText } from '../e-book.js';
import { APP_VERSION } from '../version.js';
import { todayString } from '../period.js';

export async function render({ app, outlet }) {
  const { settings } = await app.load();
  const text = ebookProcedureText({ businessName: settings.businessName, entityType: settings.entityType, version: APP_VERSION, today: todayString() });

  async function download() {
    const result = await saveFile(new Blob([text], { type: 'text/plain' }), 'pocket-kaikei-jimu-tetsuzuki.txt');
    if (result !== 'cancelled') showToast('ひな形を書き出しました');
  }

  async function copy() {
    try {
      await navigator.clipboard.writeText(text);
      showToast('ひな形をコピーしました');
    } catch {
      showToast('コピーできませんでした。テキストで書き出してください');
    }
  }

  put(
    outlet,
    h(
      'section',
      { class: 'panel' },
      h('h2', { class: 'section-title', text: '優良な電子帳簿とは' }),
      h('p', { text: '仕訳帳・総勘定元帳などをパソコンやスマホで作って電子のまま保存するとき、訂正・削除の履歴や検索などの要件を満たすものを「優良な電子帳簿」といいます。' }),
      h(
        'ul',
        { class: 'ebook-merit' },
        h('li', { text: '個人の青色申告：令和9年分以後、e-Tax で申告し、仕訳帳・総勘定元帳を優良な電子帳簿で保存すると、青色申告特別控除が75万円になります（e-Tax だけなら65万円、書面で提出すると10万円）。' }),
        h('li', { text: '令和8年分までは、e-Tax で申告するか優良な電子帳簿で保存すれば65万円です（書面で提出すると55万円）。' }),
        h('li', { text: 'あらかじめ届出書を出しておくと、後で申告漏れが見つかったときの過少申告加算税が5%軽くなります。' }),
      ),
      h('p', { class: 'muted small', text: '出典：国税庁「優良な電子帳簿の要件」、国税庁「令和9年分から青色申告特別控除はどう変わる？」（令和8年4月）。75万円の届出の要否や、年の途中から始める場合の扱いは、国税庁の案内で確かめてください。' }),
    ),
    h(
      'section',
      { class: 'panel' },
      h('h2', { class: 'section-title', text: '要件とPocket会計の対応' }),
      h(
        'ol',
        { class: 'ebook-reqs' },
        EBOOK_REQUIREMENTS.map((r) =>
          h(
            'li',
            {},
            h('div', { class: 'ebook-req-head' }, h('strong', { text: r.title }), h('span', { class: 'muted small', text: r.basis })),
            h('p', { text: r.app }),
            r.user ? h('p', { class: 'ebook-user' }, h('span', { class: 'ebook-tag', text: 'あなたがすること' }), r.user) : null,
          ),
        ),
      ),
      h(
        'div',
        { class: 'actions no-print' },
        h('a', { href: '#/journals/history', class: 'btn', text: '訂正・削除の履歴を見る' }),
        h('a', { href: '#/journals', class: 'btn', text: '仕訳帳で検索する' }),
      ),
      h('p', { class: 'notice', text: 'Pocket会計は第三者機関（JIIMA）の認証を受けていません。要件を満たしているかは、この説明と実際の画面で確かめてください。データはこの端末の中だけにあるため、端末の故障や紛失に備えて、バックアップを定期的に書き出してください。' }),
    ),
    h(
      'section',
      { class: 'panel' },
      h('h2', { class: 'section-title', text: '事務手続の書類（ひな形）' }),
      h('p', { class: 'muted small', text: '優良な電子帳簿では、入力・確認・訂正・保存の手続を書いた書類を備え付けます（一問一答 問9）。国税庁のサンプルを参考に作ったひな形です。担当者や期限を実態に合わせて直して保存してください。' }),
      h('pre', { class: 'ebook-template', text }),
      h(
        'div',
        { class: 'actions no-print' },
        h('button', { type: 'button', class: 'btn', text: 'テキストで書き出す', onclick: download }),
        h('button', { type: 'button', class: 'btn', text: 'コピー', onclick: copy }),
      ),
    ),
  );
}
