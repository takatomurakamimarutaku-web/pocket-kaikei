// 勘定科目の区分・役割・テンプレート（DOM に依存しない）
// 科目の判定は名前ではなく group（区分）と role（役割）で行う

/**
 * 区分。section：bs_asset / bs_liability / bs_equity / pl
 * side：区分の既定の残高側。entity：その区分を使う事業者（both / individual / corporation）
 */
export const GROUPS = [
  { id: 'current_assets', label: '流動資産', section: 'bs_asset', side: 'debit', entity: 'both' },
  { id: 'tangible_fixed_assets', label: '有形固定資産', section: 'bs_asset', side: 'debit', entity: 'both' },
  { id: 'intangible_fixed_assets', label: '無形固定資産', section: 'bs_asset', side: 'debit', entity: 'both' },
  { id: 'investments', label: '投資その他の資産', section: 'bs_asset', side: 'debit', entity: 'both' },
  { id: 'deferred_assets', label: '繰延資産', section: 'bs_asset', side: 'debit', entity: 'both' },
  { id: 'owner_drawings', label: '事業主貸', section: 'bs_asset', side: 'debit', entity: 'individual' },
  { id: 'current_liabilities', label: '流動負債', section: 'bs_liability', side: 'credit', entity: 'both' },
  { id: 'fixed_liabilities', label: '固定負債', section: 'bs_liability', side: 'credit', entity: 'both' },
  { id: 'equity', label: '純資産', section: 'bs_equity', side: 'credit', entity: 'both' },
  { id: 'sales', label: '売上高', section: 'pl', side: 'credit', entity: 'both' },
  { id: 'cost_of_sales', label: '売上原価', section: 'pl', side: 'debit', entity: 'both' },
  { id: 'sga', label: '販売費及び一般管理費', section: 'pl', side: 'debit', entity: 'both' },
  { id: 'non_operating_income', label: '営業外収益', section: 'pl', side: 'credit', entity: 'corporation' },
  { id: 'non_operating_expenses', label: '営業外費用', section: 'pl', side: 'debit', entity: 'corporation' },
  { id: 'extraordinary_income', label: '特別利益', section: 'pl', side: 'credit', entity: 'corporation' },
  { id: 'extraordinary_losses', label: '特別損失', section: 'pl', side: 'debit', entity: 'corporation' },
  { id: 'income_taxes', label: '法人税等', section: 'pl', side: 'debit', entity: 'corporation' },
  { id: 'reserves_reversal', label: '引当金・準備金等の繰戻額', section: 'pl', side: 'credit', entity: 'individual' },
  { id: 'reserves_provision', label: '引当金・準備金等の繰入額', section: 'pl', side: 'debit', entity: 'individual' },
  { id: 'family_salary', label: '専従者給与', section: 'pl', side: 'debit', entity: 'individual' },
  // 製造原価（法人。設定で「製造原価を使う」にしたときに科目を追加する）。合計は損益計算書の売上原価の「当期製品製造原価」になる
  { id: 'mfg_materials', label: '材料費', section: 'pl', side: 'debit', entity: 'corporation', mfg: true },
  { id: 'mfg_labor', label: '労務費', section: 'pl', side: 'debit', entity: 'corporation', mfg: true },
  { id: 'mfg_overhead', label: '製造経費', section: 'pl', side: 'debit', entity: 'corporation', mfg: true },
  { id: 'mfg_wip', label: '仕掛品棚卸高', section: 'pl', side: 'debit', entity: 'corporation', mfg: true },
];

/** 製造原価の区分 */
export const MFG_GROUPS = ['mfg_materials', 'mfg_labor', 'mfg_overhead', 'mfg_wip'];

export function isMfgGroup(groupId) {
  return MFG_GROUPS.includes(groupId);
}

export const GROUP_BY_ID = Object.fromEntries(GROUPS.map((g) => [g.id, g]));

/** 個人事業主での区分の呼び名（青色申告決算書の様式に合わせる） */
const INDIVIDUAL_LABELS = { sales: '売上(収入)金額', sga: '経費', equity: '資本', current_liabilities: '負債', fixed_liabilities: '負債' };

