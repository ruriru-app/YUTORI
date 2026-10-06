import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { readFile, stat } from "node:fs/promises";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import test, { before, beforeEach, after } from "node:test";
const { chromium } = createRequire(import.meta.url)("playwright");
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
    const person = { no: 1, name: "確認用", pageId: "sample" };
    window.practiceFixture = orientation => ({ id: orientation, orientation, paperSize: "a4", testName: "練習確認", questions: Array(25).fill("りんご"), modelAnswers: Array(25).fill("apple"), classes: ["test"], answers: { test: [person] }, grades: Object.fromEntries(Array.from({ length: 25 }, (_, q) => [`test::1::${q}`, { mark: "ng" }])) });
    localStorage.setItem(sessionsKey(), JSON.stringify([practiceFixture("portrait"), practiceFixture("landscape")]));
    await loadReturnPracticeFont();
  });
});
after(async () => {
  await browser?.close();
  server?.closeAllConnections();
  await new Promise(resolve => server?.close(resolve));
});

for (const [orientation, expected] of [["portrait", 15], ["landscape", 7]]) {
  test(`${orientation} starts with a full one-page practice count rather than five`, async () => {
    const result = await page.evaluate(async orientation => {
      await changeReturnOutputSession(orientation);
      const session = returnOutputState.session, options = returnOutputOptions();
      const pages = returnPracticePagesHtml(session, "test", session.answers.test[0], options);
      const host = document.createElement("div"); host.innerHTML = pages.join("");
      return { value: document.getElementById("returnPracticeCount").value, pages: pages.length, rows: host.querySelectorAll(".return-practice-item").length, auto: options.fitPracticePage };
    }, orientation);
    assert.deepEqual(result, { value: String(expected), pages: 1, rows: expected, auto: true });
  });
  test(`${orientation} maximum rows use the printable space without clipping`, async () => {
    const metrics = await page.evaluate(async orientation => {
      await changeReturnOutputSession(orientation);
      const session = returnOutputState.session, options = returnOutputOptions(), person = session.answers.test[0];
      const host = document.createElement("div"); host.style.width = "794px"; document.body.appendChild(host);
      host.innerHTML = returnPracticePagesHtml(session, "test", person, options).join("");
      const sheet = host.querySelector(".return-practice-sheet"), list = sheet.querySelector(".return-practice-list"), rows = [...list.children];
      const first = rows[0].getBoundingClientRect(), last = rows.at(-1).getBoundingClientRect(), bounds = list.getBoundingClientRect();
      return { fraction: (last.bottom - first.top) / (bounds.bottom - first.top), fits: last.bottom <= bounds.bottom + 1 };
    }, orientation);
    assert.ok(metrics.fraction > .95, `only ${Math.round(metrics.fraction * 100)}% of the practice space is used`);
    assert.equal(metrics.fits, true);
  });
}

test("manual counts are retained for the same session but a new orientation gets its own initial maximum", async () => {
  await page.evaluate(() => changeReturnOutputSession("portrait"));
  await page.locator("#returnPracticeCount").evaluate(input => { input.value = "3"; input.dispatchEvent(new Event("input", { bubbles: true })); });
  const manual = await page.evaluate(async () => { await changeReturnOutputSession("portrait"); return { value: document.getElementById("returnPracticeCount").value, auto: returnOutputOptions().fitPracticePage }; });
  assert.deepEqual(manual, { value: "3", auto: false });
  await page.evaluate(() => changeReturnOutputSession("landscape"));
  assert.equal(await page.locator("#returnPracticeCount").inputValue(), "7");
  const reset = await page.evaluate(() => { document.getElementById("returnPracticeCount").value = "3"; document.getElementById("returnPracticeCount").dispatchEvent(new Event("input", { bubbles: true })); document.getElementById("returnPracticeAutoButton").click(); return returnOutputOptions(); });
  assert.equal(reset.practiceCount, 7);
  assert.equal(reset.fitPracticePage, true);
});

test("automatic packing respects complete long answers, while manual mode still permits extra pages", async () => {
  const result = await page.evaluate(async () => {
    await changeReturnOutputSession("landscape");
    const session = returnOutputState.session, person = session.answers.test[0];
    session.modelAnswers = Array(25).fill("I want to be a soccer player and I practice every day after school.");
    const options = returnOutputOptions(), auto = returnPracticePagesHtml(session, "test", person, options), manual = returnPracticePagesHtml(session, "test", person, { ...options, fitPracticePage: false });
    const host = document.createElement("div"); host.innerHTML = auto.join("");
    const groups = new Map();
    host.querySelectorAll(".return-practice-item").forEach(row => {
      const q = Number(row.querySelector(".return-practice-number").textContent.match(/^\d+/)[0]);
      groups.set(q, (groups.get(q) || "") + row.querySelector("text").textContent.replace(/\s/g, ""));
    });
    return { autoPages: auto.length, manualPages: manual.length, answers: [...groups.values()], expected: session.modelAnswers[0].replace(/\s/g, "") };
  });
  assert.equal(result.autoPages, 1);
  assert.ok(result.manualPages > 1);
  assert.ok(result.answers.length > 0);
  assert.ok(result.answers.every(answer => answer === result.expected));
});

