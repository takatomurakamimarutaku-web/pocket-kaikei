// 決算・繰越：期末棚卸・減価償却の決算整理仕訳、そのほかの決算整理の案内、次の会計期間への繰越
import { h, put, field, showToast, confirmDialog, errorBox, amountCell } from '../ui.js';
import { carryForwardBalances, nextPeriodDates, inventoryAccounts, findInventoryJournals, inventoryLines } from '../closing.js';
import { trialBalance, computeOwnerCapital } from '../ledger.js';
import { findByRole, compareAccounts } from '../accounts.js';
import { validateJournal } from '../journal.js';
import { parseYen, formatYen } from '../money.js';
import { formatPeriod, todayString } from '../period.js';
import { createJournal, createPeriod } from '../models.js';
import { ValidationError } from '../db.js';
import { errorText } from '../errors.js';
import { periodContext, closedNotice } from './period-common.js';
import { assetRegister, depreciationLines, findDepreciationJournals, smeUsage } from '../depreciation.js';

export async function render({ app, outlet }) {
  const data = await app.load();
  const { settings, period, accounts, subAccounts, journals, accountById, subById } = data;
  const entityType = settings.entityType;
  const individual = entityType === 'individual';
  const ctx = await periodContext(app, data);
  const [assets, periods] = await Promise.all([app.db.listAssets(), app.db.listPeriods()]);

  // ---- 1. 期末の棚卸 ----
  function inventorySection() {
    const inv = inventoryAccounts(accounts);
    if (!inv) return h('section', { class: 'panel' }, h('h2', { class: 'section-title', text: '1. 期末の棚卸' }), h('p', { class: 'muted small', text: '期首商品棚卸高・期末商品棚卸高・商品の科目が見つからないため、振替伝票で入力してください。' }));
    const done = findInventoryJournals(journals, accounts);
    if (done.length) {
      return h(
        'section',
        { class: 'panel' },
        h('h2', { class: 'section-title', text: '1. 期末の棚卸' }),
        h('p', { text: '棚卸の仕訳は登録済みです。' }),
        h('ul', { class: 'plain-list' }, done.map((j) => h('li', {}, h('a', { href: `#/journal/${encodeURIComponent(j.id)}/edit`, text: `No.${j.no}（${j.date.replaceAll('-', '/')}）` })))),
      );
    }
    const goods = trialBalance({ accounts, period, journals }).rows.find((r) => r.account.id === inv.goods.id).closing;
    const input = h('input', { id: 'inv-amount', type: 'text', inputmode: 'numeric', class: 'amount-input', placeholder: '0' });
    const errorsEl = h('div');
    const save = async () => {
      const p = parseYen(input.value || '0', { allowZero: true });
      if (!p.ok) return put(errorsEl, errorBox([`期末の棚卸高：${p.error}`]));
      if (goods < 0) return put(errorsEl, errorBox([`「${inv.goods.name}」の残高がマイナスです。先に仕訳を確認してください`]));
      const lines = inventoryLines({ accounts, goodsBalance: goods, closingAmount: p.value });
      if (!lines.length) return put(errorsEl, errorBox(['期首・期末とも在庫がないため、仕訳は不要です']));
      const journal = createJournal({ periodId: period.id, date: period.endDate, lines, source: 'inventory' });
      const errors = validateJournal(journal, { accounts, subAccounts, period });
      if (errors.length) return put(errorsEl, errorBox(errors));
      try {
        const saved = await app.db.saveJournal(journal);
        showToast(`棚卸の仕訳（No.${saved.no}）を登録しました`);
        app.refresh();
      } catch (e) {
        put(errorsEl, errorBox(e instanceof ValidationError ? errorList(e) : [errorText(e, '保存')]));
      }
    };
    return h(
      'section',
      { class: 'panel' },
      h('h2', { class: 'section-title', text: '1. 期末の棚卸' }),
      h('p', { class: 'small', text: `期末に残っている商品・製品の金額（棚卸高）を入力すると、決算整理の仕訳を期末日（${period.endDate.replaceAll('-', '/')}）で登録します。` }),
      h('div', { class: 'kv' }, h('span', { class: 'muted', text: `期首の在庫（${inv.goods.name}の残高）` }), h('span', { class: 'num', text: `${formatYen(goods)}円` })),
      field('期末の棚卸高（円）', input, { name: 'inventory', hint: '在庫がなければ 0 のまま登録します' }),
      errorsEl,
      h('button', { type: 'button', class: 'btn btn-primary btn-block', text: '棚卸の仕訳を登録する', onclick: save }),
    );
  }

  // ---- 2. 減価償却 ----
  function depreciationSection() {
    const title = h('h2', { class: 'section-title', text: '2. 減価償却' });
    const link = h('a', { href: '#/assets', class: 'btn btn-block', text: '固定資産台帳を開く' });
    const { lines, total, errors } = depreciationLines({ assets, periods, period, accounts, entityType });
    const done = findDepreciationJournals(journals);
    if (done.length) {
      const booked = done.reduce((s, j) => s + j.lines.filter((l) => l.side === 'credit').reduce((t, l) => t + l.amount, 0), 0);
      return h(
        'section',
        { class: 'panel' },
        title,
        h('p', { text: '減価償却の仕訳は登録済みです。' }),
        h('ul', { class: 'plain-list' }, done.map((j) => h('li', {}, h('a', { href: `#/journal/${encodeURIComponent(j.id)}/edit`, text: `No.${j.no}（${j.date.replaceAll('-', '/')}）` })))),
        booked !== total ? h('p', { class: 'notice', text: `固定資産台帳の償却費（${formatYen(total)}円）と仕訳の金額（${formatYen(booked)}円）が違います。台帳を直した場合は、仕訳を削除してから登録し直してください。` }) : null,
        link,
      );
    }
    if (!assets.length) {
      return h('section', { class: 'panel' }, title, h('p', { class: 'small', text: '固定資産台帳に登録すると、減価償却費を計算して決算整理の仕訳を登録できます。' }), link);
    }
    const rows = assetRegister(assets, periods, period).filter((x) => x.row?.amount);
    const errorsEl = h('div');
    const sme = smeUsage(assets, period);
    const save = async () => {
      if (errors.length) return put(errorsEl, errorBox(errors));
      const journal = createJournal({ periodId: period.id, date: period.endDate, lines, source: 'depreciation' });
      const v = validateJournal(journal, { accounts, subAccounts, period });
      if (v.length) return put(errorsEl, errorBox(v));
      try {
        const saved = await app.db.saveJournal(journal);
        showToast(`減価償却の仕訳（No.${saved.no}）を登録しました`);
        app.refresh();
      } catch (e) {
        put(errorsEl, errorBox(e instanceof ValidationError ? errorList(e) : [errorText(e, '保存')]));
      }
    };
    return h(
      'section',
      { class: 'panel' },
      title,
      rows.length
        ? [
            h('p', { class: 'small', text: `固定資産台帳から計算した償却費を、期末日（${period.endDate.replaceAll('-', '/')}）の仕訳で登録します。` }),
            h(
              'div',
              { class: 'table-wrap' },
              h(
                'table',
                { class: 'report' },
                h('thead', {}, h('tr', {}, h('th', { scope: 'col', text: '資産' }), h('th', { scope: 'col', text: '償却費' }), individual ? h('th', { scope: 'col', text: '経費' }) : null)),
                h(
                  'tbody',
                  {},
                  rows.map(({ asset, row }) => h('tr', {}, h('th', { scope: 'row', text: asset.name }), amountCell('td', row.amount), individual ? amountCell('td', row.business) : null)),
                  h('tr', { class: 'mt-strong' }, h('th', { scope: 'row', text: '合計' }), amountCell('td', total), individual ? amountCell('td', rows.reduce((s, x) => s + x.row.business, 0)) : null),
                ),
              ),
            ),
            sme.over ? h('p', { class: 'notice', text: `少額減価償却資産の特例の合計が上限（${formatYen(sme.limit)}円）を超えています。台帳で確認してください。` }) : null,
            errorsEl,
            h('button', { type: 'button', class: 'btn btn-primary btn-block', text: '減価償却の仕訳を登録する', onclick: save }),
          ]
        : h('p', { class: 'small', text: 'この期間に償却する固定資産はありません。' }),
      link,
    );
  }

  // ---- 3. そのほかの決算整理 ----
  const others = individual
    ? ['家事関連費の按分（私用分を事業主貸へ）', '未払・前払の費用、売上の計上漏れ', '貸倒引当金の繰入・繰戻（使う場合）', '消費税等（課税事業者は「帳票 › 消費税の申告計算」から登録できます）']
    : ['未払費用・前払費用、売上・仕入の計上漏れ', '法人税、住民税及び事業税／未払法人税等', '未払消費税等（課税事業者は「帳票 › 消費税の申告計算」から登録できます）'];
  const othersSection = h(
    'section',
    { class: 'panel' },
    h('h2', { class: 'section-title', text: '3. そのほかの決算整理' }),
    h('p', { class: 'small', text: '必要なものを振替伝票で、期末日の日付で入力してください。' }),
    h('ul', { class: 'plain-list small' }, others.map((t) => h('li', { text: t }))),
    h('a', { href: '#/journal/new', class: 'btn btn-block', text: '振替伝票で入力する' }),
  );

  // ---- 4. 次の期間へ繰越 ----
  function carrySection() {
    const title = h('h2', { class: 'section-title', text: '4. 次の期間へ繰り越す' });
    if (ctx.next) {
      return h(
        'section',
        { class: 'panel' },
        title,
        h('p', { text: `繰越済みです（次の期間：${formatPeriod(ctx.next)}）。` }),
        h('p', { class: 'muted small', text: 'この期間の仕訳を直した場合は、次の期間の「会計期間」画面で期首残高を更新できます。' }),
        h('button', {
          type: 'button',
          class: 'btn btn-block',
          text: '次の期間を表示する',
          onclick: async () => {
            await app.db.setCurrentPeriod(ctx.next.id);
            app.navigate('#/home');
          },
        }),
      );
    }
    const dates = nextPeriodDates(period, entityType);
    const { balances, netIncome } = carryForwardBalances({ entityType, accounts, subAccounts, period, journals });
    const capital = individual ? findByRole(accounts, 'owner_capital') : null;
    const rows = [...balances]
      .sort((a, b) => compareAccounts(accountById.get(a.accountId), accountById.get(b.accountId)))
      .map((b) => ({ label: `${accountById.get(b.accountId).name}${b.subAccountId ? `（${subById.get(b.subAccountId)?.name ?? ''}）` : ''}`, amount: b.amount }));
    if (capital) rows.push({ label: `${capital.name}（自動計算）`, amount: computeOwnerCapital(balances, accounts), strong: true });
    const errorsEl = h('div');
    const carry = async () => {
      const ok = await confirmDialog({
        title: `${formatPeriod(dates)} を始めますか？`,
        message: '期末の残高を期首残高にして、次の期間に切り替えます。念のため、先にバックアップを取っておくと安心です。',
        buttons: [
          { label: 'キャンセル', value: false },
          { label: '繰り越す', value: true, variant: 'primary' },
        ],
      });
      if (!ok) return;
      try {
        await app.db.createNextPeriod(createPeriod(dates), balances);
        showToast(`${formatPeriod(dates)} を始めました`, { duration: 5000 });
        app.navigate('#/home');
      } catch (e) {
        put(errorsEl, errorBox(e instanceof ValidationError ? errorList(e) : [errorText(e, '繰越')]));
      }
    };
    return h(
      'section',
      { class: 'panel' },
      title,
      h('p', { class: 'small', text: `次の期間：${formatPeriod(dates)}` }),
      todayString() <= period.endDate ? h('p', { class: 'notice', text: 'まだ期末日の前です。繰越の後でもこの期間の仕訳は直せます（その場合は次の期間の期首残高を更新します）。' }) : null,
      h(
        'p',
        { class: 'muted small', text: individual
          ? `事業主貸・事業主借は0にし、元入金は「期首の資産合計−負債合計」で計算します（前期の元入金＋所得 ${formatYen(netIncome)}円＋事業主借−事業主貸 と同じ額）。`
          : `繰越利益剰余金に当期純利益 ${formatYen(netIncome)}円 を加えて繰り越します。` },
      ),
      h(
        'div',
        { class: 'table-wrap' },
        h(
          'table',
          { class: 'report' },
          h('thead', {}, h('tr', {}, h('th', { scope: 'col', text: '次の期間の期首残高' }), h('th', { scope: 'col', text: '金額' }))),
          h('tbody', {}, rows.length ? rows.map((r) => h('tr', { class: r.strong ? 'mt-strong' : '' }, h('th', { scope: 'row', text: r.label }), amountCell('td', r.amount))) : h('tr', {}, h('td', { colspan: 2, class: 'muted', text: '繰り越す残高はありません' }))),
        ),
      ),
      errorsEl,
      h('button', { type: 'button', class: 'btn btn-primary btn-block', text: '繰り越して次の期間を始める', onclick: carry }),
    );
  }

  put(
    outlet,
    h('p', { class: 'muted small', text: `会計期間 ${formatPeriod(period)}` }),
    closedNotice(period),
    period.closed ? null : inventorySection(),
    period.closed ? null : depreciationSection(),
    period.closed ? null : othersSection,
    carrySection(),
    h('p', { class: 'center small' }, h('a', { href: '#/backup', class: 'link', text: 'バックアップを取る' })),
  );
}

const errorList = (e) => (Array.isArray(e.errors) ? e.errors : Object.values(e.errors));
