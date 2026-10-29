// 経営分析の指標：収益性・安全性・効率性・損益分岐点（純粋関数）
//
// 金額は整数の円のまま扱い、比率は表示のための整数（‰＝千分率、回転期間は0.1か月単位）にする。
// 科目は区分（group）・役割（role）・目印（hint）で集める（科目名は使わない）。
// 損益分岐点は簡便な勘定科目法：変動費＝売上原価、固定費＝それ以外の費用（営業外の損益を含む）。
import { GROUP_BY_ID } from './accounts.js';

/** 科目の残高を区分の向きの金額にする（statements.js と同じ） */
const groupAmount = (r) => (GROUP_BY_ID[r.account.group].side === 'debit' ? r.dc : 0 - r.dc);

const QUICK_HINTS = ['receivable', 'notes_receivable', 'securities', 'allowance_doubtful'];
const INVENTORY_HINTS = ['inventory', 'finished_goods', 'raw_materials', 'work_in_process', 'supplies'];

/**
 * 貸借対照表の数字（ある時点の残高の行から）
 * 総資産は事業主貸を除く。純資産＝総資産−負債（個人は 元入金＋事業主借−事業主貸＋所得 に当たる）
 */
export function bsFigures(rows) {
  const sum = (pred) => rows.filter(pred).reduce((s, r) => s + groupAmount(r), 0);
  const inGroup = (...ids) => (r) => ids.includes(r.account.group);
  const withHint = (hints) => (r) => hints.includes(r.account.hint);
  const currentAssets = sum(inGroup('current_assets'));
  const quickAssets = sum((r) => r.account.group === 'current_assets' && (['cash', 'deposit'].includes(r.account.role) || QUICK_HINTS.includes(r.account.hint)));
  const fixedAssets = sum(inGroup('tangible_fixed_assets', 'intangible_fixed_assets', 'investments'));
  const totalAssets = currentAssets + fixedAssets + sum(inGroup('deferred_assets'));
  const currentLiabilities = sum(inGroup('current_liabilities'));
  const liabilities = currentLiabilities + sum(inGroup('fixed_liabilities'));
  return {
    currentAssets,
    quickAssets,
    inventories: sum(withHint(INVENTORY_HINTS)),
    receivables: sum(withHint(['receivable', 'notes_receivable'])),
    payables: sum(withHint(['payable', 'notes_payable'])),
    fixedAssets,
    totalAssets,
    currentLiabilities,
    liabilities,
    netAssets: totalAssets - liabilities,
  };
}

/**
 * 損益計算書の数字（incomeStatement の profits から）
 * profit：損益分岐点で0になる利益（法人は経常利益、個人は青色申告特別控除前の所得金額）
 */
export function plFigures(entityType, profits) {
  if (entityType === 'individual') {
    return { sales: profits.sales, cogs: profits.cogs, gross: profits.diff1, operating: null, ordinary: null, income: profits.income, profit: profits.income };
  }
  return { sales: profits.sales, cogs: profits.cogs, gross: profits.gross, operating: profits.operating, ordinary: profits.ordinary, income: null, profit: profits.ordinary };
}

/** 分子÷分母を‰の整数に。分母が0以下なら null */
export function permille(num, den) {
  return den > 0 ? Math.round((num * 1000) / den) : null;
}

/** 残高が月平均の何か月分か（0.1か月単位の整数）。flow は期間の合計、months は期間の月数 */
export function monthsOf(balance, flow, months) {
  return flow > 0 && months > 0 ? Math.round((balance * months * 10) / flow) : null;
}

/**
 * 損益分岐点
 *   限界利益＝売上−変動費（売上原価）、固定費＝限界利益−利益
 *   損益分岐点売上高＝固定費×売上÷限界利益（1円未満は四捨五入）
 */
export function breakEven(pl) {
  if (!pl || pl.sales <= 0) return null;
  const variable = pl.cogs;
  const marginal = pl.sales - variable;
  const fixed = marginal - pl.profit;
  if (marginal <= 0) return { variable, fixed, marginal, marginalRate: permille(marginal, pl.sales), point: null, pointRatio: null, safety: null };
  const point = fixed > 0 ? Math.round((fixed * pl.sales) / marginal) : 0;
  return { variable, fixed, marginal, marginalRate: permille(marginal, pl.sales), point, pointRatio: permille(point, pl.sales), safety: permille(pl.sales - point, pl.sales) };
}

