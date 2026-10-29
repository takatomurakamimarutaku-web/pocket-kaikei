// 固定資産台帳の補助機能（純粋関数）：中古資産の耐用年数・売却と除却の仕訳・科目別の集計・資本的支出・一部の売却除却
// 耐用年数表の候補は js/life-table.js
// 出典（2026-10-29 確認。令和8年4月1日現在の法令等）
// - 中古資産の耐用年数（簡便法）：No.5404 https://www.nta.go.jp/taxes/shiraberu/taxanswer/hojin/5404.htm
//   耐用年数の適用等に関する取扱通達 第5節（1-5-1 使い始めた年に限る、1-5-6 1年未満の端数は切り捨て）
// - 事業用の固定資産の売却は消費税の課税対象：国税庁 質疑応答「事業者の事業用固定資産の売却」
//   https://www.nta.go.jp/law/shitsugi/shohi/02/02.htm
// - 個人の事業用の固定資産（機械・車両など）の売却は譲渡所得（事業所得ではない）：No.3105
//   https://www.nta.go.jp/taxes/shiraberu/taxanswer/joto/3105.htm
// - 個人の業務用資産の取壊し・除却の損失は必要経費：No.2210 https://www.nta.go.jp/taxes/shiraberu/taxanswer/shotoku/2210.htm
// - 資本的支出：元の資産と種類・耐用年数が同じ資産を新たに取得したものとして、支出額を取得価額にして償却する（平成19年4月1日以後の支出）
//   No.2107 https://www.nta.go.jp/taxes/shiraberu/taxanswer/shotoku/2107.htm 、法人税法施行令55条
//   （国税庁「2 固定資産の取得価額等」https://www.nta.go.jp/law/joho-zeikaishaku/hojin/070622-2/03.htm）
import { CATEGORY_BY_ID, usesLife, depreciationSchedule, hasCarryOver, MIN_LIFE, NEW_METHOD_FROM } from './depreciation.js';
import { isValidDate } from './period.js';
import { newId } from './models.js';

/**
 * 中古資産の耐用年数（簡便法）
 *   全部経過：法定耐用年数×20%、一部経過：(法定耐用年数−経過年数)＋経過年数×20%
 *   1年未満の端数は切り捨て、2年未満なら2年。経過年数は月数で計算する
 * @param {number} legalLife 法定耐用年数（年）
 * @param {number} elapsedMonths 経過した月数（製造・新品の取得から自分が取得するまで）
 * @returns {number|null} 耐用年数（入力が不正なら null）
 */
export function usedAssetLife(legalLife, elapsedMonths) {
  if (!Number.isInteger(legalLife) || legalLife < 1 || !Number.isInteger(elapsedMonths) || elapsedMonths < 0) return null;
  const legal = legalLife * 12;
  // 月数で (法定−経過)＋経過×20% ＝ 法定−経過×4/5。全部経過なら 法定×1/5
  const months = elapsedMonths >= legal ? legal / 5 : legal - (elapsedMonths * 4) / 5;
  return Math.max(MIN_LIFE, Math.floor(months / 12));
}

/** 売却・除却の仕訳を作れる資産か（一括償却資産は除却しても3年で償却を続け、少額は取得時に全額を費用にしている） */
export function canDispose(asset) {
  return usesLife(asset.method);
}

/** ある日に売却・除却したときの帳簿価額（その日までの償却を引いた額） */
export function bookValueAt(asset, periods, date) {
  const rows = depreciationSchedule({ ...asset, disposedOn: date }, periods).filter((r) => r.startDate <= date);
  if (rows.length) return rows[rows.length - 1].closing;
  if (hasCarryOver(asset) && date >= asset.carryOn) return asset.carryBook;
  return asset.cost;
}

