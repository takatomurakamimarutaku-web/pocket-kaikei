// 申告書の頭書き（純粋関数）：様式の上の欄（提出日・提出先・納税地・名称・番号・代表者・事業年度など）を、
// 項目名を薄く塗った2組の欄の表にする。国税庁・都道府県・市町村の様式の頭書きの項目と並びにならう
//   適用額明細書：提出先・納税地・法人名・法人番号・事業種目・業種番号・期末現在の資本金の額・所得金額又は欠損金額
//   法人税申告書 別表一：納税地・フリガナ・法人名・法人番号・代表者・経理責任者・事業種目・期末現在の資本金の額・事業年度
//   第六号様式・第二十号様式：所在地・法人名・法人番号・代表者・事業種目・資本金等の額・従業者数・事業年度・申告区分
//   消費税の申告書 第一表：納税地・名称又は屋号・個人番号又は法人番号・代表者氏名又は氏名・課税期間
//   所得税の申告書 第一表：住所・フリガナ・氏名・職業・屋号・雅号・電話番号・個人番号
//   青色申告決算書・収支内訳書：住所・事業所所在地・業種名・屋号・氏名・電話番号・加入団体名・依頼税理士等
// 入力の無い欄は空欄のまま印刷する（手で書けるように）。個人番号は保存しないので常に空欄
import { fmt, warekiText } from './print-layout.js';

const BLANK_DATE = '令和　　年　　月　　日';
const label = (text) => ({ text, shade: true, size: 7, align: 'center' });

/**
 * 項目と内容の組を2組ずつ並べた表
 * @param {Array<[string, string] | { label: string, value: string, wide?: boolean } | null>} items wide：1行を使う
 */
export function formHeadBlock(items) {
  const list = items.filter(Boolean).map((it) => (Array.isArray(it) ? { label: it[0], value: it[1] } : it));
  const rows = [];
  let pending = null;
  const flush = () => {
    if (pending) rows.push({ cells: [label(pending.label), pending.value ?? '', label(''), ''] });
    pending = null;
  };
  for (const it of list) {
    if (it.wide) {
      flush();
      rows.push({ cells: [label(it.label), { text: it.value ?? '', span: 3 }] });
    } else if (pending) {
      rows.push({ cells: [label(pending.label), pending.value ?? '', label(it.label), it.value ?? ''] });
      pending = null;
    } else pending = it;
  }
  flush();
  return { type: 'table', columns: [{ label: '', w: 27 }, { label: '', grow: 1, min: 40 }, { label: '', w: 27 }, { label: '', grow: 1, min: 40 }], rows, font: 8, rowH: 5.6 };
}

const office = (name, suffix) => (name ? `${name}${suffix}` : `　　　　　　${suffix}`);
const addr = (f, key = 'address') => [f.zip ? `〒${f.zip}` : '', f[key]].filter(Boolean).join('　');
const period = (from, to) => `自 ${warekiText(from)}　至 ${warekiText(to)}`;
const yen = (n) => (Number.isFinite(n) ? `${fmt(n)}円` : '');

/** 法人税申告書（別表一）の頭書き */
export function corporateHead(f, { startDate, endDate, capital, sme }) {
  return formHeadBlock([
    ['提出日', BLANK_DATE],
    ['提出先', office(f.taxOffice, '税務署長殿')],
    { label: '納税地', value: addr(f), wide: true },
    ['電話番号', f.phone],
    ['法人番号', f.corporateNumber],
    ['フリガナ', f.kana],
    ['法人名', f.name],
    ['代表者', f.representative],
    ['経理責任者', f.accountant],
    ['事業種目', f.businessType],
    ['資本金の額', yen(capital)],
    ['法人区分', sme ? '中小法人等（普通法人）' : '普通法人'],
    ['申告区分', '確定申告（青色申告）'],
    { label: '事業年度', value: period(startDate, endDate), wide: true },
    { label: '関与税理士', value: f.taxAccountant, wide: true },
  ]);
}

/** 適用額明細書の頭書き（別記様式：提出先・納税地・法人名・法人番号・事業種目・期末現在の資本金の額・所得金額又は欠損金額） */
export function applicationHead(f, { capital, income }) {
  return formHeadBlock([
    ['提出日', BLANK_DATE],
    ['提出先', office(f.taxOffice, '税務署長殿')],
    { label: '納税地', value: addr(f), wide: true },
    ['電話番号', f.phone],
    ['法人番号', f.corporateNumber],
    ['フリガナ', f.kana],
    ['法人名', f.name],
    ['事業種目', f.businessType],
    ['業種番号', ''],
    ['期末現在の資本金の額', yen(capital)],
    ['所得金額又は欠損金額', Number.isFinite(income) ? (income < 0 ? `△${fmt(-income)}円` : yen(income)) : ''],
    ['提出区分', '当初提出分'],
  ]);
}

