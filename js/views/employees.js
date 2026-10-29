// 従業員の一覧：在籍している人・辞めた人、区分・税額表の欄・毎月の支給額
import { h, put, emptyState } from '../ui.js';
import { formatYen } from '../money.js';
import { sumItems, EMPLOYEE_KIND_LABEL, TAX_COLUMN_LABEL } from '../payroll.js';

export async function render({ app, outlet }) {
  const employees = await app.db.listEmployees();
  const card = (e) =>
    h(
      'li',
      {},
      h(
        'a',
        { class: `pay-card ${e.active ? '' : 'is-void'}`, href: `#/payroll/employees/${e.id}` },
        h('div', { class: 'pay-card-head' }, h('span', { text: EMPLOYEE_KIND_LABEL[e.kind] }), h('span', { text: e.taxColumn === 'kou' ? `甲欄・扶養${e.dependents}人` : TAX_COLUMN_LABEL[e.taxColumn] }), e.active ? null : h('span', { class: 'badge badge-warn', text: '在籍していない' })),
        h('div', { class: 'pay-card-body' }, h('span', { class: 'pay-name', text: e.name }), h('span', { class: 'pay-net num', text: `${formatYen(sumItems(e.earnings) + (e.commute || 0))}円` })),
        h('p', { class: 'muted small', text: `毎月の支給（通勤手当を含む）${e.employmentRate != null ? '　雇用保険あり' : ''}${e.health || e.pension ? '　社会保険あり' : ''}` }),
      ),
    );
  put(
    outlet,
    h('a', { href: '#/payroll/employees/new', class: 'btn btn-primary btn-block', text: '従業員を登録する' }),
    employees.length ? h('ul', { class: 'pay-list' }, employees.map(card)) : emptyState('従業員はまだ登録されていません。基本給・通勤手当・社会保険料・住民税・扶養親族等の数を登録しておくと、毎月の給与をまとめて作れます。', null, { title: '従業員' }),
    h('div', { class: 'panel small' }, h('p', { text: '社会保険料（健康保険・厚生年金）と住民税は、届いた通知の金額を登録してください。雇用保険料は料率を入れると支給額から計算します。' }), h('p', { class: 'muted', text: '辞めた人は「在籍」を外すと、まとめて作る給与の対象から外れます。給与の記録がある人は削除できません。' })),
  );
}
