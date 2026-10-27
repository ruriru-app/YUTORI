import assert from "node:assert/strict";
import test, { before, beforeEach, after } from "node:test";
import { createYutoriBrowser } from "./helpers/yutori-browser.mjs";

let app, page;
before(async () => { app = await createYutoriBrowser(); });
beforeEach(async () => {
  await page?.context().close();
  page = await app.freshPage({ pathname: "/index.html" });
});
after(async () => { await app?.close(); });

const base = { paperSize: "a5", orientation: "portrait", rows: 10, cols: 1, flow: "column", answerFormat: "word", questionMode: "inline", answerLine: "third", testName: "Synthetic", questions: Array(10).fill("word"), answers: Array(10).fill("word") };
const near = (actual, expected, tolerance = .002) => assert.ok(Math.abs(actual - expected) < tolerance, `${actual} should be near ${expected}`);

// Wrong scale source (short header height), wrong origin, or expanding a half grid breaks these hand-computed values.
test("pure header transforms use width-based pixels/mm and retain a half-width grid", async () => {
  const result = await page.evaluate(() => {
    if (!globalThis.YutoriSheetGeometry) return null;
    const reference = { paper: { width: 148, height: 210 }, headerMm: { left: 10, top: 10, right: 138, bottom: 22 }, gridMm: { left: 10, top: 36.5, right: 74, bottom: 195.5 } };
    // 5 px/mm plus (25,40) px; height deliberately contains a one-pixel detection error.
    const header = { left: .075, top: .06, right: .715, bottom: 151 / 1500 };
    const size = { width: 1000, height: 1500 };
    return { prediction: YutoriSheetGeometry.predictFromHeader(reference, header, size), mapped: YutoriSheetGeometry.mapReferenceRect({ left: 20, top: 40, right: 30, bottom: 50 }, reference, header, size), cell: YutoriSheetGeometry.questionRect({ left: .075, top: 222.5 / 1500, right: .395, bottom: 1017.5 / 1500 }, { rows: 10, cols: 1 }, 9) };
  });
  assert.ok(result, "the pure geometry interface must be loaded");
  near(result.prediction.grid.left, .075); near(result.prediction.grid.right, .395);
  near(result.prediction.grid.top, 222.5 / 1500); near(result.prediction.grid.bottom, 1017.5 / 1500);
  assert.deepEqual(result.mapped, { left: .125, top: .16, right: .175, bottom: 290 / 1500 });
  near(result.cell.top, 938 / 1500); near(result.cell.width, .32); near(result.cell.height, .053);
});

// Catches accepting malformed metadata and propagating NaN, inverted or out-of-image boxes.
test("pure transforms reject invalid references, headers, images, and question indices", async () => {
  const result = await page.evaluate(() => {
    if (!globalThis.YutoriSheetGeometry) return null;
    const reference = { paper: { width: 148, height: 210 }, headerMm: { left: 10, top: 10, right: 138, bottom: 22 }, gridMm: { left: 10, top: 36.5, right: 74, bottom: 195.5 } };
    const valid = { left: .1, top: .05, right: .9, bottom: .1 }, size = { width: 1000, height: 1500 };
    return [null, {}, { ...valid, left: NaN }, { ...valid, left: -1 }, { ...valid, right: .1 }, { ...valid, bottom: 2 }, { ...valid, bottom: .8 }].map(header => YutoriSheetGeometry.predictFromHeader(reference, header, size)).concat([
      YutoriSheetGeometry.predictFromHeader({}, valid, size),
      YutoriSheetGeometry.predictFromHeader(reference, valid, { width: 0, height: 1500 }),
      YutoriSheetGeometry.mapReferenceRect({ left: 1, right: 0, top: 0, bottom: 1 }, reference, valid, size),
      YutoriSheetGeometry.questionRect(valid, { rows: 10, cols: 1 }, -1),
      YutoriSheetGeometry.questionRect(valid, { rows: 10, cols: 1 }, 10)
    ]);
  });
  assert.ok(result, "the pure geometry interface must be loaded");
  assert.ok(result.every(value => value === null), JSON.stringify(result));
});

