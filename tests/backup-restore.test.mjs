import assert from "node:assert/strict";
import test, { before, beforeEach, afterEach, after } from "node:test";
import { createYutoriBrowser } from "./helpers/yutori-browser.mjs";

let harness, page, errors;
before(async () => { harness = await createYutoriBrowser(); });
beforeEach(async () => {
  page = await harness.freshPage({ pathname: "/", timezoneId: "Asia/Tokyo" });
  errors = []; page.on("pageerror", error => errors.push(error.message));
  await page.evaluate(async () => {
    clearTimeout(draftSaveTimer); draftSaveTimer = null;
    globalThis.fixtureManifest = () => ({ formatVersion: 1, createdAt: "2026-10-01T01:02:03Z", appVersion: "v0.3.40",
      counts: { localStorage: 4, indexedDB: 2 }, localStorageKeys: ["yutori_saved_tests_v1", "yutori_rosters", "yutori_grading_sessions_v023", "yutori_secret"],
      indexedDB: { name: "YUTORI_DB", version: 2, stores: ["pdfFiles", "pdfPages"].map(name => ({ name, keyPath: "id", autoIncrement: false, indexes: [], count: 1 })) } });
    globalThis.fixtureRecords = () => [
      ...[["yutori_saved_tests_v1", '[{"id":1},{"id":2}]'], ["yutori_rosters", '{"一組":[],"二組":[]}'], ["yutori_grading_sessions_v023", '[{"id":"session"}]'], ["yutori_secret", "PRIVATE_CANDIDATE"]].map(([key, value]) => ({ type: "localStorage", source: "localStorage", key, value })),
      ...["pdfFiles", "pdfPages"].map(store => ({ type: "indexedDB", source: "indexedDB", store, key: "p1", value: { id: "p1", blob: new Blob([store]) } })),
    ];
    globalThis.archiveFile = async (manifest = fixtureManifest(), records = fixtureRecords()) => new File([await new Response(YutoriBackupArchive.createArchiveStream(manifest, records)).blob()], "source.yutori");
    globalThis.repackFrames = async (file, mutate) => {
      const frames = (await new Response(file.stream().pipeThrough(new DecompressionStream("gzip"))).text()).trim().split("\n").map(JSON.parse);
      await mutate(frames);
      return new File([await new Response(new Blob([frames.map(f => JSON.stringify(f) + "\n").join("")]).stream().pipeThrough(new CompressionStream("gzip"))).blob()], "source.yutori");
    };
    globalThis.sourceFile = await archiveFile();
    const root = await navigator.storage.getDirectory();
    globalThis.safetyHandle = await root.getFileHandle("safety.yutori", { create: true });
    globalThis.downloads = []; globalThis.pickerNames = [];
    localStorage.setItem("yutori_live", "CURRENT_PRIVATE"); localStorage.setItem("mitori_fixture", "foreign");
    YutoriBackup.configure({ now: () => new Date("2026-10-13T12:34:56Z"), pickSaveFile: settings => { pickerNames.push(settings.suggestedName); return Promise.resolve(safetyHandle); }, downloadBlob: (blob, name) => { downloads.push({ blob, name }); } });
    await YutoriBackup.initialize();
  });
});
afterEach(async () => { await page?.context().close(); assert.deepEqual(errors, []); });
after(async () => { await harness?.close(); });

