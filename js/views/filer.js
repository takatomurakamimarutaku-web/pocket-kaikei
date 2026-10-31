// 申告書の提出者：納税地・フリガナ・代表者・法人番号・提出先の税務署など。申告書の印刷の頭書きに使う
import { h, put, field, showErrors, showToast } from '../ui.js';
import { ValidationError } from '../db.js';
import { errorText } from '../errors.js';
import { filerFields, cleanFiler, MAX_FILER_TEXT } from '../filer.js';

export async function render({ app, outlet, query }) {
  const { settings } = await app.load();
  const cur = cleanFiler(settings.filer || {});
  const corp = settings.entityType === 'corporation';
  const inputs = new Map();
  const back = typeof query.back === 'string' && query.back.startsWith('#/') ? query.back : '#/settings';

  const fields = filerFields(settings.entityType).map((f) => {
    const input = h('input', { id: `filer-${f.key}`, type: 'text', maxlength: f.max ?? MAX_FILER_TEXT, value: cur[f.key] || '', autocomplete: 'off', ...(f.inputmode ? { inputmode: f.inputmode } : {}) });
    inputs.set(f.key, input);
    return field(f.label, input, { name: f.key, hint: f.hint });
  });

  const form = h(
    'form',
    { novalidate: true, onsubmit: (e) => (e.preventDefault(), save()) },
    h('p', { class: 'muted small', text: `申告書を印刷するとき、上の欄（${corp ? '納税地・法人名のフリガナ・法人番号・代表者・提出先' : '住所・氏名・フリガナ・職業・提出先'}）に書く内容です。空欄の欄は印刷でも空欄になります。` }),
    ...fields,
    h('p', { class: 'notice small', text: corp ? '法人番号は公表されている番号なので保存できます。' : 'マイナンバー（個人番号）はこのアプリに保存しません。印刷した申告書の個人番号の欄に手で書いてください。' }),
    h('button', { type: 'submit', class: 'btn btn-primary btn-block', text: '保存する' }),
  );
  put(outlet, form);

  async function save() {
    const v = Object.fromEntries([...inputs].map(([k, el]) => [k, el.value]));
    try {
      await app.db.saveFiler(v);
      showToast('提出者の欄を保存しました');
      app.goBack(back);
    } catch (e) {
      if (e instanceof ValidationError && !Array.isArray(e.errors)) showErrors(form, e.errors);
      else showToast(errorText(e, '保存'));
    }
  }
}
