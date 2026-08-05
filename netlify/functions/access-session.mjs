import {
  ACCESS_TTL_SECONDS,
  accessCookie,
  accessConfigurationError,
  accessSessionExpiresIn,
  isAccessAuthorized,
  issueAccessToken,
  verifyAccessPassword
} from "./_shared/access-auth.mjs";
import { clearLoginFailures, loginBlock, recordLoginFailure } from "./_shared/auth-rate-limit.mjs";

function json(data, status = 200, headers = {}) {
  return Response.json(data, {
    status,
    headers: {
      "Cache-Control": "no-store, max-age=0",
      "X-Content-Type-Options": "nosniff",
      "Referrer-Policy": "same-origin",
      ...headers
    }
  });
}

function runtimeConfig() {
  return {
    yandexMapsApiKey: String(process.env.YANDEX_MAPS_API_KEY || "").trim(),
    serverNow: new Date().toISOString()
  };
}

export default async (req, context = {}) => {
  const configurationError = accessConfigurationError();
  if (configurationError) {
    return json({
      authenticated: false,
      configured: false,
      error: configurationError
    }, 503);
  }

  if (req.method === "GET") {
    const authenticated = isAccessAuthorized(req);
    return json({
      authenticated,
      configured: true,
      ...(authenticated ? { ...runtimeConfig(), expiresIn: accessSessionExpiresIn(req) } : {})
    });
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

  if (body?.action === "logout") {
    return json(
      { authenticated: false, configured: true },
      200,
      { "Set-Cookie": accessCookie("", 0) }
    );
  }

  if (body?.action !== "login") {
    return json({ error: "Неизвестное действие" }, 400);
  }

  const blocked = await loginBlock("viewer", req);
  if (blocked) {
    return json({
      authenticated: false,
      configured: true,
      error: `Слишком много неудачных попыток. Повторите через ${blocked.retryAfterSeconds} сек.`,
      retryAfterSeconds: blocked.retryAfterSeconds
    }, 429, { "Retry-After": String(blocked.retryAfterSeconds) });
  }

  if (!verifyAccessPassword(body.password)) {
    const state = await recordLoginFailure("viewer", req);
    await new Promise(resolve => setTimeout(resolve, 350));
    return json({
      authenticated: false,
      configured: true,
      error: state.blocked
        ? `Слишком много неудачных попыток. Повторите через ${state.retryAfterSeconds} сек.`
        : "Неверный пароль",
      attemptsRemaining: state.attemptsRemaining
    }, state.blocked ? 429 : 401, state.blocked ? { "Retry-After": String(state.retryAfterSeconds) } : {});
  }

  // A successful password check must not wait for a remote Blobs delete.
  // Netlify keeps this cleanup alive in the background; local tests and
  // compatible runtimes still await it to preserve deterministic behavior.
  const clearFailures = clearLoginFailures("viewer", req);
  if (typeof context.waitUntil === "function") {
    context.waitUntil(clearFailures.catch(() => {}));
  } else {
    await clearFailures;
  }
  const token = issueAccessToken();
  return json(
    {
      authenticated: true,
      configured: true,
      expiresIn: ACCESS_TTL_SECONDS,
      ...runtimeConfig()
    },
    200,
    { "Set-Cookie": accessCookie(token) }
  );
};

export const config = {
  path: "/.netlify/functions/access-session"
};