// All drawing positions are independent physical fixtures, not measured or computed by the production helpers.
async function synthetic({ settings, widthMm = 148, heightMm = 210, gridTopMm = 36.4753, scale = 1, translated = false, translation = null, noHeader = false, metadata = null, metadataRowShift = null, skew = 0, contrast = 1, render = false, renderQuestion = 9, tallInk = false }) {
  const testState = { ...settings, questions: Array(settings.rows * settings.cols).fill("word"), answers: Array(settings.rows * settings.cols).fill("word") };
  const canvas = document.createElement("canvas"); canvas.width = Math.round(widthMm * 6); canvas.height = Math.round(heightMm * 6);
  const ctx = canvas.getContext("2d"); ctx.fillStyle = "white"; ctx.fillRect(0, 0, canvas.width, canvas.height);
  const originX = (1 - scale) * widthMm / 2 + (translation?.x ?? (translated ? 3 : 0)), originY = (1 - scale) * heightMm / 2 + (translation?.y ?? (translated ? 8 : 0));
  ctx.save(); ctx.translate(originX * 6, originY * 6); ctx.scale(scale * 6, scale * 6); ctx.transform(1, skew, 0, 1, 0, 0); ctx.globalAlpha = contrast;
  if (!noHeader) {
    const header = new Image(); header.src = "assets/test-mark-name-header.svg"; await header.decode();
    const headerWidth = Math.min(139, widthMm - 20); ctx.drawImage(header, 10, 10, headerWidth, headerWidth * 371 / 4000);
  }
  const gridWidth = (widthMm - 20) * (settings.answerFormat === "word" && settings.cols === 1 ? .5 : 1), gridHeight = heightMm - 51;
  const cellWidth = gridWidth / settings.cols, cellHeight = gridHeight / settings.rows;
  ctx.strokeStyle = "#666"; ctx.lineWidth = .3;
  for (let c = 0; c <= settings.cols; c++) { ctx.beginPath(); ctx.moveTo(10 + c * cellWidth, gridTopMm); ctx.lineTo(10 + c * cellWidth, gridTopMm + gridHeight); ctx.stroke(); }
  for (let r = 0; r <= settings.rows; r++) { ctx.beginPath(); ctx.moveTo(10, gridTopMm + r * cellHeight); ctx.lineTo(10 + gridWidth, gridTopMm + r * cellHeight); ctx.stroke(); }
  ctx.globalAlpha = 1;
  const colors = [];
  for (let q = 0; q < settings.rows * settings.cols; q++) {
    const row = settings.flow === "row" ? Math.floor(q / settings.cols) : q % settings.rows, col = settings.flow === "row" ? q % settings.cols : Math.floor(q / settings.rows);
    const rgb = [20 + q * 31 % 180, 30 + q * 73 % 180, 40 + q * 101 % 180]; colors.push(rgb.join(","));
    ctx.fillStyle = `rgb(${rgb})`;
    for (const position of tallInk ? [.10, .88] : [.64]) ctx.fillRect(10 + col * cellWidth + 5, gridTopMm + (row + position) * cellHeight, cellWidth - 10, cellHeight * (tallInk ? .05 : .12));
  }
  ctx.restore();
  const image = new Image(); image.src = canvas.toDataURL(); await image.decode();
  if (metadataRowShift !== null) {
    const actual = normalizedMarkHeaderBounds(detectMarkHeaderBoundsFromImage(image), canvas.width, canvas.height);
    const shift = metadataRowShift * cellHeight * scale / heightMm;
    metadata = { markHeaderBounds: { ...actual, top: actual.top + shift, bottom: actual.bottom + shift } };
  }
  const calibration = typeof prepareAnswerSheetCalibration === "function" ? await prepareAnswerSheetCalibration(image, testState, metadata) : null;
  const crops = [], pixels = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
  for (let q = 0; q < settings.rows * settings.cols; q++) {
    const crop = answerCropRect(image, testState, q, metadata), found = new Set(); let ownPixels = 0;
    for (let y = Math.ceil(crop.y); y < Math.floor(crop.y + crop.height); y++) for (let x = Math.ceil(crop.x); x < Math.floor(crop.x + crop.width); x++) {
      const i = (y * canvas.width + x) * 4, key = `${pixels[i]},${pixels[i + 1]},${pixels[i + 2]}`;
      const owner = colors.indexOf(key); if (owner >= 0) found.add(owner); if (owner === q) ownPixels++;
    }
    crops.push({ q, owners: [...found], crop, ownPixels });
  }
  const totalInk = Array(colors.length).fill(0);
  if (tallInk) for (let i = 0; i < pixels.length; i += 4) { const owner = colors.indexOf(`${pixels[i]},${pixels[i + 1]},${pixels[i + 2]}`); if (owner >= 0) totalInk[owner]++; }
  let renderedOwners = null, renderedSize = null;
  if (render) {
    const target = document.createElement("canvas"); target.className = "answer-crop-canvas"; target.dataset.pageId = "synthetic"; target.dataset.questionIndex = String(renderQuestion); document.body.appendChild(target);
    // A fully invisible answer must replace prior content, not leave a previous tile behind.
    target.getContext("2d").fillRect(0, 0, target.width, target.height);
    gradingState.pageImageUrls.synthetic = image.src;
    await renderAnswerCrops(0, testState);
    const data = target.getContext("2d").getImageData(0, 0, target.width, target.height).data, found = new Set();
    for (let i = 0; i < data.length; i += 4) { const owner = colors.indexOf(`${data[i]},${data[i + 1]},${data[i + 2]}`); if (owner >= 0) found.add(owner); }
    renderedOwners = [...found]; renderedSize = { width: target.width, height: target.height, blank: data.every((value, i) => i % 4 === 3 || value === 255) }; target.remove();
  }
  return { crops, provenance: calibration?.provenance, grid: calibration?.grid, visibleGrid: calibration?.visibleGrid, metadata, renderedOwners, renderedSize, totalInk, width: canvas.width, height: canvas.height };
}

