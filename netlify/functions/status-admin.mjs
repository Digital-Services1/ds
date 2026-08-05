import { getStore } from "./_shared/storage.mjs";
import { createHmac, timingSafeEqual } from "node:crypto";
import { probeExcelWriteAccess } from "./_shared/nextcloud-excel-sync.mjs";
import { accessConfigurationError, isAccessAuthorized } from "./_shared/access-auth.mjs";
import { issueInternalToken } from "./_shared/internal-auth.mjs";
import { clearLoginFailures, loginBlock, recordLoginFailure } from "./_shared/auth-rate-limit.mjs";
import {
  BACKUP_STORE_NAME,
  STATUS_STORE_NAME,
  readStatusDocument,
  syncPendingOperation,
  writeStatusDocument
} from "./_shared/status-store.mjs";
const ALLOWED_STATUSES = new Set(["Запланирован", "Выполнен", "Перенесён", "Отменён", "Завершено"]);
const TOKEN_TTL_SECONDS = 8 * 60 * 60;

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

function safeEqual(left, right) {
  const a = Buffer.from(String(left ?? ""));
  const b = Buffer.from(String(right ?? ""));
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

function base64url(value) {
  return Buffer.from(value).toString("base64url");
}

function sign(payload, secret) {
  return createHmac("sha256", secret).update(payload).digest("base64url");
}

function issueToken(secret) {
  const payload = base64url(JSON.stringify({
    role: "status-admin",
    exp: Math.floor(Date.now() / 1000) + TOKEN_TTL_SECONDS
  }));
  return `${payload}.${sign(payload, secret)}`;
}

function verifyToken(token, secret) {
  if (!token || !secret) return false;
  const [payload, signature] = token.split(".");
  if (!payload || !signature || !safeEqual(signature, sign(payload, secret))) return false;
  try {
    const parsed = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
    return parsed.role === "status-admin" && Number(parsed.exp) > Math.floor(Date.now() / 1000);
  } catch (_) {
    return false;
  }
}

function getBearer(req) {
  const value = req.headers.get("authorization") || "";
  return value.startsWith("Bearer ") ? value.slice(7).trim() : "";
}

function adminConfigurationError() {
  if (!String(process.env.DASHBOARD_ADMIN_PASSWORD || "")) {
    return "На сервере не задана переменная DASHBOARD_ADMIN_PASSWORD.";
  }
  const secret = String(process.env.DASHBOARD_ADMIN_TOKEN_SECRET || "");
  if (!secret) return "На сервере не задана переменная DASHBOARD_ADMIN_TOKEN_SECRET.";
  if (Buffer.byteLength(secret, "utf8") < 32) {
    return "DASHBOARD_ADMIN_TOKEN_SECRET должен содержать не менее 32 символов.";
  }
  return null;
}

async function scheduleBackgroundSync(req, visitId, operationId) {
  const rawBody = JSON.stringify({ visitId, operationId });
  try {
    const url = new URL("/.netlify/functions/status-sync-background", req.url);
    const request = fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Photo-Internal": issueInternalToken(rawBody)
      },
      body: rawBody
    });
    if (process.env.RUNTIME_PLATFORM === "timeweb") {
      request
        .then(response => {
          if (!response.ok && response.status !== 202) {
            console.error("[PhotoDashboard][excel-sync] background-http-failed", response.status);
          }
        })
        .catch(error => {
          console.error("[PhotoDashboard][excel-sync] background-start-failed", String(error?.message || error));
        });
      return true;
    }
    const response = await request;
    return response.ok || response.status === 202;
  } catch (error) {
    console.error("[PhotoDashboard][excel-sync] background-start-failed", String(error?.message || error));
    return false;
  }
}

