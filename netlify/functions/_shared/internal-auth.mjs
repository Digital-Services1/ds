import { createHmac, timingSafeEqual } from "node:crypto";

function secret() {
  return String(process.env.DASHBOARD_ADMIN_TOKEN_SECRET || "");
}

function signature(timestamp, body) {
  return createHmac("sha256", secret()).update(`${timestamp}.${body}`).digest("base64url");
}

export function issueInternalToken(body) {
  const timestamp = String(Math.floor(Date.now() / 1000));
  return `${timestamp}.${signature(timestamp, body)}`;
}

export function verifyInternalToken(token, body) {
  if (Buffer.byteLength(secret(), "utf8") < 32) return false;
  const [timestamp, supplied] = String(token || "").split(".");
  if (!/^\d{10}$/.test(timestamp || "") || !supplied) return false;
  if (Math.abs(Math.floor(Date.now() / 1000) - Number(timestamp)) > 300) return false;
  const expected = signature(timestamp, body);
  const left = Buffer.from(supplied);
  const right = Buffer.from(expected);
  return left.length === right.length && timingSafeEqual(left, right);
}
