// 月別の棒＋折れ線グラフ（SVG、外部ライブラリなし）。軸は1本（同じ円の単位の2系列）
// 色は CSS 変数 --chart-1 / --chart-2（ライト・ダークで別の段階を指定し、色覚の差の検証済み）
import { h } from './ui.js';
import { formatYen } from './money.js';

const NS = 'http://www.w3.org/2000/svg';

function s(tag, attrs = {}, ...children) {
  const el = document.createElementNS(NS, tag);
  for (const [k, v] of Object.entries(attrs)) if (v !== null && v !== undefined) el.setAttribute(k, String(v));
  for (const c of children.flat()) if (c) el.append(c);
  return el;
}

/** 目盛りの間隔（1・2・5 × 10^n） */
export function niceStep(range, count = 4) {
  if (range <= 0) return 1;
  const raw = range / count;
  const pow = 10 ** Math.floor(Math.log10(raw));
  const f = raw / pow;
  return (f <= 1 ? 1 : f <= 2 ? 2 : f <= 5 ? 5 : 10) * pow;
}

/** 目盛りの短い表示（22万・1.5億・△3万） */
export function compactYen(n) {
  const a = Math.abs(n);
  const sign = n < 0 ? '△' : '';
  if (a >= 1e8) return `${sign}${trim(a / 1e8)}億`;
  if (a >= 1e4) return `${sign}${trim(a / 1e4)}万`;
  return `${sign}${a.toLocaleString('ja-JP')}`;
}
const trim = (x) => String(Math.round(x * 10) / 10);

/** 目盛り（0 を含み、最小・最大を覆う） */
export function axisTicks(values) {
  const min = Math.min(0, ...values);
  const max = Math.max(0, ...values);
  const step = niceStep(max - min || 1);
  const lo = Math.floor(min / step) * step;
  const hi = Math.ceil(max / step) * step || step;
  const ticks = [];
  for (let v = lo; v <= hi + step / 2; v += step) ticks.push(Math.round(v));
  return ticks;
}

/**
 * @param {{ labels: string[], bar: {label, values}, line: {label, values}, title: string, planFrom?: number }} opts
 *   planFrom：この位置から後は予定（棒を薄く、線を破線にする）
 * @returns {HTMLElement}
 */
