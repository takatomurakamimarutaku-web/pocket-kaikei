// 勘定科目内訳明細書（法人）：帳簿の残高・補助科目・仕訳から各内訳書の行を作る（純粋関数）
//
// 内訳書の種類と並びは国税庁「勘定科目内訳明細書」の様式による（2026-10-29 確認）
//   https://www.e-tax.nta.go.jp/hojin/gimuka/csv_jyoho2_meisai_20240325a.htm （令和6年3月1日以後終了事業年度分の標準フォーム）
//   記載内容の簡素化：https://www.e-tax.nta.go.jp/hojin/gimuka/kansoka.pdf ・ https://www.e-tax.nta.go.jp/hojin/gimuka/kansokajiko_ichiran.pdf
// 相手先は補助科目で分ける（補助科目の名前を相手先・金融機関・銘柄などとして使う）。
// 所在地・法人との関係・利率・担保・振出日などの帳簿に無い欄は、書き出した後に手で記入する。
// 科目は目印（hint）・役割（role）で選ぶ（名前では判定しない）。
// ⑫土地の売上高等・⑮権利金等の期中支払・⑮工業所有権等の使用料は、決まった科目が無いため利用者が選んだ科目（補助科目）の仕訳から作る。
//   欄は標準フォームの記録項目による：HOI120（⑫）https://www.e-tax.nta.go.jp/hojin/gimuka/csv_jyoho1/10/HOI120.pdf
//   HOI130（⑬）https://www.e-tax.nta.go.jp/hojin/gimuka/csv_jyoho1/10/HOI130.pdf ・ HOI150（⑮）https://www.e-tax.nta.go.jp/hojin/gimuka/csv_jyoho1/10/HOI150.pdf
// ⑬売上高等の事業所別は、事業所を帳簿で分けていないため、損益計算書の売上高と期末棚卸高の合計を1行にする。
// 金額基準（相手先別に50万円以上は各別、その他は一括など）は弥生会計・勘定奉行の内訳書の既定と同じ考え方で、
// 基準未満の相手先を「その他（N件）」にまとめる。すべて表示にもできる。
import { trialBalance } from './ledger.js';

/** 内訳書の定義。threshold：各別に書く金額の基準（未満は「その他」にまとめる） */
export const BREAKDOWN_FORMS = [
  { id: 'deposits', no: '①', title: '預貯金等の内訳書', threshold: 0 },
  { id: 'notes_receivable', no: '②', title: '受取手形の内訳書', threshold: 0 },
  { id: 'receivables', no: '③', title: '売掛金（未収入金）の内訳書', threshold: 500000 },
  { id: 'advances', no: '④', title: '仮払金（前渡金）の内訳書', threshold: 500000 },
  { id: 'loans', no: '④', title: '貸付金及び受取利息の内訳書', threshold: 500000 },
  { id: 'inventory', no: '⑤', title: '棚卸資産の内訳書', threshold: 0 },
  { id: 'securities', no: '⑥', title: '有価証券の内訳書', threshold: 0 },
  { id: 'real_estate', no: '⑦', title: '固定資産（土地、土地の上に存する権利及び建物に限る。）の内訳書', threshold: 0 },
  { id: 'notes_payable', no: '⑧', title: '支払手形の内訳書', threshold: 0 },
  { id: 'payables', no: '⑨', title: '買掛金（未払金・未払費用）の内訳書', threshold: 500000 },
  { id: 'received', no: '⑩', title: '仮受金（前受金・預り金）の内訳書', threshold: 500000 },
  { id: 'borrowings', no: '⑪', title: '借入金及び支払利子の内訳書', threshold: 500000 },
  { id: 'land_sales', no: '⑫', title: '土地の売上高等の内訳書', threshold: 0 },
  { id: 'offices', no: '⑬', title: '売上高等の事業所別内訳書', threshold: 0 },
  { id: 'officers', no: '⑭', title: '役員給与等の内訳書', threshold: 0 },
  { id: 'personnel', no: '⑭', title: '人件費の内訳書', threshold: 0 },
  { id: 'rent', no: '⑮', title: '地代家賃等の内訳書', threshold: 0 },
  { id: 'rights', no: '⑮', title: '権利金等の期中支払の内訳書', threshold: 0 },
  { id: 'royalties', no: '⑮', title: '工業所有権等の使用料の内訳書', threshold: 0 },
  { id: 'misc', no: '⑯', title: '雑益、雑損失等の内訳書', threshold: 100000 },
];
export const BREAKDOWN_BY_ID = Object.fromEntries(BREAKDOWN_FORMS.map((f) => [f.id, f]));

