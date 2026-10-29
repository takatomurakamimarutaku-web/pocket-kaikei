// 請求書の設定：発行元の情報（名前・登録番号・住所・連絡先）・振込先・端数処理・税抜/税込・備考の初期値
import { h, put, field, segmented, showToast, errorBox } from '../ui.js';
import { ValidationError } from '../db.js';
import { errorText } from '../errors.js';
import { ROUNDINGS, PRICE_MODES, MAX_NAME, MAX_ADDRESS, MAX_NOTE, normalizeRegistrationNo, isRegistrationNo } from '../invoices.js';

export async function render({ app, outlet }) {
  const { settings, period } = await app.load();
  const cur = settings.invoice || {};
  let rounding = cur.rounding || 'floor';
  let priceMode = cur.priceMode || 'exclusive';
  const input = (id, value, attrs = {}) => h('input', { id, type: 'text', value: value || '', ...attrs });
  const issuerName = input('inv-issuer', cur.issuerName, { maxlength: MAX_NAME, placeholder: settings.businessName });
  const regNo = input('inv-reg', cur.registrationNo, { maxlength: 20, inputmode: 'text', autocomplete: 'off', placeholder: '例：T1234567890123' });
  const address = input('inv-address', cur.address, { maxlength: MAX_ADDRESS });
  const phone = input('inv-phone', cur.phone, { maxlength: MAX_ADDRESS, inputmode: 'tel' });
  const email = input('inv-email', cur.email, { maxlength: MAX_ADDRESS, inputmode: 'email' });
  const bank = h('textarea', { id: 'inv-bank', rows: 3, maxlength: MAX_NOTE, placeholder: '例：みらい銀行 本店 普通 1234567 ポケット タロウ', value: cur.bank || '' });
  const note = h('textarea', { id: 'inv-note', rows: 2, maxlength: MAX_NOTE, placeholder: '例：振込手数料はご負担ください', value: cur.note || '' });
  const errors = h('div', { class: 'errors-wrap' });
  const regHint = h('p', { class: 'field-hint' });
  const exemptWarn = h('p', { class: 'notice small', hidden: true });

  function paintReg() {
    const v = normalizeRegistrationNo(regNo.value);
    regHint.textContent = !v
      ? '登録番号が無いと、適格請求書（インボイス）にはなりません。登録を受けていない場合は空欄のままにしてください（登録番号の欄の無い請求書になります）'
      : isRegistrationNo(v)
        ? `登録番号：${v}。国税庁の「適格請求書発行事業者公表サイト」で、登録されている番号か確かめてください`
        : '「T」と13桁の数字で入力してください';
    exemptWarn.hidden = !(v && settings.taxStatus === 'exempt');
    exemptWarn.textContent = '事業者の設定が「免税事業者」になっています。適格請求書発行事業者の登録を受けると課税事業者になるため、登録を受けている場合は事業者の設定の消費税を「課税事業者」にしてください。';
  }
  regNo.addEventListener('input', paintReg);

  // 消費税の申告で積上げ計算にしているとき、端数処理を合わせないと請求書の消費税額と申告の計算がずれる
  const tr = period?.taxReturn;
  const stackedNote = h('p', { class: 'field-hint' });
  function paintRounding() {
    const label = (id) => ROUNDINGS.find((r) => r.id === id)?.label ?? id;
    stackedNote.textContent =
      tr?.salesCalc === 'stacked' && tr.salesRounding && tr.salesRounding !== rounding
        ? `消費税の申告計算で売上を積上げ計算（端数は${label(tr.salesRounding)}）にしています。請求書の端数処理も${label(tr.salesRounding)}にそろえてください`
        : '消費税額の1円未満の端数は、1枚の請求書ごと・税率ごとに1回だけ処理します（国税庁 インボイスQ&A 問57）';
  }

  const form = h(
    'form',
    { novalidate: true, onsubmit: (e) => (e.preventDefault(), save()) },
    errors,
    field('発行元の名前', issuerName, { hint: `空欄なら事業者名（${settings.businessName}）を使います。屋号や会社名などを入れられます` }),
    field('登録番号', regNo),
    regHint,
    exemptWarn,
    field('住所', address),
    h('div', { class: 'field-row' }, field('電話番号', phone), field('メールアドレス', email)),
    field('振込先', bank, { hint: '請求書の下に出します（見積書には出しません）' }),
    field('備考の初期値', note, { hint: '新しく作る請求書・見積書の備考に最初から入れます' }),
    field(
      '単価の書き方（初期値）',
      segmented({ name: '単価の書き方', options: PRICE_MODES.map((m) => ({ value: m.id, label: m.label })), value: priceMode, onChange: (v) => (priceMode = v) }),
      { hint: '税抜：単価・金額を税抜で書き、税率ごとの消費税を足します。税込：税込で書き、税率ごとの消費税額を内訳として出します。請求書ごとにも変えられます' },
    ),
    field(
      '消費税額の端数処理',
      segmented({ name: '消費税額の端数処理', options: ROUNDINGS.map((r) => ({ value: r.id, label: r.label })), value: rounding, onChange: (v) => ((rounding = v), paintRounding()) }),
    ),
    stackedNote,
    h('button', { type: 'submit', class: 'btn btn-primary btn-block', text: '保存する' }),
  );

  async function save() {
    try {
      await app.db.saveInvoiceSettings({ issuerName: issuerName.value, registrationNo: regNo.value, address: address.value, phone: phone.value, email: email.value, bank: bank.value, note: note.value, rounding, priceMode });
      showToast('請求書の設定を保存しました');
      app.goBack('#/invoices');
    } catch (e) {
      put(errors, errorBox(e instanceof ValidationError ? [].concat(Object.values(e.errors)) : [errorText(e, '保存')]));
      errors.scrollIntoView({ behavior: 'smooth', block: 'center' });
    }
  }

  paintReg();
  paintRounding();
  put(
    outlet,
    h('div', { class: 'panel small' }, h('p', { text: '請求書・見積書に出す発行元の情報です。適格請求書（インボイス）には、発行元の名前と登録番号が必要です。' })),
    form,
  );
}
