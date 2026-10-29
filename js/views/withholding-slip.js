// 源泉徴収票（受給者交付用）・給与支払報告書（個人別明細書）の紙面（印刷・PDF 保存）。全員分をまとめて印刷もできる
import { h, put, segmented } from '../ui.js';
import { formatYen } from '../money.js';
import { RESIDENT_COLLECTION_LABEL } from '../payroll.js';
import { withholdingSlip, withholdingSlips, supportedSlipYears, payerInfo, eraDate, yearLabel } from '../withholding-slip.js';

const TYPES = [
  { value: 'slip', label: '源泉徴収票' },
  { value: 'report', label: '給与支払報告書' },
];

/** 金額の欄（null・0 は空欄。zero のときは0も書く） */
const yen = (n, { zero = false } = {}) => (n == null || (n === 0 && !zero) ? '' : formatYen(n));
/** 人数の欄（0 は空欄） */
const cnt = (n) => (n ? String(n) : '');
const mark = (b) => (b ? '○' : '');

function cell(label, value, { cls = '', sub = null } = {}) {
  return h('div', { class: `ws-cell ${cls}` }, h('span', { class: 'ws-l', text: label }), sub ? h('span', { class: 'ws-sub', text: sub }) : null, h('span', { class: 'ws-v', text: value }));
}

function block(title, ...cells) {
  return h('section', { class: 'ws-block' }, title ? h('h3', { class: 'ws-block-title', text: title }) : null, h('div', { class: 'ws-grid' }, ...cells));
}

function eraCells(prefix, iso) {
  const e = eraDate(iso);
  return [cell(`${prefix}元号`, e ? e.era : ''), cell('年', e ? String(e.year) : ''), cell('月', e ? String(e.month) : ''), cell('日', e ? String(e.day) : '')];
}

