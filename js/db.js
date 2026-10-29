// IndexedDB 操作。データの読み書きは必ずこの Repository を通す（将来の同期処理を差し込む場所を1か所にするため）
import { validateRule } from './bank-import.js';
import { isCashAccount } from './quick.js';
import { validateJournal } from './journal.js';
import { DEFAULT_NOTES, validateNotes } from './financial.js';
import { validateAccount, isBsGroup, findByRole, fillHints, REQUIRED_ROLES, manufacturingAccounts } from './accounts.js';
import { validatePeriod, addDays } from './period.js';
import { computeOwnerCapital, fromNormal } from './ledger.js';
import { isYen } from './money.js';
import { newId, createAccount } from './models.js';
import { validateAsset } from './depreciation.js';
import { DEFAULT_ENTERPRISE_TAX, validateEnterpriseTax } from './enterprise-tax.js';

export const DB_NAME = 'pocket-kaikei';
export const DB_VERSION = 2;
export const DATA_STORES = ['accounts', 'subAccounts', 'periods', 'journals', 'assets', 'tombstones'];
const ALL_STORES = ['meta', ...DATA_STORES];

/** 締めた会計期間を変更しようとしたときのメッセージ */
export const CLOSED_PERIOD_MESSAGE = 'この会計期間は締めてあるため変更できません（会計期間の画面で締めを解除できます）';

export class ValidationError extends Error {
  constructor(errors) {
    const list = Array.isArray(errors) ? errors : Object.values(errors);
    super(list.join('\n'));
    this.name = 'ValidationError';
    this.errors = errors;
  }
}

/**
 * スキーマの移行。バージョンを上げるときは `if (oldVersion < N)` のブロックを追加する。
 */
// eslint-disable-next-line no-unused-vars
export function migrate(db, oldVersion, tx) {
  if (oldVersion < 1) {
    db.createObjectStore('meta', { keyPath: 'key' });
    db.createObjectStore('accounts', { keyPath: 'id' }).createIndex('code', 'code', { unique: true });
    db.createObjectStore('subAccounts', { keyPath: 'id' }).createIndex('accountId', 'accountId');
    db.createObjectStore('periods', { keyPath: 'id' }).createIndex('startDate', 'startDate');
    const journals = db.createObjectStore('journals', { keyPath: 'id' });
    journals.createIndex('periodId', 'periodId');
    journals.createIndex('date', 'date');
    db.createObjectStore('tombstones', { keyPath: 'id' }).createIndex('store', 'store');
  }
  if (oldVersion < 2) {
    // 固定資産台帳
    db.createObjectStore('assets', { keyPath: 'id' }).createIndex('accountId', 'accountId');
  }
}

function req(r) {
  return new Promise((resolve, reject) => {
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });
}

function txDone(tx) {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error || new Error('トランザクションが中断されました'));
  });
}

/** DB を開く。テストでは fake-indexeddb の IDBFactory を渡す */
export function openDB({ indexedDB = globalThis.indexedDB, name = DB_NAME } = {}) {
  return new Promise((resolve, reject) => {
    if (!indexedDB) {
      reject(new Error('この環境ではIndexedDBが使えません'));
      return;
    }
    const open = indexedDB.open(name, DB_VERSION);
    open.onupgradeneeded = (e) => migrate(open.result, e.oldVersion, open.transaction);
    open.onsuccess = () => {
      const db = open.result;
      db.onversionchange = () => db.close();
      resolve(new Repository(db));
    };
    open.onerror = () => reject(open.error);
    open.onblocked = () => reject(new Error('ほかのタブでアプリが開かれているため、データベースを更新できません'));
  });
}

function now() {
  return new Date().toISOString();
}

function tombstone(store, id) {
  const ts = now();
  return { id, store, deletedAt: ts, createdAt: ts, updatedAt: ts };
}

/** 科目が仕訳・期首残高で使われているか */
function usedAccountIds(journals, periods) {
  const accounts = new Set();
  const subs = new Set();
  for (const j of journals) {
    for (const l of j.lines) {
      accounts.add(l.accountId);
      if (l.subAccountId) subs.add(l.subAccountId);
    }
  }
  for (const p of periods) {
    for (const ob of p.openingBalances || []) {
      if (!ob.amount) continue;
      accounts.add(ob.accountId);
      if (ob.subAccountId) subs.add(ob.subAccountId);
    }
  }
  return { accounts, subs };
}

