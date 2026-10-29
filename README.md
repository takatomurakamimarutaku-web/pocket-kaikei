# Pocket会計（ポケットかいけい）

スマートフォンで使う複式簿記の会計アプリ（PWA）です。個人事業主（青色申告）と法人の両方に対応します。
HTML / CSS / JavaScript（ES Modules）だけで作られており、ビルドは不要です。
データはすべて端末のブラウザ内（IndexedDB）に保存され、外部には送信されません。

## 使い方

1. GitHub Pages で公開した URL を iPhone の Safari で開く
2. 共有ボタン →「ホーム画面に追加」でアプリとしてインストールする
   - Safari で開いたときとホーム画面のアプリでは、データの保存場所が別になります。ホーム画面のアプリで使ってください
3. 初期設定で事業者名・個人/法人・会計期間・課税/免税を選ぶ
4. 「その他」→「期首残高」「勘定科目」（補助科目）を整える
5. 「＋入力」で振替伝票形式の仕訳を入力する（複合仕訳・税区分・摘要の候補・貸借差額の表示・複製）
6. 「帳票」で残高試算表・総勘定元帳・損益計算書・貸借対照表・消費税集計を見る
7. 「その他」→「バックアップ」で定期的に書き出す（端末間の受け渡しもこのファイルで行います）

## Windows 版（exe）

PC では Windows 用のアプリ（exe）でも使えます。中身はこの PWA と同じファイルで、[Tauri](https://tauri.app/) で包んでいます。

1. [Releases](https://github.com/takatomurakamimarutaku-web/pocket-kaikei/releases) から `Pocket会計_x.y.z_x64-setup.exe` をダウンロードして実行する（管理者権限は不要）
2. 署名していないため「WindowsによってPCが保護されました」と出たら、「詳細情報」→「実行」で進める
3. データはこの PC の中（`%LOCALAPPDATA%\io.github.takatomurakamimarutaku-web.pocket-kaikei`）だけに保存されます。ブラウザ版やスマホとはバックアップファイル（JSON）で受け渡してください
4. 新しい版は Releases から入れ直すと上書きされ、データは引き継がれます

ビルドは GitHub Actions（`.github/workflows/desktop.yml`）で行います。`v0.24.0` のようなタグを push すると Releases に下書きができるので、確認してから公開します。詳細は `docs/spec-phase2-windows.md`。

## 画面

| ハッシュ | 画面 |
|---|---|
| `#/setup` | 初期設定 |
| `#/home` | ホーム（当期の概要・バックアップの催促） |
| `#/journals?month=YYYY-MM&q=` | 仕訳帳（月別・検索・CSV 出力） |
| `#/journal/new`（`?copy=:id` で複製）、`#/journal/:id/edit` | 仕訳の入力・編集 |
| `#/reports` | 帳票メニュー |
| `#/reports/trial`、`/ledger`、`/pl`、`/bs`、`/tax` | 試算表・元帳・PL・BS・消費税集計（`from`・`to` で月範囲） |
| `#/more`、`#/settings`、`#/accounts`、`#/account/:id`、`#/opening`、`#/backup` | 設定・科目・期首残高・バックアップ |

## 開発

```
npm install
npm test               # 単体テスト（node --test）
npm run check          # PWA 構成チェック
python3 -m http.server 8123 &
node scripts/screenshots.cjs individual   # スマホ幅のスクリーンショット（shots/）
node scripts/screenshots.cjs corporation
```

方針・規約は `CLAUDE.md`、第1弾の仕様は `docs/spec-phase1.md` を参照してください。

## キャッシュ更新手順

ファイルを変更したら `sw.js` の `CACHE_VERSION` を上げ、ファイルを追加・削除したら `PRECACHE_URLS` も更新します（`npm run check` で漏れを検出します）。
