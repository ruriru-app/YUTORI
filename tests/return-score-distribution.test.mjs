import assert from "node:assert/strict";
import test, { before, beforeEach, afterEach, after } from "node:test";
import { createRequire } from "node:module";
import { createYutoriBrowser } from "./helpers/yutori-browser.mjs";

const { PDFDocument } = createRequire(import.meta.url)("pdf-lib");
let harness, page;
before(async () => { harness = await createYutoriBrowser(); });
beforeEach(async () => {
  page = await harness.freshPage({ pathname: "/" });
  await page.evaluate(async () => {
    globalThis.distributionFixture = (count = 10) => {
      const pupil = (no, name, extra = {}) => ({ no, name, pageId: `synthetic-${no}`, ...extra });
      const session = { id: "distribution", testName: "合成テスト", grade: "6", paperSize: "a4", orientation: "portrait", rows: 10, cols: 1,
        questions: Array(count).fill("単語"), modelAnswers: Array(count).fill("apple"), fullScore: 1, partialScore: .5,
        classes: ["A", "B", "C"], answers: { A: [pupil(1, "本人"), pupil(2, "他者A2"), pupil(3, "他者A3"), pupil(4, "欠席", { absent: true }), pupil(5, "途中")],
          B: [pupil(1, "他者B1"), pupil(2, "他者B2")], C: [pupil(1, "別学年")] }, grades: {} };
      for (const [name, scores] of [["A", [0, count / 2, count, count]], ["B", [count * .4, count * .6]], ["C", [count]]]) {
        scores.forEach((score, index) => { for (let q = 0; q < count; q++) session.grades[`${name}::${index + 1}::${q}`] = { mark: q < score ? "ok" : "ng" }; });
      }
      session.grades["A::5::0"] = { mark: "ok" };
      return session;
    };
    gradingState.classProfiles = { A: { grade: "6" }, B: { grade: "6" }, C: { grade: "5" } };
    localStorage.setItem(sessionsKey(), JSON.stringify([distributionFixture()]));
    await loadReturnPracticeFont();
    await changeReturnOutputSession("distribution");
    globalThis.slipSummary = html => {
      const host = document.createElement("div"); host.innerHTML = html;
      const slip = host.querySelector(".return-score-distribution");
      return slip ? { text: slip.textContent, bars: [...slip.querySelectorAll("rect")].map(bar => ({ count: Number(bar.dataset.count), fill: bar.getAttribute("fill") })),
        marker: slip.querySelectorAll(".return-distribution-marker").length, invalid: /NaN|Infinity/.test(slip.outerHTML), html: slip.outerHTML } : null;
    };
  });
});
afterEach(async () => { await page?.context().close(); });
after(async () => { await harness?.close(); });

// Missing checkbox/default, ignored toggle or resetting a manual choice must fail here.
test("distribution starts on; disabling survives redisplay and removes preview and print slips", async () => {
  assert.equal(await page.locator("#returnShowScoreDistribution").count(), 1);
  assert.equal(await page.locator("#returnShowScoreDistribution").isChecked(), true);
  await page.evaluate(async () => { setReturnPreviewPage(2); await renderReturnOutputPreview(); });
  assert.equal(await page.locator("#returnOutputPreview .return-score-distribution").count(), 1);
  await page.locator("#returnShowScoreDistribution").evaluate(input => input.click());
  await page.evaluate(async () => { await changeReturnOutputSession("distribution"); setReturnPreviewPage(2); await renderReturnOutputPreview(); window.print = () => {}; await printReturnPdfs(); });
  assert.equal(await page.locator("#returnShowScoreDistribution").isChecked(), false);
  assert.equal(await page.locator("#returnOutputPreview .return-score-distribution").count(), 0);
  assert.equal(await page.locator("#returnPrintRoot .return-score-distribution").count(), 0);
  assert.equal(await page.evaluate(() => returnOutputOptions().showScoreDistribution), false);
});

