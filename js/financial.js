// 決算書（法人）：販売費及び一般管理費の内訳・株主資本等変動計算書・個別注記表（純粋関数）
//
// 計算書類の種類（貸借対照表・損益計算書・株主資本等変動計算書・個別注記表）：会社法 第435条第2項、会社計算規則 第59条
// 個別注記表の項目（会社計算規則 第98条第1項）と、会計監査人を置かない会社が表示しなくてよい項目（同条第2項）：
//   非公開会社（第1号）：継続企業の前提・会計上の見積り・見積りの変更・貸借対照表等・損益計算書・税効果会計〜連結配当規制適用会社（第10号〜第18号）を除く
//     → 重要な会計方針・会計方針の変更・表示方法の変更・誤謬の訂正・株主資本等変動計算書・収益認識・その他
//   公開会社（第2号）：継続企業の前提・会計上の見積り・見積りの変更・持分法損益等・連結配当規制適用会社を除く
//     → 上に加えて 貸借対照表等・損益計算書・税効果会計・リース・金融商品・賃貸等不動産・関連当事者との取引・一株当たり情報・重要な後発事象
//   （令和2年8月12日法務省令第45号による改正後の条文で確認。docs/spec-phase3-fs-formats.md）
// 中小会計要領・中小会計指針で作ったときは、注記表の冒頭に「この計算書類は、「…」によって作成しています。」と書く（実務の記載例）
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

/**
 * 個別注記表のパターン：会社の区分（表示する項目が変わる）と、計算書類を作るときに従った会計のルール（冒頭の文）
 * 会計監査人を置く会社（大会社など）は対象外
 */
export const NOTE_COMPANY_TYPES = [
  ['private', '非公開会社（株式に譲渡制限あり）'],
  ['public', '公開会社（譲渡制限なし）'],
];
export const NOTE_STANDARDS = [
  ['none', '書かない'],
  ['youryou', '中小会計要領'],
  ['shishin', '中小会計指針'],
];
const STANDARD_LEAD = {
  youryou: 'この計算書類は、「中小企業の会計に関する基本要領」によって作成しています。',
  shishin: 'この計算書類は、「中小企業の会計に関する指針」によって作成しています。',
};

/**
 * 個別注記表の項目（会社計算規則 第98条第1項の順）。public：公開会社だけが表示する項目
 * key：入力の文の欄（無いものは計算や他の欄から作る）
 */
export const NOTE_SECTIONS = [
  { id: 'policy', title: '重要な会計方針に係る事項に関する注記' },
  { id: 'policyChanges', title: '会計方針の変更に関する注記', key: 'policyChanges' },
  { id: 'presentationChanges', title: '表示方法の変更に関する注記', key: 'presentationChanges' },
  { id: 'errorCorrections', title: '誤謬の訂正に関する注記', key: 'errorCorrections' },
  { id: 'balanceSheet', title: '貸借対照表等に関する注記', key: 'balanceSheetNotes', public: true },
  { id: 'incomeStatement', title: '損益計算書に関する注記', key: 'incomeStatementNotes', public: true },
  { id: 'equity', title: '株主資本等変動計算書に関する注記' },
  { id: 'taxEffect', title: '税効果会計に関する注記', key: 'taxEffect', public: true },
  { id: 'lease', title: 'リースにより使用する固定資産に関する注記', key: 'lease', public: true },
  { id: 'financialInstruments', title: '金融商品に関する注記', key: 'financialInstruments', public: true },
  { id: 'rentalProperty', title: '賃貸等不動産に関する注記', key: 'rentalProperty', public: true },
  { id: 'relatedParty', title: '関連当事者との取引に関する注記', key: 'relatedParty', public: true },
  { id: 'perShare', title: '一株当たり情報に関する注記', key: 'perShare', public: true },
  { id: 'subsequentEvents', title: '重要な後発事象に関する注記', key: 'subsequentEvents', public: true },
  { id: 'revenueRecognition', title: '収益認識に関する注記', key: 'revenueRecognition' },
  { id: 'other', title: 'その他の注記', key: 'other' },
];

