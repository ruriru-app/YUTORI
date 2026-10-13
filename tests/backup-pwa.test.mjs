import assert from "node:assert/strict";
import test from "node:test";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { createYutoriBrowser } from "./helpers/yutori-browser.mjs";
import { registerAndWaitForWorker } from "./helpers/yutori-worker.mjs";

const { chromium } = createRequire(import.meta.url)("playwright");

// A dedicated browser/context allows the real worker; the ordinary helper still blocks it.
// Missing precache assets must fail before an online application visit can warm the cache.
test("APP_SHELL v0.3.51 installs backup dependencies and boots the backup UI offline", { timeout: 20000 }, async t => {
  const harness = await createYutoriBrowser();
  let browser;
  const abort = () => { browser?.close().catch(() => {}); };
  t.signal.addEventListener("abort", abort, { once: true });
  const errors = [];
  try {
    const executablePath = [process.env.PLAYWRIGHT_CHROMIUM_PATH, chromium.executablePath(),
      "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe"].find(candidate => candidate && existsSync(candidate));
    browser = await chromium.launch({ executablePath, headless: true, timeout: 10000 });
    const context = await browser.newContext({ serviceWorkers: "allow" });
    const page = await context.newPage();
    page.setDefaultTimeout(5000); page.setDefaultNavigationTimeout(10000);
    page.on("pageerror", error => errors.push(error.message));
    await page.goto(`${harness.origin}/__test_blank__`);
    await registerAndWaitForWorker(page);
    const installed = await page.evaluate(async () => {
      const names = await caches.keys();
      const cache = await caches.open(names.find(name => name.startsWith("yutori-v")));
      return { names, paths: (await cache.keys()).map(request => new URL(request.url).pathname) };
    });
    assert.deepEqual(installed.names, ["yutori-v0.3.51"]);
    const dependencies = ["/assets/yutori-backup-archive.js", "/assets/yutori-backup-storage.js", "/assets/yutori-backup.js"];
    for (const asset of [...dependencies, "/assets/backup.svg"]) assert.ok(installed.paths.includes(asset), `precache missing ${asset}`);
    assert.ok(installed.paths.indexOf(dependencies[0]) < installed.paths.indexOf(dependencies[1]));
    assert.ok(installed.paths.indexOf(dependencies[1]) < installed.paths.indexOf(dependencies[2]));
    await context.setOffline(true);
    const responses = await page.evaluate(async paths => Promise.all(paths.map(async path => {
      const response = await fetch(path);
      return { path, status: response.status, bytes: (await response.arrayBuffer()).byteLength };
    })), [...dependencies, "/assets/backup.svg"]);
    for (const response of responses) {
      assert.equal(response.status, 200, response.path);
      assert.ok(response.bytes > 0, response.path);
    }
    await page.goto(`${harness.origin}/`, { waitUntil: "domcontentloaded" });
    await page.evaluate(() => globalThis.yutoriAppInitialization);
    assert.equal(await page.title(), "YUTORI v0.3.51");
    assert.deepEqual(await page.evaluate(() => ({ ready: yutoriAppReady,
      codec: typeof YutoriBackupArchive.readArchiveStream,
      storage: typeof YutoriBackupStorage.createSnapshotRecordSource,
      backup: typeof YutoriBackup.savePrimaryBackup,
      restore: typeof YutoriBackup.replaceWithCandidate })),
    { ready: true, codec: "function", storage: "function", backup: "function", restore: "function" });
    await page.getByRole("button", { name: "各種設定", exact: true }).click();
    await page.getByRole("button", { name: "バックアップ設定", exact: true }).click();
    assert.equal(await page.getByRole("button", { name: "今すぐバックアップ", exact: true }).isEnabled(), true);
    assert.equal(await page.getByRole("button", { name: "バックアップから復元", exact: true }).isEnabled(), true);
    assert.deepEqual(errors, []);
  } finally {
    t.signal.removeEventListener("abort", abort);
    await browser?.close();
    await harness.close();
  }
});

