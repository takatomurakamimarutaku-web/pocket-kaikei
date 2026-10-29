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
    memo: '',
    ...stamp(now),
    ...fields,
  };
}