export function groupLabel(groupId, entityType) {
  if (entityType === 'individual' && INDIVIDUAL_LABELS[groupId]) return INDIVIDUAL_LABELS[groupId];
  return GROUP_BY_ID[groupId]?.label ?? groupId;
}

/** 事業者の種類で使える区分 */
export function groupsFor(entityType) {
  return GROUPS.filter((g) => g.entity === 'both' || g.entity === entityType);
}

export function isBsGroup(groupId) {
  return GROUP_BY_ID[groupId]?.section !== 'pl';
}

/** 役割。役割のある科目は削除・区分変更・無効化ができない */
export const ROLES = {
  cash: '現金',
  deposit: '預金',
  owner_capital: '元入金',
  owner_drawings: '事業主貸',
  owner_borrowings: '事業主借',
  capital_stock: '資本金',
  retained_earnings: '繰越利益剰余金',
  opening_inventory: '期首商品棚卸高',
  closing_inventory: '期末商品棚卸高',
};

/**
 * 目印。かんたん入力で初期値の科目を探すためだけに使う。role と違い、区分の変更・無効化を妨げない
 */
export const HINTS = {
  receivable: '売掛金',
  payable: '買掛金',
  accrued: '未払金',
  sales: '売上高',
  purchases: '仕入高',
  officer_loan: '役員借入金',
  inventory: '商品',
  depreciation: '減価償却費',
  accumulated_depreciation: '減価償却累計額',
  taxes_dues: '租税公課',
  consumption_tax_payable: '未払消費税等',
  asset_sale_gain: '固定資産売却益',
  asset_sale_loss: '固定資産売却損',
  asset_retirement_loss: '固定資産除却損',
  misc_expense: '雑費',
  // 勘定科目内訳明細書（法人）で使う
  notes_receivable: '受取手形',
  other_receivable: '未収入金',
  securities: '有価証券',
  investment_securities: '投資有価証券',
  supplies: '貯蔵品',
  advance_paid: '前払金',
  suspense_paid: '仮払金',
  short_loan: '短期貸付金',
  long_loan: '長期貸付金',
  building: '建物',
  land: '土地',
  notes_payable: '支払手形',
  short_borrowings: '短期借入金',
  long_borrowings: '長期借入金',
  accrued_expenses: '未払費用',
  advance_received: '前受金',
  deposits_received: '預り金',
  suspense_received: '仮受金',
  officer_compensation: '役員報酬',
  salaries: '給料手当',
  bonuses: '賞与',
  rent: '地代家賃',
  mfg_rent: '地代家賃（製造）',
  interest_income: '受取利息',
  interest_expense: '支払利息',
  misc_income: '雑収入',
  misc_loss: '雑損失',
  // 決算書（法人）で使う
  allowance_doubtful: '貸倒引当金',
  capital_reserve: '資本準備金',
  legal_reserve: '利益準備金',
  // 製造原価（法人）
  raw_materials: '原材料',
  work_in_process: '仕掛品',
  finished_goods: '製品',
  opening_materials: '期首材料棚卸高',
  material_purchases: '材料仕入高',
  closing_materials: '期末材料棚卸高',
  wages: '賃金',
  mfg_depreciation: '減価償却費（製造）',
  opening_wip: '期首仕掛品棚卸高',
  closing_wip: '期末仕掛品棚卸高',
  opening_finished: '期首製品棚卸高',
  closing_finished: '期末製品棚卸高',
};

/** 法人だけの目印（勘定科目内訳明細書・決算書の注記と株主資本等変動計算書で使う）。個人のテンプレートには付けない */
export const BREAKDOWN_HINTS = ['notes_receivable', 'other_receivable', 'securities', 'investment_securities', 'supplies', 'advance_paid', 'suspense_paid', 'short_loan', 'long_loan', 'building', 'land', 'notes_payable', 'short_borrowings', 'long_borrowings', 'accrued_expenses', 'advance_received', 'deposits_received', 'suspense_received', 'officer_compensation', 'salaries', 'bonuses', 'rent', 'mfg_rent', 'interest_income', 'interest_expense', 'misc_income', 'misc_loss', 'allowance_doubtful', 'capital_reserve', 'legal_reserve'];

