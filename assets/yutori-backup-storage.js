(function (global) {
  "use strict";

  const META_DB = "YUTORI_BACKUP_META";
  const DEFAULT_DATA_DB = Object.freeze({ name: "YUTORI_DB", version: 2 });
  const STAGE_PREFIX = "YUTORI_RESTORE_STAGE_";
  const STAGE_NAME = /^YUTORI_RESTORE_STAGE_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  // All historical keys found in index.html already use yutori_. Register any
  // future non-prefixed compatibility keys explicitly, never origin-wide.
  const LEGACY_LOCAL_STORAGE_KEYS = new Set();
  const CURSOR_PAGE_SIZE = 32;
  let requestTimeoutMs = 10000;
  function configure({ requestTimeoutMs: timeout = requestTimeoutMs } = {}) {
    if (!Number.isFinite(timeout) || timeout <= 0) throw new TypeError("Invalid database request timeout");
    requestTimeoutMs = timeout;
  }
  function requestDeadline(signal, reject) {
    const abort = () => reject(signal.reason || new DOMException("Request cancelled", "AbortError"));
    const timer = global.setTimeout(() => reject(new DOMException("Database request timed out; close other YUTORI tabs/windows and retry", "TimeoutError")), requestTimeoutMs);
    signal?.addEventListener("abort", abort, { once: true });
    return () => { global.clearTimeout(timer); signal?.removeEventListener("abort", abort); };
  }
  const fail = code => { throw new global.YutoriBackupArchive.ArchiveFormatError(code); };
  const isOwnedLocalStorageKey = key => typeof key === "string" && (key.startsWith("yutori_") || LEGACY_LOCAL_STORAGE_KEYS.has(key));

  function collectLocalStorageEntries(storage = global.localStorage) {
    const entries = [];
    for (let i = 0; i < storage.length; i++) {
      const key = storage.key(i);
      if (isOwnedLocalStorageKey(key)) {
        const value = storage.getItem(key);
        if (value !== null) entries.push({ key, value });
      }
    }
    return entries.sort((a, b) => a.key < b.key ? -1 : a.key > b.key ? 1 : 0);
  }

  function openDatabase(name, version, upgrade, { signal } = {}) {
    if (signal?.aborted) return Promise.reject(signal.reason || new DOMException("Request cancelled", "AbortError"));
    return new Promise((resolve, reject) => {
      const request = global.indexedDB.open(name, version);
      let failure, settled = false;
      const failRequest = error => { if (!settled) { settled = true; clearDeadline(); reject(error); } };
      const clearDeadline = requestDeadline(signal, failRequest);
      request.onupgradeneeded = event => {
        if (settled) { request.transaction.abort(); return; }
        try { upgrade?.(request.result, event, request.transaction); }
        catch (error) { failure = error; request.transaction.abort(); }
      };
      request.onsuccess = () => {
        const db = request.result;
        db.onversionchange = () => db.close();
        if (settled) { db.close(); return; }
        settled = true; clearDeadline(); resolve(db);
      };
      request.onerror = () => failRequest(failure || request.error);
      request.onblocked = () => failRequest(new DOMException("Database is open in another tab", "InvalidStateError"));
    });
  }

  function transactionResult(db, stores, mode, execute) {
    return new Promise((resolve, reject) => {
      let tx, result, failure;
      try { tx = db.transaction(stores, mode, { durability: db.name === META_DB && mode === "readwrite" ? "strict" : "default" }); } catch (error) { reject(error); return; }
      tx.oncomplete = () => resolve(result);
      tx.onerror = () => {};
      tx.onabort = () => reject(failure || tx.error || new DOMException("Transaction aborted", "AbortError"));
      const abort = error => { failure = error; tx.abort(); };
      try { execute(tx, value => { result = value; }, abort); }
      catch (error) { abort(error); }
    });
  }

  function openMetaDb() {
    return openDatabase(META_DB, 1, db => {
      db.createObjectStore("settings");
      db.createObjectStore("journals");
    });
  }

  async function readSetting(key) {
    const db = await openMetaDb();
    try {
      return await transactionResult(db, "settings", "readonly", (tx, result) => {
        const request = tx.objectStore("settings").get(key);
        request.onsuccess = () => result(request.result ?? null);
      });
    } finally { db.close(); }
  }

  async function updateSetting(key, update) {
    const db = await openMetaDb();
    try {
      return await transactionResult(db, "settings", "readwrite", (tx, result, abort) => {
        const store = tx.objectStore("settings");
        const request = store.get(key);
        request.onsuccess = () => {
          try { const value = update(request.result); store.put(value, key); result(value); }
          catch (error) { abort(error); }
        };
      });
    } finally { db.close(); }
  }

  const getDestinationMeta = () => readSetting("destination");
  const saveDestinationMeta = meta => updateSetting("destination", previous => ({ ...previous, ...meta }));
  const clearDestinationHandle = () => updateSetting("destination", previous => {
    const meta = { ...previous }; delete meta.handle; return meta;
  });
  async function getLastBackupMeta() {
    const meta = await getDestinationMeta();
    if (!meta?.lastSuccessfulAt) return null;
    return { fileName: meta.fileName, lastSuccessfulAt: meta.lastSuccessfulAt, size: meta.size };
  }

  function validateDescriptor(descriptor) {
    if (!descriptor || (descriptor.name !== DEFAULT_DATA_DB.name && !STAGE_NAME.test(descriptor.name)) ||
        !Number.isSafeInteger(descriptor.version) || descriptor.version < 1) fail("UNSUPPORTED_VERSION");
    return { name: descriptor.name, version: descriptor.version };
  }
  async function getActiveDataDbDescriptor() {
    return validateDescriptor(await readSetting("activeDataDb") || DEFAULT_DATA_DB);
  }
  async function saveActiveDataDbDescriptor(descriptor) {
    const value = validateDescriptor(descriptor);
    return updateSetting("activeDataDb", () => value);
  }
  function upgradeDefaultSchema(db) {
    for (const name of ["pdfFiles", "pdfPages"]) if (!db.objectStoreNames.contains(name)) db.createObjectStore(name, { keyPath: "id" });
  }
  async function openActiveDataDb(upgradeCallback = upgradeDefaultSchema, requestOptions) {
    const descriptor = await getActiveDataDbDescriptor();
    // Only application opens request a schema migration. Snapshot opens retain
    // the archived version until post-reload journal validation has finished.
    const version = arguments.length ? Math.max(DEFAULT_DATA_DB.version, descriptor.version) : descriptor.version;
    let db;
    try { db = await openDatabase(descriptor.name, version, upgradeCallback, requestOptions); }
    catch (error) {
      if (error.name !== "VersionError") throw error;
      // IndexedDB upgrade is atomic, but metadata is a different database.
      // If a crash happened between those commits, discover the already-upgraded
      // version and repair its pointer before returning any connection.
      db = await openDatabase(descriptor.name, undefined, undefined, requestOptions);
    }
    try {
      if (db.version !== descriptor.version) await saveActiveDataDbDescriptor({ name: db.name, version: db.version });
      return db;
    } catch (error) { db.close(); throw error; }
  }

  async function readSchema(db) {
    const names = [...db.objectStoreNames];
    if (!names.length) return [];
    return transactionResult(db, names, "readonly", (tx, result) => {
      const schemas = names.map(name => {
        const store = tx.objectStore(name);
        const schema = { name, keyPath: store.keyPath, autoIncrement: store.autoIncrement,
          indexes: [...store.indexNames].map(indexName => {
            const index = store.index(indexName);
            return { name: index.name, keyPath: index.keyPath, unique: index.unique, multiEntry: index.multiEntry };
          }), count: 0 };
        const request = store.count(); request.onsuccess = () => { schema.count = request.result; };
        return schema;
      });
      result(schemas);
    });
  }

  function readCursorPage(db, store, afterKey) {
    return transactionResult(db, store, "readonly", (tx, result) => {
      const records = [];
      const range = afterKey === undefined ? null : IDBKeyRange.lowerBound(afterKey, true);
      const request = tx.objectStore(store).openCursor(range);
      request.onsuccess = () => {
        const cursor = request.result;
        if (cursor) records.push({ type: "indexedDB", source: "indexedDB", store, key: cursor.primaryKey, value: cursor.value });
        if (cursor && records.length < CURSOR_PAGE_SIZE) cursor.continue();
      };
      result(records);
    });
  }

  async function* dataRecords(descriptor, schemas) {
    const db = await openDatabase(descriptor.name, descriptor.version);
    try {
      for (const schema of schemas) {
        let afterKey;
        while (true) {
          const page = await readCursorPage(db, schema.name, afterKey);
          if (!page.length) break;
          afterKey = page.at(-1).key;
          yield* page;
          if (page.length < CURSOR_PAGE_SIZE) break;
        }
      }
    } finally { db.close(); }
  }

  const increment = (counts, type) => { counts[type] = (counts[type] || 0) + 1; };
  function summarize(localStorageEntries, counts, stores) {
    const parse = key => {
      const entry = localStorageEntries.find(item => item.key === key);
      try { return entry ? JSON.parse(entry.value) : null; } catch { return null; }
    };
    const tests = parse("yutori_saved_tests_v1");
    const classNames = new Set();
    for (const key of ["yutori_class_profiles_v1", "yutori_rosters"]) {
      const classes = parse(key);
      if (classes && typeof classes === "object" && !Array.isArray(classes)) for (const name of Object.keys(classes)) classNames.add(name);
    }
    const sessions = parse("yutori_grading_sessions_v023");
    return { counts: { ...counts }, tests: Array.isArray(tests) ? tests.length : 0,
      classes: classNames.size,
      gradingSessions: Array.isArray(sessions) ? sessions.length : 0,
      pdfFiles: stores.find(s => s.name === "pdfFiles")?.count || 0,
      pdfPages: stores.find(s => s.name === "pdfPages")?.count || 0 };
  }

  async function createSnapshotRecordSource({ appVersion, createdAt = new Date().toISOString() } = {}) {
    const localStorageEntries = collectLocalStorageEntries();
    const db = await openActiveDataDb();
    let descriptor, stores;
    try { descriptor = { name: db.name, version: db.version }; stores = await readSchema(db); }
    finally { db.close(); }
    const counts = {};
    let estimatedBytes = 0;
    // Estimate structured JSON plus attachment sizes without reading Blob bytes or
    // retaining records. The coordinator must keep persistence idle across passes.
    for (const entry of localStorageEntries) {
      increment(counts, "localStorage"); estimatedBytes += new Blob([entry.key, entry.value]).size;
    }
    for await (const record of dataRecords(descriptor, stores)) {
      increment(counts, "indexedDB");
      const encoded = await global.YutoriBackupArchive.serializeStructuredValue(record);
      estimatedBytes += new Blob([JSON.stringify(encoded.jsonValue)]).size + encoded.attachments.reduce((sum, item) => sum + item.blob.size, 0);
    }
    const manifest = { formatVersion: global.YutoriBackupArchive.FORMAT_VERSION, appVersion, createdAt,
      counts, localStorageKeys: localStorageEntries.map(item => item.key), indexedDB: { ...descriptor, stores },
      estimatedBytes, summary: summarize(localStorageEntries, counts, stores) };
    const records = (async function* () {
      for (const entry of localStorageEntries) yield { type: "localStorage", source: "localStorage", ...entry };
      yield* dataRecords(descriptor, stores);
    })();
    return { manifest, records };
  }

  function onlyFields(object, allowed) {
    if (!object || typeof object !== "object" || Array.isArray(object) || Object.keys(object).some(key => !allowed.includes(key))) fail("UNSUPPORTED_VERSION");
  }
  function validateKeyPath(keyPath, nullable) {
    if (nullable && keyPath === null) return;
    const validString = path => typeof path === "string" && (path === "" || path.split(".").every(part => /^[$_\p{ID_Start}][$_\u200C\u200D\p{ID_Continue}]*$/u.test(part)));
    if (validString(keyPath) || (Array.isArray(keyPath) && keyPath.length > 0 && keyPath.every(validString))) return;
    fail("UNSUPPORTED_VERSION");
  }
  function validateManifest(manifest) {
    if (!manifest || manifest.formatVersion !== global.YutoriBackupArchive.FORMAT_VERSION || !manifest.indexedDB) fail("UNSUPPORTED_VERSION");
    const descriptor = validateDescriptor(manifest.indexedDB);
    if (!Array.isArray(manifest.indexedDB.stores) || !manifest.counts || !Array.isArray(manifest.localStorageKeys)) fail("CHECKSUM_MISMATCH");
    onlyFields(manifest.counts, ["localStorage", "indexedDB"]);
    for (const count of Object.values(manifest.counts)) if (!Number.isSafeInteger(count) || count < 1) fail("CHECKSUM_MISMATCH");
    const localKeys = new Set();
    for (const key of manifest.localStorageKeys) {
      if (!isOwnedLocalStorageKey(key)) fail("UNSUPPORTED_VERSION");
      if (localKeys.has(key)) fail("DUPLICATE_ENTRY"); localKeys.add(key);
    }
    if ((manifest.counts.localStorage || 0) !== localKeys.size) fail("CHECKSUM_MISMATCH");
    const names = new Set();
    let total = 0;
    for (const schema of manifest.indexedDB.stores) {
      onlyFields(schema, ["name", "keyPath", "autoIncrement", "indexes", "count"]);
      if (typeof schema.name !== "string" || typeof schema.autoIncrement !== "boolean" || !Number.isSafeInteger(schema.count) || schema.count < 0 || !Array.isArray(schema.indexes)) fail("UNSUPPORTED_VERSION");
      if (names.has(schema.name)) fail("DUPLICATE_ENTRY"); names.add(schema.name);
      validateKeyPath(schema.keyPath, true);
      if (schema.autoIncrement && (schema.keyPath === "" || Array.isArray(schema.keyPath))) fail("UNSUPPORTED_VERSION");
      const indexes = new Set();
      for (const index of schema.indexes) {
        onlyFields(index, ["name", "keyPath", "unique", "multiEntry"]);
        if (typeof index.name !== "string" || typeof index.unique !== "boolean" || typeof index.multiEntry !== "boolean") fail("UNSUPPORTED_VERSION");
        validateKeyPath(index.keyPath, false);
        if (index.multiEntry && Array.isArray(index.keyPath)) fail("UNSUPPORTED_VERSION");
        if (indexes.has(index.name)) fail("DUPLICATE_ENTRY"); indexes.add(index.name);
      }
      total += schema.count;
    }
    if ((manifest.counts.indexedDB || 0) !== total) fail("CHECKSUM_MISMATCH");
    return descriptor;
  }

  const stageOwners = new Map();
  const stageLockName = name => `yutori-stage:${name}`;
  async function ownStage(name) {
    if (!global.navigator?.locks) return;
    await new Promise((resolve, reject) => {
      global.navigator.locks.request(stageLockName(name), () => new Promise(release => {
        stageOwners.set(name, release); resolve();
      })).catch(reject);
    });
  }
  function releaseStage(name) { stageOwners.get(name)?.(); stageOwners.delete(name); }
  const databaseDeletions = new Map();
  function deleteDatabase(name, { signal } = {}) {
    if (name !== DEFAULT_DATA_DB.name && !STAGE_NAME.test(name)) return Promise.reject(new TypeError("Not a YUTORI data database"));
    if (signal?.aborted) return Promise.reject(signal.reason || new DOMException("Request cancelled", "AbortError"));
    const existing = databaseDeletions.get(name);
    if (existing) return existing.waitError ? Promise.reject(existing.waitError) : existing.promise;
    const deletion = { waitError: null };
    deletion.promise = new Promise((resolve, reject) => {
      const request = global.indexedDB.deleteDatabase(name);
      const failRequest = error => { deletion.waitError = error; clearDeadline(); reject(error); };
      const clearDeadline = requestDeadline(signal, failRequest);
      request.onsuccess = () => { clearDeadline(); databaseDeletions.delete(name); releaseStage(name); resolve(); };
      request.onerror = () => { clearDeadline(); databaseDeletions.delete(name); reject(request.error); };
      // Native requests cannot be cancelled. Keep timed-out/aborted/blocked
      // requests tracked until a terminal event; late success only clears this
      // entry, never resumes a rejected finalization or changes its journal.
      request.onblocked = () => failRequest(new DOMException("Database is open in another tab", "InvalidStateError"));
    });
    databaseDeletions.set(name, deletion);
    deletion.promise.catch(() => {
      // A synchronous native exception has no request event to clear the entry.
      if (!deletion.waitError && databaseDeletions.get(name) === deletion) databaseDeletions.delete(name);
    });
    return deletion.promise;
  }
  async function deleteAllRestoreStagesExcept(name) {
    const active = await getActiveDataDbDescriptor();
    for (const db of await global.indexedDB.databases()) {
      if (STAGE_NAME.test(db.name) && db.name !== name && db.name !== active.name) await deleteDatabase(db.name);
    }
  }
  async function reclaimAbandonedStages() {
    // The DB name is durable lifecycle identity; a Web Lock proves that its
    // inspecting page is still alive, including after the writer closes its DB.
    // Without cross-page ownership support, prefer retaining an orphan to
    // deleting another page's live candidate.
    if (!global.navigator?.locks || await getRestoreJournal()) return;
    for (const db of await global.indexedDB.databases()) {
      if (!STAGE_NAME.test(db.name)) continue;
      try {
        await global.navigator.locks.request(stageLockName(db.name), { ifAvailable: true }, async lock => {
          if (!lock) return;
          const meta = await openMetaDb(); let references;
          try {
            references = await transactionResult(meta, ["settings", "journals"], "readonly", (tx, result) => {
              const state = {};
              tx.objectStore("journals").get("restore").onsuccess = event => { state.journal = event.target.result; };
              tx.objectStore("settings").get("activeDataDb").onsuccess = event => { state.active = event.target.result || DEFAULT_DATA_DB; };
              result(state);
            });
          } finally { meta.close(); }
          // A pointer switch and its journal must be observed in one snapshot;
          // mixing reads across that transaction could mistake the old DB for
          // an orphan just as another tab starts recovery.
          if (references.journal || validateDescriptor(references.active).name === db.name) return;
          await deleteDatabase(db.name);
        });
      } catch { break; } // Optional cleanup is bounded and must not block startup.
    }
  }

  async function deleteRestoreStage(name) {
    if (!STAGE_NAME.test(name)) throw new TypeError("Not a restore stage");
    if ((await getActiveDataDbDescriptor()).name === name) throw new DOMException("Stage is active", "InvalidStateError");
    await deleteDatabase(name);
  }

  async function createStageWriter(inputManifest) {
    const manifest = structuredClone(inputManifest);
    const descriptor = validateManifest(manifest);
    const stageDbName = `${STAGE_PREFIX}${global.crypto.randomUUID()}`;
    await ownStage(stageDbName);
    const localStorageEntries = [];
    const localKeys = new Set();
    const expectedLocalKeys = new Set(manifest.localStorageKeys);
    const counts = {}, storeCounts = new Map(manifest.indexedDB.stores.map(schema => [schema.name, 0]));
    let db, state = "open", queue = Promise.resolve(), failure;
    try {
      db = await openDatabase(stageDbName, descriptor.version, database => {
        for (const schema of manifest.indexedDB.stores) {
          const store = database.createObjectStore(schema.name, { keyPath: schema.keyPath, autoIncrement: schema.autoIncrement });
          for (const index of schema.indexes) store.createIndex(index.name, index.keyPath, { unique: index.unique, multiEntry: index.multiEntry });
        }
      });
    } catch (error) { await deleteDatabase(stageDbName); throw error; }

    async function cleanup() {
      state = "aborted";
      db?.close(); db = null;
      localStorageEntries.length = 0;
      await deleteDatabase(stageDbName);
    }
    function ensureOpen() { if (state !== "open") throw failure || new DOMException("Stage writer is closed", "InvalidStateError"); }
    async function consume(record) {
      ensureOpen();
      if (!record || record.type !== record.source || !Object.hasOwn(record, "key") || !Object.hasOwn(record, "value")) fail("CHECKSUM_MISMATCH");
      if (record.source === "localStorage") {
        if (!isOwnedLocalStorageKey(record.key) || !expectedLocalKeys.has(record.key) || typeof record.value !== "string") fail("UNSUPPORTED_VERSION");
        if (localKeys.has(record.key)) fail("DUPLICATE_ENTRY");
        localKeys.add(record.key); localStorageEntries.push({ key: record.key, value: record.value });
      } else if (record.source === "indexedDB") {
        if (!storeCounts.has(record.store)) fail("UNSUPPORTED_VERSION");
        try { global.indexedDB.cmp(record.key, record.key); } catch { fail("CHECKSUM_MISMATCH"); }
        await transactionResult(db, record.store, "readwrite", (tx, result, abort) => {
          const store = tx.objectStore(record.store);
          if (store.keyPath !== null) {
            const extract = path => path === "" ? record.value : path.split(".").reduce((value, part) => value == null ? undefined : value[part], record.value);
            const inlineKey = Array.isArray(store.keyPath) ? store.keyPath.map(extract) : extract(store.keyPath);
            // Never allow an autoIncrement store to insert a missing inline key:
            // the archive already contains both the exact value and primary key.
            try { if (global.indexedDB.cmp(inlineKey, record.key) !== 0) fail("CHECKSUM_MISMATCH"); }
            catch { fail("CHECKSUM_MISMATCH"); }
          }
          const request = store.keyPath === null ? store.add(record.value, record.key) : store.add(record.value);
          request.onsuccess = () => {
            if (global.indexedDB.cmp(request.result, record.key) !== 0) abort(new global.YutoriBackupArchive.ArchiveFormatError("CHECKSUM_MISMATCH"));
          };
        });
        storeCounts.set(record.store, storeCounts.get(record.store) + 1);
      } else fail("UNSUPPORTED_VERSION");
      increment(counts, record.source);
    }
    function enqueue(operation) {
      const pending = queue.then(operation).catch(async error => {
        failure = error;
        if (state !== "finalized") await cleanup();
        throw error;
      });
      queue = pending.catch(() => {});
      return pending;
    }
    const onRecord = record => enqueue(() => consume(record));
    const finalize = () => enqueue(() => {
      ensureOpen();
      for (const type of ["localStorage", "indexedDB"]) if ((counts[type] || 0) !== (manifest.counts[type] || 0)) fail("CHECKSUM_MISMATCH");
      for (const schema of manifest.indexedDB.stores) if (storeCounts.get(schema.name) !== schema.count) fail("CHECKSUM_MISMATCH");
      db.close(); db = null; state = "finalized";
      return { stageDbName, manifest, summary: summarize(localStorageEntries, counts, manifest.indexedDB.stores), localStorageEntries: localStorageEntries.slice() };
    });
    const abort = async () => { await queue; if (state !== "finalized") await cleanup(); };
    return Object.freeze({ onRecord, finalize, abort });
  }

  async function createStageFromArchive(validatedArchive) {
    const writer = await createStageWriter(validatedArchive.manifest);
    try { for await (const record of validatedArchive.records) await writer.onRecord(record); return await writer.finalize(); }
    catch (error) { await writer.abort(); throw error; }
  }

  const sortedEntries = entries => entries.slice().sort((a, b) => a.key < b.key ? -1 : a.key > b.key ? 1 : 0);
  const hashJson = async value => [...new Uint8Array(await global.crypto.subtle.digest("SHA-256", new TextEncoder().encode(JSON.stringify(value))))].map(n => n.toString(16).padStart(2, "0")).join("");
  function validateEntries(entries) {
    const keys = new Set();
    for (const entry of entries) {
      if (!isOwnedLocalStorageKey(entry.key) || typeof entry.value !== "string" || keys.has(entry.key)) fail("CHECKSUM_MISMATCH");
      keys.add(entry.key);
    }
  }
  function applyOwnedLocalStorage(entries) {
    validateEntries(entries);
    for (const { key } of collectLocalStorageEntries()) global.localStorage.removeItem(key);
    for (const { key, value } of entries) global.localStorage.setItem(key, value);
    if (JSON.stringify(collectLocalStorageEntries()) !== JSON.stringify(sortedEntries(entries))) fail("CHECKSUM_MISMATCH");
  }
  async function getRestoreJournal() {
    const db = await openMetaDb();
    try { return await transactionResult(db, "journals", "readonly", (tx, result) => {
      const request = tx.objectStore("journals").get("restore"); request.onsuccess = () => result(request.result || null);
    }); } finally { db.close(); }
  }
  const verifiedSafetyTransitions = new WeakSet();
  async function commitJournal(journal, descriptor, remove = false) {
    const db = await openMetaDb();
    try { return await transactionResult(db, ["settings", "journals"], "readwrite", (tx, result, abort) => {
      const store = tx.objectStore("journals"), request = store.get("restore");
      request.onsuccess = () => {
        try {
          const safetyTransition = verifiedSafetyTransitions.has(journal) && journal.phase === "recovering-safety" && journal.id === request.result?.id && journal.failedTarget.name === request.result.targetDescriptor.name && journal.targetHash === request.result.oldHash;
          if (request.result?.phase === "finalizing" && !safetyTransition && (!remove && journal.phase !== "finalizing" || descriptor && descriptor.name !== request.result.targetDescriptor.name)) throw new DOMException("Finalized target is authoritative", "InvalidStateError");
          if (descriptor) tx.objectStore("settings").put(validateDescriptor(descriptor), "activeDataDb");
          if (remove) store.delete("restore"); else store.put(journal, "restore");
          result(journal);
        } catch (error) { abort(error); }
      };
    }); } finally { db.close(); }
  }
  const setRestorePhase = (journal, phase) => commitJournal({ ...journal, phase });
  function switchActiveDataDb(descriptor, journal) {
    if (!journal || descriptor.name !== journal.targetDescriptor.name || descriptor.version !== journal.targetDescriptor.version) throw new TypeError("Journal target required");
    return commitJournal({ ...journal, phase: "pointer-switched" }, descriptor);
  }
  async function dataIdentity(descriptor, manifest, entries) {
    validateDescriptor(descriptor); validateManifest(manifest); validateEntries(entries);
    if (JSON.stringify(entries.map(e => e.key).sort()) !== JSON.stringify(manifest.localStorageKeys.slice().sort())) fail("CHECKSUM_MISMATCH");
    // Opening a vanished DB must never silently recreate it as a valid empty DB.
    const db = await openDatabase(descriptor.name, descriptor.version, () => fail("CHECKSUM_MISMATCH"));
    try {
      const normalize = schemas => schemas.map(s => ({ name: s.name, keyPath: s.keyPath, autoIncrement: s.autoIncrement, count: s.count,
        indexes: s.indexes.map(i => ({ name: i.name, keyPath: i.keyPath, unique: i.unique, multiEntry: i.multiEntry })).sort((a,b) => a.name.localeCompare(b.name)) })).sort((a,b) => a.name.localeCompare(b.name));
      if (JSON.stringify(normalize(await readSchema(db))) !== JSON.stringify(normalize(manifest.indexedDB.stores))) fail("CHECKSUM_MISMATCH");
    } finally { db.close(); }
    // Re-hash all logical values and Blob chunks using bounded streaming IO.
    // No data is copied between databases; the stage itself becomes active.
    const records = (async function* () {
      for (const entry of sortedEntries(entries)) yield { type: "localStorage", source: "localStorage", ...entry };
      yield* dataRecords(descriptor, manifest.indexedDB.stores.slice().sort((a,b) => a.name.localeCompare(b.name)));
    })();
    const digests = [await hashJson(manifest)];
    for await (const record of records) {
      const encoded = await global.YutoriBackupArchive.serializeStructuredValue(record);
      digests.push(await hashJson(encoded.jsonValue));
      for (const { blob } of encoded.attachments) {
        for (let offset = 0; offset < blob.size; offset += 1024 * 1024) {
          digests.push([...new Uint8Array(await global.crypto.subtle.digest("SHA-256", await blob.slice(offset, offset + 1024 * 1024).arrayBuffer()))].map(n => n.toString(16).padStart(2, "0")).join(""));
        }
      }
    }
    return hashJson(digests);
  }
  async function beginRestoreJournal({ candidate, safetyBackup, oldLocalStorage }) {
    if (await getRestoreJournal()) throw new DOMException("Recovery pending", "InvalidStateError");
    if (!safetyBackup?.verifiedAt || !/^[a-f0-9]{64}$/.test(safetyBackup.archiveHash) || !/^[a-f0-9]{64}$/.test(safetyBackup.manifestHash)) throw new TypeError("Verified safety proof required");
    const oldDescriptor = await getActiveDataDbDescriptor();
    const targetDescriptor = validateDescriptor({ name: candidate.stageDbName, version: candidate.manifest.indexedDB.version });
    if (targetDescriptor.name === oldDescriptor.name) throw new TypeError("Inactive stage required");
    const oldManifest = safetyBackup.manifest;
    const oldHash = await dataIdentity(oldDescriptor, oldManifest, oldLocalStorage);
    if (oldHash !== safetyBackup.dataHash) fail("CHECKSUM_MISMATCH");
    const targetHash = await dataIdentity(targetDescriptor, candidate.manifest, candidate.localStorageEntries);
    const journal = { id: global.crypto.randomUUID(), phase: "staged", oldDescriptor, targetDescriptor,
      oldLocalStorage: structuredClone(oldLocalStorage), oldManifest, oldHash,
      targetManifest: candidate.manifest, targetManifestHash: await hashJson(candidate.manifest), targetHash,
      targetLocalStorage: candidate.localStorageEntries, safetyBackup: { ...safetyBackup } };
    // Native FileSystemHandles are structured-cloneable; fallback test/UI handles
    // may not be. Keep the verified identity even when a handle cannot be saved.
    try { structuredClone(journal.safetyBackup); }
    catch (error) { if (error.name !== "DataCloneError") throw error; journal.safetyBackup.handle = null; }
    return commitJournal(journal);
  }
  async function validateRestoreTarget(journal) {
    if (await hashJson(journal.targetManifest) !== journal.targetManifestHash ||
        await dataIdentity(journal.targetDescriptor, journal.targetManifest, journal.targetLocalStorage) !== journal.targetHash ||
        JSON.stringify(collectLocalStorageEntries()) !== JSON.stringify(sortedEntries(journal.targetLocalStorage))) fail("CHECKSUM_MISMATCH");
  }
  async function commitSafetyRecovery(journal) {
    const durable = await getRestoreJournal();
    if (!durable || durable.id !== journal.id || journal.phase !== "recovering-safety" ||
        journal.targetManifestHash !== durable.safetyBackup.manifestHash || journal.targetHash !== durable.oldHash ||
        await dataIdentity(journal.targetDescriptor, journal.targetManifest, journal.targetLocalStorage) !== durable.oldHash) fail("CHECKSUM_MISMATCH");
    if (durable.phase === "finalizing") {
      let valid = true;
      try { await validateRestoreTarget(durable); } catch { valid = false; }
      if (valid) throw new DOMException("Validated target remains authoritative", "InvalidStateError");
    }
    verifiedSafetyTransitions.add(journal);
    try { return await commitJournal(journal); } finally { verifiedSafetyTransitions.delete(journal); }
  }
  async function deleteInactive(descriptor) {
    validateDescriptor(descriptor);
    if ((await getActiveDataDbDescriptor()).name === descriptor.name) throw new DOMException("Database is active", "InvalidStateError");
    await deleteDatabase(descriptor.name);
  }
  async function rollbackRestore(journal) {
    const durable = await getRestoreJournal();
    if (!durable || durable.id !== journal.id || durable.phase === "finalizing") throw new DOMException("Rollback is no longer permitted", "InvalidStateError");
    journal = durable;
    // Persist intent first: a crash after restoring localStorage must not resume
    // the target merely because the prior phase said pointer-switched.
    journal = await setRestorePhase(journal, "rolling-back");
    if (await dataIdentity(journal.oldDescriptor, journal.oldManifest, journal.oldLocalStorage) !== journal.oldHash) fail("CHECKSUM_MISMATCH");
    applyOwnedLocalStorage(journal.oldLocalStorage);
    journal = await commitJournal({ ...journal, phase: "rolled-back" }, journal.oldDescriptor);
    await deleteInactive(journal.targetDescriptor);
    await commitJournal(journal, null, true);
  }
  async function finalizeRestore(journal) {
    const durable = await getRestoreJournal();
    if (!durable) return; // Journal removal already committed: cleanup is done.
    if (durable.id !== journal.id || !["pointer-switched", "reload-pending", "finalizing"].includes(durable.phase)) throw new DOMException("Target is not ready to finalize", "InvalidStateError");
    journal = durable;
    try { await validateRestoreTarget(journal); }
    catch (cause) { throw Object.assign(new Error("Restore target integrity could not be verified", { cause }), { name: "RestoreIntegrityError" }); }
    if ((await getActiveDataDbDescriptor()).name !== journal.targetDescriptor.name) fail("CHECKSUM_MISMATCH");
    // Validation completed after reload. Persist this before deleting the only
    // old database so cleanup can be retried after another crash.
    if (journal.phase !== "finalizing") journal = await setRestorePhase(journal, "finalizing");
    await deleteInactive(journal.oldDescriptor);
    if (journal.failedTarget && journal.failedTarget.name !== journal.targetDescriptor.name && journal.failedTarget.name !== journal.oldDescriptor.name) await deleteInactive(journal.failedTarget);
    await commitJournal(journal, null, true);
  }

  global.YutoriBackupStorage = Object.freeze({
    configure,
    isOwnedLocalStorageKey, collectLocalStorageEntries, openMetaDb, getDestinationMeta,
    saveDestinationMeta, clearDestinationHandle, getLastBackupMeta, getActiveDataDbDescriptor,
    saveActiveDataDbDescriptor, openActiveDataDb, createSnapshotRecordSource,
    createStageWriter, createStageFromArchive, deleteDatabase, deleteAllRestoreStagesExcept, deleteRestoreStage, reclaimAbandonedStages,
    beginRestoreJournal, getRestoreJournal, setRestorePhase, switchActiveDataDb, applyOwnedLocalStorage,
    rollbackRestore, finalizeRestore, validateRestoreTarget, dataIdentity, commitJournal, commitSafetyRecovery,
  });
})(globalThis);
