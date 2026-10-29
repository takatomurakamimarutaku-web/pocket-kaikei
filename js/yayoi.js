// 弥生会計のインポート形式（仕訳データ）での書き出し（純粋関数）
//
// 項目（25列）・識別フラグ・タイプ：弥生会計 サポート情報「仕訳データの項目と記述形式（他製品から仕訳データをインポートする場合など）」
// 税区分の記述形式（税込は「込」、軽減税率は「軽減8%」、区分記載の経過措置は末尾に「区分80%」などを付ける）：
//   弥生会計 サポート情報「消費税の税区分と税計算区分の一覧」
// 出典の URL は docs/spec-phase2-transfer.md（アプリのソースには国税庁以外の URL を書かない決まり）
// インボイスのない仕入の経過措置の割合は tax-return.js の transitionalRate（国税庁の案内）による
import { TAX_BY_CODE, backCalc } from './tax.js';
import { linesToRows, compareJournals } from './journal.js';
import { transitionalRate } from './tax-return.js';
import { toCsv } from './csv.js';

const RATE = { 100: '10%', 80: '軽減8%' };

/**
 * Pocket会計の税区分を弥生会計の記述形式にする（税込経理なので「込」）
 * @param {string} code 税区分
 * @param {string} date 取引日（インボイスのない仕入の経過措置の割合に使う）
 */
export function yayoiTaxName(code, date) {
  const cat = TAX_BY_CODE[code];
  if (!cat || cat.kind === 'none') return '対象外';
  const r = RATE[cat.rate] ?? '';
  const head = { taxable: '課対', common: '共対', exempt: '非対' }[cat.use] ?? '課対';
  switch (cat.role) {
    case 'exempt':
      return cat.kind === 'purchase' ? '非課仕入' : '非課売上';
    case 'export':
      return '輸出売上';
    case 'export_return':
      return '輸出売返';
    case 'exempt_return':
      return '非課売返';
    case 'securities':
      return '有価譲渡';
    case 'baddebt':
      return `課税売倒込${r}`;
    case 'recovered':
      return `課税売回込${r}`;
    case 'import':
      // 輸入の消費税は税額そのもの。Pocket会計では税率を持たないため標準税率（国税7.8%）とする
      return `${head}輸税7.8%`;
    case 'import_local':
      return '地消貨割2.2%';
    case 'return':
      return cat.kind === 'sales' ? `課税売返込${r}` : `${head}仕返込${r}`;
    case 'taxable': {
      if (cat.kind === 'sales') return `課税売上込${r}`;
      const base = `${head}仕入込${r}`;
      if (!cat.transitional) return base;
      const rate = transitionalRate(date);
      if (rate >= 100) return base;
      return `${base}区分${rate > 0 ? `${rate}%` : '控不'}`;
    }
    default:
      return '対象外';
  }
}

/** 税金額の列：税率のある税区分は税込金額から割り戻した税額、それ以外は空欄 */
function taxAmount(code, amount) {
  const cat = TAX_BY_CODE[code];
  if (!cat || !cat.rate || cat.taxOnly) return '';
  return backCalc(amount, cat).tax;
}

const slash = (d) => d.replaceAll('-', '/');

/**
 * 仕訳を弥生会計のインポート形式の行にする
 * 借方・貸方が1行ずつの仕訳は「2000」（仕訳データ）、複合仕訳は振替伝票（1行目2110・間2100・最終行2101、タイプ3）
 * 決算整理仕訳で期末日のものは「本決」にする
 * @param {Array} journals
 * 部門（借方部門・貸方部門の列）は部門の名前。弥生会計の側に同じ名前の部門が必要
 * @param {{ accountById: Map, subById: Map, period: object, departmentById?: Map }} ctx
 * @returns {string[][]}
 */
export function yayoiRows(journals, { accountById, subById, period, departmentById = new Map() }) {
  const out = [];
  for (const j of [...journals].sort(compareJournals)) {
    const rows = linesToRows(j.lines);
    const kessan = j.adjusting && j.date === period?.endDate ? '本決' : '';
    rows.forEach((r, i) => {
      const single = rows.length === 1;
      const flag = single ? '2000' : i === 0 ? '2110' : i === rows.length - 1 ? '2101' : '2100';
      const side = (s) => {
        if (!s.accountId) return ['', '', '', '対象外', 0, ''];
        const amount = Number(s.amount);
        const dep = s.departmentId ? departmentById.get(s.departmentId)?.name ?? '' : '';
        return [accountById.get(s.accountId)?.name ?? '', s.subAccountId ? subById.get(s.subAccountId)?.name ?? '' : '', dep, yayoiTaxName(s.taxCategory, j.date), amount, taxAmount(s.taxCategory, amount)];
      };
      out.push([flag, j.no, kessan, slash(j.date), ...side(r.debit), ...side(r.credit), r.memo, '', '', single ? 0 : 3, '', '', 0, 0, 'no']);
    });
  }
  return out;
}

/** 弥生会計のインポート形式の CSV（見出しなし） */
export function yayoiCsv(journals, ctx) {
  return toCsv(yayoiRows(journals, ctx)).replace(/^﻿/, '');
}
