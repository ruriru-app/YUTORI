import assert from "node:assert/strict";
import test, { before, beforeEach, afterEach, after } from "node:test";
import { createYutoriBrowser } from "./helpers/yutori-browser.mjs";

let harness, page, errors;
before(async () => { harness = await createYutoriBrowser(); });
beforeEach(async () => {
  page = await harness.freshPage({ pathname: "/", timezoneId: "Asia/Tokyo" });
  errors = [];
  page.on("pageerror", error => errors.push(error.message));
});
afterEach(async () => { await page?.context().close(); assert.deepEqual(errors, []); });
after(async () => { await harness?.close(); });

async function setup() {
  await page.evaluate(async () => {
    const root = await navigator.storage.getDirectory();
    globalThis.backupHandle = await root.getFileHandle("答案.yutori", { create: true });
    globalThis.pickerNames = [];
    globalThis.downloads = [];
    localStorage.setItem("yutori_fixture", "名簿・答案");
    YutoriBackup.configure({ appVersion: "v0.3.51", now: () => new Date("2026-10-13T12:34:56Z"),
      pickSaveFile: options => { pickerNames.push(options.suggestedName); return Promise.resolve(backupHandle); },
      downloadBlob: async (blob, name) => { downloads.push({ name, size: blob.size }); },
    });
    await YutoriBackup.initialize();
  });
}

test("backup waits for registered page persistence with zero bytes and an exclusive gate before idle", async () => {
  await setup();
  await page.evaluate(() => {
    globalThis.releasePageWrite = null;
    const writing = new Promise(resolve => { releasePageWrite = () => {
      localStorage.setItem("yutori_completed_write", "committed"); resolve(42);
    }; });
    // Compatibility fallback makes RED show the missing behavior, not a missing API exception.
    if (globalThis.trackPersistence) trackPersistence(writing, "pdf-page");
    globalThis.firstSave = saveYutoriBackup();
    globalThis.sharedSave = saveYutoriBackup() === firstSave;
    globalThis.importStarted = false;
    globalThis.restoreStarted = false;
    globalThis.nextImport = globalThis.runExclusiveOperation
      ? runExclusiveOperation("pdf-import", () => { importStarted = true; })
      : Promise.resolve().then(() => { importStarted = true; });
    globalThis.nextRestore = globalThis.runExclusiveOperation
      ? runExclusiveOperation("restore", () => { restoreStarted = true; })
      : Promise.resolve().then(() => { restoreStarted = true; });
  });
  await page.waitForTimeout(50);
  const waiting = await page.evaluate(async () => ({ phase: YutoriBackup.getOperationState().phase,
    bytes: (await backupHandle.getFile()).size, importStarted, restoreStarted, sharedSave }));
  assert.deepEqual(waiting, { phase: "準備", bytes: 0, importStarted: false, restoreStarted: false, sharedSave: true });
  const completed = await page.evaluate(async () => {
    releasePageWrite(); const saved = await firstSave; await nextImport; await nextRestore;
    const records = [];
    await YutoriBackupArchive.readArchiveStream(await backupHandle.getFile(), { onRecord: record => records.push(record) });
    return { ok: saved.ok, importStarted, restoreStarted, value: records.find(record => record.key === "yutori_completed_write")?.value };
  });
  assert.deepEqual(completed, { ok: true, importStarted: true, restoreStarted: true, value: "committed" });
});

test("persistence idle waits for writes registered while draining and preserves values and errors", async () => {
  await setup();
  const result = await page.evaluate(async () => {
    if (!globalThis.trackPersistence) return { available: false };
    let releaseFirst, releaseSecond, idle = false;
    const first = trackPersistence(new Promise(resolve => { releaseFirst = resolve; }), "pdf-files");
    first.then(() => trackPersistence(new Promise(resolve => { releaseSecond = resolve; }), "pdf-page"));
    const waiting = waitForPersistenceIdle().then(() => { idle = true; });
    releaseFirst(17);
    while (!releaseSecond) await new Promise(resolve => setTimeout(resolve, 0));
    await new Promise(resolve => setTimeout(resolve, 0));
    const early = idle;
    releaseSecond(); await waiting;
    const error = new Error("private fixture error");
    let sameError;
    try { await trackPersistence(Promise.reject(error), "pdf-page"); } catch (caught) { sameError = caught === error; }
    await waitForPersistenceIdle();
    return { available: true, early, idle, value: await first, sameError };
  });
  assert.deepEqual(result, { available: true, early: false, idle: true, value: 17, sameError: true });
});

