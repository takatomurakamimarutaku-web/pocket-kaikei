// 消費税集計（税込経理。割り戻しの参考値）：税区分別・科目別税区分・月別推移・税区分のチェック
// 弥生会計の「消費税集計表」「科目別税区分表」、勘定奉行の科目別・税区分別の集計と確認を参考にした
import { h, put, amountCell, saveFile, segmented, stackTable } from '../ui.js';

/** スマホの2段表示で金額の前に出す見出し */
const TAX_LABELS = ['', '税込金額', '税抜（参考）', '消費税等（参考）'];
import { summarizeTax, CORE_TAX_CODES, TAX_BY_CODE } from '../tax.js';
import { taxByAccount, taxMonthly, taxChecks } from '../tax-reports.js';
import { isAdjusting } from '../monthly.js';
import { taxByAccountCsv, taxMonthlyCsv, csvFileName } from '../csv.js';
import { monthsInPeriod } from '../period.js';
import { monthRangePicker, dateRangeOptions, printRange } from './report-common.js';
import { docHead } from '../print-forms.js';
import { fmt } from '../print-layout.js';
import { journalLabel } from '../journal.js';

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
      stackTable(h(
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
      ), TAX_LABELS),
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
  function byAccount({ from, to, query: rq }) {
    const r = taxByAccount({ journals: target(), accounts, from, to });
    if (!r.rows.length) return h('p', { class: 'empty', text: 'この期間に税区分のある仕訳はありません。' });
    const head = h('tr', {}, ['科目・税区分', '税込金額', '税抜(参考)', '消費税等(参考)'].map((t) => h('th', { scope: 'col', text: t })));
    const rows = [];
    for (const row of r.rows) {
      const link = `#/reports/ledger?${new URLSearchParams({ account: row.account.id, ...rq })}`;
      rows.push(h('tr', { class: 'tb-group' }, h('th', { colspan: 4 }, h('a', { href: link, text: `${row.account.code} ${row.account.name}` }))));
      for (const x of row.items) {
        rows.push(h('tr', {}, h('th', { class: 'mt-acc' }, x.label, h('span', { class: 'muted small block', text: `${x.count}件` })), amountCell('td', x.gross), amountCell('td', x.net), amountCell('td', x.tax, { blankZero: true })));
      }
      if (row.items.length > 1) rows.push(h('tr', { class: 'tb-subtotal' }, h('th', { text: '科目計' }), amountCell('td', row.total.gross), amountCell('td', row.total.net), amountCell('td', row.total.tax, { blankZero: true })));
    }
    const sums = r.byCode.map((x) => h('tr', {}, h('th', { class: 'mt-acc', text: x.label }), amountCell('td', x.gross), amountCell('td', x.net), amountCell('td', x.tax, { blankZero: true })));
    return [
      h('div', { class: 'table-wrap' }, stackTable(h('table', { class: 'report taxsum tax-account' }, h('caption', { text: '科目別税区分集計表' }), h('thead', {}, head), h('tbody', {}, rows), h('tbody', {}, h('tr', { class: 'tb-group' }, h('th', { colspan: 4, text: '税区分ごとの合計' })), sums)), TAX_LABELS)),
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
                    h('span', { class: 'muted small', text: `${slash(x.journal.date)}　${journalLabel(x.journal)}　${x.line.side === 'debit' ? '借方' : '貸方'} ${x.account.name}　${yen(x.line.amount)}円` }),
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

  // 印刷：消費税集計表（税区分別・科目別税区分集計表・月別推移）。印刷条件：表の種類・期間・決算整理を含めるか
  app.printDoc = ({ printedAt }) => {
    const r0 = picker.range();
    return {
      options: [
        { key: 'kind', label: '集計表', type: 'select', choices: [['summary', '消費税集計表（税区分別）'], ['account', '科目別税区分集計表'], ['monthly', '税区分別の月別推移（税込金額）'], ['monthlyTax', '税区分別の月別推移（消費税等）']], value: tab === 'account' ? 'account' : tab === 'monthly' ? (monthlyValue === 'tax' ? 'monthlyTax' : 'monthly') : 'summary' },
        ...dateRangeOptions(period, r0),
        { key: 'adj', label: '決算整理の仕訳を含める', type: 'check', value: includeAdj },
      ],
      build: (v) => {
        const r = printRange(period, v);
        const js = v.adj ? journals : journals.filter((j) => !isAdjusting(j));
        const head = docHead({ settings, period, ...r, printedAt });
        const money = (n) => fmt(n);
        const blankMoney = (n) => (n ? fmt(n) : '');
        const cols4 = (first) => [{ label: first, grow: 1, min: 50 }, { label: '税込金額', align: 'right', w: 32 }, { label: '税抜金額（参考）', align: 'right', w: 32 }, { label: '消費税等（参考）', align: 'right', w: 32 }];
        if (v.kind === 'summary') {
          const sm = summarizeTax(js, { from: r.from, to: r.to });
          const blocks = [];
          for (const g of sm.groups) {
            const rows = g.rows.filter((x) => x.count || CORE_TAX_CODES.includes(x.code));
            if (!rows.length) continue;
            blocks.push({ type: 'heading', text: g.label }, { type: 'table', columns: [...cols4('税区分'), { label: '件数', align: 'right', w: 14 }], rows: [...rows.map((x) => ({ cells: [x.label, money(x.gross), money(x.net), blankMoney(x.tax), String(x.count)] })), { kind: 'total', cells: ['計', money(g.total.gross), '', money(g.total.tax), ''] }] });
          }
          blocks.push({ type: 'text', text: `差引（売上の消費税等 ＋ 貸倒れの回収・仕入の返品の消費税等 − 仕入・輸入・売上の返品・貸倒れの消費税等）の参考値：${money(sm.netTax)}円` });
          blocks.push({ type: 'text', text: '参考値は、税込金額×100/110（軽減税率は100/108）を税抜金額として計算しています（1円未満切り捨て）。申告書の計算ではありません。' });
          return { title: '消費税集計表', ...head, orientation: 'portrait', blocks };
        }
        if (v.kind === 'account') {
          const t = taxByAccount({ journals: js, accounts, from: r.from, to: r.to });
          const rows = [];
          for (const row of t.rows) {
            rows.push({ kind: 'group', cells: [{ text: `${row.account.code} ${row.account.name}`, span: 4 }] });
            for (const x of row.items) rows.push({ cells: [{ text: x.label, indent: 3 }, money(x.gross), money(x.net), blankMoney(x.tax)] });
            if (row.items.length > 1) rows.push({ kind: 'subtotal', cells: [{ text: '科目計', indent: 3 }, money(row.total.gross), money(row.total.net), blankMoney(row.total.tax)] });
          }
          const sums = t.byCode.map((x) => ({ cells: [{ text: x.label, indent: 3 }, money(x.gross), money(x.net), blankMoney(x.tax)] }));
          return { title: '科目別税区分集計表', ...head, orientation: 'portrait', blocks: [{ type: 'table', columns: cols4('勘定科目・税区分'), rows }, { type: 'heading', text: '税区分ごとの合計' }, { type: 'table', columns: cols4('税区分'), rows: sums }] };
        }
        const months = monthsInPeriod(period).filter((m) => m >= r.fromMonth && m <= r.toMonth);
        const t = taxMonthly({ journals: js, period, months });
        const key = v.kind === 'monthlyTax' ? 'tax' : 'gross';
        const rows = t.rows.map((x) => ({ cells: [x.label, ...x[key].map(blankMoney), money(x.total[key])] }));
        if (key === 'tax') rows.push({ kind: 'total', cells: ['差引（参考）', ...t.netTax.map(money), money(t.netTaxTotal)] });
        return {
          title: key === 'tax' ? '税区分別月別推移表（消費税等）' : '税区分別月別推移表（税込金額）',
          ...head,
          orientation: 'landscape',
          blocks: [{ type: 'table', columns: [{ label: '税区分', grow: 1, min: 30, max: 50 }, ...months.map((m) => ({ label: `${Number(m.slice(5))}月`, align: 'right' })), { label: '合計', align: 'right' }], rows }],
        };
      },
    };
  };

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
