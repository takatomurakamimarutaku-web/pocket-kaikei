// 証憑（領収書・請求書）の添付：撮影・ファイルの選択、一覧、表示・情報の修正・削除
// 仕訳の入力・かんたん入力・証憑の一覧から使う
import { h, put, confirmDialog, showToast, saveFile } from '../ui.js';
import {
  ATTACHMENT_KINDS,
  ACCEPT_ATTR,
  PREVIEW_TYPES,
  MAX_ATTACHMENT_BYTES,
  PHOTO_LONG_SIDE,
  PHOTO_QUALITY,
  THUMB_SIZE,
  attachmentType,
  isImageType,
  typeLabel,
  fitSize,
  formatBytes,
  attachmentDefaults,
  fillBlank,
  attachmentFileName,
} from '../attachments.js';
import { createAttachment } from '../models.js';
import { formatYen, parseYen } from '../money.js';
import { isValidDate } from '../period.js';
import { isCashAccount } from '../quick.js';
import { errorText } from '../errors.js';

const slash = (d) => (d ? d.replaceAll('-', '/') : '');
const KIND_SHORT = { paper: '紙を撮影', electronic: '電子取引のデータ' };

/** 画像を読み込む（読めない形式なら null）。使い終わったら release を呼ぶ */
async function loadImage(blob) {
  const url = URL.createObjectURL(blob);
  const img = new Image();
  img.src = url;
  try {
    await img.decode();
    return { img, release: () => URL.revokeObjectURL(url) };
  } catch {
    URL.revokeObjectURL(url);
    return null;
  }
}

function draw(img, maxSide) {
  const { width, height } = fitSize(img.naturalWidth, img.naturalHeight, maxSide);
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d');
  // 透過の PNG を JPEG にすると黒くなるため白で塗ってから描く
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, width, height);
  ctx.drawImage(img, 0, 0, width, height);
  return canvas;
}

const toBlob = (canvas, type, quality) => new Promise((resolve, reject) => canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('画像を変換できませんでした'))), type, quality));

/**
 * 選んだファイルを保存できる形にする
 * 紙の証憑の撮影は長辺 PHOTO_LONG_SIDE まで縮めて JPEG にする（A4 を 200dpi 相当以上で残す）。電子取引のデータはそのまま
 * @returns {Promise<{ bytes: ArrayBuffer, name: string, type: string, thumb: string|null }>}
 */
export async function prepareFile(file, kind) {
  const type = attachmentType(file.name, file.type);
  if (!type) throw new Error('添付できるのは画像・PDF・XML・CSV・テキストのファイルです');
  let blob = file;
  let outType = type;
  let name = file.name || `file.${type.split('/')[1]}`;
  let thumb = null;
  if (isImageType(type)) {
    const loaded = await loadImage(file);
    if (loaded) {
      try {
        const { img } = loaded;
        const fit = fitSize(img.naturalWidth, img.naturalHeight, PHOTO_LONG_SIDE);
        if (kind === 'paper' && (fit.scaled || !PREVIEW_TYPES.includes(type))) {
          blob = await toBlob(draw(img, PHOTO_LONG_SIDE), 'image/jpeg', PHOTO_QUALITY);
          outType = 'image/jpeg';
          name = `${name.replace(/\.[^.]*$/, '') || 'photo'}.jpg`;
        }
        thumb = draw(img, THUMB_SIZE).toDataURL('image/jpeg', 0.7);
      } finally {
        loaded.release();
      }
    }
  }
  if (blob.size > MAX_ATTACHMENT_BYTES) throw new Error(`ファイルが大きすぎます（${formatBytes(blob.size)}。${formatBytes(MAX_ATTACHMENT_BYTES)}まで）`);
  if (!blob.size) throw new Error('ファイルが空です');
  return { bytes: await blob.arrayBuffer(), name: name.slice(0, 200), type: outType, thumb };
}

/** 一覧の縮小画像（なければ種類の札） */
export function attachmentThumb(a) {
  return a.thumb ? h('img', { class: 'attach-thumb', src: a.thumb, alt: '' }) : h('span', { class: 'attach-thumb attach-type', text: typeLabel(a.type) });
}

