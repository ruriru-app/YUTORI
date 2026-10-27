import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import test, { before, beforeEach, after } from "node:test";
import { createYutoriBrowser } from "./helpers/yutori-browser.mjs";

let app, page;
before(async () => { app = await createYutoriBrowser(); });
beforeEach(async () => {
  await page?.context().close();
  page = await app.freshPage({ pathname: "/index.html" });
});
after(async () => { await app?.close(); });

// Catches drift between the actual print/PDF renderer, cut-sheet calibration,
// answer crops and returned HTML. Expected cells come from printed DOM boxes,
// never from the calibration/reference helpers being checked.
for (const orientation of ["portrait", "landscape"]) {
  test(`actual A5 ${orientation} PDF cuts retain all ten ink owners and return alignment`, async () => {
    await page.emulateMedia({ media: "print" });
    const fixture = await page.evaluate(async orientation => {
      applyTestToEditor({ paperSize: "a5", orientation, rows: 5, cols: 2,
        flow: "row", answerFormat: "extended", answerLine: "third",
        subject: "Synthetic", unit: "Round trip", testName: "Synthetic PDF",
        questions: Array(10).fill("Synthetic question"), answers: Array(10).fill("answer") });
      window.print = () => {};
      printDocument();
      const colors = Array.from({ length: 10 }, (_, q) => [20 + q * 17, 30 + q * 13, 210 - q * 19]);
      const papers = [...document.querySelectorAll("#testPrintRoot .paper")];
      await document.fonts.ready;
      await Promise.all(papers.flatMap(paper => [...paper.querySelectorAll("img")].map(image => image.decode())));
      // Native beforeprint regenerates the copies. A paint-only stylesheet
      // survives that lifecycle without changing canonical/reference geometry.
      const ink = document.createElement("style");
      ink.textContent = colors.map((rgb, q) => `#testPrintRoot .problem-cell:nth-child(${q + 1})::after{content:"";position:absolute;left:20%;top:62%;width:60%;height:10%;background:rgb(${rgb});print-color-adjust:exact}`).join("");
      document.head.appendChild(ink);
      const sheet = papers[0].getBoundingClientRect();
      const cells = [...papers[0].querySelectorAll(".problem-cell")].map(cell => {
        const r = cell.getBoundingClientRect();
        return { left: (r.left - sheet.left) / sheet.width, top: (r.top - sheet.top) / sheet.height,
          width: r.width / sheet.width, height: r.height / sheet.height };
      });
      return { test: copyTestState(state), colors, cells };
    }, orientation);
    const bytes = await page.pdf({ printBackground: true, preferCSSPageSize: true });
    await page.emulateMedia({ media: "screen" });
    const result = await page.evaluate(async ({ bytes, fixture, orientation }) => {
      const pdf = await pdfjsLib.getDocument({ data: new Uint8Array(bytes) }).promise;
      if (pdf.numPages !== 1) throw new Error(`expected one physical page, got ${pdf.numPages}`);
      const pdfPage = await pdf.getPage(1), viewport = pdfPage.getViewport({ scale: 2 });
      const physical = document.createElement("canvas");
      physical.width = Math.round(viewport.width); physical.height = Math.round(viewport.height);
      await pdfPage.render({ canvasContext: physical.getContext("2d"), viewport }).promise;
      const portrait = orientation === "portrait", widthMm = portrait ? 148 : 210, heightMm = portrait ? 210 : 148;
      const pxPerMmX = physical.width / (portrait ? 297 : 210), pxPerMmY = physical.height / (portrait ? 210 : 297);
      const session = { ...fixture.test, id: "synthetic-roundtrip", modelAnswers: fixture.test.answers,
        classes: ["synthetic"], answers: { synthetic: [] }, pdfPages: [], grades: {} };
      const snapshot = { ...fixture.test }, checks = [];
      for (const [copy, scale, xMm, yMm] of [[0, .92, 2, 3], [1, 1, 0, 0]]) {
        const cut = document.createElement("canvas");
        cut.width = Math.round(widthMm * pxPerMmX); cut.height = Math.round(heightMm * pxPerMmY);
        cut.getContext("2d").drawImage(physical, (portrait ? .5 + copy * 148 : 0) * pxPerMmX,
          (portrait ? 0 : .5 + copy * 148) * pxPerMmY,
          widthMm * pxPerMmX, heightMm * pxPerMmY, 0, 0, cut.width, cut.height);
        const scan = document.createElement("canvas"); scan.width = cut.width; scan.height = cut.height;
        const ctx = scan.getContext("2d", { willReadFrequently: true });
        ctx.fillStyle = "white"; ctx.fillRect(0, 0, scan.width, scan.height);
        ctx.drawImage(cut, xMm * pxPerMmX, yMm * pxPerMmY, cut.width * scale, cut.height * scale);
        const image = new Image(); image.src = scan.toDataURL(); await image.decode();
        const calibration = await prepareAnswerSheetCalibration(image, snapshot);
        const data = ctx.getImageData(0, 0, scan.width, scan.height).data;
        const crops = fixture.colors.map((rgb, q) => {
          const crop = answerCropRect(image, snapshot, q), owners = new Set(); let ownPixels = 0;
          for (let y = Math.ceil(crop.y); y < Math.floor(crop.y + crop.height); y++) {
            for (let x = Math.ceil(crop.x); x < Math.floor(crop.x + crop.width); x++) {
              const i = (y * scan.width + x) * 4;
              const owner = fixture.colors.findIndex(color => color.every((value, c) => Math.abs(value - data[i + c]) <= 2));
              if (owner >= 0) owners.add(owner);
              if (owner === q) ownPixels++;
            }
          }
          return { q, owners: [...owners], ownPixels, crop };
        });
        const pageId = `cut-${copy}`;
        session.pdfPages.push({ id: pageId }); session.answers.synthetic.push({ no: copy + 1, name: "Synthetic", pageId });
        for (let q = 0; q < 10; q++) session.grades[`synthetic::${copy + 1}::${q}`] = { mark: "ng", score: 0 };
        const blob = await new Promise(resolve => scan.toBlob(resolve)), db = await openYutoriDb();
        await new Promise((resolve, reject) => { const tx = db.transaction("pdfPages", "readwrite");
          tx.objectStore("pdfPages").put({ id: `${session.id}:${pageId}`, sessionId: session.id, pageId, metadata: { id: pageId }, blob });
          tx.oncomplete = resolve; tx.onerror = () => reject(tx.error); }); db.close();
        checks.push({ provenance: calibration.provenance, crops, expected: fixture.cells.map(cell => ({
          left: cell.left * scale + xMm / widthMm, top: cell.top * scale + yMm / heightMm,
          width: cell.width * scale, height: cell.height * scale })) });
      }
      const before = JSON.stringify({ answers: session.answers, grades: session.grades });
      await loadReturnOutputImages(session);
      const host = document.createElement("div"); host.id = "roundtrip-return"; host.style.width = "900px"; document.body.appendChild(host);
      for (const [i, person] of session.answers.synthetic.entries()) {
        host.innerHTML = returnAnswerPageHtml(session, "synthetic", person, { showQuestionRate: true, showAverage: true, showRank: true });
        const source = host.querySelector(".return-answer-source"), bounds = source.getBoundingClientRect();
        checks[i].overlays = [...host.querySelectorAll(".return-question-annotation")].map(node => {
          const r = node.getBoundingClientRect();
          return { left: (r.left - bounds.left) / bounds.width, top: (r.top - bounds.top) / bounds.height,
            width: r.width / bounds.width, height: r.height / bounds.height,
            mark: node.querySelector(".return-question-mark")?.getAttribute("aria-label"),
            answer: node.querySelector(".return-correct-answer")?.textContent };
        });
        checks[i].headerLayout = returnOutputState.calibrations[person.pageId].headerLayout;
      }
      window.dispatchEvent(new Event("afterprint"));
      host.scrollIntoView();
      await pdf.destroy();
      return { checks, unchanged: before === JSON.stringify({ answers: session.answers, grades: session.grades }) };
    }, { bytes: [...bytes], fixture, orientation });
    assert.equal(result.unchanged, true);
    for (const check of result.checks) {
      assert.equal(check.provenance, "header-grid");
      assert.equal(check.headerLayout, "wide");
      assert.equal(check.overlays.length, 10);
      for (const crop of check.crops) {
        assert.deepEqual(crop.owners, [crop.q], `${orientation} q${crop.q + 1}: wrong crop ink`);
        assert.ok(crop.ownPixels > 100, `${orientation} q${crop.q + 1}: missing ink`);
        const overlay = check.overlays[crop.q], expected = check.expected[crop.q];
        for (const key of ["left", "top", "width", "height"]) assert.ok(Math.abs(overlay[key] - expected[key]) < .004,
          `${orientation} q${crop.q + 1} ${key}: ${overlay[key]} vs ${expected[key]}`);
        assert.equal(overlay.mark, "×"); assert.equal(overlay.answer, "正：answer");
      }
    }
    if (process.env.YUTORI_ROUNDTRIP_QA_DIR) {
      await mkdir(process.env.YUTORI_ROUNDTRIP_QA_DIR, { recursive: true });
      await writeFile(path.join(process.env.YUTORI_ROUNDTRIP_QA_DIR, `${orientation}.pdf`), bytes);
      await writeFile(path.join(process.env.YUTORI_ROUNDTRIP_QA_DIR, `${orientation}.json`), JSON.stringify(result, null, 2));
      await page.locator("#roundtrip-return").screenshot({ path: path.join(process.env.YUTORI_ROUNDTRIP_QA_DIR, `${orientation}-return.png`) });
    }
  });
}
