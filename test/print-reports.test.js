import { test } from 'node:test';
import assert from 'node:assert/strict';
import { agingDoc } from '../js/print-reports.js';
import { partyBalances, AGING_BUCKETS } from '../js/receivables.js';
import { buildSample } from '../js/sample.js';
import { layoutDocument, fmt } from '../js/print-layout.js';

const textOf = (c) => (c && typeof c === 'object' && !Array.isArray(c) ? c.text : c);

test('売掛金残高一覧表：取引先ごとの残高と年齢の区分、合計は集計と一致し、区分の合計＝残高', () => {
  const s = buildSample('corporation');
  const period = s.periods[0];
  const r = partyBalances('receivable', { accounts: s.accounts, subAccounts: s.subAccounts, journals: s.journals, period, asOf: '2026-10-30' });
  const doc = agingDoc(r, { head: { company: 'サンプル', printedAt: '2026-10-30' } });
  assert.equal(doc.title, '売掛金残高一覧表');
  assert.equal(doc.period, '令和8年10月30日 現在');
  const t = doc.blocks[0];
  assert.deepEqual(
    t.columns.map((c) => c.label),
    ['得意先', '残高', ...AGING_BUCKETS.map((b) => b.label), '期日超過', '過入金', '支払条件', '次の入金予定日'],
  );
  const total = t.rows.find((row) => row.kind === 'total');
  assert.equal(textOf(total.cells[0]), '合計');
  assert.equal(total.cells[1], fmt(r.totals.balance));
  assert.equal(r.totals.balance, AGING_BUCKETS.reduce((sum, b) => sum + r.totals.buckets[b.id], 0));
  // 取引先の行の残高の合計＝合計の行
  const lines = t.rows.filter((row) => !row.kind);
  assert.ok(lines.length >= 1);
  assert.equal(lines.reduce((sum, row) => sum + Number(row.cells[1].replace(/,/g, '')), 0), r.totals.balance);
  // 構成比は合計で100%前後（四捨五入）
  const ratio = t.rows.find((row) => textOf(row.cells[0]) === '構成比');
  const pct = ratio.cells.slice(2, 2 + AGING_BUCKETS.length).reduce((sum, c) => sum + parseFloat(c), 0);
  assert.ok(Math.abs(pct - 100) < 0.5);
  assert.equal(layoutDocument(doc).length, 1);
  assert.equal(layoutDocument(doc)[0].orientation, 'landscape');
});

test('買掛金残高一覧表：見出しは仕入先・過払い・次の支払予定日', () => {
  const s = buildSample('corporation');
  const period = s.periods[0];
  const r = partyBalances('payable', { accounts: s.accounts, subAccounts: s.subAccounts, journals: s.journals, period, asOf: period.endDate });
  const doc = agingDoc(r, { head: {} });
  const labels = doc.blocks[0].columns.map((c) => c.label);
  assert.equal(labels[0], '仕入先');
  assert.ok(labels.includes('過払い'));
  assert.equal(labels.at(-1), '次の支払予定日');
});

test('幅を指定した表：直前の見出しと直後の注記は表の左端にそろえる', () => {
  const doc = {
    title: 't',
    blocks: [
      { type: 'heading', text: '見出し' },
      { type: 'table', width: 120, columns: [{ label: '科目' }, { label: '金額', align: 'right', w: 30 }], rows: [{ cells: ['現金', '1,000'] }] },
      { type: 'text', text: '注記1' },
      { type: 'text', text: '注記2' },
      { type: 'heading', text: '次' },
      { type: 'table', columns: [{ label: '科目' }, { label: '金額', align: 'right' }], rows: [{ cells: ['現金', '1,000'] }] },
    ],
  };
  const items = layoutDocument(doc)[0].items.filter((i) => i.t === 'text');
  const x = (s) => items.find((i) => i.text === s).x;
  const tableLeft = items.find((i) => i.text === '現金').x;
  assert.ok(x('見出し') > 20, '中央に置いた表の上の見出しは余白より右');
  assert.ok(Math.abs(x('見出し') - x('注記1')) < 0.01);
  assert.equal(x('注記1'), x('注記2'));
  assert.ok(tableLeft > x('見出し'));
  assert.ok(x('次') < x('見出し'), '幅いっぱいの表の見出しは左の余白から');
});

test('固定資産台帳：科目ごとに資産を並べ、科目計と合計は台帳の集計と一致（個人は事業割合と必要経費の列）', async () => {
  const { assetRegister } = await import('../js/depreciation.js');
  const { assetRegisterDoc } = await import('../js/print-reports.js');
  for (const entity of ['individual', 'corporation']) {
    const s = buildSample(entity);
    const period = s.periods[0];
    const register = assetRegister(s.assets, s.periods, period);
    assert.ok(register.length >= 1);
    const accountById = new Map(s.accounts.map((a) => [a.id, a]));
    const individual = entity === 'individual';
    const doc = assetRegisterDoc(register, { accountById, individual, head: { company: 'x' } });
    const t = doc.blocks[0];
    const labels = t.columns.map((c) => c.label);
    assert.equal(labels.includes('事業\n割合'), individual);
    assert.equal(labels.includes('必要経費\n算入額'), individual);
    const groups = t.rows.filter((r) => r.kind === 'group');
    const subs = t.rows.filter((r) => r.kind === 'subtotal');
    assert.equal(groups.length, subs.length);
    assert.equal(t.rows.filter((r) => !r.kind).length, register.length);
    const total = t.rows.at(-1);
    assert.equal(total.kind, 'total');
    // 列の位置：合計の行の「当期償却額」
    const amountCol = labels.indexOf('当期償却額');
    const cellAt = (row, col) => {
      let i = 0;
      for (const c of row.cells) {
        const span = (c && typeof c === 'object' && !Array.isArray(c) && c.span) || 1;
        if (col < i + span) return c;
        i += span;
      }
      return null;
    };
    assert.equal(cellAt(total, amountCol), fmt(register.reduce((sum, x) => sum + (x.row?.amount || 0), 0)));
    assert.equal(cellAt(total, labels.indexOf('取得価額')), fmt(register.reduce((sum, x) => sum + (x.cost ?? x.asset.cost), 0)));
    assert.equal(layoutDocument(doc)[0].orientation, 'landscape');
  }
});
