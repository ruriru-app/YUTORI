import assert from "node:assert/strict";
import test, { after, afterEach, before, beforeEach } from "node:test";
import { createYutoriBrowser } from "./helpers/yutori-browser.mjs";

let harness, page, pageErrors;
before(async () => { harness = await createYutoriBrowser(); });
beforeEach(async () => {
  page = await harness.freshPage();
  pageErrors = [];
  page.on("pageerror", error => pageErrors.push(error.message));
  const response = await page.request.get(`${harness.origin}/assets/yutori-backup-archive.js`);
  if (response.ok()) await page.addScriptTag({ content: await response.text() });
});
afterEach(async () => {
  await page?.context().close();
  assert.deepEqual(pageErrors, [], "no unhandled browser errors");
});
after(async () => { await harness?.close(); });

test("format 1 round-trips Unicode and structured browser values across multiple chunks", async () => {
  assert.equal(await page.evaluate(() => typeof window.YutoriBackupArchive), "object", "the archive codec must be available");
  const result = await page.evaluate(async () => {
    const api = YutoriBackupArchive;
    const binary = Uint8Array.from({ length: 2 * 1024 * 1024 + 37 }, (_, i) => i % 251);
    const value = {
      name: "山田 花子 📝", nested: { note: "数学\n答案" }, date: new Date("2026-10-13T01:02:03.004Z"),
      blob: new Blob([binary], { type: "application/pdf" }),
      file: new File(["こんにちは"], "答案_日本語.pdf", { type: "application/pdf", lastModified: 123456789 }),
      buffer: new Uint8Array([0, 128, 255]).buffer,
      typed: new Int16Array(new Int16Array([99, -32768, 12, 32767]).buffer, 2, 2),
      view: new DataView(new Uint8Array([8, 9, 10]).buffer, 1, 2),
      collision: { $yutori: "Date", value: "ordinary object" },
    };
    const serialized = await api.serializeStructuredValue(value);
    const direct = await api.deserializeStructuredValue(serialized.jsonValue, serialized.attachments);
    const arrayBuffer = Blob.prototype.arrayBuffer;
    let largestRead = 0;
    Blob.prototype.arrayBuffer = function () {
      largestRead = Math.max(largestRead, this.size);
      if (this.size > 1024 * 1024) throw new Error("whole binary materialized");
      return arrayBuffer.call(this);
    };
    const records = (async function* () {
      yield { type: "localStorage", source: "localStorage", key: "yutori_名簿", value: "花子" };
      yield { type: "indexedDB", source: "indexedDB", store: "pdfFiles", key: ["答案", 7], value };
    })();
    let archive;
    const progress = [];
    try { archive = await new Response(api.createArchiveStream({ appVersion: "v0.3.40", counts: { localStorage: 1, indexedDB: 1 } }, records, { onProgress: data => progress.push(data) })).blob(); }
    finally { Blob.prototype.arrayBuffer = arrayBuffer; }
    const frames = (await new Response(archive.stream().pipeThrough(new DecompressionStream("gzip"))).text()).trim().split("\n").map(JSON.parse);
    const received = [];
    const validated = await api.readArchiveStream(archive, { onRecord: record => received.push(record) });
    const restored = received[1].value;
    const restoredBytes = new Uint8Array(await restored.blob.arrayBuffer());
    return {
      format: api.FORMAT_VERSION, sourceVersion: validated.manifest.appVersion,
      counts: validated.counts, totalBytes: validated.totalBytes, archiveSize: archive.size,
      hash: validated.archiveHash, endHash: frames.at(-1).archiveHash,
      magic: frames[0].magic, chunks: frames.filter(f => f.type === "chunk").length,
      maxChunkBytes: Math.max(...frames.filter(f => f.type === "chunk").map(f => atob(f.data).length)),
      largestRead, progressCalls: progress.length, sameBytes: restoredBytes.every((byte, i) => byte === i % 251),
      name: restored.name, date: restored.date.toISOString(), blobType: restored.blob.type, blobSize: restored.blob.size,
      file: { name: restored.file.name, type: restored.file.type, lastModified: restored.file.lastModified, text: await restored.file.text() },
      buffer: [...new Uint8Array(restored.buffer)], typed: [...restored.typed], typedName: restored.typed.constructor.name,
      view: [...new Uint8Array(restored.view.buffer, restored.view.byteOffset, restored.view.byteLength)],
      collision: restored.collision, directDate: direct.date.toISOString(), key: received[1].key,
    };
  });
  assert.equal(result.format, 1);
  assert.equal(result.magic, "YUTORI-BACKUP");
  assert.equal(result.sourceVersion, "v0.3.40");
  assert.deepEqual(result.counts, { localStorage: 1, indexedDB: 1 });
  assert.equal(result.totalBytes, result.archiveSize);
  assert.match(result.hash, /^[a-f0-9]{64}$/);
  assert.equal(result.hash, result.endHash);
  assert.ok(result.chunks >= 3);
  assert.ok(result.maxChunkBytes <= 1024 * 1024);
  assert.ok(result.largestRead <= 1024 * 1024);
  assert.ok(result.progressCalls > 0);
  assert.equal(result.sameBytes, true);
  assert.equal(result.name, "山田 花子 📝");
  assert.equal(result.date, "2026-10-13T01:02:03.004Z");
  assert.equal(result.directDate, result.date);
  assert.equal(result.blobType, "application/pdf");
  assert.equal(result.blobSize, 2 * 1024 * 1024 + 37);
  assert.deepEqual(result.file, { name: "答案_日本語.pdf", type: "application/pdf", lastModified: 123456789, text: "こんにちは" });
  assert.deepEqual(result.buffer, [0, 128, 255]);
  assert.deepEqual(result.typed, [-32768, 12]);
  assert.equal(result.typedName, "Int16Array");
  assert.deepEqual(result.view, [9, 10]);
  assert.deepEqual(result.collision, { $yutori: "Date", value: "ordinary object" });
  assert.deepEqual(result.key, ["答案", 7]);
});

