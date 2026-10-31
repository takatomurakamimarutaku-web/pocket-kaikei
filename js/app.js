// 起動処理
import { openDB, openDeviceStore } from './db.js';
import { needsLock } from './lock.js';
import { lockScreen, isLocked } from './views/lock-screen.js';
import { createRouter } from './router.js';
import { h, showToast, setAmountUnit, getAmountUnit } from './ui.js';
import { YEN_UNIT, unitCaption } from './money.js';
import { friendlyError } from './errors.js';
import { APP_VERSION } from './version.js';
import { isDesktopApp } from './install.js';
import { renderSidebar } from './sidebar.js';
import { formatPeriod, todayString, monthRange } from './period.js';
import { docHead, formLayoutBlocks } from './print-forms.js';
import { settlementHead } from './print-form-heads.js';
import { filerOf } from './filer.js';
import { captureBlocks, capturedRange } from './print-capture.js';
import { openPrintPreview } from './views/print-preview.js';
import * as setupView from './views/setup.js';
import * as lockSettingsView from './views/lock-settings.js';
import * as booksView from './views/books.js';
import * as homeView from './views/home.js';
import * as advisorHomeView from './views/advisor-home.js';
import * as advisorForecastView from './views/advisor-forecast.js';
import * as advisorTaxView from './views/advisor-tax.js';
import * as advisorSavingView from './views/advisor-saving.js';
import * as advisorSimulationView from './views/advisor-simulation.js';
import * as advisorAnnualView from './views/advisor-annual.js';
import * as advisorSuccessionView from './views/advisor-succession.js';
import * as advisorMeetingView from './views/advisor-meeting.js';
import * as journalsView from './views/journals.js';
import * as journalFormView from './views/journal-form.js';
import * as journalHistoryView from './views/journal-history.js';
import * as templatesView from './views/templates.js';
import * as checksView from './views/checks.js';
import * as analysisView from './views/analysis.js';
import * as cashFlowView from './views/cash-flow.js';
import * as budgetView from './views/budget.js';
import * as entryView from './views/entry.js';
import * as quickEntryView from './views/quick-entry.js';
import * as cashbookView from './views/cashbook.js';
import * as bankImportView from './views/bank-import.js';
import * as bankRulesView from './views/bank-rules.js';
import * as reportsView from './views/reports.js';
import * as ledgerView from './views/ledger.js';
import * as subLedgerView from './views/sub-ledger.js';
import * as findView from './views/find.js';
import * as trialView from './views/trial.js';
import * as monthlyView from './views/monthly.js';
import * as trialMonthlyView from './views/trial-monthly.js';
import * as statementsView from './views/statements.js';
import * as manufacturingView from './views/manufacturing.js';
import * as taxView from './views/tax.js';
import * as taxReturnView from './views/tax-return.js';
import * as blueReturnView from './views/blue-return.js';
import * as realEstateView from './views/real-estate.js';
import * as whiteReturnView from './views/white-return.js';
import * as breakdownView from './views/breakdown.js';
import * as financialView from './views/financial.js';
import * as propertyTaxView from './views/property-tax.js';
import * as schedule16View from './views/schedule16.js';
import * as schedule13View from './views/schedule13.js';
import * as enterpriseTaxView from './views/enterprise-tax.js';
import * as corporateTaxView from './views/corporate-tax.js';
import * as corporateTaxInputView from './views/corporate-tax-input.js';
import * as incomeTaxView from './views/income-tax.js';
import * as moreView from './views/more.js';
import * as settingsView from './views/settings.js';
import * as accountsView from './views/accounts.js';
import * as accountEditView from './views/account-edit.js';
import * as openingView from './views/opening.js';
import * as backupView from './views/backup.js';
import * as ebookView from './views/e-book.js';
import * as changelogView from './views/changelog.js';
import * as attachmentsView from './views/attachments.js';
import * as transferView from './views/transfer.js';
import * as receivablesView from './views/receivables.js';
import * as periodsView from './views/periods.js';
import * as closingView from './views/closing.js';
import * as assetsView from './views/assets.js';
import * as assetFormView from './views/asset-form.js';
import * as assetDisposeView from './views/asset-dispose.js';
import * as departmentsView from './views/departments.js';
import * as departmentPlView from './views/department-pl.js';
import * as invoicesView from './views/invoices.js';
import * as invoiceFormView from './views/invoice-form.js';
import * as invoiceView from './views/invoice-view.js';
import * as invoiceSettingsView from './views/invoice-settings.js';
import * as filerView from './views/filer.js';
import * as payrollView from './views/payroll.js';
import * as payrollFormView from './views/payroll-form.js';
import * as payrollSlipView from './views/payroll-view.js';
import * as payrollSettingsView from './views/payroll-settings.js';
import * as payrollPaymentsView from './views/payroll-payments.js';
import * as withholdingSlipsView from './views/withholding-slips.js';
import * as withholdingSlipView from './views/withholding-slip.js';
import * as yearEndView from './views/year-end.js';
import * as yearEndFormView from './views/year-end-form.js';
import * as employeesView from './views/employees.js';
import * as employeeFormView from './views/employee-form.js';

