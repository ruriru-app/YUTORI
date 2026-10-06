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
  const context = await browser.newContext({ serviceWorkers: "block", viewport: { width: 1280, height: 900 } });
  page = await context.newPage();
  await page.goto(`${origin}/index.html`, { waitUntil: "domcontentloaded", timeout: 15_000 });
});

after(async () => {
  await browser?.close();
  server?.closeAllConnections();
  await new Promise(resolve => server?.close(resolve));
});

// Synthetic A4 sheets at 10 pixels/mm, with visible marks near all four corners.
// Real card builders and the production renderer connect the bitmap to live CSS.
async function prepareTiles({ orientation = "portrait", rows = 10, cols = 3, width = 400, questionMode = "separate", render = true } = {}) {
  const source = document.createElement("canvas");
  source.width = orientation === "portrait" ? 2100 : 2970;
  source.height = orientation === "portrait" ? 2970 : 2100;
  const context = source.getContext("2d");
  context.fillStyle = "white";
  context.fillRect(0, 0, source.width, source.height);
  const cellWidth = (source.width - 200) / cols, cellHeight = (source.height - 500) / rows;
  context.strokeStyle = "black";
  context.lineWidth = 2;
  for (let col = 0; col <= cols; col++) {
    const x = 100 + col * cellWidth;
    context.beginPath(); context.moveTo(x, 400); context.lineTo(x, source.height - 100); context.stroke();
  }
  for (let row = 0; row <= rows; row++) {
    const y = 400 + row * cellHeight;
    context.beginPath(); context.moveTo(100, y); context.lineTo(source.width - 100, y); context.stroke();
  }
  context.fillStyle = "#008000";
  for (const x of [111, 100 + cellWidth - 19]) {
    for (const y of [411, 400 + cellHeight - 19]) context.fillRect(x, y, 8, 8);
  }
  gradingState.pageImageUrls["synthetic-layout"] = source.toDataURL();
  const host = document.createElement("div");
  host.id = "tile-layout-fixture";
  host.style.cssText = `position:fixed;top:0;left:0;width:${width}px;z-index:9999`;
  document.body.appendChild(host);
  const person = { pageId: "synthetic-layout", no: 1, name: "Synthetic" };
  const testState = { paperSize: "a4", orientation, rows, cols, flow: "column", answerLine: "none", questionMode, questions: [""], answers: ["sample"] };
  host.innerHTML = card("synthetic", person, 0) + individualQuestionCard("synthetic", person, 0, testState);
  window.tileLayoutTestState = testState;
  if (render) await renderAnswerCrops(0, testState);
}

function measureTiles() {
  return [...document.querySelectorAll("#tile-layout-fixture .answer-image,#tile-layout-fixture .individual-answer-image")].map(box => {
    const canvas = box.querySelector("canvas"), bounds = box.getBoundingClientRect(), style = getComputedStyle(box);
    const canvasBounds = canvas?.getBoundingClientRect();
    const result = {
      kind: box.classList.contains("individual-answer-image") ? "individual" : "normal",
      width: bounds.width,
      height: bounds.height,
      contentWidth: bounds.width - parseFloat(style.borderLeftWidth) - parseFloat(style.borderRightWidth),
      contentHeight: bounds.height - parseFloat(style.borderTopWidth) - parseFloat(style.borderBottomWidth),
      canvasWidth: canvasBounds?.width,
      canvasHeight: canvasBounds?.height,
      bitmapWidth: canvas?.width,
      bitmapHeight: canvas?.height,
    };
    if (canvas) {
      const pixels = canvas.getContext("2d").getImageData(0, 0, canvas.width, canvas.height).data;
      const corners = new Set();
      for (let y = 0; y < canvas.height; y++) {
        for (let x = 0; x < canvas.width; x++) {
          const index = (y * canvas.width + x) * 4;
          if (pixels[index + 1] > pixels[index] + 40 && pixels[index + 1] > pixels[index + 2] + 40) corners.add(`${x < canvas.width / 2 ? "left" : "right"}-${y < canvas.height / 2 ? "top" : "bottom"}`);
        }
      }
      result.corners = [...corners].sort();
    }
    return result;
  });
}

