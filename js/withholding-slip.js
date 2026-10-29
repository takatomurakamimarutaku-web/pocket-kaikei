// 源泉徴収票・給与支払報告書（個人別明細書）・法定調書合計表の「給与所得の源泉徴収票合計表」欄（純粋関数）
//
// 対応は令和8年分（年末調整と同じ年分）
//   給与所得の源泉徴収票（同合計表）：https://www.nta.go.jp/taxes/tetsuzuki/shinsei/annai/hotei/23100051.htm
//   令和8年分 法定調書の作成と提出の手引（給与所得の源泉徴収票）：https://www.nta.go.jp/publication/pamph/hotei/tebiki2026/PDF/02.pdf
//   源泉徴収票の記載要領（令和8年分）：https://www.nta.go.jp/taxes/tetsuzuki/shinsei/annai/hotei/pdf/r08/kisai_chousho01.pdf
//   No.7411 「給与所得の源泉徴収票」の提出範囲と提出枚数等：https://www.nta.go.jp/taxes/shiraberu/taxanswer/hotei/7411.htm
//   合計表の記載要領（令和8年分）：https://www.nta.go.jp/taxes/tetsuzuki/shinsei/annai/hotei/pdf/r08/kisai_goukei01.pdf
//
// 1. 提出範囲（令和8年分以後＝令和9年1月1日以後に提出するもの）：年の中途で退職した人で、その年の支払金額が30万円以下の人を除く全員。
//    税務署に出す源泉徴収票と、市区町村に出す給与支払報告書の範囲は同じ（No.7411）
// 2. 源泉徴収票のみなし提出の特例（令和9年1月1日以後）：給与支払報告書を市区町村に提出すると、税務署に源泉徴収票を提出したものとみなす。
//    受給者への交付は全員に必要（翌年1月31日まで。年の中途で退職した人は退職の日以後1か月以内）。
//    合計表の「給与所得の源泉徴収票合計表」欄は、みなし提出の特例で税務署に提出する源泉徴収票が無ければ記載不要（合計表の記載要領）
// 3. 給与支払報告書は、翌年1月1日現在の住所地の市区町村に出す（年の中途で退職した人は退職した時の住所地）。期限は翌年1月31日
// 4. 年末調整をした人：支払金額・社会保険料等・源泉徴収税額は前職分を含め（源泉徴収税額は年調年税額）、摘要に前職分を書く。
//    給与所得控除後の金額・所得控除の額の合計額は、年末調整（所得税法第190条）をした場合に限り書く。
//    年末調整をしなかった人の源泉徴収税額は、徴収した税額の合計
// 5. 未成年者：平成21年1月3日以後に生まれた人（令和8年分の手引）。翌年1月1日現在で18歳未満の人になる
// 6. 控除対象扶養親族等の区分：居住者は00。非居住者の配偶者は01、非居住者の扶養親族は01（30歳未満・70歳以上）、
//    02（留学）・03（障害者）・04（38万円以上の送金）。02〜04は入力していないので空けて、書き足してもらう
// 7. 摘要：5人目以降の控除対象扶養親族等は番号を付けて氏名を書く。所得金額調整控除の対象の同一生計配偶者は「氏名（同配）」、
//    扶養親族は「氏名（調整）」。23歳未満の扶養親族がいる人の生命保険料控除は「租税特別措置法第41条の15の5第1項適用」。
//    同じ年に就職して退職した人は「中途就」
// 8. 合計表 Ⓐ（俸給、給与、賞与等の総額）：提出を省略する人も含めた全員。前職分を含めない。年末調整の超過額が徴収した税額を上回るときは0。
//    「左のうち、源泉徴収税額のない者」は源泉徴収票の源泉徴収税額が0の人。Ⓑ（源泉徴収票を提出するもの）は前職分を含める
import { isValidDate } from './period.js';
import { formatYen } from './money.js';
import { RESIDENT_COLLECTION_LABEL } from './payroll.js';
import { yearEndCalc, yearPayTotals, snapshotChanges, supportedYearEndYears, ageAtYearEnd, dependentIncomeLimit } from './year-end.js';

/** 退職者で提出を省略できる支払金額の上限（令和8年分以後） */
export const OMIT_LIMIT = 300_000;
/** 源泉徴収票の家族の欄の行数（5人目以降は摘要に書く） */
export const FAMILY_ROWS = 4;

/** 源泉徴収票を作れる年分（年末調整と同じ） */
export function supportedSlipYears() {
  return supportedYearEndYears();
}

