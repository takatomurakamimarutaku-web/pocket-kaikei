// ZIP ファイルを作る（純粋関数）。圧縮しない（格納のみ）。複数のファイルを1回で保存・共有するために使う
// 形式は PKWARE の APPNOTE（ZIP File Format Specification）の、ローカルヘッダ・中央ディレクトリ・終端レコードによる

let crcTable = null;

/** CRC-32（ZIP・PNG と同じ多項式 0xEDB88320） */
export function crc32(bytes) {
  crcTable ??= Array.from({ length: 256 }, (_, n) => {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    return c >>> 0;
  });
  let crc = 0xffffffff;
  for (const b of bytes) crc = crcTable[(crc ^ b) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

/** MS-DOS 形式の日時（2秒単位）。date は 'YYYY-MM-DDTHH:MM:SS' のような現地時刻の文字列 */
function dosDateTime(date) {
  const [y, mo, d, h = 0, mi = 0, s = 0] = date.match(/\d+/g).map(Number);
  return { time: (h << 11) | (mi << 5) | (s >> 1), date: ((Math.max(y, 1980) - 1980) << 9) | (mo << 5) | d };
}

/**
 * ZIP のバイト列を作る
 * @param {Array<{ name: string, bytes: Uint8Array }>} files name は UTF-8 で記録する
 * @param {string} date ファイルの更新日時（現地時刻 'YYYY-MM-DDTHH:MM:SS'）
 * @returns {Uint8Array}
 */
export function createZip(files, date) {
  const enc = new TextEncoder();
  const { time, date: day } = dosDateTime(date);
  const locals = [];
  const centrals = [];
  let offset = 0;
  for (const f of files) {
    const name = enc.encode(f.name);
    const crc = crc32(f.bytes);
    const size = f.bytes.length;
    const local = new DataView(new ArrayBuffer(30));
    local.setUint32(0, 0x04034b50, true); // ローカルファイルヘッダ
    local.setUint16(4, 20, true); // 展開に必要なバージョン 2.0
    local.setUint16(6, 0x0800, true); // ファイル名は UTF-8
    local.setUint16(8, 0, true); // 格納（無圧縮）
    local.setUint16(10, time, true);
    local.setUint16(12, day, true);
    local.setUint32(14, crc, true);
    local.setUint32(18, size, true);
    local.setUint32(22, size, true);
    local.setUint16(26, name.length, true);
    local.setUint16(28, 0, true);
    locals.push(new Uint8Array(local.buffer), name, f.bytes);

    const central = new DataView(new ArrayBuffer(46));
    central.setUint32(0, 0x02014b50, true); // 中央ディレクトリ
    central.setUint16(4, 20, true);
    central.setUint16(6, 20, true);
    central.setUint16(8, 0x0800, true);
    central.setUint16(10, 0, true);
    central.setUint16(12, time, true);
    central.setUint16(14, day, true);
    central.setUint32(16, crc, true);
    central.setUint32(20, size, true);
    central.setUint32(24, size, true);
    central.setUint16(28, name.length, true);
    central.setUint32(42, offset, true); // ローカルヘッダの位置
    centrals.push(new Uint8Array(central.buffer), name);
    offset += 30 + name.length + size;
  }
  const centralSize = centrals.reduce((s, b) => s + b.length, 0);
  const end = new DataView(new ArrayBuffer(22));
  end.setUint32(0, 0x06054b50, true); // 終端レコード
  end.setUint16(8, files.length, true);
  end.setUint16(10, files.length, true);
  end.setUint32(12, centralSize, true);
  end.setUint32(16, offset, true);
  const parts = [...locals, ...centrals, new Uint8Array(end.buffer)];
  const out = new Uint8Array(parts.reduce((s, b) => s + b.length, 0));
  let p = 0;
  for (const b of parts) {
    out.set(b, p);
    p += b.length;
  }
  return out;
}
