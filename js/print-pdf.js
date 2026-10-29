// 帳票の PDF 書き出し（純粋関数）：print-layout.js のページ（文字・罫線・塗り）を PDF にする
// 外部ライブラリを使わない（ビルド不要・外部CDN不使用の方針）。
// 日本語は PDF の標準の日本語フォント（平成角ゴシック W5、Adobe-Japan1）を埋め込まずに指定する。
// 表示する側（iPhone・Mac のプレビュー、Chrome、Acrobat など）が手元の日本語フォントで描く。
// 文字コードは UniJIS-UCS2-HW-H（UCS-2。ASCII を半角の字形にする）。半角の幅は全角の半分（W で指定）で、
// 組版の幅の計算（print-layout.js の emWidth）と一致する

import { PT, isHalfWidth } from './print-layout.js';

const K = 72 / 25.4; // mm → pt
const num = (n) => {
  const r = Math.round(n * 100) / 100;
  return Object.is(r, -0) ? '0' : String(r);
};

/** 文字を UCS-2（16進）にする。BMP の外の文字（絵文字など）は〓にする */
export function ucs2Hex(s) {
  let out = '';
  for (const ch of String(s)) {
    let cp = ch.codePointAt(0);
    if (cp > 0xffff || cp < 0x20) cp = cp < 0x20 ? 0x20 : 0x3013;
    out += cp.toString(16).padStart(4, '0');
  }
  return out.toUpperCase();
}

/** 文字の幅（PDF の文字単位 1/1000 em） */
function width1000(s) {
  let w = 0;
  for (const ch of String(s)) {
    const cp = ch.codePointAt(0);
    w += cp === 0x2c ? 300 : cp <= 0xffff && isHalfWidth(cp) ? 500 : 1000;
  }
  return w;
}

/**
 * 文字を描く命令。半角の空白は字形を描かずに送る（表示側のフォントによっては空白が四角になるため）。
 * 幅は print-layout.js の emWidth と一致させる
 * TJ の数値は 1/1000 em 単位で、負の値で右へ送る
 */
export function showText(s) {
  const parts = [];
  for (const run of String(s).split(/( +|,)/)) {
    if (!run) continue;
    if (run[0] === ' ') parts.push(String(-500 * run.length));
    // 桁区切りのカンマは前後を詰めて 0.3em にする（半角の字形のままだと「1, 000」のように空いて見える）
    else if (run === ',') parts.push(`100 <${ucs2Hex(',')}> 100`);
    else parts.push(`<${ucs2Hex(run)}>`);
  }
  return `[${parts.join(' ')}] TJ`;
}

/** 1ページ分の描画命令 */
export function pageContent(page) {
  const H = page.h * K;
  const out = [];
  for (const it of page.items) {
    if (it.t === 'rect') {
      out.push(`${num(it.gray)} g ${num(it.x * K)} ${num(H - (it.y + it.h) * K)} ${num(it.w * K)} ${num(it.h * K)} re f`);
    } else if (it.t === 'line') {
      out.push(`0 G ${num(it.w * K)} w ${num(it.x1 * K)} ${num(H - it.y1 * K)} m ${num(it.x2 * K)} ${num(H - it.y2 * K)} l S`);
    } else if (it.t === 'text') {
      if (!it.text) continue;
      const scale = it.scale ?? 1;
      const w = (width1000(it.text) / 1000) * it.size * scale; // pt
      let x = it.x * K;
      if (it.align === 'right') x -= w;
      else if (it.align === 'center') x -= w / 2;
      // 太字は輪郭も塗って太らせる（日本語フォントの太字を指定しても表示側に無いことが多いため）
      const mode = it.bold ? `2 Tr ${num(it.size * 0.03)} w` : '0 Tr';
      out.push(`BT 0 g 0 G ${mode} /F1 ${num(it.size)} Tf ${num(scale * 100)} Tz 1 0 0 1 ${num(x)} ${num(H - it.y * K)} Tm ${showText(it.text)} ET`);
    }
  }
  return out.join('\n');
}

/** PDF の日付（D:YYYYMMDDHHmmSS） */
function pdfDate(d) {
  const p = (n) => String(n).padStart(2, '0');
  return `D:${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

/**
 * ページの一覧を PDF にする
 * @param {Array<{w, h, items}>} pages print-layout.js の layoutDocument の結果
 * @param {{ title?: string, now?: Date }} opts
 * @returns {Uint8Array}
 */
export function buildPdf(pages, { title = '', now = new Date() } = {}) {
  const objs = []; // 1 から始まる番号の中身（文字列。すべて ASCII）
  const add = (body) => objs.push(body) && objs.length;
  const catalog = add(null);
  const pagesId = add(null);
  const descriptor = add(
    '<< /Type /FontDescriptor /FontName /HeiseiKakuGo-W5 /Flags 4 /FontBBox [-92 -250 1010 922] /ItalicAngle 0 /Ascent 880 /Descent -120 /CapHeight 737 /StemV 114 /Style << /Panose <0801020b0600000000000000> >> >>',
  );
  const cidFont = add(`<< /Type /Font /Subtype /CIDFontType0 /BaseFont /HeiseiKakuGo-W5 /CIDSystemInfo << /Registry (Adobe) /Ordering (Japan1) /Supplement 2 >> /FontDescriptor ${descriptor} 0 R /DW 1000 /W [231 389 500] >>`);
  const font = add(`<< /Type /Font /Subtype /Type0 /BaseFont /HeiseiKakuGo-W5-UniJIS-UCS2-HW-H /Encoding /UniJIS-UCS2-HW-H /DescendantFonts [${cidFont} 0 R] >>`);
  const kids = [];
  for (const p of pages) {
    const content = pageContent(p);
    const c = add(`<< /Length ${content.length} >>\nstream\n${content}\nendstream`);
    kids.push(add(`<< /Type /Page /Parent ${pagesId} 0 R /MediaBox [0 0 ${num(p.w * K)} ${num(p.h * K)}] /Resources << /Font << /F1 ${font} 0 R >> >> /Contents ${c} 0 R >>`));
  }
  objs[catalog - 1] = `<< /Type /Catalog /Pages ${pagesId} 0 R /ViewerPreferences << /DisplayDocTitle true >> >>`;
  objs[pagesId - 1] = `<< /Type /Pages /Kids [${kids.map((k) => `${k} 0 R`).join(' ')}] /Count ${kids.length} >>`;
  const info = add(`<< /Title <FEFF${ucs2Hex(title)}> /Producer (Pocket Kaikei) /CreationDate (${pdfDate(now)}) >>`);

  let out = '%PDF-1.4\n%\xE2\xE3\xCF\xD3\n';
  const offsets = [];
  objs.forEach((body, i) => {
    offsets.push(out.length);
    out += `${i + 1} 0 obj\n${body}\nendobj\n`;
  });
  const xref = out.length;
  out += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n`;
  for (const o of offsets) out += `${String(o).padStart(10, '0')} 00000 n \n`;
  out += `trailer\n<< /Size ${objs.length + 1} /Root ${catalog} 0 R /Info ${info} 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  // 2行目の4文字（バイナリを含む印）以外はすべて ASCII なので、1文字＝1バイトで書く
  const bytes = new Uint8Array(out.length);
  for (let i = 0; i < out.length; i++) bytes[i] = out.charCodeAt(i) & 0xff;
  return bytes;
}
