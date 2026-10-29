// 固定資産と減価償却の計算（純粋関数）
// 出典（2026-10-29 確認。いずれも令和8年4月1日現在の法令等）
// - 国税庁 タックスアンサー No.2100 減価償却のあらまし（個人）
//   https://www.nta.go.jp/taxes/shiraberu/taxanswer/shotoku/2100.htm
// - 国税庁 No.2106 定額法と定率法による減価償却（平成19年4月1日以後に取得する場合）
//   https://www.nta.go.jp/taxes/shiraberu/taxanswer/shotoku/2106.htm
// - 国税庁 No.5410 減価償却資産の償却限度額の計算方法（法人・平成19年4月1日以後取得分）
//   https://www.nta.go.jp/taxes/shiraberu/taxanswer/hojin/5410.htm
// - 国税庁 No.5408 中小企業者等の少額減価償却資産の取得価額の損金算入の特例
//   https://www.nta.go.jp/taxes/shiraberu/taxanswer/hojin/5408.htm
// - 償却率表：国税庁「令和7年分 青色申告決算書（一般用）の書き方」の減価償却資産の償却率等表
//   https://www.nta.go.jp/taxes/shiraberu/shinkoku/tebiki/2025/pdf/037.pdf （耐用年数省令 別表第七〜第十）
//   旧定額法・旧定率法・250%定率法の率は、国税庁「個人の減価償却制度の改正について」資料編でも照合した
//   https://www.nta.go.jp/law/joho-zeikaishaku/shotoku/shinkoku/070412/pdf/3.pdf
// - 旧定額法・旧定率法（平成19年3月31日以前の取得）：国税庁 No.2105
//   https://www.nta.go.jp/taxes/shiraberu/taxanswer/shotoku/2105.htm
//   残存価額は取得価額の10%（無形は0）。償却費の累積額が取得価額の95%に達したら、翌年から5年間で1円まで均等に償却する
//   （青色申告決算書の書き方：{(取得価額−取得価額×95%−1円)÷5}×本年中の償却期間/12）
// - 平成19年3月31日以前に取得し、4月1日以後に事業の用に供した資産は、供用日に取得したものとみなす（No.5410）
// - 特別償却：特別償却限度額は事業供用年度に 取得価額×率（例：中小企業投資促進税制 30%。月数按分しない）、
//   中小企業経営強化税制の即時償却は 取得価額−普通償却限度額。国税庁 No.5433・No.5434
//   https://www.nta.go.jp/taxes/shiraberu/taxanswer/hojin/5433.htm ・ https://www.nta.go.jp/taxes/shiraberu/taxanswer/hojin/5434.htm
// 金額はすべて整数の円。率は整数（定額法・定率法・改定償却率は1/1000、保証率は1/100000）で持ち、浮動小数点を使わない
import { isValidDate, addMonths, addDays } from './period.js';
import { isYen } from './money.js';

/**
 * 償却率表（耐用年数 2〜50 年）
 * [定額法の償却率, 定率法（200%・平成24年4月1日以後取得）の償却率, 改定償却率, 保証率]
 * 2年の定率法は1年で償却し終わるため改定償却率・保証率なし（0）
 */
export const RATE_TABLE = {
  2: [500, 1000, 0, 0],
  3: [334, 667, 1000, 11089],
  4: [250, 500, 1000, 12499],
  5: [200, 400, 500, 10800],
  6: [167, 333, 334, 9911],
  7: [143, 286, 334, 8680],
  8: [125, 250, 334, 7909],
  9: [112, 222, 250, 7126],
  10: [100, 200, 250, 6552],
  11: [91, 182, 200, 5992],
  12: [84, 167, 200, 5566],
  13: [77, 154, 167, 5180],
  14: [72, 143, 167, 4854],
  15: [67, 133, 143, 4565],
  16: [63, 125, 143, 4294],
  17: [59, 118, 125, 4038],
  18: [56, 111, 112, 3884],
  19: [53, 105, 112, 3693],
  20: [50, 100, 112, 3486],
  21: [48, 95, 100, 3335],
  22: [46, 91, 100, 3182],
  23: [44, 87, 91, 3052],
  24: [42, 83, 84, 2969],
  25: [40, 80, 84, 2841],
  26: [39, 77, 84, 2716],
  27: [38, 74, 77, 2624],
  28: [36, 71, 72, 2568],
  29: [35, 69, 72, 2463],
  30: [34, 67, 72, 2366],
  31: [33, 65, 67, 2286],
  32: [32, 63, 67, 2216],
  33: [31, 61, 63, 2161],
  34: [30, 59, 63, 2097],
  35: [29, 57, 59, 2051],
  36: [28, 56, 59, 1974],
  37: [28, 54, 56, 1950],
  38: [27, 53, 56, 1882],
  39: [26, 51, 53, 1860],
  40: [25, 50, 53, 1791],
  41: [25, 49, 50, 1741],
  42: [24, 48, 50, 1694],
  43: [24, 47, 48, 1664],
  44: [23, 45, 46, 1664],
  45: [23, 44, 46, 1634],
  46: [22, 43, 44, 1601],
  47: [22, 43, 44, 1532],
  48: [21, 42, 44, 1499],
  49: [21, 41, 42, 1475],
  50: [20, 40, 42, 1440],
};
export const MIN_LIFE = 2;
export const MAX_LIFE = 50;

