# YUTORI Full Data Backup Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a reusable single-file backup and full-replacement restore flow that preserves all YUTORI-owned localStorage data, original PDFs, rendered PDF pages, grading sessions, and results.

**Architecture:** Add a gzip-compressed, checksummed NDJSON archive codec, a browser-storage layer that owns YUTORI data discovery and active IndexedDB selection, and a coordinator/UI layer for file permissions, progress, safety backups, restore journaling, and recovery. Restore imports the binary database into a shadow database and switches an active-database pointer only after validation, while localStorage changes are journaled so interruption can roll back without merging datasets.

**Tech Stack:** Vanilla HTML/CSS/JavaScript, IndexedDB, localStorage, File System Access API, Web Streams, CompressionStream/DecompressionStream, Web Crypto SHA-256, Node test runner, Playwright Chromium, Service Worker cache.

**Spec:** `docs/superpowers/specs/2026-10-13-full-data-backup-design.md`

## Global Constraints

- Official targets are current Chrome/Edge on Chromebook and Windows.
- The normal school-managed Chromebook destination is Google Drive; YUTORI must not attempt to bypass the school's USB prohibition.
- Windows and other permitted devices may use Google Drive sync storage or a writable USB device.
- Backup filename defaults to `YUTORI_全データバックアップ.yutori`; pre-restore safety backup defaults to `YUTORI_復元前バックアップ_YYYYMMDD_HHmm.yutori`.
- Backup format version starts at `1`; unknown newer versions are rejected before live data changes.
- Backup includes only YUTORI-owned `yutori_` localStorage keys, registered legacy YUTORI keys, and all stores in the active YUTORI data database.
- `YUTORI_BACKUP_META`, file handles, restore staging databases, journals, browser caches, and other applications' storage are excluded.
- Restore is full replacement only; merge/sync, automatic backup, generation rotation, and encryption are out of scope.
- A verified pre-restore safety backup is mandatory before enabling full replacement.
- A backup success message means the selected file was written and read back successfully; it does not claim Google Drive cloud sync has completed.
- If a remembered destination is missing or unavailable, stop and ask for reconnection/reselection; never silently switch to Downloads.
- Backup and restore contents must never be sent over the network or written to console logs.
- Release version for this feature is `v0.3.51`.

## Review Focus

- Remembered Google Drive/USB handle is unavailable before or during write: preserve the previous success metadata and show a reconnect/reselect action (Task 3 tests).
- Archive contains duplicate localStorage keys, duplicate IndexedDB keys, or a schema collision: reject it during inspection before safety export or replacement (Task 5 tests).
- Browser quota is exhausted while staging or switching databases: keep the active database pointer and live localStorage unchanged, and clean the incomplete stage (Tasks 5 and 6 tests).
- Browser is interrupted after localStorage application but before restore finalization: use the journal on next startup to complete or roll back before normal UI initialization (Task 6 tests).
- Backup contains Unicode names plus Blob, File, ArrayBuffer, typed-array, and Date values split across multiple chunks: round-trip every supported value without loss (Task 1 tests).

---

## File Structure

- Create `assets/yutori-backup-archive.js`: archive framing, stable structured-value serialization, binary chunking, gzip compression, SHA-256 checks, archive parsing, and format validation; no DOM access.
- Create `assets/yutori-backup-storage.js`: YUTORI storage registry, meta database, active data-database pointer, snapshot cursor sources, staging database creation, journal persistence, and cleanup; no presentation logic.
- Create `assets/yutori-backup.js`: destination selection, permission handling, backup/restore coordination, progress events, fallback download, UI event handlers, and startup recovery orchestration.
- Create `assets/backup.svg`: header/settings backup icon following the existing rounded pastel icon style.
- Modify `index.html`: load the three scripts, add header button/tooltip, settings panel, progress/restore modals, styles, persistence integration hooks, async startup recovery, and active-database-aware `openYutoriDb()`.
- Modify `sw.js`: cache the new scripts/icon and change the cache version to `yutori-v0.3.51`.
- Modify `README.md`: document v0.3.51 backup behavior, supported destinations, full-replacement restore, personal-data warning, and Google Drive sync boundary.
- Create `tests/helpers/yutori-browser.mjs`: shared local HTTP server and Playwright browser/page setup for backup tests only.
- Create `tests/backup-archive.test.mjs`: codec, type preservation, chunking, corruption, truncation, and version tests.
- Create `tests/backup-storage.test.mjs`: data ownership, active database, meta store, snapshot, and stage cleanup tests.
- Create `tests/backup-save-ui.test.mjs`: header/settings UI, permissions, first/repeat save, tooltip, fallback, unavailable destination, and concurrency tests.
- Create `tests/backup-restore.test.mjs`: inspection, safety export, full replacement, rollback, startup recovery, and foreign-storage preservation tests.

