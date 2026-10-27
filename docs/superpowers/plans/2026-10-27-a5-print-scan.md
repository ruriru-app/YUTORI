# A5 Two-up Printing and Scan Calibration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Print two A5 tests on A4 by default and align answer crops plus returned annotations to scaled scanned content.

**Architecture:** Keep one canonical logical-sheet markup builder and measure a hidden reference without touching editor state. Predict a page's printed geometry from its detected header width/location, refine it against answer-grid edges, and share the derived normalized geometry between grading crops and returned overlays. A separate print-only root imposes two unscaled A5 copies on A4.

**Tech Stack:** Existing browser JavaScript, CSS print rules, bundled PDF.js, Node test runner, Playwright and pdf-lib; no added runtime dependencies.

**Spec:** `docs/superpowers/specs/2026-10-27-a5-print-scan-design.md`

## Global Constraints

- Teachers cut A4 into individual A5 sheets before scanning; one pupil per PDF page.
- Default `a5PrintMode` is `two-up`; the alternative is `single`; it has no effect for A4/B5.
- A5 portrait uses A4 landscape; A5 landscape uses A4 portrait. Preserve logical A5 dimensions without additional scaling.
- No automatic changes to pupil assignments or grading results.
- No new runtime dependencies or network services.
- Calibration is derived in-memory data; no database migration or overwriting original PDF/grade records.
- Release version will be v0.3.52, including the visible app version, service-worker cache and default backup appVersion metadata; preserve explicit historical-version fixtures and the backup schema.
- Use only synthetic, non-identifying committed fixtures. Real-scan verification stays outside the repository in local temporary files.
- Keep public v0.3.51 unchanged until implementation, verification and publication authorization are complete.

## Review Focus

- Direct browser printing and repeated/cancelled print dialogs must use the same imposition without leaving duplicate roots or affecting return printing; Task 1.
- Sparse questions, a wrapped title or fonts/images finishing late must not silently change reference geometry or mutate the open editor; Task 2.
- Missing or stale header metadata, misleading answer-grid lines and small skew must not create non-finite model bounds or invalid visible crops. Raw model extents may exceed 0..1 and must be subdivided before individual image intersections; Task 2.
- Switching tests or resuming/restoring sessions must invalidate derived geometry while preserving every pupil assignment and grade; Tasks 2 and 3.
- A4/B5, original-size return placement and mixed-orientation duplex output must keep their existing physical size and internal annotation alignment; Tasks 3 and 4.

## Repository and verification setup

The repository is `F:\YUTORI\YUTORI-publish`, main at `49ba72d7b02fde9c52cd0ee497cfbdac46ffc45f`. There is no package installation step. Reuse the bundled Node runtime and set NODE_PATH to its node_modules directory. Use `git -c safe.directory=F:/YUTORI/YUTORI-publish` or the equivalent GIT_CONFIG environment for test subprocesses. Run the existing full suite with `node --test --test-concurrency=2 --test-reporter=spec tests/*.test.mjs` before implementation to establish a clean baseline.

Use an isolated workspace if the user confirms that preference; otherwise work in the existing clean checkout without modifying unrelated work. Existing backup worktrees are not this feature's workspace. Do not push while carrying out this plan.

## File responsibilities

- `index.html`: canonical markup, editor print choice, print-only root lifecycle, DOM reference measurement, pixel/header detection, calibration cache and crop/return integration.
- `assets/yutori-sheet-geometry.js`: pure normalized prediction, reference mapping, question-box transforms and finite/bounds validation.
- `tests/test-print-layout.test.mjs`: persisted print choice, physical PDF dimensions/copy placement and print lifecycle.
- `tests/sheet-calibration.test.mjs`: synthetic scaled-sheet crop ownership, metadata/fallback/cache cases and pure transforms.
- `tests/return-scan-calibration.test.mjs`: return overlays share each pupil page's geometry and survive target-paper changes.
- `tests/a5-print-scan-roundtrip.test.mjs`: actual Chromium PDF -> bundled PDF.js -> two A5 cuts -> crop ink ownership and rendered return alignment in both orientations, using synthetic inputs only.
- Existing return/question-mode/backup tests: regression coverage; update only release-version assertions where needed.
- `sw.js`, `README.md`, default `assets/yutori-backup.js` appVersion: v0.3.52 offline asset list, concise user-facing behavior/limits and synchronized default backup metadata.

