// 給与・賞与の入力（下書き）：支給・控除、源泉所得税と雇用保険料の自動計算、差引支給額
import { h, put, field, segmented, showToast, confirmDialog, errorBox } from '../ui.js';
import { formatYen } from '../money.js';
import { ValidationError } from '../db.js';
import { errorText } from '../errors.js';
import { todayString, isValidDate, addMonths } from '../period.js';
import {
  PAY_KINDS,
  TAX_COLUMNS,
  MAX_TITLE,
  MAX_NOTE,
  payrollDraft,
  copyPayroll,
  payrollTotals,
  applyAuto,
  autoIncomeTax,
  previousMonthSalary,
  validatePayroll,
  formatRate,
  defaultTitle,
} from '../payroll.js';
import { amountInput, readAmount, itemsEditor, toCount } from './pay-items.js';

const yen = (n) => `${formatYen(n)}円`;

/** 源泉所得税の計算方法の説明 */
function taxNote(p) {
  const r = autoIncomeTax(p);
  const year = Number(String(p.payDate).slice(0, 4));
  const t = payrollTotals(p);
  const deps = p.taxColumn === 'kou' ? `扶養${p.dependents}人` : '乙欄';
  if (r.reason === 'year') return `${year}年分の計算方法はまだ入っていません。税額表で求めて入力してください。`;
  if (r.reason === 'otsu') return p.kind === 'bonus' ? '乙欄で、前月の給与が無い（または賞与が前月の給与の10倍を超える）ときは、月額表の乙欄を使って計算します。税額表で求めて入力してください。' : '乙欄の給与は、税額表（月額表の乙欄）で求めて入力してください。';
  if (r.method === 'monthly') return `月額表の甲欄（電算機計算の特例）：社会保険料等を引いた後の ${yen(t.afterSocial)}・${deps} → ${yen(r.tax)}。税額表の金額と数十円違うことがあります（どちらで計算してもかまいません）。`;
  if (r.method === 'rate') return `賞与の算出率 ${(r.rate / 1000).toFixed(3)}%（前月の給与 ${yen(p.prevAfterSocial || 0)}・${deps}の欄）：${yen(t.afterSocial)} × ${(r.rate / 1000).toFixed(3)}% → ${yen(r.tax)}（1円未満切捨て）`;
  const prev = Math.max(p.prevAfterSocial || 0, 0);
  const a1 = Math.floor(t.afterSocial / r.divisor) + prev;
  return `前月の給与が無い（または賞与が前月の給与の10倍を超える）ため、月額表を使う方法です：（${yen(a1)}の税額 − ${yen(prev)}の税額）× ${r.divisor} → ${yen(r.tax)}。この金額は月額表の代わりに電算機計算の方法で求めた目安です。税額表（月額表の甲欄）で ${yen(a1)} と ${yen(prev)} の税額を調べて確かめてください（国税庁 No.2523）。`;
}