// back: 戻るボタンを表示し、アプリ内の履歴が無いときに戻る先。print: ヘッダーに印刷（PDF 保存）ボタンを出す
// （true：帳票の様式の印刷プレビュー、'browser'：画面そのものが用紙の形なのでブラウザの印刷）。form：申告書の様式に組み替える
const routes = [
  { path: '/setup', view: setupView, title: '初期設定', tab: null, setup: true },
  { path: '/home', view: homeView, title: 'ホーム', tab: 'home' },
  // 経営サポート（会計のホームと「会計｜経営」で切り替える）
  { path: '/advisor', view: advisorHomeView, title: '経営サポート', tab: 'home' },
  { path: '/advisor/forecast', view: advisorForecastView, title: '着地見込み', tab: 'home', back: '#/advisor', print: true },
  { path: '/advisor/tax', view: advisorTaxView, title: '納税予測', tab: 'home', back: '#/advisor', print: true },
  { path: '/advisor/saving', view: advisorSavingView, title: '節税・税制の提案', tab: 'home', back: '#/advisor', print: true },
  { path: '/advisor/simulation', view: advisorSimulationView, title: '利益シミュレーション', tab: 'home', back: '#/advisor', print: true },
  { path: '/advisor/annual', view: advisorAnnualView, title: '年計（移動年計）', tab: 'home', back: '#/advisor', print: true },
  { path: '/advisor/meeting', view: advisorMeetingView, title: '決算検討会の資料', tab: 'home', back: '#/advisor', print: true },
  { path: '/advisor/succession', view: advisorSuccessionView, title: '事業承継：自社株の評価（概算）', tab: 'home', back: '#/advisor', print: true },
  { path: '/journals', view: journalsView, title: '仕訳帳', tab: 'journals', print: true },
  { path: '/journals/history', view: journalHistoryView, title: '訂正・削除の履歴', tab: 'journals', back: '#/journals', print: true },
  { path: '/entry', view: entryView, title: '入力', tab: 'entry' },
  { path: '/quick/:kind', view: quickEntryView, title: 'かんたん入力', tab: 'entry', back: '#/entry' },
  { path: '/cashbook', view: cashbookView, title: '出納帳', tab: 'entry', back: '#/entry', print: true },
  { path: '/import/bank', view: bankImportView, title: '銀行明細の取り込み', tab: 'entry', back: '#/entry' },
  { path: '/import/bank/rules', view: bankRulesView, title: '振り分けルール', tab: 'entry', back: '#/import/bank' },
  { path: '/import/card', view: bankImportView, kind: 'card', title: 'カード明細の取り込み', tab: 'entry', back: '#/entry' },
  { path: '/journal/new', view: journalFormView, title: '振替伝票の入力', tab: 'entry', back: '#/entry' },
  { path: '/journal/:id/edit', view: journalFormView, title: '仕訳の編集', tab: 'journals', back: '#/journals' },
  { path: '/invoices', view: invoicesView, title: '請求書・見積書', tab: 'entry', back: '#/entry' },
  { path: '/invoices/settings', view: invoiceSettingsView, title: '請求書の設定', tab: 'entry', back: '#/invoices' },
  { path: '/invoices/new', view: invoiceFormView, title: '請求書・見積書の作成', tab: 'entry', back: '#/invoices' },
  { path: '/invoices/:id/edit', view: invoiceFormView, title: '請求書・見積書の編集', tab: 'entry', back: '#/invoices' },
  { path: '/invoices/:id', view: invoiceView, title: '請求書・見積書', tab: 'entry', back: '#/invoices', print: 'browser' },
  { path: '/payroll', view: payrollView, title: '給与計算', tab: 'entry', back: '#/entry' },
  { path: '/payroll/settings', view: payrollSettingsView, title: '給与の設定', tab: 'entry', back: '#/payroll' },
  { path: '/payroll/payments', view: payrollPaymentsView, title: '税・保険料の納付', tab: 'entry', back: '#/payroll' },
  { path: '/payroll/year-end', view: yearEndView, title: '年末調整', tab: 'entry', back: '#/payroll' },
  { path: '/payroll/year-end/new', view: yearEndFormView, title: '年末調整の入力', tab: 'entry', back: '#/payroll/year-end' },
  { path: '/payroll/year-end/:id', view: yearEndFormView, title: '年末調整', tab: 'entry', back: '#/payroll/year-end' },
  { path: '/payroll/slips', view: withholdingSlipsView, title: '源泉徴収票・給与支払報告書', tab: 'entry', back: '#/payroll' },
  { path: '/payroll/slips/:id', view: withholdingSlipView, title: '源泉徴収票', tab: 'entry', back: '#/payroll/slips', print: 'browser' },
  { path: '/payroll/employees', view: employeesView, title: '従業員', tab: 'entry', back: '#/payroll' },
  { path: '/payroll/employees/new', view: employeeFormView, title: '従業員の登録', tab: 'entry', back: '#/payroll/employees' },
  { path: '/payroll/employees/:id', view: employeeFormView, title: '従業員', tab: 'entry', back: '#/payroll/employees' },
  { path: '/payroll/new', view: payrollFormView, title: '給与・賞与の入力', tab: 'entry', back: '#/payroll' },
  { path: '/payroll/:id/edit', view: payrollFormView, title: '給与・賞与の編集', tab: 'entry', back: '#/payroll' },
  { path: '/payroll/:id', view: payrollSlipView, title: '給与明細', tab: 'entry', back: '#/payroll', print: 'browser' },
  { path: '/templates', view: templatesView, title: '定型仕訳', tab: 'entry', back: '#/entry' },
  { path: '/template/new', view: journalFormView, kind: 'template', title: '定型仕訳の登録', tab: 'entry', back: '#/templates' },
  { path: '/template/:id', view: journalFormView, kind: 'template', title: '定型仕訳の編集', tab: 'entry', back: '#/templates' },
  { path: '/reports', view: reportsView, title: '帳票', tab: 'reports' },
  { path: '/reports/ledger', view: ledgerView, title: '総勘定元帳', tab: 'reports', back: '#/reports', print: true },
  { path: '/reports/sub-ledger', view: subLedgerView, title: '補助元帳', tab: 'reports', back: '#/reports', print: true },
  { path: '/reports/search', view: findView, title: '摘要・科目の検索', tab: 'reports', back: '#/reports' },
  { path: '/receivables', view: receivablesView, title: '売掛金・買掛金', tab: 'reports', back: '#/reports', print: true },
  { path: '/receivables/party', view: receivablesView, kind: 'party', title: '取引先', tab: 'reports', back: '#/receivables' },
  { path: '/reports/checks', view: checksView, title: '仕訳のチェック', tab: 'reports', back: '#/reports', print: true },
  { path: '/reports/trial', view: trialView, title: '残高試算表', tab: 'reports', back: '#/reports', print: true },
  { path: '/reports/trial-monthly', view: trialMonthlyView, title: '月次推移試算表', tab: 'reports', back: '#/reports', print: true },
  { path: '/reports/monthly', view: monthlyView, title: '月次推移表', tab: 'reports', back: '#/reports', print: true },
  { path: '/reports/departments', view: departmentPlView, title: '部門別損益', tab: 'reports', back: '#/reports', print: true },
  { path: '/reports/pl', view: statementsView, kind: 'pl', title: '損益計算書', tab: 'reports', back: '#/reports', print: true },
  { path: '/reports/manufacturing', view: manufacturingView, title: '製造原価報告書', tab: 'reports', back: '#/reports', print: true },
  { path: '/reports/cash-flow', view: cashFlowView, kind: 'statement', title: 'キャッシュフロー計算書', tab: 'reports', back: '#/reports', print: true },
  { path: '/reports/cash-plan', view: cashFlowView, kind: 'plan', title: '資金繰り表', tab: 'reports', back: '#/reports', print: true },
  { path: '/reports/budget', view: budgetView, kind: 'report', title: '予算と実績', tab: 'reports', back: '#/reports', print: true },
  { path: '/budget', view: budgetView, kind: 'edit', title: '予算の入力', tab: 'reports', back: '#/reports/budget' },
  { path: '/reports/analysis', view: analysisView, title: '経営分析', tab: 'reports', back: '#/reports', print: true },
  { path: '/reports/bs', view: statementsView, kind: 'bs', title: '貸借対照表', tab: 'reports', back: '#/reports', print: true },
  { path: '/reports/tax', view: taxView, title: '消費税集計', tab: 'reports', back: '#/reports', print: true },
  { path: '/reports/tax-return', view: taxReturnView, title: '消費税の申告計算', tab: 'reports', back: '#/reports', print: true },
  { path: '/reports/blue-return', view: blueReturnView, title: '青色申告決算書', tab: 'reports', back: '#/reports', print: true, form: true },
  { path: '/reports/blue-return-re', view: realEstateView, title: '青色申告決算書（不動産所得用）', tab: 'reports', back: '#/reports', print: true, form: true },
  { path: '/reports/white-return', view: whiteReturnView, title: '収支内訳書', tab: 'reports', back: '#/reports', print: true, form: true },
  { path: '/reports/financial', view: financialView, title: '決算書', tab: 'reports', back: '#/reports', print: true },
  { path: '/reports/income-tax', view: incomeTaxView, title: '所得税の確定申告書', tab: 'reports', back: '#/reports', print: true },
  { path: '/reports/corporate-tax', view: corporateTaxView, title: '法人税の申告', tab: 'reports', back: '#/reports', print: true },
  { path: '/reports/corporate-tax/input', view: corporateTaxInputView, title: '法人税の計算の条件', tab: 'reports', back: '#/reports/corporate-tax' },
  { path: '/reports/enterprise-tax', view: enterpriseTaxView, title: '事業税', tab: 'reports', back: '#/reports', print: true },
  { path: '/reports/property-tax', view: propertyTaxView, title: '償却資産申告書', tab: 'reports', back: '#/reports', print: true },
  { path: '/reports/schedule16', view: schedule16View, title: '別表十六（減価償却の明細書）', tab: 'reports', back: '#/reports', print: true },
  { path: '/reports/schedule13', view: schedule13View, title: '別表十三（一）（国庫補助金等の圧縮額）', tab: 'reports', back: '#/reports', print: true },
  { path: '/reports/breakdown', view: breakdownView, title: '勘定科目内訳明細書', tab: 'reports', back: '#/reports', print: true },
  { path: '/more', view: moreView, title: 'その他', tab: 'more' },
  { path: '/settings', view: settingsView, title: '事業者の設定', tab: 'more', back: '#/more' },
  { path: '/settings/filer', view: filerView, title: '申告書の提出者', tab: 'more', back: '#/settings' },
  { path: '/books', view: booksView, title: '事業所の切替', tab: 'more', back: '#/more' },
  { path: '/lock', view: lockSettingsView, title: '画面ロック', tab: 'more', back: '#/more' },
  { path: '/accounts', view: accountsView, title: '勘定科目', tab: 'more', back: '#/more' },
  { path: '/account/new', view: accountEditView, title: '科目の追加', tab: 'more', back: '#/accounts' },
  { path: '/account/:id', view: accountEditView, title: '科目の編集', tab: 'more', back: '#/accounts' },
  { path: '/departments', view: departmentsView, title: '部門', tab: 'more', back: '#/more' },
  { path: '/opening', view: openingView, title: '期首残高', tab: 'more', back: '#/more' },
  { path: '/periods', view: periodsView, title: '会計期間', tab: 'more', back: '#/more' },
  { path: '/closing', view: closingView, title: '決算・繰越', tab: 'more', back: '#/more' },
  { path: '/assets', view: assetsView, title: '固定資産台帳', tab: 'more', back: '#/more', print: true },
  { path: '/asset/new', view: assetFormView, title: '固定資産の登録', tab: 'more', back: '#/assets' },
  { path: '/asset/:id', view: assetFormView, title: '固定資産の編集', tab: 'more', back: '#/assets' },
  { path: '/asset/:id/dispose', view: assetDisposeView, title: '固定資産の売却・除却', tab: 'more', back: '#/assets' },
  { path: '/backup', view: backupView, title: 'バックアップ', tab: 'more', back: '#/more' },
  { path: '/changelog', view: changelogView, title: '更新履歴', tab: 'more', back: '#/more' },
  { path: '/e-book', view: ebookView, title: '電子帳簿保存', tab: 'more', back: '#/more', print: true },
  { path: '/attachments', view: attachmentsView, title: '証憑の一覧', tab: 'more', back: '#/more' },
  { path: '/transfer', view: transferView, title: '会計ソフトとの受け渡し', tab: 'more', back: '#/more' },
];

