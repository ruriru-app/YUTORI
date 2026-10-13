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
    saved: { fileName: "safety.yutori", verifiedAt: "2026-10-13T12:34:56.000Z", hash: true }, picker: ["YUTORI_復元前バックアップ_20261013_2134.yutori"], meta: { fileName: "primary.yutori", size: 77, lastSuccessfulAt: "before" }, mutationStarted: false, replacementDisabled: false });
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

test("successful replacement preserves foreign data and destination, reloads validated PDFs and discards stale autosaves", async () => {
  assert.equal(await page.evaluate(() => typeof YutoriBackup.replaceWithCandidate), "function");
  const result = await page.evaluate(async () => {
    localStorage.setItem("unrelated_fixture", "keep");
    await YutoriBackupStorage.saveDestinationMeta({ fileName: "primary.yutori", size: 77 });
    const candidate = await YutoriBackup.inspectRestoreFile(sourceFile), safety = await YutoriBackup.saveSafetyBackup(candidate);
    YutoriBackup.setRestoreConfirmation(true);
    let stale = false, reloads = 0;
    const queued = runPersistenceOperation(() => { stale = true; localStorage.setItem("yutori_stale", "bad"); }, "stale").catch(e => e.name);
    scheduleDraftSave(); scheduleAutoSave();
    YutoriBackup.configure({ reload: () => { reloads++; } });
    const first = YutoriBackup.replaceWithCandidate(candidate, safety);
    const second = YutoriBackup.replaceWithCandidate(candidate, safety).catch(e => e.name);
    await first; await second; await queued; await new Promise(r => setTimeout(r, 400));
    const db = await openYutoriDb();
    const pdf = await new Promise(r => { const q = db.transaction("pdfFiles").objectStore("pdfFiles").get("p1"); q.onsuccess = () => r(q.result); }); db.close();
    const journal = await YutoriBackupStorage.getRestoreJournal();
    return { stale, reloads, live: localStorage.getItem("yutori_live"), secret: localStorage.getItem("yutori_secret"), foreign: localStorage.getItem("mitori_fixture"), unrelated: localStorage.getItem("unrelated_fixture"), pdf: await pdf.blob.text(), db: db.name === candidate.stageDbName, phase: journal.phase, oldKept: (await indexedDB.databases()).some(d => d.name === "YUTORI_DB"), destination: await YutoriBackupStorage.getDestinationMeta(), keys: YutoriBackupStorage.collectLocalStorageEntries().map(e => e.key) };
  });
  assert.deepEqual(result, { stale: false, reloads: 1, live: null, secret: "PRIVATE_CANDIDATE", foreign: "foreign", unrelated: "keep", pdf: "pdfFiles", db: true, phase: "reload-pending", oldKept: true, destination: { fileName: "primary.yutori", size: 77 }, keys: ["yutori_grading_sessions_v023", "yutori_rosters", "yutori_saved_tests_v1", "yutori_secret"] });
  assert.equal(await page.locator("#restoreCancelButton").isDisabled(), true, "reload-pending cannot be cancelled");
  await page.reload();
  await page.waitForFunction(() => globalThis.yutoriAppReady === true);
  assert.deepEqual(await page.evaluate(async () => ({ journal: await YutoriBackupStorage.getRestoreJournal(), old: (await indexedDB.databases()).some(d => d.name === "YUTORI_DB"), secret: localStorage.getItem("yutori_secret") })), { journal: null, old: false, secret: "PRIVATE_CANDIDATE" });
});