### Task 1: Versioned Streaming Archive Codec

**Files:**
- Create: `assets/yutori-backup-archive.js`
- Create: `tests/helpers/yutori-browser.mjs`
- Create: `tests/backup-archive.test.mjs`

**Interfaces:**
- Produces: `window.YutoriBackupArchive.FORMAT_VERSION === 1`.
- Produces: `createArchiveStream(manifest, records, options) -> ReadableStream<Uint8Array>` where `records` is an async iterable of `{type, ...payload}` and `options` accepts `{chunkBytes, onProgress}`.
- Produces: `readArchiveStream(source, handlers, options) -> Promise<ValidatedArchive>` where `source` is `Blob | ReadableStream<Uint8Array>`, `handlers.onRecord(record)` consumes validated logical records, and the return value contains `{manifest, counts, totalBytes, archiveHash}`.
- Produces: `serializeStructuredValue(value) -> Promise<{jsonValue, attachments}>` and `deserializeStructuredValue(jsonValue, attachments) -> Promise<unknown>` preserving Blob, File, ArrayBuffer, typed arrays, and Date.
- Produces: `ArchiveFormatError` with stable codes `BAD_MAGIC`, `UNSUPPORTED_VERSION`, `TRUNCATED`, `CHECKSUM_MISMATCH`, and `DUPLICATE_ENTRY`.

- [ ] **Step 1: Write the failing archive round-trip and failure tests**

Add Playwright tests named:

```js
test("format 1 round-trips Unicode and structured browser values across multiple chunks", async () => {
  // Use a binary payload larger than two 1 MiB chunks.
  // Assert Japanese names, Blob/File metadata, Date, ArrayBuffer, and typed-array bytes are identical.
});

test("truncation, a changed chunk checksum, duplicate entries, and format 2 are rejected", async () => {
  // Assert the five stable ArchiveFormatError codes.
});
```

Also assert that an archive created by an older app version such as `v0.3.40` is accepted when its backup format is still version 1.

The helper must serve repository files, launch the existing Playwright Chromium/Chrome fallback, block Service Workers, and expose a fresh page per test without modifying existing helpers.

- [ ] **Step 2: Run the focused test and confirm it fails**

Run: `node --test tests/backup-archive.test.mjs`

Expected: FAIL because `assets/yutori-backup-archive.js` and `window.YutoriBackupArchive` do not exist.

- [ ] **Step 3: Implement the archive codec**

Use gzip-compressed NDJSON. The decompressed first record is a header with `magic: "YUTORI-BACKUP"` and `formatVersion: 1`; the last is an end record containing logical counts and a SHA-256 digest over the ordered record-digest list. Encode binary attachments in 1 MiB base64 chunks by default, with a SHA-256 per chunk. Stable-serialize JSON object keys so record checksums are reproducible.

Keep all work streaming: no call may concatenate all PDF/image bytes into one `ArrayBuffer`. A single chunk may be materialized for `crypto.subtle.digest()`.

- [ ] **Step 4: Run the archive tests and confirm they pass**

Run: `node --test tests/backup-archive.test.mjs`

Expected: PASS with no unhandled page errors.

- [ ] **Step 5: Commit the archive codec**

```bash
git add assets/yutori-backup-archive.js tests/helpers/yutori-browser.mjs tests/backup-archive.test.mjs
git commit -m "feat: add YUTORI backup archive codec"
```

### Task 2: YUTORI-Owned Storage Registry and Metadata

**Files:**
- Create: `assets/yutori-backup-storage.js`
- Create: `tests/backup-storage.test.mjs`
- Modify: `index.html:3962-3964` (script order only in this task)

