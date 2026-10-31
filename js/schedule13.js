// 別表十三（一）Ⅰ（法人）：国庫補助金等で取得した固定資産等の圧縮額等の損金算入に関する明細書の転記用の明細（純粋関数）
// 固定資産台帳で圧縮記帳（直接減額方式）をした資産のうち、圧縮記帳をした日がこの事業年度の資産を並べる
// 出典（2026-10-31 確認）
// - 別表十三（一）の様式：圧縮限度額は「(5)、(7)若しくは(11)又は((5)、(7)若しくは(11))−1円」（帳簿価額を1円以上残す）
//   https://www.nta.go.jp/taxes/tetsuzuki/shinsei/annai/hojin/shinkoku/itiran2022/pdf/13(01).pdf
// - 記載の仕方（令和8年4月1日以後終了事業年度分）https://www.nta.go.jp/taxes/tetsuzuki/shinsei/annai/hojin/shinkoku/itiran2026/pdf/13(01)-ki.pdf
// 欄の番号は様式の改正で変わるので付けない。特別勘定（交付が先で取得が後の年度）・返還を要するかが未確定の補助金・
// 前期以前に取得した資産の既償却額の調整は扱わない（使い始めた事業年度の中で圧縮記帳した資産だけ）

/** 当期に圧縮記帳をした資産 */
export function compressedIn(assets, period) {
  return assets
    .filter((a) => a.compressionAmount > 0 && a.compressionOn >= period.startDate && a.compressionOn <= period.endDate)
    .sort((a, b) => (a.compressionOn < b.compressionOn ? -1 : a.compressionOn > b.compressionOn ? 1 : String(a.name).localeCompare(String(b.name), 'ja')));
}

/**
 * 1資産の明細
 *   圧縮限度額＝交付を受けた補助金等の額（取得価額（圧縮前）以上なら 取得価額−1円）
 *   圧縮限度超過額＝帳簿価額を減額した金額−圧縮限度額（0未満は0。別表四で加算し、別表五(一)に記載）
 */
export function schedule13Item(asset) {
  const cost = asset.cost + asset.compressionAmount; // 圧縮前の取得価額
  const subsidy = asset.compressionSubsidy ?? asset.compressionAmount;
  const limit = subsidy >= cost ? cost - 1 : subsidy;
  const reduced = asset.compressionAmount;
  return {
    asset,
    name: asset.compressionName || '',
    grantor: asset.compressionGrantor || '',
    date: asset.compressionOn,
    subsidy,
    assetName: asset.name,
    acquiredOn: asset.acquiredOn,
    cost,
    limit,
    reduced,
    excess: Math.max(0, reduced - limit),
    book: asset.cost, // 圧縮後の取得価額（帳簿価額の基礎）
    subsidyGiven: asset.compressionSubsidy != null,
  };
}

/** 別表十三（一）Ⅰ の明細と合計 */
export function schedule13({ assets, period }) {
  const items = compressedIn(assets, period).map(schedule13Item);
  const sum = (k) => items.reduce((s, x) => s + x[k], 0);
  return { items, totals: { subsidy: sum('subsidy'), cost: sum('cost'), limit: sum('limit'), reduced: sum('reduced'), excess: sum('excess') } };
}

/** 画面・印刷の行（欄の名前と値の取り出し方） */
export const SCHEDULE13_LINES = [
  { key: 'name', label: '補助金等の名称', kind: 'text' },
  { key: 'grantor', label: '補助金等を交付した者', kind: 'text' },
  { key: 'date', label: '交付を受けた（返還を要しないことが確定した）年月日', kind: 'date' },
  { key: 'subsidy', label: '交付を受けた補助金等の額', kind: 'yen' },
  { key: 'assetName', label: '取得等をした固定資産の種類・名称', kind: 'text' },
  { key: 'acquiredOn', label: '取得等をした年月日', kind: 'date' },
  { key: 'cost', label: '取得等をした固定資産の取得価額（圧縮前）', kind: 'yen' },
  { key: 'limit', label: '圧縮限度額', formula: '補助金等の額（取得価額以上なら 取得価額−1円）', kind: 'yen' },
  { key: 'reduced', label: '帳簿価額を減額した金額（圧縮額）', kind: 'yen' },
  { key: 'excess', label: '圧縮限度超過額', formula: '減額した金額−圧縮限度額（別表四で加算）', kind: 'yen' },
];
