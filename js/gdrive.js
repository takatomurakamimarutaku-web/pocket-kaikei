// Google ドライブとの通信（利用者が接続したときだけ使う）
// - ログイン：Google Identity Services のトークンモデル（ライブラリは接続ボタンを押したときに読み込む）
// - 権限：drive.file（このアプリが作ったファイルだけ。ドライブのほかのファイルは見えない）
//   出典：Google Drive API の「drive.file」スコープの説明（Google for Developers）
// - アクセストークンはメモリにだけ置き、端末に保存しない（有効期限は約1時間）
export const SYNC_FILE_NAME = 'pocket-kaikei-sync.json';
const SCOPE = 'https://www.googleapis.com/auth/drive.file';
const GIS_URL = 'https://accounts.google.com/gsi/client';
const API = 'https://www.googleapis.com/drive/v3';
const UPLOAD = 'https://www.googleapis.com/upload/drive/v3';

export class DriveError extends Error {
  constructor(message, status) {
    super(message);
    this.name = 'DriveError';
    this.status = status;
  }
}

let gisPromise = null;
function loadGis() {
  if (globalThis.google?.accounts?.oauth2) return Promise.resolve();
  gisPromise ||= new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = GIS_URL;
    s.async = true;
    s.onload = () => resolve();
    s.onerror = () => {
      gisPromise = null;
      reject(new DriveError('Googleのログイン画面を読み込めませんでした。通信状況を確認してください'));
    };
    document.head.append(s);
  });
  return gisPromise;
}

/**
 * Google ドライブの窓口。fetch を差し替えられる（テスト用）
 * @param {{ clientId: string, fetch?: Function }} opts
 */
export function createDrive({ clientId, fetch: fetchFn = (...a) => globalThis.fetch(...a) }) {
  let token = null;
  let expiresAt = 0;

  /** アクセストークン（期限切れならログイン画面を出す。ボタンを押した処理の中で呼ぶ） */
  async function getToken() {
    if (token && Date.now() < expiresAt - 60000) return token;
    await loadGis();
    return new Promise((resolve, reject) => {
      const client = globalThis.google.accounts.oauth2.initTokenClient({
        client_id: clientId,
        scope: SCOPE,
        callback: (res) => {
          if (res.error) return reject(new DriveError(res.error === 'access_denied' ? 'Googleドライブへのアクセスが許可されませんでした' : `Googleのログインに失敗しました（${res.error}）`));
          if (!globalThis.google.accounts.oauth2.hasGrantedAllScopes(res, SCOPE)) return reject(new DriveError('Googleドライブへのアクセスを許可してください'));
          token = res.access_token;
          expiresAt = Date.now() + Number(res.expires_in || 3600) * 1000;
          resolve(token);
        },
        error_callback: (err) => reject(new DriveError(err?.type === 'popup_closed' ? 'ログインの画面が閉じられました' : 'Googleのログイン画面を開けませんでした')),
      });
      client.requestAccessToken({ prompt: '' });
    });
  }

  async function call(url, init = {}) {
    const t = await getToken();
    const res = await fetchFn(url, { ...init, headers: { ...(init.headers || {}), Authorization: `Bearer ${t}` } });
    if (res.status === 401) {
      token = null;
      throw new DriveError('Googleのログインの期限が切れました。もう一度同期してください', 401);
    }
    if (!res.ok) throw new DriveError(`Googleドライブとの通信に失敗しました（${res.status}）`, res.status);
    return res;
  }

  return {
    getToken,
    /** ログインの部品を先に読み込む（ボタンを押してからポップアップを開くまでを短くするため） */
    preload: () => loadGis().catch(() => {}),
    /** 同期ファイルを探す（このアプリが作ったファイルだけが見える） */
    async findFile() {
      const q = encodeURIComponent(`name = '${SYNC_FILE_NAME}' and trashed = false`);
      const res = await call(`${API}/files?q=${q}&spaces=drive&fields=files(id,modifiedTime)&orderBy=modifiedTime desc`);
      const { files } = await res.json();
      return files?.[0] || null;
    },
    async getMeta(id) {
      const res = await call(`${API}/files/${encodeURIComponent(id)}?fields=id,modifiedTime`);
      return res.json();
    },
    async download(id) {
      const res = await call(`${API}/files/${encodeURIComponent(id)}?alt=media`);
      return res.text();
    },
    async create(text) {
      const boundary = `pk${Math.random().toString(36).slice(2)}`;
      const body = [
        `--${boundary}`,
        'Content-Type: application/json; charset=UTF-8',
        '',
        JSON.stringify({ name: SYNC_FILE_NAME, mimeType: 'application/json' }),
        `--${boundary}`,
        'Content-Type: application/json; charset=UTF-8',
        '',
        text,
        `--${boundary}--`,
      ].join('\r\n');
      const res = await call(`${UPLOAD}/files?uploadType=multipart&fields=id,modifiedTime`, { method: 'POST', headers: { 'Content-Type': `multipart/related; boundary=${boundary}` }, body });
      return res.json();
    },
    async update(id, text) {
      const res = await call(`${UPLOAD}/files/${encodeURIComponent(id)}?uploadType=media&fields=id,modifiedTime`, { method: 'PATCH', headers: { 'Content-Type': 'application/json; charset=UTF-8' }, body: text });
      return res.json();
    },
    /** 接続の解除（トークンを取り消す） */
    async revoke() {
      if (!token) return;
      const t = token;
      token = null;
      if (globalThis.google?.accounts?.oauth2?.revoke) globalThis.google.accounts.oauth2.revoke(t, () => {});
    },
  };
}
