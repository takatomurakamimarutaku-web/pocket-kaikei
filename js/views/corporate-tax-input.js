// 法人税の計算の条件：中小法人の区分・配当・交際費・別表四の加算減算・税額控除・繰越欠損金・前期分と中間納付の税額・住民税・別表五(一)の期首
import { h, put, field, showToast, confirmDialog, errorBox } from '../ui.js';
import { ValidationError } from '../db.js';
import { errorText } from '../errors.js';
import { parseYen, formatYen } from '../money.js';
import { formatPeriod, periodMonths } from '../period.js';
import { previousPeriod } from '../closing.js';
import { formatPercent, parsePercent } from '../enterprise-tax.js';
import { emptyShareholder, MAX_SHAREHOLDERS } from '../family-company.js';
import { emptyWithholdingRow, MAX_WITHHOLDING_ROWS, WITHHOLDING_KINDS } from '../withholding-credit.js';
import { emptyApplicationRow, MAX_APPLICATION_ROWS } from '../application-statement.js';
import { corporateTaxReturn, carryOverInput, cleanCorporateTax, validateCorporateTax, TAX_KINDS, ADJUSTMENT_PRESETS, RESIDENT_DEFAULTS, TOKYO_DEFAULTS, standardPerCapita, MAX_ROWS, MAX_LOSS_ROWS, MAX_LABEL, DEFENSE_FROM } from '../corporate-tax.js';

/** 金額の欄 */
const yenBox = (id, value, { placeholder = '0', label } = {}) => h('input', { id, type: 'text', inputmode: 'numeric', autocomplete: 'off', class: 'num', value: value ? String(value) : '', placeholder, 'aria-label': label });

/** 金額の欄を読む（空欄は empty の値） */
function readYen(input, label, errors, { allowNegative = false, empty = 0 } = {}) {
  const s = String(input.value).trim();
  if (!s) return empty;
  const r = parseYen(s, { allowNegative, allowZero: true });
  if (!r.ok) {
    errors.push(`${label}：${r.error}`);
    return 0;
  }
  return r.value;
}