for (const phase of ["staged", "local-storage-applied", "pointer-switched", "reload-pending"]) {
  test(`interrupted replacement at ${phase} recovers before application reads`, async () => {
    assert.equal(await page.evaluate(() => typeof YutoriBackupStorage.beginRestoreJournal), "function");
    await page.evaluate(async phase => {
      const candidate = await YutoriBackup.inspectRestoreFile(sourceFile), safetyBackup = await YutoriBackup.saveSafetyBackup(candidate);
      let journal = await YutoriBackupStorage.beginRestoreJournal({ candidate, safetyBackup, oldLocalStorage: YutoriBackupStorage.collectLocalStorageEntries() });
      if (phase !== "staged") { YutoriBackupStorage.applyOwnedLocalStorage(candidate.localStorageEntries); journal = await YutoriBackupStorage.setRestorePhase(journal, "local-storage-applied"); }
      if (["pointer-switched", "reload-pending"].includes(phase)) journal = await YutoriBackupStorage.switchActiveDataDb(journal.targetDescriptor, journal);
      if (phase === "reload-pending") await YutoriBackupStorage.setRestorePhase(journal, phase);
    }, phase);
    await page.addInitScript(() => { globalThis.earlyReads = []; const get = Storage.prototype.getItem; Storage.prototype.getItem = function(key) { if (!globalThis.yutoriRecoveryFinished && /readOutputShelvedSessionIds|initializeYutoriApp|readSavedTests/.test(new Error().stack)) earlyReads.push(key); return get.call(this, key); }; });
    await page.reload(); await page.waitForFunction(() => globalThis.yutoriAppReady === true);
    const result = await page.evaluate(async () => ({ live: localStorage.getItem("yutori_live"), secret: localStorage.getItem("yutori_secret"), journal: await YutoriBackupStorage.getRestoreJournal(), foreign: localStorage.getItem("mitori_fixture"), early: earlyReads }));
    assert.deepEqual(result, { live: ["staged", "local-storage-applied"].includes(phase) ? "CURRENT_PRIVATE" : null, secret: ["staged", "local-storage-applied"].includes(phase) ? null : "PRIVATE_CANDIDATE", journal: null, foreign: "foreign", early: [] });
  });
}

test("replacement localStorage quota rolls back old pointer and owned keys without losing foreign keys", async () => {
  assert.equal(await page.evaluate(() => typeof YutoriBackup.replaceWithCandidate), "function");
  const result = await page.evaluate(async () => {
    const candidate = await YutoriBackup.inspectRestoreFile(sourceFile), safety = await YutoriBackup.saveSafetyBackup(candidate);
    YutoriBackup.setRestoreConfirmation(true);
    const set = Storage.prototype.setItem; Storage.prototype.setItem = function(k,v) { if (k === "yutori_secret") throw new DOMException("quota", "QuotaExceededError"); return set.call(this,k,v); };
    let error; try { await YutoriBackup.replaceWithCandidate(candidate, safety); } catch(e) { error = e.name; } finally { Storage.prototype.setItem = set; }
    return { error, active: (await YutoriBackupStorage.getActiveDataDbDescriptor()).name, live: localStorage.getItem("yutori_live"), foreign: localStorage.getItem("mitori_fixture"), journal: await YutoriBackupStorage.getRestoreJournal(), stage: (await indexedDB.databases()).some(d => d.name === candidate.stageDbName) };
  });
  assert.deepEqual(result, { error: "QuotaExceededError", active: "YUTORI_DB", live: "CURRENT_PRIVATE", foreign: "foreign", journal: null, stage: false });
});

test("needs-safety-file blocks startup and accepts only recorded verified safety identity", async () => {
  assert.equal(await page.evaluate(() => typeof YutoriBackup.recoverFromSafetyFile), "function");
  await page.evaluate(async () => {
    const candidate = await YutoriBackup.inspectRestoreFile(sourceFile), safetyBackup = await YutoriBackup.saveSafetyBackup(candidate);
    const journal = await YutoriBackupStorage.beginRestoreJournal({ candidate, safetyBackup, oldLocalStorage: YutoriBackupStorage.collectLocalStorageEntries() });
    journal.safetyBackup.handle = null;
    await YutoriBackupStorage.commitJournal(journal);
    await YutoriBackupStorage.deleteDatabase("YUTORI_DB");
  });
  await page.reload();
  await page.getByRole("button", { name: "復元前バックアップを選んで回復" }).waitFor();
  assert.deepEqual(await page.evaluate(() => ({ ready: !!globalThis.yutoriAppReady, inert: document.body.inert })), { ready: false, inert: true });
  assert.deepEqual(await page.evaluate(async () => {
    const calls = [], originals = [syncState, renderPaper, positionFloatingPalette];
    syncState = () => calls.push("sync"); renderPaper = () => calls.push("render"); positionFloatingPalette = () => calls.push("palette");
    dispatchEvent(new Event("resize")); dispatchEvent(new Event("beforeprint")); dispatchEvent(new Event("afterprint"));
    await new Promise(r => setTimeout(r, 40));
    [syncState, renderPaper, positionFloatingPalette] = originals;
    return calls;
  }), [], "browser events must not render or collect app state during blocked recovery");
  const result = await page.evaluate(async () => {
    const handle = await (await navigator.storage.getDirectory()).getFileHandle("safety.yutori");
    const file = await handle.getFile();
    const records = []; const archive = await YutoriBackupArchive.readArchiveStream(file, { onRecord: r => records.push(r) });
    const changed = records.map(r => r.key === "yutori_live" ? { ...r, value: "wrong" } : r);
    const wrong = await new Response(YutoriBackupArchive.createArchiveStream(archive.manifest, changed)).blob();
    let rejected = false; try { await YutoriBackup.recoverFromSafetyFile(wrong); } catch { rejected = true; }
    let reloads = 0; YutoriBackup.configure({ reload: () => reloads++ });
    await YutoriBackup.recoverFromSafetyFile(file);
    return { rejected, reloads, live: localStorage.getItem("yutori_live"), foreign: localStorage.getItem("mitori_fixture"), phase: (await YutoriBackupStorage.getRestoreJournal()).phase };
  });
  assert.deepEqual(result, { rejected: true, reloads: 1, live: "CURRENT_PRIVATE", foreign: "foreign", phase: "reload-pending" });
  await page.reload(); await page.waitForFunction(() => globalThis.yutoriAppReady === true);
  assert.equal(await page.evaluate(() => YutoriBackupStorage.getRestoreJournal()), null);
});