test("exclusive operations are FIFO and release after throw and backup cancellation", async () => {
  await setup();
  const result = await page.evaluate(async () => {
    if (!globalThis.runExclusiveOperation) return { available: false };
    let release, started = false;
    const order = [];
    const holding = runExclusiveOperation("pdf-import", () => new Promise(resolve => { release = resolve; }));
    const throwing = runExclusiveOperation("restore", () => { order.push("restore"); throw new Error("expected"); }).catch(error => error.message);
    const last = runExclusiveOperation("pdf-import", () => { order.push("pdf"); return 8; });
    YutoriBackup.configure({ waitForIdle: () => new Promise(() => { started = true; }) });
    const cancelled = saveYutoriBackup();
    YutoriBackup.cancelBackup();
    const cancellation = await Promise.race([cancelled, new Promise(resolve => setTimeout(() => resolve({ reason: "timeout" }), 250))]);
    release(); await holding;
    const error = await throwing, value = await last;
    await new Promise(resolve => setTimeout(resolve, 10));
    return { available: true, order, error, value, reason: cancellation.reason, started };
  });
  assert.deepEqual(result, { available: true, order: ["restore", "pdf"], error: "expected", value: 8, reason: "AbortError", started: false });
});

test("exclusive backup blocks actual IDB page writes, PDF imports and session deletion until verified close", async () => {
  await setup();
  await page.evaluate(async () => {
    await savePdfFilesToIndexedDB("assets-to-delete", [new File(["original"], "before.pdf", { type: "application/pdf" })]);
    globalThis.releaseCollection = null;
    const original = YutoriBackupStorage.createSnapshotRecordSource;
    globalThis.YutoriBackupStorage = { ...YutoriBackupStorage,
      createSnapshotRecordSource: async options => {
        await new Promise(resolve => { releaseCollection = resolve; }); return original(options);
      } };
    localStorage.setItem(sessionsKey(), JSON.stringify([{ id: "delete-me" }]));
    globalThis.saving = saveYutoriBackup();
  });
  await page.waitForFunction(() => !!releaseCollection);
  await page.evaluate(() => {
    globalThis.pdfWrite = savePdfPageToIndexedDB("later", { id: "p1" }, new Blob(["page"]));
    globalThis.originalWrite = savePdfFilesToIndexedDB("later", [new File(["original"], "later.pdf", { type: "application/pdf" })]);
    globalThis.additionalWrite = saveAdditionalPdfFileToIndexedDB("later", new File(["additional"], "additional.pdf", { type: "application/pdf" }), 1);
    globalThis.assetDeletion = deleteSessionAssetsFromIndexedDB("assets-to-delete");
    gradingState.selectedTestId = "sentinel";
    globalThis.alerts = [];
    globalThis.alert = message => alerts.push(message);
    globalThis.importing = processPdf();
    latePdfContext = { sessionId: "delete-me", candidates: [] };
    document.getElementById("latePdfStatus").textContent = "sentinel";
    globalThis.lateImporting = processLatePdf();
    pendingDeleteSessionId = "delete-me";
    globalThis.deleting = confirmDeleteSession();
  });
  const held = await page.evaluate(async () => {
    const db = await openYutoriDb();
    const pages = await new Promise(resolve => { const request = db.transaction("pdfPages").objectStore("pdfPages").count(); request.onsuccess = () => resolve(request.result); }); db.close();
    const filesDb = await openYutoriDb();
    const files = await new Promise(resolve => { const request = filesDb.transaction("pdfFiles").objectStore("pdfFiles").count(); request.onsuccess = () => resolve(request.result); }); filesDb.close();
    return { pages, files, alerts, selected: gradingState.selectedTestId, sessions: JSON.parse(localStorage.getItem(sessionsKey())).length,
      lateStatus: document.getElementById("latePdfStatus").textContent };
  });
  assert.deepEqual(held, { pages: 0, files: 1, alerts: [], selected: "sentinel", sessions: 1, lateStatus: "sentinel" });
  const final = await page.evaluate(async () => {
    releaseCollection(); const saved = await saving; await pdfWrite; await originalWrite; await additionalWrite; await assetDeletion; await importing; await lateImporting; await deleting;
    const records = []; await YutoriBackupArchive.readArchiveStream(await backupHandle.getFile(), { onRecord: item => records.push(item) });
    return { ok: saved.ok, pageInArchive: records.some(item => item.store === "pdfPages"),
      archivedFiles: records.filter(item => item.store === "pdfFiles").length,
      archivedSessions: JSON.parse(records.find(item => item.key === sessionsKey()).value).length,
      sessions: JSON.parse(localStorage.getItem(sessionsKey())).length, alertCount: alerts.length };
  });
  assert.deepEqual(final, { ok: true, pageInArchive: false, archivedFiles: 1, archivedSessions: 1, sessions: 0, alertCount: 1 });
});