// Wrong scope, output-selection filtering, absence/unfinished inclusion or leaked names fails.
test("population uses completed class or same-grade pupils independently of return selection", async () => {
  const result = await page.evaluate(() => {
    if (typeof returnScoreDistributionHtml !== "function") return null;
    const s = returnOutputState.session, p = s.answers.A[0], options = returnOutputOptions();
    const classSlip = slipSummary(returnScoreDistributionHtml(s, "A", p, options));
    returnOutputState.selectedNos = new Set([1]);
    const selected = slipSummary(returnScoreDistributionHtml(s, "A", p, options));
    const grade = slipSummary(returnScoreDistributionHtml(s, "A", p, { ...options, rateScope: "grade" }));
    changeReturnOutputClass("B");
    return { classSlip, selected, grade, other: slipSummary(returnScoreDistributionHtml(s, "B", s.answers.B[0], options)) };
  });
  assert.ok(result, "distribution renderer missing");
  assert.match(result.classSlip.text, /クラス・3人/);
  assert.match(result.classSlip.text, /平均 5点/);
  assert.match(result.classSlip.text, /あなた 0点/);
  assert.deepEqual(result.classSlip.bars.map(bar => bar.count), [1, 0, 0, 0, 0, 1, 0, 0, 0, 1]);
  assert.deepEqual(result.selected, result.classSlip);
  assert.match(result.grade.text, /学年・5人/);
  assert.match(result.grade.text, /平均 5点/);
  assert.deepEqual(result.grade.bars.map(bar => bar.count), [1, 0, 0, 0, 1, 1, 1, 0, 0, 1]);
  assert.match(result.other.text, /クラス・2人/);
  assert.match(result.other.text, /あなた 4点/);
  for (const slip of [result.classSlip, result.grade, result.other]) {
    assert.doesNotMatch(slip.html, /他者|欠席|途中|別学年|順位/);
    assert.equal(slip.invalid, false);
    assert.equal(slip.marker, 1);
    assert.equal(slip.bars.filter(bar => bar.fill === "#FCCC8E").length, 1);
    assert.ok(slip.bars.filter(bar => bar.fill !== "#FCCC8E").every(bar => bar.fill === "#a7a29b"));
  }
});

// Decimal scores, zero totals, empty populations and invalid maxima must not corrupt SVG.
test("decimal, zero, lone, empty and unfinished cases produce honest scores and finite SVG", async () => {
  const result = await page.evaluate(() => {
    if (typeof returnScoreDistributionHtml !== "function") return null;
    const s = distributionFixture(2), options = returnOutputOptions(), p = s.answers.A[0];
    s.classes = ["A"]; s.answers = { A: [p] }; s.questionScores = [{ ok: .5, partial: .25 }, { ok: .5, partial: .25 }];
    s.grades = { "A::1::0": { mark: "partial" }, "A::1::1": { mark: "ng" } };
    const decimal = slipSummary(returnScoreDistributionHtml(s, "A", p, options));
    s.grades["A::1::0"].mark = "ng";
    const zero = slipSummary(returnScoreDistributionHtml(s, "A", p, options));
    delete s.grades["A::1::1"];
    const empty = slipSummary(returnScoreDistributionHtml(s, "A", p, options));
    s.answers.A.push({ no: 2, name: "非公開" });
    s.grades["A::2::0"] = { mark: "ok" }; s.grades["A::2::1"] = { mark: "ok" };
    const unfinished = slipSummary(returnScoreDistributionHtml(s, "A", p, options));
    s.questionScores[0].ok = Infinity;
    const invalid = slipSummary(returnScoreDistributionHtml(s, "A", p, options));
    return { decimal, zero, empty, unfinished, invalid };
  });
  assert.ok(result, "distribution renderer missing");
  assert.match(result.decimal.text, /クラス・1人/);
  assert.match(result.decimal.text, /あなた 0.25点/);
  assert.match(result.decimal.text, /平均 0.3点/);
  assert.deepEqual(result.decimal.bars.map(bar => bar.count), [0, 0, 1, 0, 0, 0, 0, 0, 0, 0]);
  assert.match(result.zero.text, /あなた 0点/);
  assert.match(result.zero.text, /平均 0点/);
  assert.equal(result.zero.bars[0].count, 1);
  assert.match(result.empty.text, /クラス・0人/);
  assert.match(result.empty.text, /採点完了データなし/);
  assert.match(result.empty.text, /あなた —点/);
  assert.match(result.unfinished.text, /クラス・1人/);
  assert.match(result.unfinished.text, /あなた —点/);
  for (const key of ["empty", "unfinished", "invalid"]) assert.equal(result[key].marker, 0);
  for (const slip of Object.values(result)) { assert.equal(slip.invalid, false); assert.doesNotMatch(slip.html, /非公開/); }
});

