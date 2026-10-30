// 画面の表から帳票を作る（専用の様式を持たない帳票用）。画面に出ている見出し・表・注記を順に拾い、
// print-layout.js の doc にする。表の見出し行・合計行・区分の見出しは、行と列の class と構造から判断する

const SKIP = '.no-print, .chara, .chara-say, button, input, textarea, label.check, .segmented, .range-bar, .month-bar, .ledger-pick, .search-bar, .toggles, .chip-row, .option-bar, .report-tools, .actions, .notice, .emptystate, .empty-state, details:not([open])';
const HEADING = 'h1, h2, h3, h4, .section-title, .fs-title';
const PAGE = '.br-page, .fs-section';
/** 列の少ない表の金額の列の幅と、科目の列の幅（mm） */
const NUM_W = 30;
const COMPACT_LABEL_W = 92;
const NUM_RE = /^[△\-+]?[\d,]+(\.\d+)?%?$|^—$/;

function hidden(el) {
  if (el.matches(SKIP)) return true;
  // 画面では隠していても印刷するもの（青色申告決算書の他のページ・印刷用の見出し）
  if (el.matches('.br-page, .print-only')) return false;
  return getComputedStyle(el).display === 'none';
}

/** セルの文字（表示上の改行で行に分ける。開閉の印は除く） */
function cellLines(cell) {
  const parts = [];
  const walk = (n) => {
    for (const c of n.childNodes) {
      if (c.nodeType === Node.TEXT_NODE) {
        if (c.textContent.trim()) parts.push({ text: c.textContent, block: false });
      } else if (c.nodeType === Node.ELEMENT_NODE) {
        if (c.matches('button.tb-toggle, a') || !c.matches(SKIP)) {
          if (c.matches('select')) {
            parts.push({ text: c.selectedOptions?.[0]?.textContent ?? '', block: false });
            continue;
          }
          if (c.matches('input')) continue;
          const block = ['block', 'flex', 'grid', 'list-item'].includes(getComputedStyle(c).display);
          if (block) parts.push({ br: true });
          walk(c);
          if (block) parts.push({ br: true });
        }
      }
    }
  };
  walk(cell);
  const lines = [''];
  for (const p of parts) {
    if (p.br) {
      if (lines.at(-1).trim()) lines.push('');
    } else lines[lines.length - 1] += p.text;
  }
  const out = lines.map((l) => l.replace(/\s+/g, ' ').replace(/^[▸▾]\s*/, '').trim()).filter(Boolean);
  return out.length ? out.slice(0, 3) : [''];
}

