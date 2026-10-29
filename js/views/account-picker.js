// 勘定科目の選択シート（コード・科目名の部分一致で絞り込み、最近使った科目を先頭に）
import { h, put, trapFocus } from '../ui.js';
import { groupLabel, compareAccounts } from '../accounts.js';
import { normalize } from '../search.js';

/**
 * @param {{ accounts: Array, entityType: string, recentIds?: string[], currentId?: string, title?: string }} opts
 * @returns {Promise<string|null>} 選んだ科目の id（閉じたら null）
 */
export function pickAccount({ accounts, entityType, recentIds = [], currentId = '', title = '勘定科目を選ぶ' }) {
  return new Promise((resolve) => {
    const prevFocus = document.activeElement;
    const active = accounts.filter((a) => a.active || a.id === currentId).sort(compareAccounts);
    const byId = new Map(active.map((a) => [a.id, a]));
    const recent = recentIds.map((id) => byId.get(id)).filter(Boolean).slice(0, 8);
    const search = h('input', { type: 'search', placeholder: 'コード・科目名で検索', 'aria-label': '勘定科目を検索', enterkeyhint: 'search' });
    const list = h('div', { class: 'picker-list' });

    const item = (a) =>
      h(
        'button',
        { type: 'button', class: `picker-item ${a.id === currentId ? 'is-current' : ''}`, onclick: () => finish(a.id) },
        h('span', { class: 'picker-code', text: a.code }),
        h('span', { class: 'picker-name', text: a.name }),
        a.active ? null : h('span', { class: 'badge', text: '無効' }),
      );

    function paint() {
      const q = normalize(search.value);
      const hit = (a) => !q || normalize(a.name).includes(q) || a.code.startsWith(q);
      const parts = [];
      if (!q && recent.length) parts.push(h('h3', { class: 'picker-group', text: '最近使った科目' }), ...recent.map(item));
      let group = null;
      let count = 0;
      for (const a of active) {
        if (!hit(a)) continue;
        if (a.group !== group) {
          group = a.group;
          parts.push(h('h3', { class: 'picker-group', text: groupLabel(group, entityType) }));
        }
        parts.push(item(a));
        count++;
      }
      if (!count) parts.push(h('p', { class: 'muted center', text: '該当する科目がありません' }));
      put(list, ...parts);
    }

    const finish = (v) => {
      overlay.remove();
      document.removeEventListener('keydown', onKey);
      window.removeEventListener('hashchange', onHash);
      release();
      if (prevFocus?.focus) prevFocus.focus();
      resolve(v);
    };
    const onKey = (e) => e.key === 'Escape' && finish(null);
    const onHash = () => finish(null);
    search.addEventListener('input', paint);
    const sheet = h(
      'div',
      { class: 'sheet', role: 'dialog', 'aria-modal': 'true', 'aria-label': title },
      h('div', { class: 'sheet-head' }, h('h2', { text: title }), h('button', { type: 'button', class: 'link', text: '閉じる', onclick: () => finish(null) })),
      search,
      list,
    );
    const overlay = h('div', { class: 'overlay sheet-overlay', onclick: (e) => e.target === overlay && finish(null) }, sheet);
    paint();
    document.body.append(overlay);
    document.addEventListener('keydown', onKey);
    window.addEventListener('hashchange', onHash);
    const release = trapFocus(sheet);
    // iPhone ではキーボードが開いて一覧が隠れるため、検索欄には自動でフォーカスしない
    sheet.querySelector('.picker-item')?.focus({ preventScroll: true });
  });
}
