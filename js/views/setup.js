// 初期設定ウィザード（事業者名・個人/法人・会計期間・課税/免税）
import { h, put, field, segmented, showErrors, showToast } from '../ui.js';
import { templateAccounts } from '../accounts.js';
import { createAccount, createPeriod, createSettings, ENTITY_LABELS, TAX_STATUS_LABELS } from '../models.js';
import { individualPeriod, defaultCorporateEnd, todayString, validatePeriod } from '../period.js';
import { ValidationError } from '../db.js';
import { errorText } from '../errors.js';

export async function render({ app, outlet }) {
  const thisYear = Number(todayString().slice(0, 4));
  const state = {
    businessName: '',
    entityType: 'individual',
    taxStatus: 'exempt',
    year: thisYear,
    startDate: `${thisYear}-04-01`,
    endDate: defaultCorporateEnd(`${thisYear}-04-01`),
  };

  const name = h('input', { id: 'f-name', type: 'text', maxlength: 60, placeholder: '例：村上商店', oninput: (e) => (state.businessName = e.target.value) });
  const yearSelect = h(
    'select',
    { id: 'f-year', onchange: (e) => (state.year = Number(e.target.value)) },
    [thisYear - 2, thisYear - 1, thisYear, thisYear + 1].map((y) => h('option', { value: y, text: `${y}年（1月1日〜12月31日）`, selected: y === thisYear })),
  );
  const start = h('input', {
    id: 'f-start',
    type: 'date',
    value: state.startDate,
    onchange: (e) => {
      state.startDate = e.target.value;
      if (state.startDate) {
        state.endDate = defaultCorporateEnd(state.startDate);
        end.value = state.endDate;
      }
    },
  });
  const end = h('input', { id: 'f-end', type: 'date', value: state.endDate, onchange: (e) => (state.endDate = e.target.value) });
  const individualPeriodField = field('会計期間', yearSelect, { name: 'year', hint: '個人事業主の会計期間は暦年（1月1日〜12月31日）です' });
  const corporatePeriodField = h(
    'div',
    { hidden: true },
    h('div', { class: 'field-row' }, field('開始日', start, { name: 'startDate' }), field('終了日', end, { name: 'endDate' })),
    h('p', { class: 'field-hint', text: '終了日は開始日の12か月後の前日が入ります。設立初年度など、短くすることもできます' }),
  );

  const syncEntity = () => {
    individualPeriodField.hidden = state.entityType !== 'individual';
    corporatePeriodField.hidden = state.entityType !== 'corporation';
  };

  const form = h(
    'form',
    { class: 'setup', novalidate: true, onsubmit: (e) => (e.preventDefault(), submit()) },
    h('div', { class: 'panel' }, h('p', { text: 'はじめに、帳簿の基本情報を設定します。個人/法人は後から変更できません。' })),
    field('事業者名（屋号・会社名）', name, { name: 'businessName' }),
    field(
      '事業の形態',
      segmented({
        name: '事業の形態',
        options: Object.entries(ENTITY_LABELS).map(([value, label]) => ({ value, label })),
        value: state.entityType,
        onChange: (v) => {
          state.entityType = v;
          syncEntity();
        },
      }),
      { hint: '勘定科目と決算書の様式が切り替わります' },
    ),
    individualPeriodField,
    corporatePeriodField,
    field(
      '消費税',
      segmented({
        name: '消費税',
        options: Object.entries(TAX_STATUS_LABELS).map(([value, label]) => ({ value, label })),
        value: state.taxStatus,
        onChange: (v) => (state.taxStatus = v),
      }),
      { hint: '後から変更できます。経理方式は税込経理です' },
    ),
    h('button', { type: 'submit', class: 'btn btn-primary btn-block', text: 'この内容で始める' }),
  );
  syncEntity();
  put(outlet, form);

  async function submit() {
    const period = state.entityType === 'individual' ? individualPeriod(state.year) : { startDate: state.startDate, endDate: state.endDate };
    const errors = validatePeriod(period, state.entityType);
    if (!state.businessName.trim()) errors.businessName = '事業者名を入力してください';
    if (!showErrors(form, errors)) return;
    try {
      await app.db.setup({
        settings: createSettings({ businessName: state.businessName.trim(), entityType: state.entityType, taxStatus: state.taxStatus }),
        period: createPeriod(period),
        accounts: templateAccounts(state.entityType).map((a) => createAccount(a)),
      });
      showToast('初期設定が完了しました。期首残高があれば入力してください', { actionLabel: '期首残高へ', onAction: () => app.navigate('#/opening'), duration: 8000 });
      app.navigate('#/home', { replace: true });
    } catch (e) {
      if (e instanceof ValidationError && !Array.isArray(e.errors)) showErrors(form, e.errors);
      else showToast(errorText(e, '保存'));
    }
  }
}
