// 経営サポート：節税・税制の提案（純粋関数）
//
// 着地見込みの仕訳（実績＋予測）をもとに、決算までに打てる手・来期から使える制度を並べ、
// それぞれ「税金がいくら減るか」を、納税予測（tax-forecast.js）をもう一度計算して差で求める。
// - 費用になるもの（経営セーフティ共済・少額減価償却資産・決算賞与・短期前払費用）：期末に費用の仕訳を1本足して計算し直す
// - 所得控除（小規模企業共済・iDeCo）：確定申告書の入力（period.incomeTaxReturn.smallBusinessAid）に足して計算し直す
// - 青色申告特別控除：青色申告決算書の控除額（period.blueReturn.deduction）を変えて計算し直す
// - 消費税の計算方法：納税予測の比較（taxes.consumption.compare）から、いちばん少ない方法との差を出す
// 「税金」は法人税等（法人）・所得税と個人事業税（個人）の年税額。消費税と、個人の住民税は含めない
// 制度の数字の出典は各提案の sources に持たせ、画面に出す。数字は令和8年10月時点で確認したもの
import { forecastTaxes } from './tax-forecast.js';
import { smeUsage, smeLimit } from '../depreciation.js';
import { blueDeductionOptions } from '../blue-return.js';
import { isWhite } from '../white-return.js';
import { TAX_METHOD_BY_ID } from '../tax-return.js';

/** 経営セーフティ共済の掛金の上限（月20万円×12か月） */
export const SAFETY_ANNUAL_MAX = 2400000;
/** 小規模企業共済の掛金の上限（月7万円×12か月） */
export const SHOKIBO_ANNUAL_MAX = 840000;
/** iDeCo（第1号加入者）の掛金の上限（年額）。2026年12月分（2027年1月引落し）から月7.5万円 */
export function idecoAnnualMax(year) {
  return year >= 2027 ? 900000 : 816000;
}
/** 限界税率を見るときに足す費用 */
export const MARGINAL_STEP = 1000000;

const SRC = {
  safety: { label: '経営セーフティ共済 掛金について（中小機構）', url: 'https://kyosai-web.smrj.go.jp/customer/tkyosai/installment/index.html' },
  sme: { label: 'No.5408 中小企業者等の少額減価償却資産の取得価額の損金算入の特例（国税庁）', url: 'https://www.nta.go.jp/taxes/shiraberu/taxanswer/hojin/5408.htm' },
  smeIndividual: { label: 'No.2100 減価償却のあらまし（国税庁）', url: 'https://www.nta.go.jp/taxes/shiraberu/taxanswer/shotoku/2100.htm' },
  prepaid: { label: '法人税基本通達2-2-14 短期の前払費用（国税庁）', url: 'https://www.nta.go.jp/law/tsutatsu/kihon/hojin/02/02_02_02.htm' },
  officer: { label: 'No.5211 役員に対する給与（国税庁）', url: 'https://www.nta.go.jp/taxes/shiraberu/taxanswer/hojin/5211.htm' },
  shokibo: { label: '小規模企業共済 掛金について（中小機構）', url: 'https://kyosai-web.smrj.go.jp/customer/skyosai/installment/index.html' },
  blue: { label: 'No.2072 青色申告特別控除（国税庁）', url: 'https://www.nta.go.jp/taxes/shiraberu/taxanswer/shotoku/2072.htm' },
};

/** 効果の性質 */
export const NATURE_LABELS = {
  deferral: '税金の先送り（受け取るときに課税）',
  timing: '費用の前倒し（翌期以後の費用が減る）',
  expense: '費用が増える（お金も出ていく）',
  deduction: '所得控除（受け取るときに課税・優遇あり）',
  method: '計算方法の選択',
};

/** いつ打てる手か */
export const TIMING_LABELS = {
  now: '決算までに',
  filing: '申告のときに',
  next: '来期から',
};

const yen = (n) => `${n.toLocaleString('ja-JP')}円`;
const floorTo = (n, unit) => Math.max(0, Math.floor(n / unit) * unit);

