// 共通UI部品（ホップ手帖と共通の部品を流用）
import { suggest } from './search.js';
import { formatYen } from './money.js';
import { TAX_CATEGORIES, TAX_GROUPS } from './tax.js';

/** 要素を作る。attrs: class, text, html禁止, on*, dataset, その他の属性 */
export function h(tag, attrs = {}, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v === null || v === undefined || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k === 'text') el.textContent = v;
    else if (k === 'dataset') Object.assign(el.dataset, v);
    else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2), v);
    else if (k === 'value') el.value = v;
    else if (k === 'checked' || k === 'disabled' || k === 'hidden' || k === 'selected') el[k] = Boolean(v);
    else el.setAttribute(k, v === true ? '' : String(v));
  }
  appendChildren(el, children);
  return el;
}

function appendChildren(el, children) {
  for (const c of children) {
    if (c === null || c === undefined || c === false) continue;
    if (Array.isArray(c)) appendChildren(el, c);
    else el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
}

const SVG_NS = 'http://www.w3.org/2000/svg';

/** SVG 文字列からノードを作る（自作の固定SVGのみに使う） */
export function svg(markup) {
  const doc = new DOMParser().parseFromString(markup, 'image/svg+xml');
  return document.importNode(doc.documentElement, true);
}

// ---- トースト ----

let toastTimer = null;

/** 画面下部の通知。action を渡すとボタン付き（「元に戻す」など） */
export function showToast(message, { actionLabel, onAction, duration = 3000 } = {}) {
  const root = document.getElementById('toast-root');
  root.replaceChildren();
  clearTimeout(toastTimer);
  const close = () => {
    clearTimeout(toastTimer);
    root.replaceChildren();
  };
  const toast = h(
    'div',
    { class: 'toast', role: 'status' },
    h('span', { text: message }),
    actionLabel
      ? h('button', {
          class: 'toast-action',
          type: 'button',
          text: actionLabel,
          onclick: () => {
            close();
            onAction();
          },
        })
      : null,
  );
  root.append(toast);
  toastTimer = setTimeout(close, duration);
  return close;
}

// ---- フォーカスの閉じ込め（モーダル表示中に Tab で背面へ移らないようにする） ----

const FOCUSABLE = 'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

/** container 内で Tab / Shift+Tab を循環させる。戻り値で解除 */
export function trapFocus(container) {
  const onKey = (e) => {
    if (e.key !== 'Tab') return;
    const items = [...container.querySelectorAll(FOCUSABLE)].filter((el) => !el.closest('[hidden]'));
    if (!items.length) return;
    const first = items[0];
    const last = items[items.length - 1];
    if (e.shiftKey && (document.activeElement === first || !container.contains(document.activeElement))) {
      e.preventDefault();
      last.focus();
    } else if (!e.shiftKey && document.activeElement === last) {
      e.preventDefault();
      first.focus();
    }
  };
  document.addEventListener('keydown', onKey);
  return () => document.removeEventListener('keydown', onKey);
}

// ---- 確認ダイアログ ----

/**
 * @param {{title, message, buttons:[{label, value, variant}]}} opts
 * @returns {Promise<any>} 押したボタンの value（閉じた場合は null）
 */
export function confirmDialog({ title, message, buttons, body = null }) {
  return new Promise((resolve) => {
    const prevFocus = document.activeElement;
    const finish = (v) => {
      overlay.remove();
      document.removeEventListener('keydown', onKey);
      release();
      if (prevFocus && prevFocus.focus) prevFocus.focus();
      resolve(v);
    };
    const onKey = (e) => {
      if (e.key === 'Escape') finish(null);
    };
    const list = buttons || [
      { label: 'キャンセル', value: false },
      { label: 'OK', value: true, variant: 'primary' },
    ];
    const dialog = h(
      'div',
      { class: 'dialog', role: 'alertdialog', 'aria-modal': 'true', 'aria-labelledby': 'dialog-title' },
      h('h2', { id: 'dialog-title', text: title }),
      message ? h('p', { class: 'dialog-message', text: message }) : null,
      body,
      h(
        'div',
        { class: 'dialog-buttons' },
        list.map((b) =>
          h('button', { type: 'button', class: `btn ${b.variant ? 'btn-' + b.variant : ''}`, text: b.label, onclick: () => finish(b.value) }),
        ),
      ),
    );
    const overlay = h('div', { class: 'overlay', onclick: (e) => e.target === overlay && finish(null) }, dialog);
    document.body.append(overlay);
    document.addEventListener('keydown', onKey);
    const release = trapFocus(dialog);
    const primary = dialog.querySelector('.btn-primary, .btn-danger') || dialog.querySelector('button');
    primary.focus();
  });
}

// ---- 入力候補 ----

/**
 * 入力欄の下に候補を表示する（datalist は iOS での表示が不安定なため使わない）。
 * @param {HTMLInputElement} input
 * @param {{ items: () => Array<{label, sub?, key, value}>, onSelect?: (item) => void, limit?: number }} opts
 */
export function attachSuggest(input, { items, onSelect, limit = 6 }) {
  const list = h('ul', { class: 'suggest', role: 'listbox', hidden: true });
  input.setAttribute('autocomplete', 'off');
  input.after(list);

  function render() {
    const found = suggest(items(), input.value, (it) => it.key, limit).filter((it) => it.label !== input.value.trim() || it.sub);
    list.replaceChildren(
      ...found.map((it) =>
        h(
          'li',
          {
            role: 'option',
            // blur より先に処理するため pointerdown で選択する
            onpointerdown: (e) => {
              e.preventDefault();
              choose(it);
            },
          },
          h('span', { class: 'suggest-label', text: it.label }),
          it.sub ? h('span', { class: 'suggest-sub', text: it.sub }) : null,
        ),
      ),
    );
    list.hidden = found.length === 0 || document.activeElement !== input;
  }

  function choose(it) {
    list.hidden = true;
    if (onSelect) onSelect(it);
    else {
      input.value = it.value;
      input.dispatchEvent(new Event('input', { bubbles: true }));
      list.hidden = true;
    }
  }

  input.addEventListener('input', render);
  input.addEventListener('focus', render);
  input.addEventListener('blur', () => {
    list.hidden = true;
  });
  return { refresh: render, hide: () => (list.hidden = true) };
}

// ---- 選択部品 ----

/** 単一選択（ラジオ）のボタン群。allowEmpty なら選択中を再タップで解除 */
export function segmented({ name, options, value, onChange, allowEmpty = false }) {
  const wrap = h('div', { class: 'segmented', role: 'radiogroup', 'aria-label': name });
  let current = value;
  const buttons = options.map((o) =>
    h('button', {
      type: 'button',
      class: 'seg',
      role: 'radio',
      text: o.label,
      'aria-checked': String(o.value === current),
      onclick: () => {
        current = allowEmpty && current === o.value ? null : o.value;
        buttons.forEach((b, i) => b.setAttribute('aria-checked', String(options[i].value === current)));
        onChange(current);
      },
    }),
  );
  wrap.append(...buttons);
  return wrap;
}

/** 空の状態の表示 */
export function emptyState(message, action, { title } = {}) {
  return h(
    'div',
    { class: 'empty' },
    title ? h('h2', { class: 'empty-title', text: title }) : null,
    h('p', { text: message }),
    action || null,
  );
}

/** フォーム項目（ラベル＋入力＋エラー表示） */
export function field(label, control, { name, hint } = {}) {
  return h(
    'div',
    { class: 'field', dataset: name ? { field: name } : undefined },
    h('label', { class: 'field-label', text: label, for: control.id || null }),
    control,
    hint ? h('p', { class: 'field-hint', text: hint }) : null,
    h('p', { class: 'field-error', role: 'alert' }),
  );
}

/** エラー表示をまとめて更新し、最初のエラー項目へスクロールする */
export function showErrors(form, errors) {
  let first = null;
  for (const el of form.querySelectorAll('.field')) {
    const msg = errors[el.dataset.field] || '';
    el.querySelector('.field-error').textContent = msg;
    el.classList.toggle('has-error', Boolean(msg));
    if (msg && !first) first = el;
  }
  if (first) first.scrollIntoView({ behavior: 'smooth', block: 'center' });
  return !first;
}

/** エラーの一覧（仕訳の検証結果など）を表示する箱 */
export function errorBox(errors) {
  if (!errors || !errors.length) return h('div', { class: 'error-box', role: 'alert', hidden: true });
  return h('div', { class: 'error-box', role: 'alert' }, h('ul', {}, errors.map((e) => h('li', { text: e }))));
}

/** 金額のセル（右寄せ・等幅数字、マイナスは△と色） */
export function amountCell(tag, n, { blankZero = false, cls = '' } = {}) {
  const text = blankZero && !n ? '' : formatYen(n);
  return h(tag, { class: `num ${n < 0 ? 'neg' : ''} ${cls}`.trim(), text });
}

/** ファイルの保存（iPhone では共有シートを使い、使えなければダウンロード） */
export async function saveFile(blob, fileName) {
  const file = typeof File === 'function' ? new File([blob], fileName, { type: blob.type }) : null;
  if (file && navigator.canShare?.({ files: [file] })) {
    try {
      await navigator.share({ files: [file], title: fileName });
      return 'shared';
    } catch (e) {
      if (e.name === 'AbortError') return 'cancelled';
    }
  }
  const url = URL.createObjectURL(blob);
  const a = h('a', { href: url, download: fileName });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10000);
  return 'downloaded';
}

/** 要素の中身を入れ替える（null・false は無視する。replaceChildren は null を文字列にしてしまうため） */
export function put(el, ...children) {
  el.replaceChildren();
  appendChildren(el, children);
  return el;
}

/**
 * 税区分の選択（グループ見出し付き）
 * split が偽のとき、仕入の用途区分（共通対応・非課税売上対応）は今の値の区分だけを出す（設定の taxUseSplit）
 */
export function taxSelect(value, { split = false, ...attrs } = {}) {
  const groups = TAX_GROUPS.map((g) => [g, TAX_CATEGORIES.filter((c) => c.group === g.id && (split || !g.split || c.code === value))]).filter(([, cs]) => cs.length);
  return h(
    'select',
    attrs,
    groups.map(([g, cs]) => h('optgroup', { label: g.label }, cs.map((c) => h('option', { value: c.code, text: c.label, selected: c.code === value })))),
  );
}
