// 源泉徴収票・給与支払報告書の一覧：年分ごとに、給与を支払った人の源泉徴収票・提出の要否、法定調書合計表の欄、市区町村ごとの人数
import { h, put, emptyState, saveFile } from '../ui.js';
import { formatYen } from '../money.js';
import { toCsv, csvFileName } from '../csv.js';
import { todayString } from '../period.js';
import { EMPLOYEE_KIND_LABEL } from '../payroll.js';
import { withholdingSlips, slipTotals, slipsCsvRows, supportedSlipYears, slipDeadline, yearLabel, OMIT_LIMIT } from '../withholding-slip.js';

export async function render({ app, outlet, query }) {
  const [employees, payrolls, yearEnds] = await Promise.all([app.db.listEmployees(), app.db.listPayrolls(), app.db.listYearEnds()]);
  const today = todayString();
  const supported = supportedSlipYears();
  // 1月までは前の年分を出す（源泉徴収票は翌年1月31日までに交付・提出する）
  const defaultYear = Number(today.slice(0, 4)) - (today.slice(5, 7) <= '01' ? 1 : 0);
  let year = /^\d{4}$/.test(query.year || '') ? Number(query.year) : defaultYear;
  const body = h('div');
  const yearText = h('span', { class: 'month-label' });
  const move = (d) => {
    year += d;
    history.replaceState(history.state, '', `#/payroll/slips?year=${year}`);
    paint();
  };

  function card(s) {
    const e = employees.find((x) => x.id === s.employeeId);
    const badge = s.adjusted ? h('span', { class: 'badge badge-ok', text: '年末調整済み' }) : h('span', { class: 'badge', text: '年末調整なし' });
    const submit = s.omittable ? `提出を省略できる（退職者で${formatYen(OMIT_LIMIT)}円以下）` : `給与支払報告書を提出する（${s.city || '提出先の市区町村が未入力'}）`;
    return h(
      'li',
      {},
      h(
        'a',
        { class: 'pay-card', href: `#/payroll/slips/${s.employeeId}?year=${year}` },
        h('div', { class: 'pay-card-head' }, h('span', { text: EMPLOYEE_KIND_LABEL[e.kind] }), s.retired ? h('span', { text: '退職' }) : null, badge),
        h('div', { class: 'pay-card-body' }, h('span', { class: 'pay-name', text: s.name }), h('span', { class: 'pay-net num', text: `税額 ${formatYen(s.tax)}円` })),
        h('p', { class: 'muted small', text: `支払金額 ${formatYen(s.pay)}円　${submit}` }),
        s.warnings.length ? h('p', { class: 'small notice', text: `確かめること ${s.warnings.length}件：${s.warnings[0]}` }) : null,
      ),
    );
  }

  function totalsTable(t) {
    const row = (label, x, noTax) => h('tr', {}, h('th', { scope: 'row', text: label }), h('td', { class: 'num', text: `${x.count}人` }), h('td', { class: 'num', text: formatYen(x.pay) }), h('td', { class: 'num', text: formatYen(x.tax) }), h('td', { class: 'num', text: noTax == null ? '' : `${noTax}人` }));
    return h(
      'div',
      { class: 'table-wrap' },
      h(
        'table',
        { class: 'report ws-totals' },
        h('thead', {}, h('tr', {}, h('th', { scope: 'col', text: '区分' }), h('th', { scope: 'col', text: '人員' }), h('th', { scope: 'col', text: '支払金額' }), h('th', { scope: 'col', text: '源泉徴収税額' }), h('th', { scope: 'col', text: 'うち税額0円' }))),
        h('tbody', {}, row('Ⓐ 俸給、給与、賞与等の総額', t.a, t.a.noTax), row('Ⓑ 源泉徴収票を提出するもの', t.b, null)),
      ),
    );
  }

  function citiesTable(t) {
    return h(
      'div',
      { class: 'table-wrap' },
      h(
        'table',
        { class: 'report ws-cities' },
        h('thead', {}, h('tr', {}, h('th', { scope: 'col', text: '提出先' }), h('th', { scope: 'col', text: '報告人員' }), h('th', { scope: 'col', text: '特別徴収' }), h('th', { scope: 'col', text: '普通徴収（退職者）' }), h('th', { scope: 'col', text: '普通徴収（退職者を除く）' }))),
        h(
          'tbody',
          {},
          t.cities.map((c) => h('tr', {}, h('th', { scope: 'row', text: c.city || '（未入力）' }), h('td', { class: 'num', text: `${c.count}人` }), h('td', { class: 'num', text: `${c.special}人` }), h('td', { class: 'num', text: `${c.retired}人` }), h('td', { class: 'num', text: `${c.ordinary}人` }))),
        ),
      ),
    );
  }

  function paint() {
    yearText.textContent = yearLabel(year);
    const ok = supported.includes(year);
    const slips = ok ? withholdingSlips({ employees, payrolls, yearEnds, year }) : [];
    const t = slipTotals(slips);
    const csv = () => saveFile(new Blob([toCsv(slipsCsvRows(slips))], { type: 'text/csv' }), csvFileName(`withholding-slips-${year}`));
    if (!ok) {
      put(body, h('p', { class: 'notice small', text: `${yearLabel(year)}の源泉徴収票には対応していません（対応：${supported.map(yearLabel).join('・')}）。年末調整と同じ年分に対応します。` }));
      return;
    }
    if (!slips.length) {
      put(body, emptyState(`${year}年に給与を支払った人がいません。`, null, { title: '源泉徴収票' }));
      return;
    }
    const waiting = slips.filter((s) => !s.adjusted && s.warnings.some((w) => /年末調整/.test(w) && /確定/.test(w))).length;
    put(
      body,
      h(
        'dl',
        { class: 'pay-summary' },
        h('div', {}, h('dt', { text: '源泉徴収票' }), h('dd', { class: 'num', text: `${slips.length}人` })),
        h('div', {}, h('dt', { text: '給与支払報告書' }), h('dd', { class: 'num', text: `${t.b.count}人` })),
        h('div', {}, h('dt', { text: '期限' }), h('dd', { class: 'num', text: slipDeadline(year).slice(5).replace(/^0?(\d+)-0?(\d+)$/, '$1月$2日') })),
      ),
      waiting ? h('p', { class: 'notice small', text: `年末調整がまだ確定していない人が${waiting}人います。年末調整をする人は、先に年末調整を確定してください（給与計算 › 年末調整）。` }) : null,
      h('ul', { class: 'pay-list' }, slips.map(card)),
      h('div', { class: 'report-tools no-print' }, h('a', { class: 'btn', href: `#/payroll/slips/all?year=${year}`, text: '全員分をまとめて印刷' }), h('button', { type: 'button', class: 'btn', text: 'CSVで書き出す', onclick: csv })),
      h('h2', { class: 'section-title', text: '法定調書合計表（給与所得の源泉徴収票合計表）' }),
      totalsTable(t),
      h('p', { class: 'small muted', text: 'Ⓐは提出を省略する人も含めた全員の金額で、就職する前のほかの支払者の分は含めません（年末調整の超過額が徴収した税額より多い人は0円）。Ⓑは源泉徴収票を提出する人の金額で、前職分を含めます。' }),
      h('p', { class: 'small notice', text: '給与支払報告書を市区町村に提出して、税務署に源泉徴収票を提出しない場合（源泉徴収票のみなし提出の特例）は、合計表のこの欄は書かなくてよいとされています（国税庁「法定調書合計表の記載要領」）。' }),
      h('h2', { class: 'section-title', text: '給与支払報告書の提出先（総括表の人数）' }),
      t.b.count ? citiesTable(t) : h('p', { class: 'small muted', text: '提出する人がいません。' }),
      t.omitted ? h('p', { class: 'small muted', text: `退職者で支払金額が${formatYen(OMIT_LIMIT)}円以下の${t.omitted}人は含めていません（提出を省略できます）。` }) : null,
    );
  }

  put(
    outlet,
    h('div', { class: 'month-bar month-bar-plain' }, h('button', { type: 'button', class: 'btn btn-small', 'aria-label': '前の年', text: '‹', onclick: () => move(-1) }), yearText, h('button', { type: 'button', class: 'btn btn-small', 'aria-label': '次の年', text: '›', onclick: () => move(1) })),
    body,
    h(
      'div',
      { class: 'panel small' },
      h('p', { text: '源泉徴収票は、その年に給与を支払った全員に、翌年1月31日まで（年の途中で退職した人には退職の日から1か月以内）に交付します。給与支払報告書は、翌年1月1日現在の住所の市区町村に、翌年1月31日までに提出します（土日のときは翌日）。' }),
      h('p', { text: `令和8年分からは、提出する範囲が「年の途中で退職した人で支払金額が${formatYen(OMIT_LIMIT)}円以下の人」を除く全員になり、税務署に出す源泉徴収票と市区町村に出す給与支払報告書の範囲が同じになりました。令和9年1月からは、給与支払報告書を市区町村に提出すれば、税務署に源泉徴収票を提出したものとみなされます（源泉徴収票のみなし提出の特例。国税庁 No.7411）。` }),
      h('p', { text: '年末調整をした人は、年末調整の結果（前職分を含む）で作ります。年末調整をしていない人（年の途中で退職した人・乙欄の人など）は、支払った給与と徴収した税額で作ります。マイナンバーは保存していないため、給与支払報告書の個人番号は書き足すか、eLTAX などで入力してください。' }),
    ),
  );
  paint();
}