/**
 * 売却・除却の仕訳の明細（税込経理）
 *   法人の有形固定資産で減価償却累計額の科目を使っているとき：減価償却累計額 / 資産（取得価額−帳簿価額）
 *   売却：入金先 / 資産（売却額。課税売上10%）、差額は 資産 / 固定資産売却益 または 固定資産売却損 / 資産
 *         個人は譲渡所得になるので、売却益は事業主借、売却損は事業主貸。売却額のうち私用割合の分は消費税の対象外
 *   除却：固定資産除却損 / 資産（帳簿価額）。個人は事業で使う割合の分を選んだ経費の科目、残りを事業主貸
 * @param {{ asset, periods, accounts, entityType, date, type: 'sell'|'retire', price?, receiptAccountId?, lossAccountId?, gainAccountId? }} input
 * @returns {{ lines: Array, book: number, accumulated: number, gain: number, loss: number, errors: string[] }}
 */
export function disposalLines({ asset, periods, accounts, entityType, date, type, price = 0, receiptAccountId = '', lossAccountId = '', gainAccountId = '' }) {
  const errors = [];
  const byId = (id) => accounts.find((a) => a.id === id && a.active);
  const individual = entityType === 'individual';
  const ratio = individual && Number.isInteger(asset.businessRatio) ? asset.businessRatio : 100;
  const book = bookValueAt(asset, periods, date);
  const intangible = CATEGORY_BY_ID[asset.category]?.intangible;
  const accumulatedAccount = !individual && !intangible ? accounts.find((a) => a.hint === 'accumulated_depreciation' && a.active) : null;
  const accumulated = accumulatedAccount ? asset.cost - book : 0;
  const drawings = accounts.find((a) => a.role === 'owner_drawings');
  const contributions = accounts.find((a) => a.role === 'owner_borrowings');
  const memo = `${type === 'sell' ? '売却' : '除却'} ${asset.name}`.slice(0, 100);
  const lines = [];
  const line = (side, accountId, amount, taxCategory = 'none', suffix = '') => {
    if (amount > 0) lines.push({ side, accountId, subAccountId: null, amount, taxCategory, memo: `${memo}${suffix}`.slice(0, 100) });
  };
  if (!canDispose(asset)) errors.push('定額法・定率法の資産だけ売却・除却の仕訳を作れます（一括償却資産は除却後も3年で償却し、少額の資産は取得した年に全額を費用にしています）');
  if (date < asset.startedOn) errors.push('売却・除却した日は使い始めた日以後にしてください');
  if (accumulated > 0) {
    line('debit', accumulatedAccount.id, accumulated);
    line('credit', asset.accountId, accumulated);
  }
  let gain = 0;
  let loss = 0;
  if (type === 'sell') {
    if (!Number.isInteger(price) || price < 0) errors.push('売却額は0円以上の整数で入力してください');
    const receipt = byId(receiptAccountId);
    if (price > 0 && !receipt) errors.push('売却代金の入金先（または未収入金）の科目を選んでください');
    const diff = price - book;
    gain = Math.max(0, diff);
    loss = Math.max(0, -diff);
    const gainAccount = individual ? contributions : byId(gainAccountId);
    const lossAccount = individual ? drawings : byId(lossAccountId);
    if (gain && !gainAccount) errors.push(individual ? '事業主借の科目が見つかりません' : '固定資産売却益の科目を選んでください');
    if (loss && !lossAccount) errors.push(individual ? '事業主貸の科目が見つかりません' : '固定資産売却損の科目を選んでください');
    if (!errors.length) {
      line('debit', receipt?.id, price);
      // 事業用の資産の売却は課税売上。個人で私用にも使っていた資産は、事業で使う割合の分だけが課税対象
      const taxable = Math.floor((price * ratio) / 100);
      line('credit', asset.accountId, taxable, 'sales_10');
      line('credit', asset.accountId, price - taxable, 'none', '（私用分）');
      line('debit', asset.accountId, gain);
      line('credit', gainAccount?.id, gain);
      line('debit', lossAccount?.id, loss);
      line('credit', asset.accountId, loss);
    }
  } else if (type === 'retire') {
    const lossAccount = byId(lossAccountId);
    if (book > 0 && !lossAccount) errors.push(individual ? '除却損を計上する経費の科目を選んでください' : '固定資産除却損の科目を選んでください');
    const business = Math.floor((book * ratio) / 100);
    if (book - business > 0 && !drawings) errors.push('事業主貸の科目が見つかりません');
    if (!errors.length) {
      line('debit', lossAccount?.id, business);
      line('debit', drawings?.id, book - business, 'none', '（私用分）');
      line('credit', asset.accountId, book);
    }
    loss = book;
  } else errors.push('売却か除却かを選んでください');
  return { lines: errors.length ? [] : lines, book, accumulated, gain, loss, errors };
}