export function barLineChart({ labels, bar, line, title, planFrom = labels.length }) {
  const W = 360;
  const H = 210;
  const pad = { l: 40, r: 8, t: 10, b: 22 };
  const ticks = axisTicks([...bar.values, ...line.values]);
  const lo = ticks[0];
  const hi = ticks.at(-1);
  const y = (v) => pad.t + ((hi - v) / (hi - lo)) * (H - pad.t - pad.b);
  const band = (W - pad.l - pad.r) / labels.length;
  const cx = (i) => pad.l + band * (i + 0.5);
  const bw = Math.min(16, band * 0.55);
  const y0 = y(0);

  const grid = ticks.map((t) =>
    s('g', {}, s('line', { x1: pad.l, x2: W - pad.r, y1: y(t), y2: y(t), class: t === 0 ? 'ch-zero' : 'ch-grid' }), s('text', { x: pad.l - 4, y: y(t) + 3, class: 'ch-tick', 'text-anchor': 'end' }, compactYen(t))),
  );
  // 棒：基線側は角を立て、先端だけ丸める（半径は棒の長さを超えない）
  const bars = bar.values.map((v, i) => {
    if (!v) return null;
    const top = y(v);
    const hgt = Math.abs(y0 - top);
    const r = Math.min(4, hgt, bw / 2);
    const x = cx(i) - bw / 2;
    const d =
      v > 0
        ? `M${x},${y0}V${top + r}Q${x},${top} ${x + r},${top}H${x + bw - r}Q${x + bw},${top} ${x + bw},${top + r}V${y0}Z`
        : `M${x},${y0}V${top - r}Q${x},${top} ${x + r},${top}H${x + bw - r}Q${x + bw},${top} ${x + bw},${top - r}V${y0}Z`;
    return s('path', { d, class: i >= planFrom ? 'ch-bar ch-plan' : 'ch-bar' });
  });
  const pts = (from, to) => line.values.slice(from, to).map((v, k) => `${cx(from + k)},${y(v)}`).join(' ');
  const dots = line.values.map((v, i) => s('circle', { cx: cx(i), cy: y(v), r: 4, class: i >= planFrom ? 'ch-dot ch-plan' : 'ch-dot' }));
  const hasPlan = planFrom < labels.length;
  const xLabels = labels.map((l, i) => s('text', { x: cx(i), y: H - 6, class: 'ch-tick', 'text-anchor': 'middle' }, l));
  const hilite = s('rect', { x: 0, y: pad.t, width: band, height: H - pad.t - pad.b, class: 'ch-hilite', visibility: 'hidden' });
  // 選んだ月の値（グラフに重ねると棒が隠れるため、グラフの下に出す）
  const tip = h('div', { class: 'ch-readout', 'aria-live': 'polite' });

  const show = (i) => {
    hilite.setAttribute('x', pad.l + band * i);
    hilite.setAttribute('visibility', 'visible');
    const row = (cls, label, v) => h('div', { class: 'ch-tip-row' }, h('span', { class: `ch-sw ${cls}` }), h('span', { text: label }), h('span', { class: `num ${v < 0 ? 'neg' : ''}`, text: `${formatYen(v)}円` }));
    tip.replaceChildren(h('div', { class: 'ch-tip-head', text: i >= planFrom ? `${labels[i]}（予定）` : labels[i] }), row('ch-sw-bar', bar.label, bar.values[i]), row('ch-sw-line', line.label, line.values[i]));
  };
  // 当たり判定は月の幅いっぱい（棒より広く）
  const hits = labels.map((l, i) =>
    s('rect', { x: pad.l + band * i, y: 0, width: band, height: H, class: 'ch-hit', tabindex: 0, 'aria-label': `${l} ${bar.label}${formatYen(bar.values[i])}円 ${line.label}${formatYen(line.values[i])}円` }),
  );
  hits.forEach((el, i) => {
    el.addEventListener('pointerenter', () => show(i));
    el.addEventListener('click', () => show(i));
    el.addEventListener('focus', () => show(i));
  });

  const svgEl = s(
    'svg',
    { viewBox: `0 0 ${W} ${H}`, class: 'chart-svg', role: 'img', 'aria-label': title },
    grid,
    hilite,
    bars,
    planFrom > 0 ? s('polyline', { points: pts(0, planFrom), class: 'ch-line' }) : null,
    hasPlan ? s('polyline', { points: pts(Math.max(0, planFrom - 1), labels.length), class: 'ch-line ch-plan' }) : null,
    dots,
    xLabels,
    hits,
  );
  // 初めは値のある最後の月を選んでおく
  let last = 0;
  labels.forEach((_, i) => (bar.values[i] || line.values[i]) && (last = i));
  show(last);
  const legend = h(
    'div',
    { class: 'ch-legend' },
    h('span', { class: 'ch-key' }, h('span', { class: 'ch-sw ch-sw-bar' }), bar.label),
    h('span', { class: 'ch-key' }, h('span', { class: 'ch-sw ch-sw-line' }), line.label),
    hasPlan ? h('span', { class: 'ch-key' }, h('span', { class: 'ch-sw ch-sw-plan' }), '予定（薄い棒・破線）') : null,
  );
  return h('figure', { class: 'chart panel' }, h('figcaption', { class: 'chart-title', text: title }), legend, h('div', { class: 'chart-area' }, svgEl), tip);
}

/**
 * 月別の折れ線グラフ（1〜2本。値が null の月は線を切る）
 * @param {{ labels: string[], series: Array<{label, values: Array<number|null>}>, title: string, planFrom?: number }} opts
 *   1本目は --chart-1、2本目は --chart-2 の色。planFrom から後は破線
 * @returns {HTMLElement}
 */
