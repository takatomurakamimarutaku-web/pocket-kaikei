// サンプルデータの読み込み（初期設定・バックアップの画面から）。復元と同じ検証を通してから置き換える
import { h, put, field, segmented, showToast, confirmDialog } from '../ui.js';
import { buildSample, SAMPLES, SAMPLE_NAMES } from '../sample.js';
import { createBackup, parseBackup } from '../backup.js';
import { APP_VERSION } from '../version.js';
import { errorText } from '../errors.js';

/**
 * サンプルを選ぶ欄（業種・規模・消費税の説明つき）、期の数（当期だけ／前々期からの3期分）と、決めるボタン
 * @param {{ onPick: (id: string, opts: { periods: 1|3 }) => void, buttonLabel: string }} opts
 */
export function sampleChooser({ onPick, buttonLabel }) {
  let periods = 1;
  const periodsNote = h('p', { class: 'field-hint' });
  const paintPeriods = () => (periodsNote.textContent = periods === 3 ? '前々期・前期は決算整理（棚卸・減価償却・消費税等・法人税等）をして締めてあり、期末残高が当期の期首に繰り越してあります。前期との比較や締めた期の確認も試せます' : '当期の1年分だけです');
  paintPeriods();
  const select = h(
    'select',
    { id: 'sample-id', onchange: () => paint() },
    [['individual', '個人'], ['corporation', '法人']].map(([type, label]) =>
      h('optgroup', { label }, SAMPLES.filter((x) => x.entityType === type).map((x) => h('option', { value: x.id, text: x.industry }))),
    ),
  );
  const detail = h('div', { class: 'sample-detail', 'aria-live': 'polite' });
  function paint() {
    const x = SAMPLES.find((s) => s.id === select.value) || SAMPLES[0];
    put(
      detail,
      h('dl', { class: 'sample-facts small' }, [['名前', x.name], ['規模', x.size], ['消費税', x.tax], ['決算', x.fiscal]].map(([k, v]) => [h('dt', { text: k }), h('dd', { text: v })])),
      h('p', { class: 'small muted', text: x.summary }),
    );
  }
  paint();
  const periodsSeg = segmented({
    name: '期の数',
    options: [
      { value: 1, label: '当期だけ' },
      { value: 3, label: '前々期から3期分' },
    ],
    value: periods,
    onChange: (v) => ((periods = v), paintPeriods()),
  });
  return h(
    'div',
    { class: 'sample-chooser' },
    field('サンプルの種類', select),
    detail,
    h('div', { class: 'field' }, h('p', { class: 'field-label', text: '期の数' }), periodsSeg, periodsNote),
    h('button', { type: 'button', class: 'btn btn-block', text: buttonLabel, onclick: () => onPick(select.value, { periods }) }),
  );
}

/**
 * サンプルデータを選んで読み込む欄
 * @param {{ app, journals?: number, replaceNote?: boolean }} opts journals：今の仕訳の件数（1件以上なら置き換えの確認を出す）。replaceNote：今の事業所を置き換えることを書き添える
 */
export function samplePanel({ app, journals = 0, replaceNote = false }) {
  async function load(id, { periods = 1 } = {}) {
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
      const data = parseBackup(JSON.stringify(createBackup(buildSample(id, { periods }), { appVersion: APP_VERSION })));
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
    h('p', { class: 'small', text: `動作確認用の帳簿を読み込みます。個人・法人とも業種・規模・消費税の違う5種類ずつから選べ、前々期からの3期分にもできます。${replaceNote ? '今開いている事業所を置き換えるので、今のデータを残したまま試すなら「事業所の切替」からサンプルの事業所を作ってください。' : ''}当期の期末の棚卸・減価償却・消費税の決算整理は入っていないので、決算・繰越の画面で試せます。` }),
    sampleChooser({ onPick: load, buttonLabel: 'このサンプルを読み込む' }),
  );
}
