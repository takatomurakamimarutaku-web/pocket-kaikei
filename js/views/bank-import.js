// 銀行明細CSVの取り込み：ファイルを選ぶ → 列の割り当てを確かめる → 明細ごとに相手科目を選んでまとめて登録
// CSV は端末の中で読み込むだけで、外部へ送信しない
import { h, put, field, showToast, errorBox } from '../ui.js';
import {
  decodeBytes,
  parseCsv,
  detectColumns,
  extractTransactions,
  balanceMismatches,
  buildCounterIndex,
  suggestCounter,
  markDuplicates,
  importLines,
  headerSignature,
  COLUMN_KINDS,
} from '../bank-import.js';
import { compareAccounts } from '../accounts.js';
import { isCashAccount } from '../quick.js';
import { validateJournal } from '../journal.js';
import { TAX_CATEGORIES } from '../tax.js';
import { formatYen } from '../money.js';
import { isInPeriod } from '../period.js';
import { createJournal } from '../models.js';
import { normalize } from '../search.js';
import { ValidationError } from '../db.js';
import { errorText } from '../errors.js';
import { pickAccount } from './account-picker.js';
import { closedNotice } from './period-common.js';

const slash = (d) => d.replaceAll('-', '/');

export async function render({ app, outlet, query }) {
  const data = await app.load();
  const { settings, period, accounts, subAccounts, journals, accountById } = data;
  if (period.closed) {
    put(outlet, closedNotice(period));
    return;
  }
  const saved = (await app.db.getMeta('bankImport')) || { mappings: {} };
  const options = [];
  for (const a of accounts.filter((x) => isCashAccount(x) && x.active).sort(compareAccounts)) {
    options.push({ key: a.id, accountId: a.id, subAccountId: '', label: a.name });
    for (const s of subAccounts.filter((x) => x.accountId === a.id && x.active).sort((x, y) => (x.sortOrder ?? 0) - (y.sortOrder ?? 0))) {
      options.push({ key: `${a.id}|${s.id}`, accountId: a.id, subAccountId: s.id, label: `${a.name}／${s.name}` });
    }
  }
  const pickKey = (acc, sub) => options.find((o) => o.accountId === acc && o.subAccountId === (sub || ''));
  let bank = pickKey(query.account, query.sub) || pickKey(saved.accountId, saved.subAccountId) || options.find((o) => accountById.get(o.accountId).role === 'deposit') || options[0];

  const recentIds = [];
  for (const j of [...journals].sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1))) {
    for (const l of j.lines) if (!recentIds.includes(l.accountId) && !isCashAccount(accountById.get(l.accountId))) recentIds.push(l.accountId);
    if (recentIds.length >= 12) break;
  }
  const index = buildCounterIndex(journals, (id) => isCashAccount(accountById.get(id)));

  let file = null; // { name, encoding, rows, signature }
  let mapping = null;
  let items = []; // { tx, include, counter: {accountId, subAccountId, taxCategory}|null, duplicate, outside, suggested }

  const accSelect = h(
    'select',
    { id: 'bi-account', onchange: (e) => ((bank = options.find((o) => o.key === e.target.value)), file && rebuild()) },
    options.map((o) => h('option', { value: o.key, text: o.label, selected: o === bank })),
  );
  const fileInput = h('input', { id: 'bi-file', type: 'file', accept: '.csv,.txt,text/csv,text/plain', class: 'visually-hidden', onchange: (e) => load(e.target.files[0]) });
  const fileLabel = h('span', { class: 'muted small', text: 'まだ選んでいません' });
  const mappingEl = h('div');
  const listEl = h('div');
  const footerEl = h('div');

  async function load(f) {
    if (!f) return;
    if (f.size > 5 * 1024 * 1024) return put(listEl, errorBox(['ファイルが大きすぎます（5MBまで）']));
    const { text, encoding } = decodeBytes(new Uint8Array(await f.arrayBuffer()));
    const rows = parseCsv(text);
    if (!rows.length) return put(listEl, errorBox(['CSVの中身が読み取れませんでした']));
    const detected = detectColumns(rows);
    const signature = headerSignature(rows, detected.headerRow);
    file = { name: f.name, encoding, rows, signature };
    mapping = saved.mappings?.[signature] ? structuredClone(saved.mappings[signature]) : detected;
    fileLabel.textContent = `${f.name}（${encoding === 'shift_jis' ? 'Shift_JIS' : 'UTF-8'}・${rows.length}行）`;
    rebuild();
  }

  /** 列の割り当てや口座が変わったら明細を作り直す（選んだ相手科目は同じ行なら残す） */
  function rebuild() {
    const before = new Map(items.map((it) => [it.tx.row, it]));
    const txs = extractTransactions(file.rows, mapping);
    const dup = markDuplicates(txs, journals, bank);
    items = txs.map((tx, i) => {
      const prev = before.get(tx.row);
      const outside = !isInPeriod(tx.date, period);
      const suggested = prev ? prev.suggested : suggestCounter(tx.memo, index);
      const counter = prev?.counter ?? (suggested ? { ...suggested } : null);
      return { tx, duplicate: dup[i], outside, suggested: Boolean(suggested), counter, include: prev ? prev.include : !dup[i] && !outside && !tx.error };
    });
    paintMapping();
    paintList();
  }

  function paintMapping() {
    const header = mapping.headerRow >= 0 ? file.rows[mapping.headerRow] : null;
    const width = Math.max(...file.rows.slice(0, 20).map((r) => r.length));
    const colOptions = [{ value: -1, label: '（使わない）' }, ...Array.from({ length: width }, (_, k) => ({ value: k, label: header?.[k] ? `${k + 1}列目：${header[k]}` : `${k + 1}列目` }))];
    const headerSelect = h(
      'select',
      { id: 'bi-header', onchange: (e) => ((mapping.headerRow = Number(e.target.value)), rebuild()) },
      [{ value: -1, label: '見出しなし' }, ...file.rows.slice(0, 15).map((r, i) => ({ value: i, label: `${i + 1}行目：${r.slice(0, 4).join(' / ').slice(0, 40)}` }))].map((o) => h('option', { value: o.value, text: o.label, selected: o.value === mapping.headerRow })),
    );
    const selects = COLUMN_KINDS.map((k) =>
      field(
        k.label,
        h(
          'select',
          { id: `bi-col-${k.id}`, onchange: (e) => ((mapping.columns[k.id] = Number(e.target.value)), rebuild()) },
          colOptions.map((o) => h('option', { value: o.value, text: o.label, selected: o.value === (mapping.columns[k.id] ?? -1) })),
        ),
      ),
    );
    const mismatches = balanceMismatches(items.map((i) => i.tx));
    const problems = [];
    if (mapping.columns.date < 0) problems.push('日付の列を選んでください');
    if (mapping.columns.amount < 0 && mapping.columns.deposit < 0 && mapping.columns.withdrawal < 0) problems.push('金額（または入金額・出金額）の列を選んでください');
    if (mismatches.length) problems.push(`残高が前の行の残高＋金額と合わない行があります（${mismatches.slice(0, 5).join('・')}行目${mismatches.length > 5 ? 'ほか' : ''}）。入金・出金の列の割り当てを確かめてください`);
    put(
      mappingEl,
      h(
        'details',
        { class: 'panel', open: problems.length > 0 || !items.length },
        h('summary', { class: 'section-title', text: '2. 列の割り当て' }),
        h('p', { class: 'muted small', text: '見出しの言葉から自動で選んでいます。違っていたら直してください（同じ形式のCSVは次回も同じ割り当てにします）。' }),
        field('見出しの行', headerSelect),
        ...selects,
      ),
      problems.length ? errorBox(problems) : null,
    );
  }

  function setCounter(item, accountId) {
    const acc = accountById.get(accountId);
    item.counter = { accountId, subAccountId: null, taxCategory: acc.defaultTaxCategory };
    item.include = !item.tx.error && !item.outside;
    // 同じ摘要で相手科目が未定の明細にも同じ科目を入れる
    const key = normalize(item.tx.memo);
    let more = 0;
    for (const other of items) {
      if (other !== item && !other.counter && key && normalize(other.tx.memo) === key) {
        other.counter = { ...item.counter };
        if (!other.duplicate && !other.outside && !other.tx.error) other.include = true;
        more++;
      }
    }
    if (more) showToast(`同じ摘要の${more}件にも「${acc.name}」を入れました`);
    paintList();
  }

  function card(item) {
    const { tx } = item;
    const acc = item.counter ? accountById.get(item.counter.accountId) : null;
    const subs = acc ? subAccounts.filter((s) => s.accountId === acc.id && s.active) : [];
    const disabled = Boolean(tx.error) || item.outside;
    return h(
      'li',
      { class: `bi-row ${item.include ? '' : 'is-off'}` },
      h('label', { class: 'bi-check' }, h('input', { type: 'checkbox', checked: item.include, disabled, 'aria-label': `${slash(tx.date)} ${tx.memo} を登録する`, onchange: (e) => ((item.include = e.target.checked), paintFooter(), e.target.closest('.bi-row').classList.toggle('is-off', !item.include)) })),
      h(
        'div',
        { class: 'bi-main' },
        h(
          'div',
          { class: 'bi-head' },
          h('span', { class: 'muted small nowrap', text: slash(tx.date).slice(5) }),
          h('span', { class: 'bi-memo', text: tx.memo || '（摘要なし）' }),
          h('span', { class: `num nowrap ${tx.amount < 0 ? 'bi-out' : 'bi-in'}`, text: `${tx.amount < 0 ? '出金' : '入金'} ${formatYen(Math.abs(tx.amount))}` }),
        ),
        h(
          'div',
          { class: 'bi-tags' },
          tx.error ? h('span', { class: 'badge badge-warn', text: tx.error }) : null,
          item.outside ? h('span', { class: 'badge badge-warn', text: '会計期間外' }) : null,
          item.duplicate ? h('span', { class: 'badge badge-warn', text: '登録済みかも' }) : null,
          item.suggested && item.counter ? h('span', { class: 'badge', text: '過去の仕訳から' }) : null,
        ),
        disabled
          ? null
          : h(
              'div',
              { class: 'bi-counter' },
              h('button', {
                type: 'button',
                class: `btn btn-small acc-btn ${acc ? '' : 'is-empty'}`,
                text: acc ? `${tx.amount < 0 ? '借方' : '貸方'}：${acc.name}` : '相手科目を選ぶ',
                onclick: async () => {
                  const id = await pickAccount({ accounts: accounts.filter((a) => !(a.id === bank.accountId && !bank.subAccountId)), entityType: settings.entityType, recentIds, currentId: item.counter?.accountId || '', title: tx.amount < 0 ? '何に払ったか（相手科目）' : '何の入金か（相手科目）' });
                  if (id) setCounter(item, id);
                },
              }),
              subs.length
                ? h(
                    'select',
                    { class: 'tax-select', 'aria-label': '補助科目', onchange: (e) => (item.counter.subAccountId = e.target.value || null) },
                    h('option', { value: '', text: '補助なし' }),
                    subs.map((s) => h('option', { value: s.id, text: s.name, selected: s.id === item.counter.subAccountId })),
                  )
                : null,
              acc
                ? h(
                    'select',
                    { class: 'tax-select', 'aria-label': '税区分', onchange: (e) => (item.counter.taxCategory = e.target.value) },
                    TAX_CATEGORIES.map((t) => h('option', { value: t.code, text: t.label, selected: t.code === item.counter.taxCategory })),
                  )
                : null,
            ),
      ),
    );
  }

  function paintList() {
    if (!items.length) {
      put(listEl, h('p', { class: 'muted small', text: '取り込める明細がありません。列の割り当てを確かめてください。' }));
      put(footerEl);
      return;
    }
    const needs = items.filter((i) => !i.counter && !i.tx.error && !i.outside).length;
    put(
      listEl,
      h('h2', { class: 'section-title', text: `3. 明細（${items.length}件）` }),
      h('p', { class: 'muted small', text: needs ? `相手科目が未定の明細が${needs}件あります。科目を選ぶと、同じ摘要の明細にも入ります。` : '内容を確かめて登録してください。摘要は銀行の表記のまま仕訳の摘要になります。' }),
      h('ul', { class: 'menu-group bi-list' }, items.map(card)),
    );
    paintFooter();
  }

  function selected() {
    return items.filter((i) => i.include && i.counter && !i.tx.error && !i.outside);
  }

  function paintFooter() {
    const list = selected();
    const unset = items.filter((i) => i.include && !i.counter).length;
    const dep = list.filter((i) => i.tx.amount > 0).reduce((s, i) => s + i.tx.amount, 0);
    const wd = list.filter((i) => i.tx.amount < 0).reduce((s, i) => s - i.tx.amount, 0);
    const last = [...items].reverse().find((i) => i.tx.balance !== null && !i.outside);
    const errorsEl = h('div');
    put(
      footerEl,
      h(
        'section',
        { class: 'panel' },
        h('div', { class: 'kv' }, h('span', { class: 'muted', text: '入金の合計' }), h('span', { class: 'num', text: `${formatYen(dep)}円` })),
        h('div', { class: 'kv' }, h('span', { class: 'muted', text: '出金の合計' }), h('span', { class: 'num', text: `${formatYen(wd)}円` })),
        last ? h('p', { class: 'muted small', text: `CSVの最後の残高：${slash(last.tx.date)} 時点 ${formatYen(last.tx.balance)}円（登録後に出納帳の残高と見比べてください）` }) : null,
        unset ? h('p', { class: 'notice', text: `相手科目が未定の${unset}件は登録しません。` }) : null,
        errorsEl,
        h('button', { type: 'button', class: 'btn btn-primary btn-block', disabled: !list.length, text: list.length ? `${list.length}件を仕訳として登録する` : '登録する明細がありません', onclick: () => save(errorsEl) }),
      ),
    );
  }

  async function save(errorsEl) {
    const list = selected();
    const journalsToSave = list.map((i) => createJournal({ periodId: period.id, date: i.tx.date, lines: importLines(i.tx, bank, i.counter), source: 'bank_import' }));
    const errors = journalsToSave.flatMap((j, n) => validateJournal(j, { accounts, subAccounts, period }).map((e) => `${slash(j.date)} ${list[n].tx.memo}：${e}`));
    if (errors.length) return put(errorsEl, errorBox(errors.slice(0, 10)));
    try {
      const done = await app.db.saveJournals(journalsToSave);
      await app.db.setMeta('bankImport', { accountId: bank.accountId, subAccountId: bank.subAccountId, mappings: { ...saved.mappings, [file.signature]: mapping } });
      showToast(`${done.length}件の仕訳を登録しました（No.${done[0].no}〜${done[done.length - 1].no}）`, { duration: 5000 });
      const p = new URLSearchParams({ account: bank.accountId, month: 'all', ...(bank.subAccountId ? { sub: bank.subAccountId } : {}) });
      app.navigate(`#/cashbook?${p}`);
    } catch (e) {
      put(errorsEl, errorBox(e instanceof ValidationError ? (Array.isArray(e.errors) ? e.errors : Object.values(e.errors)) : [errorText(e, '登録')]));
    }
  }

  put(
    outlet,
    h('p', { class: 'muted small', text: 'ネットバンキングからダウンロードした入出金明細のCSVを読み込み、仕訳にします。ファイルはこの端末の中で読むだけで、外部へは送信しません。' }),
    h(
      'section',
      { class: 'panel' },
      h('h2', { class: 'section-title', text: '1. 口座とファイル' }),
      options.length ? field('取り込む口座', accSelect, { hint: '現金・預金の科目（補助科目ごとにも選べます）' }) : h('p', { class: 'notice', text: '現金・預金の科目がありません' }),
      h('div', { class: 'field' }, h('label', { class: 'btn btn-block', for: 'bi-file', text: 'CSVファイルを選ぶ' }), fileInput, fileLabel),
    ),
    mappingEl,
    listEl,
    footerEl,
  );
}