for (const phase of ["staged", "local-storage-applied", "pointer-switched", "reload-pending"]) {
  test(`replacement failure after durable ${phase} rolls back and never reloads`, async () => {
    const result = await page.evaluate(async phase => {
      const candidate = await YutoriBackup.inspectRestoreFile(sourceFile), safety = await YutoriBackup.saveSafetyBackup(candidate);
      YutoriBackup.setRestoreConfirmation(true);
      const api = YutoriBackupStorage;
      const failAfter = async promise => { const journal = await promise; if (journal.phase === phase) throw new Error("injected"); return journal; };
      globalThis.YutoriBackupStorage = { ...api,
        beginRestoreJournal: args => failAfter(api.beginRestoreJournal(args)),
        setRestorePhase: (...args) => failAfter(api.setRestorePhase(...args)),
        switchActiveDataDb: (...args) => failAfter(api.switchActiveDataDb(...args)) };
      let reloads = 0; YutoriBackup.configure({ reload: () => reloads++ });
      let failed = false; try { await YutoriBackup.replaceWithCandidate(candidate,safety); } catch { failed = true; }
      globalThis.YutoriBackupStorage = api;
      return { failed, reloads, live: localStorage.getItem("yutori_live"), secret: localStorage.getItem("yutori_secret"), active: (await api.getActiveDataDbDescriptor()).name, journal: await api.getRestoreJournal(), message: document.getElementById("restorePhase").textContent };
    }, phase);
    assert.deepEqual(result, { failed: true, reloads: 0, live: "CURRENT_PRIVATE", secret: null, active: "YUTORI_DB", journal: null, message: "復元を中止し、復元前のデータに戻しました。" });
  });
}

test("replacement rejects changed stage bytes and changed live safety snapshot before switching", async () => {
  const result = await page.evaluate(async () => {
    const outcomes = [];
    for (const mutateStage of [true, false]) {
      const candidate = await YutoriBackup.inspectRestoreFile(sourceFile), safety = await YutoriBackup.saveSafetyBackup(candidate);
      YutoriBackup.setRestoreConfirmation(true);
      if (mutateStage) {
        const db = await new Promise(r => { const q = indexedDB.open(candidate.stageDbName); q.onsuccess = () => r(q.result); });
        await new Promise(r => { const tx = db.transaction("pdfFiles","readwrite"); tx.objectStore("pdfFiles").put({ id: "p1", blob: new Blob(["CORRUPT"]) }); tx.oncomplete = r; }); db.close();
      } else localStorage.setItem("yutori_live", "CHANGED_AFTER_SAFETY");
      let failed = false; try { await YutoriBackup.replaceWithCandidate(candidate,safety); } catch { failed = true; }
      outcomes.push({ failed, active: (await YutoriBackupStorage.getActiveDataDbDescriptor()).name, live: localStorage.getItem("yutori_live") });
      await YutoriBackup.cancelRestore();
    }
    return outcomes;
  });
  assert.deepEqual(result, [{ failed: true, active: "YUTORI_DB", live: "CURRENT_PRIVATE" }, { failed: true, active: "YUTORI_DB", live: "CHANGED_AFTER_SAFETY" }]);
});

