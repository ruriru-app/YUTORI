import assert from "node:assert/strict";
import test, { before, beforeEach, afterEach, after } from "node:test";
import { createYutoriBrowser } from "./helpers/yutori-browser.mjs";

const payload = '<img data-restored-count src="/__restore_count_payload__" onerror="globalThis.restoreCountExecuted=true;localStorage.removeItem(\'foreign_count_sentinel\')">';
const sessionsKey = "yutori_grading_sessions_v023";
let harness, page, errors;
before(async () => { harness = await createYutoriBrowser(); });
beforeEach(async () => {
  page = await harness.freshPage({ pathname: "/", timezoneId: "Asia/Tokyo" });
  errors = [];
  page.on("pageerror", error => errors.push(error.message));
  await page.addInitScript(() => { globalThis.restoreCountExecuted = false; });
});
afterEach(async () => { await page?.context().close(); assert.deepEqual(errors, []); });
after(async () => { await harness?.close(); });

function session(overrides = {}) {
  return { id: "count-session", testName: "Count control", questions: [], modelAnswers: [], classes: [], answers: {}, grades: {}, currentWorkflowStep: 1, ...overrides };
}

// Only the OS save picker is substituted: archive parsing, OPFS write/readback,
// confirmation, replacement, native reload, and all renderers are production code.
async function restoreEntries(entries) {
  await page.evaluate(async entries => {
    clearTimeout(draftSaveTimer); draftSaveTimer = null;
    localStorage.setItem("yutori_count_before_restore", "safety-copy");
    localStorage.setItem("foreign_count_sentinel", "preserve");
    const handle = await (await navigator.storage.getDirectory()).getFileHandle("counts-safety.yutori", { create: true });
    YutoriBackup.configure({ pickSaveFile: () => Promise.resolve(handle) });
    const manifest = {
      formatVersion: 1, createdAt: "2026-10-14T00:00:00Z", appVersion: "v0.3.51",
      counts: { localStorage: Object.keys(entries).length }, localStorageKeys: Object.keys(entries),
      indexedDB: { name: "YUTORI_DB", version: 2, stores: ["pdfFiles", "pdfPages"].map(name => ({ name, keyPath: "id", autoIncrement: false, indexes: [], count: 0 })) },
    };
    const records = Object.entries(entries).map(([key, value]) => ({ type: "localStorage", source: "localStorage", key, value }));
    const file = new File([await new Response(YutoriBackupArchive.createArchiveStream(manifest, records)).blob()], "counts.yutori");
    await YutoriBackup.inspectRestoreFile(file);
  }, entries);
  await page.locator("#restoreSafetyButton").click();
  await page.waitForFunction(() => !document.getElementById("restoreConfirm").disabled);
  assert.equal(await page.evaluate(async () => {
    const file = await (await (await navigator.storage.getDirectory()).getFileHandle("counts-safety.yutori")).getFile();
    const records = [];
    await YutoriBackupArchive.readArchiveStream(file, { onRecord: record => records.push(record) });
    return file.size > 0 && records.some(record => record.key === "yutori_count_before_restore" && record.value === "safety-copy");
  }), true, "native safety archive was written and read back");
  await page.locator("#restoreConfirm").check();
  await Promise.all([
    page.waitForEvent("domcontentloaded"),
    page.locator("#restoreReplaceButton").click(),
  ]);
  await page.evaluate(() => yutoriAppInitialization);
  await assertRawEntries(entries);
  assert.equal(await page.evaluate(() => localStorage.getItem("yutori_count_before_restore")), null);
}

async function assertRawEntries(entries) {
  assert.deepEqual(await page.evaluate(keys => Object.fromEntries(keys.map(key => [key, localStorage.getItem(key)])), Object.keys(entries)), entries);
}

async function assertInert() {
  const actual = await page.evaluate(async () => {
    await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    return {
      injected: document.querySelectorAll("[data-restored-count]").length,
      executed: globalThis.restoreCountExecuted,
      foreign: localStorage.getItem("foreign_count_sentinel"),
      ready: globalThis.yutoriAppReady,
    };
  });
  assert.deepEqual(actual, { injected: 0, executed: false, foreign: "preserve", ready: true });
  assert.deepEqual(errors, []);
}

async function openGrading() { await page.locator('header [data-screen="gradingScreen"]').click(); }
async function openOutput() { await page.locator('header [data-screen="outputScreen"]').click(); }
async function openSettings() { await page.getByRole("button", { name: "各種設定", exact: true }).click(); }

