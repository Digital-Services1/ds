import { createHash } from "node:crypto";
import { getStore } from "./storage.mjs";

const STORE_NAME = "photo360-auth-rate-limit";
const WINDOW_MS = 15 * 60 * 1000;
const MAX_FAILURES = 5;
const memory = new Map();

function clientKey(scope, req) {
  const forwarded = String(req.headers.get("x-forwarded-for") || "").split(",")[0].trim();
  const address = String(req.headers.get("x-real-ip") || req.headers.get("x-nf-client-connection-ip") || forwarded || "unknown");
  const agent = String(req.headers.get("user-agent") || "unknown").slice(0, 180);
  return `${scope}/${createHash("sha256").update(`${address}|${agent}`).digest("hex")}`;
}

function normalized(value) {
  if (!value || Number(value.expiresAt) <= Date.now()) return { failures: 0, expiresAt: Date.now() + WINDOW_MS };
  return { failures: Number(value.failures || 0), expiresAt: Number(value.expiresAt) };
}

async function read(key) {
  try {
    const store = getStore({ name: STORE_NAME, consistency: "strong" });
    return { value: normalized(await store.get(key, { type: "json", consistency: "strong" })), store };
  } catch (_) {
    return { value: normalized(memory.get(key)), store: null };
  }
}

async function write(key, value, store) {
  if (store) {
    try {
      await store.setJSON(key, value);
      return;
    } catch (_) {}
  }
  memory.set(key, value);
}

export async function loginBlock(scope, req) {
  const key = clientKey(scope, req);
  const { value } = await read(key);
  if (value.failures < MAX_FAILURES) return null;
  return { retryAfterSeconds: Math.max(1, Math.ceil((value.expiresAt - Date.now()) / 1000)) };
}

export async function recordLoginFailure(scope, req) {
  const key = clientKey(scope, req);
  const { value, store } = await read(key);
  value.failures += 1;
  await write(key, value, store);
  return {
    blocked: value.failures >= MAX_FAILURES,
    attemptsRemaining: Math.max(0, MAX_FAILURES - value.failures),
    retryAfterSeconds: Math.max(1, Math.ceil((value.expiresAt - Date.now()) / 1000))
  };
}

export async function clearLoginFailures(scope, req) {
  const key = clientKey(scope, req);
  memory.delete(key);
  try {
    const store = getStore({ name: STORE_NAME, consistency: "strong" });
    await store.delete(key);
  } catch (_) {}
}
