import { test } from 'node:test';
import assert from 'node:assert/strict';
import { layoutDocument, fitText, textWidth, emWidth, columnWidths, warekiText, periodText, fmt, PT } from '../js/print-layout.js';
import { buildPdf, ucs2Hex, showText, pageContent } from '../js/print-pdf.js';
import { journalBookDoc, ledgerBookDoc, trialBalanceDoc, statementDoc, ratioText, splitSub, docHead } from '../js/print-forms.js';
import { generalLedger, generalLedgers, trialBalance } from '../js/ledger.js';
import { buildStatements } from '../js/statements.js';
import { browserPrintWorks } from '../js/install.js';
import { makeBook } from './helpers.js';

const texts = (page) => page.items.filter((i) => i.t === 'text').map((i) => i.text);
const allTexts = (pages) => pages.flatMap(texts);

test('文字の幅：全角1・半角0.5・カンマ0.3。収まらない文字は縮め、縮めても入らなければ「…」', () => {
  assert.equal(emWidth('現金'), 2);
  assert.equal(emWidth('AB'), 1);
  assert.equal(emWidth('1,000'), 2.3);
  assert.equal(emWidth('ｱｲ'), 1);
  assert.ok(Math.abs(textWidth('現金', 10) - 20 * PT) < 1e-9);
  assert.deepEqual(fitText('現金', 10, 100), { text: '現金', scale: 1 });
  const shrunk = fitText('あいうえお', 10, textWidth('あいうえお', 10) * 0.8);
  assert.equal(shrunk.text, 'あいうえお');
  assert.ok(shrunk.scale < 1 && shrunk.scale >= 0.6);
  const cut = fitText('あいうえおかきくけこ', 10, textWidth('あいう', 10));
  assert.ok(cut.text.endsWith('…'));
  assert.equal(cut.scale, 0.6);
  assert.ok(textWidth(cut.text, 10) * 0.6 <= textWidth('あいう', 10) + 1e-9);
});

test('和暦と期間の見出し', () => {
  assert.equal(warekiText('2026-04-01'), '令和8年4月1日');
  assert.equal(warekiText('2019-05-01'), '令和元年5月1日');
  assert.equal(warekiText('2019-04-30'), '平成31年4月30日');
  assert.equal(periodText('2026-01-01', '2026-12-31'), '自 令和8年1月1日　至 令和8年12月31日');
  assert.equal(fmt(-1234567), '△1,234,567');
  assert.equal(fmt(0), '0');
});

test('列の幅：使える幅にぴったり収め、数字の列は縮めない。収まらない表は横向きにする', () => {
  const cols = [{ label: '科目' }, { label: '金額', align: 'right' }];
  const rows = [{ cells: ['現金', '1,000'] }];
  const { widths, over } = columnWidths(cols, rows, 186);
  assert.equal(over, 0);
  assert.ok(Math.abs(widths[0] + widths[1] - 186) < 1e-9);
  assert.ok(widths[0] > widths[1], '余りは文字の列に配る');
  // 金額の列が13本ある表（月次推移）は A4 縦に入らない
  const wide = [{ label: '科目' }, ...Array.from({ length: 13 }, (_, i) => ({ label: `${i + 1}月`, align: 'right' }))];
  const wideRows = [{ cells: ['売上高', ...Array(13).fill('123,456,789')] }];
  const pages = layoutDocument({ title: '月次推移表', orientation: 'auto', blocks: [{ type: 'table', columns: wide, rows: wideRows }] });
  assert.equal(pages[0].orientation, 'landscape');
  assert.equal(pages[0].w, 297);
});

