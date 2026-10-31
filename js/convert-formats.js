// 移行先ごとの仕訳の形式（純粋関数）：マネーフォワードの仕訳帳インポート形式と、freee の仕訳インポート形式
// 弥生のインポート形式は yayoi.js
//
// 出典（URL は docs/spec-phase2-convert.md。アプリのソースには国税庁以外の URL を書かない決まり）
// - マネーフォワード クラウド会計「「仕訳帳」をインポートする」：27列（取引No〜最終更新者）、1行目は見出し。
//   同じ取引No・取引日で貸借が一致する行を1つの仕訳にする。インボイスの列は「適格」「80％控除」〜「控除なし」。決算整理仕訳の列は文字があれば決算整理
// - マネーフォワード クラウド会計 FAQ「消費税改正に伴い追加される税区分の一覧」：税区分の名称（「課税仕入 10%」「共通課税仕入 (軽)8%」など）
// - freee ヘルプセンター「CSVインポートで移行する方法」：33列（[表題行]〜摘要）、2行目からの行の先頭は[明細行]。
//   同じ伝票番号の行を1つの仕訳にする。決算整理仕訳は「1」。1ファイル50,000行・64MBまで
// - freee ヘルプセンター「一般課税を選択している場合の取引登録方法」：「課対仕入10%」「課対仕入8%(軽)」、
//   経過措置は「課対仕入(控80)10%」（2026/9/30まで）・「課対仕入(控70)10%」（2026/10/1から）
// インボイスのない仕入の経過措置の割合は tax-return.js の transitionalRate（国税庁の案内）による
import { TAX_BY_CODE } from './tax.js';
import { linesToRows, compareJournals } from './journal.js';
import { transitionalRate } from './tax-return.js';

const slash = (d) => d.replaceAll('-', '/');

/** マネーフォワードの税区分の名称（税込経理。インボイスの経過措置はインボイスの列で表す） */
export function mfTaxName(code) {
  const cat = TAX_BY_CODE[code];
  if (!cat || cat.kind === 'none') return '対象外';
  const r = { 100: '10%', 80: '(軽)8%' }[cat.rate] ?? '';
  const buy = { taxable: '課税仕入', common: '共通課税仕入', exempt: '非課税対応仕入' }[cat.use] ?? '課税仕入';
  const imp = { taxable: '輸入仕入', common: '共通輸入仕入', exempt: '非課税対応輸入' }[cat.use] ?? '輸入仕入';
  switch (cat.role) {
    case 'exempt':
      return cat.kind === 'purchase' ? '非課税仕入' : '非課税売上';
    case 'export':
      return '輸売 0%';
    case 'export_return':
      return '輸出売上-返還等 0%';
    case 'exempt_return':
      return '非課税売上-返還等';
    case 'securities':
      return '非課税売上-有価証券譲渡';
    case 'baddebt':
      return `課税売上-貸倒 ${r}`;
    case 'recovered':
      return `課税売上-貸倒回収 ${r}`;
    case 'import':
      return `${imp}-消費税額 7.8%`;
    case 'import_local':
      return '輸入仕入-地方消費税額 2.2%';
    case 'return':
      return cat.kind === 'sales' ? `課税売上-返還等 ${r}` : `${buy}-返還等 ${r}`;
    case 'taxable':
      return cat.kind === 'sales' ? `課税売上 ${r}` : `${buy} ${r}`;
    default:
      return '対象外';
  }
}

/** マネーフォワードのインボイスの列：経過措置の仕入だけ取引日の割合を書く（空欄は「適格」） */
export function mfInvoice(code, date) {
  const cat = TAX_BY_CODE[code];
  if (!cat?.transitional) return '';
  const rate = transitionalRate(date);
  if (rate >= 100) return '';
  return rate > 0 ? `${rate}％控除` : '控除なし';
}

