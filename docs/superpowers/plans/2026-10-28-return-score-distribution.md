# Return Score Distribution Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [x]`) syntax for tracking.

**Goal:** 承認済みの小さな得点分布票を返却用の最初の課題面へ重ね、従来の練習欄と印刷順を保つ。

**Architecture:** 純粋な集計関数だけを独立した小さなブラウザー用ファイルへ分離する。既存のクラス／学年判定・採点結果計算を入口とし、index.htmlの返却ページ生成へHTML/SVGの票を追加する。票は絶対配置し、既存の課題行の測定・４線・ページ分割には参加させない。

**Tech Stack:** 既存のJavaScript、HTML/CSS、SVG、Node test、Playwright、pdf-lib。新規依存なし。

**Spec:** `docs/superpowers/specs/2026-10-28-return-score-distribution-design.md`

**Execution status:** Tasks 1–3 implemented and independently approved on 2026-10-28. Commits: 8a84cb2, 1d1bc92, 806c1ff. Whole-branch review and integration choice remain pending; no merge/push/publication performed.

## Global Constraints

- 答案表面、採点結果、名簿、PDF画像、バックアップ形式は変更しない。
- 他の児童の氏名・個別得点・順位は分布票に掲載しない。
- ４線の右端が票に隠れるのは意図した表示であり、行数・出題数・用紙のページ数は票のために変えない。
- 通常の棒は灰色、本人の得点帯はテーマカラー #FCCC8E、本人の得点位置は縦線と点で示す。
- 「2ページ目・個別課題」に「得点分布票を付ける」チェックボックスを追加し、初期値はオン。
- A4・B5・A5、縦・横に対応する。右下の既存余白内に収め、用紙幅30%を目安に最大幅63mmとする。
- 新しい実行時依存関係、ネットワークサービス、保存データの移行は不要。新規ファイルを作る場合はオフライン利用に含める。
- GitHub公開は、実装と検証の完了後に別途確認する。

## Review Focus

- 小数配点の境界と満点：丸め誤差で隣の得点帯に落ちたり二重計上されたりしない（Task 1）。
- 全員０点、同点１人、対象ゼロ、不正な数値：平均・軸・本人マーカーが有限値で正しく表示される（Task 1/2）。
- 返却対象チェックとクラス切替：出力する人数を絞っても母集団が減らず、違う学年や前のクラスの分布が残らない（Task 2）。
- 短い・長い課題、全問正解、続きページ：票の有無で行配置と両面順が変わらず、手本の先頭を隠さない（Task 2）。
- A5/B5/A4の縦横とオフライン：画面の大小で票だけ肥大化せず、実際のPDF寸法と文字・グラフを保つ（Task 2）。

---

## Execution and file ownership

これまでのユーザー指定を引き継ぎ、隔離した作業場所でサブエージェント方式を使用する。２タスクは順次実施し、それぞれに独立したレビューを挟む。公開用mainの既存変更187be6f（△初期値オン）を含む現在の履歴を起点とし、他の作業場所は変更しない。

集計部品は`assets/yutori-score-distribution.js`、画面・票の組み込みは既存`index.html`に置く。新規テストは集計用と返却用に分ける。既存テスト補助・保存処理を広く作り替えない。

### Task 1: Pure score distribution

**Files:** Create `assets/yutori-score-distribution.js`; test `tests/score-distribution.test.mjs`.

**Interfaces:** `globalThis.YutoriScoreDistribution.buildDistribution(scores, maximum, ownScore = null)`を公開。入力は数値配列、満点、本人得点またはnull。戻り値は`{ maximum, count, average, bins, ownScore, ownBin }`。各binは`{ from, to, count }`。通常は10帯、ownBinは0〜9またはnull。対象ゼロではaverage/ownScore/ownBinをnullにする。不正な満点ではmaximumもnull、binsは空配列とする。入力を変更しない。

- [x] **Step 1: 失敗する集計テストを書く。** Nodeのvmで部品を読み、公開関数の実際の戻り値を検証する。
  - `buildDistribution([0, 10, 50, 100], 100, 100)`：count=4、average=40、帯0/1/5/9が各1、ownBin=9、他の帯は0。
  - 満点10・2.5・0.7の小数配点：0、途中境界、境界直前、満点の所属と合計人数を検証。特に0.7満点の0.42点は帯6へ入る。
  - 全員０点、１人同点、空配列、NaN/Infinity/文字列/null/負数/満点超過：有効な数値のみ集計し、無効な本人得点はマーカー対象にしない。
  - 満点0/負数/NaN/Infinityと、入力配列の不変性を検証する。