for (const variant of [
  { label: "A5 word one column", settings: {} },
  { label: "A5 word two columns", settings: { cols: 2 } },
  { label: "A5 extended row flow", settings: { cols: 2, flow: "row", answerFormat: "extended" } },
  { label: "A5 separate", settings: { questionMode: "separate" } },
  { label: "A5 landscape", settings: { orientation: "landscape" }, widthMm: 210, heightMm: 148, gridTopMm: 37.4964 },
  { label: "A4 portrait", settings: { paperSize: "a4", answerFormat: "extended" }, widthMm: 210, heightMm: 297, gridTopMm: 37.4964 },
  { label: "A4 landscape", settings: { paperSize: "a4", orientation: "landscape", cols: 3 }, widthMm: 297, heightMm: 210, gridTopMm: 37.4964 },
  { label: "B5 portrait", settings: { paperSize: "b5", cols: 2 }, widthMm: 182, heightMm: 257, gridTopMm: 37.4964 },
  { label: "B5 landscape", settings: { paperSize: "b5", orientation: "landscape", answerFormat: "extended" }, widthMm: 257, heightMm: 182, gridTopMm: 37.4964 }
]) {
  // Each row's unique ink detects accumulated scale error, incorrect translation, flow and width.
  test(`${variant.label} keeps every row's ink through scale and translation`, async () => {
    for (const scale of [.85, .92, 1, 1.05]) for (const translated of [false, true]) {
      const result = await page.evaluate(synthetic, { ...variant, settings: { ...base, ...variant.settings }, scale, translated });
      for (const { q, owners, crop } of result.crops) {
        assert.deepEqual(owners, [q], `${variant.label}, scale ${scale}, translated ${translated}, q${q + 1}: ${JSON.stringify(crop)}`);
        assert.ok(crop.x >= 0 && crop.y >= 0 && crop.width > 0 && crop.height > 0 && crop.x + crop.width <= result.width && crop.y + crop.height <= result.height);
      }
      assert.equal(result.provenance, "header-grid");
      if (variant.settings.cols == null && variant.settings.answerFormat !== "extended") assert.ok(result.grid.right - result.grid.left < .5, "half grid must not expand");
    }
  });
}

