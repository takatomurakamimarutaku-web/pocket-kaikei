// 事業税：法人は第六号様式の所得割・特別法人事業税の欄、個人は個人事業税の見込み額
// 弥生会計・freee の法人税申告ソフトの「第六号様式」と、個人の事業税の試算を参考にした
import { h, put, amountCell, field, showToast, errorBox } from '../ui.js';
import { buildStatements } from '../statements.js';
import { periodMonths } from '../depreciation.js';
import { corporateEnterpriseTax, individualEnterpriseTax, DEFAULT_ENTERPRISE_TAX, STANDARD_RATES, SPECIAL_RATE, INDUSTRIES, formatPercent, parsePercent } from '../enterprise-tax.js';
import { formatPeriod } from '../period.js';
import { formatYen, parseYen } from '../money.js';
import { ValidationError } from '../db.js';
import { errorText } from '../errors.js';
import { isWhite } from '../white-return.js';
import { corporateTaxReturn } from '../corporate-tax.js';

export async function render({ app, outlet }) {
  const { settings, period, accounts, journals } = await app.load();
  const corp = settings.entityType === 'corporation';
  const white = isWhite(settings);
  const { pl } = buildStatements({ entityType: settings.entityType, accounts, period, journals, white });
  const input = { ...DEFAULT_ENTERPRISE_TAX, ...(period.enterpriseTax || {}) };
  const months = periodMonths(period);
  // 法人の所得金額の既定は、法人税の申告の別表四の所得金額（欠損金の繰越控除を含む）
  const schedule4Income = corp ? corporateTaxReturn({ accounts, period, journals, input: period.corporateTax || {}, enterpriseInput: period.enterpriseTax || {} }).schedule4.income.total : 0;
  const resultEl = h('div');
  const errorsEl = h('div');

  const row = (no, label, amount, { rate = null, strong = false, sub = '' } = {}) =>
    h('tr', { class: strong ? 'mt-strong' : '' }, h('td', { class: 'tf-no', text: no }), h('th', { scope: 'row' }, label, sub ? h('span', { class: 'muted small block', text: sub }) : null), h('td', { class: 'num', text: rate === null ? '' : `${formatPercent(rate)}%` }), amountCell('td', amount));
  const table = (label, rows) => h('div', { class: 'table-wrap' }, h('table', { class: 'report taxform et-table', 'aria-label': label }, h('thead', {}, h('tr', {}, ['', '項目', '税率', '金額'].map((t) => h('th', { scope: 'col', text: t })))), h('tbody', {}, rows)));
  const yenInput = (id, key, placeholder = '0') =>
    h('input', {
      id,
      type: 'text',
      inputmode: 'numeric',
      value: input[key] === null ? '' : String(input[key]),
      placeholder,
      oninput: (e) => {
        const v = e.target.value.trim();
        const r = v === '' ? null : parseYen(v, { allowNegative: key === 'income', allowZero: true });
        input[key] = r === null ? (key === 'income' ? null : 0) : r.ok ? r.value : NaN;
        paint();
      },
    });

  async function save() {
    try {
      await app.db.saveEnterpriseTax(period.id, input);
      put(errorsEl);
      showToast('事業税の入力を保存しました');
    } catch (e) {
      put(errorsEl, errorBox(e instanceof ValidationError ? (Array.isArray(e.errors) ? e.errors : Object.values(e.errors)) : [errorText(e, '保存')]));
    }
  }

  function corporateView() {
    const autoIncome = schedule4Income;
    const income = Number.isInteger(input.income) ? input.income : autoIncome;
    const r = corporateEnterpriseTax({ ...input, income, months });
    const tierNo = ['㉙', '㉚', '㉛'];
    return [
      h(
        'div',
        { class: 'kpi-grid' },
        h('div', { class: 'kpi' }, h('span', { class: 'kpi-label', text: '法人事業税（所得割）' }), h('span', { class: 'kpi-value num', text: `${formatYen(r.incomeTax)}円` }), h('span', { class: 'kpi-sub', text: `差引 ${formatYen(r.dueTax)}円` })),
        h('div', { class: 'kpi' }, h('span', { class: 'kpi-label', text: '特別法人事業税' }), h('span', { class: 'kpi-value num', text: `${formatYen(r.special)}円` }), h('span', { class: 'kpi-sub', text: `差引 ${formatYen(r.dueSpecial)}円` })),
      ),
      h('h3', { class: 'tf-title', text: '第六号様式（所得割・特別法人事業税の欄）' }),
      table('法人事業税', [
        row('㉘', '所得金額総額（課税標準）', r.base, { sub: Number.isInteger(input.income) ? '入力した所得金額（1,000円未満切捨て）' : '法人税の申告（別表四）の所得金額（1,000円未満切捨て）' }),
        ...r.rows.map((x, i) => row(r.reduced ? tierNo[i] : '㉜', x.label, x.amount, { rate: x.rate, sub: r.reduced && months < 12 && i < 2 ? `月割：${formatYen(r.limits[i])}円まで（${months}か月）` : '' })),
        row('', '所得割の税額', r.incomeTax, { strong: true, sub: '各区分の税額の合計（100円未満切捨て）' }),
        row('', '中間納付額', -r.interimTax),
        row('', '差引納付すべき事業税額', r.dueTax, { strong: true }),
      ]),
      table('特別法人事業税', [
        row('㊷', '基準法人所得割額', r.standardTax, { sub: '標準税率（3.5%・5.3%・7.0%）で計算した所得割額' }),
        row('㊸', '特別法人事業税額', r.special, { rate: SPECIAL_RATE * 1000, strong: true }),
        row('', '中間納付額', -r.interimSpecial),
        row('', '差引納付すべき特別法人事業税額', r.dueSpecial, { strong: true }),
        row('', '事業税と特別法人事業税の合計', r.total, { strong: true }),
      ]),
      h('p', { class: 'muted small', text: `${formatPeriod(period)}（${months}か月）。欄の番号は第六号様式の目安です。` }),
    ];
  }

  function corporateInputs() {
    const rateInput = (i) =>
      h('input', {
        id: `et-rate-${i}`,
        type: 'text',
        inputmode: 'decimal',
        value: formatPercent(input.rates[i]),
        oninput: (e) => {
          input.rates = input.rates.map((r, j) => (j === i ? parsePercent(e.target.value) : r));
          paint();
        },
      });
    const reduced = h('input', { type: 'checkbox', checked: input.reduced, onchange: (e) => ((input.reduced = e.target.checked), paint()) });
    return [
      field('所得金額（法人税の所得）', yenInput('et-income', 'income', `空欄なら別表四の所得金額 ${formatYen(schedule4Income)}`), { hint: '空欄なら「法人税の申告」の別表四の所得金額を使います（欠損金の繰越控除も反映）' }),
      h('label', { class: 'check small' }, reduced, '軽減税率を適用する（3以上の都道府県に事務所があり資本金1,000万円以上の法人は外す）'),
      h('div', { class: 'field-row et-rates' }, field('400万円以下（%）', rateInput(0)), field('800万円以下（%）', rateInput(1)), field('800万円超（%）', rateInput(2))),
      h('p', { class: 'muted small', text: `標準税率は ${STANDARD_RATES.map(formatPercent).join('%・')}%。東京都などの超過税率は都道府県の税率表で確認してください。` }),
      h('div', { class: 'field-row' }, field('中間納付した事業税', yenInput('et-interim', 'interimTax')), field('中間納付した特別法人事業税', yenInput('et-interim-special', 'interimSpecial'))),
    ];
  }

  function individualView() {
    const r = individualEnterpriseTax({ income: pl.profits.businessIncome, industry: input.industry, months: input.months, lossCarry: input.lossCarry });
    return [
      h(
        'div',
        { class: 'kpi-grid' },
        h('div', { class: 'kpi' }, h('span', { class: 'kpi-label', text: '個人事業税の見込み' }), h('span', { class: 'kpi-value num', text: `${formatYen(r.tax)}円` }), h('span', { class: 'kpi-sub', text: r.exempt ? '課税されない業種' : `税率 ${formatPercent(r.rate)}%` })),
        h('div', { class: 'kpi' }, h('span', { class: 'kpi-label', text: '納期の目安' }), h('span', { class: 'kpi-value num', text: r.second ? `${formatYen(r.first)}円` : `${formatYen(r.tax)}円` }), h('span', { class: 'kpi-sub', text: r.second ? `8月 / 11月 ${formatYen(r.second)}円` : '8月に1回' })),
      ),
      h('h3', { class: 'tf-title', text: '個人事業税の計算' }),
      table('個人事業税', [
        white
          ? row('', '所得金額（専従者控除前）', r.income, { sub: '帳簿の事業所得。事業税の事業専従者控除は計算していないので、控除する額は「損失の繰越控除など」に含めて入力してください' })
          : row('', '所得金額（青色申告特別控除前）', r.income, { sub: '青色申告決算書の「青色申告特別控除前の所得金額」。事業税では青色申告特別控除は引けません' }),
        row('', '損失の繰越控除など', -r.lossCarry),
        row('', '事業主控除', -r.deduction, { sub: input.months < 12 ? `${input.months}か月の月割` : '年290万円' }),
        row('', '課税標準', r.base, { strong: true, sub: '1,000円未満切捨て' }),
        row('', '事業税額', r.tax, { rate: r.rate, strong: true, sub: '100円未満切捨て' }),
      ]),
      h(
        'div',
        { class: 'panel small' },
        h('p', { class: 'strong', text: '確定申告書 第二表「住民税・事業税に関する事項」に書くこと' }),
        h('ul', {}, [
          '事業用資産の譲渡損失など、不動産所得から差し引いた青色申告特別控除額（不動産所得がある場合）',
          '非課税所得など（課税されない事業の所得がある場合はその番号と所得）',
          '開業・廃業した場合はその日付、他の都道府県にも事務所がある場合はその旨',
        ].map((t) => h('li', { text: t }))),
        h('p', { class: 'muted', text: '確定申告をすれば事業税の申告は不要です。税額は都道府県から8月ごろ届く納税通知書で確定します。' }),
      ),
    ];
  }

  function individualInputs() {
    return [
      field('業種の区分', h('select', { id: 'et-industry', onchange: (e) => ((input.industry = e.target.value), paint()) }, INDUSTRIES.map((x) => h('option', { value: x.id, text: `${x.label}　${formatPercent(x.rate)}%`, selected: input.industry === x.id }))), { hint: '業種ごとの区分は都道府県の案内で確認してください' }),
      h(
        'div',
        { class: 'field-row' },
        field('事業を行った月数', h('input', { id: 'et-months', type: 'text', inputmode: 'numeric', value: String(input.months), oninput: (e) => ((input.months = /^\d+$/.test(e.target.value.trim()) ? Number(e.target.value.trim()) : NaN), paint()) }), { hint: '年の途中で開業したとき' }),
        field('損失の繰越控除など', yenInput('et-loss', 'lossCarry')),
      ),
    ];
  }

  function paint() {
    const ok = corp ? input.rates.every(Number.isInteger) && [input.interimTax, input.interimSpecial].every(Number.isInteger) && (input.income === null || Number.isInteger(input.income)) : Number.isInteger(input.months) && input.months >= 1 && input.months <= 12 && Number.isInteger(input.lossCarry);
    put(resultEl, ok ? (corp ? corporateView() : individualView()) : h('p', { class: 'notice', text: '入力を確認してください（数字・月数1〜12・税率は小数第3位まで）。' }));
  }

  put(
    outlet,
    h('p', { class: 'muted small', text: `${settings.businessName}　${formatPeriod(period)}` }),
    resultEl,
    h('details', { class: 'panel no-print', open: !period.enterpriseTax }, h('summary', { text: '計算の条件を入力する' }), corp ? corporateInputs() : individualInputs(), errorsEl, h('button', { type: 'button', class: 'btn btn-block', text: '入力を保存する', onclick: save })),
    h(
      'div',
      { class: 'panel small muted' },
      corp
        ? [
            h('p', { text: '資本金1億円以下の普通法人（外形標準課税の対象外）の所得割を計算します。所得割の税率は標準税率（年400万円以下3.5%・800万円以下5.3%・800万円超7.0%）、特別法人事業税は基準法人所得割額の37%です（地方税法 第72条の24の7、特別法人事業税及び特別法人事業譲与税に関する法律 第7条）。' }),
            h('p', { text: '対応していないもの：外形標準課税（付加価値割・資本割）、収入金額課税の法人、複数の都道府県への分割（第十号様式）。法人住民税と、欠損金の繰越控除を反映した所得金額は「法人税の申告」の画面で計算します。' }),
          ]
        : [
            h('p', { text: '課税標準＝所得金額（青色申告特別控除前）−損失の繰越控除など−事業主控除（年290万円・1年未満は月割）。税率は第1種事業5%・第2種事業4%・第3種事業5%（あん摩・はり・きゅう等は3%）。' }),
            h('p', { text: '不動産所得（不動産貸付業）・青色事業専従者給与以外の専従者控除・事業用資産の譲渡損失には対応していません。実際の税額は都道府県の通知で確定します。' }),
          ],
    ),
  );
  paint();
}
