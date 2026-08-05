import { createHash } from "node:crypto";
import { getStore } from "./_shared/storage.mjs";
import { accessConfigurationError, isAccessAuthorized } from "./_shared/access-auth.mjs";

const STORE_NAME = "photo360-photo-cache";
const DEFAULT_PUBLIC_FOLDER_URL = "https://disk2.mosinzhproekt.ru/index.php/s/gRLKm39AAWy59Sy";
const DEFAULT_PHOTO_VERSION = "20260729-v1183";
const MAX_PHOTO_BYTES = 8 * 1024 * 1024;
const SOURCE_TIMEOUT_MS = 12000;
const memoryCache = new Map();

function json(data, status = 200) {
  return Response.json(data, {
    status,
    headers: {
      "Cache-Control": "no-store, max-age=0",
      "X-Content-Type-Options": "nosniff"
    }
  });
}

function expectedVersion() {
  return String(process.env.NEXTCLOUD_PHOTO_VERSION || DEFAULT_PHOTO_VERSION).trim();
}

function photoFolderUrl() {
  return String(process.env.NEXTCLOUD_PHOTO_PUBLIC_FOLDER_URL || DEFAULT_PUBLIC_FOLDER_URL)
    .trim()
    .replace(/\/$/, "");
}

function normalizedObjectId(value) {
  const objectId = String(value || "").trim().toUpperCase();
  return /^OBJ_\d{3}$/.test(objectId) ? objectId : "";
}

export function buildNextcloudPreviewUrl(objectId) {
  const folder = new URL(photoFolderUrl());
  if (folder.protocol !== "https:") throw new Error("Папка фотографий Nextcloud должна использовать HTTPS.");
  const match = folder.pathname.match(/^(.*?)(\/index\.php)?\/s\/([^/?#]+)/i);
  if (!match) throw new Error("Некорректная публичная ссылка папки фотографий Nextcloud.");
  const prefix = match[1] || "";
  const indexPart = match[2] || "";
  const token = decodeURIComponent(match[3]);
  const params = new URLSearchParams({
    file: `/${objectId}.jpg`,
    x: "960",
    y: "540",
    a: "true",
    scalingup: "0",
    v: expectedVersion()
  });
  return `${folder.origin}${prefix}${indexPart}/apps/files_sharing/publicpreview/${encodeURIComponent(token)}?${params}`;
}

function cacheKey(objectId, version) {
  return `${version}--${objectId}`;
}

async function cachedPhoto(store, key) {
  const memory = memoryCache.get(key);
  if (memory) return { ...memory, cacheStatus: "memory" };
  if (!store) return null;
  try {
    const entry = await store.getWithMetadata(key, { type: "arrayBuffer", consistency: "eventual" });
    if (!entry?.data) return null;
    const photo = {
      bytes: entry.data,
      contentType: String(entry.metadata?.contentType || "image/jpeg"),
      etag: String(entry.metadata?.etag || entry.etag || ""),
      cacheStatus: "blob"
    };
    memoryCache.set(key, photo);
    return photo;
  } catch (_) {
    return null;
  }
}

async function fetchPhoto(objectId) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), SOURCE_TIMEOUT_MS);
  try {
    const response = await fetch(buildNextcloudPreviewUrl(objectId), {
      method: "GET",
      headers: {
        "Accept": "image/avif,image/webp,image/jpeg,image/*;q=0.8",
        "User-Agent": "PhotoDashboard/2.0"
      },
      cache: "no-store",
      redirect: "follow",
      signal: controller.signal
    });
    if (!response.ok) throw new Error(`Nextcloud вернул HTTP ${response.status}.`);
    const contentType = String(response.headers.get("content-type") || "").split(";")[0].trim().toLowerCase();
    if (!contentType.startsWith("image/")) throw new Error("Nextcloud вернул не изображение.");
    const declaredSize = Number(response.headers.get("content-length") || 0);
    if (declaredSize > MAX_PHOTO_BYTES) throw new Error("Фотография превышает допустимый размер.");
    const bytes = await response.arrayBuffer();
    if (!bytes.byteLength || bytes.byteLength > MAX_PHOTO_BYTES) {
      throw new Error("Фотография пустая либо превышает допустимый размер.");
    }
    return {
      bytes,
      contentType,
      etag: createHash("sha256").update(Buffer.from(bytes)).digest("hex"),
      cacheStatus: "source"
    };
  } catch (error) {
    if (error?.name === "AbortError") {
      throw new Error(`Nextcloud не отдал фотографию за ${SOURCE_TIMEOUT_MS / 1000} секунд.`);
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

function photoResponse(req, photo) {
  const etag = `"${photo.etag}"`;
  const headers = {
    "Cache-Control": "private, max-age=86400, stale-while-revalidate=604800",
    "Content-Type": photo.contentType,
    "Content-Disposition": "inline",
    "X-Content-Type-Options": "nosniff",
    "Cross-Origin-Resource-Policy": "same-origin",
    "ETag": etag,
    "Vary": "Cookie",
    "X-PhotoDashboard-Photo-Cache": photo.cacheStatus
  };
  if (req.headers.get("if-none-match") === etag) {
    return new Response(null, { status: 304, headers });
  }
  return new Response(photo.bytes, { status: 200, headers });
}

export default async (req, context = {}) => {
  if (req.method !== "GET") return json({ error: "Метод не поддерживается" }, 405);
  const configurationError = accessConfigurationError();
  if (configurationError) return json({ error: configurationError, authenticated: false }, 503);
  if (!isAccessAuthorized(req)) return json({ error: "Требуется вход в дашборд." }, 401);

  const url = new URL(req.url);
  const objectId = normalizedObjectId(url.searchParams.get("id"));
  if (!objectId) return json({ error: "Некорректный идентификатор объекта." }, 400);
  const version = String(url.searchParams.get("v") || expectedVersion()).trim();
  if (version !== expectedVersion()) return json({ error: "Версия фотографии не поддерживается." }, 400);
  const key = cacheKey(objectId, version);

  let store = null;
  try {
    store = getStore({ name: STORE_NAME });
  } catch (_) {}

  const cached = await cachedPhoto(store, key);
  if (cached) return photoResponse(req, cached);

  try {
    const photo = await fetchPhoto(objectId);
    memoryCache.set(key, photo);
    if (store) {
      const write = store.set(key, photo.bytes, {
        metadata: { contentType: photo.contentType, etag: photo.etag, cachedAt: new Date().toISOString() }
      });
      if (typeof context.waitUntil === "function") context.waitUntil(write.catch(() => {}));
      else await write.catch(() => {});
    }
    return photoResponse(req, photo);
  } catch (error) {
    return json({
      error: "Фотография временно недоступна.",
      details: String(error?.message || error).slice(0, 240),
      retryable: true
    }, 503);
  }
};

export const config = {
  path: "/.netlify/functions/photo"
};