- [x] **Step 2: REDを確認。** `node --test tests/score-distribution.test.mjs`。部品不在または関数未定義による失敗を記録する。
- [x] **Step 3: 最小実装。** 上記の関数を既存部品と同じglobalThisへの公開形式で実装。丸めは所属判定の浮動小数誤差対策に限定し、得点自体を整数化しない。
- [x] **Step 4: GREENを確認。** 同じコマンドが全件成功し、差分に依存追加や保存処理の変更がないことを確認する。
- [x] **Step 5: コミット。** ２ファイルだけを追加し、`feat: calculate return score distributions`として保存する。

### Task 2: Return overlay, controls, offline and PDF verification

**Files:** Modify `index.html`, `sw.js`, `assets/yutori-backup.js`, `README.md`, `tests/backup-pwa.test.mjs`, `tests/backup-save-ui.test.mjs`; create `tests/return-score-distribution.test.mjs`.

**Interfaces:** Task 1の`buildDistribution`を消費する。`returnScoreDistributionHtml(session, className, person, options)`が票のHTML文字列を返す。`returnOutputOptions()`へBooleanの`showScoreDistribution`を追加し、DOMの`returnShowScoreDistribution`を読む。`returnPracticeSheetHtml`は`pageIndex === 0`かつ表示オンの場合だけ票を挿入する。既存のページ生成関数の引数と戻り値は維持する。

- [x] **Step 1: 失敗する統合テストを書く。** `tests/helpers/yutori-browser.mjs`を使い、合成データだけで以下を検証する。
  - 初期値オン、チェックを外すとプレビューと印刷用HTMLの両方から票が消える。同じデータを再表示しても外した値を戻さない。
  - 10点満点、クラスAの完了者0/5/10点、同学年Bの4/6点、別学年C、欠席者、採点途中者を用意。クラス集計は3人平均5点、学年集計は5人平均5点。返却対象を１人にしても同じ分布。クラス切替で分布が更新される。
  - 小数配点、全員０点、１人だけ、完了者ゼロ、本人未完了：人数・表示得点・マーカー有無とSVG属性にNaN/Infinityがないことを検証。本人以外の氏名は票内に出さない。
  - 課題を25問指定した続きページで票は最初の課題面に１枚だけ。全問正解でも課題面に票がある。表示オン／オフで行数・４線の幅・手本の位置・出力ページ数と両面順が同じ。
  - A4/B5/A5×縦横を画面幅320/1024pxと実寸印刷で検証。票の幅は用紙の約30%、かつ63mm以下。右下の余白内、説明欄と手本の先頭は票の外。最終見本の小さな本文・詰まった行間・白地・枠・テーマ色を確認する。
- [x] **Step 2: REDを確認。** `node --test tests/return-score-distribution.test.mjs`。チェックボックス／票が存在しない失敗を記録する。
- [x] **Step 3: 組み込む。** `resultRateClasses`、`calculateStudentResult`、`returnMaximumScore`を利用して完了者を集計。表示対象生徒の選択状態を集計に使わない。全描画値を検証し、文字列は既存のescapeHtmlで扱う。票はHTML/SVGの絶対配置、元の４線と行測定は変更しない。満点・半分・０の横軸と人数の縦軸を使い、最大人数０でも破綻させない。
- [x] **Step 4: 更新を完成させる。** 新規部品をscriptとAPP_SHELLに登録。集計範囲の表示に得点分布を追記。保守上の判断として次版をv0.3.53に揃え、タイトル・ブランド・キャッシュ・既定バックアップ版・現在版テストを更新する（過去版を明示した履歴テストは維持）。READMEへ分布票と△の初期値オンを説明する。
- [x] **Step 5: オフラインとPDFを検証。** 既存PWAテストに新規部品の初回precache・オフライン集計を追加する。Chromiumの`page.pdf({printBackground:true, preferCSSPageSize:true})`をpdf-libで読み、A4/B5/A5の表横・裏縦が実寸・従来のページ数であることを確認。PDFスキルに従い、ローカル一時フォルダーへ合成PDFを作り、レンダリングした最初の裏面を目視確認する。実データはコミットしない。
- [x] **Step 6: GREENと回帰を確認。** `node --test --test-concurrency=2 --test-reporter=spec tests/score-distribution.test.mjs tests/return-score-distribution.test.mjs tests/return-paper-layout.test.mjs tests/return-practice-defaults.test.mjs tests/backup-pwa.test.mjs tests/backup-save-ui.test.mjs`、続いて`node --test --test-concurrency=2 --test-reporter=spec tests/*.test.mjs`が全件成功すること。差分確認と独立レビュー後、対象ファイルを`feat: overlay compact score distributions on return practice sheets`としてコミットする。