export const MF_HEADER = ['取引No', '取引日', '借方勘定科目', '借方補助科目', '借方部門', '借方取引先', '借方税区分', '借方インボイス', '借方金額(円)', '借方税額', '貸方勘定科目', '貸方補助科目', '貸方部門', '貸方取引先', '貸方税区分', '貸方インボイス', '貸方金額(円)', '貸方税額', '摘要', '仕訳メモ', 'タグ', 'MF仕訳タイプ', '決算整理仕訳', '作成日時', '作成者', '最終更新日時', '最終更新者'];

const sideNames = (s, { accountById, subById, departmentById }) => [
  accountById.get(s.accountId)?.name ?? '',
  s.subAccountId ? subById.get(s.subAccountId)?.name ?? '' : '',
  s.departmentId ? departmentById.get(s.departmentId)?.name ?? '' : '',
];

/**
 * 仕訳をマネーフォワードの仕訳帳インポート形式の行にする（見出しなし。仕訳ごとの行のまとまりで返す）
 * 取引No は入力No.（会計期間の中で重ならない）。取引先の列は使わない（取り込みで追加できないため、補助科目で渡す）
 * @returns {string[][][]}
 */
export function mfGroups(journals, { accountById, subById, departmentById = new Map() }) {
  const ctx = { accountById, subById, departmentById };
  return [...journals].sort(compareJournals).map((j) =>
    linesToRows(j.lines).map((r) => {
      const side = (s) => {
        if (!s.accountId) return ['', '', '', '', '', '', '', ''];
        return [...sideNames(s, ctx), '', mfTaxName(s.taxCategory), mfInvoice(s.taxCategory, j.date), Number(s.amount), ''];
      };
      return [j.no, slash(j.date), ...side(r.debit), ...side(r.credit), r.memo, '', '', '', j.adjusting ? '決算整理' : '', '', '', '', ''];
    }),
  );
}

/** freee の税区分の名称（税込経理）。経過措置の仕入は「課対仕入(控80)10%」の形 */
export function freeeTaxName(code, date) {
  const cat = TAX_BY_CODE[code];
  if (!cat || cat.kind === 'none') return '対象外';
  const r = { 100: '10%', 80: '8%(軽)' }[cat.rate] ?? '';
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
      return `課税売倒${r}`;
    case 'recovered':
      return `課税売回${r}`;
    case 'import':
      return `${head}輸税10%`;
    case 'import_local':
      return '地消貨割10%';
    case 'return':
      return cat.kind === 'sales' ? `課税売返${r}` : `${head}仕返${r}`;
    case 'taxable': {
      if (cat.kind === 'sales') return `課税売上${r}`;
      if (!cat.transitional) return `${head}仕入${r}`;
      const rate = transitionalRate(date);
      if (rate >= 100) return `${head}仕入${r}`;
      // 控除できなくなった後（2031/10/1 以降）は仕入税額控除の対象にならない
      return rate > 0 ? `${head}仕入(控${rate})${r}` : '対象外';
    }
    default:
      return '対象外';
  }
}

export const FREEE_HEADER = ['[表題行]', '日付', '伝票番号', '決算整理仕訳', '借方勘定科目', '借方科目コード', '借方補助科目', '借方取引先', '借方取引先コード', '借方部門', '借方品目', '借方メモタグ', '借方セグメント1', '借方セグメント2', '借方セグメント3', '借方金額', '借方税区分', '借方税額', '貸方勘定科目', '貸方科目コード', '貸方補助科目', '貸方取引先', '貸方取引先コード', '貸方部門', '貸方品目', '貸方メモタグ', '貸方セグメント1', '貸方セグメント2', '貸方セグメント3', '貸方金額', '貸方税区分', '貸方税額', '摘要'];

/**
 * 仕訳を freee の仕訳インポート形式の行にする（見出しなし。仕訳ごとの行のまとまりで返す）
 * 伝票番号は入力No.（freee は同じ日付・伝票番号の仕訳がすでにあると誤りにするため、重ならない番号を使う）。
 * 税額は税込経理なので空欄
 * @returns {string[][][]}
 */
