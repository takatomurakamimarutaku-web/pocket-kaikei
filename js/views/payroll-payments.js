// 天引きした税・保険料の納付：源泉所得税（所得税徴収高計算書に書く金額・納期限）、住民税、社会保険料。納付の仕訳の登録
import { h, put, field, segmented, showToast, confirmDialog, errorBox } from '../ui.js';
import { formatYen } from '../money.js';
import { ValidationError } from '../db.js';
import { errorText } from '../errors.js';
import { journalLabel } from '../journal.js';
import { compareAccounts } from '../accounts.js';
import { todayString, isValidDate } from '../period.js';
import { weekday } from '../holidays.js';
import { withholdingSummary, monthlyDeductions, resolvePayrollSettings, paymentSourceId, PAYMENT_KINDS } from '../payroll.js';
import { amountInput, readAmount } from './pay-items.js';

const WEEK = '日月火水木金土';
const slash = (d) => d.replaceAll('-', '/');
const withDay = (d) => `${slash(d)}（${WEEK[weekday(d)]}）`;
const monthName = (key) => `${Number(key.slice(5))}月`;
const TABS = [
  { value: 'incomeTax', label: '源泉所得税' },
  { value: 'residentTax', label: '住民税' },
  { value: 'social', label: '社会保険料' },
];

