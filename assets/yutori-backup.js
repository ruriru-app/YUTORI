(function (global) {
  "use strict";

  const DEFAULT_NAME = "YUTORI_全データバックアップ.yutori";
  const persistence = new Map(), operationQueue = [];
  let persistenceRevision = 0, operationOwner = null;

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
    return new Promise((resolve, reject) => {
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
  }
  function runPersistenceOperation(callback, label, owner) {
    // Only the explicit token passed down an import's call graph permits nested
    // writes. A new unrelated caller must queue even while an import is active.
    if (owner && owner === operationOwner) return trackPersistence(callback(owner), label);
    return runExclusiveOperation("pdf-import", token => trackPersistence(callback(token), label));
  }
  function deferPersistenceWhileExclusive(callback, label) {
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
    if (button) { button.title = status; button.disabled = !ready || state.busy; button.setAttribute("aria-busy", String(state.busy)); }
    setText("backupTooltip", status);
    setText("backupFileName", `${name}${mode}`);
    setText("backupLastSaved", successful ? timeLabel(destination.lastSuccessfulAt) : "まだ保存していません");
    setText("backupSize", successful ? byteLabel(destination.size) : "—");
    global.document?.querySelectorAll("[data-backup-action]").forEach(button => { button.disabled = !ready || state.busy; });
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

  // Restore orchestration shares the same gate in later tasks; the reusable IO
  // writer deliberately does not acquire it again inside a restore operation.
  global.YutoriBackup = { configure, initialize, savePrimaryBackup: () => startSave(false),
    changeDestination: () => startSave(true), writeVerifiedArchiveToHandle,
    renderStatus, getOperationState: () => ({ ...state }), cancelBackup };
  global.saveYutoriBackup = () => global.YutoriBackup.savePrimaryBackup();
  global.changeYutoriBackupDestination = () => global.YutoriBackup.changeDestination();
  global.showBackupSettings = showBackupSettings;
  global.document?.addEventListener("DOMContentLoaded", () => {
    element("backupProgressDialog")?.addEventListener("cancel", event => { event.preventDefault(); cancelBackup(); });
    initialize().catch(() => notify("バックアップ設定を読み込めませんでした。画面を再読み込みしてください。", true));
  });
})(globalThis);