/**
 * 期首残高の検証と整形（トランザクションの中で呼ぶ）。BS 科目のみ。
 * 個人は元入金を資産合計−負債合計で計算して上書き、法人は貸借が一致しなければ ValidationError
 */
async function normalizeOpening(tx, balances) {
  const settings = (await req(tx.objectStore('meta').get('settings')))?.value;
  const accounts = await req(tx.objectStore('accounts').getAll());
  const subs = await req(tx.objectStore('subAccounts').getAll());
  const accountById = new Map(accounts.map((a) => [a.id, a]));
  const subById = new Map(subs.map((s) => [s.id, s]));
  const errors = [];
  const list = [];
  for (const b of balances) {
    const acc = accountById.get(b.accountId);
    if (!acc) {
      errors.push('存在しない勘定科目があります');
      continue;
    }
    if (!isBsGroup(acc.group)) errors.push(`「${acc.name}」は損益の科目なので期首残高を入力できません`);
    if (b.subAccountId && subById.get(b.subAccountId)?.accountId !== acc.id) errors.push(`「${acc.name}」の補助科目が正しくありません`);
    if (!isYen(b.amount)) errors.push(`「${acc.name}」の金額は整数で入力してください`);
    if (b.amount) list.push({ accountId: b.accountId, subAccountId: b.subAccountId || null, amount: b.amount });
  }
  if (errors.length) throw new ValidationError(errors);
  let result = list;
  if (settings?.entityType === 'individual') {
    const capital = findByRole(accounts, 'owner_capital');
    result = list.filter((b) => b.accountId !== capital.id);
    const amount = computeOwnerCapital(result, accounts);
    if (amount) result.push({ accountId: capital.id, subAccountId: null, amount });
  } else {
    // 法人：借方合計と貸方合計が一致しない期首残高は保存しない
    const diff = result.reduce((s, b) => s + fromNormal(b.amount, accountById.get(b.accountId)), 0);
    if (diff) throw new ValidationError([`借方と貸方の合計が一致しません（差額 ${Math.abs(diff).toLocaleString('ja-JP')}円）`]);
  }
  return result;
}

/**
 * 仕訳の保存（トランザクションの中で呼ぶ）。同じトランザクションで科目・期間を読み、貸借一致などを再検証する。
 * 新規のときは期間の通し番号を採番する（削除しても番号は詰めない）
 */
async function putJournal(tx, journal) {
  const periods = tx.objectStore('periods');
  const journals = tx.objectStore('journals');
  const period = await req(periods.get(journal.periodId));
  const original = (await req(journals.get(journal.id))) || null;
  if (period?.closed || (original && (await req(periods.get(original.periodId)))?.closed)) throw new ValidationError([CLOSED_PERIOD_MESSAGE]);
  const errors = validateJournal(journal, {
    accounts: await req(tx.objectStore('accounts').getAll()),
    subAccounts: await req(tx.objectStore('subAccounts').getAll()),
    period,
    original,
  });
  if (errors.length) throw new ValidationError(errors);
  const record = { ...journal, updatedAt: now() };
  if (original) {
    record.no = original.no;
    record.createdAt = original.createdAt;
  } else {
    record.no = period.nextJournalNo || 1;
    // 同じトランザクションで続けて保存するときのために、読み直した期間に番号を進める
    periods.put({ ...period, nextJournalNo: record.no + 1 });
  }
  journals.put(record);
  return record;
}

async function putAsset(tx, asset) {
  const settings = (await req(tx.objectStore('meta').get('settings')))?.value;
  const accounts = await req(tx.objectStore('accounts').getAll());
  const record = {
    ...asset,
    name: String(asset.name ?? '').trim(),
    memo: String(asset.memo ?? '').trim(),
    assetNo: String(asset.assetNo ?? '').trim(),
    location: String(asset.location ?? '').trim(),
    quantity: asset.quantity ?? 1,
    businessRatio: settings?.entityType === 'individual' ? asset.businessRatio : 100,
    disposedOn: asset.disposedOn || null,
    disposalType: asset.disposedOn ? (asset.disposalType ?? null) : null,
    salePrice: asset.disposedOn && asset.disposalType === 'sell' ? asset.salePrice : null,
  };
  const errors = validateAsset(record, { entityType: settings?.entityType, accounts });
  if (Object.keys(errors).length) throw new ValidationError(errors);
  const store = tx.objectStore('assets');
  const before = await req(store.get(record.id));
  const next = { ...record, createdAt: before?.createdAt ?? record.createdAt, updatedAt: now() };
  store.put(next);
  return next;
}