/**
 * 平成19年3月31日以前に取得した資産の償却率（耐用年数省令 別表第七）[旧定額法, 旧定率法]（1/1000）
 */
export const OLD_RATE_TABLE = {
  2: [500, 684], 3: [333, 536], 4: [250, 438], 5: [200, 369], 6: [166, 319], 7: [142, 280], 8: [125, 250], 9: [111, 226], 10: [100, 206],
  11: [90, 189], 12: [83, 175], 13: [76, 162], 14: [71, 152], 15: [66, 142], 16: [62, 134], 17: [58, 127], 18: [55, 120], 19: [52, 114], 20: [50, 109],
  21: [48, 104], 22: [46, 99], 23: [44, 95], 24: [42, 92], 25: [40, 88], 26: [39, 85], 27: [37, 82], 28: [36, 79], 29: [35, 76], 30: [34, 74],
  31: [33, 72], 32: [32, 69], 33: [31, 67], 34: [30, 66], 35: [29, 64], 36: [28, 62], 37: [27, 60], 38: [27, 59], 39: [26, 57], 40: [25, 56],
  41: [25, 55], 42: [24, 53], 43: [24, 52], 44: [23, 51], 45: [23, 50], 46: [22, 49], 47: [22, 48], 48: [21, 47], 49: [21, 46], 50: [20, 45],
};

/**
 * 250%定率法（平成19年4月1日〜平成24年3月31日の取得。耐用年数省令 別表第九）[償却率, 改定償却率, 保証率]
 * 償却率・改定償却率は1/1000、保証率は1/100000。2年は1年で償却し終わるため改定償却率・保証率なし（0）
 */
export const DECLINING_250_TABLE = {
  2: [1000, 0, 0], 3: [833, 1000, 2789], 4: [625, 1000, 5274], 5: [500, 1000, 6249], 6: [417, 500, 5776], 7: [357, 500, 5496], 8: [313, 334, 5111],
  9: [278, 334, 4731], 10: [250, 334, 4448], 11: [227, 250, 4123], 12: [208, 250, 3870], 13: [192, 200, 3633], 14: [179, 200, 3389], 15: [167, 200, 3217],
  16: [156, 167, 3063], 17: [147, 167, 2905], 18: [139, 143, 2757], 19: [132, 143, 2616], 20: [125, 143, 2517], 21: [119, 125, 2408], 22: [114, 125, 2296],
  23: [109, 112, 2226], 24: [104, 112, 2157], 25: [100, 112, 2058], 26: [96, 100, 1989], 27: [93, 100, 1902], 28: [89, 91, 1866], 29: [86, 91, 1803],
  30: [83, 84, 1766], 31: [81, 84, 1688], 32: [78, 84, 1655], 33: [76, 77, 1585], 34: [74, 77, 1532], 35: [71, 72, 1532], 36: [69, 72, 1494],
  37: [68, 72, 1425], 38: [66, 67, 1393], 39: [64, 67, 1370], 40: [63, 67, 1317], 41: [61, 63, 1306], 42: [60, 63, 1261], 43: [58, 59, 1248],
  44: [57, 59, 1210], 45: [56, 59, 1175], 46: [54, 56, 1175], 47: [53, 56, 1153], 48: [52, 53, 1126], 49: [51, 53, 1102], 50: [50, 53, 1072],
};

/** 率の表示（例：250 → "0.250"、7909 → "0.07909"） */
export function formatRate(value, digits = 3) {
  return (value / 10 ** digits).toFixed(digits);
}

/**
 * 資産の種類。intangible：無形（定額法のみ・残存1円なし）
 * decliningUntil：この日より前に取得したものだけ定率法を選べる（建物附属設備・構築物は平成28年4月1日以後は定額法のみ、
 * 建物は平成10年4月1日以後は定額法のみ。出典 No.2100）
 */
export const ASSET_CATEGORIES = [
  { id: 'building', label: '建物', intangible: false, decliningUntil: '1998-04-01' },
  { id: 'building_equipment', label: '建物附属設備', intangible: false, decliningUntil: '2016-04-01' },
  { id: 'structure', label: '構築物', intangible: false, decliningUntil: '2016-04-01' },
  { id: 'machinery', label: '機械装置', intangible: false, decliningUntil: null },
  { id: 'vehicle', label: '車両運搬具', intangible: false, decliningUntil: null },
  { id: 'tools', label: '工具器具備品', intangible: false, decliningUntil: null },
  { id: 'intangible', label: 'ソフトウェアなど（無形）', intangible: true, decliningUntil: '0000-01-01' },
];
/** 種類ごとの初期値の科目（テンプレートのコード。科目名では判定しない） */
export const CATEGORY_ACCOUNT_CODES = {
  individual: { building: '200', building_equipment: '201', machinery: '202', vehicle: '203', tools: '204', intangible: '220' },
  corporation: { building: '200', building_equipment: '201', structure: '202', machinery: '203', vehicle: '204', tools: '205', intangible: '220' },
};

