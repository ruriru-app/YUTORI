import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { readFile, stat, mkdir } from "node:fs/promises";
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

async function renderPracticeItems(items, orientation = "portrait", width = 794) {
  await page.evaluate(async ({ itemsToRender, orientation, width }) => {
    const session = { testName: "Alphabet", orientation };
    const person = { no: 1, name: "Test Student" };
    await loadReturnPracticeFont();
    const rowHeight = returnPracticeRowHeight(session, itemsToRender.length);
    // The sheet renderer consumes already-wrapped rows in the real print pipeline.
    const rows = wrapReturnPracticeItems(itemsToRender, rowHeight);
    document.body.innerHTML = `<div style="width:${width}px">${returnPracticeSheetHtml(session, "1組", person, rows, 0, 1, rowHeight)}</div>`;
  }, { itemsToRender: items, orientation, width });
  await page.evaluate(() => document.fonts.ready);
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

test("short and long model answers use the same size and gray tracing ink", async () => {
  await renderPracticeItems([
    { q: 0, question: "Short", answer: "Aa", rate: 50 },
    { q: 1, question: "Long", answer: "abcdefghijklmnopqrstuvwxyz", rate: 50 },
  ]);

  const sizes = await page.locator(".return-practice-model-answer").evaluateAll(elements =>
    elements.map(element => Number.parseFloat(getComputedStyle(element).fontSize)),
  );
  assert.equal(sizes[1], sizes[0], "answer length must not change the model size");
  const fills = await page.locator(".return-practice-model-answer").evaluateAll(elements => elements.map(element => getComputedStyle(element).fill));
  assert.ok(fills.every(fill => fill === "rgb(150, 150, 150)"), "models should be gray enough for tracing");
});

test("model ink is not clipped at the top or bottom (including the T crossbar)", async () => {
  await renderPracticeItems([
    { q: 10, question: "いつも", answer: "always", rate: 62 },
    { q: 7, question: "むらさき", answer: "purple", rate: 57 },
    { q: 18, question: "風呂に入る", answer: "take a bath", rate: 57 },
    { q: 17, question: "テレビを見る", answer: "watch TV", rate: 48 },
  ], "landscape", 1000);
  const rows = page.locator(".return-practice-list");
  const normal = await rows.screenshot();
  await page.locator(".return-practice-model-answer").evaluateAll(elements => {
    for (const element of elements) element.style.overflow = "visible";
  });
  const unclipped = await rows.screenshot();
  assert.ok(normal.equals(unclipped), "removing the model's clipping exposes missing glyph strokes");
});

test("compact information stacks number, question and rate beside a wider writing area", async () => {
  await renderPracticeItems([{ q: 10, question: "いつも", answer: "always", rate: 62 }]);
  const geometry = await page.locator(".return-practice-work").evaluate(row => {
    const rect = selector => row.querySelector(selector).getBoundingClientRect();
    const number = rect(".return-practice-number"), question = rect(".return-practice-detail-question"), rate = rect(".return-practice-detail-rate");
    return { numberBottom: number.bottom, questionTop: question.top, questionBottom: question.bottom, rateTop: rate.top,
      numberLeft: number.left, questionLeft: question.left, rateLeft: rate.left,
      writingFraction: rect(".return-four-lines").width / row.getBoundingClientRect().width };
  });
  assert.ok(geometry.questionTop >= geometry.numberBottom - 1, "question should be below the number");
  assert.ok(geometry.rateTop >= geometry.questionBottom - 1, "rate should be below the question");
  assert.ok(Math.abs(geometry.numberLeft - geometry.questionLeft) < 1);
  assert.ok(Math.abs(geometry.numberLeft - geometry.rateLeft) < 1);
  assert.ok(geometry.writingFraction >= .84, "four lines should occupy at least 84% of the row");
});

test("all glyph strokes fit within the four-line area at preview and print sizes", async () => {
  const answers = ["watch TV", "always", "purple", "take a bath", "Agjypq", "ABCDEFGHIJKLMNOPQRSTUVWXYZ", "WWWWWWWWWWWWWWWWWWWWWWWW"];
  for (const [orientation, count, width] of [["portrait", 4, 480], ["portrait", 15, 794], ["landscape", 4, 794], ["landscape", 7, 1123]]) {
    const items = Array.from({ length: count }, (_, q) => ({ q, question: "文字を練習します", answer: answers[q % answers.length], rate: 62 }));
    await renderPracticeItems(items, orientation, width);
    const rows = await page.locator(".return-practice-model-answer").evaluateAll(elements => elements.map(text => {
      const svg = text.ownerSVGElement, box = svg.getBoundingClientRect(), style = getComputedStyle(text);
      const context = document.createElement("canvas").getContext("2d");
      context.font = `${style.fontSize} ${style.fontFamily}`;
      const ink = context.measureText(text.textContent), baseline = text.y.baseVal[0].value, x = text.x.baseVal[0].value;
      const guides = [...svg.parentElement.querySelectorAll("i")].map(line => (line.getBoundingClientRect().top + line.getBoundingClientRect().bottom) / 2 - box.top);
      const cap = context.measureText("T");
      return { answer: text.textContent, height: box.height, width: box.width,
        inkTop: baseline - ink.actualBoundingBoxAscent, inkBottom: baseline + ink.actualBoundingBoxDescent,
        inkLeft: x - ink.actualBoundingBoxLeft, inkRight: x + ink.actualBoundingBoxRight,
        capTop: baseline - cap.actualBoundingBoxAscent, guides };
    }));
    for (const row of rows) {
      const label = `${orientation}/${count}/${width}: ${row.answer}`;
      assert.ok(row.inkTop >= row.height * .05, `${label}: insufficient space above glyphs`);
      assert.ok(row.inkBottom <= row.height * .95, `${label}: insufficient space below glyphs`);
      assert.ok(row.inkLeft >= 0, `${label}: clips the first glyph`);
      assert.ok(row.inkRight <= row.width + 1, `${label}: overflows the writing area`);
      assert.ok(Math.abs(row.guides[2] - row.height * .61) < 1, `${label}: baseline differs from third line`);
      if (row.answer === "watch TV") assert.ok(Math.abs(row.capTop - row.guides[0]) < 1.5, `${label}: T does not meet the top guideline`);
    }
  }
});

test("long answers wrap onto additional four-line rows without shrinking or dropping letters", async () => {
  const result = await page.evaluate(async () => {
    await loadReturnPracticeFont();
    const answers = ["ABCDEFGHIJKLMNOPQRSTUVWXYZ", "I want to be a soccer player and I practice every day after school.", "W".repeat(220)];
    const person = { no: 1, name: "確認用", pageId: "sample" };
    const session = { orientation: "portrait", questions: answers.map(() => "練習"), modelAnswers: answers,
      classes: ["1組"], answers: { "1組": [person] }, grades: Object.fromEntries(answers.map((_, q) => [`1組::1::${q}`, { mark: "ng" }])) };
    const pages = returnPracticePagesHtml(session, "1組", person, { practiceCount: 3, rateScope: "class" });
    document.body.innerHTML = `<div style="width:794px">${pages.join("")}</div>`;
    const rows = [...document.querySelectorAll(".return-practice-item")];
    const reconstructed = answers.map((_, index) => rows.filter(row => row.querySelector(".return-practice-number").textContent.startsWith(String(index + 1).padStart(2, "0"))).map(row => row.querySelector("text").textContent).join(""));
    const sizes = rows.map(row => getComputedStyle(row.querySelector("text")).fontSize);
    const fits = rows.every(row => { const text = row.querySelector("text"), box = text.getBBox(); return box.x + box.width <= text.ownerSVGElement.getBoundingClientRect().width; });
    return { reconstructed, sizes, fits, pages: pages.length, original: answers.map(answer => answer.replace(/\s/g, "")) };
  });
  assert.deepEqual(result.reconstructed.map(answer => answer.replace(/\s/g, "")), result.original);
  assert.ok(result.sizes.every(size => size === result.sizes[0]), "continuations and last pages must keep the same model size");
  assert.ok(result.pages > 1, "long continuations should create another page");
  assert.equal(result.fits, true);
});

test("real print preparation loads the tracing font and preserves full glyphs in PDF layout", async () => {
  const { port } = server.address();
  for (const [orientation, count] of [["landscape", 4], ["portrait", 15]]) {
    const printPage = await browser.newPage();
    await printPage.goto(`http://127.0.0.1:${port}/index.html`, { waitUntil: "domcontentloaded" });
    await printPage.evaluate(async ({ orientation, count }) => {
      const examples = [["いつも", "always"], ["むらさき", "purple"], ["風呂に入る", "take a bath"], ["テレビを見る", "watch TV"], ["アルファベット", "Agjypq"]];
      const person = { no: 1, name: "確認用", pageId: "sample" };
      const items = Array.from({ length: count }, (_, q) => examples[q % examples.length]);
      const session = { testName: "単語テスト", orientation, paperSize: "a4", questions: items.map(item => item[0]), modelAnswers: items.map(item => item[1]),
        classes: ["1組"], answers: { "1組": [person] }, grades: Object.fromEntries(items.map((_, q) => [`1組::1::${q}`, { mark: "ng" }])) };
      Object.assign(returnOutputState, { session, className: "1組", selectedNos: new Set([1]) });
      document.getElementById("returnPracticeCount").value = String(count);
      window.print = () => { window.printRequested = true; };
      await printReturnPdfs();
    }, { orientation, count });
    await printPage.waitForFunction(() => window.printRequested === true);
    await printPage.emulateMedia({ media: "print" });
    const metrics = await printPage.locator("#returnPrintRoot .return-practice-sheet").evaluate(sheet => {
      const sheetBox = sheet.getBoundingClientRect();
      const rows = [...sheet.querySelectorAll(".return-practice-item")];
      return { fontLoaded: [...document.fonts].some(font => font.family === "RuRiRu Font" && font.status === "loaded"),
        rowCount: rows.length, rowsOnPage: rows.every(row => row.getBoundingClientRect().bottom < sheetBox.bottom),
        allTextFits: rows.every(row => { const text = row.querySelector("text"), svg = text.ownerSVGElement.getBoundingClientRect();
          const ctx = document.createElement("canvas").getContext("2d"), style = getComputedStyle(text);
          ctx.font = `${style.fontSize} ${style.fontFamily}`; const ink = ctx.measureText(text.textContent), baseline = text.y.baseVal[0].value;
          return baseline - ink.actualBoundingBoxAscent > 0 && baseline + ink.actualBoundingBoxDescent < svg.height;
        }) };
    });
    assert.equal(metrics.fontLoaded, true);
    assert.equal(metrics.rowCount, count);
    assert.equal(metrics.rowsOnPage, true);
    assert.equal(metrics.allTextFits, true);
    if (process.env.YUTORI_QA_DIR) {
      await mkdir(process.env.YUTORI_QA_DIR, { recursive: true });
      await printPage.locator("#returnPrintRoot .return-practice-sheet").screenshot({ path: path.join(process.env.YUTORI_QA_DIR, `${orientation}.png`) });
      await printPage.pdf({ path: path.join(process.env.YUTORI_QA_DIR, `${orientation}.pdf`), preferCSSPageSize: true, printBackground: true });
    }
    await printPage.close();
  }
});