export class Repository {
  constructor(db) {
    this.db = db;
  }

  close() {
    this.db.close();
  }

  /** トランザクションを実行し、完了後に fn の戻り値を返す。fn が例外を投げたら中断して何も書かない */
  async run(stores, mode, fn) {
    const tx = this.db.transaction(stores, mode);
    const done = txDone(tx);
    let result;
    try {
      result = await fn(tx);
    } catch (e) {
      try {
        tx.abort();
      } catch {
        /* 既に終了 */
      }
      await done.catch(() => {});
      throw e;
    }
    await done;
    return result;
  }

  // ---- メタ情報 ----

  async getMeta(key) {
    const r = await this.run(['meta'], 'readonly', (tx) => req(tx.objectStore('meta').get(key)));
    return r ? r.value : null;
  }

  setMeta(key, value) {
    return this.run(['meta'], 'readwrite', (tx) => {
      tx.objectStore('meta').put({ key, value });
    });
  }

  getSettings() {
    return this.getMeta('settings');
  }

  /**
   * 初期設定：設定・端末ID・最初の会計期間・科目テンプレートを1つのトランザクションで登録する
   */
  setup({ settings, period, accounts }) {
    const errors = validatePeriod(period, settings.entityType);
    if (!String(settings.businessName || '').trim()) errors.businessName = '事業者名を入力してください';
    if (Object.keys(errors).length) return Promise.reject(new ValidationError(errors));
    return this.run(ALL_STORES, 'readwrite', async (tx) => {
      const meta = tx.objectStore('meta');
      if (await req(meta.get('settings'))) throw new Error('初期設定は済んでいます');
      meta.put({ key: 'settings', value: settings });
      if (!(await req(meta.get('deviceId')))) meta.put({ key: 'deviceId', value: newId() });
      meta.put({ key: 'currentPeriodId', value: period.id });
      tx.objectStore('periods').put({ nextJournalNo: 1, ...period });
      for (const a of accounts) tx.objectStore('accounts').put(a);
      return settings;
    });
  }

  /** 設定の更新（事業者の種類は変更できない） */
  updateSettings(patch) {
    return this.run(['meta'], 'readwrite', async (tx) => {
      const meta = tx.objectStore('meta');
      const cur = (await req(meta.get('settings')))?.value;
      if (!cur) throw new Error('初期設定がされていません');
      if (patch.entityType && patch.entityType !== cur.entityType) throw new ValidationError(['個人/法人は変更できません']);
      const next = { ...cur, ...patch, entityType: cur.entityType, updatedAt: now() };
      if (!String(next.businessName || '').trim()) throw new ValidationError({ businessName: '事業者名を入力してください' });
      meta.put({ key: 'settings', value: next });
      return next;
    });
  }

  /**
   * 製造原価を使う・使わない（法人だけ）。使うときは製造原価の科目（材料費・労務費・製造経費・仕掛品、原材料・仕掛品・製品）を追加する
   * 使わないにしても科目は残す（仕訳で使っているかもしれないため。不要なら勘定科目の画面で無効・削除する）
   * @returns {Promise<{ settings, added: Array }>}
   */
  setManufacturing(on) {
    return this.run(['meta', 'accounts'], 'readwrite', async (tx) => {
      const meta = tx.objectStore('meta');
      const cur = (await req(meta.get('settings')))?.value;
      if (!cur) throw new Error('初期設定がされていません');
      if (on && cur.entityType !== 'corporation') throw new ValidationError(['製造原価報告書は法人だけで使えます']);
      const at = now();
      const added = on ? manufacturingAccounts(await req(tx.objectStore('accounts').getAll())).map((a) => createAccount(a)) : [];
      for (const a of added) tx.objectStore('accounts').put(a);
      const next = { ...cur, manufacturing: Boolean(on), updatedAt: at };
      meta.put({ key: 'settings', value: next });
      return { settings: next, added };
    });
  }

