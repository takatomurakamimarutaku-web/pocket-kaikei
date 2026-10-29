// 給与の入力部品：金額の欄と、支給・控除の明細（名前と金額の行）の入力欄。従業員の登録と給与の入力で使う
import { h, put } from '../ui.js';
import { parseYen } from '../money.js';
import { MAX_ITEMS, MAX_ITEM_NAME } from '../payroll.js';

/** 金額の欄（空欄は0として読む） */
export function amountInput(id, value, attrs = {}) {
  return h('input', { id, type: 'text', inputmode: 'numeric', autocomplete: 'off', value: value ? String(value) : '', placeholder: '0', class: 'num', ...attrs });
}

/** 金額の欄を読む。空欄は0。読めなければ errors にメッセージを足して0 */
export function readAmount(input, label, errors, { allowNegative = false } = {}) {
  const v = String(input.value).trim();
  if (!v) return 0;
  const r = parseYen(v, { allowNegative, allowZero: true });
  if (!r.ok) {
    errors.push(`${label}：${r.error}`);
    return 0;
  }
  return r.value;
}

/** 人数の欄を読む（全角も可。空欄は0。整数でなければ NaN にして検証で弾く） */
export function toCount(value) {
  const s = String(value ?? '').normalize('NFKC').trim();
  return s === '' ? 0 : /^\d+$/.test(s) ? Number(s) : NaN;
}

/**
 * 名前と金額の行の入力欄
 * @param {{ label: string, items: Array<{name, amount}>, allowNegative?: boolean, onChange?: () => void }} o
 * @returns {{ el: HTMLElement, read: (errors: string[]) => Array<{name, amount}> }}
 */
export function itemsEditor({ label, items, allowNegative = false, onChange = () => {} }) {
  const rows = items.map((x) => ({ name: x.name, amount: x.amount ? String(x.amount) : '' }));
  const list = h('div', { class: 'pay-items' });
  const addBtn = h('button', {
    type: 'button',
    class: 'btn btn-small',
    text: `＋ ${label}の行を足す`,
    onclick: () => {
      rows.push({ name: '', amount: '' });
      paint();
      list.querySelector('.pay-item:last-child input')?.focus();
      onChange();
    },
  });
  function paint() {
    put(
      list,
      ...rows.map((r, i) =>
        h(
          'div',
          { class: 'pay-item' },
          h('input', { type: 'text', value: r.name, maxlength: MAX_ITEM_NAME, 'aria-label': `${label}${i + 1}の名前`, placeholder: '名前', oninput: (e) => ((r.name = e.target.value), onChange()) }),
          h('input', { type: 'text', inputmode: 'numeric', class: 'num', value: r.amount, 'aria-label': `${label}${i + 1}の金額`, placeholder: '0', oninput: (e) => ((r.amount = e.target.value), onChange()) }),
          h('button', { type: 'button', class: 'btn btn-small btn-danger-text', 'aria-label': `${label}${i + 1}を削除`, text: '×', onclick: () => (rows.splice(i, 1), paint(), onChange()) }),
        ),
      ),
    );
    addBtn.disabled = rows.length >= MAX_ITEMS;
  }
  paint();
  return {
    el: h('div', { class: 'pay-items-wrap' }, list, addBtn),
    read(errors) {
      const out = [];
      rows.forEach((r, i) => {
        const name = r.name.trim();
        const v = String(r.amount).trim();
        if (!name && !v) return;
        let amount = 0;
        if (v) {
          const p = parseYen(v, { allowNegative, allowZero: true });
          if (p.ok) amount = p.value;
          else errors.push(`${label}${i + 1}行目：${p.error}`);
        }
        out.push({ name, amount });
      });
      return out;
    },
  };
}