/** 利用者が対象の科目（補助科目）を選ぶ内訳書。groups：選べる科目の区分 */
export const BREAKDOWN_TARGETS = {
  land_sales: { groups: ['sales', 'non_operating_income', 'extraordinary_income'], hint: '販売用の土地の売上や、土地の仲介手数料を計上した科目' },
  rights: { groups: ['intangible_fixed_assets', 'investments', 'deferred_assets', 'cost_of_sales', 'sga', 'non_operating_expenses', 'mfg_overhead'], hint: '権利金・更新料・礼金などを計上した科目' },
  royalties: { groups: ['cost_of_sales', 'sga', 'non_operating_expenses', 'mfg_overhead'], hint: '特許権・商標権などの使用料を計上した科目' },
};

/**
 * 保存する対象の形の検証（設定 settings.breakdownTargets。undefined・null はよい）
 * @returns {string|null} 誤りの文言
 */
export function validateBreakdownTargets(targets) {
  if (targets === undefined || targets === null) return null;
  const isStr = (v) => typeof v === 'string' && v !== '';
  const bad = '内訳書の対象の科目が正しくありません';
  if (typeof targets !== 'object' || Array.isArray(targets)) return bad;
  for (const [id, list] of Object.entries(targets)) {
    if (!BREAKDOWN_TARGETS[id] || !Array.isArray(list)) return bad;
    if (list.some((t) => !t || typeof t !== 'object' || !isStr(t.accountId) || !(t.subAccountId === null || t.subAccountId === undefined || isStr(t.subAccountId)))) return bad;
  }
  return null;
}

/**
 * 選んだ対象を、いまある科目・補助科目だけに整える
 * @param {object} targets { land_sales|rights|royalties: Array<{ accountId, subAccountId|null }> }
 */
export function cleanBreakdownTargets(targets, { accounts, subAccounts = [] }) {
  const accountById = new Map(accounts.map((a) => [a.id, a]));
  const subById = new Map(subAccounts.map((x) => [x.id, x]));
  return Object.fromEntries(
    Object.entries(BREAKDOWN_TARGETS).map(([id, def]) => {
      const list = Array.isArray(targets?.[id]) ? targets[id] : [];
      const ok = list.filter((t) => def.groups.includes(accountById.get(t?.accountId)?.group) && (!t.subAccountId || subById.get(t.subAccountId)?.accountId === t.accountId));
      return [id, ok.map((t) => ({ accountId: t.accountId, subAccountId: t.subAccountId || null }))];
    }),
  );
}

/** 対象の科目（補助科目を選んだときはその補助科目だけ）の期中の明細。金額は科目の向き（収益は貸方、資産・費用は借方）をプラス */
export function targetLines(list, { accounts, subAccounts = [], period, journals }) {
  const accountById = new Map(accounts.map((a) => [a.id, a]));
  const subById = new Map(subAccounts.map((x) => [x.id, x]));
  const match = (l) => list.some((t) => t.accountId === l.accountId && (!t.subAccountId || t.subAccountId === l.subAccountId));
  const out = [];
  for (const j of [...journals].sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : a.no - b.no))) {
    if (j.date < period.startDate || j.date > period.endDate) continue;
    for (const l of j.lines) {
      if (!match(l)) continue;
      const a = accountById.get(l.accountId);
      out.push({ date: j.date, account: a.name, accountId: a.id, party: l.subAccountId ? subById.get(l.subAccountId)?.name ?? '' : '', memo: l.memo || '', amount: l.side === a.normalSide ? l.amount : -l.amount });
    }
  }
  return out;
}

