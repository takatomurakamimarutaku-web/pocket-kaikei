// 会計ソフトとの受け渡し：ほかの会計ソフトの仕訳 CSV の取り込みと、弥生会計のインポート形式での書き出し
// ファイルは端末の中で読み書きするだけで、外部へ送信しない
import { h, put, field, showToast, errorBox, taxSelect, saveFile } from '../ui.js';
import { decodeBytes, parseCsv } from '../bank-import.js';
import { detectFormat, parseEntries, namesIn, suggestAccounts, suggestTax, buildImport, journalSignature, IMPORT_FORMATS } from '../journal-import.js';
import { yayoiCsv } from '../yayoi.js';
import { encodeShiftJis } from '../sjis.js';
import { compareAccounts, groupLabel, GROUPS } from '../accounts.js';
import { validateJournal } from '../journal.js';
import { formatYen } from '../money.js';
import { formatPeriod, isInPeriod } from '../period.js';
import { createJournal } from '../models.js';
import { TAX_BY_CODE } from '../tax.js';
import { ValidationError } from '../db.js';
import { errorText } from '../errors.js';
import { BOM } from '../csv.js';

const slash = (d) => (d ? d.replaceAll('-', '/') : '');
const META_KEY = 'journalImport';
const LIST_MAX = 200;

