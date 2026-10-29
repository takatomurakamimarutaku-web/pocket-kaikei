// 年末調整の入力：申告書の内容（本人・配偶者・扶養親族・保険料・住宅ローン・前職分）と計算の結果、確定・精算
import { h, put, field, showToast, confirmDialog, errorBox } from '../ui.js';
import { formatYen } from '../money.js';
import { ValidationError } from '../db.js';
import { errorText } from '../errors.js';
import { payrollTitle, PAY_KINDS, MAX_NAME, MAX_NOTE } from '../payroll.js';
import { yearEndCalc, yearEndDraft, familyDraft, validateYearEnd, snapshotChanges, dependentClass, ageAtYearEnd, supportedYearEndYears, DISABILITIES, WIDOW_KINDS, DEPENDENT_CLASS_LABEL, YEAR_END_STATUS, MAX_FAMILY, MAX_RELATION } from '../year-end.js';
import { amountInput, readAmount } from './pay-items.js';
import { diffLabel } from './year-end.js';

const yen = (v) => `${formatYen(v)}円`;
const slash = (d) => d.replaceAll('-', '/');

/** 計算の結果の表（源泉徴収簿の年末調整の欄に近い並び） */
function resultTable(r) {
  const l = r.lines;
  const row = (label, v, { cls = '', sub = '' } = {}) => h('tr', { class: cls }, h('th', { scope: 'row' }, label, sub ? h('span', { class: 'ye-sub', text: sub }) : null), h('td', { class: 'num', text: formatYen(v) }));
  return h(
    'table',
    { class: 'ye-table' },
    h(
      'tbody',
      {},
      row('給与・賞与の支払額', r.pay),
      row('給与所得控除後の給与等の金額', r.salaryIncome),
      r.adjustment ? row('所得金額調整控除', r.adjustment) : null,
      r.adjustment ? row('給与所得控除後の金額（調整控除後）', r.afterAdjust) : null,
      row('社会保険料等の控除', l.social + l.smallBusiness, { sub: l.smallBusiness ? `うち小規模企業共済等掛金 ${formatYen(l.smallBusiness)}` : l.socialDeclared ? `うち申告分 ${formatYen(l.socialDeclared)}` : '' }),
      row('生命保険料控除', l.life),
      row('地震保険料控除', l.earthquake),
      row(r.spouseKind === 'special' ? '配偶者特別控除' : '配偶者控除', l.spouse),
      row('扶養控除', l.dependents),
      l.specificRelative ? row('特定親族特別控除', l.specificRelative) : null,
      row('障害者・寡婦・ひとり親・勤労学生の控除', l.disability + l.widow + l.student),
      row('基礎控除', l.basic, { sub: `本人の合計所得金額 ${formatYen(r.totalIncome)}` }),
      row('所得控除の合計', r.totalDeductions, { cls: 'ye-sum' }),
      row('課税給与所得金額', r.taxable, { sub: '1,000円未満切捨て' }),
      row('算出所得税額', r.calculated),
      r.housingPossible ? row('住宅借入金等特別控除', r.housing, { sub: r.housing < r.housingPossible ? `控除可能額 ${formatYen(r.housingPossible)}` : '' }) : null,
      row('年調所得税額', r.incomeTax),
      row('年調年税額（×102.1%）', r.annualTax, { cls: 'ye-sum', sub: '100円未満切捨て' }),
      row('徴収した税額', r.withheld),
      h('tr', { class: 'ye-diff' }, h('th', { scope: 'row', text: r.diff > 0 ? '不足額（給与から徴収する）' : r.diff < 0 ? '超過額（本人に還付する）' : '過不足額' }), h('td', { class: 'num', text: formatYen(Math.abs(r.diff)) })),
    ),
  );
}