### Task 1: Canonical sheet markup and A5 two-up printing

**Files:** Modify `index.html` paper controls, state-copy/sync/editor paths and print lifecycle; create `tests/test-print-layout.test.mjs`.

**Interfaces:**
- Consumes: existing test state (`paperSize`, `orientation`, title choices, rows/cols/flow, answer format, question mode, guides).
- Produces: `paperMarkupForTest(test) -> string`, a state-independent equivalent of current paper contents; `prepareTestPrintLayout() -> void`, an idempotent root/layout builder used by both printDocument and beforeprint; persisted `a5PrintMode`.
- The logical `#paper` keeps its existing dimensions and markup structure. Task 2 may reuse `paperMarkupForTest(test)` in a hidden `.paper` reference.

- [x] **Step 1: Add failing browser tests.** `A5 two-up outputs one physical A4 page` asserts portrait yields one 297 x 210 mm PDF page and two 148 x 210 mm paper boxes; landscape yields one 210 x 297 mm page and two 210 x 148 mm boxes, each within 1 PDF point. `two copies have identical content` compares question/header/title markup and no scaling transform. `A5 single and A4/B5 retain physical sizes` verifies one copy. `print choice survives draft/save/duplicate` checks explicit single and absent-value two-up. `repeated/direct/return printing isolates roots` fires beforeprint/afterprint twice and checks root counts and restoration. `editor preview remains one sheet with an A4 two-copy summary` checks visible controls/summary and logical paper dimensions.
- [x] **Step 2: Run** `node --test tests/test-print-layout.test.mjs` and confirm failures identify the absent print mode/imposition, not harness errors.
- [x] **Step 3: Implement** the two interfaces, normalization and Japanese controls. Share markup rather than the live editor node; center two copies along A4's 297 mm axis with 0.5 mm outer slack. Keep the current PDF base filename. Do not alter return-printing branches or existing logical scan dimensions.
- [x] **Step 4: Run** the new tests plus `tests/question-mode.test.mjs` and `tests/return-paper-layout.test.mjs`; expect all pass. Inspect synthetic PDFs in both orientations, including a cancelled/repeated print path.
- [x] **Step 5: Commit** only Task 1 files with `feat: print A5 tests two-up on A4` after review.

### Task 2: Reference-based page calibration and crop integration

**Files:** Create `assets/yutori-sheet-geometry.js` and `tests/sheet-calibration.test.mjs`; modify `index.html` script loading, image/header/grid helpers and answer crop preparation.

**Interfaces:**
- Consumes: Task 1 `paperMarkupForTest(test)` and existing `markHeaderBounds` metadata/detection.
- Produces: `measureSheetReference(test) -> Promise<Reference>`, containing paper dimensions and actual header/grid rectangles in logical millimeters; cached by layout/content. It must not call syncState or mutate state/editor.
- Produces: pure `YutoriSheetGeometry.predictFromHeader(reference, header, imageSize) -> normalized geometry|null`, `mapReferenceRect(rectMm, reference, header, imageSize) -> visible normalized rect|null`, `clipRect(rect) -> visible normalized rect|null`, and `questionRect(grid, test, q) -> {left,top,width,height}`. Header/visible output bounds use 0..1 image coordinates; imageSize is `{width,height}` pixels. Raw `grid` may exceed 0..1; divide it into cells before intersecting individual visible crops. `visibleGrid` is only an intersection, never a spacing source. All model extents remain finite and ordered.
- Produces: `prepareAnswerSheetCalibration(image, test, page = null) -> Promise<Calibration>` cached by image/reference; `Calibration` contains raw normalized grid bounds, separate visibleGrid intersection, validated header bounds, reference, imageSize and provenance (`header-grid` or `legacy`). Calibrated inline crops retain the whole cell interior including question text, at natural proportions to preserve handwriting; legacy guide/trim behavior remains unchanged.
- Existing `answerCropRect(image,test,q)` remains callable with an optional fourth page parameter; async renderAnswerCrops prepares calibration once per image/test before requesting cells. Task 3 reuses the same calibration preparation.