export async function render({ app, outlet }) {
  const data = await app.load();
  const { settings, period, accounts, subAccounts, journals, accountById, subById, departmentById } = data;
  const saved = (await app.db.getMeta(META_KEY)) || { accounts: {}, taxes: {} };
  const usable = accounts.filter((a) => a.active !== false).sort(compareAccounts);

  // ---- 取り込み ----
  let file = null; // { name, encoding, detected, entries }
  let accountMap = new Map();
  let taxMap = new Map();
  let taxNotes = new Map();
  let items = [];
  let newSubs = [];
  const fileInput = h('input', { id: 'ti-file', type: 'file', accept: '.csv,.txt,text/csv,text/plain', class: 'visually-hidden', onchange: (e) => load(e.target.files[0]) });
  const fileLabel = h('span', { class: 'muted small', text: 'まだ選んでいません' });
  const mapEl = h('div');
  const listEl = h('div');
  const footerEl = h('div');

  async function load(f) {
    fileInput.value = '';
    if (!f) return;
    if (f.size > 10 * 1024 * 1024) return put(listEl, errorBox(['ファイルが大きすぎます（10MBまで）']));
    const { text, encoding } = decodeBytes(new Uint8Array(await f.arrayBuffer()));
    const rows = parseCsv(text);
    const detected = detectFormat(rows);
    if (!detected.format) {
      file = null;
      put(mapEl);
      put(footerEl);
      return put(listEl, errorBox([detected.error]));
    }
    const entries = parseEntries(rows, detected);
    file = { name: f.name, encoding, detected, entries };
    const names = namesIn(entries);
    accountMap = suggestAccounts(names.accounts, accounts, saved.accounts);
    taxMap = new Map();
    taxNotes = new Map();
    for (const label of names.taxes) {
      const s = suggestTax(label);
      taxMap.set(label, saved.taxes?.[label] && TAX_BY_CODE[saved.taxes[label]] ? saved.taxes[label] : s.code);
      if (s.note && !saved.taxes?.[label]) taxNotes.set(label, s.note);
    }
    fileLabel.textContent = `${f.name}（${IMPORT_FORMATS[detected.format]}・${encoding === 'shift_jis' ? 'Shift_JIS' : 'UTF-8'}・${rows.length}行）`;
    rebuild();
  }

  function rebuild() {
    const built = buildImport(file.entries, { accountMap, taxMap, subAccounts, accountById });
    newSubs = built.newSubs;
    // 新しく作る補助科目も検証できるよう、仮の補助科目として加える
    const subsForCheck = [...subAccounts, ...newSubs.map((s) => ({ id: s.key, accountId: s.accountId, name: s.name, active: true }))];
    const existing = new Set(journals.map(journalSignature));
    const before = new Map(items.map((it) => [it.entry.key, it]));
    items = built.items.map((it) => {
      const outside = Boolean(it.date) && !isInPeriod(it.date, period);
      const journal = createJournal({ periodId: period.id, date: it.date || '', lines: it.lines, adjusting: it.adjusting, source: 'journal_import' });
      const errors = it.errors.length || outside ? it.errors : validateJournal(journal, { accounts, subAccounts: subsForCheck, period });
      const duplicate = !errors.length && existing.has(journalSignature(journal));
      const prev = before.get(it.entry.key);
      const ok = !errors.length && !outside;
      return { ...it, journal, errors, outside, duplicate, include: ok && (prev && !prev.errors.length && !prev.outside ? prev.include : !duplicate) };
    });
    paintMaps();
    paintList();
  }

  const accountSelect = (name) =>
    h(
      'select',
      {
        'aria-label': `「${name}」に対応する科目`,
        class: accountMap.get(name) ? '' : 'is-missing',
        onchange: (e) => {
          accountMap.set(name, e.target.value || null);
          rebuild();
        },
      },
      h('option', { value: '', text: '（選んでください）' }),
      GROUPS.map((g) => {
        const list = usable.filter((a) => a.group === g.id);
        return list.length ? h('optgroup', { label: groupLabel(g.id, settings.entityType) }, list.map((a) => h('option', { value: a.id, text: `${a.code} ${a.name}`, selected: accountMap.get(name) === a.id }))) : null;
      }),
    );

  function paintMaps() {
    const names = [...accountMap.keys()];
    const missing = names.filter((n) => !accountMap.get(n));
    const matched = names.filter((n) => accountMap.get(n));
    const row = (n) => h('li', { class: 'ti-map-row' }, h('span', { class: 'ti-map-name', text: n }), accountSelect(n));
    const taxRow = ([label, code]) =>
      h(
        'li',
        { class: 'ti-map-row' },
        h('span', { class: 'ti-map-name', text: label }),
        taxSelect(code, {
          split: true,
          'aria-label': `「${label}」に対応する税区分`,
          onchange: (e) => {
            taxMap.set(label, e.target.value);
            taxNotes.delete(label);
            rebuild();
          },
        }),
        taxNotes.get(label) ? h('p', { class: 'ti-note small', text: taxNotes.get(label) }) : null,
      );
    put(
      mapEl,
      h(
        'section',
        { class: 'panel' },
        h('h2', { class: 'section-title', text: '2. 科目の対応' }),
        missing.length
          ? [h('p', { class: 'notice', text: `この帳簿の科目と名前が合わない科目が${missing.length}件あります。対応する科目を選んでください（次回も同じ対応にします）。` }), h('ul', { class: 'ti-map' }, missing.map(row))]
          : h('p', { class: 'muted small', text: 'すべての科目をこの帳簿の科目に対応させました。' }),
        matched.length ? h('details', {}, h('summary', { class: 'small', text: `名前で対応させた科目（${matched.length}件）` }), h('ul', { class: 'ti-map' }, matched.map(row))) : null,
      ),
      taxMap.size
        ? h(
            'section',
            { class: 'panel' },
            h('h2', { class: 'section-title', text: '3. 税区分の対応' }),
            h('p', { class: 'muted small', text: '税区分の名前から判定しました。違っていたら直してください。空欄の税区分は、科目の既定の税区分にします。' }),
            h('details', { open: taxNotes.size > 0 }, h('summary', { class: 'small', text: `税区分（${taxMap.size}種類${taxNotes.size ? `・確かめてほしいもの${taxNotes.size}件` : ''}）` }), h('ul', { class: 'ti-map' }, [...taxMap].map(taxRow))),
          )
        : null,
      newSubs.length
        ? h(
            'section',
            { class: 'panel' },
            h('h2', { class: 'section-title', text: '新しく作る補助科目' }),
            h('p', { class: 'muted small', text: `この帳簿にない補助科目が${newSubs.length}件あります。登録するときに作ります。` }),
            h('ul', { class: 'plain-list small' }, newSubs.slice(0, 30).map((s) => h('li', { text: `${accountById.get(s.accountId)?.name ?? ''}／${s.name}` }))),
            newSubs.length > 30 ? h('p', { class: 'muted small', text: `ほか${newSubs.length - 30}件` }) : null,
          )
        : null,
    );
  }

  function itemRow(it) {
    // ファイルの明細で表示する（対応の決まっていない科目はファイルの科目名のまま）
    const src = it.entry.lines;
    const total = src.filter((l) => l.side === 'debit').reduce((s, l) => s + l.amount, 0);
    const names = (side) => [...new Set(src.filter((l) => l.side === side).map((l) => accountById.get(accountMap.get(l.account))?.name ?? l.account))].join('・') || '—';
    const memo = src.find((l) => l.memo)?.memo || '';
    const disabled = Boolean(it.errors.length) || it.outside;
    return h(
      'li',
      { class: `bi-row ${it.include ? '' : 'is-off'}` },
      h(
        'label',
        { class: 'bi-check' },
        h('input', {
          type: 'checkbox',
          checked: it.include,
          disabled,
          'aria-label': `${slash(it.date)} の仕訳を登録する`,
          onchange: (e) => {
            it.include = e.target.checked;
            e.target.closest('.bi-row').classList.toggle('is-off', !it.include);
            paintFooter();
          },
        }),
      ),
      h(
        'div',
        { class: 'bi-main' },
        h('div', { class: 'bi-head' }, h('span', { class: 'muted small nowrap', text: slash(it.date) || '日付なし' }), h('span', { class: 'bi-memo', text: `${names('debit')} ／ ${names('credit')}` }), h('span', { class: 'num nowrap', text: formatYen(total) })),
        memo ? h('span', { class: 'muted small bi-memo', text: memo }) : null,
        h(
          'div',
          { class: 'bi-tags' },
          h('span', { class: 'badge', text: `${it.entry.rows[0]}行目${it.entry.rows.length > 1 ? `〜${it.entry.rows.at(-1)}行目` : ''}` }),
          it.errors.length ? h('span', { class: 'badge badge-warn', text: it.errors[0] }) : null,
          it.outside ? h('span', { class: 'badge badge-warn', text: '会計期間外' }) : null,
          it.duplicate ? h('span', { class: 'badge badge-warn', text: '登録済みかも' }) : null,
        ),
      ),
    );
  }

  function paintList() {
    if (!items.length) {
      put(listEl, h('p', { class: 'muted small', text: '取り込める仕訳がありません。' }));
      put(footerEl);
      return;
    }
    const problems = items.filter((it) => it.errors.length || it.outside || it.duplicate);
    const ok = items.filter((it) => !problems.includes(it));
    put(
      listEl,
      h('h2', { class: 'section-title', text: `4. 仕訳（${items.length}件）` }),
      problems.length
        ? [h('p', { class: 'muted small', text: `確かめてほしい仕訳が${problems.length}件あります。誤りのある仕訳と会計期間外の仕訳は登録しません。登録済みかもしれない仕訳は、確かめてから選んでください。` }), h('ul', { class: 'menu-group bi-list' }, problems.map(itemRow))]
        : null,
      ok.length
        ? h(
            'details',
            { class: 'ti-ok', open: !problems.length && ok.length <= 20 },
            h('summary', { class: 'small', text: `登録できる仕訳（${ok.length}件）` }),
            h('ul', { class: 'menu-group bi-list' }, ok.slice(0, LIST_MAX).map(itemRow)),
            ok.length > LIST_MAX ? h('p', { class: 'muted small', text: `ほか${ok.length - LIST_MAX}件（表示を省いています。登録の対象には含みます）` }) : null,
          )
        : null,
    );
    paintFooter();
  }

  const selected = () => items.filter((it) => it.include && !it.errors.length && !it.outside);

  function paintFooter() {
    const list = selected();
    const errorsEl = h('div');
    const total = list.reduce((s, it) => s + it.lines.filter((l) => l.side === 'debit').reduce((a, l) => a + l.amount, 0), 0);
    put(
      footerEl,
      h(
        'section',
        { class: 'panel' },
        h('div', { class: 'kv' }, h('span', { class: 'muted', text: '登録する仕訳' }), h('span', { class: 'num', text: `${list.length}件・借方合計 ${formatYen(total)}円` })),
        newSubs.length ? h('p', { class: 'muted small', text: `補助科目を${newSubs.length}件作ります。` }) : null,
        errorsEl,
        h('button', { type: 'button', class: 'btn btn-primary btn-block', disabled: !list.length, text: list.length ? `${list.length}件を仕訳として登録する` : '登録する仕訳がありません', onclick: () => save(errorsEl) }),
      ),
    );
  }

  async function save(errorsEl) {
    const list = selected();
    // 選んだ仕訳で使う補助科目だけ作る
    const used = new Set(list.flatMap((it) => it.lines.map((l) => l.subAccountId)));
    try {
      const done = await app.db.importJournals(
        newSubs.filter((s) => used.has(s.key)),
        list.map((it) => it.journal),
      );
      await app.db.setMeta(META_KEY, {
        accounts: { ...saved.accounts, ...Object.fromEntries([...accountMap].filter(([, id]) => id)) },
        taxes: { ...saved.taxes, ...Object.fromEntries(taxMap) },
      });
      showToast(`${done.journals.length}件の仕訳を登録しました（No.${done.journals[0].no}〜${done.journals.at(-1).no}${done.subs ? `、補助科目${done.subs}件` : ''}）`, { duration: 6000 });
      app.navigate('#/journals?month=all');
    } catch (e) {
      put(errorsEl, errorBox(e instanceof ValidationError ? (Array.isArray(e.errors) ? e.errors : Object.values(e.errors)).slice(0, 10) : [errorText(e, '登録')]));
    }
  }

  // ---- 書き出し ----
  const encodingSelect = h(
    'select',
    { id: 'te-encoding' },
    h('option', { value: 'sjis', text: 'Shift_JIS（弥生会計に読み込むとき）' }),
    h('option', { value: 'utf8', text: 'UTF-8（Excel・ほかのソフトで開くとき）' }),
  );
  const exportNote = h('div');
  async function exportYayoi() {
    if (!journals.length) return showToast('書き出す仕訳がありません');
    const text = yayoiCsv(journals, { accountById, subById, period, departmentById });
    let blob;
    if (encodingSelect.value === 'sjis') {
      const { bytes, unmappable } = encodeShiftJis(text);
      blob = new Blob([bytes], { type: 'text/csv' });
      put(exportNote, unmappable.length ? h('p', { class: 'notice', text: `Shift_JIS にない文字（${unmappable.slice(0, 10).join(' ')}${unmappable.length > 10 ? ' ほか' : ''}）は「?」にしました。科目名や摘要を直すか、UTF-8 で書き出してください。` }) : null);
    } else {
      blob = new Blob([BOM + text], { type: 'text/csv' });
      put(exportNote);
    }
    const p = (n) => String(n).padStart(2, '0');
    const d = new Date();
    const result = await saveFile(blob, `pocket-kaikei-yayoi-${period.startDate.slice(0, 4)}-${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}.csv`);
    if (result !== 'cancelled') showToast(`${journals.length}件の仕訳を書き出しました`);
  }

  put(
    outlet,
    h('p', { class: 'muted small', text: 'ほかの会計ソフトから移るときや、税理士さんに帳簿を渡すときに使います。ファイルはこの端末の中で読み書きするだけで、外部へは送信しません。' }),
    period.closed
      ? h('p', { class: 'notice', text: 'この会計期間は締めてあるため、取り込みはできません（書き出しはできます）。' })
      : [
          h(
            'section',
            { class: 'panel' },
            h('h2', { class: 'section-title', text: '1. ほかの会計ソフトの仕訳を取り込む' }),
            h('p', { class: 'small', text: `弥生会計のインポート形式と、見出しのある仕訳のCSV（freee・マネーフォワードの仕訳帳など）を読み込めます。今の会計期間（${formatPeriod(period)}）の日付の仕訳だけを登録します。` }),
            h('div', { class: 'field' }, h('label', { class: 'btn btn-block', for: 'ti-file', text: 'CSVファイルを選ぶ' }), fileInput, fileLabel),
            h('p', { class: 'muted small', text: '期首残高は取り込みません。「期首残高」の画面で入力してください。取引先（freee など）は摘要の先頭に付けます。' }),
          ),
          mapEl,
          listEl,
          footerEl,
        ],
    h(
      'section',
      { class: 'panel' },
      h('h2', { class: 'section-title', text: '弥生会計の形式で書き出す' }),
      h('p', { class: 'small', text: `今の会計期間（${formatPeriod(period)}）の仕訳${journals.length}件を、弥生会計のインポート形式（仕訳データ）で書き出します。` }),
      field('文字コード', encodingSelect),
      h('ul', { class: 'muted small plain-list ti-points' }, [
        h('li', { text: '税区分は税込（「課税売上込10%」など）で書き出します。インボイスのない仕入は、取引日に応じた経過措置の割合を付けます（「区分80%」など）。' }),
        h('li', { text: '借方・貸方が1行ずつの仕訳は仕訳データ、複合仕訳は振替伝票の形にします。期末日の決算整理仕訳は「本決」にします。' }),
        h('li', { text: '科目名が弥生会計と違うときは、弥生会計の取り込みの画面で対応を選んでください。' }),
      ]),
      exportNote,
      h('button', { type: 'button', class: 'btn btn-block', text: '弥生会計の形式で書き出す', onclick: exportYayoi }),
    ),
  );
}
