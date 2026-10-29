// 事業者の設定（事業者名・消費税・会計期間・データの初期化）
import { h, put, field, segmented, showErrors, showToast, confirmDialog } from '../ui.js';
import { ENTITY_LABELS, TAX_STATUS_LABELS } from '../models.js';
import { validatePeriod, formatPeriod } from '../period.js';
import { ValidationError } from '../db.js';
import { errorText } from '../errors.js';

export async function render({ app, outlet }) {
  const { settings, period } = await app.load();
  let taxStatus = settings.taxStatus;
  const name = h('input', { id: 's-name', type: 'text', maxlength: 60, value: settings.businessName });
  const corp = settings.entityType === 'corporation';
  const start = h('input', { id: 's-start', type: 'date', value: period.startDate });
  const end = h('input', { id: 's-end', type: 'date', value: period.endDate });

  const form = h(
    'form',
    { novalidate: true, onsubmit: (e) => (e.preventDefault(), save()) },
    field('事業者名', name, { name: 'businessName' }),
    field('事業の形態', h('p', { class: 'readonly', text: ENTITY_LABELS[settings.entityType] }), { hint: '個人/法人は変更できません。変える場合はデータを初期化してください' }),
    field('消費税', segmented({ name: '消費税', options: Object.entries(TAX_STATUS_LABELS).map(([value, label]) => ({ value, label })), value: taxStatus, onChange: (v) => (taxStatus = v) })),
    corp
      ? h('div', { class: 'field-row' }, field('期首日', start, { name: 'startDate' }), field('期末日', end, { name: 'endDate' }))
      : field('会計期間', h('p', { class: 'readonly', text: formatPeriod(period) }), { hint: '個人事業主は暦年（1月1日〜12月31日）です' }),
    h('button', { type: 'submit', class: 'btn btn-primary btn-block', text: '保存する' }),
  );

  put(outlet, 
    form,
    h('h2', { class: 'section-title', text: 'データの保存場所' }),
    h(
      'div',
      { class: 'panel small' },
      h('p', { text: 'データはこの端末のブラウザの中（IndexedDB）にだけ保存され、外部には送信されません。' }),
      h('p', { text: 'iPhone では、Safari とホーム画面に追加したアプリで保存場所が別になります。ホーム画面のアプリで使ってください。' }),
      h('p', {}, '端末の故障や機種変更に備えて、定期的に', h('a', { href: '#/backup', text: 'バックアップ' }), 'してください。'),
    ),
    h('h2', { class: 'section-title', text: 'データの初期化' }),
    h('div', { class: 'panel small' }, h('p', { text: 'すべての仕訳・科目・設定を消して、初期設定からやり直します。' }), h('button', { type: 'button', class: 'btn btn-danger-text', text: 'すべてのデータを消す', onclick: reset })),
  );

  async function save() {
    const errors = {};
    if (!name.value.trim()) errors.businessName = '事業者名を入力してください';
    if (corp) Object.assign(errors, validatePeriod({ startDate: start.value, endDate: end.value }, 'corporation'));
    if (!showErrors(form, errors)) return;
    try {
      await app.db.updateSettings({ businessName: name.value.trim(), taxStatus });
      if (corp && (start.value !== period.startDate || end.value !== period.endDate)) await app.db.savePeriodDates(period.id, { startDate: start.value, endDate: end.value });
      showToast('保存しました');
      app.goBack('#/more');
    } catch (e) {
      if (e instanceof ValidationError) {
        if (Array.isArray(e.errors)) showToast(e.errors.join(' '));
        else showErrors(form, e.errors);
      } else showToast(errorText(e, '保存'));
    }
  }

  async function reset() {
    const ok = await confirmDialog({
      title: 'すべてのデータを消しますか？',
      message: '元に戻せません。先にバックアップを作成してください。',
      buttons: [
        { label: 'キャンセル', value: false },
        { label: 'バックアップへ', value: 'backup' },
        { label: '消す', value: true, variant: 'danger' },
      ],
    });
    if (ok === 'backup') return app.navigate('#/backup');
    if (ok !== true) return;
    await app.db.clearAll();
    showToast('データを消しました');
    app.navigate('#/setup', { replace: true });
  }
}