// 列：key、label、num（金額）
const COL = {
  account: { key: 'account', label: '科目' },
  party: { key: 'party', label: '相手先' },
  amount: { key: 'amount', label: '期末現在高', num: true },
  memo: { key: 'memo', label: '摘要' },
};

/**
 * 内訳書をまとめて作る
 * @param {{ accounts, subAccounts, period, journals, showAll?: boolean }} input showAll：金額基準でまとめずにすべて出す
 * @returns {Array<{ id, no, title, columns, rows, total, note }>}
 */
export function breakdownStatements({ accounts, subAccounts = [], period, journals, showAll = false, targets = {} }) {
  const tb = trialBalance({ accounts, subAccounts, period, journals });
  const byHint = (hints) => tb.rows.filter((r) => hints.includes(r.account.hint));
  const byRole = (roles) => tb.rows.filter((r) => roles.includes(r.account.role));
  // 期間の発生額（費用は借方−貸方、収益は貸方−借方）＝ toNormal した期末残高（損益の科目は期首残高が無い）
  const subName = (s) => (s.subAccount ? s.subAccount.name : '（補助なし）');
  /** 科目の行を補助科目ごとに分ける（補助が無ければ科目の1行） */
  const split = (rows, make) =>
    rows.flatMap((r) => {
      const subs = r.subs.filter((s) => s.closing !== 0);
      if (!r.subs.length) return r.closing ? [make(r, null, r.closing)] : [];
      return subs.map((s) => make(r, s.subAccount ? subName(s) : null, s.closing));
    });
  const form = (id, columns, rows, { note = '', sumKey = 'amount', extraTotals = {} } = {}) => {
    const def = BREAKDOWN_BY_ID[id];
    const listed = summarize(rows, showAll ? 0 : def.threshold, sumKey, columns);
    return { ...def, columns, rows: listed, total: rows.reduce((s, r) => s + (r[sumKey] || 0), 0), extraTotals, note };
  };

  // 相手先の名前で、受取利息・支払利息の補助科目の期中の発生額を引く
  const interestBy = (hint) => {
    const map = new Map();
    for (const r of byHint([hint])) for (const s of r.subs) if (s.subAccount) map.set(s.subAccount.name, (map.get(s.subAccount.name) || 0) + s.closing);
    return map;
  };
  const interestIncome = interestBy('interest_income');
  const interestExpense = interestBy('interest_expense');
  const interestIncomeTotal = byHint(['interest_income']).reduce((s, r) => s + r.closing, 0);
  const interestExpenseTotal = byHint(['interest_expense']).reduce((s, r) => s + r.closing, 0);

  const misc = miscLines({ accounts, subAccounts, period, journals });
  const picked = cleanBreakdownTargets(targets, { accounts, subAccounts });
  const lines = (id) => targetLines(picked[id], { accounts, subAccounts, period, journals });
  const slash = (d) => d.replaceAll('-', '/');
  const inventoryHints = ['inventory', 'finished_goods', 'work_in_process', 'raw_materials', 'supplies'];
  const salesTotal = tb.rows.filter((r) => r.account.group === 'sales').reduce((s, r) => s + r.closing, 0);
  const inventoryTotal = byHint(inventoryHints).reduce((s, r) => s + r.closing, 0);
  // 工業所有権等の使用料：支払先（科目・補助科目）ごとに期中の合計
  const royalties = [];
  for (const l of lines('royalties')) {
    const row = royalties.find((x) => x.accountId === l.accountId && x.party === l.party);
    if (row) row.amount += l.amount;
    else royalties.push({ accountId: l.accountId, name: l.memo, party: l.party, amount: l.amount, memo: l.account });
  }
  const pickedNote = (id) => (picked[id].length ? '' : '対象の科目を選ぶと、その科目の仕訳から作ります。');

  return [
    form(
      'deposits',
      [{ key: 'party', label: '金融機関名・支店名' }, { key: 'account', label: '種類' }, COL.amount, COL.memo],
      split(byRole(['deposit']), (r, party, amount) => ({ party: party ?? '', account: r.account.name, amount, memo: '' })),
      { note: '補助科目の名前を金融機関名・支店名として出します。口座番号は記入してください。' },
    ),
    form(
      'notes_receivable',
      [{ key: 'party', label: '振出人' }, { key: 'amount', label: '金額', num: true }, COL.memo],
      split(byHint(['notes_receivable']), (r, party, amount) => ({ party: party ?? '', amount, memo: '' })),
      { note: '振出年月日・支払期日・支払銀行名・割引銀行名は記入してください。' },
    ),
    form('receivables', [COL.account, COL.party, COL.amount, COL.memo], split(byHint(['receivable', 'other_receivable']), (r, party, amount) => ({ account: r.account.name, party: party ?? '', amount, memo: '' })), {
      note: '相手先別の期末現在高が50万円以上のものを各別に、その他はまとめて出します。所在地は記入してください。',
    }),
    form('advances', [COL.account, COL.party, COL.amount, COL.memo], split(byHint(['advance_paid', 'suspense_paid']), (r, party, amount) => ({ account: r.account.name, party: party ?? '', amount, memo: '' })), {
      note: '相手先別の期末現在高が50万円以上のものを各別に出します。所在地・法人・代表者との関係は記入してください。',
    }),
    form(
      'loans',
      [{ key: 'party', label: '貸付先' }, COL.amount, { key: 'interest', label: '期中の受取利息額', num: true }, COL.memo],
      split(byHint(['short_loan', 'long_loan']), (r, party, amount) => ({ party: party ?? '', amount, interest: party ? interestIncome.get(party) || 0 : 0, memo: r.account.name })),
      { note: `受取利息は、受取利息の補助科目のうち貸付先と同じ名前のものを出します（受取利息の合計 ${interestIncomeTotal.toLocaleString('ja-JP')}円）。利率・担保の内容は記入してください。` },
    ),
    form(
      'inventory',
      [COL.account, { key: 'party', label: '品目' }, COL.amount, COL.memo],
      split(byHint(['inventory', 'finished_goods', 'work_in_process', 'raw_materials', 'supplies']), (r, party, amount) => ({ account: r.account.name, party: party ?? '', amount, memo: '' })),
      { note: '数量・単価は記入してください。' },
    ),
    form(
      'securities',
      [{ key: 'account', label: '区分' }, { key: 'party', label: '種類・銘柄' }, COL.amount, COL.memo],
      split(byHint(['securities', 'investment_securities']), (r, party, amount) => ({ account: r.account.name, party: party ?? '', amount, memo: '' })),
      { note: '数量・期中の増減は記入してください。' },
    ),
    form(
      'real_estate',
      [{ key: 'account', label: '種類・構造' }, { key: 'party', label: '物件' }, COL.amount, COL.memo],
      split(byHint(['land', 'building']), (r, party, amount) => ({ account: r.account.name, party: party ?? '', amount, memo: '' })),
      { note: '帳簿の残高（取得価額）を出します。用途・面積・所在地・期中の取得（処分）等は記入してください。' },
    ),
    form(
      'notes_payable',
      [{ key: 'party', label: '支払先' }, { key: 'amount', label: '金額', num: true }, COL.memo],
      split(byHint(['notes_payable']), (r, party, amount) => ({ party: party ?? '', amount, memo: '' })),
      { note: '振出年月日・支払期日・支払銀行名は記入してください。' },
    ),
    form('payables', [COL.account, COL.party, COL.amount, COL.memo], split(byHint(['payable', 'accrued', 'accrued_expenses']), (r, party, amount) => ({ account: r.account.name, party: party ?? '', amount, memo: '' })), {
      note: '相手先別の期末現在高が50万円以上のものを各別に、その他はまとめて出します。所在地は記入してください。',
    }),
    form('received', [COL.account, COL.party, COL.amount, COL.memo], split(byHint(['advance_received', 'deposits_received', 'suspense_received']), (r, party, amount) => ({ account: r.account.name, party: party ?? '', amount, memo: '' })), {
      note: '相手先別の期末現在高が50万円以上のものを各別に出します。源泉所得税預り金の内訳（支払年月・所得の種類）は記入してください。',
    }),
    form(
      'borrowings',
      [{ key: 'party', label: '借入先' }, COL.amount, { key: 'interest', label: '期中の支払利子額', num: true }, COL.memo],
      split(byHint(['short_borrowings', 'long_borrowings', 'officer_loan']), (r, party, amount) => ({ party: party ?? '', amount, interest: party ? interestExpense.get(party) || 0 : 0, memo: r.account.name })),
      { note: `支払利子は、支払利息の補助科目のうち借入先と同じ名前のものを出します（支払利息の合計 ${interestExpenseTotal.toLocaleString('ja-JP')}円）。所在地・法人・代表者との関係・利率・担保の内容は記入してください。` },
    ),
    form(
      'land_sales',
      [{ key: 'month', label: '売上（仲介）年月' }, { key: 'party', label: '売上（仲介）先' }, { key: 'memo', label: '摘要' }, { key: 'amount', label: '売上金額（仲介手数料）', num: true }],
      lines('land_sales')
        .map((l) => ({ month: slash(l.date.slice(0, 7)), party: l.party, memo: l.memo, amount: l.amount }))
        .sort((a, b) => b.amount - a.amount),
      { note: `${pickedNote('land_sales')}棚卸資産の土地の売却と、土地の仲介を書きます。金額の多い順に出します（20口までの記載でもよい）。区分（売上・仲介手数料）・商品の所在地・地目・面積・売上商品の取得年は記入してください。` },
    ),
    form(
      'offices',
      [{ key: 'party', label: '事業所の名称' }, { key: 'amount', label: '売上高', num: true }, { key: 'inventory', label: '期末棚卸高', num: true }, { key: 'memo', label: '摘要' }],
      salesTotal || inventoryTotal ? [{ party: '本店', amount: salesTotal, inventory: inventoryTotal, memo: '' }] : [],
      { note: '売上高は損益計算書の売上高、期末棚卸高は棚卸資産の期末残高の合計です（合計は損益計算書と一致させます）。事業所が複数あるときは、事業所ごとに分けて記入してください。所在地・責任者氏名・事業等の内容・期末従事員数・源泉所得税納付署も記入してください。' },
    ),
    form(
      'officers',
      [{ key: 'party', label: '氏名' }, { key: 'amount', label: '役員給与計', num: true }, COL.memo],
      split(byHint(['officer_compensation']), (r, party, amount) => ({ party: party ?? '', amount, memo: '' })),
      { note: '役員報酬の補助科目の名前を氏名として出します。役職名・代表者との関係・常勤非常勤の別・定期同額給与等の内訳は記入してください。' },
    ),
    personnel(tb.rows),
    form(
      'rent',
      [COL.account, { key: 'party', label: '貸主' }, { key: 'amount', label: '支払賃借料', num: true }, COL.memo],
      split(byHint(['rent', 'mfg_rent']), (r, party, amount) => ({ account: r.account.name, party: party ?? '', amount, memo: '' })),
      { note: '地代家賃の補助科目の名前を貸主として出します。地代・家賃の区分、物件の用途・所在地、支払対象期間は記入してください。' },
    ),
    form(
      'rights',
      [{ key: 'party', label: '支払先' }, { key: 'date', label: '支払年月日' }, { key: 'memo', label: '権利金等の内容' }, { key: 'amount', label: '支払金額', num: true }],
      lines('rights').map((l) => ({ party: l.party, date: slash(l.date), memo: l.memo, amount: l.amount })),
      { note: `${pickedNote('rights')}支払先の所在地（または登録番号・法人番号）は記入してください。` },
    ),
    form(
      'royalties',
      [{ key: 'name', label: '名称' }, { key: 'party', label: '支払先' }, { key: 'amount', label: '支払金額', num: true }, { key: 'memo', label: '摘要' }],
      royalties.map(({ accountId, ...r }) => r),
      { note: `${pickedNote('royalties')}支払先（補助科目）ごとの期中の合計です。名称は最初の仕訳の摘要です。特許権・商標権などの名称、契約期間・使用料等支払対象期間、支払先の所在地は記入してください。` },
    ),
    form('misc', [COL.account, { key: 'memo', label: '取引の内容' }, COL.party, { key: 'amount', label: '金額', num: true }], misc, {
      note: '雑収入・雑損失の仕訳を1件ずつ出し、10万円未満はまとめます。所在地は記入してください。',
    }),
  ];

  function personnel(rows) {
    const total = (hints) => rows.filter((r) => hints.includes(r.account.hint)).reduce((s, r) => s + r.closing, 0);
    const list = [
      { account: '役員報酬手当', amount: total(['officer_compensation']) },
      { account: '従業員給料手当', amount: total(['salaries', 'bonuses']) },
      { account: '従業員賃金手当', amount: total(['wages']) },
    ];
    const def = BREAKDOWN_BY_ID.personnel;
    return { ...def, columns: [{ key: 'account', label: '区分' }, { key: 'amount', label: '総額', num: true }], rows: list, total: list.reduce((s, r) => s + r.amount, 0), extraTotals: {}, note: '役員報酬・給料手当・賞与・賃金（製造）の科目の合計です。「うち代表者及びその家族分」は記入してください。' };
  }
}

