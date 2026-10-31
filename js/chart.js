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
