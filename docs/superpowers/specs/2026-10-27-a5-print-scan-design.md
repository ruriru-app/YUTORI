# A5 printing and scan-relative geometry

Status: design and implementation plan approved by the user on 2026-10-27, including an isolated workspace and subagent-driven implementation. GitHub publication requires separate confirmation after verification.

## Intent and evidence

Teachers print A5 tests on A4 stock, cut them into individual A5 sheets, and scan one pupil per PDF page. Exporting the same A5 twice and joining PDFs is unnecessary work. Printer scaling currently also moves answer crops because the application mostly assumes that the scanned page boundary is the logical paper boundary.

A private 45-page ScanSnap sample has near-A5 page dimensions but printed content at approximately 91.5-91.7% of the original horizontal size. The existing header detector finds the header on all 45 pages. The existing answer crop can fall below question 10. Synthetic scaled sheets also reproduce question 10 appearing in question 9. The header's short height is too sensitive to pixel rounding to estimate the entire page's vertical scale by itself. The long header width plus the answer-grid edges provides a better reference. No pupil data belongs in the repository or test artifacts intended for publication.

## Goals

- Default A5 test printing to two identical, unscaled A5 copies on one A4 sheet. A5 portrait uses A4 landscape; A5 landscape uses A4 portrait.
- Offer an explicit A5 single-sheet alternative. Preserve A4 and B5 single-sheet printing.
- Recover answer crops after moderate print scaling and translation by locating printed content rather than assuming page-sized content.
- Use the same per-page geometry for returned marks, correct answers, question rates, score and optional statistics.
- Work with today's already printed PDF without requiring new registration marks.
- Preserve names, assignments, grades, original PDFs, existing sessions and backup behavior.

## Non-goals and anti-goals

- No uncut two-pupil A4 scan splitting, OCR, new attendance-assignment rules, new test formats or printer-driver configuration.
- No perspective correction for photographed paper or recovery of handwriting outside the printed answer fields.
- No automatic changes to pupil assignments or grading results.
- No claim that all possible printer scales or damaged scans can be corrected. Reject invalid detected bounds and retain the existing fallback when the necessary evidence is absent.
- Do not publish the private PDF, rendered pupil images or identifiers. Do not deploy automatically as part of plan preparation.

## Approaches

1. **Chosen: existing header plus answer-grid calibration.** Use header width and location as an initial scale/translation estimate, then refine the grid using its printed edges. It handles existing sheets and current scans, with no new pupil workflow. It needs a shared geometry path across cropping and returned annotations.
2. Header-only proportional mapping is smaller but the short header height amplifies rounding error over the page and cannot resolve the observed full-page drift reliably.
3. New corner markers would be useful for a future photo/perspective workflow, but cannot repair existing printed tests and would change the paper design. Not part of this update.

The user approved approach 1 and the two-up printing behavior together on 2026-10-27.

## Printing design

Add a per-test `a5PrintMode` choice, `two-up` by default or `single`. Missing values default to `two-up`; the field has no effect for A4/B5. Save it with drafts, saved tests and duplicates. Display the controls only for A5, using Japanese labels that clearly identify A4 two-copy output and A5 one-copy output.

The normal editing preview remains one logical sheet for legibility; its print summary states the physical output size and number of copies. Build a dedicated print-only root from two copies of the canonical paper markup, not by scaling a screenshot or mutating the logical A5 dimensions. Center the combined 296 mm extent in the 297 mm A4 extent, leaving 0.5 mm at each end. Keep the existing 10 mm inner paper margins. Output exactly one physical A4 PDF page, not two A5 pages. Normal print, beforeprint, repeated printing, cancellation/afterprint, and return printing must not leave duplicate roots or leak print state.

## Shared geometry design

Keep the existing HTML/CSS paper design and PDF.js renderer. Extract a state-independent paper-markup builder so both rendering and offscreen reference measurement use the same layout without changing the active editor. Await the header asset and fonts before measuring. Cache references by all layout-relevant test fields, including displayed title and font readiness, not just rows/columns.

For each page, combine the existing detected header metadata (or image header detection for older sessions) with the selected test's logical reference. Estimate uniform physical scale from the long header width and translation from its location. Refine actual grid edges near that prediction, validating finite, ordered, in-image bounds and plausible row/column dimensions. Do not estimate vertical scale solely from the header height. Preserve the single-column word half-width and both row/column question ordering. Keep the existing no-header fallback for legacy scans and test fixtures.

Represent the result as image-normalized geometry: grid bounds, normalized header bounds/layout, source image dimensions and provenance. Store this as derived in-memory data keyed by image and test reference. Do not add a database migration or write calibration over original PDF/grade records. Recompute it when grading resumes or return images load, including for restored backups. Pixel crop coordinates and percentage return overlays must both derive from this representation.

For returned answer pages, map every question box to the calibrated grid. Map the score/statistics regions through the detected header/reference transform, using known header layout or the existing legacy fallback. Apply calibration inside the scanned source layer before the existing fit/original target-paper placement. Do not change practice-side size, duplex pairing, mixed orientation or B5 behavior.

## Builder decisions and constraints

- Retain plain browser JavaScript and existing Node/Playwright tests; no new runtime dependencies or network services.
- A small dedicated geometry asset may hold pure normalized transforms and validators; DOM measurement, pixel detection and existing workflow orchestration stay in index.html. This division is an implementation choice, not a new user requirement.
- Cache/reuse one calibrated page across all its question crops; do not render the PDF or scan image for every question. Clear or key caches correctly for changed tests and images.
- Treat existing `pdfPages` header metadata as a hint and validate it against current image dimensions; missing metadata must be recoverable by detection.
- Release version will be v0.3.52, including the visible app version and service-worker cache. Any new geometry asset must be available offline.
- Use only synthetic, non-identifying committed fixtures. Real-scan verification stays outside the repository in local temporary files.
- Keep public v0.3.51 unchanged until implementation, verification and publication authorization are complete.

## Acceptance checks

1. A5 portrait/two-up produces one 297 x 210 mm PDF page containing two identical 148 x 210 mm logical sheets; A5 landscape/two-up produces one 210 x 297 mm page with two 210 x 148 mm sheets. Single mode remains exact A5. A4/B5 are unchanged.
2. Synthetic sheets at 85%, 92%, 100% and 105% print scale, translated within a containing page, keep each row's identifying ink in the correct crop, including the last row. Cover half-width word, two-column word, extended, question-separate, row flow, A4/B5 and both orientations.
3. Header-missing, malformed metadata, long titles, low contrast and small skew do not yield invalid/NaN boxes or trusted wrong geometry. The existing fallback remains testable.
4. Returned question marks and header scores align to the same scaled/translated page as the crops; selecting a different return paper size/orientation does not change their internal alignment.
5. Reopening an old session or restoring a backup recalculates geometry without changing assignments or grades. Printing preferences survive save/reload/duplicate without changing paper geometry.
6. Verify the private 45-page scan locally: header/grid detection summary for all pages; visually inspect crops and return annotations on beginning, middle and final pages, including question 10. Report limitations honestly; do not infer grading correctness from geometry detection alone.
7. Run the entire existing suite and an offline boot/update check. No private scan data or identifiers in tracked files.
