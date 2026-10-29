// 消費税集計（税込経理。割り戻しの参考値）：税区分別・科目別税区分・月別推移・税区分のチェック
// 弥生会計の「消費税集計表」「科目別税区分表」、勘定奉行の科目別・税区分別の集計と確認を参考にした
import { h, put, amountCell, saveFile, segmented } from '../ui.js';
import { summarizeTax, CORE_TAX_CODES, TAX_BY_CODE } from '../tax.js';
import { taxByAccount, taxMonthly, taxChecks } from '../tax-reports.js';
import { isAdjusting } from '../monthly.js';
import { taxByAccountCsv, taxMonthlyCsv, csvFileName } from '../csv.js';
import { monthsInPeriod } from '../period.js';
import { monthRangePicker } from './report-common.js';

const TABS = [
  { value: 'summary', label: '税区分別' },
  { value: 'account', label: '科目別' },
  { value: 'monthly', label: '月別推移' },
  { value: 'check', label: 'チェック' },
];

const yen = (n) => n.toLocaleString('ja-JP');
const slash = (d) => d.replaceAll('-', '/');
const labelOf = (code) => TAX_BY_CODE[code]?.label ?? code ?? '';

export async function render({ app, outlet, query }) {
  const { settings, period, journals, accounts } = await app.load();
  let tab = TABS.some((t) => t.value === query.view) ? query.view : 'summary';
  let includeAdj = query.adj !== '0';
  let showInfo = query.info === '1';
  let monthlyValue = 'gross';
  const body = h('div');
  const extra = () => ({ ...(tab !== 'summary' ? { view: tab } : {}), ...(includeAdj ? {} : { adj: '0' }), ...(showInfo ? { info: '1' } : {}) });
  const picker = monthRangePicker({ period, query, path: '/reports/tax', onChange: paint, extra });
  const check = (label, value, onChange) => {
    const input = h('input', { type: 'checkbox', checked: value, onchange: () => (onChange(input.checked), picker.refreshUrl(), paint()) });
    return h('label', { class: 'check small' }, input, label);
  };
  const adjToggle = check('決算整理の仕訳を含める', includeAdj, (v) => (includeAdj = v));
  const infoToggle = check('科目の初期値と違う税区分も表示', showInfo, (v) => (showInfo = v));
  const tabs = segmented({ name: '集計表', options: TABS, value: tab, onChange: (v) => ((tab = v), picker.refreshUrl(), paint()) });
  const csvButton = (make, kind) => h('div', { class: 'actions no-print' }, h('button', { type: 'button', class: 'btn', text: 'CSVで書き出す', onclick: () => saveFile(new Blob([make()], { type: 'text/csv' }), csvFileName(kind)) }));
  const target = () => (includeAdj ? journals : journals.filter((j) => !isAdjusting(j)));

  // ---- 税区分別 ----
  function block(title, rows, total) {
    return h(
      'div',
      { class: 'table-wrap' },
      h(
        'table',
        { class: 'report taxsum' },
        h('caption', { text: title }),
        h('thead', {}, h('tr', {}, ['税区分', '税込金額', '税抜(参考)', '消費税等(参考)'].map((t) => h('th', { scope: 'col', text: t })))),
        h(
          'tbody',
          {},
          rows.map((r) =>
            h('tr', {}, h('th', {}, r.label, h('span', { class: 'muted small block', text: `${r.count}件${r.tax ? `・うち国税 ${yen(r.national)}円` : ''}` })), amountCell('td', r.gross), amountCell('td', r.net), amountCell('td', r.tax, { blankZero: true })),
          ),
        ),
        h('tfoot', {}, h('tr', {}, h('th', { text: '計' }), amountCell('td', total.gross), h('td'), amountCell('td', total.tax))),
      ),
    );
  }
  function summary({ from, to }) {
    const s = summarizeTax(target(), { from, to });
    // 使っている税区分（と主な4区分）だけを出す。行の無いグループは出さない
    const groups = s.groups.map((g) => ({ ...g, rows: g.rows.filter((r) => r.count || CORE_TAX_CODES.includes(r.code)) })).filter((g) => g.rows.length);
    return [
      groups.map((g) => block(g.label, g.rows, g.total)),
      h('p', { class: 'small', text: `差引（売上の消費税等 ＋ 貸倒れの回収・仕入の返品の消費税等 − 仕入・輸入・売上の返品・貸倒れの消費税等）の参考値：${yen(s.netTax)}円` }),
    ];
  }

  // ---- 科目別税区分集計表 ----
  function byAccount({ from, to, fromMonth, toMonth }) {
    const r = taxByAccount({ journals: target(), accounts, from, to });
    if (!r.rows.length) return h('p', { class: 'empty', text: 'この期間に税区分のある仕訳はありません。' });
    const head = h('tr', {}, ['科目・税区分', '税込金額', '税抜(参考)', '消費税等(参考)'].map((t) => h('th', { scope: 'col', text: t })));
    const rows = [];
    for (const row of r.rows) {
      const link = `#/reports/ledger?account=${encodeURIComponent(row.account.id)}&from=${fromMonth}&to=${toMonth}`;
      rows.push(h('tr', { class: 'tb-group' }, h('th', { colspan: 4 }, h('a', { href: link, text: `${row.account.code} ${row.account.name}` }))));
      for (const x of row.items) {
        rows.push(h('tr', {}, h('th', { class: 'mt-acc' }, x.label, h('span', { class: 'muted small block', text: `${x.count}件` })), amountCell('td', x.gross), amountCell('td', x.net), amountCell('td', x.tax, { blankZero: true })));
      }
      if (row.items.length > 1) rows.push(h('tr', { class: 'tb-subtotal' }, h('th', { text: '科目計' }), amountCell('td', row.total.gross), amountCell('td', row.total.net), amountCell('td', row.total.tax, { blankZero: true })));
    }
    const sums = r.byCode.map((x) => h('tr', {}, h('th', { class: 'mt-acc', text: x.label }), amountCell('td', x.gross), amountCell('td', x.net), amountCell('td', x.tax, { blankZero: true })));
    return [
      h('div', { class: 'table-wrap' }, h('table', { class: 'report taxsum tax-account' }, h('caption', { text: '科目別税区分集計表' }), h('thead', {}, head), h('tbody', {}, rows), h('tbody', {}, h('tr', { class: 'tb-group' }, h('th', { colspan: 4, text: '税区分ごとの合計' })), sums))),
      h('p', { class: 'muted small', text: '損益の科目は「対象外」も表示します（課税の経費が対象外になっていないかの確認用）。科目名を押すと元帳を開きます。' }),
      csvButton(() => taxByAccountCsv(r), 'tax-by-account'),
    ];
  }

  // ---- 月別推移 ----
  function monthly({ fromMonth, toMonth }) {
    const months = monthsInPeriod(period).filter((m) => m >= fromMonth && m <= toMonth);
    const r = taxMonthly({ journals: target(), period, months });
    if (!r.rows.length) return h('p', { class: 'empty', text: 'この期間に税区分のある仕訳はありません。' });
    const key = monthlyValue;
    const head = h('tr', {}, h('th', { scope: 'col', text: '税区分' }), months.map((m) => h('th', { scope: 'col', text: `${Number(m.slice(5))}月` })), h('th', { scope: 'col', text: '合計' }));
    const rows = r.rows.map((x) => h('tr', {}, h('th', { scope: 'row', class: 'mt-acc', text: x.label }), x[key].map((v) => amountCell('td', v, { blankZero: true })), amountCell('td', x.total[key])));
    if (key === 'tax') rows.push(h('tr', { class: 'mt-strong' }, h('th', { scope: 'row', text: '差引（参考）' }), r.netTax.map((v) => amountCell('td', v)), amountCell('td', r.netTaxTotal)));
    return [
      h(
        'div',
        { class: 'no-print' },
        segmented({
          name: '表示する金額',
          options: [
            { value: 'gross', label: '税込金額' },
            { value: 'tax', label: '消費税等（参考）' },
          ],
          value: key,
          onChange: (v) => ((monthlyValue = v), paint()),
        }),
      ),
      h('div', { class: 'table-wrap' }, h('table', { class: 'report monthly' }, h('thead', {}, head), h('tbody', {}, rows))),
      h('p', { class: 'muted small', text: '消費税等は月ごとに割り戻しています。合計の列は期間の税込金額から割り戻すため、月の合計と1円単位でずれることがあります。' }),
      csvButton(() => taxMonthlyCsv(r), 'tax-monthly'),
    ];
  }

  // ---- チェックリスト ----
  function checks({ from, to }) {
    const list = taxChecks({ journals: target(), accounts, from, to, includeDefaultDiff: showInfo });
    const warn = list.filter((x) => x.level === 'warn').length;
    return [
      h('div', { class: 'option-bar no-print' }, infoToggle),
      h('p', { class: `check-line ${warn ? 'ng' : 'ok'}`, text: warn ? `誤りの可能性がある明細が ${warn}件 あります` : '誤りの可能性が高い明細はありません' }),
      list.length
        ? h(
            'ul',
            { class: 'menu-group tax-checks' },
            list.map((x) =>
              h(
                'li',
                {},
                h(
                  'a',
                  { class: `acc-row tax-check ${x.level}`, href: `#/journal/${encodeURIComponent(x.journal.id)}/edit` },
                  h(
                    'span',
                    { class: 'acc-main' },
                    h('span', { class: 'acc-title', text: `${x.level === 'warn' ? '⚠ ' : ''}${x.message}` }),
                    h('span', { class: 'muted small', text: `${slash(x.journal.date)}　No.${x.journal.no ?? ''}　${x.line.side === 'debit' ? '借方' : '貸方'} ${x.account.name}　${yen(x.line.amount)}円` }),
                    h('span', { class: 'muted small', text: `税区分：${labelOf(x.line.taxCategory)}${x.type === 'default_diff' ? `（科目の初期値：${labelOf(x.account.defaultTaxCategory)}）` : ''}${x.line.memo ? `　${x.line.memo}` : ''}` }),
                  ),
                ),
              ),
            ),
          )
        : null,
      h('p', { class: 'muted small', text: '決めつけではなく、確認の目安です。返品・値引きを費用や売上のマイナスで処理した場合などは、そのままで問題ないこともあります。明細を押すと仕訳を開きます。' }),
    ];
  }

  function paint() {
    const range = picker.range();
    const view = { summary, account: byAccount, monthly, check: checks }[tab];
    put(body, view(range));
  }

  put(
    outlet,
    settings.taxStatus === 'exempt' ? h('div', { class: 'notice', text: '免税事業者として設定されています。参考表示です。' }) : null,
    h('div', { class: 'no-print' }, tabs),
    picker.el,
    h('div', { class: 'option-bar no-print' }, adjToggle),
    body,
    h(
      'div',
      { class: 'panel small muted' },
      h('p', { text: '売上は貸方、仕入・経費は借方をプラスとして集計しています。売上の返品・値引き・貸倒れは借方、仕入の返品・値引き・貸倒れの回収は貸方がプラスです。輸入の消費税・地方消費税は金額そのものを税額としています。' }),
      h('p', { text: '参考値は、税込金額×100/110（軽減税率は100/108）を税抜金額とし、うち国税は税込金額×7.8/110（軽減は6.24/108）で計算しています（いずれも1円未満切り捨て）。' }),
      h('p', {}, '申告書の計算ではありません。納める税額は ', h('a', { class: 'link', href: '#/reports/tax-return', text: '消費税の申告計算' }), ' で確認できます（インボイスのない仕入の経過措置・簡易課税・2割特例などに対応）。'),
      h('p', { text: '出典：国税庁 タックスアンサー No.6383「課税標準額に対する消費税額の計算」、No.6391「課税仕入れに係る消費税額の計算」、No.6359・6363（対価の返還等）、No.6367（貸倒れ）' }),
    ),
  );
  paint();
}