/** 一覧の1行の文字 */
export function attachmentText(a) {
  const sub = [slash(a.date), a.amount != null ? `${formatYen(a.amount)}円` : ''].filter(Boolean).join('・');
  return h(
    'span',
    { class: 'attach-text' },
    h('span', { class: 'attach-title', text: a.partner || a.name }),
    sub ? h('span', { class: 'muted small', text: sub }) : null,
    h('span', { class: `attach-kind kind-${a.kind}`, text: KIND_SHORT[a.kind] }),
  );
}

/** 証憑の中身を開く：画像は画面で表示、PDF などは共有・保存 */
export async function openAttachment(app, a, data = null) {
  const bytes = data ?? (await app.db.getAttachmentData(a.id));
  if (!bytes) return showToast('証憑の中身が見つかりません');
  // 表示できない種類は、ブラウザで開かれないよう汎用の種類で渡す
  const type = PREVIEW_TYPES.includes(a.type) || a.type === 'application/pdf' ? a.type : 'application/octet-stream';
  const blob = new Blob([bytes], { type });
  if (!PREVIEW_TYPES.includes(a.type)) {
    await saveFile(blob, attachmentFileName(a));
    return;
  }
  const url = URL.createObjectURL(blob);
  try {
    const choice = await confirmDialog({
      title: a.partner || a.name,
      body: h('div', { class: 'attach-viewer' }, h('img', { src: url, alt: a.name })),
      buttons: [
        { label: '保存・共有', value: 'save' },
        { label: '閉じる', value: false, variant: 'primary' },
      ],
    });
    if (choice === 'save') await saveFile(blob, attachmentFileName(a));
  } finally {
    URL.revokeObjectURL(url);
  }
}

/**
 * 証憑の情報の入力（追加のとき・修正のとき）。入力が正しくなければ閉じずに直してもらう
 * @returns {Promise<{ action: 'save'|'delete'|'open'|null, values?: object }>}
 */
async function infoDialog({ meta, isNew, locked, previewUrl }) {
  const kind = h(
    'select',
    { id: 'att-kind', disabled: locked },
    Object.entries(ATTACHMENT_KINDS).map(([value, label]) => h('option', { value, text: label, selected: meta.kind === value })),
  );
  const date = h('input', { id: 'att-date', type: 'date', value: meta.date || '', disabled: locked });
  const amount = h('input', { id: 'att-amount', type: 'text', inputmode: 'numeric', value: meta.amount != null ? formatYen(meta.amount) : '', placeholder: '空欄なら仕訳の金額', disabled: locked });
  const partner = h('input', { id: 'att-partner', type: 'text', maxlength: 100, value: meta.partner || '', placeholder: '例：株式会社〇〇', disabled: locked });
  const memo = h('input', { id: 'att-memo', type: 'text', maxlength: 200, value: meta.memo || '', disabled: locked });
  const errorEl = h('p', { class: 'field-error', role: 'alert', hidden: true });
  const row = (label, control) => h('label', { class: 'attach-field' }, h('span', { class: 'small', text: label }), control);
  const body = h(
    'div',
    { class: 'attach-info' },
    h(
      'div',
      { class: 'attach-file' },
      previewUrl ? h('img', { class: 'attach-preview', src: previewUrl, alt: '' }) : attachmentThumb(meta),
      h('span', { class: 'attach-text' }, h('span', { class: 'attach-title', text: meta.name }), h('span', { class: 'muted small', text: `${typeLabel(meta.type)}・${formatBytes(meta.size)}` })),
    ),
    row('種類', kind),
    row('取引年月日', date),
    row('取引金額（円）', amount),
    row('取引先', partner),
    row('メモ', memo),
    isNew ? h('p', { class: 'muted small', text: '日付・金額・取引先は、後で証憑の一覧から検索するときに使います。空欄のものは仕訳の内容で補います。' }) : null,
    !isNew && meta.sha256 ? h('p', { class: 'muted small attach-hash', text: `登録 ${new Date(meta.createdAt).toLocaleString('ja-JP')}　SHA-256：${meta.sha256}` }) : null,
    errorEl,
  );
  const buttons = locked
    ? [
        { label: '中身を開く', value: 'open' },
        { label: '閉じる', value: null, variant: 'primary' },
      ]
    : isNew
      ? [
          { label: 'やめる', value: null },
          { label: '添付する', value: 'save', variant: 'primary' },
        ]
      : [
          { label: '削除', value: 'delete', variant: 'danger-text' },
          { label: '中身を開く', value: 'open' },
          { label: '保存', value: 'save', variant: 'primary' },
        ];
  for (;;) {
    const action = await confirmDialog({ title: isNew ? '証憑を添付する' : '証憑の情報', body, buttons });
    if (action !== 'save') return { action };
    const errors = [];
    const amountText = amount.value.trim();
    const parsed = amountText ? parseYen(amountText, { allowZero: true }) : { ok: true, value: null };
    if (!parsed.ok) errors.push(`取引金額：${parsed.error}`);
    if (date.value && !isValidDate(date.value)) errors.push('取引年月日が正しくありません');
    if (!errors.length) return { action, values: { kind: kind.value, date: date.value, amount: parsed.value, partner: partner.value.trim(), memo: memo.value.trim() } };
    errorEl.textContent = errors.join('　');
    errorEl.hidden = false;
  }
}

