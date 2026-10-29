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
//   https://www.nta.go.jp/taxes/shiraberu/shinkoku/tebiki/2025/pdf/037.pdf （耐用年数省令 別表第八・第十）
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

/** 定額法・定率法の対象日（平成19年3月31日以前取得・4月1日以後に事業供用したものは供用日に取得したとみなす。出典 No.5410） */
export const NEW_METHOD_FROM = '2007-04-01';
/** 200%定率法の対象（平成24年4月1日以後取得）。それより前の250%定率法には対応しない */
export const DECLINING_200_FROM = '2012-04-01';
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
      if (asset.startedOn < NEW_METHOD_FROM) e.method = '平成19年3月31日以前に使い始めた資産（旧定額法・旧定率法）には対応していません';
      if (!Number.isInteger(asset.usefulLife) || asset.usefulLife < MIN_LIFE || asset.usefulLife > MAX_LIFE) e.usefulLife = `耐用年数は${MIN_LIFE}〜${MAX_LIFE}年で入力してください`;
    }
    if (asset.method === 'declining' && cat) {
      if (cat.intangible) e.method = '無形固定資産は定額法で償却します';
      else if (cat.decliningUntil && asset.acquiredOn >= cat.decliningUntil) e.method = `${cat.label}は定額法で償却します（${cat.decliningUntil.slice(0, 4)}年${Number(cat.decliningUntil.slice(5, 7))}月以後の取得）`;
      else if (asset.acquiredOn < DECLINING_200_FROM) e.method = '平成24年3月31日以前に取得した資産の定率法（250%定率法）には対応していません';
    }
    if (asset.method === 'lump3' && cost >= 200000) e.method = '一括償却資産は取得価額20万円未満のものだけです';
    if (asset.method === 'small' && cost >= 100000) e.method = '少額減価償却資産（全額を経費）は取得価額10万円未満のものだけです';
    if (asset.method === 'sme') {
      const limit = smeLimit(asset.acquiredOn);
      if (asset.acquiredOn < SME_FROM || asset.acquiredOn > SME_UNTIL) e.method = '特例の対象期間（平成18年4月1日〜令和11年3月31日の取得）外です';
      else if (cost >= limit) e.method = `特例は取得価額${limit / 10000}万円未満のものだけです`;
    }
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
  if (String(asset.memo ?? '').length > 100) e.memo = 'メモは100文字以内にしてください';
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
 * @returns {Array<{ startDate, endDate, periodId, months, base, rate, opening, amount, business, private, closing, switched? }>}
 *   base：償却の基礎になる金額、rate：使った率（1/1000。一括償却・少額は null）
 *   amount：その期間の償却費（全体）、business：経費になる額（事業で使う割合）、private：私用分
 *   償却が終わる（残り1円・無形は0円）か、除却・売却した期間までを返す
 */
export function depreciationSchedule(asset, periods) {
  const out = [];
  const cat = CATEGORY_BY_ID[asset.category];
  const floor = cat?.intangible || !usesLife(asset.method) ? 0 : 1; // 有形の定額法・定率法は1円（備忘価額）を残す
  const ratio = Number.isInteger(asset.businessRatio) ? asset.businessRatio : 100;
  const [straight, declining, revised, guarantee] = RATE_TABLE[asset.usefulLife] || [0, 0, 0, 0];
  let book = asset.cost;
  let usedMonths = 0; // 一括償却の経過月数
  let revisedBase = null; // 定率法の改定取得価額
  const carry = hasCarryOver(asset);
  for (const r of ranges(periods, asset.startedOn)) {
    if (r.endDate < asset.startedOn) continue;
    // 前の会計ソフトの帳簿価額を引き継ぐ：引き継いだ日より前の期間は出さず、その日の帳簿価額から計算を続ける。
    // 定率法で切り替え済みなら、前の帳簿の改定取得価額を使う（無ければ、引き継いだ年に保証額を下回ればその年の期首帳簿価額）
    if (carry && r.startDate < asset.carryOn) continue;
    if (carry && r.startDate >= asset.carryOn && !out.length) {
      book = asset.carryBook;
      if (asset.method === 'declining' && isYen(asset.carryRevisedBase)) revisedBase = asset.carryRevisedBase;
    }
    if (book <= floor || out.length >= 200) break;
    if (asset.method !== 'lump3' && asset.disposedOn && r.startDate > asset.disposedOn) break;
    const from = r.startDate > asset.startedOn ? r.startDate : asset.startedOn;
    const to = asset.method !== 'lump3' && asset.disposedOn && asset.disposedOn < r.endDate ? asset.disposedOn : r.endDate;
    const months = Math.min(periodMonths(r), monthsBetween(from, to));
    let amount = 0;
    let switched = false;
    let base = asset.cost; // 償却の基礎になる金額（青色申告決算書の「償却の基礎になる金額」）
    let rate = null; // 使った率（1/1000。一括償却・少額は null）
    if (asset.method === 'small' || asset.method === 'sme') {
      amount = book;
    } else if (asset.method === 'lump3') {
      // 一括償却資産：取得価額 × 期間の月数 / 36（月の途中から使っても期間の月数で計算する）
      const pm = periodMonths(r);
      usedMonths += pm;
      amount = usedMonths >= 36 ? book : Math.floor((asset.cost * pm) / 36);
    } else if (asset.method === 'straight') {
      const annual = Math.floor((asset.cost * straight) / 1000);
      amount = Math.floor((annual * months) / 12);
      rate = straight;
    } else if (asset.method === 'declining') {
      // 調整前償却額が償却保証額（取得価額×保証率）に満たない年から、改定取得価額×改定償却率に切り替える
      if (revisedBase === null && guarantee && book * declining * 100 < asset.cost * guarantee) revisedBase = book;
      switched = revisedBase !== null;
      const annual = switched ? Math.floor((revisedBase * revised) / 1000) : Math.floor((book * declining) / 1000);
      amount = Math.floor((annual * months) / 12);
      base = switched ? revisedBase : book;
      rate = switched ? revised : declining;
    }
    amount = Math.max(0, Math.min(amount, book - floor));
    const business = Math.floor((amount * ratio) / 100);
    out.push({
      startDate: r.startDate,
      endDate: r.endDate,
      periodId: r.periodId,
      months,
      base,
      rate,
      opening: book,
      amount,
      business,
      private: amount - business,
      closing: book - amount,
      ...(switched ? { switched: true } : {}),
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
  return asset.cost;
}

/**
 * 会計期間の固定資産台帳（期首に使っていた資産と、期中に使い始めた資産）
 * @returns {Array<{ asset, opening, row, closing }>} row：その期間の償却（なければ null）
 */
export function assetRegister(assets, periods, period) {
  return assets
    .filter((a) => a.startedOn <= period.endDate)
    .filter((a) => !a.disposedOn || a.disposedOn >= period.startDate || a.method === 'lump3')
    .map((asset) => {
      const row = depreciationFor(asset, periods, period);
      const opening = row ? row.opening : openingBook(asset, periods, period);
      return { asset, opening, row, closing: row ? row.closing : opening };
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
  if (!expense) errors.push('減価償却費の科目が見つかりません（勘定科目の画面で確認してください）');
  const lines = [];
  let total = 0;
  const line = (side, accountId, amount, memo) => ({ side, accountId, subAccountId: null, amount, taxCategory: 'none', memo });
  for (const { asset, row } of assetRegister(assets, periods, period)) {
    if (!row || !row.amount) continue;
    const memo = `減価償却 ${asset.name}`.slice(0, 100);
    if (expense && row.business) lines.push(line('debit', expense.id, row.business, memo));
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