  /**
   * 銀行明細の振り分けルールを保存する（設定の bankRules。バックアップにも入る）
   * @param {Array<{ id, keyword, direction, accountId, subAccountId?, taxCategory }>} rules
   */
  saveBankRules(rules) {
    return this.run(['meta', 'accounts', 'subAccounts'], 'readwrite', async (tx) => {
      const meta = tx.objectStore('meta');
      const cur = (await req(meta.get('settings')))?.value;
      if (!cur) throw new Error('初期設定がされていません');
      const [accounts, subAccounts] = await Promise.all([req(tx.objectStore('accounts').getAll()), req(tx.objectStore('subAccounts').getAll())]);
      const isBank = (id) => isCashAccount(accounts.find((a) => a.id === id));
      const errors = rules.flatMap((r, i) => Object.values(validateRule(r, { accounts, subAccounts, isBankAccount: isBank })).map((m) => `${i + 1}件目：${m}`));
      if (errors.length) throw new ValidationError(errors);
      const at = now();
      const bankRules = rules.map((r) => ({ id: r.id || newId(), keyword: String(r.keyword).trim(), direction: r.direction, accountId: r.accountId, subAccountId: r.subAccountId || null, taxCategory: r.taxCategory }));
      const next = { ...cur, bankRules, updatedAt: at };
      meta.put({ key: 'settings', value: next });
      return next;
    });
  }

  // ---- 会計期間 ----

  async getCurrentPeriod() {
    const id = await this.getMeta('currentPeriodId');
    if (!id) return null;
    return this.run(['periods'], 'readonly', (tx) => req(tx.objectStore('periods').get(id)));
  }

  /** 期間の日付の変更。期間外になる仕訳があれば変更しない */
  savePeriodDates(periodId, { startDate, endDate }) {
    return this.run(['meta', 'periods', 'journals'], 'readwrite', async (tx) => {
      const settings = (await req(tx.objectStore('meta').get('settings')))?.value;
      const errors = validatePeriod({ startDate, endDate }, settings?.entityType);
      if (Object.keys(errors).length) throw new ValidationError(errors);
      const store = tx.objectStore('periods');
      const period = await req(store.get(periodId));
      if (!period) throw new Error('会計期間が見つかりません');
      if (period.closed) throw new ValidationError([CLOSED_PERIOD_MESSAGE]);
      const others = (await req(store.getAll())).filter((p) => p.id !== periodId);
      if (others.some((p) => p.startDate <= endDate && startDate <= p.endDate)) throw new ValidationError(['ほかの会計期間と重なります']);
      const journals = await req(tx.objectStore('journals').index('periodId').getAll(periodId));
      const outside = journals.filter((j) => j.date < startDate || j.date > endDate).length;
      if (outside) throw new ValidationError([`新しい期間の外になる仕訳が${outside}件あります`]);
      const next = { ...period, startDate, endDate, updatedAt: now() };
      store.put(next);
      return next;
    });
  }

  /**
   * 期首残高の保存。BS 科目のみ。個人は元入金を自動計算して上書きする
   * @param {Array<{accountId, subAccountId, amount}>} balances amount は残高側の金額（整数・マイナス可）
   */
  saveOpeningBalances(periodId, balances) {
    return this.run(['meta', 'periods', 'accounts', 'subAccounts'], 'readwrite', async (tx) => {
      const store = tx.objectStore('periods');
      const period = await req(store.get(periodId));
      if (!period) throw new Error('会計期間が見つかりません');
      if (period.closed) throw new ValidationError([CLOSED_PERIOD_MESSAGE]);
      const result = await normalizeOpening(tx, balances);
      const next = { ...period, openingBalances: result, updatedAt: now() };
      store.put(next);
      return next;
    });
  }

  /**
   * 消費税の申告計算の設定（計算の方法・事業区分・中間納付税額）を期間に保存する
   * @param {{ method: string, businessType: number, allocation?: 'individual'|'proportional', interimNational: number, interimLocal: number }} taxReturn
   */
  saveTaxReturnSettings(periodId, taxReturn) {
    return this.run(['periods'], 'readwrite', async (tx) => {
      const store = tx.objectStore('periods');
      const period = await req(store.get(periodId));
      if (!period) throw new Error('会計期間が見つかりません');
      if (period.closed) throw new ValidationError([CLOSED_PERIOD_MESSAGE]);
      const errors = [];
      if (!['general', 'simplified', 'twenty', 'thirty'].includes(taxReturn.method)) errors.push('計算の方法を選んでください');
      if (![1, 2, 3, 4, 5, 6].includes(taxReturn.businessType)) errors.push('事業区分を選んでください');
      if (taxReturn.allocation !== undefined && !['individual', 'proportional'].includes(taxReturn.allocation)) errors.push('個別対応方式か一括比例配分方式を選んでください');
      for (const k of ['interimNational', 'interimLocal']) if (!isYen(taxReturn[k]) || taxReturn[k] < 0) errors.push('中間納付税額は0以上の整数で入力してください');
      if (taxReturn.baseSales != null && (!isYen(taxReturn.baseSales) || taxReturn.baseSales < 0)) errors.push('基準期間の課税売上高は0以上の整数で入力してください');
      if (errors.length) throw new ValidationError([...new Set(errors)]);
      const { method, businessType, interimNational, interimLocal, allocation = 'proportional', baseSales = null } = taxReturn;
      const next = { ...period, taxReturn: { method, businessType, allocation, interimNational, interimLocal, baseSales }, updatedAt: now() };
      store.put(next);
      return next;
    });
  }

