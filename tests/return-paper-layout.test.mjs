import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { readFile, stat } from "node:fs/promises";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import test, { before, beforeEach, after } from "node:test";

const { chromium } = createRequire(import.meta.url)("playwright");
const { PDFDocument } = createRequire(import.meta.url)("pdf-lib");
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
  const context = await browser.newContext({ serviceWorkers: "block" });
  page = await context.newPage();
  await page.goto(origin, { waitUntil: "domcontentloaded" });
  await page.evaluate(async () => {
    const fixture = (id, paperSize, orientation) => {
      const person = { no: 1, name: "確認用", pageId: "sample" };
      return {
        id, paperSize, orientation, testName: "返却確認", rows: 10, cols: 5,
        questions: Array(25).fill("りんご"), modelAnswers: Array(25).fill("apple"),
        classes: ["test"], answers: { test: [person] },
        grades: Object.fromEntries(Array.from({ length: 25 }, (_, q) => [`test::1::${q}`, { mark: "ng" }]))
      };
    };
    localStorage.setItem(sessionsKey(), JSON.stringify([
      fixture("a5-portrait", "a5", "portrait"),
      fixture("a4-portrait", "a4", "portrait"),
      fixture("b5-portrait", "b5", "portrait"),
      fixture("b5-landscape", "b5", "landscape"),
      fixture("a4-landscape", "a4", "landscape")
    ]));
    await loadReturnPracticeFont();
  });
});

after(async () => {
  await browser?.close();
  server?.closeAllConnections();
  await new Promise(resolve => server?.close(resolve));
});

test("return layout defaults mirror the source test and expose every radio choice", async () => {
  const result = await page.evaluate(async () => {
    await changeReturnOutputSession("a5-portrait");
    const options = returnOutputOptions();
    const checked = name => document.querySelector(`input[name="${name}"]:checked`)?.value || null;
    return {
      options: {
        paperSize: options.returnPaperSize,
        answerOrientation: options.returnAnswerOrientation,
        practiceOrientation: options.returnPracticeOrientation,
        placement: options.returnAnswerPlacement
      },
      checked: {
        paperSize: checked("returnPaperSize"),
        answerOrientation: checked("returnAnswerOrientation"),
        practiceOrientation: checked("returnPracticeOrientation"),
        placement: checked("returnAnswerPlacement")
      },
      counts: {
        paperSize: document.querySelectorAll('input[name="returnPaperSize"]').length,
        answerOrientation: document.querySelectorAll('input[name="returnAnswerOrientation"]').length,
        practiceOrientation: document.querySelectorAll('input[name="returnPracticeOrientation"]').length,
        placement: document.querySelectorAll('input[name="returnAnswerPlacement"]').length
      }
    };
  });
  const expected = { paperSize: "a5", answerOrientation: "portrait", practiceOrientation: "portrait", placement: "fit" };
  assert.deepEqual(result.options, expected);
  assert.deepEqual(result.checked, expected);
  assert.deepEqual(result.counts, { paperSize: 3, answerOrientation: 2, practiceOrientation: 2, placement: 2 });
});

for (const [sessionId, widthRatio, heightRatio] of [
  ["a5-portrait", 148 / 210, 210 / 297],
  ["b5-portrait", 182 / 210, 257 / 297]
]) {
  test(`${sessionId} can switch between enlarged and original top-left placement on A4`, async () => {
    const result = await page.evaluate(async sessionId => {
      await changeReturnOutputSession(sessionId);
      const choose = (name, value) => {
        const radio = document.querySelector(`input[name="${name}"][value="${value}"]`);
        if (!radio) return false;
        radio.click();
        return true;
      };
      if (!choose("returnPaperSize", "a4") || !choose("returnAnswerPlacement", "original")) return { missing: true };
      const session = returnOutputState.session, person = session.answers.test[0], options = returnOutputOptions();
      const host = document.createElement("div"); host.style.width = "794px"; document.body.appendChild(host);
      host.innerHTML = returnAnswerPageHtml(session, "test", person, options);
      const sheet = host.querySelector(".return-answer-sheet"), source = host.querySelector(".return-answer-source");
      if (!source) return { missing: true };
      const sheetBox = sheet.getBoundingClientRect(), sourceBox = source.getBoundingClientRect();
      const original = { left: sourceBox.left - sheetBox.left, top: sourceBox.top - sheetBox.top, widthRatio: sourceBox.width / sheetBox.width, heightRatio: sourceBox.height / sheetBox.height };
      choose("returnAnswerPlacement", "fit");
      host.innerHTML = returnAnswerPageHtml(session, "test", person, returnOutputOptions());
      const fitSheet = host.querySelector(".return-answer-sheet").getBoundingClientRect(), fitSource = host.querySelector(".return-answer-source").getBoundingClientRect();
      return { original, fit: { widthRatio: fitSource.width / fitSheet.width, heightRatio: fitSource.height / fitSheet.height } };
    }, sessionId);
    assert.equal(result.missing, undefined);
    assert.ok(Math.abs(result.original.left) < 1);
    assert.ok(Math.abs(result.original.top) < 1);
    assert.ok(Math.abs(result.original.widthRatio - widthRatio) < .01, JSON.stringify(result));
    assert.ok(Math.abs(result.original.heightRatio - heightRatio) < .01, JSON.stringify(result));
    assert.ok(result.fit.widthRatio > .99, JSON.stringify(result));
    assert.ok(result.fit.heightRatio > .99, JSON.stringify(result));
  });
}