test("inspection streams once into an inactive stage and renders only verified summary", async () => {
  assert.equal(await page.evaluate(() => typeof YutoriBackup.inspectRestoreFile), "function");
  const result = await page.evaluate(async () => {
    let passes = 0, records = 0, finalizeAt = -1, validated = false;
    const reader = YutoriBackupArchive.readArchiveStream, writer = YutoriBackupStorage.createStageWriter;
    globalThis.YutoriBackupArchive = { ...YutoriBackupArchive, async readArchiveStream(...args) { passes++; const result = await reader(...args); validated = true; return result; } };
    globalThis.YutoriBackupStorage = { ...YutoriBackupStorage, async createStageWriter(manifest) { const stage = await writer(manifest); return { ...stage,
      async onRecord(record) { records++; return stage.onRecord(record); }, finalize() { finalizeAt = validated ? records : -1; return stage.finalize(); } }; } };
    const candidate = await YutoriBackup.inspectRestoreFile(sourceFile);
    const db = await new Promise((resolve, reject) => { const r = indexedDB.open(candidate.stageDbName); r.onsuccess = () => resolve(r.result); r.onerror = () => reject(r.error); });
    const files = await new Promise(resolve => { const r = db.transaction("pdfFiles").objectStore("pdfFiles").get("p1"); r.onsuccess = () => resolve(r.result); }); db.close();
    return { passes, finalizeAt, summary: candidate.summary, time: candidate.manifest.createdAt, version: candidate.manifest.appVersion, size: candidate.size === sourceFile.size,
      blob: await files.blob.text(), live: localStorage.getItem("yutori_live"), active: await YutoriBackupStorage.getActiveDataDbDescriptor(),
      privateVisible: document.getElementById("restoreDialog").textContent.includes("PRIVATE_CANDIDATE"), canReplace: YutoriBackup.getRestoreUiState().canReplace };
  });
  assert.deepEqual(result, { passes: 1, finalizeAt: 6, summary: { counts: { localStorage: 4, indexedDB: 2 }, tests: 2, classes: 2, gradingSessions: 1, pdfFiles: 1, pdfPages: 1 }, time: "2026-10-01T01:02:03Z", version: "v0.3.40", size: true, blob: "pdfFiles", live: "CURRENT_PRIVATE", active: { name: "YUTORI_DB", version: 2 }, privateVisible: false, canReplace: false });
  await assert.doesNotReject(page.getByRole("dialog", { name: "バックアップから復元" }).waitFor());
  assert.match(await page.locator("#restoreSummary").innerText(), /v0\.3\.40/);
});

test("inspection rejects corruption, truncation, future formats, duplicates and schema collisions without live changes", async () => {
  assert.equal(await page.evaluate(() => typeof YutoriBackup.inspectRestoreFile), "function");
  const result = await page.evaluate(async () => {
    const corrupt = await repackFrames(sourceFile, frames => { frames.at(-1).archiveHash = "0".repeat(64); });
    const truncated = new File([sourceFile.slice(0, sourceFile.size - 12)], "source.yutori");
    const unsupported = await repackFrames(sourceFile, frames => { frames[0].formatVersion = 999; });
    const duplicateLocal = await repackFrames(sourceFile, frames => { frames.splice(2, 0, frames[1]); });
    const duplicateDb = await repackFrames(sourceFile, frames => { const index = frames.map((frame, index) => frame.type === "record" ? index : -1).filter(index => index >= 0)[4]; frames.splice(index, 0, frames[index]); });
    const schema = fixtureManifest(); schema.indexedDB.stores[1].name = "pdfFiles";
    const collision = await archiveFile(schema);
    const rejected = [];
    for (const file of [corrupt, truncated, unsupported, duplicateLocal, duplicateDb, collision]) {
      try { await YutoriBackup.inspectRestoreFile(file); rejected.push(false); } catch { rejected.push(true); }
    }
    return { rejected, stages: (await indexedDB.databases()).filter(db => db.name.startsWith("YUTORI_RESTORE_STAGE_")).length,
      live: localStorage.getItem("yutori_live"), foreign: localStorage.getItem("mitori_fixture"), active: await YutoriBackupStorage.getActiveDataDbDescriptor(), canReplace: YutoriBackup.getRestoreUiState().canReplace };
  });
  assert.deepEqual(result, { rejected: Array(6).fill(true), stages: 0, live: "CURRENT_PRIVATE", foreign: "foreign", active: { name: "YUTORI_DB", version: 2 }, canReplace: false });
});

