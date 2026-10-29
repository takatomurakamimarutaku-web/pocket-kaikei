// 請求書・見積書の紙面（画面の確認と印刷・PDF 保存で同じものを使う）
// 適格請求書の記載事項（invoices.js の冒頭の出典）：①発行元の名前と登録番号 ②取引年月日 ③内容（軽減税率の対象は※）
// ④税率ごとの合計と税率 ⑤税率ごとの消費税額 ⑥宛名
import { h } from '../ui.js';
import { formatYen } from '../money.js';
import { INVOICE_KINDS, invoiceTotals, lineAmount, formatQuantity, customerLabel, LINE_TAX_BY_CODE } from '../invoices.js';

/** 2026-10-31 → 2026年10月31日 */
export function jpDate(s) {
  if (!s) return '';
  const [y, m, d] = s.split('-').map(Number);
  return `${y}年${m}月${d}日`;
}

/** 取引年月日（期間のときは「〜」でつなぐ。同じ年なら終わりの年を省く） */
export function deliveryLabel(inv) {
  if (!inv.deliveryTo || inv.deliveryTo === inv.deliveryFrom) return jpDate(inv.deliveryFrom);
  const to = inv.deliveryTo.slice(0, 4) === inv.deliveryFrom.slice(0, 4) ? jpDate(inv.deliveryTo).replace(/^\d+年/, '') : jpDate(inv.deliveryTo);
  return `${jpDate(inv.deliveryFrom)}〜${to}`;
}

const yen = (n) => `${formatYen(n)}円`;

/**
 * 紙面
 * @param {object} inv 請求書・見積書
 * @param {{ settings }} ctx 設定（発行元の情報は settings.invoice）
 */
export function invoiceDoc(inv, { settings }) {
  const kind = INVOICE_KINDS[inv.kind];
  const issuer = settings.invoice || {};
  const totals = invoiceTotals(inv);
  const inclusive = inv.priceMode === 'inclusive';
  const isInvoice = inv.kind === 'invoice';
  const meta = (label, value) => (value ? h('div', { class: 'idoc-meta-row' }, h('dt', { text: label }), h('dd', { text: value })) : null);

  const sumRows = totals.groups.map((g) =>
    g.rate
      ? h(
          'tr',
          {},
          h('th', { scope: 'row', text: `${g.docLabel}${inclusive ? '（税込）' : ''}` }),
          h('td', { class: 'num', text: yen(inclusive ? g.gross : g.net) }),
          h('th', { scope: 'row', class: 'idoc-taxlabel', text: inclusive ? '内消費税' : '消費税' }),
          h('td', { class: 'num', text: yen(g.tax) }),
        )
      : h('tr', {}, h('th', { scope: 'row', text: g.docLabel }), h('td', { class: 'num', text: yen(g.gross) }), h('td', { colspan: 2 })),
  );

  return h(
    'article',
    { class: `invoice-doc ${inv.status === 'void' ? 'is-void' : ''}`, 'aria-label': `${kind.label} No.${inv.number}` },
    inv.status === 'void' ? h('p', { class: 'idoc-void', text: '取消' }) : null,
    h(
      'header',
      { class: 'idoc-head' },
      h('h2', { class: 'idoc-title', text: kind.label }),
      h('dl', { class: 'idoc-meta' }, meta('No.', inv.number), meta('発行日', jpDate(inv.issueDate))),
    ),
    h(
      'div',
      { class: 'idoc-parties' },
      h(
        'div',
        { class: 'idoc-to' },
        h('p', { class: 'idoc-customer', text: customerLabel(inv.customer) }),
        inv.subject ? h('p', { class: 'idoc-subject', text: `件名：${inv.subject}` }) : null,
        h('p', { class: 'idoc-lead', text: kind.lead }),
        h('div', { class: 'idoc-total' }, h('span', { class: 'idoc-total-label', text: kind.totalLabel }), h('span', { class: 'idoc-total-value', text: `${yen(totals.total)}（税込）` })),
      ),
      h(
        'div',
        { class: 'idoc-from' },
        h('p', { class: 'idoc-issuer', text: issuer.issuerName || settings.businessName }),
        issuer.registrationNo ? h('p', { class: 'idoc-reg', text: `登録番号 ${issuer.registrationNo}` }) : null,
        issuer.address ? h('p', { text: issuer.address }) : null,
        issuer.phone ? h('p', { text: `TEL ${issuer.phone}` }) : null,
        issuer.email ? h('p', { text: issuer.email }) : null,
      ),
    ),
    h(
      'dl',
      { class: 'idoc-dates' },
      isInvoice ? meta('取引年月日', deliveryLabel(inv)) : null,
      isInvoice ? meta('お支払期限', jpDate(inv.dueDate)) : meta('有効期限', jpDate(inv.validUntil)),
    ),
    h(
      'table',
      { class: 'idoc-lines' },
      h('thead', {}, h('tr', {}, h('th', { scope: 'col', text: '品名・内容' }), h('th', { scope: 'col', class: 'num', text: '数量' }), h('th', { scope: 'col', class: 'num', text: `単価${inclusive ? '（税込）' : '（税抜）'}` }), h('th', { scope: 'col', class: 'num', text: '金額' }))),
      h(
        'tbody',
        {},
        inv.lines.map((l) => {
          const t = LINE_TAX_BY_CODE[l.tax];
          const mark = t.reduced ? '※' : '';
          const tag = t.rate ? '' : `（${t.label}）`;
          return h(
            'tr',
            {},
            h('td', { class: 'idoc-item', text: `${mark}${l.name}${tag}` }),
            h('td', { class: 'num', text: `${formatQuantity(l.qty100)}${l.unit || ''}` }),
            h('td', { class: 'num', text: formatYen(l.unitPrice) }),
            h('td', { class: 'num', text: formatYen(lineAmount(l)) }),
          );
        }),
      ),
    ),
    h(
      'table',
      { class: 'idoc-sum' },
      h('tbody', {}, sumRows),
      h('tfoot', {}, h('tr', {}, h('th', { scope: 'row', text: '合計（税込）' }), h('td', { class: 'num', text: yen(totals.total) }), h('th', { scope: 'row', class: 'idoc-taxlabel', text: inclusive ? '内消費税' : '消費税計' }), h('td', { class: 'num', text: yen(totals.tax) }))),
    ),
    totals.hasReduced ? h('p', { class: 'idoc-legend', text: '※は軽減税率（8%）の対象です' }) : null,
    isInvoice && issuer.bank ? h('div', { class: 'idoc-box' }, h('p', { class: 'idoc-box-title', text: 'お振込先' }), h('p', { class: 'idoc-pre', text: issuer.bank })) : null,
    inv.note ? h('div', { class: 'idoc-box' }, h('p', { class: 'idoc-box-title', text: '備考' }), h('p', { class: 'idoc-pre', text: inv.note })) : null,
  );
}
