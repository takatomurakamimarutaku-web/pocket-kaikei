// 帳票の組版（純粋関数）：帳票の内容（見出し・表・文）を A4 のページに割り付け、
// 文字・罫線・塗りの部品（単位 mm、左上が原点）にする。プレビュー（SVG）と PDF は同じ部品を描く
//
// 様式は市販の会計ソフト（弥生会計など）の帳票にならう：
//   中央に表題（二重下線）と期間、左上に事業者名、右上に作成日、下にページ番号（n / N）
//   表の見出し行はページごとに繰り返す。元帳・仕訳帳は「次頁へ繰越」「前頁より繰越」の行を入れる
//   科目ごとの元帳のように caption のある見出しは改ページし、各ページの左上に科目名を出す

export const PT = 25.4 / 72; // 1pt の mm
export const PAPER = Object.freeze({ portrait: { w: 210, h: 297 }, landscape: { w: 297, h: 210 } });
export const MARGIN = Object.freeze({ x: 12, top: 11, bottom: 11 });

const FONT = 8; // 表の文字（pt）
const HEAD_FONT = 7.5; // 表の見出し行（pt）
const LINE_H = 4.6; // 表の1行の高さ（mm）
const HEAD_H = 6.4; // 見出し行の高さ（mm）
const PAD = 1.2; // セルの左右の余白（mm）
const TABLE_TOP = 35; // 表の始まり（ページ上端から mm）
const FOOTER_H = 7; // ページ番号の欄（mm）
const MIN_SCALE = 0.6; // 文字を横に縮める下限（これより長い文字は末尾を「…」にする）

/** 半角の文字か（ASCII と半角カナ）。PDF のフォントでも半角は全角の半分の幅 */
export function isHalfWidth(cp) {
  return (cp >= 0x20 && cp <= 0x7e) || (cp >= 0xff61 && cp <= 0xff9f);
}

/** 文字の幅（全角＝1、半角＝0.5、カンマ＝0.3） */
export function emWidth(text) {
  let w = 0;
  for (const ch of String(text)) {
    const cp = ch.codePointAt(0);
    w += cp === 0x2c ? 0.3 : isHalfWidth(cp) ? 0.5 : 1; // カンマは PDF で詰めて描く（print-pdf.js の showText）
  }
  return w;
}

/** 文字の幅（mm）。size は pt */
export function textWidth(text, size) {
  return emWidth(text) * size * PT;
}

/**
 * 幅に収める：収まらなければ横に縮め（scale）、MIN_SCALE でも収まらなければ末尾を「…」にする
 * @returns {{ text: string, scale: number }}
 */
export function fitText(text, size, maxW) {
  const s = String(text ?? '');
  const w = textWidth(s, size);
  if (w <= maxW || maxW <= 0) return { text: s, scale: 1 };
  if (w * MIN_SCALE <= maxW) return { text: s, scale: Math.floor((maxW / w) * 1000) / 1000 };
  const chars = [...s];
  while (chars.length && textWidth(`${chars.join('')}…`, size) * MIN_SCALE > maxW) chars.pop();
  return { text: `${chars.join('')}…`, scale: MIN_SCALE };
}

/**
 * 印刷できる文字にする：㉑〜㊿の丸数字は (21) のように書く（PDF の日本語フォントの文字集合と、
 * 表示側の代わりのフォントに無いことがあるため。①〜⑳はそのまま）
 */
export function printable(s) {
  return String(s ?? '').replace(/[\u3251-\u325f\u32b1-\u32bf]/g, (ch) => {
    const cp = ch.codePointAt(0);
    return `(${cp <= 0x325f ? cp - 0x3251 + 21 : cp - 0x32b1 + 36})`;
  });
}

/** 和暦の年月日（令和・平成） */
export function warekiText(date) {
  if (!date) return '';
  const y = Number(date.slice(0, 4));
  const m = Number(date.slice(5, 7));
  const d = Number(date.slice(8, 10));
  const [era, year] = date >= '2019-05-01' ? ['令和', y - 2018] : date >= '1989-01-08' ? ['平成', y - 1988] : ['昭和', y - 1925];
  return `${era}${year === 1 ? '元' : year}年${m}月${d}日`;
}

/** 期間の見出し（自 令和8年1月1日　至 令和8年12月31日） */
export function periodText(from, to) {
  return `自 ${warekiText(from)}　至 ${warekiText(to)}`;
}

