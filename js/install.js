// ホーム画面への追加の判定（純粋関数）

/**
 * @param {{ standalone?: boolean, displayModeStandalone?: boolean, userAgent?: string, maxTouchPoints?: number }} env
 * @returns {'installed' | 'ios-browser' | 'browser'}
 *   installed：ホーム画面のアプリとして開いている、ios-browser：iPhone/iPad の Safari 等で開いている
 */
export function installState({ standalone, displayModeStandalone, userAgent = '', maxTouchPoints = 0 } = {}) {
  if (standalone === true || displayModeStandalone) return 'installed';
  // iPadOS の Safari は Mac と同じ UA を名乗るため、タッチ対応で見分ける
  const ios = /iPhone|iPad|iPod/.test(userAgent) || (/Macintosh/.test(userAgent) && maxTouchPoints > 1);
  return ios ? 'ios-browser' : 'browser';
}

/** 実行中の環境から判定する */
export function currentInstallState() {
  return installState({
    standalone: navigator.standalone,
    displayModeStandalone: typeof matchMedia === 'function' && matchMedia('(display-mode: standalone)').matches,
    userAgent: navigator.userAgent,
    maxTouchPoints: navigator.maxTouchPoints || 0,
  });
}