test("inspection quota failure deletes only incomplete stage", async () => {
  assert.equal(await page.evaluate(() => typeof YutoriBackup.inspectRestoreFile), "function");
  const result = await page.evaluate(async () => {
    const api = YutoriBackupStorage, preserved = await api.createStageFromArchive({ manifest: fixtureManifest(), records: fixtureRecords() });
    const add = IDBObjectStore.prototype.add; IDBObjectStore.prototype.add = function () { throw new DOMException("PRIVATE_QUOTA_DETAIL", "QuotaExceededError"); };
    let name;
    try { await YutoriBackup.inspectRestoreFile(sourceFile); } catch (error) { name = error.name; } finally { IDBObjectStore.prototype.add = add; }
    return { name, stages: (await indexedDB.databases()).filter(db => db.name.startsWith("YUTORI_RESTORE_STAGE_")).map(db => db.name), kept: preserved.stageDbName,
      live: localStorage.getItem("yutori_live"), raw: document.getElementById("restoreMessage").textContent.includes("PRIVATE_QUOTA_DETAIL") };
  });
  assert.equal(result.name, "QuotaExceededError"); assert.deepEqual(result.stages, [result.kept]); assert.equal(result.live, "CURRENT_PRIVATE"); assert.equal(result.raw, false);
});

test("verified safety export snapshots current data, holds gate and requires explicit confirmation", async () => {
  assert.equal(await page.evaluate(() => typeof YutoriBackup.saveSafetyBackup), "function");
  const result = await page.evaluate(async () => {
    globalThis.candidate = await YutoriBackup.inspectRestoreFile(sourceFile);
    const meta = { fileName: "primary.yutori", size: 77, lastSuccessfulAt: "before" }; await YutoriBackupStorage.saveDestinationMeta(meta);
    const saved = await YutoriBackup.saveSafetyBackup(candidate);
    const records = []; await YutoriBackupArchive.readArchiveStream(await safetyHandle.getFile(), { onRecord: item => records.push(item) });
    const before = YutoriBackup.getRestoreUiState().canReplace;
    YutoriBackup.setRestoreConfirmation(true);
    globalThis.mutationStarted = false; globalThis.queuedMutation = runPersistenceOperation(() => { mutationStarted = true; localStorage.setItem("yutori_late", "late"); }, "late-autosave");
    await new Promise(resolve => setTimeout(resolve, 20));
    return { before, after: YutoriBackup.getRestoreUiState().canReplace, liveArchived: records.find(r => r.key === "yutori_live")?.value, candidateArchived: records.some(r => r.key === "yutori_secret"),
      saved: { fileName: saved.fileName, verifiedAt: saved.verifiedAt, hash: /^[a-f0-9]{64}$/.test(saved.manifestHash) }, picker: pickerNames, meta: await YutoriBackupStorage.getDestinationMeta(), mutationStarted, replacementDisabled: document.getElementById("restoreReplaceButton").disabled };
  });
  assert.deepEqual(result, { before: false, after: true, liveArchived: "CURRENT_PRIVATE", candidateArchived: false,
    saved: { fileName: "safety.yutori", verifiedAt: "2026-10-13T12:34:56.000Z", hash: true }, picker: ["YUTORI_復元前バックアップ_20261013_2134.yutori"], meta: { fileName: "primary.yutori", size: 77, lastSuccessfulAt: "before" }, mutationStarted: false, replacementDisabled: true });
  await page.locator("#restoreConfirm").uncheck();
  assert.equal(await page.evaluate(() => YutoriBackup.getRestoreUiState().canReplace), false);
  const cancelled = await page.evaluate(async () => { await YutoriBackup.cancelRestore(); await queuedMutation; return { phase: YutoriBackup.getRestoreUiState().phase, live: localStorage.getItem("yutori_live"), foreign: localStorage.getItem("mitori_fixture"), stages: (await indexedDB.databases()).filter(db => db.name.startsWith("YUTORI_RESTORE_STAGE_")).length }; });
  assert.deepEqual(cancelled, { phase: "closed", live: "CURRENT_PRIVATE", foreign: "foreign", stages: 0 });
});

