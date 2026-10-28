import assert from "node:assert/strict";
import { createRequire } from "node:module";
import test, { before, beforeEach, after } from "node:test";
import { createYutoriBrowser } from "./helpers/yutori-browser.mjs";

const { PDFDocument } = createRequire(import.meta.url)("pdf-lib");
const pt = 72 / 25.4;
let app, page;
before(async () => { app = await createYutoriBrowser(); });
beforeEach(async () => {
  await page?.context().close();
  page = await app.freshPage({ pathname: "/" });
});
after(async () => { await app?.close(); });

function near(actual, expected, label, tolerance = 2) {
  assert.ok(Math.abs(actual - expected) <= tolerance, `${label}: ${actual}pt, expected ${expected}pt ±${tolerance}`);
}

async function prepare({ paperSize = "a4", front = "landscape", back = "portrait", sourceSize = paperSize, sourceOrientation = front, placement = "fit", cols = 3, grid = null } = {}) {
  await page.evaluate(async settings => {
    const { paperSize, front, back, sourceSize, sourceOrientation, placement, cols, grid } = settings;
    const session = { id: "physical-scale", testName: "Synthetic scale", paperSize: sourceSize, orientation: sourceOrientation, rows: 10, cols,
      questions: Array(25).fill("word"), modelAnswers: Array(25).fill("apple"), classes: ["QA"],
      answers: { QA: [{ no: 1, name: "Synthetic", pageId: "synthetic-scale" }] },
      grades: Object.fromEntries(Array.from({ length: 25 }, (_, q) => [`QA::1::${q}`, { mark: "ng" }])) };
    localStorage.setItem(sessionsKey(), JSON.stringify([session]));
    await changeReturnOutputSession(session.id); await loadReturnPracticeFont();
    // A real browser image, with an independently chosen solid color whose PDF bounds are measurable.
    returnOutputState.imageUrls["synthetic-scale"] = `data:image/svg+xml,${encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="100" height="100"><rect width="100" height="100" fill="#007d92"/></svg>')}`;
    if (grid) returnOutputState.calibrations["synthetic-scale"] = { provenance: "header-grid", grid };
    checkReturnOption("returnPaperSize", paperSize); checkReturnOption("returnAnswerOrientation", front);
    checkReturnOption("returnPracticeOrientation", back); checkReturnOption("returnAnswerPlacement", placement);
    window.print = () => {};
  }, { paperSize, front, back, sourceSize, sourceOrientation, placement, cols, grid });
}

async function printAndMeasure(showDistribution = true) {
  await page.evaluate(async show => {
    document.getElementById("returnShowScoreDistribution").checked = show;
    await printReturnPdfs();
  }, showDistribution);
  await page.emulateMedia({ media: "print" });
  const bytes = await page.pdf({ printBackground: true, preferCSSPageSize: true });
  const document = await PDFDocument.load(bytes);
  const mediaBoxes = document.getPages().map(p => p.getSize());
  // Measure the actual serialized PDF through the app's bundled PDF.js, not screen/print DOM geometry.
  const ink = await page.evaluate(async data => {
    const pdfjs = await loadPdfJs(), pdf = await pdfjs.getDocument({ data: new Uint8Array(data) }).promise;
    const output = [];
    for (let number = 1; number <= pdf.numPages; number++) {
      const p = await pdf.getPage(number), viewport = p.getViewport({ scale: 2 });
      const canvas = document.createElement("canvas"); canvas.width = Math.ceil(viewport.width); canvas.height = Math.ceil(viewport.height);
      const context = canvas.getContext("2d", { willReadFrequently: true });
      await p.render({ canvasContext: context, viewport }).promise;
      const { data: pixels } = context.getImageData(0, 0, canvas.width, canvas.height), w = canvas.width, h = canvas.height;
      const matches = (offset, color) => color.every((value, channel) => Math.abs(pixels[offset + channel] - value) <= 8);
      const longestRule = (color, from, to) => {
        let best = null;
        for (let y = Math.floor(from * h); y < Math.floor(to * h); y++) {
          let start = -1;
          for (let x = 0; x <= w; x++) {
            if (x < w && matches((y * w + x) * 4, color)) { if (start < 0) start = x; }
            else if (start >= 0) {
              if (!best || x - start > best.width * 2) best = { x: start / 2, y: y / 2, width: (x - start) / 2 };
              start = -1;
            }
          }
        }
        // Ignore isolated antialiased text pixels of the same color: a rule spans at least 20pt.
        return best?.width >= 20 ? best : null;
      };
      let minX = w, minY = h, maxX = -1, maxY = -1, finalColumnRed = 0;
      for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
        const offset = (y * w + x) * 4;
        if (matches(offset, [0, 125, 146])) { minX = Math.min(minX, x); maxX = Math.max(maxX, x); minY = Math.min(minY, y); maxY = Math.max(maxY, y); }
        if (x > .78 * w && y > .12 * h && y < .95 * h && pixels[offset] > 170 && pixels[offset + 1] < 100 && pixels[offset + 2] < 100) finalColumnRed++;
      }
      output.push({
        header: longestRule([252, 204, 142], 0, .25),
        firstWritingRule: longestRule([105, 191, 229], .1, .4),
        ticket: longestRule([182, 175, 166], .5, 1),
        image: maxX < 0 ? null : { x: minX / 2, y: minY / 2, width: (maxX - minX + 1) / 2, height: (maxY - minY + 1) / 2 },
        finalColumnRed,
      });
      canvas.width = canvas.height = 0;
    }
    await pdf.destroy();
    return output;
  }, [...bytes]);
  return { mediaBoxes, ink };
}

