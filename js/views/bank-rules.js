// 銀行明細の振り分けルール：摘要にこの言葉を含む明細は、この相手科目にする（取り込みのときに過去の仕訳より優先）
import { h, put, field, segmented, showErrors, showToast, confirmDialog, emptyState } from '../ui.js';
import { RULE_DIRECTIONS, validateRule } from '../bank-import.js';
import { isCashAccount } from '../quick.js';
import { TAX_CATEGORIES, TAX_BY_CODE } from '../tax.js';
import { ValidationError } from '../db.js';
import { errorText } from '../errors.js';
import { pickAccount } from './account-picker.js';

const DIRECTION_LABEL = Object.fromEntries(RULE_DIRECTIONS.map((d) => [d.id, d.label]));

export async function render({ app, outlet }) {
  const { settings, accounts, subAccounts, accountById, subById } = await app.load();
  let rules = [...(settings.bankRules || [])];
  const candidates = accounts.filter((a) => !isCashAccount(a));
  const blank = () => ({ id: null, keyword: '', direction: 'out', accountId: '', subAccountId: null, taxCategory: 'none' });
  let draft = blank();

  const listEl = h('div');
  const formEl = h('section', { class: 'panel' });

  function paintList() {
    put(
      listEl,
      h('h2', { class: 'section-title', text: `登録済みのルール（${rules.length}件）` }),
      rules.length
        ? h(
            'ul',
            { class: 'menu-group' },
            rules.map((r) => {
              const acc = accountById.get(r.accountId);
              const sub = r.subAccountId ? subById.get(r.subAccountId) : null;
              return h(
                'li',
                { class: 'rule-row' },
                h(
                  'button',
                  { type: 'button', class: 'rule-main', 'aria-label': `「${r.keyword}」のルールを編集`, onclick: () => edit(r) },
                  h('span', { class: 'rule-kw', text: `「${r.keyword}」` }),
                  h('span', { class: 'rule-acc', text: acc ? `${acc.name}${sub ? `／${sub.name}` : ''}` : '（科目が見つかりません）' }),
                  h('span', { class: 'muted small', text: `${DIRECTION_LABEL[r.direction] || ''}の明細・${TAX_BY_CODE[r.taxCategory]?.label ?? ''}${acc && !acc.active ? '・科目が無効のため使いません' : ''}` }),
                ),
                h('button', { type: 'button', class: 'btn btn-small btn-danger-text', text: '削除', onclick: () => remove(r) }),
              );
            }),
          )
        : emptyState('まだルールがありません。上の欄から登録してください。'),
      h('p', { class: 'muted small', text: '摘要に複数のルールの言葉が含まれるときは、言葉の長いルールを使います。ルールに当てはまらない明細は、これまでどおり過去の仕訳の摘要から候補を出します。' }),
    );
  }

  function paintForm() {
    const keyword = h('input', { id: 'rule-keyword', type: 'text', maxlength: 30, value: draft.keyword, placeholder: '例：アマゾン、NTT、デンキ', oninput: (e) => (draft.keyword = e.target.value) });
    const acc = accountById.get(draft.accountId);
    const subs = acc ? subAccounts.filter((x) => x.accountId === acc.id && x.active) : [];
    put(
      formEl,
      h('h2', { class: 'section-title', text: draft.id ? 'ルールの編集' : 'ルールの追加' }),
      h(
        'form',
        { novalidate: true, onsubmit: (e) => (e.preventDefault(), save(e.target)) },
        field('摘要に含まれる言葉', keyword, { name: 'keyword', hint: '銀行の明細の表記（カタカナ・英字など）に合わせます。ひらがな・カタカナ、全角・半角の違いは区別しません' }),
        field(
          '入金・出金',
          segmented({ name: '入金・出金', options: RULE_DIRECTIONS.map((d) => ({ value: d.id, label: d.label })), value: draft.direction, onChange: (v) => (draft.direction = v) }),
          { name: 'direction' },
        ),
        field(
          '相手科目',
          h('button', {
            type: 'button',
            id: 'rule-account',
            class: `btn acc-btn btn-block ${acc ? '' : 'is-empty'}`,
            text: acc ? `${acc.code} ${acc.name}` : '相手科目を選ぶ',
            onclick: async () => {
              const id = await pickAccount({ accounts: candidates, entityType: settings.entityType, currentId: draft.accountId, title: '相手科目を選ぶ' });
              if (!id) return;
              draft = { ...draft, accountId: id, subAccountId: null, taxCategory: accountById.get(id).defaultTaxCategory };
              paintForm();
            },
          }),
          { name: 'accountId' },
        ),
        subs.length
          ? field(
              '補助科目',
              h('select', { id: 'rule-sub', onchange: (e) => (draft.subAccountId = e.target.value || null) }, h('option', { value: '', text: '補助なし' }), subs.map((x) => h('option', { value: x.id, text: x.name, selected: x.id === draft.subAccountId }))),
              { name: 'subAccountId' },
            )
          : null,
        field(
          '税区分',
          h('select', { id: 'rule-tax', onchange: (e) => (draft.taxCategory = e.target.value) }, TAX_CATEGORIES.map((t) => h('option', { value: t.code, text: t.label, selected: t.code === draft.taxCategory }))),
          { name: 'taxCategory' },
        ),
        h('div', { class: 'actions' }, draft.id ? h('button', { type: 'button', class: 'btn', text: 'やめる', onclick: () => ((draft = blank()), paintForm()) }) : null, h('button', { type: 'submit', class: 'btn btn-primary', text: draft.id ? '保存する' : '追加する' })),
      ),
    );
  }

  function edit(r) {
    draft = { ...r };
    paintForm();
    formEl.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }

  async function persist(next, message) {
    try {
      const saved = await app.db.saveBankRules(next);
      rules = saved.bankRules;
      showToast(message);
      return true;
    } catch (e) {
      showToast(e instanceof ValidationError ? (Array.isArray(e.errors) ? e.errors[0] : Object.values(e.errors)[0]) : errorText(e, '保存'));
      return false;
    }
  }

  async function save(form) {
    const rule = { ...draft, keyword: draft.keyword.trim() };
    const errors = validateRule(rule, { accounts, subAccounts, isBankAccount: (id) => isCashAccount(accountById.get(id)) });
    if (Object.keys(errors).length) return showErrors(form, errors);
    const next = rule.id ? rules.map((r) => (r.id === rule.id ? rule : r)) : [...rules, rule];
    if (await persist(next, rule.id ? 'ルールを保存しました' : `「${rule.keyword}」のルールを追加しました`)) {
      draft = blank();
      paintForm();
      paintList();
    }
  }

  async function remove(r) {
    const ok = await confirmDialog({ title: 'ルールを削除しますか', message: `「${r.keyword}」のルールを削除します。登録済みの仕訳は変わりません。`, buttons: [{ label: 'やめる', value: false }, { label: '削除する', value: true, variant: 'danger' }] });
    if (!ok) return;
    if (await persist(rules.filter((x) => x.id !== r.id), 'ルールを削除しました')) {
      if (draft.id === r.id) draft = blank();
      paintForm();
      paintList();
    }
  }

  put(outlet, h('p', { class: 'muted small', text: '銀行明細のCSVを取り込むとき、摘要にここで登録した言葉を含む明細には、決めておいた相手科目と税区分を自動で入れます。' }), formEl, listEl);
  paintForm();
  paintList();
}
