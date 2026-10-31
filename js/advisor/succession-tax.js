// 事業承継：自社株を引き継ぐときの税金の概算（純粋関数）
//
// 承継先（子・孫・その他の親族・役員や従業員・第三者）ごとに、使える引継ぎ方と税金の目安を出す。
// 金額は整数の円。税率は百分率の整数・千分率で持ち、端数は法令の切捨て（課税価格は千円未満、税額は百円未満）に合わせる。
//
// 出典（2026-10-31 確認）
// - 贈与税（暦年課税）の速算表・基礎控除110万円・特例税率の対象（直系尊属から、その年1月1日に18歳以上）：国税庁 No.4408
//   https://www.nta.go.jp/taxes/shiraberu/taxanswer/zoyo/4408.htm
// - 相続時精算課税（贈与者60歳以上の父母・祖父母、受贈者18歳以上の子・孫、基礎控除110万円（令和6年以後）、特別控除2,500万円、税率20%）：国税庁 No.4103
//   https://www.nta.go.jp/taxes/shiraberu/taxanswer/sozoku/4103_sankou.htm
// - 相続税の速算表：国税庁 No.4155 https://www.nta.go.jp/taxes/shiraberu/taxanswer/sozoku/4155.htm
// - 相続税の基礎控除（3,000万円＋600万円×法定相続人の数）：国税庁 No.4152
// - 相続税額の2割加算（一親等の血族・配偶者以外。代襲相続人の孫は除く）：国税庁 No.4157
//   https://www.nta.go.jp/taxes/shiraberu/taxanswer/sozoku/4157.htm
// - 相続開始前の贈与の加算（3年→7年へ段階的に延長）：国税庁 No.4161 https://www.nta.go.jp/taxes/shiraberu/taxanswer/sozoku/4161.htm
// - 法人版事業承継税制（特例措置）：特例承継計画の提出は令和9年9月30日まで、贈与・相続は令和9年12月31日まで、
//   対象株式の上限なし・猶予割合100%、親族外の後継者も可（最大3人）：中小企業庁
//   https://www.chusho.meti.go.jp/zaimu/shoukei/shoukei_enkatsu_zouyo_souzoku.html
// - 上場していない株式の譲渡所得：所得税15%＋復興特別所得税（所得税の2.1%）＋住民税5%＝20.315%。取得費が分からないときは売った金額の5%（概算取得費）

/** 承継先 */
export const SUCCESSORS = [
  { id: 'child', label: '子' },
  { id: 'grandchild', label: '孫' },
  { id: 'relative', label: 'その他の親族（兄弟・おい・めいなど）' },
  { id: 'employee', label: '役員・従業員（親族外）' },
  { id: 'third', label: '第三者（M&A・会社への売却）' },
];

export const DEFAULT_PLAN = {
  successor: 'child',
  transferShares: null, // 引き継ぐ株式数（null なら発行済株式のすべて）
  giftYears: 1, // 暦年贈与を何年に分けるか（1〜10）
  otherEstate: 0, // 株式以外の財産（相続税の概算に使う。債務を引いた額）
  spouse: true, // 配偶者がいる
  children: 1, // 子の人数（法定相続人）
  salePrice: null, // 売る値段（null なら評価額）
  acquisitionCost: null, // 株式の取得費（null なら資本金等の額を株数で按分）
};

// 速算表：[この額以下, 税率(%), 控除額]
const GIFT_GENERAL = [
  [2000000, 10, 0],
  [3000000, 15, 100000],
  [4000000, 20, 250000],
  [6000000, 30, 650000],
  [10000000, 40, 1250000],
  [15000000, 45, 1750000],
  [30000000, 50, 2500000],
  [Infinity, 55, 4000000],
];
const GIFT_SPECIAL = [
  [2000000, 10, 0],
  [4000000, 15, 100000],
  [6000000, 20, 300000],
  [10000000, 30, 900000],
  [15000000, 40, 1900000],
  [30000000, 45, 2650000],
  [45000000, 50, 4150000],
  [Infinity, 55, 6400000],
];
const INHERITANCE = [
  [10000000, 10, 0],
  [30000000, 15, 500000],
  [50000000, 20, 2000000],
  [100000000, 30, 7000000],
  [200000000, 40, 17000000],
  [300000000, 45, 27000000],
  [600000000, 50, 42000000],
  [Infinity, 55, 72000000],
];
export const GIFT_BASIC = 1100000;
export const SETTLEMENT_SPECIAL = 25000000;
export const SPECIAL_SCHEME_PLAN_DEADLINE = '2027-09-30';
export const SPECIAL_SCHEME_DEADLINE = '2027-12-31';

