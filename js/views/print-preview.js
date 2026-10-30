// 帳票の印刷プレビュー：A4 の用紙の形で表示し、PDF の保存・共有と印刷をする
// 組版は print-layout.js、PDF は print-pdf.js。プレビュー（SVG）と PDF は同じ部品から描くので見た目が一致する
import { h, saveFile, showToast, trapFocus } from '../ui.js';
import { layoutDocument, textWidth, PT } from '../print-layout.js';
import { buildPdf } from '../print-pdf.js';
import { browserPrintWorks } from '../install.js';

const SVG_NS = 'http://www.w3.org/2000/svg';
const FONT_FAMILY = '"Hiragino Kaku Gothic ProN", "Hiragino Sans", "Yu Gothic", "Meiryo", "Noto Sans JP", "IPAGothic", sans-serif';

function el(tag, attrs) {
  const e = document.createElementNS(SVG_NS, tag);
  for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, String(v));
  return e;
}

/** 1ページを SVG にする（単位 mm。利用者の文字は textContent で入れる） */
export function pageSvg(page) {
  const s = el('svg', { viewBox: `0 0 ${page.w} ${page.h}`, class: `pp-page ${page.orientation}`, role: 'img', 'font-family': FONT_FAMILY });
  s.append(el('rect', { x: 0, y: 0, width: page.w, height: page.h, fill: '#fff' }));
  for (const it of page.items) {
    if (it.t === 'rect') {
      const g = Math.round(it.gray * 255);
      s.append(el('rect', { x: it.x, y: it.y, width: it.w, height: it.h, fill: `rgb(${g},${g},${g})` }));
    } else if (it.t === 'line') {
      s.append(el('line', { x1: it.x1, y1: it.y1, x2: it.x2, y2: it.y2, stroke: '#000', 'stroke-width': it.w }));
    } else if (it.t === 'text') {
      const anchor = it.align === 'right' ? 'end' : it.align === 'center' ? 'middle' : 'start';
      const attrs = { 'font-size': (it.size * PT).toFixed(3), 'text-anchor': anchor, fill: '#000' };
      if (it.bold) attrs['font-weight'] = 'bold';
      // 幅は PDF と同じ計算（全角1・半角0.5・カンマ0.3）にそろえる。表示のフォントの字幅の違いで列からはみ出さないように
      const w = textWidth(it.text, it.size) * (it.scale ?? 1);
      Object.assign(attrs, { x: it.x, y: it.y, textLength: w.toFixed(3), lengthAdjust: 'spacingAndGlyphs' });
      const t = el('text', attrs);
      t.textContent = it.text;
      s.append(t);
    }
  }
  return s;
}

const env = () => ({
  standalone: navigator.standalone,
  displayModeStandalone: typeof matchMedia === 'function' && matchMedia('(display-mode: standalone)').matches,
  userAgent: navigator.userAgent,
  maxTouchPoints: navigator.maxTouchPoints || 0,
});

/**
 * 印刷条件の欄。options：[{ key, label, type: 'select'|'check'|'number', choices?: [[value, label]], value, min?, max?, placeholder? }]
 * number は整数の欄（期数など。空欄も選べる）
 * 条件を変えると onChange(values) を呼ぶ
 */
function optionsPanel(options, onChange) {
  const values = Object.fromEntries(options.map((o) => [o.key, o.value]));
  const controls = options.map((o) => {
    const id = `pp-opt-${o.key}`;
    if (o.type === 'check') {
      return h(
        'label',
        { class: 'pp-check', for: id },
        h('input', { id, type: 'checkbox', checked: Boolean(o.value), onchange: (e) => ((values[o.key] = e.target.checked), onChange({ ...values })) }),
        h('span', { text: o.label }),
      );
    }
    if (o.type === 'number') {
      return h(
        'label',
        { class: 'pp-select', for: id },
        h('span', { class: 'pp-opt-label', text: o.label }),
        h('input', { id, type: 'number', inputmode: 'numeric', class: 'pp-number', min: o.min ?? 0, max: o.max ?? '', step: 1, placeholder: o.placeholder ?? '', value: o.value ?? '', oninput: (e) => ((values[o.key] = e.target.value), onChange({ ...values })) }),
      );
    }
    return h(
      'label',
      { class: 'pp-select', for: id },
      h('span', { class: 'pp-opt-label', text: o.label }),
      h(
        'select',
        { id, onchange: (e) => ((values[o.key] = e.target.value), onChange({ ...values })) },
        o.choices.map(([v, label]) => h('option', { value: v, text: label, selected: String(v) === String(o.value) })),
      ),
    );
  });
  return { el: h('details', { class: 'pp-options', open: true }, h('summary', { text: '印刷条件' }), h('div', { class: 'pp-options-body' }, controls)), values };
}

