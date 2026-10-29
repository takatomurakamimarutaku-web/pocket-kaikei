// 証憑の一覧：取引年月日・取引金額の範囲、取引先、種類を組み合わせて検索する（電子取引のデータの検索の要件）
import { h, put, field, emptyState, saveFile, showToast } from '../ui.js';
import { searchAttachments, ATTACHMENT_KINDS, formatBytes, attachmentFileName } from '../attachments.js';
import { attachmentThumb, attachmentText, editAttachment } from './attachment-panel.js';
import { attachmentsCsv, csvFileName } from '../csv.js';
import { parseYen } from '../money.js';

const slash = (d) => d.replaceAll('-', '/');

export async function render({ app, outlet, query }) {
  const { settings, period } = await app.load();
  const [list, periods] = await Promise.all([app.db.listAttachments(), app.db.listPeriods()]);
  // 証憑をつないだ仕訳（ほかの会計期間の仕訳も）
  const journalById = new Map();
  for (const p of periods) for (const j of await app.db.listJournals(p.id)) journalById.set(j.id, j);
  const periodById = new Map(periods.map((p) => [p.id, p]));
  const yen = (v) => {
    const r = v ? parseYen(v, { allowZero: true }) : null;
    return r?.ok ? r.value : null;
  };
  const crit = {
    from: query.from ?? period.startDate,
    to: query.to ?? period.endDate,
    min: yen(query.min),
    max: yen(query.max),
    party: query.q || '',
    kind: ATTACHMENT_KINDS[query.kind] ? query.kind : '',
    unlinked: query.unlinked === '1',
  };

  function syncUrl() {
    const params = new URLSearchParams();
    if (crit.from !== period.startDate) params.set('from', crit.from);
    if (crit.to !== period.endDate) params.set('to', crit.to);
    if (crit.min != null) params.set('min', crit.min);
    if (crit.max != null) params.set('max', crit.max);
    if (crit.party) params.set('q', crit.party);
    if (crit.kind) params.set('kind', crit.kind);
    if (crit.unlinked) params.set('unlinked', '1');
    const qs = String(params);
    history.replaceState(history.state, '', `#/attachments${qs ? `?${qs}` : ''}`);
  }

  const update = (key, value) => {
    crit[key] = value;
    syncUrl();
    paint();
  };
  const dateInput = (key) => h('input', { id: `att-${key}`, type: 'date', value: crit[key], onchange: (e) => update(key, e.target.value) });
  const yenInput = (key, placeholder) =>
    h('input', {
      id: `att-${key}`,
      type: 'text',
      inputmode: 'numeric',
      placeholder,
      value: crit[key] ?? '',
      oninput: (e) => {
        const v = e.target.value.trim();
        const r = v === '' ? null : parseYen(v, { allowZero: true });
        if (r && !r.ok) return;
        update(key, r ? r.value : null);
      },
    });
  const searchPanel = h(
    'section',
    { class: 'panel adv-search' },
    h('div', { class: 'field-row' }, field('取引年月日（から）', dateInput('from')), field('取引年月日（まで）', dateInput('to'))),
    h('div', { class: 'field-row' }, field('取引金額（以上）', yenInput('min', '0')), field('取引金額（以下）', yenInput('max', '上限なし'))),
    field('取引先', h('input', { id: 'att-party', type: 'search', value: crit.party, placeholder: '取引先・メモ・ファイル名', oninput: (e) => update('party', e.target.value) })),
    field(
      '種類',
      h(
        'select',
        { id: 'att-kind', onchange: (e) => update('kind', e.target.value) },
        h('option', { value: '', text: 'すべて' }),
        Object.entries(ATTACHMENT_KINDS).map(([value, label]) => h('option', { value, text: label, selected: crit.kind === value })),
      ),
    ),
    h('label', { class: 'check small' }, h('input', { type: 'checkbox', checked: crit.unlinked, onchange: (e) => update('unlinked', e.target.checked) }), '仕訳が削除された・つながっていない証憑だけ'),
    h('p', { class: 'muted small', text: '入力した条件をすべて満たす証憑を探します。日付・金額で絞り込むと、日付・金額が空欄の証憑は出ません。' }),
  );

  const meta = h('p', { class: 'list-meta' });
  const listEl = h('ul', { class: 'attach-list panel' });
  let shown = [];

  function journalLine(a) {
    const j = a.journalId ? journalById.get(a.journalId) : null;
    if (!j) return h('span', { class: 'muted small', text: a.journalId ? '仕訳は削除されています' : '仕訳につながっていません' });
    const other = j.periodId !== period.id ? `（${slash(periodById.get(j.periodId)?.startDate ?? '')}からの期間）` : '';
    return j.periodId === period.id
      ? h('a', { class: 'small', href: `#/journal/${encodeURIComponent(j.id)}/edit`, text: `No.${j.no}（${slash(j.date)}）の仕訳を開く` })
      : h('span', { class: 'muted small', text: `No.${j.no}（${slash(j.date)}）${other}` });
  }

  function paint() {
    shown = searchAttachments(list, { ...crit, journalIds: new Set(journalById.keys()) });
    const size = shown.reduce((s, a) => s + a.size, 0);
    meta.textContent = `${shown.length}件・${formatBytes(size)}（すべての証憑 ${list.length}件）`;
    if (!shown.length) {
      put(listEl);
      listEl.hidden = true;
      meta.after(emptyHint);
      return;
    }
    emptyHint.remove();
    listEl.hidden = false;
    put(
      listEl,
      shown.map((a) => {
        const j = a.journalId ? journalById.get(a.journalId) : null;
        const locked = Boolean(j && periodById.get(j.periodId)?.closed);
        return h(
          'li',
          { class: 'attach-row' },
          h(
            'button',
            {
              type: 'button',
              class: 'attach-item',
              onclick: async () => {
                if (await editAttachment(app, a, { locked })) app.refresh();
              },
            },
            attachmentThumb(a),
            attachmentText(a),
          ),
          h('div', { class: 'attach-link' }, journalLine(a)),
        );
      }),
    );
  }

  const emptyHint = list.length
    ? h('p', { class: 'empty', text: '条件に合う証憑はありません' })
    : emptyState('証憑はまだありません', h('p', { class: 'muted small', text: '仕訳の入力画面の「証憑」で、領収書を撮影したり、PDF の請求書を選んだりして添付できます。' }));

  async function exportCsv() {
    if (!shown.length) return showToast('書き出す証憑がありません');
    const text = attachmentsCsv(shown, { journalById, kindLabels: ATTACHMENT_KINDS, fileName: attachmentFileName });
    await saveFile(new Blob([text], { type: 'text/csv' }), csvFileName('attachments'));
  }

  put(
    outlet,
    h('p', { class: 'muted small', text: `${settings.businessName}　すべての会計期間の証憑を探せます。` }),
    searchPanel,
    meta,
    listEl,
    h(
      'div',
      { class: 'actions' },
      h('button', { type: 'button', class: 'btn', text: '一覧をCSVで書き出す（索引簿）', onclick: exportCsv }),
      h('a', { href: '#/e-book', class: 'btn', text: '電子取引の保存の要件' }),
    ),
    h('p', { class: 'muted small', text: '証憑の中身はこの端末の中だけにあります。バックアップで「証憑も含める」を選んで、定期的に書き出してください。' }),
  );
  paint();
}