const outlet = document.getElementById('view');
const titleEl = document.getElementById('title');
const backBtn = document.getElementById('back');
const headerEl = document.querySelector('.app-header');
const tabbar = document.querySelector('.tabbar');
const sidebar = document.getElementById('sidebar');
const printBtn = document.getElementById('print');
const printHead = document.getElementById('print-head');

async function start() {
  // 起動できた印（js/boot-guard.js が見る）
  document.documentElement.setAttribute('data-started', '');
  let db, device, book, lock;
  try {
    // 帳簿の一覧と画面ロックは端末の設定（帳簿とは別のデータベース）。今の帳簿のデータベースを開く
    device = await openDeviceStore();
    book = await device.currentBook();
    lock = await device.getLock();
    db = await openDB({ name: book.dbName });
  } catch (e) {
    outlet.replaceChildren(errorView(friendlyError(e, 'データを開くことが')));
    return;
  }
  let current = null;

  /** パスコードを忘れたとき：すべての帳簿と端末の設定を消して初期設定から */
  async function eraseEverything() {
    db.close();
    await device.eraseAll();
    history.replaceState(null, '', '#/setup');
    location.reload();
  }
  const lockNow = () => (lock ? lockScreen({ device, lock, onErase: eraseEverything }) : Promise.resolve());

  const app = {
    db,
    device,
    book,
    lock: lockNow,
    /** 画面ロックの設定を変えたあとに読み直す */
    refreshLock: async () => {
      lock = await device.getLock();
    },
    /** 事業所（帳簿）を切り替える（今の帳簿のデータベースを閉じて、切り替えた帳簿のデータベースを開く） */
    switchBook: async (id, hash = '#/home') => {
      const next = await device.switchBook(id);
      const nextDb = await openDB({ name: next.dbName });
      db.close();
      db = nextDb;
      app.db = nextDb;
      app.book = next;
      await fillAccountHints(db);
      if (location.hash === hash) router.refresh();
      else router.navigate(hash, { replace: true });
    },
    navigate: (hash, opts) => router.navigate(hash, opts),
    goBack: (fallback) => router.goBack(fallback),
    refresh: () => router.refresh(),
    setTitle: (t) => {
      titleEl.textContent = t;
      document.title = `${t} | Pocket会計`;
    },
    /**
     * 画面で使うデータをまとめて読む（第1弾は件数が少ない前提で、画面ごとに読み直す）
     * @returns {{ settings, period, accounts, subAccounts, journals, departments, accountById, subById, departmentById }}
     */
    async load() {
      const settings = await db.getSettings();
      const period = await db.getCurrentPeriod();
      const [accounts, subAccounts, journals, departments] = await Promise.all([db.listAccounts(), db.listSubAccounts(), period ? db.listJournals(period.id) : [], db.listDepartments()]);
      return {
        settings,
        period,
        accounts,
        subAccounts,
        journals,
        departments,
        accountById: new Map(accounts.map((a) => [a.id, a])),
        subById: new Map(subAccounts.map((s) => [s.id, s])),
        departmentById: new Map(departments.map((d) => [d.id, d])),
      };
    },
  };

  const router = createRouter({
    routes,
    defaultHash: '#/home',
    onRoute: async ({ route, params, query }, isStale) => {
      // 初期設定が済んでいなければ、初期設定の画面へ
      const settings = await db.getSettings().catch(() => null);
      if (!settings && !route.setup) {
        router.navigate('#/setup', { replace: true });
        return null;
      }
      if (settings && route.setup) {
        router.navigate('#/home', { replace: true });
        return null;
      }
      // 事業所の一覧に出す名前（事業者名）と個人・法人の別を覚えておく
      if (settings && (settings.businessName !== app.book.label || settings.entityType !== app.book.entityType)) {
        device
          .setBookInfo(app.book.id, { label: settings.businessName, entityType: settings.entityType })
          .then((b) => b && (app.book = b))
          .catch(() => {});
      }
      current = route;
      app.leaveGuard = null;
      app.printDoc = null;
      // 金額の表示単位は画面ごと。集計の帳票は画面を組むときに選んだ単位を設定し直す（report-common.js の unitPicker）
      setAmountUnit(YEN_UNIT);
      app.setTitle(route.title);
      backBtn.hidden = !route.back;
      printBtn.hidden = !route.print;
      if (route.print) fillPrintHead(route.title).catch(() => {});
      headerEl.classList.toggle('is-root', !route.back);
      tabbar.hidden = Boolean(route.setup);
      sidebar.hidden = Boolean(route.setup);
      if (settings) {
        db.getCurrentPeriod()
          .then((period) => !isStale() && renderSidebar(sidebar, { settings, period, hash: location.hash }))
          .catch(() => {});
      }
      // PC 幅の画面は、画面ごとに幅や並べ方を変える（css/desktop.css）
      outlet.dataset.route = route.path;
      for (const a of document.querySelectorAll('.tabbar a')) {
        if (a.dataset.tab === route.tab) a.setAttribute('aria-current', 'page');
        else a.removeAttribute('aria-current');
      }
      outlet.replaceChildren(h('p', { class: 'loading', text: '読み込み中…' }));
      window.scrollTo(0, 0);
      outlet.classList.remove('view-enter');
      try {
        const result = await route.view.render({ app, outlet, params, query, route, isStale });
        if (!isStale()) {
          void outlet.offsetWidth;
          outlet.classList.add('view-enter');
        }
        return result;
      } catch (e) {
        console.error(e);
        if (!isStale()) outlet.replaceChildren(errorView(friendlyError(e, '画面を表示')));
        return null;
      }
    },
  });

  const onScroll = () => headerEl.classList.toggle('is-scrolled', window.scrollY > 4);
  window.addEventListener('scroll', onScroll, { passive: true });

  // 印刷：帳票の様式で組んだ印刷プレビュー（PDF の保存・共有と印刷）を開く。
  // 画面が app.printDoc を用意していればその様式（仕訳帳・元帳など）、無ければ画面の表から作る。
  // 請求書・給与明細・源泉徴収票は画面そのものが用紙の形なので、ブラウザの印刷を使う（print: 'browser'）
  printBtn.addEventListener('click', async () => {
    const route = current;
    if (!route) return;
    if (route.print === 'browser') return window.print();
    try {
      const [settings, period] = await Promise.all([db.getSettings(), db.getCurrentPeriod()]);
      const printedAt = todayString();
      const range = period ? capturedRange(outlet) : null;
      const { from, to } = range ? monthRange(period, range.fromMonth, range.toMonth) : period ? { from: period.startDate, to: period.endDate } : {};
      const head = period ? docHead({ settings, period, from, to, printedAt }) : { company: settings?.businessName || '', printedAt };
      const custom = app.printDoc ? await app.printDoc({ settings, period, printedAt, head }) : null;
      const fileName = `${route.title}_${printedAt}`.replace(/[\\/:*?"<>|\s]+/g, '');
      // 印刷条件を選べる帳票（仕訳帳・元帳・試算表・決算書など）
      if (custom?.build) return openPrintPreview(custom, { fileName });
      // そのほか：画面の表から作る（用紙の向きを選べる）
      // 画面の表から作るときは、画面で選んだ金額の単位を右上に書く（金額は画面の表示のまま）
      const doc = { title: route.title, ...head, unit: unitCaption(getAmountUnit()), orientation: 'auto', ...(custom?.blocks ? {} : captureBlocks(outlet)), ...custom };
      // 申告書の様式（青色申告決算書・収支内訳書）：欄を3列のマス目に、貸借対照表を勘定式に組み替える
      if (route.form) doc.blocks = formLayoutBlocks(doc.blocks);
      // 申告書の頭書き（提出者の欄）：最初のページの表題の下に置く。決算書の様式は住所・氏名・業種名などの欄
      const headBlocks = custom?.headBlocks ?? (route.form ? [settlementHead(filerOf(settings))] : []);
      if (headBlocks.length) {
        const at = doc.blocks[0]?.type === 'heading' && doc.blocks[0].caption ? 1 : 0;
        doc.blocks = [...doc.blocks.slice(0, at), ...headBlocks, ...doc.blocks.slice(at)];
      }
      delete doc.headBlocks;
      if (!doc.blocks.length) return showToast('印刷する内容がありません');
      openPrintPreview(
        { options: [{ key: 'orientation', label: '用紙の向き', type: 'select', choices: [['auto', '自動（表の幅で決める）'], ['portrait', 'A4縦'], ['landscape', 'A4横']], value: 'auto' }], build: (v) => ({ ...doc, orientation: v.orientation }) },
        { fileName },
      );
    } catch (e) {
      console.error(e);
      showToast('印刷用の帳票を作れませんでした');
    }
  });
  // 印刷の見出し：事業者名・帳票名・会計期間・印刷日（画面には出さない）
  async function fillPrintHead(title) {
    const [settings, period] = await Promise.all([db.getSettings(), db.getCurrentPeriod()]);
    printHead.replaceChildren(
      h('p', { class: 'print-title', text: title }),
      h('p', { text: [settings?.businessName, period ? formatPeriod(period) : ''].filter(Boolean).join('　') }),
      h('p', { text: `印刷日 ${todayString().replaceAll('-', '/')}` }),
    );
  }

  backBtn.addEventListener('click', () => leaveIfAllowed(() => router.goBack(current?.back)));
  // 入力途中の画面から、タブ・リンクで離れるときに確認する
  document.addEventListener(
    'click',
    (e) => {
      const a = e.target.closest?.('a[href^="#"]');
      if (!a || !app.leaveGuard || a.getAttribute('href') === location.hash) return;
      e.preventDefault();
      leaveIfAllowed(() => router.navigate(a.getAttribute('href')));
    },
    true,
  );
  async function leaveIfAllowed(go) {
    if (app.leaveGuard && !(await app.leaveGuard())) return;
    app.leaveGuard = null;
    go();
  }

  await fillAccountHints(db);
  // 画面ロック：解除するまで帳簿の画面を出さない。裏に回った時間で自動ロックする
  await lockNow();
  let hiddenAt = null;
  document.addEventListener('visibilitychange', () => {
    if (!lock || isLocked()) return;
    if (document.visibilityState === 'hidden') {
      hiddenAt = Date.now();
      // 「すぐ」はアプリの切替画面に帳簿を出さないよう、裏に回ったときにロックする
      if (lock.timeout === 0) lockNow();
    } else {
      if (needsLock({ hiddenAt, now: Date.now(), timeout: lock.timeout })) lockNow();
      hiddenAt = null;
    }
  });
  router.start();
  requestPersistence();
  notifyUpdated(db);
}

/** エラー画面（何が起きたか・次にすること・再読み込み） */
function errorView({ message, hint, detail }) {
  return h(
    'div',
    { class: 'empty error-view', role: 'alert' },
    h('p', { class: 'error-title', text: message }),
    h('p', { class: 'small', text: hint }),
    h('button', { type: 'button', class: 'btn', text: '再読み込み', onclick: () => location.reload() }),
    detail ? h('p', { class: 'small muted error-detail', text: `詳細：${detail}` }) : null,
  );
}

/** 更新後の初回起動で、新しいバージョンになったことを知らせる */
async function notifyUpdated(db) {
  try {
    const seen = await db.getMeta('seenVersion');
    if (seen === APP_VERSION) return;
    await db.setMeta('seenVersion', APP_VERSION);
    if (!seen) return;
    // 更新履歴の画面で、前の版から新しくなった分に印を付けるために覚えておく
    await db.setMeta('updatedFrom', seen);
    showToast(`バージョン${APP_VERSION}に更新しました`, {
      duration: 8000,
      actionLabel: '内容を見る',
      onAction: () => (location.hash = `#/changelog?from=${encodeURIComponent(seen)}`),
    });
  } catch (e) {
    console.warn('seenVersion', e);
  }
}

/** 目印（hint）の導入前に作った科目に目印を補う（失敗しても使えるので止めない） */
async function fillAccountHints(db) {
  try {
    await db.fillAccountHints();
  } catch (e) {
    console.warn('fillAccountHints', e);
  }
}

/** 対応環境ではストレージの永続化を要求する（非対応・拒否でも止めない） */
async function requestPersistence() {
  try {
    if (navigator.storage?.persist && !(await navigator.storage.persisted())) await navigator.storage.persist();
  } catch (e) {
    console.warn('persist', e);
  }
}

// ---- Service Worker と更新の通知 ----

function registerServiceWorker() {
  if (!('serviceWorker' in navigator)) return;
  // Windows 版（exe）はファイルを同梱しているので Service Worker は使わない。更新は新しい exe を入れて行う
  if (isDesktopApp()) return;
  const banner = document.getElementById('update-banner');
  let updateRequested = false;
  let reloading = false;
  const showUpdate = (worker) => {
    banner.hidden = false;
    banner.querySelector('button').onclick = () => {
      banner.querySelector('button').disabled = true;
      updateRequested = true;
      worker.postMessage({ type: 'SKIP_WAITING' });
    };
  };
  // 初回インストール時の clients.claim() でも発火するため、［更新］を押した場合だけ再読み込みする
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (!updateRequested || reloading) return;
    reloading = true;
    location.reload();
  });
  navigator.serviceWorker
    .register('sw.js')
    .then((reg) => {
      if (reg.waiting && navigator.serviceWorker.controller) showUpdate(reg.waiting);
      reg.addEventListener('updatefound', () => {
        const w = reg.installing;
        if (!w) return;
        w.addEventListener('statechange', () => {
          if (w.state === 'installed' && navigator.serviceWorker.controller) showUpdate(w);
        });
      });
      document.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'visible') reg.update().catch(() => {});
      });
    })
    .catch((e) => {
      console.warn('SW登録に失敗', e);
      if (location.protocol === 'https:') showToast('オフライン機能を有効にできませんでした');
    });
}

registerServiceWorker();
start();