  /** 事業税の入力を期間に保存する（締めた期間も保存できる） */
  saveEnterpriseTax(periodId, input) {
    return this.run(['periods'], 'readwrite', async (tx) => {
      const store = tx.objectStore('periods');
      const period = await req(store.get(periodId));
      if (!period) throw new Error('会計期間が見つかりません');
      const value = { ...DEFAULT_ENTERPRISE_TAX, ...input };
      const errors = validateEnterpriseTax(value);
      if (errors.length) throw new ValidationError(errors);
      const picked = Object.fromEntries(Object.keys(DEFAULT_ENTERPRISE_TAX).map((k) => [k, value[k]]));
      const next = { ...period, enterpriseTax: picked, updatedAt: now() };
      store.put(next);
      return next;
    });
  }

  /** 決算書（法人）の個別注記表の入力を期間に保存する（締めた期間も、注記だけは直せる） */
  saveStatementNotes(periodId, notes) {
    return this.run(['periods'], 'readwrite', async (tx) => {
      const store = tx.objectStore('periods');
      const period = await req(store.get(periodId));
      if (!period) throw new Error('会計期間が見つかりません');
      const value = { ...DEFAULT_NOTES, ...notes };
      const errors = validateNotes(value);
      if (errors.length) throw new ValidationError(errors);
      const picked = Object.fromEntries(Object.keys(DEFAULT_NOTES).map((k) => [k, value[k]]));
      const next = { ...period, statementNotes: picked, updatedAt: now() };
      store.put(next);
      return next;
    });
  }

  /** 青色申告決算書の設定（青色申告特別控除額）を期間に保存する */
  saveBlueReturnSettings(periodId, { deduction }) {
    return this.run(['periods'], 'readwrite', async (tx) => {
      const store = tx.objectStore('periods');
      const period = await req(store.get(periodId));
      if (!period) throw new Error('会計期間が見つかりません');
      if (period.closed) throw new ValidationError([CLOSED_PERIOD_MESSAGE]);
      if (![0, 100000, 550000, 650000, 750000].includes(deduction)) throw new ValidationError(['青色申告特別控除額を選んでください']);
      const next = { ...period, blueReturn: { deduction }, updatedAt: now() };
      store.put(next);
      return next;
    });
  }

  listPeriods() {
    return this.run(['periods'], 'readonly', async (tx) => (await req(tx.objectStore('periods').getAll())).sort((a, b) => (a.startDate < b.startDate ? -1 : 1)));
  }

  /**
   * 会計期間を締める（仕訳・期首残高・日付を変更できなくする）。次の期間へ繰り越した後だけ締められる
   */
  closePeriod(periodId) {
    return this.run(['periods'], 'readwrite', async (tx) => {
      const store = tx.objectStore('periods');
      const period = await req(store.get(periodId));
      if (!period) throw new Error('会計期間が見つかりません');
      const all = await req(store.getAll());
      const nextStart = addDays(period.endDate, 1);
      if (!all.some((p) => p.startDate === nextStart)) throw new ValidationError(['次の期間へ繰り越してから締めてください']);
      const ts = now();
      const next = { ...period, closed: true, closedAt: ts, updatedAt: ts };
      store.put(next);
      return next;
    });
  }

  /** 締めの解除 */
  reopenPeriod(periodId) {
    return this.run(['periods'], 'readwrite', async (tx) => {
      const store = tx.objectStore('periods');
      const period = await req(store.get(periodId));
      if (!period) throw new Error('会計期間が見つかりません');
      const next = { ...period, closed: false, closedAt: null, updatedAt: now() };
      store.put(next);
      return next;
    });
  }

  /** 表示・入力する会計期間を切り替える */
  setCurrentPeriod(periodId) {
    return this.run(['meta', 'periods'], 'readwrite', async (tx) => {
      if (!(await req(tx.objectStore('periods').get(periodId)))) throw new Error('会計期間が見つかりません');
      tx.objectStore('meta').put({ key: 'currentPeriodId', value: periodId });
    });
  }

