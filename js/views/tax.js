// 消費税の税区分別集計（税込経理。割り戻しの参考値）
import { h, put, amountCell } from '../ui.js';
import { summarizeTax, CORE_TAX_CODES } from '../tax.js';
import { monthRangePicker } from './report-common.js';

export async function render({ app, outlet, query }) {
  const { settings, period, journals } = await app.load();
  const body = h('div');
  const picker = monthRangePicker({ period, query, path: '/reports/tax', onChange: paint });

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
            h('tr', {}, h('th', {}, r.label, h('span', { class: 'muted small block', text: `${r.count}件${r.tax ? `・うち国税 ${r.national.toLocaleString('ja-JP')}円` : ''}` })), amountCell('td', r.gross), amountCell('td', r.net), amountCell('td', r.tax, { blankZero: true })),
          ),
        ),
        h('tfoot', {}, h('tr', {}, h('th', { text: '計' }), amountCell('td', total.gross), h('td'), amountCell('td', total.tax))),
      ),
    );
  }

  function paint() {
    const { from, to } = picker.range();
    const s = summarizeTax(journals, { from, to });
    // 使っている税区分（と主な4区分）だけを出す。行の無いグループは出さない
    const groups = s.groups.map((g) => ({ ...g, rows: g.rows.filter((r) => r.count || CORE_TAX_CODES.includes(r.code)) })).filter((g) => g.rows.length);
    put(
      body,
      groups.map((g) => block(g.label, g.rows, g.total)),
      h('p', { class: 'small', text: `差引（売上の消費税等 ＋ 貸倒れの回収・仕入の返品の消費税等 − 仕入・輸入・売上の返品・貸倒れの消費税等）の参考値：${s.netTax.toLocaleString('ja-JP')}円` }),
    );
  }

  put(outlet, 
    settings.taxStatus === 'exempt' ? h('div', { class: 'notice', text: '免税事業者として設定されています。参考表示です。' }) : null,
    picker.el,
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