/**
 * 地方税の申告書（第六号様式・第二十号様式）の頭書き
 * @param {'pref'|'city'} kind pref：都道府県（事業税・道府県民税）、city：市町村（市町村民税）
 */
export function localHead(f, { kind, startDate, endDate, capital, capitalTotal, employees, months }) {
  return formHeadBlock([
    ['提出日', BLANK_DATE],
    ['提出先', kind === 'pref' ? (f.prefOffice ? `${f.prefOffice}　殿` : '　　　　　　　殿') : f.city ? `${f.city}　殿` : '　　　　　　　殿'],
    { label: '所在地', value: addr(f), wide: true },
    ['電話番号', f.phone],
    ['法人番号', f.corporateNumber],
    ['フリガナ', f.kana],
    ['法人名', f.name],
    ['代表者', f.representative],
    ['経理責任者', f.accountant],
    ['事業種目', f.businessType],
    ['資本金の額', yen(capital)],
    ['資本金等の額', yen(capitalTotal)],
    ['従業者数', Number.isInteger(employees) ? `${employees}人` : ''],
    { label: '事業年度', value: `${period(startDate, endDate)}　確定申告（月数 ${months}か月）`, wide: true },
    { label: '関与税理士', value: f.taxAccountant, wide: true },
  ]);
}

/** 消費税及び地方消費税の申告書（第一表）の頭書き */
export function consumptionHead(f, { startDate, endDate, corporation }) {
  return formHeadBlock([
    ['提出日', BLANK_DATE],
    ['提出先', office(f.taxOffice, '税務署長殿')],
    { label: '納税地', value: addr(f), wide: true },
    ['電話番号', f.phone],
    [corporation ? '法人番号' : '個人番号', corporation ? f.corporateNumber : ''],
    ['フリガナ', f.kana],
    [corporation ? '名称' : '名称又は屋号', corporation ? f.name : f.tradeName || f.name],
    [corporation ? '代表者氏名' : '氏名', corporation ? f.representative : f.ownerName],
    corporation ? ['経理担当者氏名', f.accountant] : ['関与税理士', f.taxAccountant],
    { label: '課税期間', value: `${period(startDate, endDate)}　確定申告`, wide: true },
    corporation ? { label: '関与税理士', value: f.taxAccountant, wide: true } : null,
  ]);
}

/** 所得税及び復興特別所得税の申告書（第一表）の頭書き */
export function incomeHead(f, { year, white }) {
  return formHeadBlock([
    ['提出日', BLANK_DATE],
    ['提出先', office(f.taxOffice, '税務署長殿')],
    { label: '住所', value: addr(f), wide: true },
    ['フリガナ', f.kana],
    ['氏名', f.ownerName],
    ['職業', f.occupation],
    ['屋号・雅号', f.tradeName],
    ['電話番号', f.phone],
    ['個人番号', ''],
    ['申告の種類', `${white ? '白色' : '青色'}申告（令和${year - 2018}年分・確定）`],
    ['関与税理士', f.taxAccountant],
  ]);
}

/** 青色申告決算書・収支内訳書の頭書き */
export function settlementHead(f) {
  return formHeadBlock([
    { label: '住所', value: addr(f), wide: true },
    { label: '事業所所在地', value: f.businessAddress, wide: true },
    ['フリガナ', f.kana],
    ['氏名', f.ownerName],
    ['業種名', f.businessType],
    ['屋号', f.tradeName],
    ['電話番号', f.phone],
    ['加入団体名', f.association],
    { label: '依頼税理士等', value: f.taxAccountant, wide: true },
  ]);
}

/** 償却資産申告書の頭書き（所有者の欄） */
export function propertyHead(f, { corporation, capital }) {
  return formHeadBlock([
    ['提出日', BLANK_DATE],
    ['提出先', f.city ? `${f.city}　殿` : '　　　　　　　殿'],
    { label: corporation ? '本店所在地' : '住所', value: addr(f), wide: true },
    ['フリガナ', f.kana],
    [corporation ? '名称' : '氏名', corporation ? f.name : f.ownerName],
    corporation ? ['代表者', f.representative] : ['屋号', f.tradeName],
    [corporation ? '法人番号' : '個人番号', corporation ? f.corporateNumber : ''],
    ['事業種目', f.businessType],
    corporation ? ['資本金等の額', yen(capital)] : ['電話番号', f.phone],
    corporation ? ['電話番号', f.phone] : null,
    ['関与税理士', f.taxAccountant],
  ]);
}
