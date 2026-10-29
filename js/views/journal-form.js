// 仕訳の入力・編集（振替伝票形式）
import { historyItem } from './journal-history.js';
import { h, put, field, attachSuggest, confirmDialog, showToast, errorBox, taxSelect } from '../ui.js';
import { emptyRow, emptySide, rowsToLines, linesToRows, rowsTotals, validateJournal, memoCandidates, copyForNew, journalLabel, voucherOf, parseVoucherNo } from '../journal.js';
import { formatYen, parseYen } from '../money.js';
import { todayString, isInPeriod } from '../period.js';
import { createJournal, createTemplate } from '../models.js';
import { isAdjusting } from '../monthly.js';
import { isBsGroup } from '../accounts.js';
import { normalize } from '../search.js';
import { ValidationError } from '../db.js';
import { errorText } from '../errors.js';
import { pickAccount } from './account-picker.js';
import { closedNotice } from './period-common.js';
import { linesForTemplate, repeatLabel, TEMPLATE_SOURCE } from '../templates.js';
import { attachmentPanel } from './attachment-panel.js';

const SIDE_LABEL = { debit: '借方', credit: '貸方' };

export async function render({ app, outlet, params, query, route }) {
  const data = await app.load();
  const { settings, period, accounts, subAccounts, journals, accountById, departments } = data;
  // 定型仕訳の登録・編集も同じ伝票の画面で行う（日付の代わりに名前と毎月作る日を入れる）
  const templateMode = route?.kind === 'template';
  const templates = await app.db.listTemplates();
  const editingTemplate = templateMode && params.id ? templates.find((t) => t.id === params.id) : null;
  if (templateMode && params.id && !editingTemplate) {
    put(outlet, h('p', { class: 'empty', text: 'この定型仕訳は見つかりません' }));
    return;
  }
  const editing = !templateMode && params.id ? await app.db.getJournal(params.id) : null;
  if (!templateMode && params.id && !editing) {
    put(outlet, h('p', { class: 'empty', text: 'この仕訳は見つかりません（削除された可能性があります）' }));
    return;
  }
  const source = !editing && (query.copy || query.from) ? journals.find((j) => j.id === (query.copy || query.from)) : null;
  // 定型仕訳を呼び出した新規入力
  const fromTemplate = !templateMode && !editing && query.template ? templates.find((t) => t.id === query.template) : null;

  // 日付の初期値：編集中はその日付、新規は前回入力した日付（期間外なら今日か期首）
  const lastDate = await app.db.getMeta('lastEntryDate');
  const defaultDate = () => {
    for (const d of [lastDate, todayString()]) if (d && isInPeriod(d, period)) return d;
    return todayString() > period.endDate ? period.endDate : period.startDate;
  };
  let date = editing ? editing.date : defaultDate();
  // 金額0の行（呼び出したときに入れる金額）は空欄にする
  const templateRows = (t) => linesToRows(t.lines).map((r) => ({ ...r, debit: { ...r.debit, amount: r.debit.amount === '0' ? '' : r.debit.amount }, credit: { ...r.credit, amount: r.credit.amount === '0' ? '' : r.credit.amount } }));
  let rows = editing ? linesToRows(editing.lines) : editingTemplate ? templateRows(editingTemplate) : fromTemplate ? templateRows(fromTemplate) : source ? linesToRows(copyForNew(source).lines) : [emptyRow()];
  let dirty = Boolean(source || fromTemplate);
  const nameInput = h('input', { id: 't-name', type: 'text', maxlength: 30, value: editingTemplate?.name ?? '', placeholder: '例：家賃の支払い' });
  const repeatSelect = h(
    'select',
    { id: 't-repeat' },
    h('option', { value: '', text: '作らない（呼び出して使う）' }),
    Array.from({ length: 31 }, (_, i) => i + 1).map((d) => h('option', { value: d, text: repeatLabel(d), selected: editingTemplate?.repeatDay === d })),
  );

  const candidates = memoCandidates(journals).map((c) => ({ ...c, label: c.memo, sub: `${c.count}回`, key: normalize(c.memo), value: c.memo }));
  // 最近使った科目（新しい仕訳から順に）
  const recentIds = [];
  for (const j of [...journals].sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1))) {
    for (const l of j.lines) if (!recentIds.includes(l.accountId)) recentIds.push(l.accountId);
    if (recentIds.length >= 12) break;
  }
  // 部門：登録してあれば、損益の科目の行に部門を選ぶ欄を出す（貸借対照表の科目には付けない）
  const isPl = (acc) => Boolean(acc) && !isBsGroup(acc.group);
  const departmentsFor = (currentId) => departments.filter((d) => d.active || d.id === currentId);
  // 新しく選んだ損益の科目には、直前の行で付けた部門を入れておく（複合仕訳で同じ部門が続くことが多い）
  const lastDepartment = () => {
    for (const r of [...rows].reverse()) for (const side of ['credit', 'debit']) if (r[side].departmentId) return r[side].departmentId;
    return '';
  };
  const subsOf = (accountId, currentSubId) =>
    subAccounts.filter((s) => s.accountId === accountId && (s.active || s.id === currentSubId)).sort((a, b) => (a.sortOrder ?? 0) - (b.sortOrder ?? 0));

  const adjustingInput = h('input', { type: 'checkbox', id: 'j-adjusting', checked: editing ? isAdjusting(editing) : false, onchange: () => (dirty = true) });
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
  // 伝票No：新規は次の番号（これまでに使った最大の番号＋1）を出しておき、書き換えなければ保存のときに付ける
  const nextVoucher = () => Math.max(period.nextVoucherNo || 1, ...journals.map((j) => voucherOf(j) + 1));
  let voucherTouched = false;
  const voucherInput = h('input', {
    id: 'j-voucher',
    type: 'text',
    inputmode: 'numeric',
    autocomplete: 'off',
    value: String(editing ? voucherOf(editing) : nextVoucher()),
    oninput: () => {
      voucherTouched = true;
      dirty = true;
    },
  });
  const rowsEl = h('div', { class: 'jrows' });
  const totalsEl = h('div', { class: 'jtotals', 'aria-live': 'polite' });
  const errorsEl = h('div', { class: 'errors-wrap' });
  const saveBtn = h('button', { type: 'submit', class: 'btn btn-primary btn-block', text: templateMode ? '定型仕訳を保存する' : editing ? '保存する' : '登録する' });

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
          const departmentId = !isPl(a) ? '' : s.departmentId || (departmentsFor('').some((d) => d.id === lastDepartment()) ? lastDepartment() : '');
          row[side] = { ...s, accountId: id, subAccountId: '', taxCategory: a.defaultTaxCategory, departmentId };
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
    const deps = isPl(acc) ? departmentsFor(s.departmentId) : [];
    const depSelect = deps.length
      ? h(
          'select',
          {
            class: 'dep-select',
            'aria-label': `${index + 1}行目の${SIDE_LABEL[side]}部門`,
            onchange: (e) => {
              s.departmentId = e.target.value;
              dirty = true;
            },
          },
          h('option', { value: '', text: '部門なし（共通）' }),
          deps.map((d) => h('option', { value: d.id, text: d.active ? d.name : `${d.name}（使わない）`, selected: d.id === s.departmentId })),
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
    const tax = taxSelect(s.taxCategory, {
      split: Boolean(settings.taxUseSplit),
      class: 'tax-select',
      'aria-label': `${index + 1}行目の${SIDE_LABEL[side]}税区分`,
      onchange: (e) => {
        s.taxCategory = e.target.value;
        dirty = true;
      },
    });
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
      depSelect,
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
              const dep = l.departmentId && departmentsFor('').some((d) => d.id === l.departmentId) ? l.departmentId : '';
              row[side] = { ...emptySide(), ...row[side], accountId: l.accountId, subAccountId: l.subAccountId || '', taxCategory: l.taxCategory, departmentId: dep };
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
    // 定型仕訳は金額を空欄（呼び出したときに入れる）にできる
    saveBtn.disabled = t.diff !== 0 || (!templateMode && t.debit === 0);
  }

  // 締めた期間の仕訳は表示のみ（編集中の仕訳はその仕訳の期間、新規は表示中の期間で判定）
  const locked = templateMode ? false : editing ? (await app.db.listPeriods()).find((p) => p.id === editing.periodId)?.closed : period.closed;
  if (locked) {
    app.setTitle(editing ? '仕訳の表示' : '仕訳の入力');
    put(outlet, closedNotice({ closed: true }), editing ? journalCardLike(editing) : null);
    // 添付した証憑は表示だけできる
    if (editing && (await app.db.listAttachmentsByJournal(editing.id)).length) outlet.append(attachmentPanel({ app, data, journalId: editing.id, locked: true, current: () => editing }).el);
    await appendHistory();
    return;
  }
  // この仕訳の訂正・削除の履歴
  async function appendHistory() {
    if (!editing) return;
    const list = (await app.db.listJournalHistory(editing.periodId)).filter((e) => e.journalId === editing.id);
    if (!list.length) return;
    outlet.append(h('details', { class: 'panel journal-history' }, h('summary', { text: `この仕訳の履歴（${list.length}件）` }), h('ul', { class: 'history-list' }, list.map((e) => historyItem(e, { accountById, subById: data.subById, departmentById: data.departmentById })))));
  }
  function journalCardLike(j) {
    return h(
      'div',
      { class: 'panel' },
      h('p', { class: 'muted small', text: `${journalLabel(j)}・${j.date.replaceAll('-', '/')}` }),
      h('ul', { class: 'plain-list' }, j.lines.map((l) => h('li', { text: `${SIDE_LABEL[l.side]}　${accountById.get(l.accountId)?.name ?? '（不明な科目）'}　${formatYen(l.amount)}円${l.memo ? `　${l.memo}` : ''}` }))),
    );
  }

  // 証憑（領収書・請求書）の添付。新しい仕訳は登録したときに一緒に保存する
  const attach = templateMode
    ? null
    : attachmentPanel({ app, data, journalId: editing?.id ?? null, current: () => ({ date, lines: rowsToLines(rows).lines }), onPending: () => (dirty = true) });

  const form = h(
    'form',
    { class: 'journal-form', novalidate: true, onsubmit: (e) => (e.preventDefault(), templateMode ? saveTemplate() : save()) },
    editing ? h('p', { class: 'muted small', text: `入力No.${editing.no}（登録した順に付く番号で、変わりません）` }) : null,
    editing?.source === 'invoice' ? h('p', { class: 'notice small' }, '請求書を発行したときに作った売掛金の仕訳です。', h('a', { href: `#/invoices/${editing.sourceId}`, text: '請求書を見る' })) : null,
    editing?.source === 'payroll' ? h('p', { class: 'notice small' }, '給与計算で登録した仕訳です。金額を直すときは、給与明細の画面で「計上を取り消す」を押して給与を直してください。', h('a', { href: `#/payroll/${editing.sourceId}`, text: '給与明細を見る' })) : null,
    editing?.source === 'payroll_payment' ? h('p', { class: 'notice small' }, '給与計算の「税・保険料の納付」で登録した仕訳です。', h('a', { href: '#/payroll/payments', text: '納付の画面へ' })) : null,
    source && !templateMode ? h('p', { class: 'notice', text: `${journalLabel(source)} を複製しました。日付を確認して登録してください。` }) : null,
    fromTemplate ? h('p', { class: 'notice', text: `定型仕訳「${fromTemplate.name}」を呼び出しました。日付と金額を確認して登録してください。` }) : null,
    templateMode
      ? [
          source ? h('p', { class: 'notice', text: `${journalLabel(source)} の内容から定型仕訳を作ります。名前を付けて保存してください。` }) : null,
          field('名前', nameInput, { name: 'name' }),
          field('毎月作る', repeatSelect, { name: 'repeatDay', hint: '日を選ぶと「定型仕訳」画面の「毎月の仕訳を作る」でまとめて登録できます。毎月作るものはすべての金額を入れてください。31日を超える月は月末日になります' }),
          h('p', { class: 'muted small', text: '金額を空欄にすると、呼び出したときに入力します。' }),
        ]
      : h('div', { class: 'field-row' }, field('日付', dateInput, { name: 'date' }), field('伝票No', voucherInput, { name: 'voucherNo' })),
    rowsEl,
    templateMode ? null : h('label', { class: 'check small adjusting-check' }, adjustingInput, '決算整理仕訳（月次推移の試算表で「決算整理」の列に分けて表示）'),
    attach?.el,
    errorsEl,
    h('div', { class: 'form-footer' }, totalsEl, saveBtn),
    editing
      ? h(
          'div',
          { class: 'actions' },
          h('a', { href: `#/journal/new?copy=${encodeURIComponent(editing.id)}`, class: 'btn', text: '複製して新規入力' }),
          h('a', { href: `#/template/new?from=${encodeURIComponent(editing.id)}`, class: 'btn', text: '定型仕訳に登録' }),
          h('button', { type: 'button', class: 'btn btn-danger-text', text: '削除', onclick: remove }),
        )
      : null,
    editingTemplate ? h('div', { class: 'actions' }, h('button', { type: 'button', class: 'btn btn-danger-text', text: '定型仕訳を削除', onclick: removeTemplate })) : null,
  );
  paintRows();
  put(outlet, form);
  await appendHistory();

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
    // 伝票No：編集では入力のまま、新規で書き換えていなければ保存のときに次の番号を付ける
    const voucher = editing || voucherTouched ? parseVoucherNo(voucherInput.value) : { ok: true, value: null };
    if (!voucher.ok) errors.unshift(voucher.error);
    const voucherNo = voucher.ok ? voucher.value : null;
    const journal = editing
      ? { ...editing, date, voucherNo: voucherNo ?? voucherOf(editing), lines, adjusting: adjustingInput.checked }
      : createJournal({ periodId: period.id, date, lines, adjusting: adjustingInput.checked, ...(voucherNo ? { voucherNo } : {}), ...(fromTemplate ? { source: TEMPLATE_SOURCE, sourceId: fromTemplate.id } : {}) });
    const all = [...errors, ...validateJournal(journal, { accounts, subAccounts, period, original: editing, departments })];
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
        showToast(`${journalLabel(saved)} を保存しました`);
        app.goBack('#/journals');
        return;
      }
      const attached = attach.hasPending() ? await attach.commit(saved) : 0;
      // 続けて入力できるよう、日付を残して伝票を空にする
      showToast(`${journalLabel(saved)} を登録しました${attached ? `（証憑${attached}件）` : ''}`, { actionLabel: '仕訳帳へ', onAction: () => app.navigate(`#/journals?month=${date.slice(0, 7)}`), duration: 5000 });
      if (source || fromTemplate) {
        app.navigate('#/journal/new', { replace: true });
        return;
      }
      journals.push(saved);
      rows = [emptyRow()];
      adjustingInput.checked = false;
      period.nextVoucherNo = Math.max(period.nextVoucherNo || 1, saved.voucherNo + 1);
      voucherInput.value = String(nextVoucher());
      voucherTouched = false;
      clearErrors();
      paintRows();
      window.scrollTo({ top: 0, behavior: 'smooth' });
    } catch (e) {
      if (e instanceof ValidationError) showErrorList(Array.isArray(e.errors) ? e.errors : Object.values(e.errors));
      else showToast(errorText(e, '保存'));
      paintTotals();
    }
  }

  // 定型仕訳の保存（金額の空欄は0＝呼び出したときに入れる）
  async function saveTemplate() {
    const lines = [];
    const errors = [];
    rows.forEach((row, i) => {
      for (const side of ['debit', 'credit']) {
        const sd = row[side];
        if (!sd.accountId && String(sd.amount ?? '').trim() === '') continue;
        const p = String(sd.amount ?? '').trim() === '' ? { ok: true, value: 0 } : parseYen(sd.amount, { allowZero: true });
        if (!p.ok) errors.push(`${i + 1}行目（${SIDE_LABEL[side]}）：${p.error}`);
        lines.push({ side, accountId: sd.accountId, subAccountId: sd.subAccountId || null, amount: p.ok ? p.value : NaN, taxCategory: sd.taxCategory || 'none', memo: String(row.memo ?? '').trim(), ...(sd.departmentId ? { departmentId: sd.departmentId } : {}) });
      }
    });
    if (errors.length) return showErrorList(errors);
    const base = editingTemplate || createTemplate();
    const record = { ...base, name: nameInput.value, repeatDay: repeatSelect.value ? Number(repeatSelect.value) : null, lines: linesForTemplate(lines) };
    try {
      await app.db.saveTemplate(record);
      dirty = false;
      app.leaveGuard = null;
      showToast(`定型仕訳「${record.name.trim()}」を保存しました`);
      app.navigate('#/templates', { replace: true });
    } catch (e) {
      if (e instanceof ValidationError) showErrorList(Array.isArray(e.errors) ? e.errors : Object.values(e.errors));
      else showToast(errorText(e, '保存'));
    }
  }

  async function removeTemplate() {
    const ok = await confirmDialog({
      title: `定型仕訳「${editingTemplate.name}」を削除しますか？`,
      message: 'この定型仕訳から作った仕訳は残ります。',
      buttons: [
        { label: 'キャンセル', value: false },
        { label: '削除する', value: true, variant: 'danger' },
      ],
    });
    if (!ok) return;
    await app.db.deleteTemplate(editingTemplate.id);
    dirty = false;
    app.leaveGuard = null;
    showToast('削除しました');
    app.navigate('#/templates', { replace: true });
  }

  async function remove() {
    const ok = await confirmDialog({
      title: `${journalLabel(editing)} を削除しますか？`,
      message: '削除した直後は「元に戻す」で取り消せます。添付した証憑は消さずに残します（証憑の一覧で確かめられます）。',
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
      showToast(`${journalLabel(editing)} を削除しました`, {
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
