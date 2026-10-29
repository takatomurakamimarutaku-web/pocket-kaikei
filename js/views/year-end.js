// 年末調整の一覧：年分ごとに、給与を支払った人の年末調整の状態・年調年税額・過不足額
import { h, put, emptyState, saveFile } from '../ui.js';
import { formatYen } from '../money.js';
import { toCsv, csvFileName } from '../csv.js';
import { todayString } from '../period.js';
import { EMPLOYEE_KIND_LABEL } from '../payroll.js';
import { yearEndCalc, snapshotChanges, supportedYearEndYears, yearEndCsvRows, YEAR_END_STATUS } from '../year-end.js';

const reiwa = (y) => (y >= 2019 ? `令和${y - 2018 === 1 ? '元' : y - 2018}年分` : `${y}年分`);

/** 過不足額の表示（＋は徴収、−は還付） */
export function diffLabel(diff) {
  if (!diff) return '過不足なし';
  return diff > 0 ? `徴収 ${formatYen(diff)}円` : `還付 ${formatYen(-diff)}円`;
}

export async function render({ app, outlet, query }) {
  const [employees, payrolls, yearEnds] = await Promise.all([app.db.listEmployees(), app.db.listPayrolls(), app.db.listYearEnds()]);
  const today = todayString();
  const supported = supportedYearEndYears();
  const defaultYear = Number(today.slice(0, 4)) - (today.slice(5, 7) <= '01' ? 1 : 0);
  let year = /^\d{4}$/.test(query.year || '') ? Number(query.year) : defaultYear;
  const body = h('div');
  const yearLabel = h('span', { class: 'month-label' });
  const move = (d) => {
    year += d;
    history.replaceState(history.state, '', `#/payroll/year-end?year=${year}`);
    paint();
  };

  /** その年に給与を支払った人と、年末調整の記録がある人 */
  function rows() {
    const ids = new Set([...payrolls.filter((p) => p.payDate.startsWith(`${year}-`)).map((p) => p.employeeId), ...yearEnds.filter((x) => x.year === year).map((x) => x.employeeId)]);
    return employees
      .filter((e) => ids.has(e.id))
      .map((e) => {
        const ye = yearEnds.find((x) => x.employeeId === e.id && x.year === year) || null;
        const live = supported.includes(year) ? yearEndCalc(ye || { employeeId: e.id, year }, { payrolls, employee: e }) : null;
        const result = ye && ye.status !== 'draft' ? ye.result : live;
        const changed = ye && ye.status !== 'draft' && live ? snapshotChanges(ye.result, live) : [];
        return { e, ye, live, result, changed };
      });
  }

  function card({ e, ye, live, result, changed }) {
    const href = ye ? `#/payroll/year-end/${ye.id}` : `#/payroll/year-end/new?employee=${e.id}&year=${year}`;
    const status = ye ? YEAR_END_STATUS[ye.status] : '未入力';
    const badge = !ye ? 'badge' : ye.status === 'draft' ? 'badge badge-warn' : 'badge badge-ok';
    let sub;
    if (!ye && live && !live.eligible) sub = live.reasons[0];
    else if (!ye) sub = '申告書の内容を入力してください';
    else if (result?.lines) sub = `年調年税額 ${formatYen(result.annualTax)}円　徴収済み ${formatYen(result.withheld)}円`;
    else sub = result?.reasons?.[0] ?? '';
    return h(
      'li',
      {},
      h(
        'a',
        { class: 'pay-card', href },
        h('div', { class: 'pay-card-head' }, h('span', { text: EMPLOYEE_KIND_LABEL[e.kind] }), e.active ? null : h('span', { text: '退職' }), h('span', { class: badge, text: status })),
        h('div', { class: 'pay-card-body' }, h('span', { class: 'pay-name', text: e.name }), ye && result?.lines && result.eligible !== false ? h('span', { class: 'pay-net num', text: diffLabel(result.diff) }) : null),
        h('p', { class: 'muted small', text: sub }),
        changed.length ? h('p', { class: 'small notice', text: `確定した後に${changed.map((c) => c.label).join('・')}が変わっています` }) : null,
      ),
    );
  }

  function paint() {
    yearLabel.textContent = reiwa(year);
    const list = rows();
    const done = list.filter((x) => x.ye && x.ye.status !== 'draft');
    const sum = (f) => done.reduce((s, x) => s + f(x.ye.result.diff), 0);
    const csv = () => {
      const data = yearEndCsvRows(list.filter((x) => x.ye && x.result?.lines).map((x) => ({ ye: x.ye, name: x.e.name, result: x.result })));
      saveFile(new Blob([toCsv(data)], { type: 'text/csv' }), csvFileName(`year-end-${year}`));
    };
    put(
      body,
      supported.includes(year) ? null : h('p', { class: 'notice small', text: `${reiwa(year)}の年末調整の計算には対応していません（対応：${supported.map(reiwa).join('・')}）。新しい年分は、国税庁の「年末調整のしかた」が公表されてから対応します。` }),
      list.length
        ? h(
            'div',
            {},
            h(
              'dl',
              { class: 'pay-summary' },
              h('div', {}, h('dt', { text: '確定' }), h('dd', { class: 'num', text: `${done.length}/${list.length}人` })),
              h('div', {}, h('dt', { text: '徴収する額' }), h('dd', { class: 'num', text: `${formatYen(sum((d) => Math.max(0, d)))}円` })),
              h('div', {}, h('dt', { text: '還付する額' }), h('dd', { class: 'num', text: `${formatYen(sum((d) => Math.max(0, -d)))}円` })),
            ),
            h('ul', { class: 'pay-list' }, list.map(card)),
            done.length ? h('div', { class: 'report-tools no-print' }, h('button', { type: 'button', class: 'btn', text: 'この年分の結果をCSVで書き出す', onclick: csv }), h('a', { class: 'btn', href: `#/payroll/slips?year=${year}`, text: '源泉徴収票を作る' })) : null,
          )
        : emptyState(`${year}年に給与を支払った人がいません。`, null, { title: '年末調整' }),
    );
  }

  put(
    outlet,
    h('div', { class: 'month-bar month-bar-plain' }, h('button', { type: 'button', class: 'btn btn-small', 'aria-label': '前の年', text: '‹', onclick: () => move(-1) }), yearLabel, h('button', { type: 'button', class: 'btn btn-small', 'aria-label': '次の年', text: '›', onclick: () => move(1) })),
    body,
    h(
      'div',
      { class: 'panel small' },
      h('p', { text: '年末調整は、その年の最後の給与を支払うときに、1年分の給与と、従業員から受け取った申告書（扶養控除等申告書・基礎控除申告書兼配偶者控除等申告書兼特定親族特別控除申告書・保険料控除申告書・住宅借入金等特別控除申告書）の内容で年税額を計算し、毎月の源泉所得税との差を精算する手続です。' }),
      h('p', { text: '手順：①従業員ごとに申告書の内容を入力 → ②確定 → ③12月の給与（仕訳を登録する前）か翌年1月の給与で精算 → ④その給与の仕訳を登録。精算した不足額・超過額は、源泉所得税の納付の集計に「年末調整による不足税額・超過税額」として入ります。' }),
      h('p', { text: '令和8年分は、基礎控除の引上げ（合計所得金額489万円以下は104万円）、給与所得控除の最低額の引上げ（74万円）、扶養親族などの所得要件の引上げ（62万円以下）、23歳未満の扶養親族がいる人の生命保険料控除の上乗せが入っています（国税庁「令和8年分 年末調整のしかた」）。' }),
    ),
  );
  paint();
}
