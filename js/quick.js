// かんたん取引入力のテンプレートと仕訳への変換（純粋関数）
// 科目は名前ではなく role（役割）・hint（目印）・group（区分）で選ぶ
import { parseYen } from './money.js';
import { compareAccounts } from './accounts.js';

const CASH = [{ role: 'cash' }, { role: 'deposit' }];
const INVENTORY_ROLES = ['opening_inventory', 'closing_inventory'];
// 製造原価の棚卸高の科目（決算整理でだけ使う）
const INVENTORY_HINTS = ['opening_finished', 'closing_finished', 'opening_materials', 'closing_materials', 'opening_wip', 'closing_wip'];

/**
 * 取引の種類。slot.pick：候補の条件（上から順に並べる）
 *   { role } / { hint } / { groups, excludeRoles?, excludeHints? } / { any: true }（すべての科目） / { fixed: true }（出納帳の口座）
 * slot.defaultHint：初期値にする目印。taxSide：税区分を選ばせる側
 * menu：入力メニューに出すか（false は出納帳から開く）
 */
export const QUICK_TEMPLATES = [
  {
    id: 'sale',
    label: '売上',
    desc: '商品・サービスの代金を受け取った・請求した',
    entity: 'both',
    menu: true,
    debit: { label: '受け取り方', pick: [...CASH, { hint: 'receivable' }] },
    credit: { label: '売上の科目', pick: [{ groups: ['sales', 'non_operating_income'] }], defaultHint: 'sales' },
    taxSide: 'credit',
    memoPlaceholder: '例：〇〇様 デザイン料',
  },
  {
    id: 'expense',
    label: '経費の支払',
    desc: '交通費・通信費・消耗品などを払った',
    entity: 'both',
    menu: true,
    debit: { label: '経費の科目', pick: [{ groups: ['sga', 'non_operating_expenses', 'mfg_labor', 'mfg_overhead'] }] },
    credit: { label: '支払い方', pick: [...CASH, { hint: 'accrued' }, { role: 'owner_borrowings' }, { hint: 'officer_loan' }] },
    taxSide: 'debit',
    memoPlaceholder: '例：電車代 打合せ',
  },
  {
    id: 'purchase',
    label: '仕入',
    desc: '販売用の商品・材料を買った',
    entity: 'both',
    menu: true,
    debit: { label: '仕入の科目', pick: [{ groups: ['cost_of_sales', 'mfg_materials'], excludeRoles: INVENTORY_ROLES, excludeHints: INVENTORY_HINTS }], defaultHint: 'purchases' },
    credit: { label: '支払い方', pick: [...CASH, { hint: 'payable' }] },
    taxSide: 'debit',
    memoPlaceholder: '例：〇〇商事 4月分',
  },
  {
    id: 'receive',
    label: '売掛金の入金',
    desc: '請求していた代金が入金された',
    entity: 'both',
    menu: true,
    debit: { label: '入金先', pick: CASH },
    credit: { label: '回収した科目', pick: [{ hint: 'receivable' }] },
    taxSide: null,
    memoPlaceholder: '例：〇〇様 3月請求分',
  },
  {
    id: 'pay',
    label: '買掛金・未払金の支払',
    desc: '後払いにしていた代金を払った',
    entity: 'both',
    menu: true,
    debit: { label: '支払った科目', pick: [{ hint: 'payable' }, { hint: 'accrued' }] },
    credit: { label: '支払い方', pick: CASH },
    taxSide: null,
    memoPlaceholder: '例：〇〇商事 3月分',
  },
  {
    id: 'transfer',
    label: '預金の預け入れ・引き出し',
    desc: '現金と口座、口座どうしでお金を移した',
    entity: 'both',
    menu: true,
    debit: { label: '入れた先', pick: CASH },
    credit: { label: '出した元', pick: CASH },
    taxSide: null,
    memoPlaceholder: '例：ATM 引き出し',
  },
  {
    id: 'owner_out',
    label: '生活費などの支払',
    desc: '事業のお金を私用に使った（事業主貸）',
    entity: 'individual',
    menu: true,
    debit: { label: '科目', pick: [{ role: 'owner_drawings' }] },
    credit: { label: '支払い方', pick: CASH },
    taxSide: null,
    memoPlaceholder: '例：生活費',
  },
  {
    id: 'owner_in',
    label: '自己資金の入金',
    desc: '私的なお金を事業に入れた（事業主借）',
    entity: 'individual',
    menu: true,
    debit: { label: '入金先', pick: CASH },
    credit: { label: '科目', pick: [{ role: 'owner_borrowings' }] },
    taxSide: null,
    memoPlaceholder: '例：個人口座から資金移動',
  },
  {
    id: 'officer_in',
    label: '役員からの借入',
    desc: '代表者などから会社にお金を入れた',
    entity: 'corporation',
    menu: true,
    debit: { label: '入金先', pick: CASH },
    credit: { label: '科目', pick: [{ hint: 'officer_loan' }] },
    taxSide: null,
    memoPlaceholder: '例：代表者より借入',
  },
  {
    id: 'cash_in',
    label: '入金',
    desc: '口座にお金が入った',
    entity: 'both',
    menu: false,
    debit: { label: '入金先', pick: [{ fixed: true }] },
    credit: { label: '相手の科目', pick: [{ any: true }] },
    taxSide: 'credit',
    memoPlaceholder: '摘要',
  },
  {
    id: 'cash_out',
    label: '出金',
    desc: '口座からお金が出た',
    entity: 'both',
    menu: false,
    debit: { label: '相手の科目', pick: [{ any: true }] },
    credit: { label: '出金元', pick: [{ fixed: true }] },
    taxSide: 'debit',
    memoPlaceholder: '摘要',
  },
];