function assertNaturalLayout(tiles) {
  assert.equal(tiles.length, 2, "both grading layouts must be exercised");
  for (const tile of tiles) {
    assert.ok(Math.abs(tile.canvasWidth - tile.contentWidth) < 1, `${tile.kind}: answer must use the available tile width`);
    const expectedHeight = tile.canvasWidth * tile.bitmapHeight / tile.bitmapWidth;
    assert.ok(Math.abs(tile.canvasHeight - expectedHeight) < 1, `${tile.kind}: bitmap proportions require displayed height ${expectedHeight}, received ${tile.canvasHeight}`);
    assert.ok(Math.abs(tile.contentHeight - tile.canvasHeight) < 1, `${tile.kind}: wrapper must follow the image height without clipping or blank space`);
    assert.deepEqual(tile.corners, ["left-bottom", "left-top", "right-bottom", "right-top"], `${tile.kind}: the whole answer must remain visible`);
  }
}

for (const fixture of [
  { name: "portrait 10 by 3", orientation: "portrait", rows: 10, cols: 3 },
  { name: "landscape 10 by 3", orientation: "landscape", rows: 10, cols: 3 },
  { name: "portrait 5 by 4", orientation: "portrait", rows: 5, cols: 4 },
]) {
  for (const width of [180, 460]) {
    test(`separate ${fixture.name} answers fill ${width}px cards with their own proportions`, async () => {
      await page.evaluate(prepareTiles, { ...fixture, width });
      assertNaturalLayout(await page.evaluate(measureTiles));
    });
  }
}

test("separate answer tiles adapt to available width without recropping", async () => {
  await page.evaluate(prepareTiles, { width: 460 });
  assertNaturalLayout(await page.evaluate(measureTiles));
  await page.evaluate(() => { document.getElementById("tile-layout-fixture").style.width = "180px"; });
  assertNaturalLayout(await page.evaluate(measureTiles));
});

test("switching back to inline mode restores the existing compact tile shape", async () => {
  await page.evaluate(prepareTiles);
  assertNaturalLayout(await page.evaluate(measureTiles));
  await page.evaluate(async () => {
    tileLayoutTestState.questionMode = "inline";
    await renderAnswerCrops(0, tileLayoutTestState);
  });
  for (const tile of await page.evaluate(measureTiles)) {
    assert.equal(tile.bitmapHeight, 128);
    assert.ok(Math.abs(tile.height - tile.width * 4 / 15) < 1, `${tile.kind}: inline mode must keep the compact layout`);
  }
  await page.evaluate(async () => {
    tileLayoutTestState.questionMode = "separate";
    await renderAnswerCrops(0, tileLayoutTestState);
  });
  assertNaturalLayout(await page.evaluate(measureTiles));
});

test("missing image retries clear a previous crop and restore a stable placeholder size", async () => {
  await page.evaluate(prepareTiles);
  assertNaturalLayout(await page.evaluate(measureTiles));
  await page.evaluate(async () => {
    document.querySelectorAll("#tile-layout-fixture canvas").forEach(canvas => { canvas.dataset.pageId = "missing-image"; });
    await renderAnswerCrops(0, tileLayoutTestState);
  });
  for (const tile of await page.evaluate(measureTiles)) {
    assert.ok(Math.abs(tile.height - tile.width * 4 / 15) < 1, `${tile.kind}: failed image must not retain the previous tall layout`);
    assert.deepEqual(tile.corners, [], `${tile.kind}: failed image must not display an unrelated previous answer`);
  }
});

test("loading and unavailable images keep usable compact placeholders", async () => {
  await page.evaluate(prepareTiles, { render: false });
  for (const tile of await page.evaluate(measureTiles)) {
    assert.ok(Math.abs(tile.height - tile.width * 4 / 15) < 1, `${tile.kind}: initial loading layout must stay compact`);
  }
  await page.evaluate(() => {
    const host = document.getElementById("tile-layout-fixture");
    const person = { no: 1, name: "Synthetic" };
    host.innerHTML = card("synthetic", { ...person, absent: true }, 0) + individualQuestionCard("synthetic", person, 0, tileLayoutTestState);
  });
  for (const tile of await page.evaluate(measureTiles)) {
    assert.ok(tile.height > 30, `${tile.kind}: placeholder must remain visible`);
    assert.ok(Math.abs(tile.height - tile.width * 4 / 15) < 1, `${tile.kind}: absent or unavailable image must retain its placeholder layout`);
  }
});