test('改ページ：見出し行を各ページで繰り返し、ページ番号は n / N。繰越行の金額は前のページまでの累計', () => {
  const rows = [];
  let bal = 0;
  for (let i = 1; i <= 120; i++) {
    bal += 100;
    rows.push({ cells: ['04/01', String(i), '売上高', '', '100', '', fmt(bal)], nums: { 4: 100, 5: 0, 6: bal } });
  }
  const columns = ['日付', 'No.', '相手科目', '摘要', '借方', '貸方', '残高'].map((label, i) => ({ label, align: i >= 4 ? 'right' : undefined }));
  const pages = layoutDocument({ title: '総勘定元帳', company: 'テスト商店', period: '期間', printedAt: '2026-10-29', blocks: [{ type: 'heading', text: '[111] 現金', caption: true }, { type: 'table', columns, rows, carry: { label: 3, sum: [4, 5], balance: 6 } }] });
  assert.ok(pages.length >= 3);
  pages.forEach((p, i) => {
    const t = texts(p);
    assert.ok(t.includes('総勘定元帳'));
    assert.ok(t.includes('テスト商店'));
    assert.ok(t.includes(`${i + 1} / ${pages.length}`));
    assert.ok(t.includes('借方'), '見出し行を繰り返す');
    assert.ok(t.some((x) => x.startsWith('[111] 現金')), '科目名を各ページに出す');
    if (i > 0) assert.ok(t.includes('前頁より繰越'));
    if (i < pages.length - 1) assert.ok(t.includes('次頁へ繰越'));
    // 行が下の余白にはみ出さない
    for (const it of p.items) if (it.t === 'line') assert.ok(Math.max(it.y1, it.y2) <= p.h - 11 + 1e-9);
  });
  // 1ページ目の「次頁へ繰越」の借方＝1ページ目の行数×100、残高も同じ
  const p1 = texts(pages[0]);
  const n1 = p1.filter((x) => x === '売上高').length;
  const carry = p1.slice(p1.indexOf('次頁へ繰越') + 1, p1.indexOf('次頁へ繰越') + 4);
  assert.deepEqual(carry, [fmt(n1 * 100), '0', fmt(n1 * 100)], '借方の累計・貸方の累計・残高');
  const p2 = texts(pages[1]);
  assert.deepEqual(p2.slice(p2.indexOf('前頁より繰越') + 1, p2.indexOf('前頁より繰越') + 4), carry);
  // 全行が1回ずつ出る
  assert.equal(allTexts(pages).filter((x) => x === '売上高').length, 120);
});

test('keep：1件の仕訳の行はページをまたがない', () => {
  const rows = [];
  for (let k = 0; k < 40; k++) for (let i = 0; i < 3; i++) rows.push({ keep: `j${k}`, cells: [i ? '' : `J${k}`, `行${i}`] });
  const pages = layoutDocument({ title: '仕訳日記帳', blocks: [{ type: 'table', columns: [{ label: 'No.' }, { label: '科目' }], rows }] });
  assert.ok(pages.length >= 2);
  for (const p of pages) {
    const t = texts(p);
    for (const x of t.filter((s) => /^J\d+$/.test(s))) {
      const i = t.indexOf(x);
      assert.deepEqual(t.slice(i + 1, i + 4), ['行0', '行1', '行2'], `${x} の3行が同じページにある`);
    }
  }
});

test('PDF：ヘッダー・ページ数・xref の位置が正しく、日本語は UCS-2 で書く', () => {
  const pages = layoutDocument({ title: '残高試算表', company: '株式会社テスト', blocks: [{ type: 'table', columns: [{ label: '科目' }, { label: '金額', align: 'right' }], rows: [{ cells: ['現金', '1,000'] }] }] });
  const bytes = buildPdf(pages, { title: '残高試算表', now: new Date(2026, 9, 29, 10, 0, 0) });
  const s = String.fromCharCode(...bytes);
  assert.ok(s.startsWith('%PDF-1.4'));
  assert.ok(s.trimEnd().endsWith('%%EOF'));
  assert.match(s, /\/Count 1\b/);
  assert.match(s, /\/Encoding \/UniJIS-UCS2-HW-H/);
  assert.match(s, /\/MediaBox \[0 0 595\.28 841\.89\]/);
  // xref の各位置に「n 0 obj」がある
  const startxref = Number(/startxref\n(\d+)/.exec(s)[1]);
  assert.ok(s.slice(startxref).startsWith('xref'));
  const offsets = [...s.slice(startxref).matchAll(/^(\d{10}) 00000 n $/gm)].map((m) => Number(m[1]));
  offsets.forEach((o, i) => assert.ok(s.slice(o).startsWith(`${i + 1} 0 obj`), `obj ${i + 1}`));
  assert.ok(s.includes(ucs2Hex('株式会社テスト')));
  assert.equal(ucs2Hex('現金'), '73FE91D1');
  assert.equal(ucs2Hex('😀'), '3013');
  // 空白は字形を描かずに送り、カンマは前後を詰める
  assert.equal(showText('a b'), '[<0061> -500 <0062>] TJ');
  assert.equal(showText('1,000'), '[<0031> 100 <002C> 100 <003000300030>] TJ');
  // 右寄せの文字は、右端から文字の幅だけ左に置く
  const c = pageContent({ w: 210, h: 297, items: [{ t: 'text', x: 100, y: 100, size: 10, text: '1,000', align: 'right', scale: 1 }] });
  const x = Number(/1 0 0 1 ([\d.]+) /.exec(c)[1]);
  assert.ok(Math.abs(x - ((100 * 72) / 25.4 - 23)) < 0.01, `x=${x}`);
});