test("summed decimal points print clean axis and own-score labels without floating-point tails", async () => {
  const result = await page.evaluate(() => {
    const s = distributionFixture(25); s.fullScore = .4; s.partialScore = .2;
    for (let q = 0; q < 25; q++) s.grades[`A::1::${q}`] = { mark: q < 12 ? "ok" : q === 12 ? "partial" : "ng" };
    const host = document.createElement("div"); host.innerHTML = returnScoreDistributionHtml(s, "A", s.answers.A[0], returnOutputOptions());
    return { score: host.querySelector(".return-distribution-score strong").textContent,
      labels: [...host.querySelectorAll(".return-distribution-chart text")].map(node => node.textContent).slice(-3) };
  });
  assert.equal(result.score, "あなた 5点");
  assert.deepEqual(result.labels, ["0", "5", "10点"]);
});

// Catches real scoring accumulation putting a displayed boundary in the previous band.
test("real fractional scoring counts and highlights the midpoint band without changing grades", async () => {
  const result = await page.evaluate(() => {
    const s = distributionFixture(40), p = s.answers.A[0];
    s.fullScore = .3; s.partialScore = .15;
    s.classes = ["A"]; s.answers = { A: [p] }; s.grades = {};
    for (let q = 0; q < 40; q++) s.grades[`A::1::${q}`] = { mark: q < 20 ? "ok" : "ng" };
    const before = JSON.stringify(s), own = calculateStudentResult(s, "A", p), maximum = returnMaximumScore(s);
    const slip = slipSummary(returnScoreDistributionHtml(s, "A", p, returnOutputOptions()));
    return { own, maximum, slip, unchanged: JSON.stringify(s) === before };
  });
  assert.equal(result.own.score, 5.999999999999998);
  assert.equal(result.maximum, 12.000000000000007);
  assert.equal(result.own.complete, true);
  assert.match(result.slip.text, /あなた 6点/);
  assert.deepEqual(result.slip.bars.map(bar => bar.count), [0, 0, 0, 0, 0, 1, 0, 0, 0, 0]);
  assert.equal(result.slip.bars.findIndex(bar => bar.fill === "#FCCC8E"), 5);
  assert.equal(result.slip.marker, 1);
  assert.equal(result.slip.invalid, false);
  assert.equal(result.unchanged, true);
});

// Literal counts follow correct fractions of questions; no scoring helper derives expectations.
for (const [questions, points] of [[40, .3], [60, .1], [80, .7], [200, .1], [300, .2], [1000, .3]]) {
  test(`real ${questions} x ${points} scoring retains every interior distribution boundary`, async () => {
    const result = await page.evaluate(({ questions, points }) => {
      const s = distributionFixture(questions); s.fullScore = points; s.partialScore = points / 2;
      s.classes = ["A"]; s.answers = { A: [] }; s.grades = {};
      for (let band = 0; band <= 10; band++) {
        const p = { no: band + 1, name: `合成${band}` }; s.answers.A.push(p);
        for (let q = 0; q < questions; q++) s.grades[`A::${p.no}::${q}`] = { mark: q < questions * band / 10 ? "ok" : "ng" };
      }
      const before = JSON.stringify(s);
      const slips = s.answers.A.map(p => slipSummary(returnScoreDistributionHtml(s, "A", p, returnOutputOptions())));
      return { counts: slips[0].bars.map(bar => bar.count), highlights: slips.map(slip => slip.bars.findIndex(bar => bar.fill === "#FCCC8E")),
        unchanged: JSON.stringify(s) === before, finite: slips.every(slip => !slip.invalid && slip.marker === 1) };
    }, { questions, points });
    assert.deepEqual(result.counts, [1, 1, 1, 1, 1, 1, 1, 1, 1, 2]);
    assert.deepEqual(result.highlights, [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 9]);
    assert.equal(result.unchanged, true);
    assert.equal(result.finite, true);
  });
}