const floorTo = (n, unit) => Math.floor(n / unit) * unit;
const byTable = (table, base) => {
  const [, rate, ded] = table.find(([lim]) => base <= lim);
  return Math.max(0, Math.floor((base * rate) / 100) - ded);
};

/**
 * 暦年課税の贈与税（1年分）
 * @param {number} amount その年にもらった財産の合計
 * @param {{ special: boolean }} o special：特例税率（直系尊属から18歳以上へ）
 */
export function giftTaxCalendar(amount, { special }) {
  const base = floorTo(Math.max(0, amount - GIFT_BASIC), 1000);
  return floorTo(byTable(special ? GIFT_SPECIAL : GIFT_GENERAL, base), 100);
}

/** 相続時精算課税の贈与税（はじめて使う年。特別控除2,500万円を使い切るまで0） */
export function giftTaxSettlement(amount, { usedSpecial = 0 } = {}) {
  const afterBasic = Math.max(0, amount - GIFT_BASIC);
  const special = Math.min(afterBasic, Math.max(0, SETTLEMENT_SPECIAL - usedSpecial));
  const base = floorTo(afterBasic - special, 1000);
  return { tax: floorTo(Math.floor((base * 20) / 100), 100), special };
}

/**
 * 相続税の総額（法定相続分どおりに分けたとして計算）
 * @param {{ estate: number, spouse: boolean, children: number }} p estate：課税価格の合計（債務を引いた後）
 * @returns {{ heirs, basic, taxable, total }}
 *   子がいないときは配偶者だけを相続人とみなす（父母・兄弟姉妹が相続人になる場合は扱わない）
 */
export function inheritanceTax({ estate, spouse, children }) {
  const heirs = (spouse ? 1 : 0) + children;
  const basic = 30000000 + 6000000 * heirs;
  const taxable = Math.max(0, estate - basic);
  if (!taxable || !heirs) return { heirs, basic, taxable, total: 0 };
  let total = 0;
  if (children > 0) {
    const childShare = floorTo(Math.floor((taxable * (spouse ? 1 : 2)) / 2 / children), 1000);
    total += byTable(INHERITANCE, childShare) * children;
    if (spouse) total += byTable(INHERITANCE, floorTo(Math.floor(taxable / 2), 1000));
  } else {
    total += byTable(INHERITANCE, floorTo(taxable, 1000));
  }
  return { heirs, basic, taxable, total: floorTo(total, 100) };
}

/** 上場していない株式の譲渡所得の税金（所得税・復興特別所得税・住民税） */
export function transferTax({ price, cost }) {
  const usedCost = Math.max(cost || 0, Math.floor((price * 5) / 100));
  const gain = floorTo(Math.max(0, price - usedCost), 1000);
  const income = Math.floor((gain * 15) / 100);
  const national = floorTo(income + Math.floor((income * 21) / 1000), 100);
  const local = floorTo(Math.floor((gain * 5) / 100), 100);
  return { usedCost, gain, national, local, total: national + local, roughCost: usedCost > (cost || 0) };
}

/** 入力の検証 */
export function validatePlan(p) {
  const e = [];
  if (!p || typeof p !== 'object') return ['承継の入力が不正です'];
  const isYen = (n) => Number.isInteger(n) && Math.abs(n) <= 1e15;
  if (!SUCCESSORS.some((s) => s.id === p.successor)) e.push('承継先を選んでください');
  if (p.transferShares !== null && !(Number.isInteger(p.transferShares) && p.transferShares >= 0)) e.push('引き継ぐ株式数は0以上の整数で入れてください');
  if (!(Number.isInteger(p.giftYears) && p.giftYears >= 1 && p.giftYears <= 10)) e.push('贈与を分ける年数は1〜10で入れてください');
  if (!isYen(p.otherEstate)) e.push('株式以外の財産は整数の円で入れてください');
  if (typeof p.spouse !== 'boolean') e.push('配偶者の有無を選んでください');
  if (!(Number.isInteger(p.children) && p.children >= 0 && p.children <= 20)) e.push('子の人数は0〜20で入れてください');
  if (p.salePrice !== null && !(isYen(p.salePrice) && p.salePrice >= 0)) e.push('売る値段は0以上の整数の円で入れてください');
  if (p.acquisitionCost !== null && !(isYen(p.acquisitionCost) && p.acquisitionCost >= 0)) e.push('取得費は0以上の整数の円で入れてください');
  return e;
}