/** 表を doc の table にする */
export function captureTable(table) {
  const headRows = [...(table.tHead?.rows || [])];
  const bodyRows = [...table.tBodies].flatMap((b) => [...b.rows]).concat([...(table.tFoot?.rows || [])]);
  // 列の数：行のセルの colspan の合計の最大
  const width = (tr) => [...tr.cells].reduce((s, c) => s + (c.colSpan || 1), 0);
  const n = Math.max(1, ...headRows.map(width), ...bodyRows.map(width));
  // 見出し：各列の上から下までの文字（同じ文字は1回）
  const labels = Array.from({ length: n }, () => []);
  const numCol = Array(n).fill(false);
  const occupied = headRows.map(() => Array(n).fill(false));
  headRows.forEach((tr, ri) => {
    let col = 0;
    for (const c of tr.cells) {
      while (col < n && occupied[ri][col]) col++;
      const span = c.colSpan || 1;
      const rs = c.rowSpan || 1;
      const t = cellLines(c).join(' ');
      for (let k = col; k < Math.min(n, col + span); k++) {
        if (t && labels[k].at(-1) !== t) labels[k].push(t);
        if (c.classList.contains('num')) numCol[k] = true;
        for (let r = ri; r < Math.min(headRows.length, ri + rs); r++) occupied[r][k] = true;
      }
      col += span;
    }
  });
  const rows = [];
  for (const tr of bodyRows) {
    if (tr.hidden || hidden(tr)) continue;
    const cls = tr.className || '';
    const inFoot = tr.parentElement === table.tFoot;
    const cells = [];
    let col = 0;
    for (const c of tr.cells) {
      const span = Math.min(c.colSpan || 1, n - col);
      if (span <= 0) break;
      const lines = cellLines(c);
      const isNum = c.classList.contains('num') || (lines.length === 1 && NUM_RE.test(lines[0]) && lines[0] !== '');
      cells.push({ text: lines, span, align: isNum ? 'right' : span > 1 && col > 0 ? 'right' : undefined });
      if (span === 1 && isNum && lines[0]) numCol[col] = true;
      col += span;
    }
    if (!cells.length) continue;
    let kind;
    if (/total|sum/.test(cls) || inFoot) kind = /subtotal/.test(cls) ? 'subtotal' : 'total';
    else if (/group|heading/.test(cls) || (cells.length === 1 && cells[0].span === n && n > 1)) kind = 'group';
    if (/level2|tb-sub|st-line|st-note|indent/.test(cls) && cells[0]) cells[0].indent = 3;
    rows.push({ cells, kind });
  }
  if (!rows.length) return null;
  // 列の少ない表（科目｜金額、指標｜当期｜前期 など）は用紙いっぱいに広げない：科目と金額が離れすぎないよう、
  // 金額の列の幅をそろえ、表の幅を列の数で決めて中央に置く（決算書の体裁と同じ考え方）
  const nums = numCol.filter(Boolean).length;
  const compact = n <= 4 && nums >= 1 && nums < n;
  const columns = labels.map((l, i) => ({ label: l.slice(-2).join('\n'), align: numCol[i] ? 'right' : undefined, max: numCol[i] ? 40 : 80, ...(compact && numCol[i] ? { w: NUM_W } : {}) }));
  return { type: 'table', columns, rows, ...(compact ? { width: COMPACT_LABEL_W + NUM_W * nums } : {}) };
}

/**
 * 画面（outlet）から帳票を作る
 * @returns {{ blocks: Array }}
 */
export function captureBlocks(root) {
  const blocks = [];
  const walk = (el) => {
    for (const c of el.children) {
      if (hidden(c)) continue;
      if (c.matches(PAGE)) {
        // 青色申告決算書のページ・決算書の各表：ページの見出しで改ページ
        const title = c.querySelector(':scope > .br-page-title, :scope > .fs-title, :scope > h2, :scope > h3');
        if (title) blocks.push({ type: 'heading', caption: true, text: cellLines(title).join(' ') });
        walk(c);
        continue;
      }
      if (c.matches('table')) {
        const cap = c.caption ? cellLines(c.caption).join(' ') : '';
        if (cap) blocks.push({ type: 'heading', text: cap });
        const t = captureTable(c);
        if (t) blocks.push(t);
        continue;
      }
      if (c.matches(HEADING)) {
        if (c.matches('.br-page-title') || (c.parentElement?.matches(PAGE) && blocks.at(-1)?.caption && cellLines(c).join(' ') === blocks.at(-1).text)) continue;
        const t = cellLines(c).join(' ');
        if (t) blocks.push({ type: 'heading', text: t });
        continue;
      }
      if (c.matches('p, li, dt, dd') && !c.querySelector('table')) {
        if (c.matches('.muted, .list-meta, .loading')) continue;
        const t = c.textContent.replace(/\s+/g, ' ').trim();
        if (t) blocks.push({ type: 'text', text: c.matches('li') ? `・${t}` : t });
        continue;
      }
      walk(c);
    }
  };
  walk(root);
  return { blocks };
}

/** 画面の月の範囲の選択（開始月・終了月）。無ければ null */
export function capturedRange(root) {
  const sels = root.querySelectorAll('.range-bar select');
  if (sels.length !== 2) return null;
  return { fromMonth: sels[0].value, toMonth: sels[1].value };
}