  /**
   * 年度繰越：次の会計期間を期首残高つきで作り、現在の期間にする（1つのトランザクション）
   * @param {object} period createPeriod で作った期間（startDate・endDate）
   * @param {Array} balances 期首残高（closing.carryForwardBalances の結果）
   */
  createNextPeriod(period, balances) {
    return this.run(ALL_STORES, 'readwrite', async (tx) => {
      const settings = (await req(tx.objectStore('meta').get('settings')))?.value;
      const errors = validatePeriod(period, settings?.entityType);
      if (Object.keys(errors).length) throw new ValidationError(errors);
      const store = tx.objectStore('periods');
      const periods = await req(store.getAll());
      if (periods.some((p) => p.startDate <= period.endDate && period.startDate <= p.endDate)) throw new ValidationError(['この期間と重なる会計期間が既にあります']);
      const result = await normalizeOpening(tx, balances);
      const next = { ...period, openingBalances: result, nextJournalNo: 1 };
      store.put(next);
      tx.objectStore('meta').put({ key: 'currentPeriodId', value: next.id });
      return next;
    });
  }

  // ---- 勘定科目・補助科目 ----

  listAccounts() {
    return this.run(['accounts'], 'readonly', (tx) => req(tx.objectStore('accounts').getAll()));
  }

  getAccount(id) {
    return this.run(['accounts'], 'readonly', (tx) => req(tx.objectStore('accounts').get(id)));
  }

  listSubAccounts() {
    return this.run(['subAccounts'], 'readonly', (tx) => req(tx.objectStore('subAccounts').getAll()));
  }

  /** 使用中の科目・補助科目の id */
  usage() {
    return this.run(['journals', 'periods'], 'readonly', async (tx) =>
      usedAccountIds(await req(tx.objectStore('journals').getAll()), await req(tx.objectStore('periods').getAll())),
    );
  }

  /** 科目の追加・更新（検証してから保存） */
  saveAccount(account) {
    return this.run(['meta', 'accounts', 'journals', 'periods'], 'readwrite', async (tx) => {
      const settings = (await req(tx.objectStore('meta').get('settings')))?.value;
      const store = tx.objectStore('accounts');
      const all = await req(store.getAll());
      const before = all.find((a) => a.id === account.id) || null;
      const { accounts: used } = usedAccountIds(await req(tx.objectStore('journals').getAll()), await req(tx.objectStore('periods').getAll()));
      const record = { ...account, code: String(account.code).trim(), name: String(account.name).trim(), role: before ? before.role : null, hint: before ? (before.hint ?? null) : null };
      const errors = validateAccount(record, all, { used: used.has(account.id), entityType: settings?.entityType }, before);
      if (Object.keys(errors).length) throw new ValidationError(errors);
      const next = { ...record, updatedAt: now() };
      store.put(next);
      return next;
    });
  }

  /** 目印（hint）の導入前に作った科目に目印を補う。起動時に呼ぶ（変更が無ければ何もしない） */
  fillAccountHints() {
    return this.run(['meta', 'accounts'], 'readwrite', async (tx) => {
      const settings = (await req(tx.objectStore('meta').get('settings')))?.value;
      if (!settings) return 0;
      const changed = fillHints(settings.entityType, await req(tx.objectStore('accounts').getAll()));
      const ts = now();
      for (const a of changed) tx.objectStore('accounts').put({ ...a, updatedAt: ts });
      return changed.length;
    });
  }

  /** 科目の削除：自分で追加し、どこにも使っていない科目だけ。補助科目も削除する */
  deleteAccount(id) {
    return this.run(['accounts', 'subAccounts', 'journals', 'periods', 'assets', 'tombstones'], 'readwrite', async (tx) => {
      const acc = await req(tx.objectStore('accounts').get(id));
      if (!acc) return;
      if (acc.template || acc.role) throw new ValidationError(['テンプレートの科目は削除できません。使わない場合は無効にしてください']);
      const { accounts: used } = usedAccountIds(await req(tx.objectStore('journals').getAll()), await req(tx.objectStore('periods').getAll()));
      if (used.has(id)) throw new ValidationError(['仕訳か期首残高で使われているため削除できません。無効にしてください']);
      if (await req(tx.objectStore('assets').index('accountId').count(id))) throw new ValidationError(['固定資産台帳で使われているため削除できません。無効にしてください']);
      const subs = await req(tx.objectStore('subAccounts').index('accountId').getAll(id));
      for (const s of subs) {
        tx.objectStore('subAccounts').delete(s.id);
        tx.objectStore('tombstones').put(tombstone('subAccounts', s.id));
      }
      tx.objectStore('accounts').delete(id);
      tx.objectStore('tombstones').put(tombstone('accounts', id));
    });
  }