/** 種類に合う初期値の科目 id（テンプレートの科目が無効・変更済みなら候補の先頭） */
export function defaultAssetAccount(entityType, categoryId, candidates) {
  const code = CATEGORY_ACCOUNT_CODES[entityType]?.[categoryId];
  return (candidates.find((a) => a.template && a.code === code && a.active) || candidates[0])?.id || '';
}
export const CATEGORY_BY_ID = Object.fromEntries(ASSET_CATEGORIES.map((c) => [c.id, c]));

/** 償却の方法 */
export const METHODS = [
  { id: 'straight', label: '定額法', short: '定額法' },
  { id: 'declining', label: '定率法', short: '定率法' },
  { id: 'lump3', label: '一括償却資産（3年で均等に償却）', short: '一括償却' },
  { id: 'small', label: '少額減価償却資産（10万円未満・全額を経費）', short: '少額' },
  { id: 'sme', label: '少額減価償却資産の特例（中小企業者等・全額を経費）', short: '少額特例' },
];
export const METHOD_BY_ID = Object.fromEntries(METHODS.map((m) => [m.id, m]));

/** 定額法・定率法で計算する方法か（耐用年数を使う） */
export function usesLife(method) {
  return method === 'straight' || method === 'declining';
}

/** 定額法・定率法の対象日（平成19年3月31日以前取得・4月1日以後に事業供用したものは供用日に取得したとみなす。出典 No.5410）。前は旧定額法・旧定率法 */
export const NEW_METHOD_FROM = '2007-04-01';
/** 200%定率法の対象（平成24年4月1日以後取得）。平成19年4月1日〜平成24年3月31日の取得は250%定率法 */
export const DECLINING_200_FROM = '2012-04-01';

/**
 * 償却の方法の細かい区分（取得日で決まる）
 * old_straight：旧定額法、old_declining：旧定率法、straight：定額法、declining250・declining200：定率法
 * それ以外の方法（一括償却・少額）は method をそのまま返す
 */
export function methodVariant(asset) {
  if (asset.method === 'straight') return asset.startedOn < NEW_METHOD_FROM ? 'old_straight' : 'straight';
  if (asset.method === 'declining') {
    if (asset.startedOn < NEW_METHOD_FROM) return 'old_declining';
    // 平成19年3月31日以前に取得し、4月1日以後に使い始めたものは、使い始めた日に取得したとみなす
    const acquired = asset.acquiredOn < NEW_METHOD_FROM ? asset.startedOn : asset.acquiredOn;
    return acquired < DECLINING_200_FROM ? 'declining250' : 'declining200';
  }
  return asset.method;
}

const VARIANT_LABELS = { old_straight: '旧定額法', old_declining: '旧定率法', straight: '定額法', declining250: '定率法', declining200: '定率法' };

/** 償却方法の表示（旧定額法・旧定率法・定額法・定率法、一括償却など） */
export function methodLabel(asset) {
  return VARIANT_LABELS[methodVariant(asset)] ?? METHOD_BY_ID[asset.method]?.short ?? '';
}

/**
 * 償却率（表示・計算用）
 * @returns {{ rate: number, revised: number, guarantee: number }|null} rate・revised は1/1000、guarantee は1/100000
 */
export function ratesFor(asset) {
  const v = methodVariant(asset);
  const life = asset.usefulLife;
  if (v === 'old_straight' || v === 'old_declining') {
    const r = OLD_RATE_TABLE[life];
    return r ? { rate: v === 'old_straight' ? r[0] : r[1], revised: 0, guarantee: 0 } : null;
  }
  if (v === 'straight') return RATE_TABLE[life] ? { rate: RATE_TABLE[life][0], revised: 0, guarantee: 0 } : null;
  if (v === 'declining250') {
    const r = DECLINING_250_TABLE[life];
    return r ? { rate: r[0], revised: r[1], guarantee: r[2] } : null;
  }
  if (v === 'declining200') {
    const r = RATE_TABLE[life];
    return r ? { rate: r[1], revised: r[2], guarantee: r[3] } : null;
  }
  return null;
}

/** 特別償却の率の範囲（%）。100 は即時償却（取得価額−普通償却費） */
export const SPECIAL_RATE_MAX = 100;
/** 少額減価償却資産の特例の期間と上限（出典 No.5408・No.2100：令和8年4月1日以後の取得は40万円未満） */
export const SME_FROM = '2006-04-01';
export const SME_UNTIL = '2029-03-31';
export const SME_LIMIT_RAISED_FROM = '2026-04-01';
export const SME_ANNUAL_LIMIT = 3000000;

/** 少額特例の取得価額の上限（この額未満） */
export function smeLimit(acquiredOn) {
  return acquiredOn >= SME_LIMIT_RAISED_FROM ? 400000 : 300000;
}

/**
 * 月数（暦に従って数え、1か月に満たない端数は1か月とする。所得税法施行令132条・法人税法施行令59条）
 * from〜to（両端を含む）。例：2026-04-10〜2027-03-31 → 12
 */
export function monthsBetween(from, to) {
  if (to < from) return 0;
  let n = 1;
  while (addMonths(from, n) <= to) n += 1;
  return n;
}

/** 会計期間の月数 */
export function periodMonths(range) {
  return Math.min(12, monthsBetween(range.startDate, range.endDate));
}