const ERAS = [
  ['2019-05-01', '令和', 2018],
  ['1989-01-08', '平成', 1988],
  ['1926-12-25', '昭和', 1925],
  ['1912-07-30', '大正', 1911],
  ['0000-01-01', '明治', 1867],
];

/** 和暦（元号・年・月・日）。日付でなければ null */
export function eraDate(iso) {
  if (!isValidDate(iso)) return null;
  const [y, m, d] = iso.split('-').map(Number);
  const [, era, offset] = ERAS.find(([from]) => iso >= from);
  return { era, year: y - offset, month: m, day: d };
}

/** 和暦の表示（例：令和8年12月25日。1年は「元年」） */
export function eraText(iso) {
  const e = eraDate(iso);
  return e ? `${e.era}${e.year === 1 ? '元' : e.year}年${e.month}月${e.day}日` : '';
}

/** 年分の表示（例：2026 → 令和8年分） */
export function yearLabel(year) {
  return year >= 2020 ? `令和${year - 2018}年分` : year === 2019 ? '令和元年分' : `平成${year - 1988}年分`;
}

/** 源泉徴収票の「未成年者」：翌年1月1日現在で18歳未満（令和8年分は平成21年1月3日以後に生まれた人） */
export function isMinor(birthDate, year) {
  return isValidDate(birthDate) && birthDate >= `${year - 17}-01-03`;
}

/** 提出・交付の期限：翌年1月31日（土日祝日は翌日。令和8年分は令和9年2月1日（月）） */
export function slipDeadline(year) {
  const d = new Date(Date.UTC(year + 1, 0, 31));
  while (d.getUTCDay() === 0 || d.getUTCDay() === 6) d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString().slice(0, 10);
}

/** 源泉徴収票の支払者の欄（給与の設定で空欄なら、請求書の発行元・事業者名を使う） */
export function payerInfo(settings) {
  const p = settings?.payroll?.payer || {};
  const inv = settings?.invoice || {};
  return {
    name: p.name || inv.issuerName || settings?.businessName || '',
    address: p.address || inv.address || '',
    phone: p.phone || inv.phone || '',
  };
}

const TARGET_CLASSES = ['general', 'specific', 'elderly', 'elderly_cohabiting', 'specific_relative'];

/** 家族の区分の欄（居住者00・非居住者01。30歳以上70歳未満の非居住者の扶養親族は02〜04のどれかを書き足す＝null） */
function familyCode(x, year, spouse) {
  if (!x.nonResident) return '00';
  if (spouse) return '01';
  const age = ageAtYearEnd(x.birthDate, year) ?? 0;
  return age < 30 || age >= 70 ? '01' : null;
}

/** 1人1年分の給与の種別（給料・賞与） */
function slipKind(sum) {
  if (sum.salaryCount && sum.bonusCount) return '給料・賞与';
  if (sum.bonusCount) return '賞与';
  return '給料';
}

/**
 * 1人分の源泉徴収票（給与支払報告書の個人別明細書も同じ内容）
 * @param {{ employee: object, yearEnd: object|null, payrolls: Array, year: number }} p
 *   yearEnd：その年分の年末調整の記録（確定・精算済みなら年末調整の結果を使う）
 */