- [x] **Step 1: Add failing geometry/crop tests.** Use real header SVG with synthetic independent row-color ink, not real pupil data. At scales `[.85,.92,1,1.05]` and centered/off-center translations, assert each row's crop contains its own ink and no adjacent-row ink, especially q9/q10. Cover A5 word one/two columns, extended, separate mode, row flow, A4/B5 and both orientations. Pin pure header prediction against independently calculated millimeter/pixel values. Assert a half-width word grid never expands to full width. Add missing/malformed metadata, no-header fallback, long title, delayed image/font readiness, contrast/small skew and changed-test cache tests; assert no NaN/out-of-image rects and no editor state changes.
- [x] **Step 2: Run** `node --test tests/sheet-calibration.test.mjs` and verify current scaled-sheet crop ownership fails while unscaled legacy fixtures remain meaningful.
- [x] **Step 3: Implement** pure transforms/validation and hidden reference measurement with awaited image/font readiness. Derive initial physical scale from header width, not its short height. Reuse/refine printed grid edges near that prediction; extend header candidate search only as needed by the translated fixtures, keeping template/aspect validation to avoid mistaking question lines for the header. Include every layout-relevant field in cache keys. Preserve legacy no-header fallback and guide-based crop behavior only for uncalibrated cells; reliably calibrated inline crops retain the cell interior and printed question text to preserve handwriting. Divide raw model extents before clipping each crop, with zero-area output for wholly invisible cells. Do not persist or modify names/grades.
- [x] **Step 4: Run** new tests and `tests/question-mode.test.mjs`; expect all pass. Run a local diagnostic against the private 45-page PDF outside the repo, reporting only geometry/counts. Visually verify early/middle/final-page crops including question 10; do not equate header detection alone with correct cropping.
- [x] **Step 5: Commit** Task 2 code and synthetic tests with `fix: align scanned answer crops to printed sheet geometry` after review.

### Task 3: Calibrated returned annotations and session reuse

**Files:** Modify `index.html` return image preparation, returnOutputState, returnQuestionRect, returnHeaderOverlayStyles and returnAnswerPageHtml; create `tests/return-scan-calibration.test.mjs`.

**Interfaces:**
- Consumes: Task 2 `prepareAnswerSheetCalibration(image,test,page)` and its normalized calibration, plus `YutoriSheetGeometry.questionRect` and `mapReferenceRect`.
- Produces: derived `returnOutputState.calibrations[pageId]`, filled when return images load, and optional `pageId` arguments to `returnQuestionRect(session,q,pageId="")` / `returnHeaderOverlayStyles(session={},pageId="")`.
- A session's questions/modelAnswers and stored snapshot options form the reference; do not silently use the currently edited or subsequently modified saved test. Existing synchronous return HTML functions consume prepared geometry; no repeated image loading per question.

- [x] **Step 1: Add failing return tests.** Generate synthetic scaled/translated scan images with known question/header regions. Assert returned q1/q10 marks, correct answers and rates match calibrated cells, including half-width word mode; score/optional statistics remain inside the appropriate header fields. Compare normalized alignment after fit/original and A5-to-A4/B5/mixed-orientation output. Switch two pupils with different translations and assert no cache leakage. Reopen/restore a synthetic session without calibration metadata and assert geometry is recomputed while assignments/grades remain deep-equal. Missing images/header must retain a bounded legacy fallback.
- [x] **Step 2: Run** `node --test tests/return-scan-calibration.test.mjs`; confirm scaled returned overlay alignment fails on the current implementation.
- [x] **Step 3: Implement** prepared per-page geometry for question/header overlays inside the existing source-image layer. Retain known-header layout validation and legacy header fallback. Revoke/reset derived image state using the existing return loading token lifecycle. Do not change practice layout or target paper/duplex logic.
- [x] **Step 4: Run** new tests with existing `return-paper-layout`, `return-practice-defaults`, `return-practice-font`, `grading-tile-layout`, `backup-restore` and `backup-restore-counts` tests. Inspect local private-scan return previews at several pages; no pupil artifacts in repo.
- [x] **Step 5: Commit** Task 3 files with `fix: share scan calibration with returned grading annotations` after review.