/** 償却費の科目にできる区分 */
export const EXPENSE_GROUPS = ['sga', 'mfg_overhead'];

/**
 * 資産の検証
 * @param {object} asset
 * @param {{ entityType: string, accounts: Array }} ctx
 * @returns {Object<string,string>} 項目ごとのエラー（空ならOK）
 */
export function validateAsset(asset, { entityType, accounts }) {
  const e = {};
  const name = String(asset.name ?? '').trim();
  if (!name) e.name = '資産の名前を入力してください';
  else if (name.length > 40) e.name = '名前は40文字以内にしてください';
  const cat = CATEGORY_BY_ID[asset.category];
  if (!cat) e.category = '種類を選んでください';
  const acc = accounts.find((a) => a.id === asset.accountId);
  if (!acc) e.accountId = '勘定科目を選んでください';
  else if (cat && acc.group !== (cat.intangible ? 'intangible_fixed_assets' : 'tangible_fixed_assets')) {
    e.accountId = cat.intangible ? '無形固定資産の科目を選んでください' : '有形固定資産の科目を選んでください';
  } else if (acc.normalSide !== 'debit') e.accountId = '資産の科目を選んでください';
  if (!isValidDate(asset.acquiredOn)) e.acquiredOn = '取得日を入力してください';
  if (!isValidDate(asset.startedOn)) e.startedOn = '事業に使い始めた日を入力してください';
  else if (isValidDate(asset.acquiredOn) && asset.startedOn < asset.acquiredOn) e.startedOn = '使い始めた日は取得日以後にしてください';
  if (!isYen(asset.cost) || asset.cost < 1 || asset.cost >= 1e12) e.cost = '取得価額は1円以上の整数で入力してください';
  const m = METHOD_BY_ID[asset.method];
  if (!m) e.method = '償却の方法を選んでください';
  const cost = isYen(asset.cost) ? asset.cost : 0;
  if (m && !e.startedOn && !e.acquiredOn) {
    if (usesLife(asset.method)) {
      if (!Number.isInteger(asset.usefulLife) || asset.usefulLife < MIN_LIFE || asset.usefulLife > MAX_LIFE) e.usefulLife = `耐用年数は${MIN_LIFE}〜${MAX_LIFE}年で入力してください`;
    }
    if (asset.method === 'declining' && cat) {
      if (cat.intangible) e.method = '無形固定資産は定額法で償却します';
      else if (cat.decliningUntil && asset.acquiredOn >= cat.decliningUntil) e.method = `${cat.label}は定額法で償却します（${cat.decliningUntil.slice(0, 4)}年${Number(cat.decliningUntil.slice(5, 7))}月以後の取得）`;
    }
    if (asset.method === 'lump3' && cost >= 200000) e.method = '一括償却資産は取得価額20万円未満のものだけです';
    if (asset.method === 'small' && cost >= 100000) e.method = '少額減価償却資産（全額を経費）は取得価額10万円未満のものだけです';
    if (asset.method === 'sme') {
      const limit = smeLimit(asset.acquiredOn);
      if (asset.acquiredOn < SME_FROM || asset.acquiredOn > SME_UNTIL) e.method = '特例の対象期間（平成18年4月1日〜令和11年3月31日の取得）外です';
      else if (cost >= limit) e.method = `特例は取得価額${limit / 10000}万円未満のものだけです`;
    }
  }
  // 償却費の科目（任意。空なら「減価償却費」。製造業の工場の機械などは製造経費の科目にする）
  if (asset.expenseAccountId) {
    const ex = accounts.find((a) => a.id === asset.expenseAccountId);
    if (!ex || !EXPENSE_GROUPS.includes(ex.group) || ex.normalSide !== 'debit') e.expenseAccountId = '償却費の科目は販売費及び一般管理費か製造経費の科目を選んでください';
  }
  if (entityType === 'individual') {
    if (!Number.isInteger(asset.businessRatio) || asset.businessRatio < 1 || asset.businessRatio > 100) e.businessRatio = '事業で使う割合は1〜100%で入力してください';
  }
  if (asset.disposedOn) {
    if (!isValidDate(asset.disposedOn)) e.disposedOn = '日付が正しくありません';
    else if (isValidDate(asset.startedOn) && asset.disposedOn < asset.startedOn) e.disposedOn = '使い始めた日より前にはできません';
  }
  if (asset.carryOn != null || asset.carryBook != null || asset.carryRevisedBase != null) {
    const floorYen = cat?.intangible ? 0 : 1;
    if (!usesLife(asset.method)) e.carryBook = '帳簿価額の引き継ぎは定額法・定率法の資産だけです';
    else if (!isValidDate(asset.carryOn)) e.carryBook = '引き継ぐ日付が正しくありません';
    else if (isValidDate(asset.startedOn) && asset.carryOn <= asset.startedOn) e.carryBook = '使い始めた日より後の期首の帳簿価額を入力してください（使い始めた年からアプリを使うなら空欄）';
    else if (asset.disposedOn && asset.carryOn > asset.disposedOn) e.carryBook = '除却・売却した日より後の引き継ぎはできません';
    else if (!isYen(asset.carryBook) || asset.carryBook < floorYen || asset.carryBook > cost) e.carryBook = `帳簿価額は${floorYen}円以上・取得価額以下の整数で入力してください`;
    if (asset.carryRevisedBase != null) {
      if (asset.method !== 'declining') e.carryRevisedBase = '改定取得価額は定率法の資産だけです';
      else if (!isYen(asset.carryRevisedBase) || asset.carryRevisedBase < 1 || asset.carryRevisedBase > cost) e.carryRevisedBase = '改定取得価額は1円以上・取得価額以下の整数で入力してください';
    }
  }
  // 資本的支出（parentId：元の資産）・一部の売却・除却（splitFrom：分けた元の資産、splits：分けた記録）。v0.37.0 で追加
  if (asset.parentId != null && (typeof asset.parentId !== 'string' || !asset.parentId || asset.parentId === asset.id)) e.parentId = '元の資産が正しくありません';
  if (asset.splitFrom != null && (typeof asset.splitFrom !== 'string' || !asset.splitFrom || asset.splitFrom === asset.id)) e.splitFrom = '分けた元の資産が正しくありません';
  if (asset.splits != null) {
    if (!Array.isArray(asset.splits) || asset.splits.some((sp) => !sp || typeof sp.id !== 'string' || !isValidDate(sp.date) || !isValidDate(sp.periodStart) || sp.periodStart > sp.date || !isYen(sp.cost) || sp.cost < 1 || !(sp.quantity == null || (Number.isInteger(sp.quantity) && sp.quantity >= 1)))) e.splits = '一部の売却・除却の記録が正しくありません';
    else if (asset.splits.length && !usesLife(asset.method)) e.splits = '一部の売却・除却は定額法・定率法の資産だけです';
    else if (isValidDate(asset.startedOn) && asset.splits.some((sp) => sp.date < asset.startedOn)) e.splits = '一部の売却・除却の日は使い始めた日以後にしてください';
    else if (hasCarryOver(asset) && asset.splits.some((sp) => sp.periodStart < asset.carryOn)) e.splits = '一部の売却・除却は、前の帳簿から引き継いだ日以後にしてください';
  }
  // 特別償却（v0.36.0 で追加。任意）：事業供用年度に 取得価額×率
  if (asset.specialRate != null) {
    if (!Number.isInteger(asset.specialRate) || asset.specialRate < 1 || asset.specialRate > SPECIAL_RATE_MAX) e.specialRate = `特別償却の率は1〜${SPECIAL_RATE_MAX}%の整数で入力してください（即時償却は100）`;
    else if (!usesLife(asset.method)) e.specialRate = '特別償却は定額法・定率法の資産だけです';
    else if (isValidDate(asset.startedOn) && asset.startedOn < NEW_METHOD_FROM) e.specialRate = '平成19年3月31日以前に使い始めた資産には特別償却を入れられません';
    else if (asset.carryOn != null && asset.carryBook != null) e.specialRate = '前の帳簿から引き継ぐ資産の特別償却は、前の帳簿で済んでいます（空欄にしてください）';
    else if (!String(asset.specialName ?? '').trim()) e.specialName = '特別償却の制度の名前を入力してください（例：中小企業投資促進税制）';
  }
  if (String(asset.specialName ?? '').length > 40) e.specialName = '制度の名前は40文字以内にしてください';
  if (asset.specialName && asset.specialRate == null) e.specialRate = '特別償却の率を入力してください';
  if (String(asset.memo ?? '').length > 100) e.memo = 'メモは100文字以内にしてください';
  // v0.14.0 で追加した項目（古いデータには無い）
  if (String(asset.assetNo ?? '').length > 20) e.assetNo = '資産番号は20文字以内にしてください';
  if (asset.quantity != null && (!Number.isInteger(asset.quantity) || asset.quantity < 1 || asset.quantity > 99999)) e.quantity = '数量は1〜99999の整数で入力してください';
  if (String(asset.location ?? '').length > 40) e.location = '設置場所は40文字以内にしてください';
  // v0.38.0 で追加した耐用年数表の区分（任意。別表十六・少額減価償却資産の明細書の「構造又は用途」「細目」）
  if (asset.structure != null && (typeof asset.structure !== 'string' || asset.structure.length > 60)) e.structure = '構造又は用途は60文字以内にしてください';
  if (asset.detail != null && (typeof asset.detail !== 'string' || asset.detail.length > 60)) e.detail = '細目は60文字以内にしてください';
  if (asset.disposalType != null) {
    if (!['sell', 'retire'].includes(asset.disposalType)) e.disposedOn = '売却か除却かが正しくありません';
    else if (!asset.disposedOn) e.disposedOn = '売却・除却した日を入力してください';
    if (asset.disposalType === 'sell' && (!isYen(asset.salePrice) || asset.salePrice < 0)) e.disposedOn = '売却額は0円以上の整数にしてください';
  }
  if (asset.salePrice != null && asset.disposalType !== 'sell') e.disposedOn = '売却額は売却した資産だけに入れます';
  // v0.23.0 で追加した償却資産申告書の項目（任意。js/property-tax.js）
  if (asset.ptInclude != null && !['yes', 'no'].includes(asset.ptInclude)) e.ptInclude = '申告の対象かどうかが正しくありません';
  if (asset.ptKind != null && !(Number.isInteger(asset.ptKind) && asset.ptKind >= 1 && asset.ptKind <= 6)) e.ptKind = '償却資産の種類を選んでください';
  if (asset.ptLife != null && !(Number.isInteger(asset.ptLife) && asset.ptLife >= MIN_LIFE && asset.ptLife <= MAX_LIFE)) e.ptLife = `耐用年数は${MIN_LIFE}〜${MAX_LIFE}年で入力してください`;
  return e;
}

