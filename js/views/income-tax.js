// 所得税の確定申告書（個人）：第一表・第二表の欄と、医療費控除の明細書・添付書類の確認
// 弥生会計・freee の確定申告書作成と同じく、事業所得・不動産所得は青色申告決算書（白色は収支内訳書）から、それ以外の所得と控除は入力から作る
// 損失申告（第四表）：本年の純損失と、前年以前から繰り越した純損失を差し引く計算
import { h, put, amountCell, field, showToast, errorBox } from '../ui.js';
import { blueReturnSet, realEstateForFirstTable } from '../real-estate.js';
import { computeIncomeTax, DEFAULT_INCOME_TAX, MEDICAL_KINDS, DEPENDENT_KIND_LABELS, SUPPORTED_YEARS, LOSS_YEARS, rulesFor } from '../income-tax.js';
import { isWhite, whiteReturnSet } from '../white-return.js';
import { formatYen, parseYen } from '../money.js';
import { ValidationError } from '../db.js';
import { errorText } from '../errors.js';

const MARU = '⓪①②③④⑤⑥⑦⑧⑨⑩⑪⑫⑬⑭⑮⑯⑰⑱⑲⑳㉑㉒㉓㉔㉕㉖㉗㉘㉙㉚㉛㉜㉝㉞㉟㊱㊲㊳㊴㊵㊶㊷㊸㊹㊺㊻㊼㊽㊾㊿';
const maru = (n) => (typeof n === 'number' ? MARU[n] || String(n) : n);
const clone = (o) => JSON.parse(JSON.stringify(o));

