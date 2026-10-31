// 損益計算書・貸借対照表（個人/法人で様式を切り替える）。前期比較（増減額・増減率）も出せる
// 損益計算書は期間（月・四半期・日付の範囲）、貸借対照表は時点（月末・日付）を選べる
import { h, put } from '../ui.js';
import { buildStatements, balanceSheet, incomeStatement, rangeRows } from '../statements.js';
import { openingDiff } from '../ledger.js';
import { compareIncomeRows, compareBalanceRows, openingRows } from '../compare.js';
import { addDays, addMonths, monthRange } from '../period.js';
import { formatYen, normalizeUnit, unitCaption } from '../money.js';
import { isWhite } from '../white-return.js';
import { zeroToggle, openingWarning, loadPrevious, unitPicker, unitPrintOptions, formatPicker, formatPrintOption, monthRangePicker, asOfPicker } from './report-common.js';
import { fsPaper, fsPeriod, incomeStatementByFormat, balanceSheetByFormat, compareTable } from './fs-view.js';
import { incomeStatementFormatDoc, balanceSheetAccountDoc, balanceSheetReportDoc, compareStatementDoc, docHead } from '../print-forms.js';
import { warekiText } from '../print-layout.js';

export async function render({ app, outlet, route, query }) {
  const { settings, period, accounts, journals } = await app.load();
  const individual = settings.entityType === 'individual';
  const isPl = route.kind === 'pl';
  const white = isWhite(settings);
  // 前期：損益計算書は前期の帳簿、貸借対照表は当期の期首残高（前期末の残高を繰り越したもの）
  const previous = isPl ? await loadPrevious(app, period) : null;
  const prevBs = isPl ? null : balanceSheet(settings.entityType, openingRows({ accounts, period }), 0, { white });

  let showZero = false;
  let compare = query.compare === '1';
  const extra = () => (compare ? { compare: '1' } : {});
  // 損益計算書：期間の範囲（期間全体・月・四半期・半期・日付）。貸借対照表：時点（期末・月末・日付）
  const picker = isPl ? monthRangePicker({ period, query, path: `/reports/${route.kind}`, onChange: () => paint(), extra }) : asOfPicker({ period, query, path: `/reports/${route.kind}`, onChange: () => paint(), extra });
  const range = () => (isPl ? picker.range() : { from: period.startDate, to: picker.value() });
  // 前期の同じ範囲：当期の初日から何か月目かで前期に当てはめる（期間全体なら前期の全体）
  function previousRange(r) {
    if (!previous) return null;
    const p = previous.period;
    if (r.from === period.startDate && r.to === period.endDate) return { from: p.startDate, to: p.endDate };
    const k = (Number(period.startDate.slice(0, 4)) - Number(p.startDate.slice(0, 4))) * 12 + Number(period.startDate.slice(5, 7)) - Number(p.startDate.slice(5, 7));
    const toEnd = monthRange(period, r.to.slice(0, 7), r.to.slice(0, 7)).to === r.to;
    const to = toEnd ? monthRange(p, addMonths(r.to, -k).slice(0, 7), addMonths(r.to, -k).slice(0, 7)).to : addMonths(r.to, -k);
    const from = addMonths(r.from, -k);
    return from > p.endDate || to < p.startDate ? null : { from: from < p.startDate ? p.startDate : from, to: to > p.endDate ? p.endDate : to };
  }
  let pl, bs, prevPl, prevRange;
  function compute() {
    const r = range();
    if (isPl) {
      pl = incomeStatement(settings.entityType, rangeRows({ accounts, period, journals, from: r.from, to: r.to }), { white });
      prevRange = previousRange(r);
      prevPl = prevRange ? incomeStatement(settings.entityType, rangeRows({ accounts, period: previous.period, journals: previous.journals, ...prevRange }), { white }) : null;
    } else bs = buildStatements({ entityType: settings.entityType, accounts, period, journals, to: r.to, white }).bs;
  }
  // 前期と比べる表の列の名前。貸借対照表を期末より前の時点で見るときは、その日付（例：6/30現在）
  const labels = () => {
    if (isPl) return ['当期', '前期'];
    const at = range().to;
    const current = at === period.endDate ? (individual ? '期末' : '当期末') : `${Number(at.slice(5, 7))}/${Number(at.slice(8))}現在`;
    return [current, individual ? '期首' : '前期末'];
  };
  const body = h('div');
  const zero = zeroToggle((v) => ((showZero = v), paint()));
  const unit = unitPicker({ key: route.path, onChange: () => paint() });
  // 様式：損益計算書は報告式、貸借対照表は勘定式を初めに選んでおく（決算書でよく使う形）。前期と比べる表は様式が決まっているので隠す
  const format = formatPicker({ key: route.path, value: isPl ? 'report' : 'account', onChange: () => paint() });
  const compareInput = h('input', {
    type: 'checkbox',
    checked: compare,
    onchange: (e) => {
      compare = e.target.checked;
      picker.refreshUrl();
      paint();
    },
  });
  const compareToggle = h('label', { class: 'check small' }, compareInput, isPl ? '前期と比べる' : `${labels()[1]}と比べる`);

  // 紙の決算書と同じ配置の表（印刷の様式と同じ行）
  const periodLine = () => {
    const r = range();
    return isPl ? fsPeriod.range({ startDate: r.from, endDate: r.to }) : fsPeriod.at(r.to);
  };
  const paper = (body) => fsPaper({ title: route.title, period: periodLine(), company: settings.businessName, unit: unitCaption(unit.value()), body });
  // 前期と比べる表：比較損益計算書・比較貸借対照表。前期の期間（貸借対照表は前期末・期首の日）を期間の下に書く
  const compareTitle = isPl ? '比較損益計算書' : '比較貸借対照表';
  const comparePeriod2 = () =>
    isPl ? (prevPl ? `（${labels()[1]}　${fsPeriod.range({ startDate: prevRange.from, endDate: prevRange.to })}）` : null) : `（${labels()[1]}　${warekiText(individual ? period.startDate : addDays(period.startDate, -1))}）`;
  const compareRows = (zero) =>
    isPl ? compareIncomeRows(pl.items, prevPl?.items ?? null, { entityType: settings.entityType, showZero: zero }) : compareBalanceRows(bs, prevBs, { entityType: settings.entityType, showZero: zero });

  // 印刷：決算書の体裁。勘定式（左右2段）と報告式を選べる。前期と比べる表は比較損益計算書・比較貸借対照表の様式
  app.printDoc = ({ printedAt }) => {
    const r = range();
    const head = docHead({ settings, period, from: r.from, to: r.to, printedAt });
    if (!isPl) head.period = `${warekiText(r.to)} 現在`;
    return {
      options: [
        compare ? null : formatPrintOption({ value: format.value() }),
        { key: 'orientation', label: '用紙の向き', type: 'select', choices: [['portrait', 'A4縦'], ['landscape', 'A4横']], value: 'portrait' },
        { key: 'zero', label: '0円の科目も出す', type: 'check', value: showZero },
        ...unitPrintOptions(unit.value()),
      ].filter(Boolean),
      build: (v) => {
        const opts = { head, title: route.title, entityType: settings.entityType, showZero: v.zero, unit: normalizeUnit(v), orientation: v.orientation };
        if (compare) return compareStatementDoc(compareRows(v.zero), { head, title: compareTitle, labels: labels(), period2: comparePeriod2(), unit: opts.unit, orientation: v.orientation });
        if (isPl) return incomeStatementFormatDoc(pl.items, { ...opts, format: v.format });
        return v.format === 'account' ? balanceSheetAccountDoc(bs, opts) : balanceSheetReportDoc(bs, opts);
      },
    };
  };

  const comparePaper = () =>
    fsPaper({ title: compareTitle, period: periodLine(), period2: comparePeriod2(), company: settings.businessName, unit: unitCaption(unit.value()), body: compareTable(compareRows(showZero), { labels: labels(), label: compareTitle }) });

  function paint() {
    compute();
    format.el.hidden = compare;
    if (isPl) {
      if (!compare)
        return put(
          body,
          paper(incomeStatementByFormat(pl.items, { format: format.value(), entityType: settings.entityType, showZero })),
          format.value() === 'account' ? h('p', { class: 'muted small', text: `勘定式は、左に費用と${individual ? '所得金額' : '当期純利益'}、右に収益を並べて合計をそろえます。段階利益（${individual ? '差引金額' : '売上総利益・営業利益・経常利益など'}）は報告式で確認できます。` }) : null,
          individual ? h('p', { class: 'muted small', text: '科目の並びは青色申告決算書（収支内訳書）の損益計算書に合わせています。' }) : null,
        );
      return put(
        body,
        prevPl ? null : h('p', { class: 'notice', text: 'このアプリに前期の帳簿がないため、前期の列は空欄です。前期を締めて「次の期間へ繰り越す」で作った期間なら比べられます。' }),
        prevPl && !range().whole ? h('p', { class: 'muted small', text: '前期の列は、前期の同じ月・日の範囲の金額です。' }) : null,
        comparePaper(),
        individual ? h('p', { class: 'muted small', text: '科目の並びは青色申告決算書（収支内訳書）の損益計算書に合わせています。' }) : null,
      );
    }
    const balance = h(
      'p',
      { class: `check-line ${bs.balanced ? 'ok' : 'ng'}` },
      bs.balanced
        ? `資産合計 ${formatYen(bs.totalAssets)}円 ＝ ${individual ? '負債・資本合計' : '負債・純資産合計'}`
        : `資産合計と${individual ? '負債・資本合計' : '負債・純資産合計'}が一致しません（差額 ${formatYen(bs.totalAssets - bs.totalLiabilitiesAndEquity)}円）`,
    );
    if (!compare) return put(body, balance, paper(balanceSheetByFormat(bs, { format: format.value(), entityType: settings.entityType, showZero })));
    put(
      body,
      balance,
      comparePaper(),
      h('p', { class: 'muted small', text: `${labels()[1]}の列は、この期間の期首残高（前期末の残高を繰り越したもの）です。${individual ? '期首の事業主貸・事業主借は0、所得は期末の列だけに入ります。' : '前期末の繰越利益剰余金には前期の当期純利益が含まれます。'}` }),
    );
  }

  put(
    outlet,
    openingWarning(individual ? 0 : openingDiff(period, accounts)),
    picker.el,
    unit.el,
    format.el,
    h('div', { class: 'toggles' }, zero.el, compareToggle),
    body,
    h(
      'p',
      { class: 'muted small' },
      '決算整理（棚卸・減価償却・家事按分など）は ',
      h('a', { href: '#/closing', class: 'link', text: '決算・繰越' }),
      ' から登録できます。',
      individual && isPl ? (white ? ['専従者控除と所得金額は ', h('a', { href: '#/reports/white-return', class: 'link', text: '収支内訳書' }), ' で計算します。'] : ['青色申告特別控除と所得金額は ', h('a', { href: '#/reports/blue-return', class: 'link', text: '青色申告決算書' }), ' で計算します。']) : null,
      ' 指標は ',
      h('a', { href: '#/reports/analysis', class: 'link', text: '経営分析' }),
      ' で見られます。',
    ),
  );
  paint();
}