test("backup flushes scheduled grading and draft autosaves then defers later timer mutations", async () => {
  await setup();
  await page.evaluate(() => {
    gradingState.sessionId = "autosave-before";
    scheduleAutoSave(); scheduleDraftSave();
    const original = YutoriBackupStorage.createSnapshotRecordSource;
    globalThis.YutoriBackupStorage = { ...YutoriBackupStorage,
      createSnapshotRecordSource: async options => {
        globalThis.beforeSnapshot = { sessions: JSON.parse(localStorage.getItem(sessionsKey()) || "[]").length,
          draft: !!localStorage.getItem(CURRENT_DRAFT_KEY) };
        await new Promise(resolve => { globalThis.releaseAutosaveCollection = resolve; }); return original(options);
      } };
    globalThis.savingAutosave = saveYutoriBackup();
  });
  await page.waitForFunction(() => !!globalThis.releaseAutosaveCollection);
  const before = await page.evaluate(() => beforeSnapshot);
  assert.deepEqual(before, { sessions: 1, draft: true });
  await page.evaluate(() => { gradingState.sessionId = "autosave-later"; scheduleAutoSave(); });
  await page.waitForTimeout(400);
  const count = await page.evaluate(() => JSON.parse(localStorage.getItem(sessionsKey())).length);
  assert.equal(count, 1);
  const final = await page.evaluate(async () => {
    releaseAutosaveCollection(); const saved = await savingAutosave;
    await runExclusiveOperation("pdf-import", () => {});
    const records = []; await YutoriBackupArchive.readArchiveStream(await backupHandle.getFile(), { onRecord: item => records.push(item) });
    return { ok: saved.ok, archived: JSON.parse(records.find(item => item.key === sessionsKey()).value).map(item => item.id),
      after: JSON.parse(localStorage.getItem(sessionsKey())).length };
  });
  assert.deepEqual(final, { ok: true, archived: ["autosave-before"], after: 2 });
});

test("idle preparation does not create an unscheduled editor draft", async () => {
  await setup();
  const result = await page.evaluate(async () => {
    // Startup legitimately schedules a draft via updateCounts. Isolate idle
    // without a pending timer before asserting that it causes no extra save.
    clearTimeout(draftSaveTimer); draftSaveTimer = null;
    const before = localStorage.getItem(CURRENT_DRAFT_KEY);
    await waitForPersistenceIdle();
    return { before, after: localStorage.getItem(CURRENT_DRAFT_KEY) };
  });
  assert.deepEqual(result, { before: null, after: null });
});

test("exclusive gate remains held during readback verification and cancellation releases a running idle wait", async () => {
  await setup();
  await page.evaluate(() => {
    const readFile = backupHandle.getFile.bind(backupHandle);
    let reads = 0;
    backupHandle.getFile = async () => {
      if (++reads === 2) await new Promise(resolve => { globalThis.releaseVerification = resolve; });
      return readFile();
    };
    globalThis.verifyingSave = saveYutoriBackup();
  });
  await page.waitForFunction(() => !!globalThis.releaseVerification);
  const held = await page.evaluate(async () => {
    globalThis.duringVerification = false;
    globalThis.verificationImport = runExclusiveOperation("pdf-import", () => { duringVerification = true; });
    await new Promise(resolve => setTimeout(resolve, 20));
    return duringVerification;
  });
  assert.equal(held, false);
  await page.evaluate(async () => { releaseVerification(); await verifyingSave; await verificationImport; });
  await page.evaluate(() => {
    YutoriBackup.configure({ waitForIdle: () => new Promise(() => { globalThis.runningIdle = true; }) });
    globalThis.cancelledIdle = saveYutoriBackup();
  });
  await page.waitForFunction(() => !!globalThis.runningIdle);
  const released = await page.evaluate(async () => {
    YutoriBackup.cancelBackup();
    const saved = await cancelledIdle;
    return { reason: saved.reason, next: await runExclusiveOperation("restore", () => "released") };
  });
  assert.deepEqual(released, { reason: "AbortError", next: "released" });
});