/** 1人分の紙面 */
export function slipDoc(s, { payer, type }) {
  const report = type === 'report';
  const c = s.counts || {};
  const lb = s.lifeBreakdown || {};
  const f = s.flags;
  const family = (rows, title, suffix = '') =>
    block(title, ...[0, 1, 2, 3].flatMap((i) => [cell(`${i + 1} 氏名`, rows[i] ? `${rows[i].name}${suffix}` : '', { cls: 'ws-name' }), cell('区分', rows[i] ? (rows[i].code ?? '（要記入）') : '', { cls: 'ws-code' })]));
  return h(
    'article',
    { class: 'ws-paper' },
    h('header', { class: 'ws-head' }, h('h2', { class: 'ws-title', text: `${yearLabel(s.year)}　${report ? '給与支払報告書（個人別明細書）' : '給与所得の源泉徴収票'}` }), h('p', { class: 'ws-copy', text: report ? `提出先：${s.city || '（市区町村）'}　住民税：${RESIDENT_COLLECTION_LABEL[s.collection]}` : '（受給者交付用）' })),
    block('支払を受ける者', cell('住所又は居所', s.address, { cls: 'ws-wide' }), cell('（フリガナ）', s.kana, { cls: 'ws-half' }), cell('氏名', s.name, { cls: 'ws-half ws-strong' }), report ? cell('個人番号', '', { cls: 'ws-half' }) : null),
    block(
      null,
      cell('種別', s.kind),
      cell('支払金額', yen(s.pay, { zero: true }), { cls: 'num' }),
      cell('給与所得控除後の金額（調整控除後）', yen(s.salaryIncome, { zero: s.adjusted }), { cls: 'num' }),
      cell('所得控除の額の合計額', yen(s.totalDeductions, { zero: s.adjusted }), { cls: 'num' }),
      cell('源泉徴収税額', yen(s.tax, { zero: true }), { cls: 'num ws-strong' }),
    ),
    block(
      null,
      cell('（源泉）控除対象配偶者の有無等', s.spouse.has == null ? '' : s.spouse.has ? '有' : '無', { sub: '従有' }),
      cell('老人', mark(s.spouse.elderly)),
      cell('配偶者（特別）控除の額', yen(s.spouse.amount), { cls: 'num' }),
      cell('控除対象扶養親族の数 特定', cnt(c.specific), { cls: 'num' }),
      cell('老人', cnt(c.elderly), { cls: 'num', sub: c.elderlyCohabiting ? `内${c.elderlyCohabiting}` : null }),
      cell('その他', cnt(c.other), { cls: 'num' }),
      cell('特親', cnt(c.specificRelative), { cls: 'num' }),
      cell('16歳未満扶養親族の数', cnt(c.young), { cls: 'num' }),
      cell('障害者の数（本人を除く） 特別', cnt(c.disabledSpecial), { cls: 'num', sub: c.disabledSpecialCohabiting ? `内${c.disabledSpecialCohabiting}` : null }),
      cell('その他', cnt(c.disabledOther), { cls: 'num' }),
      cell('非居住者である親族の数', cnt(c.nonResident), { cls: 'num' }),
    ),
    block(
      null,
      cell('社会保険料等の金額', yen(s.social, { zero: true }), { cls: 'num', sub: s.smallBusiness ? `内${formatYen(s.smallBusiness)}` : null }),
      cell('生命保険料の控除額', yen(s.life), { cls: 'num' }),
      cell('地震保険料の控除額', yen(s.earthquake), { cls: 'num' }),
      cell('住宅借入金等特別控除の額', yen(s.housing), { cls: 'num' }),
      cell('特定親族特別控除の額', yen(s.specificRelative), { cls: 'num' }),
    ),
    block('（摘要）', cell('', s.remarks.join('　'), { cls: 'ws-wide ws-remarks' })),
    block(
      '生命保険料の金額の内訳',
      cell('新生命保険料の金額', yen(lb.lifeNew), { cls: 'num' }),
      cell('旧生命保険料の金額', yen(lb.lifeOld), { cls: 'num' }),
      cell('介護医療保険料の金額', yen(lb.care), { cls: 'num' }),
      cell('新個人年金保険料の金額', yen(lb.pensionNew), { cls: 'num' }),
      cell('旧個人年金保険料の金額', yen(lb.pensionOld), { cls: 'num' }),
    ),
    block('住宅借入金等特別控除の額の内訳', cell('住宅借入金等特別控除適用数', ''), cell('住宅借入金等特別控除可能額', yen(s.housingPossible), { cls: 'num' }), cell('居住開始年月日（1回目）', ''), cell('住宅借入金等特別控除区分（1回目）', ''), cell('住宅借入金等年末残高（1回目）', '')),
    block(
      '（源泉・特別）控除対象配偶者',
      cell('氏名', s.spouseRow?.name ?? '', { cls: 'ws-name' }),
      cell('区分', s.spouseRow?.code ?? '', { cls: 'ws-code' }),
      cell('配偶者の合計所得', yen(s.spouse.income, { zero: s.spouse.income != null }), { cls: 'num' }),
      cell('国民年金保険料等の金額', yen(s.nationalPension), { cls: 'num' }),
      cell('旧長期損害保険料の金額', yen(s.oldLongTerm), { cls: 'num' }),
      cell('基礎控除の額', yen(s.basic), { cls: 'num' }),
      cell('所得金額調整控除額', yen(s.adjustment), { cls: 'num' }),
    ),
    family(s.dependentRows, '控除対象扶養親族等'),
    family(s.youngRows, '16歳未満の扶養親族'),
    block(
      null,
      cell('未成年者', mark(f.minor)),
      cell('外国人', mark(f.foreigner)),
      cell('死亡退職', mark(f.deceased)),
      cell('災害者', mark(f.disaster)),
      cell('乙欄', mark(f.otsu)),
      cell('本人が障害者 特別', mark(f.disabled === 'special')),
      cell('その他', mark(f.disabled === 'general')),
      cell('寡婦', mark(f.widow)),
      cell('ひとり親', mark(f.singleParent)),
      cell('勤労学生', mark(f.student)),
    ),
    block('中途就・退職', cell('就職', mark(s.midway?.joined)), cell('退職', mark(s.midway?.retired)), ...eraCells('', s.midway?.date ?? '').slice(1)),
    block('受給者生年月日', ...eraCells('', s.birthDate)),
    block('支払者', cell('住所（居所）又は所在地', payer.address, { cls: 'ws-wide' }), cell('氏名又は名称', payer.name, { cls: 'ws-half' }), cell('（電話）', payer.phone, { cls: 'ws-half' })),
  );
}