test("calibration tolerates small skew and reduced contrast and renderAnswerCrops prepares it", async () => {
  const result = await page.evaluate(synthetic, { settings: base, scale: .92, translated: true, skew: .003, contrast: .75, render: true });
  for (const { q, owners } of result.crops) assert.deepEqual(owners, [q], `q${q + 1}`);
  assert.equal(result.provenance, "header-grid"); assert.deepEqual(result.renderedOwners, [9]);
});

test("absent headers keep legacy crop geometry and malformed hints do not override real headers", async () => {
  const legacy = await page.evaluate(synthetic, { settings: base, noHeader: true, gridTopMm: 40 });
  assert.equal(legacy.provenance, "legacy");
  for (const { q, owners } of legacy.crops) assert.deepEqual(owners, [q]);
  for (const markHeaderBounds of [{ left: -.1, top: .05, right: .9, bottom: .1 }, { left: .1, right: .1, top: .1, bottom: .2 }, { left: .1, right: .9, top: .1, bottom: .8 }, { left: "0.1", right: .9, top: .1, bottom: .2 }]) {
    const result = await page.evaluate(synthetic, { settings: base, scale: .85, translated: true, metadata: { markHeaderBounds } });
    assert.equal(result.provenance, "header-grid"); for (const { q, owners } of result.crops) assert.deepEqual(owners, [q]);
  }
});

// A finite, ordered, correctly proportioned hint one row above the real header
// must not let grid refinement relabel q9's ink as q10's answer.
for (const metadataRowShift of [0, -1]) test(`current-image evidence keeps crop ownership with header hint shifted ${metadataRowShift} rows`, async () => {
  const result = await page.evaluate(synthetic, { settings: base, scale: .92, translated: true, metadataRowShift });
  const hint = result.metadata.markHeaderBounds;
  assert.ok(Object.values(hint).every(Number.isFinite));
  assert.ok(hint.left >= 0 && hint.top >= 0 && hint.right <= 1 && hint.bottom <= 1 && hint.right > hint.left && hint.bottom > hint.top);
  const aspect = (hint.right - hint.left) * 888 / ((hint.bottom - hint.top) * 1260);
  assert.ok(aspect > 8 && aspect < 15, "the hint must pass the former shape-only validation");
  assert.equal(result.provenance, "header-grid");
  assert.deepEqual(result.crops[9].owners, [9], "q10 must contain q10 ink, not q9 ink");
  for (const { q, owners } of result.crops) assert.deepEqual(owners, [q], `q${q + 1}`);
  // Independent physical fixture: 92% scale, +8.92/+16.4 mm origin, 0.5 mm inset.
  near(result.crops[9].crop.y, ((36.4753 + 9 * 15.9 + .5) * .92 + 16.4) * 6, 3);
});

test("header hints without current-image evidence cannot promote legacy crops to calibrated geometry", async () => {
  const metadata = { markHeaderBounds: { left: 80 / 888, top: 110 / 1260, right: 784 / 888, bottom: 173.5 / 1260 } };
  const result = await page.evaluate(synthetic, { settings: base, noHeader: true, gridTopMm: 40, metadata });
  assert.equal(result.provenance, "legacy");
  for (const { q, owners } of result.crops) assert.deepEqual(owners, [q]);
});