/**
 * 証憑の情報を表示し、修正・削除・中身の表示をする（保存済みの証憑）
 * @returns {Promise<boolean>} 変更（修正・削除）したか
 */
export async function editAttachment(app, a, { locked = false } = {}) {
  const { action, values } = await infoDialog({ meta: a, isNew: false, locked });
  if (action === 'open') {
    await openAttachment(app, a);
    return false;
  }
  try {
    if (action === 'save') {
      await app.db.updateAttachment(a.id, values);
      showToast('証憑の情報を保存しました');
      return true;
    }
    if (action === 'delete') {
      const ok = await confirmDialog({
        title: '証憑を削除しますか？',
        message: '中身も消えます。電子取引のデータは、法律で決められた期間は保存が必要です。間違えて添付したときだけ削除してください。',
        buttons: [
          { label: 'キャンセル', value: false },
          { label: '削除する', value: true, variant: 'danger' },
        ],
      });
      if (!ok) return false;
      await app.db.deleteAttachment(a.id);
      showToast('証憑を削除しました');
      return true;
    }
  } catch (e) {
    showToast(Array.isArray(e.errors) ? e.errors.join('\n') : errorText(e, '保存'));
  }
  return false;
}

/**
 * 仕訳の証憑の欄
 * 保存済みの仕訳ならすぐ保存する。新しい仕訳では、仕訳を登録したときに commit(journal) で保存する
 * @param {{ app, data: { subById, accountById }, journalId?: string|null, locked?: boolean, current: () => { date, lines }, onPending?: () => void }} opts
 *   current：入力中の仕訳（日付・行）。取引年月日・金額・取引先の初期値に使う
 */
