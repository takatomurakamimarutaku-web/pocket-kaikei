// 青色申告決算書（不動産所得用）：4ページの各欄を様式の並びで表示する（確定申告書等作成コーナー・e-Tax に転記する数字）
import { h, put, field, segmented, amountCell, showToast } from '../ui.js';
import { depreciationTable, blueBalanceSheet, blueDeductionOptions, blueDeductionReplaced } from '../blue-return.js';
import { blueReturnSet, hasRealEstate, isRealEstateAsset, realEstateDetails, realEstateForFirstTable } from '../real-estate.js';
import { depreciationTableView } from './blue-return.js';
import { formatYen, parseYen } from '../money.js';
import { formatPeriod } from '../period.js';
import { ValidationError } from '../db.js';

const MARU = '⓪①②③④⑤⑥⑦⑧⑨⑩⑪⑫⑬⑭⑮⑯⑰⑱⑲⑳㉑㉒㉓';
const maru = (n) => MARU[n] || String(n);

export async function render({ app, outlet, query }) {
  const { settings, period, accounts, subAccounts, journals } = await app.load();
  if (!hasRealEstate(settings)) {
    put(
      outlet,
      h('p', { class: 'empty', text: settings.entityType === 'individual' ? '不動産所得の設定が「なし」です。設定の「不動産所得」を「事業と両方」か「不動産だけ」にすると使えます。' : '青色申告決算書（不動産所得用）は個人の様式です。' }),
      settings.entityType === 'individual' ? h('a', { href: '#/settings', class: 'btn', text: '設定へ' }) : null,
    );
    return;
  }
  const [assets, periods] = await Promise.all([app.db.listAssets(), app.db.listPeriods()]);
  const accountById = new Map(accounts.map((a) => [a.id, a]));
  const only = settings.realEstate === 'only';
  const saved = { ...(period.blueReturn || {}) };
  const state = { deduction: saved.deduction, scale: saved.scale === 'business' ? 'business' : 'small', landInterest: saved.landInterest ?? 0 };
  let set = blueReturnSet({ settings, accounts, period, journals, overrides: state });
  state.deduction = set.selected;
  let page = ['1', '2', '3', '4'].includes(query.page) ? query.page : '1';
  const details = realEstateDetails({ accounts, subAccounts, period, journals });
  const body = h('div');
  const controls = h('div');

  const row = (no, label, amount, { strong = false, sub = '' } = {}) =>
    h('tr', { class: strong ? 'mt-strong' : '' }, h('td', { class: 'br-no', text: no ? maru(no) : '' }), h('th', { scope: 'row' }, label, sub ? h('span', { class: 'muted small block', text: sub }) : null), amountCell('td', amount));
  const table = (caption, rows, head = null) => h('div', { class: 'table-wrap' }, h('table', { class: 'report blue-return' }, caption ? h('caption', { text: caption }) : null, head, h('tbody', {}, rows)));
  /** 相手先ごとの内訳（補助科目から作る） */
  const listTable = (caption, list, nameLabel, amountLabel) =>
    list.length
      ? table(
          caption,
          [...list.map((x) => h('tr', {}, h('th', { scope: 'row', text: x.name }), amountCell('td', x.amount))), h('tr', { class: 'mt-strong' }, h('th', { scope: 'row', text: '計' }), amountCell('td', list.reduce((s, x) => s + x.amount, 0)))],
          h('thead', {}, h('tr', {}, h('th', { scope: 'col', text: nameLabel }), h('th', { scope: 'col', text: amountLabel }))),
        )
      : null;

  async function save(patch, message) {
    if (period.closed) return;
    try {
      await app.db.saveBlueReturnSettings(period.id, patch);
      if (message) showToast(message);
    } catch (e) {
      showToast(e instanceof ValidationError ? e.errors.join(' ') : '保存できませんでした');
    }
  }

  /** 土地等を取得するために要した負債の利子の額（㉓が赤字のときだけ出す） */
  function landInterestField() {
    return h(
      'div',
      { class: 'panel no-print' },
      field(
        '土地等を取得するために要した負債の利子の額',
        h('input', {
          id: 're-land-interest',
          type: 'text',
          inputmode: 'numeric',
          value: state.landInterest ? String(state.landInterest) : '',
          placeholder: '0',
          onchange: async (e) => {
            const r = e.target.value.trim() === '' ? { ok: true, value: 0 } : parseYen(e.target.value, { allowZero: true });
            if (!r.ok) return showToast(r.error);
            state.landInterest = r.value;
            paint();
            await save({ landInterest: r.value, deduction: state.deduction });
          },
        }),
        { hint: '⑨借入金利子のうち、土地（借地権を含む）を買うための借入金の利子。決算書の㉓の下の欄に書きます' },
      ),
    );
  }

  function page1() {
    const L = set.realEstate.lines;
    // 帳簿の科目名が様式の欄名と違うときだけ出す（「租税公課（不動産）」のように欄名で始まるものは出さない）
    const named = (e) => (e.name && !e.name.startsWith(e.label) ? `帳簿の科目：${e.name}` : '');
    const firstTable = realEstateForFirstTable(L[23], set.landInterest);
    return [
      table('収入金額', [...set.realEstate.incomes.map((x) => row(x.no, x.label, x.amount)), row(4, '計（①＋②＋③）', L[4], { strong: true })]),
      table('必要経費', [
        ...set.realEstate.expenses.map((e) => row(e.no, e.label || '（空欄）', e.amount, { sub: e.no === 17 && set.realEstate.overflow.length ? `空欄の行に入りきらない ${set.realEstate.overflow.map((o) => o.name).join('・')} を含む` : named(e) })),
        row(18, '計（⑤〜⑰）', L[18], { strong: true }),
      ]),
      table('所得金額', [
        row(19, '差引金額（④−⑱）', L[19]),
        row(20, '専従者給与', L[20]),
        row(21, '青色申告特別控除前の所得金額（⑲−⑳）', L[21], { strong: true }),
        row(22, '青色申告特別控除額', L[22], { sub: !only && set.business.lines[44] ? `残りの ${formatYen(set.business.lines[44])}円は一般用の㊹で差し引きます` : L[22] < set.selected && L[21] > 0 ? '控除前の所得金額が限度' : '' }),
        row(23, '所得金額（㉑−㉒）', L[23], { strong: true }),
        L[23] < 0 ? row(0, '確定申告書 第一表の「不動産③」', firstTable, { strong: true, sub: '赤字のうち土地等を取得するための負債の利子の分は、ほかの所得と損益通算できません' }) : null,
      ]),
      L[23] < 0 ? landInterestField() : null,
      set.familySalaryNotAllowed ? h('p', { class: 'notice', text: `貸付けが事業的規模でないときは、家族への給与（専従者給与 ${formatYen(L[20])}円）は必要経費になりません。事業的規模なら上の「貸付けの規模」を変え、そうでなければ仕訳の科目を事業主貸に直してください。` }) : null,
      L[23] < 0 && set.landInterest > L[9] ? h('p', { class: 'notice', text: `土地等の負債の利子（${formatYen(set.landInterest)}円）が⑨借入金利子（${formatYen(L[9])}円）を超えています。` }) : null,
    ];
  }

  function page2() {
    const t = details.tenants;
    const sum = (k) => t.reduce((s, x) => s + x[k], 0);
    return [
      t.length
        ? h(
            'div',
            { class: 'table-wrap' },
            h(
              'table',
              { class: 'report blue-return' },
              h('caption', { text: '不動産所得の収入の内訳' }),
              h('thead', {}, h('tr', {}, ['賃借人', '賃貸料', '礼金等', 'その他'].map((c) => h('th', { scope: 'col', text: c })))),
              h(
                'tbody',
                {},
                t.map((x) => h('tr', {}, h('th', { scope: 'row', text: x.name }), amountCell('td', x.rent, { blankZero: true }), amountCell('td', x.key, { blankZero: true }), amountCell('td', x.other, { blankZero: true }))),
                h('tr', { class: 'mt-strong' }, h('th', { scope: 'row', text: '計' }), amountCell('td', sum('rent')), amountCell('td', sum('key')), amountCell('td', sum('other'))),
              ),
            ),
          )
        : null,
      t.length
        ? h('p', { class: `check-line ${sum('total') === set.realEstate.lines[4] ? 'ok' : 'ng'}`, text: sum('total') === set.realEstate.lines[4] ? `収入金額の計 ${formatYen(sum('total'))}円＝1ページの④` : `内訳の計（${formatYen(sum('total'))}円）が1ページの④と一致しません` })
        : h('p', { class: 'muted small', text: 'この期間の不動産収入はありません。' }),
      h('p', { class: 'muted small', text: '礼金等は「礼金・権利金・更新料」、その他は「名義書換料その他」の欄です。賃借人ごとの金額は、賃貸料などの科目の補助科目（賃借人の名前）で分けています。貸家・貸地等の別、用途、賃借人の住所、貸付面積、賃貸契約期間、賃貸料の月額、保証金・敷金は、確定申告書等作成コーナーで入力してください。' }),
      listTable('給料賃金の内訳', details.wages, '氏名（補助科目）', '支給額'),
      listTable('専従者給与の内訳', details.family, '氏名（補助科目）', '支給額'),
      details.wages.length || details.family.length ? h('p', { class: 'muted small', text: '年齢・従事月数・源泉徴収税額は確定申告書等作成コーナーで入力してください。' }) : null,
      table(
        '青色申告特別控除額の計算',
        [
          row(0, '不動産所得の金額（㉑）', set.realEstate.lines[21]),
          row(0, '選んだ控除額', set.selected),
          row(0, '不動産所得から差し引く控除額（㉒）', set.realEstate.lines[22], { strong: true, sub: '控除は不動産所得から先に差し引き、所得金額が限度です' }),
          only ? null : row(0, '事業所得から差し引く控除額（一般用の㊹）', set.business.lines[44]),
        ],
      ),
    ];
  }

  function page3() {
    const t = depreciationTable({ assets, periods, period, filter: (a) => isRealEstateAsset(a, accountById) });
    return [
      t.rows.length ? depreciationTableView(t) : h('p', { class: 'muted small' }, '償却費の科目を「減価償却費（不動産）」にした固定資産はありません。', h('a', { class: 'link', href: '#/assets', text: '固定資産台帳' })),
      t.total.business !== set.realEstate.lines[8] ? h('p', { class: 'notice', text: `必要経費算入額の計（${formatYen(t.total.business)}円）と損益計算書の⑧減価償却費（${formatYen(set.realEstate.lines[8])}円）が違います。固定資産の「償却費の科目」と、決算・繰越の画面の減価償却の仕訳を確かめてください。` }) : null,
      listTable('地代家賃の内訳', details.rent, '支払先（補助科目）', '本年中の賃借料・権利金等'),
      listTable('借入金利子の内訳', details.interest, '支払先（補助科目）', '本年中の借入金利子'),
      h('p', { class: 'muted small', text: '借入金利子の内訳は金融機関以外からの借入れの分だけ書きます。税理士・弁護士等の報酬・料金の内訳、本年中における特殊事情は、確定申告書等作成コーナーで入力してください。' }),
    ];
  }

  function page4() {
    if (!only) {
      return [
        h('p', { class: 'small', text: '事業所得もあるので、貸借対照表は事業所得と不動産所得の資産・負債を合算して、一般用の4ページに書きます（国税庁「青色申告決算書（一般用）の書き方」。所得ごとに分けて書いてもかまいません）。' }),
        h('a', { class: 'btn', href: '#/reports/blue-return?page=4', text: '一般用の貸借対照表を見る' }),
      ];
    }
    const bs = blueBalanceSheet({ accounts, period, journals, incomeBeforeDeduction: set.incomeBeforeDeduction });
    const start = `${Number(period.startDate.slice(5, 7))}月${Number(period.startDate.slice(8))}日（期首）`;
    const end = `${Number(period.endDate.slice(5, 7))}月${Number(period.endDate.slice(8))}日（期末）`;
    // 不動産所得用の様式は一般用と科目の行が違うので、帳簿の科目名で金額のある行だけ出す
    const shown = (list) => list.filter((x) => x.opening === null || x.opening || x.closing);
    const side = (caption, list, openingTotal, closingTotal) =>
      h(
        'div',
        { class: 'table-wrap' },
        h(
          'table',
          { class: 'report blue-return' },
          h('caption', { text: caption }),
          h('thead', {}, h('tr', {}, h('th', { scope: 'col', text: '科目' }), h('th', { scope: 'col', text: start }), h('th', { scope: 'col', text: end }))),
          h(
            'tbody',
            {},
            shown(list).map((x) => h('tr', {}, h('th', { scope: 'row', text: x.name || x.label }), x.opening === null ? h('td') : amountCell('td', x.opening, { blankZero: true }), amountCell('td', x.closing, { blankZero: true }))),
            h('tr', { class: 'mt-strong' }, h('th', { scope: 'row', text: '合計' }), amountCell('td', openingTotal), amountCell('td', closingTotal)),
          ),
        ),
      );
    return [
      side('資産の部', bs.assets, bs.totals.assetsOpening, bs.totals.assetsClosing),
      side('負債・資本の部', bs.liabilities, bs.totals.liabilitiesOpening, bs.totals.liabilitiesClosing),
      h('p', { class: `check-line ${bs.balanced ? 'ok' : 'ng'}`, text: bs.balanced ? '期首・期末とも、資産の部の合計＝負債・資本の部の合計' : '資産の部と負債・資本の部の合計が一致しません。期首残高と仕訳を確かめてください' }),
      h('p', { class: 'muted small', text: '科目は帳簿の科目名で、金額のある行だけ出しています。様式に同じ科目の行が無いものは空欄の行に書いてください。「青色申告特別控除前の所得金額」は1ページの㉑です。' }),
    ];
  }

  function paintControls() {
    const options = blueDeductionOptions(set.year, { limited: set.limited });
    put(
      controls,
      field(
        '貸付けの規模',
        segmented({
          name: '貸付けの規模',
          options: [
            { value: 'business', label: '事業的規模' },
            { value: 'small', label: '事業的規模でない' },
          ],
          value: state.scale,
          onChange: async (v) => {
            state.scale = v;
            paint();
            await save({ scale: v, deduction: state.deduction });
          },
        }),
        { hint: 'おおむね5棟10室以上なら事業的規模（国税庁 No.1373）。事業的規模でないと専従者給与は経費にならず、不動産所得だけなら控除は10万円までです' },
      ),
      field(
        '青色申告特別控除額',
        h(
          'select',
          {
            id: 're-deduction',
            onchange: async (e) => {
              state.deduction = Number(e.target.value);
              paint();
              await save({ deduction: state.deduction });
            },
          },
          options.map((d) => h('option', { value: d.value, text: d.label, selected: d.value === state.deduction })),
        ),
        { hint: only ? '65万円・55万円は、事業的規模の貸付けを複式簿記で記帳し、貸借対照表を添付して期限内に申告する場合です' : '一般用と同じ控除額。不動産所得から先に差し引きます' },
      ),
      blueDeductionReplaced(set.year, saved.deduction, { limited: set.limited }) ? h('p', { class: 'notice', text: `前に選んだ控除額はこの条件では使えないため、${formatYen(set.selected)}円で計算しています。` }) : null,
      segmented({
        name: 'ページ',
        options: [
          { value: '1', label: '1 損益' },
          { value: '2', label: '2 収入' },
          { value: '3', label: '3 償却' },
          { value: '4', label: '4 貸借' },
        ],
        value: page,
        onChange: (v) => {
          page = v;
          paint();
        },
      }),
    );
  }

  function paint() {
    history.replaceState(history.state, '', `#/reports/blue-return-re?page=${page}`);
    set = blueReturnSet({ settings, accounts, period, journals, overrides: state });
    state.deduction = set.selected;
    paintControls();
    const pages = [page1, page2, page3, page4];
    const titles = ['損益計算書', '不動産所得の収入の内訳など', '減価償却費の計算など', '貸借対照表（資産負債調）'];
    put(
      body,
      pages.map((fn, i) => h('section', { class: `br-page${String(i + 1) === page ? '' : ' is-off'}` }, h('h2', { class: 'print-only br-page-title', text: `青色申告決算書（不動産所得用）${i + 1}ページ　${titles[i]}` }), fn())),
    );
  }

  put(
    outlet,
    h('p', { class: 'muted small no-print', text: `${formatPeriod(period)}・${settings.businessName}` }),
    h('section', { class: 'panel no-print' }, controls),
    body,
    h(
      'div',
      { class: 'panel small muted no-print' },
      h('p', { text: '国税庁の青色申告決算書（不動産所得用）の欄の並びで集計しています。確定申告書等作成コーナーや e-Tax に転記するときの数字としてお使いください。' }),
      h('p', { text: '科目と欄の対応は、不動産所得の科目の目印で決めています。自分で追加した不動産経費の科目は空欄の行（⑫〜⑯）に、不動産収入の科目は③に入ります。' }),
      h('p', { text: '出典：国税庁「令和7年分 青色申告決算書（不動産所得用）の書き方」、タックスアンサー No.2072（青色申告特別控除）・No.1373（事業としての不動産貸付け）' }),
    ),
  );
  paint();
}