/** この資産の売却・除却の仕訳 */
export function findDisposalJournals(journals, assetId) {
  return journals.filter((j) => j.source === 'asset_disposal' && j.sourceId === assetId);
}

/**
 * 固定資産台帳を科目ごとに合計する
 * @param {Array<{ asset, opening, row, closing }>} register assetRegister() の結果
 * @returns {Array<{ accountId, count, cost, opening, amount, business, closing }>} 科目の並びは台帳に出た順
 */
export function registerByAccount(register) {
  const map = new Map();
  for (const { asset, cost, opening, row, closing } of register) {
    const s = map.get(asset.accountId) || { accountId: asset.accountId, count: 0, cost: 0, opening: 0, amount: 0, business: 0, closing: 0 };
    s.count += 1;
    s.cost += cost ?? asset.cost;
    s.opening += opening || 0;
    s.amount += row?.amount || 0;
    s.business += row?.business || 0;
    s.closing += closing || 0;
    map.set(asset.accountId, s);
  }
  return [...map.values()];
}

/** 資本的支出を追加できる資産か（定額法・定率法で、資本的支出・一部の売却除却で分けた資産でなく、全部を売却・除却していない） */
export function canAddCapex(asset) {
  return usesLife(asset.method) && !asset.parentId && !asset.splitFrom && !asset.disposalType;
}

/**
 * 資本的支出の資産の初期値：元の資産と種類・耐用年数・科目を同じにする（No.2107）
 * 平成19年3月31日以前の資産（旧定額法・旧定率法）への支出も、新たな資産として定額法・定率法で償却する（取得価額に加算する特例は使わない）
 */
export function capexDefaults(parent, date) {
  return {
    name: `${parent.name}（資本的支出）`.slice(0, 40),
    category: parent.category,
    accountId: parent.accountId,
    acquiredOn: date,
    startedOn: date,
    method: parent.method,
    usefulLife: parent.usefulLife,
    businessRatio: parent.businessRatio ?? 100,
    expenseAccountId: parent.expenseAccountId ?? null,
    location: parent.location || '',
    structure: parent.structure || '',
    detail: parent.detail || '',
    parentId: parent.id,
  };
}

/** 資本的支出の資産の検証（元の資産と比べる）。誤りの文言の配列 */
export function validateCapex(asset, parent) {
  if (!asset.parentId) return [];
  if (!parent) return ['資本的支出の元の資産が見つかりません'];
  const errors = [];
  if (parent.parentId || parent.splitFrom) errors.push('資本的支出・一部の売却除却で分けた資産には、資本的支出を追加できません');
  if (!usesLife(parent.method)) errors.push('資本的支出は、定額法・定率法の資産に追加します');
  if (asset.category !== parent.category || asset.usefulLife !== parent.usefulLife) errors.push('資本的支出は、元の資産と同じ種類・耐用年数にします（国税庁 No.2107）');
  if (!usesLife(asset.method)) errors.push('資本的支出は、定額法・定率法で償却します');
  if (isValidDate(asset.startedOn) && asset.startedOn < parent.startedOn) errors.push('資本的支出は、元の資産を使い始めた日以後にします');
  if (isValidDate(asset.startedOn) && asset.startedOn < NEW_METHOD_FROM) errors.push('平成19年3月31日以前の資本的支出（元の資産の取得価額に加算するもの）には対応していません');
  if (parent.disposedOn && isValidDate(asset.startedOn) && asset.startedOn > parent.disposedOn) errors.push('元の資産を売却・除却した日より後には追加できません');
  return errors;
}

