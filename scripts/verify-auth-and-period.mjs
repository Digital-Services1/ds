import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import vm from "node:vm";

const build = "2.0.7-rc5-fast-load-20260804";
const periodSource = await readFile(new URL("../period-utils.v207.js", import.meta.url), "utf8");
const context = {
  window: {
    PHOTO_DASHBOARD_ASSETS: Object.create(null)
  },
  Intl,
  Date,
  Object
};
vm.runInNewContext(periodSource, context, { filename: "period-utils.js" });

const period = context.window.PhotoDashboardPeriod;
assert.equal(context.window.PHOTO_DASHBOARD_ASSETS.period, build);
assert.deepEqual(
  Array.from(period.reportPeriodRangeAt(new Date("2026-07-31T09:00:00Z"))),
  ["2026-07-29", "2026-08-05"]
);
assert.deepEqual(
  Array.from(period.reportPeriodRangeAt(new Date("2026-08-05T20:29:00Z"))),
  ["2026-07-29", "2026-08-05"]
);
assert.deepEqual(
  Array.from(period.reportPeriodRangeAt(new Date("2026-08-05T20:30:00Z"))),
  ["2026-08-05", "2026-08-12"]
);
assert.equal(
  period.nextSwitchAt(new Date("2026-07-31T09:00:00Z")).toISOString(),
  "2026-08-05T20:30:00.000Z"
);

const previousEnvironment = {
  DASHBOARD_ACCESS_PASSWORD: process.env.DASHBOARD_ACCESS_PASSWORD,
  DASHBOARD_ACCESS_TOKEN_SECRET: process.env.DASHBOARD_ACCESS_TOKEN_SECRET,
  DASHBOARD_ADMIN_PASSWORD: process.env.DASHBOARD_ADMIN_PASSWORD,
  DASHBOARD_ADMIN_TOKEN_SECRET: process.env.DASHBOARD_ADMIN_TOKEN_SECRET,
  YANDEX_MAPS_API_KEY: process.env.YANDEX_MAPS_API_KEY
};
process.env.DASHBOARD_ACCESS_PASSWORD = "viewer-test-password";
process.env.DASHBOARD_ACCESS_TOKEN_SECRET = "viewer-test-secret-that-is-long-enough";
process.env.YANDEX_MAPS_API_KEY = "yandex-test-key";

const auth = await import("../netlify/functions/_shared/access-auth.mjs");
assert.equal(auth.verifyAccessPassword("viewer-test-password"), true);
assert.equal(auth.verifyAccessPassword("wrong"), false);
const token = auth.issueAccessToken();
const cookie = `${auth.ACCESS_COOKIE_NAME}=${encodeURIComponent(token)}`;
assert.equal(auth.isAccessAuthorized(new Request("https://example.test/", {
  headers: { cookie }
})), true);
assert.equal(auth.isAccessAuthorized(new Request("https://example.test/")), false);

const accessSession = (await import("../netlify/functions/access-session.mjs")).default;
const anonymousResponse = await accessSession(new Request("https://example.test/api/access-session"));
assert.equal(anonymousResponse.status, 200);
assert.equal((await anonymousResponse.json()).authenticated, false);

const loginResponse = await accessSession(new Request("https://example.test/api/access-session", {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ action: "login", password: "viewer-test-password" })
}));
assert.equal(loginResponse.status, 200);
const loginPayload = await loginResponse.json();
assert.equal(loginPayload.authenticated, true);
assert.equal(loginPayload.yandexMapsApiKey, "yandex-test-key");
assert.match(loginResponse.headers.get("set-cookie") || "", /HttpOnly/);
assert.match(loginResponse.headers.get("set-cookie") || "", /SameSite=Lax/);

const dashboardData = (await import("../netlify/functions/dashboard-data.mjs")).default;
const unauthorizedData = await dashboardData(new Request("https://example.test/api/dashboard-data"));
assert.equal(unauthorizedData.status, 401);

const sessionCookie = (loginResponse.headers.get("set-cookie") || "").split(";")[0];
const protectedFallback = await dashboardData(new Request("https://example.test/api/dashboard-data?mode=bundled", {
  headers: { cookie: sessionCookie }
}));
assert.equal(protectedFallback.status, 200);
const protectedFallbackPayload = await protectedFallback.json();
assert.equal(protectedFallbackPayload.meta.sourceStatus, "fallback");
assert.ok(protectedFallbackPayload.objects.length > 0);
assert.ok(protectedFallbackPayload.visits.length > 0);

for (let attempt = 1; attempt <= 5; attempt += 1) {
  const limited = await accessSession(new Request("https://example.test/api/access-session", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "User-Agent": "rate-limit-test",
      "X-Nf-Client-Connection-Ip": "192.0.2.207"
    },
    body: JSON.stringify({ action: "login", password: "wrong-password" })
  }));
  assert.equal(limited.status, attempt < 5 ? 401 : 429);
}
const blockedLogin = await accessSession(new Request("https://example.test/api/access-session", {
  method: "POST",
  headers: {
    "Content-Type": "application/json",
    "User-Agent": "rate-limit-test",
    "X-Nf-Client-Connection-Ip": "192.0.2.207"
  },
  body: JSON.stringify({ action: "login", password: "viewer-test-password" })
}));
assert.equal(blockedLogin.status, 429);
assert.ok(Number(blockedLogin.headers.get("retry-after")) > 0);

const statusAdmin = (await import("../netlify/functions/status-admin.mjs")).default;
const unauthorizedStatuses = await statusAdmin(new Request("https://example.test/.netlify/functions/status-admin"));
assert.equal(unauthorizedStatuses.status, 401);

delete process.env.DASHBOARD_ACCESS_PASSWORD;
delete process.env.DASHBOARD_ACCESS_TOKEN_SECRET;
const failClosedSession = await accessSession(new Request("https://example.test/api/access-session"));
assert.equal(failClosedSession.status, 503);
const failClosedData = await dashboardData(new Request("https://example.test/api/dashboard-data"));
assert.equal(failClosedData.status, 503);

process.env.DASHBOARD_ACCESS_PASSWORD = "viewer-test-password";
process.env.DASHBOARD_ACCESS_TOKEN_SECRET = "short-secret";
const weakSecretSession = await accessSession(new Request("https://example.test/api/access-session"));
assert.equal(weakSecretSession.status, 503);

process.env.DASHBOARD_ACCESS_TOKEN_SECRET = "viewer-test-secret-that-is-long-enough";
process.env.DASHBOARD_ADMIN_PASSWORD = "admin-test-password";
delete process.env.DASHBOARD_ADMIN_TOKEN_SECRET;
const missingAdminSecret = await statusAdmin(new Request("https://example.test/.netlify/functions/status-admin", {
  method: "POST",
  headers: { "Content-Type": "application/json", cookie: sessionCookie },
  body: JSON.stringify({ action: "login", password: "admin-test-password" })
}));
assert.equal(missingAdminSecret.status, 503);
delete process.env.DASHBOARD_ADMIN_PASSWORD;

for (const [key, value] of Object.entries(previousEnvironment)) {
  if (value === undefined) delete process.env[key];
  else process.env[key] = value;
}

console.log("Проверка серверной авторизации и автоматического периода пройдена.");
