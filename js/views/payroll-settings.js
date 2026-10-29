// 給与の設定：給与・通勤手当・預り金・支払口座などの科目、預り金の補助科目、源泉所得税の納期の特例、源泉徴収票の支払者
import { h, put, field, showToast, errorBox } from '../ui.js';
import { ValidationError } from '../db.js';
import { errorText } from '../errors.js';
import { compareAccounts } from '../accounts.js';
import { PAYROLL_ACCOUNT_FIELDS, DEPOSIT_KINDS, PAYER_FIELDS, resolvePayrollSettings } from '../payroll.js';
import { payerInfo } from '../withholding-slip.js';

const HINTS = {
  salary: '従業員の給与（課税の支給額）',
  bonus: '従業員の賞与',
  officer: '役員の給与',
  officerBonus: '役員の賞与（事前確定届出給与など）',
  family: '青色事業専従者の給与',
  commute: '非課税の通勤手当（税区分は科目の税区分。通常は課税仕入れ10%）',
  deposit: '天引きした社会保険料・雇用保険料・源泉所得税・住民税などを入れる科目',
  payment: '差引支給額を払う口座（給与の入力では変えられません）',
  welfare: '社会保険料を納めるときの会社負担分（法定福利費など）',
};

export async function render({ app, outlet }) {
  const [settings, accounts, subAccounts] = await Promise.all([app.db.getSettings(), app.db.listAccounts(), app.db.listSubAccounts()]);
  const cfg = resolvePayrollSettings(settings.payroll, accounts);
  const sorted = [...accounts].sort(compareAccounts);
  const errorsEl = h('div', { class: 'errors-wrap' });
  const fields = PAYROLL_ACCOUNT_FIELDS.filter((f) => !f.entity || f.entity === settings.entityType);
  const selects = {};
  for (const f of fields) {
    const list = sorted.filter((a) => f.groups.includes(a.group) && (f.key !== 'payment' || a.role === 'cash' || a.role === 'deposit') && (a.active || a.id === cfg.accounts[f.key]));
    selects[f.key] = h(
      'select',
      { id: `payset-${f.key}` },
      h('option', { value: '', text: '選んでください' }),
      list.map((a) => h('option', { value: a.id, text: `${a.code} ${a.name}${a.active ? '' : '（無効）'}`, selected: a.id === cfg.accounts[f.key] })),
    );
  }
  const subSelects = Object.fromEntries(DEPOSIT_KINDS.map((k) => [k.key, h('select', { id: `payset-sub-${k.key}`, 'aria-label': `${k.label}の補助科目` })]));
  const subsHint = h('p', { class: 'field-hint' });
  function paintSubs() {
    const depositId = selects.deposit.value;
    const subs = subAccounts.filter((s) => s.accountId === depositId && (s.active || Object.values(cfg.subs).includes(s.id))).sort((a, b) => (a.sortOrder ?? 0) - (b.sortOrder ?? 0));
    for (const k of DEPOSIT_KINDS) {
      const cur = subSelects[k.key].value || cfg.subs[k.key];
      put(subSelects[k.key], h('option', { value: '', text: '補助科目なし' }), ...subs.map((s) => h('option', { value: s.id, text: s.name, selected: s.id === cur })));
    }
    subsHint.textContent = subs.length ? '預り金の補助科目を選ぶと、補助元帳で控除の種類ごとの残高（納め忘れ）を確かめられます' : '預り金に補助科目（例：源泉所得税・住民税・社会保険料）を作ると、控除の種類ごとに分けて記帳できます（勘定科目の画面）';
  }
  selects.deposit.addEventListener('change', paintSubs);
  paintSubs();
  const special = h('input', { id: 'payset-special', type: 'checkbox', checked: cfg.special });
  // 支払者：空欄なら請求書の発行元・事業者名を使う（入力欄の薄い字で見せる）
  const fallback = payerInfo({ ...settings, payroll: undefined });
  const payerInputs = Object.fromEntries(PAYER_FIELDS.map((f) => [f.key, h('input', { id: `payset-payer-${f.key}`, type: f.key === 'phone' ? 'tel' : 'text', value: cfg.payer[f.key], maxlength: f.max, autocomplete: 'off', placeholder: fallback[f.key] || '' })]));

  async function save() {
    try {
      await app.db.savePayrollSettings({
        accounts: Object.fromEntries(fields.map((f) => [f.key, selects[f.key].value])),
        subs: Object.fromEntries(DEPOSIT_KINDS.map((k) => [k.key, subSelects[k.key].value || null])),
        special: special.checked,
        payer: Object.fromEntries(PAYER_FIELDS.map((f) => [f.key, payerInputs[f.key].value])),
      });
      showToast('給与の設定を保存しました');
      app.goBack('#/payroll');
    } catch (e) {
      put(errorsEl, errorBox(e instanceof ValidationError ? [].concat(Object.values(e.errors)) : [errorText(e, '保存')]));
      errorsEl.scrollIntoView({ behavior: 'smooth', block: 'center' });
    }
  }

  put(
    outlet,
    h(
      'form',
      { class: 'pay-form', novalidate: true, onsubmit: (e) => (e.preventDefault(), save()) },
      errorsEl,
      h('h2', { class: 'section-title', text: '源泉所得税の納付' }),
      h('label', { class: 'check' }, special, h('span', { text: '納期の特例の承認を受けている（1〜6月分を7月10日、7〜12月分を翌年1月20日にまとめて納める）' })),
      h('p', { class: 'field-hint', text: '給与の支払を受ける人が常に10人未満で、税務署に「源泉所得税の納期の特例の承認に関する申請書」を出して承認を受けた場合です（国税庁 No.2505）。' }),
      h('h2', { class: 'section-title', text: '仕訳の科目' }),
      ...fields.map((f) => field(f.label, selects[f.key], { hint: HINTS[f.key] })),
      h('h2', { class: 'section-title', text: '預り金の補助科目' }),
      subsHint,
      ...DEPOSIT_KINDS.map((k) => field(k.label, subSelects[k.key])),
      h('h2', { class: 'section-title', text: '源泉徴収票の支払者' }),
      h('p', { class: 'field-hint', text: '源泉徴収票・給与支払報告書の「支払者」の欄に載ります。空欄なら、請求書の設定の発行元・事業者名を使います。' }),
      field('氏名又は名称', payerInputs.name),
      field('住所（居所）又は所在地', payerInputs.address),
      field('電話番号', payerInputs.phone),
      h('button', { type: 'submit', class: 'btn btn-primary btn-block', text: '保存する' }),
    ),
  );
}