/**
 * 承継先に合わせた引継ぎ方と税金の目安
 * @param {object} p
 * @param {object} p.plan DEFAULT_PLAN の形
 * @param {number} p.price 1株の評価額（shareValuation の price）
 * @param {number} p.shares 発行済株式数
 * @param {number} p.capital 資本金等の額（取得費の目安に使う）
 * @param {string} p.today YYYY-MM-DD（事業承継税制の期限の判定）
 * @returns {{ value, shares, options: Array, inheritance, ideas: Array }}
 *   options：{ id, label, tax, payer, cash, deferred, note, warn }。tax は納める税金の合計（猶予されるものは deferred に）
 */
export function successionOptions({ plan, price, shares, capital, today }) {
  const v = { ...DEFAULT_PLAN, ...plan };
  const n = v.transferShares === null ? shares : Math.min(v.transferShares, shares);
  const value = price * n;
  const s = v.successor;
  const lineal = s === 'child' || s === 'grandchild'; // 直系卑属（特例税率・精算課税の対象）
  const schemeOpen = today <= SPECIAL_SCHEME_DEADLINE;
  const options = [];

  if (s !== 'third') {
    // 暦年贈与（年数で均等に分ける）
    const years = v.giftYears;
    const per = Math.floor(value / years);
    const last = value - per * (years - 1);
    const special = lineal;
    const tax = giftTaxCalendar(per, { special }) * (years - 1) + giftTaxCalendar(last, { special });
    options.push({
      id: 'gift',
      label: years > 1 ? `暦年贈与（${years}年に分ける）` : '暦年贈与（1回で）',
      tax,
      payer: '後継者（贈与税）',
      cash: tax,
      note: `${special ? '特例税率（直系尊属から18歳以上へ）' : '一般税率'}。毎年110万円の基礎控除。${years > 1 ? '毎年の贈与の合意が必要で、株価が上がると後の年の税金が増えます。' : ''}`,
      warn: '贈与した人が亡くなると、相続前の一定期間（令和13年以後は7年）の贈与は相続財産に足し戻されます。',
    });
    if (lineal) {
      const st = giftTaxSettlement(value);
      options.push({
        id: 'settlement',
        label: '相続時精算課税で贈与',
        tax: st.tax,
        payer: '後継者（贈与税）',
        cash: st.tax,
        note: '贈与する人が60歳以上・もらう人が18歳以上。110万円を引いたあと、2,500万円までは贈与税がかからず、超えた分は20%。',
        warn: '一度選ぶと、その人からの贈与は暦年課税に戻せません。相続のときは贈与のときの価額（基礎控除を除く）を足し戻して相続税を計算し、払った贈与税は差し引かれます。株価が上がる見込みなら、今の低い価額で固定できます。',
      });
    }
    // 相続・遺贈
    const estate = value + v.otherEstate;
    const inh = inheritanceTax({ estate, spouse: v.spouse, children: v.children });
    const share = estate > 0 ? Math.floor((inh.total * value) / estate) : 0;
    const surcharge = s === 'child' ? 0 : Math.floor(share / 5);
    options.push({
      id: 'inherit',
      label: s === 'child' ? '相続で引き継ぐ' : '遺言で引き継ぐ（遺贈）',
      tax: share + surcharge,
      payer: '後継者（相続税）',
      cash: share + surcharge,
      note: `相続税の総額 ${inh.total.toLocaleString('ja-JP')}円のうち、株式の割合で按分した目安${surcharge ? '。一親等の血族・配偶者以外なので2割加算' : ''}。`,
      warn: s === 'child' ? 'ほかの相続人の遺留分に注意します（経営承継円滑化法の遺留分の特例があります）。' : '相続人でない人に株式を遺すには遺言が必要です。ほかの相続人の遺留分に注意します。',
    });
    // 法人版事業承継税制（特例措置）
    const base = lineal ? Math.min(options[0].tax, options[1]?.tax ?? Infinity) : options[0].tax;
    options.push({
      id: 'scheme',
      label: '事業承継税制（特例措置）で贈与',
      tax: 0,
      deferred: base,
      payer: '—（要件を守る間は猶予）',
      cash: 0,
      disabled: !schemeOpen,
      note: schemeOpen
        ? `株式の贈与税・相続税が全額猶予されます（親族外の後継者も可）。特例承継計画を${slashDate(SPECIAL_SCHEME_PLAN_DEADLINE)}までに都道府県へ出し、${slashDate(SPECIAL_SCHEME_DEADLINE)}までに贈与・相続することが条件です。`
        : '特例措置の期限（令和9年12月31日）を過ぎています。一般措置（対象は議決権の3分の2まで、相続税の猶予は80%）の検討になります。',
      warn: '後継者は代表者で、贈与のときは役員を3年以上。贈与後も株式を持ち続ける・代表者を続けるなどの要件を外れると、猶予された税金と利子税を納めます。都道府県の認定と、毎年・3年ごとの報告が必要です。',
    });
  }
  if (s === 'relative' || s === 'employee' || s === 'third') {
    const sale = v.salePrice ?? value;
    const cost = v.acquisitionCost ?? (shares > 0 ? Math.floor((capital * n) / shares) : 0);
    const t = transferTax({ price: sale, cost });
    options.push({
      id: 'sale',
      label: s === 'third' ? '株式を売る（M&A）' : '株式を買い取ってもらう',
      tax: t.total,
      payer: '今の株主（譲渡所得の税金）',
      cash: s === 'third' ? 0 : sale,
      note: `売る値段 ${sale.toLocaleString('ja-JP')}円、取得費 ${t.usedCost.toLocaleString('ja-JP')}円${t.roughCost ? '（売る値段の5%の概算取得費）' : ''}で、税率20.315%（所得税・復興特別所得税15.315%＋住民税5%）。`,
      warn:
        s === 'third'
          ? '売る値段は交渉で決まります（評価額は目安）。役員退職金を組み合わせると、退職所得（2分の1課税）になって手取りが増える場合があります。'
          : '後継者は買い取る資金が要ります（日本政策金融公庫の事業承継の融資、会社からの役員報酬の引上げなど）。個人間の売買の値段が時価より低いと、差額に贈与税がかかることがあります。',
    });
  }
  return { value, shares: n, options, ideas: ideasFor(s, schemeOpen) };
}