/** 個別注記表の入力の初期値（period.statementNotes） */
export const DEFAULT_NOTES = {
  companyType: 'private',
  standard: 'none',
  showNone: false, // 表示する項目で該当が無いものも「該当事項はありません。」と書く
  securities: '',
  inventoryMethod: '最終仕入原価法による原価法',
  depreciation: '', // 空なら固定資産台帳から文を作る
  allowance: '', // 空なら貸倒引当金の残高があるときに定型文
  revenue: '',
  policyChanges: '',
  presentationChanges: '',
  errorCorrections: '',
  showAccumulatedDepreciation: true,
  balanceSheetNotes: '',
  incomeStatementNotes: '',
  sharesIssued: null,
  treasuryShares: null,
  dividends: '',
  taxEffect: '',
  lease: '',
  financialInstruments: '',
  rentalProperty: '',
  relatedParty: '',
  perShare: '', // 空なら発行済株式の数から1株当たり純資産額・当期純利益を計算する（公開会社）
  subsequentEvents: '',
  revenueRecognition: '',
  other: '',
};

/** 前期の注記から引き継ぐ項目（パターン・会計方針・株式の数。その期だけの出来事の文は引き継がない） */
export const CARRY_NOTE_KEYS = ['companyType', 'standard', 'showNone', 'securities', 'inventoryMethod', 'depreciation', 'allowance', 'revenue', 'showAccumulatedDepreciation', 'sharesIssued', 'treasuryShares'];

/** 文字の入力欄（長さの上限） */
export const NOTE_TEXT_KEYS = Object.keys(DEFAULT_NOTES).filter((k) => typeof DEFAULT_NOTES[k] === 'string' && !['companyType', 'standard'].includes(k));
export const NOTE_TEXT_MAX = 2000;

/** 個別注記表の入力を検証する。エラーメッセージの配列を返す */
export function validateNotes(notes) {
  const errors = [];
  for (const k of NOTE_TEXT_KEYS) if (typeof notes[k] !== 'string' || notes[k].length > NOTE_TEXT_MAX) errors.push(`注記の文は${NOTE_TEXT_MAX}文字以内で入力してください`);
  for (const k of ['sharesIssued', 'treasuryShares']) if (notes[k] !== null && !(Number.isInteger(notes[k]) && notes[k] >= 0)) errors.push('株式の数は0以上の整数で入力してください');
  if (typeof notes.showAccumulatedDepreciation !== 'boolean') errors.push('減価償却累計額の注記の有無を選んでください');
  if (typeof notes.showNone !== 'boolean') errors.push('該当の無い項目の書き方を選んでください');
  if (!NOTE_COMPANY_TYPES.some(([v]) => v === notes.companyType)) errors.push('会社の区分を選んでください');
  if (!NOTE_STANDARDS.some(([v]) => v === notes.standard)) errors.push('会計のルールを選んでください');
  return [...new Set(errors)];
}

