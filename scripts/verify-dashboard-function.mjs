import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { deepStrictEqual, rejects, strictEqual } from "node:assert";
import { refreshData } from "../netlify/functions/dashboard-data.mjs";
import { parseDashboardWorkbook } from "../netlify/functions/_shared/dashboard-data-parser.mjs";

const workbook = await readFile("dashboard_data.xlsx");
const expected = await parseDashboardWorkbook(workbook, {
  version: "function-verification",
  sourceFile: "dashboard_data.xlsx",
  sourceUpdatedAt: new Date().toISOString(),
  lastSuccessfulSyncAt: new Date().toISOString()
});
strictEqual(expected.errors.length, 0);
const etag = '"local-dashboard-test"';
let requestCount = 0;
let stalledResponse = null;

const server = createServer((request, response) => {
  requestCount += 1;
  if (request.url === "/stall-body") {
    stalledResponse = response;
    response.writeHead(200, {
      "Content-Type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      "Content-Length": workbook.length
    });
    response.write(workbook.subarray(0, 1));
    return;
  }
  if (request.url === "/fail") {
    response.writeHead(503, { "Content-Type": "text/plain" });
    response.end("temporary failure");
    return;
  }
  if (request.headers["if-none-match"] === etag) {
    response.writeHead(304, { ETag: etag });
    response.end();
    return;
  }
  response.writeHead(200, {
    "Content-Type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    "Content-Length": workbook.length,
    "Last-Modified": new Date("2026-07-29T10:00:00Z").toUTCString(),
    "ETag": etag
  });
  response.end(workbook);
});

await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
const address = server.address();
process.env.NEXTCLOUD_EXCEL_URL = `http://127.0.0.1:${address.port}/dashboard_data.xlsx`;
process.env.DASHBOARD_REFRESH_SECONDS = "30";

let savedCache = null;
const store = {
  async get() {
    return savedCache;
  },
  async setJSON(_key, value) {
    savedCache = value;
  }
};

try {
  const first = await refreshData(store, { force: true });
  strictEqual(first.meta.sourceStatus, "ok");
  deepStrictEqual(first.objects, expected.data.objects);
  deepStrictEqual(first.visits, expected.data.visits);
  strictEqual(savedCache?.source?.etag, etag);

  const second = await refreshData(store, { force: true });
  strictEqual(second.meta.version, first.meta.version);
  deepStrictEqual(second.objects, first.objects);
  strictEqual(requestCount, 2);

  process.env.NEXTCLOUD_EXCEL_URL = `http://127.0.0.1:${address.port}/fail`;
  const fallback = await refreshData(store, { force: true });
  strictEqual(fallback.meta.sourceStatus, "fallback");
  strictEqual(fallback.meta.version, first.meta.version);
  deepStrictEqual(fallback.visits, first.visits);

  const freshModuleUrl = new URL(`../netlify/functions/dashboard-data.mjs?first-launch=${Date.now()}`, import.meta.url);
  const { refreshData: refreshWithoutMemory } = await import(freshModuleUrl);
  await rejects(
    refreshWithoutMemory({ get: async () => null, setJSON: async () => {} }, { force: true }),
    /HTTP 503/
  );

  process.env.NEXTCLOUD_EXCEL_URL = `http://127.0.0.1:${address.port}/stall-body`;
  process.env.NEXTCLOUD_EXCEL_TIMEOUT_MS = "3000";
  const timeoutStartedAt = Date.now();
  await rejects(
    refreshWithoutMemory({ get: async () => null, setJSON: async () => {} }, { force: true }),
    /не завершил скачивание Excel за 3 сек\./
  );
  strictEqual(Date.now() - timeoutStartedAt < 6000, true);

  console.log("ПРОВЕРКА СЕРВЕРНОЙ СИНХРОНИЗАЦИИ ПРОЙДЕНА");
  console.log("- Excel получен по HTTP и сохранён как последняя корректная версия");
  console.log("- повторная проверка использовала ETag и не разбирала файл заново");
  console.log("- при сбое источника возвращена последняя корректная версия");
  console.log("- первый запуск без кэша корректно завершился ошибкой");
  console.log("- зависшее тело ответа Nextcloud прерывается до лимита Netlify Function");
} finally {
  stalledResponse?.destroy();
  server.closeAllConnections?.();
  await new Promise(resolve => server.close(resolve));
  delete process.env.NEXTCLOUD_EXCEL_URL;
  delete process.env.DASHBOARD_REFRESH_SECONDS;
  delete process.env.NEXTCLOUD_EXCEL_TIMEOUT_MS;
}
