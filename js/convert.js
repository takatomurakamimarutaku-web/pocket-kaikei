// 他の会計ソフトへ移るための「移行パック」（純粋関数）
//
// 弥生会計のインポート形式（仕訳データ・期首残高データ）を軸にする。弥生の各製品のほか、
// マネーフォワード クラウド会計も「他社ソフトデータの移行」で弥生のインポート形式の仕訳を読める
// 移行先ごとの制限（出典の URL は docs/spec-phase2-convert.md。アプリのソースには国税庁以外の URL を書かない決まり）
// - 弥生会計 サポート情報「勘定科目の期首残高データの項目と記述形式」：期首日・勘定科目名・貸借区分・補助科目名・部門・前期繰越残高の6列。
//   科目名・補助科目名・部門は24桁まで（超えた分は切り捨て）。事業主貸・事業主借・元入金・繰越利益は取り込めない
// - 弥生会計 Next「インポートの事前準備」：1回5,000行まで、複合仕訳は100行まで
// - 弥生会計 オンライン サポート情報「インポートする際の制限事項」：Shift_JIS のみ、1ファイル1.0MB・1,000行まで、
//   複合仕訳は20行まで、項目の中の半角カンマはダブルクォートで囲んでも不可、製造原価の科目は不可
// - マネーフォワード・freee・勘定奉行は各社の仕訳インポート形式（convert-formats.js）で渡す
import { yayoiRows } from './yayoi.js';
import { mfGroups, MF_HEADER, freeeGroups, FREEE_HEADER, bugyoGroups, BUGYO_HEADER, bugyoTaxCheckRows, isBugyoCode } from './convert-formats.js';
import { encodeShiftJis } from './sjis.js';
import { toCsv, BOM, trialBalanceCsv, assetsCsv } from './csv.js';
import { trialBalance } from './ledger.js';
import { assetRegister } from './depreciation.js';
import { compareAccounts, groupLabel, isMfgGroup } from './accounts.js';
import { TAX_BY_CODE } from './tax.js';
import { linesToRows } from './journal.js';

/**
 * 移行先
 * maxRows：1ファイルの行数の上限（超えたら仕訳の途中で切らずにファイルを分ける）。maxBytes：1ファイルの大きさの上限
 * maxLines：1つの仕訳（伝票）の行数の上限。nameMax：科目名などの長さの上限（Shift_JIS のバイト数）
 * noComma：項目の中の半角カンマを全角にする。noMfg：製造原価の科目を使えない。opening：期首残高を弥生の形式で渡すか一覧で渡すか
 * format：仕訳の形式（yayoi・mf・freee・bugyo）。codes：科目を移行先のコードで渡す（コードの対応表が要る）
 * freee：1ファイル50,000行・64MB、1仕訳400行まで（freee ヘルプセンター「CSVインポートで移行する方法」「仕訳データのインポート」）
 * 勘定奉行：1ファイル2MB、1伝票9,999明細まで（OBC「勘定奉行クラウド データ移行手順書」）
 */
export const CONVERT_TARGETS = {
  yayoi: { label: '弥生会計（デスクトップ）・やよいの青色申告', maxRows: Infinity, maxBytes: Infinity, maxLines: Infinity, nameMax: 24, noComma: false, noMfg: false, opening: 'yayoi', format: 'yayoi' },
  next: { label: '弥生会計 Next', maxRows: 5000, maxBytes: Infinity, maxLines: 100, nameMax: 24, noComma: false, noMfg: false, opening: 'yayoi', format: 'yayoi' },
  online: { label: '弥生会計 オンライン・やよいの青色申告 オンライン', maxRows: 1000, maxBytes: 1_000_000, maxLines: 20, nameMax: 24, noComma: true, noMfg: true, opening: 'yayoi', format: 'yayoi' },
  mf: { label: 'マネーフォワード クラウド会計・確定申告', maxRows: Infinity, maxBytes: Infinity, maxLines: Infinity, nameMax: 60, noComma: false, noMfg: false, opening: 'list', format: 'mf' },
  freee: { label: 'freee会計', maxRows: 50000, maxBytes: 64_000_000, maxLines: 400, nameMax: 60, noComma: false, noMfg: false, opening: 'list', format: 'freee' },
  bugyo: { label: '勘定奉行', maxRows: Infinity, maxBytes: 2_000_000, maxLines: 9999, nameMax: Infinity, noComma: false, noMfg: false, opening: 'list', format: 'bugyo', codes: true },
};

