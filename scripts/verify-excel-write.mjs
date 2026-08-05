import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { deepStrictEqual, rejects, strictEqual } from "node:assert";
import { parseDashboardWorkbook } from "../netlify/functions/_shared/dashboard-data-parser.mjs";
import {
  probeExcelWriteAccess,
  syncVisitStatusToExcel,
  updateVisitStatusInWorkbook
} from "../netlify/functions/_shared/nextcloud-excel-sync.mjs";
import { syncPendingOperation } from "../netlify/functions/_shared/status-store.mjs";

const originalWorkbook = await readFile("dashboard_data.xlsx");
const visitId = "VIS_20260413_001";
let remoteWorkbook = Buffer.from(originalWorkbook);
let remoteEtag = '"version-1"';
let rejectNextWrite = false;
let stallNextDownloadBody = false;
let lastRequestHeaders = null;
const backups = [];

const server = createServer(async (request, response) => {
  if (request.url !== "/public.php/dav/files/testToken") {
    response.writeHead(404);
    response.end();
    return;
  }

  lastRequestHeaders = request.headers;
  if (request.method === "PROPFIND") {
    response.writeHead(207, { "Content-Type": "application/xml" });
    response.end(`<?xml version="1.0"?>
      <d:multistatus xmlns:d="DAV:" xmlns:oc="http://owncloud.org/ns">
        <d:response><d:propstat><d:prop>
          <d:getetag>${remoteEtag}</d:getetag><oc:permissions>RDNVW</oc:permissions>
        </d:prop></d:propstat></d:response>
      </d:multistatus>`);
    return;
  }

  if (request.method === "GET") {
    if (stallNextDownloadBody) {
      stallNextDownloadBody = false;
      response.writeHead(200, {
        "Content-Type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        "Content-Length": remoteWorkbook.length,
        "ETag": remoteEtag
      });
      response.write(remoteWorkbook.subarray(0, 32));
      return;
    }
    response.writeHead(200, {
      "Content-Type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      "Content-Length": remoteWorkbook.length,
      "ETag": remoteEtag
    });
    response.end(remoteWorkbook);
    return;
  }

  if (request.method === "PUT") {
    if (rejectNextWrite || request.headers["if-match"] !== remoteEtag) {
      rejectNextWrite = false;
      response.writeHead(412);
      response.end();
      return;
    }
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    remoteWorkbook = Buffer.concat(chunks);
    remoteEtag = '"version-2"';
    response.writeHead(204, { "ETag": remoteEtag });
    response.end();
    return;
  }

  response.writeHead(405);
  response.end();
});

await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
const { port } = server.address();
process.env.NEXTCLOUD_EXCEL_WRITE_SHARE_URL = `http://127.0.0.1:${port}/index.php/s/testToken`;
process.env.NEXTCLOUD_EXCEL_WRITE_TIMEOUT_MS = "3000";
process.env.NEXTCLOUD_EXCEL_WRITE_ENABLED = "true";

const backupStore = {
  async set(key, value, options) {
    backups.push({ key, value: Buffer.from(value), options });
  }
};

try {
  const patched = await updateVisitStatusInWorkbook(originalWorkbook, visitId, "Перенесён");
  const patchedData = await parseDashboardWorkbook(patched.bytes);
  strictEqual(patchedData.data.visits.find(visit => visit.id === visitId)?.status, "Перенесён");
  strictEqual(patched.previousStatus, "Выполнен");

  const probe = await probeExcelWriteAccess();
  strictEqual(probe.ok, true);
  strictEqual(probe.status, 207);
  strictEqual(probe.permissions, "RDNVW");
  strictEqual(lastRequestHeaders["x-requested-with"], "XMLHttpRequest");

  const result = await syncVisitStatusToExcel({
    visitId,
    status: "Отменён",
    backupStore
  });
  strictEqual(result.status, "synced");
  strictEqual(result.previousStatus, "Выполнен");
  strictEqual(lastRequestHeaders["if-match"], '"version-1"');
  strictEqual(lastRequestHeaders["x-requested-with"], "XMLHttpRequest");
  strictEqual(backups.some(item => /^backups\/.+_VIS_20260413_001\.xlsx$/.test(item.key)), true);
  strictEqual(backups.some(item => item.key === "latest-before-write.xlsx"), true);
  deepStrictEqual(backups.find(item => item.key === "latest-before-write.xlsx")?.value, originalWorkbook);

  const remoteData = await parseDashboardWorkbook(remoteWorkbook);
  strictEqual(remoteData.data.visits.find(visit => visit.id === visitId)?.status, "Отменён");
  strictEqual(remoteData.errors.length, 0);

  rejectNextWrite = true;
  await rejects(
    syncVisitStatusToExcel({ visitId, status: "Завершено", backupStore }),
    /изменить параллельно/
  );
  const afterConflict = await parseDashboardWorkbook(remoteWorkbook);
  strictEqual(afterConflict.data.visits.find(visit => visit.id === visitId)?.status, "Отменён");

  let statusDocument = {
    version: 2,
    updatedAt: new Date().toISOString(),
    items: {
      [visitId]: {
        status: "Завершено",
        operationId: "operation_sync_0001",
        updatedAt: new Date().toISOString(),
        sync: { status: "pending", attempts: 0 }
      }
    },
    audit: []
  };
  const statusStore = {
    async get() { return structuredClone(statusDocument); },
    async setJSON(_key, value) { statusDocument = structuredClone(value); }
  };
  const queuedResult = await syncPendingOperation({
    store: statusStore,
    backupStore,
    visitId,
    operationId: "operation_sync_0001",
    maxAttempts: 1
  });
  strictEqual(queuedResult.status, "synced");
  strictEqual(statusDocument.items[visitId], undefined);
  strictEqual(statusDocument.audit[0]?.type, "excel-synced");

  statusDocument.items[visitId] = {
    status: "Запланирован",
    operationId: "operation_conflict_0002",
    updatedAt: new Date().toISOString(),
    sync: { status: "pending", attempts: 0 }
  };
  rejectNextWrite = true;
  const queuedConflict = await syncPendingOperation({
    store: statusStore,
    backupStore,
    visitId,
    operationId: "operation_conflict_0002",
    maxAttempts: 3,
    waitBetweenAttempts: true
  });
  strictEqual(queuedConflict.status, "conflict");
  strictEqual(queuedConflict.attempts, 1);
  strictEqual(statusDocument.items[visitId].sync.status, "conflict");

  stallNextDownloadBody = true;
  await rejects(
    syncVisitStatusToExcel({ visitId, status: "Завершено", backupStore }),
    /не завершил этап «download» за 3 сек/
  );

  console.log("ПРОВЕРКА ДВУСТОРОННЕЙ СИНХРОНИЗАЦИИ ПРОЙДЕНА");
  console.log("- статус найден по VISIT_ID и изменён без потери структуры Excel");
  console.log("- перед PUT сохранена резервная копия исходного файла");
  console.log("- зависшее тело ответа прерывается тем же тайм-аутом, что и заголовки");
  console.log("- запись защищена ETag и заголовком X-Requested-With");
  console.log("- конфликт параллельного изменения не перезаписывает Excel");
  console.log("- pending автоматически синхронизируется, а conflict не повторяется вслепую");
} finally {
  server.closeAllConnections?.();
  await new Promise(resolve => server.close(resolve));
  delete process.env.NEXTCLOUD_EXCEL_WRITE_SHARE_URL;
  delete process.env.NEXTCLOUD_EXCEL_WRITE_TIMEOUT_MS;
  delete process.env.NEXTCLOUD_EXCEL_WRITE_ENABLED;
}
