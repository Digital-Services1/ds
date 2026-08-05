import { createHash, randomBytes } from "node:crypto";
import { mkdir, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

const memoryStores = new Map();
const fileLocks = new Map();

function cloneJson(value) {
  return value == null ? value : JSON.parse(JSON.stringify(value));
}

function asArrayBuffer(value) {
  const buffer = Buffer.isBuffer(value) ? value : Buffer.from(value);
  return buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength);
}

function normalizedStoreName(value) {
  const name = String(value || "default").trim();
  if (!/^[A-Za-z0-9_.-]{1,120}$/.test(name)) throw new Error("Некорректное имя локального хранилища.");
  return name;
}

function normalizedKey(value) {
  const key = String(value || "");
  if (!key || key.length > 500) throw new Error("Некорректный ключ локального хранилища.");
  return key;
}

function keyHash(key) {
  return createHash("sha256").update(key).digest("hex");
}

function etag(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

async function withFileLock(lockKey, operation) {
  const previous = fileLocks.get(lockKey) || Promise.resolve();
  const current = previous.catch(() => {}).then(operation);
  fileLocks.set(lockKey, current);
  try {
    return await current;
  } finally {
    if (fileLocks.get(lockKey) === current) fileLocks.delete(lockKey);
  }
}

async function atomicWrite(path, bytes) {
  const temporary = `${path}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`;
  await writeFile(temporary, bytes);
  await rename(temporary, path);
}

function memoryStore(name) {
  if (!memoryStores.has(name)) memoryStores.set(name, new Map());
  const entries = memoryStores.get(name);

  return {
    async get(key, options = {}) {
      const entry = entries.get(normalizedKey(key));
      if (!entry) return null;
      if (options.type === "json") return entry.kind === "json" ? cloneJson(entry.value) : null;
      if (options.type === "arrayBuffer") return entry.kind === "binary" ? asArrayBuffer(entry.value) : null;
      return entry.kind === "json" ? cloneJson(entry.value) : Buffer.from(entry.value);
    },
    async getWithMetadata(key, options = {}) {
      const entry = entries.get(normalizedKey(key));
      if (!entry) return null;
      const data = options.type === "arrayBuffer"
        ? asArrayBuffer(entry.value)
        : entry.kind === "json" ? cloneJson(entry.value) : Buffer.from(entry.value);
      return { data, metadata: cloneJson(entry.metadata || {}), etag: entry.etag };
    },
    async setJSON(key, value) {
      const normalized = normalizedKey(key);
      const bytes = Buffer.from(JSON.stringify(value));
      entries.set(normalized, { kind: "json", value: cloneJson(value), metadata: {}, etag: etag(bytes) });
    },
    async set(key, value, options = {}) {
      const normalized = normalizedKey(key);
      const bytes = Buffer.from(value);
      entries.set(normalized, {
        kind: "binary",
        value: Buffer.from(bytes),
        metadata: cloneJson(options.metadata || {}),
        etag: etag(bytes)
      });
    },
    async delete(key) {
      entries.delete(normalizedKey(key));
    },
    async list(options = {}) {
      const prefix = String(options.prefix || "");
      return {
        blobs: [...entries.entries()]
          .filter(([key]) => key.startsWith(prefix))
          .map(([key, entry]) => ({ key, etag: entry.etag, metadata: cloneJson(entry.metadata || {}) }))
      };
    }
  };
}

function fileStore(name, storageRoot) {
  const directory = resolve(storageRoot, name);

  function paths(key) {
    const hash = keyHash(normalizedKey(key));
    return {
      hash,
      metadata: resolve(directory, `${hash}.meta.json`),
      json: resolve(directory, `${hash}.json`),
      binary: resolve(directory, `${hash}.bin`)
    };
  }

  async function readEntry(key) {
    const target = paths(key);
    try {
      const metadata = JSON.parse(await readFile(target.metadata, "utf8"));
      const file = metadata.kind === "json" ? target.json : target.binary;
      return { metadata, bytes: await readFile(file), target };
    } catch (error) {
      if (error?.code === "ENOENT") return null;
      throw error;
    }
  }

  return {
    async get(key, options = {}) {
      const entry = await readEntry(key);
      if (!entry) return null;
      if (options.type === "json") {
        return entry.metadata.kind === "json" ? JSON.parse(entry.bytes.toString("utf8")) : null;
      }
      if (options.type === "arrayBuffer") {
        return entry.metadata.kind === "binary" ? asArrayBuffer(entry.bytes) : null;
      }
      return entry.metadata.kind === "json" ? JSON.parse(entry.bytes.toString("utf8")) : entry.bytes;
    },
    async getWithMetadata(key, options = {}) {
      const entry = await readEntry(key);
      if (!entry) return null;
      const data = options.type === "arrayBuffer"
        ? asArrayBuffer(entry.bytes)
        : entry.metadata.kind === "json" ? JSON.parse(entry.bytes.toString("utf8")) : entry.bytes;
      return {
        data,
        metadata: cloneJson(entry.metadata.metadata || {}),
        etag: String(entry.metadata.etag || "")
      };
    },
    async setJSON(key, value) {
      const normalized = normalizedKey(key);
      const target = paths(normalized);
      await withFileLock(`${name}/${target.hash}`, async () => {
        await mkdir(directory, { recursive: true });
        const bytes = Buffer.from(JSON.stringify(value));
        await atomicWrite(target.json, bytes);
        await atomicWrite(target.metadata, Buffer.from(JSON.stringify({
          key: normalized,
          kind: "json",
          etag: etag(bytes),
          metadata: {},
          updatedAt: new Date().toISOString()
        })));
        await rm(target.binary, { force: true });
      });
    },
    async set(key, value, options = {}) {
      const normalized = normalizedKey(key);
      const target = paths(normalized);
      await withFileLock(`${name}/${target.hash}`, async () => {
        await mkdir(directory, { recursive: true });
        const bytes = Buffer.from(value);
        await atomicWrite(target.binary, bytes);
        await atomicWrite(target.metadata, Buffer.from(JSON.stringify({
          key: normalized,
          kind: "binary",
          etag: etag(bytes),
          metadata: cloneJson(options.metadata || {}),
          updatedAt: new Date().toISOString()
        })));
        await rm(target.json, { force: true });
      });
    },
    async delete(key) {
      const target = paths(key);
      await withFileLock(`${name}/${target.hash}`, async () => {
        await Promise.all([
          rm(target.metadata, { force: true }),
          rm(target.json, { force: true }),
          rm(target.binary, { force: true })
        ]);
      });
    },
    async list(options = {}) {
      const prefix = String(options.prefix || "");
      let files;
      try {
        files = await readdir(directory);
      } catch (error) {
        if (error?.code === "ENOENT") return { blobs: [] };
        throw error;
      }
      const blobs = [];
      for (const file of files.filter(item => item.endsWith(".meta.json"))) {
        try {
          const metadata = JSON.parse(await readFile(resolve(directory, file), "utf8"));
          if (String(metadata.key || "").startsWith(prefix)) {
            blobs.push({
              key: metadata.key,
              etag: metadata.etag || "",
              metadata: cloneJson(metadata.metadata || {})
            });
          }
        } catch (_) {}
      }
      return { blobs };
    }
  };
}

export function getStore(options = {}) {
  const name = normalizedStoreName(options.name);
  const storageRoot = String(process.env.DASHBOARD_STORAGE_DIR || "").trim();
  return storageRoot ? fileStore(name, storageRoot) : memoryStore(name);
}