export async function render({ app, outlet }) {
  const { settings, period, accounts, journals } = await app.load();
  if (settings.entityType !== 'corporation') return put(outlet, h('p', { class: 'notice', text: '法人税の申告は法人で使います' }));
  const v = cleanCorporateTax(period.corporateTax || {});
  const current = corporateTaxReturn({ accounts, period, journals, input: { ...v, entertainment: null }, enterpriseInput: period.enterpriseTax || {} });
  const defenseApplies = period.startDate >= DEFENSE_FROM;
  let dirty = false;
  const markDirty = () => (dirty = true);
  const errorsEl = h('div', { class: 'errors-wrap' });

  // 法人の区分
  const sme = h('input', { id: 'ct-sme', type: 'checkbox', checked: v.sme });
  const excluded = h('input', { id: 'ct-excluded', type: 'checkbox', checked: v.excluded });
  // 金額の欄
  const dividends = yenBox('ct-dividends', v.dividends);
  const withholding = yenBox('ct-withholding', v.withholding);
  const entertainment = yenBox('ct-entertainment', v.entertainment, { placeholder: `空欄なら ${formatYen(current.entertainment.amount)}` });
  const dining = yenBox('ct-dining', v.dining);
  const credits = yenBox('ct-credits', v.credits);
  const addBack = yenBox('ct-addback', v.residentAddBack);

  // 別表四の加算・減算の行
  const adjRows = v.adjustments.map((a) => ({ ...a, amount: String(a.amount || '') }));
  const adjList = h('div', { class: 'ct-rows' });
  const presets = h('datalist', { id: 'ct-presets' }, ADJUSTMENT_PRESETS.map((p) => h('option', { value: p.label })));
  function paintAdj() {
    put(
      adjList,
      adjRows.length ? null : h('p', { class: 'small muted', text: '役員給与の損金不算入額・減価償却の償却超過額・寄附金の損金不算入額など、決算書の利益と所得が違う項目を足します。' }),
      ...adjRows.map((a, i) => {
        const side = h('select', { 'aria-label': `加算・減算${i + 1}の区分`, onchange: (e) => ((a.side = e.target.value), markDirty()) }, h('option', { value: 'add', text: '加算', selected: a.side === 'add' }), h('option', { value: 'sub', text: '減算', selected: a.side === 'sub' }));
        const kind = h('select', { 'aria-label': `加算・減算${i + 1}の処分`, onchange: (e) => ((a.kind = e.target.value), markDirty()) }, h('option', { value: 'retained', text: '留保', selected: a.kind === 'retained' }), h('option', { value: 'outflow', text: '社外流出', selected: a.kind === 'outflow' }));
        return h(
          'div',
          { class: 'ct-row ct-adj' },
          h('input', {
            type: 'text',
            list: 'ct-presets',
            value: a.label,
            maxlength: MAX_LABEL,
            placeholder: '項目（候補から選べます）',
            'aria-label': `加算・減算${i + 1}の項目`,
            oninput: (e) => {
              a.label = e.target.value;
              const p = ADJUSTMENT_PRESETS.find((x) => x.label === a.label);
              if (p) ((a.side = p.side), (a.kind = p.kind), (side.value = p.side), (kind.value = p.kind));
              markDirty();
            },
          }),
          side,
          kind,
          h('input', { type: 'text', inputmode: 'numeric', class: 'num', value: a.amount, placeholder: '0', 'aria-label': `加算・減算${i + 1}の金額`, oninput: (e) => ((a.amount = e.target.value), markDirty()) }),
          h('button', { type: 'button', class: 'btn btn-small btn-danger-text', 'aria-label': `加算・減算${i + 1}を削除`, text: '×', onclick: () => (adjRows.splice(i, 1), paintAdj(), markDirty()) }),
        );
      }),
      adjRows.length < MAX_ROWS ? h('button', { type: 'button', class: 'btn btn-small', text: '＋ 加算・減算の行を足す', onclick: () => (adjRows.push({ label: '', side: 'add', kind: 'outflow', amount: '' }), paintAdj(), adjList.querySelector('.ct-row:last-of-type input')?.focus()) }) : null,
    );
  }

  // 繰越欠損金の行
  let lossRows = v.losses.map((l) => ({ endDate: l.endDate, amount: String(l.amount) }));
  const lossList = h('div', { class: 'ct-rows' });
  function paintLoss() {
    put(
      lossList,
      ...lossRows.map((l, i) =>
        h(
          'div',
          { class: 'ct-row ct-loss' },
          h('input', { type: 'date', value: l.endDate, 'aria-label': `欠損金${i + 1}の事業年度の終了日`, oninput: (e) => ((l.endDate = e.target.value), markDirty()) }),
          h('input', { type: 'text', inputmode: 'numeric', class: 'num', value: l.amount, placeholder: '0', 'aria-label': `欠損金${i + 1}の控除未済欠損金額`, oninput: (e) => ((l.amount = e.target.value), markDirty()) }),
          h('button', { type: 'button', class: 'btn btn-small btn-danger-text', 'aria-label': `欠損金${i + 1}を削除`, text: '×', onclick: () => (lossRows.splice(i, 1), paintLoss(), markDirty()) }),
        ),
      ),
      lossRows.length < MAX_LOSS_ROWS ? h('button', { type: 'button', class: 'btn btn-small', text: '＋ 欠損金の行を足す', onclick: () => (lossRows.push({ endDate: '', amount: '' }), paintLoss()) }) : null,
    );
  }

  // 別表五(一)の期首の調整項目
  let openRows = v.openingAdjustments.map((a) => ({ label: a.label, amount: String(a.amount) }));
  const openList = h('div', { class: 'ct-rows' });
  function paintOpen() {
    put(
      openList,
      ...openRows.map((a, i) =>
        h(
          'div',
          { class: 'ct-row ct-open' },
          h('input', { type: 'text', list: 'ct-presets', value: a.label, maxlength: MAX_LABEL, placeholder: '項目（例：減価償却の償却超過額）', 'aria-label': `期首の調整項目${i + 1}の名前`, oninput: (e) => ((a.label = e.target.value), markDirty()) }),
          h('input', { type: 'text', inputmode: 'numeric', class: 'num', value: a.amount, placeholder: '0', 'aria-label': `期首の調整項目${i + 1}の金額`, oninput: (e) => ((a.amount = e.target.value), markDirty()) }),
          h('button', { type: 'button', class: 'btn btn-small btn-danger-text', 'aria-label': `期首の調整項目${i + 1}を削除`, text: '×', onclick: () => (openRows.splice(i, 1), paintOpen(), markDirty()) }),
        ),
      ),
      openRows.length < MAX_ROWS ? h('button', { type: 'button', class: 'btn btn-small', text: '＋ 期首の調整項目を足す', onclick: () => (openRows.push({ label: '', amount: '' }), paintOpen()) }) : null,
    );
  }

  // 前期分の確定税額と当期の中間納付額
  const kinds = TAX_KINDS.filter((k) => k.key !== 'defense' || defenseApplies || v.prior.defense || v.interim.defense);
  const taxInputs = Object.fromEntries(
    kinds.map((k) => [
      k.key,
      {
        prior: yenBox(`ct-prior-${k.key}`, v.prior[k.key], { label: `前期分の${k.label}` }),
        interim: k.key === 'enterprise' ? null : yenBox(`ct-interim-${k.key}`, v.interim[k.key], { label: `中間納付した${k.label}` }),
      },
    ]),
  );
  const ent = period.enterpriseTax || {};
  const taxGrid = h(
    'div',
    { class: 'ct-taxes' },
    h('span', { class: 'ct-taxes-head', text: '' }),
    h('span', { class: 'ct-taxes-head', text: '前期分の確定額' }),
    h('span', { class: 'ct-taxes-head', text: '当期の中間納付額' }),
    ...kinds.flatMap((k) => [
      h('span', { class: 'ct-taxes-label', text: k.label }),
      taxInputs[k.key].prior,
      taxInputs[k.key].interim ?? h('a', { class: 'small ct-taxes-link', href: '#/reports/enterprise-tax', text: `${formatYen((ent.interimTax || 0) + (ent.interimSpecial || 0))}円（事業税の画面）` }),
    ]),
  );

  // 別表二の株主（株主グループ＝判定基準となる株主と同族関係者。グループの欄が空なら本人だけのグループ）
  const countText = (n) => (n === null || n === undefined ? '' : String(n));
  let holderRows = v.shareholders.map((x) => ({ ...x, shares: countText(x.shares), votes: countText(x.votes) }));
  const sharesTotal = h('input', { id: 'ct-shares-total', type: 'text', inputmode: 'numeric', autocomplete: 'off', class: 'num', value: countText(v.sharesTotal), placeholder: '空欄なら株主の合計' });
  const votesTotal = h('input', { id: 'ct-votes-total', type: 'text', inputmode: 'numeric', autocomplete: 'off', class: 'num', value: countText(v.votesTotal), placeholder: '空欄なら発行済株式の総数' });
  const holderList = h('div', { class: 'ct-holders' });
  function paintHolders() {
    const box = (x, key, label, attrs = {}) => h('input', { type: 'text', value: x[key] ?? '', 'aria-label': label, placeholder: label, oninput: (e) => ((x[key] = e.target.value), markDirty()), ...attrs });
    put(
      holderList,
      holderRows.length ? null : h('p', { class: 'small muted', text: '期末の株主（社員）と持っている株式数（出資の金額）を入れます。親族など同族関係者は「グループ」に判定基準となる株主の名前を入れると、まとめて判定します。' }),
      ...holderRows.map((x, i) =>
        h(
          'div',
          { class: 'ct-holder' },
          h('div', { class: 'ct-holder-row' }, box(x, 'name', `株主${i + 1}の氏名又は法人名`, { maxlength: 60 }), box(x, 'relation', '続柄（本人・妻など）', { maxlength: 20 })),
          h('div', { class: 'ct-holder-row' }, box(x, 'group', 'グループ（判定基準となる株主の名前）', { maxlength: 60 }), box(x, 'address', '住所又は所在地', { maxlength: 60 })),
          h(
            'div',
            { class: 'ct-holder-row' },
            box(x, 'shares', '株式数（出資の金額）', { inputmode: 'numeric', class: 'num' }),
            box(x, 'votes', '議決権の数（空欄なら株式数）', { inputmode: 'numeric', class: 'num' }),
          ),
          h(
            'div',
            { class: 'ct-holder-row' },
            h('label', { class: 'check small' }, h('input', { type: 'checkbox', checked: x.corporate, onchange: (e) => ((x.corporate = e.target.checked), markDirty()) }), h('span', { text: '被支配会社でない法人株主' })),
            h('button', { type: 'button', class: 'btn btn-small btn-danger-text', 'aria-label': `株主${i + 1}を削除`, text: '× 削除', onclick: () => (holderRows.splice(i, 1), paintHolders(), markDirty()) }),
          ),
        ),
      ),
      holderRows.length < MAX_SHAREHOLDERS ? h('button', { type: 'button', class: 'btn btn-small', text: '＋ 株主を足す', onclick: () => (holderRows.push({ ...emptyShareholder(), shares: '', votes: '' }), paintHolders()) }) : null,
    );
  }
  paintHolders();

  // 別表六(一)の明細（預金の利子・配当などの源泉徴収税額）。明細があれば控除を受ける所得税額はその計になる
  const textOf = (n) => (n === null || n === undefined ? '' : String(n));
  let whRows = v.withholdingRows.map((x) => ({ ...x, income: textOf(x.income), tax: textOf(x.tax), periodMonths: textOf(x.periodMonths), heldMonths: textOf(x.heldMonths) }));
  const whList = h('div', { class: 'ct-holders' });
  function paintWithholding() {
    withholding.disabled = whRows.length > 0;
    const box = (x, key, label, attrs = {}) => h('input', { type: 'text', value: x[key] ?? '', 'aria-label': label, placeholder: label, oninput: (e) => ((x[key] = e.target.value), markDirty()), ...attrs });
    put(
      whList,
      whRows.length ? null : h('p', { class: 'small muted', text: '明細を入れると、区分ごとに集計して「法人税額から控除される所得税額」に入ります（別表六(一)）。入れなければ上の欄の金額を使います。' }),
      ...whRows.map((x, i) => {
        const kind = WITHHOLDING_KINDS.find((k) => k.no === Number(x.kind));
        return h(
          'div',
          { class: 'ct-holder' },
          h(
            'div',
            { class: 'ct-holder-row' },
            h('select', { 'aria-label': `明細${i + 1}の区分`, onchange: (e) => ((x.kind = Number(e.target.value)), markDirty(), paintWithholding()) }, ...WITHHOLDING_KINDS.map((k) => h('option', { value: String(k.no), text: `${k.no} ${k.short}`, selected: k.no === Number(x.kind) }))),
            box(x, 'payer', `明細${i + 1}の支払者（銘柄）`, { maxlength: 60 }),
          ),
          h('div', { class: 'ct-holder-row' }, box(x, 'income', '収入金額（税引前）', { inputmode: 'numeric', class: 'num' }), box(x, 'tax', '源泉徴収された所得税額', { inputmode: 'numeric', class: 'num' })),
          kind?.prorate
            ? h('div', { class: 'ct-holder-row' }, box(x, 'periodMonths', '配当の計算期間（月）', { inputmode: 'numeric', class: 'num' }), box(x, 'heldMonths', 'うち元本の所有期間（月）', { inputmode: 'numeric', class: 'num' }))
            : null,
          x.kind === 5 || Number(x.kind) === 5 ? h('div', { class: 'ct-holder-row' }, box(x, 'address', '支払者の住所', { maxlength: 60 }), h('input', { type: 'date', value: x.date || '', 'aria-label': '支払を受けた年月日', oninput: (e) => ((x.date = e.target.value), markDirty()) })) : null,
          h('div', { class: 'ct-holder-row' }, h('span', { class: 'small muted', text: kind?.prorate ? '期間を空欄にすると全額を控除します' : '' }), h('button', { type: 'button', class: 'btn btn-small btn-danger-text', 'aria-label': `明細${i + 1}を削除`, text: '× 削除', onclick: () => (whRows.splice(i, 1), paintWithholding(), markDirty()) })),
        );
      }),
      whRows.length < MAX_WITHHOLDING_ROWS ? h('button', { type: 'button', class: 'btn btn-small', text: '＋ 明細を足す', onclick: () => (whRows.push({ ...emptyWithholdingRow(), income: '', tax: '', periodMonths: '', heldMonths: '' }), paintWithholding()) }) : null,
    );
  }
  paintWithholding();

  // 適用額明細書に足す措置（法人税率の特例・少額減価償却資産の特例は帳簿から自動で書く）
  let appRows = v.applicationRows.map((x) => ({ ...x, amount: textOf(x.amount) }));
  const appList = h('div', { class: 'ct-holders' });
  function paintApplication() {
    const box = (x, key, label, attrs = {}) => h('input', { type: 'text', value: x[key] ?? '', 'aria-label': label, placeholder: label, oninput: (e) => ((x[key] = e.target.value), markDirty()), ...attrs });
    put(
      appList,
      ...appRows.map((x, i) =>
        h(
          'div',
          { class: 'ct-holder' },
          box(x, 'article', `措置${i + 1}の租税特別措置法の条項（例：第42条の12の５第２項）`, { maxlength: 60 }),
          h('div', { class: 'ct-holder-row' }, box(x, 'code', '区分番号（5桁）', { inputmode: 'numeric', maxlength: 5 }), box(x, 'amount', '適用額', { inputmode: 'numeric', class: 'num' })),
          h('div', { class: 'ct-holder-row' }, h('span', {}), h('button', { type: 'button', class: 'btn btn-small btn-danger-text', 'aria-label': `措置${i + 1}を削除`, text: '× 削除', onclick: () => (appRows.splice(i, 1), paintApplication(), markDirty()) })),
        ),
      ),
      appRows.length < MAX_APPLICATION_ROWS ? h('button', { type: 'button', class: 'btn btn-small', text: '＋ 措置を足す', onclick: () => (appRows.push({ ...emptyApplicationRow(), amount: '' }), paintApplication()) }) : null,
    );
  }
  paintApplication();

  // 住民税
  const tokyo = h('input', { id: 'ct-tokyo', type: 'checkbox', checked: v.tokyo });
  const rateBox = (id, r) => h('input', { id, type: 'text', inputmode: 'decimal', autocomplete: 'off', class: 'num', value: formatPercent(r) });
  const prefRate = rateBox('ct-pref-rate', v.prefRate);
  const cityRate = rateBox('ct-city-rate', v.cityRate);
  const prefPerCapita = yenBox('ct-pref-pc', v.prefPerCapita);
  const cityPerCapita = yenBox('ct-city-pc', v.cityPerCapita);
  const months = h('input', { id: 'ct-months', type: 'text', inputmode: 'numeric', autocomplete: 'off', class: 'num', value: v.residentMonths === null ? '' : String(v.residentMonths), placeholder: `空欄なら ${Math.min(12, periodMonths(period))}` });
  const employees = h('input', { id: 'ct-employees', type: 'text', inputmode: 'numeric', autocomplete: 'off', class: 'num', value: v.employees === null ? '' : String(v.employees) });
  const prefInterimPC = yenBox('ct-pref-ipc', v.interimPerCapita.pref, { label: '道府県民税の中間納付額のうち均等割' });
  const cityInterimPC = yenBox('ct-city-ipc', v.interimPerCapita.city, { label: '市町村民税の中間納付額のうち均等割' });
  // 均等割の標準税率：資本金等の額（別表五(一)の資本金等の期末）と従業者数から（自治体の超過税率は入力で直す）
  const fillStandard = () => {
    const n = Number(String(employees.value).normalize('NFKC').trim() || 0);
    const d = standardPerCapita(current.capital.total, Number.isFinite(n) ? n : 0, tokyo.checked);
    prefPerCapita.value = d.pref ? String(d.pref) : '';
    cityPerCapita.value = d.city ? String(d.city) : '';
    markDirty();
    showToast(`資本金等の額 ${formatYen(current.capital.total)}円・従業者${Number.isFinite(n) ? n : 0}人の標準税率を入れました`);
  };
  tokyo.addEventListener('change', () => {
    const d = tokyo.checked ? TOKYO_DEFAULTS : RESIDENT_DEFAULTS;
    prefRate.value = formatPercent(d.prefRate);
    cityRate.value = formatPercent(d.cityRate);
    prefPerCapita.value = d.prefPerCapita ? String(d.prefPerCapita) : '';
    cityPerCapita.value = d.cityPerCapita ? String(d.cityPerCapita) : '';
  });

  function collect() {
    const errors = [];
    const rateOf = (input, label) => {
      const r = parsePercent(input.value);
      if (Number.isNaN(r)) errors.push(`${label}：税率は小数第3位までの数字で入力してください（例：1.0）`);
      return Number.isNaN(r) ? 0 : r;
    };
    const m = String(months.value).normalize('NFKC').trim();
    const e = String(employees.value).normalize('NFKC').trim();
    const countOf = (s, label, { empty = null } = {}) => {
      const t = String(s ?? '').normalize('NFKC').replace(/,/g, '').trim();
      if (!t) return empty;
      if (!/^\d+$/.test(t)) {
        errors.push(`${label}は0以上の整数で入力してください`);
        return 0;
      }
      return Number(t);
    };
    const record = {
      sme: sme.checked,
      excluded: excluded.checked,
      dividends: readYen(dividends, '配当', errors),
      withholding: readYen(withholding, '法人税額から控除される所得税額', errors),
      entertainment: readYen(entertainment, '支出交際費等の額', errors, { empty: null }),
      dining: readYen(dining, '接待飲食費の額', errors),
      credits: readYen(credits, '法人税額の特別控除額', errors),
      residentAddBack: readYen(addBack, '足し戻す控除額', errors),
      adjustments: adjRows.filter((a) => a.label.trim() || a.amount.trim()).map((a, i) => ({ label: a.label, side: a.side, kind: a.kind, amount: readYen({ value: a.amount }, `加算・減算${i + 1}`, errors) })),
      losses: lossRows.filter((l) => l.endDate || l.amount.trim()).map((l, i) => ({ endDate: l.endDate, amount: readYen({ value: l.amount }, `欠損金${i + 1}`, errors) })),
      openingAdjustments: openRows.filter((a) => a.label.trim() || a.amount.trim()).map((a, i) => ({ label: a.label, amount: readYen({ value: a.amount }, `期首の調整項目${i + 1}`, errors, { allowNegative: true }) })),
      prior: Object.fromEntries(TAX_KINDS.map((k) => [k.key, taxInputs[k.key] ? readYen(taxInputs[k.key].prior, `前期分の${k.label}`, errors) : 0])),
      interim: Object.fromEntries(TAX_KINDS.map((k) => [k.key, taxInputs[k.key]?.interim ? readYen(taxInputs[k.key].interim, `中間納付した${k.label}`, errors) : 0])),
      tokyo: tokyo.checked,
      prefRate: rateOf(prefRate, '道府県民税の法人税割'),
      cityRate: rateOf(cityRate, '市町村民税の法人税割'),
      prefPerCapita: readYen(prefPerCapita, '道府県民税の均等割', errors),
      cityPerCapita: readYen(cityPerCapita, '市町村民税の均等割', errors),
      residentMonths: m === '' ? null : /^\d+$/.test(m) ? Number(m) : NaN,
      applicationRows: appRows.map((x, i) => ({ article: x.article, code: x.code, amount: countOf(x.amount, `措置${i + 1}の適用額`, { empty: 0 }) })),
      withholdingRows: whRows.map((x, i) => ({ kind: Number(x.kind), payer: x.payer, address: x.address, date: x.date, income: countOf(x.income, `明細${i + 1}の収入金額`, { empty: 0 }), tax: countOf(x.tax, `明細${i + 1}の所得税額`, { empty: 0 }), periodMonths: countOf(x.periodMonths, `明細${i + 1}の計算期間`), heldMonths: countOf(x.heldMonths, `明細${i + 1}の所有期間`) })),
      shareholders: holderRows.filter((x) => x.name.trim() || String(x.shares).trim()).map((x, i) => ({ name: x.name, address: x.address, relation: x.relation, group: x.group, shares: countOf(x.shares, `株主${i + 1}の株式数`, { empty: 0 }), votes: countOf(x.votes, `株主${i + 1}の議決権の数`), corporate: Boolean(x.corporate) })),
      sharesTotal: countOf(sharesTotal.value, '発行済株式の総数'),
      votesTotal: countOf(votesTotal.value, '議決権の総数'),
      employees: e === '' ? null : /^\d+$/.test(e) ? Number(e) : NaN,
      interimPerCapita: { pref: readYen(prefInterimPC, '道府県民税の中間納付額のうち均等割', errors), city: readYen(cityInterimPC, '市町村民税の中間納付額のうち均等割', errors) },
    };
    return { record, errors: [...errors, ...validateCorporateTax(cleanCorporateTax(record))] };
  }

  async function save() {
    const { record, errors } = collect();
    if (errors.length) {
      put(errorsEl, errorBox([...new Set(errors)]));
      errorsEl.scrollIntoView({ behavior: 'smooth', block: 'center' });
      return;
    }
    try {
      await app.db.saveCorporateTax(period.id, record);
      app.leaveGuard = null;
      showToast('法人税の計算の条件を保存しました');
      app.goBack('#/reports/corporate-tax');
    } catch (e) {
      put(errorsEl, errorBox(e instanceof ValidationError ? [].concat(Array.isArray(e.errors) ? e.errors : Object.values(e.errors)) : [errorText(e, '保存')]));
      errorsEl.scrollIntoView({ behavior: 'smooth', block: 'center' });
    }
  }

  // 前期の計算から引き継ぐ
  const prev = previousPeriod(await app.db.listPeriods(), period);
  async function carryOver() {
    const prevJournals = await app.db.listJournals(prev.id);
    const pr = corporateTaxReturn({ accounts, period: prev, journals: prevJournals, input: prev.corporateTax || {}, enterpriseInput: prev.enterpriseTax || {} });
    const next = carryOverInput(pr);
    const ok = await confirmDialog({
      title: '前期の計算から引き継ぎますか？',
      message: `前期（${formatPeriod(prev)}）の別表から、繰越欠損金${next.losses.length}件・期首の調整項目${next.openingAdjustments.length}件・前期分の確定税額を入れ直します。いま入っている繰越欠損金・期首の調整項目・前期分の税額は置き換わります。`,
      buttons: [
        { label: 'キャンセル', value: false },
        { label: '引き継ぐ', value: true },
      ],
    });
    if (ok !== true) return;
    lossRows = next.losses.map((l) => ({ endDate: l.endDate, amount: String(l.amount) }));
    if (next.shareholders?.length && !holderRows.length) {
      holderRows = next.shareholders.map((x) => ({ ...x, shares: countText(x.shares), votes: countText(x.votes) }));
      sharesTotal.value = countText(next.sharesTotal);
      votesTotal.value = countText(next.votesTotal);
      paintHolders();
    }
    openRows = next.openingAdjustments.map((a) => ({ label: a.label, amount: String(a.amount) }));
    for (const k of kinds) taxInputs[k.key].prior.value = next.prior[k.key] ? String(next.prior[k.key]) : '';
    paintLoss();
    paintOpen();
    markDirty();
    showToast('前期の計算から引き継ぎました（保存すると反映されます）');
  }

  app.leaveGuard = async () =>
    !dirty ||
    (await confirmDialog({
      title: '入力中の内容を破棄しますか？',
      buttons: [
        { label: '入力を続ける', value: false },
        { label: '破棄する', value: true, variant: 'danger' },
      ],
    }));

  paintAdj();
  paintLoss();
  paintOpen();
  put(
    outlet,
    h(
      'form',
      { class: 'pay-form ct-form', novalidate: true, oninput: markDirty, onchange: markDirty, onsubmit: (e) => (e.preventDefault(), save()) },
      presets,
      errorsEl,
      h('p', { class: 'muted small', text: `${formatPeriod(period)}（${periodMonths(period)}か月）` }),
      prev ? h('button', { type: 'button', class: 'btn btn-block', text: '前期の計算から引き継ぐ', onclick: carryOver }) : null,
      h('h2', { class: 'section-title', text: '法人の区分' }),
      h('label', { class: 'check' }, sme, h('span', { text: '中小法人（期末の資本金が1億円以下で、資本金5億円以上の法人の100%子会社などではない）' })),
      h('label', { class: 'check' }, excluded, h('span', { text: '適用除外事業者（前3事業年度の所得の平均が年15億円を超える）' })),
      h('p', { class: 'field-hint', text: '中小法人は、年800万円以下の所得の税率が15%、交際費の定額控除（年800万円）、欠損金の100%控除の対象です。' }),
      h('h2', { class: 'section-title', text: '利益の処分と所得税' }),
      field('当期に支払った剰余金の配当', dividends, { hint: '別表四の社外流出「配当」。株主総会で決めて当期に支払った配当の額' }),
      field('法人税額から控除される所得税額', withholding, { hint: '預金の利子・配当から源泉徴収された所得税と復興特別所得税。下の明細を入れると、その計（別表六(一)の6の③）になります' }),
      h('h3', { class: 'tf-title', text: '所得税額の控除（別表六(一)）の明細' }),
      whList,
      h('h2', { class: 'section-title', text: '交際費（別表十五）' }),
      field('支出交際費等の額', entertainment, { hint: '空欄なら「接待交際費」の科目の当期の額。会議費など他の科目に交際費等があれば合計を入れます' }),
      field('うち接待飲食費の額', dining, { hint: '得意先などとの飲食の費用（社内の人だけの飲食を除く）。中小法人は50%か定額控除の多いほうで計算します' }),
      h('h2', { class: 'section-title', text: '別表四のその他の加算・減算' }),
      adjList,
      h('p', { class: 'field-hint', text: '留保：翌期以降に解消する差（別表五(一)に載る）。社外流出：解消しない差（役員給与・寄附金・罰金など）。' }),
      h('h2', { class: 'section-title', text: '税額控除' }),
      field('法人税額の特別控除額', credits, { hint: '賃上げ促進税制・中小企業投資促進税制などで法人税額から引く額の合計（別表六の各明細書）' }),
      field('住民税の法人税割で足し戻す控除額', addBack, { hint: '中小企業者等の賃上げ促進税制・試験研究費の税額控除などは、法人税割の課税標準からは引きません' }),
      h('h3', { class: 'tf-title', text: '適用額明細書に足す措置' }),
      h('p', { class: 'field-hint', text: '中小企業者等の法人税率の特例と少額減価償却資産の特例は、帳簿から自動で書きます。賃上げ促進税制・特別償却など、ほかに適用を受けた措置の条項・区分番号・適用額を入れます（区分番号は国税庁「適用額明細書の記載の手引」の一覧で確かめてください）。' }),
      appList,
      h('h2', { class: 'section-title', text: '繰越欠損金（別表七(一)）' }),
      h('p', { class: 'field-hint', text: '前期以前の青色申告の事業年度の欠損金で、まだ控除していない額。事業年度の終了日と金額を入れます。' }),
      lossList,
      h('h2', { class: 'section-title', text: '前期分の確定税額・当期の中間納付額' }),
      h('p', { class: 'field-hint', text: '前期分：当期に未払法人税等を取り崩して納めた、前期の確定申告の税額。中間納付額：当期に「法人税、住民税及び事業税」で処理した中間申告の税額。' }),
      taxGrid,
      h('h2', { class: 'section-title', text: '法人住民税' }),
      h('label', { class: 'check' }, tokyo, h('span', { text: '東京都の特別区（23区）だけに事務所がある（都民税だけを納める）' })),
      h('div', { class: 'field-row' }, field('法人税割の税率（道府県民税・%）', prefRate), field('法人税割の税率（市町村民税・%）', cityRate)),
      h('div', { class: 'field-row' }, field('均等割の年額（道府県民税）', prefPerCapita), field('均等割の年額（市町村民税）', cityPerCapita)),
      field('均等割の月数（事務所があった月数）', months, { hint: '税率・年額は事務所がある自治体の案内で確かめてください（資本金等の額・従業者数で年額が変わります）' }),
      field('期末の従業者数', employees, { hint: '第六号様式・第二十号様式の欄。市町村民税の均等割は従業者数が50人を超えるかで年額が変わります' }),
      h('div', { class: 'report-tools' }, h('button', { type: 'button', class: 'btn', text: '均等割を標準税率で入れる', onclick: fillStandard })),
      h('p', { class: 'field-hint', text: `帳簿の資本金＋資本準備金の期末（${formatYen(current.capital.total)}円）で区分します。税務上の資本金等の額（別表五(一)の差引翌期首現在資本金等の額）の方が大きいときは、その額で判定し直してください。自治体が超過税率を決めていれば、その年額に直してください。` }),
      h('div', { class: 'field-row' }, field('中間納付額のうち均等割（道府県民税）', prefInterimPC), field('中間納付額のうち均等割（市町村民税）', cityInterimPC)),
      h('p', { class: 'field-hint', text: '中間申告で納めた住民税のうち均等割の額。残りを法人税割として、申告書の「既に納付の確定した当期分」の欄に分けて書きます。' }),
      h('h2', { class: 'section-title', text: '株主（別表二 同族会社等の判定）' }),
      h('div', { class: 'field-row' }, field('期末現在の発行済株式の総数（出資の総額）', sharesTotal), field('期末現在の議決権の総数', votesTotal)),
      h('p', { class: 'field-hint', text: '自己株式は発行済株式の総数から除きます。議決権の無い株式があるときは議決権の総数を入れてください。' }),
      holderList,
      h('h2', { class: 'section-title', text: '別表五(一)の期首の調整項目' }),
      h('p', { class: 'field-hint', text: '前期の別表五(一)の「差引翌期首現在」に載っている、減価償却の償却超過額などの調整項目。マイナスは「-」か「△」を付けます。当期の留保の加算・減算と同じ名前にすると同じ行にまとまります。' }),
      openList,
      h('button', { type: 'submit', class: 'btn btn-primary btn-block', text: '保存する' }),
    ),
  );
}
