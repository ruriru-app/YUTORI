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
    let picked = false, release;
    YutoriBackup.configure({ pickSaveFile: () => { picked = true; return Promise.resolve(backupHandle); }, waitForIdle: () => new Promise(resolve => { release = resolve; }) });
    const first = YutoriBackup.savePrimaryBackup();
    const synchronous = picked;
    const second = YutoriBackup.savePrimaryBackup();
    await new Promise(resolve => setTimeout(resolve, 20));
    const phase = YutoriBackup.getOperationState().phase;
    release();
    return { synchronous, shared: first === second, phase, success: (await first).ok };
  });
  assert.deepEqual(result, { synchronous: true, shared: true, phase: "準備", success: true });
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
