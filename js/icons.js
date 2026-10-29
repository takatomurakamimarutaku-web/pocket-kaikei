// メニューのアイコン（自作の線画。24×24、線の色は currentColor）と色の系統
// 色の系統（tone）：entry＝入力（緑）、report＝帳票（青）、tax＝消費税（紫）、close＝決算（橙）、setting＝設定（灰）、data＝データ（藍）
import { h, svg } from './ui.js';

const P = {
  sale: '<path d="M4 19h16"/><path d="M7 15l4-4 3 3 5-6"/><path d="M15 8h4v4"/>',
  expense: '<rect x="3" y="6" width="18" height="13" rx="2.5"/><path d="M3 10h18"/><path d="M16 14.5h2"/>',
  purchase: '<path d="M3 4h2.5l2 11h10.5l2-8H7"/><circle cx="9.5" cy="19" r="1.3"/><circle cx="16.5" cy="19" r="1.3"/>',
  receive: '<path d="M12 4v10"/><path d="M8 10l4 4 4-4"/><path d="M4 15v3a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-3"/>',
  pay: '<path d="M12 14V4"/><path d="M8 8l4-4 4 4"/><path d="M4 15v3a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-3"/>',
  transfer: '<path d="M4 8h14"/><path d="M15 5l3 3-3 3"/><path d="M20 16H6"/><path d="M9 13l-3 3 3 3"/>',
  person_out: '<circle cx="10" cy="8" r="3.5"/><path d="M3.5 20c.8-3.6 3.4-5.5 6.5-5.5 1.6 0 3 .5 4.2 1.4"/><path d="M16 18h6"/>',
  person_in: '<circle cx="10" cy="8" r="3.5"/><path d="M3.5 20c.8-3.6 3.4-5.5 6.5-5.5 1.6 0 3 .5 4.2 1.4"/><path d="M19 15v6"/><path d="M16 18h6"/>',
  cash_in: '<rect x="3" y="6" width="18" height="12" rx="2"/><circle cx="12" cy="12" r="2.5"/><path d="M6 9.5v5M18 9.5v5"/>',
  journal: '<path d="M6 3h9l4 4v14H6z"/><path d="M15 3v4h4"/><path d="M9 12h7M9 16h7"/>',
  cashbook: '<path d="M5 4h11a3 3 0 0 1 3 3v13H8a3 3 0 0 1-3-3z"/><path d="M5 17a3 3 0 0 1 3-3h11"/><path d="M9 8h6"/>',
  bank: '<path d="M3 9l9-5 9 5"/><path d="M5 10v8M9.5 10v8M14.5 10v8M19 10v8"/><path d="M3 20h18"/>',
  trial: '<rect x="3.5" y="4" width="17" height="16" rx="2"/><path d="M3.5 9h17M3.5 14h17M10 4v16"/>',
  grid: '<rect x="3.5" y="4" width="17" height="16" rx="2"/><path d="M3.5 9h17M8.5 9v11M13.5 9v11M18 9"/>',
  ledger: '<path d="M12 6.5C10.5 5 8 4.5 4 4.5v14c4 0 6.5.5 8 2 1.5-1.5 4-2 8-2v-14c-4 0-6.5.5-8 2z"/><path d="M12 6.5v14"/>',
  chart: '<path d="M4 20h16"/><rect x="5.5" y="11" width="3" height="6" rx="1"/><rect x="10.5" y="7" width="3" height="10" rx="1"/><rect x="15.5" y="13" width="3" height="4" rx="1"/>',
  pl: '<path d="M4 4v16h16"/><path d="M7.5 15l3.5-4 3 2.5 5-6"/>',
  bs: '<path d="M12 4v16"/><path d="M5 20h14"/><path d="M4 9h16"/><path d="M6.5 9l-2.5 6h5z"/><path d="M17.5 9l-2.5 6h5z"/>',
  factory: '<path d="M3 20V10l5 3V10l5 3V6h4l1 14z"/><path d="M3 20h18"/><path d="M7 17h2M12 17h2"/>',
  tax: '<circle cx="12" cy="12" r="8.5"/><path d="M9 15l6-6"/><circle cx="9.3" cy="9.3" r="1"/><circle cx="14.7" cy="14.7" r="1"/>',
  calc: '<rect x="5" y="3" width="14" height="18" rx="2.5"/><path d="M8 7h8"/><path d="M8.5 11.5h.01M12 11.5h.01M15.5 11.5h.01M8.5 15h.01M12 15h.01M15.5 15h.01M8.5 18h.01M12 18h3.5"/>',
  form: '<path d="M6 3h12v18H6z"/><path d="M9 7h6M9 11h6M9 15h3"/><path d="M14.5 17l1.5 1.5 3-3"/>',
  settings: '<circle cx="12" cy="12" r="3"/><path d="M12 3v2.5M12 18.5V21M3 12h2.5M18.5 12H21M5.6 5.6l1.8 1.8M16.6 16.6l1.8 1.8M5.6 18.4l1.8-1.8M16.6 7.4l1.8-1.8"/>',
  list: '<path d="M9 6h11M9 12h11M9 18h11"/><path d="M4.5 6h.01M4.5 12h.01M4.5 18h.01"/>',
  flag: '<path d="M5 21V4"/><path d="M5 4h11l-2 4 2 4H5"/>',
  closing: '<rect x="3.5" y="5" width="17" height="15" rx="2"/><path d="M3.5 10h17M8 3v4M16 3v4"/><path d="M9 15l2 2 4-4"/>',
  asset: '<path d="M12 3l8 4.5v9L12 21l-8-4.5v-9z"/><path d="M4 7.5l8 4.5 8-4.5M12 12v9"/>',
  calendar: '<rect x="3.5" y="5" width="17" height="15" rx="2"/><path d="M3.5 10h17M8 3v4M16 3v4"/><path d="M8 14h3M13 14h3M8 17h3"/>',
  backup: '<path d="M7 18a4.5 4.5 0 0 1-.6-9A6 6 0 0 1 18 8.5 4 4 0 0 1 17.5 18"/><path d="M12 11v8"/><path d="M9 16l3 3 3-3"/>',
  sample: '<path d="M9 3h6"/><path d="M10 3v6L4.5 18.5A1.8 1.8 0 0 0 6 21h12a1.8 1.8 0 0 0 1.5-2.5L14 9V3"/><path d="M7 15h10"/>',
  check: '<circle cx="12" cy="12" r="8.5"/><path d="M8.5 12.2l2.4 2.4 4.6-4.8"/>',
  alert: '<path d="M12 4l9 16H3z"/><path d="M12 10v4.5M12 17.5h.01"/>',
  attach: '<path d="M20 11.5l-7.8 7.8a5 5 0 0 1-7.1-7.1l8.5-8.5a3.3 3.3 0 0 1 4.7 4.7l-8.5 8.5a1.7 1.7 0 0 1-2.4-2.4l7.8-7.8"/>',
  lock: '<rect x="5" y="10.5" width="14" height="10" rx="2.5"/><path d="M8 10.5V8a4 4 0 0 1 8 0v2.5"/><path d="M12 14.5v2.5"/>',
  books: '<path d="M4 5.5h5v14H4z"/><path d="M9 5.5h5v14H9z"/><path d="M14.5 6.2l4.2-1.1 3.4 13.2-4.2 1.1z"/>',
  dept: '<rect x="9" y="3.5" width="6" height="5" rx="1"/><rect x="3" y="15.5" width="6" height="5" rx="1"/><rect x="15" y="15.5" width="6" height="5" rx="1"/><path d="M12 8.5v3.5M6 15.5V12h12v3.5"/>',
  invoice: '<path d="M6 3h12v18l-2-1.5L14 21l-2-1.5L10 21l-2-1.5L6 21z"/><path d="M9 8h6M9 12h6"/><path d="M9 16h3"/>',
  payroll: '<circle cx="9" cy="7.5" r="3.5"/><path d="M2.5 20a6.5 6.5 0 0 1 13 0"/><path d="M16.5 8.5l2.25 3 2.25-3M18.75 11.5V18M16.5 13.5h4.5M16.5 16h4.5"/>',
  history: '<path d="M4.5 12a7.5 7.5 0 1 0 2.2-5.3"/><path d="M4 4v3.5h3.5"/><path d="M12 8v4.2l2.8 1.8"/>',
};