const cellOf = (c) => (c !== null && typeof c === 'object' && !Array.isArray(c) ? c : { text: c });
const linesOf = (t) => (Array.isArray(t) ? t.map((x) => String(x ?? '')) : String(t ?? '').split('\n'));

/** 行の高さ（mm）：セルの行数の最大。lineH：1行の高さ */
function rowHeight(row, lineH = LINE_H) {
  let n = 1;
  for (const c of row.cells) n = Math.max(n, linesOf(cellOf(c).text).length);
  return n * lineH + (n > 1 ? 0.6 : 0);
}

/**
 * 列の幅（mm）を決める。数字の列は縮めず、文字の列（grow の大きい列）で余りと不足を受け持つ
 * @param {Array<{label, align?, w?, grow?, min?}>} columns
 * @param {Array<{cells}>} rows
 * @param {number} avail 使える幅
 * @param {{ font?: number, headFont?: number }} [size] 表の文字の大きさ（pt）
 * @returns {{ widths: number[], over: number }} over：最小幅でも足りない幅（0 なら収まった）
 */
export function columnWidths(columns, rows, avail, { font = FONT, headFont = HEAD_FONT } = {}) {
  const content = columns.map((col) => Math.max(...linesOf(col.label).map((l) => textWidth(l, headFont))));
  for (const r of rows) {
    let i = 0;
    for (const raw of r.cells) {
      const c = cellOf(raw);
      const span = c.span || 1;
      // 複数の列にまたがるセル（区分の見出しなど）は列の幅を決めない
      if (span === 1 && i < columns.length) for (const l of linesOf(c.text)) content[i] = Math.max(content[i], textWidth(l, font) + (c.indent || 0));
      i += span;
    }
  }
  const natural = columns.map((col, i) => col.w || Math.min(content[i] + PAD * 2, col.max ?? 90));
  const total = natural.reduce((a, b) => a + b, 0);
  const grow = columns.map((col) => (col.w ? 0 : (col.grow ?? (col.align === 'right' || col.align === 'center' ? 0 : 1))));
  const growSum = grow.reduce((a, b) => a + b, 0);
  if (total <= avail) {
    const extra = avail - total;
    if (!growSum) return { widths: natural.map((w) => w + extra / columns.length), over: 0 };
    // 余りは伸びる列に、今の幅に比例して配る（短い列ばかり広がらないように）
    const weight = natural.map((w, i) => grow[i] * w);
    const weightSum = weight.reduce((a, b) => a + b, 0);
    return { widths: natural.map((w, i) => w + (extra * weight[i]) / weightSum), over: 0 };
  }
  // 足りない：伸び縮みする列を最小幅まで縮める（数字の列は縮めない）
  const mins = columns.map((col, i) => (grow[i] ? Math.min(natural[i], col.min ?? 14) : natural[i]));
  const shrinkable = natural.reduce((s, w, i) => s + (w - mins[i]), 0);
  const need = total - avail;
  if (shrinkable >= need) {
    const ratio = need / shrinkable;
    return { widths: natural.map((w, i) => w - (w - mins[i]) * ratio), over: 0 };
  }
  // 最小幅でも足りない：全体を比例で縮める（文字は fitText で縮む）
  const minTotal = mins.reduce((a, b) => a + b, 0);
  return { widths: mins.map((w) => (w * avail) / minTotal), over: minTotal - avail };
}

/** 用紙の向きの自動判定：縦で表が収まらなければ横 */
function chooseOrientation(orientation, blocks) {
  if (orientation === 'portrait' || orientation === 'landscape') return orientation;
  const avail = PAPER.portrait.w - MARGIN.x * 2;
  for (const b of blocks) {
    if (b.type !== 'table') continue;
    if (columnWidths(b.columns, b.rows, Math.min(b.width ?? avail, avail), { font: b.font, headFont: b.headFont }).over > 0) return 'landscape';
  }
  return 'portrait';
}