/** 事業者ごとに必ず存在する役割 */
export const REQUIRED_ROLES = {
  individual: ['cash', 'owner_capital', 'owner_drawings', 'owner_borrowings'],
  corporation: ['cash', 'capital_stock', 'retained_earnings'],
};

// ---- テンプレート ----
// [コード, 科目名, 区分, 税区分の初期値, オプション]  オプション：role、hint、contra（評価勘定＝残高側が区分と逆）

const T = 'purchase_10';
const N = 'none';

const CORPORATION = [
  ['100', '現金', 'current_assets', N, { role: 'cash' }],
  ['101', '小口現金', 'current_assets', N, { role: 'cash' }],
  ['110', '当座預金', 'current_assets', N, { role: 'deposit' }],
  ['111', '普通預金', 'current_assets', N, { role: 'deposit' }],
  ['112', '定期預金', 'current_assets', N, { role: 'deposit' }],
  ['120', '受取手形', 'current_assets', N, { hint: 'notes_receivable' }],
  ['121', '売掛金', 'current_assets', N, { hint: 'receivable' }],
  ['130', '有価証券', 'current_assets', N, { hint: 'securities' }],
  ['140', '商品', 'current_assets', N, { hint: 'inventory' }],
  ['141', '貯蔵品', 'current_assets', N, { hint: 'supplies' }],
  ['150', '前払金', 'current_assets', N, { hint: 'advance_paid' }],
  ['151', '前払費用', 'current_assets', N],
  ['152', '立替金', 'current_assets', N],
  ['153', '仮払金', 'current_assets', N, { hint: 'suspense_paid' }],
  ['154', '未収入金', 'current_assets', N, { hint: 'other_receivable' }],
  ['155', '短期貸付金', 'current_assets', N, { hint: 'short_loan' }],
  ['199', '貸倒引当金', 'current_assets', N, { contra: true, hint: 'allowance_doubtful' }],
  ['200', '建物', 'tangible_fixed_assets', T, { hint: 'building' }],
  ['201', '建物附属設備', 'tangible_fixed_assets', T],
  ['202', '構築物', 'tangible_fixed_assets', T],
  ['203', '機械装置', 'tangible_fixed_assets', T],
  ['204', '車両運搬具', 'tangible_fixed_assets', T],
  ['205', '工具器具備品', 'tangible_fixed_assets', T],
  ['206', '土地', 'tangible_fixed_assets', 'purchase_exempt', { hint: 'land' }],
  ['219', '減価償却累計額', 'tangible_fixed_assets', N, { contra: true, hint: 'accumulated_depreciation' }],
  ['220', 'ソフトウェア', 'intangible_fixed_assets', T],
  ['221', '電話加入権', 'intangible_fixed_assets', T],
  ['240', '投資有価証券', 'investments', N, { hint: 'investment_securities' }],
  ['241', '出資金', 'investments', N],
  ['242', '長期貸付金', 'investments', N, { hint: 'long_loan' }],
  ['243', '敷金', 'investments', N],
  ['244', '差入保証金', 'investments', N],
  ['245', '長期前払費用', 'investments', N],
  ['260', '創立費', 'deferred_assets', N],
  ['261', '開業費', 'deferred_assets', N],
  ['300', '支払手形', 'current_liabilities', N, { hint: 'notes_payable' }],
  ['301', '買掛金', 'current_liabilities', N, { hint: 'payable' }],
  ['302', '短期借入金', 'current_liabilities', N, { hint: 'short_borrowings' }],
  ['303', '未払金', 'current_liabilities', N, { hint: 'accrued' }],
  ['304', '未払費用', 'current_liabilities', N, { hint: 'accrued_expenses' }],
  ['305', '前受金', 'current_liabilities', N, { hint: 'advance_received' }],
  ['306', '預り金', 'current_liabilities', N, { hint: 'deposits_received' }],
  ['307', '仮受金', 'current_liabilities', N, { hint: 'suspense_received' }],
  ['308', '未払法人税等', 'current_liabilities', N],
  ['309', '未払消費税等', 'current_liabilities', N, { hint: 'consumption_tax_payable' }],
  ['350', '長期借入金', 'fixed_liabilities', N, { hint: 'long_borrowings' }],
  ['351', '役員借入金', 'fixed_liabilities', N, { hint: 'officer_loan' }],
  ['400', '資本金', 'equity', N, { role: 'capital_stock' }],
  ['401', '資本準備金', 'equity', N, { hint: 'capital_reserve' }],
  ['410', '利益準備金', 'equity', N, { hint: 'legal_reserve' }],
  ['411', '繰越利益剰余金', 'equity', N, { role: 'retained_earnings' }],
  ['500', '売上高', 'sales', 'sales_10', { hint: 'sales' }],
  ['510', '期首商品棚卸高', 'cost_of_sales', N, { role: 'opening_inventory' }],
  ['511', '仕入高', 'cost_of_sales', T, { hint: 'purchases' }],
  ['519', '期末商品棚卸高', 'cost_of_sales', N, { role: 'closing_inventory', contra: true }],
  ['600', '役員報酬', 'sga', N, { hint: 'officer_compensation' }],
  ['601', '給料手当', 'sga', N, { hint: 'salaries' }],
  ['602', '賞与', 'sga', N, { hint: 'bonuses' }],
  ['603', '法定福利費', 'sga', 'purchase_exempt'],
  ['604', '福利厚生費', 'sga', T],
  ['605', '外注費', 'sga', T],
  ['606', '荷造運賃', 'sga', T],
  ['607', '広告宣伝費', 'sga', T],
  ['608', '接待交際費', 'sga', T],
  ['609', '会議費', 'sga', T],
  ['610', '旅費交通費', 'sga', T],
  ['611', '通信費', 'sga', T],
  ['612', '販売手数料', 'sga', T],
  ['613', '消耗品費', 'sga', T],
  ['614', '事務用品費', 'sga', T],
  ['615', '修繕費', 'sga', T],
  ['616', '水道光熱費', 'sga', T],
  ['617', '新聞図書費', 'sga', T],
  ['618', '諸会費', 'sga', N],
  ['619', '支払手数料', 'sga', T],
  ['620', '車両費', 'sga', T],
  ['621', '地代家賃', 'sga', T, { hint: 'rent' }],
  ['622', '賃借料', 'sga', T],
  ['623', '保険料', 'sga', 'purchase_exempt'],
  ['624', '租税公課', 'sga', N, { hint: 'taxes_dues' }],
  ['625', '支払報酬料', 'sga', T],
  ['626', '減価償却費', 'sga', N, { hint: 'depreciation' }],
  ['699', '雑費', 'sga', T, { hint: 'misc_expense' }],
  ['700', '受取利息', 'non_operating_income', 'sales_exempt', { hint: 'interest_income' }],
  ['701', '受取配当金', 'non_operating_income', N],
  ['702', '雑収入', 'non_operating_income', 'sales_10', { hint: 'misc_income' }],
  ['710', '支払利息', 'non_operating_expenses', 'purchase_exempt', { hint: 'interest_expense' }],
  ['711', '雑損失', 'non_operating_expenses', N, { hint: 'misc_loss' }],
  ['720', '固定資産売却益', 'extraordinary_income', N, { hint: 'asset_sale_gain' }],
  ['730', '固定資産売却損', 'extraordinary_losses', N, { hint: 'asset_sale_loss' }],
  ['731', '固定資産除却損', 'extraordinary_losses', N, { hint: 'asset_retirement_loss' }],
  ['740', '法人税、住民税及び事業税', 'income_taxes', N],
];

