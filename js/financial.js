// 決算書（法人）：販売費及び一般管理費の内訳・株主資本等変動計算書・個別注記表（純粋関数）
//
// 計算書類の種類（貸借対照表・損益計算書・株主資本等変動計算書・個別注記表）：会社法 第435条第2項、会社計算規則 第59条
// 個別注記表で、会計監査人設置会社以外の公開会社でない株式会社が表示する項目（会社計算規則 第98条第2項第1号）：
//   重要な会計方針に係る事項・会計方針の変更・表示方法の変更・誤謬の訂正・株主資本等変動計算書・その他の注記
//   （弥生会計のサポート「個別注記表について」の表で確認。条文の原文は未照合）
// 株主資本等変動計算書は、科目を縦に並べる様式（縦型）で表示する（「株主資本等変動計算書に関する会計基準の適用指針」で認められている形）
import { trialBalance } from './ledger.js';
import { compareAccounts } from './accounts.js';
import { CATEGORY_BY_ID } from './depreciation.js';

/** 損益計算書の「販売費及び一般管理費」の内訳（決算書では損益計算書に合計だけを書き、内訳書を別に付ける） */
export function sgaBreakdown(pl) {
  const g = pl.items.find((it) => it.type === 'group' && it.groups?.includes('sga'));
  return g ? { lines: g.lines, total: g.total } : { lines: [], total: 0 };
}

/** 損益計算書の行を決算書の形にする：販売費及び一般管理費を合計の1行にする */
export function condensedIncomeItems(pl) {
  return pl.items.map((it) => (it.type === 'group' && it.groups?.includes('sga') ? { type: 'subtotal', label: '販売費及び一般管理費', amount: it.total, plain: true, sga: true } : it));
}

/**
 * 株主資本等変動計算書（縦型）
 * 純資産の科目ごとに 当期首残高・当期変動額（当期純利益・その他）・当期末残高
 * 区分：資本金（role capital_stock）、資本剰余金（目印 capital_reserve）、利益剰余金（目印 legal_reserve・role retained_earnings）、その他
 * @returns {{ sections: Array<{ label, rows: Array<{ account, opening, netIncome, other, closing }>, total }>, total, netIncome }}
 */
export function equityStatement({ accounts, period, journals, netIncome }) {
  const tb = trialBalance({ accounts, period, journals });
  const rows = tb.rows
    .filter((r) => r.account.group === 'equity' && (r.opening || r.closing || r.account.role === 'retained_earnings' || r.account.role === 'capital_stock'))
    .sort((a, b) => compareAccounts(a.account, b.account))
    .map((r) => {
      const ni = r.account.role === 'retained_earnings' ? netIncome : 0;
      return { account: r.account, opening: r.opening, netIncome: ni, other: r.closing - r.opening, closing: r.closing + ni };
    });
  const kind = (a) => (a.role === 'capital_stock' ? 'capital' : a.hint === 'capital_reserve' ? 'capital_surplus' : a.hint === 'legal_reserve' || a.role === 'retained_earnings' ? 'retained' : 'other');
  const LABELS = { capital: '資本金', capital_surplus: '資本剰余金', retained: '利益剰余金', other: 'その他' };
  const sum = (list) => ({
    opening: list.reduce((s, r) => s + r.opening, 0),
    netIncome: list.reduce((s, r) => s + r.netIncome, 0),
    other: list.reduce((s, r) => s + r.other, 0),
    closing: list.reduce((s, r) => s + r.closing, 0),
  });
  const sections = Object.keys(LABELS)
    .map((k) => {
      const list = rows.filter((r) => kind(r.account) === k);
      return { id: k, label: LABELS[k], rows: list, total: sum(list) };
    })
    .filter((s) => s.rows.length);
  return { sections, total: sum(rows), netIncome };
}

/** 個別注記表の入力の初期値（period.statementNotes） */
export const DEFAULT_NOTES = {
  inventoryMethod: '最終仕入原価法による原価法',
  depreciation: '', // 空なら固定資産台帳から文を作る
  allowance: '', // 空なら貸倒引当金の残高があるときに定型文
  policyChanges: '',
  presentationChanges: '',
  errorCorrections: '',
  showAccumulatedDepreciation: true,
  sharesIssued: null,
  treasuryShares: null,
  dividends: '',
  other: '',
};

/** 文字の入力欄（長さの上限） */
export const NOTE_TEXT_KEYS = ['inventoryMethod', 'depreciation', 'allowance', 'policyChanges', 'presentationChanges', 'errorCorrections', 'dividends', 'other'];
export const NOTE_TEXT_MAX = 2000;