test("structured metadata survives a Blob attachment map", async () => {
  const result = await page.evaluate(async () => {
    const api = YutoriBackupArchive;
    const encoded = await api.serializeStructuredValue({
      file: new File(["答案"], "答案.txt", { type: "text/plain", lastModified: 1234 }),
      typed: new Uint16Array([256, 65535]),
    });
    const restored = await api.deserializeStructuredValue(encoded.jsonValue, new Map(encoded.attachments.map(item => [item.id, item.blob])));
    return { name: restored.file.name, type: restored.file.type, modified: restored.file.lastModified, text: await restored.file.text(), typed: [...restored.typed] };
  });
  assert.deepEqual(result, { name: "答案.txt", type: "text/plain", modified: 1234, text: "答案", typed: [256, 65535] });
});

test("reader preserves failures from its asynchronous consumer", async () => {
  const result = await page.evaluate(async () => {
    const api = YutoriBackupArchive;
    const archive = await new Response(api.createArchiveStream({}, (async function* () {
      yield { type: "localStorage", source: "localStorage", key: "yutori_test", value: "答案" };
    })())).blob();
    const expected = new TypeError("consumer failed");
    try { await api.readArchiveStream(archive, { async onRecord() { throw expected; } }); }
    catch (error) { return { sameError: error === expected, name: error.name }; }
  });
  assert.deepEqual(result, { sameError: true, name: "TypeError" });
});

test("record hashes are canonical and the final digest protects chunk routing", async () => {
  const result = await page.evaluate(async () => {
    const api = YutoriBackupArchive;
    const encode = async value => {
      const archive = await new Response(api.createArchiveStream({}, (async function* () {
        yield { type: "indexedDB", source: "indexedDB", store: "pdfPages", key: 1, value };
      })())).blob();
      return (await new Response(archive.stream().pipeThrough(new DecompressionStream("gzip"))).text()).trim().split("\n").map(JSON.parse);
    };
    const first = await encode({ z: "日本語", a: "答案" });
    const second = await encode({ a: "答案", z: "日本語" });
    const frames = await encode({ a: new Blob(["AA"]), b: new Blob(["BB"]) });
    const chunks = frames.filter(frame => frame.type === "chunk");
    [chunks[0].attachmentId, chunks[1].attachmentId] = [chunks[1].attachmentId, chunks[0].attachmentId];
    const changed = new Blob([frames.map(frame => JSON.stringify(frame) + "\n").join("")]).stream().pipeThrough(new CompressionStream("gzip"));
    let routingError = "ACCEPTED";
    try { await api.readArchiveStream(changed); } catch (error) { routingError = error.code; }
    return { sameRecordHash: first[1].checksum === second[1].checksum, sameArchiveHash: first.at(-1).archiveHash === second.at(-1).archiveHash, routingError };
  });
  assert.deepEqual(result, { sameRecordHash: true, sameArchiveHash: true, routingError: "CHECKSUM_MISMATCH" });
});

