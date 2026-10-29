// 勘定科目の追加・編集と補助科目の管理
import { h, put, field, segmented, showErrors, showToast, confirmDialog, taxSelect } from '../ui.js';
import { groupsFor, groupLabel, normalSideFor, ROLES, GROUP_BY_ID } from '../accounts.js';
import { createAccount, createSubAccount } from '../models.js';
import { ValidationError } from '../db.js';
import { errorText } from '../errors.js';

export async function render({ app, outlet, params }) {
  const { settings, accounts, subAccounts } = await app.load();
  const original = params.id ? accounts.find((a) => a.id === params.id) : null;
  if (params.id && !original) {
    put(outlet, h('p', { class: 'empty', text: '科目が見つかりません' }));
    return;
  }
  const usage = await app.db.usage();
  const used = original ? usage.accounts.has(original.id) : false;
  const nextCode = String(Math.max(0, ...accounts.map((a) => Number(a.code) || 0)) + 1);
  const acc = original ? { ...original } : createAccount({ code: nextCode, group: 'sga', normalSide: 'debit', defaultTaxCategory: 'purchase_10', sortOrder: Number(nextCode) });
  const locked = Boolean(acc.role) || used;

  const code = h('input', { id: 'a-code', type: 'text', inputmode: 'numeric', maxlength: 6, value: acc.code });
  const name = h('input', { id: 'a-name', type: 'text', maxlength: 30, value: acc.name });
  const sideWrap = h('div');
  const paintSide = () =>
    put(sideWrap, 
      segmented({
        name: '残高の側',
        options: [
          { value: 'debit', label: '借方' },
          { value: 'credit', label: '貸方' },
        ],
        value: acc.normalSide,
        onChange: (v) => (acc.normalSide = v),
      }),
    );
  const group = h(
    'select',
    {
      id: 'a-group',
      disabled: locked,
      onchange: (e) => {
        acc.group = e.target.value;
        acc.normalSide = normalSideFor(acc.group);
        paintSide();
      },
    },
    groupsFor(settings.entityType).map((g) => h('option', { value: g.id, text: groupLabel(g.id, settings.entityType), selected: g.id === acc.group })),
  );
  const tax = taxSelect(acc.defaultTaxCategory, { split: Boolean(settings.taxUseSplit), id: 'a-tax', onchange: (e) => (acc.defaultTaxCategory = e.target.value) });
  const active = h('input', { type: 'checkbox', checked: acc.active, disabled: Boolean(acc.role) });
  paintSide();

  const form = h(
    'form',
    { novalidate: true, onsubmit: (e) => (e.preventDefault(), save()) },
    acc.role ? h('p', { class: 'notice', text: `「${ROLES[acc.role]}」の役割を持つ科目です。名前は変えられますが、区分の変更・無効化・削除はできません。` }) : null,
    used && !acc.role ? h('p', { class: 'muted small', text: '仕訳か期首残高で使われているため、区分と残高の側は変更できません。' }) : null,
    h('div', { class: 'field-row' }, field('コード', code, { name: 'code' }), field('科目名', name, { name: 'name' })),
    field('区分', group, { name: 'group' }),
    h('div', { hidden: locked }, field('残高の側', sideWrap, { name: 'normalSide', hint: '減価償却累計額のような評価勘定は、区分と逆の側を選びます' })),
    field('税区分の初期値', tax, { name: 'defaultTaxCategory', hint: '仕訳で科目を選んだときに入る税区分です' }),
    h('label', { class: 'check' }, active, '入力時の選択肢に表示する（オフで無効）'),
    h('p', { class: 'field-error', 'data-field': 'active' }),
    h('button', { type: 'submit', class: 'btn btn-primary btn-block', text: original ? '保存する' : '追加する' }),
  );

  const subsEl = h('div');
  function paintSubs() {
    const subs = subAccounts.filter((s) => s.accountId === acc.id).sort((a, b) => (a.sortOrder ?? 0) - (b.sortOrder ?? 0));
    const input = h('input', { type: 'text', maxlength: 30, placeholder: '例：みずほ銀行、A社', 'aria-label': '新しい補助科目名' });
    put(subsEl, 
      h('h2', { class: 'section-title', text: '補助科目' }),
      h('p', { class: 'muted small', text: '銀行口座や取引先ごとに残高を分けて管理できます。' }),
      h(
        'ul',
        { class: 'menu-group' },
        subs.length
          ? subs.map((s) =>
              h(
                'li',
                { class: `sub-row ${s.active ? '' : 'is-inactive'}` },
                h('span', { class: 'sub-name', text: s.name }),
                s.active ? null : h('span', { class: 'badge badge-warn', text: '無効' }),
                h('button', { type: 'button', class: 'link small', text: '名前', onclick: () => renameSub(s) }),
                h('button', { type: 'button', class: 'link small', text: s.active ? '無効に' : '有効に', onclick: () => saveSub({ ...s, active: !s.active }) }),
                usage.subs.has(s.id) ? null : h('button', { type: 'button', class: 'link danger small', text: '削除', onclick: () => deleteSub(s) }),
              ),
            )
          : h('li', { class: 'sub-row muted small', text: '補助科目はありません' }),
      ),
      h(
        'form',
        { class: 'row sub-add', onsubmit: (e) => (e.preventDefault(), input.value.trim() && saveSub(createSubAccount({ accountId: acc.id, name: input.value, sortOrder: subs.length }))) },
        input,
        h('button', { type: 'submit', class: 'btn btn-small', text: '追加' }),
      ),
    );
  }

  async function saveSub(sub) {
    try {
      const saved = await app.db.saveSubAccount(sub);
      const i = subAccounts.findIndex((s) => s.id === saved.id);
      if (i >= 0) subAccounts[i] = saved;
      else subAccounts.push(saved);
      paintSubs();
    } catch (e) {
      showToast(e instanceof ValidationError ? Object.values(e.errors).join(' ') : errorText(e, '保存'));
    }
  }
  async function renameSub(s) {
    const input = h('input', { type: 'text', maxlength: 30, value: s.name, 'aria-label': '補助科目名' });
    const ok = await confirmDialog({ title: '補助科目名の変更', body: input, buttons: [{ label: 'キャンセル', value: false }, { label: '変更する', value: true, variant: 'primary' }] });
    if (ok) saveSub({ ...s, name: input.value });
  }
  async function deleteSub(s) {
    try {
      await app.db.deleteSubAccount(s.id);
      subAccounts.splice(subAccounts.indexOf(s), 1);
      paintSubs();
    } catch (e) {
      showToast(e instanceof ValidationError ? e.message : errorText(e, '削除'));
    }
  }

  put(outlet, 
    form,
    original ? subsEl : h('p', { class: 'muted small', text: '補助科目は、科目を追加した後に登録できます。' }),
    original && !original.template && !used ? h('div', { class: 'actions' }, h('button', { type: 'button', class: 'btn btn-danger-text', text: 'この科目を削除', onclick: remove })) : null,
  );
  if (original) paintSubs();

  async function save() {
    const record = { ...acc, code: code.value.trim(), name: name.value.trim(), active: active.checked, sortOrder: Number(code.value) || acc.sortOrder };
    if (!GROUP_BY_ID[record.group]) return;
    try {
      await app.db.saveAccount(record);
      showToast(original ? '保存しました' : `「${record.name}」を追加しました`);
      app.goBack('#/accounts');
    } catch (e) {
      if (e instanceof ValidationError && !Array.isArray(e.errors)) {
        showErrors(form, e.errors);
        const err = form.querySelector('[data-field="active"]');
        err.textContent = e.errors.active || '';
      } else showToast(errorText(e, '保存'));
    }
  }
  async function remove() {
    const ok = await confirmDialog({ title: `「${original.name}」を削除しますか？`, buttons: [{ label: 'キャンセル', value: false }, { label: '削除する', value: true, variant: 'danger' }] });
    if (!ok) return;
    try {
      await app.db.deleteAccount(original.id);
      showToast('削除しました');
      app.goBack('#/accounts');
    } catch (e) {
      showToast(e instanceof ValidationError ? e.message : errorText(e, '削除'));
    }
  }
}
