import assert from "node:assert/strict";
import test, { before, beforeEach, after } from "node:test";
import { createYutoriBrowser } from "./helpers/yutori-browser.mjs";

let app, page;
before(async () => { app = await createYutoriBrowser(); });
beforeEach(async () => {
  await page?.context().close();
  page = await app.freshPage({ pathname: "/index.html" });
  await page.evaluate(() => {
    clearTimeout(draftSaveTimer); draftSaveTimer = null;
    // Independent physical fixture: A5, header at 10 mm, half-width grid
    // at 36.4753 mm, ten 15.9 mm rows. No production geometry draws this scan.
    globalThis.seedReturnScan = async ({ scale = .85, x = 3, y = 8, noHeader = false, legacyHeader = false, metadataRowShift = null, id = "return-scan", pageId = "scan-a", settings = {} } = {}) => {
      const session = { id, selectedTestId: "changed-saved-test", testName: "Synthetic", paperSize: "a5", orientation: "portrait", rows: 10, cols: 1, flow: "column", answerFormat: "word", answerLine: "third", questionMode: "inline", questions: Array(10).fill("word"), modelAnswers: Array(10).fill("answer"), classes: ["test"], answers: { test: [{ no: 1, name: "Synthetic", pageId }] }, grades: Object.fromEntries(Array.from({ length: 10 }, (_, q) => [`test::1::${q}`, { mark: q === 0 ? "ok" : "ng", score: q === 0 ? 1 : 0 }])), pdfPages: [{ id: pageId }], ...settings };
      const paperWidth = session.paperSize === "a4" ? 210 : 148, paperHeight = session.paperSize === "a4" ? 297 : 210;
      const headerWidth = Math.min(139, paperWidth - 20);
      const canvas = document.createElement("canvas"); canvas.width = paperWidth * 6; canvas.height = paperHeight * 6;
      const ctx = canvas.getContext("2d"); ctx.fillStyle = "white"; ctx.fillRect(0, 0, canvas.width, canvas.height);
      ctx.translate(x * 6, y * 6); ctx.scale(scale * 6, scale * 6);
      if (!noHeader) { const image = new Image(); image.src = legacyHeader ? URL.createObjectURL(new Blob([HEADER_SVG], { type: "image/svg+xml" })) : "assets/test-mark-name-header.svg"; await image.decode(); ctx.drawImage(image, 10, 10, headerWidth, headerWidth * 371 / (legacyHeader ? 3690 : 4000)); if (legacyHeader) URL.revokeObjectURL(image.src); }
      ctx.strokeStyle = "#666"; ctx.lineWidth = .3;
      const top = noHeader ? 40 : 36.4753;
      ctx.strokeRect(10, top, 64, 159);
      for (let r = 1; r < 10; r++) { ctx.beginPath(); ctx.moveTo(10, top + r * 15.9); ctx.lineTo(74, top + r * 15.9); ctx.stroke(); }
      ctx.font = "3px sans-serif"; ctx.fillStyle = "#244";
      for (let r = 0; r < 10; r++) ctx.fillText(`Synthetic ${r + 1}`, 15, top + (r + .7) * 15.9);
      const blob = await new Promise(resolve => canvas.toBlob(resolve));
      if (metadataRowShift !== null) {
        const image = new Image(); image.src = URL.createObjectURL(blob); await image.decode();
        const actual = normalizedMarkHeaderBounds(detectMarkHeaderBoundsFromImage(image), canvas.width, canvas.height);
        const shift = metadataRowShift * 15.9 * scale / paperHeight;
        session.pdfPages[0].markHeaderBounds = { ...actual, top: actual.top + shift, bottom: actual.bottom + shift };
        URL.revokeObjectURL(image.src);
      }
      const db = await openYutoriDb();
      await new Promise((resolve, reject) => { const tx = db.transaction("pdfPages", "readwrite"); tx.objectStore("pdfPages").put({ id: `${id}:${pageId}`, sessionId: id, pageId, metadata: { id: pageId }, blob }); tx.oncomplete = resolve; tx.onerror = () => reject(tx.error); }); db.close();
      return session;
    };
    globalThis.showReturnScan = (session, person = session.answers.test[0], options = {}) => {
      let host = document.getElementById("scan-return-test");
      if (!host) { host = document.createElement("div"); host.id = "scan-return-test"; host.style.cssText = "position:absolute;left:0;top:0;width:888px"; document.body.appendChild(host); }
      host.innerHTML = returnAnswerPageHtml(session, "test", person, { showQuestionRate: true, showAverage: true, showRank: true, ...options });
      const source = host.querySelector(".return-answer-source"), box = source.getBoundingClientRect();
      const rect = node => { const r = node.getBoundingClientRect(); return { left: (r.left - box.left) / box.width, top: (r.top - box.top) / box.height, width: r.width / box.width, height: r.height / box.height }; };
      return { cells: [...host.querySelectorAll(".return-question-annotation")].map(node => ({ ...rect(node), mark: node.querySelector(".return-question-mark")?.getAttribute("aria-label"), answer: node.querySelector(".return-correct-answer")?.textContent, rate: node.querySelector(".return-question-rate")?.textContent })), score: rect(host.querySelector(".return-score-overlay")), extra: rect(host.querySelector(".return-extra-overlay")), overflow: [...host.querySelectorAll(".return-score-overlay,.return-extra-overlay,.return-extra-overlay span")].some(node => node.scrollWidth > node.clientWidth + 1 || node.scrollHeight > node.clientHeight + 1), sourceOverflow: getComputedStyle(source).overflow };
    };
  });
});
after(async () => { await app?.close(); });
const near = (actual, expected, tolerance = .003) => assert.ok(Math.abs(actual - expected) < tolerance, `${actual} should be near ${expected}`);