test("cancelled, corrupt readback and same-source safety exports cannot unlock replacement", async () => {
  assert.equal(await page.evaluate(() => typeof YutoriBackup.saveSafetyBackup), "function");
  const result = await page.evaluate(async () => {
    const results = [];
    globalThis.candidate = await YutoriBackup.inspectRestoreFile(sourceFile);
    YutoriBackup.setRestoreConfirmation(true);
    for (const picker of [() => Promise.reject(new DOMException("PRIVATE_PATH", "AbortError")), () => Promise.resolve({ name: "bad.yutori", createWritable: () => safetyHandle.createWritable(), getFile: () => Promise.resolve(new File(["corrupt"], "bad.yutori")) })]) {
      YutoriBackup.configure({ pickSaveFile: picker });
      try { await YutoriBackup.saveSafetyBackup(candidate); } catch {}
      results.push(YutoriBackup.getRestoreUiState().canReplace);
    }
    await YutoriBackup.cancelRestore();
    const writable = await safetyHandle.createWritable(); await writable.write(sourceFile); await writable.close();
    const aliasHandle = await (await navigator.storage.getDirectory()).getFileHandle("safety.yutori");
    YutoriBackup.configure({ pickOpenFile: () => Promise.resolve([safetyHandle]), pickSaveFile: () => Promise.resolve(aliasHandle) });
    await YutoriBackup.selectRestoreFile();
    try { await YutoriBackup.saveSafetyBackup(YutoriBackup.getRestoreUiState().candidate); } catch (error) { results.push(error.name); }
    const file = await safetyHandle.getFile();
    return { results, unchanged: file.size === sourceFile.size, raw: document.getElementById("restoreMessage").textContent.includes("PRIVATE_PATH") };
  });
  assert.deepEqual(result, { results: [false, false, "InvalidStateError"], unchanged: true, raw: false });
});

test("unsupported file input requires reselected exact downloaded safety archive before confirmation counts", async () => {
  assert.equal(await page.evaluate(() => typeof YutoriBackup.verifyDownloadedSafetyFile), "function");
  await page.evaluate(() => { YutoriBackup.configure({ pickOpenFile: null, pickSaveFile: null }); showBackupSettings(); });
  const buffer = await page.evaluate(async () => [...new Uint8Array(await sourceFile.arrayBuffer())]);
  await page.getByRole("button", { name: "バックアップから復元", exact: true }).click();
  await page.locator("#restoreSourceInput").setInputFiles({ name: "source.yutori", mimeType: "application/octet-stream", buffer: Buffer.from(buffer) });
  await page.waitForFunction(() => !!YutoriBackup.getRestoreUiState().candidate);
  const pending = await page.evaluate(async () => {
    const result = await YutoriBackup.saveSafetyBackup(YutoriBackup.getRestoreUiState().candidate);
    YutoriBackup.setRestoreConfirmation(true);
    return { requiresReselection: result.requiresReselection, canReplace: YutoriBackup.getRestoreUiState().canReplace, proof: YutoriBackup.getRestoreUiState().safetyBackup, downloads: downloads.length, name: downloads[0]?.name };
  });
  assert.deepEqual(pending, { requiresReselection: true, canReplace: false, proof: null, downloads: 1, name: "YUTORI_復元前バックアップ_20261013_2134.yutori" });
  const wrong = await page.evaluate(async () => {
    try { await YutoriBackup.verifyDownloadedSafetyFile(new File([sourceFile], downloads[0].name)); } catch {}
    return YutoriBackup.getRestoreUiState().canReplace;
  });
  assert.equal(wrong, false);
  const downloaded = await page.evaluate(async () => [...new Uint8Array(await downloads[0].blob.arrayBuffer())]);
  await page.locator("#restoreSafetyInput").setInputFiles({ name: pending.name, mimeType: "application/octet-stream", buffer: Buffer.from(downloaded) });
  await page.waitForFunction(() => !!YutoriBackup.getRestoreUiState().safetyBackup);
  await page.locator("#restoreConfirm").check();
  assert.equal(await page.evaluate(() => YutoriBackup.getRestoreUiState().canReplace), true);
});

