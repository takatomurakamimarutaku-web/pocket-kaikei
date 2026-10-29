// 仕訳の入力・編集（振替伝票形式）
import { h, put, field, attachSuggest, confirmDialog, showToast, errorBox } from '../ui.js';
import { emptyRow, emptySide, rowsToLines, linesToRows, rowsTotals, validateJournal, memoCandidates, copyForNew } from '../journal.js';
import { TAX_CATEGORIES } from '../tax.js';
import { formatYen, parseYen } from '../money.js';
import { todayString, isInPeriod } from '../period.js';
import { createJournal } from '../models.js';
import { normalize } from '../search.js';
import { ValidationError } from '../db.js';
import { errorText } from '../errors.js';
import { pickAccount } from './account-picker.js';
import { closedNotice } from './period-common.js';

const SIDE_LABEL = { debit: '借方', credit: '貸方' };

export async function render({ app, outlet, params, query }) {
  const data = await app.load();
  const { settings, period, accounts, subAccounts, journals, accountById } = data;
  const editing = params.id ? await app.db.getJournal(params.id) : null;
  if (params.id && !editing) {
    put(outlet, h('p', { class: 'empty', text: 'この仕訳は見つかりません（削除された可能性があります）' }));
    return;
  }
  const source = !editing && query.copy ? journals.find((j) => j.id === query.copy) : null;

  // 日付の初期値：編集中はその日付、新規は前回入力した日付（期間外なら今日か期首）
  const lastDate = await app.db.getMeta('lastEntryDate');
  const defaultDate = () => {
    for (const d of [lastDate, todayString()]) if (d && isInPeriod(d, period)) return d;
    return todayString() > period.endDate ? period.endDate : period.startDate;
  };
  let date = editing ? editing.date : defaultDate();
  let rows = editing ? linesToRows(editing.lines) : source ? linesToRows(copyForNew(source).lines) : [emptyRow()];
  let dirty = Boolean(source);

  const candidates = memoCandidates(journals).map((c) => ({ ...c, label: c.memo, sub: `${c.count}回`, key: normalize(c.memo), value: c.memo }));
  // 最近使った科目（新しい仕訳から順に）
  const recentIds = [];
  for (const j of [...journals].sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1))) {
    for (const l of j.lines) if (!recentIds.includes(l.accountId)) recentIds.push(l.accountId);
    if (recentIds.length >= 12) break;
  }
  const subsOf = (accountId, currentSubId) =>
    subAccounts.filter((s) => s.accountId === accountId && (s.active || s.id === currentSubId)).sort((a, b) => (a.sortOrder ?? 0) - (b.sortOrder ?? 0));

  const dateInput = h('input', {
    id: 'j-date',
    type: 'date',
    value: date,
    min: period.startDate,
    max: period.endDate,
    onchange: (e) => {
      date = e.target.value;
      dirty = true;
    },
  });
  const rowsEl = h('div', { class: 'jrows' });
  const totalsEl = h('div', { class: 'jtotals', 'aria-live': 'polite' });
  const errorsEl = h('div', { class: 'errors-wrap' });
  const saveBtn = h('button', { type: 'submit', class: 'btn btn-primary btn-block', text: editing ? '保存する' : '登録する' });

  function sideBlock(row, side, index) {
    const s = row[side];
    const acc = accountById.get(s.accountId);
    const accBtn = h(
      'button',
      {
        type: 'button',
        class: `acc-btn ${acc ? '' : 'is-empty'}`,
        'aria-label': `${index + 1}行目の${SIDE_LABEL[side]}科目`,
        onclick: async () => {
          const id = await pickAccount({ accounts, entityType: settings.entityType, recentIds, currentId: s.accountId, title: `${SIDE_LABEL[side]}の勘定科目` });
          if (!id || id === s.accountId) return;
          const a = accountById.get(id);
          row[side] = { ...s, accountId: id, subAccountId: '', taxCategory: a.defaultTaxCategory };
          dirty = true;
          paintRows();
        },
      },
      acc ? h('span', { class: 'acc-name', text: acc.name }) : h('span', { text: '科目を選ぶ' }),
    );
    const subs = acc ? subsOf(acc.id, s.subAccountId) : [];
    const subSelect = subs.length
      ? h(
          'select',
          {
            class: 'sub-select',
            'aria-label': `${index + 1}行目の${SIDE_LABEL[side]}補助科目`,
            onchange: (e) => {
              s.subAccountId = e.target.value;
              dirty = true;
            },
          },
          h('option', { value: '', text: '補助なし' }),
          subs.map((x) => h('option', { value: x.id, text: x.name, selected: x.id === s.subAccountId })),
        )
      : null;
    const amount = h('input', {
      type: 'text',
      inputmode: 'numeric',
      class: 'amount-input',
      placeholder: '金額',
      value: s.amount ? formatYen(Number(s.amount)) : '',
      'aria-label': `${index + 1}行目の${SIDE_LABEL[side]}金額`,
      oninput: (e) => {
        s.amount = e.target.value;
        dirty = true;
        paintTotals();
      },
      onblur: (e) => {
        const p = parseYen(e.target.value);
        if (p.ok) {
          s.amount = String(p.value);
          e.target.value = formatYen(p.value);
        }
      },
      onfocus: (e) => {
        const p = parseYen(e.target.value);
        if (p.ok) e.target.value = String(p.value);
      },
    });
    const tax = h(
      'select',
      {
        class: 'tax-select',
        'aria-label': `${index + 1}行目の${SIDE_LABEL[side]}税区分`,
        onchange: (e) => {
          s.taxCategory = e.target.value;
          dirty = true;
        },
      },
      TAX_CATEGORIES.map((t) => h('option', { value: t.code, text: t.label, selected: t.code === s.taxCategory })),
    );
    // 反対側の金額を差額で埋めるボタン（複合仕訳で便利）
    const fill = h('button', {
      type: 'button',
      class: 'link small fill-btn',
      text: '差額',
      'aria-label': `${index + 1}行目の${SIDE_LABEL[side]}に差額を入れる`,
      onclick: () => {
        const t = rowsTotals(rows);
        const cur = parseYen(s.amount).ok ? parseYen(s.amount).value : 0;
        const need = side === 'debit' ? t.credit - (t.debit - cur) : t.debit - (t.credit - cur);
        if (need > 0) {
          s.amount = String(need);
          amount.value = formatYen(need);
          dirty = true;
          paintTotals();
        }
      },
    });
    return h(
      'div',
      { class: `jside jside-${side}` },
      h('div', { class: 'jside-head' }, h('span', { class: 'jside-label', text: SIDE_LABEL[side] }), fill),
      accBtn,
      subSelect,
      h('div', { class: 'jside-amount' }, amount, tax),
    );
  }

  function paintRows() {
    put(rowsEl, 
      ...rows.map((row, i) => {
        const memo = h('input', {
          type: 'text',
          maxlength: 100,
          placeholder: '摘要',
          value: row.memo,
          'aria-label': `${i + 1}行目の摘要`,
          oninput: (e) => {
            row.memo = e.target.value;
            dirty = true;
          },
        });
        const memoWrap = h('div', { class: 'memo-wrap' }, memo);
        attachSuggest(memo, {
          items: () => candidates,
          onSelect: (c) => {
            row.memo = c.memo;
            memo.value = c.memo;
            dirty = true;
            // 科目が空欄の側だけ、その摘要を使った直近の仕訳の科目で補う
            let filled = false;
            for (const side of ['debit', 'credit']) {
              if (row[side].accountId) continue;
              const l = c.lines.find((x) => x.side === side && accountById.get(x.accountId)?.active);
              if (!l) continue;
              row[side] = { ...emptySide(), ...row[side], accountId: l.accountId, subAccountId: l.subAccountId || '', taxCategory: l.taxCategory };
              filled = true;
            }
            if (filled) paintRows();
          },
        });
        return h(
          'section',
          { class: 'jrow panel' },
          h(
            'div',
            { class: 'jrow-head' },
            h('span', { class: 'jrow-no', text: `${i + 1}行目` }),
            rows.length > 1
              ? h('button', {
                  type: 'button',
                  class: 'link danger small',
                  text: '行を削除',
                  onclick: () => {
                    rows.splice(i, 1);
                    dirty = true;
                    paintRows();
                  },
                })
              : null,
          ),
          h('div', { class: 'jsides' }, sideBlock(row, 'debit', i), sideBlock(row, 'credit', i)),
          memoWrap,
        );
      }),
      h('button', {
        type: 'button',
        class: 'btn btn-block add-row',
        text: '＋ 行を追加（複合仕訳）',
        onclick: () => {
          rows.push(emptyRow());
          paintRows();
        },
      }),
    );
    paintTotals();
  }

  function paintTotals() {
    const t = rowsTotals(rows);
    put(totalsEl, 
      h('div', {}, h('span', { class: 'muted', text: '借方' }), h('span', { class: 'num', text: formatYen(t.debit) })),
      h('div', {}, h('span', { class: 'muted', text: '貸方' }), h('span', { class: 'num', text: formatYen(t.credit) })),
      h(
        'div',
        { class: t.diff ? 'diff-ng' : 'diff-ok' },
        h('span', { text: '貸借差額' }),
        h('span', { class: 'num', text: t.diff ? formatYen(Math.abs(t.diff)) : '0' }),
      ),
    );
    saveBtn.disabled = t.diff !== 0 || t.debit === 0;
  }

  // 締めた期間の仕訳は表示のみ（編集中の仕訳はその仕訳の期間、新規は表示中の期間で判定）
  const locked = editing ? (await app.db.listPeriods()).find((p) => p.id === editing.periodId)?.closed : period.closed;
  if (locked) {
    app.setTitle(editing ? '仕訳の表示' : '仕訳の入力');
    put(outlet, closedNotice({ closed: true }), editing ? journalCardLike(editing) : null);
    return;
  }
  function journalCardLike(j) {
    return h(
      'div',
      { class: 'panel' },
      h('p', { class: 'muted small', text: `No.${j.no}・${j.date.replaceAll('-', '/')}` }),
      h('ul', { class: 'plain-list' }, j.lines.map((l) => h('li', { text: `${SIDE_LABEL[l.side]}　${accountById.get(l.accountId)?.name ?? '（不明な科目）'}　${formatYen(l.amount)}円${l.memo ? `　${l.memo}` : ''}` }))),
    );
  }

  const form = h(
    'form',
    { class: 'journal-form', novalidate: true, onsubmit: (e) => (e.preventDefault(), save()) },
    editing ? h('p', { class: 'muted small', text: `No.${editing.no}` }) : null,
    source ? h('p', { class: 'notice', text: `No.${source.no} を複製しました。日付を確認して登録してください。` }) : null,
    field('日付', dateInput, { name: 'date' }),
    rowsEl,
    errorsEl,
    h('div', { class: 'form-footer' }, totalsEl, saveBtn),
    editing
      ? h(
          'div',
          { class: 'actions' },
          h('a', { href: `#/journal/new?copy=${encodeURIComponent(editing.id)}`, class: 'btn', text: '複製して新規入力' }),
          h('button', { type: 'button', class: 'btn btn-danger-text', text: '削除', onclick: remove }),
        )
      : null,
  );
  paintRows();
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
  const clearErrors = () => put(errorsEl, );

  async function save() {
    const { lines, errors } = rowsToLines(rows);
    const journal = editing ? { ...editing, date, lines } : createJournal({ periodId: period.id, date, lines });
    const all = [...errors, ...validateJournal(journal, { accounts, subAccounts, period, original: editing })];
    if (all.length) {
      showErrorList([...new Set(all)]);
      return;
    }
    saveBtn.disabled = true;
    try {
      const saved = await app.db.saveJournal(journal);
      await app.db.setMeta('lastEntryDate', date);
      dirty = false;
      app.leaveGuard = null;
      if (editing) {
        showToast(`No.${saved.no} を保存しました`);
        app.goBack('#/journals');
        return;
      }
      // 続けて入力できるよう、日付を残して伝票を空にする
      showToast(`No.${saved.no} を登録しました`, { actionLabel: '仕訳帳へ', onAction: () => app.navigate(`#/journals?month=${date.slice(0, 7)}`), duration: 5000 });
      if (source) {
        app.navigate('#/journal/new', { replace: true });
        return;
      }
      journals.push(saved);
      rows = [emptyRow()];
      clearErrors();
      paintRows();
      window.scrollTo({ top: 0, behavior: 'smooth' });
    } catch (e) {
      if (e instanceof ValidationError) showErrorList(Array.isArray(e.errors) ? e.errors : Object.values(e.errors));
      else showToast(errorText(e, '保存'));
      paintTotals();
    }
  }

  async function remove() {
    const ok = await confirmDialog({
      title: `No.${editing.no} を削除しますか？`,
      message: '削除した直後は「元に戻す」で取り消せます。',
      buttons: [
        { label: 'キャンセル', value: false },
        { label: '削除する', value: true, variant: 'danger' },
      ],
    });
    if (!ok) return;
    try {
      const snap = await app.db.deleteJournal(editing.id);
      dirty = false;
      app.leaveGuard = null;
      showToast(`No.${editing.no} を削除しました`, {
        actionLabel: '元に戻す',
        duration: 6000,
        onAction: async () => {
          await app.db.restoreJournal(snap);
          app.refresh();
        },
      });
      app.goBack('#/journals');
    } catch (e) {
      showToast(errorText(e, '削除'));
    }
  }
}