test("post-switch byte corruption rolls back old data before normal startup", async () => {
  await page.evaluate(async () => {
    const candidate = await YutoriBackup.inspectRestoreFile(sourceFile), safetyBackup = await YutoriBackup.saveSafetyBackup(candidate);
    const journal = await YutoriBackupStorage.beginRestoreJournal({ candidate, safetyBackup, oldLocalStorage: YutoriBackupStorage.collectLocalStorageEntries() });
    YutoriBackupStorage.applyOwnedLocalStorage(candidate.localStorageEntries);
    await YutoriBackupStorage.switchActiveDataDb(journal.targetDescriptor,journal);
    const db = await openYutoriDb();
    await new Promise(r => { const tx = db.transaction("pdfPages","readwrite"); tx.objectStore("pdfPages").put({ id: "p1", blob: new Blob(["wrong"]) }); tx.oncomplete = r; }); db.close();
  });
  await page.reload(); await page.waitForFunction(() => globalThis.yutoriAppReady);
  assert.deepEqual(await page.evaluate(async () => ({ live: localStorage.getItem("yutori_live"), active: (await YutoriBackupStorage.getActiveDataDbDescriptor()).name, journal: await YutoriBackupStorage.getRestoreJournal() })), { live: "CURRENT_PRIVATE", active: "YUTORI_DB", journal: null });
});

test("replacement preserves exact PDF bytes page metadata grading and native primary destination without copying binary records", async () => {
  const result = await page.evaluate(async () => {
    const records = fixtureRecords();
    const bytes = new Uint8Array(1024 * 1024 + 7); bytes[0] = 37; bytes[1000] = 255; bytes[bytes.length-1] = 9;
    records.find(r => r.store === "pdfFiles").value = { id: "p1", name: "答案.pdf", blob: new Blob([bytes], { type: "application/pdf" }) };
    records.find(r => r.store === "pdfPages").value = { id: "p1", blob: new Blob([new Uint8Array([0,13,255,42])], { type: "image/png" }), page: 3, rotation: 90, width: 1240, height: 1754, studentNo: 12, className: "一組" };
    const grading = '[{"id":"session","grades":{"一組::12::0":"ok"},"q":3,"status":"in-progress","lastSavedAt":1791894896000}]';
    records.find(r => r.key === "yutori_grading_sessions_v023").value = grading;
    const primary = await (await navigator.storage.getDirectory()).getFileHandle("primary.yutori", { create: true });
    await YutoriBackupStorage.saveDestinationMeta({ handle: primary, fileName: "primary.yutori", size: 777, lastSuccessfulAt: "before" });
    await YutoriBackup.initialize();
    const candidate = await YutoriBackup.inspectRestoreFile(await archiveFile(fixtureManifest(), records));
    const safety = await YutoriBackup.saveSafetyBackup(candidate);
    YutoriBackup.setRestoreConfirmation(true); YutoriBackup.configure({ reload: () => {} });
    let importRan = false;
    const queued = runExclusiveOperation("pdf-import", () => { importRan = true; }).catch(e => e.name);
    const add = IDBObjectStore.prototype.add, put = IDBObjectStore.prototype.put;
    IDBObjectStore.prototype.add = function(...args) { if (["pdfFiles","pdfPages"].includes(this.name)) throw new Error("Unexpected binary copy"); return add.apply(this,args); };
    IDBObjectStore.prototype.put = function(...args) { if (["pdfFiles","pdfPages"].includes(this.name)) throw new Error("Unexpected binary copy"); return put.apply(this,args); };
    try { await YutoriBackup.replaceWithCandidate(candidate,safety); } finally { IDBObjectStore.prototype.add = add; IDBObjectStore.prototype.put = put; }
    const cancelled = await queued;
    const db = await openYutoriDb();
    const read = store => new Promise(r => { const q = db.transaction(store).objectStore(store).get("p1"); q.onsuccess = () => r(q.result); });
    const pdf = await read("pdfFiles"), page = await read("pdfPages"); db.close();
    const output = new Uint8Array(await pdf.blob.arrayBuffer()), pageBytes = [...new Uint8Array(await page.blob.arrayBuffer())]; delete page.blob;
    const destination = await YutoriBackupStorage.getDestinationMeta();
    return { exact: output.length === bytes.length && output.every((b,i) => b === bytes[i]), mime: pdf.blob.type, page, pageBytes,
      grading: localStorage.getItem("yutori_grading_sessions_v023"), importRan, cancelled, destination: { same: await destination.handle.isSameEntry(primary), size: destination.size, date: destination.lastSuccessfulAt } };
  });
  assert.deepEqual(result, { exact: true, mime: "application/pdf", page: { id: "p1", page: 3, rotation: 90, width: 1240, height: 1754, studentNo: 12, className: "一組" }, pageBytes: [0,13,255,42],
    grading: '[{"id":"session","grades":{"一組::12::0":"ok"},"q":3,"status":"in-progress","lastSavedAt":1791894896000}]', importRan: false, cancelled: "AbortError", destination: { same: true, size: 777, date: "before" } });
});