// Defaulting explicit zero/NaN/malformed values silently creates unrelated cells.
for (const field of ["rows", "cols"]) test(`pure question geometry rejects explicit invalid ${field}`, async () => {
  const result = await page.evaluate(field => [0, NaN, "bad", -1, 1.5, Infinity, null, ""].map(value => ({
    label: String(value), cell: YutoriSheetGeometry.questionRect({ left: 0, top: 0, right: 1, bottom: 1 }, { rows: 10, cols: 3, [field]: value }, 0)
  })), field);
  for (const { label, cell } of result) assert.equal(cell, null, `${field}=${label} must be rejected`);
});

test("pure question geometry defaults omitted counts and accepts legitimate numeric strings", async () => {
  const result = await page.evaluate(() => {
    const grid = { left: 0, top: 0, right: 1, bottom: 1 };
    return [{}, { rows: undefined, cols: undefined }, { rows: "10", cols: "3" }].map(settings => YutoriSheetGeometry.questionRect(grid, settings, 29));
  });
  for (const cell of result) assert.deepEqual(cell, { left: 2 / 3, top: .9, width: 1 / 3, height: .1 });
});

// Measuring state instead of the passed snapshot, omitting content from cache keys, or changing editor state breaks this.
test("reference measurement is content-aware and does not touch editor, assignments, or grades", async () => {
  const result = await page.evaluate(async base => {
    if (typeof measureSheetReference !== "function") return null;
    const before = JSON.stringify({ state, html: document.getElementById("paper").outerHTML, grades: gradingState.grades, answers: gradingState.answers });
    const first = await measureSheetReference(base), same = await measureSheetReference({ ...base });
    const long = await measureSheetReference({ ...base, testName: "Long synthetic title ".repeat(3) });
    const extended = await measureSheetReference({ ...base, answerFormat: "extended" });
    const changed = await measureSheetReference({ ...base, questions: ["changed"], answers: ["changed"], answerLine: "fourline", fourLineHeight: "large", flow: "row" });
    return { first, reused: first === same, long, extended, changedKey: changed.key !== first.key, unchanged: before === JSON.stringify({ state, html: document.getElementById("paper").outerHTML, grades: gradingState.grades, answers: gradingState.answers }) };
  }, base);
  assert.ok(result, "reference measurement must be available");
  assert.equal(result.reused, true); assert.equal(result.unchanged, true); assert.equal(result.changedKey, true);
  near(result.first.gridMm.top, 36.4753, .05); near(result.first.gridMm.bottom, 195.4775, .05);
  near(result.first.headerImageMm.left, 10, .02); near(result.first.headerImageMm.right, 138, .02);
  assert.ok(result.first.headerMm.left > result.first.headerImageMm.left);
  assert.ok(result.long.gridMm.top > result.first.gridMm.top + 4);
  near(result.extended.gridMm.right - result.extended.gridMm.left, 128, .05);
});

test("reference waits for delayed header image and font layout before resolving", async () => {
  assert.equal(await page.evaluate(() => typeof measureSheetReference), "function");
  let releaseImage, releaseFont, imageRequested, fontRequested;
  const imageStarted = new Promise(resolve => { imageRequested = resolve; }), fontStarted = new Promise(resolve => { fontRequested = resolve; });
  await page.route("**/test-mark-name-header.svg", async route => { imageRequested(); await new Promise(resolve => { releaseImage = resolve; }); await route.continue(); });
  await page.route("**/Andika-Regular.ttf", async route => { fontRequested(); await new Promise(resolve => { releaseFont = resolve; }); await route.continue(); });
  await page.addStyleTag({ content: '@font-face{font-family:CalibrationDelayed;src:url("assets/fonts/andika/Andika-Regular.ttf")} .paper-title{font-family:CalibrationDelayed}' });
  await page.evaluate(base => { window.referenceFinished = false; window.pendingReference = measureSheetReference(base).then(value => { window.referenceFinished = true; return value; }); }, base);
  await imageStarted; assert.equal(await page.evaluate(() => window.referenceFinished), false); releaseImage();
  await fontStarted; assert.equal(await page.evaluate(() => window.referenceFinished), false); releaseFont();
  const reference = await page.evaluate(() => window.pendingReference);
  assert.ok(reference.headerImageMm.bottom - reference.headerImageMm.top > 11);
  assert.ok(reference.gridMm.top > reference.headerImageMm.bottom + 8);
});

