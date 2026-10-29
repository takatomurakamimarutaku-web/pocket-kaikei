# Windows 版（exe）仕様（v0.24.0）

2026-10-29 たかとさんの選択で、PWA を Tauri v2 で包んだ Windows 用インストーラーを配布する（比較した案：PWA を PC にインストール／Tauri／Electron）。

## 構成
- `desktop/`：Tauri の外枠。アプリ本体のコードは持たない
  - `scripts/copy-web.js`：`sw.js` の `PRECACHE_URLS` に載っているファイルを `desktop/web/` に写す（`sw.js` 自体は写さない）
  - `src-tauri/src/main.rs`：ウィンドウ作成、外部サイトへの移動の禁止、ダウンロード時の保存ダイアログ
  - アイコンはビルド時に `icons/icon-512.png` から `tauri icon` で作る（main のアイコンが変われば exe も変わる）
- バージョンは `tauri.conf.json` から ルートの `package.json` を参照する

## 方針との関係
- 外部送信なし：Tauri の機能（IPC）は画面に一つも許可していない（`capabilities/default.json` が空）。CSP で外部への接続を禁じ、`on_navigation` でアプリ外の URL へは移動しない
- データ：WebView2 の IndexedDB（`%LOCALAPPDATA%\<identifier>\EBWebView`）。ブラウザ版とは別。受け渡しは既存のバックアップ JSON
- `identifier` を変えると保存場所が変わり、データが見えなくなるので変えない

## アプリ側の違い（`js/install.js` の `isDesktopApp()`）
- Service Worker を登録しない（ファイルは exe に同梱。更新は新しい exe を入れる）
- ホーム画面への追加の案内を出さない（インストール済みとして扱う）
- 保存は共有シートを使わず、`<a download>` → 保存ダイアログ（Windows 標準）

## 配布
- `.github/workflows/desktop.yml`（windows-latest）
  - PR（`desktop/**` の変更時）：ビルドしてインストーラーを Actions の成果物に置く
  - `v*` タグの push：Releases に下書きを作る。確認してから公開する
  - 手動実行（workflow_dispatch）：ビルドのみ
- インストーラーは NSIS、利用者ごとのインストール（管理者権限不要）。WebView2 が無い PC ではインストール時に取得する
- コード署名はしていないので SmartScreen の警告が出る

## 未確認
- Windows 実機でのインストール・保存ダイアログ・印刷（`window.print()`）・ファイル読込（バックアップ復元・銀行CSV）
- Linux（WebKitGTK）ではビルド・起動・初期設定の保存・再起動後のデータ保持を確認済み
