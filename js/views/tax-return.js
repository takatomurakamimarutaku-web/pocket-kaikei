// 消費税の申告計算：計算の方法を選び、申告書の主な欄（課税標準額〜納付税額）と方法ごとの比較を表示する
// 「申告書」の表示では、第一表・第二表・付表を様式の欄番号どおりに並べる（弥生会計の消費税申告書の画面を参考にした）
import { h, put, field, segmented, showToast, errorBox, amountCell, saveFile } from '../ui.js';
import { computeTaxReturn, TAX_METHODS, BUSINESS_TYPES, ALLOCATIONS, TAX_CALCS, ROUNDINGS, stackedDetail, consumptionTaxLines } from '../tax-return.js';
import { taxReturnForms } from '../tax-forms.js';
import { taxFormsCsv, stackedTaxCsv, csvFileName } from '../csv.js';
import { validateJournal, journalLabel } from '../journal.js';
import { parseYen, formatYen } from '../money.js';
import { formatPeriod } from '../period.js';
import { createJournal } from '../models.js';
import { ValidationError } from '../db.js';
import { errorText } from '../errors.js';
import { closedNotice } from './period-common.js';

export async function render({ app, outlet, query = {} }) {
  const { settings, period, accounts, subAccounts, journals, accountById, subById } = await app.load();
  const entityType = settings.entityType;
  const saved = period.taxReturn || {};
  const state = {
    method: saved.method || 'general',
    businessType: saved.businessType || 5,
    allocation: saved.allocation || 'proportional',
    interimNational: saved.interimNational || 0,
    interimLocal: saved.interimLocal || 0,
    baseSales: saved.baseSales ?? null,
    salesCalc: saved.salesCalc === 'stacked' ? 'stacked' : 'gross',
    purchaseCalc: saved.salesCalc === 'stacked' || saved.purchaseCalc === 'stacked' ? 'stacked' : 'gross',
    salesRounding: ROUNDINGS.some((x) => x.id === saved.salesRounding) ? saved.salesRounding : 'floor',
    purchaseRounding: ROUNDINGS.some((x) => x.id === saved.purchaseRounding && x.purchase) ? saved.purchaseRounding : 'floor',
  };
  let view = query.view === 'form' ? 'form' : 'calc';
  const body = h('div');
  const typeWrap = h('div');
  const allocWrap = h('div');
  const calcWrap = h('div');
  const errorsEl = h('div');

  const typeSelect = h(
    'select',
    { id: 'tr-type', onchange: (e) => ((state.businessType = Number(e.target.value)), paint()) },
    BUSINESS_TYPES.map((t) => h('option', { value: t.id, text: `${t.label}　みなし仕入率${t.rate}%`, selected: t.id === state.businessType })),
  );
  const yenInput = (id, key) =>
    h('input', {
      id,
      type: 'text',
      inputmode: 'numeric',
      class: 'amount-input',
      value: state[key] ? String(state[key]) : '',
      placeholder: '0',
      oninput: (e) => {
        const p = parseYen(e.target.value || '0', { allowZero: true });
        state[key] = p.ok ? p.value : NaN;
        paint();
      },
    });
  const interimN = yenInput('tr-interim-n', 'interimNational');
  const interimL = yenInput('tr-interim-l', 'interimLocal');
  const baseSalesInput = h('input', {
    id: 'tr-base-sales',
    type: 'text',
    inputmode: 'numeric',
    class: 'amount-input',
    value: state.baseSales === null ? '' : String(state.baseSales),
    placeholder: '未入力',
    oninput: (e) => {
      const v = e.target.value.trim();
      const p = parseYen(v || '0', { allowZero: true });
      state.baseSales = v === '' ? null : p.ok ? p.value : NaN;
      paint();
    },
  });

  const row = (label, value, { strong = false, note = '' } = {}) =>
    h('tr', { class: strong ? 'mt-strong' : '' }, h('th', { scope: 'row' }, label, note ? h('span', { class: 'muted small block', text: note }) : null), amountCell('td', value));

  function paint() {
    typeWrap.hidden = state.method !== 'simplified';
    allocWrap.hidden = state.method !== 'general';
    const bad = !Number.isFinite(state.interimNational) || !Number.isFinite(state.interimLocal);
    if (bad) {
      put(body, errorBox(['中間納付税額は0以上の整数で入力してください']));
      return;
    }
    if (Number.isNaN(state.baseSales)) {
      put(body, errorBox(['基準期間の課税売上高は0以上の整数で入力してください']));
      return;
    }
    const r = computeTaxReturn({ journals, period, entityType, ...state });
    if (view === 'form') {
      put(body, r.warnings.length ? h('div', { class: 'notice' }, h('ul', { class: 'plain-list' }, r.warnings.map((w) => h('li', { text: w })))) : null, formsView(taxReturnForms(r, { baseSales: state.baseSales })));
      return;
    }
    const pct = (x) => `${(Math.floor(x * 10000) / 100).toFixed(2)}%`; // 課税売上割合は小数点以下2桁まで表示（切り捨て）
    const purchaseNote = [
      r.purchaseCalc === 'stacked' ? `積上げ計算（明細ごとの消費税額等 ${formatYen(r.stacked.purchase10 + r.stacked.purchase8)}円 × 78/100）` : '',
      `仕入10% ${formatYen(r.purchaseTax10)}・8% ${formatYen(r.purchaseTax8)}`,
      ...r.transitional.map((t) => `インボイスなし${t.pct}% ${formatYen(t.tax)}`),
      r.importTax ? `輸入 ${formatYen(r.importTax)}` : '',
      r.purchaseReturnTax ? `仕入の返品 △${formatYen(r.purchaseReturnTax)}` : '',
      r.fullDeduction ? '' : `${ALLOCATIONS.find((a) => a.id === r.allocation).label}：課税売上割合 ${pct(r.taxableRatio)}`,
    ]
      .filter(Boolean)
      .join('・');
    const deductionLabel = { general: '控除対象仕入税額', simplified: `控除対象仕入税額（みなし仕入率${r.businessType.rate}%）`, twenty: '特別控除税額（2割特例：売上の税額の80%）', thirty: '特別控除税額（3割特例：売上の税額の70%）' }[state.method];
    put(
      body,
      r.warnings.length ? h('div', { class: 'notice' }, h('ul', { class: 'plain-list' }, r.warnings.map((w) => h('li', { text: w })))) : null,
      h(
        'div',
        { class: 'table-wrap' },
        h(
          'table',
          { class: 'report taxsum' },
          h('caption', { text: '消費税（国税）' }),
          h(
            'tbody',
            {},
            row('課税標準額（10%）', r.base10, { note: `税込 ${formatYen(r.buckets.sales10)}円 × 100/110・千円未満切り捨て` }),
            r.base8 || r.buckets.sales8 ? row('課税標準額（8%軽減）', r.base8, { note: `税込 ${formatYen(r.buckets.sales8)}円 × 100/108・千円未満切り捨て` }) : null,
            row('消費税額', r.salesTax, { note: r.salesCalc === 'stacked' ? `積上げ計算：明細ごとの消費税額等の合計 ${formatYen(r.stacked.sales10 + r.stacked.sales8)}円 × 78/100` : '課税標準額 × 7.8%（軽減 6.24%）' }),
            r.adjustment ? row('控除過大調整税額', r.adjustment, { note: [r.recoveredTax ? `貸倒れの回収 ${formatYen(r.recoveredTax)}` : '', r.adjustment - r.recoveredTax ? `控除しきれない仕入の返品 ${formatYen(r.adjustment - r.recoveredTax)}` : ''].filter(Boolean).join('・') }) : null,
            row(deductionLabel, r.deduction, { note: state.method === 'general' ? purchaseNote : r.returnTax || r.recoveredTax ? '（消費税額＋貸倒れの回収−売上の返品の税額）に割合を掛けています' : '' }),
            r.returnTax ? row('返還等対価に係る税額', r.returnTax, { note: '売上の返品・値引き（税込）× 7.8/110（軽減 6.24/108）' }) : null,
            r.badDebtTax ? row('貸倒れに係る税額', r.badDebtTax, { note: '貸倒れ（税込）× 7.8/110（軽減 6.24/108）' }) : null,
            r.returnTax || r.badDebtTax ? row('控除税額小計', r.deductionTotal) : null,
            row(r.net >= 0 ? '差引税額' : '控除不足還付税額', r.net, { strong: true, note: r.net >= 0 ? '百円未満切り捨て' : '' }),
          ),
        ),
      ),
      h(
        'div',
        { class: 'table-wrap' },
        h(
          'table',
          { class: 'report taxsum' },
          h('caption', { text: '地方消費税と納付税額' }),
          h(
            'tbody',
            {},
            row('地方消費税（譲渡割額）', r.local, { note: '差引税額 × 22/78・百円未満切り捨て' }),
            row('消費税及び地方消費税の合計', r.total, { strong: true }),
            r.interimNational || r.interimLocal ? row('中間納付税額', -(r.interimNational + r.interimLocal)) : null,
            row(r.payable >= 0 ? '納付税額' : '還付される税額', r.payable, { strong: true }),
          ),
        ),
      ),
      state.method === 'general' && r.taxableRatio !== null
        ? h(
            'div',
            { class: 'table-wrap' },
            h(
              'table',
              { class: 'report taxsum' },
              h('caption', { text: '課税売上割合' }),
              h(
                'tbody',
                {},
                row('課税売上高（税抜）', r.taxableSales, { note: '返品・値引きを引く。輸出売上を含む' }),
                row('総売上高（税抜）', r.totalSales, { note: '課税売上高＋非課税売上＋有価証券等の譲渡対価の5%' }),
                r.months < 12 ? row('年換算した課税売上高', r.annualTaxable, { note: `課税期間が${r.months}か月のため、課税売上高 ÷ ${r.months} × 12（5億円の判定に使う）` }) : null,
                h('tr', {}, h('th', { scope: 'row', text: '課税売上割合' }, h('span', { class: 'muted small block', text: r.fullDeduction ? '95%以上・課税売上高5億円以下なので全額控除' : '95%未満などのため按分' })), h('td', { class: 'num', text: pct(r.taxableRatio) })),
                r.fullDeduction ? null : ALLOCATIONS.map((a) => row(`控除対象仕入税額（${a.short}）`, r.allocated[a.id], { strong: a.id === r.allocation })),
              ),
            ),
          )
        : null,
      r.salesCalc === 'stacked' || (state.method === 'general' && r.purchaseCalc === 'stacked')
        ? h('div', { class: 'actions no-print' }, h('button', { type: 'button', class: 'btn', text: '積上げ計算の明細をCSVで書き出す', onclick: exportStacked }))
        : null,
      h('h2', { class: 'section-title', text: '計算の方法ごとの比較' }),
      h(
        'div',
        { class: 'table-wrap' },
        h(
          'table',
          { class: 'report' },
          h('thead', {}, h('tr', {}, h('th', { scope: 'col', text: '方法' }), h('th', { scope: 'col', text: '消費税＋地方消費税' }))),
          h(
            'tbody',
            {},
            TAX_METHODS.map((m) => {
              const c = r.compare[m.id];
              return h(
                'tr',
                { class: m.id === state.method ? 'mt-strong' : '' },
                h('th', { scope: 'row' }, m.label, c.unavailable ? h('span', { class: 'muted small block', text: 'この期間は使えません' }) : null),
                c.unavailable ? h('td', { class: 'num muted', text: '－' }) : amountCell('td', c.total),
              );
            }),
          ),
        ),
      ),
      h('p', { class: 'muted small', text: '簡易課税は前々年（法人は前々事業年度）の課税売上高が5,000万円以下で届出をしている場合、2割特例・3割特例はインボイス発行事業者で前々年の課税売上高が1,000万円以下などの場合に使えます。' }),
      journalSection(r),
    );
  }

  async function exportStacked() {
    const rows = stackedDetail(journals, { from: period.startDate, to: period.endDate, salesRounding: state.salesRounding, purchaseRounding: state.purchaseRounding });
    const res = await saveFile(new Blob([stackedTaxCsv(rows, { accountById, subById })], { type: 'text/csv' }), csvFileName('tax-stacked'));
    if (res !== 'cancelled') showToast(`積上げ計算の明細（${rows.length}行）を書き出しました`);
  }

  /** 税額の計算（割戻し・積上げ）と、積上げ計算の明細ごとの端数処理 */
  function paintCalc() {
    const changed = () => {
      paintCalc();
      paint();
      saveSettings().catch(() => {});
    };
    const calcSeg = (name, key) =>
      segmented({
        name,
        options: TAX_CALCS.map((c) => ({ value: c.id, label: c.short })),
        value: state[key],
        onChange: (v) => {
          state[key] = v;
          if (key === 'salesCalc' && v === 'stacked') state.purchaseCalc = 'stacked';
          changed();
        },
      });
    const roundingSelect = (id, key, purchase) =>
      h(
        'select',
        { id, onchange: (e) => ((state[key] = e.target.value), changed()) },
        ROUNDINGS.filter((x) => !purchase || x.purchase).map((x) => h('option', { value: x.id, text: x.label, selected: x.id === state[key] })),
      );
    const salesStacked = state.salesCalc === 'stacked';
    const purchaseStacked = salesStacked || state.purchaseCalc === 'stacked';
    put(
      calcWrap,
      h(
        'div',
        { class: 'field-row' },
        field('売上の税額', calcSeg('売上の税額', 'salesCalc')),
        field('仕入の税額', salesStacked ? h('p', { class: 'tr-fixed small', text: '積上げ（売上を積上げにしたとき）' }) : calcSeg('仕入の税額', 'purchaseCalc')),
      ),
      salesStacked || purchaseStacked
        ? h(
            'div',
            { class: 'field-row' },
            salesStacked ? field('明細ごとの端数（売上）', roundingSelect('tr-round-s', 'salesRounding', false)) : h('div'),
            field('明細ごとの端数（仕入）', roundingSelect('tr-round-p', 'purchaseRounding', true)),
          )
        : null,
      salesStacked || purchaseStacked
        ? h('p', {
            class: 'muted small',
            text: '積上げ計算では、明細1行を1枚の請求書とみなし、明細ごとに税込金額×10/110（軽減8/108）の消費税額等を出して、その合計×78/100を税額にします。売上は交付した適格請求書の写しを保存していること、仕入は請求書に書かれた税額か、取引ごとに税額を帳簿に記録していることが要件です。請求書の税額と違うときは、仕訳を請求書ごとに分けるか、割戻し計算にしてください。',
          })
        : null,
    );
  }

  /** 申告書の様式（第一表・第二表・付表）の欄 */
  function formsView(f) {
    const v = (n) => (n === null || n === undefined ? h('td', { class: 'num muted', text: '' }) : amountCell('td', n));
    const single = (t, extraHead) => [
      h('h3', { class: 'tf-title', text: t.title }),
      h(
        'div',
        { class: 'table-wrap' },
        h(
          'table',
          { class: 'report taxform', 'aria-label': t.title },
          h('thead', {}, h('tr', {}, h('th', { scope: 'col', class: 'tf-no', text: '欄' }), h('th', { scope: 'col', text: '項目' }), h('th', { scope: 'col', text: '金額' }))),
          h(
            'tbody',
            {},
            extraHead,
            t.rows.map((x) => h('tr', { class: x.strong ? 'mt-strong' : '' }, h('td', { class: 'tf-no', text: x.no }), h('th', { scope: 'row' }, x.label, x.note ? h('span', { class: 'muted small block', text: x.note }) : null), v(x.value))),
          ),
        ),
      ),
    ];
    const triple = (t) => [
      h('h3', { class: 'tf-title', text: t.title }),
      h(
        'div',
        { class: 'table-wrap' },
        h(
          'table',
          { class: 'report taxform abc', 'aria-label': t.title },
          h('thead', {}, h('tr', {}, ['欄', '項目', '6.24%（A）', '7.8%（B）', '合計（C）'].map((x, i) => h('th', { scope: 'col', class: i === 0 ? 'tf-no' : '', text: x })))),
          h(
            'tbody',
            {},
            t.rows.map((x) =>
              h(
                'tr',
                { class: [x.strong ? 'mt-strong' : '', x.sub ? 'tf-sub' : ''].filter(Boolean).join(' ') },
                h('td', { class: 'tf-no', text: x.no }),
                h('th', { scope: 'row' }, x.label, x.note ? h('span', { class: 'muted small block', text: x.note }) : null),
                x.text !== undefined ? [h('td', {}), h('td', {}), h('td', { class: 'num', text: x.text })] : [v(x.a), v(x.b), v(x.c)],
              ),
            ),
          ),
        ),
      ),
    ];
    return [
      single(f.first, f.first.flags.map((t) => h('tr', {}, h('td', { class: 'tf-no' }), h('th', { scope: 'row', colspan: 2, text: t })))),
      single(f.second),
      f.sheets.map(triple),
      h('ul', { class: 'plain-list muted small' }, f.notes.map((t) => h('li', { text: t }))),
      h('p', { class: 'muted small', text: '空欄は0円または対応していない欄です。e-Tax・確定申告書等作成コーナーへの入力や、税理士への確認資料として使ってください。' }),
      h('div', { class: 'actions no-print' }, h('button', { type: 'button', class: 'btn', text: '申告書の欄をCSVで書き出す', onclick: () => saveFile(new Blob([taxFormsCsv(f)], { type: 'text/csv' }), csvFileName('tax-return-forms')) })),
    ];
  }

  function journalSection(r) {
    if (period.closed) return null;
    const done = journals.filter((j) => j.source === 'consumption_tax');
    const title = h('h2', { class: 'section-title', text: '決算整理の仕訳' });
    if (done.length) {
      const booked = done.reduce((s, j) => s + j.lines.filter((l) => l.side === 'debit').reduce((t, l) => t + l.amount, 0), 0);
      return h(
        'section',
        { class: 'panel no-print' },
        title,
        h('p', {}, '消費税等の仕訳は登録済みです（', h('a', { class: 'link', href: `#/journal/${encodeURIComponent(done[0].id)}/edit`, text: journalLabel(done[0]) }), '）。'),
        booked !== r.payable ? h('p', { class: 'notice', text: `いまの計算の納付税額（${formatYen(r.payable)}円）と仕訳の金額（${formatYen(booked)}円）が違います。仕訳を直してください。` }) : null,
      );
    }
    return h(
      'section',
      { class: 'panel no-print' },
      title,
      h('p', { class: 'small', text: `税込経理なので、納める消費税等を期末日（${period.endDate.replaceAll('-', '/')}）の仕訳で租税公課にします（中間納付は支払ったときに租税公課にしている前提で、残りの${formatYen(Math.max(0, r.payable))}円）。` }),
      errorsEl,
      h('button', { type: 'button', class: 'btn btn-block', text: '消費税等の仕訳を登録する', onclick: () => saveJournal(r) }),
    );
  }

  async function saveJournal(r) {
    const { lines, errors } = consumptionTaxLines({ amount: r.payable, accounts });
    if (errors.length) return put(errorsEl, errorBox(errors));
    const journal = createJournal({ periodId: period.id, date: period.endDate, lines, source: 'consumption_tax' });
    const v = validateJournal(journal, { accounts, subAccounts, period });
    if (v.length) return put(errorsEl, errorBox(v));
    try {
      await saveSettings();
      const saved = await app.db.saveJournal(journal);
      showToast(`消費税等の仕訳（${journalLabel(saved)}）を登録しました`);
      app.refresh();
    } catch (e) {
      put(errorsEl, errorBox(e instanceof ValidationError ? (Array.isArray(e.errors) ? e.errors : Object.values(e.errors)) : [errorText(e, '保存')]));
    }
  }

  async function saveSettings() {
    if (period.closed || !Number.isFinite(state.interimNational) || !Number.isFinite(state.interimLocal) || Number.isNaN(state.baseSales)) return;
    await app.db.saveTaxReturnSettings(period.id, state);
  }

  put(
    outlet,
    h('p', { class: 'muted small', text: `課税期間 ${formatPeriod(period)}（会計期間と同じ）` }),
    closedNotice(period),
    settings.taxStatus === 'exempt' ? h('div', { class: 'notice', text: '免税事業者として設定されています。申告は不要です（参考の計算です）。' }) : null,
    h(
      'section',
      { class: 'panel no-print' },
      field(
        '計算の方法',
        segmented({
          name: '計算の方法',
          options: TAX_METHODS.map((m) => ({ value: m.id, label: m.short })),
          value: state.method,
          onChange: (v) => {
            state.method = v;
            paint();
            saveSettings().catch(() => {});
          },
        }),
      ),
      h('div', {}, typeWrap),
      h('div', {}, allocWrap),
      calcWrap,
      h('div', { class: 'field-row' }, field('中間納付（国税）', interimN), field('中間納付（地方）', interimL)),
      h('p', { class: 'muted small', text: '選んだ方法・税額の計算と中間納付税額はこの期間に保存します。' }),
    ),
    h(
      'div',
      { class: 'no-print' },
      segmented({
        name: '表示',
        options: [
          { value: 'calc', label: '計算の内容' },
          { value: 'form', label: '申告書の欄' },
        ],
        value: view,
        onChange: (v) => {
          view = v;
          history.replaceState(history.state, '', v === 'form' ? '#/reports/tax-return?view=form' : '#/reports/tax-return');
          paint();
        },
      }),
    ),
    body,
    h(
      'div',
      { class: 'panel small muted' },
      h('p', { text: '税込経理の帳簿から、売上・仕入とも割戻し計算（選んだときは積上げ計算）で求めています。売上・仕入の返品・値引き、貸倒れの税額は割戻し計算です。税区分「売上の返品・値引き」は返還等対価に係る税額、「課税売上」の借方に入れた返品は売上から差し引いて計算します。' }),
      h('p', { text: '課税売上高が5億円を超えるかは、課税期間が1年に満たないとき（法人の設立の期など）は月数で年換算して判定します。' }),
      h('p', { text: '課税売上割合が95%未満（または課税売上高5億円超）のときは、選んだ方法（個別対応方式・一括比例配分方式）で控除額を按分します。個別対応方式は、設定で「仕入の用途区分」を使い、仕入を課税売上対応・共通対応・非課税売上対応に分けて記帳している場合に使えます。' }),
      h('p', { text: '対応していないもの：請求書に書かれた税額そのものの入力（積上げ計算は明細ごとに計算した税額を使います）、課税売上割合に準ずる割合、特定課税仕入れ（リバースチャージ）、インボイスのない仕入の返品の区分、簡易課税で複数の事業区分がある場合、令和9年4月からの飲食料品の税率の引き下げ。' }),
      h('p', { text: '出典：国税庁 タックスアンサー No.6383・6391（割戻し計算・積上げ計算）、インボイスQ&A 問130（経過措置の積上げ計算）、質疑応答事例「課税売上高が5億円超の場合の仕入税額控除の計算」（年換算）、No.6371（端数計算）、No.6359・6363（対価の返還等）、No.6367・6631（貸倒れ・貸倒回収）、No.6401・6405（按分・課税売上割合）、No.6505（簡易課税）、2割特例・3割特例とインボイス制度の見直しの案内（令和8年度改正）' }),
    ),
  );
  put(typeWrap, field('事業区分', typeSelect), field('基準期間の課税売上高（申告書第一表⑯）', baseSalesInput, { hint: '前々年（法人は前々事業年度）の課税売上高（税抜）。空欄でも計算できます' }));
  put(
    allocWrap,
    field(
      '課税売上割合が95%未満のとき',
      segmented({
        name: '按分の方法',
        options: ALLOCATIONS.map((a) => ({ value: a.id, label: a.short })),
        value: state.allocation,
        onChange: (v) => {
          state.allocation = v;
          paint();
          saveSettings().catch(() => {});
        },
      }),
      { hint: '課税売上割合が95%以上なら全額控除なので、どちらでも同じです' },
    ),
  );
  paintCalc();
  typeSelect.addEventListener('change', () => saveSettings().catch(() => {}));
  for (const el of [interimN, interimL, baseSalesInput]) el.addEventListener('change', () => saveSettings().catch(() => {}));
  paint();
}
