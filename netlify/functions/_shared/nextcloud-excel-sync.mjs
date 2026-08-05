import { createHash } from "node:crypto";
import { unzipSync, zipSync, strFromU8, strToU8 } from "fflate";
import { XMLParser } from "fast-xml-parser";
import { parseDashboardWorkbook } from "./dashboard-data-parser.mjs";

const MAX_FILE_BYTES = 20 * 1024 * 1024;
const DEFAULT_TIMEOUT_MS = 10000;
const MIN_TIMEOUT_MS = 3000;
const MAX_TIMEOUT_MS = 20000;
const EXCEL_CONTENT_TYPE = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
const ALLOWED_STATUSES = new Set(["Запланирован", "Выполнен", "Перенесён", "Отменён", "Завершено"]);
const xmlParser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: "",
  removeNSPrefix: true,
  parseTagValue: false,
  trimValues: false
});

function asArray(value) {
  if (value == null) return [];
  return Array.isArray(value) ? value : [value];
}

function xmlText(value) {
  if (value == null) return "";
  if (typeof value !== "object") return String(value);
  if ("#text" in value) return String(value["#text"] ?? "");
  if ("t" in value) return xmlText(value.t);
  if ("r" in value) return asArray(value.r).map(item => xmlText(item?.t)).join("");
  return "";
}

function safeMessage(error) {
  return String(error?.message || error || "Неизвестная ошибка")
    .replace(/https?:\/\/\S+/gi, "[адрес скрыт]")
    .replace(/Basic\s+\S+/gi, "Basic [скрыто]")
    .slice(0, 500);
}

function writeTimeoutMs() {
  const configured = Number(process.env.NEXTCLOUD_EXCEL_WRITE_TIMEOUT_MS || DEFAULT_TIMEOUT_MS);
  if (!Number.isFinite(configured)) return DEFAULT_TIMEOUT_MS;
  return Math.min(MAX_TIMEOUT_MS, Math.max(MIN_TIMEOUT_MS, Math.round(configured)));
}

