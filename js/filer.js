// 申告書の提出者の欄（純粋関数とデータ）：納税地・フリガナ・代表者・法人番号・提出先など
// 申告書の頭書き（国税庁・都道府県・市町村の様式の上の欄）に印刷する。settings.filer に保存する（DB の版は変えない）
// マイナンバー（個人番号）は保存しない：印刷した申告書の空欄に手で書く（端末に置く個人情報を増やさないため）
//
// 法人番号の検査用数字（先頭の1桁）：9−（下から奇数桁の数字の和＋偶数桁の数字の和×2）を9で割った余り
//   国税庁 法人番号公表サイト「チェックデジットの計算方法」（例：700110005901 → 8700110005901）
//   （出典の URL は docs/spec-phase3-tax-forms.md）

export const MAX_FILER_TEXT = 80;

/** 欄の定義。for：corporation（法人）・individual（個人）・both */
export const FILER_FIELDS = [
  { key: 'taxOffice', label: '提出先の税務署', for: 'both', hint: '「麹町」のように税務署の名前だけ。申告書に「○○税務署長殿」と印刷します', max: 20 },
  { key: 'zip', label: '郵便番号', for: 'both', hint: '例：100-0001', max: 8, inputmode: 'numeric' },
  { key: 'address', label: '納税地', for: 'corporation', hint: '本店の所在地（登記の住所）' },
  { key: 'address', label: '住所', for: 'individual', hint: '1月1日現在ではなく、提出する日の住所' },
  { key: 'businessAddress', label: '事業所の所在地', for: 'individual', hint: '住所と違うときだけ（青色申告決算書・収支内訳書に印刷します）' },
  { key: 'phone', label: '電話番号', for: 'both', max: 20, inputmode: 'tel' },
  { key: 'kana', label: '法人名のフリガナ', for: 'corporation', hint: 'カタカナで' },
  { key: 'corporateNumber', label: '法人番号（13桁）', for: 'corporation', hint: '国税庁の法人番号公表サイトで調べられます', max: 13, inputmode: 'numeric' },
  { key: 'representative', label: '代表者の氏名', for: 'corporation' },
  { key: 'representativeKana', label: '代表者の氏名のフリガナ', for: 'corporation' },
  { key: 'accountant', label: '経理責任者の氏名', for: 'corporation' },
  { key: 'ownerName', label: '氏名', for: 'individual', hint: '事業者名（屋号）とは別に、申告する人の氏名' },
  { key: 'kana', label: '氏名のフリガナ', for: 'individual', hint: 'カタカナで' },
  { key: 'occupation', label: '職業', for: 'individual', hint: '例：デザイナー' },
  { key: 'tradeName', label: '屋号', for: 'individual', hint: '空欄なら事業者名を使います' },
  { key: 'businessType', label: '事業種目', for: 'corporation', hint: '例：ソフトウェア開発' },
  { key: 'businessType', label: '業種名', for: 'individual', hint: '青色申告決算書の「業種名」。例：小売業' },
  { key: 'association', label: '加入団体名', for: 'individual', hint: '青色申告会など（無ければ空欄）' },
  { key: 'prefOffice', label: '都道府県の宛名', for: 'corporation', hint: '「神奈川県知事」「千代田都税事務所長」など。事業税・道府県民税の申告書（第六号様式）に「○○　殿」と印刷します' },
  { key: 'city', label: '市町村の宛名', for: 'corporation', hint: '「横浜市長」など。市町村民税の申告書（第二十号様式）と償却資産申告書に印刷します（東京23区は空欄）' },
  { key: 'city', label: '市町村の宛名', for: 'individual', hint: '「横浜市長」など。償却資産申告書に「○○　殿」と印刷します' },
  { key: 'taxAccountant', label: '関与税理士', for: 'both', hint: '税理士に頼んでいるときの氏名と電話番号' },
];

/** その事業形態で使う欄 */
export function filerFields(entityType) {
  return FILER_FIELDS.filter((f) => f.for === 'both' || f.for === entityType);
}

const KEYS = [...new Set(FILER_FIELDS.map((f) => f.key))];

/** 保存する形にそろえる（前後の空白を取り、知らない項目は捨てる。法人番号・郵便番号は半角の数字に） */
export function cleanFiler(v = {}) {
  const out = {};
  for (const k of KEYS) {
    const s = typeof v[k] === 'string' ? v[k].trim() : '';
    out[k] = s;
  }
  out.corporateNumber = toHalf(out.corporateNumber).replace(/[\s-]/g, '');
  out.zip = toHalf(out.zip).replace(/[^0-9-]/g, '');
  if (/^\d{7}$/.test(out.zip)) out.zip = `${out.zip.slice(0, 3)}-${out.zip.slice(3)}`;
  out.phone = toHalf(out.phone);
  return out;
}

/** 全角の数字・ハイフンを半角に */
function toHalf(s) {
  return String(s ?? '')
    .replace(/[０-９]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0))
    .replace(/[－ー―‐]/g, '-');
}

/**
 * 法人番号の検査用数字が合っているか（13桁の先頭が検査用数字）
 * 検査用数字＝9−（下から n 桁目の数字×（n が奇数なら1、偶数なら2）の合計を9で割った余り）
 */
export function isValidCorporateNumber(s) {
  if (!/^\d{13}$/.test(s)) return false;
  const digits = [...s].map(Number);
  const base = digits.slice(1).reverse(); // 下の桁から
  const sum = base.reduce((t, d, i) => t + d * (i % 2 === 0 ? 1 : 2), 0);
  return digits[0] === 9 - (sum % 9);
}

/** 入力の検証。{ key: メッセージ } を返す（空なら問題なし） */
export function validateFiler(v) {
  const errors = {};
  for (const f of FILER_FIELDS) {
    const s = v[f.key] ?? '';
    if (typeof s !== 'string') errors[f.key] = `${f.label}は文字で入力してください`;
    else if (s.length > (f.max ?? MAX_FILER_TEXT)) errors[f.key] = `${f.label}は${f.max ?? MAX_FILER_TEXT}文字までです`;
  }
  if (v.corporateNumber && !isValidCorporateNumber(v.corporateNumber)) errors.corporateNumber = '法人番号は13桁の数字です（先頭の検査用数字が合いません）';
  if (v.zip && !/^\d{3}-\d{4}$/.test(v.zip)) errors.zip = '郵便番号は7桁の数字で入力してください';
  if (v.phone && !/^[0-9()+\- ]{6,20}$/.test(v.phone)) errors.phone = '電話番号は数字とハイフンで入力してください';
  return errors;
}

/** 印刷に使う提出者の情報（保存が無ければ空欄。屋号は空なら事業者名） */
export function filerOf(settings) {
  const f = cleanFiler(settings?.filer || {});
  const name = settings?.businessName || '';
  return { ...f, name, tradeName: f.tradeName || (settings?.entityType === 'individual' ? name : '') };
}

/** 入力が1つでもあるか（申告書の画面で「提出者の欄を入力」を促すため） */
export function hasFiler(settings) {
  const f = settings?.filer;
  return Boolean(f && KEYS.some((k) => typeof f[k] === 'string' && f[k].trim()));
}