test("Task 6 continuation reuses held restore owner and stale autosaves stay queued until session ends", async () => {
  assert.equal(await page.evaluate(() => typeof YutoriBackup.withRestoreSession), "function");
  const result = await page.evaluate(async () => {
    const candidate = await YutoriBackup.inspectRestoreFile(sourceFile), safety = await YutoriBackup.saveSafetyBackup(candidate);
    YutoriBackup.setRestoreConfirmation(true);
    let staleWritten = false;
    const deferred = runPersistenceOperation(() => { staleWritten = true; }, "old-state-autosave");
    const entered = await YutoriBackup.withRestoreSession(candidate, safety, async owner => {
      const nested = await runPersistenceOperation(() => 42, "task-6-owned-write", owner);
      return { nested, staleWritten };
    });
    await deferred;
    const canReplace = YutoriBackup.getRestoreUiState().canReplace, cancelled = await YutoriBackup.cancelRestore();
    return { entered, after: staleWritten, canReplace, cancelled };
  });
  assert.deepEqual(result, { entered: { nested: 42, staleWritten: false }, after: true, canReplace: false, cancelled: true });
});

test("inspection cancel settles promptly during late stage creation and never revives a newer candidate", async () => {
  await page.evaluate(() => {
    const create = YutoriBackupStorage.createStageWriter;
    globalThis.originalRestoreStorage = YutoriBackupStorage;
    globalThis.YutoriBackupStorage = { ...YutoriBackupStorage, createStageWriter: async manifest => {
      await new Promise(resolve => { globalThis.releaseStageCreation = resolve; }); return create(manifest);
    } };
    globalThis.inspecting = YutoriBackup.inspectRestoreFile(sourceFile).catch(error => error.name);
  });
  await page.waitForFunction(() => !!globalThis.releaseStageCreation);
  const cancelled = await page.evaluate(async () => {
    const result = await Promise.race([YutoriBackup.cancelRestore(), new Promise(resolve => setTimeout(() => resolve("timeout"), 250))]);
    return { result, phase: YutoriBackup.getRestoreUiState().phase, open: document.getElementById("restoreDialog").open };
  });
  assert.deepEqual(cancelled, { result: true, phase: "closed", open: false });
  const late = await page.evaluate(async () => {
    globalThis.YutoriBackupStorage = originalRestoreStorage;
    const next = await YutoriBackup.inspectRestoreFile(sourceFile);
    releaseStageCreation(); await inspecting; await new Promise(resolve => setTimeout(resolve, 30));
    return { phase: YutoriBackup.getRestoreUiState().phase, same: YutoriBackup.getRestoreUiState().candidate === next,
      stages: (await indexedDB.databases()).filter(db => db.name.startsWith("YUTORI_RESTORE_STAGE_")).map(db => db.name), next: next.stageDbName };
  });
  assert.equal(late.phase, "inspected"); assert.equal(late.same, true); assert.deepEqual(late.stages, [late.next]);
});

test("source picker rapid clicks share one selection and cancellation ignores late picker fulfillment", async () => {
  const result = await page.evaluate(async () => {
    let picks = 0; const resolvers = [];
    YutoriBackup.configure({ pickOpenFile: () => { picks++; return new Promise(resolve => { resolvers.push(resolve); }); } });
    const first = YutoriBackup.selectRestoreFile(), second = YutoriBackup.selectRestoreFile();
    const same = first === second;
    const cancelled = await YutoriBackup.cancelRestore();
    for (const resolve of resolvers) resolve([{ getFile: () => Promise.resolve(sourceFile) }]);
    await Promise.allSettled([first, second]); await new Promise(resolve => setTimeout(resolve, 20));
    return { picks, same, cancelled, phase: YutoriBackup.getRestoreUiState().phase, stages: (await indexedDB.databases()).filter(db => db.name.startsWith("YUTORI_RESTORE_STAGE_")).length };
  });
  assert.deepEqual(result, { picks: 1, same: true, cancelled: true, phase: "closed", stages: 0 });
});

test("candidate discard refuses to delete an active stage or foreign database", async () => {
  const result = await page.evaluate(async () => {
    const candidate = await YutoriBackup.inspectRestoreFile(sourceFile);
    await YutoriBackupStorage.saveActiveDataDbDescriptor({ name: candidate.stageDbName, version: 2 });
    let activeRejected = false, foreignRejected = false;
    try { await YutoriBackup.discardRestoreCandidate(candidate); } catch { activeRejected = true; }
    try { await YutoriBackup.discardRestoreCandidate({ stageDbName: "MITORI_DB" }); } catch { foreignRejected = true; }
    return { activeRejected, foreignRejected, present: (await indexedDB.databases()).some(db => db.name === candidate.stageDbName), active: (await YutoriBackupStorage.getActiveDataDbDescriptor()).name === candidate.stageDbName };
  });
  assert.deepEqual(result, { activeRejected: true, foreignRejected: true, present: true, active: true });
});