/** アイコンの SVG ノード */
export function icon(name) {
  return svg(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${P[name] ?? P.list}</svg>`);
}

export const ICON_NAMES = Object.keys(P);

/** かんたん入力の種類ごとのアイコン */
export const QUICK_ICONS = {
  sale: 'sale',
  expense: 'expense',
  purchase: 'purchase',
  receive: 'receive',
  pay: 'pay',
  transfer: 'transfer',
  owner_out: 'person_out',
  owner_in: 'person_in',
  officer_in: 'person_in',
  cash_in: 'receive',
  cash_out: 'pay',
};

/**
 * メニューの1行（アイコン・見出し・説明・右の矢印）
 * @param {{ href: string, label: string, sub?: string, icon: string, tone?: string, badge?: string }} item
 */
export function menuRow({ href, label, sub = '', icon: name, tone = 'entry', badge = '' }) {
  return h(
    'li',
    {},
    h(
      'a',
      { class: 'menu-row', href },
      h('span', { class: `menu-icon tone-${tone}` }, icon(name)),
      h('span', { class: 'menu-text' }, h('span', { class: 'menu-label' }, label, badge ? h('span', { class: 'menu-badge', text: badge }) : null), sub ? h('span', { class: 'menu-sub', text: sub }) : null),
    ),
  );
}
