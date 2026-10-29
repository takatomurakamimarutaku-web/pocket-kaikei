# Pocket会計（pocket-kaikei）開発メモ

スマートフォンで使う複式簿記の会計PWA。個人事業主（青色申告）と法人の両方に対応する。
開発はスマホから Claude Code（クラウド環境）で行う。仕様の詳細は `docs/spec-phase1.md`。

## 決定済みの方針（変える場合は必ずたかとさんに確認する）

- 対象：個人事業主（青色申告）と法人。初期設定で選び、勘定科目テンプレートと決算書の様式を切り替える
- データ保存：端末内の IndexedDB のみ。外部へ送信しない。端末間はバックアップファイル（JSON）で受け渡す
- 将来のクラウド同期に備える（今は作らない）
  - 全レコードに `id`（UUID）・`createdAt`・`updatedAt` を持たせる
  - 削除したレコードは `tombstones` ストアに記録する
  - IndexedDB への読み書きは `js/db.js` の Repository 経由に限る（画面から直接触らない）
- 技術構成：HTML/CSS/JavaScript（ES Modules）、ビルド不要、外部CDN不使用。iPhone の Safari で「ホーム画面に追加」して使う
- 参考実装：ホップ手帖（takatomurakamimarutaku-web/craft_beer_log）と同じ構成・書き方に揃える
  - `h()` で DOM を組む（innerHTML に利用者の入力を入れない）、ハッシュルーティング、`views/*.js` の `render()`、`node --test`＋`fake-indexeddb`、`scripts/check-pwa.js`

## 会計ロジックのルール

- 金額は整数の円で扱う。浮動小数点で計算しない（入力は `parseYen()` で整数化し、小数は拒否）
- 仕訳は貸借一致を検証し、一致しないものは保存させない（検証は `js/journal.js` の純粋関数、Repository でも再検証）
- 集計（元帳・試算表・決算書・消費税集計）は `js/ledger.js` などの純粋関数にし、テストを書く
- 貸借対照表で「資産合計＝負債・純資産合計」になることをテストで確認する
- 科目の判定は名前ではなく区分（`group`）と役割（`role`）で行う。科目名は利用者が変えられる
- マイナスは「△1,000」と表示する（CSV は機械で読むため `-1000`）
- 税法の判断（消費税の計算、インボイスの経過措置など）は国税庁など最新の公的情報で確認してから実装し、
  出典を `docs/` とコードのコメントに残す

## ファイル構成（予定）

```
index.html / manifest.webmanifest / sw.js   PWA の土台
css/style.css
js/app.js          起動・ルート定義・SW 登録
js/router.js       ハッシュルーティング（ホップ手帖と同じ）
js/db.js           IndexedDB のスキーマ移行と Repository（唯一の保存口）
js/models.js       レコード生成（UUID・日時）と定数
js/money.js        金額の整数化・△表示（純粋関数）
js/period.js       会計期間の検証・月の列挙（純粋関数）
js/accounts.js     区分・役割・科目テンプレート（純粋関数とデータ）
js/journal.js      仕訳の検証・貸借差額・複製（純粋関数）
js/ledger.js       元帳・試算表（純粋関数）
js/statements.js   損益計算書・貸借対照表（純粋関数）
js/tax.js          税区分と消費税集計（純粋関数）
js/backup.js       バックアップの書き出し・検証・復元
js/csv.js          CSV 出力（純粋関数）
js/changelog.js    更新履歴（利用者向けの更新内容）と抜けの検証
js/ui.js           共通 UI 部品
js/views/*.js      画面
scripts/check-pwa.js  PWA 構成チェック
test/*.test.js
```

## 作業の進め方

- 日本語で、結論と作業結果を先に書く。報告は「実施した確認」と「未確認の事項」を分ける
- 説明だけで終わらせず、コード・テスト・動作確認まで行う
- 作業の最後に必ず実行する
  - `npm test`
  - `npm run check`（PWA 構成チェック）
  - 画面を変えたら、スマホ幅（390×844）のスクリーンショットで確認する（Playwright。`shots/` に保存）
- 作業ブランチで開発し、テストが通ってから main に反映する（main は GitHub Pages で公開される）
- ファイルを追加・変更したら `sw.js` の `PRECACHE_URLS` と `CACHE_VERSION` を更新する（チェックで検出される）
- 版を上げるときは3か所をそろえ、更新履歴を必ず書く（`npm test` と `npm run check` で抜け・食い違いを検出する）
  - `package.json` の `version` と `js/version.js` の `APP_VERSION`
  - `js/changelog.js` の `CHANGELOG` の先頭に、同じバージョン・公開日・題名・更新内容を足す。
    内容は利用者向けの平易な言葉で書く（内部の名前・ファイル名・DB の番号は書かない）。アプリの「その他 › 更新履歴」に出る
  - main を取り込んで版が重なったら、番号を上げ直し、更新履歴の項目も新しい番号に移す
- IndexedDB のスキーマを変えるときは `DB_VERSION` を上げ、`migrate()` に `if (oldVersion < N)` を足し、移行テストを書く
- バックアップ形式を変えるときは `BACKUP_VERSION` を上げ、旧形式からの変換とテストを書く
- 事実と推測を区別し、計算式と判断の根拠を示す
