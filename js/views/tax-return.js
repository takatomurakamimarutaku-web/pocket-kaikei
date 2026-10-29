// 消費税の申告計算：計算の方法を選び、申告書の主な欄（課税標準額〜納付税額）と方法ごとの比較を表示する
import { h, put, field, segmented, showToast, errorBox, amountCell } from '../ui.js';
import { computeTaxReturn, TAX_METHODS, BUSINESS_TYPES, consumptionTaxLines } from '../tax-return.js';
import { validateJournal } from '../journal.js';
import { parseYen, formatYen } from '../money.js';
import { formatPeriod } from '../period.js';
import { createJournal } from '../models.js';
import { ValidationError } from '../db.js';
import { errorText } from '../errors.js';
import { closedNotice } from './period-common.js';

export async function render({ app, outlet }) {
  const { settings, period, accounts, subAccounts, journals } = await app.load();
  const entityType = settings.entityType;
  const saved = period.taxReturn || {};
  const state = {
    method: saved.method || 'general',
    businessType: saved.businessType || 5,
    interimNational: saved.interimNational || 0,
    interimLocal: saved.interimLocal || 0,
  };
  const body = h('div');
  const typeWrap = h('div');
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

  const row = (label, value, { strong = false, note = '' } = {}) =>
    h('tr', { class: strong ? 'mt-strong' : '' }, h('th', { scope: 'row' }, label, note ? h('span', { class: 'muted small block', text: note }) : null), amountCell('td', value));

  function paint() {
    typeWrap.hidden = state.method !== 'simplified';
    const bad = !Number.isFinite(state.interimNational) || !Number.isFinite(state.interimLocal);
    if (bad) {
      put(body, errorBox(['中間納付税額は0以上の整数で入力してください']));
      return;
    }
    const r = computeTaxReturn({ journals, period, entityType, ...state });
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
            row('消費税額', r.salesTax, { note: '課税標準額 × 7.8%（軽減 6.24%）' }),
            row(deductionLabel, r.deduction, {
              note:
                state.method === 'general'
                  ? `仕入10% ${formatYen(r.purchaseTax10)}・8% ${formatYen(r.purchaseTax8)}${r.transitional.map((t) => `・インボイスなし${t.pct}% ${formatYen(t.tax)}`).join('')}`
                  : '',
            }),
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
        h('p', {}, '消費税等の仕訳は登録済みです（', h('a', { class: 'link', href: `#/journal/${encodeURIComponent(done[0].id)}/edit`, text: `No.${done[0].no}` }), '）。'),
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
      showToast(`消費税等の仕訳（No.${saved.no}）を登録しました`);
      app.refresh();
    } catch (e) {
      put(errorsEl, errorBox(e instanceof ValidationError ? (Array.isArray(e.errors) ? e.errors : Object.values(e.errors)) : [errorText(e, '保存')]));
    }
  }

  async function saveSettings() {
    if (period.closed || !Number.isFinite(state.interimNational) || !Number.isFinite(state.interimLocal)) return;
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
      h('div', { class: 'field-row' }, field('中間納付（国税）', interimN), field('中間納付（地方）', interimL)),
      h('p', { class: 'muted small', text: '選んだ方法と中間納付税額はこの期間に保存します。' }),
    ),
    body,
    h(
      'div',
      { class: 'panel small muted' },
      h('p', { text: '税込経理の帳簿から、売上・仕入とも割戻し計算で求めています。売上の返品・値引きは売上から差し引いて計算しています（申告書では「返還等対価に係る税額」として別に書きます）。' }),
      h('p', { text: '対応していないもの：積上げ計算、課税売上割合が95%未満のときの按分、貸倒れ、簡易課税で複数の事業区分がある場合、令和9年4月からの飲食料品の税率の引き下げ。' }),
      h('p', { text: '出典：国税庁 タックスアンサー No.6383・6391（割戻し計算）、No.6371（端数計算）、No.6505（簡易課税）、2割特例・3割特例とインボイス制度の見直しの案内（令和8年度改正）' }),
    ),
  );
  put(typeWrap, field('事業区分', typeSelect));
  typeSelect.addEventListener('change', () => saveSettings().catch(() => {}));
  for (const el of [interimN, interimL]) el.addEventListener('change', () => saveSettings().catch(() => {}));
  paint();
}