/** 個別注記表の入力を検証する。エラーメッセージの配列を返す */
export function validateNotes(notes) {
  const errors = [];
  for (const k of NOTE_TEXT_KEYS) if (typeof notes[k] !== 'string' || notes[k].length > NOTE_TEXT_MAX) errors.push(`注記の文は${NOTE_TEXT_MAX}文字以内で入力してください`);
  for (const k of ['sharesIssued', 'treasuryShares']) if (notes[k] !== null && !(Number.isInteger(notes[k]) && notes[k] >= 0)) errors.push('株式の数は0以上の整数で入力してください');
  if (typeof notes.showAccumulatedDepreciation !== 'boolean') errors.push('減価償却累計額の注記の有無を選んでください');
  return [...new Set(errors)];
}

/** 固定資産台帳から減価償却の方法の文を作る（その期間に使っている資産だけ） */
export function depreciationPolicy(assets, period) {
  const used = assets.filter((a) => a.acquiredOn <= period.endDate && !(a.disposedOn && a.disposedOn < period.startDate));
  if (!used.length) return [];
  const tangible = used.filter((a) => !CATEGORY_BY_ID[a.category]?.intangible);
  const intangible = used.filter((a) => CATEGORY_BY_ID[a.category]?.intangible);
  const out = [];
  const methods = (list) => new Set(list.map((a) => a.method));
  if (tangible.length) {
    const m = methods(tangible);
    if (m.has('declining')) out.push('有形固定資産　定率法（ただし、平成10年4月1日以後に取得した建物並びに平成28年4月1日以後に取得した建物附属設備及び構築物については定額法）');
    else if (m.has('straight')) out.push('有形固定資産　定額法');
  }
  if (intangible.length && [...methods(intangible)].some((x) => x === 'straight' || x === 'declining')) out.push('無形固定資産　定額法');
  const all = methods(used);
  if (all.has('lump3')) out.push('取得価額10万円以上20万円未満の減価償却資産については、3年間で均等償却しています。');
  if (all.has('small') || all.has('sme')) out.push(`少額減価償却資産（${[all.has('small') ? '取得価額10万円未満' : '', all.has('sme') ? '中小企業者等の特例の対象' : ''].filter(Boolean).join('・')}）については、取得時に全額を費用処理しています。`);
  return out;
}

/**
 * 個別注記表の内容
 * @returns {Array<{ title, items: Array<{ heading?: string, text: string }> }>}
 */
export function companyNotes({ accounts, period, journals, assets = [], notes = {} }) {
  const n = { ...DEFAULT_NOTES, ...notes };
  const tb = trialBalance({ accounts, period, journals });
  const balance = (pred) => tb.rows.filter((r) => pred(r.account)).reduce((s, r) => s + r.closing, 0);
  const inventory = tb.rows.some((r) => ['inventory', 'finished_goods', 'work_in_process', 'raw_materials', 'supplies'].includes(r.account.hint) && (r.opening || r.closing));
  const allowance = balance((a) => a.hint === 'allowance_doubtful');
  const accumulated = balance((a) => a.hint === 'accumulated_depreciation');

  const policy = [];
  if (inventory && n.inventoryMethod.trim()) policy.push({ heading: '棚卸資産の評価基準及び評価方法', text: n.inventoryMethod.trim() });
  const dep = n.depreciation.trim() ? [n.depreciation.trim()] : depreciationPolicy(assets, period);
  if (dep.length) policy.push({ heading: '固定資産の減価償却の方法', text: dep.join('\n') });
  const allow = n.allowance.trim() || (allowance ? '貸倒引当金　債権の貸倒れによる損失に備えるため、法人税法の規定に基づく繰入限度額を計上しています。' : '');
  if (allow) policy.push({ heading: '引当金の計上基準', text: allow });
  policy.push({ heading: '消費税等の会計処理', text: '消費税等の会計処理は、税込方式によっています。' });

  const sections = [{ title: '重要な会計方針に係る事項に関する注記', items: policy }];
  const free = (title, text) => text.trim() && sections.push({ title, items: [{ text: text.trim() }] });
  free('会計方針の変更に関する注記', n.policyChanges);
  free('表示方法の変更に関する注記', n.presentationChanges);
  free('誤謬の訂正に関する注記', n.errorCorrections);
  if (n.showAccumulatedDepreciation && accumulated) sections.push({ title: '貸借対照表に関する注記', items: [{ text: `有形固定資産の減価償却累計額　${accumulated.toLocaleString('ja-JP')}円` }] });
  const equity = [];
  if (n.sharesIssued !== null) equity.push({ heading: '当事業年度の末日における発行済株式の数', text: `普通株式　${n.sharesIssued.toLocaleString('ja-JP')}株` });
  if (n.treasuryShares) equity.push({ heading: '当事業年度の末日における自己株式の数', text: `普通株式　${n.treasuryShares.toLocaleString('ja-JP')}株` });
  if (n.dividends.trim()) equity.push({ heading: '剰余金の配当に関する事項', text: n.dividends.trim() });
  if (equity.length) sections.push({ title: '株主資本等変動計算書に関する注記', items: equity });
  free('その他の注記', n.other);
  return sections;
}