### Task 3: Correct actual return-PDF content scale (user-approved addition)

**Authorization:** ユーザーが2026-10-28に既存の本文縮小も今回修正するよう明示的に承認。Task 2の独立レビュー後、別の新しい実装担当が開始する。v0.3.53の同じ更新に含め、別の公開操作は行わない。

**Files:** Modify `index.html` and `README.md`; create `tests/return-print-scale.test.mjs`. 既存のPDF寸法テストを必要な範囲で拡張してもよいが、無関係な印刷方式や保存方式へ作り替えない。

**Interfaces:** 既存の`printReturnPdfs()`、`returnPrintPagesForPerson(session, className, person, options)`、`returnOutputPaperSpec(session, side, options)`を維持する。原因に応じた最小の印刷CSS／ページ設定修正だけを行い、新しい保存形式や依存関係は追加しない。

- [x] **Step 1: 原因を特定する。** `F:/YUTORI/tmp/pdfs/return-distribution-qa/investigate-scale.mjs`とTask 2報告を読み、同一fixtureのプレビュー・印刷DOM・実際のPDFの違いを再現する。初期viewportや表示ズーム、ページ設定、向きの組合せを１要因ずつ比較し、具体的な根本原因を記録する。推測による固定倍率補正はしない。
- [x] **Step 2: 実際の本文寸法を検証する失敗テストを書く。** 新規テストでA4(210×297mm)/B5(182×257mm)/A5(148×210mm)について、表横・裏縦、表縦・裏横、両面縦、両面横を出力。pdf-libの用紙外形に加え、PDF.jsで実際のPDFを描画して色の付いた罫線の座標を測り、課題見出しの幅が縦用紙幅の88%、横用紙幅の90%であることを2pt以内の許容差で検証する。既存の6%/5%左右余白に基づく、制作コードとは独立した値を使う。答案表面も合成画像の境界を測り、用紙に合わせる場合とA5原寸をA4の左上へ置く場合に意図した実寸を保つことを確認する。分布票オン／オフで本文サイズが同じことと、票の実際の幅が用紙幅30%かつ63mm以下であることも検証する。
- [x] **Step 3: REDを記録する。** `node --test tests/return-print-scale.test.mjs`で、紙の外形は正しいのに本文が小さくなる失敗を確認する。もし同じ向きや特定用紙では症状が出ない場合、その対照ケースも残す。
- [x] **Step 4: 最小修正とGREEN。** 原因が確認できたCSS／印刷ページ設定だけを修正し、新規テストと既存の返却レイアウト・答案位置・A5印刷テストを通す。任意の拡大係数で帳尻を合わせたり、答案や課題データを書き換えたりしない。
- [x] **Step 5: PDFを再生成して確認する。** 同じ合成PDFを再生成し、Popplerで裏面を描画して実寸と余白、文字・分布票・４線を目視確認。例外的な長い手本、続きページ、調整用白紙も維持する。READMEに必要な説明だけ追記する。
- [x] **Step 6: 全体確認・保存。** `node --test --test-concurrency=2 --test-reporter=spec tests/*.test.mjs`が全件成功することを確認し、自己レビュー後に対象ファイルだけを`fix: preserve physical content scale in return PDFs`としてコミット。担当は報告に根本原因、RED/GREEN、全体テスト、実寸測定とPNG/PDFの場所を記載する。独立したタスクレビューを受ける。

## Handoff and final gate

実行前にこの計画をユーザーへ提示し確認を待つ。承認後は各タスクのRED/GREEN証拠・独立レビューを残し、最後に全差分をレビューする。公開前の状態で変更点、テスト結果、合成PDFの見本を報告し、GitHub公開の可否を確認する。

Self-review: 承認済み仕様の各項目をTask 1/2へ対応付け済み。Review Focusの５項目は各テスト項目で検証する。データ移行や新しい集計範囲の仕組みは追加しない。
