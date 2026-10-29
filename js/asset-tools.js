// 固定資産台帳の補助機能（純粋関数）：耐用年数表の候補・中古資産の耐用年数・売却と除却の仕訳・科目別の集計
// 出典（2026-10-29 確認。令和8年4月1日現在の法令等）
// - 耐用年数：国税庁「主な減価償却資産の耐用年数表」https://www.nta.go.jp/taxes/shiraberu/taxanswer/shotoku/pdf/2100_01.pdf
//   確定申告書等作成コーナー「耐用年数（器具・備品）（その1）」「耐用年数（車両・運搬具／工具）」「耐用年数（建物、建物付属設備）」
//   ソフトウエア：No.5461 https://www.nta.go.jp/taxes/shiraberu/taxanswer/hojin/5461.htm
// - 中古資産の耐用年数（簡便法）：No.5404 https://www.nta.go.jp/taxes/shiraberu/taxanswer/hojin/5404.htm
//   耐用年数の適用等に関する取扱通達 第5節（1-5-1 使い始めた年に限る、1-5-6 1年未満の端数は切り捨て）
// - 事業用の固定資産の売却は消費税の課税対象：国税庁 質疑応答「事業者の事業用固定資産の売却」
//   https://www.nta.go.jp/law/shitsugi/shohi/02/02.htm
// - 個人の事業用の固定資産（機械・車両など）の売却は譲渡所得（事業所得ではない）：No.3105
//   https://www.nta.go.jp/taxes/shiraberu/taxanswer/joto/3105.htm
// - 個人の業務用資産の取壊し・除却の損失は必要経費：No.2210 https://www.nta.go.jp/taxes/shiraberu/taxanswer/shotoku/2210.htm
import { CATEGORY_BY_ID, usesLife, depreciationSchedule, hasCarryOver, MIN_LIFE } from './depreciation.js';

/** よく使う資産の耐用年数（耐用年数表から抜粋。表にないものは利用者が年数を入力する） */
export const LIFE_PRESETS = [
  { category: 'tools', label: 'パソコン（サーバー用を除く）', life: 4 },
  { category: 'tools', label: 'サーバー・その他の電子計算機', life: 5 },
  { category: 'tools', label: '複写機・計算機・タイムレコーダー', life: 5 },
  { category: 'tools', label: 'ファクシミリ', life: 5 },
  { category: 'tools', label: 'デジタル構内交換設備・デジタルボタン電話設備', life: 6 },
  { category: 'tools', label: 'その他の電話設備・通信機器', life: 10 },
  { category: 'tools', label: 'エアコンなどの冷房用・暖房用機器', life: 6 },
  { category: 'tools', label: '電気冷蔵庫・電気洗濯機など', life: 6 },
  { category: 'tools', label: 'テレビ・音響機器', life: 5 },
  { category: 'tools', label: 'カメラ', life: 5 },
  { category: 'tools', label: '事務机・いす・キャビネット（主に金属製）', life: 15 },
  { category: 'tools', label: '事務机・いす・キャビネット（その他）', life: 8 },
  { category: 'tools', label: '応接セット（接客業用）', life: 5 },
  { category: 'tools', label: '応接セット（その他）', life: 8 },
  { category: 'tools', label: '陳列棚・陳列ケース（冷凍・冷蔵機能付き）', life: 6 },
  { category: 'tools', label: '陳列棚・陳列ケース（その他）', life: 8 },
  { category: 'tools', label: '看板・ネオンサイン', life: 3 },
  { category: 'tools', label: '金庫（手さげ金庫を除く）', life: 20 },
  { category: 'tools', label: '時計', life: 10 },
  { category: 'tools', label: '理容・美容機器', life: 5 },
  { category: 'tools', label: '測定工具・検査工具', life: 5 },
  { category: 'vehicle', label: '自動車（普通車など）', life: 6 },
  { category: 'vehicle', label: '軽自動車（総排気量0.66リットル以下）', life: 4 },
  { category: 'vehicle', label: '貨物自動車（ダンプ式以外）', life: 5 },
  { category: 'vehicle', label: '二輪・三輪自動車', life: 3 },
  { category: 'vehicle', label: '自転車', life: 2 },
  { category: 'building', label: '木造の事務所', life: 24 },
  { category: 'building', label: '木造の店舗・住宅', life: 22 },
  { category: 'building', label: '鉄筋コンクリート造の事務所', life: 50 },
  { category: 'building', label: '鉄筋コンクリート造の住宅', life: 47 },
  { category: 'building_equipment', label: '電気設備（照明設備を含む。蓄電池電源設備以外）', life: 15 },
  { category: 'building_equipment', label: '給排水・衛生設備、ガス設備', life: 15 },
  { category: 'building_equipment', label: '店用簡易装備', life: 3 },
  { category: 'intangible', label: 'ソフトウェア（販売用の原本・研究開発用以外）', life: 5 },
];

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
  for (const { asset, opening, row, closing } of register) {
    const s = map.get(asset.accountId) || { accountId: asset.accountId, count: 0, cost: 0, opening: 0, amount: 0, business: 0, closing: 0 };
    s.count += 1;
    s.cost += asset.cost;
    s.opening += opening || 0;
    s.amount += row?.amount || 0;
    s.business += row?.business || 0;
    s.closing += closing || 0;
    map.set(asset.accountId, s);
  }
  return [...map.values()];
}