**Interfaces:**
- Consumes: `YutoriBackupArchive.serializeStructuredValue()` from Task 1.
- Produces: `YutoriBackupStorage.isOwnedLocalStorageKey(key) -> boolean`.
- Produces: `collectLocalStorageEntries(storage) -> Array<{key, value}>`, sorted by key.
- Produces: `openMetaDb() -> Promise<IDBDatabase>` for `YUTORI_BACKUP_META` version 1 with stores `settings` and `journals`.
- Produces: `getDestinationMeta()`, `saveDestinationMeta(meta)`, `clearDestinationHandle()`, and `getLastBackupMeta()`; the meta database is never included in a snapshot.
- Produces: `getActiveDataDbDescriptor() -> Promise<{name, version}>`, defaulting to `{name: "YUTORI_DB", version: 2}`.
- Produces: `openActiveDataDb(upgradeCallback) -> Promise<IDBDatabase>`.
- Produces: `createSnapshotRecordSource({appVersion, createdAt}) -> Promise<{manifest, records}>`; `records` is an async iterable over owned localStorage and every store in the active data database.
- Produces: `createStageFromArchive(validatedArchive) -> Promise<{stageDbName, manifest, summary}>`, `deleteDatabase(name)`, and `deleteAllRestoreStagesExcept(name?)`.

- [ ] **Step 1: Write failing ownership, metadata, active database, and snapshot tests**

Add tests asserting:

```js
assert.equal(isOwnedLocalStorageKey("yutori_saved_tests_v1"), true);
assert.equal(isOwnedLocalStorageKey("mitori_grades"), false);
assert.equal(isOwnedLocalStorageKey("unrelated"), false);
```

Also assert that:

- a real OPFS `FileSystemFileHandle` can be stored/retrieved through `YUTORI_BACKUP_META` in Chromium;
- destination metadata and journals are absent from snapshot records;
- the default descriptor opens existing `YUTORI_DB` stores `pdfFiles` and `pdfPages`;
- changing the active descriptor makes subsequent opens use the shadow database;
- a quota/staging failure deletes the incomplete stage and does not alter the active descriptor;
- all stores and key paths in the active database appear in the manifest.

- [ ] **Step 2: Run the storage test and confirm it fails**

Run: `node --test tests/backup-storage.test.mjs`

Expected: FAIL because `window.YutoriBackupStorage` is undefined.

- [ ] **Step 3: Implement the registry, meta DB, snapshot cursors, and staging helpers**

Owned localStorage is exactly keys beginning with `yutori_` plus an explicit `LEGACY_LOCAL_STORAGE_KEYS` set for any historical YUTORI keys found in `index.html`. Do not use “all keys for this origin.” Enumerate active database records with cursors and close each database/transaction deterministically.

Staging database names use `YUTORI_RESTORE_STAGE_<uuid>`. Store schema comes from the validated manifest (`name`, `keyPath`, `autoIncrement`); reject duplicate store definitions or unsupported schema before creation.

- [ ] **Step 4: Load archive/storage scripts and run both focused suites**

Load scripts in this order before the existing inline application script:

```html
<script src="assets/yutori-backup-archive.js"></script>
<script src="assets/yutori-backup-storage.js"></script>
```

Run: `node --test tests/backup-archive.test.mjs tests/backup-storage.test.mjs`

Expected: PASS.

- [ ] **Step 5: Commit the storage layer**

```bash
git add assets/yutori-backup-storage.js tests/backup-storage.test.mjs index.html
git commit -m "feat: register YUTORI backup storage"
```

### Task 3: Reusable Backup Saving and Destination UI

**Files:**
- Create: `assets/yutori-backup.js`
- Create: `assets/backup.svg`
- Create: `tests/backup-save-ui.test.mjs`
- Modify: `index.html:1692-1740, 3258-3273, 3431-3438, 3832-3898, 3962-3964, 4158-4175`

**Interfaces:**
- Consumes: `YutoriBackupArchive.createArchiveStream()` and `readArchiveStream()`.
- Consumes: snapshot and destination-meta APIs from Task 2.
- Produces: `YutoriBackup.configure({appVersion, waitForIdle, openDataDb, reload, now, pickSaveFile, pickOpenFile, downloadBlob})` for production defaults and test injection.
- Produces: `initialize() -> Promise<void>`, `savePrimaryBackup()`, `changeDestination()`, `saveSafetyBackup()`, `renderStatus()`, and `getOperationState()`.
- Produces: UI globals `saveYutoriBackup()`, `changeYutoriBackupDestination()`, and `showBackupSettings()` used by inline buttons.