const slashDate = (d) => {
  const [y, m, day] = d.split('-').map(Number);
  return `令和${y - 2018}年${m}月${day}日`;
};

/** 承継先ごとに使えそうな税制・対策 */
function ideasFor(s, schemeOpen) {
  const ideas = [];
  if (s !== 'third' && schemeOpen) ideas.push({ title: '事業承継税制（特例措置）', text: `株式の贈与税・相続税を全額猶予。まず特例承継計画を${slashDate(SPECIAL_SCHEME_PLAN_DEADLINE)}までに提出（認定支援機関の所見が必要）。`, url: 'https://www.chusho.meti.go.jp/zaimu/shoukei/shoukei_enkatsu_zouyo_souzoku.html' });
  if (s === 'child' || s === 'grandchild') ideas.push({ title: '相続時精算課税', text: '株価が上がる会社は、低いうちに精算課税で贈与すると相続のときの価額が固定されます。', url: 'https://www.nta.go.jp/taxes/shiraberu/taxanswer/sozoku/4103_sankou.htm' });
  if (s !== 'third') ideas.push({ title: '株価を下げてから引き継ぐ', text: '役員退職金の支給などで利益と純資産が下がった期の翌期に贈与すると、評価額が下がります（上の「株価対策の目安」）。' });
  if (s === 'child' || s === 'grandchild' || s === 'relative') ideas.push({ title: '遺留分の特例（経営承継円滑化法）', text: '後継者がもらった株式を遺留分の計算から外す（除外合意）・贈与のときの価額で固定する（固定合意）ことができます。推定相続人全員の合意と家庭裁判所の許可が必要です。' });
  if (s === 'employee') ideas.push({ title: '株式を一度に移さない', text: '議決権のある株式を後継者に、配当優先の無議決権株式を親族に分ける（種類株式）、持株会をつくるなどで、後継者の資金負担を抑えられます。' });
  if (s === 'employee' || s === 'third') ideas.push({ title: '事業承継・引継ぎ支援センター', text: '各都道府県にある国の相談窓口。親族外承継・M&Aの相手探しや進め方を無料で相談できます。' });
  if (s === 'third') ideas.push({ title: '役員退職金と株式の売却の組合せ', text: '退職金は退職所得（勤続年数に応じた控除のあと2分の1課税）で、会社の利益と株価も下がります。売る値段との組合せで手取りを比べます。' });
  return ideas;
}