test("restored forged question length cannot execute HTML in grading resume", async () => {
  const entries = { [sessionsKey]: JSON.stringify([session({ questions: { length: payload } })]) };
  await restoreEntries(entries);
  await openGrading();
  await assertInert();
  assert.match(await page.locator("#resumeList").innerText(), /採点途中：0 \/ 0問/);
  await page.locator(".resume-delete").click();
  assert.match(await page.locator("#deleteSessionMessage").innerText(), /Count control/);
  await assertRawEntries(entries);
});

test("restored forged roster length and hostile studentCount stay inert in settings and edit", async () => {
  const entries = {
    yutori_rosters: JSON.stringify({ Review: { length: payload } }),
    yutori_class_profiles_v1: JSON.stringify({ Review: { className: "Review", studentCount: payload } }),
  };
  await restoreEntries(entries);
  await openSettings();
  await assertInert();
  assert.match(await page.locator("#classSettingsList").innerText(), /人数 0名・名簿 0名/);
  await page.locator(".class-settings-edit").click();
  assert.equal(await page.locator("#classStudentCountInput").inputValue(), "0");
  assert.equal(await page.locator("#classRosterInput").inputValue(), "");
  await assertInert();
  await assertRawEntries(entries);
});

test("restored forged question length cannot execute HTML in graded output cards", async () => {
  const entries = { [sessionsKey]: JSON.stringify([session({ questions: { length: payload }, grades: { recorded: { mark: "ok" } } })]) };
  await restoreEntries(entries);
  await openOutput();
  await assertInert();
  assert.match(await page.locator("#outputSessionCards").innerText(), /採点済み 0\/0問/);
  await page.locator("#outputSessionCards").getByRole("button", { name: "本棚へ収納" }).click();
  assert.equal(await page.locator("#outputSessionCards .output-session-card").count(), 0);
  await page.locator("#outputSessionCatalog").getByRole("button", { name: "机に戻す" }).click();
  assert.equal(await page.locator("#outputSessionCards .output-session-card").count(), 1);
  await assertInert();
  await assertRawEntries(entries);
});

for (const [label, value] of [["null", null], ["number", 7], ["string", "not-an-array"], ["object", { length: payload }]]) {
  test(`restored ${label} collections have safe counts and traversals`, async () => {
    const entries = {
      yutori_rosters: JSON.stringify({ Review: value }),
      [sessionsKey]: JSON.stringify([
        session({ id: "bad-classes", testName: "Bad classes", questions: ["q"], classes: value, answers: value, grades: { recorded: { mark: "ok" } } }),
        session({ id: "bad-answers", testName: "Bad answers", questions: ["q"], classes: ["Review"], answers: { Review: value }, grades: { recorded: { mark: "ok" } } }),
        session({ id: "bad-questions", testName: "Bad questions", questions: value, grades: { recorded: { mark: "ok" } } }),
      ]),
    };
    await restoreEntries(entries);
    await openSettings();
    assert.match(await page.locator("#classSettingsList").innerText(), /人数 0名・名簿 0名/);
    await openGrading();
    assert.equal(await page.locator("#resumeList .resume-item").count(), 3);
    assert.match(await page.locator(".resume-item").filter({ hasText: "Bad questions" }).innerText(), /採点途中：0 \/ 0問/);
    assert.equal(await page.locator(".resume-missing-simple").filter({ hasText: "未受験・答案なし 0名" }).count(), 3);
    await openOutput();
    assert.equal(await page.locator("#outputSessionCards .output-session-card").count(), 3);
    await page.locator("#outputSessionSort").selectOption("class");
    await assertInert();
    await assertRawEntries(entries);
  });
}

test("restored profile counts reject nonfinite fractional negative and object fallbacks", async () => {
  const counts = { infinite: "Infinity", negative: -1, fraction: 2.5, hostile: payload, object: { length: payload }, conversion: { toString: payload }, missing: null, zero: 0, numericString: "4", valid: 5 };
  const entries = {
    yutori_rosters: JSON.stringify(Object.fromEntries(Object.keys(counts).map(name => [name, [{ no: 1, name: "One" }, { no: 2, name: "Two" }]]))),
    yutori_class_profiles_v1: JSON.stringify(Object.fromEntries(Object.entries(counts).map(([name, studentCount]) => [name, { className: name, studentCount }]))),
  };
  await restoreEntries(entries);
  await openSettings();
  await assertInert();
  for (const [name, expected] of [["infinite", 2], ["negative", 2], ["fraction", 2], ["hostile", 2], ["object", 2], ["conversion", 2], ["missing", 2], ["zero", 2], ["numericString", 4], ["valid", 5]]) {
    const card = page.locator(".class-settings-card").filter({ has: page.getByRole("heading", { name, exact: true }) });
    assert.match(await card.innerText(), new RegExp(`人数 ${expected}名・名簿 2名`), name);
    await card.getByRole("button", { name: "編集" }).click();
    assert.equal(await page.locator("#classStudentCountInput").inputValue(), String(expected), name);
    await page.locator('#classModal button[onclick="closeClassModal()"]').first().click();
  }
  await assertInert();
  await assertRawEntries(entries);
});