test("restore gate precedes persistence idle and stays held across safety verification", async () => {
  await page.evaluate(async () => {
    globalThis.candidate = await YutoriBackup.inspectRestoreFile(sourceFile);
    trackPersistence(new Promise(resolve => { globalThis.finishCurrentWrite = () => { localStorage.setItem("yutori_completed", "committed"); resolve(); }; }), "current-write");
    globalThis.safetySaving = YutoriBackup.saveSafetyBackup(candidate);
    globalThis.laterStarted = false;
    globalThis.laterWrite = runPersistenceOperation(() => { laterStarted = true; localStorage.setItem("yutori_after", "queued"); }, "later-write");
  });
  await page.waitForTimeout(30);
  const waiting = await page.evaluate(async () => ({ laterStarted, bytes: (await safetyHandle.getFile()).size, canReplace: YutoriBackup.getRestoreUiState().canReplace }));
  assert.deepEqual(waiting, { laterStarted: false, bytes: 0, canReplace: false });
  const saved = await page.evaluate(async () => {
    finishCurrentWrite(); await safetySaving;
    const records = []; await YutoriBackupArchive.readArchiveStream(await safetyHandle.getFile(), { onRecord: item => records.push(item) });
    return { laterStarted, current: records.find(item => item.key === "yutori_completed")?.value, queued: records.some(item => item.key === "yutori_after") };
  });
  assert.deepEqual(saved, { laterStarted: false, current: "committed", queued: false });
  await page.evaluate(async () => { await YutoriBackup.cancelRestore(); await laterWrite; });
});

test("safety save rapid calls open one stream and cancellation disables during write", async () => {
  await page.evaluate(async () => {
    globalThis.candidate = await YutoriBackup.inspectRestoreFile(sourceFile);
    const create = safetyHandle.createWritable.bind(safetyHandle); globalThis.writes = 0;
    safetyHandle.createWritable = async () => { writes++; await new Promise(resolve => { globalThis.releaseSafetyWrite = resolve; }); return create(); };
    globalThis.firstSafety = YutoriBackup.saveSafetyBackup(candidate);
    globalThis.sharedSafety = firstSafety === YutoriBackup.saveSafetyBackup(candidate);
  });
  await page.waitForFunction(() => !!globalThis.releaseSafetyWrite);
  const held = await page.evaluate(async () => ({ writes, sharedSafety, picks: pickerNames.length, cancelDisabled: document.getElementById("restoreCancelButton").disabled, cancelled: await YutoriBackup.cancelRestore() }));
  assert.deepEqual(held, { writes: 1, sharedSafety: true, picks: 1, cancelDisabled: true, cancelled: false });
  await page.evaluate(async () => { releaseSafetyWrite(); await firstSafety; await YutoriBackup.cancelRestore(); });
});

test("safety preparation cancel releases gate promptly and ignores late snapshot completion", async () => {
  await page.evaluate(async () => {
    globalThis.candidate = await YutoriBackup.inspectRestoreFile(sourceFile);
    const snapshot = YutoriBackupStorage.createSnapshotRecordSource;
    globalThis.YutoriBackupStorage = { ...YutoriBackupStorage, createSnapshotRecordSource: async settings => {
      await new Promise(resolve => { globalThis.releaseSafetySnapshot = resolve; }); return snapshot(settings);
    } };
    globalThis.cancelledSafety = YutoriBackup.saveSafetyBackup(candidate).catch(error => error.name);
  });
  await page.waitForFunction(() => !!globalThis.releaseSafetySnapshot);
  const cancelled = await page.evaluate(async () => {
    const result = await Promise.race([YutoriBackup.cancelRestore(), new Promise(resolve => setTimeout(() => resolve("timeout"), 250))]);
    return { result, error: await cancelledSafety, next: await runExclusiveOperation("restore", () => "released") };
  });
  assert.deepEqual(cancelled, { result: true, error: "AbortError", next: "released" });
  const late = await page.evaluate(async () => { releaseSafetySnapshot(); await new Promise(resolve => setTimeout(resolve, 30)); return { bytes: (await safetyHandle.getFile()).size, phase: YutoriBackup.getRestoreUiState().phase, downloads: downloads.length, stages: (await indexedDB.databases()).filter(db => db.name.startsWith("YUTORI_RESTORE_STAGE_")).length }; });
  assert.deepEqual(late, { bytes: 0, phase: "closed", downloads: 0, stages: 0 });
});