- [ ] **Step 1: Write failing save and UI tests**

Add tests covering:

- header backup button exists beside Home/Settings, has accessible name `バックアップ保存`, and its tooltip initially says no backup exists;
- settings navigation has `バックアップ設定` and the panel shows filename, last successful time, size, privacy warning, Google Drive/USB guidance, save/change/restore actions;
- first save asks injected picker for default name `YUTORI_全データバックアップ.yutori`, stores the handle, writes and reads back the archive, then renders the fixed clock value;
- second save reuses the same handle without invoking the picker;
- `prompt` requests permission from the button gesture, while `denied` preserves previous success metadata;
- a handle that disappears before or during write shows reconnection/reselection and never downloads elsewhere;
- API absence triggers exactly one `.yutori` download per click and does not claim a remembered destination;
- hover/focus tooltip contains last successful timestamp and filename, while a failed later save leaves it unchanged.
- the UI never displays a full local path, shows item/byte progress through all four save phases, and renders the verified file size;
- changing destination replaces the remembered handle only after a successful save to the newly selected file.

Use OPFS file handles for real read/write tests and injected adapters only for permission/error branches.

- [ ] **Step 2: Run the save/UI suite and confirm it fails**

Run: `node --test tests/backup-save-ui.test.mjs`

Expected: FAIL because the coordinator, icon, and controls do not exist.

- [ ] **Step 3: Implement destination handling and header/settings UI**

Acquire/select/request file permission synchronously from the user click before starting asynchronous snapshot work. Pipe the archive stream to `FileSystemWritableFileStream`; close it, reopen with `handle.getFile()`, and fully validate before updating `lastSuccessfulAt`, `fileName`, and `size`.

Add a reusable progress modal with phases `準備`, `データ収集`, `圧縮・保存`, and `保存内容の確認`. The header tooltip uses a custom accessible tooltip for hover/focus and also updates the button `title`. The settings panel always shows the same status for touch users.

- [ ] **Step 4: Run focused and existing UI suites**

Run: `node --test tests/backup-save-ui.test.mjs tests/question-mode.test.mjs`

Expected: PASS; existing header/test-list behavior is unchanged.

- [ ] **Step 5: Commit reusable backup saving**

```bash
git add assets/yutori-backup.js assets/backup.svg tests/backup-save-ui.test.mjs index.html
git commit -m "feat: save complete YUTORI backups"
```

### Task 4: Persistence Quiescence and Operation Exclusion

**Files:**
- Modify: `assets/yutori-backup.js`
- Modify: `index.html:5400-5550, 6373, 6489-6529, 6603-6635`
- Modify: `tests/backup-save-ui.test.mjs`

**Interfaces:**
- Produces: `trackPersistence(promise, label) -> Promise<T>` and `waitForPersistenceIdle() -> Promise<void>`.
- Produces: `runExclusiveOperation(kind, callback) -> Promise<T>` with kinds `pdf-import`, `backup`, and `restore`.
- `YutoriBackup.configure().waitForIdle` consumes `waitForPersistenceIdle`.

- [ ] **Step 1: Add failing concurrency tests**

Test that a backup started while an injected PDF-page write is unresolved remains in `準備`, writes no bytes, and starts only after the write resolves. Test two rapid backup clicks produce one write. Test `pdf-import` and `restore` cannot begin while backup owns the exclusive lock.

- [ ] **Step 2: Run the concurrency cases and confirm they fail**

Run: `node --test --test-name-pattern="waits|double|exclusive" tests/backup-save-ui.test.mjs`

Expected: FAIL because current IndexedDB/PDF operations are untracked.

- [ ] **Step 3: Add the shared persistence tracker and wrap existing asynchronous writes**

Wrap `processPdf()`, `savePdfFilesToIndexedDB()`, `saveAdditionalPdfFileToIndexedDB()`, `savePdfPageToIndexedDB()`, and `deleteSessionAssetsFromIndexedDB()` without changing their returned values or existing alerts. Backup acquires the exclusive lock after waiting for registered persistence promises, and the modal prevents new mutating UI gestures until release.