/**
 * 指標の一覧
 * @param {{ entityType, pl: object|null, bs: object|null, months: number }} p pl：plFigures、bs：bsFigures、months：期間の月数
 * @returns {Array<{ title, items: Array<{ key, label, value: number|null, unit: 'permille'|'months'|'yen', formula }> }>}
 */
export function indicators({ entityType, pl, bs, months }) {
  const individual = entityType === 'individual';
  const salesWord = individual ? '売上(収入)金額' : '売上高';
  const sales = pl?.sales ?? 0;
  const item = (key, label, value, unit, formula) => ({ key, label, value: value ?? null, unit, formula });
  const ifPl = (f) => (pl && sales > 0 ? f() : null);
  const ifBs = (f) => (bs ? f() : null);
  const be = breakEven(pl);
  const workingCapital = bs ? bs.receivables + bs.inventories - bs.payables : null;
  return [
    {
      title: '収益性',
      items: [
        item('gross_margin', '売上総利益率', ifPl(() => permille(pl.gross, sales)), 'permille', `（${salesWord}−売上原価）÷${salesWord}`),
        ...(individual
          ? [item('income_ratio', '所得率', ifPl(() => permille(pl.income, sales)), 'permille', `青色申告特別控除前の所得金額÷${salesWord}`)]
          : [
              item('operating_margin', '営業利益率', ifPl(() => permille(pl.operating, sales)), 'permille', '営業利益÷売上高'),
              item('ordinary_margin', '経常利益率', ifPl(() => permille(pl.ordinary, sales)), 'permille', '経常利益÷売上高'),
            ]),
      ],
    },
    {
      title: '安全性',
      items: [
        item('current_ratio', '流動比率', ifBs(() => permille(bs.currentAssets, bs.currentLiabilities)), 'permille', '流動資産÷流動負債'),
        item('quick_ratio', '当座比率', ifBs(() => permille(bs.quickAssets, bs.currentLiabilities)), 'permille', '当座資産（現金・預金・売上債権・有価証券）÷流動負債'),
        item('equity_ratio', '自己資本比率', ifBs(() => permille(bs.netAssets, bs.totalAssets)), 'permille', individual ? '（元入金＋事業主借−事業主貸＋所得）÷（資産合計−事業主貸）' : '純資産÷総資産'),
        item('fixed_ratio', '固定比率', ifBs(() => permille(bs.fixedAssets, bs.netAssets)), 'permille', individual ? '固定資産÷自己資本' : '固定資産÷純資産'),
      ],
    },
    {
      title: '効率性（月商の何か月分か）',
      items: [
        item('receivable_months', '売上債権回転期間', ifPl(() => ifBs(() => monthsOf(bs.receivables, sales, months))), 'months', `（売掛金＋受取手形）÷月平均の${salesWord}`),
        item('inventory_months', '棚卸資産回転期間', ifPl(() => ifBs(() => monthsOf(bs.inventories, sales, months))), 'months', `棚卸資産÷月平均の${salesWord}`),
        item('payable_months', '仕入債務回転期間', ifPl(() => ifBs(() => monthsOf(bs.payables, sales, months))), 'months', `（買掛金＋支払手形）÷月平均の${salesWord}`),
        item('working_capital', '運転資本', workingCapital, 'yen', '売上債権＋棚卸資産−仕入債務'),
        item('working_capital_months', '運転資本の回転期間', ifPl(() => ifBs(() => monthsOf(workingCapital, sales, months))), 'months', `運転資本÷月平均の${salesWord}`),
      ],
    },
    {
      title: '損益分岐点',
      items: [
        item('variable', '変動費', be?.variable, 'yen', '売上原価（簡便法）'),
        item('fixed', '固定費', be?.fixed, 'yen', individual ? '経費・専従者給与など売上原価以外の費用' : '販管費＋営業外費用−営業外収益'),
        item('marginal_rate', '限界利益率', be?.marginalRate, 'permille', `（${salesWord}−変動費）÷${salesWord}`),
        item('break_even', '損益分岐点売上高', be?.point, 'yen', '固定費÷限界利益率'),
        item('break_even_ratio', '損益分岐点比率', be?.pointRatio, 'permille', `損益分岐点売上高÷${salesWord}`),
        item('safety_margin', '安全余裕率', be?.safety, 'permille', `（${salesWord}−損益分岐点売上高）÷${salesWord}`),
      ],
    },
  ];
}

/** 0.1か月単位の整数を「1.5か月」にする */
export function formatMonths(tenths) {
  if (tenths == null) return '—';
  const abs = Math.abs(tenths);
  return `${tenths < 0 ? '△' : ''}${Math.floor(abs / 10)}.${abs % 10}か月`;
}