test("B5 landscape retains its proportions when placed at the top-left of A4 landscape", async () => {
  const result = await page.evaluate(async () => {
    await changeReturnOutputSession("b5-landscape");
    const choose = (name, value) => { const radio = document.querySelector(`input[name="${name}"][value="${value}"]`); if (!radio) return false; radio.click(); return true; };
    if (!choose("returnPaperSize", "a4") || !choose("returnAnswerPlacement", "original")) return { missing: true };
    const session = returnOutputState.session, host = document.createElement("div"); host.style.width = "1000px"; document.body.appendChild(host);
    host.innerHTML = returnAnswerPageHtml(session, "test", session.answers.test[0], returnOutputOptions());
    const sheet = host.querySelector(".return-answer-sheet")?.getBoundingClientRect(), source = host.querySelector(".return-answer-source")?.getBoundingClientRect();
    if (!sheet || !source) return { missing: true };
    return { left: source.left - sheet.left, top: source.top - sheet.top, widthRatio: source.width / sheet.width, heightRatio: source.height / sheet.height };
  });
  assert.equal(result.missing, undefined);
  assert.ok(Math.abs(result.left) < 1);
  assert.ok(Math.abs(result.top) < 1);
  assert.ok(Math.abs(result.widthRatio - 257 / 297) < .01, JSON.stringify(result));
  assert.ok(Math.abs(result.heightRatio - 182 / 210) < .01, JSON.stringify(result));
});

test("original top-left keeps 100 percent scale even when the selected return paper is smaller", async () => {
  const result = await page.evaluate(async () => {
    await changeReturnOutputSession("a4-portrait");
    document.querySelector('input[name="returnPaperSize"][value="a5"]').click();
    document.querySelector('input[name="returnAnswerPlacement"][value="original"]').click();
    const session = returnOutputState.session, host = document.createElement("div"); host.style.width = "600px"; document.body.appendChild(host);
    host.innerHTML = returnAnswerPageHtml(session, "test", session.answers.test[0], returnOutputOptions());
    const sheet = host.querySelector(".return-answer-sheet").getBoundingClientRect(), source = host.querySelector(".return-answer-source").getBoundingClientRect();
    return { left: source.left - sheet.left, top: source.top - sheet.top, widthRatio: source.width / sheet.width, heightRatio: source.height / sheet.height };
  });
  assert.ok(Math.abs(result.left) < 1);
  assert.ok(Math.abs(result.top) < 1);
  assert.ok(Math.abs(result.widthRatio - 210 / 148) < .01, JSON.stringify(result));
  assert.ok(Math.abs(result.heightRatio - 297 / 210) < .01, JSON.stringify(result));
});