test("replacement refuses unconfirmed copied or stale proof without creating a journal", async () => {
  const result = await page.evaluate(async () => {
    const candidate = await YutoriBackup.inspectRestoreFile(sourceFile), safety = await YutoriBackup.saveSafetyBackup(candidate);
    const results = [];
    try { await YutoriBackup.replaceWithCandidate(candidate,safety); } catch(e) { results.push(e.name); }
    YutoriBackup.setRestoreConfirmation(true);
    for (const [c,s] of [[{...candidate},safety], [candidate,{...safety}]]) {
      try { await YutoriBackup.replaceWithCandidate(c,s); } catch(e) { results.push(e.name); }
    }
    await YutoriBackup.cancelRestore();
    try { await YutoriBackup.replaceWithCandidate(candidate,safety); } catch(e) { results.push(e.name); }
    return { results, journal: await YutoriBackupStorage.getRestoreJournal(), live: localStorage.getItem("yutori_live") };
  });
  assert.deepEqual(result, { results: Array(4).fill("InvalidStateError"), journal: null, live: "CURRENT_PRIVATE" });
});

test("inspection hashing failure and cancellation delete finalized inactive stages promptly", async () => {
  const result = await page.evaluate(async () => {
    const api = YutoriBackupStorage;
    globalThis.YutoriBackupStorage = { ...api, dataIdentity: async () => { throw new Error("hash IO failed"); } };
    try { await YutoriBackup.inspectRestoreFile(sourceFile); } catch {}
    const leaked = (await indexedDB.databases()).filter(d => d.name.startsWith("YUTORI_RESTORE_STAGE_")).length;
    let release, entered;
    const ready = new Promise(r => entered = r);
    globalThis.YutoriBackupStorage = { ...api, dataIdentity: async (...args) => { entered(); await new Promise(r => release = r); return api.dataIdentity(...args); } };
    const inspect = YutoriBackup.inspectRestoreFile(sourceFile).catch(e => e.name);
    await ready;
    const cancelling = YutoriBackup.cancelRestore();
    const prompt = await Promise.race([cancelling.then(() => true), new Promise(r => setTimeout(() => r(false),250))]);
    release(); await inspect; await cancelling;
    globalThis.YutoriBackupStorage = api;
    return { leaked, prompt, remaining: (await indexedDB.databases()).filter(d => d.name.startsWith("YUTORI_RESTORE_STAGE_")).length };
  });
  assert.deepEqual(result, { leaked: 0, prompt: true, remaining: 0 });
});

for (const denied of [false,true]) {
  test(`missing old database with ${denied ? "denied" : "available"} safety handle recovers truthfully`, async () => {
    await page.evaluate(async () => {
      const candidate = await YutoriBackup.inspectRestoreFile(sourceFile), safetyBackup = await YutoriBackup.saveSafetyBackup(candidate);
      const journal = await YutoriBackupStorage.beginRestoreJournal({ candidate, safetyBackup, oldLocalStorage: YutoriBackupStorage.collectLocalStorageEntries() });
      if (!await journal.safetyBackup.handle.isSameEntry(safetyHandle)) throw new Error("Handle lost");
      await YutoriBackupStorage.deleteDatabase("YUTORI_DB");
    });
    if (denied) await page.addInitScript(() => { FileSystemHandle.prototype.queryPermission = async () => "denied"; });
    await page.reload();
    if (denied) {
      await page.getByRole("button", { name: "復元前バックアップを選んで回復" }).waitFor();
      assert.equal(await page.evaluate(() => !!globalThis.yutoriAppReady), false);
    } else {
      await page.waitForFunction(() => globalThis.yutoriAppReady);
      assert.equal(await page.evaluate(() => localStorage.getItem("yutori_live")), "CURRENT_PRIVATE");
      assert.equal(await page.evaluate(() => YutoriBackupStorage.getRestoreJournal()), null);
    }
  });
}

