// 請求書・見積書の作成と編集（下書き）。見積書から請求書を作る・複製もここで開く
import { h, put, field, segmented, showToast, confirmDialog, errorBox } from '../ui.js';
import { formatYen } from '../money.js';
import { ValidationError } from '../db.js';
import { errorText } from '../errors.js';
import { todayString } from '../period.js';
import { compareAccounts } from '../accounts.js';
import { dueDate as termsDueDate, termsLabel } from '../receivables.js';
import {
  INVOICE_KINDS,
  LINE_TAXES,
  PRICE_MODES,
  ROUNDINGS,
  HONORIFICS,
  MAX_INVOICE_LINES,
  MAX_NUMBER,
  MAX_NAME,
  MAX_ITEM,
  MAX_UNIT,
  MAX_NOTE,
  invoiceDraft,
  copyInvoice,
  nextInvoiceNumber,
  invoiceTotals,
  validateInvoice,
  parseQuantity,
  parseUnitPrice,
  formatQuantity,
  lineAmount,
  isRevenueAccount,
} from '../invoices.js';

export async function render({ app, outlet, params, query }) {
  const [settings, accounts, subAccounts, invoices] = await Promise.all([app.db.getSettings(), app.db.listAccounts(), app.db.listSubAccounts(), app.db.listInvoices()]);
  const today = todayString();
  const editing = params.id ? invoices.find((x) => x.id === params.id) : null;
  if (params.id && !editing) return put(outlet, h('p', { class: 'notice', text: '請求書・見積書が見つかりません' }), h('a', { href: '#/invoices', class: 'btn', text: '一覧へ' }));
  if (editing && editing.status !== 'draft') {
    return put(outlet, h('p', { class: 'notice', text: '発行した請求書は変更できません。直すときは取り消してから複製してください。' }), h('a', { href: `#/invoices/${editing.id}`, class: 'btn', text: '請求書へ戻る' }));
  }
  const fromId = query.from || query.copy;
  const src = !editing && fromId ? invoices.find((x) => x.id === fromId) : null;
  const kind = editing?.kind ?? (query.from ? 'invoice' : src?.kind ?? (INVOICE_KINDS[query.kind] ? query.kind : 'invoice'));
  const label = INVOICE_KINDS[kind].label;
  const inv = editing
    ? structuredClone(editing)
    : src
      ? copyInvoice(src, { kind, number: nextInvoiceNumber(invoices, kind), today, accounts })
      : invoiceDraft({ kind, number: nextInvoiceNumber(invoices, kind), today, settings, accounts });
  const isInvoice = kind === 'invoice';
  let dirty = Boolean(src);

  // 取引先：売掛金の補助科目（入金の消し込み・支払条件と結びつく）
  const receivableIds = new Set(accounts.filter((a) => a.hint === 'receivable').map((a) => a.id));
  const customers = subAccounts.filter((s) => receivableIds.has(s.accountId) && (s.active || s.id === inv.customer.subAccountId)).sort((a, b) => (a.sortOrder ?? 0) - (b.sortOrder ?? 0));
  const revenueAccounts = accounts.filter((a) => isRevenueAccount(a) && (a.active || a.id === inv.revenueAccountId)).sort(compareAccounts);

  const errorsEl = h('div', { class: 'errors-wrap' });
  const text = (id, value, attrs = {}) => h('input', { id, type: 'text', value: value ?? '', ...attrs });
  const date = (id, value) => h('input', { id, type: 'date', value: value ?? '' });
  const number = text('inv-number', inv.number, { maxlength: MAX_NUMBER, autocomplete: 'off' });
  const issueDate = date('inv-issue', inv.issueDate);
  const deliveryFrom = isInvoice ? date('inv-from', inv.deliveryFrom) : null;
  const deliveryTo = isInvoice ? date('inv-to', inv.deliveryTo) : null;
  const due = date(isInvoice ? 'inv-due' : 'inv-valid', isInvoice ? inv.dueDate : inv.validUntil);
  const customerName = text('inv-customer', inv.customer.name, { maxlength: MAX_NAME, placeholder: '例：株式会社ポケット商事' });
  const honorific = h('select', { id: 'inv-honorific', 'aria-label': '敬称' }, HONORIFICS.map((v) => h('option', { value: v, text: v || 'なし', selected: v === (inv.customer.honorific ?? '') })));
  const subject = text('inv-subject', inv.subject, { maxlength: MAX_NAME, placeholder: '例：10月分 ホームページ保守' });
  const note = h('textarea', { id: 'inv-note', rows: 3, maxlength: MAX_NOTE, value: inv.note || '' });
  const termsHint = h('p', { class: 'field-hint' });
  let dueAuto = !inv.dueDate;

  const customerSelect = h(
    'select',
    { id: 'inv-customer-sub', 'aria-label': '取引先' },
    h('option', { value: '', text: '取引先に登録しない（宛先を直接入力）' }),
    customers.map((s) => h('option', { value: s.id, text: s.active ? s.name : `${s.name}（無効）`, selected: s.id === inv.customer.subAccountId })),
  );
  const subOf = (id) => customers.find((s) => s.id === id) || null;
  function paintTerms() {
    const sub = subOf(customerSelect.value);
    termsHint.textContent = sub?.paymentTerms ? `支払条件：${termsLabel(sub.paymentTerms)}。お支払期限は取引年月日から自動で入れます` : customers.length ? '売掛金の取引先を選ぶと、発行したときの売掛金がその取引先に付き、入金の消し込みと支払条件（支払期限）に使われます' : '売掛金の補助科目に取引先を登録すると、ここで選べます（勘定科目の画面）';
  }
  /** 支払期限：取引先の支払条件から（手で入れたら変えない） */
  function autoDue() {
    if (!isInvoice || !dueAuto) return;
    const sub = subOf(customerSelect.value);
    const base = deliveryTo.value || deliveryFrom.value;
    const d = sub?.paymentTerms && base ? termsDueDate(base, sub.paymentTerms) : null;
    if (d) due.value = d;
  }
  customerSelect.addEventListener('change', () => {
    const prev = subOf(inv.customer.subAccountId);
    const sub = subOf(customerSelect.value);
    if (sub && (!customerName.value.trim() || customerName.value.trim() === prev?.name)) customerName.value = sub.name;
    inv.customer.subAccountId = sub?.id ?? null;
    paintTerms();
    autoDue();
  });
  if (isInvoice) {
    for (const el of [deliveryFrom, deliveryTo]) el.addEventListener('change', autoDue);
    due.addEventListener('change', () => (dueAuto = !due.value));
  }
  const revenueSelect = isInvoice ? h('select', { id: 'inv-revenue', 'aria-label': '売上の科目' }, revenueAccounts.map((a) => h('option', { value: a.id, text: `${a.code} ${a.name}`, selected: a.id === inv.revenueAccountId }))) : null;

  // ---- 明細 ----
  let rows = inv.lines.map((l) => ({ name: l.name, qty: formatQuantity(l.qty100).replace(/,/g, ''), unit: l.unit || '', price: l.unitPrice ? String(l.unitPrice) : '', tax: l.tax }));
  const linesEl = h('div', { class: 'inv-lines' });
  const totalsEl = h('div', { class: 'inv-totals', 'aria-live': 'polite' });
  let priceMode = inv.priceMode;
  let rounding = inv.rounding;

  /** 画面の行を明細にする。読めない行は errors に入れる */
  function parseRows() {
    const errors = [];
    const lines = rows.map((r, i) => {
      const q = parseQuantity(r.qty);
      const p = parseUnitPrice(r.price);
      if (!q.ok) errors.push(`明細${i + 1}行目：${q.error}`);
      if (!p.ok) errors.push(`明細${i + 1}行目：${p.error}`);
      return { name: r.name, qty100: q.ok ? q.value : 0, unit: r.unit, unitPrice: p.ok ? p.value : 0, tax: r.tax, ok: q.ok && p.ok };
    });
    return { lines, errors };
  }

  function paintTotals() {
    const { lines } = parseRows();
    const t = invoiceTotals({ priceMode, rounding, lines: lines.filter((l) => l.ok) });
    rows.forEach((r, i) => {
      const out = linesEl.querySelector(`[data-amount="${i}"]`);
      if (out) out.textContent = lines[i].ok ? `${formatYen(lineAmount(lines[i]))}円` : '—';
    });
    const inclusive = priceMode === 'inclusive';
    put(
      totalsEl,
      h(
        'table',
        { class: 'report inv-totals-table' },
        h(
          'tbody',
          {},
          t.groups.map((g) =>
            h(
              'tr',
              {},
              h('th', { scope: 'row', text: g.rate ? `${g.label}対象${inclusive ? '（税込）' : ''}` : g.label }),
              h('td', { class: 'num', text: formatYen(g.rate && !inclusive ? g.net : g.gross) }),
              h('td', { class: 'num muted small', text: g.rate ? `${inclusive ? '内' : ''}消費税 ${formatYen(g.tax)}` : '' }),
            ),
          ),
        ),
        h('tfoot', {}, h('tr', {}, h('th', { scope: 'row', text: '合計（税込）' }), h('td', { class: 'num', text: formatYen(t.total) }), h('td', { class: 'num muted small', text: `消費税 ${formatYen(t.tax)}` }))),
      ),
    );
  }

  function lineCard(r, i) {
    const on = (key) => (e) => {
      r[key] = e.target.value;
      dirty = true;
      paintTotals();
    };
    const no = i + 1;
    return h(
      'div',
      { class: 'inv-line' },
      h('div', { class: 'inv-line-head' }, h('span', { class: 'inv-line-no', text: `明細${no}` }), rows.length > 1 ? h('button', { type: 'button', class: 'link danger small', text: '削除', 'aria-label': `明細${no}を削除`, onclick: () => ((rows = rows.filter((_, k) => k !== i)), (dirty = true), paintLines()) }) : null),
      h('input', { type: 'text', value: r.name, maxlength: MAX_ITEM, placeholder: '品名・内容', 'aria-label': `明細${no}の品名`, oninput: on('name') }),
      h('div', { class: 'inv-line-nums inv-line-caps', 'aria-hidden': 'true' }, ['数量', '単位', priceMode === 'inclusive' ? '単価（税込）' : '単価（税抜）', '税率'].map((t) => h('span', { text: t }))),
      h(
        'div',
        { class: 'inv-line-nums' },
        h('input', { type: 'text', inputmode: 'decimal', value: r.qty, 'aria-label': `明細${no}の数量`, placeholder: '数量', oninput: on('qty') }),
        h('input', { type: 'text', value: r.unit, maxlength: MAX_UNIT, 'aria-label': `明細${no}の単位`, placeholder: '単位', oninput: on('unit') }),
        h('input', { type: 'text', inputmode: 'numeric', value: r.price, 'aria-label': `明細${no}の単価`, placeholder: '単価', oninput: on('price') }),
        h(
          'select',
          { 'aria-label': `明細${no}の税率`, onchange: on('tax') },
          LINE_TAXES.map((t) => h('option', { value: t.code, text: t.short, selected: t.code === r.tax })),
        ),
      ),
      h('p', { class: 'inv-line-amount' }, '金額 ', h('span', { class: 'num', dataset: { amount: String(i) } })),
    );
  }

  function paintLines() {
    put(
      linesEl,
      rows.map(lineCard),
      rows.length < MAX_INVOICE_LINES
        ? h('button', {
            type: 'button',
            class: 'btn btn-small',
            text: '＋ 明細を追加',
            onclick: () => {
              const last = rows.at(-1);
              rows.push({ name: '', qty: '1', unit: '', price: '', tax: last?.tax ?? '10' });
              paintLines();
              linesEl.querySelectorAll('.inv-line input')[(rows.length - 1) * 4]?.focus();
            },
          })
        : null,
    );
    paintTotals();
  }

  function collect() {
    const { lines, errors } = parseRows();
    const record = {
      ...inv,
      number: number.value,
      issueDate: issueDate.value,
      customer: { name: customerName.value, honorific: honorific.value, subAccountId: customerSelect.value || null },
      subject: subject.value,
      priceMode,
      rounding,
      lines: lines.map(({ ok, ...l }) => (void ok, l)),
      note: note.value,
      ...(isInvoice ? { deliveryFrom: deliveryFrom.value, deliveryTo: deliveryTo.value, dueDate: due.value, revenueAccountId: revenueSelect.value } : { validUntil: due.value }),
    };
    return { record, errors };
  }

  async function save() {
    const { record, errors } = collect();
    // 読めない明細があるときは、その明細と合計の誤りは読み取りの誤りだけを出す
    const checked = validateInvoice(record, { accounts, subAccounts, original: editing });
    const list = errors.length ? [...checked.filter((e) => !/^明細|合計金額|税率ごとの合計/.test(e)), ...errors] : checked;
    if (list.length) {
      put(errorsEl, errorBox(list));
      errorsEl.scrollIntoView({ behavior: 'smooth', block: 'center' });
      return;
    }
    try {
      const saved = await app.db.saveInvoice(record);
      app.leaveGuard = null;
      showToast(`${label} No.${saved.number} を保存しました`);
      app.navigate(`#/invoices/${saved.id}`, { replace: true });
    } catch (e) {
      put(errorsEl, errorBox(e instanceof ValidationError ? [].concat(Object.values(e.errors)) : [errorText(e, '保存')]));
      errorsEl.scrollIntoView({ behavior: 'smooth', block: 'center' });
    }
  }

  app.leaveGuard = async () =>
    !dirty ||
    (await confirmDialog({
      title: '入力中の内容を破棄しますか？',
      buttons: [
        { label: '入力を続ける', value: false },
        { label: '破棄する', value: true, variant: 'danger' },
      ],
    }));

  const form = h(
    'form',
    { class: 'invoice-form', novalidate: true, oninput: () => (dirty = true), onsubmit: (e) => (e.preventDefault(), save()) },
    src && query.from ? h('p', { class: 'notice', text: `見積書 No.${src.number} の内容から請求書を作ります。取引年月日と金額を確かめて保存してください。` }) : null,
    src && query.copy ? h('p', { class: 'notice', text: `${INVOICE_KINDS[src.kind].label} No.${src.number} を複製しました。番号・日付を確かめて保存してください。` }) : null,
    errorsEl,
    h('div', { class: 'field-row' }, field(`${label}の番号`, number), field('発行日', issueDate)),
    isInvoice ? h('div', { class: 'field-row' }, field('取引年月日', deliveryFrom, { hint: '納品・作業をした日' }), field('（期間の終わり）', deliveryTo, { hint: '月まとめなど期間のとき' })) : null,
    field(isInvoice ? 'お支払期限' : '有効期限', due),
    h('h2', { class: 'section-title', text: '宛先' }),
    field('取引先', customerSelect),
    termsHint,
    h('div', { class: 'inv-customer-row' }, field('宛先（相手の名前）', customerName), field('敬称', honorific)),
    field('件名', subject),
    h('h2', { class: 'section-title', text: '明細' }),
    field(
      '単価の書き方',
      segmented({ name: '単価の書き方', options: PRICE_MODES.map((m) => ({ value: m.id, label: m.label })), value: priceMode, onChange: (v) => ((priceMode = v), (dirty = true), paintLines()) }),
    ),
    linesEl,
    totalsEl,
    field(
      '消費税額の端数処理',
      segmented({ name: '消費税額の端数処理', options: ROUNDINGS.map((r) => ({ value: r.id, label: r.label })), value: rounding, onChange: (v) => ((rounding = v), (dirty = true), paintTotals()) }),
      { hint: '1枚の請求書ごと・税率ごとに1回だけ端数を処理します' },
    ),
    isInvoice ? field('売上の科目', revenueSelect, { hint: '発行したときの仕訳の貸方の科目です（借方は売掛金）' }) : null,
    field('備考', note),
    h('button', { type: 'submit', class: 'btn btn-primary btn-block', text: '保存する' }),
  );

  paintTerms();
  paintLines();
  put(outlet, form);
  if (src && isInvoice && query.from) autoDue();
}