function publicShareConfiguration() {
  if (String(process.env.NEXTCLOUD_EXCEL_WRITE_ENABLED || "").trim().toLocaleLowerCase("en") !== "true") {
    throw new Error("Запись в Excel выключена. Задайте NEXTCLOUD_EXCEL_WRITE_ENABLED=true только для тестового файла.");
  }
  const shareUrl = String(process.env.NEXTCLOUD_EXCEL_WRITE_SHARE_URL || "").trim();
  if (!shareUrl) {
    throw new Error("Не задана переменная NEXTCLOUD_EXCEL_WRITE_SHARE_URL.");
  }

  const parsed = new URL(shareUrl);
  if (parsed.protocol !== "https:" && parsed.hostname !== "localhost" && parsed.hostname !== "127.0.0.1") {
    throw new Error("NEXTCLOUD_EXCEL_WRITE_SHARE_URL должен начинаться с https://.");
  }
  const match = parsed.pathname.match(/^(.*?)(?:\/index\.php)?\/s\/([^/?#]+)/i);
  if (!match) {
    throw new Error("Ссылка для записи должна иметь вид https://сервер/index.php/s/<token>.");
  }

  const prefix = match[1] || "";
  const shareToken = match[2];
  const davUrl = new URL(parsed.origin);
  davUrl.pathname = `${prefix}/public.php/dav/files/${encodeURIComponent(shareToken)}`.replace(/\/{2,}/g, "/");
  davUrl.search = "";
  davUrl.hash = "";

  const headers = {
    "Accept": EXCEL_CONTENT_TYPE,
    "User-Agent": "PhotoDashboard/2.0.7",
    "X-Requested-With": "XMLHttpRequest"
  };
  const sharePassword = String(process.env.NEXTCLOUD_EXCEL_WRITE_SHARE_PASSWORD || "");
  if (sharePassword) {
    headers.Authorization = `Basic ${Buffer.from(`anonymous:${sharePassword}`).toString("base64")}`;
  }

  return {
    shareToken,
    shareLabel: parsed.hostname,
    davUrl: davUrl.toString(),
    headers
  };
}

export class ExcelSyncError extends Error {
  constructor(message, { code = "EXCEL_SYNC_FAILED", retryable = true } = {}) {
    super(message);
    this.name = "ExcelSyncError";
    this.code = code;
    this.retryable = retryable;
  }
}

export function excelSyncErrorDetails(error) {
  return {
    code: String(error?.code || "EXCEL_SYNC_FAILED"),
    retryable: error?.retryable !== false,
    message: safeMessage(error)
  };
}

async function fetchWithTimeout(url, options, stage, consumeResponse = null) {
  const timeoutMs = writeTimeoutMs();
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  const startedAt = Date.now();
  console.log(`[PhotoDashboard][excel-sync] ${stage}-start`, { timeoutMs });
  try {
    const response = await fetch(url, {
      ...options,
      signal: controller.signal,
      cache: "no-store",
      redirect: "follow"
    });
    const body = consumeResponse ? await consumeResponse(response) : null;
    console.log(`[PhotoDashboard][excel-sync] ${stage}-complete`, {
      status: response.status,
      elapsedMs: Date.now() - startedAt
    });
    return { response, body };
  } catch (error) {
    const timedOut = error?.name === "AbortError";
    console.log(`[PhotoDashboard][excel-sync] ${stage}-failed`, {
      elapsedMs: Date.now() - startedAt,
      timedOut,
      error: timedOut ? "source-timeout" : safeMessage(error)
    });
    if (timedOut) {
      throw new ExcelSyncError(
        `Nextcloud не завершил этап «${stage}» за ${Math.ceil(timeoutMs / 1000)} сек.`,
        { code: "NEXTCLOUD_TIMEOUT", retryable: true }
      );
    }
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

function readSharedStrings(files) {
  const bytes = files["xl/sharedStrings.xml"];
  if (!bytes) return [];
  const document = xmlParser.parse(strFromU8(bytes));
  return asArray(document?.sst?.si).map(item => xmlText(item));
}

function workbookSheetPath(files, sheetName) {
  const workbook = xmlParser.parse(strFromU8(files["xl/workbook.xml"] || new Uint8Array()));
  const relationships = xmlParser.parse(strFromU8(files["xl/_rels/workbook.xml.rels"] || new Uint8Array()));
  const sheet = asArray(workbook?.workbook?.sheets?.sheet).find(item => item?.name === sheetName);
  if (!sheet) throw new Error(`В Excel отсутствует лист «${sheetName}».`);

  const relationship = asArray(relationships?.Relationships?.Relationship).find(item => item?.Id === sheet.id);
  if (!relationship?.Target) throw new Error(`Не найден XML-файл листа «${sheetName}».`);

  let target = String(relationship.Target).replaceAll("\\", "/");
  if (target.startsWith("/")) target = target.slice(1);
  else if (!target.startsWith("xl/")) target = `xl/${target}`;
  return target;
}

function columnNumber(reference) {
  const match = String(reference || "").match(/^([A-Z]+)\d+$/i);
  if (!match) return 0;
  let result = 0;
  for (const character of match[1].toUpperCase()) {
    result = result * 26 + character.charCodeAt(0) - 64;
  }
  return result;
}

function columnLetters(number) {
  let value = Number(number);
  let result = "";
  while (value > 0) {
    value -= 1;
    result = String.fromCharCode(65 + (value % 26)) + result;
    value = Math.floor(value / 26);
  }
  return result;
}

function cellValue(cell, sharedStrings) {
  const type = cell?.t || "";
  const raw = xmlText(cell?.v);
  if (type === "inlineStr") return xmlText(cell?.is);
  if (raw === "") return "";
  if (type === "s") return sharedStrings[Number(raw)] ?? raw;
  return raw;
}

function escapeRegex(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function escapeXml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

function replaceStatusCell(sheetXml, rowNumber, cellReference, status) {
  const cellPattern = new RegExp(
    `<c\\b[^>]*\\br="${escapeRegex(cellReference)}"[^>]*(?:\\/>|>[\\s\\S]*?<\\/c>)`
  );
  const existingCell = sheetXml.match(cellPattern)?.[0] || "";
  const style = existingCell.match(/\bs="([^"]*)"/)?.[1];
  const replacement = `<c r="${cellReference}"${style != null ? ` s="${escapeXml(style)}"` : ""} t="inlineStr"><is><t>${escapeXml(status)}</t></is></c>`;

  if (existingCell) return sheetXml.replace(cellPattern, replacement);

  const rowPattern = new RegExp(`(<row\\b[^>]*\\br="${rowNumber}"[^>]*>[\\s\\S]*?)(<\\/row>)`);
  if (!rowPattern.test(sheetXml)) {
    throw new Error(`В листе «Выезды» не найдена строка ${rowNumber}.`);
  }
  return sheetXml.replace(rowPattern, `$1${replacement}$2`);
}

export async function updateVisitStatusInWorkbook(workbookBytes, visitId, status) {
  if (!ALLOWED_STATUSES.has(status)) throw new Error("Недопустимый статус.");
  if (!workbookBytes?.length || workbookBytes[0] !== 0x50 || workbookBytes[1] !== 0x4b) {
    throw new Error("Nextcloud вернул не Excel-файл.");
  }
  if (workbookBytes.length > MAX_FILE_BYTES) throw new Error("Excel превышает допустимый размер 20 МБ.");

  const files = unzipSync(new Uint8Array(workbookBytes));
  const sharedStrings = readSharedStrings(files);
  const sheetPath = workbookSheetPath(files, "Выезды");
  const sheetXml = strFromU8(files[sheetPath]);
  const document = xmlParser.parse(sheetXml);
  const rows = asArray(document?.worksheet?.sheetData?.row);
  const headerRow = rows.find(row => Number(row?.r) === 4);
  const headers = new Map();

  for (const cell of asArray(headerRow?.c)) {
    headers.set(cellValue(cell, sharedStrings).trim(), columnNumber(cell?.r));
  }
  const visitIdColumn = headers.get("VISIT_ID");
  const statusColumn = headers.get("STATUS");
  if (!visitIdColumn || !statusColumn) {
    throw new Error("На листе «Выезды» не найдены столбцы VISIT_ID и STATUS.");
  }

  let targetRow = null;
  let previousStatus = "";
  for (const row of rows) {
    if (Number(row?.r) <= 4) continue;
    const cells = asArray(row?.c);
    const idCell = cells.find(cell => columnNumber(cell?.r) === visitIdColumn);
    if (cellValue(idCell, sharedStrings).trim() !== visitId) continue;
    targetRow = row;
    const statusCell = cells.find(cell => columnNumber(cell?.r) === statusColumn);
    previousStatus = cellValue(statusCell, sharedStrings).trim();
    break;
  }
  if (!targetRow) throw new Error(`В Excel не найден выезд ${visitId}.`);

  const statusReference = `${columnLetters(statusColumn)}${Number(targetRow.r)}`;
  files[sheetPath] = strToU8(replaceStatusCell(sheetXml, Number(targetRow.r), statusReference, status));
  const updatedBytes = Buffer.from(zipSync(files, { level: 6 }));
  const parsed = await parseDashboardWorkbook(updatedBytes, { sourceFile: "dashboard_data_test.xlsx" });
  if (parsed.errors.length) {
    throw new Error(`После изменения Excel не прошёл проверку: ${parsed.errors.join(" | ")}`);
  }
  const updatedVisit = parsed.data.visits.find(visit => visit.id === visitId);
  if (!updatedVisit || updatedVisit.status !== status) {
    throw new Error("Контрольное чтение Excel не подтвердило новый статус.");
  }

  return {
    bytes: updatedBytes,
    previousStatus,
    checksum: createHash("sha256").update(updatedBytes).digest("hex"),
    objectsCount: parsed.data.objects.length,
    visitsCount: parsed.data.visits.length,
    warningsCount: parsed.warnings.length
  };
}

async function readCurrentWorkbook(config) {
  const { response, body } = await fetchWithTimeout(config.davUrl, {
    method: "GET",
    headers: config.headers
  }, "download", response => response.arrayBuffer());
  if (!response.ok) throw new Error(`Nextcloud WebDAV вернул HTTP ${response.status} при чтении.`);

  const contentLength = Number(response.headers.get("content-length") || 0);
  if (contentLength > MAX_FILE_BYTES) throw new Error("Excel превышает допустимый размер 20 МБ.");
  const bytes = Buffer.from(body);
  if (!bytes.length) throw new Error("Nextcloud WebDAV вернул пустой файл.");
  if (bytes.length > MAX_FILE_BYTES) throw new Error("Excel превышает допустимый размер 20 МБ.");
  if (bytes[0] !== 0x50 || bytes[1] !== 0x4b) {
    throw new Error("Nextcloud WebDAV вернул не Excel-файл.");
  }

  const etag = response.headers.get("etag");
  if (!etag) {
    throw new Error("Nextcloud не вернул ETag; безопасная перезапись без защиты от конфликта отменена.");
  }
  return { bytes, etag, lastModified: response.headers.get("last-modified") || null };
}

export async function probeExcelWriteAccess() {
  const config = publicShareConfiguration();
  const { response, body } = await fetchWithTimeout(config.davUrl, {
    method: "PROPFIND",
    headers: {
      ...config.headers,
      "Depth": "0",
      "Content-Type": "application/xml; charset=utf-8"
    },
    body: `<?xml version="1.0" encoding="UTF-8"?>
      <d:propfind xmlns:d="DAV:" xmlns:oc="http://owncloud.org/ns">
        <d:prop><d:getetag/><d:getcontentlength/><d:getcontenttype/><oc:permissions/></d:prop>
      </d:propfind>`
  }, "probe", response => response.text());
  const details = String(body || "").slice(0, 4000);
  if (response.status !== 207) {
    throw new Error(`Nextcloud WebDAV вернул HTTP ${response.status} при проверке прав.`);
  }
  return {
    ok: true,
    status: response.status,
    hasEtag: /getetag/i.test(details),
    permissions: details.match(/<[^>]*permissions[^>]*>([^<]*)</i)?.[1] || null
  };
}

export async function syncVisitStatusToExcel({ visitId, status, backupStore }) {
  const config = publicShareConfiguration();
  const current = await readCurrentWorkbook(config);
  const updated = await updateVisitStatusInWorkbook(current.bytes, visitId, status);

  if (!backupStore?.set) {
    throw new Error("Резервное хранилище Excel недоступно; перезапись отменена.");
  }
  const savedAt = new Date().toISOString();
  const backupMetadata = {
    visitId,
    previousStatus: updated.previousStatus,
    nextStatus: status,
    sourceEtag: current.etag,
    savedAt
  };
  const safeTimestamp = savedAt.replace(/[:.]/g, "-");
  const safeVisitId = visitId.replace(/[^A-Za-zА-Яа-яЁё0-9_.-]/gu, "_");
  const versionedBackupKey = `backups/${safeTimestamp}_${safeVisitId}.xlsx`;
  await backupStore.set(versionedBackupKey, current.bytes, { metadata: backupMetadata });
  await backupStore.set("latest-before-write.xlsx", current.bytes, { metadata: backupMetadata });

  try {
    if (typeof backupStore.list === "function" && typeof backupStore.delete === "function") {
      const listing = await backupStore.list({ prefix: "backups/" });
      const blobs = Array.isArray(listing?.blobs) ? listing.blobs : [];
      const obsolete = blobs.sort((a, b) => String(b.key).localeCompare(String(a.key))).slice(30);
      for (const blob of obsolete) await backupStore.delete(blob.key);
    }
  } catch (error) {
    console.warn("[PhotoDashboard][excel-sync] backup-retention-failed", safeMessage(error));
  }

  const { response } = await fetchWithTimeout(config.davUrl, {
    method: "PUT",
    headers: {
      ...config.headers,
      "Content-Type": EXCEL_CONTENT_TYPE,
      "If-Match": current.etag,
      "OC-Checksum": `SHA256:${updated.checksum}`
    },
    body: updated.bytes
  }, "upload");

  if (response.status === 412) {
    throw new ExcelSyncError(
      "Excel успели изменить параллельно. Обновите данные и повторите сохранение.",
      { code: "ETAG_CONFLICT", retryable: false }
    );
  }
  if (!response.ok) {
    throw new Error(`Nextcloud WebDAV вернул HTTP ${response.status} при записи.`);
  }

  return {
    status: "synced",
    syncedAt: new Date().toISOString(),
    previousStatus: updated.previousStatus,
    etagBefore: current.etag,
    etagAfter: response.headers.get("etag") || null,
    checksum: updated.checksum,
    objectsCount: updated.objectsCount,
    visitsCount: updated.visitsCount,
    warningsCount: updated.warningsCount,
    backupKey: versionedBackupKey
  };
}
