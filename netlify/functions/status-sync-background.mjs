import { getStore } from "./_shared/storage.mjs";
import { verifyInternalToken } from "./_shared/internal-auth.mjs";
import {
  BACKUP_STORE_NAME,
  STATUS_STORE_NAME,
  syncPendingOperation
} from "./_shared/status-store.mjs";

export default async (req) => {
  if (req.method !== "POST") return new Response("Method not allowed", { status: 405 });
  const rawBody = await req.text();
  if (!verifyInternalToken(req.headers.get("x-photo-internal"), rawBody)) {
    return new Response("Unauthorized", { status: 401 });
  }
  let body;
  try {
    body = JSON.parse(rawBody);
  } catch (_) {
    return new Response("Bad request", { status: 400 });
  }
  const visitId = String(body?.visitId || "");
  const operationId = String(body?.operationId || "");
  if (!visitId || !operationId) return new Response("Bad request", { status: 400 });

  const store = getStore({ name: STATUS_STORE_NAME, consistency: "strong" });
  const backupStore = getStore({ name: BACKUP_STORE_NAME, consistency: "strong" });
  const result = await syncPendingOperation({
    store,
    backupStore,
    visitId,
    operationId,
    maxAttempts: 4,
    waitBetweenAttempts: true
  });

  if (result?.status === "pending") {
    throw new Error(`Excel sync remains pending after ${result.attempts || 0} attempts.`);
  }
  return Response.json({ ok: true, status: result?.status || "unknown" });
};

export const config = {
  path: "/.netlify/functions/status-sync-background"
};