/** 費用を1本足すための科目（雑費。無ければ販管費・経費のどれか）と相手（現金・預金） */
function simAccounts(accounts) {
  const expense = accounts.find((a) => a.hint === 'misc_expense' && a.active) || accounts.find((a) => a.group === 'sga' && a.active);
  const cash = accounts.find((a) => a.role === 'cash' && a.active) || accounts.find((a) => a.role === 'deposit' && a.active);
  return { expense, cash };
}

/**
 * 節税・税制の提案
 * @param {object} p
 * @param {object} p.settings
 * @param {Array} p.accounts
 * @param {object} p.period
 * @param {Array} p.journals 着地見込みの仕訳（forecastLanding の journals）
 * @param {Array} p.actualJournals 帳簿の仕訳
 * @param {Array} [p.assets] 固定資産（少額特例の使った額）
 * @param {object} [p.amounts] 提案ごとに画面で入れた金額 { [id]: 円 }（保存しない）
 * @returns {{ base, marginal, proposals: Array, income }}
 *   base：今の着地での税金（incomeTaxes）。marginal：費用を MARGINAL_STEP 足したときに減る税金と、その割合（‰）
 *   proposals：[{ id, title, timing, nature, summary, applicable, reason, amount, max, editable, saving, cash, requirements, cautions, sources }]
 *     saving：減る税金（円）、cash：出ていくお金（円。所得控除・計算方法は掛金・0）
 */