export async function render({ app, outlet }) {
  const { settings, period, accounts, journals } = await app.load();
  if (settings.entityType !== 'individual') return put(outlet, h('p', { class: 'notice', text: '所得税の確定申告書は個人事業主の画面です。' }));
  const year = Number(period.endDate.slice(0, 4));
  const white = isWhite(settings);
  // 決算書の数字：青色は青色申告決算書（一般用㊺・不動産所得用㉓）、白色は収支内訳書（一般用㉑・不動産所得用⑮）
  let business, realEstate, re, reIncome, landInterest, deduction;
  if (white) {
    const w = whiteReturnSet({ settings, accounts, period, journals });
    re = w.realEstate;
    reIncome = re ? re.lines[15] : 0;
    landInterest = w.landInterest;
    business = { revenue: w.general ? w.general.lines[4] : 0, income: w.general ? w.general.lines[21] : 0, familySalary: w.familyTotal, blueDeduction: 0 };
    realEstate = re ? { revenue: re.income, income: realEstateForFirstTable(reIncome, landInterest) } : null;
  } else {
    const blue = blueReturnSet({ settings, accounts, period, journals });
    const is = blue.business;
    re = blue.realEstate;
    reIncome = re ? re.lines[23] : 0;
    landInterest = blue.landInterest;
    deduction = blue.selected;
    business = { revenue: is.lines[1], income: is.lines[45], familySalary: is.lines[38] + (re ? re.lines[20] : 0), blueDeduction: is.lines[44] + (re ? re.lines[22] : 0) };
    realEstate = re ? { revenue: re.lines[4], income: realEstateForFirstTable(reIncome, landInterest) } : null;
  }
  const source = white ? '収支内訳書' : '青色申告決算書';
  const input = clone({ ...DEFAULT_INCOME_TAX, ...(period.incomeTaxReturn || {}) });
  const resultEl = h('div');
  const errorsEl = h('div');
  const editorBody = h('div');

  if (!SUPPORTED_YEARS.includes(year) || period.startDate.slice(0, 4) !== period.endDate.slice(0, 4)) {
    return put(outlet, h('p', { class: 'notice', text: `令和${year - 2018}年分の確定申告書には対応していません（対応：${SUPPORTED_YEARS.map((y) => `令和${y - 2018}年分`).join('・')}。令和9年分以後は防衛特別所得税などの改正を確認してから対応します）。` }));
  }

  const row = (no, label, amount, { strong = false, sub = '' } = {}) => h('tr', { class: strong ? 'mt-strong' : '' }, h('td', { class: 'tf-no', text: maru(no) }), h('th', { scope: 'row' }, label, sub ? h('span', { class: 'muted small block', text: sub }) : null), amountCell('td', amount));
  const table = (title, rows) => [h('h4', { class: 'it-sub', text: title }), h('div', { class: 'table-wrap' }, h('table', { class: 'report taxform', 'aria-label': title }, h('tbody', {}, rows)))];
  const section = (title, ...content) => h('section', { class: 'fs-section' }, h('h3', { class: 'tf-title', text: title }), ...content);

  function firstTable(r) {
    const L = r.lines;
    return section(
      `確定申告書 第一表（令和${year - 2018}年分）`,
      table('収入金額等', [row('㋐', '事業　営業等', r.rev.a, { sub: white ? '収支内訳書（一般用）の収入金額の計④' : '' }), re ? row('㋒', '不動産', r.rev.c, { sub: white ? '収支内訳書（不動産所得用）の収入金額の計' : '不動産所得用の収入金額④' }) : null, row('㋔', '給与', r.rev.e), row('㋖', '雑　業務', r.rev.g), row('㋗', '雑　その他', r.rev.h)]),
      table('所得金額等', [
        row(1, '事業　営業等', L[1], { sub: white ? '収支内訳書（一般用）の所得金額㉑' : '青色申告決算書の所得金額㊺' }),
        re
          ? row(3, '不動産', L[3], {
              sub: reIncome < 0 && landInterest ? `不動産所得用の${white ? '⑮' : '㉓'}（△${formatYen(-reIncome)}）から土地等を取得するための負債の利子 ${formatYen(landInterest)}円の分を除く` : white ? '収支内訳書（不動産所得用）の所得金額⑮' : '青色申告決算書（不動産所得用）の所得金額㉓',
            })
          : null,
        row(6, '給与', L[6]),
        row(8, '雑　業務', L[8]),
        row(9, '雑　その他', L[9]),
        row(10, '雑の計（⑦〜⑨）', L[10]),
        row(12, '合計', L[12], { strong: true, sub: r.loss.carried ? `繰越損失 ${formatYen(r.loss.carried)}円を差し引いた後（第四表）` : r.loss.netLoss ? `損失 △${formatYen(r.loss.netLoss)}円（第四表）` : '' }),
      ]),
      table('所得から差し引かれる金額', [
        row(13, '社会保険料控除', L[13]),
        row(14, '小規模企業共済等掛金控除', L[14]),
        row(15, '生命保険料控除', L[15]),
        row(16, '地震保険料控除', L[16]),
        row('⑰⑱', '寡婦、ひとり親控除', L[17]),
        row('⑲', '勤労学生控除', L[19]),
        row('⑳', '障害者控除', L[20]),
        row('㉑㉒', r.spouse?.kind === 'special' ? '配偶者特別控除' : '配偶者控除', L[21]),
        row(23, '扶養控除', L[23]),
        row(24, '特定親族特別控除', L[24]),
        row(25, '基礎控除', L[25]),
        row(26, '⑬から㉕までの計', L[26], { strong: true }),
        row(28, '医療費控除', L[28]),
        row(29, '寄附金控除', L[29]),
        row(30, '合計', L[30], { strong: true }),
      ]),
      table('税金の計算', [
        row(31, '課税される所得金額（⑫−㉚）', L[31], { sub: '1,000円未満切捨て' }),
        row(32, '上の㉛に対する税額', L[32]),
        row(35, '住宅借入金等特別控除', L[35]),
        row(42, '差引所得税額', L[42]),
        row(44, '再差引所得税額（基準所得税額）', L[44]),
        row(45, '復興特別所得税額（㊹×2.1%）', L[45]),
        row(46, '所得税及び復興特別所得税の額', L[46], { strong: true }),
        row(49, '源泉徴収税額', L[49]),
        row(50, '申告納税額', L[50], { strong: true, sub: '納める場合は100円未満切捨て' }),
        row(51, '予定納税額（第1期分・第2期分）', L[51]),
        row(52, '第3期分の税額　納める税金', L[52], { strong: true }),
        row(53, '第3期分の税額　還付される税金', L[53], { strong: true }),
      ]),
      table('その他', [
        row('', '配偶者の合計所得金額', r.other.spouseIncome ?? 0),
        row('', '専従者給与（控除）額の合計額', r.other.familySalary, { sub: white ? '収支内訳書の専従者控除の合計' : re ? '一般用の㊳と不動産所得用の⑳の合計' : '' }),
        white ? null : row('', '青色申告特別控除額', r.other.blueDeduction, { sub: re ? '一般用の㊹と不動産所得用の㉒の合計' : '' }),
        row('', '雑所得・一時所得等の源泉徴収税額の合計額', r.other.miscWithholding),
      ]),
    );
  }

  function secondTable(r) {
    const td = (t, cls = '') => h('td', { class: cls, text: t });
    const simple = (title, head, rows) => [h('h4', { class: 'it-sub', text: title }), h('div', { class: 'table-wrap' }, h('table', { class: 'report taxform it-list' }, h('thead', {}, h('tr', {}, head.map((t) => h('th', { scope: 'col', text: t })))), h('tbody', {}, rows)))];
    const people = [
      ...(r.spouse ? [h('tr', {}, td(r.spouse.name), td('配偶者'), td(r.spouse.birthDate.replaceAll('-', '/'), 'num'), td(r.spouse.familyWorker ? '事業専従者（控除の対象外）' : r.spouse.kind === 'special' ? '配偶者特別控除' : r.spouse.kind ? (r.spouse.elderly ? '老人控除対象配偶者' : '控除対象配偶者') : '対象外'))] : []),
      ...r.dependents.map((d) => h('tr', {}, td(d.name), td(d.relation || '親族'), td(d.birthDate.replaceAll('-', '/'), 'num'), td(DEPENDENT_KIND_LABELS[d.kind]))),
    ];
    const life = input.life;
    return section(
      '確定申告書 第二表',
      input.salaryRevenue ? simple('所得の内訳（源泉徴収税額）', ['種目', '支払者', '収入金額', '源泉徴収税額'], [h('tr', {}, td('給与'), td(input.salaryPayer || '（未入力）'), amountCell('td', input.salaryRevenue), amountCell('td', input.salaryWithholding))]) : null,
      table('保険料控除等に関する事項', [
        row('⑬', '社会保険料（支払保険料等の計）', input.socialInsurance),
        row('⑭', '小規模企業共済等掛金', input.smallBusinessAid),
        row('⑮', '新生命保険料', life.newGeneral),
        row('', '旧生命保険料', life.oldGeneral),
        row('', '新個人年金保険料', life.newPension),
        row('', '旧個人年金保険料', life.oldPension),
        row('', '介護医療保険料', life.newMedical),
        row('⑯', '地震保険料', input.earthquake.quake),
        row('', '旧長期損害保険料', input.earthquake.oldLongTerm),
      ]),
      people.length ? simple('配偶者や親族に関する事項', ['氏名', '続柄', '生年月日', '控除の区分'], people) : null,
      h('p', { class: 'muted small', text: `事業専従者に関する事項：${white ? '専従者控除' : '専従者給与'}の合計 ${formatYen(r.other.familySalary)}円（氏名・続柄・従事月数は第二表に記入してください）。16歳未満の扶養親族は「住民税・事業税に関する事項」に書きます。` }),
    );
  }

  /** 確定申告書 第四表（損失申告用）：経常所得だけの計算（譲渡・山林・退職・分離課税の所得は対象外） */
  function lossTable(r) {
    const lo = r.loss;
    if (!lo.needed) return null;
    const reiwa = (y) => `令和${y - 2018}年分`;
    const carryRows = lo.carry.filter((c) => c.available > 0);
    return section(
      '確定申告書 第四表（損失申告用）',
      table('1 損失額又は所得金額・2 損益の通算', [
        row('A', '経常所得（①〜⑥・⑩の合計）', lo.ordinary, { sub: '事業・不動産・給与・雑所得を損益通算した後の金額' }),
        lo.netLoss ? row('', '本年分の純損失の金額', lo.netLoss, { strong: true }) : null,
      ]),
      lo.netLoss
        ? table('3 翌年以後に繰り越す損失額', [
            row('', white ? '翌年以後に繰り越す損失額' : '青色申告者の損失の金額', lo.carryForward, { strong: true, sub: white ? '白色申告の純損失は、変動所得・被災事業用資産の損失の分だけ繰り越せます（この画面では計算していません）' : '翌年以後3年間、所得から差し引けます（毎年続けて確定申告が必要）' }),
          ])
        : null,
      carryRows.map((c) =>
        table(`4 繰越損失を差し引く計算（${reiwa(c.year)}の純損失）`, [
          row('Ⓐ', '前年分までに引ききれなかった損失額', c.available),
          row('Ⓑ', '本年分で差し引く損失額', c.used, { strong: true }),
          row('Ⓒ', '翌年分以後に繰り越して差し引かれる損失額（Ⓐ−Ⓑ）', c.remaining, { sub: c.key === 'y3' && c.remaining ? '3年前の分なので翌年には繰り越せません（繰越期限切れ）' : '' }),
        ]),
      ),
      table('所得金額', [
        row('', '合計所得金額（繰越控除の前）', r.totalIncome, { sub: '基礎控除・配偶者控除などの所得の判定に使います' }),
        row('M', '雑損控除、医療費控除及び寄附金控除の計算で使用する所得金額の合計額', r.lines[12], { strong: true, sub: '繰越損失を差し引いた後。第一表の⑫' }),
      ]),
      h('p', { class: 'muted small', text: '第四表を使う年の第一表の書き方（⑪・⑫など）は、国税庁「確定申告書の書き方（損失申告用）」に従ってください。この画面の⑫は繰越損失を差し引いた後の金額です。' }),
      h('p', { class: 'muted small', text: `来年（${reiwa(year + 1)}）の入力：3年前の分 ${formatYen(lo.next.y3)}円・2年前の分 ${formatYen(lo.next.y2)}円・前年の分 ${formatYen(lo.next.y1)}円${lo.expired ? `。${reiwa(year - 3)}の残り ${formatYen(lo.expired)}円は繰越期限が切れます` : ''}。` }),
    );
  }

  function medicalStatement(r) {
    if (!input.medical.length) return null;
    const td = (t) => h('td', { text: t });
    const kind = (id) => MEDICAL_KINDS.find((k) => k.id === id)?.label ?? '';
    return section(
      '医療費控除の明細書',
      h('div', { class: 'table-wrap' }, h('table', { class: 'report taxform it-list' }, h('thead', {}, h('tr', {}, ['医療を受けた方', '病院・薬局などの支払先', '区分', '支払った医療費', '補填される金額'].map((t) => h('th', { scope: 'col', text: t })))), h('tbody', {}, input.medical.map((m) => h('tr', {}, td(m.name), td(m.payee), td(kind(m.kind)), amountCell('td', m.paid), amountCell('td', m.reimbursed)))))),
      table('控除額の計算', [
        row('A', '支払った医療費', r.medical.paid),
        row('B', '保険金などで補填される金額', r.medical.reimbursed),
        row('C', '差引金額（A−B）', r.medical.net),
        row('E', '10万円と所得金額等の5%の少ない方', r.medical.threshold),
        row('', '医療費控除額（C−E、最高200万円）', r.lines[28], { strong: true }),
      ]),
    );
  }

  function attachments(r) {
    const items = [
      ['青色申告決算書（一般用・4ページ）', !white && (settings.realEstate !== 'only' || !re), h('a', { href: '#/reports/blue-return', class: 'link', text: '青色申告決算書を開く' })],
      ['青色申告決算書（不動産所得用・4ページ）', !white && Boolean(re), h('a', { href: '#/reports/blue-return-re', class: 'link', text: '不動産所得用を開く' })],
      ['収支内訳書（一般用・2ページ）', white && settings.realEstate !== 'only', h('a', { href: '#/reports/white-return', class: 'link', text: '収支内訳書を開く' })],
      ['収支内訳書（不動産所得用・2ページ）', white && Boolean(re), h('a', { href: '#/reports/white-return?page=r1', class: 'link', text: '不動産所得用を開く' })],
      ['確定申告書 第四表（損失申告用）', r.loss.needed, '純損失がある年や繰越損失を差し引く年に、第一表・第二表と一緒に提出します'],
      ['医療費控除の明細書', input.medical.length > 0, '医療費の領収書は5年間保存（提出は不要）'],
      ['社会保険料（国民年金保険料）控除証明書', input.socialInsurance > 0, '国民年金保険料・国民年金基金の分。e-Tax なら提出を省略できます'],
      ['小規模企業共済等掛金払込証明書', input.smallBusinessAid > 0, ''],
      ['生命保険料・地震保険料の控除証明書', r.lines[15] + r.lines[16] > 0, 'e-Tax なら提出を省略できます（5年間保存）'],
      ['寄附金の受領証明書', input.donations > 0, 'ふるさと納税は寄附金控除に関する証明書でもよい'],
      ['住宅借入金等特別控除額の計算明細書', input.housingLoanCredit > 0, '1年目は登記事項証明書・売買契約書の写しなども必要'],
      ['給与所得の源泉徴収票', input.salaryRevenue > 0, '平成31年4月以後は添付不要（第二表に転記）'],
    ];
    return section(
      '添付書類・提出書類の確認',
      h('ul', { class: 'it-attach' }, items.filter(([, need]) => need).map(([label, , note]) => h('li', {}, h('strong', { text: label }), note ? h('span', { class: 'muted small block' }, note) : null))),
    );
  }

  function paint() {
    const r = computeIncomeTax({ year, business, realEstate, input, white });
    const pay = r.lines[52];
    const refund = r.lines[53];
    put(
      resultEl,
      h(
        'div',
        { class: 'kpi-grid' },
        h('div', { class: 'kpi' }, h('span', { class: 'kpi-label', text: refund ? '還付される税金' : '納める税金' }), h('span', { class: 'kpi-value num', text: `${formatYen(refund || pay)}円` }), h('span', { class: 'kpi-sub', text: refund ? '第3期分（還付）' : '第3期分（3月15日まで）' })),
        h('div', { class: 'kpi' }, h('span', { class: 'kpi-label', text: '課税される所得金額' }), h('span', { class: 'kpi-value num', text: `${formatYen(r.lines[31])}円` }), h('span', { class: 'kpi-sub', text: `所得税及び復興特別所得税 ${formatYen(r.lines[46])}円` })),
      ),
      firstTable(r),
      secondTable(r),
      lossTable(r),
      medicalStatement(r),
      attachments(r),
    );
  }

  // 入力欄
  const get = (path) => path.reduce((o, k) => o?.[k], input);
  const set = (path, value) => {
    let o = input;
    path.slice(0, -1).forEach((k) => (o = o[k]));
    o[path.at(-1)] = value;
  };
  const yen = (label, path, { hint, allowNegative = false } = {}) =>
    field(
      label,
      h('input', {
        id: `it-${path.join('-')}`,
        type: 'text',
        inputmode: 'numeric',
        value: get(path) ? String(get(path)) : '',
        placeholder: '0',
        oninput: (e) => {
          const v = e.target.value.trim();
          const res = v === '' ? { ok: true, value: 0 } : parseYen(v, { allowZero: true, allowNegative });
          set(path, res.ok ? res.value : NaN);
          if (res.ok) paint();
        },
      }),
      { hint },
    );
  const text = (label, path, placeholder = '') => field(label, h('input', { id: `it-${path.join('-')}`, type: 'text', value: get(path) ?? '', placeholder, maxlength: 40, oninput: (e) => (set(path, e.target.value), paint()) }));
  const date = (label, path) => field(label, h('input', { id: `it-${path.join('-')}`, type: 'date', value: get(path) ?? '', oninput: (e) => (set(path, e.target.value), paint()) }));
  const group = (title, ...children) => h('fieldset', { class: 'it-group' }, h('legend', { text: title }), ...children);

  function personFields(path, withRelation) {
    const person = get(path);
    return [
      h('div', { class: 'field-row' }, text('氏名', [...path, 'name']), withRelation ? text('続柄', [...path, 'relation'], '子・母など') : date('生年月日', [...path, 'birthDate'])),
      h('div', { class: 'field-row' }, withRelation ? date('生年月日', [...path, 'birthDate']) : null, yen('合計所得金額', [...path, 'income'], { hint: '給与だけなら給与所得の金額' })),
      h('label', { class: 'check small' }, h('input', { type: 'checkbox', checked: Boolean(person.familyWorker), onchange: (e) => ((person.familyWorker = e.target.checked), paint()) }), `事業専従者（${white ? '専従者控除' : '専従者給与'}の対象。配偶者控除・扶養控除は受けられません）`),
    ];
  }

  function paintEditor() {
    const dependents = input.dependents.map((d, i) =>
      h(
        'div',
        { class: 'it-item' },
        ...personFields(['dependents', i], true),
        h('label', { class: 'check small' }, h('input', { type: 'checkbox', checked: d.livingWithParent, onchange: (e) => ((d.livingWithParent = e.target.checked), paint()) }), '同居している70歳以上の父母・祖父母（同居老親等）'),
        h('button', { type: 'button', class: 'btn btn-small btn-danger-text', text: 'この親族を削除', onclick: () => (input.dependents.splice(i, 1), paintEditor(), paint()) }),
      ),
    );
    const medical = input.medical.map((m, i) =>
      h(
        'div',
        { class: 'it-item' },
        h('div', { class: 'field-row' }, text('医療を受けた方', ['medical', i, 'name']), text('支払先', ['medical', i, 'payee'])),
        field('区分', h('select', { id: `it-medical-${i}-kind`, onchange: (e) => ((m.kind = e.target.value), paint()) }, MEDICAL_KINDS.map((k) => h('option', { value: k.id, text: k.label, selected: m.kind === k.id })))),
        h('div', { class: 'field-row' }, yen('支払った医療費', ['medical', i, 'paid']), yen('補填される金額', ['medical', i, 'reimbursed'])),
        h('button', { type: 'button', class: 'btn btn-small btn-danger-text', text: 'この行を削除', onclick: () => (input.medical.splice(i, 1), paintEditor(), paint()) }),
      ),
    );
    const r = rulesFor(year);
    put(
      editorBody,
      group('給与所得', text('支払者（勤務先）', ['salaryPayer']), h('div', { class: 'field-row' }, yen('給与の収入金額', ['salaryRevenue']), yen('源泉徴収税額', ['salaryWithholding']))),
      group('雑所得（副業・原稿料など）', h('div', { class: 'field-row' }, yen('業務の収入', ['miscBusinessRevenue']), yen('業務の必要経費', ['miscBusinessExpenses'])), h('div', { class: 'field-row' }, yen('その他の収入', ['miscOtherRevenue']), yen('その他の必要経費', ['miscOtherExpenses'])), yen('雑所得・事業所得の源泉徴収税額', ['miscWithholding'], { hint: '報酬から差し引かれた所得税（支払調書の金額）' })),
      group('社会保険料・共済掛金', h('div', { class: 'field-row' }, yen('社会保険料', ['socialInsurance'], { hint: '国民年金・国民健康保険など' }), yen('小規模企業共済等掛金', ['smallBusinessAid'], { hint: 'iDeCo を含む' }))),
      group(
        '生命保険料・地震保険料（年間の支払額）',
        h('div', { class: 'field-row' }, yen('新生命保険料', ['life', 'newGeneral']), yen('旧生命保険料', ['life', 'oldGeneral'])),
        h('div', { class: 'field-row' }, yen('新個人年金保険料', ['life', 'newPension']), yen('旧個人年金保険料', ['life', 'oldPension'])),
        h('div', { class: 'field-row' }, yen('介護医療保険料', ['life', 'newMedical']), yen('地震保険料', ['earthquake', 'quake'])),
        yen('旧長期損害保険料', ['earthquake', 'oldLongTerm']),
      ),
      group(
        '本人の状況',
        field('寡婦・ひとり親', h('select', { id: 'it-widow', onchange: (e) => ((input.widow = e.target.value), paint()) }, [['none', '該当しない'], ['widow', '寡婦（27万円）'], ['single_parent', `ひとり親（${r.singleParent / 10000}万円）`]].map(([v, t]) => h('option', { value: v, text: t, selected: input.widow === v })))),
        h('label', { class: 'check small' }, h('input', { type: 'checkbox', checked: input.workingStudent, onchange: (e) => ((input.workingStudent = e.target.checked), paint()) }), '勤労学生'),
        h(
          'div',
          { class: 'field-row et-rates' },
          ...[['normal', '障害者'], ['special', '特別障害者'], ['specialLiving', '同居特別障害者']].map(([k, label]) =>
            field(`${label}（人）`, h('input', { id: `it-disabled-${k}`, type: 'text', inputmode: 'numeric', value: String(input.disabled[k]), oninput: (e) => ((input.disabled[k] = /^\d+$/.test(e.target.value.trim()) ? Number(e.target.value.trim()) : NaN), Number.isInteger(input.disabled[k]) && paint()) })),
          ),
        ),
      ),
      group(
        '配偶者',
        input.spouse
          ? [...personFields(['spouse'], false), h('button', { type: 'button', class: 'btn btn-small btn-danger-text', text: '配偶者の入力を消す', onclick: () => ((input.spouse = null), paintEditor(), paint()) })]
          : h('button', { type: 'button', class: 'btn btn-small', text: '配偶者を入力する', onclick: () => ((input.spouse = { name: '', birthDate: '', income: 0 }), paintEditor()) }),
      ),
      group('扶養親族（16歳未満の子も入力）', ...dependents, h('button', { type: 'button', class: 'btn btn-small', text: '親族を追加', onclick: () => (input.dependents.push({ name: '', relation: '', birthDate: '', income: 0, livingWithParent: false }), paintEditor()) })),
      group('医療費（医療費控除の明細書）', ...medical, h('button', { type: 'button', class: 'btn btn-small', text: '医療費を追加', onclick: () => (input.medical.push({ name: '本人', payee: '', kind: 'treatment', paid: 0, reimbursed: 0 }), paintEditor()) })),
      group(
        '繰越損失（第四表）',
        h('p', { class: 'muted small', text: '前年以前の確定申告書（第四表）で翌年以後に繰り越した純損失のうち、まだ差し引いていない金額。3年前の分から順に差し引きます。' }),
        h('div', { class: 'field-row' }, ...LOSS_YEARS.slice(0, 2).map(([k, ago]) => yen(`令和${year - ago - 2018}年分（${ago}年前）`, ['lossCarry', k]))),
        yen(`令和${year - 1 - 2018}年分（前年）`, ['lossCarry', 'y1']),
      ),
      group('その他', h('div', { class: 'field-row' }, yen('寄附金（ふるさと納税など）', ['donations']), yen('住宅借入金等特別控除額', ['housingLoanCredit'], { hint: '計算明細書で計算した額' })), h('div', { class: 'field-row' }, yen('予定納税額 第1期分', ['prepaid1']), yen('予定納税額 第2期分', ['prepaid2']))),
    );
  }

  async function save() {
    try {
      await app.db.saveIncomeTaxReturn(period.id, input);
      put(errorsEl);
      showToast('確定申告書の入力を保存しました');
    } catch (e) {
      put(errorsEl, errorBox(e instanceof ValidationError ? (Array.isArray(e.errors) ? e.errors : Object.values(e.errors)) : [errorText(e, '保存')]));
    }
  }

  put(
    outlet,
    h('p', { class: 'muted small', text: `${settings.businessName}　令和${year - 2018}年分　${re ? '事業所得・不動産所得' : '事業所得'}は${white ? '収支内訳書（白色申告）' : `青色申告決算書（青色申告特別控除 ${formatYen(deduction)}円）`}から` }),
    resultEl,
    h('details', { class: 'panel no-print', open: !period.incomeTaxReturn }, h('summary', { text: '所得と控除を入力する' }), editorBody, errorsEl, h('button', { type: 'button', class: 'btn btn-block', text: '入力を保存する', onclick: save })),
    h(
      'div',
      { class: 'panel small muted' },
      h('p', { text: `事業所得（営業等）・不動産所得・給与所得・雑所得と、主な所得控除から、第一表・第二表と第四表（損失申告用）の欄を計算します。事業所得・不動産所得は${source}から取ります。数字を確定申告書等作成コーナーや e-Tax に転記して提出してください。` }),
      h('p', { text: '対応していないもの：配当・譲渡・一時所得、公的年金等、分離課税（第三表）、変動所得・被災事業用資産の損失、純損失の繰戻し還付、雑損控除と雑損失の繰越し、セルフメディケーション税制、所得金額調整控除、配当控除・外国税額控除、政党等寄附金特別控除。住宅借入金等特別控除は計算した額を入力します。' }),
      h('p', { text: '欄の番号は令和7年分の様式に合わせています。令和8年分の様式が公表されたら照合します。' }),
    ),
  );
  paintEditor();
  paint();
}
