// 請求書・見積書の一覧：種類の切替、状態・金額の表示、新規作成、一覧の CSV
import { h, put, segmented, emptyState, saveFile } from '../ui.js';
import { formatYen } from '../money.js';
import { csvFileName } from '../csv.js';
import { INVOICE_KINDS, INVOICE_STATUSES, invoiceTotals, customerLabel, invoicesCsv } from '../invoices.js';
import { jpDate } from './invoice-doc.js';

const STATUS_BADGE = { draft: 'badge', issued: 'badge badge-ok', void: 'badge badge-warn' };

export async function render({ app, outlet, query }) {
  const [settings, invoices] = await Promise.all([app.db.getSettings(), app.db.listInvoices()]);
  let kind = INVOICE_KINDS[query.kind] ? query.kind : 'invoice';
  const issuer = settings.invoice || {};
  const listEl = h('div');
  const newBtn = h('a', { class: 'btn btn-primary btn-block' });

  const setup = !issuer.registrationNo
    ? h(
        'div',
        { class: 'notice small' },
        h('p', { text: settings.taxStatus === 'taxable' ? '登録番号がまだ設定されていません。適格請求書（インボイス）を作るには、請求書の設定で登録番号を入れてください。' : '登録番号を設定していないので、登録番号の欄の無い請求書になります（適格請求書発行事業者の登録を受けたら、請求書の設定で登録番号を入れてください）。' }),
        h('a', { href: '#/invoices/settings', text: '請求書の設定（発行元・登録番号・振込先）' }),
      )
    : null;

  function card(inv) {
    const t = invoiceTotals(inv);
    const status = inv.kind === 'estimate' ? (inv.invoiceId ? h('span', { class: 'badge badge-ok', text: '請求書を作成済み' }) : null) : h('span', { class: STATUS_BADGE[inv.status], text: INVOICE_STATUSES[inv.status] });
    return h(
      'li',
      {},
      h(
        'a',
        { class: `inv-card ${inv.status === 'void' ? 'is-void' : ''}`, href: `#/invoices/${inv.id}` },
        h('div', { class: 'inv-card-head' }, h('span', { class: 'inv-no', text: `No.${inv.number}` }), h('span', { class: 'inv-date', text: jpDate(inv.issueDate) }), status),
        h('div', { class: 'inv-card-body' }, h('span', { class: 'inv-customer', text: customerLabel(inv.customer) }), h('span', { class: 'inv-amount num', text: `${formatYen(t.total)}円` })),
        inv.subject ? h('p', { class: 'inv-subject muted small', text: inv.subject }) : null,
      ),
    );
  }

  function paint() {
    const label = INVOICE_KINDS[kind].label;
    const list = invoices.filter((x) => x.kind === kind);
    newBtn.href = `#/invoices/new?kind=${kind}`;
    newBtn.textContent = `新しい${label}を作る`;
    history.replaceState(null, '', `#/invoices${kind === 'invoice' ? '' : `?kind=${kind}`}`);
    put(
      listEl,
      list.length
        ? h('ul', { class: 'inv-list' }, list.map(card))
        : emptyState(
            kind === 'invoice' ? '請求書はまだありません。作った請求書は印刷やPDFで相手に渡せます。発行すると売掛金を計上します。' : '見積書はまだありません。見積書からそのまま請求書を作れます。',
            null,
            { title: label },
          ),
      list.length ? h('div', { class: 'report-tools no-print' }, h('button', { type: 'button', class: 'btn', text: '一覧をCSVで書き出す', onclick: () => saveFile(new Blob([invoicesCsv(list)], { type: 'text/csv' }), csvFileName(kind === 'invoice' ? 'invoices' : 'estimates')) })) : null,
    );
  }

  put(
    outlet,
    segmented({ name: '種類', options: Object.values(INVOICE_KINDS).map((k) => ({ value: k.id, label: k.label })), value: kind, onChange: (v) => ((kind = v), paint()) }),
    setup,
    newBtn,
    listEl,
    h(
      'div',
      { class: 'panel small' },
      h('p', { text: '請求書は「発行して売掛金を計上」で、売掛金と売上の仕訳を登録します。入金は、かんたん入力の「売掛金の入金」などで入力すると売掛金の画面で消し込まれます。' }),
      h('p', { class: 'muted', text: '交付した請求書（適格請求書）の控えは7年間保存する決まりがあります。このアプリは発行した請求書を残しておき、いつでも同じ内容で印刷できます。PDFをメールで送った場合は、送ったPDFも保存してください（電子取引のデータの保存）。' }),
      h('p', {}, h('a', { href: '#/invoices/settings', text: '請求書の設定（発行元・登録番号・振込先・端数処理）' })),
    ),
  );
  paint();
}