export async function render({ app, outlet, params, query }) {
  const [settings, employees, payrolls, yearEnds] = await Promise.all([app.db.getSettings(), app.db.listEmployees(), app.db.listPayrolls(), app.db.listYearEnds()]);
  const year = /^\d{4}$/.test(query.year || '') ? Number(query.year) : null;
  const back = h('a', { class: 'btn', href: `#/payroll/slips${year ? `?year=${year}` : ''}`, text: '一覧へ' });
  if (!year || !supportedSlipYears().includes(year)) return put(outlet, h('p', { class: 'notice', text: `${year ? yearLabel(year) : 'その年分'}の源泉徴収票には対応していません` }), back);
  const all = params.id === 'all';
  const employee = all ? null : employees.find((e) => e.id === params.id);
  if (!all && !employee) return put(outlet, h('p', { class: 'notice', text: '従業員が見つかりません' }), back);
  const slips = all ? withholdingSlips({ employees, payrolls, yearEnds, year }) : [withholdingSlip({ employee, yearEnd: yearEnds.find((x) => x.employeeId === employee.id && x.year === year) || null, payrolls, year })];
  if (!slips.length || (!all && !slips[0].pay)) return put(outlet, h('p', { class: 'notice', text: `${year}年に支払った給与がありません` }), back);
  app.setTitle(all ? `${yearLabel(year)}の源泉徴収票（全員）` : `${employee.name}さんの源泉徴収票`);
  const payer = payerInfo(settings);
  let type = query.type === 'report' ? 'report' : 'slip';
  const papers = h('div', { class: 'ws-papers' });
  const info = h('div', { class: 'no-print' });

  function paint() {
    put(papers, slips.map((s) => slipDoc(s, { payer, type })));
    const warnings = all ? slips.flatMap((s) => s.warnings.map((w) => `${s.name}：${w}`)) : slips[0].warnings;
    if (!payer.address) warnings.unshift('支払者の住所が入っていません（給与計算 › 給与の設定）');
    put(
      info,
      warnings.length ? h('div', { class: 'notice small ws-warn' }, h('p', { class: 'ws-warn-title', text: '確かめること' }), h('ul', {}, warnings.map((w) => h('li', { text: w })))) : null,
      type === 'report'
        ? h('p', { class: 'small muted', text: '給与支払報告書の住所は、翌年1月1日現在の住所です（年の途中で退職した人は退職した時の住所）。個人番号は保存していないため書き足してください。市区町村ごとに総括表を付けて提出します（eLTAX でも提出できます）。' })
        : h('p', { class: 'small muted', text: '国税庁の様式（受給者交付用）の欄に合わせて並べた写しです。受給者交付用にはマイナンバーを書きません。国税庁の様式に書き写すときや、e-Tax・eLTAX のソフトに入力するときに使ってください。' }),
    );
  }

  put(
    outlet,
    h(
      'div',
      { class: 'no-print ws-tools' },
      segmented({
        name: '帳票',
        options: TYPES,
        value: type,
        onChange: (v) => {
          type = v;
          history.replaceState(history.state, '', `#/payroll/slips/${params.id}?year=${year}${v === 'report' ? '&type=report' : ''}`);
          paint();
        },
      }),
    ),
    info,
    papers,
    h('div', { class: 'no-print report-tools' }, back),
  );
  paint();
}
