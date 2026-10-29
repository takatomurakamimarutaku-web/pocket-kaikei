// 給与計算：支給日の月ごとの給与・賞与の一覧、まとめて作る・まとめて仕訳を登録、従業員・納付・設定への入口
import { h, put, emptyState, saveFile, showToast, confirmDialog, errorBox, field } from '../ui.js';
import { formatYen } from '../money.js';
import { csvFileName } from '../csv.js';
import { addMonths, todayString, isValidDate } from '../period.js';
import { ValidationError } from '../db.js';
import { errorText } from '../errors.js';
import { menuRow } from '../icons.js';
import { payrollTotals, payrollTitle, payrollDraft, payrollsCsv, defaultTitle, PAY_KINDS, EMPLOYEE_KIND_LABEL } from '../payroll.js';

const ymLabel = (ym) => `${ym.slice(0, 4)}年${Number(ym.slice(5))}月`;

export async function render({ app, outlet, query }) {
  const [settings, employees, payrolls] = await Promise.all([app.db.getSettings(), app.db.listEmployees(), app.db.listPayrolls()]);
  const today = todayString();
  let month = /^\d{4}-\d{2}$/.test(query.month || '') ? query.month : today.slice(0, 7);
  const active = employees.filter((e) => e.active);
  const errorsEl = h('div', { class: 'errors-wrap' });
  const body = h('div');
  const monthLabel = h('span', { class: 'month-label' });
  const move = (d) => {
    month = addMonths(`${month}-01`, d).slice(0, 7);
    history.replaceState(history.state, '', `#/payroll?month=${month}`);
    paint();
  };
  const fail = (e, what) => {
    put(errorsEl, errorBox(e instanceof ValidationError ? [].concat(Object.values(e.errors)) : [errorText(e, what)]));
    errorsEl.scrollIntoView({ behavior: 'smooth', block: 'center' });
  };

  /** 在籍している人の給与の下書きをまとめて作る（その月に給与がある人は作らない） */
  async function bulkCreate() {
    const date = h('input', { id: 'bulk-date', type: 'date', value: month === today.slice(0, 7) ? today : `${month}-25`, required: true });
    const title = h('input', { id: 'bulk-title', type: 'text', maxlength: 30, placeholder: defaultTitle('salary', `${month}-01`) });
    const targets = () => active.filter((e) => !payrolls.some((p) => p.employeeId === e.id && p.kind === 'salary' && p.payDate.slice(0, 7) === String(date.value).slice(0, 7)));
    const note = h('p', { class: 'field-hint' });
    const paintNote = () => {
      const list = targets();
      note.textContent = isValidDate(date.value) ? (list.length ? `${list.map((e) => e.name).join('、')}（${list.length}人）の給与を、従業員の登録内容で作ります。` : 'この月の給与は、在籍している人の分がもうあります。') : '支給日を入れてください';
    };
    date.addEventListener('input', paintNote);
    paintNote();
    const ok = await confirmDialog({
      title: '給与をまとめて作る',
      body: h('div', {}, field('支給日', date), field('題名', title, { hint: '空欄なら「◯月分」' }), note),
      buttons: [
        { label: 'キャンセル', value: false },
        { label: '作る', value: true, variant: 'primary' },
      ],
    });
    if (ok !== true) return;
    const list = targets();
    if (!isValidDate(date.value) || !list.length) return;
    try {
      const all = await app.db.listPayrolls();
      await app.db.createPayrolls(list.map((e) => payrollDraft(e, { kind: 'salary', payDate: date.value, title: title.value.trim() || undefined, payrolls: all })));
      showToast(`${list.length}人の給与を作りました（下書き）`);
      app.navigate(`#/payroll?month=${date.value.slice(0, 7)}`, { replace: true });
    } catch (e) {
      fail(e, '作成');
    }
  }

  async function bulkPost(list) {
    const total = list.reduce((s, p) => s + payrollTotals(p).net, 0);
    const ok = await confirmDialog({
      title: `${list.length}件の仕訳を登録しますか？`,
      message: `${ymLabel(month)}の下書きの給与・賞与を、支給日の仕訳として登録します（差引支給額の合計 ${formatYen(total)}円）。登録した給与は、計上を取り消すまで変更できません。`,
      buttons: [
        { label: 'キャンセル', value: false },
        { label: '登録する', value: true, variant: 'primary' },
      ],
    });
    if (ok !== true) return;
    try {
      const r = await app.db.postPayrolls(list.map((p) => p.id));
      showToast(`${r.length}件の仕訳を登録しました`);
      app.refresh();
    } catch (e) {
      fail(e, '登録');
    }
  }

  function card(p) {
    const t = payrollTotals(p);
    return h(
      'li',
      {},
      h(
        'a',
        { class: 'pay-card', href: `#/payroll/${p.id}` },
        h('div', { class: 'pay-card-head' }, h('span', { class: 'pay-date', text: `${p.payDate.slice(5).replace('-', '/')} 支給` }), h('span', { class: 'pay-kind', text: `${PAY_KINDS[p.kind]}・${payrollTitle(p)}` }), h('span', { class: p.journalId ? 'badge badge-ok' : 'badge', text: p.journalId ? '仕訳済み' : '下書き' })),
        h('div', { class: 'pay-card-body' }, h('span', { class: 'pay-name', text: p.name }), h('span', { class: 'pay-net num', text: `${formatYen(t.net)}円` })),
        h('p', { class: 'muted small', text: `${EMPLOYEE_KIND_LABEL[p.employeeKind]}　総支給 ${formatYen(t.gross)}円　源泉所得税 ${formatYen(p.incomeTax || 0)}円` }),
      ),
    );
  }

  function paint() {
    put(errorsEl);
    monthLabel.textContent = ymLabel(month);
    const list = payrolls.filter((p) => p.payDate.slice(0, 7) === month);
    const drafts = list.filter((p) => !p.journalId);
    const sum = (f) => list.reduce((s, p) => s + f(p), 0);
    put(
      body,
      list.length
        ? h(
            'div',
            {},
            h(
              'dl',
              { class: 'pay-summary' },
              h('div', {}, h('dt', { text: '総支給額' }), h('dd', { class: 'num', text: `${formatYen(sum((p) => payrollTotals(p).gross))}円` })),
              h('div', {}, h('dt', { text: '源泉所得税' }), h('dd', { class: 'num', text: `${formatYen(sum((p) => p.incomeTax || 0))}円` })),
              h('div', {}, h('dt', { text: '差引支給額' }), h('dd', { class: 'num', text: `${formatYen(sum((p) => payrollTotals(p).net))}円` })),
            ),
            drafts.length ? h('button', { type: 'button', class: 'btn btn-primary btn-block', text: `下書き${drafts.length}件の仕訳をまとめて登録`, onclick: () => bulkPost(drafts) }) : null,
            h('ul', { class: 'pay-list' }, list.map(card)),
            h('div', { class: 'report-tools no-print' }, h('button', { type: 'button', class: 'btn', text: 'この月の一覧をCSVで書き出す', onclick: () => saveFile(new Blob([payrollsCsv(list)], { type: 'text/csv' }), csvFileName(`payroll-${month}`)) })),
          )
        : emptyState(employees.length ? `${ymLabel(month)}に支給した給与はまだありません。「給与をまとめて作る」で、在籍している人の給与を従業員の登録内容から作れます。` : 'まずは従業員を登録してください。毎月の基本給・通勤手当・社会保険料などを登録しておくと、毎月の給与をまとめて作れます。', employees.length ? null : h('a', { href: '#/payroll/employees/new', class: 'btn btn-primary', text: '従業員を登録する' }), { title: '給与' }),
    );
  }

  const setup = !settings.payroll
    ? h('div', { class: 'notice small' }, h('p', { text: 'はじめに給与の設定で、給与・預り金・支払口座の科目と、源泉所得税の納期の特例を受けているかを確かめてください。' }), h('a', { href: '#/payroll/settings', text: '給与の設定' }))
    : null;

  put(
    outlet,
    setup,
    h('div', { class: 'month-bar month-bar-plain' }, h('button', { type: 'button', class: 'btn btn-small', 'aria-label': '前の月', text: '‹', onclick: () => move(-1) }), monthLabel, h('button', { type: 'button', class: 'btn btn-small', 'aria-label': '次の月', text: '›', onclick: () => move(1) })),
    errorsEl,
    h(
      'div',
      { class: 'actions pay-actions' },
      h('button', { type: 'button', class: 'btn btn-block', text: '給与をまとめて作る', disabled: !active.length, onclick: bulkCreate }),
      h('a', { class: `btn btn-block ${active.length ? '' : 'is-disabled'}`, href: active.length ? `#/payroll/new?kind=bonus&date=${month === today.slice(0, 7) ? today : `${month}-10`}` : '#/payroll/employees', text: '賞与を作る' }),
    ),
    body,
    h(
      'ul',
      { class: 'menu-group pay-menu' },
      menuRow({ href: '#/payroll/employees', label: '従業員', sub: `在籍 ${active.length}人。基本給・通勤手当・社会保険料・扶養親族等の数`, icon: 'payroll', tone: 'entry' }),
      menuRow({ href: '#/payroll/payments', label: '源泉所得税・住民税・社会保険料の納付', sub: '納付書（所得税徴収高計算書）に書く金額と納期限、納付の仕訳', icon: 'calendar', tone: 'close' }),
      menuRow({ href: '#/payroll/settings', label: '給与の設定', sub: '科目・預り金の補助科目・納期の特例', icon: 'settings', tone: 'setting' }),
    ),
    h('div', { class: 'panel small' }, h('p', { text: '源泉所得税は、国税庁の「電子計算機等を使用して源泉徴収税額を計算する方法」（月額表の甲欄）と賞与の算出率の表で計算します（令和8年分・令和9年分）。乙欄の給与など、計算できないときは税額表で求めて入力してください。' })),
  );
  paint();
}
