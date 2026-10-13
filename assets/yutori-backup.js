(function (global) {
  "use strict";

  const DEFAULT_NAME = "YUTORI_全データバックアップ.yutori";
  const persistence = new Map(), operationQueue = [];
  let persistenceRevision = 0, operationOwner = null;
  let persistenceBlocked = false;

  function trackPersistence(promise, label) {
    const entry = { label: String(label || "persistence") };
    const tracked = Promise.resolve(promise).then(value => {
      persistence.delete(entry); return value;
    }, error => { persistence.delete(entry); throw error; });
    persistence.set(entry, tracked); persistenceRevision++;
    // Idle draining observes failures without exposing record contents. The
    // caller still receives the original rejection from the returned promise.
    tracked.catch(() => {});
    return tracked;
  }
  async function waitForPersistenceIdle() {
    global.flushYutoriAutoSaves?.();
    for (;;) {
      const revision = persistenceRevision;
      await Promise.allSettled([...persistence.values()]);
      // One microtask yield can leave deeper .then chains still registering
      // child writes. A task boundary drains the complete current microtask
      // checkpoint before the empty/revision check declares stable idle.
      await new Promise(resolve => global.setTimeout(resolve, 0));
      if (!persistence.size && revision === persistenceRevision) return;
    }
  }
  function pumpOperations() {
    if (operationOwner || !operationQueue.length) return;
    const entry = operationQueue.shift();
    entry.signal?.removeEventListener("abort", entry.abort);
    operationOwner = entry;
    let result;
    try { result = entry.callback(entry); }
    catch (error) { result = Promise.reject(error); }
    const finish = (settle, value) => {
      operationOwner = null; settle(value); pumpOperations();
    };
    Promise.resolve(result).then(value => finish(entry.resolve, value), error => finish(entry.reject, error));
  }
  function runExclusiveOperation(kind, callback, { signal } = {}) {
    if (!["pdf-import", "backup", "restore"].includes(kind)) return Promise.reject(new TypeError("Unknown operation kind"));
    const pending = new Promise((resolve, reject) => {
      if (persistenceBlocked) { reject(new DOMException("Reload required", "AbortError")); return; }
      if (signal?.aborted) { reject(signal.reason); return; }
      const entry = { kind, callback, resolve, reject, signal };
      entry.abort = () => {
        const index = operationQueue.indexOf(entry);
        if (index < 0) return; // Running callbacks own their safe cancellation boundary.
        operationQueue.splice(index, 1); signal.removeEventListener("abort", entry.abort); reject(signal.reason);
      };
      signal?.addEventListener("abort", entry.abort, { once: true });
      operationQueue.push(entry); pumpOperations();
    });
    pending.catch(() => {});
    return pending;
  }
  function invalidateOldPersistence() {
    persistenceBlocked = true;
    global.cancelYutoriAutoSaves?.();
    for (const entry of operationQueue.splice(0)) {
      entry.signal?.removeEventListener("abort", entry.abort);
      entry.reject(new DOMException("Restore discarded old pending work", "AbortError"));
    }
  }
  function runPersistenceOperation(callback, label, owner) {
    // Only the explicit token passed down an import's call graph permits nested
    // writes. A new unrelated caller must queue even while an import is active.
    if (owner && owner === operationOwner) return trackPersistence(callback(owner), label);
    return runExclusiveOperation("pdf-import", token => trackPersistence(callback(token), label));
  }
  function deferPersistenceWhileExclusive(callback, label) {
    if (persistenceBlocked) return true;
    if (!operationOwner || operationOwner.kind === "pdf-import") return false;
    runPersistenceOperation(callback, label).catch(() => {
      global.console?.warn("YUTORI deferred persistence failed", label);
    });
    return true;
  }
  Object.assign(global, { trackPersistence, waitForPersistenceIdle, runExclusiveOperation, runPersistenceOperation, deferPersistenceWhileExclusive });
  const options = {
    appVersion: "v0.3.51", waitForIdle: waitForPersistenceIdle, now: () => new Date(),
    pickSaveFile: typeof global.showSaveFilePicker === "function" ? settings => global.showSaveFilePicker(settings) : null,
    pickOpenFile: typeof global.showOpenFilePicker === "function" ? settings => global.showOpenFilePicker(settings) : null,
    openDataDb: () => global.YutoriBackupStorage.openActiveDataDb(), reload: () => global.location.reload(),
    downloadBlob: (blob, name) => {
      const url = URL.createObjectURL(blob), link = document.createElement("a");
      link.href = url; link.download = name; document.body.append(link); link.click(); link.remove();
      setTimeout(() => URL.revokeObjectURL(url), 60_000);
    },
  };
  let destination = null, ready = false, pending = null, activeOperation = null, generation = 0;
  let state = { busy: false, phase: "", itemsDone: 0, itemsTotal: 0, bytesDone: 0, bytesTotal: 0, canCancel: false };
  let restoreSession = null;
  const candidates = new WeakSet();
  const storage = () => global.YutoriBackupStorage;
  const codec = () => global.YutoriBackupArchive;
  const element = id => global.document?.getElementById(id);
  const filename = name => String(name || DEFAULT_NAME).split(/[\\/]/).at(-1);
  const count = counts => Object.values(counts || {}).reduce((sum, value) => sum + value, 0);
  const byteLabel = bytes => `${Number(bytes || 0).toLocaleString("ja-JP")} バイト`;
  function timeLabel(value) {
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? "—" : new Intl.DateTimeFormat("ja-JP", {
      year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false,
    }).format(date);
  }
  const setText = (id, text) => { const node = element(id); if (node) node.textContent = text; };

  function configure(configuration) { Object.assign(options, configuration); }
  async function initialize() {
    destination = await storage().getDestinationMeta();
    ready = true; renderStatus();
  }
  function renderStatus() {
    const successful = !!destination?.lastSuccessfulAt;
    const name = successful ? filename(destination.fileName) : "未設定";
    const mode = successful && !destination.handle ? "（ダウンロード・毎回保存）" : "";
    const status = successful ? `最終バックアップ: ${timeLabel(destination.lastSuccessfulAt)}\n${name}${mode}\n確認済み容量: ${byteLabel(destination.size)}` : "バックアップはまだ作成されていません";
    const button = element("backupSaveButton");
    if (button) { button.title = status; button.disabled = !ready || state.busy || !!restoreSession; button.setAttribute("aria-busy", String(state.busy)); }
    setText("backupTooltip", status);
    setText("backupFileName", `${name}${mode}`);
    setText("backupLastSaved", successful ? timeLabel(destination.lastSuccessfulAt) : "まだ保存していません");
    setText("backupSize", successful ? byteLabel(destination.size) : "—");
    global.document?.querySelectorAll("[data-backup-action]").forEach(button => { button.disabled = !ready || state.busy || !!restoreSession; });
  }
  function progress(phase, details = {}) {
    state = { ...state, phase, ...details };
    setText("backupProgressPhase", phase);
    setText("backupProgressItems", `${state.itemsDone} / ${state.itemsTotal || "—"} 件`);
    // The collection estimate is uncompressed; compressed bytes are never shown
    // against that estimate as if they were a reliable percentage.
    setText("backupProgressBytes", `${byteLabel(state.bytesDone)}${state.bytesTotal ? ` / ${byteLabel(state.bytesTotal)}` : ""}`);
    const cancel = element("backupCancelButton");
    if (cancel) cancel.disabled = !state.canCancel;
    global.document?.dispatchEvent(new CustomEvent("yutori-backup-progress", { detail: { ...state } }));
  }
  function notify(text, failed = false) {
    setText("backupMessage", text); setText("backupNoticeText", text);
    const notice = element("backupNotice");
    if (notice) { notice.hidden = false; notice.classList.toggle("backup-error", failed); }
  }
  function errorMessage(error) {
    if (error.name === "AbortError") return "バックアップをキャンセルしました。";
    if (error.name === "NotAllowedError" || error.name === "SecurityError") return "保存先への書き込みが許可されませんでした。もう一度「バックアップ保存」を押して許可してください。";
    if (error.name === "QuotaExceededError") return "保存先の空き容量が足りません。空き容量を増やすか、「保存先を変更」から別の場所を選んでください。";
    if (error.name === "BackupVerificationError") return "保存内容の確認に失敗しました。前回の成功日時は更新していません。保存先を確認し、もう一度保存してください。";
    return "保存先を利用できず、バックアップを保存できませんでした。Google ドライブや USB を再接続するか、「保存先を変更」から選び直してください。";
  }

  // Reusable IO boundary. No destination metadata, restore candidate, or gating
  // state belongs here. Task 5 can build its own safety-export flow on this API.
  async function writeVerifiedArchiveToHandle(handle, source, { onProgress = () => {} } = {}) {
    const total = count(source.manifest.counts);
    let writable, writtenBytes = 0;
    const writtenChunks = [];
    const checksum = async bytes => new Uint8Array(await global.crypto.subtle.digest("SHA-256", bytes));
    try {
      onProgress({ phase: "圧縮・保存", itemsDone: 0, itemsTotal: total, bytesDone: 0, bytesTotal: 0 });
      writable = await handle.createWritable();
      await codec().createArchiveStream(source.manifest, source.records, {
        onProgress: info => onProgress({ phase: "圧縮・保存", itemsDone: count(info.counts), itemsTotal: total, bytesDone: info.totalBytes, bytesTotal: 0 }),
      }).pipeThrough(new TransformStream({ async transform(bytes, output) {
        writtenChunks.push({ offset: writtenBytes, size: bytes.byteLength, digest: await checksum(bytes) });
        writtenBytes += bytes.byteLength; output.enqueue(bytes);
      } })).pipeTo(writable); // pipeTo resolves only after the file stream closes.
    } catch (error) {
      if (writable) { try { await writable.abort(); } catch {} }
      throw error;
    }
    // Reopen the committed file, never validate a pre-write in-memory copy.
    const file = await handle.getFile();
    onProgress({ phase: "保存内容の確認", itemsDone: 0, itemsTotal: total, bytesDone: 0, bytesTotal: file.size });
    let verified;
    try {
      if (file.size !== writtenBytes) throw new Error("Saved archive size differs");
      // Retain only one digest per streamed chunk, never all attachment bytes.
      // A valid older archive is still a failed write, so compare the actual
      // committed bytes as well as performing the complete codec validation.
      for (const chunk of writtenChunks) {
        const digest = await checksum(await file.slice(chunk.offset, chunk.offset + chunk.size).arrayBuffer());
        if (!digest.every((byte, index) => byte === chunk.digest[index])) throw new Error("Saved archive bytes differ");
      }
      let bytesRead = 0;
      const stream = file.stream().pipeThrough(new TransformStream({ transform(bytes, output) {
        bytesRead += bytes.byteLength; output.enqueue(bytes);
      } }));
      verified = await codec().readArchiveStream(stream, {}, {
        onProgress: info => onProgress({ phase: "保存内容の確認", itemsDone: count(info.counts), itemsTotal: total, bytesDone: bytesRead, bytesTotal: file.size }),
      });
    } catch (cause) {
      const error = new Error("Saved archive verification failed", { cause }); error.name = "BackupVerificationError"; throw error;
    }
    onProgress({ phase: "保存内容の確認", itemsDone: total, itemsTotal: total, bytesDone: file.size, bytesTotal: file.size });
    return { handle, fileName: filename(handle.name), size: file.size, ...verified };
  }

  function acquireDestination(change) {
    if (!options.pickSaveFile) return Promise.resolve(null);
    const handle = !change && destination?.handle;
    if (handle) {
      // requestPermission must begin in the click stack. Awaiting an IndexedDB
      // read or queryPermission first can consume transient user activation.
      const permission = typeof handle.requestPermission === "function" ? handle.requestPermission({ mode: "readwrite" }) : Promise.resolve("granted");
      return Promise.resolve(permission).then(result => {
        if (result !== "granted") throw new DOMException("Permission denied", "NotAllowedError");
        return handle;
      });
    }
    return options.pickSaveFile({ suggestedName: DEFAULT_NAME, types: [{ description: "YUTORI 全データバックアップ", accept: { "application/octet-stream": [".yutori"] } }] });
  }
  function assertActive(operation) {
    operation.controller.signal.throwIfAborted();
    if (activeOperation?.generation !== operation.generation) throw new DOMException("Backup operation ended", "AbortError");
  }
  function waitCancellable(promise, operation) {
    const signal = operation.controller.signal;
    return new Promise((resolve, reject) => {
      let settled = false;
      const finish = (settle, value) => {
        if (settled) return;
        settled = true; signal.removeEventListener("abort", aborted); settle(value);
      };
      const aborted = () => finish(reject, signal.reason);
      // Keep both handlers attached even after cancellation. Hook APIs need not
      // support signals, and their abandoned rejection must remain handled.
      Promise.resolve(promise).then(value => {
        if (settled) return;
        try { assertActive(operation); finish(resolve, value); }
        catch (error) { finish(reject, error); }
      }, error => finish(reject, error));
      if (signal.aborted) aborted();
      else signal.addEventListener("abort", aborted, { once: true });
    });
  }
  function startSave(change = false) {
    if (pending) return pending;
    if (!ready) return Promise.resolve({ ok: false, reason: "initializing" });
    if (restoreSession) return Promise.resolve({ ok: false, reason: "restore-active" });
    state = { busy: true, phase: "準備", itemsDone: 0, itemsTotal: 0, bytesDone: 0, bytesTotal: 0, canCancel: true };
    const operation = { generation: ++generation, controller: new AbortController(), previousFocus: global.document?.activeElement };
    activeOperation = operation;
    let selected;
    try { selected = acquireDestination(change); } // user-activation boundary
    catch (error) { selected = Promise.reject(error); }
    renderStatus(); progress("準備");
    element("backupProgressDialog")?.showModal();
    // Observe the gesture promise immediately, even when the operation queues
    // behind an import and is cancelled before its callback begins.
    Promise.resolve(selected).catch(() => {});
    pending = runExclusiveOperation("backup", () => performSave(selected, operation), { signal: operation.controller.signal }).catch(error => {
      if (activeOperation === operation) notify(errorMessage(error), error.name !== "AbortError");
      return { ok: false, reason: error.name };
    }).finally(() => {
      if (activeOperation !== operation) return;
      pending = null; activeOperation = null; state = { ...state, busy: false, canCancel: false };
      element("backupProgressDialog")?.close(); renderStatus(); operation.previousFocus?.focus();
    });
    return pending;
  }
  async function performSave(selected, operation) {
    try {
      const handle = await waitCancellable(selected, operation);
      assertActive(operation);
      if (handle) await waitCancellable(handle.getFile(), operation); // detect disconnected/deleted destination
      assertActive(operation);
      await waitCancellable(options.waitForIdle(), operation);
      assertActive(operation);
      progress("データ収集");
      const source = await waitCancellable(storage().createSnapshotRecordSource({ appVersion: options.appVersion, createdAt: options.now().toISOString() }), operation);
      assertActive(operation);
      progress("データ収集", { itemsDone: count(source.manifest.counts), itemsTotal: count(source.manifest.counts), bytesDone: source.manifest.estimatedBytes, bytesTotal: source.manifest.estimatedBytes });
      let result;
      state.canCancel = false;
      if (handle) {
        result = await writeVerifiedArchiveToHandle(handle, source, { onProgress: info => {
          if (activeOperation === operation) progress(info.phase, info);
        } });
      } else {
        progress("圧縮・保存", { itemsDone: 0, bytesDone: 0, bytesTotal: 0, canCancel: false });
        const blob = await new Response(codec().createArchiveStream(source.manifest, source.records, {
          onProgress: info => progress("圧縮・保存", { itemsDone: count(info.counts), bytesDone: info.totalBytes }),
        })).blob();
        progress("保存内容の確認", { itemsDone: 0, bytesDone: 0, bytesTotal: blob.size });
        await codec().readArchiveStream(blob);
        progress("保存内容の確認", { itemsDone: count(source.manifest.counts), bytesDone: blob.size });
        assertActive(operation);
        await options.downloadBlob(blob, DEFAULT_NAME);
        result = { fileName: DEFAULT_NAME, size: blob.size };
      }
      assertActive(operation);
      const meta = { handle: handle || null, fileName: result.fileName, size: result.size, lastSuccessfulAt: options.now().toISOString() };
      destination = await storage().saveDestinationMeta(meta);
      assertActive(operation);
      notify(handle ? "バックアップを保存し、ファイルの内容を確認しました。Google ドライブのクラウド同期完了は、ドライブ側で確認してください。" : "内容を確認したバックアップをダウンロードしました。このブラウザでは毎回ダウンロードします。同じ保存先への自動上書きはできません。保存したファイルを確認してください。");
      return { ok: true, ...result };
    } catch (error) {
      if (activeOperation === operation) notify(errorMessage(error), error.name !== "AbortError");
      return { ok: false, reason: error.name };
    }
  }
  function cancelBackup() { if (state.canCancel) activeOperation?.controller.abort(); }
  function showBackupSettings() { global.showSettingsPanel("backup"); renderStatus(); }

  function restoreActive(session) {
    session.controller.signal.throwIfAborted();
    if (restoreSession !== session) throw new DOMException("Restore session ended", "AbortError");
  }
  function restoreWait(promise, session) {
    return new Promise((resolve, reject) => {
      const signal = session.controller.signal;
      let settled = false;
      const finish = (settle, value) => { if (settled) return; settled = true; signal.removeEventListener("abort", aborted); settle(value); };
      const aborted = () => finish(reject, signal.reason);
      Promise.resolve(promise).then(value => {
        try { restoreActive(session); finish(resolve, value); } catch (error) { finish(reject, error); }
      }, error => finish(reject, error));
      if (signal.aborted) aborted(); else signal.addEventListener("abort", aborted, { once: true });
    });
  }
  function getRestoreUiState() {
    const session = restoreSession;
    return { phase: session?.phase || "closed", candidate: session?.candidate || null, safetyBackup: session?.safetyBackup || null,
      canReplace: !!(session?.held && session.safetyBackup && session.confirmed && !session.busy), busy: !!session?.busy };
  }
  function renderRestore() {
    const session = restoreSession;
    setText("restorePhase", session?.phaseLabel || "ファイルを選んでください");
    const candidate = session?.candidate;
    const summary = element("restoreSummary");
    if (summary) summary.hidden = !candidate;
    if (candidate) {
      const version = candidate.manifest.appVersion;
      const values = { restoreCreatedAt: timeLabel(candidate.manifest.createdAt), restoreAppVersion: typeof version === "string" && /^v?\d+\.\d+\.\d+(?:[-+][a-zA-Z0-9.-]+)?$/.test(version) ? version : "—", restoreSize: byteLabel(candidate.size),
        restoreTests: candidate.summary.tests, restoreClasses: candidate.summary.classes, restoreSessions: candidate.summary.gradingSessions,
        restorePdfs: candidate.summary.pdfFiles, restorePages: candidate.summary.pdfPages };
      for (const [id, value] of Object.entries(values)) setText(id, String(value));
    }
    const save = element("restoreSafetyButton");
    if (save) save.disabled = !candidate || !!session.busy || !!session.safetyBackup || !!session.awaitingDownload;
    const confirm = element("restoreConfirm");
    if (confirm) { confirm.checked = !!session?.confirmed; confirm.disabled = !session?.safetyBackup || !!session.busy; }
    const reselect = element("restoreSafetyReselect");
    if (reselect) { reselect.hidden = !session?.awaitingDownload; reselect.disabled = !!session?.busy; }
    const cancel = element("restoreCancelButton");
    if (cancel) cancel.disabled = !!session?.writing || ["replacing", "reload-pending", "needs-safety-file"].includes(session?.phase);
    const replace = element("restoreReplaceButton");
    if (replace) replace.disabled = !getRestoreUiState().canReplace;
    renderStatus();
  }
  function restorePhase(session, phase, label, busy = false) {
    restoreActive(session); Object.assign(session, { phase, phaseLabel: label, busy }); renderRestore();
  }
  function restoreError(error) {
    if (error.name === "AbortError") return "キャンセルしました。現在のデータは変更していません。";
    if (error.name === "QuotaExceededError") return "復元の準備に必要な空き容量が足りません。空き容量を増やして、もう一度ファイルを選んでください。";
    if (error.code === "UNSUPPORTED_VERSION") return "このバックアップ形式には対応していません。YUTORI を更新するか、別のバックアップを選んでください。";
    if (error.name === "InvalidStateError") return "復元元や主バックアップとは別の安全用ファイルを選んでください。";
    if (error.name === "NotAllowedError" || error.name === "SecurityError") return "安全用ファイルへの保存が許可されませんでした。保存先を確認して、もう一度保存してください。";
    return "ファイルの内容を確認できませんでした。現在のデータは変更していません。別のバックアップを選ぶか、安全用ファイルを保存し直してください。";
  }
  function deepFreeze(value) {
    if (value && typeof value === "object") { Object.values(value).forEach(deepFreeze); Object.freeze(value); }
    return value;
  }
  function newRestoreSession(phase, phaseLabel) {
    return { controller: new AbortController(), phase, phaseLabel, busy: true,
      previousFocus: global.document?.activeElement, candidate: null, safetyBackup: null, confirmed: false };
  }
  async function inspectRestoreFile(file, sourceHandle = null, selectedSession = null) {
    if (state.busy) throw new DOMException("Backup is running", "InvalidStateError");
    if (selectedSession) restoreActive(selectedSession);
    if (restoreSession && restoreSession !== selectedSession) {
      if (restoreSession.writing || restoreSession.phase === "replacing") throw new DOMException("Restore is busy", "InvalidStateError");
      await cancelRestore();
    }
    const session = selectedSession || newRestoreSession("inspecting", "バックアップの内容を確認");
    Object.assign(session, { sourceHandle, phase: "inspecting", phaseLabel: "バックアップの内容を確認", busy: true });
    restoreSession = session; setText("restoreMessage", ""); renderRestore(); element("restoreDialog")?.showModal();
    let writer, staged;
    session.inspection = (async () => {
      try {
        const signal = session.controller.signal;
        const parsing = codec().readArchiveStream(file.stream().pipeThrough(new TransformStream(), { signal }), {
          async onManifest(manifest) {
            restoreActive(session);
            writer = await storage().createStageWriter(manifest);
            try { restoreActive(session); } catch (error) { await writer.abort(); throw error; }
          },
          async onRecord(record) { restoreActive(session); await writer.onRecord(record); },
        }, { onProgress: info => { if (restoreSession === session) setText("restoreProgress", `${count(info.counts)} 件を確認`); } });
        // A hook can continue after cancellation. Observe it and clean any late
        // stage, while the session itself stops awaiting it immediately.
        parsing.catch(async () => { await writer?.abort(); }).catch(() => {});
        const verified = await restoreWait(parsing, session);
        restoreActive(session);
        staged = await writer.finalize();
        const dataHash = await restoreWait(storage().dataIdentity({ name: staged.stageDbName, version: staged.manifest.indexedDB.version }, staged.manifest, staged.localStorageEntries), session);
        const candidate = deepFreeze({ ...staged, size: file.size, archiveHash: verified.archiveHash,
          dataHash }); candidates.add(candidate);
        session.candidate = candidate;
        restoreActive(session); restorePhase(session, "inspected", "内容を確認しました。復元前バックアップを保存してください。");
        return candidate;
      } catch (error) {
        await writer?.abort();
        if (staged) await storage().deleteRestoreStage(staged.stageDbName);
        if (restoreSession === session) { session.candidate = null; restorePhase(session, "inspection-failed", "バックアップの確認を中止しました。"); setText("restoreMessage", restoreError(error)); }
        throw error;
      }
    })();
    session.inspection.catch(() => {});
    return session.inspection;
  }
  async function discardRestoreCandidate(candidate) {
    if (!candidates.has(candidate)) throw new TypeError("Unknown restore candidate");
    if (restoreSession?.candidate === candidate) { await cancelRestore(); return; }
    await storage().deleteRestoreStage(candidate.stageDbName); candidates.delete(candidate);
  }
  async function cancelRestore() {
    const session = restoreSession;
    if (!session) return true;
    if (session.writing || ["replacing", "reload-pending", "needs-safety-file"].includes(session.phase)) return false;
    restoreSession = null; session.controller.abort(); session.release?.(null);
    element("restoreDialog")?.close(); renderRestore(); session.previousFocus?.focus();
    await Promise.allSettled([session.inspection, session.selection, session.gate]);
    if (session.candidate && candidates.has(session.candidate)) {
      await storage().deleteRestoreStage(session.candidate.stageDbName); candidates.delete(session.candidate);
    }
    return true;
  }
  function selectRestoreFile() {
    if (restoreSession?.selection && restoreSession.phase === "selecting") return restoreSession.selection;
    if (state.busy || restoreSession) return Promise.resolve();
    if (!options.pickOpenFile) { const input = element("restoreSourceInput"); if (input) { input.value = ""; input.click(); } return; }
    const session = newRestoreSession("selecting", "復元元のファイルを選んでください");
    restoreSession = session; setText("restoreMessage", ""); renderRestore(); element("restoreDialog")?.showModal();
    let selected;
    try { selected = options.pickOpenFile({ multiple: false, types: [{ description: "YUTORI バックアップ", accept: { "application/octet-stream": [".yutori"] } }] }); }
    catch (error) { selected = Promise.reject(error); }
    session.selection = (async () => {
      try {
        const [handle] = await restoreWait(selected, session);
        const file = await restoreWait(handle.getFile(), session);
        return await inspectRestoreFile(file, handle, session);
      } catch (error) {
        if (restoreSession === session) { restorePhase(session, "selection-failed", "ファイルを選び直してください。"); setText("restoreMessage", restoreError(error)); }
      }
    })();
    return session.selection;
  }
  function safetyName() {
    const date = options.now(), pad = n => String(n).padStart(2, "0");
    return `YUTORI_復元前バックアップ_${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}_${pad(date.getHours())}${pad(date.getMinutes())}.yutori`;
  }
  async function sha(bytes) { return [...new Uint8Array(await global.crypto.subtle.digest("SHA-256", bytes))].map(n => n.toString(16).padStart(2, "0")).join(""); }
  async function fingerprint(file) {
    const hashes = [];
    for (let offset = 0; offset < file.size; offset += 1024 * 1024) hashes.push(await sha(await file.slice(offset, offset + 1024 * 1024).arrayBuffer()));
    return { size: file.size, hashes };
  }
  async function safetyProof(result) {
    return Object.freeze({ handle: result.handle || null, fileName: result.fileName,
      manifest: result.manifest, dataHash: await storage().dataIdentity(await storage().getActiveDataDbDescriptor(), result.manifest, storage().collectLocalStorageEntries()),
      manifestHash: await sha(new TextEncoder().encode(JSON.stringify(result.manifest))), archiveHash: result.archiveHash, verifiedAt: options.now().toISOString() });
  }
  function setRestoreConfirmation(checked) { if (restoreSession) { restoreSession.confirmed = !!checked && !!restoreSession.safetyBackup; renderRestore(); } }
  function saveSafetyBackup(candidate) {
    const session = restoreSession;
    if (!session || session.candidate !== candidate || !candidates.has(candidate)) return Promise.reject(new DOMException("Unknown restore session", "InvalidStateError"));
    if (session.safetyPending) return session.safetyPending;
    if (session.safetyBackup) return Promise.resolve(session.safetyBackup);
    if (session.awaitingDownload) return Promise.resolve({ requiresReselection: true, fileName: session.awaitingDownload.fileName });
    let selected;
    const fileName = safetyName();
    try { selected = options.pickSaveFile ? options.pickSaveFile({ suggestedName: fileName, types: [{ description: "YUTORI 復元前バックアップ", accept: { "application/octet-stream": [".yutori"] } }] }) : null; }
    catch (error) { selected = Promise.reject(error); }
    Promise.resolve(selected).catch(() => {});
    session.safetyBackup = null; session.confirmed = false;
    setText("restoreMessage", "");
    restorePhase(session, "safety-preparing", "復元前バックアップの準備", true);
    let resolveSaved, rejectSaved;
    session.safetyPending = new Promise((resolve, reject) => { resolveSaved = resolve; rejectSaved = reject; });
    session.gate = runExclusiveOperation("restore", async owner => {
      session.held = true; session.owner = owner;
      const continuing = new Promise(resolve => { session.release = resolve; });
      try {
        const handle = await restoreWait(selected, session);
        for (const other of [session.sourceHandle, destination?.handle]) {
          if (handle && other && (handle === other || (typeof handle.isSameEntry === "function" && await restoreWait(handle.isSameEntry(other), session)))) throw new DOMException("Same file", "InvalidStateError");
        }
        await restoreWait(options.waitForIdle(), session);
        const source = await restoreWait(storage().createSnapshotRecordSource({ appVersion: options.appVersion, createdAt: options.now().toISOString() }), session);
        restoreActive(session); session.writing = true;
        let result;
        if (handle) {
          result = await writeVerifiedArchiveToHandle(handle, source, { onProgress: info => { restorePhase(session, "safety-saving", info.phase, true); } });
          restoreActive(session); session.safetyBackup = await safetyProof(result);
          restoreActive(session); restorePhase(session, "safety-verified", "復元前バックアップを保存し、内容を確認しました。");
          resolveSaved(session.safetyBackup);
        } else {
          restorePhase(session, "safety-saving", "復元前バックアップを作成・確認", true);
          const blob = await new Response(codec().createArchiveStream(source.manifest, source.records)).blob();
          const verified = await codec().readArchiveStream(blob);
          const identity = await fingerprint(blob);
          restoreActive(session);
          await options.downloadBlob(blob, fileName);
          session.awaitingDownload = { ...verified, ...identity, fileName };
          restorePhase(session, "safety-reselect", "ダウンロードした復元前バックアップを選び直し、保存内容を確認してください。");
          resolveSaved({ requiresReselection: true, fileName });
        }
        session.writing = false; renderRestore();
        const callback = await continuing;
        if (callback) { restoreActive(session); return await callback(owner); }
      } catch (error) {
        rejectSaved(error);
        if (restoreSession === session && !session.replacementStarted) {
          session.safetyBackup = null; session.awaitingDownload = null; session.confirmed = false; session.writing = false;
          restorePhase(session, "safety-failed", "復元前バックアップを確認できませんでした。"); setText("restoreMessage", restoreError(error));
        }
        throw error;
      } finally {
        session.held = false; session.release = null;
        if (restoreSession === session) {
          session.busy = false; session.safetyBackup = null; session.confirmed = false;
          if (session.phase === "replacing") { session.phase = "continuation-ended"; session.phaseLabel = "復元の処理を終了しました。"; }
          renderRestore();
        }
      }
    }, { signal: session.controller.signal });
    session.gate.catch(error => { rejectSaved(error); });
    const pendingSafety = session.safetyPending;
    pendingSafety.finally(() => { if (session.safetyPending === pendingSafety) session.safetyPending = null; }).catch(() => {});
    return pendingSafety;
  }
  async function verifyDownloadedSafetyFile(file) {
    const session = restoreSession, expected = session?.awaitingDownload;
    if (!expected || !session.held || session.busy) throw new DOMException("No safety download", "InvalidStateError");
    session.confirmed = false; session.safetyBackup = null;
    setText("restoreMessage", "");
    restorePhase(session, "safety-checking", "保存した復元前バックアップを確認", true);
    try {
      if (file.name !== expected.fileName || file.size !== expected.size) throw new Error("Different safety file");
      const identity = await restoreWait(fingerprint(file), session);
      if (JSON.stringify(identity.hashes) !== JSON.stringify(expected.hashes)) throw new Error("Different safety bytes");
      const verified = await restoreWait(codec().readArchiveStream(file), session);
      if (verified.archiveHash !== expected.archiveHash) throw new Error("Different safety archive");
      const proof = await restoreWait(safetyProof({ ...verified, fileName: expected.fileName }), session);
      session.safetyBackup = proof; session.awaitingDownload = null;
      restorePhase(session, "safety-verified", "保存した復元前バックアップの内容を確認しました。");
      return proof;
    } catch (error) {
      if (restoreSession === session) { restorePhase(session, "safety-reselect", "ダウンロードした安全用ファイルを選び直してください。"); setText("restoreMessage", restoreError(error)); }
      throw error;
    }
  }
  function withRestoreSession(candidate, safetyBackup, callback) {
    const session = restoreSession;
    if (!getRestoreUiState().canReplace || session.candidate !== candidate || session.safetyBackup !== safetyBackup || typeof callback !== "function") return Promise.reject(new DOMException("Safety confirmation required", "InvalidStateError"));
    // Task 6 must retain this callback's owner through reload, or explicitly
    // discard queued old-state autosaves before it returns. Never reacquire.
    restorePhase(session, "replacing", "復元を準備しています", true);
    session.release(callback);
    return session.gate;
  }

  function replaceWithCandidate(candidate, safetyBackup) {
    const session = restoreSession;
    return withRestoreSession(candidate, safetyBackup, async () => {
      session.replacementStarted = true;
      let journal;
      try {
        invalidateOldPersistence();
        await options.waitForIdle();
        if (await storage().dataIdentity({ name: candidate.stageDbName, version: candidate.manifest.indexedDB.version }, candidate.manifest, candidate.localStorageEntries) !== candidate.dataHash) throw new Error("Stage changed");
        journal = await storage().beginRestoreJournal({ candidate, safetyBackup, oldLocalStorage: storage().collectLocalStorageEntries() });
        storage().applyOwnedLocalStorage(candidate.localStorageEntries);
        journal = await storage().setRestorePhase(journal, "local-storage-applied");
        journal = await storage().switchActiveDataDb(journal.targetDescriptor, journal);
        await storage().validateRestoreTarget(journal);
        journal = await storage().setRestorePhase(journal, "reload-pending");
        restorePhase(session, "reload-pending", "復元を確認しました。再読み込みしています。", true);
        options.reload();
      } catch (error) {
        let restored = true;
        try {
          // A transaction may have committed immediately before an injected or
          // environmental failure; recover from durable state, not local phase.
          journal = await storage().getRestoreJournal() || journal;
          if (journal) await storage().rollbackRestore(journal);
          else await storage().deleteRestoreStage(candidate.stageDbName);
        } catch { restored = false; }
        candidates.delete(candidate); session.candidate = null;
        if (restored) {
          persistenceBlocked = false;
          restorePhase(session, "replacement-failed", "復元を中止し、復元前のデータに戻しました。");
          setText("restoreMessage", error.name === "QuotaExceededError" ? "空き容量が足りません。空き容量を増やしてやり直してください。" : "復元前のデータは保持されています。ファイルを選び直してください。");
        } else {
          restorePhase(session, "needs-safety-file", "復元前バックアップによる回復が必要です。", true);
          showStartupError(Object.assign(new Error(), { name: "NeedsSafetyFileError" }));
        }
        throw error;
      }
    });
  }

  async function recoverFromSafetyFile(file, { reload = true } = {}) {
    const journal = await storage().getRestoreJournal();
    if (!journal) throw new DOMException("No recovery pending", "InvalidStateError");
    let writer, staged;
    try {
      const verified = await codec().readArchiveStream(file, {
        async onManifest(manifest) { writer = await storage().createStageWriter(manifest); },
        async onRecord(record) { await writer.onRecord(record); },
      });
      if (verified.archiveHash !== journal.safetyBackup.archiveHash || await sha(new TextEncoder().encode(JSON.stringify(verified.manifest))) !== journal.safetyBackup.manifestHash) throw new Error("Wrong safety identity");
      staged = await writer.finalize();
      const targetDescriptor = { name: staged.stageDbName, version: staged.manifest.indexedDB.version };
      const recovered = { ...journal, phase: "recovering-safety", failedTarget: journal.targetDescriptor, targetDescriptor,
        targetManifest: staged.manifest, targetManifestHash: await sha(new TextEncoder().encode(JSON.stringify(staged.manifest))),
        targetLocalStorage: staged.localStorageEntries, targetHash: await storage().dataIdentity(targetDescriptor, staged.manifest, staged.localStorageEntries) };
      await storage().commitJournal(recovered);
      await completeSafetyRecovery(recovered);
      if (reload) options.reload();
      return { status: "completed" };
    } catch (error) {
      await writer?.abort();
      // Once journaled, the stage belongs to crash recovery and must survive.
      const durable = await storage().getRestoreJournal();
      if (staged && durable?.targetDescriptor.name !== staged.stageDbName) await storage().deleteRestoreStage(staged.stageDbName);
      throw error;
    }
  }
  async function completeSafetyRecovery(journal) {
    if (await storage().dataIdentity(journal.targetDescriptor, journal.targetManifest, journal.targetLocalStorage) !== journal.targetHash) throw new Error("Recovery stage changed");
    storage().applyOwnedLocalStorage(journal.targetLocalStorage);
    journal = await storage().switchActiveDataDb(journal.targetDescriptor, journal);
    await storage().validateRestoreTarget(journal);
    return storage().setRestorePhase(journal, "reload-pending");
  }
  async function recoverInterruptedRestore() {
    let journal = await storage().getRestoreJournal();
    if (!journal) return { status: "none" };
    try {
      if (journal.phase === "recovering-safety") journal = await completeSafetyRecovery(journal);
      if (["pointer-switched", "reload-pending", "finalizing"].includes(journal.phase)) {
        try { await storage().finalizeRestore(journal); return { status: "completed" }; }
        catch (error) { if (journal.phase === "finalizing") throw error; }
      }
      await storage().rollbackRestore(journal);
      return { status: "rolled-back" };
    } catch {
      // A remembered handle is only an optimization. Never prompt for permission
      // at startup or initialize the app against mixed/incomplete data.
      try {
        const handle = journal.safetyBackup?.handle;
        if (!handle || (handle.queryPermission && await handle.queryPermission({ mode: "read" }) !== "granted")) throw new Error("Safety file unavailable");
        await recoverFromSafetyFile(await handle.getFile(), { reload: false });
        await storage().finalizeRestore(await storage().getRestoreJournal());
        return { status: "rolled-back" };
      } catch { return { status: "needs-safety-file", message: "復元前バックアップを選んで回復してください。" }; }
    }
  }
  let recoveryPromise;
  function recoverBeforeAppStart() {
    if (!recoveryPromise) recoveryPromise = (async () => {
      if (global.document?.body) global.document.body.inert = true;
      const result = await recoverInterruptedRestore();
      if (result.status === "needs-safety-file") throw Object.assign(new Error(result.message), { name: "NeedsSafetyFileError" });
      global.yutoriRecoveryFinished = true;
      return result;
    })();
    return recoveryPromise;
  }
  function showStartupError(error) {
    invalidateOldPersistence();
    global.yutoriAppReady = false;
    global.document.body.inert = true;
    element("restoreDialog")?.close();
    let dialog = element("startupRecoveryDialog");
    if (!dialog) {
      dialog = global.document.createElement("dialog"); dialog.id = "startupRecoveryDialog"; dialog.className = "restore-dialog";
      dialog.setAttribute("aria-label", "データの回復");
      const message = global.document.createElement("p"); message.textContent = error.name === "NeedsSafetyFileError" ? "データの回復が必要です。復元前に保存したバックアップを選んでください。" : "起動できませんでした。画面を再読み込みしてください。";
      dialog.append(message);
      if (error.name === "NeedsSafetyFileError") {
        const input = global.document.createElement("input"); input.type = "file"; input.accept = ".yutori"; input.hidden = true;
        const button = global.document.createElement("button"); button.type = "button"; button.textContent = "復元前バックアップを選んで回復";
        button.onclick = () => { input.value = ""; input.click(); };
        input.onchange = async () => {
          if (!input.files[0]) return; button.disabled = true;
          try { await recoverFromSafetyFile(input.files[0]); }
          catch { message.textContent = "必要な復元前バックアップを確認できませんでした。保存したファイルを選び直してください。"; button.disabled = false; }
        };
        dialog.append(button, input);
      }
      dialog.addEventListener("cancel", event => event.preventDefault()); global.document.body.append(dialog);
    }
    if (!dialog.open) dialog.showModal();
  }

  // Restore orchestration shares the same gate in later tasks; the reusable IO
  // writer deliberately does not acquire it again inside a restore operation.
  global.YutoriBackup = { configure, initialize, savePrimaryBackup: () => startSave(false),
    changeDestination: () => startSave(true), writeVerifiedArchiveToHandle,
    renderStatus, getOperationState: () => ({ ...state }), cancelBackup,
    inspectRestoreFile, discardRestoreCandidate, saveSafetyBackup, getRestoreUiState, setRestoreConfirmation,
    selectRestoreFile, verifyDownloadedSafetyFile, cancelRestore, withRestoreSession,
    replaceWithCandidate, recoverInterruptedRestore, recoverBeforeAppStart, recoverFromSafetyFile, showStartupError };
  global.saveYutoriBackup = () => global.YutoriBackup.savePrimaryBackup();
  global.changeYutoriBackupDestination = () => global.YutoriBackup.changeDestination();
  global.showBackupSettings = showBackupSettings;
  global.document?.addEventListener("DOMContentLoaded", () => {
    element("backupProgressDialog")?.addEventListener("cancel", event => { event.preventDefault(); cancelBackup(); });
    element("restoreDialog")?.addEventListener("cancel", event => { event.preventDefault(); cancelRestore().catch(() => {}); });
    element("restoreSourceInput")?.addEventListener("change", event => { const file = event.target.files[0]; if (file) inspectRestoreFile(file).catch(() => {}); });
    element("restoreSafetyInput")?.addEventListener("change", event => { const file = event.target.files[0]; if (file) verifyDownloadedSafetyFile(file).catch(() => {}); });
    recoverBeforeAppStart().then(initialize).catch(showStartupError);
  });
})(globalThis);