// 個人：青色申告決算書（一般用）の科目と並びに合わせる
const INDIVIDUAL = [
  ['100', '現金', 'current_assets', N, { role: 'cash' }],
  ['110', '当座預金', 'current_assets', N, { role: 'deposit' }],
  ['111', '定期預金', 'current_assets', N, { role: 'deposit' }],
  ['112', '普通預金', 'current_assets', N, { role: 'deposit' }],
  ['120', '受取手形', 'current_assets', N, { hint: 'notes_receivable' }],
  ['121', '売掛金', 'current_assets', N, { hint: 'receivable' }],
  ['130', '有価証券', 'current_assets', N, { hint: 'securities' }],
  ['140', '商品', 'current_assets', N, { hint: 'inventory' }],
  ['150', '前払金', 'current_assets', N],
  ['151', '貸付金', 'current_assets', N],
  ['152', '未収入金', 'current_assets', N],
  ['200', '建物', 'tangible_fixed_assets', T],
  ['201', '建物附属設備', 'tangible_fixed_assets', T],
  ['202', '機械装置', 'tangible_fixed_assets', T],
  ['203', '車両運搬具', 'tangible_fixed_assets', T],
  ['204', '工具器具備品', 'tangible_fixed_assets', T],
  ['205', '土地', 'tangible_fixed_assets', 'purchase_exempt'],
  ['220', 'ソフトウェア', 'intangible_fixed_assets', T],
  ['240', '敷金', 'investments', N],
  ['290', '事業主貸', 'owner_drawings', N, { role: 'owner_drawings' }],
  ['300', '支払手形', 'current_liabilities', N, { hint: 'notes_payable' }],
  ['301', '買掛金', 'current_liabilities', N, { hint: 'payable' }],
  ['302', '借入金', 'current_liabilities', N],
  ['303', '未払金', 'current_liabilities', N, { hint: 'accrued' }],
  ['304', '前受金', 'current_liabilities', N],
  ['305', '預り金', 'current_liabilities', N],
  ['309', '貸倒引当金', 'current_liabilities', N],
  ['400', '事業主借', 'equity', N, { role: 'owner_borrowings' }],
  ['410', '元入金', 'equity', N, { role: 'owner_capital' }],
  ['500', '売上高', 'sales', 'sales_10', { hint: 'sales' }],
  ['501', '雑収入', 'sales', 'sales_10'],
  ['510', '期首商品棚卸高', 'cost_of_sales', N, { role: 'opening_inventory' }],
  ['511', '仕入高', 'cost_of_sales', T, { hint: 'purchases' }],
  ['519', '期末商品棚卸高', 'cost_of_sales', N, { role: 'closing_inventory', contra: true }],
  ['600', '租税公課', 'sga', N, { hint: 'taxes_dues' }],
  ['601', '荷造運賃', 'sga', T],
  ['602', '水道光熱費', 'sga', T],
  ['603', '旅費交通費', 'sga', T],
  ['604', '通信費', 'sga', T],
  ['605', '広告宣伝費', 'sga', T],
  ['606', '接待交際費', 'sga', T],
  ['607', '損害保険料', 'sga', 'purchase_exempt'],
  ['608', '修繕費', 'sga', T],
  ['609', '消耗品費', 'sga', T],
  ['610', '減価償却費', 'sga', N, { hint: 'depreciation' }],
  ['611', '福利厚生費', 'sga', T],
  ['612', '給料賃金', 'sga', N],
  ['613', '外注工賃', 'sga', T],
  ['614', '利子割引料', 'sga', 'purchase_exempt'],
  ['615', '地代家賃', 'sga', T],
  ['616', '貸倒金', 'sga', N],
  ['620', '支払手数料', 'sga', T],
  ['621', '車両費', 'sga', T],
  ['622', '新聞図書費', 'sga', T],
  ['623', '会議費', 'sga', T],
  ['699', '雑費', 'sga', T, { hint: 'misc_expense' }],
  ['700', '貸倒引当金繰戻額', 'reserves_reversal', N],
  ['710', '貸倒引当金繰入額', 'reserves_provision', N],
  ['720', '専従者給与', 'family_salary', N],
];