/** 注記表の冒頭の文（中小会計要領・中小会計指針で作ったとき）。無ければ空文字 */
export function notesLead(notes = {}) {
  return STANDARD_LEAD[notes.standard] ?? '';
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
 * 1株当たりの金額（円・銭）の文。小数第3位を四捨五入し、マイナスは△
 * @param {number} yen 金額（円）  @param {number} shares 株式の数
 */
export function perShareText(yen, shares) {
  const sen = Math.round((Math.abs(yen) * 100) / shares);
  const text = `${Math.floor(sen / 100).toLocaleString('ja-JP')}.${String(sen % 100).padStart(2, '0')}円`;
  return yen < 0 && sen ? `△${text}` : text;
}

/**
 * 個別注記表の内容。パターン（会社の区分）で表示する項目を選び、該当が無い項目は出さない（showNone なら「該当事項はありません。」）
 * @param {{ netAssets?: number, netIncome?: number }} [figures] 一株当たり情報の計算に使う純資産合計・当期純利益（公開会社）
 * @returns {Array<{ id, title, items: Array<{ heading?: string, text: string }> }>}
 */
export function companyNotes({ accounts, period, journals, assets = [], notes = {}, netAssets = null, netIncome = null }) {
  const n = { ...DEFAULT_NOTES, ...notes };
  const isPublic = n.companyType === 'public';
  const tb = trialBalance({ accounts, period, journals });
  const balance = (pred) => tb.rows.filter((r) => pred(r.account)).reduce((s, r) => s + r.closing, 0);
  const inventory = tb.rows.some((r) => ['inventory', 'finished_goods', 'work_in_process', 'raw_materials', 'supplies'].includes(r.account.hint) && (r.opening || r.closing));
  const allowance = balance((a) => a.hint === 'allowance_doubtful');
  const accumulated = balance((a) => a.hint === 'accumulated_depreciation');
  const t = (k) => (n[k] || '').trim();

  const items = {};
  const policy = [];
  if (t('securities')) policy.push({ heading: '有価証券の評価基準及び評価方法', text: t('securities') });
  if (inventory && t('inventoryMethod')) policy.push({ heading: '棚卸資産の評価基準及び評価方法', text: t('inventoryMethod') });
  const dep = t('depreciation') ? [t('depreciation')] : depreciationPolicy(assets, period);
  if (dep.length) policy.push({ heading: '固定資産の減価償却の方法', text: dep.join('\n') });
  const allow = t('allowance') || (allowance ? '貸倒引当金　債権の貸倒れによる損失に備えるため、法人税法の規定に基づく繰入限度額を計上しています。' : '');
  if (allow) policy.push({ heading: '引当金の計上基準', text: allow });
  if (t('revenue')) policy.push({ heading: '収益及び費用の計上基準', text: t('revenue') });
  policy.push({ heading: '消費税等の会計処理', text: '消費税等の会計処理は、税込方式によっています。' });
  items.policy = policy;

  // 貸借対照表等：減価償却累計額（任意。非公開会社でも書ける）と、担保資産・保証債務・関係会社に対する金銭債権債務などの文
  const bs = [];
  if (n.showAccumulatedDepreciation && accumulated) bs.push({ text: `有形固定資産の減価償却累計額　${accumulated.toLocaleString('ja-JP')}円` });
  if (isPublic && t('balanceSheetNotes')) bs.push({ text: t('balanceSheetNotes') });
  items.balanceSheet = bs;

  const equity = [];
  if (n.sharesIssued !== null) equity.push({ heading: '当事業年度の末日における発行済株式の数', text: `普通株式　${n.sharesIssued.toLocaleString('ja-JP')}株` });
  if (n.treasuryShares) equity.push({ heading: '当事業年度の末日における自己株式の数', text: `普通株式　${n.treasuryShares.toLocaleString('ja-JP')}株` });
  if (t('dividends')) equity.push({ heading: '剰余金の配当に関する事項', text: t('dividends') });
  items.equity = equity;

  // 一株当たり情報：文を入れなければ、期末の発行済株式の数（自己株式を除く）で純資産合計と当期純利益を割る（期中に株式の数が変わらない前提）
  const outstanding = n.sharesIssued !== null ? n.sharesIssued - (n.treasuryShares || 0) : 0;
  if (t('perShare')) items.perShare = [{ text: t('perShare') }];
  else if (outstanding > 0 && netAssets !== null && netIncome !== null) items.perShare = [{ text: `1株当たり純資産額　${perShareText(netAssets, outstanding)}\n1株当たり当期純利益　${perShareText(netIncome, outstanding)}` }];
  else items.perShare = [];

  const out = [];
  for (const sec of NOTE_SECTIONS) {
    // 貸借対照表等は、非公開会社でも減価償却累計額を書くときは出す（任意の注記）
    const target = !sec.public || isPublic || (sec.id === 'balanceSheet' && items.balanceSheet.length);
    if (!target) continue;
    const list = items[sec.id] ?? (t(sec.key) ? [{ text: t(sec.key) }] : []);
    if (list.length || n.showNone) out.push({ id: sec.id, title: sec.title, items: list });
  }
  return out;
}