// Catches decimal quantization of distinct partial-credit scores or altered general totals.
test("distribution preserves genuinely nearby partial-score bands and original scoring rules", async () => {
  const result = await page.evaluate(() => {
    const s = distributionFixture(40); s.fullScore = .3; s.partialScore = .15;
    s.classes = ["A"]; s.answers = { A: [1, 2, 3].map(no => ({ no, name: `合成${no}` })) }; s.grades = {};
    s.questionScores = [{ ok: .3, partial: .3 - 24e-15 }, { ok: .3, partial: .3 + 24e-15 }];
    for (const p of s.answers.A) for (let q = 0; q < 40; q++) {
      s.grades[`A::${p.no}::${q}`] = { mark: q < 20 ? "ok" : "ng" };
    }
    s.grades["A::1::0"].mark = "partial"; s.grades["A::3::1"].mark = "partial";
    const before = JSON.stringify(s);
    const raw = s.answers.A.map(p => calculateStudentResult(s, "A", p));
    const slips = s.answers.A.map(p => slipSummary(returnScoreDistributionHtml(s, "A", p, returnOutputOptions())));
    return { counts: slips[0].bars.map(bar => bar.count), highlights: slips.map(slip => slip.bars.findIndex(bar => bar.fill === "#FCCC8E")),
      raw, rawAfter: s.answers.A.map(p => calculateStudentResult(s, "A", p)), unchanged: JSON.stringify(s) === before };
  });
  assert.deepEqual(result.counts, [0, 0, 0, 0, 1, 2, 0, 0, 0, 0]);
  assert.deepEqual(result.highlights, [4, 5, 5]);
  assert.deepEqual(result.rawAfter, result.raw);
  assert.equal(result.unchanged, true);
});

test("only the first practice page gets a slip; perfect scores retain the empty practice side", async () => {
  const result = await page.evaluate(() => {
    const s = distributionFixture(25), p = s.answers.A[0], options = { ...returnOutputOptions(), practiceCount: 25, fitPracticePage: false };
    const host = document.createElement("div");
    const describe = show => {
      host.innerHTML = returnPrintPagesForPerson(s, "A", p, { ...options, showScoreDistribution: show }).join("");
      return { sides: [...host.children].map(node => node.dataset.side), slips: [...host.children].map(node => node.querySelectorAll(".return-score-distribution").length), rows: host.querySelectorAll(".return-practice-item").length };
    };
    const on = describe(true), off = describe(false);
    host.innerHTML = returnPracticePagesHtml(s, "A", s.answers.A[2], options).join("");
    return { on, off, perfect: host.querySelectorAll(".return-score-distribution").length, empty: host.querySelectorAll(".return-practice-empty").length };
  });
  assert.deepEqual(result.on.sides, ["answer", "practice", "practice", "blank"]);
  assert.deepEqual(result.on.slips, [0, 1, 0, 0]);
  assert.deepEqual(result.off.slips, [0, 0, 0, 0]);
  assert.deepEqual(result.on.sides, result.off.sides);
  assert.equal(result.on.rows, 25); assert.equal(result.off.rows, 25);
  assert.equal(result.perfect, 1); assert.equal(result.empty, 1);
});