export const TEMPLATES = { corporation: CORPORATION, individual: INDIVIDUAL };

// 製造原価の科目（法人。設定で「製造原価を使う」にしたときに追加する。テンプレートと違い、使っていなければ削除できる）
// 並びは財務諸表等規則の製造原価明細書（材料費・労務費・経費・当期総製造費用・期首／期末仕掛品棚卸高・当期製品製造原価）と
// 国税庁「勘定科目内訳明細書」の原価の内訳書（材料費は期首材料棚卸高＋材料仕入高−期末材料棚卸高）に合わせる
const MANUFACTURING = [
  ['142', '製品', 'current_assets', N, { hint: 'finished_goods' }],
  ['143', '仕掛品', 'current_assets', N, { hint: 'work_in_process' }],
  ['144', '原材料', 'current_assets', N, { hint: 'raw_materials' }],
  ['513', '期首製品棚卸高', 'cost_of_sales', N, { hint: 'opening_finished' }],
  ['518', '期末製品棚卸高', 'cost_of_sales', N, { hint: 'closing_finished', contra: true }],
  ['800', '期首材料棚卸高', 'mfg_materials', N, { hint: 'opening_materials' }],
  ['801', '材料仕入高', 'mfg_materials', T, { hint: 'material_purchases' }],
  ['809', '期末材料棚卸高', 'mfg_materials', N, { hint: 'closing_materials', contra: true }],
  ['810', '賃金', 'mfg_labor', N, { hint: 'wages' }],
  ['811', '雑給', 'mfg_labor', N],
  ['812', '賞与（製造）', 'mfg_labor', N],
  ['813', '法定福利費（製造）', 'mfg_labor', 'purchase_exempt'],
  ['814', '福利厚生費（製造）', 'mfg_labor', T],
  ['820', '外注加工費', 'mfg_overhead', T],
  ['821', '電力費', 'mfg_overhead', T],
  ['822', '水道光熱費（製造）', 'mfg_overhead', T],
  ['823', '修繕費（製造）', 'mfg_overhead', T],
  ['824', '消耗品費（製造）', 'mfg_overhead', T],
  ['825', '減価償却費（製造）', 'mfg_overhead', N, { hint: 'mfg_depreciation' }],
  ['826', '地代家賃（製造）', 'mfg_overhead', T, { hint: 'mfg_rent' }],
  ['827', '保険料（製造）', 'mfg_overhead', 'purchase_exempt'],
  ['828', '租税公課（製造）', 'mfg_overhead', N],
  ['829', '運賃（製造）', 'mfg_overhead', T],
  ['839', '雑費（製造）', 'mfg_overhead', T],
  ['850', '期首仕掛品棚卸高', 'mfg_wip', N, { hint: 'opening_wip' }],
  ['859', '期末仕掛品棚卸高', 'mfg_wip', N, { hint: 'closing_wip', contra: true }],
];