Keep synchronous localStorage writes unchanged; the exclusive modal prevents user-driven writes during snapshot enumeration.

- [ ] **Step 4: Run PDF/grading and backup suites**

Run: `node --test tests/backup-save-ui.test.mjs tests/question-mode.test.mjs tests/grading-tile-layout.test.mjs`

Expected: PASS.

- [ ] **Step 5: Commit persistence coordination**

```bash
git add assets/yutori-backup.js index.html tests/backup-save-ui.test.mjs
git commit -m "feat: coordinate backups with YUTORI persistence"
```

### Task 5: Restore Inspection and Mandatory Safety Export

**Files:**
- Create: `tests/backup-restore.test.mjs`
- Modify: `assets/yutori-backup.js`
- Modify: `assets/yutori-backup-storage.js`
- Modify: `index.html` (backup settings and restore modal markup/styles)

**Interfaces:**
- Consumes: `readArchiveStream()` and staging APIs.
- Produces: `inspectRestoreFile(file) -> Promise<RestoreCandidate>` with `{stageDbName, manifest, summary, localStorageEntries}`.
- Produces: `discardRestoreCandidate(candidate) -> Promise<void>`.
- Produces: `saveSafetyBackup(candidate) -> Promise<{handle, fileName, manifestHash, verifiedAt}>`.
- Produces: `getRestoreUiState() -> {phase, candidate, safetyBackup, canReplace}` where `canReplace` is true only after verified safety export plus the confirmation checkbox.

- [ ] **Step 1: Write failing inspection and safety-gate tests**

Test that:

- valid backup inspection shows created time, source app version, test/class/grading-session/PDF/page counts, and size;
- corrupted, truncated, unknown-version, duplicate localStorage key, duplicate IndexedDB key, and store-schema collision files are rejected before current data changes;
- staging quota failure deletes the stage and leaves the active descriptor/live storage untouched;
- full replacement remains disabled before safety export, after a cancelled export, and after failed read-back validation;
- successful verified safety export plus checked confirmation enables replacement;
- cancelling the modal deletes only its stage and leaves all live YUTORI and foreign keys untouched.
- a browser without File System Access can select the restore source through `<input type="file">`; its generated safety Blob is validated before the fallback download is offered.

- [ ] **Step 2: Run restore tests and confirm they fail**

Run: `node --test tests/backup-restore.test.mjs`

Expected: FAIL because restore inspection and modal state do not exist.

- [ ] **Step 3: Implement restore inspection, summary, and mandatory safety export**

The restore file picker is reachable only from Backup Settings. Parse and import to the stage while validating all checksums/counts. Render the summary before offering `復元前バックアップを保存`. The final `全データを置き換えて復元` control stays disabled until the saved safety archive has itself been read back and validated and the user checks `現在のデータがすべて置き換わることを確認しました`.

The safety export must use a separate handle from the restore source. Do not reuse or overwrite the selected restore file or primary destination automatically.

- [ ] **Step 4: Run archive, storage, save, and inspection suites**

Run: `node --test tests/backup-archive.test.mjs tests/backup-storage.test.mjs tests/backup-save-ui.test.mjs tests/backup-restore.test.mjs`

Expected: PASS for inspection/safety tests; replacement tests remain marked for Task 6 only if written with `test.todo`.

- [ ] **Step 5: Commit restore inspection**

```bash
git add assets/yutori-backup.js assets/yutori-backup-storage.js index.html tests/backup-restore.test.mjs
git commit -m "feat: inspect backups before YUTORI restore"
```

### Task 6: Journaled Full Replacement and Startup Recovery

**Files:**
- Modify: `assets/yutori-backup-storage.js`
- Modify: `assets/yutori-backup.js`
- Modify: `index.html:6603-6604, 7409-7462`
- Modify: `tests/backup-storage.test.mjs`
- Modify: `tests/backup-restore.test.mjs`