// Fixed logical cells or expanding the word half-column breaks q1/q10 placement.
for (const fixture of [{ scale: .85, x: 3, y: 8 }, { scale: 1.05, x: -2, y: 0 }, { scale: 1, x: 0, y: 20 }]) {
  test(`returned q1/q10 follow the raw scan cells at ${JSON.stringify(fixture)}`, async () => {
    const result = await page.evaluate(async fixture => { const session = await seedReturnScan(fixture); await loadReturnOutputImages(session); return showReturnScan(session); }, fixture);
    for (const q of [0, 9]) {
      near(result.cells[q].left, (10 * fixture.scale + fixture.x) / 148);
      near(result.cells[q].top, ((36.4753 + q * 15.9) * fixture.scale + fixture.y) / 210);
      near(result.cells[q].width, 64 * fixture.scale / 148);
      near(result.cells[q].height, 15.9 * fixture.scale / 210);
    }
    assert.equal(result.cells[0].mark, "○"); assert.equal(result.cells[9].mark, "×");
    assert.equal(result.cells[9].answer, "正：answer"); assert.equal(result.cells[0].rate, "正答率 100%"); assert.equal(result.cells[9].rate, "正答率 0%");
    assert.equal(result.sourceOverflow, "hidden");
  });
}

// Plausible saved bounds cannot register question/header annotations to another row.
for (const metadataRowShift of [0, -1]) test(`current-image evidence aligns returned overlays with header hint shifted ${metadataRowShift} rows`, async () => {
  const result = await page.evaluate(async metadataRowShift => {
    const s = await seedReturnScan({ scale: .92, x: 8.92, y: 16.4, metadataRowShift });
    const before = JSON.stringify(s);
    await loadReturnOutputImages(s);
    return { output: showReturnScan(s), hint: s.pdfPages[0].markHeaderBounds, unchanged: JSON.stringify(s) === before, provenance: returnOutputState.calibrations["scan-a"].provenance, layout: returnOutputState.calibrations["scan-a"].headerLayout };
  }, metadataRowShift);
  assert.ok(Object.values(result.hint).every(Number.isFinite));
  assert.ok(result.hint.top >= 0 && result.hint.bottom <= 1 && result.hint.bottom > result.hint.top);
  assert.equal(result.provenance, "header-grid"); assert.equal(result.layout, "wide"); assert.equal(result.unchanged, true);
  for (const q of [9, 0]) {
    near(result.output.cells[q].top, ((36.4753 + q * 15.9) * .92 + 16.4) / 210);
    near(result.output.cells[q].height, 15.9 * .92 / 210);
    near(result.output.cells[q].left, (10 * .92 + 8.92) / 148);
    near(result.output.cells[q].width, 64 * .92 / 148);
  }
  const field = { left: (8.92 + .92 * (10 + 128 * 3202.02 / 4000)) / 148, right: (8.92 + .92 * (10 + 128 * 3994.18 / 4000)) / 148, top: (16.4 + .92 * (10 + 128 * 5.5449 / 4000)) / 210, bottom: (16.4 + .92 * (10 + 128 * 365.281 / 4000)) / 210 };
  for (const box of [result.output.score, result.output.extra]) {
    assert.ok(box.left >= field.left - .002 && box.left + box.width <= field.right + .002);
    assert.ok(box.top >= field.top - .002 && box.top + box.height <= field.bottom + .002);
  }
});