export function freeeGroups(journals, { accountById, subById, departmentById = new Map() }) {
  const ctx = { accountById, subById, departmentById };
  return [...journals].sort(compareJournals).map((j) =>
    linesToRows(j.lines).map((r) => {
      const side = (s) => {
        if (!s.accountId) return Array(14).fill('');
        const [acc, sub, dep] = sideNames(s, ctx);
        return [acc, '', sub, '', '', dep, '', '', '', '', '', Number(s.amount), freeeTaxName(s.taxCategory, j.date), ''];
      };
      return ['[明細行]', slash(j.date), j.no, j.adjusting ? 1 : '', ...side(r.debit), ...side(r.credit), r.memo];
    }),
  );
}

// 勘定奉行の「OBC受入形式」（仕訳伝票データ受入）
// 出典（URL は docs/spec-phase2-convert.md）
// - OBC「勘定奉行クラウド データ移行手順書」：CSV またはタブ区切り、1ファイル2MBまで、1伝票9,999明細まで。勘定科目・補助科目・部門はコードで受け入れる
// - 勘定奉行へ受け入れる仕訳 CSV の例（他社の連携マニュアル）：1行目に受入記号。OBCD001（伝票区切）が「*」の行から新しい伝票。
//   CSJS005 日付、CSJS200〜 借方（部門・勘定科目・補助科目・税区分…・本体金額）、CSJS300〜 貸方、CSJS100 摘要
// 税区分コードの一覧は確認できなかったため空欄にする（空欄は移行先の勘定科目・補助科目の初期値になる）
export const BUGYO_HEADER = ['OBCD001', 'CSJS005', 'CSJS200', 'CSJS201', 'CSJS202', 'CSJS203', 'CSJS213', 'CSJS300', 'CSJS301', 'CSJS302', 'CSJS303', 'CSJS313', 'CSJS100'];

/** 勘定奉行のコードの決まり（推測：半角の英数字10桁まで。桁数は移行先の会社運用設定による） */
export const isBugyoCode = (s) => /^[0-9A-Za-z]{1,10}$/.test(String(s ?? ''));

/**
 * 仕訳を勘定奉行の OBC受入形式の行にする（見出しなし。仕訳ごとの行のまとまりで返す）
 * codes：移行先のコード { accounts: {科目ID: コード}, subs: {補助科目ID: コード}, departments: {部門ID: コード} }。
 * 補助科目・部門のコードが空欄なら、移行先で「その他補助科目」「その他部門」になる
 * @returns {string[][][]}
 */
export function bugyoGroups(journals, { codes = {} }) {
  const acc = codes.accounts || {};
  const sub = codes.subs || {};
  const dep = codes.departments || {};
  return [...journals].sort(compareJournals).map((j) =>
    linesToRows(j.lines).map((r, i) => {
      const side = (s) => (s.accountId ? [dep[s.departmentId] ?? '', acc[s.accountId] ?? '', sub[s.subAccountId] ?? '', '', Number(s.amount)] : ['', '', '', '', '']);
      return [i === 0 ? '*' : '', i === 0 ? j.date : '', ...side(r.debit), ...side(r.credit), r.memo];
    }),
  );
}

/**
 * 勘定奉行で税区分を確かめる明細の一覧（税区分は空欄で渡し、移行先の科目の初期値になるため）
 * 科目の既定の税区分と違う明細・インボイスのない仕入の明細を載せる
 */
export function bugyoTaxCheckRows(journals, { accountById, subById }) {
  const rows = [];
  for (const j of [...journals].sort(compareJournals)) {
    for (const l of j.lines) {
      const a = accountById.get(l.accountId);
      if (!a) continue;
      const cat = TAX_BY_CODE[l.taxCategory];
      const def = TAX_BY_CODE[a.defaultTaxCategory];
      if ((l.taxCategory || 'none') === (a.defaultTaxCategory || 'none') && !cat?.transitional) continue;
      const label = (c) => (c && c.kind !== 'none' ? c.label : '対象外');
      rows.push([slash(j.date), j.voucherNo ?? j.no, l.side === 'debit' ? '借方' : '貸方', a.name, l.subAccountId ? subById.get(l.subAccountId)?.name ?? '' : '', Number(l.amount), label(cat), label(def), l.memo || '']);
    }
  }
  return rows;
}