/** 移行先のコードの対応表（設定の convertCodes[移行先]）を確かめる。errors は直さないと保存できないもの */
export function validateConvertCodes(codes = {}) {
  const errors = [];
  for (const kind of ['accounts', 'subs', 'departments']) {
    for (const v of Object.values(codes[kind] || {})) {
      if (v !== '' && !isBugyoCode(v)) errors.push(`コード「${v}」は半角の英数字10桁までで入力してください`);
    }
  }
  return errors;
}

/** 仕訳・期首残高で使っている科目・補助科目・部門の ID（コードの対応表に並べるもの） */
export function usedIds(journals, period) {
  const accounts = new Set();
  const subs = new Set();
  const departments = new Set();
  for (const j of journals) {
    for (const l of j.lines) {
      accounts.add(l.accountId);
      if (l.subAccountId) subs.add(l.subAccountId);
      if (l.departmentId) departments.add(l.departmentId);
    }
  }
  for (const ob of period?.openingBalances || []) {
    if (!ob.amount) continue;
    accounts.add(ob.accountId);
    if (ob.subAccountId) subs.add(ob.subAccountId);
  }
  return { accounts, subs, departments };
}

// 弥生の期首残高データに入れられない科目（移行先が自動で計算する）
const OPENING_SKIP_ROLES = ['owner_drawings', 'owner_borrowings', 'owner_capital'];
// 弥生の仕訳データで文字を入れる列（借方・貸方の科目・補助・部門、摘要）
const TEXT_COLS = [4, 5, 6, 10, 11, 12, 16];

const slash = (d) => d.replaceAll('-', '/');
const sjisBytes = (s) => encodeShiftJis(String(s ?? '')).bytes.length;
const noComma = (s) => String(s ?? '').replaceAll(',', '，');

/**
 * 期首残高を弥生会計の期首残高データの行にする。科目・補助科目ごとに合計し、0円は出さない
 * 金額は科目の残高側の向き（貸借区分は科目の残高側）。マイナスの残高はマイナスのまま出す
 * @returns {{ rows: string[][], skipped: string[] }} skipped：移行先が計算するため出さなかった科目
 */
export function yayoiOpeningRows(period, { accountById, subById }) {
  const sums = new Map();
  const skipped = new Set();
  for (const ob of period.openingBalances || []) {
    const acc = accountById.get(ob.accountId);
    if (!acc || !ob.amount) continue;
    if (OPENING_SKIP_ROLES.includes(acc.role)) {
      skipped.add(acc.name);
      continue;
    }
    const k = `${ob.accountId}|${ob.subAccountId || ''}`;
    sums.set(k, (sums.get(k) || 0) + ob.amount);
  }
  const rows = [];
  const accounts = [...new Set([...sums.keys()].map((k) => k.split('|')[0]))].map((id) => accountById.get(id)).sort(compareAccounts);
  for (const acc of accounts) {
    const keys = [...sums.keys()].filter((k) => k.startsWith(`${acc.id}|`)).sort((a, b) => (subById.get(a.split('|')[1])?.sortOrder ?? -1) - (subById.get(b.split('|')[1])?.sortOrder ?? -1));
    for (const k of keys) {
      const amount = sums.get(k);
      if (!amount) continue;
      const sub = subById.get(k.split('|')[1]);
      rows.push([slash(period.startDate), acc.name, acc.normalSide === 'debit' ? '借方' : '貸方', sub?.name ?? '', '', amount]);
    }
  }
  return { rows, skipped: [...skipped] };
}

/** 弥生の仕訳データの行を、仕訳（伝票）ごとのまとまりにする（2000 は1行、2110〜2101 で1つ） */
export function groupYayoiRows(rows) {
  const groups = [];
  for (const r of rows) {
    if (r[0] === '2000' || r[0] === '2111' || r[0] === '2110' || !groups.length) groups.push([r]);
    else groups.at(-1).push(r);
  }
  return groups;
}

/**
 * 仕訳を途中で切らずに、行数とバイト数の上限でファイルに分ける
 * @param {string[][][]} groups groupYayoiRows の結果
 * @param {{ maxRows: number, maxBytes: number }} limits
 * @returns {string[][][]} ファイルごとの行
 */