test("localStorage identity ignores unrelated fields and rejects duplicate keys", async () => {
  const code = await page.evaluate(async () => {
    const api = YutoriBackupArchive;
    const records = (async function* () {
      yield { type: "localStorage", source: "localStorage", key: "yutori_name", value: "花子" };
      yield { type: "localStorage", source: "localStorage", key: "yutori_name", store: "irrelevant", value: "太郎" };
    })();
    const reader = api.createArchiveStream({}, records).getReader();
    try { while (!(await reader.read()).done) {} return "ACCEPTED"; }
    catch (error) { return error.code; }
  });
  assert.equal(code, "DUPLICATE_ENTRY");
});

test("writer and reader detect equivalent IndexedDB binary keys inside nested compounds", async () => {
  const results = await page.evaluate(async () => {
    const api = YutoriBackupArchive;
    const backing = new Uint8Array([99, 1, 2, 88]).buffer;
    const plain = new Uint8Array([1, 2]).buffer;
    const large = new Uint8Array(1024 * 1024 + 3).fill(7);
    const pairs = [
      [plain, new Uint8Array(backing, 1, 2)],
      [new Uint16Array(plain), new DataView(backing, 1, 2)],
      [["答案", [12, plain]], ["答案", [12, new DataView(backing, 1, 2)]]],
      [[new Uint8Array(plain), ["名簿", new DataView(backing, 1, 2)]], [plain, ["名簿", new Uint16Array(plain)]]],
      [large.buffer, large],
    ];
    const canonical = value => Array.isArray(value) ? `[${value.map(canonical).join(",")}]` :
      value !== null && typeof value === "object" ? `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(",")}}` : JSON.stringify(value);
    const hash = async value => [...new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(canonical(value))))].map(byte => byte.toString(16).padStart(2, "0")).join("");
    const output = [];
    for (const [first, second] of pairs) {
      const records = store => (async function* () {
        yield { type: "indexedDB", source: "indexedDB", store: "pdfFiles", key: first, value: "花子" };
        yield { type: "indexedDB", source: "indexedDB", store, key: second, value: "太郎" };
      })();
      let writer = "ACCEPTED";
      const arrayBuffer = Blob.prototype.arrayBuffer;
      Blob.prototype.arrayBuffer = function () {
        if (this.size > 1024 * 1024) throw new Error("unbounded key read");
        return arrayBuffer.call(this);
      };
      try {
        const reader = api.createArchiveStream({}, records("pdfFiles")).getReader();
        while (!(await reader.read()).done) {}
      } catch (error) { writer = error.code ?? error.name; }
      finally { Blob.prototype.arrayBuffer = arrayBuffer; }
      // Make a valid two-store archive, then independently re-sign it with both
      // records in one store. The writer cannot suppress the reader regression.
      const archive = await new Response(api.createArchiveStream({}, records("otherStore"))).blob();
      const frames = (await new Response(archive.stream().pipeThrough(new DecompressionStream("gzip"))).text()).trim().split("\n").map(JSON.parse);
      const digests = [frames[0].checksum];
      for (const frame of frames.slice(1, -1)) {
        if (frame.type === "record") {
          frame.record.entries.find(entry => entry[0] === "store")[1] = "pdfFiles";
          const { checksum, ...body } = frame;
          frame.checksum = await hash(body);
          digests.push(frame.checksum);
        } else digests.push(await hash(frame));
      }
      frames.at(-1).archiveHash = await hash(digests);
      const changed = new Blob([frames.map(frame => canonical(frame) + "\n").join("")]).stream().pipeThrough(new CompressionStream("gzip"));
      let reader = "ACCEPTED";
      try { await api.readArchiveStream(changed); } catch (error) { reader = error.code ?? error.name; }
      output.push({ nativeEquality: indexedDB.cmp(first, second), writer, reader });
    }
    return output;
  });
  assert.deepEqual(results, Array.from({ length: 5 }, () => ({ nativeEquality: 0, writer: "DUPLICATE_ENTRY", reader: "DUPLICATE_ENTRY" })));
});