// Removing the source-size print boundary must fail the calibrated and malformed guards below;
// changing page sizes, placement, card sizing or padding must fail these independent physical measurements.
for (const [paperSize, short, long] of [["a4", 210, 297], ["b5", 182, 257], ["a5", 148, 210]]) {
  for (const [front, back] of [["landscape", "portrait"], ["portrait", "landscape"], ["portrait", "portrait"], ["landscape", "landscape"]]) {
    test(`${paperSize} ${front}/${back}: valid source preserves physical image, writing and ticket scale with distribution on/off`, async () => {
      await prepare({ paperSize, front, back });
      const on = await printAndMeasure(true), off = await printAndMeasure(false);
      const frontWidth = (front === "portrait" ? short : long) * pt, frontHeight = (front === "portrait" ? long : short) * pt;
      const backWidth = (back === "portrait" ? short : long) * pt, backHeight = (back === "portrait" ? long : short) * pt;
      for (const result of [on, off]) {
        assert.equal(result.mediaBoxes.length, 2);
        near(result.mediaBoxes[0].width, frontWidth, "front MediaBox width", 1); near(result.mediaBoxes[0].height, frontHeight, "front MediaBox height", 1);
        near(result.mediaBoxes[1].width, backWidth, "back MediaBox width", 1); near(result.mediaBoxes[1].height, backHeight, "back MediaBox height", 1);
        near(result.ink[0].image.x, 0, "fit image left"); near(result.ink[0].image.y, 0, "fit image top");
        near(result.ink[0].image.width, frontWidth, "fit image width"); near(result.ink[0].image.height, frontHeight, "fit image height");
        // Literal stylesheet side paddings: 6% portrait; 5% landscape. No production helper supplies expectations.
        near(result.ink[1].header.width, backWidth * (back === "portrait" ? .88 : .9), "practice header physical width");
        near(result.ink[1].header.x, backWidth * (back === "portrait" ? .06 : .05), "practice header left padding");
        assert.ok(result.ink[1].firstWritingRule?.width > backWidth * .7, "actual handwriting rule must span the body");
      }
      assert.deepEqual(on.ink[1].header, off.ink[1].header, "card toggle changed body header scale");
      assert.deepEqual(on.ink[1].firstWritingRule, off.ink[1].firstWritingRule, "card toggle changed handwriting geometry");
      assert.equal(off.ink[1].ticket, null);
      near(on.ink[1].ticket.width, Math.min(backWidth * .3, 63 * pt), "physical ticket width");
    });
  }
}

// Calibration intentionally retains raw extents beyond an image. They must remain raw, but must not
// cause the print renderer to shrink either side. These are valid 10x3 source tests, not over-capacity data.
for (const front of ["portrait", "landscape"]) {
  test(`valid ${front} calibrated grid crossing the right scan edge cannot shrink either PDF side`, async () => {
    await prepare({ front, back: "portrait", grid: { left: .135, top: .12, right: 1.067, bottom: .96 } });
    const before = await page.evaluate(() => ({ stored: localStorage.getItem(sessionsKey()), grid: structuredClone(returnOutputState.calibrations["synthetic-scale"].grid) }));
    const output = await printAndMeasure();
    near(output.ink[1].header.width, 210 * pt * .88, "calibrated practice header physical width");
    near(output.ink[0].image.width, (front === "portrait" ? 210 : 297) * pt, "calibrated front image width");
    assert.ok(output.ink[0].finalColumnRed > 10, "red annotations in the partly clipped final column must remain visible");
    const after = await page.evaluate(() => ({ stored: localStorage.getItem(sessionsKey()), grid: returnOutputState.calibrations["synthetic-scale"].grid, cell: returnQuestionRect(returnOutputState.session, 20, "synthetic-scale") }));
    assert.equal(after.stored, before.stored); assert.deepEqual(after.grid, before.grid);
    near(after.cell.left, 75.63333333333334, "raw final-column left (%)", .0001);
    near(after.cell.width, 31.06666666666667, "raw final-column width (%)", .0001);
    assert.ok(after.cell.left + after.cell.width > 100, "raw calibration was silently clipped");
  });
}

test("malformed legacy capacity cannot shrink the actual PDF through off-image annotations", async () => {
  // Dedicated guard for the original QA fixture mistake; ordinary demos/tests use a valid 10x3 capacity.
  await prepare({ cols: 1, sourceOrientation: "portrait" });
  const output = await printAndMeasure();
  near(output.ink[1].header.width, 210 * pt * .88, "malformed-capacity practice header physical width");
});

for (const [placement, width, height, left] of [["original", 148, 210, 0], ["fit", 209.31428571428572, 297, .34285714285714]]) {
  test(`A5 portrait on A4 ${placement} retains independently calculated physical image bounds`, async () => {
    await prepare({ paperSize: "a4", sourceSize: "a5", sourceOrientation: "portrait", front: "portrait", placement });
    const output = await printAndMeasure();
    near(output.ink[0].image.x, left * pt, "source image left"); near(output.ink[0].image.y, 0, "source image top");
    near(output.ink[0].image.width, width * pt, "source image width"); near(output.ink[0].image.height, height * pt, "source image height");
    near(output.ink[1].header.width, 210 * pt * .88, "A4 practice header physical width");
  });
}
