// 期首残高の入力（個人は元入金を自動計算）
import { h, put, showToast, errorBox, confirmDialog } from '../ui.js';
import { GROUPS, groupLabel, compareAccounts, isBsGroup, findByRole } from '../accounts.js';
import { parseYen, formatYen } from '../money.js';
import { fromNormal, computeOwnerCapital } from '../ledger.js';
import { ValidationError } from '../db.js';
import { errorText } from '../errors.js';
import { closedNotice } from './period-common.js';

export async function render({ app, outlet }) {
  const { settings, period, accounts, subAccounts } = await app.load();
  const individual = settings.entityType === 'individual';
  const capital = individual ? findByRole(accounts, 'owner_capital') : null;
  // 個人の事業主貸・事業主借は期首は0（前年末に元入金へ振り替える）ので入力欄を出さない
  const ownerRoles = individual ? ['owner_drawings', 'owner_borrowings'] : [];
  const bsAccounts = accounts
    .filter((a) => isBsGroup(a.group) && !ownerRoles.includes(a.role) && (a.active || period.openingBalances.some((b) => b.accountId === a.id)))
    .sort(compareAccounts);
  const key = (accountId, subId) => `${accountId}|${subId || ''}`;
  const values = new Map(period.openingBalances.map((b) => [key(b.accountId, b.subAccountId), String(b.amount)]));
  let dirty = false;
  const summary = h('div', { class: 'jtotals' });
  const capitalCell = h('span', { class: 'num' });
  const errorsEl = h('div');
  const saveBtn = h('button', { type: 'button', class: 'btn btn-primary btn-block', text: '保存する', onclick: () => save() });

  function collect() {
    const list = [];
    const errors = [];
    for (const [k, v] of values) {
      if (!String(v).trim()) continue;
      const [accountId, subId] = k.split('|');
      if (capital && accountId === capital.id) continue;
      const p = parseYen(v, { allowNegative: true, allowZero: true });
      const acc = accounts.find((a) => a.id === accountId);
      if (!p.ok) errors.push(`${acc?.name}：${p.error}`);
      else if (p.value) list.push({ accountId, subAccountId: subId || null, amount: p.value });
    }
    return { list, errors };
  }

  function paintSummary() {
    const { list } = collect();
    const byId = new Map(accounts.map((a) => [a.id, a]));
    let debit = 0;
    let credit = 0;
    for (const b of list) {
      const dc = fromNormal(b.amount, byId.get(b.accountId));
      if (dc > 0) debit += dc;
      else credit -= dc;
    }
    if (individual) {
      const c = computeOwnerCapital(list, accounts);
      capitalCell.textContent = formatYen(c);
      capitalCell.classList.toggle('neg', c < 0);
      credit += Math.max(c, 0);
      debit += Math.max(-c, 0);
    }
    const diff = debit - credit;
    put(summary, 
      h('div', {}, h('span', { class: 'muted', text: '借方合計' }), h('span', { class: 'num', text: formatYen(debit) })),
      h('div', {}, h('span', { class: 'muted', text: '貸方合計' }), h('span', { class: 'num', text: formatYen(credit) })),
      h('div', { class: diff ? 'diff-ng' : 'diff-ok' }, h('span', { text: '差額' }), h('span', { class: 'num', text: formatYen(Math.abs(diff)) })),
    );
    // 借方と貸方が一致しないと保存できない（個人は元入金で必ず一致する）
    saveBtn.disabled = diff !== 0;
  }

  const input = (k, label) =>
    h('input', {
      type: 'text',
      inputmode: 'numeric',
      class: 'amount-input',
      value: values.get(k) ? formatYen(Number(values.get(k))) : '',
      placeholder: '0',
      'aria-label': label,
      oninput: (e) => {
        values.set(k, e.target.value);
        dirty = true;
        paintSummary();
      },
      onfocus: (e) => {
        const p = parseYen(e.target.value, { allowNegative: true, allowZero: true });
        if (p.ok) e.target.value = String(p.value);
      },
      onblur: (e) => {
        const p = parseYen(e.target.value, { allowNegative: true, allowZero: true });
        if (p.ok) {
          values.set(k, String(p.value));
          e.target.value = p.value ? formatYen(p.value) : '';
        }
      },
    });

  const sections = GROUPS.filter((g) => bsAccounts.some((a) => a.group === g.id)).map((g) =>
    h(
      'section',
      { class: 'panel opening-group' },
      h('h2', { class: 'section-title', text: groupLabel(g.id, settings.entityType) }),
      bsAccounts
        .filter((a) => a.group === g.id)
        .map((a) => {
          if (capital && a.id === capital.id) {
            return h('div', { class: 'ob-row' }, h('span', { class: 'ob-name' }, a.name, h('span', { class: 'muted small block', text: '資産−負債で自動計算' })), capitalCell);
          }
          const subs = subAccounts.filter((s) => s.accountId === a.id && (s.active || values.has(key(a.id, s.id))));
          const side = a.normalSide === g.side ? '' : '（評価勘定・残高をプラスで入力）';
          if (!subs.length) return h('div', { class: 'ob-row' }, h('span', { class: 'ob-name', text: a.name + side }), input(key(a.id), a.name));
          return h(
            'div',
            { class: 'ob-subs' },
            h('span', { class: 'ob-name', text: a.name }),
            subs.map((s) => h('div', { class: 'ob-row ob-sub' }, h('span', { class: 'ob-name', text: s.name }), input(key(a.id, s.id), `${a.name} ${s.name}`))),
            h('div', { class: 'ob-row ob-sub' }, h('span', { class: 'ob-name muted', text: '補助なし' }), input(key(a.id), `${a.name} 補助なし`)),
          );
        }),
    ),
  );

  put(outlet,
    closedNotice(period),
    h(
      'p',
      { class: 'muted small', text: `${period.startDate.replaceAll('-', '/')} 時点の残高を、各科目の残高の側（資産は借方、負債・純資産は貸方）でプラスとして入力します。マイナスは「-」か「△」を付けます。` },
    ),
    individual ? h('p', { class: 'muted small', text: '個人事業主は、元入金＝資産の合計−負債の合計で自動計算します（事業主貸・事業主借は期首は0です）。' }) : null,
    ...sections,
    errorsEl,
    h('div', { class: 'form-footer' }, summary, saveBtn),
  );
  paintSummary();
  if (period.closed) {
    for (const el of outlet.querySelectorAll('input')) el.disabled = true;
    saveBtn.hidden = true;
    return;
  }

  app.leaveGuard = async () => !dirty || confirmDialog({ title: '入力中の内容を破棄しますか？', buttons: [{ label: '入力を続ける', value: false }, { label: '破棄する', value: true, variant: 'danger' }] });

  async function save() {
    const { list, errors } = collect();
    if (errors.length) {
      put(errorsEl, errorBox(errors));
      return;
    }
    try {
      const saved = await app.db.saveOpeningBalances(period.id, list);
      dirty = false;
      app.leaveGuard = null;
      put(errorsEl, );
      if (individual) {
        const c = saved.openingBalances.find((b) => b.accountId === capital.id);
        showToast(`期首残高を保存しました（元入金 ${formatYen(c ? c.amount : 0)}円）`);
      } else showToast('期首残高を保存しました');
    } catch (e) {
      if (e instanceof ValidationError) put(errorsEl, errorBox(Array.isArray(e.errors) ? e.errors : Object.values(e.errors)));
      else showToast(errorText(e, '保存'));
    }
  }
}
