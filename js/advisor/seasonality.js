// 経営サポート：前期の推移から、季節変動と特別な支出（賞与・保険の年払いなど）を見つけて助言する（純粋関数）
//
// 着地見込みの行（forecastLanding の rows。prevMonthly＝前期の同じ月の発生額、決算整理を除く）を見る。
// 1. 特別な月：前期のある月が、その科目のふだんの月（中央値）の2倍以上で、年間の8%以上・5万円以上
//    → 賞与・保険や会費の年払い・更新料・修繕などの、決まった月の支出（収入）かもしれない
// 2. 季節変動：売上の月ごとの差が大きい（月平均からのばらつき＝変動係数が20%以上）→ 多い月・少ない月を示す
// その月が見込みの月にあり、いまの見込みが前期の半分に届かなければ「見込みに入っていない」と知らせる
// 判定の数字は目安（会計ソフト・税理士事務所の月次の見方を参考に決めた。法令の基準ではない）

export const SPIKE_RATIO = 2; // ふだんの月の何倍以上を「特別な月」とするか
export const SPIKE_SHARE = 80; // 年間に占める割合（‰）
export const SPIKE_MIN = 50000;
export const SEASONAL_CV = 200; // 売上の変動係数（‰）
export const MISSING_SHARE = 500; // 見込みが前期の何‰未満なら「入っていない」とするか

const median = (xs) => {
  const s = [...xs].sort((a, b) => a - b);
  const n = s.length;
  if (!n) return 0;
  return n % 2 ? s[(n - 1) / 2] : Math.round((s[n / 2 - 1] + s[n / 2]) / 2);
};

/** 科目から、特別な月の理由の候補を言葉にする */
function guessReason(account) {
  const n = account.name || '';
  if (account.hint === 'bonuses' || /賞与/.test(n)) return '賞与';
  if (/保険/.test(n)) return '保険料の年払い';
  if (/家賃|地代/.test(n)) return '更新料・年払い';
  if (/修繕/.test(n)) return '修繕';
  if (/租税|公課/.test(n)) return '税金の納付（固定資産税・自動車税など）';
  if (/会費|諸会費/.test(n)) return '年会費';
  if (/法定福利/.test(n)) return '賞与の社会保険料・労働保険料の年度更新';
  if (/広告|宣伝/.test(n)) return '催事・広告の集中';
  if (account.group === 'sales') return '季節の需要・大口の取引';
  return '決まった月の支出';
}

/**
 * 季節変動・特別な月の助言
 * @param {object} p
 * @param {object} p.landing forecastLanding の結果
 * @returns {Array<{ kind: 'special'|'seasonal', account, months: Array<{ month, prev, forecast, actual, missing }>, reason, message, missing }>}
 *   months：該当する当期の月（前期の同じ月の金額 prev、いまの見込み forecast、実績の月なら actual=true）
 *   missing：見込みの月にあるのに、いまの見込みが前期の半分に届かない
 */
export function seasonalAdvice({ landing }) {
  const { months, actualMonths } = landing;
  const isActual = new Set(actualMonths);
  const out = [];
  for (const r of landing.rows) {
    const prev = r.prevMonthly;
    if (!prev) continue;
    const total = prev.reduce((s, x) => s + x, 0);
    if (total <= 0) continue;
    const info = (i) => {
      const m = months[i];
      const forecast = r.forecastMonthly?.[m] || 0;
      const actual = isActual.has(m);
      const missing = !actual && forecast * 1000 < prev[i] * MISSING_SHARE;
      return { month: m, prev: prev[i], forecast, actual, missing };
    };

    // ---- 特別な月 ----
    const med = median(prev);
    const spikes = prev
      .map((x, i) => [x, i])
      .filter(([x]) => x >= SPIKE_MIN && x * 1000 >= total * SPIKE_SHARE && x >= Math.max(1, med) * SPIKE_RATIO)
      .map(([, i]) => i);
    const isSales = r.account.group === 'sales';
    if (spikes.length && spikes.length <= 3 && !isSales) {
      const list = spikes.map(info);
      const reason = guessReason(r.account);
      const times = med > 0 ? `ふだんの月の約${Math.round(Math.max(...spikes.map((i) => prev[i])) / med)}倍` : 'ほかの月はほとんど無し';
      out.push({
        kind: 'special',
        account: r.account,
        months: list,
        reason,
        missing: list.some((x) => x.missing),
        message: `前期は${list.map((x) => `${Number(x.month.slice(5))}月 ${x.prev.toLocaleString('ja-JP')}円`).join('・')}（${times}）。${reason}かもしれません。`,
      });
      continue;
    }

    // ---- 季節変動（売上） ----
    if (isSales && prev.length >= 6) {
      const mean = total / prev.length;
      const variance = prev.reduce((s, x) => s + (x - mean) ** 2, 0) / prev.length;
      const cv = Math.round((Math.sqrt(variance) * 1000) / mean);
      if (cv < SEASONAL_CV) continue;
      const order = prev.map((x, i) => [x, i]).sort((a, b) => b[0] - a[0]);
      const high = order.slice(0, 2).map(([, i]) => i).sort((a, b) => a - b);
      const low = order.slice(-2).map(([, i]) => i).sort((a, b) => a - b);
      const list = high.map(info);
      const pct = (i) => Math.round((prev[i] * 100) / mean);
      out.push({
        kind: 'seasonal',
        account: r.account,
        months: list,
        low: low.map(info),
        reason: guessReason(r.account),
        missing: list.some((x) => x.missing),
        message: `前期は月によって差が大きく、多い月は${high.map((i) => `${Number(months[i].slice(5))}月（平均の${pct(i)}%）`).join('・')}、少ない月は${low.map((i) => `${Number(months[i].slice(5))}月（${pct(i)}%）`).join('・')}でした。`,
      });
    }
  }
  // 見込みに入っていないものを先に、その中は金額の大きい順
  const size = (a) => Math.max(...a.months.map((x) => x.prev));
  return out.sort((a, b) => Number(b.missing) - Number(a.missing) || size(b) - size(a));
}

/** 助言の科目を「前期の同じ月×伸び率」にしたときに見込みが変わるか（ボタンを出すかの判定） */
export function adviceSuggestsLastYear(advice, row) {
  return advice.missing && row && row.method !== 'last_year' && row.method !== 'monthly';
}