test("malformed UTF-8, frames, and structured payloads return stable corruption errors", async () => {
  const result = await page.evaluate(async () => {
    const api = YutoriBackupArchive;
    const archive = await new Response(api.createArchiveStream({}, (async function* () {})())).blob();
    const header = (await new Response(archive.stream().pipeThrough(new DecompressionStream("gzip"))).text()).split("\n")[0] + "\n";
    const failure = async operation => {
      try { await operation(); return "ACCEPTED"; }
      catch (error) { return error instanceof api.ArchiveFormatError ? error.code : error.name; }
    };
    const packed = parts => new Blob(parts).stream().pipeThrough(new CompressionStream("gzip"));
    const utf8 = await failure(() => api.readArchiveStream(packed([new Uint8Array([255, 10])])));
    const incompleteUtf8 = await failure(() => api.readArchiveStream(packed([header, new Uint8Array([0xe3])])));
    const frames = [];
    for (const frame of [null, 7, true, "record", []]) {
      frames.push(await failure(() => api.readArchiveStream(packed([header, JSON.stringify(frame) + "\n"]))));
    }
    const payloads = [];
    for (const jsonValue of [
      { tag: "BigInt", value: "not-an-integer" }, { tag: "BigInt", value: {} },
      { tag: "Array", values: null }, { tag: "Object", entries: [null] }, { tag: "Date", value: "not-a-date" },
    ]) payloads.push(await failure(() => api.deserializeStructuredValue(jsonValue, [])));
    const attachments = await failure(() => api.deserializeStructuredValue({ tag: "Blob", attachmentId: "0" }, [null]));
    const fileMetadata = await failure(() => api.deserializeStructuredValue({ tag: "File", attachmentId: "0" }, [{
      id: "0", kind: "File", blob: new Blob([]), byteLength: 0,
      name: { toString: 0, valueOf: 0 }, mimeType: "", lastModified: 1,
    }]));
    return { utf8, incompleteUtf8, frames, payloads, attachments, fileMetadata };
  });
  assert.deepEqual(result, {
    utf8: "CHECKSUM_MISMATCH", incompleteUtf8: "CHECKSUM_MISMATCH",
    frames: Array(5).fill("CHECKSUM_MISMATCH"), payloads: Array(5).fill("CHECKSUM_MISMATCH"), attachments: "CHECKSUM_MISMATCH", fileMetadata: "CHECKSUM_MISMATCH",
  });
});

test("oversized unterminated frames are rejected early and writer uses the same byte budget", async () => {
  const result = await page.evaluate(async () => {
    const api = YutoriBackupArchive;
    const parts = [];
    let seed = 12345;
    for (let i = 0; i < 128; i++) {
      const bytes = new Uint8Array(64 * 1024);
      for (let j = 0; j < bytes.length; j++) {
        seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
        bytes[j] = 32 + (seed >>> 24) % 95; // ASCII, deliberately no newline.
      }
      parts.push(bytes);
    }
    const compressed = await new Response(new Blob(parts).stream().pipeThrough(new CompressionStream("gzip"))).blob();
    let offset = 0, cancelled = false;
    const source = new ReadableStream({
      async pull(controller) {
        if (offset === compressed.size) return controller.close();
        const end = Math.min(offset + 512, compressed.size);
        controller.enqueue(new Uint8Array(await compressed.slice(offset, end).arrayBuffer()));
        offset = end;
      },
      cancel() { cancelled = true; },
    });
    let overflowCode = "ACCEPTED";
    try { await api.readArchiveStream(source); }
    catch (error) { overflowCode = error.code ?? error.name; }
    await new Promise(resolve => setTimeout(resolve, 0));
    const writerCode = async (manifest, value) => {
      const reader = api.createArchiveStream(manifest, (async function* () {
        yield { type: "localStorage", source: "localStorage", key: "yutori_limit", value };
      })()).getReader();
      try { while (!(await reader.read()).done) {} return "ACCEPTED"; }
      catch (error) { return error.code ?? error.name; }
    };
    const metadata = await writerCode({ note: "x".repeat(2 * 1024 * 1024) }, "small");
    const record = await writerCode({}, "x".repeat(2 * 1024 * 1024));
    const utf8Record = await writerCode({}, "あ".repeat(800000));
    const supported = "x".repeat(2 * 1024 * 1024 - 1024);
    const archive = await new Response(api.createArchiveStream({}, (async function* () {
      yield { type: "localStorage", source: "localStorage", key: "yutori_limit", value: supported };
    })())).blob();
    let restored;
    await api.readArchiveStream(archive, { onRecord(item) { restored = item.value; } });
    return { overflowCode, cancelled, consumedBytes: offset, compressedBytes: compressed.size, metadata, record, utf8Record, nearLimitRoundTrip: restored === supported };
  });
  assert.equal(result.overflowCode, "CHECKSUM_MISMATCH");
  assert.equal(result.cancelled, true);
  assert.ok(result.consumedBytes < result.compressedBytes / 2, "reject without consuming most of the no-newline input");
  assert.equal(result.metadata, "CHECKSUM_MISMATCH");
  assert.equal(result.record, "CHECKSUM_MISMATCH");
  assert.equal(result.utf8Record, "CHECKSUM_MISMATCH", "budget counts UTF-8 bytes rather than string characters");
  assert.equal(result.nearLimitRoundTrip, true);
});