const toAccount = ([code, name, group, tax, opt = {}], template) => ({
  code,
  name,
  group,
  role: opt.role ?? null,
  hint: opt.hint ?? null,
  normalSide: normalSideFor(group, opt.contra),
  defaultTaxCategory: tax,
  active: true,
  sortOrder: Number(code),
  template,
});

/**
 * 製造原価を使うときに追加する科目の元（id・日時は呼び出し側で付ける）
 * 同じ目印の科目があれば追加しない。コードが使われていれば空いている次の番号にする
 * @param {Array} existing 今ある科目
 */
export function manufacturingAccounts(existing = []) {
  const hints = new Set(existing.map((a) => a.hint).filter(Boolean));
  const names = new Set(existing.map((a) => a.name));
  const codes = new Set(existing.map((a) => String(a.code)));
  const out = [];
  for (const row of MANUFACTURING) {
    const hint = row[4]?.hint;
    if (hint ? hints.has(hint) : names.has(row[1])) continue;
    let code = Number(row[0]);
    while (codes.has(String(code))) code += 1;
    codes.add(String(code));
    out.push({ ...toAccount(row, false), code: String(code), sortOrder: code });
  }
  return out;
}

/** 区分と評価勘定かどうかから残高側を決める */
export function normalSideFor(groupId, contra = false) {
  const side = GROUP_BY_ID[groupId].side;
  return contra ? (side === 'debit' ? 'credit' : 'debit') : side;
}