export function lineChart({ labels, series, title, planFrom = labels.length }) {
  const W = 360;
  const H = 210;
  const pad = { l: 40, r: 8, t: 10, b: 22 };
  const all = series.flatMap((x) => x.values).filter((v) => v !== null && v !== undefined);
  const ticks = axisTicks(all.length ? all : [0]);
  const lo = ticks[0];
  const hi = ticks.at(-1);
  const y = (v) => pad.t + ((hi - v) / (hi - lo)) * (H - pad.t - pad.b);
  const band = (W - pad.l - pad.r) / labels.length;
  const cx = (i) => pad.l + band * (i + 0.5);
  const has = (v) => v !== null && v !== undefined;
  const grid = ticks.map((t) =>
    s('g', {}, s('line', { x1: pad.l, x2: W - pad.r, y1: y(t), y2: y(t), class: t === 0 ? 'ch-zero' : 'ch-grid' }), s('text', { x: pad.l - 4, y: y(t) + 3, class: 'ch-tick', 'text-anchor': 'end' }, compactYen(t))),
  );
  // 続いている月どうしを線で結ぶ。実績どうしは実線、見込みにかかる区間は破線
  const lines = series.map((sr, k) => {
    const cls = k === 0 ? 'ch-line ch-line-1' : 'ch-line';
    const segs = [];
    for (let i = 1; i < labels.length; i += 1) {
      if (!has(sr.values[i - 1]) || !has(sr.values[i])) continue;
      segs.push(s('line', { x1: cx(i - 1), y1: y(sr.values[i - 1]), x2: cx(i), y2: y(sr.values[i]), class: i >= planFrom ? `${cls} ch-plan` : cls }));
    }
    const dots = sr.values.map((v, i) => (has(v) ? s('circle', { cx: cx(i), cy: y(v), r: 3.5, class: `${k === 0 ? 'ch-dot ch-dot-1' : 'ch-dot'}${i >= planFrom ? ' ch-plan' : ''}` }) : null));
    return s('g', {}, segs, dots);
  });
  const hasPlan = planFrom < labels.length;
  const xLabels = labels.map((l, i) => s('text', { x: cx(i), y: H - 6, class: 'ch-tick', 'text-anchor': 'middle' }, l));
  const hilite = s('rect', { x: 0, y: pad.t, width: band, height: H - pad.t - pad.b, class: 'ch-hilite', visibility: 'hidden' });
  const tip = h('div', { class: 'ch-readout', 'aria-live': 'polite' });
  const yen = (v) => (has(v) ? `${formatYen(v)}円` : '—');
  const show = (i) => {
    hilite.setAttribute('x', pad.l + band * i);
    hilite.setAttribute('visibility', 'visible');
    tip.replaceChildren(
      h('div', { class: 'ch-tip-head', text: i >= planFrom ? `${labels[i]}（見込みを含む）` : labels[i] }),
      ...series.map((sr, k) => h('div', { class: 'ch-tip-row' }, h('span', { class: `ch-sw ${k === 0 ? 'ch-sw-line1' : 'ch-sw-line'}` }), h('span', { text: sr.label }), h('span', { class: `num ${sr.values[i] < 0 ? 'neg' : ''}`, text: yen(sr.values[i]) }))),
    );
  };
  const hits = labels.map((l, i) => s('rect', { x: pad.l + band * i, y: 0, width: band, height: H, class: 'ch-hit', tabindex: 0, 'aria-label': `${l} ${series.map((sr) => `${sr.label}${yen(sr.values[i])}`).join(' ')}` }));
  hits.forEach((el, i) => {
    el.addEventListener('pointerenter', () => show(i));
    el.addEventListener('click', () => show(i));
    el.addEventListener('focus', () => show(i));
  });
  const svgEl = s('svg', { viewBox: `0 0 ${W} ${H}`, class: 'chart-svg', role: 'img', 'aria-label': title }, grid, hilite, lines, xLabels, hits);
  let last = 0;
  labels.forEach((_, i) => series.some((sr) => has(sr.values[i])) && (last = i));
  show(last);
  const legend = h(
    'div',
    { class: 'ch-legend' },
    series.map((sr, k) => h('span', { class: 'ch-key' }, h('span', { class: `ch-sw ${k === 0 ? 'ch-sw-line1' : 'ch-sw-line'}` }), sr.label)),
    hasPlan ? h('span', { class: 'ch-key' }, h('span', { class: 'ch-sw ch-sw-dash' }), '見込みを含む（破線）') : null,
  );
  return h('figure', { class: 'chart panel' }, h('figcaption', { class: 'chart-title', text: title }), legend, h('div', { class: 'chart-area' }, svgEl), tip);
}

/**
 * 横棒の比較（CSS の棒。1行に1〜2本）
 * @param {{ title: string, rows: Array<{ label: string, sub?: string, values: Array<number|null> }>, series: Array<{ label: string, cls: string }>, format: (v:number)=>string, scale?: 'all'|'row' }} opts
 *   scale：'all' はすべての行で同じ物差し、'row' は行ごとに一番大きい値を100%にする（桁の違う指標を並べるとき）
 *   cls：棒の色のクラス（hb-1：--chart-1、hb-2：--chart-2、hb-3：--chart-2 を薄く）。負の値は長さ0で、数字だけ出す
 * @returns {HTMLElement}
 */