/** 一部の売却・除却ができる資産か */
export function canSplit(asset) {
  return canDispose(asset) && !asset.disposalType && !asset.splitFrom;
}

/**
 * 一部の売却・除却：元の資産から、売却・除却する分を別の資産に分ける
 * 分けた期間の期首に、取得価額・帳簿価額（定率法は改定取得価額も）を割合で分ける。それより前の期間は元の資産のまま
 * 分けた資産は、期首の帳簿価額を引き継いで売却・除却した月まで償却する（使い始めた期間に分けるときは引き継がずに同じ日から）
 * @param {object} asset 元の資産
 * @param {Array} periods 会計期間
 * @param {{ date: string, cost: number, quantity: number|null }} input cost：売却・除却する分の取得価額、quantity：その数量（数量で分けないなら null）
 * @returns {{ original: object, part: object, errors: string[] }} part の disposedOn などは売却・除却の処理で入れる
 */
export function splitAsset(asset, periods, { date, cost, quantity = null }) {
  const errors = [];
  if (!canSplit(asset)) errors.push('この資産は一部の売却・除却ができません（定額法・定率法で、売却・除却していない資産だけ）');
  if (!isValidDate(date)) errors.push('売却・除却した日を入れてください');
  else if (date < asset.startedOn) errors.push('売却・除却した日は使い始めた日以後にしてください');
  else if (hasCarryOver(asset) && date < asset.carryOn) errors.push('前の帳簿から引き継いだ日より前は分けられません');
  if (!Number.isInteger(cost) || cost < 1 || cost >= asset.cost) errors.push('売却・除却する分の取得価額は、1円以上で今の取得価額より小さくしてください');
  const total = asset.quantity ?? 1;
  if (quantity !== null && (!Number.isInteger(quantity) || quantity < 1 || quantity >= total)) errors.push(`売却・除却する数量は1〜${total - 1}にしてください`);
  const target = isValidDate(date) ? periods.find((p) => p.startDate <= date && date <= p.endDate) : null;
  if (isValidDate(date) && !target) errors.push('その日を含む会計期間がありません');
  if (errors.length) return { original: asset, part: null, errors };
  const id = newId();
  const original = { ...asset, cost: asset.cost - cost, quantity: quantity !== null ? total - quantity : asset.quantity, splits: [...(asset.splits || []), { id, date, periodStart: target.startDate, cost, quantity }] };
  // 分けた期間の期首に、元の資産から減らした帳簿価額・改定取得価額（この額を分けた資産が引き継ぐ）
  const row = depreciationSchedule(original, periods).find((r) => r.splits?.some((sp) => sp.id === id));
  const removed = row?.splits.find((sp) => sp.id === id);
  const carry = target.startDate > asset.startedOn;
  const minBook = CATEGORY_BY_ID[asset.category]?.intangible ? 0 : 1;
  if (carry && (!removed || removed.book < minBook)) return { original: asset, part: null, errors: ['帳簿価額が小さいため分けられません（償却が終わった資産は、全部を除却してください）'] };
  const part = {
    ...asset,
    id,
    name: `${asset.name}（一部）`.slice(0, 40),
    cost,
    quantity: quantity ?? 1,
    splits: [],
    splitFrom: asset.id,
    parentId: null,
    carryOn: carry ? target.startDate : null,
    carryBook: carry ? removed.book : null,
    carryRevisedBase: carry && asset.method === 'declining' ? removed.revisedBase : null,
    // 特別償却は使い始めた期間だけ。引き継ぐときは元の資産で済んでいる
    specialRate: carry ? null : (asset.specialRate ?? null),
    specialName: carry ? null : (asset.specialName ?? null),
    disposedOn: null,
    disposalType: null,
    salePrice: null,
  };
  return { original, part, errors: [] };
}