export function withholdingSlip({ employee, yearEnd = null, payrolls, year }) {
  const sum = yearPayTotals(payrolls, employee.id, year);
  const done = yearEnd && yearEnd.status !== 'draft' && yearEnd.result?.lines ? yearEnd : null;
  const r = done?.result ?? null;
  const live = done ? yearEndCalc(done, { payrolls, employee }) : null;
  const prev = done ? done.previous || {} : {};
  const ins = done ? done.insurance || {} : {};
  const warnings = [];
  const remarks = [];

  const inYear = (d) => !!d && isValidDate(d) && d.startsWith(`${year}-`);
  const joined = inYear(employee.joinedOn);
  const retired = inYear(employee.retiredOn);
  const omittable = retired && sum.pay <= OMIT_LIMIT;

  // 家族の欄（年末調整をした人だけ。しなかった人は扶養控除等申告書を見て書き足してもらう）
  let spouseRow = null;
  const dependentRows = [];
  const youngRows = [];
  if (done) {
    const sp = done.spouse;
    if (sp && r.spouseKind) spouseRow = { name: sp.name, code: familyCode(sp, year, true), nonResident: !!sp.nonResident };
    done.dependents.forEach((d, i) => {
      const c = live.classes[i];
      const row = { name: d.name, code: familyCode(d, year, false), nonResident: !!d.nonResident, cls: c };
      if (TARGET_CLASSES.includes(c)) dependentRows.push(row);
      else if (c === 'young') youngRows.push(row);
    });
    if ([spouseRow, ...dependentRows, ...youngRows].some((x) => x && x.code == null)) warnings.push('30歳以上70歳未満の非居住者の扶養親族は、区分の欄（02 留学・03 障害者・04 38万円以上の送金）を書き足してください');
    dependentRows.slice(FAMILY_ROWS).forEach((x, i) => remarks.push(`(${FAMILY_ROWS + 1 + i})${x.name}`));
    youngRows.slice(FAMILY_ROWS).forEach((x, i) => remarks.push(`(${FAMILY_ROWS + 1 + i})${x.name}（年少）`));

    // 控除対象配偶者を除く同一生計配偶者が障害者なら「氏名（同配）」。所得金額調整控除の対象の同一生計配偶者・扶養親族は、
    // 家族の欄に載っていなければ「氏名（同配）」「氏名（調整）」（本人が特別障害者なら書かない）
    const shown = new Set([spouseRow, ...dependentRows.slice(0, FAMILY_ROWS), ...youngRows.slice(0, FAMILY_ROWS)].filter(Boolean).map((x) => x.name));
    const sameLivingNote = sp && r.spouseSameLiving && !r.spouseKind && sp.disability !== 'none';
    if (sameLivingNote) remarks.push(`${sp.name}（同配）`);
    if (r.adjustment > 0 && done.person?.disability !== 'special') {
      const limit = dependentIncomeLimit(year);
      if (sp && r.spouseSameLiving && sp.disability?.startsWith('special') && !sameLivingNote && !shown.has(sp.name)) remarks.push(`${sp.name}（同配）`);
      for (const d of done.dependents) {
        if (shown.has(d.name) || (d.income || 0) > limit) continue;
        if ((ageAtYearEnd(d.birthDate, year) ?? 99) < 23 || d.disability?.startsWith('special')) remarks.push(`${d.name}（調整）`);
      }
    }
    if (live.hasUnder23 && (ins.lifeNew || 0) > 0) remarks.push('租税特別措置法第41条の15の5第1項適用');
    if ((prev.pay || 0) > 0) {
      remarks.push(`前職分 ${prev.name || '（前の支払者）'} 支払金額${formatYen(prev.pay)}円 源泉徴収税額${formatYen(prev.tax || 0)}円 社会保険料等${formatYen(prev.social || 0)}円${prev.retiredOn ? ` ${eraText(prev.retiredOn)}退職` : ''}`);
      warnings.push('前の支払者の住所（所在地）を摘要に書き足してください');
    }
    const changed = snapshotChanges(r, live);
    if (changed.length) warnings.push(`年末調整を確定した後に${changed.map((c) => c.label).join('・')}が変わっています。年末調整の確定を取り消して計算し直してください`);
    if (r.housingPossible > 0) warnings.push('住宅借入金等特別控除の内訳（居住開始年月日・控除区分・年末残高）は、住宅借入金等特別控除申告書を見て書き足してください');
  } else {
    if (yearEnd?.status === 'draft') warnings.push('年末調整が確定していません。年末調整をする人は、先に年末調整を確定してください');
    else if (supportedYearEndYears().includes(year) && employee.taxColumn === 'kou' && !retired && employee.active !== false) warnings.push('年末調整をしていません。12月の給与で年末調整をする人は、先に年末調整を確定してください');
    if (employee.taxColumn === 'kou' && employee.dependents > 0) warnings.push('年末調整をしていないため、源泉控除対象配偶者・控除対象扶養親族の欄は扶養控除等申告書を見て書き足してください');
  }
  if (joined && retired) remarks.push('中途就');
  if (!employee.address) warnings.push('住所を従業員の登録に入れてください');
  if (!isValidDate(employee.birthDate)) warnings.push('生年月日を従業員の登録に入れてください');
  if (employee.active === false && !employee.retiredOn) warnings.push('退職した人は、退職した日を従業員の登録に入れてください（提出の要否と「中途就・退職」の欄に使います）');
  if (sum.unposted) warnings.push(`仕訳を登録していない給与が${sum.unposted}件あります（含めて集計しています）`);

  const lines = r?.lines;
  const tax = done ? r.annualTax : sum.tax;
  return {
    employeeId: employee.id,
    year,
    name: employee.name,
    kana: employee.kana || '',
    address: employee.address || '',
    adjusted: !!done,
    yearEndStatus: yearEnd?.status ?? null,
    kind: slipKind(sum),
    pay: done ? r.pay : sum.pay,
    salaryIncome: done ? r.afterAdjust : null,
    totalDeductions: done ? r.totalDeductions : null,
    tax,
    spouse: done
      ? { has: r.spouseKind === 'spouse', elderly: r.spouseKind === 'spouse' && !!r.spouseElderly, amount: lines.spouse, income: r.spouseKind ? done.spouse.income || 0 : null }
      : { has: null, elderly: null, amount: null, income: null },
    counts: done
      ? {
          specific: r.counts.specific,
          elderly: r.counts.elderly,
          elderlyCohabiting: r.counts.elderlyCohabiting,
          other: r.counts.general,
          specificRelative: r.counts.specificRelative,
          young: r.counts.young,
          disabledSpecial: r.counts.disabledSpecial,
          disabledSpecialCohabiting: r.counts.disabledSpecialCohabiting,
          disabledOther: r.counts.disabledOther,
          nonResident: r.counts.nonResident,
        }
      : null,
    social: done ? lines.social + lines.smallBusiness : sum.social,
    smallBusiness: done ? lines.smallBusiness : 0,
    life: done ? lines.life : null,
    earthquake: done ? lines.earthquake : null,
    housing: done ? r.housing : null,
    specificRelative: done ? lines.specificRelative : null,
    lifeBreakdown: done ? { lifeNew: ins.lifeNew || 0, lifeOld: ins.lifeOld || 0, care: ins.care || 0, pensionNew: ins.pensionNew || 0, pensionOld: ins.pensionOld || 0 } : null,
    housingPossible: done && r.housingPossible > 0 ? r.housingPossible : null,
    oldLongTerm: done ? ins.oldLongTerm || 0 : null,
    nationalPension: done ? ins.nationalPension || 0 : null,
    basic: done ? lines.basic : null,
    adjustment: done ? r.adjustment : null,
    spouseRow,
    dependentRows: dependentRows.slice(0, FAMILY_ROWS),
    youngRows: youngRows.slice(0, FAMILY_ROWS),
    flags: {
      minor: isMinor(employee.birthDate, year),
      foreigner: employee.foreigner === true,
      deceased: employee.deceased === true && retired,
      disaster: false,
      otsu: !done && sum.count > 0 && sum.otsu === sum.count,
      disabled: done && done.person?.disability !== 'none' ? done.person.disability : null,
      widow: !!done && done.person?.widow === 'widow' && lines.widow > 0,
      singleParent: !!done && done.person?.widow === 'single_parent' && lines.widow > 0,
      student: !!done && lines.student > 0,
    },
    // 同じ年に就職して退職した人は、退職の欄と退職した日（就職の欄は「2」＝該当しない）で、摘要に「中途就」
    midway: joined || retired ? { joined: joined && !retired, retired, date: retired ? employee.retiredOn : employee.joinedOn } : null,
    birthDate: isValidDate(employee.birthDate) ? employee.birthDate : '',
    birth: eraDate(employee.birthDate),
    remarks,
    warnings,
    // 提出と合計表
    retired,
    omittable,
    city: employee.residentCity || '',
    collection: retired ? 'ordinary' : employee.residentCollection === 'ordinary' ? 'ordinary' : 'special',
    ownPay: sum.pay,
    ownTax: done ? Math.max(0, r.annualTax - (prev.tax || 0)) : sum.tax,
  };
}

