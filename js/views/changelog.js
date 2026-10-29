// 更新履歴：バージョンごとの更新内容。更新の後は、前に使っていた版から新しくなった分に印を付ける
import { h, put } from '../ui.js';
import { APP_VERSION } from '../version.js';
import { CHANGELOG, changesSince, isVersion } from '../changelog.js';

export async function render({ app, outlet, query = {} }) {
  // 印を付ける起点：更新のお知らせから開いたときは ?from=、それ以外は最後の更新の前の版
  const from = isVersion(query.from) ? query.from : await app.db.getMeta('updatedFrom').catch(() => null);
  const fresh = new Set(changesSince(CHANGELOG, from, APP_VERSION).map((e) => e.version));

  const entry = (e) =>
    h(
      'section',
      { class: `panel changelog-entry${fresh.has(e.version) ? ' is-new' : ''}` },
      h(
        'div',
        { class: 'changelog-head' },
        h('h2', { class: 'changelog-version', text: `バージョン ${e.version}` }),
        e.version === APP_VERSION ? h('span', { class: 'badge badge-ok', text: '使用中' }) : null,
        fresh.has(e.version) ? h('span', { class: 'badge badge-new', text: '新しく入った内容' }) : null,
        h('span', { class: 'muted small changelog-date', text: e.date.replaceAll('-', '/') }),
      ),
      h('p', { class: 'changelog-title', text: e.title }),
      h('ul', { class: 'changelog-items' }, e.items.map((t) => h('li', { text: t }))),
    );

  put(
    outlet,
    h(
      'p',
      { class: 'muted small changelog-lead' },
      fresh.size
        ? `バージョン ${from} から ${APP_VERSION} に更新しました。新しく入った内容に印を付けています。`
        : `いま使っているのはバージョン ${APP_VERSION} です。新しい順に並べています。`,
    ),
    ...CHANGELOG.map(entry),
  );
}
