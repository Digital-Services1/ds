import assert from "node:assert/strict";

const previousEnvironment = {
  DASHBOARD_ACCESS_PASSWORD: process.env.DASHBOARD_ACCESS_PASSWORD,
  DASHBOARD_ACCESS_TOKEN_SECRET: process.env.DASHBOARD_ACCESS_TOKEN_SECRET,
  NEXTCLOUD_PHOTO_VERSION: process.env.NEXTCLOUD_PHOTO_VERSION
};
process.env.DASHBOARD_ACCESS_PASSWORD = "viewer-test-password";
process.env.DASHBOARD_ACCESS_TOKEN_SECRET = "viewer-test-secret-that-is-long-enough";
process.env.NEXTCLOUD_PHOTO_VERSION = "20260729-v1183";

const auth = await import("../netlify/functions/_shared/access-auth.mjs");
const photoModule = await import("../netlify/functions/photo.mjs");
const photo = photoModule.default;
const token = auth.issueAccessToken();
const cookie = `${auth.ACCESS_COOKIE_NAME}=${encodeURIComponent(token)}`;

const unauthorized = await photo(new Request("https://example.test/api/photo?id=OBJ_001"));
assert.equal(unauthorized.status, 401);

const invalidId = await photo(new Request("https://example.test/api/photo?id=../../secret", {
  headers: { cookie }
}));
assert.equal(invalidId.status, 400);

const previewUrl = photoModule.buildNextcloudPreviewUrl("OBJ_001");
assert.match(previewUrl, /publicpreview/);
assert.match(previewUrl, /OBJ_001\.jpg/);

const originalFetch = globalThis.fetch;
let sourceRequests = 0;
const jpeg = Uint8Array.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0xff, 0xd9]);
globalThis.fetch = async url => {
  sourceRequests += 1;
  assert.match(String(url), /publicpreview/);
  return new Response(jpeg, {
    status: 200,
    headers: {
      "Content-Type": "image/jpeg",
      "Content-Length": String(jpeg.byteLength)
    }
  });
};

try {
  const requestUrl = "https://example.test/api/photo?id=OBJ_001&v=20260729-v1183";
  const first = await photo(new Request(requestUrl, { headers: { cookie } }));
  assert.equal(first.status, 200);
  assert.equal(first.headers.get("content-type"), "image/jpeg");
  assert.equal(first.headers.get("x-photodashboard-photo-cache"), "source");
  assert.match(first.headers.get("cache-control") || "", /^private,/);
  assert.deepEqual(new Uint8Array(await first.arrayBuffer()), jpeg);

  const second = await photo(new Request(requestUrl, { headers: { cookie } }));
  assert.equal(second.status, 200);
  assert.equal(second.headers.get("x-photodashboard-photo-cache"), "memory");
  assert.equal(sourceRequests, 1);
  const etag = second.headers.get("etag");
  assert.ok(etag);

  const conditional = await photo(new Request(requestUrl, {
    headers: { cookie, "If-None-Match": etag }
  }));
  assert.equal(conditional.status, 304);

  const wrongVersion = await photo(new Request("https://example.test/api/photo?id=OBJ_001&v=unknown", {
    headers: { cookie }
  }));
  assert.equal(wrongVersion.status, 400);
} finally {
  globalThis.fetch = originalFetch;
  for (const [key, value] of Object.entries(previousEnvironment)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
}

console.log("Проверка защищённого кэша фотографий пройдена.");
