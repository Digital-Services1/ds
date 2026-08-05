import { createHash } from "node:crypto";
import { getStore } from "./_shared/storage.mjs";
import { parseDashboardWorkbook } from "./_shared/dashboard-data-parser.mjs";
import { accessConfigurationError, isAccessAuthorized } from "./_shared/access-auth.mjs";
import { BUNDLED_DASHBOARD_DATA } from "./_shared/bundled-dashboard-data.mjs";

const STORE_NAME = "photo360-dashboard-data";
const CACHE_KEY = "last-good";
const DEFAULT_FILE_NAME = "dashboard_data.xlsx";
const MAX_FILE_BYTES = 20 * 1024 * 1024;
const DEFAULT_REFRESH_SECONDS = 30;
const DEFAULT_SOURCE_TIMEOUT_MS = 15000;
const MIN_SOURCE_TIMEOUT_MS = 3000;
const MAX_SOURCE_TIMEOUT_MS = 25000;

let memoryCache = null;
let memoryCheckedAt = 0;

function json(data, status = 200) {
  return Response.json(data, {
    status,
    headers: {
      "Cache-Control": "no-store, max-age=0",
      "X-Content-Type-Options": "nosniff",
      "Referrer-Policy": "same-origin"
    }
  });
}

function safeMessage(error) {
  const message = String(error?.message || error || "Неизвестная ошибка");
  return message
    .replace(/https?:\/\/\S+/gi, "[адрес скрыт]")
    .replace(/Basic\s+\S+/gi, "Basic [скрыто]")
    .slice(0, 500);
}

function logStage(stage, details = {}) {
  console.log(`[PhotoDashboard][dashboard-data] ${stage}`, details);
}

function sourceTimeoutMs() {
  const configured = Number(process.env.NEXTCLOUD_EXCEL_TIMEOUT_MS || DEFAULT_SOURCE_TIMEOUT_MS);
  if (!Number.isFinite(configured)) return DEFAULT_SOURCE_TIMEOUT_MS;
  return Math.min(MAX_SOURCE_TIMEOUT_MS, Math.max(MIN_SOURCE_TIMEOUT_MS, Math.round(configured)));
}

