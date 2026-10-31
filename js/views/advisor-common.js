// 経営サポートの画面で共通に使う部品：会計｜経営の切替、着地見込みと納税予測の読み込み
import { h } from '../ui.js';
import { todayString } from '../period.js';
import { forecastLanding } from '../advisor/forecast.js';
import { forecastTaxes } from '../advisor/tax-forecast.js';
import { loadPrevious } from './report-common.js';

/** ホームの上の「会計｜経営」の切替（会計のホームと経営サポートのホームを行き来する） */
export function modeSwitch(current) {
  const link = (value, href, label) => h('a', { class: 'seg', href, role: 'radio', 'aria-checked': String(value === current), text: label });
  return h('nav', { class: 'segmented mode-switch', role: 'radiogroup', 'aria-label': '会計と経営の切替' }, link('books', '#/home', '会計'), link('advisor', '#/advisor', '経営'));
}

/** 試算であることの断り（画面と印刷の両方に出す） */
export function estimateNote() {
  return h('p', { class: 'muted small advisor-note', text: '帳簿と入力した見込みから求めた試算です。申告の金額は、決算を終えてから申告の画面で確かめてください。' });
}

/**
 * 着地見込みと納税予測をまとめて計算する
 * @returns {{ data, landing, taxes, previous, today, budgets, assets, periods }}
 */
export async function loadAdvisor(app) {
  const data = await app.load();
  const { settings, period, accounts, journals } = data;
  const [budgets, assets, periods, previous] = await Promise.all([app.db.listBudgets(period.id), app.db.listAssets(), app.db.listPeriods(), loadPrevious(app, period)]);
  const today = todayString();
  const landing = forecastLanding({ entityType: settings.entityType, accounts, period, journals, budgets, prev: previous, assets, periods, input: period.forecast || {}, today });
  const taxes = forecastTaxes({ settings, accounts, period, journals: landing.journals, actualJournals: journals });
  return { data, landing, taxes, previous, today, budgets, assets, periods };
}

/** 月の表示（2026-10 → 10月） */
export const monthLabel = (m) => `${Number(m.slice(5))}月`;
