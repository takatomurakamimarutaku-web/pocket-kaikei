// エラーを利用者向けの日本語にする（純粋関数）

/**
 * @param {unknown} e 発生したエラー
 * @param {string} action 何をしようとして失敗したか（例：「保存」）
 * @returns {{ message: string, hint: string, detail: string }}
 *   message：何が起きたか、hint：次にすること、detail：問い合わせ用の短い技術情報
 */
export function friendlyError(e, action = '処理') {
  const name = (e && typeof e === 'object' && e.name) || '';
  const raw = (e && typeof e === 'object' && e.message) || String(e ?? '');
  const detail = [name, raw].filter(Boolean).join(': ').slice(0, 200);
  if (name === 'QuotaExceededError' || /quota/i.test(raw)) {
    return {
      message: `端末の空き容量が足りないため、${action}できませんでした。`,
      hint: '写真の多い記録を整理するか、iPhoneの空き容量を増やしてから、もう一度お試しください。先にバックアップを作成しておくと安心です。',
      detail,
    };
  }
  if (name === 'InvalidStateError' || name === 'UnknownError' || /database|indexeddb|connection/i.test(raw)) {
    return {
      message: `データの読み書きで問題が起きたため、${action}できませんでした。`,
      hint: 'アプリをいったん閉じて開き直してください。直らない場合は、設定からバックアップを作成してください。',
      detail,
    };
  }
  if (name === 'NotAllowedError' || name === 'SecurityError') {
    return {
      message: `端末の設定で許可されていないため、${action}できませんでした。`,
      hint: 'プライベートブラウズを使っている場合は、通常のモードかホーム画面のアプリで開いてください。',
      detail,
    };
  }
  if (name === 'TypeError' && /fetch|network|load failed/i.test(raw)) {
    return {
      message: `通信できなかったため、${action}できませんでした。`,
      hint: '電波の良い場所で、もう一度お試しください。',
      detail,
    };
  }
  return {
    message: `予期しない問題が起きたため、${action}できませんでした。`,
    hint: 'もう一度お試しください。繰り返す場合は、アプリを開き直してください。',
    detail,
  };
}

/** トースト用の1行（message と hint を続けたもの） */
export function errorText(e, action) {
  const f = friendlyError(e, action);
  return `${f.message}${f.hint}`;
}