test("header hints without current-image evidence retain legacy returned alignment", async () => {
  const result = await page.evaluate(async () => {
    const s = await seedReturnScan({ noHeader: true });
    await loadReturnOutputImages(s); const withoutHint = showReturnScan(s);
    s.pdfPages[0].markHeaderBounds = { left: 80 / 888, top: 110 / 1260, right: 784 / 888, bottom: 173.5 / 1260 };
    const before = JSON.stringify(s);
    await loadReturnOutputImages(s);
    return { withoutHint, withHint: showReturnScan(s), provenance: returnOutputState.calibrations["scan-a"].provenance, unchanged: JSON.stringify(s) === before };
  });
  assert.equal(result.provenance, "legacy"); assert.equal(result.unchanged, true);
  assert.deepEqual(result.withHint, result.withoutHint);
  near(result.withHint.cells[9].top, 184 / 210);
});

// The old score-left constant overlaps the name; old extras extend beyond A5.
test("A5 score and optional statistics share only the actual right header field", async () => {
  const result = await page.evaluate(async () => { const s = await seedReturnScan(); await loadReturnOutputImages(s); return showReturnScan(s); });
  const field = { left: (3 + .85 * (10 + 128 * 3202.02 / 4000)) / 148, right: (3 + .85 * (10 + 128 * 3994.18 / 4000)) / 148, top: (8 + .85 * (10 + 128 * 5.5449 / 4000)) / 210, bottom: (8 + .85 * (10 + 128 * 365.281 / 4000)) / 210 };
  for (const box of [result.score, result.extra]) {
    assert.ok(box.left >= field.left - .002 && box.left + box.width <= field.right + .002, JSON.stringify({ box, field }));
    assert.ok(box.top >= field.top - .002 && box.top + box.height <= field.bottom + .002);
  }
  assert.ok(result.score.top + result.score.height <= result.extra.top + .001, "score and statistics must not overlap");
  assert.equal(result.overflow, false);
});

// Header calibration must not take current editor/saved test content, nor survive a session reload.
test("restored session recomputes per-page calibration from its snapshot without changing grades or assignments", async () => {
  const result = await page.evaluate(async () => {
    const s = await seedReturnScan({ settings: { testName: "Long synthetic title ".repeat(3), questionMode: "separate", answerLine: "fourline", fourLineHeight: "large" } });
    localStorage.setItem(sessionsKey(), JSON.stringify([s]));
    localStorage.setItem("yutori_saved_tests_v1", JSON.stringify([{ ...s, questions: ["changed"], answers: ["changed"], cols: 3, paperSize: "a4" }]));
    state.testName = "changed editor"; state.cols = 5;
    const before = JSON.stringify({ answers: s.answers, grades: s.grades }), stored = localStorage.getItem(sessionsKey());
    await changeReturnOutputSession(s.id);
    const first = returnOutputState.calibrations?.["scan-a"], key = first?.reference.key;
    revokeReturnOutputUrls(); const cleared = Object.keys(returnOutputState.calibrations || {}).length;
    await changeReturnOutputSession(s.id);
    const second = returnOutputState.calibrations?.["scan-a"];
    return { exists: Boolean(first && second), recomputed: first !== second, cleared, key: key && JSON.parse(key), unchanged: before === JSON.stringify({ answers: returnOutputState.session.answers, grades: returnOutputState.session.grades }), storedUnchanged: stored === localStorage.getItem(sessionsKey()) };
  });
  assert.equal(result.exists, true); assert.equal(result.recomputed, true); assert.equal(result.cleared, 0);
  assert.equal(result.key.cols, 1); assert.equal(result.key.paperSize, "a5"); assert.equal(result.key.questionMode, "separate"); assert.equal(result.key.fourLineHeight, "large"); assert.deepEqual(result.key.answers, Array(10).fill("answer"));
  assert.equal(result.unchanged, true); assert.equal(result.storedUnchanged, true);
});

test("switching pupils uses each page translation without leaking geometry", async () => {
  const result = await page.evaluate(async () => {
    const s = await seedReturnScan({ x: 2, y: 0 });
    await seedReturnScan({ pageId: "scan-b", x: 5, y: 8 });
    const b = { no: 2, name: "Synthetic B", pageId: "scan-b" }; s.answers.test.push(b); s.pdfPages.push({ id: "scan-b" });
    await loadReturnOutputImages(s);
    const a = showReturnScan(s), second = showReturnScan(s, b), again = showReturnScan(s);
    return { a: a.cells[9], b: second.cells[9], again: again.cells[9], count: Object.keys(returnOutputState.calibrations || {}).length };
  });
  near(result.b.left - result.a.left, 3 / 148); near(result.b.top - result.a.top, 8 / 210); assert.deepEqual(result.again, result.a); assert.equal(result.count, 2);
});

