(function (global) {
  "use strict";

  const FORMAT_VERSION = 1;
  const CHUNK_BYTES = 1024 * 1024;
  const encoder = new TextEncoder();
  const typedArrays = new Map([
    Int8Array, Uint8Array, Uint8ClampedArray, Int16Array, Uint16Array,
    Int32Array, Uint32Array, Float32Array, Float64Array,
    ...(typeof BigInt64Array === "undefined" ? [] : [BigInt64Array, BigUint64Array]),
  ].map(constructor => [constructor.name, constructor]));

  class ArchiveFormatError extends Error {
    constructor(code) {
      super(`Invalid YUTORI backup archive: ${code}`);
      this.name = "ArchiveFormatError";
      this.code = code;
    }
  }
  const fail = code => { throw new ArchiveFormatError(code); };

  // Canonical JSON makes checksums independent of object insertion order.
  function stableStringify(value) {
    if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
    if (value !== null && typeof value === "object") {
      return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(",")}}`;
    }
    return JSON.stringify(value);
  }

  async function digest(bytes) {
    return [...new Uint8Array(await crypto.subtle.digest("SHA-256", bytes))]
      .map(byte => byte.toString(16).padStart(2, "0")).join("");
  }
  const jsonDigest = value => digest(encoder.encode(stableStringify(value)));

  function base64(bytes) {
    let binary = "";
    for (let offset = 0; offset < bytes.length; offset += 8192) {
      binary += String.fromCharCode(...bytes.subarray(offset, offset + 8192));
    }
    return btoa(binary);
  }

  function unbase64(value) {
    if (typeof value !== "string" || value.length > Math.ceil(CHUNK_BYTES / 3) * 4) fail("CHECKSUM_MISMATCH");
    try {
      const binary = atob(value);
      const bytes = Uint8Array.from(binary, char => char.charCodeAt(0));
      if (bytes.length > CHUNK_BYTES || base64(bytes) !== value) fail("CHECKSUM_MISMATCH");
      return bytes;
    } catch { fail("CHECKSUM_MISMATCH"); }
  }

  async function serializeStructuredValue(value) {
    const attachments = [];
    const active = new WeakSet();
    function visit(item) {
      if (item === undefined) return { tag: "Undefined" };
      if (typeof item === "number" && !Number.isFinite(item)) return { tag: "Number", value: String(item) };
      if (typeof item === "bigint") return { tag: "BigInt", value: String(item) };
      if (item === null || ["string", "boolean", "number"].includes(typeof item)) return item;
      if (typeof item !== "object") throw new TypeError("Unsupported structured value");
      if (item instanceof Date) return { tag: "Date", value: item.toISOString() };
      let kind, blob, metadata = {};
      if (item instanceof Blob) {
        kind = item instanceof File ? "File" : "Blob";
        blob = item;
        metadata = { mimeType: item.type };
        if (kind === "File") Object.assign(metadata, { name: item.name, lastModified: item.lastModified });
      } else if (item instanceof ArrayBuffer) {
        kind = "ArrayBuffer";
        blob = new Blob([item]);
      } else if (ArrayBuffer.isView(item)) {
        kind = item instanceof DataView ? "DataView" : "TypedArray";
        blob = new Blob([new Uint8Array(item.buffer, item.byteOffset, item.byteLength)]);
        if (kind === "TypedArray") metadata.typedArrayName = item.constructor.name;
      }
      if (kind) {
        const id = String(attachments.length);
        attachments.push({ id, kind, mimeType: "", ...metadata, byteLength: blob.size, blob });
        return { tag: kind, attachmentId: id, mimeType: "", ...metadata, byteLength: blob.size };
      }
      if (active.has(item)) throw new TypeError("Cyclic structured values are not supported");
      active.add(item);
      let result;
      if (Array.isArray(item)) result = { tag: "Array", values: Array.from(item, visit) };
      else {
        if (Object.getPrototypeOf(item) !== Object.prototype && Object.getPrototypeOf(item) !== null) {
          throw new TypeError("Unsupported structured value");
        }
        result = { tag: "Object", entries: Object.keys(item).sort().map(key => [key, visit(item[key])]) };
      }
      active.delete(item);
      return result;
    }
    return { jsonValue: visit(value), attachments };
  }

  async function deserializeStructuredValue(jsonValue, attachments) {
    const values = attachments instanceof Map ? attachments : new Map((attachments || []).map(item => [item.id, item]));
    async function visit(item) {
      if (item === null || ["string", "boolean", "number"].includes(typeof item)) return item;
      if (!item || typeof item !== "object" || typeof item.tag !== "string") fail("UNSUPPORTED_VERSION");
      switch (item.tag) {
        case "Undefined": return undefined;
        case "Number": {
          if (!["NaN", "Infinity", "-Infinity"].includes(item.value)) fail("CHECKSUM_MISMATCH");
          return Number(item.value);
        }
        case "BigInt": return BigInt(item.value);
        case "Date": {
          const date = new Date(item.value);
          if (!Number.isFinite(date.getTime()) || date.toISOString() !== item.value) fail("CHECKSUM_MISMATCH");
          return date;
        }
        case "Array": {
          if (!Array.isArray(item.values)) fail("CHECKSUM_MISMATCH");
          const array = [];
          for (const child of item.values) array.push(await visit(child));
          return array;
        }
        case "Object": {
          if (!Array.isArray(item.entries)) fail("CHECKSUM_MISMATCH");
          const object = {};
          for (const pair of item.entries) {
            if (!Array.isArray(pair) || pair.length !== 2 || typeof pair[0] !== "string") fail("CHECKSUM_MISMATCH");
            if (Object.hasOwn(object, pair[0])) fail("DUPLICATE_ENTRY");
            Object.defineProperty(object, pair[0], { value: await visit(pair[1]), enumerable: true, writable: true, configurable: true });
          }
          return object;
        }
        case "Blob": case "File": case "ArrayBuffer": case "TypedArray": case "DataView": {
          const attachment = values.get(item.attachmentId);
          if (!attachment) fail("TRUNCATED");
          const blob = attachment instanceof Blob ? attachment : attachment.blob;
          const metadata = attachment instanceof Blob ? item : attachment;
          if (!(blob instanceof Blob)) fail("TRUNCATED");
          if (attachment.kind && attachment.kind !== item.tag) fail("CHECKSUM_MISMATCH");
          if (attachment.byteLength !== undefined && blob.size !== attachment.byteLength) fail("TRUNCATED");
          if (item.tag === "Blob") return blob.slice(0, blob.size, metadata.mimeType ?? blob.type);
          if (item.tag === "File") return new File([blob], metadata.name, { type: metadata.mimeType, lastModified: metadata.lastModified });
          const buffer = await blob.arrayBuffer();
          if (item.tag === "ArrayBuffer") return buffer;
          if (item.tag === "DataView") return new DataView(buffer);
          const constructor = typedArrays.get(metadata.typedArrayName);
          if (!constructor) fail("UNSUPPORTED_VERSION");
          if (buffer.byteLength % constructor.BYTES_PER_ELEMENT !== 0) fail("CHECKSUM_MISMATCH");
          return new constructor(buffer);
        }
        default: fail("UNSUPPORTED_VERSION");
      }
    }
    return visit(jsonValue);
  }

  async function recordIdentity(record) {
    if (!record || typeof record.type !== "string" || !Object.hasOwn(record, "key")) fail("CHECKSUM_MISMATCH");
    if (record.source !== "localStorage" && record.source !== "indexedDB") fail("UNSUPPORTED_VERSION");
    if (record.source === "localStorage" && typeof record.key !== "string") fail("CHECKSUM_MISMATCH");
    if (record.source === "indexedDB" && typeof record.store !== "string") fail("CHECKSUM_MISMATCH");
    const key = await serializeStructuredValue(record.key);
    const binaryHashes = [];
    for (const attachment of key.attachments) {
      const hashes = [];
      for (let start = 0; start < attachment.blob.size; start += CHUNK_BYTES) {
        hashes.push(await digest(await attachment.blob.slice(start, start + CHUNK_BYTES).arrayBuffer()));
      }
      binaryHashes.push(hashes);
    }
    return stableStringify([record.source, record.source === "indexedDB" ? record.store : null, key.jsonValue, binaryHashes]);
  }

  function increment(counts, type) {
    Object.defineProperty(counts, type, { value: (Object.hasOwn(counts, type) ? counts[type] : 0) + 1, enumerable: true, writable: true, configurable: true });
  }

  function createArchiveStream(manifest, records, options = {}) {
    const chunkBytes = options.chunkBytes ?? CHUNK_BYTES;
    if (!Number.isInteger(chunkBytes) || chunkBytes < 1 || chunkBytes > CHUNK_BYTES) throw new RangeError("Invalid archive chunk size");
    const counts = {};
    const digests = [];
    const identities = new Set();
    async function* frames() {
      const header = { type: "header", magic: "YUTORI-BACKUP", formatVersion: FORMAT_VERSION, manifest };
      const headerHash = await jsonDigest(header);
      digests.push(headerHash);
      yield { ...header, checksum: headerHash };
      let ordinal = 0;
      for await (const record of records) {
        const identity = await recordIdentity(record);
        if (identities.has(identity)) fail("DUPLICATE_ENTRY");
        identities.add(identity);
        const encoded = await serializeStructuredValue(record);
        const attachments = encoded.attachments.map(({ blob, ...metadata }) => ({
          ...metadata, id: `${ordinal}:${metadata.id}`, chunks: Math.ceil(blob.size / chunkBytes),
        }));
        // Tagged references remain local to the logical record. Frame ids are archive-wide.
        const body = { type: "record", record: encoded.jsonValue, attachments };
        const checksum = await jsonDigest(body);
        digests.push(checksum);
        yield { ...body, checksum };
        for (let i = 0; i < encoded.attachments.length; i++) {
          const blob = encoded.attachments[i].blob;
          let index = 0;
          for (let start = 0; start < blob.size; start += chunkBytes) {
            const bytes = new Uint8Array(await blob.slice(start, start + chunkBytes).arrayBuffer());
            const checksum = await digest(bytes);
            const chunk = { type: "chunk", attachmentId: attachments[i].id, index: index++, data: base64(bytes), checksum };
            digests.push(await jsonDigest(chunk));
            yield chunk;
          }
        }
        increment(counts, record.type);
        ordinal++;
      }
      if (manifest.counts && stableStringify(manifest.counts) !== stableStringify(counts)) fail("CHECKSUM_MISMATCH");
      yield { type: "end", counts, archiveHash: await jsonDigest(digests) };
    }
    const iterator = frames();
    const source = new ReadableStream({
      async pull(controller) {
        try {
          const next = await iterator.next();
          if (next.done) controller.close();
          else controller.enqueue(encoder.encode(stableStringify(next.value) + "\n"));
        } catch (error) { controller.error(error); }
      },
      async cancel() { await iterator.return(); },
    });
    let totalBytes = 0;
    return source.pipeThrough(new CompressionStream("gzip")).pipeThrough(new TransformStream({
      transform(bytes, controller) {
        totalBytes += bytes.byteLength;
        options.onProgress?.({ counts: { ...counts }, totalBytes });
        controller.enqueue(bytes);
      },
    }));
  }

  async function* readLines(stream) {
    const reader = stream.getReader();
    const decoder = new TextDecoder("utf-8", { fatal: true });
    let pending = "";
    try {
      while (true) {
        let next;
        try { next = await reader.read(); }
        catch (error) {
          // Only stream/decompression failures are incomplete archives. Consumer
          // errors must escape unchanged so storage failures remain diagnosable.
          if (error instanceof TypeError || error instanceof DOMException) fail("TRUNCATED");
          throw error;
        }
        if (next.done) break;
        pending += decoder.decode(next.value, { stream: true });
        let end;
        while ((end = pending.indexOf("\n")) !== -1) {
          const line = pending.slice(0, end);
          pending = pending.slice(end + 1);
          if (!line) fail("CHECKSUM_MISMATCH");
          try { yield JSON.parse(line); } catch (error) {
            if (error instanceof ArchiveFormatError) throw error;
            fail("CHECKSUM_MISMATCH");
          }
        }
      }
      pending += decoder.decode();
      if (pending) fail("TRUNCATED");
    } finally {
      await reader.cancel().catch(() => {});
      reader.releaseLock();
    }
  }

  async function readArchiveStream(source, handlers = {}, options = {}) {
    let totalBytes = 0;
    const input = source instanceof Blob ? source.stream() : source;
    const measured = input.pipeThrough(new TransformStream({
      transform(bytes, controller) { totalBytes += bytes.byteLength; controller.enqueue(bytes); },
    }));
    const counts = {};
    const digests = [];
    const identities = new Set();
    const attachmentIds = new Set();
    let header, end, pending;

    async function finishRecord() {
      if (!pending) return;
      if (pending.attachments.some(item => item.nextIndex !== item.chunks || item.receivedBytes !== item.byteLength)) fail("TRUNCATED");
      const attachments = pending.attachments.map((item, index) => ({ ...item, id: String(index), blob: new Blob(item.parts, { type: item.mimeType }) }));
      const record = await deserializeStructuredValue(pending.record, attachments);
      const identity = await recordIdentity(record);
      if (identities.has(identity)) fail("DUPLICATE_ENTRY");
      identities.add(identity);
      increment(counts, record.type);
      await handlers.onRecord?.(record);
      options.onProgress?.({ counts: { ...counts }, totalBytes });
      pending = null;
    }

    for await (const frame of readLines(measured.pipeThrough(new DecompressionStream("gzip")))) {
        if (!header) {
          if (frame?.type !== "header" || frame.magic !== "YUTORI-BACKUP") fail("BAD_MAGIC");
          if (frame.formatVersion !== FORMAT_VERSION) fail("UNSUPPORTED_VERSION");
          const { checksum, ...body } = frame;
          if (await jsonDigest(body) !== checksum) fail("CHECKSUM_MISMATCH");
          if (!frame.manifest || typeof frame.manifest !== "object" || Array.isArray(frame.manifest)) fail("CHECKSUM_MISMATCH");
          header = frame;
          digests.push(checksum);
          continue;
        }
        if (end) fail("CHECKSUM_MISMATCH");
        if (frame.type === "record") {
          await finishRecord();
          const { checksum, ...body } = frame;
          if (await jsonDigest(body) !== checksum) fail("CHECKSUM_MISMATCH");
          if (!Array.isArray(frame.attachments)) fail("CHECKSUM_MISMATCH");
          const attachments = frame.attachments.map(item => {
            if (typeof item.id !== "string" || !Number.isSafeInteger(item.byteLength) || item.byteLength < 0 ||
                !Number.isSafeInteger(item.chunks) || item.chunks < 0 || (item.byteLength === 0) !== (item.chunks === 0) ||
                item.chunks > item.byteLength || item.byteLength > item.chunks * CHUNK_BYTES) fail("CHECKSUM_MISMATCH");
            if (attachmentIds.has(item.id)) fail("DUPLICATE_ENTRY");
            attachmentIds.add(item.id);
            return { ...item, parts: [], nextIndex: 0, receivedBytes: 0 };
          });
          pending = { record: frame.record, attachments };
          digests.push(checksum);
        } else if (frame.type === "chunk") {
          const attachment = pending?.attachments.find(item => item.id === frame.attachmentId);
          if (!attachment) fail(attachmentIds.has(frame.attachmentId) ? "DUPLICATE_ENTRY" : "TRUNCATED");
          if (!Number.isSafeInteger(frame.index) || frame.index < 0) fail("CHECKSUM_MISMATCH");
          if (frame.index < attachment.nextIndex) fail("DUPLICATE_ENTRY");
          if (frame.index !== attachment.nextIndex) fail("TRUNCATED");
          if (frame.index >= attachment.chunks) fail("DUPLICATE_ENTRY");
          const bytes = unbase64(frame.data);
          if (!bytes.length || await digest(bytes) !== frame.checksum) fail("CHECKSUM_MISMATCH");
          attachment.receivedBytes += bytes.byteLength;
          if (attachment.receivedBytes > attachment.byteLength) fail("CHECKSUM_MISMATCH");
          attachment.parts.push(new Blob([bytes]));
          attachment.nextIndex++;
          digests.push(await jsonDigest(frame));
        } else if (frame.type === "end") {
          await finishRecord();
          if (stableStringify(counts) !== stableStringify(frame.counts) ||
              (header.manifest.counts && stableStringify(counts) !== stableStringify(header.manifest.counts)) ||
              await jsonDigest(digests) !== frame.archiveHash) fail("CHECKSUM_MISMATCH");
          end = frame;
        } else fail("UNSUPPORTED_VERSION");
    }
    if (!header || !end) fail("TRUNCATED");
    return { manifest: header.manifest, counts, totalBytes, archiveHash: end.archiveHash };
  }

  global.YutoriBackupArchive = Object.freeze({
    FORMAT_VERSION, ArchiveFormatError, createArchiveStream, readArchiveStream,
    serializeStructuredValue, deserializeStructuredValue,
  });
})(globalThis);