export function attachmentPanel({ app, data, journalId = null, locked = false, current, onPending = () => {} }) {
  let items = [];
  let pending = [];
  const listEl = h('ul', { class: 'attach-list' });
  const countEl = h('span', { class: 'muted small' });
  const isCash = (id) => isCashAccount(data.accountById.get(id));
  const defaults = (journal) => attachmentDefaults(journal, { subById: data.subById, isCash });

  const camera = h('input', { type: 'file', accept: 'image/*', capture: 'environment', hidden: true, onchange: () => pick(camera, 'paper') });
  const chooser = h('input', { type: 'file', accept: ACCEPT_ATTR, hidden: true, onchange: () => pick(chooser, null) });

  async function pick(input, kindHint) {
    const file = input.files?.[0];
    input.value = '';
    if (!file) return;
    // 写真は紙の証憑、PDF などは電子取引のデータを初期値にする（追加の画面で変えられる）
    const kind = kindHint || (isImageType(attachmentType(file.name, file.type)) ? 'paper' : 'electronic');
    let prepared;
    try {
      prepared = await prepareFile(file, kind);
    } catch (e) {
      showToast(e.message || errorText(e, '読み込み'), { duration: 5000 });
      return;
    }
    const base = createAttachment({ journalId, kind, name: prepared.name, type: prepared.type, size: prepared.bytes.byteLength, thumb: prepared.thumb, ...defaults(current()) });
    const previewUrl = PREVIEW_TYPES.includes(prepared.type) ? URL.createObjectURL(new Blob([prepared.bytes], { type: prepared.type })) : null;
    let result;
    try {
      result = await infoDialog({ meta: base, isNew: true, locked: false, previewUrl });
    } finally {
      if (previewUrl) URL.revokeObjectURL(previewUrl);
    }
    if (result.action !== 'save') return;
    const meta = { ...base, ...result.values };
    if (!journalId) {
      pending.push({ meta, bytes: prepared.bytes });
      onPending();
      paint();
      return;
    }
    try {
      await app.db.saveAttachment(fillBlank(meta, defaults(current())), prepared.bytes);
      showToast('証憑を添付しました');
      await reload();
    } catch (e) {
      showToast(Array.isArray(e.errors) ? e.errors.join('\n') : errorText(e, '保存'), { duration: 5000 });
    }
  }

  function paint() {
    const all = [...items.map((a) => ({ a, saved: true })), ...pending.map((p) => ({ a: p.meta, saved: false, p }))];
    countEl.textContent = all.length ? `${all.length}件` : '';
    put(
      listEl,
      all.map(({ a, saved, p }) =>
        h(
          'li',
          {},
          h(
            'button',
            {
              type: 'button',
              class: 'attach-item',
              onclick: async () => {
                if (saved) {
                  if (await editAttachment(app, a, { locked })) await reload();
                  return;
                }
                // 未保存（仕訳の登録前）：表示か取り消し
                const choice = await confirmDialog({
                  title: a.partner || a.name,
                  message: '仕訳を登録すると一緒に保存します。',
                  buttons: [
                    { label: '添付をやめる', value: 'remove', variant: 'danger-text' },
                    { label: '中身を開く', value: 'open' },
                    { label: '閉じる', value: null, variant: 'primary' },
                  ],
                });
                if (choice === 'open') await openAttachment(app, a, p.bytes);
                if (choice === 'remove') {
                  pending = pending.filter((x) => x !== p);
                  paint();
                }
              },
            },
            attachmentThumb(a),
            attachmentText(a),
            saved ? null : h('span', { class: 'attach-pending small', text: '未保存' }),
          ),
        ),
      ),
    );
  }

  async function reload() {
    items = journalId ? await app.db.listAttachmentsByJournal(journalId) : [];
    paint();
  }

  /** 新しい仕訳を登録したあと、添付を保存する。保存できた件数を返す */
  async function commit(journal) {
    let saved = 0;
    const failed = [];
    for (const p of pending) {
      try {
        await app.db.saveAttachment(fillBlank({ ...p.meta, journalId: journal.id }, defaults(journal)), p.bytes);
        saved++;
      } catch (e) {
        failed.push(`${p.meta.name}：${Array.isArray(e.errors) ? e.errors[0] : errorText(e, '保存')}`);
      }
    }
    pending = [];
    paint();
    if (failed.length) showToast(`証憑を保存できませんでした（${failed.join('、')}）`, { duration: 6000 });
    return saved;
  }

  const el = h(
    'section',
    { class: 'panel attach-panel' },
    h('div', { class: 'attach-head' }, h('h2', { class: 'section-title', text: '証憑（領収書・請求書）' }), countEl),
    listEl,
    locked
      ? null
      : [
          h(
            'div',
            { class: 'attach-buttons' },
            h('button', { type: 'button', class: 'btn', text: '撮影する', onclick: () => camera.click() }),
            h('button', { type: 'button', class: 'btn', text: 'ファイルを選ぶ', onclick: () => chooser.click() }),
            camera,
            chooser,
          ),
          h('p', { class: 'muted small', text: '紙の領収書は撮影しても原本を捨てずに保存してください。メールなどで受け取った PDF の請求書は「ファイルを選ぶ」で、電子取引のデータとしてそのまま保存します。' }),
        ],
  );
  reload();
  return { el, commit, reload, hasPending: () => pending.length > 0, clear: () => ((pending = []), paint()) };
}
