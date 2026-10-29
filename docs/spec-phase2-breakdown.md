# 第2弾 勘定科目内訳明細書（法人）仕様（v0.21.0）

「帳票 › 勘定科目内訳明細書」（`#/reports/breakdown`、法人だけ）。帳簿の期末残高・期中の発生額・補助科目から、内訳書の行を作る（`js/breakdown.js`）。弥生会計・勘定奉行の内訳書作成を参考にした。

## 1. 根拠（2026-10-29 確認）
- 内訳書の種類と番号：国税庁 勘定科目内訳明細書の標準フォーム（令和6年3月1日以後終了事業年度分）https://www.e-tax.nta.go.jp/hojin/gimuka/csv_jyoho2_meisai_20240325a.htm
- 記載内容の簡素化（100件超は上位100件などを選べる、仮払金・仮受金の「摘要」欄など）：https://www.e-tax.nta.go.jp/hojin/gimuka/kansoka.pdf 、https://www.e-tax.nta.go.jp/hojin/gimuka/kansokajiko_ichiran.pdf

## 2. 作る内訳書
| 番号 | 内訳書 | 科目（目印・役割） | 相手先 | 金額基準 |
|---|---|---|---|---|
| ① | 預貯金等 | role deposit | 補助科目＝金融機関・支店 | なし |
| ② | 受取手形 | notes_receivable | 振出人 | なし |
| ③ | 売掛金（未収入金） | receivable・other_receivable | 補助科目 | 50万円 |
| ④ | 仮払金（前渡金） | advance_paid・suspense_paid | 補助科目 | 50万円 |
| ④ | 貸付金及び受取利息 | short_loan・long_loan | 補助科目（受取利息は同名の受取利息の補助） | 50万円 |
| ⑤ | 棚卸資産 | inventory・finished_goods・work_in_process・raw_materials・supplies | 補助科目＝品目 | なし |
| ⑥ | 有価証券 | securities・investment_securities | 補助科目＝銘柄 | なし |
| ⑦ | 固定資産（土地・建物） | land・building | 補助科目＝物件 | なし |
| ⑧ | 支払手形 | notes_payable | 支払先 | なし |
| ⑨ | 買掛金（未払金・未払費用） | payable・accrued・accrued_expenses | 補助科目 | 50万円 |
| ⑩ | 仮受金（前受金・預り金） | advance_received・deposits_received・suspense_received | 補助科目 | 50万円 |
| ⑪ | 借入金及び支払利子 | short_borrowings・long_borrowings・officer_loan | 補助科目（支払利子は同名の支払利息の補助） | 50万円 |
| ⑭ | 役員給与等 | officer_compensation | 補助科目＝氏名 | なし |
| ⑭ | 人件費 | officer_compensation／salaries・bonuses／wages | － | － |
| ⑮ | 地代家賃等 | rent・mfg_rent | 補助科目＝貸主 | なし |
| ⑯ | 雑益、雑損失等 | misc_income・misc_loss の仕訳1件ずつ | 仕訳の補助科目 | 10万円 |

- 金額基準未満の行は、科目ごとに「その他（N件）」にまとめる。「すべて表示」でまとめない
- 法人のテンプレートの科目に目印を追加した（`BREAKDOWN_HINTS`）。既存のデータには起動時に科目コードで補う（`fillHints`）
- 所在地・法人との関係・利率・担保・振出日・数量などの帳簿に無い欄は、CSV に書き出してから記入する

## 3. 未対応
- ⑫土地の売上高等、⑬売上高等の事業所別、⑮-2権利金等、⑮-3工業所有権等の使用料、⑩-2源泉所得税預り金の内訳
- 利用者が追加した科目（目印が無い）は内訳書に入らない
- 金額基準の値は各内訳書の記載要領の原文と未照合（売掛金50万円・雑益等10万円は弥生会計などの既定に合わせた）
