// 同族会社等の判定（法人税 別表二）：株主グループごとの株式数・議決権の数から、上位3グループ・上位1グループの割合を求める（純粋関数）
// 法人税法2条10号（同族会社：上位3株主グループで50%超）・67条（特定同族会社：上位1株主グループで50%超の被支配会社。
// 資本金1億円以下の法人は除く〔大法人の100%子会社などを除く〕）。欄の番号は別表二（令和7年4月1日以後終了事業年度分）の
// 様式どおり（(2)＝(19)と(21)の上位3順位、(11)＝(21)の上位1順位、(10)＝(3)(6)(9)の最も高い割合、(17)＝(12)(14)(16)の最も高い割合）。2026-10-31 様式PDFで確認
// 国税庁 別表二の様式：https://www.nta.go.jp/taxes/tetsuzuki/shinsei/annai/hojin/shinkoku/itiran2025/pdf/02.pdf
// 社員の数による判定（(7)〜(9)・(15)(16)）は持分会社の社員の数で行うもので、このアプリでは扱わない（株式数・出資の金額と議決権で判定）

export const MAX_SHAREHOLDERS = 20;
const MAX_TEXT = 60;

/** 株主の行の初期値 */
export const emptyShareholder = () => ({ name: '', address: '', relation: '本人', group: '', shares: 0, votes: null, corporate: false });

const isCount = (n) => Number.isInteger(n) && n >= 0 && n <= 1e15;

/** 入力の検証。エラーメッセージの配列 */
export function validateShareholders({ shareholders = [], sharesTotal = null, votesTotal = null } = {}) {
  const errors = [];
  if (!Array.isArray(shareholders) || shareholders.length > MAX_SHAREHOLDERS) return [`株主は${MAX_SHAREHOLDERS}行までです`];
  if (sharesTotal !== null && !isCount(sharesTotal)) errors.push('発行済株式の総数（出資の総額）は0以上の整数で入力してください');
  if (votesTotal !== null && !isCount(votesTotal)) errors.push('議決権の総数は0以上の整数で入力してください');
  for (const x of shareholders) {
    if (typeof x.name !== 'string' || !x.name.trim() || x.name.length > MAX_TEXT) errors.push(`株主の氏名又は法人名は1〜${MAX_TEXT}文字で入力してください`);
    for (const k of ['address', 'relation', 'group']) if (typeof (x[k] ?? '') !== 'string' || (x[k] ?? '').length > MAX_TEXT) errors.push(`株主の住所・続柄・グループは${MAX_TEXT}文字までです`);
    if (!isCount(x.shares)) errors.push('株主の株式数（出資の金額）は0以上の整数で入力してください');
    if (x.votes !== null && x.votes !== undefined && !isCount(x.votes)) errors.push('株主の議決権の数は0以上の整数で入力してください');
  }
  const sum = shareholders.reduce((s, x) => s + (Number(x.shares) || 0), 0);
  if (sharesTotal !== null && sum > sharesTotal) errors.push('株主の株式数の合計が、発行済株式の総数を超えています');
  return [...new Set(errors)];
}

/** 保存する形にそろえる */
export function cleanShareholders(list = []) {
  return (list || []).map((x) => ({
    name: String(x.name ?? '').trim(),
    address: String(x.address ?? '').trim(),
    relation: String(x.relation ?? '').trim(),
    group: String(x.group ?? '').trim(),
    shares: x.shares,
    votes: x.votes === '' || x.votes === undefined ? null : x.votes,
    corporate: Boolean(x.corporate),
  }));
}

/** 割合（1/1000 %、切捨て）。分母が0なら null */
const ratio = (part, whole) => (whole > 0 ? Math.floor((part * 100000) / whole) : null);

/**
 * 別表二の判定
 * @param {{ shareholders, sharesTotal, votesTotal, sme }} p sme：資本金1億円以下の中小法人（特定同族会社にならない）
 * @returns 欄の値（1〜6・10〜14・17・18）と、明細の行（グループごとに順位を付けた株主）
 */
export function familyCompany({ shareholders = [], sharesTotal = null, votesTotal = null, sme = true }) {
  const list = cleanShareholders(shareholders).map((x) => ({ ...x, votes: x.votes ?? x.shares }));
  const total1 = sharesTotal ?? list.reduce((s, x) => s + x.shares, 0);
  const total4 = votesTotal ?? (sharesTotal ?? list.reduce((s, x) => s + x.votes, 0));
  // 株主グループ：判定基準となる株主（グループの名前が空ならその株主自身）と同族関係者
  const groups = new Map();
  for (const x of list) {
    const key = x.group || x.name;
    if (!groups.has(key)) groups.set(key, { key, members: [], shares: 0, votes: 0, otherShares: 0, otherVotes: 0 });
    const g = groups.get(key);
    g.members.push(x);
    g.shares += x.shares;
    g.votes += x.votes;
    // (21)(22) その他の株主等：被支配会社でない法人株主等（(19)(20)）を除いた分。特定同族会社の判定（(11)(13)）はこちらで行う
    if (!x.corporate) {
      g.otherShares += x.shares;
      g.otherVotes += x.votes;
    }
  }
  const all = [...groups.values()];
  const rank = (k) => {
    const sorted = [...all].sort((a, b) => b[k] - a[k]);
    sorted.forEach((g, i) => (g[`${k}Rank`] = i + 1));
    return sorted;
  };
  const byShares = rank('shares');
  const byVotes = rank('votes');
  const top = (sorted, k, n) => sorted.slice(0, n).reduce((s, g) => s + g[k], 0);
  const f = {};
  f[1] = total1;
  f[2] = top(byShares, 'shares', 3);
  f[3] = ratio(f[2], f[1]);
  f[4] = total4;
  f[5] = top(byVotes, 'votes', 3);
  f[6] = ratio(f[5], f[4]);
  f[10] = Math.max(f[3] ?? 0, f[6] ?? 0);
  // 特定同族会社：(11)「(21)の上位1順位」・(13)「(22)の上位1順位」＝被支配会社でない法人株主等を除いて数える
  const topOther = (k) => Math.max(0, ...all.map((g) => g[k]));
  f[11] = topOther('otherShares');
  f[12] = ratio(f[11], f[1]);
  f[13] = topOther('otherVotes');
  f[14] = ratio(f[13], f[4]);
  f[17] = Math.max(f[12] ?? 0, f[14] ?? 0);
  const family = f[10] > 50000;
  const special = family && f[17] > 50000 && !sme;
  f[18] = special ? '特定同族会社' : family ? '同族会社' : '非同族会社';
  // 明細：株式数の順位の順にグループを並べ、グループの中は判定基準となる株主（本人）を先に
  const rows = byShares.flatMap((g) =>
    [...g.members].sort((a, b) => (a.name === g.key ? -1 : b.name === g.key ? 1 : b.shares - a.shares)).map((m, i) => ({ ...m, sharesRank: i === 0 ? g.sharesRank : null, votesRank: i === 0 ? g.votesRank : null, groupShares: g.shares, groupVotes: g.votes })),
  );
  return { fields: f, family, special, rows, groups: byShares, entered: list.length > 0 };
}

/** 割合の表示（51.2%） */
export function formatRatio(r) {
  return r == null ? '' : `${(Math.floor(r / 100) / 10).toFixed(1)}%`;
}