function sourceUrlFromPublicFolder(folderUrl, filePath) {
  const url = new URL(folderUrl);
  const match = url.pathname.match(/^(.*?)(\/index\.php)?\/s\/([^/?#]+)/i);
  if (!match) {
    throw new Error("NEXTCLOUD_EXCEL_PUBLIC_FOLDER_URL должен содержать публичную ссылку вида /s/<token>.");
  }
  const prefix = match[1] || "";
  const indexPart = match[2] || "";
  const shareToken = match[3];
  const normalizedPath = String(filePath || DEFAULT_FILE_NAME).replaceAll("\\", "/").replace(/^\/+/, "");
  const slash = normalizedPath.lastIndexOf("/");
  const directory = slash >= 0 ? `/${normalizedPath.slice(0, slash)}` : "/";
  const fileName = slash >= 0 ? normalizedPath.slice(slash + 1) : normalizedPath;

  url.pathname = `${prefix}${indexPart}/s/${shareToken}/download`;
  url.search = "";
  url.searchParams.set("path", directory);
  url.searchParams.set("files", fileName);
  url.hash = "";
  return { url: url.toString(), shareToken, fileName };
}

function sourceConfiguration() {
  const directUrl = String(process.env.NEXTCLOUD_EXCEL_URL || "").trim();
  const publicFolder = String(process.env.NEXTCLOUD_EXCEL_PUBLIC_FOLDER_URL || "").trim();
  const filePath = String(process.env.NEXTCLOUD_EXCEL_FILE_PATH || DEFAULT_FILE_NAME).trim();
  let resolved;

  if (directUrl) {
    const parsed = new URL(directUrl);
    if (parsed.protocol !== "https:" && parsed.hostname !== "localhost" && parsed.hostname !== "127.0.0.1") {
      throw new Error("NEXTCLOUD_EXCEL_URL должен начинаться с https://.");
    }
    resolved = { url: parsed.toString(), shareToken: "", fileName: filePath.split(/[\\/]/).at(-1) || DEFAULT_FILE_NAME };
  } else if (publicFolder) {
    resolved = sourceUrlFromPublicFolder(publicFolder, filePath);
  } else {
    throw new Error(
      "Не задан источник Excel. Добавьте NEXTCLOUD_EXCEL_URL либо NEXTCLOUD_EXCEL_PUBLIC_FOLDER_URL в переменные сервера."
    );
  }

  const headers = {
    "Accept": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet, application/octet-stream",
    "User-Agent": "PhotoDashboard/2.0"
  };
  const explicitAuthorization = String(process.env.NEXTCLOUD_EXCEL_AUTHORIZATION || "").trim();
  const username = String(process.env.NEXTCLOUD_EXCEL_USERNAME || "").trim();
  const password = String(process.env.NEXTCLOUD_EXCEL_PASSWORD || "");
  const sharePassword = String(process.env.NEXTCLOUD_EXCEL_SHARE_PASSWORD || "");

  if (explicitAuthorization) {
    headers.Authorization = explicitAuthorization;
  } else if (username) {
    headers.Authorization = `Basic ${Buffer.from(`${username}:${password}`).toString("base64")}`;
  } else if (sharePassword && resolved.shareToken) {
    headers.Authorization = `Basic ${Buffer.from(`${resolved.shareToken}:${sharePassword}`).toString("base64")}`;
  }

  return { ...resolved, headers };
}

async function readCached(store, consistency = "strong") {
  if (memoryCache) return memoryCache;
  const cached = await store.get(CACHE_KEY, { type: "json", consistency });
  if (cached?.data?.meta && Array.isArray(cached.data.objects) && Array.isArray(cached.data.visits)) {
    memoryCache = cached;
    return cached;
  }
  return null;
}

function responseData(cache, overrides = {}) {
  const checkedAt = overrides.checkedAt || new Date().toISOString();
  return {
    ...cache.data,
    meta: {
      ...cache.data.meta,
      sourceStatus: overrides.sourceStatus || "ok",
      sourceLabel: "Nextcloud",
      liveSync: true,
      checkedAt,
      lastSuccessfulSyncAt: cache.lastSuccessfulSyncAt || cache.data.meta.lastSuccessfulSyncAt || null,
      warnings: cache.warnings || [],
      fallbackReason: overrides.fallbackReason || null
    }
  };
}

function versionResponse(data) {
  const meta = data?.meta || {};
  return {
    version: meta.version || "",
    sourceStatus: meta.sourceStatus || "unknown",
    sourceUpdatedAt: meta.sourceUpdatedAt || null,
    lastSuccessfulSyncAt: meta.lastSuccessfulSyncAt || null,
    checkedAt: meta.checkedAt || null,
    warningsCount: Array.isArray(meta.warnings) ? meta.warnings.length : 0,
    serverNow: new Date().toISOString()
  };
}

function bundledResponse(reason = "Серверный кэш ещё не создан.") {
  const now = new Date().toISOString();
  return {
    ...BUNDLED_DASHBOARD_DATA,
    meta: {
      ...(BUNDLED_DASHBOARD_DATA.meta || {}),
      sourceStatus: "fallback",
      sourceLabel: "Защищённая резервная копия",
      liveSync: true,
      checkedAt: now,
      fallbackReason: safeMessage(reason)
    }
  };
}

async function cachedOrBundled(store) {
  try {
    // Initial dashboard rendering tolerates a cache replica that is a few
    // seconds behind; the background version check still performs the normal
    // strong refresh path. This removes a cross-region consistency round trip
    // from the critical page-load sequence.
    const cached = await readCached(store, "eventual");
    if (cached) return responseData(cached, { checkedAt: new Date().toISOString() });
    return bundledResponse();
  } catch (error) {
    return bundledResponse(error);
  }
}

async function fetchSource(config, cached) {
  const headers = { ...config.headers };
  if (cached?.source?.etag) headers["If-None-Match"] = cached.source.etag;
  if (cached?.source?.lastModified) headers["If-Modified-Since"] = cached.source.lastModified;

  const startedAt = Date.now();
  const timeoutMs = sourceTimeoutMs();
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  logStage("nextcloud-fetch-start", {
    timeoutMs,
    hasCachedVersion: Boolean(cached)
  });

  try {
    const response = await fetch(config.url, {
      method: "GET",
      headers,
      cache: "no-store",
      redirect: "follow",
      signal: controller.signal
    });
    const contentLength = Number(response.headers.get("content-length") || 0);
    logStage("nextcloud-response-headers", {
      status: response.status,
      elapsedMs: Date.now() - startedAt,
      contentLength: contentLength || null
    });

    if (response.status === 304 && cached) return { unchanged: true, cached };
    if (!response.ok) throw new Error(`Nextcloud вернул HTTP ${response.status}.`);
    if (contentLength > MAX_FILE_BYTES) {
      throw new Error(`Excel превышает допустимый размер ${MAX_FILE_BYTES / 1024 / 1024} МБ.`);
    }

    // Keep the same AbortController active until the response body is fully read.
    // The previous implementation cleared the timer after headers, so a stalled
    // Excel body survived until the hosting platform killed the whole request.
    const bytes = Buffer.from(await response.arrayBuffer());
    logStage("nextcloud-download-complete", {
      elapsedMs: Date.now() - startedAt,
      bytes: bytes.length
    });

    if (!bytes.length) throw new Error("Nextcloud вернул пустой файл.");
    if (bytes.length > MAX_FILE_BYTES) {
      throw new Error(`Excel превышает допустимый размер ${MAX_FILE_BYTES / 1024 / 1024} МБ.`);
    }
    if (bytes[0] !== 0x50 || bytes[1] !== 0x4b) {
      throw new Error("Вместо Excel получен другой файл. Проверьте публичную ссылку и пароль Nextcloud.");
    }

    const checksum = createHash("sha256").update(bytes).digest("hex");
    if (cached?.source?.checksum === checksum) return { unchanged: true, cached };

    return {
      unchanged: false,
      bytes,
      source: {
        checksum,
        etag: response.headers.get("etag") || null,
        lastModified: response.headers.get("last-modified") || null,
        contentLength: bytes.length
      }
    };
  } catch (error) {
    const timedOut = error?.name === "AbortError";
    logStage("nextcloud-fetch-failed", {
      elapsedMs: Date.now() - startedAt,
      timedOut,
      error: timedOut ? "source-timeout" : safeMessage(error)
    });
    if (timedOut) {
      throw new Error(`Nextcloud не завершил скачивание Excel за ${Math.ceil(timeoutMs / 1000)} сек.`);
    }
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

export async function refreshData(store, { force = false } = {}) {
  const refreshStartedAt = Date.now();
  logStage("cache-read-start");
  const cached = await readCached(store);
  logStage("cache-read-complete", {
    elapsedMs: Date.now() - refreshStartedAt,
    found: Boolean(cached)
  });
  const refreshSeconds = Math.max(
    10,
    Number(process.env.DASHBOARD_REFRESH_SECONDS || cached?.data?.meta?.refreshSeconds || DEFAULT_REFRESH_SECONDS)
  );
  const now = Date.now();

  if (!force && cached && memoryCheckedAt && now - memoryCheckedAt < refreshSeconds * 1000) {
    return responseData(cached, { checkedAt: new Date(memoryCheckedAt).toISOString() });
  }

  try {
    const config = sourceConfiguration();
    const sourceResult = await fetchSource(config, cached);
    memoryCheckedAt = now;

    if (sourceResult.unchanged) {
      logStage("source-unchanged", { elapsedMs: Date.now() - refreshStartedAt });
      memoryCache = sourceResult.cached;
      return responseData(sourceResult.cached, { checkedAt: new Date(now).toISOString() });
    }

    const syncTime = new Date(now).toISOString();
    const parsed = await parseDashboardWorkbook(sourceResult.bytes, {
      version: sourceResult.source.checksum,
      refreshSeconds,
      sourceFile: config.fileName,
      sourceUpdatedAt: sourceResult.source.lastModified || syncTime,
      lastSuccessfulSyncAt: syncTime
    });
    if (parsed.errors.length) {
      throw new Error(`Проверка Excel не пройдена: ${parsed.errors.join(" | ")}`);
    }
    logStage("workbook-parse-complete", {
      elapsedMs: Date.now() - refreshStartedAt,
      objects: parsed.data.objects.length,
      visits: parsed.data.visits.length,
      warnings: parsed.warnings.length
    });

    const nextCache = {
      schemaVersion: 1,
      data: parsed.data,
      warnings: parsed.warnings,
      source: sourceResult.source,
      lastSuccessfulSyncAt: syncTime
    };
    await store.setJSON(CACHE_KEY, nextCache);
    logStage("cache-write-complete", { elapsedMs: Date.now() - refreshStartedAt });
    memoryCache = nextCache;
    return responseData(nextCache, { checkedAt: syncTime });
  } catch (error) {
    memoryCheckedAt = now;
    if (!cached) {
      logStage("refresh-failed-without-cache", {
        elapsedMs: Date.now() - refreshStartedAt,
        error: safeMessage(error)
      });
      throw error;
    }
    logStage("cached-fallback-used", {
      elapsedMs: Date.now() - refreshStartedAt,
      error: safeMessage(error)
    });
    return responseData(cached, {
      sourceStatus: "fallback",
      checkedAt: new Date(now).toISOString(),
      fallbackReason: safeMessage(error)
    });
  }
}

export default async (req) => {
  if (req.method !== "GET") return json({ error: "Метод не поддерживается" }, 405);
  const configurationError = accessConfigurationError();
  if (configurationError) {
    return json({ error: configurationError, authenticated: false, configured: false }, 503);
  }
  if (!isAccessAuthorized(req)) {
    return json({ error: "Требуется вход в дашборд.", authenticated: false }, 401);
  }

  const url = new URL(req.url);
  const mode = url.searchParams.get("mode") || "data";
  const force = url.searchParams.get("force") === "1";

  try {
    if (mode === "bundled") return json(bundledResponse("Запрошена защищённая резервная копия."));
    let store;
    try {
      store = getStore({
        name: STORE_NAME,
        ...(mode === "cache" ? {} : { consistency: "strong" })
      });
    } catch (error) {
      if (mode === "cache") return json(bundledResponse(error));
      throw error;
    }
    if (mode === "cache") return json(await cachedOrBundled(store));
    const data = await refreshData(store, { force });
    return json(mode === "version" ? versionResponse(data) : data);
  } catch (error) {
    if (mode === "data" || mode === "version") {
      const fallback = bundledResponse(error);
      return json(mode === "version" ? versionResponse(fallback) : fallback);
    }
    return json({
      error: "Не удалось загрузить рабочие данные.",
      details: safeMessage(error),
      retryable: true
    }, 503);
  }
};

export const config = {
  path: "/.netlify/functions/dashboard-data"
};