export function splitYayoiGroups(groups, { maxRows = Infinity, maxBytes = Infinity } = {}) {
  const files = [];
  let cur = [];
  let bytes = 0;
  for (const g of groups) {
    const size = sjisBytes(toCsv(g).replace(BOM, ''));
    if (cur.length && (cur.length + g.length > maxRows || bytes + size > maxBytes)) {
      files.push(cur);
      cur = [];
      bytes = 0;
    }
    cur.push(...g);
    bytes += size;
  }
  if (cur.length) files.push(cur);
  return files;
}

/**
 * 書き出す前の確認。errors は移行先で取り込めないもの、warnings は取り込めるが確かめてほしいもの
 * @returns {{ errors: string[], warnings: string[] }}
 */
export function convertChecks(journals, { target, accountById, subById, departmentById = new Map(), period, codes = {} }) {
  const t = CONVERT_TARGETS[target];
  const errors = [];
  const warnings = [];
  const label = (j) => `${slash(j.date)} 伝票No.${j.voucherNo ?? j.no}`;
  const mfg = new Set();
  const longNames = new Set();
  const checkName = (name) => {
    if (name && sjisBytes(name) > t.nameMax) longNames.add(name);
  };
  for (const j of journals) {
    const n = linesToRows(j.lines).length;
    if (n > t.maxLines) errors.push(`${label(j)}：${n}行の仕訳は${t.label}に取り込めません（${t.maxLines}行まで）。仕訳を分けてください`);
    for (const l of j.lines) {
      const acc = accountById.get(l.accountId);
      if (!acc) continue;
      if (t.noMfg && isMfgGroup(acc.group)) mfg.add(acc.name);
      checkName(acc.name);
      if (l.subAccountId) checkName(subById.get(l.subAccountId)?.name);
      if (l.departmentId) checkName(departmentById.get(l.departmentId)?.name);
    }
  }
  for (const ob of period?.openingBalances || []) {
    checkName(accountById.get(ob.accountId)?.name);
    if (ob.subAccountId) checkName(subById.get(ob.subAccountId)?.name);
  }
  if (mfg.size) errors.push(`製造原価の科目（${[...mfg].join('・')}）を使った仕訳は${t.label}に取り込めません`);
  if (longNames.size) warnings.push(`名前が長いため、移行先で途中から切れることがあります（全角${Math.floor(t.nameMax / 2)}文字まで）：${[...longNames].slice(0, 8).join('、')}${longNames.size > 8 ? ' ほか' : ''}`);
  if (t.codes) {
    const used = usedIds(journals, period);
    const missing = [...used.accounts].map((id) => accountById.get(id)).filter((a) => a && !codes.accounts?.[a.id]).sort(compareAccounts);
    if (missing.length) errors.push(`${t.label}の勘定科目コードが入っていない科目があります：${missing.slice(0, 8).map((a) => a.name).join('、')}${missing.length > 8 ? ' ほか' : ''}`);
    errors.push(...validateConvertCodes(codes));
    const taxRows = bugyoTaxCheckRows(journals, { accountById, subById });
    if (taxRows.length) warnings.push(`税区分は移行先の科目の初期値になります。科目の初期値と違う税区分の明細が${taxRows.length}件あるため、「06_税区分の確認.csv」を見て移行先で直してください`);
    const adj = journals.filter((j) => j.adjusting).length;
    if (adj) warnings.push(`決算整理仕訳${adj}件は通常の仕訳として入ります。移行先で整理区分を確かめてください`);
  }
  if (target === 'freee' && journals.some((j) => j.date >= '2028-10-01' && j.lines.some((l) => TAX_BY_CODE[l.taxCategory]?.transitional))) {
    warnings.push('2028年10月1日以後のインボイスのない仕入は「課対仕入(控50)10%」などの形で書き出します。freee の税区分の名前と合っているか確かめてください');
  }
  return { errors, warnings };
}