/** 前の会計ソフトの帳簿価額を引き継いでいるか（定額法・定率法で、日付と金額があるとき） */
export function hasCarryOver(asset) {
  return usesLife(asset.method) && isValidDate(asset.carryOn) && isYen(asset.carryBook);
}

/**
 * 償却の計算に使う期間の並び。登録済みの会計期間をそのまま使い、その前後は12か月ずつの期間を補う
 * （アプリを使う前の年分・まだ作っていない先の年分の計算用）
 */
function* ranges(periods, startedOn) {
  const sorted = [...periods].sort((a, b) => (a.startDate < b.startDate ? -1 : 1));
  if (!sorted.length) return;
  // 使い始めた日を含む期間の開始日まで、先頭から12か月ずつさかのぼる
  let start = sorted[0].startDate;
  const before = [];
  while (start > startedOn) {
    const s = addMonths(start, -12);
    before.unshift({ startDate: s, endDate: addDays(start, -1), periodId: null });
    start = s;
  }
  yield* before;
  for (const p of sorted) yield { startDate: p.startDate, endDate: p.endDate, periodId: p.id };
  let next = addDays(sorted[sorted.length - 1].endDate, 1);
  for (;;) {
    const end = addDays(addMonths(next, 12), -1);
    yield { startDate: next, endDate: end, periodId: null };
    next = addDays(end, 1);
  }
}