for (const withHandle of [false, true]) {
  test(`finalization journal deletion failure keeps validated target with safety handle ${withHandle}`, async () => {
    const result = await page.evaluate(async withHandle => {
      const candidate = await YutoriBackup.inspectRestoreFile(sourceFile), safety = await YutoriBackup.saveSafetyBackup(candidate);
      YutoriBackup.setRestoreConfirmation(true); YutoriBackup.configure({ reload: () => {} });
      await YutoriBackup.replaceWithCandidate(candidate, safety);
      let journal = await YutoriBackupStorage.getRestoreJournal();
      if (!withHandle) { journal.safetyBackup.handle = null; await YutoriBackupStorage.commitJournal(journal); }
      const remove = IDBObjectStore.prototype.delete, deleteDb = IDBFactory.prototype.deleteDatabase; let failures = 0, oldGoneAtFailure, oldDeletionCompleted = false;
      IDBFactory.prototype.deleteDatabase = function(name) { const request = deleteDb.call(this,name); if (name === "YUTORI_DB") request.addEventListener("success", () => { oldDeletionCompleted = true; }); return request; };
      IDBObjectStore.prototype.delete = function(key) {
        if (this.name === "journals" && key === "restore" && failures++ === 0) {
          oldGoneAtFailure = oldDeletionCompleted; throw new DOMException("once", "QuotaExceededError");
        }
        return remove.call(this,key);
      };
      let first; try { first = await YutoriBackup.recoverInterruptedRestore(); } finally { IDBObjectStore.prototype.delete = remove; IDBFactory.prototype.deleteDatabase = deleteDb; }
      const second = await YutoriBackup.recoverInterruptedRestore();
      return { first: first.status, second: second.status, injected: oldGoneAtFailure, active: (await YutoriBackupStorage.getActiveDataDbDescriptor()).name === candidate.stageDbName,
        secret: localStorage.getItem("yutori_secret"), live: localStorage.getItem("yutori_live"), foreign: localStorage.getItem("mitori_fixture"), journal: await YutoriBackupStorage.getRestoreJournal(), oldGone: !(await indexedDB.databases()).some(d => d.name === "YUTORI_DB") };
    }, withHandle);
    assert.deepEqual(result, { first: "completed", second: "none", injected: true, active: true, secret: "PRIVATE_CANDIDATE", live: null, foreign: "foreign", journal: null, oldGone: true });
  });
}

test("persistent finalization cleanup failure blocks startup with retry guidance and preserves target", async () => {
  await page.evaluate(async () => {
    const candidate = await YutoriBackup.inspectRestoreFile(sourceFile), safety = await YutoriBackup.saveSafetyBackup(candidate);
    YutoriBackup.setRestoreConfirmation(true); YutoriBackup.configure({ reload: () => {} });
    await YutoriBackup.replaceWithCandidate(candidate,safety);
  });
  await page.addInitScript(() => {
    globalThis.restoreNativeDelete = IDBObjectStore.prototype.delete;
    IDBObjectStore.prototype.delete = function(key) { if (this.name === "journals") throw new DOMException("cleanup failed", "QuotaExceededError"); return restoreNativeDelete.call(this,key); };
  });
  await page.reload(); await page.locator("#startupRecoveryDialog").waitFor();
  const result = await page.evaluate(async () => {
    const before = { ready: !!globalThis.yutoriAppReady, inert: document.body.inert, phase: (await YutoriBackupStorage.getRestoreJournal()).phase,
      secret: localStorage.getItem("yutori_secret"), message: document.getElementById("startupRecoveryDialog").textContent };
    IDBObjectStore.prototype.delete = restoreNativeDelete;
    const retry = await YutoriBackup.recoverInterruptedRestore();
    return { before, retry: retry.status, journal: await YutoriBackupStorage.getRestoreJournal(), secret: localStorage.getItem("yutori_secret") };
  });
  assert.deepEqual(result, { before: { ready: false, inert: true, phase: "finalizing", secret: "PRIVATE_CANDIDATE", message: "復元したデータは確認済みです。後片付けを完了できませんでした。他の YUTORI タブを閉じて、画面を再読み込みしてください。" }, retry: "completed", journal: null, secret: "PRIVATE_CANDIDATE" });
});

