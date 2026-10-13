import assert from "node:assert/strict";
import test from "node:test";
import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { createYutoriBrowser } from "./helpers/yutori-browser.mjs";

const { chromium } = createRequire(import.meta.url)("playwright");

// A dedicated browser/context allows the real worker; the ordinary helper still blocks it.
// Missing precache assets must fail before an online application visit can warm the cache.
test("APP_SHELL v0.3.51 installs backup dependencies and boots the backup UI offline", async () => {
  const harness = await createYutoriBrowser();
  let browser;
  const errors = [];
  try {
    const executablePath = [process.env.PLAYWRIGHT_CHROMIUM_PATH, chromium.executablePath(),
      "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe"].find(candidate => candidate && existsSync(candidate));
    browser = await chromium.launch({ executablePath, headless: true });
    const context = await browser.newContext({ serviceWorkers: "allow" });
    const page = await context.newPage();
    page.on("pageerror", error => errors.push(error.message));
    await page.goto(`${harness.origin}/__test_blank__`);
    const installed = await page.evaluate(async () => {
      await navigator.serviceWorker.register("/sw.js");
      const registration = await navigator.serviceWorker.ready;
      if (registration.active.state !== "activated") await new Promise(resolve => {
        registration.active.addEventListener("statechange", () => {
          if (registration.active.state === "activated") resolve();
        });
      });
      if (!navigator.serviceWorker.controller) await new Promise(resolve =>
        navigator.serviceWorker.addEventListener("controllerchange", resolve, { once: true }));
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
    await browser?.close();
    await harness.close();
  }
});