/**
 * テンプレートから科目レコードの元を作る（id・日時は呼び出し側で付ける）
 * @returns {Array<{code,name,group,role,hint,normalSide,defaultTaxCategory,active,sortOrder,template}>}
 */
export function templateAccounts(entityType) {
  const rows = TEMPLATES[entityType];
  if (!rows) throw new Error(`不明な事業者の種類です: ${entityType}`);
  return rows.map((row) => toAccount(row, true));
}

/** 科目の並び：区分の順 → 並び順 → コード */
export function compareAccounts(a, b) {
  const gi = (x) => GROUPS.findIndex((g) => g.id === x.group);
  return gi(a) - gi(b) || (a.sortOrder ?? 0) - (b.sortOrder ?? 0) || String(a.code).localeCompare(String(b.code));
}

/** 役割を持つ最初の科目 */
export function findByRole(accounts, role) {
  return accounts.find((a) => a.role === role) || null;
}

/** 目印を持つ有効な最初の科目 */
export function findByHint(accounts, hint) {
  return accounts.find((a) => a.hint === hint && a.active) || null;
}

/**
 * 目印を持たないテンプレートの科目に、コードで目印を補う（目印の導入前に作ったデータ・復元データ、
 * 後から目印を増やしたときの既存データ用）。同じ目印を持つ科目が既にあれば付けない
 * @returns {Array} 変更した科目（変更が無ければ空）
 */
export function fillHints(entityType, accounts) {
  const byCode = new Map((TEMPLATES[entityType] || []).filter((r) => r[4]?.hint).map((r) => [r[0], r[4].hint]));
  const taken = new Set(accounts.map((a) => a.hint).filter(Boolean));
  const out = [];
  for (const a of accounts) {
    if (!a.template || a.hint) continue;
    const hint = byCode.get(a.code);
    if (hint && !taken.has(hint)) {
      taken.add(hint);
      out.push({ ...a, hint });
    } else if (a.hint === undefined) out.push({ ...a, hint: null });
  }
  return out;
}

/** 評価勘定か（残高側が区分の既定と逆） */
export function isContra(account) {
  return GROUP_BY_ID[account.group]?.side !== account.normalSide;
}

/**
 * 科目の検証（追加・編集）
 * @param {object} account
 * @param {Array} others 他の科目（コード重複の確認用）
 * @param {{ used?: boolean, entityType: string }} ctx used：仕訳・期首残高で使われているか
 * @param {object|null} before 編集前の科目
 */
export function validateAccount(account, others, { used = false, entityType } = {}, before = null) {
  const errors = {};
  const code = String(account.code ?? '').trim();
  if (!/^\d{1,6}$/.test(code)) errors.code = 'コードは6桁以内の数字で入力してください';
  else if (others.some((o) => o.id !== account.id && o.code === code)) errors.code = 'このコードは使われています';
  if (!String(account.name ?? '').trim()) errors.name = '科目名を入力してください';
  else if (String(account.name).length > 30) errors.name = '科目名は30文字以内にしてください';
  const g = GROUP_BY_ID[account.group];
  if (!g || (g.entity !== 'both' && g.entity !== entityType)) errors.group = '区分を選んでください';
  if (account.normalSide !== 'debit' && account.normalSide !== 'credit') errors.normalSide = '残高の側を選んでください';
  // 家事按分の事業割合（%）。個人の経費だけ。未設定は null
  if (account.businessRatio != null) {
    if (entityType !== 'individual' || account.group !== 'sga' || account.hint === 'depreciation') errors.businessRatio = '事業割合は個人の経費の科目（減価償却費を除く）だけに設定できます';
    else if (!Number.isInteger(account.businessRatio) || account.businessRatio < 1 || account.businessRatio > 99) errors.businessRatio = '事業割合は1〜99の整数（%）で入力してください';
  }
  if (before) {
    if (before.role && account.group !== before.group) errors.group = 'この科目は区分を変更できません';
    if (before.role && account.active === false) errors.active = 'この科目は無効にできません';
    if (used && (account.group !== before.group || account.normalSide !== before.normalSide)) {
      errors.group = errors.group || '使用中の科目は区分・残高の側を変更できません';
    }
  }
  return errors;
}
