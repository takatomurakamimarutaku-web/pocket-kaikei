// 勘定科目内訳明細書（法人）：帳簿の残高・補助科目から各内訳書を作る。弥生会計・勘定奉行の内訳書作成を参考にした
// 帳簿に無い欄（所在地・利率など）は、CSV に書き出してから記入する前提
// e-Tax 用の CSV（国税庁の標準フォームの形式）は、様式ごとのファイルを ZIP にまとめて書き出す
import { h, put, amountCell, saveFile, confirmDialog, showToast } from '../ui.js';
import { breakdownStatements, BREAKDOWN_TARGETS, BREAKDOWN_BY_ID, cleanBreakdownTargets } from '../breakdown.js';
import { etaxBreakdownFiles } from '../etax-csv.js';
import { createZip } from '../zip.js';
import { compareAccounts, groupLabel } from '../accounts.js';
import { breakdownCsv, csvFileName } from '../csv.js';
import { formatPeriod } from '../period.js';

export async function render({ app, outlet }) {
  const { settings, period, accounts, subAccounts, journals } = await app.load();
  if (settings.entityType !== 'corporation') return put(outlet, h('p', { class: 'notice', text: '勘定科目内訳明細書は法人だけで使えます。' }));
  let showAll = false;
  let showEmpty = false;
  // ⑫・⑮（権利金等・工業所有権等の使用料）の対象の科目（補助科目）
  let targets = cleanBreakdownTargets(settings.breakdownTargets || {}, { accounts, subAccounts });
  const accountById = new Map(accounts.map((a) => [a.id, a]));
  const subById = new Map(subAccounts.map((x) => [x.id, x]));
  let forms = [];
  const body = h('div');
  const targetsEl = h('div');
  const index = h('div', { class: 'chip-row no-print' });

  const check = (label, onChange) => {
    const input = h('input', { type: 'checkbox', onchange: () => onChange(input.checked) });
    return h('label', { class: 'check small' }, input, label);
  };

  function table(f) {
    const head = h('tr', {}, f.columns.map((c) => h('th', { scope: 'col', class: c.num ? 'num' : '', text: c.label })));
    const rows = f.rows.map((r) =>
      h(
        'tr',
        { class: r.other ? 'bd-other' : '' },
        f.columns.map((c) => (c.num ? amountCell('td', r[c.key] ?? 0, { blankZero: c.key !== 'amount' }) : h('td', { text: r[c.key] ?? '' }))),
      ),
    );
    const first = f.columns.findIndex((c) => c.num);
    const totalRow = h(
      'tr',
      { class: 'st-total' },
      h('th', { scope: 'row', colspan: first, text: '計' }),
      f.columns.slice(first).map((c) => (c.num ? amountCell('td', c.key === 'amount' ? f.total : f.rows.reduce((s, r) => s + (r[c.key] || 0), 0)) : h('td', {}))),
    );
    return h('div', { class: 'table-wrap' }, h('table', { class: 'report breakdown', 'aria-label': f.title }, h('thead', {}, head), h('tbody', {}, rows, f.rows.length ? totalRow : null)));
  }

  const targetText = (list) =>
    list.length ? list.map((t) => `${accountById.get(t.accountId)?.name ?? ''}${t.subAccountId ? `（${subById.get(t.subAccountId)?.name ?? ''}）` : ''}`).join('、') : '未設定';

  function paintTargets() {
    put(
      targetsEl,
      h(
        'section',
        { class: 'panel no-print' },
        h('h2', { class: 'section-title', text: '対象の科目を選ぶ内訳書' }),
        h('p', { class: 'muted small', text: '決まった科目が無い内訳書は、選んだ科目（補助科目）の仕訳から作ります。' }),
        h(
          'ul',
          { class: 'plain-list bd-targets' },
          Object.keys(BREAKDOWN_TARGETS).map((id) => {
            const f = BREAKDOWN_BY_ID[id];
            return h(
              'li',
              { class: 'bd-target' },
              h('div', {}, h('span', { class: 'bd-target-title', text: `${f.no}${f.title.replace(/の内訳書$/, '')}` }), h('span', { class: 'muted small block', text: targetText(targets[id]) })),
              h('button', { type: 'button', class: 'btn btn-small', text: '選ぶ', 'aria-label': `${f.title}の対象の科目を選ぶ`, onclick: () => pickTargets(id) }),
            );
          }),
        ),
      ),
    );
  }

  async function pickTargets(id) {
    const def = BREAKDOWN_TARGETS[id];
    const f = BREAKDOWN_BY_ID[id];
    const cands = accounts.filter((a) => a.active !== false && def.groups.includes(a.group)).sort(compareAccounts);
    const isOn = (accountId, subId) => targets[id].some((t) => t.accountId === accountId && (t.subAccountId || null) === (subId || null));
    const boxes = [];
    const box = (a, sub, label, cls) => {
      const input = h('input', { type: 'checkbox', checked: isOn(a.id, sub?.id) });
      boxes.push({ input, accountId: a.id, subAccountId: sub?.id ?? null });
      return h('label', { class: `check small ${cls}` }, input, label);
    };
    const list = h(
      'div',
      { class: 'bd-pick' },
      def.groups.map((g) => {
        const accs = cands.filter((a) => a.group === g);
        if (!accs.length) return null;
        return [
          h('p', { class: 'bd-pick-group muted small', text: groupLabel(g, settings.entityType) }),
          accs.map((a) => {
            const subs = subAccounts.filter((x) => x.accountId === a.id && x.active !== false);
            return [box(a, null, subs.length ? `${a.name}（すべて）` : a.name, ''), subs.map((x) => box(a, x, x.name, 'bd-pick-sub'))];
          }),
        ];
      }),
    );
    const ok = await confirmDialog({
      title: `${f.no}${f.title}`,
      body: h('div', {}, h('p', { class: 'muted small', text: `${def.hint}を選んでください。補助科目を選ぶと、その補助科目の仕訳だけを使います。` }), list),
      buttons: [
        { label: 'キャンセル', value: false },
        { label: '決める', value: true, variant: 'primary' },
      ],
    });
    if (!ok) return;
    const chosen = boxes.filter((b) => b.input.checked).map(({ accountId, subAccountId }) => ({ accountId, subAccountId }));
    // 科目全体を選んだときは、その科目の補助科目の選択は要らない
    const whole = new Set(chosen.filter((c) => !c.subAccountId).map((c) => c.accountId));
    targets = { ...targets, [id]: chosen.filter((c) => !c.subAccountId || !whole.has(c.accountId)) };
    await app.db.saveBreakdownTargets(targets);
    showToast(`${f.title.replace(/の内訳書$/, '')}の対象を${targets[id].length ? `${targets[id].length}件にしました` : '外しました'}`);
    paintTargets();
    paint();
  }

  async function exportEtax() {
    const r = etaxBreakdownFiles(forms);
    if (!r.files.length) return showToast('書き出す内訳書がありません');
    const list = (items) => h('ul', {}, items.map((t) => h('li', { text: t })));
    const warn = (title, items) => h('div', { class: 'notice small ws-warn' }, h('p', { class: 'ws-warn-title', text: title }), items.length ? list(items) : null);
    const cut = r.truncated.map((t) => `${t.title.replace(/の内訳書$/, '')}の${t.label}（${t.max}文字まで）：${t.value}`);
    const ok = await confirmDialog({
      title: 'e-Tax 用の CSV を書き出す',
      body: h(
        'div',
        { class: 'bd-etax' },
        h('p', { class: 'small', text: `次の${r.files.length}個のファイルを ZIP にまとめます。展開したフォルダを e-Tax ソフトの「財務諸表等の組み込み」（勘定科目内訳明細書（CSVファイル））で指定すると、内訳書が読み込まれます。` }),
        h('ul', { class: 'small bd-etax-files' }, r.files.map((f) => h('li', {}, h('span', { class: 'bd-etax-name', text: f.name }), `　${f.titles.map((t) => t.replace(/の内訳書$/, '')).join('・')}`))),
        cut.length ? warn('文字数の上限を超えたため、切り詰めた欄があります（補助科目の名前を短くするか、組み込んだ後に直してください）', cut.length > 8 ? [...cut.slice(0, 8), `ほか${cut.length - 8}件`] : cut) : null,
        r.unsupported.length ? warn(`e-Tax で使えない文字を「？」にしました：${r.unsupported.join(' ')}`, []) : null,
        h(
          'ul',
          { class: 'muted small' },
          h('li', { text: '所在地・登録番号・利率・日付など、帳簿に無い欄は空欄です。組み込んだ後に e-Tax ソフトで記入してください。' }),
          h('li', { text: '金額基準でまとめた「その他」の行は、画面の表示のとおりに書き出します。' }),
          r.skipped.length ? h('li', { text: `${r.skipped.join('、')}は書き出しません。e-Tax ソフトで入力してください。` }) : null,
          r.noTotal.length ? h('li', { text: `${r.noTotal.join('、')}は明細が1ページに収まらないため、合計行を付けていません。` }) : null,
        ),
      ),
      buttons: [
        { label: 'キャンセル', value: false },
        { label: '書き出す', value: true, variant: 'primary' },
      ],
    });
    if (!ok) return;
    const now = new Date();
    const p = (n) => String(n).padStart(2, '0');
    const stamp = `${now.getFullYear()}-${p(now.getMonth() + 1)}-${p(now.getDate())}T${p(now.getHours())}:${p(now.getMinutes())}:${p(now.getSeconds())}`;
    const zip = createZip(r.files, stamp);
    const result = await saveFile(new Blob([zip], { type: 'application/zip' }), csvFileName('etax-breakdown', now).replace(/\.csv$/, '.zip'));
    if (result !== 'cancelled') showToast('e-Tax 用の CSV を書き出しました');
  }

  function paint() {
    forms = breakdownStatements({ accounts, subAccounts, period, journals, showAll, targets });
    const visible = forms.filter((f) => showEmpty || f.rows.length);
    const sections = visible.map((f) =>
      h(
        'section',
        { class: 'bd-section', id: `bd-${f.id}` },
        h('h3', { class: 'tf-title' }, h('span', { class: 'bd-no', text: f.no }), f.title),
        f.rows.length ? table(f) : h('p', { class: 'muted small', text: '残高・発生額がありません。' }),
        f.note ? h('p', { class: 'muted small', text: f.note }) : null,
      ),
    );
    put(
      index,
      visible.map((f, i) => h('button', { type: 'button', class: 'chip', text: `${f.no}${f.title.replace(/の内訳書$/, '').replace(/（.*?）/g, '')}`, onclick: () => sections[i].scrollIntoView({ behavior: 'smooth', block: 'start' }) })),
    );
    put(
      body,
      sections.length ? sections : h('p', { class: 'empty', text: '内訳書に出す残高がありません。' }),
      h(
        'div',
        { class: 'actions no-print' },
        h('button', { type: 'button', class: 'btn', text: 'CSVで書き出す', onclick: () => saveFile(new Blob([breakdownCsv(visible)], { type: 'text/csv' }), csvFileName('breakdown')) }),
        sections.length ? h('button', { type: 'button', class: 'btn', text: 'e-Tax用に書き出す', onclick: exportEtax }) : null,
      ),
    );
  }

  put(
    outlet,
    h('p', { class: 'muted small', text: `${settings.businessName}　${formatPeriod(period)}（期末 ${period.endDate.replaceAll('-', '/')} 現在）` }),
    h(
      'div',
      { class: 'option-bar no-print' },
      check('金額基準でまとめずにすべて表示', (v) => ((showAll = v), paint())),
      check('残高の無い内訳書も表示', (v) => ((showEmpty = v), paint())),
    ),
    targetsEl,
    index,
    body,
    h(
      'div',
      { class: 'panel small muted' },
      h('p', { text: '相手先・金融機関・銘柄・氏名・貸主は、各科目の補助科目で分けて出します。補助科目を使っていない科目は科目の合計の1行になります。' }),
      h('p', {}, '補助科目は ', h('a', { href: '#/accounts', class: 'link', text: '勘定科目' }), ' の画面で追加できます。所在地・法人との関係・利率など帳簿に無い欄は、CSV に書き出してから記入してください。'),
      h('p', { text: '「e-Tax用に書き出す」は、国税庁の標準フォームの CSV 形式（様式ごとのファイル・Shift_JIS）です。e-Tax ソフトに組み込んでから、空欄を記入して申告データに添付します。預貯金の補助科目の名前は、空白の前を金融機関名、後ろを支店名として書き出します（例：さくら銀行 本店）。役員給与等の内訳は書き出さないので、e-Tax ソフトで入力してください。' }),
      h('p', { text: '⑫土地の売上高等と⑮権利金等の期中支払・工業所有権等の使用料は、上で選んだ科目の仕訳から作ります。⑬売上高等の事業所別は、事業所を帳簿で分けていないため合計の1行です。テンプレートにない科目を追加した場合、その科目は（⑫・⑮の対象に選ばない限り）内訳書に入りません。' }),
      h('p', { text: '出典：国税庁 勘定科目内訳明細書の標準フォーム（令和6年3月1日以後終了事業年度分）、記載内容の簡素化（e-Tax）、CSV形式で作成する場合の留意事項、レコードの内容及び留意事項' }),
    ),
  );
  paintTargets();
  paint();
}