// Serve actual historical/current worker bytes; only one HTTP asset response is faulted.
async function createInstallFailureFixture({ oldWorker = false } = {}) {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  const historical = execFileSync("git", ["show", "dcd0a2c606cc2edfd34bd7320a8f4026a2fc9bb9:sw.js"], { cwd: root });
  const fixture = { oldWorker, missing: false, stalled: false, stalledResponses: [] };
  const server = http.createServer(async (request, response) => {
    try {
      const pathname = new URL(request.url, "http://localhost").pathname;
      if (pathname === "/__test_blank__") return response.writeHead(200, { "content-type": "text/html" }).end("<!doctype html><title>Worker fixture</title>");
      if (fixture.missing && pathname === "/assets/yutori-backup-storage.js") return response.writeHead(404).end();
      if (fixture.stalled && pathname === "/assets/yutori-backup-storage.js") { fixture.stalledResponses.push(response); return; }
      const filename = path.resolve(root, pathname === "/" ? "index.html" : pathname.slice(1));
      if (!filename.startsWith(`${root}${path.sep}`)) return response.writeHead(403).end();
      const body = pathname === "/sw.js" && fixture.oldWorker ? historical : await readFile(filename);
      response.writeHead(200, { "content-type": pathname.endsWith(".js") ? "text/javascript" : pathname.endsWith(".html") || pathname === "/" ? "text/html" : "application/octet-stream", "cache-control": "no-store" });
      response.end(body);
    } catch { response.writeHead(404).end(); }
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const executablePath = [process.env.PLAYWRIGHT_CHROMIUM_PATH, chromium.executablePath(),
    "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe"].find(candidate => candidate && existsSync(candidate));
  let browser;
  try {
    browser = await chromium.launch({ executablePath, headless: true, timeout: 10000 });
    const context = await browser.newContext({ serviceWorkers: "allow" });
    fixture.page = await context.newPage();
    await fixture.page.goto(`http://127.0.0.1:${server.address().port}/__test_blank__`, { timeout: 10000 });
  } catch (error) {
    await browser?.close(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); throw error;
  }
  let closing;
  fixture.close = () => closing ||= (async () => { await browser.close(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); })();
  fixture.resume = async () => {
    const body = await readFile(path.join(root, "assets/yutori-backup-storage.js"));
    fixture.stalled = false;
    for (const response of fixture.stalledResponses) response.writeHead(200, { "content-type": "text/javascript" }).end(body);
    fixture.stalledResponses.length = 0;
  };
  return fixture;
}

async function failureWithinBound(page, options, boundMs = 1500) {
  let timer;
  try {
    return await Promise.race([
      registerAndWaitForWorker(page, options).then(() => "accepted", error => error.message),
      new Promise(resolve => { timer = setTimeout(() => resolve(`still pending after ${boundMs}ms`), boundMs); }),
    ]);
  } finally { clearTimeout(timer); }
}

test("APP_SHELL missing backup asset rejects fresh installation promptly", { timeout: 15000 }, async t => {
  const fixture = await createInstallFailureFixture();
  const abort = () => { fixture.close().catch(() => {}); };
  t.signal.addEventListener("abort", abort, { once: true });
  try {
    fixture.missing = true;
    const result = await failureWithinBound(fixture.page, { timeoutMs: 700 });
    assert.match(result, /Service Worker.*redundant|Service Worker.*install.*failed/);
    assert.deepEqual(await fixture.page.evaluate(async () => {
      const registration = await navigator.serviceWorker.getRegistration();
      return { active: registration?.active?.state || null, controlled: !!navigator.serviceWorker.controller };
    }), { active: null, controlled: false });
  } finally { t.signal.removeEventListener("abort", abort); await fixture.close(); }
});

test("APP_SHELL failed upgrade preserves old active shell and retry activates restored assets", { timeout: 15000 }, async t => {
  const fixture = await createInstallFailureFixture({ oldWorker: true });
  const abort = () => { fixture.close().catch(() => {}); };
  t.signal.addEventListener("abort", abort, { once: true });
  try {
    await registerAndWaitForWorker(fixture.page, { timeoutMs: 5000 });
    fixture.oldWorker = false; fixture.missing = true;
    const result = await failureWithinBound(fixture.page, { timeoutMs: 3000, update: true }, 4000);
    assert.match(result, /Service Worker.*redundant|Service Worker.*install.*failed/);
    const preserved = await fixture.page.evaluate(async () => ({ state: navigator.serviceWorker.controller?.state,
      oldIndex: !!(await (await caches.open("yutori-v0.3.50")).match("/index.html")) }));
    assert.deepEqual(preserved, { state: "activated", oldIndex: true });
    fixture.missing = false;
    await registerAndWaitForWorker(fixture.page, { timeoutMs: 5000, update: true });
    const restored = await fixture.page.evaluate(async () => ({ names: await caches.keys(),
      newAsset: !!(await (await caches.open("yutori-v0.3.51")).match("/assets/yutori-backup-storage.js")) }));
    assert.deepEqual(restored, { names: ["yutori-v0.3.51"], newAsset: true });
  } finally { t.signal.removeEventListener("abort", abort); await fixture.close(); }
});

test("APP_SHELL stalled installation has a deadline and removes timers/listeners before retry", { timeout: 15000 }, async t => {
  const fixture = await createInstallFailureFixture();
  const abort = () => { fixture.close().catch(() => {}); };
  t.signal.addEventListener("abort", abort, { once: true });
  try {
    fixture.stalled = true;
    await fixture.page.evaluate(() => {
      globalThis.workerWaitResources = { timers: new Set(), listeners: [] };
      const nativeSet = setTimeout, nativeClear = clearTimeout;
      const nativeAdd = EventTarget.prototype.addEventListener, nativeRemove = EventTarget.prototype.removeEventListener;
      globalThis.setTimeout = (callback, delay, ...args) => {
        const id = nativeSet(() => { workerWaitResources.timers.delete(id); callback(...args); }, delay);
        workerWaitResources.timers.add(id); return id;
      };
      globalThis.clearTimeout = id => { workerWaitResources.timers.delete(id); return nativeClear(id); };
      const relevant = object => object === navigator.serviceWorker || object instanceof ServiceWorker || object instanceof ServiceWorkerRegistration;
      EventTarget.prototype.addEventListener = function(type, callback, options) {
        if (relevant(this)) workerWaitResources.listeners.push({ object: this, type, callback });
        return nativeAdd.call(this, type, callback, options);
      };
      EventTarget.prototype.removeEventListener = function(type, callback, options) {
        const index = workerWaitResources.listeners.findIndex(item => item.object === this && item.type === type && item.callback === callback);
        if (index !== -1) workerWaitResources.listeners.splice(index, 1);
        return nativeRemove.call(this, type, callback, options);
      };
    });
    const result = await failureWithinBound(fixture.page, { timeoutMs: 700 });
    assert.match(result, /Service Worker activation\/control deadline after 700ms/);
    assert.equal(fixture.stalledResponses.length, 1, "the real installation fetch must have reached the stalled asset");
    const resources = () => fixture.page.evaluate(() => ({ timers: workerWaitResources.timers.size, listeners: workerWaitResources.listeners.length }));
    assert.deepEqual(await resources(), { timers: 0, listeners: 0 });
    await fixture.resume();
    assert.deepEqual(await registerAndWaitForWorker(fixture.page), { state: "activated", controlled: true });
    assert.deepEqual(await resources(), { timers: 0, listeners: 0 });
  } finally { t.signal.removeEventListener("abort", abort); await fixture.close(); }
});
