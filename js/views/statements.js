// 損益計算書・貸借対照表（個人/法人で様式を切り替える）。前期比較（増減額・増減率）も出せる
import { h, put, amountCell } from '../ui.js';
import { buildStatements, balanceSheet } from '../statements.js';
import { openingDiff } from '../ledger.js';
import { compareStatement, hideZeroRows, openingRows, formatPermille } from '../compare.js';
import { formatPeriod } from '../period.js';
import { formatYen } from '../money.js';
import { isWhite } from '../white-return.js';
import { zeroToggle, openingWarning, statementRows, loadPrevious } from './report-common.js';
import { statementDoc, docHead } from '../print-forms.js';
import { warekiText } from '../print-layout.js';

const slash = (d) => d.replaceAll('-', '/');

export async function render({ app, outlet, route, query }) {
  const { settings, period, accounts, journals } = await app.load();
  const individual = settings.entityType === 'individual';
  const isPl = route.kind === 'pl';
  const white = isWhite(settings);
  const { pl, bs } = buildStatements({ entityType: settings.entityType, accounts, period, journals, white });
  // 前期：損益計算書は前期の帳簿、貸借対照表は当期の期首残高（前期末の残高を繰り越したもの）
  const previous = isPl ? await loadPrevious(app, period) : null;
  const prevPl = previous ? buildStatements({ entityType: settings.entityType, accounts, period: previous.period, journals: previous.journals, white }).pl : null;
  const prevBs = isPl ? null : balanceSheet(settings.entityType, openingRows({ accounts, period }), 0, { white });
  const labels = isPl ? ['当期', '前期'] : individual ? ['期末', '期首'] : ['当期末', '前期末'];

  let showZero = false;
  let compare = query.compare === '1';
  const body = h('div');
  const zero = zeroToggle((v) => ((showZero = v), paint()));
  const compareInput = h('input', {
    type: 'checkbox',
    checked: compare,
    onchange: (e) => {
      compare = e.target.checked;
      history.replaceState(history.state, '', `#/reports/${route.kind}${compare ? '?compare=1' : ''}`);
      paint();
    },
  });
  const compareToggle = h('label', { class: 'check small' }, compareInput, isPl ? '前期と比べる' : `${labels[1]}と比べる`);

  const table = (caption, items) => h('div', { class: 'table-wrap' }, h('table', { class: 'report statement' }, h('caption', { text: caption }), h('tbody', {}, statementRows(items, showZero))));
  const dash = () => h('td', { class: 'num muted', text: '—' });
  const compareTable = (caption, items, prevItems) => {
    let rows = compareStatement(items, prevItems, { skipPreviousNotes: !isPl });
    if (!showZero) rows = hideZeroRows(rows);
    return h(
      'div',
      { class: 'table-wrap' },
      h(
        'table',
        { class: 'report statement compare' },
        h('caption', { text: caption }),
        h('thead', {}, h('tr', {}, h('th', { text: '科目' }), h('th', { class: 'num', text: labels[0] }), h('th', { class: 'num', text: labels[1] }), h('th', { class: 'num', text: '増減（率）' }))),
        h(
          'tbody',
          {},
          rows.map((r) => {
            if (r.kind === 'group') return h('tr', { class: `st-group ${r.level === 2 ? 'level2' : ''}` }, h('th', { colspan: 4, text: r.label }));
            const cls = { subtotal: r.plain ? 'st-line' : `st-subtotal ${r.strong ? 'strong' : ''} ${r.heading ? 'heading' : ''}`, total: 'st-total', note: 'st-note', line: 'st-line' }[r.kind];
            return h(
              'tr',
              { class: cls },
              h('th', { text: r.label }),
              amountCell('td', r.current),
              r.previous == null ? dash() : amountCell('td', r.previous),
              r.diff == null ? dash() : h('td', { class: `num diff ${r.diff < 0 ? 'neg' : ''}` }, h('span', { text: formatYen(r.diff) }), h('span', { class: 'rate', text: formatPermille(r.rate) })),
            );
          }),
        ),
      ),
    );
  };

  // 印刷：報告式の決算書の様式（前期と比べる表は画面の表から作る）
  app.printDoc = ({ printedAt }) => {
    const head = docHead({ settings, period, printedAt });
    if (!isPl) head.period = `${warekiText(period.endDate)} 現在`;
    if (compare) return { title: route.title, ...head };
    const right = individual ? '負債・資本の部' : '負債・純資産の部';
    return isPl
      ? statementDoc([{ caption: individual ? '損益計算書（青色申告決算書の並び）' : '', items: pl.items }], { head, title: route.title, showZero })
      : statementDoc([{ caption: '資産の部', items: bs.assets }, { caption: right, items: bs.liabilities }], { head, title: route.title, showZero });
  };

  function paint() {
    if (isPl) {
      const caption = individual ? '損益計算書（青色申告決算書の並び）' : '損益計算書';
      if (!compare) return put(body, table(caption, pl.items));
      return put(
        body,
        prevPl
          ? h('p', { class: 'muted small', text: `前期：${formatPeriod(previous.period)}` })
          : h('p', { class: 'notice', text: 'このアプリに前期の帳簿がないため、前期の列は空欄です。前期を締めて「次の期間へ繰り越す」で作った期間なら比べられます。' }),
        compareTable(caption, pl.items, prevPl?.items ?? null),
      );
    }
    const balance = h(
      'p',
      { class: `check-line ${bs.balanced ? 'ok' : 'ng'}` },
      bs.balanced
        ? `資産合計 ${formatYen(bs.totalAssets)}円 ＝ ${individual ? '負債・資本合計' : '負債・純資産合計'}`
        : `資産合計と${individual ? '負債・資本合計' : '負債・純資産合計'}が一致しません（差額 ${formatYen(bs.totalAssets - bs.totalLiabilitiesAndEquity)}円）`,
    );
    const right = individual ? '負債・資本の部' : '負債・純資産の部';
    if (!compare) return put(body, balance, table('資産の部', bs.assets), table(right, bs.liabilities));
    put(
      body,
      balance,
      h('p', { class: 'muted small', text: `${labels[1]}は ${slash(period.startDate)} の期首残高（前期末の残高）です。${individual ? '期首の事業主貸・事業主借は0、所得は期末の列だけに入ります。' : '前期末の繰越利益剰余金には前期の当期純利益が含まれます。'}` }),
      compareTable('資産の部', bs.assets, prevBs.assets),
      compareTable(right, bs.liabilities, prevBs.liabilities),
    );
  }

  put(
    outlet,
    h('p', { class: 'muted small', text: `${settings.businessName}　${isPl ? formatPeriod(period) : `${slash(period.endDate)} 現在`}` }),
    openingWarning(individual ? 0 : openingDiff(period, accounts)),
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
