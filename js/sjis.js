// 文字列を Shift_JIS（Windows-31J）のバイト列にする（純粋関数）
// 変換表は持たず、ブラウザの TextDecoder('shift_jis') で2バイトの全組合せを読んで逆引きの表を作る（初回だけ）

let table = null;

// Shift_JIS にない文字の言い換え（Unicode の似た文字。Mac・iPhone で入力されやすいもの）
const ALIASES = {
  '〜': '～', // 〜 → ～
  '−': '－', // − → －
  '‖': '∥', // ‖ → ∥
  '—': '―', // — → ―
  '¢': '￠', // ¢ → ￠
  '£': '￡', // £ → ￡
  '¬': '￢', // ¬ → ￢
  '¥': '\\', // ¥ → \（Shift_JIS の 0x5C は円記号として表示される）
  ' ': ' ',
};

function buildTable() {
  const decoder = new TextDecoder('shift_jis');
  const map = new Map();
  for (let b = 0x20; b < 0x7f; b++) map.set(String.fromCharCode(b), [b]);
  for (let b = 0xa1; b <= 0xdf; b++) map.set(decoder.decode(new Uint8Array([b])), [b]);
  const leads = [];
  for (let b = 0x81; b <= 0x9f; b++) leads.push(b);
  for (let b = 0xe0; b <= 0xfc; b++) if (b < 0xf0 || b > 0xf9) leads.push(b); // 0xF0〜0xF9 は外字の領域
  // NEC 選定 IBM 拡張文字（0xED・0xEE）より IBM 拡張文字（0xFA〜0xFC）を優先する（WHATWG の符号化と同じ）
  const order = [...leads.filter((b) => b !== 0xed && b !== 0xee), 0xed, 0xee];
  for (const lead of order) {
    for (let trail = 0x40; trail <= 0xfc; trail++) {
      if (trail === 0x7f) continue;
      const ch = decoder.decode(new Uint8Array([lead, trail]));
      if (ch.length !== 1 || ch === '�' || map.has(ch)) continue;
      map.set(ch, [lead, trail]);
    }
  }
  return map;
}

/**
 * Shift_JIS にする。表せない文字は「?」にして、その文字を返す
 * @returns {{ bytes: Uint8Array, unmappable: string[] }}
 */
export function encodeShiftJis(text) {
  table ??= buildTable();
  const out = [];
  const unmappable = new Set();
  for (const ch of String(text)) {
    if (ch === '\r' || ch === '\n' || ch === '\t') {
      out.push(ch.charCodeAt(0));
      continue;
    }
    const code = table.get(ch) ?? table.get(ALIASES[ch]) ?? table.get(ch.normalize('NFKC'));
    if (code) out.push(...code);
    else {
      out.push(0x3f);
      unmappable.add(ch);
    }
  }
  return { bytes: Uint8Array.from(out), unmappable: [...unmappable] };
}