test("unsupported safety export validates before download and rejects a failed generated archive", async () => {
  const result = await page.evaluate(async () => {
    const candidate = await YutoriBackup.inspectRestoreFile(sourceFile);
    YutoriBackup.configure({ pickSaveFile: null });
    const codec = YutoriBackupArchive;
    globalThis.YutoriBackupArchive = { ...codec, readArchiveStream: () => Promise.reject(new Error("PRIVATE_BINARY_ERROR")) };
    let rejected = false;
    try { await YutoriBackup.saveSafetyBackup(candidate); } catch { rejected = true; }
    globalThis.YutoriBackupArchive = codec;
    return { rejected, downloads: downloads.length, canReplace: YutoriBackup.getRestoreUiState().canReplace, next: await runExclusiveOperation("restore", () => "released"), raw: document.getElementById("restoreMessage").textContent.includes("PRIVATE_BINARY_ERROR") };
  });
  assert.deepEqual(result, { rejected: true, downloads: 0, canReplace: false, next: "released", raw: false });
});

test("retry success clears prior errors and summary never renders an archive-supplied path as version", async () => {
  const result = await page.evaluate(async () => {
    const manifest = fixtureManifest(); manifest.appVersion = "C:\\PRIVATE_STUDENT\\answers";
    const candidate = await YutoriBackup.inspectRestoreFile(await archiveFile(manifest));
    const pathVisible = document.getElementById("restoreSummary").textContent.includes("PRIVATE_STUDENT");
    YutoriBackup.configure({ pickSaveFile: () => Promise.reject(new DOMException("cancelled", "AbortError")) });
    try { await YutoriBackup.saveSafetyBackup(candidate); } catch {}
    YutoriBackup.configure({ pickSaveFile: () => Promise.resolve(safetyHandle) });
    await YutoriBackup.saveSafetyBackup(candidate);
    return { pathVisible, message: document.getElementById("restoreMessage").textContent };
  });
  assert.deepEqual(result, { pathVisible: false, message: "" });
});

test("restore is settings-only, opens picker in the gesture and stays keyboard usable at mobile width", async () => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.evaluate(() => {
    globalThis.restoreGesture = false;
    YutoriBackup.configure({ pickOpenFile: () => { restoreGesture = navigator.userActivation.isActive; return Promise.resolve([{ getFile: () => Promise.resolve(sourceFile) }]); } });
    showBackupSettings();
  });
  assert.equal(await page.locator("header").getByRole("button", { name: /復元/ }).count(), 0);
  await page.getByRole("button", { name: "バックアップから復元", exact: true }).click();
  await page.waitForFunction(() => YutoriBackup.getRestoreUiState().phase === "inspected");
  assert.equal(await page.evaluate(() => restoreGesture), true);
  const fit = await page.evaluate(() => { const dialog = document.getElementById("restoreDialog"); return { fits: dialog.getBoundingClientRect().width <= innerWidth - 30, overflow: dialog.scrollWidth > dialog.clientWidth }; });
  assert.deepEqual(fit, { fits: true, overflow: false });
  await page.locator("#restoreCancelButton").scrollIntoViewIfNeeded();
  assert.equal(await page.locator("#restoreCancelButton").isVisible(), true);
  await page.keyboard.press("Escape");
  await page.waitForFunction(() => YutoriBackup.getRestoreUiState().phase === "closed");
  assert.equal(await page.locator("#restoreOpenButton").evaluate(node => node === document.activeElement), true);
});

test.todo("Task 6 successful replacement retains owner through reload and discards stale pre-restore autosaves");