**Interfaces:**
- Produces: `beginRestoreJournal({candidate, safetyBackup, oldLocalStorage}) -> Promise<RestoreJournal>`.
- Produces: `switchActiveDataDb({name, version})`, `applyOwnedLocalStorage(entries)`, `rollbackRestore(journal)`, and `finalizeRestore(journal)`.
- Produces: `replaceWithCandidate(candidate, safetyBackup) -> Promise<void>`.
- Produces: `recoverInterruptedRestore() -> Promise<{status: "none" | "completed" | "rolled-back" | "needs-safety-file", message?: string}>`.
- Existing `openYutoriDb()` changes to delegate to `YutoriBackupStorage.openActiveDataDb(upgradeYutoriDbSchema)` while keeping all callers unchanged.

- [ ] **Step 1: Activate failing full-replacement and interruption tests**

Assert a successful restore:

- replaces every owned localStorage key but leaves `mitori_fixture` and `unrelated_fixture` unchanged;
- changes `openYutoriDb()` to the fully imported shadow DB without loading all blobs at once;
- restores PDF Blob bytes/page metadata and grading-session values exactly;
- preserves the local primary-backup destination instead of importing one from the archive;
- reloads only after target counts match the manifest.

Add injected-failure tests at phases `staged`, `local-storage-applied`, `pointer-switched`, and `reload-pending`. Before pointer switch, the old database remains active; after a simulated reload, `recoverInterruptedRestore()` must either finish the validated switch or restore the old pointer/localStorage before normal initialization. A quota error during replacement must not select the incomplete stage.

- [ ] **Step 2: Run replacement tests and confirm they fail**

Run: `node --test --test-name-pattern="replacement|interrupted|quota|foreign" tests/backup-restore.test.mjs`

Expected: FAIL because live replacement/journal recovery are not implemented.

- [ ] **Step 3: Implement shadow-database switching and journaled localStorage replacement**

Record old descriptor, new descriptor, the complete old owned-localStorage map, safety handle metadata, target manifest hash, and phase in `YUTORI_BACKUP_META.journals`. Apply target localStorage while the old data DB remains active, then atomically update the active descriptor in one meta-DB transaction. Never clear/copy the live binary database record-by-record; the validated stage becomes the active DB.

On successful post-reload validation, delete the old inactive DB and journal. On an early failure, restore old owned localStorage and keep the old pointer. If recovery cannot access the safety file when needed, block normal app interaction and show a `復元前バックアップを選んで回復` action.

- [ ] **Step 4: Make application startup wait for recovery**

Refactor lines 7416-7462 into:

```js
async function initializeYutoriApp(){
  await YutoriBackup.recoverBeforeAppStart();
  // existing initialization, reads, renders, and showScreen call in original order
}
initializeYutoriApp().catch(showYutoriStartupError);
```

Split current database schema creation into `upgradeYutoriDbSchema(db)` and keep `openYutoriDb()` as the compatibility wrapper consumed by all existing PDF functions.

- [ ] **Step 5: Run all backup and existing regression tests**

Run: `node --test tests/*.test.mjs`

Expected: PASS with zero failures and no unhandled browser errors.

- [ ] **Step 6: Commit safe full replacement**

```bash
git add assets/yutori-backup-storage.js assets/yutori-backup.js index.html tests/backup-storage.test.mjs tests/backup-restore.test.mjs
git commit -m "feat: restore complete YUTORI snapshots safely"
```

### Task 7: PWA Cache, Version, Documentation, and Real-Browser Verification

**Files:**
- Modify: `index.html:10, 3259-3262`
- Modify: `sw.js:1-18`
- Modify: `README.md`
- Test: all files under `tests/`

**Interfaces:**
- Consumes: all backup APIs from Tasks 1-6.
- Produces: release-ready `v0.3.51` files; no new JavaScript interface.

- [ ] **Step 1: Add failing release metadata/cache assertions**

Extend `tests/backup-save-ui.test.mjs` to assert:

```js
assert.match(await page.title(), /YUTORI v0\.3\.51/);
assert.equal(await page.locator(".brand-version").textContent(), "v0.3.51");
```

Read `sw.js` in the test and assert cache name `yutori-v0.3.51` plus all three backup scripts and `assets/backup.svg` in `APP_SHELL`.

- [ ] **Step 2: Run release assertions and confirm they fail**

Run: `node --test --test-name-pattern="v0.3.51|APP_SHELL" tests/backup-save-ui.test.mjs`

