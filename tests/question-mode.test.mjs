import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { readFile, stat } from "node:fs/promises";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import test, { after, before, beforeEach } from "node:test";

const require = createRequire(import.meta.url);
const { chromium } = require("playwright");
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const mimeTypes = new Map([[".html", "text/html; charset=utf-8"], [".js", "text/javascript; charset=utf-8"], [".ttf", "font/ttf"], [".svg", "image/svg+xml"]]);
let server, browser, page, origin;

before(async () => {
  server = http.createServer(async (request, response) => {
    const requestPath = decodeURIComponent(new URL(request.url, "http://localhost").pathname);
    const filePath = path.resolve(root, requestPath === "/" ? "index.html" : requestPath.slice(1));
    if (!filePath.startsWith(`${root}${path.sep}`)) return response.writeHead(403).end();
    try {
      if (!(await stat(filePath)).isFile()) throw new Error("not a file");
      response.writeHead(200, { "content-type": mimeTypes.get(path.extname(filePath)) || "application/octet-stream" });
      response.end(await readFile(filePath));
    } catch {
      response.writeHead(404).end();
    }
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  origin = `http://127.0.0.1:${server.address().port}`;
  const executablePath = [process.env.PLAYWRIGHT_CHROMIUM_PATH, chromium.executablePath(), "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe"].find(candidate => candidate && existsSync(candidate));
  browser = await chromium.launch({ executablePath, headless: true });
});

beforeEach(async () => {
  await page?.context().close();
  const context = await browser.newContext({ serviceWorkers: "block" });
  page = await context.newPage();
  page.setDefaultTimeout(1_500);
  await page.goto(`${origin}/index.html`, { waitUntil: "domcontentloaded", timeout: 15_000 });
  await page.evaluate(() => {
    createNewTest();
    setEditorAccordion(3, true);
  });
});

after(async () => {
  await browser?.close();
  server?.closeAllConnections();
  await new Promise(resolve => server?.close(resolve));
});

test("separate question sheets accept one answer per line and retain commas inside answers", async () => {
  const result = await page.evaluate(() => {
    state.questionMode = "separate";
    const separate = document.querySelector('input[name="questionMode"][value="separate"]');
    if (separate) separate.checked = true;
    document.getElementById("pasteArea").value = "apple\nHello, world\n\n  dog  \n";
    applyPaste();
    return { questions: state.questions, answers: state.answers };
  });
  assert.deepEqual(result, { questions: ["", "", "", ""], answers: ["apple", "Hello, world", "", "dog"] });
});

test("blank answer cells keep their problem numbers when pasted or reopened and reapplied", async () => {
  await selectMode("separate");
  await page.locator("#pasteArea").fill("\napple\n\ndog\n");
  await page.locator("#applyPasteButton").click();
  assert.deepEqual(await page.evaluate(() => state.answers), ["", "apple", "", "dog"]);
  const reopened = await page.evaluate(() => {
    applyTestToEditor({ questionMode: "separate", questions: ["", "", "", ""], answers: ["apple", "", "dog", ""] });
    applyPaste();
    return { questions: state.questions, answers: state.answers };
  });
  assert.deepEqual(reopened, { questions: ["", "", "", ""], answers: ["apple", "", "dog", ""] });
});

test("two-column paste preserves a leading empty question cell", async () => {
  const result = await page.evaluate(() => {
    document.getElementById("pasteArea").value = "\tapple\n犬\tdog\n";
    applyPaste();
    return { questions: state.questions, answers: state.answers };
  });
  assert.deepEqual(result, { questions: ["", "犬"], answers: ["apple", "dog"] });
});

test("copying an old test defaults to inline while a separate test keeps its mode", async () => {
  const modes = await page.evaluate(() => [copyTestState({}).questionMode, copyTestState({ questionMode: "separate" }).questionMode]);
  assert.deepEqual(modes, ["inline", "separate"]);
});

async function selectMode(mode) {
  const radio = page.locator(`input[name="questionMode"][value="${mode}"]`);
  assert.equal(await radio.count(), 1, `${mode} must be available as an input choice`);
  await radio.check();
}

test("the input mode changes paste instructions and visible columns without discarding questions", async () => {
  await page.locator("#pasteArea").fill("りんご\tapple\n犬\tdog");
  await page.locator('button[onclick="applyPaste()"]').click();
  assert.equal(await page.locator('#questionRows input[placeholder="問題"]:visible').count(), 2);
  assert.match(await page.locator("#pasteHelp").textContent(), /2列/);
  assert.match(await page.locator("#pasteArea").getAttribute("placeholder"), /\t/);
  await selectMode("separate");
  assert.match(await page.locator("#pasteHelp").textContent(), /1列/);
  assert.match(await page.locator("#applyPasteButton").textContent(), /1列/);
  assert.doesNotMatch(await page.locator("#pasteArea").getAttribute("placeholder"), /\t/);
  assert.equal(await page.locator('#questionRows input[placeholder="問題"]:visible').count(), 0);
  assert.equal(await page.locator('#questionRows input[placeholder="模範解答"]:visible').count(), 2);
  assert.equal(await page.locator("#questionTable").isVisible(), true);
  assert.deepEqual(await page.evaluate(() => state.questions), ["りんご", "犬"]);
  await selectMode("inline");
  assert.match(await page.locator("#applyPasteButton").textContent(), /2列/);
  assert.deepEqual(await page.locator('#questionRows input[placeholder="問題"]:visible').evaluateAll(inputs => inputs.map(input => input.value)), ["りんご", "犬"]);
});

test("separate mode rejects two-column paste without replacing the current answers", async () => {
  await selectMode("separate");
  await page.locator("#pasteArea").fill("apple\ndog");
  await page.locator("#applyPasteButton").click();
  await page.locator("#pasteArea").fill("りんご\tapple\n犬\tdog");
  let alertMessage = "";
  page.once("dialog", async dialog => { alertMessage = dialog.message(); await dialog.accept(); });
  await page.locator("#applyPasteButton").click();
  assert.ok(alertMessage, "the user should be told that this mode accepts only one column");
  assert.deepEqual(await page.evaluate(() => ({ questions: state.questions, answers: state.answers })), { questions: ["", ""], answers: ["apple", "dog"] });
});

test("separate mode prints numbers without retained question text and keeps grid positions", async () => {
  await page.evaluate(() => {
    applyTestToEditor({ questions: ["りんご", "犬"], answers: ["apple", "dog"], rows: 10, cols: 3 });
    setEditorAccordion(3, true);
    renderPaper();
  });
  const inline = await page.locator("#paper .problem-cell").evaluateAll(cells => cells.map(cell => ({ x: cell.offsetLeft, y: cell.offsetTop, width: cell.offsetWidth, height: cell.offsetHeight })));
  assert.equal(await page.locator("#paper .problem-text").first().textContent(), "りんご");
  await selectMode("separate");
  await page.evaluate(() => renderPaper());
  await page.emulateMedia({ media: "print" });
  assert.equal(await page.locator("#paper .problem-text").count(), 0);
  assert.deepEqual(await page.locator("#paper .problem-no").allTextContents(), ["01", "02"]);
  await page.emulateMedia({ media: "screen" });
  const separate = await page.locator("#paper .problem-cell").evaluateAll(cells => cells.map(cell => ({ x: cell.offsetLeft, y: cell.offsetTop, width: cell.offsetWidth, height: cell.offsetHeight })));
  assert.deepEqual(separate, inline, "a mode change must not move answer boxes away from the scan coordinates");
});

test("saved tests and duplicates reopen with one-column answers and the chosen mode", async () => {
  await selectMode("separate");
  await page.locator("#pasteArea").fill("apple\nHello, world");
  await page.locator("#applyPasteButton").click();
  const saved = await page.evaluate(() => {
    const id = saveCurrentTest();
    duplicateSavedTest(id);
    return readSavedTests();
  });
  assert.equal(saved.length, 2);
  assert.ok(saved.every(item => item.questionMode === "separate"));
  for (const item of saved) {
    await page.evaluate(id => openSavedTest(id), item.id);
    assert.equal(await page.locator('input[name="questionMode"][value="separate"]').isChecked(), true);
    assert.equal(await page.locator("#pasteArea").inputValue(), "apple\nHello, world");
  }
});

test("a draft reload restores separate mode while a legacy draft defaults to inline", async () => {
  await selectMode("separate");
  await page.locator("#pasteArea").fill("apple\ndog");
  await page.locator("#applyPasteButton").click();
  const persisted = await page.evaluate(() => { saveDraftNow(); return JSON.parse(localStorage.getItem(CURRENT_DRAFT_KEY)); });
  assert.equal(persisted.state.questionMode, "separate");
  await page.reload({ waitUntil: "domcontentloaded" });
  assert.equal(await page.locator('input[name="questionMode"][value="separate"]').isChecked(), true);
  assert.deepEqual(await page.evaluate(() => ({ mode: state.questionMode, answers: state.answers })), { mode: "separate", answers: ["apple", "dog"] });
  await page.evaluate(() => {
    clearTimeout(draftSaveTimer);
    localStorage.setItem(CURRENT_DRAFT_KEY, JSON.stringify({ state: { questions: ["りんご"], answers: ["apple"] } }));
  });
  await page.reload({ waitUntil: "domcontentloaded" });
  assert.equal(await page.locator('input[name="questionMode"][value="inline"]').isChecked(), true);
  assert.equal(await page.evaluate(() => state.questionMode), "inline");
});

test("grading uses the current unsaved mode and serializes it", async () => {
  await selectMode("separate");
  const result = await page.evaluate(() => {
    refreshGradeUi();
    return { mode: currentTest().questionMode, serialized: serializeSession().questionMode };
  });
  assert.deepEqual(result, { mode: "separate", serialized: "separate" });
});

test("grading preserves saved-test modes including the default for legacy tests", async () => {
  const result = await page.evaluate(() => {
    writeSavedTests([
      { id: "separate-test", questionMode: "separate", questions: [""], answers: ["apple"] },
      { id: "legacy-test", questions: ["りんご"], answers: ["apple"] },
    ]);
    refreshGradeUi();
    return gradingState.testSets.map(item => {
      gradingState.selectedTestId = item.id;
      return { mode: item.questionMode, serialized: serializeSession().questionMode };
    });
  });
  assert.deepEqual(result, [{ mode: "separate", serialized: "separate" }, { mode: "inline", serialized: "inline" }]);
});

test("resuming sessions uses each snapshot's mode and treats missing mode as inline even if the saved test changed", async () => {
  const modes = await page.evaluate(async () => {
    writeSavedTests([{ id: "test-changed", questionMode: "separate", questions: [""], answers: ["apple"] }]);
    localStorage.setItem(sessionsKey(), JSON.stringify([
      { id: "legacy-session", selectedTestId: "test-changed", questions: ["りんご"], modelAnswers: ["apple"], classes: [] },
      { id: "separate-session", selectedTestId: "test-changed", questionMode: "separate", questions: [""], modelAnswers: ["apple"], classes: [] },
    ]));
    const values = [];
    for (const id of ["legacy-session", "separate-session"]) {
      await resumeGradingSession(id);
      values.push({ mode: currentTest().questionMode, serialized: serializeSession().questionMode });
    }
    return values;
  });
  assert.deepEqual(modes, [{ mode: "inline", serialized: "inline" }, { mode: "separate", serialized: "separate" }]);
});

// These image dimensions and cell bounds come from A4 at 10 pixels/mm:
// 10 mm side/bottom margins, a 40 mm header, 10 rows, and 3 columns.
// They are deliberately independent of the production geometry helpers.
const cropFixtures = [
  { orientation: "portrait", width: 2100, height: 2970, renderedHeight: 183, cells: [
    { q: 0, left: 100, top: 400, right: 733.333333, bottom: 647 },
    { q: 9, left: 100, top: 2623, right: 733.333333, bottom: 2870 },
    { q: 10, left: 733.333333, top: 400, right: 1366.666667, bottom: 647 },
    { q: 29, left: 1366.666667, top: 2623, right: 2000, bottom: 2870 },
  ] },
  { orientation: "landscape", width: 2970, height: 2100, renderedHeight: 79, cells: [
    { q: 0, left: 100, top: 400, right: 1023.333333, bottom: 560 },
    { q: 9, left: 100, top: 1840, right: 1023.333333, bottom: 2000 },
    { q: 10, left: 1023.333333, top: 400, right: 1946.666667, bottom: 560 },
    { q: 29, left: 1946.666667, top: 1840, right: 2870, bottom: 2000 },
  ] },
];

async function cropSyntheticSheet({ fixture, answerLine, questionMode, render = false }) {
  const canvas = document.createElement("canvas");
  canvas.width = fixture.width;
  canvas.height = fixture.height;
  const context = canvas.getContext("2d");
  context.fillStyle = "white";
  context.fillRect(0, 0, canvas.width, canvas.height);
  context.strokeStyle = "black";
  context.lineWidth = 2;
  for (let col = 0; col <= 3; col++) {
    const x = 100 + col * (fixture.width - 200) / 3;
    context.beginPath(); context.moveTo(x, 400); context.lineTo(x, fixture.height - 100); context.stroke();
  }
  for (let row = 0; row <= 10; row++) {
    const y = 400 + row * (fixture.height - 500) / 10;
    context.beginPath(); context.moveTo(100, y); context.lineTo(fixture.width - 100, y); context.stroke();
  }
  for (const cell of fixture.cells) {
    const guides = answerLine === "fourline" ? [.35, .50, .65, .80] : answerLine === "third" ? [.65] : [];
    context.lineWidth = 3;
    for (const position of guides) {
      context.strokeStyle = position === .65 ? "#ff5555" : "#55bbff";
      const y = cell.top + (cell.bottom - cell.top) * position;
      context.beginPath(); context.moveTo(cell.left + 25, y); context.lineTo(cell.right - 25, y); context.stroke();
    }
    context.fillStyle = "#008000";
    for (const x of [cell.left + 11, cell.right - 17]) {
      for (const y of [cell.top + 11, cell.bottom - 17]) context.fillRect(x, y, 6, 6);
    }
  }
  const source = canvas.toDataURL();
  const image = new Image();
  image.src = source;
  await image.decode();
  const testState = { paperSize: "a4", orientation: fixture.orientation, rows: 10, cols: 3, flow: "column", answerLine, questionMode, questions: Array(30).fill(""), answers: Array(30).fill("apple") };
  const crops = fixture.cells.map(cell => answerCropRect(image, testState, cell.q));
  if (!render) return { crops };
  const target = document.createElement("canvas");
  target.className = "answer-crop-canvas";
  target.dataset.pageId = "synthetic-sheet";
  target.dataset.questionIndex = "0";
  document.body.appendChild(target);
  gradingState.pageImageUrls["synthetic-sheet"] = source;
  await renderAnswerCrops(0, testState);
  const pixels = target.getContext("2d").getImageData(0, 0, target.width, target.height).data;
  const inkQuadrants = new Set();
  for (let y = 0; y < target.height; y++) {
    for (let x = 0; x < target.width; x++) {
      const i = (y * target.width + x) * 4;
      if (pixels[i + 1] > pixels[i] + 40 && pixels[i + 1] > pixels[i + 2] + 40) inkQuadrants.add(`${x < target.width / 2 ? "left" : "right"}-${y < target.height / 2 ? "top" : "bottom"}`);
    }
  }
  return { crops, rendered: { width: target.width, height: target.height, inkQuadrants: [...inkQuadrants].sort() } };
}

for (const fixture of cropFixtures) {
  for (const answerLine of ["fourline", "third", "none"]) {
    test(`separate ${fixture.orientation} ${answerLine} crops keep the whole cell interior including boundary writing`, async () => {
      const { crops } = await page.evaluate(cropSyntheticSheet, { fixture, answerLine, questionMode: "separate" });
      for (let i = 0; i < crops.length; i++) {
        const crop = crops[i], cell = fixture.cells[i];
        const edges = { left: crop.x, top: crop.y, right: crop.x + crop.width, bottom: crop.y + crop.height };
        const expected = { left: cell.left + 5, top: cell.top + 5, right: cell.right - 5, bottom: cell.bottom - 5 };
        for (const edge of ["left", "top", "right", "bottom"]) {
          assert.ok(Math.abs(edges[edge] - expected[edge]) < 4, `question ${cell.q + 1} ${edge}: expected ${expected[edge]}, received ${edges[edge]}`);
        }
      }
    });
  }

  test(`separate ${fixture.orientation} rendered answer crops preserve proportions and writing at all four corners`, async () => {
    const { rendered } = await page.evaluate(cropSyntheticSheet, { fixture, answerLine: "fourline", questionMode: "separate", render: true });
    assert.equal(rendered.width, 480);
    assert.ok(Math.abs(rendered.height - fixture.renderedHeight) <= 2, `expected height near ${fixture.renderedHeight}, received ${rendered.height}`);
    assert.deepEqual(rendered.inkQuadrants, ["left-bottom", "left-top", "right-bottom", "right-top"]);
  });

  test(`legacy ${fixture.orientation} answer crops still exclude the printed question area`, async () => {
    const { crops, rendered } = await page.evaluate(cropSyntheticSheet, { fixture, answerLine: "fourline", render: true });
    for (let i = 0; i < crops.length; i++) {
      assert.ok(crops[i].y >= fixture.cells[i].top + 35, `question ${fixture.cells[i].q + 1} includes its printed heading`);
      assert.ok(Math.abs(crops[i].x - fixture.cells[i].left - 15) < 4, "legacy horizontal margins should remain unchanged");
    }
    assert.equal(rendered.height, 128);
  });
}
