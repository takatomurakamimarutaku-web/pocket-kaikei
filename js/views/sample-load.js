// サンプルデータの読み込み（初期設定・バックアップの画面から）。復元と同じ検証を通してから置き換える
import { h, put, field, showToast, confirmDialog } from '../ui.js';
import { buildSample, SAMPLES, SAMPLE_NAMES } from '../sample.js';
import { createBackup, parseBackup } from '../backup.js';
import { APP_VERSION } from '../version.js';
import { errorText } from '../errors.js';

/**
 * サンプルを選ぶ欄（業種・規模・消費税の説明つき）と、決めるボタン
 * @param {{ onPick: (id: string) => void, buttonLabel: string }} opts
 */
export function sampleChooser({ onPick, buttonLabel }) {
  const select = h(
    'select',
    { id: 'sample-id', onchange: () => paint() },
    [['individual', '個人'], ['corporation', '法人']].map(([type, label]) =>
      h('optgroup', { label }, SAMPLES.filter((x) => x.entityType === type).map((x) => h('option', { value: x.id, text: `${x.industry}｜${x.name}` }))),
    ),
  );
  const detail = h('div', { class: 'sample-detail', 'aria-live': 'polite' });
  function paint() {
    const x = SAMPLES.find((s) => s.id === select.value) || SAMPLES[0];
    put(
      detail,
      h('dl', { class: 'sample-facts small' }, [['規模', x.size], ['消費税', x.tax], ['決算', x.fiscal]].map(([k, v]) => [h('dt', { text: k }), h('dd', { text: v })])),
      h('p', { class: 'small muted', text: x.summary }),
    );
  }
  paint();
  return h('div', { class: 'sample-chooser' }, field('サンプルの種類', select), detail, h('button', { type: 'button', class: 'btn btn-block', text: buttonLabel, onclick: () => onPick(select.value) }));
}

/**
 * サンプルデータを選んで読み込む欄
 * @param {{ app, journals?: number, replaceNote?: boolean }} opts journals：今の仕訳の件数（1件以上なら置き換えの確認を出す）。replaceNote：今の事業所を置き換えることを書き添える
 */
export function samplePanel({ app, journals = 0, replaceNote = false }) {
  async function load(id) {
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
      const data = parseBackup(JSON.stringify(createBackup(buildSample(id), { appVersion: APP_VERSION })));
      await app.db.replaceAll(data);
      showToast(`サンプルデータ（${SAMPLE_NAMES[id]}）を読み込みました`, { duration: 6000 });
      app.navigate('#/home', { replace: true });
    } catch (e) {
      showToast(errorText(e, 'サンプルデータの読み込み'));
    }
  }
  return h(
    'div',
    { class: 'panel sample-panel' },
    h('h2', { class: 'section-title', text: 'サンプルデータで試す' }),
    h('p', { class: 'small', text: `動作確認用の1年分の帳簿を読み込みます。法人は業種・規模・消費税の計算方法の違う5種類から選べます。${replaceNote ? '今開いている事業所を置き換えるので、今のデータを残したまま試すなら「事業所の切替」からサンプルの事業所を作ってください。' : ''}期末の棚卸・減価償却・消費税の決算整理は入っていないので、決算・繰越の画面で試せます。` }),
    sampleChooser({ onPick: load, buttonLabel: 'このサンプルを読み込む' }),
  );
}