export const QUICK_BY_ID = Object.fromEntries(QUICK_TEMPLATES.map((t) => [t.id, t]));

/** 事業者の種類で使える取引の種類（menu：入力メニューに出すものだけ） */
export function quickTemplatesFor(entityType, { menu = true } = {}) {
  return QUICK_TEMPLATES.filter((t) => (t.entity === 'both' || t.entity === entityType) && (!menu || t.menu));
}

/** 出納帳の対象（役割が現金・預金）の科目か */
export function isCashAccount(account) {
  return account?.role === 'cash' || account?.role === 'deposit';
}

function matches(sel, a, fixedId) {
  if (sel.fixed) return a.id === fixedId;
  if (sel.any) return true;
  if (sel.role) return a.role === sel.role;
  if (sel.hint) return a.hint === sel.hint;
  if (sel.groups) return sel.groups.includes(a.group) && !(sel.excludeRoles || []).includes(a.role) && !(sel.excludeHints || []).includes(a.hint);
  return false;
}

/**
 * 枠の候補の科目（有効なものだけ。条件の順 → 科目の並び）
 * @param {string} [fixedId] 出納帳の口座
 */
export function slotCandidates(slot, accounts, fixedId = '') {
  const out = [];
  const seen = new Set();
  for (const sel of slot.pick) {
    for (const a of accounts.filter((x) => x.active && matches(sel, x, fixedId)).sort(compareAccounts)) {
      if (seen.has(a.id)) continue;
      seen.add(a.id);
      out.push(a);
    }
  }
  return out;
}

/** 口座を固定する枠か */
export function isFixedSlot(slot) {
  return slot.pick.some((s) => s.fixed);
}

/**
 * 科目の初期値。前回選んだ科目 → 目印の科目 → 候補が少ない枠なら先頭
 * 借方と貸方が同じになるときは、貸方を次の候補にする
 * @param {{ debit?: string, credit?: string }} last 前回その種類で選んだ科目
 * @returns {{ debit: string, credit: string }} 科目 id（決まらなければ空）
 */
export function quickDefaults(template, accounts, { last = {}, fixedId = '' } = {}) {
  const pickFor = (side) => {
    const slot = template[side];
    const cands = slotCandidates(slot, accounts, fixedId);
    if (isFixedSlot(slot)) return { id: cands[0]?.id || '', cands };
    if (last[side] && cands.some((a) => a.id === last[side])) return { id: last[side], cands };
    if (slot.defaultHint) {
      const a = cands.find((x) => x.hint === slot.defaultHint);
      if (a) return { id: a.id, cands };
    }
    const short = slot.pick.every((s) => s.role || s.hint);
    return { id: short ? cands[0]?.id || '' : '', cands };
  };
  const d = pickFor('debit');
  const c = pickFor('credit');
  let credit = c.id;
  if (credit && credit === d.id) credit = c.cands.find((a) => a.id !== d.id)?.id || '';
  return { debit: d.id, credit };
}

/**
 * 入力内容を仕訳の明細にする
 * @param {{ amount: string|number, memo?: string,
 *   debit: { accountId, subAccountId?, taxCategory? }, credit: { accountId, subAccountId?, taxCategory? } }} input
 * @returns {{ lines: Array, errors: string[] }}
 */
export function buildQuickLines(input) {
  const errors = [];
  const parsed = parseYen(input.amount);
  if (!parsed.ok) errors.push(`金額：${parsed.error}`);
  const memo = String(input.memo ?? '').trim();
  const side = (name) => {
    const s = input[name] || {};
    if (!s.accountId) errors.push(`${name === 'debit' ? '借方' : '貸方'}の科目を選んでください`);
    return {
      side: name,
      accountId: s.accountId || '',
      subAccountId: s.subAccountId || null,
      amount: parsed.ok ? parsed.value : NaN,
      taxCategory: s.taxCategory || 'none',
      memo,
    };
  };
  const lines = [side('debit'), side('credit')];
  if (lines[0].accountId && lines[0].accountId === lines[1].accountId && (lines[0].subAccountId || '') === (lines[1].subAccountId || '')) {
    errors.push('借方と貸方に同じ科目は使えません');
  }
  return { lines, errors };
}

/** 借方1行・貸方1行の仕訳なら、その2行（摘要候補から科目を補うときに使う） */
export function simplePair(lines) {
  const d = lines.filter((l) => l.side === 'debit');
  const c = lines.filter((l) => l.side === 'credit');
  return d.length === 1 && c.length === 1 ? { debit: d[0], credit: c[0] } : null;
}