/**
 * 減価償却の年ごとの明細
 * @param {object} asset
 * @param {Array} periods 会計期間（startDate・endDate・id）。1件以上
 * @returns {Array<{ startDate, endDate, periodId, months, base, rate, opening, ordinary, special, amount, business, private, closing, switched?, equal? }>}
 *   base：償却の基礎になる金額、rate：使った率（1/1000。一括償却・少額・均等償却は null）
 *   ordinary：普通償却費、special：特別償却費（事業供用年度だけ）、amount：その期間の償却費（合計）
 *   business：経費になる額（事業で使う割合）、private：私用分
 *   switched：定率法で改定償却率に切り替えた、equal：旧定額法・旧定率法の95%到達後の均等償却
 *   splits：この期間の期首に一部の売却・除却で分けた分 [{ id, cost, book, revisedBase }]（opening は分けたあとの帳簿価額）
 *   償却が終わる（残り1円・無形は0円）か、除却・売却した期間までを返す
 */
export function depreciationSchedule(asset, periods) {
  const out = [];
  const cat = CATEGORY_BY_ID[asset.category];
  const floor = cat?.intangible || !usesLife(asset.method) ? 0 : 1; // 有形の定額法・定率法は1円（備忘価額）を残す
  const ratio = Number.isInteger(asset.businessRatio) ? asset.businessRatio : 100;
  const variant = methodVariant(asset);
  const { rate: baseRate, revised, guarantee } = ratesFor(asset) || { rate: 0, revised: 0, guarantee: 0 };
  const old = variant === 'old_straight' || variant === 'old_declining';
  // 一部を売却・除却した資産：asset.cost は今の取得価額。分けた期間より前は、分けた分を足した取得価額で計算する
  const splits = [...(asset.splits || [])].sort((a, b) => (a.periodStart < b.periodStart ? -1 : 1));
  let cost = asset.cost + splits.reduce((sum, sp) => sum + sp.cost, 0);
  let nextSplit = 0;
  let book = cost;
  let usedMonths = 0; // 一括償却の経過月数
  let revisedBase = null; // 定率法の改定取得価額
  const carry = hasCarryOver(asset);
  const special = !carry && Number.isInteger(asset.specialRate) && usesLife(asset.method) && !old ? asset.specialRate : 0;
  for (const r of ranges(periods, asset.startedOn)) {
    if (r.endDate < asset.startedOn) continue;
    // 前の会計ソフトの帳簿価額を引き継ぐ：引き継いだ日より前の期間は出さず、その日の帳簿価額から計算を続ける。
    // 定率法で切り替え済みなら、前の帳簿の改定取得価額を使う（無ければ、引き継いだ年に保証額を下回ればその年の期首帳簿価額）
    if (carry && r.startDate < asset.carryOn) continue;
    if (carry && r.startDate >= asset.carryOn && !out.length) {
      book = asset.carryBook;
      if (asset.method === 'declining' && isYen(asset.carryRevisedBase)) revisedBase = asset.carryRevisedBase;
    }
    // 一部の売却・除却：その期間の期首に、取得価額・帳簿価額・改定取得価額を分けた割合で減らす（分けた分は別の資産として償却・処理する）
    const removed = [];
    while (nextSplit < splits.length && splits[nextSplit].periodStart <= r.startDate) {
      const sp = splits[nextSplit++];
      const part = { id: sp.id, cost: sp.cost, book: Math.floor((book * sp.cost) / cost), revisedBase: revisedBase === null ? null : Math.floor((revisedBase * sp.cost) / cost) };
      book -= part.book;
      if (revisedBase !== null) revisedBase -= part.revisedBase;
      cost -= sp.cost;
      removed.push(part);
    }
    // 旧定額法・旧定率法の有形：償却費の累積額が取得価額の95%に達したときの帳簿価額（＝取得価額×5%）と、その後の5年間の均等償却
    // 別表十六（一）「18」・（二）「19」の 差引取得価額×5%（1円未満切捨て）
    const tail = old && !cat?.intangible ? Math.floor((cost * 5) / 100) : 0;
    if (book <= floor || out.length >= 200) break;
    if (asset.method !== 'lump3' && asset.disposedOn && r.startDate > asset.disposedOn) break;
    const from = r.startDate > asset.startedOn ? r.startDate : asset.startedOn;
    const to = asset.method !== 'lump3' && asset.disposedOn && asset.disposedOn < r.endDate ? asset.disposedOn : r.endDate;
    const months = Math.min(periodMonths(r), monthsBetween(from, to));
    let amount = 0;
    let switched = false;
    let equal = false;
    let base = cost; // 償却の基礎になる金額（青色申告決算書の「償却の基礎になる金額」）
    let rate = null; // 使った率（1/1000。一括償却・少額・均等償却は null）
    let limit = book - floor; // この期間に償却できる上限
    if (asset.method === 'small' || asset.method === 'sme') {
      amount = book;
    } else if (asset.method === 'lump3') {
      // 一括償却資産：取得価額 × 期間の月数 / 36（月の途中から使っても期間の月数で計算する）
      const pm = periodMonths(r);
      usedMonths += pm;
      amount = usedMonths >= 36 ? book : Math.floor((cost * pm) / 36);
    } else if (old && tail && book <= tail) {
      // 95%に達した翌年から5年間の均等償却：{(取得価額×5%−1円)÷5}×月数/12。5年で1円になるよう1円未満は切り上げる（No.2105 の計算例）
      equal = true;
      base = tail;
      amount = Math.ceil(((tail - 1) * months) / 60);
    } else if (variant === 'old_straight') {
      // 旧定額法：(取得価額−残存価額（有形は10%）)×償却率。累積額は取得価額の95%まで
      base = cat?.intangible ? cost : Math.floor((cost * 9) / 10);
      const annual = cat?.intangible ? Math.floor((cost * baseRate) / 1000) : Math.floor((cost * 9 * baseRate) / 10000);
      amount = Math.floor((annual * months) / 12);
      rate = baseRate;
      if (tail) limit = book - tail;
    } else if (variant === 'old_declining') {
      // 旧定率法：期首帳簿価額×償却率。累積額は取得価額の95%まで
      base = book;
      amount = Math.floor((Math.floor((book * baseRate) / 1000) * months) / 12);
      rate = baseRate;
      limit = book - tail;
    } else if (variant === 'straight') {
      const annual = Math.floor((cost * baseRate) / 1000);
      amount = Math.floor((annual * months) / 12);
      rate = baseRate;
    } else if (variant === 'declining250' || variant === 'declining200') {
      // 調整前償却額が償却保証額（取得価額×保証率）に満たない年から、改定取得価額×改定償却率に切り替える
      if (revisedBase === null && guarantee && book * baseRate * 100 < cost * guarantee) revisedBase = book;
      switched = revisedBase !== null;
      const annual = switched ? Math.floor((revisedBase * revised) / 1000) : Math.floor((book * baseRate) / 1000);
      amount = Math.floor((annual * months) / 12);
      base = switched ? revisedBase : book;
      rate = switched ? revised : baseRate;
    }
    const ordinary = Math.max(0, Math.min(amount, limit));
    // 特別償却：使い始めた日を含む期間に 取得価額×率（月数按分しない）。即時償却（100%）は 取得価額−普通償却費
    const first = r.startDate <= asset.startedOn && asset.startedOn <= r.endDate;
    const extra = special && first ? Math.max(0, Math.min(Math.floor((cost * special) / 100), book - floor - ordinary)) : 0;
    amount = ordinary + extra;
    const business = Math.floor((amount * ratio) / 100);
    out.push({
      startDate: r.startDate,
      endDate: r.endDate,
      periodId: r.periodId,
      months,
      base,
      rate,
      opening: book,
      ordinary,
      special: extra,
      amount,
      business,
      private: amount - business,
      closing: book - amount,
      ...(switched ? { switched: true } : {}),
      ...(equal ? { equal: true } : {}),
      ...(removed.length ? { splits: removed } : {}),
    });
    book -= amount;
    if (asset.method !== 'lump3' && asset.disposedOn && asset.disposedOn <= r.endDate) break;
  }
  return out;
}