export async function render({ app, outlet, query }) {
  const [settings, accounts, payrolls, paid] = await Promise.all([app.db.getSettings(), app.db.listAccounts(), app.db.listPayrolls(), app.db.listJournalsBySource('payroll_payment')]);
  const cfg = resolvePayrollSettings(settings.payroll, accounts);
  const today = todayString();
  let year = /^\d{4}$/.test(query.year || '') ? Number(query.year) : Number(today.slice(0, 4));
  let tab = TABS.some((t) => t.value === query.tab) ? query.tab : 'incomeTax';
  const errorsEl = h('div', { class: 'errors-wrap' });
  const body = h('div');
  const yearLabel = h('span', { class: 'month-label' });
  const update = () => {
    history.replaceState(history.state, '', `#/payroll/payments?year=${year}&tab=${tab}`);
    paint();
  };
  const paidOf = (kind, key) => paid.filter((j) => j.sourceId === paymentSourceId(kind, key));
  const payAccounts = [...accounts].filter((a) => (a.role === 'cash' || a.role === 'deposit') && a.active).sort(compareAccounts);

  /** 納付の仕訳を登録するダイアログ */
  async function pay({ kind, key, label, amount, due, social = false }) {
    const date = h('input', { id: 'pp-date', type: 'date', value: due && due >= today ? due : today });
    const amountEl = amountInput('pp-amount', amount);
    const share = social ? amountInput('pp-share', amount) : null;
    const account = h('select', { id: 'pp-account' }, payAccounts.map((a) => h('option', { value: a.id, text: `${a.code} ${a.name}`, selected: a.id === cfg.accounts.payment })));
    const errBox = h('div');
    const ok = await confirmDialog({
      title: `${PAYMENT_KINDS[kind].label}の納付の仕訳`,
      message: `${label}。借方 預り金${social ? '・会社負担の科目' : ''}／貸方 支払口座 の仕訳を登録します。`,
      body: h(
        'div',
        {},
        errBox,
        field('納付した日', date),
        field(social ? '本人負担分（天引きした額）' : '納付した金額', amountEl),
        social ? field('会社負担分', share, { hint: '年金事務所などから届く納入告知書の合計から、本人負担分を引いた金額' }) : null,
        field('支払口座', account),
      ),
      buttons: [
        { label: 'キャンセル', value: false },
        { label: '登録する', value: true, variant: 'primary' },
      ],
    });
    if (ok !== true) return;
    const errors = [];
    const amt = readAmount(amountEl, '金額', errors);
    const shareAmt = share ? readAmount(share, '会社負担分', errors) : 0;
    if (!isValidDate(date.value)) errors.push('納付した日を入力してください');
    try {
      if (errors.length) throw new ValidationError(errors);
      const j = await app.db.savePayrollPayment({ kind, key, label, date: date.value, amount: amt, companyShare: shareAmt, paymentAccountId: account.value });
      showToast(`納付の仕訳を登録しました（${journalLabel(j)}）`);
      app.refresh();
    } catch (e) {
      put(errorsEl, errorBox(e instanceof ValidationError ? [].concat(Object.values(e.errors)) : [errorText(e, '登録')]));
      errorsEl.scrollIntoView({ behavior: 'smooth', block: 'center' });
    }
  }

  const paidLine = (list) => list.map((j) => h('p', { class: 'small' }, h('span', { class: 'badge badge-ok', text: '納付済み' }), ' ', h('a', { href: `#/journal/${j.id}/edit`, text: `${slash(j.date)} ${journalLabel(j)}` }), ` ${formatYen(j.lines.filter((l) => l.side === 'credit').reduce((s, l) => s + l.amount, 0))}円`));

  function incomeTaxCards() {
    const list = withholdingSummary(payrolls, { year, special: cfg.special }).filter((s) => s.posted || s.drafts);
    if (!list.length) return [h('p', { class: 'muted', text: `${year}年に仕訳を登録した給与はありません。` })];
    return list.map((s) => {
      const done = paidOf('incomeTax', s.key);
      const rows = s.rows.filter((r) => r.persons || r.tax);
      const foot = (label, amount) => h('tr', {}, h('th', { scope: 'row', colspan: 3, text: label }), h('td', { class: 'num', text: formatYen(amount) }));
      const adjusted = s.shortage || s.excess || s.carryIn;
      return h(
        'section',
        { class: 'pp-card' },
        h('h3', { class: 'pp-title', text: s.label }),
        h('p', { class: 'pp-due' }, '納期限 ', h('strong', { text: withDay(s.due) }), s.due !== s.nominalDue ? h('span', { class: 'muted small', text: `（${slash(s.nominalDue)}が休日のため）` }) : null),
        rows.length
          ? h(
              'table',
              { class: 'pp-table' },
              h('thead', {}, h('tr', {}, h('th', { text: '区分' }), h('th', { text: '人員' }), h('th', { text: '支給額' }), h('th', { text: '税額' }))),
              h(
                'tbody',
                {},
                rows.map((r) => h('tr', {}, h('th', { scope: 'row', text: r.label }), h('td', { class: 'num', text: `${r.persons}人` }), h('td', { class: 'num', text: formatYen(r.amount) }), h('td', { class: 'num', text: formatYen(r.tax) }))),
              ),
              h(
                'tfoot',
                {},
                adjusted ? foot('計', s.tax) : null,
                s.shortage ? foot('年末調整による不足税額', s.shortage) : null,
                s.excess ? foot('年末調整による超過税額', s.excess) : null,
                s.carryIn ? foot('前の納付で引ききれなかった超過税額', s.carryIn) : null,
                foot(adjusted ? '本税（納付税額）' : '納付税額', s.payable),
              ),
            )
          : null,
        s.first ? h('p', { class: 'small', text: `支払年月日：${cfg.special && s.first !== s.last ? `${slash(s.first)}〜${slash(s.last)}` : slash(s.last)}` }) : null,
        s.posted && !s.payable ? h('p', { class: 'small notice', text: '納付税額が0円でも、給与を支払ったときは納付書（所得税徴収高計算書）を税務署に出します（e-Taxでも出せます）。' }) : null,
        s.carry ? h('p', { class: 'small notice', text: `年末調整の超過税額のうち ${formatYen(s.carry)}円は引ききれていません。この後に納付する源泉所得税から順に差し引きます（翌年の納付にも繰り越します）。還付しきれないと見込まれるとき（翌月から2か月を経過しても還付しきれないときなど）は、税務署に「年末調整過納額還付請求書 兼 残存過納額明細書」を出します。` }) : null,
        s.drafts ? h('p', { class: 'small notice', text: `仕訳を登録していない給与（${s.drafts}件）は含めていません。` }) : null,
        ...paidLine(done),
        !done.length && s.payable > 0 ? h('button', { type: 'button', class: 'btn btn-block', text: '納付の仕訳を登録', onclick: () => pay({ kind: 'incomeTax', key: s.key, label: `${s.label}（納付税額 ${formatYen(s.payable)}円）`, amount: s.payable, due: s.due }) }) : null,
      );
    });
  }

  function monthlyCards(kind) {
    const months = monthlyDeductions(payrolls, year).filter((m) => m[kind]);
    if (!months.length) return [h('p', { class: 'muted', text: `${year}年に${kind === 'social' ? '社会保険料（健康保険・厚生年金）' : '住民税'}を天引きした給与（仕訳を登録したもの）はありません。` })];
    return months.map((m) => {
      const done = paidOf(kind, m.key);
      const label = `${year}年${monthName(m.key)}支給の給与から天引きした${kind === 'social' ? '社会保険料' : '住民税'}`;
      return h(
        'section',
        { class: 'pp-card' },
        h('h3', { class: 'pp-title', text: `${monthName(m.key)}支給分` }),
        h('p', {}, '天引きした額 ', h('strong', { class: 'num', text: `${formatYen(m[kind])}円` })),
        ...paidLine(done),
        done.length ? null : h('button', { type: 'button', class: 'btn btn-block', text: '納付の仕訳を登録', onclick: () => pay({ kind, key: m.key, label, amount: m[kind], social: kind === 'social' }) }),
      );
    });
  }

  function paint() {
    yearLabel.textContent = `${year}年`;
    put(errorsEl);
    let intro;
    let cards;
    if (tab === 'incomeTax') {
      intro = cfg.special ? '納期の特例：1〜6月に支払った給与の源泉所得税は7月10日まで、7〜12月分は翌年1月20日までに納めます。' : '給与を支払った月の翌月10日までに納めます（納期の特例を受けている場合は給与の設定で切り替えます）。';
      cards = incomeTaxCards();
    } else if (tab === 'residentTax') {
      intro = '住民税（特別徴収）は、市区町村から届く納入書の期限までに納めます。';
      cards = monthlyCards('residentTax');
    } else {
      const from = `${year}-04-01`;
      const to = `${year + 1}-03-31`;
      const employment = payrolls.filter((p) => p.journalId && from <= p.payDate && p.payDate <= to).reduce((s, p) => s + (p.employment || 0), 0);
      intro = `健康保険料・厚生年金保険料は、年金事務所などから届く納入告知書の金額で納めます（口座振替が多い）。会社負担分は「${accounts.find((a) => a.id === cfg.accounts.welfare)?.name ?? '会社負担の科目'}」に入ります。雇用保険料（本人負担）の天引き：${year}年4月〜${year + 1}年3月支給分 ${formatYen(employment)}円（労働保険の年度更新で納めます。納めたときは振替伝票で入力してください）。`;
      cards = monthlyCards('social');
    }
    put(body, h('p', { class: 'panel small', text: intro }), ...cards);
  }

  put(
    outlet,
    h('div', { class: 'month-bar month-bar-plain' }, h('button', { type: 'button', class: 'btn btn-small', 'aria-label': '前の年', text: '‹', onclick: () => ((year -= 1), update()) }), yearLabel, h('button', { type: 'button', class: 'btn btn-small', 'aria-label': '次の年', text: '›', onclick: () => ((year += 1), update()) })),
    segmented({ name: '納付の種類', options: TABS, value: tab, onChange: (v) => ((tab = v), update()) }),
    errorsEl,
    body,
  );
  paint();
}