test('仕訳日記帳：複合仕訳を行に分け、合計と繰越行の金額は借方・貸方の合計', () => {
  const b = makeBook('corporation', { subs: [['普通預金', 'A銀行']] });
  const journals = [];
  for (let i = 0; i < 30; i++) {
    journals.push(b.j('2026-02-01', [['消耗品費', 1100], ['通信費', 2200]], [['普通預金', 3300, undefined, 'A銀行']], `経費${i}`));
  }
  const doc = journalBookDoc({ journals, accountById: new Map(b.accounts.map((a) => [a.id, a])), subById: new Map(b.subAccounts.map((s) => [s.id, s])), head: docHead({ settings: { businessName: 'テスト' }, period: b.period, printedAt: '2026-10-29' }) });
  const t = doc.blocks[0];
  assert.equal(t.rows.length, 61);
  assert.deepEqual(t.rows[0].cells.slice(0, 5), ['02/01', '1', ['消耗品費'], '課税仕入10%', '1,100']);
  assert.deepEqual(t.rows[0].cells[5], ['普通預金', 'A銀行']);
  assert.equal(t.rows[1].cells[0], '', '2行目は日付を出さない');
  const total = t.rows.at(-1);
  assert.equal(total.kind, 'total');
  assert.equal(total.cells[1], fmt(3300 * 30));
  assert.equal(total.cells[4], fmt(3300 * 30));
  const pages = layoutDocument(doc);
  assert.ok(pages.length >= 2);
  assert.equal(doc.period, '自 令和8年1月1日　至 令和8年12月31日');
});

test('総勘定元帳：科目ごとの見出し・繰越・月計・合計。合計と残高は元帳の集計と一致', () => {
  const b = makeBook('individual');
  b.opening([['現金', 50000]]);
  const journals = [b.j('2026-01-05', [['現金', 10000]], [['売上高', 10000]], '売上'), b.j('2026-01-20', [['消耗品費', 3000]], [['現金', 3000]], '文具'), b.j('2026-02-03', [['現金', 5000]], [['売上高', 5000]], '売上')];
  const lg = generalLedger({ accountId: b.byName['現金'].id, accounts: b.accounts, period: b.period, journals });
  const doc = ledgerBookDoc([lg], { head: { company: 'x' }, carriedLabel: '前期繰越' });
  assert.equal(doc.blocks[0].type, 'heading');
  assert.ok(doc.blocks[0].caption);
  assert.match(doc.blocks[0].text, /現金（借方残）$/);
  const rows = doc.blocks[1].rows;
  assert.equal(rows[0].cells[2].text, '前期繰越');
  assert.equal(rows[0].cells.at(-1), '50,000');
  const kinds = rows.map((r) => r.kind ?? (r.sum === false ? 'carried' : 'line'));
  assert.deepEqual(kinds, ['carried', 'line', 'line', 'subtotal', 'line', 'subtotal', 'total']);
  assert.equal(rows[3].cells[3].text, '1月計');
  assert.deepEqual(rows[3].cells.slice(5, 7), ['10,000', '3,000']);
  assert.deepEqual(rows.at(-1).cells.slice(1), [fmt(lg.debit), fmt(lg.credit), fmt(lg.closing)]);
  assert.equal(lg.closing, 62000);
  // 全科目：科目ごとに改ページ（見出しの数＝元帳の数）
  const all = generalLedgers({ accounts: b.accounts, period: b.period, journals });
  const pages = layoutDocument(ledgerBookDoc(all, { head: {}, carriedLabel: '前期繰越' }));
  assert.equal(pages.length, all.length);
  assert.deepEqual(splitSub('売上高（得意先A）'), ['売上高', '得意先A']);
  assert.deepEqual(splitSub('諸口'), ['諸口']);
});

