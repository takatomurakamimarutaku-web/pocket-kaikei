// 従業員の登録・編集：区分・税額表の欄・扶養親族等の数、毎月の支給と控除の初期値
import { h, put, field, segmented, showToast, confirmDialog, errorBox } from '../ui.js';
import { ValidationError } from '../db.js';
import { errorText } from '../errors.js';
import { EMPLOYEE_KINDS, TAX_COLUMNS, MAX_NAME, MAX_NOTE, MAX_ADDRESS, MAX_CITY, RESIDENT_COLLECTIONS, employeeDraft, validateEmployee, parseRate, formatRate } from '../payroll.js';
import { amountInput, readAmount, itemsEditor, toCount } from './pay-items.js';

export async function render({ app, outlet, params }) {
  const settings = await app.db.getSettings();
  const editing = params.id ? await app.db.getEmployee(params.id) : null;
  if (params.id && !editing) return put(outlet, h('p', { class: 'notice', text: '従業員が見つかりません' }), h('a', { href: '#/payroll/employees', class: 'btn', text: '一覧へ' }));
  if (editing) app.setTitle(editing.name);
  const e = editing ? structuredClone(editing) : employeeDraft();
  let kind = e.kind;
  let taxColumn = e.taxColumn;
  let collection = e.residentCollection || 'special';
  let dirty = false;
  const markDirty = () => (dirty = true);
  const errorsEl = h('div', { class: 'errors-wrap' });
  const name = h('input', { id: 'emp-name', type: 'text', value: e.name, maxlength: MAX_NAME, autocomplete: 'off', placeholder: '例：山田 花子' });
  const kana = h('input', { id: 'emp-kana', type: 'text', value: e.kana, maxlength: MAX_NAME, autocomplete: 'off', placeholder: '例：やまだ はなこ' });
  const dependents = h('input', { id: 'emp-dependents', type: 'text', inputmode: 'numeric', autocomplete: 'off', maxlength: 2, value: String(e.dependents ?? 0) });
  const depField = field('扶養親族等の数', dependents, { hint: '扶養控除等申告書に書かれた、源泉控除対象配偶者と控除対象扶養親族の数（本人・家族が障害者などのときは1人ずつ足す）' });
  const earnings = itemsEditor({ label: '支給', items: e.earnings, allowNegative: true, onChange: markDirty });
  const deductions = itemsEditor({ label: 'その他の控除', items: e.deductions, onChange: markDirty });
  const commute = amountInput('emp-commute', e.commute);
  const health = amountInput('emp-health', e.health);
  const pension = amountInput('emp-pension', e.pension);
  const residentTax = amountInput('emp-resident', e.residentTax);
  const rate = h('input', { id: 'emp-rate', type: 'text', inputmode: 'decimal', autocomplete: 'off', value: formatRate(e.employmentRate), placeholder: '空欄＝加入していない' });
  const note = h('textarea', { id: 'emp-note', rows: 2, maxlength: MAX_NOTE, value: e.note || '' });
  const activeBox = h('input', { id: 'emp-active', type: 'checkbox', checked: e.active });
  const address = h('input', { id: 'emp-address', type: 'text', value: e.address || '', maxlength: MAX_ADDRESS, autocomplete: 'off', placeholder: '例：東京都千代田区霞が関3-1-1' });
  const birthDate = h('input', { id: 'emp-birth', type: 'date', value: e.birthDate || '' });
  const joinedOn = h('input', { id: 'emp-joined', type: 'date', value: e.joinedOn || '' });
  const retiredOn = h('input', { id: 'emp-retired', type: 'date', value: e.retiredOn || '' });
  const city = h('input', { id: 'emp-city', type: 'text', value: e.residentCity || '', maxlength: MAX_CITY, autocomplete: 'off', placeholder: '例：千代田区' });
  const foreigner = h('input', { id: 'emp-foreigner', type: 'checkbox', checked: e.foreigner === true });
  const deceased = h('input', { id: 'emp-deceased', type: 'checkbox', checked: e.deceased === true });
  const paintColumn = () => (depField.hidden = taxColumn !== 'kou');

  async function save() {
    const parseErrors = [];
    const r = parseRate(rate.value);
    if (Number.isNaN(r)) parseErrors.push('雇用保険料率は千分率の数字で入力してください（例：千分の5.5なら 5.5）');
    const record = {
      ...e,
      name: name.value,
      kana: kana.value,
      kind,
      taxColumn,
      dependents: taxColumn === 'kou' ? toCount(dependents.value) : 0,
      earnings: earnings.read(parseErrors),
      commute: readAmount(commute, '通勤手当', parseErrors),
      health: readAmount(health, '健康保険料', parseErrors),
      pension: readAmount(pension, '厚生年金保険料', parseErrors),
      employmentRate: Number.isNaN(r) ? null : r,
      residentTax: readAmount(residentTax, '住民税', parseErrors),
      deductions: deductions.read(parseErrors),
      note: note.value,
      active: activeBox.checked,
      address: address.value,
      birthDate: birthDate.value,
      joinedOn: joinedOn.value,
      retiredOn: retiredOn.value,
      residentCity: city.value,
      residentCollection: collection,
      foreigner: foreigner.checked,
      deceased: deceased.checked,
    };
    const errors = [...parseErrors, ...Object.values(validateEmployee(record, { entityType: settings.entityType }))];
    if (errors.length) {
      put(errorsEl, errorBox(errors.flatMap((m) => m.split('\n'))));
      errorsEl.scrollIntoView({ behavior: 'smooth', block: 'center' });
      return;
    }
    try {
      const saved = await app.db.saveEmployee(record);
      app.leaveGuard = null;
      showToast(`${saved.name}さんを保存しました`);
      app.goBack('#/payroll/employees');
    } catch (err) {
      put(errorsEl, errorBox(err instanceof ValidationError ? [].concat(Object.values(err.errors)) : [errorText(err, '保存')]));
      errorsEl.scrollIntoView({ behavior: 'smooth', block: 'center' });
    }
  }

  async function remove() {
    const ok = await confirmDialog({
      title: `${editing.name}さんを削除しますか？`,
      message: '給与の記録がある人は削除できません（辞めた人は「在籍」を外してください）。',
      buttons: [
        { label: 'キャンセル', value: false },
        { label: '削除する', value: true, variant: 'danger' },
      ],
    });
    if (ok !== true) return;
    try {
      await app.db.deleteEmployee(editing.id);
      app.leaveGuard = null;
      showToast('削除しました');
      app.navigate('#/payroll/employees', { replace: true });
    } catch (err) {
      put(errorsEl, errorBox(err instanceof ValidationError ? [].concat(Object.values(err.errors)) : [errorText(err, '削除')]));
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

  const kinds = EMPLOYEE_KINDS.filter((k) => k.entity === 'both' || k.entity === settings.entityType || k.id === e.kind);
  paintColumn();
  put(
    outlet,
    h(
      'form',
      { class: 'pay-form', novalidate: true, oninput: markDirty, onsubmit: (ev) => (ev.preventDefault(), save()) },
      errorsEl,
      field('名前', name),
      field('ふりがな', kana, { hint: '源泉徴収票などに使います（任意）' }),
      field('区分', segmented({ name: '区分', options: kinds.map((k) => ({ value: k.id, label: k.label })), value: kind, onChange: (v) => ((kind = v), markDirty()) }), {
        hint: settings.entityType === 'individual' ? '青色事業専従者：青色事業専従者給与に関する届出書を出した家族。給与は専従者給与の科目に入ります' : '役員の給与は役員報酬の科目に入ります',
      }),
      field('税額表の欄', segmented({ name: '税額表の欄', options: TAX_COLUMNS.map((c) => ({ value: c.id, label: c.label })), value: taxColumn, onChange: (v) => ((taxColumn = v), paintColumn(), markDirty()) }), { hint: '甲欄：扶養控除等申告書を出している人。乙欄：出していない人（ほかの勤め先に出している人など）' }),
      depField,
      h('h2', { class: 'section-title', text: '毎月の支給' }),
      h('div', { class: 'field' }, h('p', { class: 'field-label', text: '支給（課税）' }), earnings.el, h('p', { class: 'field-hint', text: '基本給・役職手当・残業手当など。欠勤控除はマイナスで入れます' })),
      field('通勤手当（非課税）', commute, { hint: '非課税の限度額までの金額。限度額を超える分は「支給」に入れてください' }),
      h('h2', { class: 'section-title', text: '毎月の控除' }),
      field('健康保険料（介護保険料を含む）', health, { hint: '本人負担分。協会けんぽ・健康保険組合の保険料額表の金額' }),
      field('厚生年金保険料', pension, { hint: '本人負担分' }),
      field('雇用保険料率（千分率）', rate, { hint: '本人負担の料率。例：千分の5.5なら 5.5。支給額（通勤手当を含む）に掛けて計算します（1円未満は50銭以下切捨て）。役員など加入していない人は空欄' }),
      field('住民税（特別徴収）', residentTax, { hint: '市区町村から届く「特別徴収税額の決定通知書」の毎月の金額（6月分は金額が違うことがあるので、給与の入力で直してください）' }),
      h('div', { class: 'field' }, h('p', { class: 'field-label', text: 'その他の控除' }), deductions.el, h('p', { class: 'field-hint', text: '社宅の家賃・財形貯蓄など。預り金に入ります' })),
      h('h2', { class: 'section-title', text: '源泉徴収票・給与支払報告書' }),
      field('住所', address, { hint: '源泉徴収票の「住所又は居所」（任意。マイナンバーは保存しません）' }),
      field('生年月日', birthDate, { hint: '源泉徴収票の受給者生年月日・未成年者の欄に使います' }),
      h('div', { class: 'field-row' }, field('就職した日', joinedOn), field('退職した日', retiredOn)),
      h('p', { class: 'field-hint emp-hint', text: 'その年に就職・退職した人は、源泉徴収票の「中途就・退職」の欄に載ります。年の途中で退職した人で、その年の支払金額が30万円以下なら、給与支払報告書（源泉徴収票）の提出を省略できます' }),
      field('給与支払報告書の提出先（市区町村）', city, { hint: '翌年1月1日現在の住所の市区町村（年の途中で退職した人は、退職した時の住所の市区町村）' }),
      field('住民税の徴収', segmented({ name: '住民税の徴収', options: RESIDENT_COLLECTIONS.map((c) => ({ value: c.id, label: c.label })), value: collection, onChange: (v) => ((collection = v), markDirty()) }), { hint: '特別徴収：給与から天引きして納める。普通徴収：本人が納める（給与支払報告書の市区町村ごとの人数に使います）' }),
      h('label', { class: 'check' }, foreigner, h('span', { text: '外国人（日本に住んでいる外国籍の人）' })),
      h('label', { class: 'check' }, deceased, h('span', { text: '死亡により退職した' })),
      field('メモ', note),
      h('label', { class: 'check' }, activeBox, h('span', { text: '在籍している（まとめて作る給与の対象にする）' })),
      h('button', { type: 'submit', class: 'btn btn-primary btn-block', text: '保存する' }),
      editing ? h('button', { type: 'button', class: 'btn btn-danger-text btn-block', text: '削除', onclick: remove }) : null,
    ),
  );
}