export function hBarChart({ title, rows, series, format, scale = 'all' }) {
  const maxOf = (xs) => Math.max(1, ...xs.filter((v) => v !== null && v > 0));
  const allMax = maxOf(rows.flatMap((r) => r.values));
  const pct = (v, max) => (v === null || v <= 0 ? 0 : Math.max(1, Math.round((v * 1000) / max) / 10));
  const legend = series.length > 1 ? h('div', { class: 'ch-legend' }, series.map((s) => h('span', { class: 'ch-key' }, h('span', { class: `ch-sw ${s.cls}` }), s.label))) : null;
  return h(
    'figure',
    { class: 'chart panel hbar' },
    h('figcaption', { class: 'chart-title', text: title }),
    legend,
    h(
      'div',
      { class: 'hbar-rows', role: 'list' },
      rows.map((r) => {
        const max = scale === 'row' ? maxOf(r.values) : allMax;
        return h(
          'div',
          { class: 'hbar-row', role: 'listitem' },
          h('div', { class: 'hbar-label' }, h('span', { text: r.label }), r.sub ? h('span', { class: 'muted small', text: r.sub }) : null),
          r.values.map((v, i) =>
            h(
              'div',
              { class: 'hbar-line' },
              h('span', { class: 'hbar-track', 'aria-hidden': 'true' }, h('span', { class: `hbar-bar ${series[i].cls}`, style: `width:${pct(v, max)}%` })),
              h('span', { class: `hbar-num num ${v < 0 ? 'neg' : ''}`, 'aria-label': `${series[i].label} ${v === null ? 'なし' : format(v)}`, text: v === null ? '—' : format(v) }),
            ),
          ),
        );
      }),
    ),
  );
}

/**
 * 損益分岐点図：横軸は売上高、縦軸は金額。売上の線（原点から45度）と総費用の線（固定費＋変動費率×売上）が交わる点が損益分岐点
 * @param {{ sales: number, variable: number, fixed: number, title: string, salesLabel?: string }} p 着地（またはシミュレーション後）の数字
 * @returns {HTMLElement|null} 売上が0以下なら null
 */
export function breakEvenChart({ sales, variable, fixed, title, salesLabel = '売上高' }) {
  if (sales <= 0) return null;
  const rate = variable / sales; // 表示のための比（金額の計算には使わない）
  const marginal = sales - variable;
  const point = marginal > 0 && fixed > 0 ? Math.round((fixed * sales) / marginal) : marginal > 0 ? 0 : null;
  const xMax = Math.max(sales, point ?? 0) * 1.25;
  const cost = (x) => fixed + rate * x;
  const ticks = axisTicks([0, xMax, cost(xMax), fixed]);
  const lo = Math.min(0, ticks[0]);
  const hi = ticks.at(-1);
  const W = 360;
  const H = 230;
  const pad = { l: 44, r: 12, t: 12, b: 30 };
  const xs = (x) => pad.l + (x / xMax) * (W - pad.l - pad.r);
  const ys = (v) => pad.t + ((hi - v) / (hi - lo)) * (H - pad.t - pad.b);
  const xTicks = axisTicks([0, xMax]).filter((t) => t >= 0 && t <= xMax);
  const grid = ticks.map((t) => s('g', {}, s('line', { x1: pad.l, x2: W - pad.r, y1: ys(t), y2: ys(t), class: t === 0 ? 'ch-zero' : 'ch-grid' }), s('text', { x: pad.l - 4, y: ys(t) + 3, class: 'ch-tick', 'text-anchor': 'end' }, compactYen(t))));
  const xLabels = xTicks.map((t) => s('text', { x: xs(t), y: H - 16, class: 'ch-tick', 'text-anchor': 'middle' }, compactYen(t)));
  const profit = sales - variable - fixed;
  // 利益（黒字）は売上の線と費用の線の間を塗る
  const area = s('polygon', { points: `${xs(sales)},${ys(sales)} ${xs(sales)},${ys(cost(sales))} ${point !== null ? `${xs(point)},${ys(point)}` : ''}`, class: profit >= 0 ? 'be-profit' : 'be-loss' });
  const svgEl = s(
    'svg',
    { viewBox: `0 0 ${W} ${H}`, class: 'chart-svg', role: 'img', 'aria-label': `${title}：損益分岐点売上高 ${point === null ? 'なし' : `${formatYen(point)}円`}、${salesLabel} ${formatYen(sales)}円` },
    grid,
    point !== null ? area : null,
    s('line', { x1: xs(0), y1: ys(fixed), x2: xs(xMax), y2: ys(fixed), class: 'be-fixed' }),
    s('line', { x1: xs(0), y1: ys(0), x2: xs(xMax), y2: ys(xMax), class: 'ch-line ch-line-1' }),
    s('line', { x1: xs(0), y1: ys(fixed), x2: xs(xMax), y2: ys(cost(xMax)), class: 'ch-line' }),
    s('line', { x1: xs(sales), y1: pad.t, x2: xs(sales), y2: H - pad.b, class: 'be-now' }),
    s('text', { x: xs(sales), y: pad.t + 9, class: 'ch-tick be-now-label', 'text-anchor': xs(sales) > W - 60 ? 'end' : 'middle' }, '今の売上'),
    point !== null ? s('circle', { cx: xs(point), cy: ys(point), r: 5, class: 'be-point' }) : null,
    s('text', { x: W - pad.r, y: H - 3, class: 'ch-tick', 'text-anchor': 'end' }, `横軸：${salesLabel}`),
    xLabels,
  );
  const legend = h(
    'div',
    { class: 'ch-legend' },
    h('span', { class: 'ch-key' }, h('span', { class: 'ch-sw ch-sw-line1' }), salesLabel),
    h('span', { class: 'ch-key' }, h('span', { class: 'ch-sw ch-sw-line' }), '費用（固定費＋変動費）'),
    h('span', { class: 'ch-key' }, h('span', { class: 'ch-sw be-sw-fixed' }), '固定費'),
    h('span', { class: 'ch-key' }, h('span', { class: 'ch-sw be-sw-point' }), '損益分岐点'),
  );
  const readout = h(
    'div',
    { class: 'ch-readout' },
    h('div', { class: 'ch-tip-row' }, h('span', { class: 'ch-sw be-sw-point' }), h('span', { text: '損益分岐点売上高' }), h('span', { class: 'num', text: point === null ? '—（限界利益がマイナス）' : `${formatYen(point)}円` })),
    h('div', { class: 'ch-tip-row' }, h('span', { class: `ch-sw ${profit >= 0 ? 'be-sw-profit' : 'be-sw-loss'}` }), h('span', { text: profit >= 0 ? '利益（線の間）' : '損失（線の間）' }), h('span', { class: `num ${profit < 0 ? 'neg' : ''}`, text: `${formatYen(profit)}円` })),
  );
  return h('figure', { class: 'chart panel' }, h('figcaption', { class: 'chart-title', text: title }), legend, h('div', { class: 'chart-area' }, svgEl), readout);
}