test('残高試算表：貸借対照表と損益計算書の科目に分け、資産合計＝負債・資本合計、構成比は資産合計・売上高に対する割合', () => {
  const b = makeBook('corporation');
  b.opening([['現金', 100000], ['資本金', 100000]]);
  const journals = [b.j('2026-03-01', [['現金', 40000]], [['売上高', 40000]]), b.j('2026-03-02', [['消耗品費', 10000]], [['現金', 10000]])];
  const tb = trialBalance({ accounts: b.accounts, period: b.period, journals });
  const doc = trialBalanceDoc(tb, { head: {}, entityType: 'corporation', carriedLabel: '前期繰越' });
  const [, bsT, , plT] = doc.blocks;
  const find = (rows, label) => rows.find((r) => (typeof r.cells[0] === 'string' ? r.cells[0] : r.cells[0].text) === label);
  assert.equal(find(bsT.rows, '資産合計').cells[4], '130,000');
  assert.equal(find(bsT.rows, '資産合計').cells[5], '100.0%');
  assert.equal(find(bsT.rows, '純資産合計').cells[4], '100,000');
  assert.equal(find(plT.rows, '消耗品費').cells[5], '25.0%');
  assert.equal(find(plT.rows, '借方・貸方の合計').cells[2], fmt(tb.totals.debit));
  assert.equal(ratioText(1, 3), '33.3%');
  assert.equal(ratioText(-1, 8), '△12.5%');
  assert.equal(ratioText(5, 0), '');
});

test('決算書（報告式）：科目は左の列、区分の計と段階利益は右の列', () => {
  const b = makeBook('corporation');
  b.opening([['現金', 100000], ['資本金', 100000]]);
  const journals = [b.j('2026-03-01', [['現金', 40000]], [['売上高', 40000]]), b.j('2026-03-02', [['消耗品費', 10000]], [['現金', 10000]])];
  const { pl, bs } = buildStatements({ entityType: 'corporation', accounts: b.accounts, period: b.period, journals });
  const doc = statementDoc([{ caption: '', items: pl.items }], { head: {}, title: '損益計算書' });
  const rows = doc.blocks[0].rows;
  const line = rows.find((r) => r.cells[0].text === '消耗品費');
  assert.deepEqual(line.cells.slice(1), ['10,000', '']);
  const last = rows.at(-1);
  assert.equal(last.cells[2], '30,000');
  const bsDoc = statementDoc([{ caption: '資産の部', items: bs.assets }, { caption: '負債・純資産の部', items: bs.liabilities }], { head: {}, title: '貸借対照表' });
  assert.deepEqual(bsDoc.blocks.map((x) => x.type), ['heading', 'table', 'heading', 'table']);
  assert.ok(layoutDocument(bsDoc).length >= 1);
});

test('ブラウザの印刷：iPhone・iPad のホーム画面のアプリだけ使えない', () => {
  const iphone = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X)';
  assert.equal(browserPrintWorks({ standalone: true, userAgent: iphone }), false);
  assert.equal(browserPrintWorks({ standalone: false, userAgent: iphone }), true);
  assert.equal(browserPrintWorks({ displayModeStandalone: true, userAgent: 'Mozilla/5.0 (Macintosh)', maxTouchPoints: 5 }), false);
  assert.equal(browserPrintWorks({ displayModeStandalone: true, userAgent: 'Mozilla/5.0 (Windows NT 10.0)' }), true);
});

test('丸数字：㉑以上は (21) と書き、①〜⑳はそのまま', async () => {
  const { printable } = await import('../js/print-layout.js');
  assert.equal(printable('①㉑㉟㊱㊿'), '①(21)(35)(36)(50)');
});