export async function render({ app, outlet, params, query }) {
  const [employees, payrolls, yearEnds] = await Promise.all([app.db.listEmployees(), app.db.listPayrolls(), app.db.listYearEnds()]);
  const editing = params.id ? yearEnds.find((x) => x.id === params.id) : null;
  if (params.id && !editing) return put(outlet, h('p', { class: 'notice', text: '年末調整が見つかりません' }), h('a', { href: '#/payroll/year-end', class: 'btn', text: '一覧へ' }));
  const employee = employees.find((e) => e.id === (editing ? editing.employeeId : query.employee));
  const year = editing ? editing.year : Number(query.year);
  if (!employee || !Number.isInteger(year)) return put(outlet, h('p', { class: 'notice', text: '従業員か年分が見つかりません' }), h('a', { href: '#/payroll/year-end', class: 'btn', text: '一覧へ' }));
  if (!editing) {
    const dup = yearEnds.find((x) => x.employeeId === employee.id && x.year === year);
    if (dup) return app.navigate(`#/payroll/year-end/${dup.id}`, { replace: true });
  }
  app.setTitle(`${employee.name} ${year}年分の年末調整`);
  const supported = supportedYearEndYears().includes(year);
  const prevYear = yearEnds.find((x) => x.employeeId === employee.id && x.year === year - 1) || null;
  const ye = editing ? structuredClone(editing) : yearEndDraft(employee, year, prevYear);
  const locked = ye.status !== 'draft';
  const mine = payrolls.filter((p) => p.employeeId === employee.id);
  const back = `#/payroll/year-end?year=${year}`;
  const errorsEl = h('div', { class: 'errors-wrap' });
  const resultEl = h('div', { class: 'ye-result', 'aria-live': 'polite' });
  let dirty = !editing && Boolean(prevYear);
  const fail = (e, what) => {
    put(errorsEl, errorBox(e instanceof ValidationError ? [].concat(Object.values(e.errors)) : [errorText(e, what)]));
    errorsEl.scrollIntoView({ behavior: 'smooth', block: 'center' });
  };
  if (!locked) {
    app.leaveGuard = async () =>
      !dirty ||
      (await confirmDialog({
        title: '入力中の内容を破棄しますか？',
        buttons: [
          { label: '入力を続ける', value: false },
          { label: '破棄する', value: true, variant: 'danger' },
        ],
      }));
  }

  // ---- 入力欄 ----
  const text = (id, value, max, attrs = {}) => h('input', { id, type: 'text', value: value ?? '', maxlength: max, autocomplete: 'off', ...attrs });
  const select = (id, options, value) => h('select', { id }, options.map((o) => h('option', { value: o.id, text: o.label, selected: o.id === value })));
  const check = (id, checked) => h('input', { id, type: 'checkbox', checked: !!checked });
  const prev = ye.previous;
  const f = {
    prevName: text('ye-prev-name', prev.name, MAX_NAME),
    prevPay: amountInput('ye-prev-pay', prev.pay),
    prevSocial: amountInput('ye-prev-social', prev.social),
    prevTax: amountInput('ye-prev-tax', prev.tax),
    prevRetired: h('input', { id: 'ye-prev-retired', type: 'date', value: prev.retiredOn || '' }),
    disability: select('ye-disability', DISABILITIES.filter((d) => d.id !== 'special_cohabiting'), ye.person.disability),
    widow: select('ye-widow', WIDOW_KINDS, ye.person.widow),
    student: check('ye-student', ye.person.student),
    otherIncome: amountInput('ye-other-income', ye.person.otherIncome),
    hasSpouse: check('ye-has-spouse', !!ye.spouse),
    housing: amountInput('ye-housing', ye.housingLoan),
    note: h('textarea', { id: 'ye-note', rows: 2, maxlength: MAX_NOTE, value: ye.note || '' }),
  };
  const insKeys = [
    ['lifeNew', '一般の生命保険料（新契約）', '平成24年1月1日以後に契約した生命保険'],
    ['lifeOld', '一般の生命保険料（旧契約）', '平成23年12月31日以前に契約した生命保険'],
    ['care', '介護医療保険料', ''],
    ['pensionNew', '個人年金保険料（新契約）', ''],
    ['pensionOld', '個人年金保険料（旧契約）', ''],
    ['earthquake', '地震保険料', ''],
    ['oldLongTerm', '旧長期損害保険料', '平成18年12月31日以前に契約した長期の損害保険'],
    ['socialDeclared', '社会保険料（申告分）', '本人が直接払った国民年金・国民健康保険など（給与から引いた分は自動で入ります）'],
    ['smallBusiness', '小規模企業共済等掛金', 'iDeCo（個人型確定拠出年金）・小規模企業共済など'],
  ];
  const ins = Object.fromEntries(insKeys.map(([k]) => [k, amountInput(`ye-ins-${k}`, ye.insurance[k])]));

  /** 配偶者・扶養親族の入力欄 */
  function familyCard(x, { spouse = false, index = 0, onRemove = null } = {}) {
    const id = spouse ? 'ye-sp' : `ye-dep${index}`;
    const name = text(`${id}-name`, x.name, MAX_NAME, { 'aria-label': '氏名' });
    const relation = spouse ? null : text(`${id}-rel`, x.relation, MAX_RELATION, { placeholder: '例：子', 'aria-label': '続柄' });
    const birth = h('input', { id: `${id}-birth`, type: 'date', value: x.birthDate || '' });
    const income = amountInput(`${id}-income`, x.income);
    const disability = select(`${id}-dis`, DISABILITIES, x.disability);
    const parent = spouse ? null : check(`${id}-parent`, x.parentCohabiting);
    const nonResident = check(`${id}-nr`, x.nonResident);
    const other = spouse ? null : check(`${id}-other`, x.claimedByOther);
    const info = h('p', { class: 'ye-class small', 'aria-live': 'polite' });
    const sync = () => {
      x.name = name.value;
      if (relation) x.relation = relation.value;
      x.birthDate = birth.value;
      x.incomeText = income.value;
      x.disability = disability.value;
      if (parent) x.parentCohabiting = parent.checked;
      x.nonResident = nonResident.checked;
      if (other) x.claimedByOther = other.checked;
    };
    const paintInfo = () => {
      const age = ageAtYearEnd(x.birthDate, year);
      if (age == null) return void (info.textContent = '生年月日を入れると区分を判定します');
      const errs = [];
      const inc = readAmount(income, '所得', errs);
      if (spouse) info.textContent = `12月31日現在 ${age}歳${age >= 70 ? '（老人控除対象配偶者の年齢）' : ''}`;
      else info.textContent = `12月31日現在 ${age}歳・${supported ? DEPENDENT_CLASS_LABEL[dependentClass({ ...x, income: inc }, year)] : ''}`;
    };
    for (const el of [name, relation, birth, income, disability, parent, nonResident, other].filter(Boolean)) {
      el.addEventListener(el.type === 'checkbox' || el.tagName === 'SELECT' || el.type === 'date' ? 'change' : 'input', () => {
        sync();
        paintInfo();
        recalc();
      });
    }
    sync();
    paintInfo();
    return h(
      'div',
      { class: 'ye-family' },
      h('div', { class: 'ye-family-head' }, h('strong', { text: spouse ? '配偶者' : `親族${index + 1}` }), onRemove ? h('button', { type: 'button', class: 'btn btn-small btn-danger-text', text: '削除', 'aria-label': `親族${index + 1}を削除`, onclick: onRemove }) : null),
      h('div', { class: 'field-row' }, field('氏名', name), relation ? field('続柄', relation) : field('生年月日', birth)),
      relation ? field('生年月日', birth) : null,
      field('合計所得金額の見積額', income, { hint: '給与だけなら、給与の収入金額136万円以下が所得62万円以下です（令和8年分）' }),
      field('障害者', disability),
      parent ? h('label', { class: 'check small' }, parent, h('span', { text: '同居老親等（70歳以上の本人・配偶者の父母などで同居）' })) : null,
      h('label', { class: 'check small' }, nonResident, h('span', { text: '国外に住んでいる（非居住者）' })),
      other ? h('label', { class: 'check small' }, other, h('span', { text: '配偶者など、ほかの人の扶養控除の対象にしている（生命保険料控除・所得金額調整控除の判定だけに使う）' })) : null,
      info,
    );
  }

  const spouseObj = ye.spouse ? ye.spouse : familyDraft();
  const spouseWrap = h('div');
  const paintSpouse = () => put(spouseWrap, f.hasSpouse.checked ? familyCard(spouseObj, { spouse: true }) : null);
  f.hasSpouse.addEventListener('change', () => (paintSpouse(), recalc()));
  const deps = ye.dependents.map((d) => ({ ...d }));
  const depsWrap = h('div', { class: 'ye-families' });
  const addDep = h('button', {
    type: 'button',
    class: 'btn btn-small',
    text: '＋ 扶養親族などを足す',
    onclick: () => {
      deps.push(familyDraft());
      paintDeps();
      depsWrap.querySelector('.ye-family:last-child input')?.focus();
      recalc();
    },
  });
  function paintDeps() {
    put(depsWrap, ...deps.map((d, i) => familyCard(d, { index: i, onRemove: () => (deps.splice(i, 1), paintDeps(), recalc()) })));
    addDep.disabled = deps.length >= MAX_FAMILY;
  }

  /** 画面の値で入力を作る（読めない金額は errors に入れる） */
  function read(errors = []) {
    const fam = (x, who) => ({ ...x, income: readAmount({ value: x.incomeText ?? String(x.income || '') }, `${who}の合計所得金額の見積額`, errors) });
    const out = {
      ...ye,
      previous: { name: f.prevName.value, pay: readAmount(f.prevPay, '前職の支払金額', errors), social: readAmount(f.prevSocial, '前職の社会保険料', errors), tax: readAmount(f.prevTax, '前職の源泉徴収税額', errors), retiredOn: f.prevRetired.value },
      person: { disability: f.disability.value, widow: f.widow.value, student: f.student.checked, otherIncome: readAmount(f.otherIncome, '給与以外の所得の見積額', errors) },
      spouse: f.hasSpouse.checked ? fam(spouseObj, '配偶者') : null,
      dependents: deps.map((d, i) => fam(d, d.name || `親族${i + 1}`)),
      insurance: Object.fromEntries(insKeys.map(([k, label]) => [k, readAmount(ins[k], label, errors)])),
      housingLoan: readAmount(f.housing, '住宅借入金等特別控除の額', errors),
      note: f.note.value,
    };
    for (const x of [out.spouse, ...out.dependents].filter(Boolean)) delete x.incomeText;
    return out;
  }

  function payrollSummary(r) {
    const s = r.sum;
    return h(
      'div',
      { class: 'panel small' },
      h('p', { text: `${year}年に支給した給与 ${s.salaryCount}回・賞与 ${s.bonusCount}回：支払額 ${yen(s.pay)}、社会保険料等 ${yen(s.social)}、源泉所得税 ${yen(s.tax)}` }),
      s.count ? null : h('p', { text: 'このアプリに給与の記録がありません。' }),
    );
  }

  function recalc() {
    if (locked) return;
    dirty = true;
    if (!supported) return put(resultEl, h('p', { class: 'notice small', text: `${year}年分の年末調整の計算には対応していません。` }));
    const r = yearEndCalc(read([]), { payrolls, employee });
    put(
      resultEl,
      payrollSummary(r),
      r.reasons.length ? h('div', { class: 'notice small' }, ...r.reasons.map((m) => h('p', { text: m }))) : null,
      r.warnings.length ? h('ul', { class: 'ye-warnings small' }, ...r.warnings.map((m) => h('li', { text: m }))) : null,
      r.eligible ? resultTable(r) : null,
      r.eligible ? h('p', { class: 'ye-diff-line', text: diffLabel(r.diff) }) : null,
    );
  }

  // ---- 保存・確定・精算 ----
  async function save({ fix = false } = {}) {
    const errors = [];
    const record = read(errors);
    if (!errors.length) errors.push(...validateYearEnd(record));
    if (errors.length) return fail(new ValidationError(errors));
    try {
      const saved = await app.db.saveYearEnd(record);
      app.leaveGuard = null;
      dirty = false;
      if (fix) {
        try {
          await app.db.fixYearEnd(saved.id);
          showToast('年末調整を確定しました');
        } catch (e) {
          showToast('保存しました（確定はできませんでした）');
          app.navigate(`#/payroll/year-end/${saved.id}`, { replace: true });
          return;
        }
      } else showToast('保存しました');
      if (editing) app.refresh();
      else app.navigate(`#/payroll/year-end/${saved.id}`, { replace: true });
    } catch (e) {
      fail(e, '保存');
    }
  }

  async function act(fn, done, what) {
    try {
      await fn();
      showToast(done);
      app.refresh();
    } catch (e) {
      fail(e, what);
    }
  }

  async function remove() {
    const ok = await confirmDialog({
      title: `${employee.name}さんの${year}年分の年末調整を削除しますか？`,
      message: '入力した申告書の内容も消えます。元に戻せません。',
      buttons: [
        { label: 'キャンセル', value: false },
        { label: '削除する', value: true, variant: 'danger' },
      ],
    });
    if (ok !== true) return;
    try {
      await app.db.deleteYearEnd(ye.id);
      app.leaveGuard = null;
      showToast('削除しました');
      app.navigate(back, { replace: true });
    } catch (e) {
      fail(e, '削除');
    }
  }

  /** 確定・精算の状態と操作 */
  function statusPanel() {
    if (!locked) return null;
    const r = ye.result;
    const live = supported ? yearEndCalc(ye, { payrolls, employee }) : null;
    const changes = live ? snapshotChanges(r, live) : [];
    const settledPay = ye.settledPayrollId ? payrolls.find((p) => p.id === ye.settledPayrollId) : null;
    const items = [];
    items.push(h('p', {}, h('span', { class: 'badge badge-ok', text: YEAR_END_STATUS[ye.status] }), ` ${ye.fixedAt ? `${slash(ye.fixedAt.slice(0, 10))}に確定` : ''}`));
    if (changes.length) items.push(h('div', { class: 'notice small' }, h('p', { text: '確定した後に給与が変わっています。' }), ...changes.map((c) => h('p', { text: `${c.label}：${yen(c.before)} → ${yen(c.after)}` })), h('p', { text: ye.status === 'settled' ? '精算を外し、確定を取り消して計算し直してください。' : '確定を取り消して計算し直してください。' })));
    if (ye.status === 'settled') {
      items.push(settledPay ? h('p', { class: 'small' }, `${diffLabel(r.diff)}を `, h('a', { href: `#/payroll/${settledPay.id}`, text: `${slash(settledPay.payDate)} 支給の${payrollTitle(settledPay)}` }), ` で精算しています${settledPay.journalId ? '（仕訳済み）' : '。その給与の仕訳を登録してください'}`) : h('p', { class: 'small notice', text: '精算した給与が見つかりません。' }));
      items.push(
        h('button', {
          type: 'button',
          class: 'btn btn-block',
          text: '精算を外す',
          onclick: () => act(() => app.db.unsettleYearEnd(ye.id), '精算を外しました', '取消'),
        }),
      );
    } else {
      if (r.diff) {
        const candidates = mine.filter((p) => !p.journalId && !p.yearEndId && p.payDate >= `${year}-01-01` && p.payDate <= `${year + 1}-01-31`).sort((a, b) => (a.payDate < b.payDate ? 1 : -1));
        if (candidates.length) {
          const sel = h('select', { id: 'ye-settle' }, candidates.map((p) => h('option', { value: p.id, text: `${slash(p.payDate)} ${PAY_KINDS[p.kind]}・${payrollTitle(p)}` })));
          items.push(field('精算する給与', sel, { hint: `${diffLabel(r.diff)}を、選んだ給与の控除に入れます（不足額は控除を増やし、超過額は差引支給額に足します）` }));
          items.push(h('button', { type: 'button', class: 'btn btn-primary btn-block', text: 'この給与で精算する', onclick: () => act(() => app.db.settleYearEnd(ye.id, sel.value), '精算しました', '精算') }));
        } else {
          items.push(h('p', { class: 'small notice', text: `精算に使える給与がありません。${year}年12月の給与（仕訳を登録する前）か、${year + 1}年1月の給与を作ってから精算してください。` }));
        }
      } else items.push(h('p', { class: 'small', text: '過不足額が0円のため、精算はいりません。' }));
      items.push(h('button', { type: 'button', class: 'btn btn-block', text: '確定を取り消す', onclick: () => act(() => app.db.unfixYearEnd(ye.id), '確定を取り消しました', '取消') }));
    }
    return h('div', { class: 'ye-status' }, ...items, resultTable(r));
  }

  const form = h(
    'form',
    { class: 'pay-form', novalidate: true, onsubmit: (e) => (e.preventDefault(), save()) },
    errorsEl,
    statusPanel(),
    h(
      'fieldset',
      { class: 'ye-fieldset', disabled: locked },
      h('h2', { class: 'section-title', text: '本人' }),
      h('div', { class: 'field-row' }, field('障害者', f.disability), field('寡婦・ひとり親', f.widow)),
      h('label', { class: 'check' }, f.student, h('span', { text: '勤労学生' })),
      field('給与以外の所得の見積額', f.otherIncome, { hint: '事業所得・不動産所得などの合計（所得の金額）。基礎控除・配偶者控除などの判定に使います' }),
      h('h2', { class: 'section-title', text: '配偶者' }),
      h('label', { class: 'check' }, f.hasSpouse, h('span', { text: '生計を一にする配偶者がいる（控除の対象になるかは所得で判定します）' })),
      spouseWrap,
      h('h2', { class: 'section-title', text: '扶養親族・特定親族' }),
      h('p', { class: 'field-hint', text: '16歳未満の子も入れてください（障害者控除・生命保険料控除・源泉徴収票に使います）。19歳以上23歳未満で所得が62万円を超え123万円以下の親族は、特定親族特別控除になります。' }),
      depsWrap,
      addDep,
      h('h2', { class: 'section-title', text: '保険料・掛金（年間の支払額）' }),
      ...insKeys.map(([k, label, hint]) => field(label, ins[k], { hint })),
      h('h2', { class: 'section-title', text: '住宅借入金等特別控除' }),
      field('控除額（住宅借入金等特別控除申告書の金額）', f.housing, { hint: '年調所得税額から引ききれない額は切り捨てます' }),
      h(
        'details',
        { class: 'ye-prev', open: Boolean(prev.pay || prev.tax) },
        h('summary', { text: '前職分（年の途中で入社した人）' }),
        field('前職の支払者', f.prevName),
        field('支払金額', f.prevPay),
        field('社会保険料等の金額', f.prevSocial),
        field('源泉徴収税額', f.prevTax),
        field('退職した日', f.prevRetired),
        h('p', { class: 'field-hint', text: '前職の「給与所得の源泉徴収票」の金額を入れます' }),
      ),
      field('メモ', f.note),
    ),
    locked ? null : h('h2', { class: 'section-title', text: '計算の結果' }),
    locked ? null : resultEl,
    locked
      ? null
      : h(
          'div',
          { class: 'actions pay-actions' },
          h('button', { type: 'submit', class: 'btn btn-primary btn-block', text: '保存する' }),
          h('button', { type: 'button', class: 'btn btn-block', text: '保存して確定する', disabled: !supported, onclick: () => save({ fix: true }) }),
          editing ? h('button', { type: 'button', class: 'btn btn-danger-text', text: '削除', onclick: remove }) : null,
        ),
    locked && ye.status === 'fixed' ? h('button', { type: 'button', class: 'btn btn-danger-text', text: '削除', onclick: remove }) : null,
  );
  for (const el of [f.prevPay, f.prevSocial, f.prevTax, f.otherIncome, f.housing, ...Object.values(ins)]) el.addEventListener('input', recalc);
  for (const el of [f.disability, f.widow, f.student]) el.addEventListener('change', recalc);
  paintSpouse();
  paintDeps();
  put(
    outlet,
    h('div', { class: 'ye-head' }, h('p', {}, h('strong', { text: employee.name }), ` ${year}年分（${employee.taxColumn === 'kou' ? '甲欄' : '乙欄'}）`), !editing && prevYear ? h('p', { class: 'small notice', text: `${year - 1}年分の本人・配偶者・扶養親族の内容を引き継ぎました。所得の見積額などを今年の申告書で確かめてください。` }) : null),
    form,
  );
  recalc();
  dirty = !editing && Boolean(prevYear);
}
