// 請求書・見積書の確認・印刷（PDF 保存）と、発行（売掛金の計上）・取消・複製・見積書から請求書を作る・削除
import { h, put, showToast, confirmDialog, errorBox } from '../ui.js';
import { formatYen } from '../money.js';
import { ValidationError } from '../db.js';
import { errorText } from '../errors.js';
import { journalLabel } from '../journal.js';
import { INVOICE_KINDS, INVOICE_STATUSES, ROUNDINGS, invoiceTotals, postingDate, customerLabel } from '../invoices.js';
import { invoiceDoc } from './invoice-doc.js';

export async function render({ app, outlet, params }) {
  const [settings, inv, accounts, subAccounts, periods] = await Promise.all([app.db.getSettings(), app.db.getInvoice(params.id), app.db.listAccounts(), app.db.listSubAccounts(), app.db.listPeriods()]);
  if (!inv) return put(outlet, h('p', { class: 'notice', text: '請求書・見積書が見つかりません' }), h('a', { href: '#/invoices', class: 'btn', text: '一覧へ' }));
  const kind = INVOICE_KINDS[inv.kind];
  const isInvoice = inv.kind === 'invoice';
  app.setTitle(`${kind.label} No.${inv.number}`);
  const journal = isInvoice && inv.journalId ? await app.db.getJournal(inv.journalId) : null;
  const linked = inv.kind === 'estimate' && inv.invoiceId ? await app.db.getInvoice(inv.invoiceId) : inv.estimateId ? await app.db.getInvoice(inv.estimateId) : null;
  const errorsEl = h('div', { class: 'errors-wrap no-print' });
  const issuer = settings.invoice || {};
  const totals = invoiceTotals(inv);
  const name = (id) => accounts.find((a) => a.id === id)?.name ?? '';
  const fail = (e, what) => {
    put(errorsEl, errorBox(e instanceof ValidationError ? [].concat(Object.values(e.errors)) : [errorText(e, what)]));
    errorsEl.scrollIntoView({ behavior: 'smooth', block: 'center' });
  };

  async function issue() {
    const date = postingDate(inv);
    const sub = subAccounts.find((s) => s.id === inv.customer.subAccountId);
    const receivable = accounts.find((a) => a.id === sub?.accountId) || accounts.find((a) => a.hint === 'receivable');
    const period = periods.find((p) => p.startDate <= date && date <= p.endDate);
    const ok = await confirmDialog({
      title: inv.status === 'issued' ? '売掛金をもう一度計上しますか？' : '発行して売掛金を計上しますか？',
      message: `${date.replaceAll('-', '/')}（取引年月日）の仕訳として、借方 ${receivable?.name ?? '売掛金'}${sub ? `（${sub.name}）` : ''} ${formatYen(totals.total)}円／貸方 ${name(inv.revenueAccountId)} ${formatYen(totals.total)}円 を登録します。${inv.status === 'issued' ? '' : '発行した請求書は変更できなくなります（直すときは取り消して複製します）。'}${period ? '' : '\n取引年月日を含む会計期間がまだありません。'}`,
      buttons: [
        { label: 'キャンセル', value: false },
        { label: inv.status === 'issued' ? '計上する' : '発行する', value: true, variant: 'primary' },
      ],
    });
    if (ok !== true) return;
    try {
      const r = await app.db.issueInvoice(inv.id);
      showToast(`発行しました（${journalLabel(r.journal)} を登録）`);
      app.refresh();
    } catch (e) {
      fail(e, '発行');
    }
  }

  async function voidIt() {
    const ok = await confirmDialog({
      title: 'この請求書を取り消しますか？',
      message: `${journal ? `売掛金の仕訳（${journalLabel(journal)}）を削除し、` : ''}請求書を「取消」にします。請求書の記録は控えとして残ります。相手に渡した後なら、取り消したことを相手にも伝えてください。直した請求書は「複製」で作れます。`,
      buttons: [
        { label: 'キャンセル', value: false },
        { label: '取り消す', value: true, variant: 'danger' },
      ],
    });
    if (ok !== true) return;
    try {
      await app.db.voidInvoice(inv.id);
      showToast('請求書を取り消しました');
      app.refresh();
    } catch (e) {
      fail(e, '取消');
    }
  }

  async function remove() {
    const ok = await confirmDialog({
      title: `${kind.label} No.${inv.number} を削除しますか？`,
      message: inv.status === 'void' ? '相手に渡した請求書は、取り消したものも控えを7年間保存する決まりがあります。渡していない場合だけ削除してください。' : '削除すると元に戻せません。',
      buttons: [
        { label: 'キャンセル', value: false },
        { label: '削除する', value: true, variant: 'danger' },
      ],
    });
    if (ok !== true) return;
    try {
      await app.db.deleteInvoice(inv.id);
      showToast(`${kind.label}を削除しました`);
      app.navigate(`#/invoices${isInvoice ? '' : '?kind=estimate'}`, { replace: true });
    } catch (e) {
      fail(e, '削除');
    }
  }

  const btn = (text, onclick, cls = 'btn') => h('button', { type: 'button', class: cls, text, onclick });
  const link = (text, href, cls = 'btn') => h('a', { href, class: cls, text });
  const actions = [];
  if (isInvoice && inv.status === 'draft') actions.push(btn('発行して売掛金を計上', issue, 'btn btn-primary btn-block'));
  if (isInvoice && inv.status === 'issued' && !journal) actions.push(btn('売掛金をもう一度計上する', issue, 'btn btn-primary btn-block'));
  if (!isInvoice) actions.push(link('この見積書から請求書を作る', `#/invoices/new?from=${inv.id}`, 'btn btn-primary btn-block'));
  actions.push(btn('印刷・PDFで保存', () => window.print(), 'btn btn-block'));
  const sub = [];
  if (inv.status === 'draft') sub.push(link('編集', `#/invoices/${inv.id}/edit`));
  sub.push(link('複製', `#/invoices/new?copy=${inv.id}`));
  if (inv.status === 'issued') sub.push(btn('取り消す', voidIt, 'btn btn-danger-text'));
  if (inv.status !== 'issued') sub.push(btn('削除', remove, 'btn btn-danger-text'));

  const notes = [];
  if (isInvoice && !issuer.registrationNo) notes.push(h('p', { class: 'notice small' }, '登録番号が設定されていないため、適格請求書（インボイス）にはなりません。', h('a', { href: '#/invoices/settings', text: '請求書の設定' })));
  const tr = periods.find((p) => p.startDate <= inv.issueDate && inv.issueDate <= p.endDate)?.taxReturn;
  if (isInvoice && tr?.salesCalc === 'stacked' && tr.salesRounding && tr.salesRounding !== inv.rounding) {
    const label = (id) => ROUNDINGS.find((r) => r.id === id)?.label;
    notes.push(h('p', { class: 'notice small', text: `消費税の申告計算は売上を積上げ計算（端数は${label(tr.salesRounding)}）にしていますが、この請求書の端数処理は${label(inv.rounding)}です。申告の税額と請求書の消費税額がずれることがあります。` }));
  }
  if (isInvoice && inv.status === 'issued' && !journal) notes.push(h('p', { class: 'notice small', text: '発行したときの売掛金の仕訳が削除されています。必要なら「売掛金をもう一度計上する」で登録し直してください。' }));

  const status = h(
    'div',
    { class: 'inv-status no-print' },
    h('p', {}, h('span', { class: `badge ${inv.status === 'issued' ? 'badge-ok' : inv.status === 'void' ? 'badge-warn' : ''}`, text: isInvoice ? INVOICE_STATUSES[inv.status] : '見積書' }), ' ', customerLabel(inv.customer)),
    journal ? h('p', { class: 'small' }, '売掛金の仕訳：', h('a', { href: `#/journal/${journal.id}/edit`, text: `${journalLabel(journal)}（${journal.date.replaceAll('-', '/')}）` })) : null,
    inv.issuedAt ? h('p', { class: 'muted small', text: `発行：${new Date(inv.issuedAt).toLocaleString('ja-JP')}${inv.voidedAt ? `　取消：${new Date(inv.voidedAt).toLocaleString('ja-JP')}` : ''}` }) : null,
    linked ? h('p', { class: 'small' }, inv.kind === 'estimate' ? '作った請求書：' : '元の見積書：', h('a', { href: `#/invoices/${linked.id}`, text: `No.${linked.number}` })) : null,
  );

  put(
    outlet,
    // 操作は紙面の上に置く（スマホで紙面の下までスクロールしなくてよいように）
    h('div', { class: 'invoice-page' }, status, ...notes, errorsEl, h('div', { class: 'actions inv-actions no-print' }, ...actions, h('div', { class: 'inv-subactions' }, ...sub)), h('div', { class: 'invoice-paper' }, invoiceDoc(inv, { settings }))),
  );
}