/**
 * 帳票をページに割り付ける
 * @param {{
 *   title: string, company?: string, period?: string, printedAt?: string, unit?: string,
 *   orientation?: 'portrait'|'landscape'|'auto',
 *   blocks: Array<
 *     { type: 'heading', text: string, caption?: boolean, title?: string } |  caption：改ページして各ページの左上に出す（元帳の科目名など）。title：そのページの表題
 *     { type: 'text', text: string, size?: number } |
 *     { type: 'table', columns: Array<{label, align?, w?, grow?, min?, max?, headSpan?, joinLeft?}>,  headSpan：見出しを右の列とまとめる。joinLeft：左の縦線を引かない
 *       rows: Array<{ cells: Array<string|string[]|{text, span?, align?, indent?, bold?, rule?: 'over'|'double'}>,
 *                     kind?: 'group'|'subtotal'|'total'|'carried', keep?: string, nums?: object, breakAfter?: boolean }>,
 *       carry?: { label: number, sum: number[], balance?: number },
 *       style?: 'grid'|'open',   open：決算書の体裁（縦罫・塗りなし）
 *       width?: number, font?: number, headFont?: number, rowH?: number,  表の幅（mm。用紙の中央に置く）・文字（pt）・1行の高さ（mm）
 *       headGroups?: Array<{ label, from, span }>,  見出しを2段にして上の段で列をまとめる
 *       split?: number|number[] }>  勘定式の左右の境・様式のマス目の区切り（この列の左に太い縦線）
 *   formal?: boolean  決算書の体裁：作成日・アプリ名を出さず、表の左上に事業者名、右上に単位。ページ番号は2ページ以上のときだけ
 *   見出し（caption）に period を付けると、そのページの期間の行にする（決算書をまとめて印刷するとき）。unit はそのページの単位（'' で書かない）
 * }} doc
 * @returns {Array<{ w, h, orientation, items: Array }>} items：{t:'text', x, y, size, text, align, bold, scale} | {t:'line', x1, y1, x2, y2, w} | {t:'rect', x, y, w, h, gray}
 */