test("A4 landscape answer and A4 portrait practice are paired on one duplex sheet", async () => {
  const result = await page.evaluate(async () => {
    await changeReturnOutputSession("a4-landscape");
    const checked = name => document.querySelector(`input[name="${name}"]:checked`)?.value || null;
    const defaults = { answer: checked("returnAnswerOrientation"), practice: checked("returnPracticeOrientation") };
    const practicePortrait = document.querySelector('input[name="returnPracticeOrientation"][value="portrait"]');
    if (!practicePortrait || typeof returnPrintPagesForPerson !== "function") return { missing: true, defaults };
    practicePortrait.click();
    const session = returnOutputState.session, person = session.answers.test[0], options = returnOutputOptions();
    const logical = returnPagesForPerson(session, "test", person, options);
    const printable = returnPrintPagesForPerson(session, "test", person, options);
    const host = document.createElement("div"); host.innerHTML = printable.join("");
    return {
      defaults,
      options: { answer: options.returnAnswerOrientation, practice: options.returnPracticeOrientation },
      logicalClasses: logical.map(html => { const node = document.createElement("div"); node.innerHTML = html; return node.firstElementChild.className; }),
      sides: [...host.querySelectorAll(".return-print-page")].map(node => node.dataset.side),
      rotations: [...host.querySelectorAll(".return-print-side")].map(node => node.dataset.orientation),
      practiceCount: document.getElementById("returnPracticeCount").value
    };
  });
  assert.equal(result.missing, undefined);
  assert.deepEqual(result.defaults, { answer: "landscape", practice: "landscape" });
  assert.deepEqual(result.options, { answer: "landscape", practice: "portrait" });
  assert.match(result.logicalClasses[0], /return-landscape/);
  assert.match(result.logicalClasses[1], /return-portrait/);
  assert.deepEqual(result.sides, ["answer", "practice"]);
  assert.deepEqual(result.rotations, ["landscape", "portrait"]);
  assert.equal(result.practiceCount, "15");
});

for (const [sessionId, shortSideMm, longSideMm] of [["a5-portrait", 148, 210], ["b5-landscape", 182, 257], ["a4-landscape", 210, 297]]) {
test(`${sessionId} mixed orientations create physical PDF pages at the selected paper size`, async () => {
  await page.evaluate(async sessionId => {
    await changeReturnOutputSession(sessionId);
    document.querySelector('input[name="returnAnswerOrientation"][value="landscape"]').click();
    document.querySelector('input[name="returnPracticeOrientation"][value="portrait"]').click();
    window.print = () => {};
    await printReturnPdfs();
    await new Promise(resolve => requestAnimationFrame(() => setTimeout(resolve, 100)));
  }, sessionId);
  const pdf = await PDFDocument.load(await page.pdf({ printBackground: true, preferCSSPageSize: true }));
  const pages = pdf.getPages().map(pdfPage => pdfPage.getSize());
  const pointsPerMm = 72 / 25.4;
  assert.equal(pages.length, 2);
  assert.ok(pages[0].width > pages[0].height, JSON.stringify(pages));
  assert.ok(Math.abs(pages[0].width - longSideMm * pointsPerMm) < 1, JSON.stringify(pages));
  assert.ok(Math.abs(pages[0].height - shortSideMm * pointsPerMm) < 1, JSON.stringify(pages));
  assert.ok(pages[1].height > pages[1].width, JSON.stringify(pages));
  assert.ok(Math.abs(pages[1].width - shortSideMm * pointsPerMm) < 1, JSON.stringify(pages));
  assert.ok(Math.abs(pages[1].height - longSideMm * pointsPerMm) < 1, JSON.stringify(pages));
});
}

test("mini previews visibly follow the selected front and back orientations", async () => {
  const result = await page.evaluate(async () => {
    document.getElementById("outputControlsHost").style.display = "block";
    await changeReturnOutputSession("a4-landscape");
    const measure = id => { const node = document.getElementById(id); if (!node) return null; const box = node.getBoundingClientRect(); return { width: box.width, height: box.height }; };
    const before = { answer: measure("returnAnswerMiniPage"), practice: measure("returnPracticeMiniPage") };
    document.querySelector('input[name="returnPracticeOrientation"][value="portrait"]')?.click();
    const after = { answer: measure("returnAnswerMiniPage"), practice: measure("returnPracticeMiniPage") };
    return { before, after };
  });
  assert.ok(result.before.answer && result.before.practice && result.after.practice, "mini previews are missing");
  assert.ok(result.before.answer.width > result.before.answer.height);
  assert.ok(result.before.practice.width > result.before.practice.height);
  assert.ok(result.after.answer.width > result.after.answer.height);
  assert.ok(result.after.practice.height > result.after.practice.width);
});

test("extra practice pages are padded so the next pupil starts on a new duplex sheet", async () => {
  const result = await page.evaluate(async () => {
    await changeReturnOutputSession("a5-portrait");
    if (typeof returnPrintPagesForPerson !== "function") return { missing: true };
    const session = returnOutputState.session, person = session.answers.test[0];
    const options = { ...returnOutputOptions(), fitPracticePage: false, practiceCount: 25 };
    const pages = returnPrintPagesForPerson(session, "test", person, options);
    const host = document.createElement("div"); host.innerHTML = pages.join("");
    return [...host.querySelectorAll(".return-print-page")].map(node => node.dataset.side);
  });
  assert.deepEqual(result, ["answer", "practice", "practice", "blank"]);
});
