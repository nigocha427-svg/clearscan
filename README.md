# ClearScan

書類・書籍・領収書・身分証・メモをiPhoneでスキャンして、きれいな画像・検索できるPDF・テキストにするWebアプリ(PWA)。

## ファイル
| ファイル | 役割 |
|---|---|
| index.html | 画面の骨組みとデザイン(Notion風の配色・文字) |
| app.js | 画面遷移・カメラ・保存(IndexedDB `clearscan`)・文字認識・書き出し |
| imaging.js | 枠検出・台形補正(切り抜き)・見開き分割(画像の補正はしない) |
| worker.js | imaging.js を画面の裏で動かすワーカー |
| pdf.js | 画像の上に透明テキストを重ねた「検索できるPDF」を作成 |
| drive.js | Google Drive への保存(drive.file スコープ) |
| sw.js | オフライン用キャッシュ(更新時は `CACHE` の番号を上げる) |

## 公開
https://nigocha427-svg.github.io/clearscan/ (リポジトリ nigocha427-svg/clearscan、main ブランチ直下)。
更新は commit → `git push`。リリースごとに sw.js の `CACHE` を上げる。

## 確認
`.claude/launch.json` の `clearscan`(http://localhost:5294)。カメラは https か localhost でのみ動作。

## 外部ライブラリ
- 文字認識: tesseract.js 5.1.1 / tesseract.js-core 5.1.1 / 認識データ 4.0.0_best_int(jpn, eng, jpn_vert)を `vendor/tesseract/` に同梱(Apache-2.0)。外部CDNは使わない
- Google ログイン: Google Identity Services(Google から読み込み)