for (const viewport of [320, 1024]) for (const paperSize of ["a4", "b5", "a5"]) for (const orientation of ["portrait", "landscape"]) {
  test(`${paperSize} ${orientation} at ${viewport}px preserves rows and model positions under a compact overlay`, async () => {
    await page.setViewportSize({ width: viewport, height: 900 });
    const result = await page.evaluate(({ paperSize, orientation }) => {
      const s = distributionFixture(25), p = s.answers.A[0];
      const options = { ...returnOutputOptions(), returnPaperSize: paperSize, returnPracticeOrientation: orientation };
      const host = document.createElement("div"); host.style.width = "100%"; document.body.appendChild(host);
      const measure = show => {
        host.innerHTML = returnPracticePagesHtml(s, "A", p, { ...options, showScoreDistribution: show }).join("");
        const sheet = host.firstElementChild, box = sheet.getBoundingClientRect(), slip = sheet.querySelector(".return-score-distribution"), card = slip?.getBoundingClientRect();
        const relative = node => { const r = node.getBoundingClientRect(); return [r.left - box.left, r.top - box.top, r.width, r.height]; };
        const items = [...sheet.querySelectorAll(".return-practice-item")];
        return { rows: items.map(relative), lines: [...sheet.querySelectorAll(".return-four-lines")].map(relative), models: [...sheet.querySelectorAll("text.return-practice-model-answer")].map(relative),
          slip: card ? { ratio: card.width / box.width, right: box.right - card.right, bottom: box.bottom - card.bottom, left: card.left - box.left, top: card.top - box.top,
            background: getComputedStyle(slip).backgroundColor, lineHeight: getComputedStyle(slip).lineHeight, fontSize: getComputedStyle(slip).fontSize, border: getComputedStyle(slip).borderTopStyle,
            contentWidth: box.width - parseFloat(getComputedStyle(sheet).paddingLeft) - parseFloat(getComputedStyle(sheet).paddingRight) } : null,
          details: [...sheet.querySelectorAll(".return-practice-details")].map(relative), width: box.width };
      };
      const on = measure(true), off = measure(false); host.remove(); return { on, off };
    }, { paperSize, orientation });
    assert.ok(result.on.slip, "slip missing");
    assert.deepEqual(result.on.rows, result.off.rows); assert.deepEqual(result.on.lines, result.off.lines); assert.deepEqual(result.on.models, result.off.models);
    const card = result.on.slip, paperWidth = ({ a4: [210, 297], b5: [182, 257], a5: [148, 210] })[paperSize][orientation === "portrait" ? 0 : 1];
    assert.ok(Math.abs(card.ratio - Math.min(.3, 63 / paperWidth)) < .012, JSON.stringify(card));
    assert.ok(card.right > 0 && card.bottom > 0 && card.top > 0);
    assert.ok(result.on.details.every(([x, , width]) => x + width < card.left));
    assert.ok(result.on.models.every(([x]) => x < card.left));
    assert.equal(card.background, "rgb(255, 255, 255)"); assert.equal(card.border, "solid");
    assert.ok(parseFloat(card.fontSize) / result.on.width < .018);
    assert.ok(parseFloat(card.lineHeight) / parseFloat(card.fontSize) <= 1.13);
  });
}

// This catches physically incorrect print sizes or added duplex pages when the slip is on.
for (const [paperSize, short, long] of [["a4", 210, 297], ["b5", 182, 257], ["a5", 148, 210]]) {
  test(`${paperSize} actual PDF retains landscape front / portrait back dimensions and page count`, async () => {
    const sizes = [];
    for (const show of [true, false]) {
      await page.evaluate(async ({ paperSize, show }) => {
        document.body.classList.remove("return-printing");
        checkReturnOption("returnPaperSize", paperSize); checkReturnOption("returnAnswerOrientation", "landscape"); checkReturnOption("returnPracticeOrientation", "portrait");
        const checkbox = document.getElementById("returnShowScoreDistribution"); if (checkbox) checkbox.checked = show;
        returnOutputState.selectedNos = new Set([1]); window.print = () => {}; await printReturnPdfs();
      }, { paperSize, show });
      await page.emulateMedia({ media: "print" });
      const layout = await page.locator("#returnPrintRoot .return-practice-sheet").evaluate(sheet => {
        const card = sheet.querySelector(".return-score-distribution"); return card ? { width: card.getBoundingClientRect().width, sheet: sheet.getBoundingClientRect().width } : null;
      });
      if (show) { assert.ok(layout, "printed slip missing"); assert.ok(layout.width / (96 / 25.4) <= 63.1); }
      else assert.equal(layout, null);
      const pdf = await PDFDocument.load(await page.pdf({ printBackground: true, preferCSSPageSize: true }));
      sizes.push(pdf.getPages().map(p => p.getSize()));
      await page.emulateMedia({ media: "screen" });
    }
    assert.deepEqual(sizes[0], sizes[1]); assert.equal(sizes[0].length, 2);
    for (const [index, [width, height]] of [[long, short], [short, long]].entries()) {
      assert.ok(Math.abs(sizes[0][index].width - width * 72 / 25.4) < 1);
      assert.ok(Math.abs(sizes[0][index].height - height * 72 / 25.4) < 1);
    }
  });
}