// The legacy (3690-unit) SVG keeps the same unequal internal partitions; broadening the search must not remove support for it.
test("legacy header detection still supports attendance metadata and name cropping", async () => {
  const result = await page.evaluate(async () => {
    const canvas = document.createElement("canvas"); canvas.width = 1000; canvas.height = 1420;
    const ctx = canvas.getContext("2d"); ctx.fillStyle = "white"; ctx.fillRect(0, 0, canvas.width, canvas.height);
    const header = new Image(); header.src = URL.createObjectURL(new Blob([HEADER_SVG], { type: "image/svg+xml" })); await header.decode();
    ctx.drawImage(header, 100, 140, 800, 800 * 371 / 3690); URL.revokeObjectURL(header.src);
    const detected = findMarkHeaderBounds(ctx.getImageData(0, 0, canvas.width, canvas.height));
    const metadata = readAttendanceMarks(canvas, ctx);
    const image = new Image(); image.src = canvas.toDataURL(); await image.decode();
    return { layout: detected.layout, header: metadata.markHeaderBounds, crop: nameCropRect(image, metadata), detection: normalizedMarkHeaderBounds(detectMarkHeaderBoundsFromImage(image), canvas.width, canvas.height) };
  });
  assert.equal(result.layout, "legacy");
  near(result.header.left, .1012, .003); near(result.header.right, .8986, .003);
  near(result.header.top, 141.2 / 1420, .003); near(result.header.bottom, 219.2 / 1420, .003);
  assert.deepEqual(result.detection, result.header);
  near(result.crop.x, 100 + 1741.56 * 800 / 3690, 4);
  near(result.crop.width, (3202.02 - 1741.56) * 800 / 3690, 4);
});

// A WeakMap keyed only by image (or a key omitting titles/flow) incorrectly reuses these calibrations.
test("same-image calibration cache tracks changed test content and metadata without mutating inputs", async () => {
  const result = await page.evaluate(async base => {
    const canvas = document.createElement("canvas"); canvas.width = 888; canvas.height = 1260;
    const ctx = canvas.getContext("2d"); ctx.fillStyle = "white"; ctx.fillRect(0, 0, canvas.width, canvas.height);
    const header = new Image(); header.src = "assets/test-mark-name-header.svg"; await header.decode();
    ctx.drawImage(header, 80, 110, 704, 704 * 371 / 4000);
    const image = new Image(); image.src = canvas.toDataURL(); await image.decode();
    const metadata = { markHeaderBounds: normalizedMarkHeaderBounds(detectMarkHeaderBoundsFromImage(image), 888, 1260) };
    const before = JSON.stringify({ base, metadata }), first = await prepareAnswerSheetCalibration(image, base, metadata), same = await prepareAnswerSheetCalibration(image, { ...base }, metadata);
    const extended = await prepareAnswerSheetCalibration(image, { ...base, answerFormat: "extended" }, metadata);
    const longer = await prepareAnswerSheetCalibration(image, { ...base, testName: "Long synthetic title ".repeat(3) }, metadata);
    const moved = await prepareAnswerSheetCalibration(image, base, { markHeaderBounds: { ...metadata.markHeaderBounds, top: metadata.markHeaderBounds.top + 10 / 1260, bottom: metadata.markHeaderBounds.bottom + 10 / 1260 } });
    const crop = answerCropRect(image, base, 9, metadata);
    const blank = await prepareAnswerSheetCalibration(image, base);
    return { reused: first === same, changedHintEntry: first !== moved, first: first.grid, extended: extended.grid, longer: longer.grid, moved: moved.grid, crop, noHint: blank.grid, provenance: blank.provenance, frozen: Object.isFrozen(first) && Object.isFrozen(first.grid) && Object.isFrozen(first.reference), unchanged: before === JSON.stringify({ base, metadata }) };
  }, base);
  assert.equal(result.reused, true); assert.equal(result.changedHintEntry, true); assert.equal(result.unchanged, true); assert.equal(result.frozen, true); assert.equal(result.provenance, "header-grid");
  near(result.extended.right - result.extended.left, 2 * (result.first.right - result.first.left));
  assert.ok(result.longer.top > result.first.top + .02); assert.deepEqual(result.moved, result.first); assert.deepEqual(result.noHint, result.first);
  assert.ok(result.crop.y >= (result.first.top + .9 * (result.first.bottom - result.first.top)) * 1260);
});