test("real PDF import persists nested original and page writes before a queued backup", async () => {
  await setup();
  const result = await page.evaluate(async () => {
    // A complete, one-page PDF; PDF.js rendering and IndexedDB writes stay real.
    const objects = ["<< /Type /Catalog /Pages 2 0 R >>", "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
      "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 200] /Contents 4 0 R /Resources << >> >>",
      "<< /Length 4 >>\nstream\nq\nQ\nendstream"];
    let pdf = "%PDF-1.4\n", offsets = [0];
    objects.forEach((object, index) => { offsets.push(pdf.length); pdf += `${index + 1} 0 obj\n${object}\nendobj\n`; });
    const xref = pdf.length;
    pdf += `xref\n0 5\n0000000000 65535 f \n${offsets.slice(1).map(offset => `${String(offset).padStart(10, "0")} 00000 n \n`).join("")}trailer\n<< /Size 5 /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
    gradingState.files = [new File([pdf], "fixture.pdf", { type: "application/pdf" })];
    gradingState.testSets = [{ id: "fixture", questions: ["one"], answers: ["answer"] }];
    gradingState.rosters = { "1組": [{ no: 1, name: "Fixture" }] };
    document.getElementById("classChecks").innerHTML = '<label><input type="checkbox" checked value="1組"></label>';
    globalThis.importAlerts = []; globalThis.alert = message => importAlerts.push(message);
    const importing = processPdf();
    const saving = saveYutoriBackup();
    const outcome = await Promise.race([Promise.all([importing, saving]), new Promise(resolve => setTimeout(() => resolve(null), 5000))]);
    if (!outcome) return { timedOut: true };
    const records = []; await YutoriBackupArchive.readArchiveStream(await backupHandle.getFile(), { onRecord: item => records.push(item) });
    return { timedOut: false, ok: outcome[1].ok, alerts: importAlerts, pages: gradingState.pdfPages.length,
      files: records.filter(item => item.store === "pdfFiles").length,
      archivedPages: records.filter(item => item.store === "pdfPages").length,
      sessions: JSON.parse(records.find(item => item.key === sessionsKey()).value).length };
  });
  assert.deepEqual(result, { timedOut: false, ok: true, alerts: [], pages: 1, files: 1, archivedPages: 1, sessions: 1 });
});

test("header and touch settings expose accessible backup status and destination guidance", async () => {
  const button = page.getByRole("button", { name: "バックアップ保存", exact: true });
  assert.equal(await button.count(), 1);
  assert.match(await button.getAttribute("title"), /まだ作成/);
  await button.focus();
  assert.equal(await page.getByRole("tooltip").isVisible(), true);
  await page.evaluate(() => showBackupSettings());
  const panel = page.locator("#backupSettingsPanel");
  assert.equal(await panel.isVisible(), true);
  const text = await panel.innerText();
  for (const term of ["ファイル名", "最終保存", "容量", "個人情報", "暗号化", "Chromebook", "Google ドライブ", "USB", "学校", "同期"]) assert.ok(text.includes(term), term);
  for (const name of ["今すぐバックアップ", "保存先を変更", "バックアップから復元"]) assert.equal(await panel.getByRole("button", { name, exact: true }).count(), 1);
});

test("first save verifies actual OPFS bytes and repeat save reuses the remembered file", async () => {
  await setup();
  const result = await page.evaluate(async () => {
    const first = await saveYutoriBackup();
    const meta = await YutoriBackupStorage.getDestinationMeta();
    const file = await meta.handle.getFile();
    const records = [];
    await YutoriBackupArchive.readArchiveStream(file, { onRecord: record => records.push(record) });
    await saveYutoriBackup();
    return { first, names: pickerNames, same: await meta.handle.isSameEntry(backupHandle),
      at: meta.lastSuccessfulAt, size: meta.size, actual: file.size,
      record: records.find(record => record.key === "yutori_fixture")?.value,
      title: document.getElementById("backupSaveButton").title };
  });
  assert.equal(result.first.ok, true);
  assert.deepEqual(result.names, ["YUTORI_全データバックアップ.yutori"]);
  assert.equal(result.same, true);
  assert.equal(result.at, "2026-10-13T12:34:56.000Z");
  assert.equal(result.size, result.actual);
  assert.ok(result.size > 0);
  assert.equal(result.record, "名簿・答案");
  assert.match(result.title, /答案.yutori/);
  assert.match(result.title, /2026\/10\/13 21:34:56/);
});

test("picker is invoked synchronously before idle/snapshot work and rapid clicks share one save", async () => {
  await setup();
  const result = await page.evaluate(async () => {
    let picked = false, release, writes = 0;
    const createWritable = backupHandle.createWritable.bind(backupHandle);
    backupHandle.createWritable = () => { writes++; return createWritable(); };
    YutoriBackup.configure({ pickSaveFile: () => { picked = true; return Promise.resolve(backupHandle); }, waitForIdle: () => new Promise(resolve => { release = resolve; }) });
    const first = YutoriBackup.savePrimaryBackup();
    const synchronous = picked;
    const second = YutoriBackup.savePrimaryBackup();
    await new Promise(resolve => setTimeout(resolve, 20));
    const phase = YutoriBackup.getOperationState().phase;
    release();
    return { synchronous, shared: first === second, phase, success: (await first).ok, writes };
  });
  assert.deepEqual(result, { synchronous: true, shared: true, phase: "準備", success: true, writes: 1 });
});

test("remembered handle requests permission synchronously before idle work", async () => {
  await setup();
  await page.evaluate(() => saveYutoriBackup());
  const result = await page.evaluate(async () => {
    const real = backupHandle;
    let requested = false, idleSawRequest = false;
    // Permission UI cannot be driven in headless Chromium; keep actual file IO real.
    const adapter = { name: real.name, queryPermission: async () => "prompt", requestPermission: () => { requested = true; return Promise.resolve("granted"); }, getFile: () => real.getFile(), createWritable: () => real.createWritable() };
    const original = YutoriBackupStorage.getDestinationMeta;
    globalThis.YutoriBackupStorage = { ...YutoriBackupStorage, getDestinationMeta: async () => ({ ...(await original()), handle: adapter }), saveDestinationMeta: async meta => meta };
    await YutoriBackup.initialize();
    YutoriBackup.configure({ waitForIdle: async () => { idleSawRequest = requested; } });
    const saving = YutoriBackup.savePrimaryBackup();
    const synchronous = requested;
    return { synchronous, idleSawRequest: (await saving).ok && idleSawRequest };
  });
  assert.deepEqual(result, { synchronous: true, idleSawRequest: true });
});

for (const branch of ["denied", "missing", "write", "corrupt"]) {
  test(`${branch} destination failure preserves successful metadata and never downloads`, async () => {
    await setup();
    await page.evaluate(() => saveYutoriBackup());
    const result = await page.evaluate(async branch => {
      const previous = await YutoriBackupStorage.getLastBackupMeta();
      const title = document.getElementById("backupSaveButton").title;
      const real = backupHandle;
      const adapter = { name: "C:\\private\\答案.yutori", requestPermission: async () => branch === "denied" ? "denied" : "granted",
        getFile: () => branch === "missing" ? Promise.reject(new DOMException("gone", "NotFoundError")) : branch === "corrupt" ? Promise.resolve(new File(["broken"], "答案.yutori")) : real.getFile(),
        createWritable: () => branch === "write" ? Promise.reject(new DOMException("gone", "NotFoundError")) : real.createWritable() };
      const original = YutoriBackupStorage.getDestinationMeta;
      globalThis.YutoriBackupStorage = { ...YutoriBackupStorage, getDestinationMeta: async () => ({ ...(await original()), handle: adapter }) };
      await YutoriBackup.initialize();
      const saved = await saveYutoriBackup();
      return { saved, previous, after: await YutoriBackupStorage.getLastBackupMeta(), unchanged: title === document.getElementById("backupSaveButton").title,
        message: document.getElementById("backupMessage").textContent, downloads: downloads.length };
    }, branch);
    assert.equal(result.saved.ok, false);
    assert.deepEqual(result.after, result.previous);
    assert.equal(result.unchanged, true);
    assert.equal(result.downloads, 0);
    assert.match(result.message, branch === "denied" ? /許可/ : branch === "corrupt" ? /確認/ : /再接続|選び直/);
    assert.doesNotMatch(result.message, /private/);
  });
}

test("destination change commits a new real handle only after its verified save", async () => {
  await setup();
  await page.evaluate(() => saveYutoriBackup());
  const result = await page.evaluate(async () => {
    const root = await navigator.storage.getDirectory();
    const next = await root.getFileHandle("変更先.yutori", { create: true });
    let release;
    YutoriBackup.configure({ pickSaveFile: () => Promise.resolve(next), waitForIdle: () => new Promise(resolve => { release = resolve; }) });
    const saving = changeYutoriBackupDestination();
    await new Promise(resolve => setTimeout(resolve, 20));
    const kept = await (await YutoriBackupStorage.getDestinationMeta()).handle.isSameEntry(backupHandle);
    release(); await saving;
    const changed = await (await YutoriBackupStorage.getDestinationMeta()).handle.isSameEntry(next);
    return { kept, changed };
  });
  assert.deepEqual(result, { kept: true, changed: true });
});

test("unsupported picker downloads exactly once per click without a remembered destination", async () => {
  await setup();
  const result = await page.evaluate(async () => {
    YutoriBackup.configure({ pickSaveFile: null });
    await saveYutoriBackup(); await saveYutoriBackup();
    const meta = await YutoriBackupStorage.getDestinationMeta();
    return { downloads, handle: !!meta?.handle, title: document.getElementById("backupSaveButton").title, message: document.getElementById("backupMessage").textContent };
  });
  assert.equal(result.downloads.length, 2);
  assert.equal(result.handle, false);
  assert.ok(result.downloads.every(item => item.name.endsWith(".yutori") && item.size > 0));
  assert.match(result.title, /ダウンロード/);
  assert.match(result.message, /毎回|上書き/);
});

test("four progress phases report items and bytes and low-level writer is reusable", async () => {
  await setup();
  const result = await page.evaluate(async () => {
    const phases = [];
    document.addEventListener("yutori-backup-progress", event => phases.push(event.detail));
    await saveYutoriBackup();
    const root = await navigator.storage.getDirectory();
    const handle = await root.getFileHandle("explicit.yutori", { create: true });
    const source = await YutoriBackupStorage.createSnapshotRecordSource({ appVersion: "v0.3.51" });
    const verified = await YutoriBackup.writeVerifiedArchiveToHandle(handle, source);
    return { phases, size: verified.size, actual: (await handle.getFile()).size,
      displayed: document.getElementById("backupSize").textContent, meta: await YutoriBackupStorage.getLastBackupMeta() };
  });
  assert.deepEqual([...new Set(result.phases.map(item => item.phase))], ["準備", "データ収集", "圧縮・保存", "保存内容の確認"]);
  assert.ok(result.phases.every(item => Number.isFinite(item.itemsDone) && Number.isFinite(item.bytesDone)));
  assert.ok(result.phases.some(item => item.itemsDone > 0 && item.bytesDone > 0));
  assert.equal(result.size, result.actual);
  assert.match(result.displayed, new RegExp(String(result.meta.size)));
  assert.equal(result.meta.fileName, "答案.yutori");
});

test("actual header gesture starts picker with user activation and exposes updated hover tooltip", async () => {
  await setup();
  await page.evaluate(() => {
    globalThis.gestureActive = false;
    YutoriBackup.configure({ pickSaveFile: () => { gestureActive = navigator.userActivation.isActive; return Promise.resolve(backupHandle); } });
  });
  const button = page.getByRole("button", { name: "バックアップ保存", exact: true });
  await button.click();
  await page.waitForFunction(() => !YutoriBackup.getOperationState().busy);
  assert.equal(await page.evaluate(() => gestureActive), true);
  await button.hover();
  assert.match(await page.getByRole("tooltip").innerText(), /答案.yutori/);
  assert.equal(await page.getByRole("tooltip").isVisible(), true);
});

test("cancelled new destination selection retains the old verified handle and metadata", async () => {
  await setup();
  await page.evaluate(() => saveYutoriBackup());
  const result = await page.evaluate(async () => {
    const before = await YutoriBackupStorage.getLastBackupMeta();
    YutoriBackup.configure({ pickSaveFile: () => Promise.reject(new DOMException("cancelled", "AbortError")) });
    const saved = await YutoriBackup.changeDestination();
    const meta = await YutoriBackupStorage.getDestinationMeta();
    return { ok: saved.ok, before, after: await YutoriBackupStorage.getLastBackupMeta(), same: await meta.handle.isSameEntry(backupHandle), downloads: downloads.length };
  });
  assert.equal(result.ok, false);
  assert.deepEqual(result.before, result.after);
  assert.equal(result.same, true);
  assert.equal(result.downloads, 0);
});

test("failure after partial streamed write aborts without replacing remembered destination", async () => {
  await setup();
  await page.evaluate(() => saveYutoriBackup());
  const result = await page.evaluate(async () => {
    const before = await YutoriBackupStorage.getLastBackupMeta();
    const root = await navigator.storage.getDirectory();
    const next = await root.getFileHandle("failed-new.yutori", { create: true });
    globalThis.aborted = false;
    const broken = { name: next.name, getFile: () => next.getFile(), createWritable: async () => {
      const stream = await next.createWritable();
      const writer = stream.getWriter();
      return new WritableStream({
        async write(bytes) { await writer.write(bytes); await writer.abort(); aborted = true; throw new DOMException("disconnected", "NotFoundError"); },
      });
    } };
    YutoriBackup.configure({ pickSaveFile: () => Promise.resolve(broken) });
    const saved = await YutoriBackup.changeDestination();
    const meta = await YutoriBackupStorage.getDestinationMeta();
    return { ok: saved.ok, aborted, before, after: await YutoriBackupStorage.getLastBackupMeta(), same: await meta.handle.isSameEntry(backupHandle), downloads: downloads.length };
  });
  assert.equal(result.ok, false);
  assert.equal(result.aborted, true);
  assert.deepEqual(result.before, result.after);
  assert.equal(result.same, true);
  assert.equal(result.downloads, 0);
});

test("verified writer rejects a valid but stale archive returned after close", async () => {
  await setup();
  const result = await page.evaluate(async () => {
    await saveYutoriBackup();
    const prior = await backupHandle.getFile();
    const old = new File([await prior.arrayBuffer()], prior.name);
    localStorage.setItem("yutori_added", "new data");
    const source = await YutoriBackupStorage.createSnapshotRecordSource({ appVersion: "v0.3.51" });
    const adapter = { name: backupHandle.name, createWritable: () => backupHandle.createWritable(), getFile: () => Promise.resolve(old) };
    try { await YutoriBackup.writeVerifiedArchiveToHandle(adapter, source); return "accepted"; }
    catch (error) { return error.name; }
  });
  assert.equal(result, "BackupVerificationError");
});

test("cancel control disables before opening the writable file stream", async () => {
  await setup();
  const result = await page.evaluate(async () => {
    let release;
    const adapter = { name: backupHandle.name, getFile: () => backupHandle.getFile(),
      createWritable: () => new Promise(resolve => { release = async () => resolve(await backupHandle.createWritable()); }) };
    const original = YutoriBackupStorage.saveDestinationMeta;
    globalThis.YutoriBackupStorage = { ...YutoriBackupStorage, saveDestinationMeta: meta => original({ ...meta, handle: backupHandle }) };
    YutoriBackup.configure({ pickSaveFile: () => Promise.resolve(adapter) });
    const saving = YutoriBackup.savePrimaryBackup();
    while (!release) await new Promise(resolve => setTimeout(resolve, 5));
    const disabled = document.getElementById("backupCancelButton").disabled;
    release(); await saving;
    return disabled;
  });
  assert.equal(result, true);
});

test("status strips local directories and exposes only filename, timestamp and size", async () => {
  await setup();
  const result = await page.evaluate(async () => {
    await YutoriBackupStorage.saveDestinationMeta({ handle: backupHandle, fileName: "C:\\school-private\\答案.yutori", lastSuccessfulAt: "2026-10-13T12:34:56Z", size: 1234 });
    await YutoriBackup.initialize();
    return { title: document.getElementById("backupSaveButton").title, tooltip: document.getElementById("backupTooltip").textContent, name: document.getElementById("backupFileName").textContent };
  });
  for (const text of Object.values(result)) { assert.doesNotMatch(text, /school-private|C:/); assert.match(text, /答案.yutori/); }
});

for (const phase of ["idle", "collection"]) {
  for (const lateOutcome of ["resolve", "reject"]) {
    test(`cancel promptly settles unresolved ${phase} and ignores late ${lateOutcome}`, async () => {
      await setup();
      await page.evaluate(() => saveYutoriBackup());
      await page.evaluate(async ({ phase, lateOutcome }) => {
        globalThis.unhandled = [];
        addEventListener("unhandledrejection", event => unhandled.push(String(event.reason)));
        globalThis.successBefore = await YutoriBackupStorage.getLastBackupMeta();
        globalThis.titleBefore = document.getElementById("backupSaveButton").title;
        globalThis.writesAfterCancel = 0;
        globalThis.metaUpdatesAfterCancel = 0;
        globalThis.blockedStarted = false;
        globalThis.cancelSettled = false;
        const original = YutoriBackupStorage;
        const real = backupHandle;
        const handle = { name: real.name, requestPermission: () => real.requestPermission({ mode: "readwrite" }),
          getFile: () => real.getFile(), createWritable: () => { writesAfterCancel++; return real.createWritable(); } };
        const blocked = () => new Promise((resolve, reject) => {
          blockedStarted = true;
          globalThis.releaseBlocked = async () => {
            if (lateOutcome === "reject") reject(new Error("late abandoned hook failure"));
            else resolve(phase === "collection" ? await original.createSnapshotRecordSource({ appVersion: "v0.3.51" }) : undefined);
          };
        });
        globalThis.YutoriBackupStorage = { ...original,
          getDestinationMeta: async () => ({ ...(await original.getDestinationMeta()), handle }),
          saveDestinationMeta: meta => { metaUpdatesAfterCancel++; return original.saveDestinationMeta(meta); },
          createSnapshotRecordSource: phase === "collection" ? blocked : original.createSnapshotRecordSource,
        };
        YutoriBackup.configure({ waitForIdle: phase === "idle" ? blocked : async () => {} });
        await YutoriBackup.initialize();
        globalThis.cancellingSave = saveYutoriBackup().then(result => { cancelSettled = true; globalThis.cancelResult = result; return result; });
      }, { phase, lateOutcome });
      await page.waitForFunction(() => blockedStarted);
      assert.equal(await page.locator("#backupCancelButton").isEnabled(), true);
      await page.locator("#backupCancelButton").click();
      const prompt = await page.evaluate(async () => {
        await Promise.race([cancellingSave, new Promise(resolve => setTimeout(resolve, 250))]);
        return { settled: cancelSettled, busy: YutoriBackup.getOperationState().busy, open: document.getElementById("backupProgressDialog").open,
          canCancel: YutoriBackup.getOperationState().canCancel, reason: globalThis.cancelResult?.reason };
      });
      assert.deepEqual(prompt, { settled: true, busy: false, open: false, canCancel: false, reason: "AbortError" });
      const late = await page.evaluate(async () => {
        await releaseBlocked();
        await new Promise(resolve => setTimeout(resolve, 50));
        return { writes: writesAfterCancel, metadataWrites: metaUpdatesAfterCancel, downloads: downloads.length, pickerCount: pickerNames.length,
          before: successBefore, after: await YutoriBackupStorage.getLastBackupMeta(), titleSame: titleBefore === document.getElementById("backupSaveButton").title,
          unhandled, message: document.getElementById("backupMessage").textContent, busy: YutoriBackup.getOperationState().busy };
      });
      assert.equal(late.writes, 0);
      assert.equal(late.metadataWrites, 0);
      assert.equal(late.downloads, 0);
      assert.equal(late.pickerCount, 1);
      assert.deepEqual(late.after, late.before);
      assert.equal(late.titleSame, true);
      assert.deepEqual(late.unhandled, []);
      assert.match(late.message, /キャンセル/);
      assert.equal(late.busy, false);
    });
  }
}

test("late cancelled collection cannot change a newer save or its rapid-call promise", async () => {
  await setup();
  await page.evaluate(async () => {
    globalThis.originalStorage = YutoriBackupStorage;
    globalThis.oldCollectionStarted = false;
    globalThis.YutoriBackupStorage = { ...originalStorage,
      createSnapshotRecordSource: () => new Promise(resolve => {
        oldCollectionStarted = true;
        globalThis.releaseOldCollection = async () => resolve(await originalStorage.createSnapshotRecordSource({ appVersion: "v0.3.51" }));
      }),
    };
    globalThis.oldSaving = saveYutoriBackup();
  });
  await page.waitForFunction(() => oldCollectionStarted);
  await page.locator("#backupCancelButton").click();
  await page.waitForFunction(() => !YutoriBackup.getOperationState().busy, { timeout: 1000 });
  const during = await page.evaluate(async () => {
    globalThis.YutoriBackupStorage = originalStorage;
    globalThis.newIdleStarted = false;
    YutoriBackup.configure({ waitForIdle: () => new Promise(resolve => { newIdleStarted = true; globalThis.releaseNewIdle = resolve; }) });
    globalThis.newSaving = saveYutoriBackup();
    const shared = saveYutoriBackup() === newSaving;
    while (!newIdleStarted) await new Promise(resolve => setTimeout(resolve, 5));
    await releaseOldCollection();
    await new Promise(resolve => setTimeout(resolve, 50));
    return { shared, busy: YutoriBackup.getOperationState().busy, phase: YutoriBackup.getOperationState().phase,
      open: document.getElementById("backupProgressDialog").open, priorReason: (await oldSaving).reason,
      meta: await YutoriBackupStorage.getDestinationMeta(), downloads: downloads.length };
  });
  assert.equal(during.shared, true);
  assert.equal(during.busy, true);
  assert.equal(during.phase, "準備");
  assert.equal(during.open, true);
  assert.equal(during.priorReason, "AbortError");
  assert.equal(during.meta, null);
  assert.equal(during.downloads, 0);
  const final = await page.evaluate(async () => { releaseNewIdle(); return (await newSaving).ok; });
  assert.equal(final, true);
});
