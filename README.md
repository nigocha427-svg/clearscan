# ClearScan

書類・書籍・領収書・身分証・メモをiPhoneでスキャンして、まっすぐに切り抜いたPDF・JPEGにするWebアプリ(PWA)。

## ファイル
| ファイル | 役割 |
|---|---|
| index.html | 画面の骨組みとデザイン(Notion風の配色・文字) |
| app.js | 画面遷移・カメラ(自動撮影)・保存(IndexedDB `clearscan`)・書き出し |
| imaging.js | 枠検出・台形補正(切り抜き)・見開き分割(画像の補正はしない) |
| worker.js | imaging.js を画面の裏で動かすワーカー |
| pdf.js | ページ画像を並べたPDFを作成 |
| drive.js | Google Drive への保存(drive.file スコープ) |
| sw.js | オフライン用キャッシュ(更新時は `CACHE` の番号を上げる) |

## 公開
https://nigocha427-svg.github.io/clearscan/ (リポジトリ nigocha427-svg/clearscan、main ブランチ直下)。
更新は commit → `git push`。リリースごとに sw.js の `CACHE` を上げる。

## 確認
`.claude/launch.json` の `clearscan`(http://localhost:5294)。カメラは https か localhost でのみ動作。

## 外部ライブラリ
- Google ログイン: Google Identity Services(Google から読み込み)