test("blocked inactive database deletion never rolls back finalizing and retries after connection closes", async () => {
  const result = await page.evaluate(async () => {
    const candidate = await YutoriBackup.inspectRestoreFile(sourceFile), safety = await YutoriBackup.saveSafetyBackup(candidate);
    YutoriBackup.setRestoreConfirmation(true); YutoriBackup.configure({ reload: () => {} });
    await YutoriBackup.replaceWithCandidate(candidate,safety);
    const old = await new Promise(r => { const q=indexedDB.open("YUTORI_DB",2);q.onsuccess=()=>r(q.result); });
    old.onversionchange = () => {};
    const recovering = YutoriBackup.recoverInterruptedRestore().then(r => r.status, e => e.name);
    const error = await Promise.race([recovering, new Promise(r => setTimeout(() => r("stalled"), 250))]);
    const phase = (await YutoriBackupStorage.getRestoreJournal())?.phase, secret = localStorage.getItem("yutori_secret");
    const blockedRetry = await Promise.race([YutoriBackup.recoverInterruptedRestore().then(r => r.status,e => e.name),new Promise(r => setTimeout(() => r("stalled"),250))]);
    old.close();
    await recovering;
    const retry = await YutoriBackup.recoverInterruptedRestore();
    return { error, blockedRetry, phase, secret, retry: retry.status, active: (await YutoriBackupStorage.getActiveDataDbDescriptor()).name === candidate.stageDbName, journal: await YutoriBackupStorage.getRestoreJournal() };
  });
  assert.deepEqual(result, { error: "RestoreCleanupError", blockedRetry: "RestoreCleanupError", phase: "finalizing", secret: "PRIVATE_CANDIDATE", retry: "completed", active: true, journal: null });
});

test("crash immediately after finalizing commit resumes target cleanup and refuses stale rollback", async () => {
  const result = await page.evaluate(async () => {
    const candidate = await YutoriBackup.inspectRestoreFile(sourceFile), safety = await YutoriBackup.saveSafetyBackup(candidate);
    YutoriBackup.setRestoreConfirmation(true); YutoriBackup.configure({ reload: () => {} });
    await YutoriBackup.replaceWithCandidate(candidate,safety);
    const stale = await YutoriBackupStorage.getRestoreJournal();
    await YutoriBackupStorage.setRestorePhase(stale,"finalizing");
    let rejected=false; try { await YutoriBackupStorage.rollbackRestore(stale); } catch { rejected=true; }
    let staleWrites=0;
    try { await YutoriBackupStorage.setRestorePhase(stale,"rolling-back"); } catch { staleWrites++; }
    try { await YutoriBackupStorage.commitJournal({...stale,phase:"finalizing"},stale.oldDescriptor); } catch { staleWrites++; }
    return { rejected, staleWrites, phase: (await YutoriBackupStorage.getRestoreJournal())?.phase, secret: localStorage.getItem("yutori_secret") };
  });
  assert.deepEqual(result, { rejected: true, staleWrites:2, phase: "finalizing", secret: "PRIVATE_CANDIDATE" });
  await page.reload(); await page.waitForFunction(() => globalThis.yutoriAppReady);
  assert.deepEqual(await page.evaluate(async () => ({ secret:localStorage.getItem("yutori_secret"), journal:await YutoriBackupStorage.getRestoreJournal() })), { secret:"PRIVATE_CANDIDATE",journal:null });
});

