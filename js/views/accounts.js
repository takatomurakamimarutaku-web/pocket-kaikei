// 勘定科目の一覧
import { h, put } from '../ui.js';
import { GROUPS, groupLabel, compareAccounts, isContra } from '../accounts.js';
import { TAX_BY_CODE } from '../tax.js';

export async function render({ app, outlet }) {
  const { settings, accounts, subAccounts } = await app.load();
  let showInactive = false;
  const subCount = new Map();
  for (const s of subAccounts) subCount.set(s.accountId, (subCount.get(s.accountId) || 0) + 1);
  const list = h('div');
  const toggle = h('input', { type: 'checkbox', onchange: () => ((showInactive = toggle.checked), paint()) });

  function paint() {
    const sorted = [...accounts].sort(compareAccounts).filter((a) => showInactive || a.active);
    put(list, 
      ...GROUPS.filter((g) => sorted.some((a) => a.group === g.id)).flatMap((g) => [
        h('h2', { class: 'menu-group-title', text: groupLabel(g.id, settings.entityType) }),
        h(
          'ul',
          { class: 'menu-group' },
          sorted
            .filter((a) => a.group === g.id)
            .map((a) =>
              h(
                'li',
                {},
                h(
                  'a',
                  { class: `acc-row ${a.active ? '' : 'is-inactive'}`, href: `#/account/${encodeURIComponent(a.id)}` },
                  h('span', { class: 'acc-code', text: a.code }),
                  h(
                    'span',
                    { class: 'acc-main' },
                    h('span', { class: 'acc-title', text: a.name }),
                    h(
                      'span',
                      { class: 'acc-tags' },
                      isContra(a) ? h('span', { class: 'badge', text: '評価勘定' }) : null,
                      a.active ? null : h('span', { class: 'badge badge-warn', text: '無効' }),
                      subCount.get(a.id) ? h('span', { class: 'badge', text: `補助 ${subCount.get(a.id)}` }) : null,
                      TAX_BY_CODE[a.defaultTaxCategory]?.short ? h('span', { class: 'muted small', text: TAX_BY_CODE[a.defaultTaxCategory].label }) : null,
                    ),
                  ),
                ),
              ),
            ),
        ),
      ]),
    );
  }

  put(outlet, 
    h('div', { class: 'actions' }, h('a', { href: '#/account/new', class: 'btn btn-primary', text: '＋ 科目を追加' })),
    h('label', { class: 'check small' }, toggle, '無効にした科目も表示'),
    list,
  );
  paint();
}