### Task 4: Version, offline assets and complete verification

**Files:** Modify `index.html`, `sw.js`, `README.md`, default `assets/yutori-backup.js` appVersion and release-sensitive assertions in `tests/backup-pwa.test.mjs` and `tests/backup-save-ui.test.mjs`; extend offline tests to require the geometry asset and add `tests/a5-print-scan-roundtrip.test.mjs`. Preserve explicit historical-version fixture values in codec/storage tests. Align these tracked spec/plan clarifications without changing the backup schema or practice design.

**Interfaces:** Consumes Tasks 1-3; produces v0.3.52 locally verified release candidate, not an automatic deployment.

- [x] **Step 1: Add/update failing release tests.** Assert version/cache `v0.3.52`, geometry asset precached and usable after offline boot, and backup UI still initializes in dependency order. Existing failed-install/update protection must remain intact.
- [x] **Step 2: Run** `node --test tests/backup-pwa.test.mjs` and confirm expected release/cache assertion failures.
- [x] **Step 3: Implement** synchronized version/cache updates and precache script loading. Document A5 two-up default, A5 single choice, one-cut-sheet-per-scan assumption and limits without promising printer-driver behavior or arbitrary photo correction.
- [x] **Step 4: Run** `node --test --test-concurrency=2 --test-reporter=spec tests/*.test.mjs`; require zero failures. Run synthetic print-to-PDF -> cut-sheet render -> crop/return alignment checks. Review git diff for private data and unrelated edits. Record exact evidence and any remaining limitations; do not loosen test deadlines to hide failures.
- [x] **Step 5: Commit** with `chore: prepare v0.3.52 A5 print and scan update`, request whole-branch review, repair findings and rerun affected/full verification. Hand off the local result and ask separately before GitHub publication if not already explicitly authorized for this release.

Final local candidate verification: controller fresh full suite271/271 pass, zero failures/skips/cancellations (94.518s) after the final fix, including real offline geometry calibration and actual Chromium PDF -> PDF.js -> both A5 cut sheets -> crop/returned-annotation checks in both orientations. Whole-branch review identified plausible stale header metadata overriding image evidence and the deferred explicit-invalid-count helper issue; one fix wave addressed both, and one scoped independent re-review found no remaining findings or new breakage. Calibration now uses cached current-image detection, never metadata alone; undetected headers retain legacy fallback. Pure geometry defaults only omitted counts. No API, storage, schema, deadlines or tolerances changed.

Controller repeated private45-page geometry verification on the final code: header-grid calibration45/45 both with and without metadata, own-row crop bounds45/45, original state/grades/pages unchanged. Earlier first/middle/last-page crop and name-redacted return previews, plus synthetic PDFs/return images and editor controls, were visually inspected. These checks do not establish semantic grading correctness of every private answer or physical printer/cutter/ADF behavior. Private inputs and artifacts remain outside the repository.

Earlier release evidence262/262 remains historical. Its first run261/262 exposed an offline synthetic fixture missing its title setting; matching the independently drawn layout fixed the fixture without production/tolerance/deadline changes. All task gates and the final review/fix gate are now complete. Product commits remain on the isolated branch; integration and GitHub publication await user choice, and no push or deployment has been performed.

Publication authorization: the user subsequently instructed that, once all tests pass, work should continue through GitHub publication without another confirmation. The verified feature branch was fast-forwarded into main; the merged main receives a fresh full-suite gate before pushing. No private scan, pupil image, roster, answer or grading record is included in the release.

## Plan self-review

All spec goals map to Tasks 1-4; all five Review Focus cases have explicit tests in their owning task. The normalized geometry boundary is shared by cropping and return overlays; logical paper size remains independent of imposition and target return paper. The private PDF remains outside tracked paths. Exact tuning of edge-search tolerances is deliberately left to the builder, constrained by independently drawn scaled fixtures and actual-scan verification. User reviewed and approved this plan, isolated workspace and subagent execution on 2026-10-27. Baseline: all 211 tests pass, zero failures. Publication remains separately gated.
