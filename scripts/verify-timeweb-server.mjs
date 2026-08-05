import assert from "node:assert/strict";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const storage = await mkdtemp(join(tmpdir(), "photo360-timeweb-test-"));
process.env.RUNTIME_PLATFORM = "timeweb";
process.env.DASHBOARD_STORAGE_DIR = storage;
process.env.DASHBOARD_ACCESS_PASSWORD = "viewer-test-password";
process.env.DASHBOARD_ACCESS_TOKEN_SECRET = "viewer-test-secret-that-is-long-enough";
process.env.DASHBOARD_ADMIN_PASSWORD = "admin-test-password";
process.env.DASHBOARD_ADMIN_TOKEN_SECRET = "admin-test-secret-that-is-long-enough";
process.env.YANDEX_MAPS_API_KEY = "yandex-test-key";

const { createApp } = await import("../server.js");
const { getStore } = await import("../netlify/functions/_shared/storage.mjs");
const app = await createApp();
const server = await new Promise((resolve, reject) => {
  const instance = app.listen(0, "127.0.0.1", () => resolve(instance));
  instance.once("error", reject);
});
const address = server.address();
const origin = `http://127.0.0.1:${address.port}`;

try {
  const health = await fetch(`${origin}/health`);
  assert.equal(health.status, 200);
  assert.equal((await health.json()).ok, true);

  const index = await fetch(`${origin}/index.html`);
  assert.equal(index.status, 200);
  assert.match(index.headers.get("cache-control") || "", /no-store/);
  assert.ok((await index.arrayBuffer()).byteLength < 24105);

  const anonymous = await fetch(`${origin}/api/access-session`);
  assert.equal(anonymous.status, 200);
  assert.equal((await anonymous.json()).authenticated, false);

  const login = await fetch(`${origin}/api/access-session`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ action: "login", password: "viewer-test-password" })
  });
  assert.equal(login.status, 200);
  const cookie = (login.headers.get("set-cookie") || "").split(";")[0];
  assert.ok(cookie.includes("photo_dashboard_access="));

  const fallback = await fetch(`${origin}/api/dashboard-data?mode=bundled`, {
    headers: { cookie }
  });
  assert.equal(fallback.status, 200);
  const data = await fallback.json();
  assert.ok(data.objects.length > 0);
  assert.ok(data.visits.length > 0);

  const legacyAdmin = await fetch(`${origin}/.netlify/functions/status-admin`, {
    headers: { cookie }
  });
  assert.equal(legacyAdmin.status, 200);

  const storageProbe = getStore({ name: "timeweb-storage-probe" });
  await storageProbe.setJSON("settings", { ok: true });
  assert.deepEqual(await storageProbe.get("settings", { type: "json" }), { ok: true });
  await storageProbe.set("backups/sample.xlsx", Uint8Array.from([0x50, 0x4b, 0x03, 0x04]), {
    metadata: { contentType: "application/octet-stream" }
  });
  const storedBytes = await storageProbe.getWithMetadata("backups/sample.xlsx", { type: "arrayBuffer" });
  assert.deepEqual(new Uint8Array(storedBytes.data), Uint8Array.from([0x50, 0x4b, 0x03, 0x04]));
  assert.equal(storedBytes.metadata.contentType, "application/octet-stream");
  assert.deepEqual((await storageProbe.list({ prefix: "backups/" })).blobs.map(item => item.key), ["backups/sample.xlsx"]);
  await storageProbe.delete("backups/sample.xlsx");
  assert.equal(await storageProbe.get("backups/sample.xlsx", { type: "arrayBuffer" }), null);

  const hashedAsset = (await readdir(new URL("../dist", import.meta.url)))
    .find(file => /^app\.v207\.[a-f0-9]{12}\.js$/.test(file));
  assert.ok(hashedAsset);
  const asset = await fetch(`${origin}/${hashedAsset}`);
  assert.equal(asset.status, 200);
  assert.match(asset.headers.get("cache-control") || "", /immutable/);

  console.log("Проверка Timeweb-сервера пройдена.");
} finally {
  server.closeAllConnections?.();
  await new Promise(resolve => server.close(resolve));
  await rm(storage, { recursive: true, force: true });
}
