# ClearScan

書類・書籍・領収書・身分証・メモをiPhoneでスキャンして、きれいな画像・検索できるPDF・テキストにするWebアプリ(PWA)。

## ファイル
| ファイル | 役割 |
|---|---|
| index.html | 画面の骨組みとデザイン(Notion風の配色・文字) |
| app.js | 画面遷移・カメラ・保存(IndexedDB `clearscan`)・文字認識・書き出し |
| imaging.js | 枠検出・台形補正・影/ムラ除去・指の消去・汚れ/折り目除去・見開き分割 |
| worker.js | imaging.js を画面の裏で動かすワーカー |
| pdf.js | 画像の上に透明テキストを重ねた「検索できるPDF」を作成 |
| drive.js | Google Drive への保存(drive.file スコープ) |
| sw.js | オフライン用キャッシュ(更新時は `CACHE` の番号を上げる) |

## 確認
`.claude/launch.json` の `clearscan`(http://localhost:5294)。
カメラは https か localhost でのみ動作。iPhone で使うには GitHub Pages などの https に公開する。

## 外部ライブラリ
- 文字認識: tesseract.js 5.1.1(jsDelivr から初回のみ読み込み)
- Google ログイン: Google Identity Services