test("few errors are not duplicated and all pupils in a batch use the same handwriting size", async () => {
  const result = await page.evaluate(async () => {
    await changeReturnOutputSession("portrait");
    const session = returnOutputState.session, many = session.answers.test[0], few = { no: 2, name: "少ない例" };
    session.answers.test.push(few);
    for (let q = 0; q < 25; q++) session.grades[`test::2::${q}`] = { mark: q < 2 ? "ng" : "ok" };
    const host = document.createElement("div"); host.style.width = "794px"; document.body.appendChild(host);
    host.innerHTML = [many, few].flatMap(person => returnPracticePagesHtml(session, "test", person, returnOutputOptions())).join("");
    return [...host.children].map(sheet => ({ rows: sheet.querySelectorAll(".return-practice-item").length, size: getComputedStyle(sheet.querySelector("text")).fontSize }));
  });
  assert.deepEqual(result.map(item => item.rows), [15, 2]);
  assert.equal(result[0].size, result[1].size);
});

test("an oversized answer does not stop shorter eligible answers from filling the page", async () => {
  const result = await page.evaluate(async () => {
    await changeReturnOutputSession("landscape");
    const session = returnOutputState.session;
    session.modelAnswers[1] = "W".repeat(800);
    const pages = returnPracticePagesHtml(session, "test", session.answers.test[0], returnOutputOptions());
    const host = document.createElement("div"); host.innerHTML = pages.join("");
    return { pages: pages.length, numbers: [...host.querySelectorAll(".return-practice-number")].map(node => node.textContent) };
  });
  assert.equal(result.pages, 1);
  assert.deepEqual(result.numbers, ["01", "03", "04", "05", "06", "07", "08"]);
});

test("maximum layouts fit all supported paper sizes with long headers and names in real print preparation", async () => {
  for (const paperSize of ["a4", "b5", "a5"]) for (const orientation of ["portrait", "landscape"]) {
    await page.evaluate(async ({ paperSize, orientation }) => {
      document.body.classList.remove("return-printing");
      const session = practiceFixture(orientation);
      session.id = `${paperSize}-${orientation}`; session.paperSize = paperSize;
      session.testName = "外国語の学習内容を確認するためのアルファベットと単語のまとめテスト";
      session.answers.test[0].name = "確認用の長い児童名";
      session.modelAnswers = Array(25).fill("watch TV");
      localStorage.setItem(sessionsKey(), JSON.stringify([session]));
      await changeReturnOutputSession(session.id);
      window.print = () => {};
      await printReturnPdfs();
    }, { paperSize, orientation });
    await page.emulateMedia({ media: "print" });
    const result = await page.locator("#returnPrintRoot .return-practice-sheet").evaluate(sheet => {
      const rows = [...sheet.querySelectorAll(".return-practice-item")], list = sheet.querySelector(".return-practice-list"), bounds = list.getBoundingClientRect();
      return { rows: rows.length, bottom: rows.at(-1).getBoundingClientRect().bottom, allowedBottom: bounds.bottom, glyphsFit: rows.every(row => {
        const text = row.querySelector("text"), box = text.getBBox(), svg = text.ownerSVGElement.getBoundingClientRect();
        return box.x >= 0 && box.x + box.width <= svg.width + 1 && box.y >= 0 && box.y + box.height <= svg.height + 1;
      }) };
    });
    assert.equal(result.rows, orientation === "portrait" ? 15 : 7, `${paperSize} ${orientation}`);
    assert.ok(result.bottom <= result.allowedBottom + 1, `${paperSize} ${orientation} rows exceed page`);
    assert.equal(result.glyphsFit, true, `${paperSize} ${orientation} clips glyphs`);
    await page.emulateMedia({ media: "screen" });
  }
});

test("a single exceptionally long answer is complete on continuation pages instead of silently truncated", async () => {
  const result = await page.evaluate(async () => {
    await changeReturnOutputSession("landscape");
    const session = returnOutputState.session;
    session.questions = ["長い手本"]; session.modelAnswers = ["W".repeat(700)];
    const pages = returnPracticePagesHtml(session, "test", session.answers.test[0], returnOutputOptions());
    const host = document.createElement("div"); host.innerHTML = pages.join("");
    return { pages: pages.length, restored: [...host.querySelectorAll("text")].map(node => node.textContent).join(""), empty: host.querySelectorAll(".return-practice-empty").length };
  });
  assert.ok(result.pages > 1);
  assert.equal(result.restored, "W".repeat(700));
  assert.equal(result.empty, 0);
});