/** 指定した会計期間の償却（なければ null） */
export function depreciationFor(asset, periods, period) {
  return depreciationSchedule(asset, periods).find((r) => r.startDate === period.startDate && r.endDate === period.endDate) || null;
}

/** 期首の帳簿価額（その期間より前の償却を引いた額。期間より後に使い始めた資産は null） */
export function openingBook(asset, periods, period) {
  if (asset.startedOn > period.endDate) return null;
  const row = depreciationFor(asset, periods, period);
  if (row) return row.opening;
  const prev = depreciationSchedule(asset, periods).filter((r) => r.endDate < period.startDate);
  if (prev.length) return prev[prev.length - 1].closing;
  // 引き継いだ帳簿価額が備忘価額（1円）だけのときは償却の行が無いので、引き継いだ額をそのまま使う
  if (hasCarryOver(asset) && period.startDate >= asset.carryOn) return asset.carryBook;
  return costAt(asset, period);
}

/** その会計期間の取得価額（一部を売却・除却した資産は、分けた期間より前なら分けた分を足す） */
export function costAt(asset, period) {
  return asset.cost + (asset.splits || []).filter((sp) => sp.periodStart > period.startDate).reduce((sum, sp) => sum + sp.cost, 0);
}

/** 一部の売却・除却で分けた資産（splitFrom）で、分けた期間より前の期間か（その期間は元の資産に含まれている） */
function beforeSplit(asset, period) {
  return Boolean(asset.splitFrom) && hasCarryOver(asset) && period.startDate < asset.carryOn;
}

