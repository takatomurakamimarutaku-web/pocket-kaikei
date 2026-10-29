// サンプルデータの読み込み（初期設定・バックアップの画面から）。復元と同じ検証を通してから置き換える
import { h, showToast, confirmDialog } from '../ui.js';
import { buildSample, SAMPLE_NAMES } from '../sample.js';
import { createBackup, parseBackup } from '../backup.js';
import { APP_VERSION } from '../version.js';
import { errorText } from '../errors.js';

/**
 * サンプルデータのボタン（個人・法人）
 * @param {{ app, journals?: number, replaceNote?: boolean }} opts journals：今の仕訳の件数（1件以上なら置き換えの確認を出す）。replaceNote：今の事業所を置き換えることを書き添える
 */
export function samplePanel({ app, journals = 0, replaceNote = false }) {
  async function load(entityType) {
    if (journals > 0) {
      const ok = await confirmDialog({
        title: 'サンプルデータで置き換えますか？',
        message: `現在のデータ（仕訳 ${journals}件）は消えます。先にバックアップを書き出してください。`,
        buttons: [
          { label: 'キャンセル', value: false },
          { label: '置き換える', value: true, variant: 'danger' },
        ],
      });
      if (!ok) return;
    }
    try {
      const data = parseBackup(JSON.stringify(createBackup(buildSample(entityType), { appVersion: APP_VERSION })));
      await app.db.replaceAll(data);
      showToast(`サンプルデータ（${SAMPLE_NAMES[entityType]}）を読み込みました`, { duration: 6000 });
      app.navigate('#/home', { replace: true });
    } catch (e) {
      showToast(errorText(e, 'サンプルデータの読み込み'));
    }
  }
  return h(
    'div',
    { class: 'panel sample-panel' },
    h('h2', { class: 'section-title', text: 'サンプルデータで試す' }),
    h('p', { class: 'small', text: `動作確認用の1年分の帳簿を読み込みます。${replaceNote ? '今開いている事業所を置き換えるので、今のデータを残したまま試すなら「事業所の切替」からサンプルの事業所を作ってください。' : ''}期末の棚卸・減価償却・消費税の決算整理は入っていないので、決算・繰越の画面で試せます。` }),
    h('ul', { class: 'small plain-list' }, h('li', { text: '個人：小売・デザインの個人事業（課税、2026年）。家賃の家事按分、インボイスのない外注、中古の軽自動車（事業70%）など' }), h('li', { text: '法人：製造業の会社（課税、2026/4〜2027/3）。製造原価、工場の機械（定率法）、輸出売上、仕入の返品、税区分の誤りの例など' })),
    h('div', { class: 'field-row' }, h('button', { type: 'button', class: 'btn', text: '個人のサンプル', onclick: () => load('individual') }), h('button', { type: 'button', class: 'btn', text: '法人のサンプル', onclick: () => load('corporation') })),
  );
}