/** 勘定科目・補助科目の一覧（移行先で科目を作る・対応させるときの参考） */
export function accountListCsv(accounts, subAccounts, entityType, codes = null) {
  const rows = [['コード', '勘定科目', '補助科目', '区分', '残高の側', '既定の税区分', '使用', ...(codes ? ['移行先の科目コード', '移行先の補助科目コード'] : [])]];
  const tailCodes = (a, s) => (codes ? [codes.accounts?.[a.id] ?? '', s ? codes.subs?.[s.id] ?? '' : ''] : []);
  const subsOf = (id) => subAccounts.filter((s) => s.accountId === id).sort((a, b) => a.sortOrder - b.sortOrder);
  for (const a of [...accounts].sort(compareAccounts)) {
    const tax = TAX_BY_CODE[a.defaultTaxCategory];
    const base = [a.code, a.name];
    const tail = [groupLabel(a.group, entityType), a.normalSide === 'debit' ? '借方' : '貸方', tax && tax.kind !== 'none' ? tax.label : '対象外'];
    rows.push([...base, '', ...tail, a.active === false ? '使わない' : '使う', ...tailCodes(a)]);
    for (const s of subsOf(a.id)) rows.push([...base, s.name, ...tail, s.active === false || a.active === false ? '使わない' : '使う', ...tailCodes(a, s)]);
  }
  return toCsv(rows);
}

/** 期首残高の一覧（弥生の形式で取り込めない移行先で、手で入力するとき用） */
function openingListCsv(rows, skipped) {
  const out = [['勘定科目', '補助科目', '残高の側', '金額']];
  for (const r of rows) out.push([r[1], r[3], r[2], r[5]]);
  if (skipped.length) out.push([], [`${skipped.join('・')}は移行先が計算するため載せていません`]);
  return toCsv(out);
}

function sjisFile(name, rows, unmappable) {
  const r = encodeShiftJis(toCsv(rows).replace(BOM, ''));
  for (const c of r.unmappable) unmappable.add(c);
  return { name, bytes: r.bytes };
}

const utf8File = (name, text) => ({ name, bytes: new TextEncoder().encode(text) });

/**
 * 移行パックのファイル一式を作る
 * @param {object} p
 * @param {string} p.target CONVERT_TARGETS のキー
 * @returns {{ files: Array<{name, bytes}>, journalFiles: number, journalCount: number, openingCount: number, skipped: string[], unmappable: string[], assetCount: number }}
 */