for (const [label, value] of [["null", null], ["primitive", "not-an-array"], ["object", { length: payload }]]) {
  test(`restored ${label} session list stays usable without traversing a non-array`, async () => {
    const entries = { [sessionsKey]: JSON.stringify(value) };
    await restoreEntries(entries);
    await openGrading();
    assert.equal(await page.locator("#resumeList .resume-item").count(), 0);
    await openOutput();
    assert.equal(await page.locator("#outputSessionCards .output-session-card").count(), 0);
    await assertInert();
    await assertRawEntries(entries);
  });
}

test("restored invalid collection members and PDF review counts stay inert after resuming", async () => {
  const wrong = { length: payload };
  const entries = {
    yutori_rosters: JSON.stringify({ Review: [null, 7, payload, { no: 1, name: "One" }] }),
    [sessionsKey]: JSON.stringify([null, 7, payload, [], session({
      questions: wrong, modelAnswers: wrong, classes: [null, 7, wrong, "Review"],
      answers: { Review: [null, 7, payload, { no: 1, name: "One" }] },
      files: wrong, pdfPages: wrong, ignoredPageIds: wrong, issues: wrong,
      questionScores: wrong, gradeHistory: wrong, assignmentMode: "attendance-mark",
      workflowCompleted: { 1: true }, currentWorkflowStep: 2,
    })]),
  };
  await restoreEntries(entries);
  await openSettings();
  assert.match(await page.locator("#classSettingsList").innerText(), /人数 1名・名簿 1名/);
  await openGrading();
  assert.equal(await page.locator("#resumeList .resume-item").count(), 1);
  assert.match(await page.locator("#resumeList").innerText(), /未受験・答案なし 1名/);
  await page.getByRole("button", { name: "採点を再開", exact: true }).click();
  assert.match(await page.locator(".pdf-review-summary").innerText(), /PDF 0ページ/);
  assert.match(await page.locator(".pdf-review-summary").innerText(), /名簿 1名/);
  assert.match(await page.locator(".pdf-review-summary").innerText(), /要確認 1件/);
  await assertInert();
  await assertRawEntries(entries);
});

test("well-formed restored arrays retain counts titles and ordinary controls", async () => {
  const people = [{ no: 1, name: "One", pageId: "p1" }, { no: 2, name: "Two" }, { no: 3, name: "Absent", absent: true }];
  const entries = {
    yutori_rosters: JSON.stringify({ Review: people }),
    yutori_class_profiles_v1: JSON.stringify({ Review: { className: "Review", schoolName: "Test School", studentCount: 4 } }),
    [sessionsKey]: JSON.stringify([session({ questions: ["Q1", "Q2"], modelAnswers: ["A1", "A2"], classes: ["Review"], answers: { Review: people }, grades: { "Review::1::0": { mark: "ok" }, "Review::2::0": { mark: "ng" }, "Review::1::1": { mark: "ok" } } })]),
  };
  await restoreEntries(entries);
  await openSettings();
  assert.match(await page.locator("#classSettingsList").innerText(), /人数 4名・名簿 3名/);
  await page.locator(".class-settings-edit").click();
  assert.equal(await page.locator("#classStudentCountInput").inputValue(), "4");
  assert.equal(await page.locator("#classRosterInput").inputValue(), "1\tOne\n2\tTwo\n3\tAbsent");
  await page.locator('#classModal button[onclick="closeClassModal()"]').first().click();
  await openGrading();
  assert.match(await page.locator("#resumeList").innerText(), /採点途中：1 \/ 2問/);
  assert.match(await page.locator("#resumeList").innerText(), /未受験・答案なし 2名/);
  await page.getByRole("button", { name: "個別のPDF読込", exact: true }).click();
  assert.equal(await page.locator(".late-pdf-candidate").count(), 2);
  await page.locator('#latePdfModal button[onclick="closeLatePdfModal()"]').first().click();
  await openOutput();
  assert.match(await page.locator("#outputSessionCards").innerText(), /採点済み 1\/2問/);
  await page.locator("#outputSessionCards").getByRole("button", { name: "本棚へ収納" }).click();
  await page.locator("#outputSessionCatalog").getByRole("button", { name: "机に戻す" }).click();
  assert.equal(await page.locator("#outputSessionCards h3").innerText(), "Count control");
  await assertInert();
  await assertRawEntries(entries);
});
