import assert from "node:assert/strict";
import test, { after, afterEach, before, beforeEach } from "node:test";
import { createYutoriBrowser } from "./helpers/yutori-browser.mjs";

let harness, page, errors;
before(async () => { harness = await createYutoriBrowser(); });
beforeEach(async () => {
  page = await harness.freshPage({ scripts: ["assets/yutori-backup-archive.js"] });
  errors = [];
  page.on("pageerror", error => errors.push(error.message));
  const response = await page.request.get(`${harness.origin}/assets/yutori-backup-storage.js`);
  if (response.ok()) await page.addScriptTag({ content: await response.text() });
  await page.evaluate(() => {
    globalThis.requestResult = request => new Promise((resolve, reject) => {
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    globalThis.txDone = tx => new Promise((resolve, reject) => {
      tx.oncomplete = resolve;
      tx.onabort = () => reject(tx.error || new Error("aborted"));
      tx.onerror = () => {};
    });
    globalThis.makeDb = async (name, version, upgrade, seed) => {
      const request = indexedDB.open(name, version);
      request.onupgradeneeded = () => upgrade(request.result);
      const db = await requestResult(request);
      try {
        if (seed) {
          const tx = db.transaction([...db.objectStoreNames], "readwrite");
          const done = txDone(tx);
          seed(tx);
          await done;
        }
      } finally { db.close(); }
    };
    globalThis.fixtureManifest = () => ({
      formatVersion: 1, appVersion: "v0.3.40", createdAt: "2026-10-13T00:00:00.000Z",
      counts: { localStorage: 1, indexedDB: 3 }, localStorageKeys: ["yutori_saved_tests_v1"],
      indexedDB: { name: "YUTORI_DB", version: 2, stores: [
        { name: "pdfFiles", keyPath: "id", autoIncrement: false, count: 1, indexes: [{ name: "byName", keyPath: "name", unique: true, multiEntry: false }] },
        { name: "pdfPages", keyPath: ["session", "page"], autoIncrement: false, count: 1, indexes: [] },
        { name: "extra", keyPath: null, autoIncrement: true, count: 1, indexes: [] },
      ] },
    });
    globalThis.fixtureRecords = () => [
      { type: "localStorage", source: "localStorage", key: "yutori_saved_tests_v1", value: '[{"id":"答案"}]' },
      { type: "indexedDB", source: "indexedDB", store: "pdfFiles", key: "f", value: { id: "f", name: "答案.pdf", blob: new Blob(["PDF"], { type: "application/pdf" }), date: new Date("2026-01-02T00:00:00Z"), bytes: new Uint16Array([256, 65535]) } },
      { type: "indexedDB", source: "indexedDB", store: "pdfPages", key: ["s", 2], value: { session: "s", page: 2, image: new Blob(["PNG"]) } },
      { type: "indexedDB", source: "indexedDB", store: "extra", key: [new Date("2026-01-01"), new Uint8Array([1, 2])], value: { note: "追加" } },
    ];
  });
  assert.equal(await page.evaluate(() => typeof YutoriBackupStorage), "object", "the storage layer must be available");
});
afterEach(async () => {
  await page?.context().close();
  assert.deepEqual(errors, [], "no unhandled browser errors");
});
after(async () => { await harness?.close(); });

test("ownership collects only YUTORI keys in deterministic order", async () => {
  const result = await page.evaluate(() => {
    for (const [key, value] of [["yutori_saved_tests_v1", "答案"], ["yutori_a", "日本語"], ["mitori_grades", "秘密"], ["unrelated", "other"], ["YUTORI_BACKUP_META", "meta"]]) localStorage.setItem(key, value);
    return { owned: ["yutori_saved_tests_v1", "mitori_grades", "unrelated", "YUTORI_BACKUP_META", null].map(YutoriBackupStorage.isOwnedLocalStorageKey), entries: YutoriBackupStorage.collectLocalStorageEntries(localStorage) };
  });
  assert.deepEqual(result, { owned: [true, false, false, false, false], entries: [{ key: "yutori_a", value: "日本語" }, { key: "yutori_saved_tests_v1", value: "答案" }] });
});

test("metadata stores real file handles and clearing a handle preserves successful backup metadata", async () => {
  const result = await page.evaluate(async () => {
    const api = YutoriBackupStorage;
    const root = await navigator.storage.getDirectory();
    const handle = await root.getFileHandle("backup.yutori", { create: true });
    await api.saveDestinationMeta({ handle, fileName: "backup.yutori", lastSuccessfulAt: "2026-10-13", size: 123 });
    const meta = await api.getDestinationMeta();
    const db = await api.openMetaDb();
    const schema = { name: db.name, version: db.version, stores: [...db.objectStoreNames] };
    db.close();
    const same = await meta.handle.isSameEntry(handle);
    await api.clearDestinationHandle();
    const cleared = await api.getDestinationMeta();
    return { same, kind: meta.handle.kind, schema, hasHandle: !!cleared.handle, last: await api.getLastBackupMeta() };
  });
  assert.deepEqual(result, { same: true, kind: "file", schema: { name: "YUTORI_BACKUP_META", version: 1, stores: ["journals", "settings"] }, hasHandle: false, last: { fileName: "backup.yutori", lastSuccessfulAt: "2026-10-13", size: 123 } });
});

test("active descriptor defaults to YUTORI_DB v2 and selects a persisted shadow on later opens", async () => {
  const result = await page.evaluate(async () => {
    const api = YutoriBackupStorage;
    await makeDb("YUTORI_DB", 2, db => { db.createObjectStore("pdfFiles", { keyPath: "id" }); db.createObjectStore("pdfPages", { keyPath: "id" }); });
    const initial = await api.getActiveDataDbDescriptor();
    const original = await api.openActiveDataDb();
    const names = [...original.objectStoreNames]; original.close();
    const name = `YUTORI_RESTORE_STAGE_${crypto.randomUUID()}`;
    await makeDb(name, 3, db => db.createObjectStore("shadow"));
    await api.saveActiveDataDbDescriptor({ name, version: 3 });
    const selected = await api.openActiveDataDb(() => { throw new Error("existing shadow must not upgrade"); });
    const shadow = selected.name === name && selected.version === 3 && selected.objectStoreNames.contains("shadow"); selected.close();
    let rejected = false;
    try { await api.saveActiveDataDbDescriptor({ name: "MITORI_DB", version: 1 }); } catch { rejected = true; }
    return { initial, names, shadow, rejected, stillSelected: (await api.getActiveDataDbDescriptor()).name === name };
  });
  assert.deepEqual(result, { initial: { name: "YUTORI_DB", version: 2 }, names: ["pdfFiles", "pdfPages"], shadow: true, rejected: true, stillSelected: true });
});

test("snapshot enumerates every active store and schema but excludes foreign and metadata databases", async () => {
  const result = await page.evaluate(async () => {
    const api = YutoriBackupStorage;
    const manifest = fixtureManifest();
    await makeDb("YUTORI_DB", 2, db => {
      for (const schema of manifest.indexedDB.stores) {
        const store = db.createObjectStore(schema.name, { keyPath: schema.keyPath, autoIncrement: schema.autoIncrement });
        for (const index of schema.indexes) store.createIndex(index.name, index.keyPath, index);
      }
    }, tx => { for (const r of fixtureRecords().slice(1)) { const s = tx.objectStore(r.store); if (s.keyPath === null) s.add(r.value, r.key); else s.add(r.value); } });
    await makeDb("MITORI_DB", 1, db => db.createObjectStore("secrets"), tx => tx.objectStore("secrets").add("secret", 1));
    await api.saveDestinationMeta({ fileName: "private", size: 9 });
    const meta = await api.openMetaDb(); const tx = meta.transaction("journals", "readwrite"); const done = txDone(tx); tx.objectStore("journals").put({ oldLocalStorage: "private" }, "restore"); await done; meta.close();
    localStorage.setItem("yutori_saved_tests_v1", '[{"id":"答案"}]'); localStorage.setItem("mitori_grades", "secret");
    const snapshot = await api.createSnapshotRecordSource({ appVersion: "v0.3.51", createdAt: "2026-10-13T00:00:00.000Z" });
    const records = []; for await (const record of snapshot.records) records.push(record);
    const archive = await new Response(YutoriBackupArchive.createArchiveStream(snapshot.manifest, (async function* () { yield* records; })())).blob();
    await YutoriBackupArchive.readArchiveStream(archive);
    const file = records.find(r => r.store === "pdfFiles").value;
    return { manifest: snapshot.manifest, types: records.map(r => r.source), stores: records.filter(r => r.store).map(r => r.store).sort(), names: records.filter(r => r.source === "localStorage").map(r => r.key), blob: await file.blob.text(), date: file.date.toISOString(), bytes: [...file.bytes] };
  });
  assert.deepEqual(result.manifest.counts, { localStorage: 1, indexedDB: 3 });
  assert.equal(result.manifest.appVersion, "v0.3.51");
  assert.equal(result.manifest.createdAt, "2026-10-13T00:00:00.000Z");
  assert.ok(result.manifest.estimatedBytes > 0);
  assert.deepEqual(result.manifest.indexedDB.stores.map(s => [s.name, s.keyPath, s.autoIncrement, s.count]), [["extra", null, true, 1], ["pdfFiles", "id", false, 1], ["pdfPages", ["session", "page"], false, 1]]);
  assert.deepEqual(result.manifest.indexedDB.stores.find(s => s.name === "pdfFiles").indexes, [{ name: "byName", keyPath: "name", unique: true, multiEntry: false }]);
  assert.deepEqual(result.stores, ["extra", "pdfFiles", "pdfPages"]);
  assert.deepEqual(result.names, ["yutori_saved_tests_v1"]);
  assert.equal(result.blob, "PDF"); assert.equal(result.date, "2026-01-02T00:00:00.000Z"); assert.deepEqual(result.bytes, [256, 65535]);
});

test("streamed writer commits incremental records with original schemas, keys and structured values", async () => {
  const result = await page.evaluate(async () => {
    const api = YutoriBackupStorage;
    const writer = await api.createStageWriter(fixtureManifest());
    const records = fixtureRecords();
    await writer.onRecord(records[0]); await writer.onRecord(records[1]);
    // Observe the committed first record while remaining records have not arrived.
    const stage = (await indexedDB.databases()).find(db => db.name.startsWith("YUTORI_RESTORE_STAGE_"));
    const partial = await requestResult(indexedDB.open(stage.name));
    const partialTx = partial.transaction("pdfFiles"); const partialDone = txDone(partialTx);
    const partialCount = await requestResult(partialTx.objectStore("pdfFiles").count()); await partialDone; partial.close();
    await writer.onRecord(records[2]); await writer.onRecord(records[3]);
    const candidate = await writer.finalize();
    const db = await requestResult(indexedDB.open(candidate.stageDbName));
    const tx = db.transaction([...db.objectStoreNames]); const done = txDone(tx);
    const fileRequest = requestResult(tx.objectStore("pdfFiles").get("f"));
    const pageRequest = requestResult(tx.objectStore("pdfPages").get(["s", 2]));
    const extraRequest = requestResult(tx.objectStore("extra").get([new Date("2026-01-01"), new DataView(new Uint8Array([1, 2]).buffer)]));
    const index = tx.objectStore("pdfFiles").index("byName");
    const indexSchema = { name: index.name, keyPath: index.keyPath, unique: index.unique, multiEntry: index.multiEntry };
    const [file, image, extra] = await Promise.all([fileRequest, pageRequest, extraRequest]); await done; db.close();
    return { partialCount, name: candidate.stageDbName, counts: candidate.summary.counts, localStorage: candidate.localStorageEntries, active: await api.getActiveDataDbDescriptor(), file: { name: file.name, blob: await file.blob.text(), date: file.date.toISOString(), bytes: [...file.bytes] }, image: await image.image.text(), extra, indexSchema };
  });
  assert.equal(result.partialCount, 1); assert.match(result.name, /^YUTORI_RESTORE_STAGE_[0-9a-f-]{36}$/);
  assert.deepEqual(result.counts, { localStorage: 1, indexedDB: 3 });
  assert.deepEqual(result.localStorage, [{ key: "yutori_saved_tests_v1", value: '[{"id":"答案"}]' }]);
  assert.deepEqual(result.active, { name: "YUTORI_DB", version: 2 });
  assert.deepEqual(result.file, { name: "答案.pdf", blob: "PDF", date: "2026-01-02T00:00:00.000Z", bytes: [256, 65535] });
  assert.equal(result.image, "PNG"); assert.deepEqual(result.extra, { note: "追加" });
  assert.deepEqual(result.indexSchema, { name: "byName", keyPath: "name", unique: true, multiEntry: false });
});

test("streamed writer rejects invalid schema definitions before creating a stage", async () => {
  const result = await page.evaluate(async () => {
    const outcomes = [];
    for (const mutate of [
      m => m.indexedDB.stores.push(m.indexedDB.stores[0]),
      m => m.indexedDB.stores[0].indexes.push(m.indexedDB.stores[0].indexes[0]),
      m => m.indexedDB.stores[0].unsupported = true,
      m => m.indexedDB.stores[0].keyPath = {},
      m => m.indexedDB.stores[1].autoIncrement = true,
      m => m.indexedDB.stores[0].indexes[0].unknown = true,
      m => { m.indexedDB.stores[0].indexes[0].keyPath = ["id", "name"]; m.indexedDB.stores[0].indexes[0].multiEntry = true; },
    ]) {
      const m = fixtureManifest(); mutate(m);
      try { await YutoriBackupStorage.createStageWriter(m); outcomes.push("ACCEPTED"); } catch { outcomes.push("REJECTED"); }
    }
    return { outcomes, stages: (await indexedDB.databases()).filter(db => db.name.startsWith("YUTORI_RESTORE_STAGE_")).length };
  });
  assert.deepEqual(result, { outcomes: Array(7).fill("REJECTED"), stages: 0 });
});

test("streamed writer deletes partial stages for duplicate, foreign, mismatched and absent records", async () => {
  const results = await page.evaluate(async () => {
    const outcomes = [];
    const records = fixtureRecords();
    const cases = [
      [records[1], records[1]],
      [records[0], records[0]],
      [records[1], { ...records[2], store: "notInManifest" }],
      [records[1], { ...records[0], key: "mitori_grades" }],
      [records[1], { ...records[2], key: ["s", 99] }],
      [records[1], { ...records[3], value: () => {} }],
      [records[1]],
    ];
    for (const batch of cases) {
      const writer = await YutoriBackupStorage.createStageWriter(fixtureManifest());
      let rejected = false;
      try { for (const record of batch) await writer.onRecord(record); await writer.finalize(); } catch { rejected = true; }
      await writer.abort();
      outcomes.push({ rejected, stages: (await indexedDB.databases()).filter(db => db.name.startsWith("YUTORI_RESTORE_STAGE_")).length, active: await YutoriBackupStorage.getActiveDataDbDescriptor() });
    }
    return outcomes;
  });
  assert.deepEqual(results, Array.from({ length: 7 }, () => ({ rejected: true, stages: 0, active: { name: "YUTORI_DB", version: 2 } })));
});

test("quota failures and abort clean streamed stages without selecting or modifying live data", async () => {
  const result = await page.evaluate(async () => {
    const api = YutoriBackupStorage;
    const writer = await api.createStageWriter(fixtureManifest());
    await writer.onRecord(fixtureRecords()[1]);
    const original = IDBObjectStore.prototype.add;
    IDBObjectStore.prototype.add = function () { throw new DOMException("full", "QuotaExceededError"); };
    let quota;
    try { await writer.onRecord(fixtureRecords()[2]); } catch (error) { quota = error.name; }
    finally { IDBObjectStore.prototype.add = original; }
    const aborted = await api.createStageWriter(fixtureManifest());
    await aborted.onRecord(fixtureRecords()[0]); await aborted.abort(); await aborted.abort();
    let closed = false; try { await aborted.finalize(); } catch { closed = true; }
    return { quota, closed, stages: (await indexedDB.databases()).filter(db => db.name.startsWith("YUTORI_RESTORE_STAGE_")).length, active: await api.getActiveDataDbDescriptor(), liveLocalStorage: localStorage.length };
  });
  assert.deepEqual(result, { quota: "QuotaExceededError", closed: true, stages: 0, active: { name: "YUTORI_DB", version: 2 }, liveLocalStorage: 0 });
});

test("stage convenience accepts async records and scoped cleanup preserves active, foreign and metadata databases", async () => {
  const result = await page.evaluate(async () => {
    const api = YutoriBackupStorage;
    const stage = await api.createStageFromArchive({ manifest: fixtureManifest(), records: (async function* () { yield* fixtureRecords(); })() });
    const second = await api.createStageFromArchive({ manifest: fixtureManifest(), records: fixtureRecords() });
    await makeDb("MITORI_RESTORE_STAGE_other", 1, db => db.createObjectStore("foreign"));
    await api.saveActiveDataDbDescriptor({ name: stage.stageDbName, version: 2 });
    await api.deleteAllRestoreStagesExcept(second.stageDbName);
    const kept = (await indexedDB.databases()).map(db => db.name);
    await api.deleteAllRestoreStagesExcept();
    const remaining = (await indexedDB.databases()).map(db => db.name);
    return { keptActive: kept.includes(stage.stageDbName), keptException: kept.includes(second.stageDbName), activeRemains: remaining.includes(stage.stageDbName), removedInactive: !remaining.includes(second.stageDbName), foreign: remaining.includes("MITORI_RESTORE_STAGE_other"), meta: remaining.includes("YUTORI_BACKUP_META") };
  });
  assert.deepEqual(result, { keptActive: true, keptException: true, activeRemains: true, removedInactive: true, foreign: true, meta: true });
});

test("snapshot paging retains all compound, binary and Date keys across cursor boundaries and closes on early return", async () => {
  const result = await page.evaluate(async () => {
    const api = YutoriBackupStorage;
    const keys = [...Array.from({ length: 40 }, (_, n) => n), new Date("2026-01-01"), new Uint8Array([1, 2]), ...Array.from({ length: 40 }, (_, n) => ["答案", n])];
    await makeDb("YUTORI_DB", 2, db => db.createObjectStore("extra"), tx => { for (const key of keys) tx.objectStore("extra").add({ key }, key); });
    const snapshot = await api.createSnapshotRecordSource({ appVersion: "v0.3.51", createdAt: "now" });
    const received = []; for await (const record of snapshot.records) received.push(record);
    const complete = keys.every(key => received.some(record => indexedDB.cmp(record.key, key) === 0));
    const early = await api.createSnapshotRecordSource({});
    for await (const record of early.records) break;
    await api.deleteDatabase("YUTORI_DB");
    return { count: received.length, complete, dbGone: !(await indexedDB.databases()).some(db => db.name === "YUTORI_DB") };
  });
  assert.deepEqual(result, { count: 82, complete: true, dbGone: true });
});

test("streamed inline autoIncrement records cannot invent a missing key path", async () => {
  const result = await page.evaluate(async () => {
    const manifest = { formatVersion: 1, counts: { indexedDB: 1 }, localStorageKeys: [], indexedDB: { name: "YUTORI_DB", version: 2, stores: [{ name: "nested", keyPath: "meta.id", autoIncrement: true, indexes: [], count: 1 }] } };
    const writer = await YutoriBackupStorage.createStageWriter(manifest);
    const value = { note: "must remain exact" };
    let rejected = false;
    try { await writer.onRecord({ type: "indexedDB", source: "indexedDB", store: "nested", key: 1, value }); await writer.finalize(); } catch { rejected = true; }
    return { rejected, unchanged: !Object.hasOwn(value, "meta"), stages: (await indexedDB.databases()).filter(db => db.name.startsWith("YUTORI_RESTORE_STAGE_")).length };
  });
  assert.deepEqual(result, { rejected: true, unchanged: true, stages: 0 });
});

test("writer schema reconstruction preserves empty, nested and autoIncrement key paths and multiEntry indexes", async () => {
  const result = await page.evaluate(async () => {
    const manifest = { formatVersion: 1, counts: { indexedDB: 3 }, localStorageKeys: [], indexedDB: { name: "YUTORI_DB", version: 2, stores: [
      { name: "emptyPath", keyPath: "", autoIncrement: false, indexes: [], count: 1 },
      { name: "nested", keyPath: "meta.id", autoIncrement: true, indexes: [{ name: "tags", keyPath: "tags", unique: false, multiEntry: true }], count: 1 },
      { name: "__proto__", keyPath: null, autoIncrement: true, indexes: [], count: 1 },
    ] } };
    const candidate = await YutoriBackupStorage.createStageFromArchive({ manifest, records: [
      { type: "indexedDB", source: "indexedDB", store: "emptyPath", key: "literal", value: "literal" },
      { type: "indexedDB", source: "indexedDB", store: "nested", key: 19, value: { meta: { id: 19 }, tags: ["日本語", "答案"] } },
      { type: "indexedDB", source: "indexedDB", store: "__proto__", key: 51, value: "explicit" },
    ] });
    const db = await requestResult(indexedDB.open(candidate.stageDbName));
    const tx = db.transaction([...db.objectStoreNames], "readwrite"); const done = txDone(tx);
    const empty = requestResult(tx.objectStore("emptyPath").get("literal"));
    const tag = requestResult(tx.objectStore("nested").index("tags").get("答案"));
    const nextInline = requestResult(tx.objectStore("nested").add({ tags: [] }));
    const nextOutline = requestResult(tx.objectStore("__proto__").add("next"));
    const schemas = [...db.objectStoreNames].map(name => { const store = tx.objectStore(name); return [name, store.keyPath, store.autoIncrement]; });
    const values = await Promise.all([empty, tag, nextInline, nextOutline]); await done; db.close();
    return { values, schemas };
  });
  assert.deepEqual(result.values, ["literal", { meta: { id: 19 }, tags: ["日本語", "答案"] }, 20, 52]);
  assert.deepEqual(result.schemas, [["__proto__", null, true], ["emptyPath", "", false], ["nested", "meta.id", true]]);
});

test("snapshot and stage summaries count the union of profile and historical roster classes", async () => {
  const result = await page.evaluate(async () => {
    localStorage.setItem("yutori_saved_tests_v1", '[{"id":1},{"id":2}]');
    localStorage.setItem("yutori_class_profiles_v1", '{"一組":{}}');
    localStorage.setItem("yutori_rosters", '{"一組":[],"二組":[]}');
    localStorage.setItem("yutori_grading_sessions_v023", '[{"id":"session"}]');
    const snapshot = await YutoriBackupStorage.createSnapshotRecordSource({ appVersion: "v0.3.51" });
    const candidate = await YutoriBackupStorage.createStageFromArchive(snapshot);
    return { snapshot: snapshot.manifest.summary, stage: candidate.summary };
  });
  const expected = { counts: { localStorage: 4 }, tests: 2, classes: 2, gradingSessions: 1, pdfFiles: 0, pdfPages: 0 };
  assert.deepEqual(result, { snapshot: expected, stage: expected });
});

test("codec consumer streams into the writer and corruption abort deletes already committed records", async () => {
  const result = await page.evaluate(async () => {
    const manifest = fixtureManifest();
    const archive = await new Response(YutoriBackupArchive.createArchiveStream(manifest, (async function* () { yield* fixtureRecords(); })())).blob();
    const frames = (await new Response(archive.stream().pipeThrough(new DecompressionStream("gzip"))).text()).trim().split("\n").map(JSON.parse);
    frames.at(-1).archiveHash = "0".repeat(64);
    const corrupt = new Blob([frames.map(frame => JSON.stringify(frame) + "\n").join("")]).stream().pipeThrough(new CompressionStream("gzip"));
    const writer = await YutoriBackupStorage.createStageWriter(manifest);
    let consumed = 0, errorCode;
    try { await YutoriBackupArchive.readArchiveStream(corrupt, { async onRecord(record) { await writer.onRecord(record); consumed++; } }); await writer.finalize(); }
    catch (error) { errorCode = error.code; await writer.abort(); }
    const validWriter = await YutoriBackupStorage.createStageWriter(manifest);
    await YutoriBackupArchive.readArchiveStream(archive, { onRecord: validWriter.onRecord });
    const candidate = await validWriter.finalize();
    return { consumed, errorCode, stages: (await indexedDB.databases()).filter(db => db.name.startsWith("YUTORI_RESTORE_STAGE_")).length, counts: candidate.summary.counts, active: await YutoriBackupStorage.getActiveDataDbDescriptor() };
  });
  assert.deepEqual(result, { consumed: 4, errorCode: "CHECKSUM_MISMATCH", stages: 1, counts: { localStorage: 1, indexedDB: 3 }, active: { name: "YUTORI_DB", version: 2 } });
});