export default async (req) => {
  const accessError = accessConfigurationError();
  if (accessError) return json({ error: accessError, configured: false }, 503);
  if (!isAccessAuthorized(req)) {
    return json({ error: "Требуется вход в дашборд.", authenticated: false }, 401);
  }
  const password = process.env.DASHBOARD_ADMIN_PASSWORD || "";
  const tokenSecret = process.env.DASHBOARD_ADMIN_TOKEN_SECRET || "";

  if (req.method === "GET") {
    const store = getStore({ name: STATUS_STORE_NAME, consistency: "strong" });
    const document = await readStatusDocument(store);
    return json({ items: document.items, updatedAt: document.updatedAt });
  }

  if (req.method !== "POST") {
    return json({ error: "Метод не поддерживается" }, 405);
  }

  let body;
  try {
    body = await req.json();
  } catch (_) {
    return json({ error: "Некорректный JSON" }, 400);
  }

  if (body?.action === "login") {
    const configurationError = adminConfigurationError();
    if (configurationError) return json({ error: configurationError }, 503);
    const blocked = await loginBlock("admin", req);
    if (blocked) {
      return json({
        error: `Слишком много неудачных попыток. Повторите через ${blocked.retryAfterSeconds} сек.`,
        retryAfterSeconds: blocked.retryAfterSeconds
      }, 429);
    }
    if (!safeEqual(body.password, password)) {
      const state = await recordLoginFailure("admin", req);
      await new Promise(resolve => setTimeout(resolve, 350));
      return json({
        error: state.blocked
          ? `Слишком много неудачных попыток. Повторите через ${state.retryAfterSeconds} сек.`
          : "Неверный пароль администратора"
      }, state.blocked ? 429 : 401);
    }
    await clearLoginFailures("admin", req);
    return json({ token: issueToken(tokenSecret), expiresIn: TOKEN_TTL_SECONDS });
  }

  const configurationError = adminConfigurationError();
  if (configurationError) return json({ error: configurationError }, 503);

  if (!verifyToken(getBearer(req), tokenSecret)) {
    return json({ error: "Сессия администратора истекла. Войдите повторно." }, 401);
  }

  const store = getStore({ name: STATUS_STORE_NAME, consistency: "strong" });
  const backupStore = getStore({ name: BACKUP_STORE_NAME, consistency: "strong" });

  if (body.action === "probe-excel-sync") {
    try {
      const probe = await probeExcelWriteAccess();
      return json({ ok: true, excelSync: probe });
    } catch (error) {
      return json({ ok: false, error: String(error?.message || error).slice(0, 500) }, 503);
    }
  }

  const visitId = String(body?.visitId || "").trim();
  if (!/^[A-Za-zА-Яа-яЁё0-9_.:-]{1,120}$/u.test(visitId)) {
    return json({ error: "Некорректный VISIT_ID" }, 400);
  }

  const document = await readStatusDocument(store);
  const timestamp = new Date().toISOString();

  if (body.action === "set-status") {
    const status = String(body.status || "");
    if (!ALLOWED_STATUSES.has(status)) {
      return json({ error: "Недопустимый статус" }, 400);
    }
    const operationId = String(body.operationId || "").trim();
    if (!/^[A-Za-z0-9_-]{16,100}$/.test(operationId)) {
      return json({ error: "Некорректный идентификатор операции" }, 400);
    }
    const completed = document.audit.find(item =>
      item?.type === "excel-synced" && item.operationId === operationId && item.visitId === visitId
    );
    if (completed) {
      return json({
        ok: true,
        duplicate: true,
        visitId,
        status: completed.status,
        updatedAt: completed.updatedAt,
        excelSync: {
          status: "synced",
          operationId,
          syncedAt: completed.updatedAt,
          backupKey: completed.backupKey || null
        }
      });
    }
    const existing = document.items[visitId];
    if (existing?.operationId === operationId) {
      if (existing.sync?.status === "pending") {
        await scheduleBackgroundSync(req, visitId, operationId);
      }
      return json({
        ok: true,
        duplicate: true,
        visitId,
        status: existing.status,
        updatedAt: existing.updatedAt,
        excelSync: existing.sync
      }, 202);
    }

    const previous = existing?.status || null;
    document.items[visitId] = {
      status,
      operationId,
      updatedAt: timestamp,
      sync: {
        status: "pending",
        operationId,
        attempts: 0,
        updatedAt: timestamp,
        error: null
      }
    };
    document.updatedAt = timestamp;
    document.audit.unshift({ visitId, previous, status, updatedAt: timestamp });
    document.audit = document.audit.slice(0, 200);
    await writeStatusDocument(store, document);

    const sync = await syncPendingOperation({
      store,
      backupStore,
      visitId,
      operationId,
      maxAttempts: 1
    });
    if (sync.status === "synced") {
      return json({
        ok: true,
        visitId,
        status,
        updatedAt: timestamp,
        excelSync: sync
      });
    }
    if (sync.status === "pending") await scheduleBackgroundSync(req, visitId, operationId);
    return json({
      ok: true,
      visitId,
      status,
      updatedAt: timestamp,
      excelSync: sync
    }, 202);
  }

  if (body.action === "reset-status") {
    const previous = document.items[visitId]?.status || null;
    delete document.items[visitId];
    document.updatedAt = timestamp;
    document.audit.unshift({ visitId, previous, status: null, updatedAt: timestamp });
    document.audit = document.audit.slice(0, 200);
    await writeStatusDocument(store, document);
    return json({ ok: true, visitId, reset: true, updatedAt: timestamp });
  }

  return json({ error: "Неизвестное действие" }, 400);
};

export const config = {
  path: "/.netlify/functions/status-admin"
};