/**
 * 印刷プレビューを開く
 * @param {object} source print-layout.js の doc、または { options, build(values) → doc }（印刷条件を選べる帳票）
 * @param {{ fileName: string }} opts ファイル名（拡張子なし）
 */
export function openPrintPreview(source, { fileName }) {
  const prevFocus = document.activeElement;
  const pdfName = `${fileName}.pdf`;
  const build = typeof source.build === 'function' ? source.build : () => source;
  const options = source.options || [];
  let doc;
  let pages;
  const titleEl = h('strong');
  const metaEl = h('span', { class: 'muted small' });
  const pagesEl = h('div', { class: 'pp-pages' });

  function render(values) {
    try {
      doc = build(values);
      pages = layoutDocument(doc);
    } catch (e) {
      console.error(e);
      showToast('この条件では帳票を作れませんでした');
      return;
    }
    titleEl.textContent = doc.title.replace(/ (?=\S)/g, '');
    const orientation = pages[0]?.orientation === 'landscape' ? 'A4横' : 'A4縦';
    metaEl.textContent = `${orientation}・全${pages.length}ページ`;
    pagesEl.replaceChildren(...pages.map((p, i) => h('div', { class: `pp-sheet ${p.orientation}`, 'aria-label': `${i + 1}ページ` }, pageSvg(p))));
  }
  const panel = options.length ? optionsPanel(options, render) : null;
  render(panel ? panel.values : {});
  if (!doc) return null;
  const pdfBlob = () => new Blob([buildPdf(pages, { title: titleEl.textContent })], { type: 'application/pdf' });

  async function savePdf() {
    const r = await saveFile(pdfBlob(), pdfName);
    if (r === 'downloaded') showToast('PDF を保存しました');
  }
  async function print() {
    if (!browserPrintWorks(env())) {
      // ホーム画面のアプリでは印刷画面が開かないため、PDF を共有シートで開く（共有シートの「プリント」で印刷できる）
      showToast('共有メニューの「プリント」で印刷できます', { duration: 5000 });
      await saveFile(pdfBlob(), pdfName);
      return;
    }
    const style = h('style', { text: `@page { size: A4 ${pages[0]?.orientation ?? 'portrait'}; margin: 0; }` });
    document.head.append(style);
    document.body.classList.add('printing-preview');
    const done = () => {
      document.body.classList.remove('printing-preview');
      style.remove();
      window.removeEventListener('afterprint', done);
    };
    window.addEventListener('afterprint', done);
    window.print();
    // afterprint が来ないブラウザ向け
    setTimeout(() => document.body.classList.contains('printing-preview') && !matchMedia('print').matches && done(), 1500);
  }
  function close() {
    overlay.remove();
    document.removeEventListener('keydown', onKey);
    release();
    document.documentElement.classList.remove('pp-open');
    if (prevFocus?.focus) prevFocus.focus();
  }
  const onKey = (e) => e.key === 'Escape' && close();

  const overlay = h(
    'div',
    { class: 'print-preview', role: 'dialog', 'aria-modal': 'true', 'aria-label': `${titleEl.textContent}の印刷プレビュー` },
    h(
      'div',
      { class: 'pp-bar' },
      h('button', { type: 'button', class: 'btn btn-small', text: '閉じる', onclick: close }),
      h('div', { class: 'pp-title' }, titleEl, metaEl),
      h('button', { type: 'button', class: 'btn btn-small', text: '印刷', onclick: print }),
      h('button', { type: 'button', class: 'btn btn-small btn-primary', text: 'PDF', 'aria-label': 'PDFを保存・共有', onclick: savePdf }),
    ),
    h('div', { class: 'pp-scroll' }, panel?.el, pagesEl),
  );
  document.body.append(overlay);
  document.documentElement.classList.add('pp-open');
  document.addEventListener('keydown', onKey);
  const release = trapFocus(overlay);
  overlay.querySelector('.btn-primary').focus();
  return { close, pages: () => pages, rebuild: render };
}