test("one-time native database deletion failure retries finalization without poisoning later cleanup", async () => {
  const result = await page.evaluate(async () => {
    const candidate = await YutoriBackup.inspectRestoreFile(sourceFile), safety = await YutoriBackup.saveSafetyBackup(candidate);
    YutoriBackup.setRestoreConfirmation(true); YutoriBackup.configure({ reload: () => {} }); await YutoriBackup.replaceWithCandidate(candidate,safety);
    const remove = IDBFactory.prototype.deleteDatabase; let failures=0, first;
    IDBFactory.prototype.deleteDatabase = function(name) { if(name === "YUTORI_DB" && failures++ === 0) throw new DOMException("once","UnknownError"); return remove.call(this,name); };
    try { first = await YutoriBackup.recoverInterruptedRestore().then(r => r.status,e => e.name); } finally { IDBFactory.prototype.deleteDatabase = remove; }
    const second = await YutoriBackup.recoverInterruptedRestore().then(r => r.status,e => e.name);
    return { first, second, secret:localStorage.getItem("yutori_secret"), journal:(await YutoriBackupStorage.getRestoreJournal())?.phase || null };
  });
  assert.deepEqual(result,{first:"completed",second:"none",secret:"PRIVATE_CANDIDATE",journal:null});
});

test("exception after journal removal is completed cleanup and never uses stale safety snapshot", async () => {
  const result = await page.evaluate(async () => {
    const candidate = await YutoriBackup.inspectRestoreFile(sourceFile), safety = await YutoriBackup.saveSafetyBackup(candidate);
    YutoriBackup.setRestoreConfirmation(true); YutoriBackup.configure({reload:()=>{}}); await YutoriBackup.replaceWithCandidate(candidate,safety);
    const api = YutoriBackupStorage; globalThis.YutoriBackupStorage = {...api,finalizeRestore:async j=>{await api.finalizeRestore(j);throw new Error("after commit");}};
    const first = await YutoriBackup.recoverInterruptedRestore(); globalThis.YutoriBackupStorage=api;
    return {status:first.status, secret:localStorage.getItem("yutori_secret"), journal:await api.getRestoreJournal()};
  });
  assert.deepEqual(result,{status:"completed",secret:"PRIVATE_CANDIDATE",journal:null});
});

for (const target of ["active", "foreign", "failed-foreign", "inactive"]) {
  test(`finalization cleanup protects scoped database target ${target}`, async () => {
    const result = await page.evaluate(async target => {
      const candidate=await YutoriBackup.inspectRestoreFile(sourceFile),safety=await YutoriBackup.saveSafetyBackup(candidate);
      YutoriBackup.setRestoreConfirmation(true);YutoriBackup.configure({reload:()=>{}});await YutoriBackup.replaceWithCandidate(candidate,safety);
      const foreign=await new Promise(r=>{const q=indexedDB.open("MITORI_FOREIGN");q.onsuccess=()=>r(q.result);});foreign.close();
      const extra = await YutoriBackupStorage.createStageFromArchive({manifest:fixtureManifest(),records:fixtureRecords()});
      const untouched = await YutoriBackupStorage.createStageFromArchive({manifest:fixtureManifest(),records:fixtureRecords()});
      const journal=await YutoriBackupStorage.getRestoreJournal();journal.phase="finalizing";
      if(target==="active")journal.oldDescriptor=journal.targetDescriptor;
      if(target==="foreign")journal.oldDescriptor={name:"MITORI_FOREIGN",version:1};
      if(target==="failed-foreign")journal.failedTarget={name:"MITORI_FOREIGN",version:1};
      if(target==="inactive")journal.failedTarget={name:extra.stageDbName,version:2};
      await YutoriBackupStorage.commitJournal(journal);
      const outcome=await YutoriBackup.recoverInterruptedRestore().then(r=>r.status,e=>e.name);
      const dbs=await indexedDB.databases();
      return {outcome,active:dbs.some(d=>d.name===candidate.stageDbName),foreign:dbs.some(d=>d.name==="MITORI_FOREIGN"),extra:dbs.some(d=>d.name===extra.stageDbName),untouched:dbs.some(d=>d.name===untouched.stageDbName),secret:localStorage.getItem("yutori_secret"),phase:(await YutoriBackupStorage.getRestoreJournal())?.phase||null};
    },target);
    assert.deepEqual(result,{outcome:target==="inactive"?"completed":"RestoreCleanupError",active:true,foreign:true,extra:target!=="inactive",untouched:true,secret:"PRIVATE_CANDIDATE",phase:target==="inactive"?null:"finalizing"});
  });
}