// Fixed inline top trimming loses high ascenders and fixed display height stretches short landscape rows.
test("calibrated inline crops preserve high ascenders and low descenders within only their own row", async () => {
  for (const answerLine of ["third", "fourline", "none"]) for (const orientation of ["portrait", "landscape"]) {
    const dimensions = orientation === "landscape" ? { widthMm: 210, heightMm: 148, gridTopMm: 37.4964 } : {};
    const result = await page.evaluate(synthetic, { ...dimensions, settings: { ...base, orientation, answerLine }, scale: .92, translated: true, tallInk: true, render: true });
    for (const { q, owners, ownPixels } of result.crops) {
      assert.deepEqual(owners, [q], `${orientation} ${answerLine} q${q + 1} includes adjacent ink`);
      assert.ok(ownPixels >= result.totalInk[q] * .99, `${orientation} ${answerLine} q${q + 1} preserved ${ownPixels}/${result.totalInk[q]} ink pixels`);
    }
    const crop = result.crops[9].crop;
    near(result.renderedSize.height, 480 * crop.height / crop.width, 1);
  }
});

// The passed test can change while image/font readiness is pending; one calibration must use one coherent snapshot.
test("calibration uses the requested snapshot if the caller edits the test while measurement waits", async () => {
  const result = await page.evaluate(async base => {
    const canvas = document.createElement("canvas"); canvas.width = 888; canvas.height = 1260;
    const ctx = canvas.getContext("2d"); ctx.fillStyle = "white"; ctx.fillRect(0, 0, canvas.width, canvas.height);
    const image = new Image(); image.src = canvas.toDataURL(); await image.decode();
    const requested = { ...base }, pending = prepareAnswerSheetCalibration(image, requested);
    requested.answerFormat = "extended"; requested.orientation = "landscape";
    const first = await pending, original = await prepareAnswerSheetCalibration(image, base);
    return { first: first.grid, reused: first === original, paper: first.reference.paper };
  }, base);
  assert.equal(result.reused, true); near(result.first.right, .5, .001);
  near(result.first.bottom, 200 / 210); assert.equal(result.paper.orientation, "portrait");
});

// Intersecting the model before subdivision compresses q10 into q9 at the bottom scan boundary.
test("bottom-clipped A5 scan preserves all original row positions including q10", async () => {
  const result = await page.evaluate(synthetic, { settings: base, translation: { x: 0, y: 20 }, render: true });
  assert.equal(result.provenance, "header-grid");
  for (const { q, owners } of result.crops) assert.deepEqual(owners, [q], `q${q + 1} owns the wrong row at the bottom boundary`);
  assert.ok(result.grid.bottom > 1); assert.equal(result.visibleGrid.bottom, 1);
  // Hand-computed q10 top: (36.4753 + 20 + 9 * 15.9) mm at 6 px/mm, plus 0.5 mm inset.
  near(result.crops[9].crop.y, 1200.4518, 3); near(result.crops[9].crop.y + result.crops[9].crop.height, 1260, .01);
  assert.deepEqual(result.renderedOwners, [9]);
});