/** その年に給与を支払った人の源泉徴収票（従業員の並び順） */
export function withholdingSlips({ employees, payrolls, yearEnds, year }) {
  const ids = new Set(payrolls.filter((p) => p.payDate.startsWith(`${year}-`)).map((p) => p.employeeId));
  return employees.filter((e) => ids.has(e.id)).map((employee) => withholdingSlip({ employee, yearEnd: yearEnds.find((x) => x.employeeId === employee.id && x.year === year) || null, payrolls, year }));
}

/**
 * 合計表の「給与所得の源泉徴収票合計表」欄と、給与支払報告書の市区町村ごとの人数
 * @returns {{ a: {count, noTax, pay, tax}, b: {count, pay, tax}, omitted: number, cities: Array<{city, count, special, retired, ordinary}> }}
 */
export function slipTotals(slips) {
  const a = { count: slips.length, noTax: slips.filter((s) => s.tax === 0).length, pay: 0, tax: 0 };
  const b = { count: 0, pay: 0, tax: 0 };
  const cities = new Map();
  for (const s of slips) {
    a.pay += s.ownPay;
    a.tax += s.ownTax;
    if (s.omittable) continue;
    b.count += 1;
    b.pay += s.pay;
    b.tax += s.tax;
    const c = cities.get(s.city) || { city: s.city, count: 0, special: 0, retired: 0, ordinary: 0 };
    c.count += 1;
    if (s.retired) c.retired += 1;
    else if (s.collection === 'ordinary') c.ordinary += 1;
    else c.special += 1;
    cities.set(s.city, c);
  }
  const list = [...cities.values()].sort((x, y) => (x.city === '' ? 1 : y.city === '' ? -1 : x.city.localeCompare(y.city, 'ja')));
  return { a, b, omitted: slips.filter((s) => s.omittable).length, cities: list };
}

