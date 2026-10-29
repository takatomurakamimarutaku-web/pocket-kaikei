// 給与明細：明細の紙面（印刷・PDF 保存）と、仕訳の登録・計上の取消・編集・複製・削除
import { h, put, showToast, confirmDialog, errorBox } from '../ui.js';
import { formatYen } from '../money.js';
import { ValidationError } from '../db.js';
import { errorText } from '../errors.js';
import { journalLabel } from '../journal.js';
import { payrollTotals, payrollTitle, expenseKey, PAY_KINDS, EMPLOYEE_KIND_LABEL, TAX_COLUMN_LABEL, resolvePayrollSettings } from '../payroll.js';
import { jpDate } from './invoice-doc.js';

/** 給与明細書の紙面 */
export function payslipDoc(p, { settings }) {
  const t = payrollTotals(p);
  const row = (label, amount, cls = '') => h('tr', { class: cls }, h('th', { scope: 'row', text: label }), h('td', { class: 'num', text: formatYen(amount) }));
  const pays = [...p.earnings.map((x) => row(x.name, x.amount)), p.commute ? row('通勤手当（非課税）', p.commute) : null];
  const deds = [
    p.health ? row('健康保険料', p.health) : null,
    p.pension ? row('厚生年金保険料', p.pension) : null,
    p.employment ? row('雇用保険料', p.employment) : null,
    row('源泉所得税', p.incomeTax || 0),
    p.residentTax ? row('住民税', p.residentTax) : null,
    ...p.deductions.map((x) => row(x.name, x.amount)),
  ];
  return h(
    'article',
    { class: 'payslip' },
    h('header', { class: 'ps-head' }, h('h1', { text: `${PAY_KINDS[p.kind]}明細書` }), h('p', { class: 'ps-title', text: payrollTitle(p) })),
    h('div', { class: 'ps-meta' }, h('p', { class: 'ps-name' }, h('span', { text: p.name }), ' 様'), h('div', { class: 'ps-issuer' }, h('p', { text: settings.businessName }), h('p', { text: `支給日 ${jpDate(p.payDate)}` }))),
    h(
      'div',
      { class: 'ps-grid' },
      h('table', { class: 'ps-table' }, h('caption', { text: '支給' }), h('tbody', {}, ...pays), h('tfoot', {}, row('総支給額', t.gross, 'ps-sum'))),
      h('table', { class: 'ps-table' }, h('caption', { text: '控除' }), h('tbody', {}, ...deds), h('tfoot', {}, row('控除合計', t.deductions, 'ps-sum'))),
    ),
    h('div', { class: 'ps-net' }, h('span', { text: '差引支給額' }), h('span', { class: 'num', text: `${formatYen(t.net)}円` })),
    h('p', { class: 'ps-foot', text: `課税支給額 ${formatYen(t.taxable)}円　社会保険料等を引いた後 ${formatYen(t.afterSocial)}円　税額表 ${TAX_COLUMN_LABEL[p.taxColumn]}${p.taxColumn === 'kou' ? `・扶養親族等 ${p.dependents}人` : ''}` }),
    p.note ? h('p', { class: 'ps-note', text: p.note }) : null,
  );
}

