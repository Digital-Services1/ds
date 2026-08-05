import { unzipSync } from "fflate";
import { XMLParser } from "fast-xml-parser";

const ALLOWED_STATUSES = new Set([
  "Запланирован",
  "Выполнен",
  "Перенесён",
  "Отменён",
  "Завершено"
]);
const xmlParser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: "",
  removeNSPrefix: true,
  parseTagValue: false,
  trimValues: false
});
const textDecoder = new TextDecoder("utf-8");

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

function columnNumber(cellReference) {
  const match = String(cellReference || "").match(/^([A-Z]+)\d+$/i);
  if (!match) return 0;
  let result = 0;
  for (const character of match[1].toUpperCase()) {
    result = result * 26 + character.charCodeAt(0) - 64;
  }
  return result;
}

function resolvedCellValue(value) {
  if (value == null) return null;
  if (value instanceof Date) return value;
  if (typeof value !== "object") return value;
  if ("result" in value) return resolvedCellValue(value.result);
  if ("text" in value) return value.text;
  if (Array.isArray(value.richText)) {
    return value.richText.map(item => item?.text || "").join("");
  }
  return value;
}

function clean(value) {
  const resolved = resolvedCellValue(value);
  if (resolved == null) return "";
  if (typeof resolved === "boolean") return resolved ? "Да" : "Нет";
  return String(resolved).trim();
}

function numberOrNull(value) {
  const resolved = resolvedCellValue(value);
  if (resolved == null || resolved === "") return null;
  if (typeof resolved === "number") return Number.isFinite(resolved) ? resolved : null;
  const parsed = Number(clean(resolved).replace(/\u00a0/g, "").replace(/\s/g, "").replace(",", "."));
  return Number.isFinite(parsed) ? parsed : null;
}

function isYes(value) {
  return new Set(["да", "yes", "true", "1"]).has(clean(value).toLocaleLowerCase("ru"));
}