test("truncation, a changed chunk checksum, duplicate entries, and format 2 are rejected", async () => {
  assert.equal(await page.evaluate(() => typeof window.YutoriBackupArchive), "object", "the archive codec must be available");
  const results = await page.evaluate(async () => {
    const api = YutoriBackupArchive;
    const make = () => (async function* () {
      yield { type: "indexedDB", source: "indexedDB", store: "pdfFiles", key: 1, value: new Blob([new Uint8Array([1, 2, 3, 4, 5])]) };
    })();
    const archive = await new Response(api.createArchiveStream({}, make(), { chunkBytes: 2 })).blob();
    const frames = (await new Response(archive.stream().pipeThrough(new DecompressionStream("gzip"))).text()).trim().split("\n").map(JSON.parse);
    const pack = frames => new Blob([frames.map(frame => JSON.stringify(frame) + "\n").join("")]).stream().pipeThrough(new CompressionStream("gzip"));
    const failure = async source => {
      try { await api.readArchiveStream(source, { onRecord() {} }); return "ACCEPTED"; }
      catch (error) { return error instanceof api.ArchiveFormatError ? error.code : error.name; }
    };
    const mutate = change => { const copy = structuredClone(frames); change(copy); return pack(copy); };
    const output = {};
    output.badMagic = await failure(mutate(f => { f[0].magic = "OTHER"; }));
    output.version = await failure(mutate(f => { f[0].formatVersion = 2; }));
    output.truncated = await failure(archive.slice(0, archive.size - 8));
    output.missingEnd = await failure(pack(frames.slice(0, -1)));
    output.checksum = await failure(mutate(f => { f.find(f => f.type === "chunk").checksum = "0".repeat(64); }));
    output.changedData = await failure(mutate(f => { f.find(f => f.type === "chunk").data = "CQI="; }));
    output.duplicate = await failure(mutate(f => { f.splice(-1, 0, ...structuredClone(f.slice(1, -1))); }));
    output.duplicateChunk = await failure(mutate(f => { const i = f.findIndex(f => f.type === "chunk"); f.splice(i, 0, structuredClone(f[i])); }));
    output.missingChunk = await failure(mutate(f => { f.splice(f.findIndex(f => f.type === "chunk"), 1); }));
    output.counts = await failure(mutate(f => { f.at(-1).counts.indexedDB = 7; }));
    output.archiveHash = await failure(mutate(f => { f.at(-1).archiveHash = "0".repeat(64); }));
    output.unknownType = await failure(mutate(f => { f.splice(1, 0, { type: "future-required" }); }));
    const unknownValue = await api.serializeStructuredValue({ date: new Date() });
    const changeTag = node => {
      if (node && typeof node === "object") {
        for (const key of Object.keys(node)) {
          if (node[key] === "Date") node[key] = "FutureDate";
          else changeTag(node[key]);
        }
      }
    };
    changeTag(unknownValue.jsonValue);
    try { await api.deserializeStructuredValue(unknownValue.jsonValue, unknownValue.attachments); output.unknownTag = "ACCEPTED"; }
    catch (error) { output.unknownTag = error.code; }
    let called = false;
    await api.readArchiveStream(archive.stream(), { async onRecord() { await Promise.resolve(); called = true; } });
    output.streamSource = called;
    return output;
  });
  assert.deepEqual(results, {
    badMagic: "BAD_MAGIC", version: "UNSUPPORTED_VERSION", truncated: "TRUNCATED", missingEnd: "TRUNCATED",
    checksum: "CHECKSUM_MISMATCH", changedData: "CHECKSUM_MISMATCH", duplicate: "DUPLICATE_ENTRY", duplicateChunk: "DUPLICATE_ENTRY",
    missingChunk: "TRUNCATED", counts: "CHECKSUM_MISMATCH", archiveHash: "CHECKSUM_MISMATCH",
    unknownType: "UNSUPPORTED_VERSION", unknownTag: "UNSUPPORTED_VERSION", streamSource: true,
  });
});