// A4 landscape leaves the real header visible while the final column crosses the right scan boundary.
test("right-clipped scan preserves the original column spacing", async () => {
  const result = await page.evaluate(synthetic, { settings: { ...base, paperSize: "a4", orientation: "landscape", answerFormat: "extended", cols: 3 }, widthMm: 297, heightMm: 210, gridTopMm: 37.4964, translation: { x: 30, y: 0 }, render: true, renderQuestion: 29 });
  assert.equal(result.provenance, "header-grid");
  for (const { q, owners } of result.crops) assert.deepEqual(owners, [q], `q${q + 1} owns the wrong column at the right boundary`);
  assert.ok(result.grid.right > 1); assert.equal(result.visibleGrid.right, 1);
  // Final column starts at 10 + 30 + 2 * (277 / 3) mm, not a third of a shortened grid.
  near(result.crops[29].crop.x, 1357, 3); near(result.crops[29].crop.x + result.crops[29].crop.width, 1782, .01);
  assert.deepEqual(result.renderedOwners, [29]);
});

for (const fixture of [
  { label: "bottom", settings: base, translation: { x: 0, y: 40 }, renderQuestion: 9 },
  { label: "right", settings: { ...base, paperSize: "a4", orientation: "landscape", answerFormat: "extended", cols: 3 }, widthMm: 297, heightMm: 210, gridTopMm: 37.4964, translation: { x: 140, y: 0 }, renderQuestion: 29 }
]) test(`fully invisible ${fixture.label} questions produce an empty crop and clear the tile`, async () => {
  const result = await page.evaluate(synthetic, { ...fixture, render: true });
  assert.equal(result.provenance, "header-grid");
  const final = result.crops[fixture.renderQuestion];
  assert.deepEqual(final.owners, [], "an invisible answer must not read a neighboring row/column");
  assert.equal(final.crop.width, 0); assert.equal(final.crop.height, 0);
  assert.ok(final.crop.x >= 0 && final.crop.x <= result.width && final.crop.y >= 0 && final.crop.y <= result.height);
  assert.deepEqual(result.renderedOwners, []); assert.equal(result.renderedSize.blank, true);
  assert.ok(result.renderedSize.width > 0 && result.renderedSize.height > 0, "empty answers keep a usable blank tile");
});

test("pure geometry distinguishes raw model extents from visible intersections", async () => {
  const result = await page.evaluate(() => {
    const reference = { paper: { width: 148, height: 210 }, headerMm: { left: 10, top: 10, right: 138, bottom: 22 }, gridMm: { left: 10, top: 36.5, right: 74, bottom: 195.5 } };
    const header = { left: 10 / 148, top: 30 / 210, right: 138 / 148, bottom: 42 / 210 }, size = { width: 888, height: 1260 };
    const prediction = YutoriSheetGeometry.predictFromHeader(reference, header, size);
    return { prediction, cell: YutoriSheetGeometry.questionRect(prediction.grid, { rows: 10, cols: 1 }, 9), mapped: YutoriSheetGeometry.mapReferenceRect(reference.gridMm, reference, header, size), negativeCell: YutoriSheetGeometry.questionRect({ left: -.1, top: -.1, right: 1.1, bottom: 1.1 }, { rows: 2, cols: 2 }, 0), hidden: typeof YutoriSheetGeometry.clipRect === "function" ? YutoriSheetGeometry.clipRect({ left: 1.1, top: .1, right: 1.2, bottom: .2 }) : "missing" };
  });
  near(result.prediction.grid.bottom, 215.5 / 210); near(result.cell.top, 199.6 / 210); near(result.cell.height, 15.9 / 210);
  assert.equal(result.prediction.visibleGrid.bottom, 1); assert.equal(result.mapped.bottom, 1);
  near(result.negativeCell.left, -.1); near(result.negativeCell.top, -.1); near(result.negativeCell.width, .6); near(result.negativeCell.height, .6);
  assert.equal(result.hidden, null);
});
