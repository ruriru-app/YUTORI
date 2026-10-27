import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { readFile, stat, mkdir } from "node:fs/promises";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import test, { before, beforeEach, after } from "node:test";

const require = createRequire(import.meta.url);
const { chromium } = require("playwright");
const { PDFDocument } = require("pdf-lib");
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
let server, browser, page, origin;

before(async () => {
  server = http.createServer(async (request, response) => {
    const file = path.resolve(root, decodeURIComponent(new URL(request.url, "http://localhost").pathname).slice(1) || "index.html");
    if (!file.startsWith(root + path.sep)) return response.writeHead(403).end();
    try {
      if (!(await stat(file)).isFile()) throw new Error("not file");
      response.writeHead(200, { "content-type": ({ ".html": "text/html; charset=utf-8", ".js": "text/javascript", ".ttf": "font/ttf", ".svg": "image/svg+xml" })[path.extname(file)] || "application/octet-stream" });
      response.end(await readFile(file));
    } catch { response.writeHead(404).end(); }
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  origin = `http://127.0.0.1:${server.address().port}`;
  const executablePath = [process.env.PLAYWRIGHT_CHROMIUM_PATH, chromium.executablePath(), "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe"].find(value => value && existsSync(value));
  browser = await chromium.launch({ executablePath, headless: true });
});

beforeEach(async () => {
  await page?.context().close();
  page = await (await browser.newContext({ serviceWorkers: "block" })).newPage();
  await page.goto(origin, { waitUntil: "domcontentloaded" });
  await page.evaluate(() => globalThis.yutoriAppInitialization);
});

after(async () => {
  await browser?.close();
  server?.closeAllConnections();
  await new Promise(resolve => server?.close(resolve));
});

async function prepare(paperSize = "a5", orientation = "portrait", a5PrintMode = "two-up") {
  await page.evaluate(({ paperSize, orientation, a5PrintMode }) => {
    applyTestToEditor({ paperSize, orientation, a5PrintMode, rows: 5, cols: 2, flow: "row", answerFormat: "extended", subject: "確認教科", unit: "合成用紙", testName: "印刷確認", questions: ["りんご", "犬", "本"], answers: ["apple", "dog", "book"] });
    window.print = () => {};
    printDocument();
  }, { paperSize, orientation, a5PrintMode });
  await page.emulateMedia({ media: "print" });
}

const pointsPerMm = 72 / 25.4;
function near(actual, mm, label) {
  assert.ok(Math.abs(actual - mm * pointsPerMm) < 1, `${label}: ${actual}pt should be ${mm}mm`);
}

// Catches missing imposition, wrong physical orientation, scaling, or an extra page.
for (const [orientation, width, height, copyWidth, copyHeight] of [
  ["portrait", 297, 210, 148, 210], ["landscape", 210, 297, 210, 148]
]) {
  test(`A5 two-up ${orientation} outputs one physical A4 page`, async () => {
    await prepare("a5", orientation);
    const boxes = await page.locator("#testPrintRoot .paper").evaluateAll(nodes => nodes.map(node => {
      const b = node.getBoundingClientRect();
      return { x: b.x * .75, y: b.y * .75, width: b.width * .75, height: b.height * .75, transform: getComputedStyle(node).transform, zoom: getComputedStyle(node).zoom };
    }));
    assert.equal(boxes.length, 2, "A5 two-up needs two independent paper copies");
    for (const box of boxes) {
      near(box.width, copyWidth, "copy width"); near(box.height, copyHeight, "copy height");
      assert.equal(box.transform, "none"); assert.equal(box.zoom, "1");
    }
    near(orientation === "portrait" ? boxes[0].x : boxes[0].y, .5, "outer slack");
    near(orientation === "portrait" ? boxes[1].x : boxes[1].y, 148.5, "second copy starts after first");
    const bytes = await page.pdf({ printBackground: true, preferCSSPageSize: true });
    const pdf = await PDFDocument.load(bytes);
    assert.equal(pdf.getPageCount(), 1);
    near(pdf.getPage(0).getWidth(), width, "physical width"); near(pdf.getPage(0).getHeight(), height, "physical height");
    if (process.env.YUTORI_PRINT_QA_DIR) {
      await mkdir(process.env.YUTORI_PRINT_QA_DIR, { recursive: true });
      // Render the actual generated PDF with the app's existing local PDF engine.
      await page.evaluate(async data => {
        const pdf = await pdfjsLib.getDocument({ data: new Uint8Array(data) }).promise;
        const pdfPage = await pdf.getPage(1), viewport = pdfPage.getViewport({ scale: 1.5 });
        const canvas = document.createElement("canvas"); canvas.id = "printQaCanvas";
        canvas.width = viewport.width; canvas.height = viewport.height;
        document.body.appendChild(canvas);
        await pdfPage.render({ canvasContext: canvas.getContext("2d"), viewport }).promise;
      }, [...bytes]);
      await page.locator("#printQaCanvas").screenshot({ path: path.join(process.env.YUTORI_PRINT_QA_DIR, `a5-${orientation}.png`) });
    }
  });
}

test("two copies have identical question, header and title content from canonical markup", async () => {
  await prepare();
  const result = await page.evaluate(() => {
    const copies = [...document.querySelectorAll("#testPrintRoot .paper")];
    const canonical = typeof paperMarkupForTest === "function" ? paperMarkupForTest(copyTestState(state)) : null;
    const html = copies.map(node => node.innerHTML);
    const before = JSON.stringify(state), editor = document.getElementById("paper").innerHTML;
    const other = typeof paperMarkupForTest === "function" ? paperMarkupForTest({ ...copyTestState(state), questions: ["別内容"], questionMode: "separate", fourLineHeight: "large" }) : "";
    return { html, canonical, editor, unchanged: before === JSON.stringify(state) && editor === document.getElementById("paper").innerHTML, other, text: copies[0]?.textContent };
  });
  assert.equal(result.html.length, 2);
  assert.equal(result.html[0], result.html[1]); assert.equal(result.html[0], result.editor);
  assert.equal(result.canonical, result.editor);
  assert.match(result.text, /確認教科.*合成用紙.*印刷確認/s); assert.match(result.text, /りんご/);
  assert.equal(result.unchanged, true); assert.doesNotMatch(result.other, /problem-text/); assert.match(result.other, /fourline-large/);
});

for (const [paperSize, orientation, mode, width, height] of [
  ["a5", "portrait", "single", 148, 210], ["a5", "landscape", "single", 210, 148],
  ["a4", "portrait", "two-up", 210, 297], ["a4", "landscape", "two-up", 297, 210],
  ["b5", "portrait", "two-up", 182, 257], ["b5", "landscape", "two-up", 257, 182]
]) {
  test(`${paperSize} ${orientation} ${mode} retains its single physical sheet size`, async () => {
    await prepare(paperSize, orientation, mode);
    assert.equal(await page.locator("#testPrintRoot .paper").count(), 1);
    const pdf = await PDFDocument.load(await page.pdf({ printBackground: true, preferCSSPageSize: true }));
    assert.equal(pdf.getPageCount(), 1);
    near(pdf.getPage(0).getWidth(), width, "width"); near(pdf.getPage(0).getHeight(), height, "height");
  });
}

test("print choice survives draft, save, duplicate and reopen with absent-value two-up default", async () => {
  const result = await page.evaluate(() => {
    applyTestToEditor({ paperSize: "a5", a5PrintMode: "single", questions: ["確認"], answers: ["test"] });
    saveDraftNow();
    const draft = JSON.parse(localStorage.getItem(CURRENT_DRAFT_KEY));
    const id = saveCurrentTest(); duplicateSavedTest(id);
    const modes = readSavedTests().map(item => item.a5PrintMode);
    openSavedTest(id);
    const reopened = document.querySelector('input[name="a5PrintMode"]:checked')?.value;
    return { draft: draft.state.a5PrintMode, modes, reopened, absent: copyTestState({}).a5PrintMode, invalid: copyTestState({ a5PrintMode: "invalid" }).a5PrintMode };
  });
  assert.deepEqual(result, { draft: "single", modes: ["single", "single"], reopened: "single", absent: "two-up", invalid: "two-up" });
  await page.reload(); await page.evaluate(() => globalThis.yutoriAppInitialization);
  assert.equal(await page.locator('input[name="a5PrintMode"][value="single"]').isChecked(), true);
});

test("repeated, direct and return printing isolates roots and restores the editor after cancellation", async () => {
  const result = await page.evaluate(() => {
    applyTestToEditor({ paperSize: "a5", questions: ["確認"], answers: ["test"] });
    const title = document.title, parent = document.getElementById("paper").parentElement.id;
    const cycles = [];
    for (let i = 0; i < 2; i++) {
      window.dispatchEvent(new Event("beforeprint")); window.dispatchEvent(new Event("beforeprint"));
      cycles.push({ roots: document.querySelectorAll("#testPrintRoot").length, copies: document.querySelectorAll("#testPrintRoot .paper").length });
      window.dispatchEvent(new Event("afterprint"));
      cycles.push({ active: document.body.classList.contains("test-printing"), copies: document.querySelectorAll("#testPrintRoot .paper").length, title: document.title, parent: document.getElementById("paper").parentElement.id });
    }
    document.body.classList.add("return-printing");
    document.getElementById("returnPrintRoot").innerHTML = '<div class="return-print-page">synthetic return</div>';
    window.dispatchEvent(new Event("beforeprint"));
    const returning = { testActive: document.body.classList.contains("test-printing"), copies: document.querySelectorAll("#testPrintRoot .paper").length, returnText: document.getElementById("returnPrintRoot").textContent };
    window.dispatchEvent(new Event("afterprint"));
    window.print = () => { window.dispatchEvent(new Event("beforeprint")); window.dispatchEvent(new Event("afterprint")); };
    printDocument();
    return { title, parent, cycles, returning, final: { title: document.title, parent: document.getElementById("paper").parentElement.id, copies: document.querySelectorAll("#testPrintRoot .paper").length } };
  });
  for (let i = 0; i < 4; i += 2) {
    assert.deepEqual(result.cycles[i], { roots: 1, copies: 2 });
    assert.deepEqual(result.cycles[i + 1], { active: false, copies: 0, title: result.title, parent: result.parent });
  }
  assert.deepEqual(result.returning, { testActive: false, copies: 0, returnText: "synthetic return" });
  assert.deepEqual(result.final, { title: result.title, parent: result.parent, copies: 0 });
});

test("editor preview remains one logical sheet with A4 two-copy summary and A5-only controls", async () => {
  await page.evaluate(() => { applyTestToEditor({ paperSize: "a5", rows: 5, questions: ["確認"], answers: ["test"] }); setEditorAccordion(1, true); renderPaper(); updatePrintInfo(); });
  assert.equal(await page.locator('input[name="a5PrintMode"]').count(), 2);
  assert.equal(await page.locator('input[name="a5PrintMode"][value="two-up"]').isVisible(), true);
  assert.match(await page.locator("#livePreviewInfo").textContent(), /A4.*2枚/);
  assert.match(await page.locator("#printInfo").textContent(), /A4.*2枚/);
  const logical = await page.locator("#paper").evaluate(node => ({ width: parseFloat(getComputedStyle(node).width) * .75, height: parseFloat(getComputedStyle(node).height) * .75, count: document.querySelectorAll("#editorPaperHost .paper").length }));
  near(logical.width, 148, "logical width"); near(logical.height, 210, "logical height"); assert.equal(logical.count, 1);
  await page.locator('input[name="a5PrintMode"][value="single"]').check();
  await page.waitForFunction(() => state.a5PrintMode === "single" && !document.getElementById("livePreviewInfo").textContent.includes("A4"));
  assert.doesNotMatch(await page.locator("#livePreviewInfo").textContent(), /A4/);
  await page.locator("#paperSize").selectOption("a4");
  assert.equal(await page.locator('input[name="a5PrintMode"][value="single"]').isVisible(), false);
});