export async function render({ app, outlet, params }) {
  const [settings, p, accounts] = await Promise.all([app.db.getSettings(), app.db.getPayroll(params.id), app.db.listAccounts()]);
  if (!p) return put(outlet, h('p', { class: 'notice', text: '給与が見つかりません' }), h('a', { href: '#/payroll', class: 'btn', text: '一覧へ' }));
  app.setTitle(`${p.name} ${payrollTitle(p)}`);
  const journal = p.journalId ? await app.db.getJournal(p.journalId) : null;
  const errorsEl = h('div', { class: 'errors-wrap no-print' });
  const t = payrollTotals(p);
  const fail = (e, what) => {
    put(errorsEl, errorBox(e instanceof ValidationError ? [].concat(Object.values(e.errors)) : [errorText(e, what)]));
    errorsEl.scrollIntoView({ behavior: 'smooth', block: 'center' });
  };
  const back = `#/payroll?month=${p.payDate.slice(0, 7)}`;

  async function post() {
    const cfg = resolvePayrollSettings(settings.payroll, accounts);
    const name = (id) => accounts.find((a) => a.id === id)?.name ?? '（未設定）';
    const ok = await confirmDialog({
      title: '仕訳を登録しますか？',
      message: `${p.payDate.replaceAll('-', '/')}（支給日）の仕訳として、借方 ${name(cfg.accounts[expenseKey(p)])} ${formatYen(t.taxable)}円${t.commute ? `・${name(cfg.accounts.commute)} ${formatYen(t.commute)}円` : ''}／貸方 ${name(cfg.accounts.deposit)} ${formatYen(t.deductions)}円・${name(cfg.accounts.payment)} ${formatYen(t.net)}円 を登録します。登録した給与は、計上を取り消すまで変更できません。`,
      buttons: [
        { label: 'キャンセル', value: false },
        { label: '登録する', value: true, variant: 'primary' },
      ],
    });
    if (ok !== true) return;
    try {
      const [r] = await app.db.postPayrolls([p.id]);
      showToast(`仕訳を登録しました（${journalLabel(r.journal)}）`);
      app.refresh();
    } catch (e) {
      fail(e, '登録');
    }
  }

  async function unpost() {
    const ok = await confirmDialog({
      title: '計上を取り消しますか？',
      message: `${journal ? `給与の仕訳（${journalLabel(journal)}）を削除し（訂正・削除の履歴に残ります）、` : ''}この給与を直せるようにします。源泉所得税の納付の集計からも外れます。`,
      buttons: [
        { label: 'キャンセル', value: false },
        { label: '取り消す', value: true, variant: 'danger' },
      ],
    });
    if (ok !== true) return;
    try {
      await app.db.unpostPayroll(p.id);
      showToast('計上を取り消しました');
      app.refresh();
    } catch (e) {
      fail(e, '取消');
    }
  }

  async function remove() {
    const ok = await confirmDialog({
      title: `${p.name}さんの${payrollTitle(p)}を削除しますか？`,
      message: '削除すると元に戻せません。',
      buttons: [
        { label: 'キャンセル', value: false },
        { label: '削除する', value: true, variant: 'danger' },
      ],
    });
    if (ok !== true) return;
    try {
      await app.db.deletePayroll(p.id);
      showToast('削除しました');
      app.navigate(back, { replace: true });
    } catch (e) {
      fail(e, '削除');
    }
  }

  const btn = (text, onclick, cls = 'btn') => h('button', { type: 'button', class: cls, text, onclick });
  const link = (text, href, cls = 'btn') => h('a', { href, class: cls, text });
  const actions = [];
  if (!p.journalId) actions.push(btn('仕訳を登録', post, 'btn btn-primary btn-block'));
  else if (!journal) actions.push(btn('仕訳をもう一度登録する', post, 'btn btn-primary btn-block'));
  actions.push(btn('印刷・PDFで保存', () => window.print(), 'btn btn-block'));
  const sub = [];
  if (!p.journalId) sub.push(link('編集', `#/payroll/${p.id}/edit`));
  sub.push(link('翌月分を作る', `#/payroll/new?copy=${p.id}`));
  if (p.journalId) sub.push(btn('計上を取り消す', unpost, 'btn btn-danger-text'));
  else sub.push(btn('削除', remove, 'btn btn-danger-text'));

  const status = h(
    'div',
    { class: 'inv-status no-print' },
    h('p', {}, h('span', { class: p.journalId ? 'badge badge-ok' : 'badge', text: p.journalId ? '仕訳済み' : '下書き' }), ` ${EMPLOYEE_KIND_LABEL[p.employeeKind]}・${PAY_KINDS[p.kind]}`),
    journal ? h('p', { class: 'small' }, '給与の仕訳：', h('a', { href: `#/journal/${journal.id}/edit`, text: `${journalLabel(journal)}（${journal.date.replaceAll('-', '/')}）` })) : null,
    p.journalId && !journal ? h('p', { class: 'notice small', text: '登録したときの仕訳が削除されています。必要なら「仕訳をもう一度登録する」で登録し直してください。' }) : null,
  );

  put(
    outlet,
    h('div', { class: 'invoice-page payslip-page' }, status, errorsEl, h('div', { class: 'actions inv-actions no-print' }, ...actions, h('div', { class: 'inv-subactions' }, ...sub)), h('div', { class: 'invoice-paper' }, payslipDoc(p, { settings }))),
  );
}
