import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { readFile, stat } from "node:fs/promises";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import test, { after, before } from "node:test";

const require = createRequire(import.meta.url);
const { chromium } = require("playwright");
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const mimeTypes = new Map([
  [".html", "text/html; charset=utf-8"],
  [".js", "text/javascript; charset=utf-8"],
  [".ttf", "font/ttf"],
  [".svg", "image/svg+xml"],
]);

let server;
let browser;
let page;

function browserExecutablePath() {
  return [
    process.env.PLAYWRIGHT_CHROMIUM_PATH,
    chromium.executablePath(),
    "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
    "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
    "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe",
  ].find(candidate => candidate && existsSync(candidate));
}

before(async () => {
  server = http.createServer(async (request, response) => {
    const requestPath = decodeURIComponent(new URL(request.url, "http://localhost").pathname);
    const relativePath = requestPath === "/" ? "index.html" : requestPath.slice(1);
    const filePath = path.resolve(root, relativePath);
    if (!filePath.startsWith(`${root}${path.sep}`) && filePath !== path.join(root, "index.html")) {
      response.writeHead(403).end();
      return;
    }
    try {
      const info = await stat(filePath);
      if (!info.isFile()) throw new Error("not a file");
      response.writeHead(200, { "content-type": mimeTypes.get(path.extname(filePath)) || "application/octet-stream" });
      response.end(await readFile(filePath));
    } catch {
      response.writeHead(404).end();
    }
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  browser = await chromium.launch({ executablePath: browserExecutablePath(), headless: true });
  page = await browser.newPage();
  page.setDefaultTimeout(1_500);
  const { port } = server.address();
  await page.goto(`http://127.0.0.1:${port}/index.html`, { waitUntil: "domcontentloaded", timeout: 15_000 });
});

after(async () => {
  await browser?.close();
  server?.closeAllConnections();
  await new Promise(resolve => server?.close(resolve));
});

async function renderPracticeItems(items) {
  await page.evaluate(itemsToRender => {
    const session = { testName: "Alphabet", orientation: "portrait" };
    const person = { no: 1, name: "Test Student" };
    document.body.innerHTML = returnPracticeSheetHtml(session, "1組", person, itemsToRender);
  }, items);
}

test("each practice row starts with its model answer and does not repeat it above the four lines", async () => {
  await renderPracticeItems([{ q: 0, question: "Write the letters", answer: "Aa", rate: 50 }]);

  assert.equal(await page.locator(".return-four-lines .return-practice-model-answer").textContent(), "Aa");
  assert.equal(await page.locator(".return-practice-detail-answer").count(), 0);
});

test("the line-leading model answer uses the bundled RuRiRu font", async () => {
  await renderPracticeItems([{ q: 0, question: "Write the letters", answer: "Agjy", rate: 50 }]);

  const result = await page.locator(".return-practice-model-answer").evaluate(async element => {
    await document.fonts.ready;
    return {
      family: getComputedStyle(element).fontFamily,
      loaded: document.fonts.check('24px "RuRiRu Font"', element.textContent),
    };
  });
  assert.match(result.family, /RuRiRu Font/);
  assert.equal(result.loaded, true);
});

test("a long model answer is smaller than a short one so practice space remains", async () => {
  await renderPracticeItems([
    { q: 0, question: "Short", answer: "Aa", rate: 50 },
    { q: 1, question: "Long", answer: "abcdefghijklmnopqrstuvwxyz", rate: 50 },
  ]);

  const sizes = await page.locator(".return-practice-model-answer").evaluateAll(elements =>
    elements.map(element => Number.parseFloat(getComputedStyle(element).fontSize)),
  );
  assert.ok(sizes[1] < sizes[0], `expected long answer (${sizes[1]}) to be smaller than short answer (${sizes[0]})`);
});
