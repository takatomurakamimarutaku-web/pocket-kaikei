// かんたん取引入力：取引の種類ごとに、日付・金額・科目・摘要から2行の仕訳を作る
import { h, put, field, attachSuggest, confirmDialog, showToast, errorBox, taxSelect } from '../ui.js';
import { QUICK_BY_ID, slotCandidates, quickDefaults, buildQuickLines, isFixedSlot, simplePair, isCashAccount } from '../quick.js';
import { validateJournal, memoCandidates } from '../journal.js';
import { TAX_BY_CODE } from '../tax.js';
import { formatYen, parseYen } from '../money.js';
import { todayString, isInPeriod } from '../period.js';
import { createJournal } from '../models.js';
import { normalize } from '../search.js';
import { ValidationError } from '../db.js';
import { errorText } from '../errors.js';
import { pickAccount } from './account-picker.js';
import { closedNotice } from './period-common.js';
import { attachmentPanel } from './attachment-panel.js';

const SIDE_LABEL = { debit: '借方', credit: '貸方' };
/** ボタンで並べる候補の上限。これより多いと科目選択シートで選ぶ */
const MAX_CHIPS = 8;

export async function render({ app, outlet, params, query }) {
  const template = QUICK_BY_ID[params.kind];
  const data = await app.load();
  const { settings, period, accounts, subAccounts, journals, accountById, subById } = data;
  if (!template || (template.entity !== 'both' && template.entity !== settings.entityType)) {
    put(outlet, h('p', { class: 'empty', text: 'この取引の種類は使えません' }), h('a', { href: '#/entry', class: 'btn', text: '入力メニューへ' }));
    return;
  }
  app.setTitle(template.menu ? template.label : `${template.label}の記録`);
  if (period.closed) {
    put(outlet, closedNotice(period));
    return;
  }
  const fixedAccount = accountById.get(query.account);
  const fixedSide = ['debit', 'credit'].find((s) => isFixedSlot(template[s]));
  if (fixedSide && !(isCashAccount(fixedAccount) && fixedAccount.active)) {
    put(outlet, h('p', { class: 'empty', text: '口座が見つかりません' }), h('a', { href: '#/cashbook', class: 'btn', text: '出納帳へ' }));
    return;
  }
  const fixedSub = fixedAccount && subById.get(query.sub)?.accountId === fixedAccount.id ? query.sub : '';

  const lastDate = await app.db.getMeta('lastEntryDate');
  const quickLast = (await app.db.getMeta('quickLast')) || {};
  const defaultDate = () => {
    for (const d of [lastDate, todayString()]) if (d && isInPeriod(d, period)) return d;
    return todayString() > period.endDate ? period.endDate : period.startDate;
  };
  const init = quickDefaults(template, accounts, { last: quickLast[template.id] || {}, fixedId: fixedAccount?.id });
  const sideState = (side) => {
    const acc = accountById.get(init[side]);
    return { accountId: init[side], subAccountId: side === fixedSide ? fixedSub : '', taxCategory: acc ? acc.defaultTaxCategory : 'none' };
  };
  const state = { date: defaultDate(), amount: '', memo: '', debit: sideState('debit'), credit: sideState('credit') };
  let dirty = false;

  const recentIds = [];
  for (const j of [...journals].sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1))) {
    for (const l of j.lines) if (!recentIds.includes(l.accountId)) recentIds.push(l.accountId);
    if (recentIds.length >= 12) break;
  }
  const subsOf = (accountId) => subAccounts.filter((s) => s.accountId === accountId && s.active).sort((a, b) => (a.sortOrder ?? 0) - (b.sortOrder ?? 0));
  const touch = () => {
    dirty = true;
    paintPreview();
  };

  const dateInput = h('input', { id: 'q-date', type: 'date', value: state.date, min: period.startDate, max: period.endDate, onchange: (e) => ((state.date = e.target.value), touch()) });
  const amountInput = h('input', {
    id: 'q-amount',
    type: 'text',
    inputmode: 'numeric',
    class: 'amount-input amount-large',
    placeholder: '0',
    oninput: (e) => ((state.amount = e.target.value), touch()),
    onblur: (e) => {
      const p = parseYen(e.target.value);
      if (p.ok) {
        state.amount = String(p.value);
        e.target.value = formatYen(p.value);
      }
    },
    onfocus: (e) => {
      const p = parseYen(e.target.value);
      if (p.ok) e.target.value = String(p.value);
    },
  });
  const memoInput = h('input', {
    id: 'q-memo',
    type: 'text',
    maxlength: 100,
    placeholder: template.memoPlaceholder,
    oninput: (e) => ((state.memo = e.target.value), touch()),
  });
  const slotEls = { debit: h('div', { class: 'qslot' }), credit: h('div', { class: 'qslot' }) };
  const previewEl = h('div', { class: 'qpreview panel', 'aria-live': 'polite' });
  const errorsEl = h('div', { class: 'errors-wrap' });
  const saveBtn = h('button', { type: 'submit', class: 'btn btn-primary btn-block', text: '登録する' });

  function setAccount(side, id) {
    const a = accountById.get(id);
    state[side] = { accountId: id, subAccountId: '', taxCategory: a ? a.defaultTaxCategory : 'none' };
    dirty = true;
    paintSlot(side);
    paintPreview();
  }

  function paintSlot(side) {
    const slot = template[side];
    const s = state[side];
    const acc = accountById.get(s.accountId);
    const parts = [h('div', { class: 'qslot-head' }, h('span', { class: 'qslot-label', text: slot.label }), h('span', { class: 'muted small', text: SIDE_LABEL[side] }))];
    if (side === fixedSide) {
      parts.push(h('p', { class: 'qfixed', text: acc.name }));
    } else {
      const cands = slotCandidates(slot, accounts);
      const any = slot.pick.some((p) => p.any);
      const pickFrom = async (list, title) => {
        const id = await pickAccount({ accounts: list, entityType: settings.entityType, recentIds, currentId: s.accountId, title });
        if (id && id !== s.accountId) setAccount(side, id);
      };
      if (!any && cands.length <= MAX_CHIPS) {
        const shown = acc && !cands.some((a) => a.id === acc.id) ? [...cands, acc] : cands;
        parts.push(
          h(
            'div',
            { class: 'chips', role: 'radiogroup', 'aria-label': slot.label },
            shown.map((a) => h('button', { type: 'button', class: 'chip', role: 'radio', 'aria-checked': String(a.id === s.accountId), text: a.name, onclick: () => setAccount(side, a.id) })),
            h('button', { type: 'button', class: 'chip chip-more', text: 'その他の科目', onclick: () => pickFrom(accounts, `${slot.label}（すべての科目）`) }),
          ),
        );
      } else {
        parts.push(
          h(
            'button',
            { type: 'button', class: `acc-btn ${acc ? '' : 'is-empty'}`, 'aria-label': slot.label, onclick: () => pickFrom(any ? accounts : cands, slot.label) },
            acc ? h('span', { class: 'acc-name', text: acc.name }) : h('span', { text: '科目を選ぶ' }),
          ),
        );
        if (!any) parts.push(h('button', { type: 'button', class: 'link small', text: 'ほかの区分の科目から選ぶ', onclick: () => pickFrom(accounts, `${slot.label}（すべての科目）`) }));
      }
    }
    const subs = acc ? subsOf(acc.id) : [];
    if (subs.length) {
      parts.push(
        h(
          'select',
          { class: 'sub-select', 'aria-label': `${slot.label}の補助科目`, onchange: (e) => ((s.subAccountId = e.target.value), touch()) },
          h('option', { value: '', text: '補助なし' }),
          subs.map((x) => h('option', { value: x.id, text: x.name, selected: x.id === s.subAccountId })),
        ),
      );
    }
    if (acc && (side === template.taxSide || acc.defaultTaxCategory !== 'none' || s.taxCategory !== 'none')) {
      parts.push(
        h(
          'label',
          { class: 'qtax' },
          h('span', { class: 'muted small', text: '税区分' }),
          taxSelect(s.taxCategory, { split: Boolean(settings.taxUseSplit), class: 'tax-select', onchange: (e) => ((s.taxCategory = e.target.value), touch()) }),
        ),
      );
    }
    put(slotEls[side], ...parts);
  }

  function paintPreview() {
    const p = parseYen(state.amount);
    const amount = p.ok && p.value > 0 ? formatYen(p.value) : '—';
    const line = (side) => {
      const s = state[side];
      const acc = accountById.get(s.accountId);
      const sub = s.subAccountId ? subById.get(s.subAccountId) : null;
      const tax = TAX_BY_CODE[s.taxCategory];
      return h(
        'div',
        { class: 'qp-line' },
        h('span', { class: 'qp-side', text: SIDE_LABEL[side] }),
        h('span', { class: 'qp-acc', text: acc ? `${acc.name}${sub ? `（${sub.name}）` : ''}` : '未選択' }),
        h('span', { class: 'qp-tax', text: tax?.short || '' }),
        h('span', { class: 'qp-amt num', text: amount }),
      );
    };
    put(previewEl, h('p', { class: 'muted small', text: '登録される仕訳' }), line('debit'), line('credit'));
    saveBtn.disabled = !(p.ok && p.value > 0 && state.debit.accountId && state.credit.accountId);
  }

  const candidates = memoCandidates(journals).map((c) => ({ ...c, label: c.memo, sub: `${c.count}回`, key: normalize(c.memo), value: c.memo }));
  attachSuggest(memoInput, {
    items: () => candidates,
    onSelect: (c) => {
      state.memo = c.memo;
      memoInput.value = c.memo;
      // その摘要の直近の仕訳が2行なら、固定していない側の科目を補う
      const pair = simplePair(c.lines);
      if (pair) {
        for (const side of ['debit', 'credit']) {
          if (side === fixedSide) continue;
          const l = pair[side];
          if (!accountById.get(l.accountId)?.active) continue;
          state[side] = { accountId: l.accountId, subAccountId: subById.get(l.subAccountId)?.active ? l.subAccountId : '', taxCategory: l.taxCategory };
          paintSlot(side);
        }
      }
      touch();
    },
  });

  const order = template.taxSide === 'credit' ? ['credit', 'debit'] : ['debit', 'credit'];
  // 証憑の添付（登録したときに一緒に保存する）
  const attach = attachmentPanel({ app, data, current: () => ({ date: state.date, lines: buildQuickLines(state).lines }), onPending: () => (dirty = true) });
  const form = h(
    'form',
    { class: 'quick-form', novalidate: true, onsubmit: (e) => (e.preventDefault(), save()) },
    h('p', { class: 'muted small', text: template.desc }),
    h('div', { class: 'field-row' }, field('日付', dateInput, { name: 'date' }), field('金額（円・税込）', amountInput, { name: 'amount' })),
    h('section', { class: 'panel qslots' }, slotEls[order[0]], slotEls[order[1]]),
    h('div', { class: 'memo-wrap' }, field('摘要', memoInput, { name: 'memo' })),
    previewEl,
    attach.el,
    errorsEl,
    saveBtn,
    h('p', { class: 'center small' }, h('a', { href: '#/journal/new', class: 'link', text: '振替伝票で入力する（複合仕訳など）' })),
  );
  paintSlot('debit');
  paintSlot('credit');
  paintPreview();
  put(outlet, form);

  app.leaveGuard = async () =>
    !dirty ||
    (await confirmDialog({
      title: '入力中の内容を破棄しますか？',
      buttons: [
        { label: '入力を続ける', value: false },
        { label: '破棄する', value: true, variant: 'danger' },
      ],
    }));

  function showErrorList(list) {
    put(errorsEl, errorBox(list));
    errorsEl.scrollIntoView({ behavior: 'smooth', block: 'center' });
  }

  async function save() {
    const { lines, errors } = buildQuickLines(state);
    const journal = createJournal({ periodId: period.id, date: state.date, lines });
    const all = errors.length ? errors : validateJournal(journal, { accounts, subAccounts, period });
    if (all.length) return showErrorList([...new Set(all)]);
    saveBtn.disabled = true;
    try {
      const saved = await app.db.saveJournal(journal);
      await app.db.setMeta('lastEntryDate', state.date);
      const last = {};
      for (const side of ['debit', 'credit']) if (side !== fixedSide) last[side] = state[side].accountId;
      await app.db.setMeta('quickLast', { ...quickLast, [template.id]: last });
      quickLast[template.id] = last;
      journals.push(saved);
      dirty = false;
      const attached = attach.hasPending() ? await attach.commit(saved) : 0;
      showToast(`No.${saved.no} を登録しました${attached ? `（証憑${attached}件）` : ''}`, { actionLabel: '仕訳帳へ', onAction: () => app.navigate(`#/journals?month=${state.date.slice(0, 7)}`), duration: 5000 });
      // 続けて入力できるよう、日付と科目を残して金額・摘要を空にする
      state.amount = '';
      state.memo = '';
      amountInput.value = '';
      memoInput.value = '';
      put(errorsEl);
      paintPreview();
      window.scrollTo({ top: 0, behavior: 'smooth' });
    } catch (e) {
      if (e instanceof ValidationError) showErrorList(Array.isArray(e.errors) ? e.errors : Object.values(e.errors));
      else showToast(errorText(e, '保存'));
      paintPreview();
    }
  }
}