const v = (n) => (n == null ? '' : n);

/** 源泉徴収票の CSV（e-Tax・eLTAX のソフトに書き写すときの一覧） */
export function slipsCsvRows(slips) {
  const rows = [
    [
      '年分', '氏名', 'ふりがな', '住所', '生年月日', '年末調整', '種別', '支払金額', '給与所得控除後の金額（調整控除後）', '所得控除の額の合計額', '源泉徴収税額',
      '控除対象配偶者の有無', '老人控除対象配偶者', '配偶者（特別）控除の額', '特定扶養親族', '老人扶養親族', 'うち同居老親等', 'その他の扶養親族', '特定親族', '16歳未満扶養親族', '特別障害者', 'うち同居特別障害者', 'その他の障害者', '非居住者である親族',
      '社会保険料等の金額', 'うち小規模企業共済等掛金', '生命保険料の控除額', '地震保険料の控除額', '住宅借入金等特別控除の額', '特定親族特別控除の額',
      '新生命保険料の金額', '旧生命保険料の金額', '介護医療保険料の金額', '新個人年金保険料の金額', '旧個人年金保険料の金額', '旧長期損害保険料の金額', '国民年金保険料等の金額', '基礎控除の額', '所得金額調整控除額', '住宅借入金等特別控除可能額', '配偶者の合計所得',
      '未成年者', '外国人', '死亡退職', '乙欄', '本人が障害者', '寡婦', 'ひとり親', '勤労学生', '就職', '退職', '就職・退職の年月日', '摘要', '給与支払報告書', '提出先の市区町村', '住民税の徴収',
    ],
  ];
  for (const s of slips) {
    const c = s.counts || {};
    const lb = s.lifeBreakdown || {};
    const f = s.flags;
    const yes = (b) => (b ? '○' : '');
    rows.push([
      s.year, s.name, s.kana, s.address, eraText(s.birthDate), s.adjusted ? '済' : '未', s.kind, s.pay, v(s.salaryIncome), v(s.totalDeductions), s.tax,
      s.spouse.has == null ? '' : s.spouse.has ? '有' : '無', s.spouse.elderly ? '○' : '', v(s.spouse.amount), v(c.specific), v(c.elderly), v(c.elderlyCohabiting), v(c.other), v(c.specificRelative), v(c.young), v(c.disabledSpecial), v(c.disabledSpecialCohabiting), v(c.disabledOther), v(c.nonResident),
      s.social, s.smallBusiness, v(s.life), v(s.earthquake), v(s.housing), v(s.specificRelative),
      v(lb.lifeNew), v(lb.lifeOld), v(lb.care), v(lb.pensionNew), v(lb.pensionOld), v(s.oldLongTerm), v(s.nationalPension), v(s.basic), v(s.adjustment), v(s.housingPossible), v(s.spouse.income),
      yes(f.minor), yes(f.foreigner), yes(f.deceased), yes(f.otsu), f.disabled === 'general' ? 'その他' : f.disabled ? '特別' : '', yes(f.widow), yes(f.singleParent), yes(f.student),
      yes(s.midway?.joined), yes(s.midway?.retired), s.midway ? s.midway.date : '', s.remarks.join(' '), s.omittable ? '省略できる' : '提出する', s.city, RESIDENT_COLLECTION_LABEL[s.collection],
    ]);
  }
  return rows;
}