// Source-relative normalized annotations must not change under target paper/duplex choices.
test("fit, original, A4/B5 and mixed orientations preserve normalized calibration", async () => {
  const result = await page.evaluate(async () => {
    const s = await seedReturnScan(); await loadReturnOutputImages(s);
    return ["a5", "a4", "b5"].flatMap(returnPaperSize => ["fit", "original"].flatMap(returnAnswerPlacement => ["portrait", "landscape"].map(returnAnswerOrientation => showReturnScan(s, undefined, { returnPaperSize, returnAnswerPlacement, returnAnswerOrientation, returnPracticeOrientation: "portrait" }).cells[9])));
  });
  for (const cell of result) { near(cell.left, 11.5 / 148); near(cell.top, 160.639005 / 210); near(cell.width, 54.4 / 148); }
});

test("missing images and no-header scans retain bounded legacy word-half-width placement", async () => {
  const result = await page.evaluate(async () => {
    const s = await seedReturnScan({ noHeader: true }); await loadReturnOutputImages(s);
    const legacy = showReturnScan(s), provenance = returnOutputState.calibrations?.["scan-a"]?.provenance;
    revokeReturnOutputUrls(); const missing = showReturnScan(s);
    return { legacy, missing, provenance };
  });
  assert.equal(result.provenance, "legacy");
  for (const output of [result.legacy, result.missing]) {
    near(output.cells[0].left, 10 / 148); near(output.cells[9].top, 184 / 210); near(output.cells[0].width, 64 / 148);
    for (const b of [output.score, output.extra]) assert.ok(b.left >= 0 && b.top >= 0 && b.left + b.width <= 1.001 && b.top + b.height <= 1.001 && b.width > 0);
  }
});

// A stale DB/image continuation must not install geometry or leak owned URLs into the new load.
test("a superseded return image load cannot replace the newest session geometry", async () => {
  const result = await page.evaluate(async () => {
    const a = await seedReturnScan({ id: "old", x: 0 }), b = await seedReturnScan({ id: "new", x: 5 });
    const first = loadReturnOutputImages(a), second = loadReturnOutputImages(b);
    const completed = await Promise.all([first, second]);
    return { completed, cell: returnQuestionRect(b, 9, "scan-a"), owned: returnOutputState.ownedUrls.length, urls: Object.keys(returnOutputState.imageUrls).length, count: Object.keys(returnOutputState.calibrations || {}).length };
  });
  assert.deepEqual(result.completed, [false, true]); near(result.cell.left / 100, 13.5 / 148); assert.equal(result.owned, 1); assert.equal(result.urls, 1); assert.equal(result.count, 1);
});

// A detected 3690-unit header must never inherit wide-4000 score/name partition ratios.
test("positively detected legacy headers retain the legacy score mapping", async () => {
  const result = await page.evaluate(async () => {
    const s = await seedReturnScan({ legacyHeader: true }); await loadReturnOutputImages(s);
    return { layout: returnOutputState.calibrations?.["scan-a"]?.headerLayout, actual: returnHeaderOverlayStyles(s, "scan-a"), fallback: returnHeaderOverlayStyles(s) };
  });
  assert.equal(result.layout, "legacy"); assert.deepEqual(result.actual, result.fallback);
});

// Malformed imported counts must not produce NaN/zero or fractional-layout cells.
test("legacy return fallback sanitizes invalid row and column counts", async () => {
  const result = await page.evaluate(() => [Infinity, -1, 1.5].map(value => returnQuestionRect({ paperSize: "a5", orientation: "portrait", answerFormat: "extended", rows: value, cols: value }, 0)));
  for (const cell of result) { near(cell.left / 100, 10 / 148); near(cell.top / 100, 40 / 210); near(cell.width / 100, 128 / 3 / 148); near(cell.height / 100, 16 / 210); }
});

// Compact A5 must not force otherwise spacious A4 statistics into the score field.
test("wide source paper retains a separate statistics lane and unshared score height", async () => {
  const result = await page.evaluate(async () => {
    const s = await seedReturnScan({ settings: { paperSize: "a4" } }); await loadReturnOutputImages(s);
    const output = showReturnScan(s), styles = returnHeaderOverlayStyles(s, "scan-a"), withExtras = returnHeaderOverlayStyles(s, "scan-a", { showAverage: true, showRank: true });
    return { output, sameScore: styles.score === withExtras.score };
  });
  assert.ok(result.output.extra.left >= result.output.score.left + result.output.score.width);
  near(result.output.extra.left, (3 + .85 * 151.5) / 210);
  near(result.output.extra.width, .85 * 50 / 210);
  assert.equal(result.output.overflow, false); assert.equal(result.sameScore, true);
});