export function taxSavingPlan({ settings, accounts, period, journals, actualJournals, assets = [], amounts = {} }) {
  const corp = settings.entityType === 'corporation';
  const year = Number(period.endDate.slice(0, 4));
  const base = forecastTaxes({ settings, accounts, period, journals, actualJournals });
  const { expense, cash } = simAccounts(accounts);
  const canSim = Boolean(expense && cash);
  const taxesOf = (r) => r.incomeTaxes;

  /** 期末に費用 amount を足したときに減る税金 */
  const savingByExpense = (amount) => {
    if (!(amount > 0) || !canSim) return 0;
    const memo = '節税の試算';
    const extra = {
      id: 'forecast:tax_saving',
      periodId: period.id,
      date: period.endDate,
      source: 'forecast',
      adjusting: true,
      lines: [
        { side: 'debit', accountId: expense.id, subAccountId: null, amount, taxCategory: 'none', memo },
        { side: 'credit', accountId: cash.id, subAccountId: null, amount, taxCategory: 'none', memo },
      ],
    };
    return taxesOf(base) - taxesOf(forecastTaxes({ settings, accounts, period, journals: [...journals, extra], actualJournals }));
  };
  /** 期間の入力を変えたときに減る税金（settingsPatch は青色・白色の切替） */
  const savingByPeriod = (patch, settingsPatch = null) => {
    const p = { ...period, ...patch };
    const s = settingsPatch ? { ...settings, ...settingsPatch } : settings;
    return taxesOf(base) - taxesOf(forecastTaxes({ settings: s, accounts, period: p, journals, actualJournals }));
  };

  // 「所得」：法人は所得金額、個人は事業所得（青色申告特別控除後）。提案の金額の目安に使う
  const income = corp ? base.taxableIncome || 0 : base.pl.profits.businessIncome ?? base.pretax;
  const marginalSaving = savingByExpense(MARGINAL_STEP);
  const marginal = { amount: MARGINAL_STEP, saving: marginalSaving, permille: Math.floor((marginalSaving * 1000) / MARGINAL_STEP) };

  const proposals = [];
  const pick = (id, suggested, max) => {
    const v = amounts[id];
    const amount = Number.isInteger(v) && v >= 0 ? v : suggested;
    return max == null ? amount : Math.min(amount, max);
  };
  const noProfit = income <= 0 ? '所得が出ない見込みなので、いま費用を増やしても税金は減りません。' : '';

  // ---- 経営セーフティ共済（法人・個人の事業所得） ----
  {
    const amount = pick('safety', floorTo(Math.min(SAFETY_ANNUAL_MAX, income), 5000 * 12), SAFETY_ANNUAL_MAX);
    proposals.push({
      id: 'safety',
      title: '経営セーフティ共済（中小企業倒産防止共済）の掛金',
      timing: 'now',
      nature: 'deferral',
      summary: `掛金は月5,000円〜20万円（年${yen(SAFETY_ANNUAL_MAX)}まで、掛金の合計800万円まで）。払った掛金は${corp ? '損金' : '事業所得の必要経費'}になります。1年分までの前納も、払った期の${corp ? '損金' : '必要経費'}にできます。`,
      applicable: !noProfit,
      reason: noProfit,
      amount,
      max: SAFETY_ANNUAL_MAX,
      editable: true,
      saving: savingByExpense(amount),
      cash: amount,
      requirements: ['期末までに加入して掛金を払う（前納は1年分まで）', corp ? '申告書に損金算入の明細書を付ける' : '確定申告で必要経費に入れる（事業所得だけ。不動産所得には入れられない）'],
      cautions: ['解約したときの解約手当金は、受け取った期の益金（個人は事業所得の収入）になります。税金を先に送る仕組みです', '掛金を払った月数が短いうちに解約すると、掛金より少なく戻るか、戻りません', '令和6年10月1日以後に解約して入り直すと、解約日から2年間に払った掛金は経費になりません'],
      sources: [SRC.safety],
    });
  }

  // ---- 少額減価償却資産の特例（青色申告の中小企業者等） ----
  {
    const sme = corp ? (period.corporateTax?.sme ?? true) : !isWhite(settings);
    const usage = smeUsage(assets, period);
    const room = Math.max(0, usage.limit - usage.total);
    const limitNow = smeLimit(period.endDate);
    const amount = pick('sme', room, room);
    const reason = !sme ? (corp ? '中小法人でない設定なので、この特例は使えません。' : '白色申告では使えません（10万円未満のものは全額を経費にできます）。') : room === 0 ? `当期の上限（${yen(usage.limit)}）まで使っています。` : noProfit;
    proposals.push({
      id: 'sme',
      title: '少額減価償却資産の特例（1つ40万円未満を全額経費）',
      timing: 'now',
      nature: 'timing',
      summary: `必要な備品・パソコンなどを期末までに買って使い始めると、1つ${yen(limitNow)}未満（令和8年3月31日までの取得は30万円未満）なら全額をその期の${corp ? '損金' : '必要経費'}にできます。合計は年${yen(usage.limit)}まで（当期に使った額 ${yen(usage.total)}）。`,
      applicable: !reason,
      reason,
      amount,
      max: room,
      editable: true,
      saving: sme ? savingByExpense(amount) : 0,
      cash: amount,
      requirements: ['期末までに買って事業に使い始める（買っただけでは対象外）', corp ? '損金経理をして、申告書に別表十六(七)を付ける' : '青色申告決算書の減価償却の明細に書く', '固定資産の画面で償却方法を「少額減価償却資産の特例」にする'],
      cautions: ['税金は減っても、払ったお金のほうが大きいので、手元のお金は減ります。必要なものだけにしてください', '翌期以後の減価償却費は、その分だけ減ります'],
      sources: [corp ? SRC.sme : SRC.smeIndividual],
    });
  }

  // ---- 決算賞与（法人の使用人） ----
  if (corp) {
    const amount = pick('bonus', floorTo(Math.min(1000000, income), 10000), null);
    proposals.push({
      id: 'bonus',
      title: '決算賞与（従業員への賞与）',
      timing: 'now',
      nature: 'expense',
      summary: '期末までに支給額を決めて従業員に知らせ、期末の翌日から1か月以内に払えば、期末に未払いでも当期の損金にできます。',
      applicable: !noProfit,
      reason: noProfit,
      amount,
      max: null,
      editable: true,
      saving: savingByExpense(amount),
      cash: amount,
      requirements: ['支給額を各人別に、同じ時期に支給するすべての従業員に期末までに通知する', '通知した額を期末の翌日から1か月以内に払う', '通知した期に損金経理する（法人税法施行令72条の3第2号）'],
      cautions: ['役員への賞与は、事前確定届出給与の届出が無ければ損金になりません', '社会保険料の会社負担も増えます（試算に含めていません）', 'お金は全額出ていきます。人件費として意味のある額かで決めてください'],
      sources: [],
    });
  }

  // ---- 短期前払費用 ----
  {
    const amount = pick('prepaid', 0, null);
    proposals.push({
      id: 'prepaid',
      title: '短期前払費用（家賃・保険料などの1年分の前払い）',
      timing: 'now',
      nature: 'timing',
      summary: `契約に基づいて毎月受けるサービス（家賃・保険料など）の1年以内の分を前払いし、毎期続けてその期の${corp ? '損金' : '必要経費'}にしているなら、払った期の費用にできます。効果が出るのは始めた期だけです。`,
      applicable: !noProfit,
      reason: noProfit,
      amount,
      max: null,
      editable: true,
      saving: savingByExpense(amount),
      cash: amount,
      requirements: ['契約で前払いができること（年払いの契約にする）', '払った日から1年以内に受けるサービスの分だけ', '毎期同じやり方を続ける'],
      cautions: ['借入金の利息のように、売上と対応させるものには使えません', '翌期からは毎年12か月分の費用に戻るので、税金が減るのは始めた期だけです'],
      sources: corp ? [SRC.prepaid] : [],
    });
  }

  // ---- 役員報酬の見直し（法人・来期） ----
  if (corp) {
    proposals.push({
      id: 'officer',
      title: '来期の役員報酬の見直し',
      timing: 'next',
      nature: 'expense',
      summary: '役員報酬は、期首から3か月以内に改定し、毎月同じ額で払えば損金になります（定期同額給与）。期の途中で増やした分は損金になりません。着地の利益を見て、来期の額を決めるときの材料にしてください。',
      applicable: true,
      reason: '',
      amount: 0,
      max: null,
      editable: false,
      saving: 0,
      cash: 0,
      requirements: ['期首から3か月以内に株主総会などで決める', '改定の前後で毎月同じ額を払う'],
      cautions: ['役員報酬を増やすと、会社の税金は減りますが、個人の所得税・住民税と社会保険料が増えます。合計で比べてください（この画面では計算していません）'],
      sources: [SRC.officer],
    });
  }

  // ---- 小規模企業共済・iDeCo（個人） ----
  if (!corp) {
    const entered = period.incomeTaxReturn?.smallBusinessAid || 0;
    const input = period.incomeTaxReturn || {};
    const withAid = (add) => ({ incomeTaxReturn: { ...input, smallBusinessAid: entered + add } });
    {
      const room = Math.max(0, SHOKIBO_ANNUAL_MAX - entered);
      const amount = pick('shokibo', room, SHOKIBO_ANNUAL_MAX);
      proposals.push({
        id: 'shokibo',
        title: '小規模企業共済の掛金',
        timing: 'now',
        nature: 'deduction',
        summary: `掛金は月1,000円〜7万円（年${yen(SHOKIBO_ANNUAL_MAX)}まで）で、全額が所得控除（小規模企業共済等掛金控除）になります。1年以内の前納もその年の控除にできます。${entered ? `確定申告書の画面ですでに ${yen(entered)}（iDeCoを含む）を入れています。` : ''}`,
        applicable: amount > 0,
        reason: amount > 0 ? '' : 'すでに上限まで入れています。',
        amount,
        max: SHOKIBO_ANNUAL_MAX,
        editable: true,
        saving: amount > 0 ? savingByPeriod(withAid(amount)) : 0,
        cash: amount,
        requirements: ['常時使用する従業員が20人以下（商業・サービス業は5人以下）の個人事業主など', '12月31日までに掛金を払う（前納は1年分まで）'],
        cautions: ['住民税も、控除した額のおよそ10%減ります（この試算には含めていません）', '受け取る共済金は、退職所得・公的年金等の雑所得として課税されます（優遇あり）。掛金を払った月数が短いうちに解約すると、掛金より少なく戻ります', '事業の経費ではないので、個人事業税は減りません'],
        sources: [SRC.shokibo],
      });
    }
    {
      const max = idecoAnnualMax(year + 1);
      const amount = pick('ideco', max, max);
      proposals.push({
        id: 'ideco',
        title: 'iDeCo（個人型確定拠出年金）の掛金',
        timing: 'next',
        nature: 'deduction',
        summary: `自営業の人（第1号加入者）は、国民年金基金・付加保険料と合わせて月6.8万円まで。2026年12月分（2027年1月の引落し）からは月7.5万円になります。掛金は全額が所得控除です。前納はできないので、早く始めるほど1年の控除が大きくなります。下の税額は、当期の所得で年${yen(max)}を払ったときの目安です。`,
        applicable: true,
        reason: '',
        amount,
        max,
        editable: true,
        saving: amount > 0 ? savingByPeriod(withAid(amount)) : 0,
        cash: amount,
        requirements: ['国民年金の保険料を納めている', '金融機関で申し込む（加入まで1〜2か月かかる）'],
        cautions: ['原則60歳まで引き出せません', '住民税も、控除した額のおよそ10%減ります（試算に含めていません）'],
        sources: [],
      });
    }
  }

  // ---- 青色申告特別控除（個人） ----
  if (!corp) {
    if (isWhite(settings)) {
      const best = 650000;
      proposals.push({
        id: 'blue',
        title: '青色申告にする（青色申告特別控除）',
        timing: 'next',
        nature: 'deduction',
        summary: `青色申告にすると、複式簿記で記帳して e-Tax で申告すれば最大${yen(best)}を所得から引けます。ほかにも家族への給与（青色事業専従者給与）・赤字の繰越し・少額減価償却資産の特例が使えます。下の税額は、当期を65万円控除の青色で申告したときの目安です。`,
        applicable: true,
        reason: '',
        amount: best,
        max: null,
        editable: false,
        saving: savingByPeriod({ blueReturn: { ...(period.blueReturn || {}), deduction: best } }, { filing: 'blue' }),
        cash: 0,
        requirements: ['青色申告をしたい年の3月15日まで（その年の1月16日以後に開業したときは開業から2か月以内）に、青色申告承認申請書を税務署に出す'],
        cautions: [],
        sources: [SRC.blue],
      });
    } else {
      const options = blueDeductionOptions(year);
      const best = options[0].value;
      const now = period.blueReturn?.deduction ?? 650000;
      if (now < best) {
        proposals.push({
          id: 'blue',
          title: `青色申告特別控除を${yen(best)}にする`,
          timing: 'filing',
          nature: 'deduction',
          summary: `いまは${yen(now)}の設定です。${options[0].label}にすると、控除が${yen(best - now)}増えます。`,
          applicable: true,
          reason: '',
          amount: best - now,
          max: null,
          editable: false,
          saving: savingByPeriod({ blueReturn: { ...(period.blueReturn || {}), deduction: best } }),
          cash: 0,
          requirements: year >= 2027 ? ['複式簿記で記帳し、e-Tax で申告する', '75万円は、さらに優良な電子帳簿の要件を満たして届出を出す'] : ['複式簿記で記帳し、e-Tax で申告する（または優良な電子帳簿で保存して届出を出す）', '申告期限（3月15日）までに出す'],
          cautions: ['控除できるのは、事業所得・不動産所得の黒字までです'],
          sources: [SRC.blue],
        });
      }
    }
  }

  // ---- 消費税の計算方法 ----
  const c = base.consumption;
  if (c) {
    const current = c.compare[c.method];
    const candidates = Object.entries(c.compare).filter(([id, r]) => id !== c.method && !r.unavailable);
    const best = candidates.sort((a, b) => a[1].total - b[1].total)[0];
    if (current && best && best[1].total < current.total) {
      const [id] = best;
      const label = TAX_METHOD_BY_ID[id]?.label || id;
      const filing = id === 'twenty' || id === 'thirty';
      proposals.push({
        id: 'consumption',
        title: `消費税を${label}で計算する`,
        timing: filing ? 'filing' : 'next',
        nature: 'method',
        summary: `着地の数字では、いまの${TAX_METHOD_BY_ID[c.method]?.label || c.method}より${label}のほうが、消費税が${yen(current.total - best[1].total)}少なくなります。`,
        applicable: true,
        reason: '',
        amount: 0,
        max: null,
        editable: false,
        saving: current.total - best[1].total,
        cash: 0,
        consumption: true,
        requirements: filing ? ['届出は不要で、申告書に書いて選ぶ'] : ['原則、適用したい課税期間が始まる前の日までに消費税簡易課税制度選択届出書を出す', '基準期間の課税売上高が5,000万円以下であること'],
        cautions: filing ? [] : ['簡易課税を選ぶと、2年間はやめられません。大きな設備投資を予定しているときは一般課税のほうが有利なこともあります'],
        sources: [],
      });
    }
  }

  return { base, marginal, proposals, income, canSim };
}