function normalizeObjectKey(value) {
  return clean(value)
    .toLocaleLowerCase("ru")
    .replace(/^ст\.?\s+/u, "")
    .replace(/[«»"']/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function excelSerialToIso(value) {
  const number = numberOrNull(value);
  if (number == null) return "";
  const millis = Math.round((number - 25569) * 86400000);
  const result = new Date(millis);
  return Number.isNaN(result.getTime()) ? "" : result.toISOString().slice(0, 10);
}

function dateToIso(value) {
  const resolved = resolvedCellValue(value);
  if (resolved instanceof Date) {
    return Number.isNaN(resolved.getTime()) ? "" : resolved.toISOString().slice(0, 10);
  }
  if (typeof resolved === "number") return excelSerialToIso(resolved);
  const text = clean(resolved);
  if (!text) return "";
  let match = text.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (match) return `${match[1]}-${match[2]}-${match[3]}`;
  match = text.match(/^(\d{1,2})[./-](\d{1,2})[./-](\d{4})$/);
  if (match) return `${match[3]}-${String(Number(match[2])).padStart(2, "0")}-${String(Number(match[1])).padStart(2, "0")}`;
  return "";
}

function resolvePhotoFile(objectId, sourceValue) {
  if (/^OBJ_\d{3}$/i.test(objectId)) return `${objectId.toUpperCase()}.jpg`;
  const parts = clean(sourceValue).split(/[\\/]/);
  return parts.at(-1) || "";
}

class SimpleXlsx {
  constructor(buffer) {
    this.files = unzipSync(new Uint8Array(buffer));
    this.sharedStrings = this.readSharedStrings();
    this.sheetPaths = this.readSheetPaths();
    this.sheetCache = new Map();
  }

  readXml(path) {
    const bytes = this.files[path];
    if (!bytes) throw new Error(`В Excel отсутствует служебный файл ${path}.`);
    return xmlParser.parse(textDecoder.decode(bytes));
  }

  readSharedStrings() {
    if (!this.files["xl/sharedStrings.xml"]) return [];
    const document = this.readXml("xl/sharedStrings.xml");
    return asArray(document?.sst?.si).map(item => xmlText(item));
  }

  readSheetPaths() {
    const workbook = this.readXml("xl/workbook.xml");
    const relationships = this.readXml("xl/_rels/workbook.xml.rels");
    const relationshipMap = new Map(
      asArray(relationships?.Relationships?.Relationship).map(item => [item.Id, item.Target])
    );
    const result = new Map();
    for (const sheet of asArray(workbook?.workbook?.sheets?.sheet)) {
      let target = String(relationshipMap.get(sheet.id) || "").replaceAll("\\", "/");
      if (target.startsWith("/")) target = target.slice(1);
      else if (!target.startsWith("xl/")) target = `xl/${target}`;
      result.set(sheet.name, target);
    }
    return result;
  }

  cellValue(cell) {
    const type = cell?.t || "";
    const raw = xmlText(cell?.v);
    if (type === "inlineStr") return xmlText(cell?.is);
    if (raw === "") return null;
    if (type === "s") return this.sharedStrings[Number(raw)] ?? raw;
    if (type === "str" || type === "e") return raw;
    if (type === "b") return raw === "1";
    const number = Number(raw);
    return Number.isFinite(number) ? number : raw;
  }

  sheet(name) {
    if (this.sheetCache.has(name)) return this.sheetCache.get(name);
    const path = this.sheetPaths.get(name);
    if (!path) throw new Error(`В Excel отсутствует лист «${name}».`);
    const document = this.readXml(path);
    const rows = asArray(document?.worksheet?.sheetData?.row).map(row => {
      const cells = new Map();
      for (const cell of asArray(row?.c)) {
        const column = columnNumber(cell?.r);
        if (column) cells.set(column, this.cellValue(cell));
      }
      return { number: Number(row?.r || 0), cells };
    });
    const result = { name, rows };
    this.sheetCache.set(name, result);
    return result;
  }

  cell(sheetName, reference) {
    const match = String(reference || "").toUpperCase().match(/^([A-Z]+)(\d+)$/);
    if (!match) return null;
    const column = columnNumber(reference);
    const rowNumber = Number(match[2]);
    return this.sheet(sheetName).rows.find(row => row.number === rowNumber)?.cells.get(column) ?? null;
  }
}

function tableRows(worksheet, headerRowNumber = 4) {
  const headers = new Map();
  const headerRow = worksheet.rows.find(row => row.number === headerRowNumber);
  for (const [column, value] of headerRow?.cells || []) {
    const header = clean(value);
    if (header) headers.set(column, header);
  }
  if (!headers.size) {
    throw new Error(`На листе «${worksheet.name}» не найдена строка заголовков ${headerRowNumber}.`);
  }

  const rows = [];
  for (const row of worksheet.rows) {
    if (row.number <= headerRowNumber) continue;
    const item = {};
    let hasValue = false;
    for (const [columnNumber, header] of headers) {
      const value = resolvedCellValue(row.cells.get(columnNumber));
      item[header] = value;
      if (value != null && value !== "") hasValue = true;
    }
    if (hasValue) rows.push(item);
  }
  return rows;
}

function duplicateValues(values) {
  const seen = new Set();
  const repeated = new Set();
  for (const value of values) {
    if (value && seen.has(value)) repeated.add(value);
    seen.add(value);
  }
  return [...repeated].sort((left, right) => left.localeCompare(right, "ru"));
}

export function validateDashboardData(data) {
  const errors = [];
  const warnings = [];
  const objects = Array.isArray(data?.objects) ? data.objects : [];
  const visits = Array.isArray(data?.visits) ? data.visits : [];

  if (!objects.length) errors.push("На листе «Объекты» не найдено ни одного объекта.");
  if (!visits.length) errors.push("На листе «Выезды» не найдено ни одного выезда.");

  for (const [label, values] of [
    ["OBJECT_ID", objects.map(item => item.id)],
    ["OBJECT_NAME", objects.map(item => item.name)],
    ["VISIT_ID", visits.map(item => item.id)]
  ]) {
    const repeated = duplicateValues(values);
    if (repeated.length) errors.push(`Дублируются ${label}: ${repeated.join(", ")}`);
  }

  const knownObjects = new Set(objects.map(item => item.name));
  for (const object of objects) {
    if (!/^OBJ_\d{3}$/.test(object.id || "")) {
      errors.push(`Некорректный OBJECT_ID: ${object.id || "<пусто>"}`);
    }
    if (!Number.isFinite(object.lat) || !Number.isFinite(object.lon) ||
        object.lat < -90 || object.lat > 90 || object.lon < -180 || object.lon > 180) {
      errors.push(`Некорректные координаты объекта ${object.id || object.name || "<без имени>"}`);
    }
    if (!object.photoFile) warnings.push(`Для объекта ${object.id || object.name} не указана фотография.`);
  }

  for (const visit of visits) {
    if (!String(visit.id || "").trim()) {
      errors.push("На листе «Выезды» найден выезд без VISIT_ID.");
      continue;
    }
    if (!ALLOWED_STATUSES.has(visit.status)) {
      errors.push(`Неизвестный статус в ${visit.id || "<без VISIT_ID>"}: ${visit.status || "<пусто>"}`);
    }
    for (const objectName of visit.objects || []) {
      if (!knownObjects.has(objectName)) {
        errors.push(`В ${visit.id || "<без VISIT_ID>"} указан неизвестный объект: ${objectName}`);
      }
    }
    if (!visit.employee) warnings.push(`В ${visit.id} не указан ответственный.`);
    if (!Number.isFinite(visit.pointsCount) || visit.pointsCount < 0) {
      warnings.push(`В ${visit.id} указано подозрительное количество точек.`);
    }
  }

  if (!data?.meta?.reportPeriodStart || !data?.meta?.reportPeriodEnd) {
    warnings.push("На листе «План недели» не определён полный отчётный период.");
  } else if (data.meta.reportPeriodStart >= data.meta.reportPeriodEnd) {
    errors.push("Начало отчётного периода должно быть раньше его окончания.");
  }

  return { errors, warnings };
}

export async function parseDashboardWorkbook(buffer, sourceMeta = {}) {
  const workbook = new SimpleXlsx(buffer);
  const objectsSheet = workbook.sheet("Объекты");
  const visitsSheet = workbook.sheet("Выезды");
  workbook.sheet("План недели");

  const objectRows = tableRows(objectsSheet);
  const visitRows = tableRows(visitsSheet);
  const objects = [];

  for (const row of objectRows) {
    const objectId = clean(row.OBJECT_ID);
    const objectName = clean(row.OBJECT_NAME);
    if (!objectId || !objectName) continue;
    objects.push({
      id: objectId,
      name: objectName,
      pointsCount: numberOrNull(row.POINTS_COUNT),
      group: clean(row.OBJECT_GROUP) || "Другие объекты",
      type: clean(row.OBJECT_TYPE) || "Другой объект",
      address: clean(row.ADDRESS) || null,
      lat: numberOrNull(row.LATITUDE),
      lon: numberOrNull(row.LONGITUDE),
      mapUrl: clean(row.YANDEX_MAP_URL) || null,
      albumUrl: clean(row.ALBUM_URL) || null,
      photoFile: resolvePhotoFile(objectId, row.PHOTO_PATH),
      active: isYes(row.IS_ACTIVE),
      comment: clean(row.COMMENT) || null
    });
  }

  const objectByName = new Map(objects.map(item => [item.name, item]));
  const objectByKey = new Map();
  for (const object of objects) {
    objectByKey.set(normalizeObjectKey(object.name), object);
    objectByKey.set(normalizeObjectKey(object.id), object);
  }

  const visits = [];
  const missingVisitIdRows = [];
  for (let index = 0; index < visitRows.length; index += 1) {
    const row = visitRows[index];
    const sourceName = clean(row.OBJECTS);
    const visitDate = dateToIso(row.VISIT_DATE);
    if (!sourceName || !visitDate) continue;
    const object = objectByName.get(sourceName) || objectByKey.get(normalizeObjectKey(sourceName));
    const visitId = clean(row.VISIT_ID);
    if (!visitId) {
      missingVisitIdRows.push(index + 5);
      continue;
    }
    const rowPoints = numberOrNull(row["Количество точек"]);
    visits.push({
      id: visitId,
      date: visitDate,
      employee: clean(row.EMPLOYEE),
      objects: [object?.name || sourceName],
      status: clean(row.STATUS),
      comment: clean(row.COMMENT) || null,
      workType: clean(row.WORK_TYPE) || "Фотопанорамная съёмка",
      pointsCount: rowPoints ?? object?.pointsCount ?? 0
    });
  }

  const data = {
    meta: {
      version: sourceMeta.version || "",
      refreshSeconds: Number(sourceMeta.refreshSeconds || 30),
      sourceFile: sourceMeta.sourceFile || "dashboard_data.xlsx",
      sourceUpdatedAt: sourceMeta.sourceUpdatedAt || null,
      lastSuccessfulSyncAt: sourceMeta.lastSuccessfulSyncAt || null,
      reportPeriodStart: dateToIso(workbook.cell("План недели", "B4")),
      reportPeriodEnd: dateToIso(workbook.cell("План недели", "D4")),
      sourceStatus: "ok",
      sourceLabel: "Nextcloud",
      liveSync: true
    },
    objects,
    visits
  };

  const validation = validateDashboardData(data);
  if (missingVisitIdRows.length) {
    validation.errors.push(
      `На листе «Выезды» отсутствует VISIT_ID в строках: ${missingVisitIdRows.join(", ")}.`
    );
  }
  return { data, ...validation };
}
