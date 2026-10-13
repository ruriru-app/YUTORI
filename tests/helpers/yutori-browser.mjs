import { existsSync } from "node:fs";
import { readFile, stat } from "node:fs/promises";
import http from "node:http";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const { chromium } = require("playwright");
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const mimeTypes = new Map([[".html", "text/html; charset=utf-8"], [".js", "text/javascript; charset=utf-8"], [".ttf", "font/ttf"], [".svg", "image/svg+xml"]]);

export async function createYutoriBrowser() {
  const server = http.createServer(async (request, response) => {
    try {
      const requestPath = decodeURIComponent(new URL(request.url, "http://localhost").pathname);
      // A blank same-origin page permits browser-native codec tests without app startup.
      if (requestPath === "/__test_blank__") {
        response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
        return response.end("<!doctype html><title>YUTORI browser test</title>");
      }
      const filePath = path.resolve(root, requestPath === "/" ? "index.html" : requestPath.slice(1));
      if (!filePath.startsWith(`${root}${path.sep}`)) return response.writeHead(403).end();
      if (!(await stat(filePath)).isFile()) throw new Error("not a file");
      response.writeHead(200, { "content-type": mimeTypes.get(path.extname(filePath)) || "application/octet-stream" });
      response.end(await readFile(filePath));
    } catch {
      response.writeHead(404).end();
    }
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const executablePath = [process.env.PLAYWRIGHT_CHROMIUM_PATH, chromium.executablePath(), "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe"].find(candidate => candidate && existsSync(candidate));
  let browser;
  try {
    browser = await chromium.launch({ executablePath, headless: true });
  } catch (error) {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    throw error;
  }
  return {
    origin,
    async freshPage({ pathname = "/__test_blank__", scripts = [], ...contextOptions } = {}) {
      const context = await browser.newContext({ ...contextOptions, serviceWorkers: "block" });
      const page = await context.newPage();
      await page.goto(`${origin}${pathname}`, { waitUntil: "domcontentloaded", timeout: 15_000 });
      if (pathname !== "/__test_blank__") await page.evaluate(() => globalThis.yutoriAppInitialization);
      for (const script of scripts) await page.addScriptTag({ url: `${origin}/${script}` });
      return page;
    },
    async close() {
      await browser.close();
      server.closeAllConnections();
      await new Promise(resolve => server.close(resolve));
    },
  };
}
