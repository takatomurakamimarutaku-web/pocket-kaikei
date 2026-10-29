// 部門の設定：店舗・事業・商品などの部門の追加・名前の変更・並び替え・使わない設定・削除
import { h, put, showToast, confirmDialog } from '../ui.js';
import { createDepartment } from '../models.js';
import { MAX_DEPARTMENT_NAME } from '../departments.js';
import { ValidationError } from '../db.js';
import { errorText } from '../errors.js';

export async function render({ app, outlet }) {
  let departments = await app.db.listDepartments();
  let used = await app.db.departmentUsage();
  const listEl = h('div');

  const message = (e, what) => (e instanceof ValidationError ? e.message : errorText(e, what));
  async function reload() {
    [departments, used] = await Promise.all([app.db.listDepartments(), app.db.departmentUsage()]);
    paint();
  }
  async function save(dep, done) {
    try {
      await app.db.saveDepartment(dep);
      if (done) showToast(done);
      await reload();
      return true;
    } catch (e) {
      showToast(message(e, '保存'));
      return false;
    }
  }
  async function rename(d) {
    const input = h('input', { type: 'text', maxlength: MAX_DEPARTMENT_NAME, value: d.name, 'aria-label': '部門名' });
    const ok = await confirmDialog({ title: '部門名の変更', body: input, buttons: [{ label: 'キャンセル', value: false }, { label: '変更する', value: true, variant: 'primary' }] });
    if (ok) await save({ ...d, name: input.value }, '部門名を変更しました');
  }
  async function move(i, delta) {
    const ids = departments.map((d) => d.id);
    const j = i + delta;
    if (j < 0 || j >= ids.length) return;
    [ids[i], ids[j]] = [ids[j], ids[i]];
    await app.db.reorderDepartments(ids);
    await reload();
  }
  async function remove(d) {
    const ok = await confirmDialog({
      title: `「${d.name}」を削除しますか？`,
      message: 'どの仕訳にも付いていない部門なので、削除しても帳簿の数字は変わりません。',
      buttons: [
        { label: 'キャンセル', value: false },
        { label: '削除する', value: true, variant: 'danger' },
      ],
    });
    if (ok !== true) return;
    try {
      await app.db.deleteDepartment(d.id);
      showToast('部門を削除しました');
      await reload();
    } catch (e) {
      showToast(message(e, '削除'));
    }
  }

  function paint() {
    const input = h('input', { id: 'dep-new', type: 'text', maxlength: MAX_DEPARTMENT_NAME, placeholder: '例：本店、ネット販売、飲食部門', 'aria-label': '新しい部門名' });
    put(
      listEl,
      h(
        'ul',
        { class: 'menu-group dep-list' },
        departments.length
          ? departments.map((d, i) =>
              h(
                'li',
                { class: `sub-row dep-row ${d.active ? '' : 'is-inactive'}` },
                h('div', { class: 'dep-head' }, h('span', { class: 'sub-name', text: d.name }), d.active ? null : h('span', { class: 'badge badge-warn', text: '使わない' })),
                h('button', { type: 'button', class: 'link small', text: '↑', 'aria-label': `「${d.name}」を上へ`, disabled: i === 0, onclick: () => move(i, -1) }),
                h('button', { type: 'button', class: 'link small', text: '↓', 'aria-label': `「${d.name}」を下へ`, disabled: i === departments.length - 1, onclick: () => move(i, 1) }),
                h('button', { type: 'button', class: 'link small', text: '名前', onclick: () => rename(d) }),
                h('button', { type: 'button', class: 'link small', text: d.active ? '使わない' : '使う', onclick: () => save({ ...d, active: !d.active }, d.active ? '入力の選択肢から外しました' : '入力の選択肢に戻しました') }),
                used.has(d.id) ? null : h('button', { type: 'button', class: 'link danger small', text: '削除', onclick: () => remove(d) }),
              ),
            )
          : h('li', { class: 'sub-row muted small', text: '部門はまだありません' }),
      ),
      h(
        'form',
        {
          class: 'row sub-add',
          onsubmit: async (e) => {
            e.preventDefault();
            if (!input.value.trim()) return;
            if (await save(createDepartment({ name: input.value, sortOrder: departments.length }), '部門を追加しました')) document.getElementById('dep-new')?.focus();
          },
        },
        input,
        h('button', { type: 'submit', class: 'btn btn-small', text: '追加' }),
      ),
    );
  }

  put(
    outlet,
    h(
      'div',
      { class: 'panel small' },
      h('p', { text: '店舗・事業・商品などの部門を登録すると、仕訳の売上・経費の行に部門を付けられます。付けた部門ごとに売上と利益を見られます（帳票 → 部門別損益）。' }),
      h('p', { class: 'muted', text: '部門を付けなかった行は「共通」として集計し、部門別損益の画面で売上高の割合などで各部門に配ることもできます。決算書・申告書の数字は部門に関係なく同じです。' }),
    ),
    listEl,
    h('div', { class: 'actions' }, h('a', { href: '#/reports/departments', class: 'btn', text: '部門別損益を見る' })),
  );
  paint();
}
