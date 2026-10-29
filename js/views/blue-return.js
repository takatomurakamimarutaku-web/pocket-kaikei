// 青色申告決算書（一般用）：4ページの各欄を様式の並びで表示する（確定申告書等作成コーナー・e-Tax に転記する数字）
import { h, put, field, segmented, amountCell } from '../ui.js';
import { blueIncomeStatement, monthlySalesPurchases, depreciationTable, blueBalanceSheet, blueDeductionOptions, blueDeductionFor, blueDeductionReplaced } from '../blue-return.js';
import { formatYen } from '../money.js';
import { formatPeriod } from '../period.js';

const MARU = '⓪①②③④⑤⑥⑦⑧⑨⑩⑪⑫⑬⑭⑮⑯⑰⑱⑲⑳㉑㉒㉓㉔㉕㉖㉗㉘㉙㉚㉛㉜㉝㉞㉟㊱㊲㊳㊴㊵㊶㊷㊸㊹㊺';
const maru = (n) => MARU[n] || String(n);

export async function render({ app, outlet, query }) {
  const { settings, period, accounts, journals } = await app.load();
  if (settings.entityType !== 'individual') {
    put(outlet, h('p', { class: 'empty', text: '青色申告決算書は個人事業主の様式です。法人は損益計算書・貸借対照表をご利用ください。' }), h('a', { href: '#/reports', class: 'btn', text: '帳票へ' }));
    return;
  }
  const [assets, periods] = await Promise.all([app.db.listAssets(), app.db.listPeriods()]);
  const year = Number(period.endDate.slice(0, 4));
  const saved = period.blueReturn?.deduction;
  let deduction = blueDeductionFor(year, saved ?? 650000);
  let page = ['1', '2', '3', '4'].includes(query.page) ? query.page : '1';
  const body = h('div');

  const row = (no, label, amount, { strong = false, sub = '' } = {}) =>
    h('tr', { class: strong ? 'mt-strong' : '' }, h('td', { class: 'br-no', text: no ? maru(no) : '' }), h('th', { scope: 'row' }, label, sub ? h('span', { class: 'muted small block', text: sub }) : null), amountCell('td', amount));
  const table = (caption, rows, head = null) => h('div', { class: 'table-wrap' }, h('table', { class: 'report blue-return' }, caption ? h('caption', { text: caption }) : null, head, h('tbody', {}, rows)));

  function page1(is) {
    const L = is.lines;
    const named = (e) => (e.name && e.name !== e.label ? `帳簿の科目：${e.name}` : '');
    return [
      table('売上原価', [
        row(1, '売上（収入）金額（雑収入を含む）', L[1], { strong: true }),
        row(2, '期首商品（製品）棚卸高', L[2]),
        row(3, '仕入金額（製品製造原価）', L[3]),
        row(4, '小計（②＋③）', L[4]),
        row(5, '期末商品（製品）棚卸高', L[5]),
        row(6, '差引原価（④−⑤）', L[6]),
        row(7, '差引金額（①−⑥）', L[7], { strong: true }),
      ]),
      table('経費', [
        ...is.expenses.map((e) => row(e.no, e.label || '（空欄）', e.amount, { sub: e.no === 31 && is.overflow.length ? `空欄の行に入りきらない ${is.overflow.map((o) => o.name).join('・')} を含む` : named(e) })),
        row(32, '計', L[32], { strong: true }),
        row(33, '差引金額（⑦−㉜）', L[33], { strong: true }),
      ]),
      table('各種引当金・準備金等', [
        ...is.reversal.map((x) => row(x.no, `繰戻額等：${x.name}`, x.amount)),
        row(37, '繰戻額等の計', L[37]),
        row(38, '専従者給与', L[38]),
        ...is.provision.map((x) => row(x.no, `繰入額等：${x.name}`, x.amount)),
        row(42, '繰入額等の計', L[42]),
      ]),
      table('所得金額', [
        row(43, '青色申告特別控除前の所得金額（㉝＋㊲−㊷）', L[43], { strong: true }),
        row(44, '青色申告特別控除額', L[44], { sub: L[44] < deduction ? '控除前の所得金額が限度' : '' }),
        row(45, '所得金額（㊸−㊹）', L[45], { strong: true }),
      ]),
    ];
  }

  function page2(is) {
    const m = monthlySalesPurchases({ accounts, period, journals });
    return [
      h(
        'div',
        { class: 'table-wrap' },
        h(
          'table',
          { class: 'report blue-return' },
          h('caption', { text: '月別売上（収入）金額及び仕入金額' }),
          h('thead', {}, h('tr', {}, h('th', { scope: 'col', text: '月' }), h('th', { scope: 'col', text: '売上（収入）金額' }), h('th', { scope: 'col', text: '仕入金額' }))),
          h(
            'tbody',
            {},
            m.months.map((x) => h('tr', {}, h('th', { scope: 'row', text: `${Number(x.month.slice(5))}月` }), amountCell('td', x.sales), amountCell('td', x.purchases))),
            h('tr', {}, h('th', { scope: 'row', text: '家事消費等' }), amountCell('td', 0, { blankZero: true }), h('td')),
            h('tr', {}, h('th', { scope: 'row', text: '雑収入' }), amountCell('td', m.misc), h('td')),
            h('tr', { class: 'mt-strong' }, h('th', { scope: 'row', text: '計' }), amountCell('td', m.salesTotal), amountCell('td', m.purchasesTotal)),
          ),
        ),
      ),
      m.salesTotal !== is.lines[1] || m.purchasesTotal !== is.lines[3] ? h('p', { class: 'notice', text: '月別の計が損益計算書の①・③と一致しません。' }) : null,
      h('p', { class: 'muted small', text: '家事消費（商品を自分で使った分）は、仕訳で売上に計上している場合は月別の金額に含まれます。' }),
      table('青色申告特別控除額の計算', [
        row(0, '控除前の所得金額（1ページの㊸）', is.lines[43]),
        row(0, '選んだ控除額', deduction),
        row(0, '青色申告特別控除額（少ない方）', is.lines[44], { strong: true }),
      ]),
      h('p', { class: 'muted small', text: '給料賃金・専従者給与・地代家賃・貸倒引当金の内訳は、帳簿から作らないため、確定申告書等作成コーナーで入力してください。' }),
    ];
  }

  function page3(is) {
    const t = depreciationTable({ assets, periods, period });
    const head = h('thead', {}, h('tr', {}, ['名称', '取得年月', '取得価額', '償却の基礎になる金額', '償却方法', '耐用年数', '償却率', '本年中の償却期間', '本年分の普通償却費', '事業専用割合', '本年分の必要経費算入額', '未償却残高', '摘要'].map((c) => h('th', { scope: 'col', text: c }))));
    const rows = t.rows.map((r) =>
      h(
        'tr',
        {},
        h('th', { scope: 'row', text: r.name }),
        h('td', { class: 'nowrap', text: r.acquired }),
        amountCell('td', r.cost),
        amountCell('td', r.base),
        h('td', { text: r.method }),
        h('td', { class: 'num', text: r.life ? `${r.life}年` : '' }),
        h('td', { class: 'num', text: r.rate }),
        h('td', { class: 'num', text: r.months }),
        amountCell('td', r.amount),
        h('td', { class: 'num', text: `${r.ratio}%` }),
        amountCell('td', r.business),
        amountCell('td', r.closing),
        h('td', { class: 'small', text: r.note }),
      ),
    );
    rows.push(h('tr', { class: 'mt-strong' }, h('th', { scope: 'row', text: '計' }), h('td', { colspan: 7 }), amountCell('td', t.total.amount), h('td'), amountCell('td', t.total.business), amountCell('td', t.total.closing), h('td')));
    return [
      t.rows.length ? h('p', { class: 'muted small no-print', text: '表は横にスクロールできます（償却方法・耐用年数・償却率・本年分の償却費・事業専用割合・未償却残高）。' }) : null,
      t.rows.length ? h('div', { class: 'table-wrap' }, h('table', { class: 'report blue-return br-wide' }, h('caption', { text: '減価償却費の計算' }), head, h('tbody', {}, rows))) : h('p', { class: 'muted small' }, '固定資産台帳に資産がありません。', h('a', { class: 'link', href: '#/assets', text: '固定資産台帳' })),
      t.total.business !== is.lines[18] ? h('p', { class: 'notice', text: `必要経費算入額の計（${formatYen(t.total.business)}円）と損益計算書の⑱減価償却費（${formatYen(is.lines[18])}円）が違います。決算・繰越の画面で減価償却の仕訳を確かめてください。` }) : null,
      h('p', { class: 'muted small', text: '利子割引料・税理士等の報酬の内訳、本年中における特殊事情は、確定申告書等作成コーナーで入力してください。' }),
    ];
  }

  function page4(is) {
    const bs = blueBalanceSheet({ accounts, period, journals, incomeBeforeDeduction: is.lines[43] });
    const start = `${Number(period.startDate.slice(5, 7))}月${Number(period.startDate.slice(8))}日（期首）`;
    const end = `${Number(period.endDate.slice(5, 7))}月${Number(period.endDate.slice(8))}日（期末）`;
    const side = (caption, list, openingTotal, closingTotal) =>
      h(
        'div',
        { class: 'table-wrap' },
        h(
          'table',
          { class: 'report blue-return' },
          h('caption', { text: caption }),
          h('thead', {}, h('tr', {}, h('th', { scope: 'col', text: '科目' }), h('th', { scope: 'col', text: start }), h('th', { scope: 'col', text: end }))),
          h(
            'tbody',
            {},
            list.map((x) => h('tr', {}, h('th', { scope: 'row' }, x.label, x.name && x.name !== x.label ? h('span', { class: 'muted small block', text: `帳簿の科目：${x.name}` }) : null, x.blank ? h('span', { class: 'muted small block', text: '空欄の行に記入' }) : null), x.opening === null ? h('td') : amountCell('td', x.opening, { blankZero: true }), amountCell('td', x.closing, { blankZero: true }))),
            h('tr', { class: 'mt-strong' }, h('th', { scope: 'row', text: '合計' }), amountCell('td', openingTotal), amountCell('td', closingTotal)),
          ),
        ),
      );
    return [
      side('資産の部', bs.assets, bs.totals.assetsOpening, bs.totals.assetsClosing),
      side('負債・資本の部', bs.liabilities, bs.totals.liabilitiesOpening, bs.totals.liabilitiesClosing),
      h('p', { class: `check-line ${bs.balanced ? 'ok' : 'ng'}`, text: bs.balanced ? '期首・期末とも、資産の部の合計＝負債・資本の部の合計' : '資産の部と負債・資本の部の合計が一致しません。期首残高と仕訳を確かめてください' }),
    ];
  }

  function paint() {
    history.replaceState(history.state, '', `#/reports/blue-return?page=${page}`);
    const is = blueIncomeStatement({ accounts, period, journals, deduction });
    // 4ページとも作り、画面では選んだページだけ見せる（印刷では全ページを1ページずつ出す）
    const pages = [page1, page2, page3, page4];
    const titles = ['損益計算書', '月別売上（収入）金額及び仕入金額', '減価償却費の計算', '貸借対照表（資産負債調）'];
    put(
      body,
      pages.map((fn, i) =>
        h('section', { class: `br-page${String(i + 1) === page ? '' : ' is-off'}` }, h('h2', { class: 'print-only br-page-title', text: `青色申告決算書（一般用）${i + 1}ページ　${titles[i]}` }), fn(is)),
      ),
    );
  }

  const deductionSelect = h(
    'select',
    {
      id: 'br-deduction',
      onchange: async (e) => {
        deduction = Number(e.target.value);
        paint();
        if (!period.closed) await app.db.saveBlueReturnSettings(period.id, { deduction }).catch(() => {});
      },
    },
    blueDeductionOptions(year).map((d) => h('option', { value: d.value, text: d.label, selected: d.value === deduction })),
  );

  put(
    outlet,
    h('p', { class: 'muted small no-print', text: `${formatPeriod(period)}・${settings.businessName}` }),
    h(
      'section',
      { class: 'panel no-print' },
      field('青色申告特別控除額', deductionSelect, {
        hint:
          year >= 2027
            ? '令和9年分以後：65万円は複式簿記で貸借対照表を添付し、期限内に e-Tax で申告する場合。75万円はさらに仕訳帳・総勘定元帳を優良な電子帳簿で保存する場合（その他メニューの「電子帳簿保存」を参照）。書面で提出すると10万円です'
            : '65万円・55万円は複式簿記で、貸借対照表を添付して期限内に申告する場合。65万円は e-Tax で申告するか、優良な電子帳簿で保存する場合です',
      }),
      blueDeductionReplaced(year, saved) ? h('p', { class: 'notice', text: `${year}年分には前に選んだ控除額の区分が無いため、65万円で計算しています。控除額を選び直してください。` }) : null,
      segmented({
        name: 'ページ',
        options: [
          { value: '1', label: '1 損益' },
          { value: '2', label: '2 月別' },
          { value: '3', label: '3 償却' },
          { value: '4', label: '4 貸借' },
        ],
        value: page,
        onChange: (v) => {
          page = v;
          paint();
        },
      }),
    ),
    body,
    h(
      'div',
      { class: 'panel small muted no-print' },
      h('p', { text: '国税庁の青色申告決算書（一般用）の欄の並びで集計しています。確定申告書等作成コーナーや e-Tax に転記するときの数字としてお使いください。' }),
      h('p', { text: '科目と欄の対応は勘定科目のテンプレートのコードで決めています。自分で追加した科目は空欄の行（経費は㉕〜㉚）に入ります。' }),
      h('p', { text: '出典：国税庁「令和7年分 青色申告決算書（一般用）の書き方」、「青色申告特別控除の見直し（令和9年分以後）」' }),
    ),
  );
  paint();
}