export async function render({ app, outlet, params, query }) {
  const [settings, employees, payrolls] = await Promise.all([app.db.getSettings(), app.db.listEmployees(), app.db.listPayrolls()]);
  const today = todayString();
  const editing = params.id ? payrolls.find((x) => x.id === params.id) : null;
  if (params.id && !editing) return put(outlet, h('p', { class: 'notice', text: '給与が見つかりません' }), h('a', { href: '#/payroll', class: 'btn', text: '一覧へ' }));
  if (editing?.journalId) return put(outlet, h('p', { class: 'notice', text: '仕訳を登録した給与は変更できません。直すときは給与明細の画面で「計上を取り消す」を押してください。' }), h('a', { href: `#/payroll/${editing.id}`, class: 'btn', text: '給与明細へ戻る' }));
  const copySrc = !editing && query.copy ? payrolls.find((x) => x.id === query.copy) : null;
  const selectable = employees.filter((e) => e.active || e.id === editing?.employeeId || e.id === copySrc?.employeeId);
  if (!editing && !selectable.length) return put(outlet, h('p', { class: 'notice', text: '在籍している従業員がいません。先に従業員を登録してください。' }), h('a', { href: '#/payroll/employees/new', class: 'btn btn-primary', text: '従業員を登録する' }));
  const others = (id) => payrolls.filter((x) => x.id !== id);
  const firstDate = isValidDate(query.date) ? query.date : today;

  let p;
  if (editing) p = structuredClone(editing);
  else if (copySrc) p = copyPayroll(copySrc, { payDate: addMonths(copySrc.payDate, 1), payrolls });
  else {
    const emp = selectable.find((e) => e.id === query.employee) || selectable[0];
    p = payrollDraft(emp, { kind: query.kind === 'bonus' ? 'bonus' : 'salary', payDate: firstDate, payrolls });
  }
  let dirty = Boolean(copySrc);
  const errorsEl = h('div', { class: 'errors-wrap' });
  const formWrap = h('div');

  app.leaveGuard = async () =>
    !dirty ||
    (await confirmDialog({
      title: '入力中の内容を破棄しますか？',
      buttons: [
        { label: '入力を続ける', value: false },
        { label: '破棄する', value: true, variant: 'danger' },
      ],
    }));

  /** 従業員・種類を変えたら、その人の登録内容から作り直す */
  function restart(employeeId, kind) {
    const emp = employees.find((e) => e.id === employeeId);
    p = payrollDraft(emp, { kind, payDate: isValidDate(p.payDate) ? p.payDate : today, payrolls: others(p.id) });
    dirty = true;
    build();
  }

  function build() {
    const isBonus = p.kind === 'bonus';
    let column = p.taxColumn;
    const employeeSelect = h(
      'select',
      { id: 'pay-employee', disabled: Boolean(editing), onchange: (e) => restart(e.target.value, p.kind) },
      selectable.map((e) => h('option', { value: e.id, text: e.active ? e.name : `${e.name}（在籍していない）`, selected: e.id === p.employeeId })),
    );
    const payDate = h('input', { id: 'pay-date', type: 'date', value: p.payDate });
    const title = h('input', { id: 'pay-title', type: 'text', maxlength: MAX_TITLE, value: p.title, placeholder: isBonus ? '例：夏季賞与' : '例：10月分' });
    let titleAuto = !editing && p.title === defaultTitle(p.kind, p.payDate);
    const earnings = itemsEditor({ label: '支給', items: p.earnings, allowNegative: true, onChange: recalc });
    const deductions = itemsEditor({ label: 'その他の控除', items: p.deductions, onChange: recalc });
    const commute = amountInput('pay-commute', p.commute);
    const health = amountInput('pay-health', p.health);
    const pension = amountInput('pay-pension', p.pension);
    const employment = amountInput('pay-employment', p.employment);
    const employmentAuto = h('input', { id: 'pay-employment-auto', type: 'checkbox', checked: p.employmentAuto, disabled: p.employmentRate == null });
    const incomeTax = amountInput('pay-income-tax', p.incomeTax);
    const incomeTaxAuto = h('input', { id: 'pay-income-tax-auto', type: 'checkbox', checked: p.incomeTaxAuto });
    const residentTax = amountInput('pay-resident', p.residentTax);
    const dependents = h('input', { id: 'pay-dependents', type: 'text', inputmode: 'numeric', autocomplete: 'off', maxlength: 2, value: String(p.dependents ?? 0), 'aria-label': '扶養親族等の数' });
    const prev = isBonus ? amountInput('pay-prev', p.prevAfterSocial) : null;
    const prevHint = h('p', { class: 'field-hint' });
    const longPeriod = isBonus ? h('input', { id: 'pay-long', type: 'checkbox', checked: !!p.longPeriod }) : null;
    const note = h('textarea', { id: 'pay-note', rows: 2, maxlength: MAX_NOTE, value: p.note || '' });
    const taxHint = h('p', { class: 'field-hint pay-tax-note', 'aria-live': 'polite' });
    const totalsEl = h('dl', { class: 'pay-totals', 'aria-live': 'polite' });
    const depWrap = h('span', { class: 'pay-dep' }, dependents, h('span', { text: '人' }));

    /** 画面の値で給与を作る（読めない金額は errors に入れる） */
    function read(errors = []) {
      return {
        ...p,
        employeeId: employeeSelect.value,
        payDate: payDate.value,
        title: title.value,
        taxColumn: column,
        dependents: column === 'kou' ? toCount(dependents.value) : 0,
        earnings: earnings.read(errors),
        commute: readAmount(commute, '通勤手当', errors),
        health: readAmount(health, '健康保険料', errors),
        pension: readAmount(pension, '厚生年金保険料', errors),
        employment: readAmount(employment, '雇用保険料', errors),
        employmentAuto: employmentAuto.checked && !employmentAuto.disabled,
        incomeTax: readAmount(incomeTax, '源泉所得税', errors),
        incomeTaxAuto: incomeTaxAuto.checked && !incomeTaxAuto.disabled,
        residentTax: readAmount(residentTax, '住民税', errors),
        deductions: deductions.read(errors),
        ...(isBonus ? { prevAfterSocial: readAmount(prev, '前月の給与', errors), longPeriod: longPeriod.checked } : {}),
        note: note.value,
      };
    }

    function recalc() {
      dirty = true;
      const cur = applyAuto(read([]));
      if (cur.employmentAuto) employment.value = String(cur.employment);
      employment.readOnly = cur.employmentAuto;
      const r = autoIncomeTax(cur);
      incomeTaxAuto.disabled = r.tax == null;
      if (r.tax == null) incomeTaxAuto.checked = false;
      if (incomeTaxAuto.checked) incomeTax.value = String(cur.incomeTax);
      incomeTax.readOnly = incomeTaxAuto.checked;
      taxHint.textContent = isValidDate(cur.payDate) ? taxNote(cur) : '支給日を入れると計算します';
      depWrap.hidden = column !== 'kou';
      if (isBonus) {
        const pm = isValidDate(cur.payDate) ? previousMonthSalary(others(p.id), cur.employeeId, cur.payDate) : null;
        prevHint.textContent = pm ? `${Number(pm.month.slice(5))}月に支払った給与（賞与を除く）の社会保険料等を引いた後の金額。${pm.count ? `このアプリの記録では ${yen(pm.amount)}` : 'このアプリに記録がありません（前月に給与が無ければ0）'}` : '';
      }
      const t = payrollTotals(cur);
      const row = (label, v, cls = '') => h('div', { class: cls }, h('dt', { text: label }), h('dd', { class: `num ${v < 0 ? 'neg' : ''}`, text: yen(v) }));
      put(totalsEl, row('総支給額', t.gross), row('社会保険料等', t.social), row('社会保険料等を引いた後', t.afterSocial, 'muted'), row('控除合計', t.deductions), row('差引支給額', t.net, 'pay-net-row'));
    }

    payDate.addEventListener('change', () => {
      if (titleAuto && isValidDate(payDate.value)) title.value = defaultTitle(p.kind, payDate.value);
      if (isBonus && isValidDate(payDate.value)) prev.value = String(previousMonthSalary(others(p.id), employeeSelect.value, payDate.value).amount || '');
      recalc();
    });
    title.addEventListener('input', () => (titleAuto = false));
    for (const el of [commute, health, pension, employment, incomeTax, residentTax, dependents, prev, longPeriod, employmentAuto, incomeTaxAuto].filter(Boolean)) {
      el.addEventListener(el.type === 'checkbox' ? 'change' : 'input', recalc);
    }

    async function save() {
      const errors = [];
      const record = read(errors);
      if (!errors.length) errors.push(...validatePayroll(record, { employees }));
      if (errors.length) {
        put(errorsEl, errorBox(errors));
        errorsEl.scrollIntoView({ behavior: 'smooth', block: 'center' });
        return;
      }
      try {
        const saved = await app.db.savePayroll(record);
        app.leaveGuard = null;
        showToast(`${saved.name}さんの${PAY_KINDS[saved.kind]}を保存しました`);
        app.navigate(`#/payroll/${saved.id}`, { replace: true });
      } catch (e) {
        put(errorsEl, errorBox(e instanceof ValidationError ? [].concat(Object.values(e.errors)) : [errorText(e, '保存')]));
        errorsEl.scrollIntoView({ behavior: 'smooth', block: 'center' });
      }
    }

    put(
      formWrap,
      h(
        'form',
        { class: 'pay-form', novalidate: true, oninput: () => (dirty = true), onsubmit: (e) => (e.preventDefault(), save()) },
        errorsEl,
        field('従業員', employeeSelect, { hint: editing ? '従業員は変えられません' : '選ぶと、その人の登録内容（支給・控除）を入れ直します' }),
        editing ? null : field('種類', segmented({ name: '種類', options: Object.entries(PAY_KINDS).map(([value, label]) => ({ value, label })), value: p.kind, onChange: (v) => restart(employeeSelect.value, v) })),
        h('div', { class: 'field-row' }, field('支給日', payDate), field('題名', title)),
        h('h2', { class: 'section-title', text: '支給' }),
        h('div', { class: 'field' }, earnings.el, h('p', { class: 'field-hint', text: isBonus ? '賞与の金額' : '基本給・手当など課税の支給。欠勤控除はマイナスで入れます' })),
        field('通勤手当（非課税）', commute),
        isBonus ? h('div', { class: 'field' }, h('label', { class: 'field-label', for: 'pay-prev', text: '前月の給与（社会保険料等を引いた後）' }), prev, prevHint) : null,
        isBonus ? h('label', { class: 'check' }, longPeriod, h('span', { text: '賞与の計算期間が6か月を超える' })) : null,
        h('h2', { class: 'section-title', text: '控除' }),
        h('div', { class: 'field-row' }, field('健康保険料', health), field('厚生年金保険料', pension)),
        h(
          'div',
          { class: 'field' },
          h('label', { class: 'field-label', for: 'pay-employment', text: '雇用保険料' }),
          employment,
          h('label', { class: 'check small' }, employmentAuto, h('span', { text: p.employmentRate != null ? `支給額×千分の${formatRate(p.employmentRate)}で計算する` : '雇用保険料率が登録されていません（手で入力）' })),
        ),
        h(
          'div',
          { class: 'field' },
          h('label', { class: 'field-label', for: 'pay-income-tax', text: '源泉所得税' }),
          incomeTax,
          h('label', { class: 'check small' }, incomeTaxAuto, h('span', { text: '自動で計算する' })),
          h('div', { class: 'pay-column' }, segmented({ name: '税額表の欄', options: TAX_COLUMNS.map((c) => ({ value: c.id, label: c.label })), value: column, onChange: (v) => ((column = v), recalc()) }), depWrap),
          taxHint,
        ),
        field('住民税', residentTax),
        h('div', { class: 'field' }, h('p', { class: 'field-label', text: 'その他の控除' }), deductions.el),
        h('h2', { class: 'section-title', text: '合計' }),
        totalsEl,
        field('メモ', note),
        h('button', { type: 'submit', class: 'btn btn-primary btn-block', text: '保存する' }),
      ),
    );
    recalc();
  }

  build();
  dirty = Boolean(copySrc);
  put(outlet, formWrap);
}
