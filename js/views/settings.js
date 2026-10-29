// 事業者の設定（事業者名・消費税・会計期間・データの初期化）
import { h, put, field, segmented, showErrors, showToast, confirmDialog } from '../ui.js';
import { ENTITY_LABELS, TAX_STATUS_LABELS } from '../models.js';
import { validatePeriod, formatPeriod } from '../period.js';
import { ValidationError } from '../db.js';
import { errorText } from '../errors.js';
import { REAL_ESTATE_MODES } from '../real-estate.js';

export async function render({ app, outlet }) {
  const { settings, period } = await app.load();
  let taxStatus = settings.taxStatus;
  let taxUseSplit = Boolean(settings.taxUseSplit);
  let manufacturing = Boolean(settings.manufacturing);
  let realEstate = REAL_ESTATE_MODES.includes(settings.realEstate) ? settings.realEstate : 'none';
  let filing = settings.filing === 'white' ? 'white' : 'blue';
  const name = h('input', { id: 's-name', type: 'text', maxlength: 60, value: settings.businessName });
  const corp = settings.entityType === 'corporation';
  const start = h('input', { id: 's-start', type: 'date', value: period.startDate });
  const end = h('input', { id: 's-end', type: 'date', value: period.endDate });

  const form = h(
    'form',
    { novalidate: true, onsubmit: (e) => (e.preventDefault(), save()) },
    field('事業者名', name, { name: 'businessName' }),
    field('事業の形態', h('p', { class: 'readonly', text: ENTITY_LABELS[settings.entityType] }), { hint: '個人/法人は変更できません。変える場合はデータを初期化してください' }),
    corp
      ? null
      : field(
          '申告の種類',
          segmented({ name: '申告の種類', options: [{ value: 'blue', label: '青色申告' }, { value: 'white', label: '白色申告' }], value: filing, onChange: (v) => (filing = v) }),
          { hint: '青色申告の承認を受けていない人は白色申告です。白色申告にすると、帳票は青色申告決算書の代わりに収支内訳書（専従者控除の計算つき）になります' },
        ),
    field('消費税', segmented({ name: '消費税', options: Object.entries(TAX_STATUS_LABELS).map(([value, label]) => ({ value, label })), value: taxStatus, onChange: (v) => (taxStatus = v) })),
    field(
      '仕入の用途区分',
      segmented({ name: '仕入の用途区分', options: [{ value: 'off', label: '使わない' }, { value: 'on', label: '使う' }], value: taxUseSplit ? 'on' : 'off', onChange: (v) => (taxUseSplit = v === 'on') }),
      { hint: '「使う」にすると、税区分に共通対応・非課税売上対応の仕入が出ます。非課税売上（家賃・利息など）が多く、課税売上割合が95%未満になるときに個別対応方式で使います' },
    ),
    corp
      ? field(
          '製造原価',
          segmented({ name: '製造原価', options: [{ value: 'off', label: '使わない' }, { value: 'on', label: '使う' }], value: manufacturing ? 'on' : 'off', onChange: (v) => (manufacturing = v === 'on') }),
          { hint: '製品を作って売る会社向け。「使う」にすると材料費・労務費・製造経費・仕掛品と原材料・製品の科目を追加し、製造原価報告書を作れます。「使わない」に戻しても科目は残ります' },
        )
      : field(
          '不動産所得',
          segmented({
            name: '不動産所得',
            options: [
              { value: 'none', label: 'なし' },
              { value: 'both', label: '事業と両方' },
              { value: 'only', label: '不動産だけ' },
            ],
            value: realEstate,
            onChange: (v) => (realEstate = v),
          }),
          { hint: 'アパート・駐車場などの貸付けがある人向け。「事業と両方」「不動産だけ」にすると賃貸料・不動産経費などの科目を追加し、青色申告決算書（不動産所得用）を作れます。「なし」に戻しても科目は残ります' },
        ),
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
    h('div', { class: 'panel small' }, h('p', { text: 'この事業所のすべての仕訳・科目・設定を消して、初期設定からやり直します（ほかの事業所と画面ロックは残ります）。' }), h('button', { type: 'button', class: 'btn btn-danger-text', text: 'すべてのデータを消す', onclick: reset })),
  );

  async function save() {
    const errors = {};
    if (!name.value.trim()) errors.businessName = '事業者名を入力してください';
    if (corp) Object.assign(errors, validatePeriod({ startDate: start.value, endDate: end.value }, 'corporation'));
    if (!showErrors(form, errors)) return;
    try {
      await app.db.updateSettings({ businessName: name.value.trim(), taxStatus, taxUseSplit, ...(corp ? {} : { filing }) });
      let message = '保存しました';
      if (corp && manufacturing !== Boolean(settings.manufacturing)) {
        const r = await app.db.setManufacturing(manufacturing);
        if (r.added.length) message = `保存しました（製造原価の科目を${r.added.length}件追加）`;
      }
      if (!corp && realEstate !== (settings.realEstate || 'none')) {
        const r = await app.db.setRealEstate(realEstate);
        if (r.added.length) message = `保存しました（不動産所得の科目を${r.added.length}件追加）`;
      }
      if (corp && (start.value !== period.startDate || end.value !== period.endDate)) await app.db.savePeriodDates(period.id, { startDate: start.value, endDate: end.value });
      showToast(message);
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