  saveSubAccount(sub) {
    return this.run(['accounts', 'subAccounts'], 'readwrite', async (tx) => {
      const name = String(sub.name || '').trim();
      if (!name) throw new ValidationError({ name: '補助科目名を入力してください' });
      if (name.length > 30) throw new ValidationError({ name: '補助科目名は30文字以内にしてください' });
      if (!(await req(tx.objectStore('accounts').get(sub.accountId)))) throw new Error('勘定科目が見つかりません');
      const siblings = await req(tx.objectStore('subAccounts').index('accountId').getAll(sub.accountId));
      if (siblings.some((s) => s.id !== sub.id && s.name === name)) throw new ValidationError({ name: '同じ名前の補助科目があります' });
      const next = { ...sub, name, updatedAt: now() };
      tx.objectStore('subAccounts').put(next);
      return next;
    });
  }

  deleteSubAccount(id) {
    return this.run(['subAccounts', 'journals', 'periods', 'tombstones'], 'readwrite', async (tx) => {
      const { subs } = usedAccountIds(await req(tx.objectStore('journals').getAll()), await req(tx.objectStore('periods').getAll()));
      if (subs.has(id)) throw new ValidationError(['仕訳か期首残高で使われているため削除できません。無効にしてください']);
      tx.objectStore('subAccounts').delete(id);
      tx.objectStore('tombstones').put(tombstone('subAccounts', id));
    });
  }

  // ---- 仕訳 ----

  listJournals(periodId) {
    return this.run(['journals'], 'readonly', (tx) => req(tx.objectStore('journals').index('periodId').getAll(periodId)));
  }

  getJournal(id) {
    return this.run(['journals'], 'readonly', (tx) => req(tx.objectStore('journals').get(id)));
  }

  /**
   * 仕訳の保存。同じトランザクションで科目・期間を読み、貸借一致などを再検証する。
   * 新規のときは期間の通し番号を採番する（削除しても番号は詰めない）
   */
  saveJournal(journal) {
    return this.run(['accounts', 'subAccounts', 'periods', 'journals'], 'readwrite', (tx) => putJournal(tx, journal));
  }

  /**
   * 複数の仕訳をまとめて新規登録する（銀行明細の取り込み）。1件でも不正なら1件も保存しない
   * @returns {Array} 保存した仕訳（番号つき）
   */
  saveJournals(list) {
    return this.run(['accounts', 'subAccounts', 'periods', 'journals'], 'readwrite', async (tx) => {
      const out = [];
      for (const [i, j] of list.entries()) {
        try {
          out.push(await putJournal(tx, j));
        } catch (e) {
          if (e instanceof ValidationError) throw new ValidationError(e.errors.map((m) => `${i + 1}件目（${j.date}）：${m}`));
          throw e;
        }
      }
      return out;
    });
  }

  /** 仕訳の削除。tombstone を記録し、「元に戻す」用に削除した仕訳を返す */
  deleteJournal(id) {
    return this.run(['journals', 'periods', 'tombstones'], 'readwrite', async (tx) => {
      const j = await req(tx.objectStore('journals').get(id));
      if (!j) return null;
      if ((await req(tx.objectStore('periods').get(j.periodId)))?.closed) throw new ValidationError([CLOSED_PERIOD_MESSAGE]);
      tx.objectStore('journals').delete(id);
      tx.objectStore('tombstones').put(tombstone('journals', id));
      return j;
    });
  }

  /** 削除の取り消し */
  restoreJournal(journal) {
    return this.run(['journals', 'periods', 'tombstones'], 'readwrite', async (tx) => {
      if ((await req(tx.objectStore('periods').get(journal.periodId)))?.closed) throw new ValidationError([CLOSED_PERIOD_MESSAGE]);
      tx.objectStore('journals').put(journal);
      tx.objectStore('tombstones').delete(journal.id);
    });
  }

  // ---- 固定資産 ----

  listAssets() {
    return this.run(['assets'], 'readonly', (tx) => req(tx.objectStore('assets').getAll()));
  }

  getAsset(id) {
    return this.run(['assets'], 'readonly', (tx) => req(tx.objectStore('assets').get(id)));
  }

  /** 固定資産の追加・更新（検証してから保存）。法人は事業で使う割合を100%にする */
  saveAsset(asset) {
    return this.run(['meta', 'accounts', 'assets'], 'readwrite', (tx) => putAsset(tx, asset));
  }

