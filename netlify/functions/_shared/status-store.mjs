import { syncVisitStatusToExcel, excelSyncErrorDetails } from "./nextcloud-excel-sync.mjs";

export const STATUS_STORE_NAME = "photo360-status-overrides";
export const STATUS_STORE_KEY = "visit-statuses";
export const BACKUP_STORE_NAME = "photo360-excel-backups";

export function emptyStatusDocument() {
  return { version: 2, updatedAt: null, items: {}, audit: [] };
}

export async function readStatusDocument(store) {
  const value = await store.get(STATUS_STORE_KEY, { type: "json", consistency: "strong" });
  if (!value || typeof value !== "object") return emptyStatusDocument();
  return {
    version: 2,
    updatedAt: value.updatedAt || null,
    items: value.items && typeof value.items === "object" ? value.items : {},
    audit: Array.isArray(value.audit) ? value.audit : []
  };
}

export async function writeStatusDocument(store, document) {
  document.updatedAt = new Date().toISOString();
  document.audit = Array.isArray(document.audit) ? document.audit.slice(0, 300) : [];
  await store.setJSON(STATUS_STORE_KEY, document);
  return document;
}

function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

export async function syncPendingOperation({
  store,
  backupStore,
  visitId,
  operationId,
  maxAttempts = 1,
  waitBetweenAttempts = false
}) {
  let lastResult = null;
  for (let attempt = 1; attempt <= Math.max(1, maxAttempts); attempt += 1) {
    const before = await readStatusDocument(store);
    const item = before.items[visitId];
    if (!item || item.operationId !== operationId) {
      return { status: "superseded", operationId };
    }
    if (item.sync?.status === "conflict") return item.sync;

    try {
      const sync = await syncVisitStatusToExcel({ visitId, status: item.status, backupStore });
      const current = await readStatusDocument(store);
      if (current.items[visitId]?.operationId === operationId) {
        delete current.items[visitId];
        current.audit.unshift({
          type: "excel-synced",
          visitId,
          status: item.status,
          operationId,
          updatedAt: sync.syncedAt,
          backupKey: sync.backupKey || null
        });
        await writeStatusDocument(store, current);
      }
      return { ...sync, operationId };
    } catch (error) {
      const details = excelSyncErrorDetails(error);
      const current = await readStatusDocument(store);
      const active = current.items[visitId];
      if (!active || active.operationId !== operationId) {
        return { status: "superseded", operationId };
      }
      const attempts = Number(active.sync?.attempts || 0) + 1;
      const status = details.retryable ? "pending" : "conflict";
      lastResult = {
        status,
        operationId,
        attempts,
        updatedAt: new Date().toISOString(),
        nextAttemptAt: details.retryable
          ? new Date(Date.now() + Math.min(30000, 1000 * (2 ** attempts))).toISOString()
          : null,
        error: details.message,
        errorCode: details.code,
        retryable: details.retryable
      };
      active.sync = lastResult;
      current.audit.unshift({
        type: status === "conflict" ? "excel-conflict" : "excel-retry",
        visitId,
        status: active.status,
        operationId,
        attempt: attempts,
        errorCode: details.code,
        updatedAt: lastResult.updatedAt
      });
      await writeStatusDocument(store, current);
      if (!details.retryable || attempt >= maxAttempts) return lastResult;
      if (waitBetweenAttempts) await delay(Math.min(4000, 500 * (2 ** attempt)));
    }
  }
  return lastResult || { status: "pending", operationId };
}
