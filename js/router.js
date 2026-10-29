// ハッシュルーティング

/** "#/beer/abc?x=1" を routes と照合して { route, params, query } を返す。純粋関数 */
export function matchRoute(hash, routes) {
  const raw = String(hash || '').replace(/^#/, '') || '/';
  const qi = raw.indexOf('?');
  const pathname = qi >= 0 ? raw.slice(0, qi) : raw;
  const query = Object.fromEntries(new URLSearchParams(qi >= 0 ? raw.slice(qi + 1) : ''));
  const segs = pathname.split('/').filter(Boolean);
  for (const route of routes) {
    const rs = route.path.split('/').filter(Boolean);
    if (rs.length !== segs.length) continue;
    const params = {};
    let ok = true;
    for (let i = 0; i < rs.length; i++) {
      if (rs[i].startsWith(':')) {
        try {
          params[rs[i].slice(1)] = decodeURIComponent(segs[i]);
        } catch {
          ok = false;
        }
      } else if (rs[i] !== segs[i]) {
        ok = false;
      }
      if (!ok) break;
    }
    if (ok) return { route, params, query };
  }
  return null;
}

/**
 * ルーターを作る。
 * 画面遷移はすべて location.hash の変更で行い、ブラウザの履歴に積む。
 * 各履歴エントリに history.state.depth（アプリ内での深さ）を記録し、
 * 戻るボタンは depth>0 なら history.back()、0 なら fallback へ置き換える。
 * これで iPhone のスワイプでの戻る操作とアプリ内の戻るボタンが同じ動きになる。
 */
export function createRouter({ routes, defaultHash, onRoute }) {
  let cleanup = null;
  let token = 0;
  let replacing = false;
  let currentDepth = 0;

  function syncDepth() {
    const st = history.state;
    if (st && typeof st.depth === 'number') {
      currentDepth = st.depth;
    } else {
      // 新しい履歴エントリ（置き換えの場合は深さを維持）
      currentDepth = replacing ? currentDepth : currentDepth + 1;
      history.replaceState({ depth: currentDepth }, '');
    }
    replacing = false;
  }

  async function resolve() {
    const match = matchRoute(location.hash, routes);
    if (!match) {
      navigate(defaultHash, { replace: true });
      return;
    }
    const my = ++token;
    if (cleanup) {
      try {
        cleanup();
      } catch (e) {
        console.error(e);
      }
      cleanup = null;
    }
    const result = await onRoute(match, () => my !== token);
    if (my !== token) {
      if (typeof result === 'function') result();
      return;
    }
    cleanup = typeof result === 'function' ? result : null;
  }

  function navigate(hash, { replace = false } = {}) {
    if (location.hash === hash) {
      resolve();
      return;
    }
    if (replace) {
      replacing = true;
      location.replace(hash);
    } else {
      location.hash = hash;
    }
  }

  function goBack(fallback = defaultHash) {
    if (currentDepth > 0) history.back();
    else navigate(fallback, { replace: true });
  }

  function start() {
    const st = history.state;
    currentDepth = st && typeof st.depth === 'number' ? st.depth : 0;
    if (!st || typeof st.depth !== 'number') history.replaceState({ depth: 0 }, '');
    window.addEventListener('hashchange', () => {
      syncDepth();
      resolve();
    });
    if (!location.hash) {
      history.replaceState({ depth: 0 }, '', defaultHash);
    }
    resolve();
  }

  return { start, navigate, goBack, refresh: resolve };
}
