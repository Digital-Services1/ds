import { createHmac, timingSafeEqual } from "node:crypto";

export const ACCESS_COOKIE_NAME = "photo_dashboard_access";
export const ACCESS_TTL_SECONDS = 12 * 60 * 60;

function safeEqual(left, right) {
  const a = Buffer.from(String(left ?? ""));
  const b = Buffer.from(String(right ?? ""));
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

function sign(payload, secret) {
  return createHmac("sha256", secret).update(payload).digest("base64url");
}

function tokenSecret() {
  return String(process.env.DASHBOARD_ACCESS_TOKEN_SECRET || "");
}

function parseCookies(req) {
  const result = new Map();
  const source = req.headers.get("cookie") || "";
  for (const part of source.split(";")) {
    const separator = part.indexOf("=");
    if (separator < 1) continue;
    const name = part.slice(0, separator).trim();
    const rawValue = part.slice(separator + 1).trim();
    try {
      result.set(name, decodeURIComponent(rawValue));
    } catch (_) {
      result.set(name, rawValue);
    }
  }
  return result;
}

export function accessPasswordConfigured() {
  return Boolean(String(process.env.DASHBOARD_ACCESS_PASSWORD || ""));
}

export function accessConfigurationError() {
  if (!accessPasswordConfigured()) {
    return "На сервере не задана переменная DASHBOARD_ACCESS_PASSWORD.";
  }
  const secret = tokenSecret();
  if (!secret) {
    return "На сервере не задана переменная DASHBOARD_ACCESS_TOKEN_SECRET.";
  }
  if (Buffer.byteLength(secret, "utf8") < 32) {
    return "DASHBOARD_ACCESS_TOKEN_SECRET должен содержать не менее 32 символов.";
  }
  return null;
}

export function verifyAccessPassword(value) {
  const expected = String(process.env.DASHBOARD_ACCESS_PASSWORD || "");
  return Boolean(expected) && safeEqual(value, expected);
}

export function issueAccessToken() {
  const configurationError = accessConfigurationError();
  if (configurationError) throw new Error(configurationError);
  const secret = tokenSecret();
  const payload = Buffer.from(JSON.stringify({
    role: "dashboard-viewer",
    exp: Math.floor(Date.now() / 1000) + ACCESS_TTL_SECONDS
  })).toString("base64url");
  return `${payload}.${sign(payload, secret)}`;
}

export function verifyAccessToken(token) {
  const secret = tokenSecret();
  if (!token || !secret) return false;
  const [payload, signature] = String(token).split(".");
  if (!payload || !signature || !safeEqual(signature, sign(payload, secret))) return false;
  try {
    const parsed = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
    return parsed.role === "dashboard-viewer" &&
      Number(parsed.exp) > Math.floor(Date.now() / 1000);
  } catch (_) {
    return false;
  }
}

export function accessSessionExpiresIn(req) {
  const token = parseCookies(req).get(ACCESS_COOKIE_NAME);
  if (!verifyAccessToken(token)) return 0;
  try {
    const [payload] = String(token).split(".");
    const parsed = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
    return Math.max(0, Number(parsed.exp) - Math.floor(Date.now() / 1000));
  } catch (_) {
    return 0;
  }
}

export function isAccessAuthorized(req) {
  if (accessConfigurationError()) return false;
  return verifyAccessToken(parseCookies(req).get(ACCESS_COOKIE_NAME));
}

export function accessCookie(token, maxAge = ACCESS_TTL_SECONDS) {
  const value = encodeURIComponent(token || "");
  return [
    `${ACCESS_COOKIE_NAME}=${value}`,
    "Path=/",
    `Max-Age=${Math.max(0, Number(maxAge) || 0)}`,
    "HttpOnly",
    "Secure",
    "SameSite=Lax"
  ].join("; ");
}