export function buildConvertPack({ target, settings, period, accounts, subAccounts, journals, departments = [], assets = [], periods = [] }) {
  const codes = settings.convertCodes?.[target] || {};
  const t = CONVERT_TARGETS[target];
  if (!t) throw new Error(`移行先がわかりません：${target}`);
  const accountById = new Map(accounts.map((a) => [a.id, a]));
  const subById = new Map(subAccounts.map((s) => [s.id, s]));
  const departmentById = new Map(departments.map((d) => [d.id, d]));
  const unmappable = new Set();
  const files = [];

  // 期首残高
  const opening = yayoiOpeningRows(period, { accountById, subById });
  const openingRows = t.noComma ? opening.rows.map((r) => r.map((v, i) => (i >= 1 && i <= 4 ? noComma(v) : v))) : opening.rows;
  if (t.opening === 'yayoi') files.push(sjisFile('01_期首残高_弥生インポート形式.csv', openingRows, unmappable));
  else files.push(utf8File('01_期首残高の一覧.csv', openingListCsv(openingRows, opening.skipped)));

  // 仕訳（移行先の上限でファイルを分ける。伝票の途中では切らない）
  const ctx = { accountById, subById, period, departmentById };
  let groups;
  if (t.format === 'mf') groups = mfGroups(journals, ctx);
  else if (t.format === 'freee') groups = freeeGroups(journals, ctx);
  else if (t.format === 'bugyo') groups = bugyoGroups(journals, { codes });
  else {
    let rows = yayoiRows(journals, ctx);
    if (t.noComma) rows = rows.map((r) => r.map((v, i) => (TEXT_COLS.includes(i) ? noComma(v) : v)));
    groups = groupYayoiRows(rows);
  }
  const parts = splitYayoiGroups(groups, t);
  const formatName = { yayoi: '弥生インポート形式', mf: 'マネーフォワード形式', freee: 'freee形式', bugyo: '勘定奉行OBC受入形式' }[t.format];
  parts.forEach((part, i) => {
    const name = `02_仕訳_${formatName}${parts.length > 1 ? `_${i + 1}of${parts.length}` : ''}.csv`;
    // マネーフォワードは見出しの行が要る（Shift_JIS）。freee は見出しの行（[表題行]）が要り、UTF-8（BOM）で渡す
    if (t.format === 'mf') files.push(sjisFile(name, [MF_HEADER, ...part], unmappable));
    else if (t.format === 'freee') files.push(utf8File(name, toCsv([FREEE_HEADER, ...part])));
    // 勘定奉行は1行目に受入記号（文字コードは資料に記載がなく Shift_JIS にした：推測）
    else if (t.format === 'bugyo') files.push(sjisFile(name, [BUGYO_HEADER, ...part], unmappable));
    else files.push(sjisFile(name, part, unmappable));
  });

  // 参考：科目の一覧・固定資産台帳・期末の残高試算表（照合用）
  files.push(utf8File('03_勘定科目と補助科目の一覧.csv', accountListCsv(accounts, subAccounts, settings.entityType)));
  const register = assetRegister(assets, periods, period);
  if (register.length) files.push(utf8File('04_固定資産台帳.csv', assetsCsv(register, { accountById, individual: settings.entityType === 'individual' })));
  const tb = trialBalance({ accounts, subAccounts, period, journals });
  files.push(utf8File('05_残高試算表_期末（照合用）.csv', trialBalanceCsv(tb, settings.entityType)));
  if (t.codes) {
    const taxRows = bugyoTaxCheckRows(journals, { accountById, subById });
    if (taxRows.length) files.push(utf8File('06_税区分の確認.csv', toCsv([['日付', '伝票No.', '貸借', '勘定科目', '補助科目', '金額', 'Pocket会計の税区分', '科目の初期値'], ...taxRows])));
    files.splice(files.findIndex((f) => f.name.startsWith('03_')), 1, utf8File('03_勘定科目と補助科目の一覧.csv', accountListCsv(accounts, subAccounts, settings.entityType, codes)));
  }

  const summary = { target, journalFiles: parts.length, journalCount: journals.length, openingCount: opening.rows.length, skipped: opening.skipped, assetCount: register.length };
  files.unshift(utf8File('00_移行の手順.txt', BOM + convertGuide({ ...summary, settings, period, files: files.map((f) => f.name) })));
  return { files, ...summary, unmappable: [...unmappable] };
}

