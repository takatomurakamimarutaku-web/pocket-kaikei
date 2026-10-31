// 事業承継：自社株の評価額の概算（取引相場のない株式・原則的評価方式）と、株価対策の目安
import { h, put, showToast, errorBox, confirmDialog } from '../ui.js';
import { formatYen, parseYen } from '../money.js';
import { buildStatements } from '../statements.js';
import { corporateTaxReturn } from '../corporate-tax.js';
import { formatPeriod } from '../period.js';
import { errorText } from '../errors.js';
import { ValidationError } from '../db.js';
import { shareValuation, figuresFrom, DEFAULT_SUCCESSION, INDUSTRIES, SIZE_LABELS } from '../advisor/share-value.js';
import { loadAdvisor, estimateNote } from './advisor-common.js';

const yen = (n) => (n === null || n === undefined ? '—' : `${formatYen(n)}円`);
const clone = (o) => JSON.parse(JSON.stringify(o));
const NTA_STOCK = 'https://www.nta.go.jp/taxes/shiraberu/taxanswer/hyoka/4638.htm';

export async function render({ app, outlet, isStale }) {
  const { data, landing, taxes, previous } = await loadAdvisor(app);
  if (isStale?.()) return;
  const { settings, period, accounts } = data;
  if (settings.entityType !== 'corporation') {
    put(outlet, h('p', { class: 'notice', text: '自社株の評価は法人のための機能です。個人事業の事業承継（事業用資産の引継ぎなど）は、税理士に相談してください。' }));
    return;
  }
  const input = clone({ ...DEFAULT_SUCCESSION, ...(period.succession || {}), peer: { ...DEFAULT_SUCCESSION.peer, ...(period.succession?.peer || {}) } });
  if (!previous && input.basis === 'previous') input.basis = 'landing';
  let dirty = false;
  const body = h('div');
  const errorsEl = h('div');
  const cutEl = h('div');
  const tipsEl = h('div');

  // 評価の元にする決算の数字
  const landingFigures = (() => {
    const { pl, bs } = buildStatements({ entityType: 'corporation', accounts, period, journals: taxes.journals });
    return figuresFrom({ bs, pl, taxableIncome: taxes.taxableIncome, incomeTaxes: taxes.incomeTaxes });
  })();
  const previousFigures = previous
    ? (() => {
        const { pl, bs } = buildStatements({ entityType: 'corporation', accounts, period: previous.period, journals: previous.journals });
        const r = corporateTaxReturn({ accounts, period: previous.period, journals: previous.journals, input: previous.period.corporateTax || {}, enterpriseInput: previous.period.enterpriseTax || {} });
        return figuresFrom({ bs, pl, taxableIncome: r.schedule4.income.total });
      })()
    : null;

  const set = (key, value) => {
    input[key] = value;
    dirty = true;
    paint();
  };
  const yenField = (label, key, { negative = false, placeholder = '', hint = '', get = () => input[key], put: putValue = (v) => set(key, v), blankNull = false } = {}) =>
    h(
      'label',
      { class: 'sim-field' },
      h('span', { class: 'field-label', text: label }),
      h(
        'span',
        { class: 'sim-input' },
        h('input', {
          type: 'text',
          inputmode: 'numeric',
          'aria-label': label,
          placeholder,
          value: get() === null ? '' : formatYen(get()),
          onchange: (e) => {
            if (blankNull && !e.target.value.trim()) return putValue(null);
            const r = parseYen(e.target.value || '0', { allowZero: true, allowNegative: negative });
            if (!r.ok) return put(errorsEl, errorBox([`${label}：${r.error}`]));
            put(errorsEl);
            putValue(r.value);
          },
        }),
      ),
      hint ? h('span', { class: 'muted small', text: hint }) : null,
    );
  const intField = (label, get, putValue, hint = '') =>
    h(
      'label',
      { class: 'sim-field' },
      h('span', { class: 'field-label', text: label }),
      h('span', { class: 'sim-input' }, h('input', { type: 'text', inputmode: 'numeric', 'aria-label': label, value: String(get() || ''), onchange: (e) => { const t = e.target.value.replace(/[,，\s]/g, ''); if (t && !/^\d+$/.test(t)) return put(errorsEl, errorBox([`${label}：0以上の整数で入れてください`])); put(errorsEl); putValue(Number(t || 0)); } })),
      hint ? h('span', { class: 'muted small', text: hint }) : null,
    );
  // 類似業種の配当 B は「4.4」のように10銭単位
  const bField = h(
    'label',
    { class: 'sim-field' },
    h('span', { class: 'field-label', text: 'B 配当金額' }),
    h('span', { class: 'sim-input' }, h('input', { type: 'text', inputmode: 'decimal', 'aria-label': 'B 配当金額', value: input.peer.B10 ? (input.peer.B10 / 10).toFixed(1) : '', onchange: (e) => { const t = e.target.value.trim(); if (t && !/^\d{1,6}(\.\d)?$/.test(t)) return put(errorsEl, errorBox(['B 配当金額：「4.4」のように小数1桁までで入れてください'])); put(errorsEl); input.peer.B10 = Math.round(Number(t || 0) * 10); dirty = true; paint(); } }), h('span', { class: 'muted small', text: '円' })),
  );

  function paint() {
    const figures = input.basis === 'previous' && previousFigures ? previousFigures : landingFigures;
    const r = shareValuation({ ...input, profitCut: 0 }, figures);
    const cut = input.profitCut ? shareValuation(input, figures) : null;
    const capitalShown = input.capital ?? figures.capital;
    const c = r.comparable;
    put(
      body,
      h(
        'div',
        { class: 'kpi-grid' },
        h('div', { class: 'kpi' }, h('span', { class: 'kpi-label', text: '1株当たりの評価額（概算）' }), h('span', { class: 'kpi-value num', text: yen(r.price) }), h('span', { class: 'kpi-sub', text: r.method || '' })),
        h('div', { class: 'kpi' }, h('span', { class: 'kpi-label', text: '株式全体の評価額（概算）' }), h('span', { class: 'kpi-value num', text: yen(r.total) }), h('span', { class: 'kpi-sub', text: `${formatYen(input.shares)}株 ／ ${SIZE_LABELS[r.size.size]}` })),
      ),
      r.notes.map((n) => h('p', { class: 'muted small', text: n })),
      h('h2', { class: 'section-title', text: '計算の内訳' }),
      h(
        'div',
        { class: 'table-wrap' },
        h(
          'table',
          { class: 'report advisor-share', 'aria-label': '評価の内訳' },
          h(
            'tbody',
            {},
            row('会社規模', SIZE_LABELS[r.size.size], `総資産・従業員：${SIZE_LABELS[r.size.byAssets]}、取引金額：${SIZE_LABELS[r.size.bySales]}`),
            row('総資産価額（帳簿価額）', yen(figures.totalAssets)),
            row('取引金額（売上高）', yen(figures.sales)),
            row('純資産（帳簿価額）', yen(figures.netAssets), input.basis === 'landing' ? '着地の法人税等を未払として引いた額' : ''),
            row('資本金等の額', yen(capitalShown), input.capital === null ? '帳簿の資本金・資本剰余金' : '入力した額'),
            row('利益（法人税の所得金額）', yen(figures.profit)),
            c ? row('1株（50円）当たりの配当・利益・純資産', `${(c.b10 / 10).toFixed(1)}円・${formatYen(c.c)}円・${formatYen(c.d)}円`) : null,
            c ? row('比準割合', (c.ratio / 100).toFixed(2), `配当 ${(c.rb / 100).toFixed(2)}・利益 ${(c.rc / 100).toFixed(2)}・純資産 ${(c.rd / 100).toFixed(2)} の平均`) : null,
            row('類似業種比準価額（1株）', c ? yen(c.price) : '—', c ? `50円当たり ${(c.per50x10 / 10).toFixed(1)}円 × 斟酌率 ${r.size.kind === 'large' ? '0.7' : r.size.kind === 'medium' ? '0.6' : '0.5'} 込み` : '類似業種の数字を入れると計算します'),
            row('純資産価額（1株）', yen(r.net?.price), r.net?.tax ? `含み益の37%（${yen(r.net.tax)}）を引いた額` : ''),
          ),
        ),
      ),
    );
    // 入力欄は描き直さない（入力中の欄が消えないように）。対策後の数字だけ描き直す
    put(
      cutEl,
      cut
          ? h(
              'div',
              { class: 'saving-stats' },
              h('div', { class: 'saving-stat' }, h('span', { class: 'muted small', text: '対策後の1株' }), h('span', { class: 'num strong', text: yen(cut.price) })),
              h('div', { class: 'saving-stat' }, h('span', { class: 'muted small', text: '対策後の株式全体' }), h('span', { class: 'num strong', text: yen(cut.total) })),
              h('div', { class: 'saving-stat' }, h('span', { class: 'muted small', text: '下がる額' }), h('span', { class: 'num', text: r.total !== null && cut.total !== null ? yen(r.total - cut.total) : '—' })),
            )
          : null,
    );
    put(
      tipsEl,
      h(
        'ul',
        { class: 'plain-list small advisor-tips' },
        h('li', { text: '利益を下げる：役員退職金の支給、不良資産の処分・含み損の実現などで、評価の年の利益（類似業種比準の「c」）と純資産が下がります。退職金は役員の退任などの要件と、金額が過大でないかに注意します。' }),
        h('li', { text: '配当を抑える：類似業種比準の「b」は直前2年の配当の平均です（記念配当などの臨時の配当は除きます）。' }),
        h('li', { text: '会社規模を上げる：従業員・総資産・取引金額で会社規模が上がると、比準価額の割合（L）が上がり、多くの場合は評価額が下がります。' }),
        h('li', { text: '時期：評価は課税時期の直前期末の決算の数字で行います。対策をした期の翌期に贈与・相続があると効果が出ます。' }),
      ),
    );
  }
  function row(label, value, note = '') {
    return h('tr', {}, h('th', { scope: 'row', text: label }), h('td', { class: 'num', text: value }), h('td', { class: 'muted small', text: note }));
  }

  async function save() {
    try {
      await app.db.saveSuccession(period.id, input);
      dirty = false;
      showToast('入力を保存しました');
      app.refresh();
    } catch (e) {
      put(errorsEl, errorBox(e instanceof ValidationError ? [].concat(Object.values(e.errors)) : [errorText(e, '保存')]));
    }
  }

  paint();
  put(
    outlet,
    h('p', { class: 'notice small', text: 'この画面の評価額は、帳簿の数字から求めたおおまかな試算です。贈与・相続・譲渡に使う正式な評価（相続税評価額による資産の評価、特定の評価会社の判定、同族株主の判定など）は、税理士に依頼してください。' }),
    h(
      'div',
      { class: 'panel sim-inputs' },
      h(
        'label',
        { class: 'sim-field' },
        h('span', { class: 'field-label', text: '評価の元にする決算' }),
        h(
          'select',
          { 'aria-label': '評価の元にする決算', onchange: (e) => set('basis', e.target.value) },
          h('option', { value: 'landing', text: `当期の着地見込み（${formatPeriod(period)}）`, selected: input.basis === 'landing' }),
          previous ? h('option', { value: 'previous', text: `前期の決算（${formatPeriod(previous.period)}）`, selected: input.basis === 'previous' }) : null,
        ),
        h('span', { class: 'muted small', text: '着地見込みにすると、この期の決算のあとに評価したときの目安になります。' }),
      ),
      h('label', { class: 'sim-field' }, h('span', { class: 'field-label', text: '業種' }), h('select', { 'aria-label': '業種', onchange: (e) => set('industry', e.target.value) }, INDUSTRIES.map((i) => h('option', { value: i.id, text: i.label, selected: i.id === input.industry })))),
      intField('従業員数', () => input.employees, (v) => set('employees', v), '直前期末以前1年間の常時使用する従業員（役員を除く。パートは労働時間で換算）'),
      intField('発行済株式数', () => input.shares, (v) => set('shares', v), '自己株式を除く'),
      yenField('資本金等の額', 'capital', { placeholder: formatYen(landingFigures.capital), blankNull: true, hint: '空欄なら帳簿の資本金・資本剰余金を使います' }),
      yenField('年配当金額（直前2年の平均）', 'dividends'),
      yenField('含み益（土地・有価証券などの相続税評価額 − 帳簿価額）', 'gain', { negative: true, hint: '含み損はマイナスで。純資産価額では含み益の37%を引きます' }),
    ),
    h('h2', { class: 'section-title', text: '類似業種の株価など' }),
    h(
      'div',
      { class: 'panel sim-inputs' },
      h('p', { class: 'muted small' }, '国税庁が毎年公表する「類似業種比準価額計算上の業種目及び業種目別株価等」から、自社の業種目の数字を入れます（株価 A は、課税時期の月以前3か月・前年平均・以前2年間の平均のうち最も低いもの）。', h('a', { class: 'link', href: NTA_STOCK, target: '_blank', rel: 'noopener noreferrer', text: '取引相場のない株式の評価（国税庁）' })),
      intField('A 株価', () => input.peer.A, (v) => { input.peer.A = v; dirty = true; paint(); }),
      bField,
      intField('C 利益金額', () => input.peer.C, (v) => { input.peer.C = v; dirty = true; paint(); }),
      intField('D 簿価純資産価額', () => input.peer.D, (v) => { input.peer.D = v; dirty = true; paint(); }),
    ),
    errorsEl,
    body,
    h('h2', { class: 'section-title', text: '株価対策の目安' }),
    h('div', { class: 'panel' }, yenField('利益を下げる額（役員退職金など）', 'profitCut', { hint: '利益と純資産が同じ額だけ減ったとして計算し直します（税金の減る分は見ていません）' }), cutEl),
    tipsEl,
    h('button', { type: 'button', class: 'btn btn-primary btn-block', text: '入力を保存する', onclick: save }),
    h('p', { class: 'muted small', text: '計算は財産評価基本通達178〜180・185の原則的評価方式（同族株主が取得する場合）に沿った簡便な試算です。特定の評価会社（株式等保有・土地保有・比準要素数1・開業後3年未満など）、配当還元方式、議決権割合50%以下の同族株主グループの純資産価額の80%評価、直前々期の数字との平均などは扱っていません。' }),
    estimateNote(),
  );
  app.leaveGuard = async () =>
    !dirty ||
    (await confirmDialog({
      title: '入力を保存せずに離れますか？',
      buttons: [
        { label: '続ける', value: false },
        { label: '保存せずに離れる', value: true, variant: 'danger' },
      ],
    }));
}
