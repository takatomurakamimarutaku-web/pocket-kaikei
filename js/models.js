// レコードの生成と定数（DOM に依存しない）
// 全レコードに id（UUID）・createdAt・updatedAt を持たせる（将来のクラウド同期のため）

export const ENTITY_LABELS = { individual: '個人事業主（青色申告）', corporation: '法人' };
export const TAX_STATUS_LABELS = { taxable: '課税事業者', exempt: '免税事業者' };

export function newId() {
  return crypto.randomUUID();
}

function stamp(now = new Date()) {
  const ts = now.toISOString();
  return { createdAt: ts, updatedAt: ts };
}

export function createSettings(fields = {}, now = new Date()) {
  return { businessName: '', entityType: 'individual', taxStatus: 'exempt', ...stamp(now), ...fields };
}

export function createAccount(fields = {}, now = new Date()) {
  return {
    id: newId(),
    code: '',
    name: '',
    group: 'sga',
    role: null,
    hint: null,
    normalSide: 'debit',
    defaultTaxCategory: 'none',
    active: true,
    sortOrder: 0,
    template: false,
    ...stamp(now),
    ...fields,
  };
}

export function createSubAccount(fields = {}, now = new Date()) {
  return { id: newId(), accountId: '', name: '', active: true, sortOrder: 0, ...stamp(now), ...fields };
}

export function createPeriod(fields = {}, now = new Date()) {
  return { id: newId(), startDate: '', endDate: '', openingBalances: [], ...stamp(now), ...fields };
}

export function createJournal(fields = {}, now = new Date()) {
  return { id: newId(), periodId: '', no: 0, date: '', lines: [], ...stamp(now), ...fields };
}

export function createAsset(fields = {}, now = new Date()) {
  return {
    id: newId(),
    name: '',
    category: 'tools',
    accountId: '',
    acquiredOn: '',
    startedOn: '',
    cost: 0,
    method: 'straight',
    usefulLife: null,
    businessRatio: 100,
    disposedOn: null,
    carryOn: null, // 前の会計ソフトの帳簿価額を引き継いだ日（期首）
    carryBook: null, // その日の帳簿価額
    carryRevisedBase: null, // 定率法で切り替え済みのときの改定取得価額
    assetNo: '', // 資産番号（任意）
    quantity: 1, // 数量
    location: '', // 設置場所（任意。償却資産申告などで使う）
    disposalType: null, // 売却（sell）・除却（retire）
    salePrice: null, // 売却額（税込）
    expenseAccountId: null, // 償却費の科目（null なら減価償却費。製造業の工場の資産は製造経費の科目）
    memo: '',
    ...stamp(now),
    ...fields,
  };
}

/**
 * 定型仕訳（よく使う仕訳のひな形）
 * repeatDay：毎月自動で作る日（1〜31。31は月末）。null は手で呼び出すだけ
 */
export function createTemplate(fields = {}, now = new Date()) {
  return { id: newId(), name: '', lines: [], repeatDay: null, ...stamp(now), ...fields };
}

/** 予算（会計期間・科目ごと）。months は { 'YYYY-MM': 金額 }（区分の向きの正の整数） */
export function createBudget(fields = {}, now = new Date()) {
  return { id: newId(), periodId: '', accountId: '', months: {}, ...stamp(now), ...fields };
}
