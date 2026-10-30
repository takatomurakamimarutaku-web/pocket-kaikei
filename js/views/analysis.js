// 経営分析：収益性・安全性・効率性・損益分岐点の指標を当期と前期で並べる
import { h, put } from '../ui.js';
import { buildStatements, closingRows } from '../statements.js';
import { openingRows, formatPermille } from '../compare.js';
import { bsFigures, plFigures, indicators, formatMonths } from '../analysis.js';
import { formatPeriod, monthsInPeriod } from '../period.js';
import { formatYen } from '../money.js';
import { loadPrevious } from './report-common.js';
import { isWhite } from '../white-return.js';

const format = (unit, v) => (v == null ? '—' : unit === 'permille' ? formatPermille(v) : unit === 'months' ? formatMonths(v) : `${formatYen(v)}円`);

export async function render({ app, outlet }) {
  const { settings, period, accounts, journals } = await app.load();
  // 印刷は画面の表から作る。指標は％・か月・円が混ざるので、右上の「単位：円」は書かない
  app.printDoc = () => ({ unit: '' });
  const entityType = settings.entityType;
  const white = isWhite(settings);
  const { pl } = buildStatements({ entityType, accounts, period, journals });
  const current = indicators({ entityType, pl: plFigures(entityType, pl.profits), bs: bsFigures(closingRows({ accounts, period, journals })), months: monthsInPeriod(period).length, white });
  // 前期：損益は前期の帳簿（あれば）、残高は当期の期首残高（＝前期末）
  const previous = await loadPrevious(app, period);
  const prevPl = previous ? buildStatements({ entityType, accounts, period: previous.period, journals: previous.journals }).pl : null;
  const prior = indicators({
    entityType,
    pl: prevPl ? plFigures(entityType, prevPl.profits) : null,
    bs: bsFigures(openingRows({ accounts, period })),
    months: previous ? monthsInPeriod(previous.period).length : 12,
    white,
  });
  const noSales = pl.profits.sales <= 0;

  put(
    outlet,
    h('p', { class: 'muted small', text: `${settings.businessName}　当期 ${formatPeriod(period)}${previous ? `／前期 ${formatPeriod(previous.period)}` : ''}` }),
    noSales ? h('p', { class: 'notice', text: '当期の売上がまだないため、売上を使う指標は「—」になります。' }) : null,
    previous ? null : h('p', { class: 'muted small', text: 'このアプリに前期の帳簿がないため、前期の列は期首残高（前期末）から求められる指標（安全性と運転資本）だけを出します。' }),
    current.map((sec, si) =>
      h(
        'section',
        { class: 'panel analysis' },
        h('h2', { class: 'section-title', text: sec.title }),
        h(
          'div',
          { class: 'table-wrap' },
          h(
            'table',
            { class: 'report analysis-table' },
            h('thead', {}, h('tr', {}, h('th', { text: '指標' }), h('th', { class: 'num', text: '当期' }), h('th', { class: 'num', text: '前期' }))),
            h(
              'tbody',
              {},
              sec.items.map((it, i) => {
                const prev = prior[si].items[i];
                return h(
                  'tr',
                  {},
                  h('th', {}, h('span', { class: 'ind-label', text: it.label }), h('span', { class: 'ind-formula', text: it.formula })),
                  h('td', { class: `num ${it.value < 0 ? 'neg' : ''}`, text: format(it.unit, it.value) }),
                  h('td', { class: `num muted ${prev.value < 0 ? 'neg' : ''}`, text: format(prev.unit, prev.value) }),
                );
              }),
            ),
          ),
        ),
      ),
    ),
    h(
      'div',
      { class: 'panel' },
      h('h2', { class: 'section-title', text: '見方のめやす' }),
      h(
        'ul',
        { class: 'plain-list small' },
        h('li', { text: '流動比率は1年以内に払う負債に対する支払能力。一般に100%を下回ると資金繰りに注意が必要と言われます。' }),
        h('li', { text: '自己資本比率は高いほど借入れに頼らない形。固定比率は100%以下なら固定資産を自己資本でまかなえています。' }),
        h('li', { text: '回転期間は売掛金・在庫・買掛金が月商の何か月分あるか。売上債権＋棚卸資産−仕入債務（運転資本）の分だけ、資金が先に出ていきます。' }),
        h('li', { text: '損益分岐点は、変動費を売上原価、固定費をそれ以外の費用とみる簡便な方法です。外注費など売上に連動する経費が多い場合は実際より高めに出ます。' }),
        h('li', { text: '業種・規模で水準は大きく違うため、同業の平均や自社の前期と比べて使ってください。' }),
      ),
    ),
  );
}