/**
 * 貸借対照表の比例縮尺図（左に資産、右に負債・純資産を金額の大きさで積む）
 * @param {{ title: string, left: Array<{label, value}>, right: Array<{label, value}> }} p right の純資産が負（債務超過）なら左に「債務超過」の箱を足す
 * @returns {HTMLElement}
 */
export function bsBoxChart({ title, left, right }) {
  const pos = (xs) => xs.filter((x) => x.value > 0);
  const net = right.find((x) => x.net);
  const deficit = net && net.value < 0 ? -net.value : 0;
  const leftBoxes = [...pos(left), ...(deficit ? [{ label: '債務超過', value: deficit, deficit: true }] : [])];
  const rightBoxes = pos(right);
  const total = Math.max(1, leftBoxes.reduce((t, x) => t + x.value, 0), rightBoxes.reduce((t, x) => t + x.value, 0));
  const col = (boxes, side) =>
    h(
      'div',
      { class: `bsbox-col bsbox-${side}` },
      boxes.map((b, i) =>
        h(
          'div',
          { class: `bsbox-box bsbox-${side}-${i}${b.deficit ? ' bsbox-deficit' : ''}${b.net ? ' bsbox-net' : ''}${b.value * 100 < total * 12 ? ' is-small' : ''}`, style: `flex-grow:${b.value}` },
          h('span', { class: 'bsbox-name', text: b.label }),
          h('span', { class: 'bsbox-val num', text: `${compactYen(b.value)}（${Math.round((b.value * 100) / total)}%）` }),
        ),
      ),
    );
  const sumL = left.reduce((t, x) => t + Math.max(0, x.value), 0);
  return h(
    'figure',
    { class: 'chart panel bsbox' },
    h('figcaption', { class: 'chart-title', text: title }),
    h('div', { class: 'bsbox-grid', role: 'img', 'aria-label': `${title}：${[...leftBoxes, ...rightBoxes].map((b) => `${b.label} ${formatYen(b.value)}円`).join('、')}` }, col(leftBoxes, 'l'), col(rightBoxes, 'r')),
    h('p', { class: 'muted small', text: `総資産 ${formatYen(sumL)}円。箱の高さは金額に比例します。` }),
  );
}