export function layoutDocument(doc) {
  // 用紙の向き：auto のときは改ページの見出し（caption）で区切った部分ごとに決める（青色申告決算書の減価償却の表だけ横など）
  const segments = [];
  for (const b of doc.blocks) {
    if (!segments.length || (b.type === 'heading' && b.caption)) segments.push([]);
    segments.at(-1).push(b);
  }
  const orientOf = new Map();
  for (const seg of segments) {
    const o = chooseOrientation(doc.orientation, seg);
    for (const b of seg) orientOf.set(b, o);
  }
  let orientation = orientOf.get(doc.blocks[0]) ?? chooseOrientation(doc.orientation, []);
  let paper;
  let right;
  let avail;
  let bottom;
  const left = MARGIN.x;
  const setPaper = () => {
    paper = PAPER[orientation];
    right = paper.w - MARGIN.x;
    avail = right - left;
    bottom = paper.h - MARGIN.bottom - FOOTER_H;
  };
  setPaper();
  const pages = [];
  let page = null;
  let y = 0;
  let caption = '';
  let pageTitle = null; // caption の見出しに title があれば、そのページの表題にする（申告書の別表ごとの名前）
  let pagePeriod = null; // caption の見出しに period があれば、そのページの期間の行にする
  let pageUnit; // caption の見出しに unit があれば、そのページの単位（'' なら書かない。個別注記表など）
  const formal = Boolean(doc.formal);
  const TOP = formal ? 41 : TABLE_TOP; // 表の始まり（決算書は表題・期間・事業者名の下を広く空ける）

  const text = (x, yy, s, size, opts = {}) => page.items.push({ t: 'text', x, y: yy, size, text: printable(s), align: opts.align || 'left', bold: Boolean(opts.bold), scale: opts.scale ?? 1 });
  const line = (x1, y1, x2, y2, w = 0.1) => page.items.push({ t: 'line', x1, y1, x2, y2, w });
  const rect = (x, yy, w, hh, gray) => page.items.push({ t: 'rect', x, y: yy, w, h: hh, gray });
  const fitted = (x, yy, s, size, maxW, opts = {}) => {
    const f = fitText(printable(s), size, maxW);
    text(x, yy, f.text, size, { ...opts, scale: f.scale });
  };

  function newPage(cont = false) {
    setPaper();
    // 表の続きのページは、前のページと同じ表の幅に事業者名・単位をそろえる
    const frame = cont ? page?.frame : undefined;
    page = { w: paper.w, h: paper.h, orientation, items: [], caption: cont && caption ? `${caption}（続き）` : caption, title: pageTitle, period: pagePeriod, unit: pageUnit, frame };
    pages.push(page);
    y = TOP;
  }
  newPage();

  // 1つの表を描く（ページをまたぐときは見出し行を繰り返す）
  function drawTable(block) {
    // 表ごとの文字の大きさ・行の高さ・幅（幅を指定した表は用紙の中央に置く）
    const font = block.font ?? FONT;
    const headFont = block.headFont ?? HEAD_FONT;
    const lineH = block.rowH ?? LINE_H;
    const headH = block.headH ?? HEAD_H;
    const rh = (row) => rowHeight(row, lineH);
    const tableW = Math.min(block.width ?? avail, avail);
    const tl = left + (avail - tableW) / 2;
    if (!page.frame) page.frame = { left: tl, right: tl + tableW };
    const { widths } = columnWidths(block.columns, block.rows, tableW, { font, headFont });
    drawTableAt(block, { font, headFont, lineH, headH, rh, widths, left: tl, right: tl + tableW, avail: tableW });
  }

  // 表を描く（left・right・avail はこの表の左端・右端・幅）
  function drawTableAt(block, { font, headFont, lineH, headH, rh, widths, left, right, avail }) {
    const xs = [left];
    for (const w of widths) xs.push(xs.at(-1) + w);
    xs[xs.length - 1] = right;
    const carry = block.carry || null;
    let tableTop = y;
    const sums = carry ? carry.sum.map(() => 0) : [];
    let balance = null;

    const noHeader = block.columns.every((c) => !c.label);
    // open：決算書の体裁（縦の罫線と塗りを使わず、見出しの上下と表の下の横線だけ。計の金額の上に線）
    const open = block.style === 'open';
    function drawHeader() {
      tableTop = y;
      if (noHeader) {
        line(left, y, right, y, 0.3);
        return;
      }
      // headGroups：見出しを2段にし、上の段で複数の列をまとめる（別表四の「処分」など）
      const groups = block.headGroups || [];
      // 見出しの文字が3行以上の列があれば、その分だけ見出しの段を高くする
      const lines = Math.max(1, ...block.columns.map((c) => linesOf(c.label).length));
      const lowH = Math.max(headH, lines * headFont * PT * 1.15 + 1.6);
      const hh = groups.length ? headH + lowH : lowH;
      if (!open) rect(left, y, avail, hh, 0.9);
      const groupOf = (i) => groups.find((g) => i >= g.from && i < g.from + g.span);
      const label = (x0, x1, top, h, s) => {
        const labels = linesOf(s);
        const size = headFont;
        labels.forEach((l, k) => {
          const yy = top + h / 2 + (k - (labels.length - 1) / 2) * size * PT * 1.15 + size * PT * 0.35;
          fitted((x0 + x1) / 2, yy, l, size, x1 - x0 - PAD, { align: 'center' });
        });
      };
      for (const g of groups) {
        label(xs[g.from], xs[g.from + g.span], y, headH, g.label);
        line(xs[g.from], y + headH, xs[g.from + g.span], y + headH, 0.1);
      }
      // headSpan：見出しだけ複数の列にまたがる（社外流出③の「※」と金額など）
      const covered = new Set();
      block.columns.forEach((col, i) => {
        if (covered.has(i)) return;
        const span = Math.min(col.headSpan || 1, block.columns.length - i);
        for (let k = 1; k < span; k++) covered.add(i + k);
        const top = groups.length && groupOf(i) ? y + headH : y;
        label(xs[i], xs[i + span], top, y + hh - top, col.label);
      });
      if (groups.length && !open) {
        for (let i = 1; i < block.columns.length; i++) {
          if (covered.has(i)) continue;
          const g = groupOf(i);
          line(xs[i], g && i > g.from ? y + headH : y, xs[i], y + hh, 0.1);
        }
      }
      line(left, y, right, y, 0.3);
      line(left, y + hh, right, y + hh, 0.2);
      y += hh;
    }
    function closeTable() {
      // 縦の罫線（見出し行の上端から表の下端まで）・外枠
      line(left, y, right, y, 0.3);
      // 勘定式（左右2段）の中央の線
      for (const sp of [].concat(block.split ?? [])) line(xs[sp], tableTop, xs[sp], y, 0.3);
      if (open) return;
      line(left, tableTop, left, y, 0.3);
      line(right, tableTop, right, y, 0.3);
    }
    function drawRow(row, { vlines = true } = {}) {
      const hh = rh(row);
      const rowBold = row.kind === 'subtotal' || row.kind === 'total' || row.kind === 'group' || row.bold;
      if (!open && row.kind === 'group') rect(left, y, avail, hh, 0.96);
      if (!open && (row.kind === 'total' || row.kind === 'carry')) rect(left, y, avail, hh, 0.95);
      let i = 0;
      for (const raw of row.cells) {
        const c = cellOf(raw);
        const span = Math.min(c.span || 1, block.columns.length - i);
        if (span <= 0) break;
        const x0 = xs[i];
        const x1 = xs[i + span];
        const align = c.align || (span === 1 ? block.columns[i].align : null) || 'left';
        const ls = linesOf(c.text);
        const bold = c.bold ?? rowBold;
        // セルの線：over＝金額の上に線（計）、double＝下に二重線（最後の合計）
        if (c.rule === 'over' || c.rule === 'double') line(x0 + PAD, y + 0.15, x1 - PAD * 0.5, y + 0.15, 0.15);
        if (c.rule === 'double') {
          line(x0 + PAD, y + hh - 0.25, x1 - PAD * 0.5, y + hh - 0.25, 0.15);
          line(x0 + PAD, y + hh + 0.3, x1 - PAD * 0.5, y + hh + 0.3, 0.15);
        }
        ls.forEach((l, k) => {
          if (!l) return;
          const yy = y + lineH * k + lineH / 2 + font * PT * 0.36;
          const ax = align === 'right' ? x1 - PAD : align === 'center' ? (x0 + x1) / 2 : x0 + PAD + (c.indent || 0);
          fitted(ax, yy, l, k > 0 && ls.length > 1 && c.subSmall !== false ? font - 0.5 : font, x1 - x0 - PAD * 2 - (c.indent || 0), { align, bold });
        });
        if (vlines && !open && i > 0 && !block.columns[i].joinLeft) line(x0, y, x0, y + hh, 0.1);
        i += span;
      }
      // セルが列より少ない行は残りの縦線だけ引く
      for (; vlines && !open && i < block.columns.length; i++) if (i > 0 && !block.columns[i].joinLeft) line(xs[i], y, xs[i], y + hh, 0.1);
      y += hh;
      if (open) return;
      if (row.kind === 'total') {
        line(left, y - hh, right, y - hh, 0.2);
        line(left, y - hh + 0.5, right, y - hh + 0.5, 0.2);
      } else if (row.kind === 'subtotal') line(left, y - hh, right, y - hh, 0.2);
      line(left, y, right, y, row.kind === 'total' ? 0.2 : 0.08);
    }
    function carryRow(label) {
      const cells = block.columns.map(() => '');
      cells[carry.label] = { text: label, align: 'center' };
      carry.sum.forEach((col, k) => (cells[col] = fmt(sums[k])));
      if (carry.balance != null && balance !== null) cells[carry.balance] = fmt(balance);
      drawRow({ cells, kind: 'carry' });
    }

    const reserve = carry ? lineH : 0;
    drawHeader();
    const rows = block.rows;
    for (let r = 0; r < rows.length; r++) {
      const row = rows[r];
      // 同じ keep の行（1件の仕訳など）は同じページに置く（1ページに入りきらないときは分ける）
      let need = rh(row);
      if (row.keep != null && (r === 0 || rows[r - 1].keep !== row.keep)) {
        let gh = 0;
        for (let k = r; k < rows.length && rows[k].keep === row.keep; k++) gh += rh(rows[k]);
        if (gh <= bottom - TOP - headH - reserve * 2) need = gh;
      }
      // 区分の見出しの行は、次の行と同じページに置く
      if ((row.kind === 'group' || row.keepNext) && rows[r + 1]) need += rh(rows[r + 1]);
      if (y + need + reserve > bottom) {
        if (carry) carryRow('次頁へ繰越');
        closeTable();
        newPage(true);
        drawHeader();
        if (carry) carryRow('前頁より繰越');
      }
      drawRow(row);
      // 1件の仕訳の終わりは罫線を太くして区切る
      if (row.keep != null && rows[r + 1]?.keep !== row.keep) line(left, y, right, y, 0.25);
      // 改ページの指定（月ごとに改ページなど）
      if (row.breakAfter && r < rows.length - 1) {
        if (carry) carryRow('次頁へ繰越');
        closeTable();
        newPage(true);
        drawHeader();
        if (carry) carryRow('前頁より繰越');
      }
      if (carry) {
        if (row.sum !== false && row.kind !== 'subtotal' && row.kind !== 'total') carry.sum.forEach((col, k) => (sums[k] += row.nums?.[col] ?? 0));
        if (carry.balance != null && row.nums && row.nums[carry.balance] != null) balance = row.nums[carry.balance];
      }
    }
    closeTable();
    y += 3;
  }

  for (const b of doc.blocks) {
    if (b.type === 'heading') {
      if (b.caption) {
        caption = b.text;
        const o = orientOf.get(b);
        if (page.items.length || y > TOP || o !== orientation) {
          orientation = o;
          newPage();
        }
        page.caption = caption;
        pageTitle = b.title ?? null;
        page.title = pageTitle;
        pagePeriod = b.period ?? null;
        page.period = pagePeriod;
        pageUnit = b.unit;
        page.unit = pageUnit;
        continue;
      }
      if (y + 7 + HEAD_H + LINE_H * 2 > bottom) newPage(true);
      text(left, y + 4.2, b.text, 10, { bold: true });
      y += 6.5;
    } else if (b.type === 'text') {
      const size = b.size || 7.5;
      for (const l of wrapText(b.text, size, avail)) {
        if (y + size * PT * 1.6 > bottom) newPage(true);
        text(left, y + size * PT * 1.1, l, size);
        y += size * PT * 1.6;
      }
      y += 1.5;
    } else if (b.type === 'table') {
      if (y + HEAD_H + LINE_H * 2 > bottom && y > TOP) newPage(true);
      drawTable(b);
    }
  }

  // ページの見出しとページ番号（全ページ数が決まってから描く）
  pages.forEach((p, i) => {
    page = p;
    orientation = p.orientation;
    setPaper();
    const items = p.items;
    p.items = [];
    const cx = p.w / 2;
    const top = MARGIN.top;
    const title = p.title || doc.title;
    const period = p.period ?? doc.period;
    if (formal) {
      // 決算書：中央に表題（二重下線）と期間。表の左上に事業者名、右上に単位（表の幅にそろえる）
      const frame = p.frame ?? { left, right };
      const titleSize = 16;
      const tw = Math.min(textWidth(title, titleSize), p.w - 80);
      fitted(cx, top + 11, title, titleSize, p.w - 80, { align: 'center', bold: true });
      line(cx - tw / 2 - 4, top + 13.2, cx + tw / 2 + 4, top + 13.2, 0.3);
      line(cx - tw / 2 - 4, top + 14, cx + tw / 2 + 4, top + 14, 0.3);
      if (period) text(cx, top + 20.5, period, 9.5, { align: 'center' });
      if (doc.company) fitted(frame.left, TOP - 2.6, doc.company, 10, (frame.right - frame.left) * 0.7);
      const unit = p.unit ?? doc.unit;
      if (unit !== '') text(frame.right, TOP - 2.4, unit ?? '（単位：円）', 8.5, { align: 'right' });
      p.items.push(...items);
      if (pages.length > 1) text(cx, p.h - MARGIN.bottom - 1, `- ${i + 1} -`, 8.5, { align: 'center' });
      return;
    }
    if (doc.company) fitted(left, top + 3, doc.company, 9, cx - left - 40);
    if (doc.printedAt) text(right, top + 3, `作成日 ${warekiText(doc.printedAt)}`, 7.5, { align: 'right' });
    const titleSize = 15;
    const tw = Math.min(textWidth(title, titleSize), p.w - 120);
    fitted(cx, top + 9.5, title, titleSize, p.w - 120, { align: 'center', bold: true });
    line(cx - tw / 2 - 3, top + 11.4, cx + tw / 2 + 3, top + 11.4, 0.25);
    line(cx - tw / 2 - 3, top + 12.1, cx + tw / 2 + 3, top + 12.1, 0.25);
    if (period) text(cx, top + 17, period, 8.5, { align: 'center' });
    if (p.caption) fitted(left, TOP - 2, p.caption, 10.5, avail - 30, { bold: true });
    if (doc.unit !== '') text(right, TOP - 1.6, doc.unit ?? '（単位：円）', 7.5, { align: 'right' });
    p.items.push(...items);
    text(cx, p.h - MARGIN.bottom - 1, `${i + 1} / ${pages.length}`, 8, { align: 'center' });
    text(right, p.h - MARGIN.bottom - 1, 'Pocket会計', 6.5, { align: 'right' });
  });
  return pages;
}

/** 3桁区切り・マイナスは△（money.js の formatYen と同じ。組版を DOM なしで使えるようここにも置く） */
export function fmt(n) {
  if (!Number.isFinite(n)) return '';
  const abs = Math.abs(n)
    .toString()
    .replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return n < 0 ? `△${abs}` : abs;
}

/** 文を幅で折り返す */
export function wrapText(s, size, maxW) {
  const out = [];
  for (const para of String(s ?? '').split('\n')) {
    let cur = '';
    for (const ch of para) {
      if (textWidth(cur + ch, size) > maxW && cur) {
        out.push(cur);
        cur = '';
      }
      cur += ch;
    }
    out.push(cur);
  }
  return out;
}