Expected: FAIL while the application still reports v0.3.50.

- [ ] **Step 3: Bump version, cache assets, and document behavior**

Update HTML title/brand/accessible label to v0.3.51, set `CACHE_NAME="yutori-v0.3.51"`, and add the new scripts/icon to `APP_SHELL` in dependency order. README must explain the two standard destination patterns, manual-only backups, the `.yutori` personal-data contents, tooltip meaning, full-replacement restore, mandatory safety backup, fallback downloads, and that “保存完了” is not Google Drive cloud-sync confirmation.

- [ ] **Step 4: Run the full automated suite**

Run: `node --test tests/*.test.mjs`

Expected: PASS with zero failures.

- [ ] **Step 5: Run manual Chrome/Edge acceptance checks**

Use a non-production fixture profile and verify:

1. First save to Chromebook Google Drive; repeated header save overwrites the same file after permission confirmation if shown.
2. Google Drive unavailable: prior tooltip timestamp remains and no Downloads fallback occurs.
3. Windows save to writable USB; remove it and confirm actionable error, then reconnect and retry.
4. Move one `.yutori` file to another browser profile/device; inspect summary, create/verify safety backup, restore, and compare tests/classes/grading/PDF counts.
5. Corrupt a copy of the file and confirm restore stops before the safety-export/replacement stage.
6. Confirm Backup Settings remains usable by touch and keyboard and that hover/focus tooltip matches the last verified write.

Record browser/OS versions and results in the implementation handoff; do not claim Google Drive cloud sync from YUTORI's completion state.

- [ ] **Step 6: Commit release-ready metadata and documentation**

```bash
git add index.html sw.js README.md tests/backup-save-ui.test.mjs
git commit -m "release: prepare YUTORI v0.3.51 backup support"
```

- [ ] **Step 7: Verify repository state**

Run: `git status --short --branch`

Expected: clean feature worktree/branch with commits from Tasks 1-7. Do not push or deploy until the user separately authorizes publication.

### Task 8: Restore-Safe Counts and Collection Shapes

User authorized this follow-up on 2026-10-14 after reviewing the remaining security findings. Continue from `b81d87ada000f0c2901be3e698fc4fded7d7fb80`; do not repeat Tasks 1-7.

**Files:**
- Modify: `index.html` (class settings, grading resume, result-output cards, and directly related count helpers)
- Modify: `tests/backup-restore.test.mjs` or create a focused restore-security test file using the existing real-browser harness
- This approved plan addendum belongs in the fix commit.

**Requirements:**
- Fix the remaining archive-to-executable-HTML paths at current lines 6271, 6470, and 7008. Treat questions and rosters as arrays only after `Array.isArray`; validate related collection shapes before traversing. Never render an arbitrary object `.length` as a numeric count.
- Derived count fields must be finite nonnegative integer values and must reach the UI through text-safe rendering. Validate the class-profile student-count fallback as well. Preserve valid existing arrays, counts, titles, and controls.
- Audit directly related archive-dependent count interpolations for the same wrong-shape input; repair equivalent sinks found in this bounded audit. Do not rewrite unrelated application features or silently alter archived raw storage.
- Use the established full archive inspection, real safety file, confirmation, replacement, actual reload, and normal UI navigation in security tests. At least three regression cases: forged `session.questions.length` in grading resume, forged roster `.length` in settings, and forged `session.questions.length` in graded result output. Use a foreign-storage sentinel and an execution sentinel. Assert no injected elements, no execution, sentinel preserved, application ready, and no unhandled page errors.
- Add well-formed data assertions proving correct counts and working ordinary controls. Include wrong-shaped null/primitive/object collections and hostile studentCount fallback where relevant; arbitrary malformed data must not become executable HTML.
- Follow TDD: reproduce the reported behavior before implementing; run focused tests while iterating, one complete suite before commit, syntax/inline-script parsing and whitespace checks. Record exact results in `task-8-report.md` under this plan's SDD workspace.
- Commit the reviewed fix to the existing feature branch. Do not merge, push, publish, or delete the worktree in this task.

**Acceptance:** Independent scoped review confirms all three known exploits and directly equivalent count sinks are closed, valid-data behavior remains correct, and no security-relevant finding remains open. After that the controller performs final verification and hands off the concrete result.