/**
 * 会計期間の固定資産台帳（期首に使っていた資産と、期中に使い始めた資産）
 * @returns {Array<{ asset, cost, opening, row, closing }>} cost：その期間の取得価額、row：その期間の償却（なければ null）
 */
export function assetRegister(assets, periods, period) {
  return assets
    .filter((a) => a.startedOn <= period.endDate)
    .filter((a) => !a.disposedOn || a.disposedOn >= period.startDate || a.method === 'lump3')
    .filter((a) => !beforeSplit(a, period))
    .map((asset) => {
      const row = depreciationFor(asset, periods, period);
      const opening = row ? row.opening : openingBook(asset, periods, period);
      return { asset, cost: costAt(asset, period), opening, row, closing: row ? row.closing : opening };
    })
    .filter((x) => x.row || x.opening > 0)
    .sort((a, b) => (a.asset.startedOn < b.asset.startedOn ? -1 : a.asset.startedOn > b.asset.startedOn ? 1 : String(a.asset.name).localeCompare(String(b.asset.name), 'ja')));
}

/** 期間に適用した少額特例の取得価額の合計と上限（年300万円。1年未満の期間は月数で按分） */
export function smeUsage(assets, period) {
  const total = assets.filter((a) => a.method === 'sme' && a.startedOn >= period.startDate && a.startedOn <= period.endDate).reduce((s, a) => s + a.cost, 0);
  const limit = Math.floor((SME_ANNUAL_LIMIT * periodMonths(period)) / 12);
  return { total, limit, over: total > limit };
}

/**
 * 減価償却の決算整理仕訳の明細
 *   減価償却費（事業分）・事業主貸（個人の私用分） / 資産の科目（直接法）または減価償却累計額（法人の有形固定資産で、累計額の科目があるとき）
 * @returns {{ lines: Array, total: number, errors: string[] }}
 */
export function depreciationLines({ assets, periods, period, accounts, entityType }) {
  const errors = [];
  const expense = accounts.find((a) => a.hint === 'depreciation' && a.active);
  const drawings = accounts.find((a) => a.role === 'owner_drawings');
  const accumulated = entityType === 'corporation' ? accounts.find((a) => a.hint === 'accumulated_depreciation' && a.active) : null;
  const needDefault = assetRegister(assets, periods, period).some(({ asset, row }) => row?.business && !asset.expenseAccountId);
  if (!expense && needDefault) errors.push('減価償却費の科目が見つかりません（勘定科目の画面で確認してください）');
  const lines = [];
  let total = 0;
  const line = (side, accountId, amount, memo) => ({ side, accountId, subAccountId: null, amount, taxCategory: 'none', memo });
  for (const { asset, row } of assetRegister(assets, periods, period)) {
    if (!row || !row.amount) continue;
    const memo = `減価償却 ${asset.name}`.slice(0, 100);
    const own = asset.expenseAccountId ? accounts.find((a) => a.id === asset.expenseAccountId && a.active) : null;
    if (asset.expenseAccountId && !own) errors.push(`「${asset.name}」の償却費の科目が見つかりません（無効にした場合は固定資産の画面で選び直してください）`);
    const debit = own || expense;
    if (debit && row.business) lines.push(line('debit', debit.id, row.business, memo));
    if (row.private) {
      if (drawings) lines.push(line('debit', drawings.id, row.private, `${memo}（私用分）`.slice(0, 100)));
      else errors.push('事業主貸の科目が見つかりません');
    }
    const intangible = CATEGORY_BY_ID[asset.category]?.intangible;
    const credit = accumulated && !intangible && usesLife(asset.method) ? accumulated.id : asset.accountId;
    lines.push(line('credit', credit, row.amount, memo));
    total += row.amount;
  }
  return { lines, total, errors };
}

/** この期間に登録した減価償却の仕訳 */
export function findDepreciationJournals(journals) {
  return journals.filter((j) => j.source === 'depreciation');
}