  /**
   * 固定資産の売却・除却：資産（売却・除却した日・種類・売却額）と、その仕訳を1つのトランザクションで保存する
   * @param {object} asset disposedOn・disposalType・salePrice を入れた資産
   * @param {object|null} journal 売却・除却の仕訳（source: 'asset_disposal'、sourceId: 資産の id）。帳簿価額0円の除却などは null
   */
  disposeAsset(asset, journal) {
    return this.run(['meta', 'accounts', 'subAccounts', 'periods', 'journals', 'assets'], 'readwrite', async (tx) => {
      const saved = await putAsset(tx, asset);
      const savedJournal = journal ? await putJournal(tx, { ...journal, source: 'asset_disposal', sourceId: saved.id }) : null;
      return { asset: saved, journal: savedJournal };
    });
  }

  /** 売却・除却の取り消し：その資産の売却・除却の仕訳を削除し（tombstone を残す）、売却・除却の項目を空にする */
  undoDisposal(assetId) {
    return this.run(['meta', 'accounts', 'periods', 'journals', 'assets', 'tombstones'], 'readwrite', async (tx) => {
      const asset = await req(tx.objectStore('assets').get(assetId));
      if (!asset) throw new Error('固定資産が見つかりません');
      const journals = (await req(tx.objectStore('journals').getAll())).filter((j) => j.source === 'asset_disposal' && j.sourceId === assetId);
      for (const j of journals) {
        if ((await req(tx.objectStore('periods').get(j.periodId)))?.closed) throw new ValidationError([CLOSED_PERIOD_MESSAGE]);
        tx.objectStore('journals').delete(j.id);
        tx.objectStore('tombstones').put(tombstone('journals', j.id));
      }
      return putAsset(tx, { ...asset, disposedOn: null, disposalType: null, salePrice: null });
    });
  }

  deleteAsset(id) {
    return this.run(['assets', 'tombstones'], 'readwrite', async (tx) => {
      if (!(await req(tx.objectStore('assets').get(id)))) return;
      tx.objectStore('assets').delete(id);
      tx.objectStore('tombstones').put(tombstone('assets', id));
    });
  }

  // ---- バックアップ ----

  async counts() {
    return this.run(DATA_STORES, 'readonly', async (tx) => {
      const out = {};
      for (const n of DATA_STORES) out[n] = await req(tx.objectStore(n).count());
      return out;
    });
  }

  /** 全データの取得（バックアップ用） */
  dumpAll() {
    return this.run(ALL_STORES, 'readonly', async (tx) => {
      const meta = tx.objectStore('meta');
      const out = {
        settings: (await req(meta.get('settings')))?.value ?? null,
        currentPeriodId: (await req(meta.get('currentPeriodId')))?.value ?? null,
        deviceId: (await req(meta.get('deviceId')))?.value ?? null,
      };
      for (const n of DATA_STORES) out[n] = await req(tx.objectStore(n).getAll());
      return out;
    });
  }

  /**
   * 復元（置き換え）。検証済みのデータを受け取り、全削除→登録を1トランザクションで行う。
   * 端末ID はこの端末のものを残す
   */
  replaceAll(data) {
    return this.run(ALL_STORES, 'readwrite', async (tx) => {
      const meta = tx.objectStore('meta');
      for (const n of DATA_STORES) await req(tx.objectStore(n).clear());
      meta.put({ key: 'settings', value: data.settings });
      meta.put({ key: 'currentPeriodId', value: data.currentPeriodId });
      for (const n of DATA_STORES) for (const r of data[n] || []) tx.objectStore(n).put(r);
      // 目印の導入前のバックアップなら、テンプレートの科目に目印を補う
      const ts = now();
      for (const a of fillHints(data.settings.entityType, data.accounts || [])) tx.objectStore('accounts').put({ ...a, updatedAt: ts });
    });
  }

  /** すべてのデータを消す（設定の初期化） */
  clearAll() {
    return this.run(ALL_STORES, 'readwrite', async (tx) => {
      for (const n of DATA_STORES) await req(tx.objectStore(n).clear());
      for (const key of ['settings', 'currentPeriodId', 'lastBackupAt']) tx.objectStore('meta').delete(key);
    });
  }
}

/** 必須の役割の科目がそろっているか（復元データの検証用） */
export function missingRoles(entityType, accounts) {
  return (REQUIRED_ROLES[entityType] || []).filter((r) => !findByRole(accounts, r));
}