/** 雑収入・雑損失の仕訳の行（1明細ずつ。金額は科目の向き：雑収入は貸方、雑損失は借方をプラス） */
export function miscLines({ accounts, subAccounts = [], period, journals }) {
  const target = new Map(accounts.filter((a) => a.hint === 'misc_income' || a.hint === 'misc_loss').map((a) => [a.id, a]));
  const subById = new Map(subAccounts.map((s) => [s.id, s]));
  const out = [];
  for (const j of journals) {
    if (j.date < period.startDate || j.date > period.endDate) continue;
    for (const l of j.lines) {
      const a = target.get(l.accountId);
      if (!a) continue;
      const amount = l.side === a.normalSide ? l.amount : -l.amount;
      out.push({ account: a.name, memo: l.memo || '', party: l.subAccountId ? subById.get(l.subAccountId)?.name ?? '' : '', amount, date: j.date, sortOrder: a.sortOrder ?? 0 });
    }
  }
  return out.sort((x, y) => x.sortOrder - y.sortOrder || (x.date < y.date ? -1 : x.date > y.date ? 1 : 0));
}

/**
 * 金額基準で行をまとめる。基準以上（絶対値）の行はそのまま、未満は科目ごとに「その他（N件）」の1行にする
 * @param {Array} rows
 * @param {number} threshold 0 ならまとめない
 */
export function summarize(rows, threshold, sumKey = 'amount', columns = []) {
  if (!threshold) return rows;
  const keep = [];
  const rest = new Map();
  const hasAccount = columns.some((c) => c.key === 'account');
  for (const r of rows) {
    if (Math.abs(r[sumKey] || 0) >= threshold) keep.push(r);
    else {
      const k = hasAccount ? r.account : '';
      const e = rest.get(k) || { count: 0, sums: {} };
      e.count += 1;
      for (const c of columns) if (c.num) e.sums[c.key] = (e.sums[c.key] || 0) + (r[c.key] || 0);
      rest.set(k, e);
    }
  }
  for (const [account, e] of rest) {
    const row = { ...e.sums, party: `その他（${e.count}件）`, memo: '', other: true };
    if (hasAccount) row.account = account;
    keep.push(row);
  }
  return keep;
}