/** 移行の手順書（移行先の画面の名前で、設定→期首残高→仕訳→照合の順に書く） */
export function convertGuide({ target, settings, period, files, journalFiles, skipped }) {
  const t = CONVERT_TARGETS[target];
  const L = [];
  const journalNames = files.filter((f) => f.startsWith('02_'));
  L.push(`Pocket会計 → ${t.label} 移行の手順`);
  L.push(`事業者：${settings.businessName || '（未設定）'}　会計期間：${slash(period.startDate)}〜${slash(period.endDate)}`);
  L.push('');
  L.push('■ 入っているファイル');
  for (const f of files) L.push(`・${f}`);
  L.push('');
  L.push('■ 始める前に');
  L.push(`・移行先で同じ会計期間（${slash(period.startDate)}〜${slash(period.endDate)}）の事業所（年度）を作ってください。`);
  L.push('・消費税の経理方式は「税込」にしてください。Pocket会計は税込経理のため、仕訳の金額は税込です。');
  L.push('・取り込みは追加だけで、上書きされません。やり直すときは、移行先で取り込んだ仕訳を消してから取り込んでください。');
  L.push('');
  const step = (() => {
    let n = 0;
    return (s) => L.push(`${++n}. ${s}`);
  })();
  L.push('■ 手順');
  if (target === 'yayoi') {
    step('「03_勘定科目と補助科目の一覧.csv」を見て、弥生会計の［科目設定］で足りない勘定科目・補助科目を作ります（弥生会計は科目そのものを取り込めません）。名前が違う科目は、取り込みの画面で対応させることもできます。');
    step('［ファイル］→［インポート］で「01_期首残高_弥生インポート形式.csv」を取り込みます（［科目残高入力］の前期繰越残高に入ります。今の値は上書きされます）。');
  } else if (target === 'next') {
    step('インポートの画面で「01_期首残高_弥生インポート形式.csv」を取り込みます。ない科目・補助科目は「追加」か「置換」を選びます。');
  } else if (target === 'online') {
    step('［弥生データのインポート］で「01_期首残高_弥生インポート形式.csv」を取り込みます。');
  } else if (target === 'mf') {
    step('［各種設定］→［事業者］で、消費税の経理方式が「税込」になっているか確かめます。');
    step('［開始残高］の画面で「01_期首残高の一覧.csv」を見ながら開始残高を入力します（マネーフォワードが読めるのは弥生会計の残高試算表の形式のため、手で入力します）。');
  } else if (target === 'bugyo') {
    step('勘定奉行で、Pocket会計の画面で入力した勘定科目コード・補助科目コード・部門コードの科目などがあるか確かめ、ない科目は作ります（「03_勘定科目と補助科目の一覧.csv」の右の2列が入力したコードです）。');
    step('［導入処理］の科目残高の入力（または［汎用データ受入］→［導入前実績金額データ受入］）で、「01_期首残高の一覧.csv」を見ながら期首残高を入力します。');
  } else {
    step('「03_勘定科目と補助科目の一覧.csv」を見て、freee に現金・預金・クレジットカードの口座を作ります（freee は口座がないと取り込めません）。');
    step('事業所の設定で、消費税の経理方式が「税込」になっているか、インボイスのない仕入の経過措置の税区分（「課対仕入(控80)10%」など）を使う設定になっているか確かめます。');
    step('［開始残高］の画面で「01_期首残高の一覧.csv」を見ながら開始残高を入力します。');
  }
  const names = journalNames.map((f) => `「${f}」`).join('');
  const split = journalFiles > 1 ? `一度に読める行数に合わせて${journalFiles}個に分けてあります。番号の順に全部取り込んでください。` : '';
  if (target === 'mf') {
    step(`［会計帳簿］→［仕訳帳］の［インポート］→［仕訳帳］で${names}を取り込みます。科目・補助科目・部門の名前が違うときは「追加」か「変換」を選びます。インボイスのない仕入は「インボイス」の列に「80％控除」などを入れてあります。`);
  } else if (target === 'bugyo') {
    step(`［随時処理］→［汎用データ受入］→［仕訳伝票データ受入］で、受入データ形式を「OBC受入形式」にして${names}を取り込みます。${split}未受入の件数が出たら［プレビュー］で理由を確かめます。`);
    step('税区分は空欄で渡しているため、勘定科目・補助科目の初期値になります。「06_税区分の確認.csv」（あるときだけ）に載っている明細は、［仕訳処理］で税区分を直します。');
  } else if (target === 'freee') {
    step(`［取引入力］→［振替伝票］の［インポート］で、freee のテンプレートの形式の仕訳として${names}を取り込みます。${split}勘定科目・補助科目（口座・取引先・品目）・税区分の対応を選んで登録します。`);
  } else {
    step(`${target === 'online' ? '［弥生データのインポート］' : target === 'next' ? 'インポートの画面' : '［ファイル］→［インポート］'}で${journalNames.map((f) => `「${f}」`).join('')}を取り込みます。${journalFiles > 1 ? `一度に読める行数に合わせて${journalFiles}個に分けてあります。番号の順に全部取り込んでください。` : ''}`);
  }
  step('移行先の残高試算表（期末）と「05_残高試算表_期末（照合用）.csv」を見比べます。まず資産・負債・純資産の合計、合わなければ科目ごとに確かめます。');
  L.push('');
  L.push('■ 気をつけること');
  if (skipped.length) L.push(`・${skipped.join('・')}の期首残高は、移行先が自動で計算するため期首残高のファイルに入れていません。`);
  if (settings.entityType === 'corporation' && t.opening === 'yayoi') L.push('・繰越利益剰余金の期首残高で取り込めないと表示されたときは、移行先の案内に従って入力してください。');
  L.push('・固定資産は「04_固定資産台帳.csv」（固定資産があるときだけ入っています）を見て、移行先の固定資産台帳に入力してください。Pocket会計の減価償却の仕訳を取り込むときは、移行先で今期の償却費を二重に計上しないよう設定してください。');
  L.push('・証憑の画像・請求書・給与・定型仕訳・予算は移行しません。Pocket会計のバックアップ（JSON）を保管しておいてください。');
  L.push('・このファイル一式は、実際の各ソフトでの取り込みをまだ確かめていません。取り込めないときは、移行先の表示したエラーを教えてください。');
  return `${L.join('\r\n')}\r\n`;
}
