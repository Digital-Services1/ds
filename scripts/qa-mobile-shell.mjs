import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { readFile } from "node:fs/promises";

const require = createRequire(import.meta.url);
const { JSDOM } = require("jsdom");
const root = new URL("../", import.meta.url);

const [index, localData] = await Promise.all([
  readFile(new URL("index.html", root), "utf8"),
  readFile(new URL("data.v207.js", root), "utf8")
]);

const dataMatch = localData.match(/window\.DASHBOARD_DATA\s*=\s*(\{[\s\S]*\})\s*;\s*$/);
const data = JSON.parse(dataMatch[1]);
data.meta = { ...data.meta, sourceStatus: "ok", liveSync: true };

function builtAssetName(source, prefix, extension = "js") {
  const match = source.match(new RegExp(`${prefix}\\.v207\\.[a-f0-9]{12}\\.${extension}`));
  assert.ok(match, `Hashed ${prefix} asset was not embedded into index.html`);
  return match[0];
}

const stylesAsset = builtAssetName(index, "styles", "css");
const corporateShellAsset = builtAssetName(index, "corporate-shell");
const corporateShell = await readFile(new URL(`dist/${corporateShellAsset}`, root), "utf8");
const configAsset = builtAssetName(corporateShell, "config");
const bootstrapAsset = builtAssetName(corporateShell, "bootstrap");

const [config, bootstrap] = await Promise.all([
  readFile(new URL(`dist/${configAsset}`, root), "utf8"),
  readFile(new URL(`dist/${bootstrapAsset}`, root), "utf8")
]);

const periodAsset = builtAssetName(bootstrap, "period-utils");
const loaderAsset = builtAssetName(bootstrap, "excel-loader");
const appAsset = builtAssetName(bootstrap, "app");
const adminAsset = builtAssetName(bootstrap, "admin");

const [period, loader, app, admin] = await Promise.all([
  readFile(new URL(`dist/${periodAsset}`, root), "utf8"),
  readFile(new URL(`dist/${loaderAsset}`, root), "utf8"),
  readFile(new URL(`dist/${appAsset}`, root), "utf8"),
  readFile(new URL(`dist/${adminAsset}`, root), "utf8")
]);

const assetSources = new Map([
  [configAsset, config],
  [bootstrapAsset, bootstrap],
  [periodAsset, period],
  [loaderAsset, loader],
  [appAsset, app],
  [adminAsset, admin]
]);
const requests = [];
const assetAttempts = new Map();
const testIndex = index.replace(
  new RegExp(`<script src="${corporateShellAsset.replaceAll(".", "\\.")}" defer><\\/script>`),
  `<script>${corporateShell}</script>`
);
assert.notEqual(testIndex, index, "Corporate shell asset was not injected into the DOM QA document");

const dom = new JSDOM(testIndex, {
  url: "https://testp360.example/?mobile-qa=1",
  runScripts: "dangerously",
  pretendToBeVisual: true,
  beforeParse(window) {
    Object.defineProperty(window, "innerWidth", { value: 390, configurable: true });
    Object.defineProperty(window, "innerHeight", { value: 740, configurable: true });
    window.Response = Response;
    window.AbortController = AbortController;
    window.TextEncoder = TextEncoder;
    window.requestAnimationFrame = callback => window.setTimeout(() => callback(Date.now()), 0);
    window.matchMedia = query => ({
      matches: /pointer:\s*coarse/.test(query) || /max-width:\s*980px/.test(query),
      media: query,
      addEventListener() {},
      removeEventListener() {}
    });
    window.fetch = async (input, init = {}) => {
      const url = new URL(String(input), window.location.href);
      requests.push(`${init.method || "GET"} ${url.pathname}${url.search}`);

      if (url.pathname === "/api/access-session") {
        if ((init.method || "GET") === "POST") {
          return Response.json({ authenticated: true, configured: true, yandexMapsApiKey: "" });
        }
        await new Promise(resolve => setTimeout(resolve, 350));
        return Response.json({ authenticated: false, configured: true });
      }
      if (url.pathname === "/api/dashboard-data") {
        if (url.searchParams.get("mode") === "version") {
          return Response.json({
            version: data.meta.version,
            sourceStatus: "ok",
            lastSuccessfulSyncAt: data.meta.lastSuccessfulSyncAt
          });
        }
        return Response.json(data);
      }
      if (assetSources.has(url.pathname.slice(1))) {
        const fileName = url.pathname.slice(1);
        const attempt = (assetAttempts.get(fileName) || 0) + 1;
        assetAttempts.set(fileName, attempt);
        if ((fileName === bootstrapAsset || fileName === appAsset) && attempt === 1) {
          throw new Error("simulated transient proxy failure");
        }
        return new Response(assetSources.get(fileName), {
          status: 200,
          headers: { "Content-Type": "application/javascript" }
        });
      }
      throw new Error(`Unexpected request: ${url}`);
    };
  }
});

const waitFor = async (predicate, timeoutMs = 3000) => {
  const started = Date.now();
  while (!predicate()) {
    if (Date.now() - started > timeoutMs) throw new Error("DOM QA timed out.");
    await new Promise(resolve => setTimeout(resolve, 20));
  }
};

await waitFor(() => requests.some(item => item.startsWith("GET /api/access-session")));
const { document } = dom.window;
assert.equal(document.body.classList.contains("auth-active"), true);
assert.equal(document.getElementById("passwordGate").classList.contains("hidden"), false);
assert.equal(document.querySelector('#passwordForm [type="submit"]').disabled, false);
assert.equal(requests.some(item => /app\.v207\.[a-f0-9]{12}\.js/.test(item)), false);

document.getElementById("passwordInput").value = "qa-password";
document.getElementById("passwordForm").dispatchEvent(new dom.window.Event("submit", {
  bubbles: true,
  cancelable: true
}));

await waitFor(() => Boolean(dom.window.DASHBOARD_APP), 5000);
assert.equal(document.body.classList.contains("dashboard-active"), true);
assert.equal(document.getElementById("passwordGate").classList.contains("hidden"), true);
assert.equal(dom.window.DASHBOARD_DATA.objects.length, data.objects.length);
assert.equal(dom.window.DASHBOARD_DATA.visits.length, data.visits.length);
assert.deepEqual(
  dom.window.DASHBOARD_DATA.objects.map(item => item.id),
  data.objects.map(item => item.id)
);
assert.deepEqual(
  dom.window.DASHBOARD_DATA.visits.map(item => item.id),
  data.visits.map(item => item.id)
);
assert.equal(requests.some(item => /mode=cache/.test(item)), true);
assert.equal(assetAttempts.get(bootstrapAsset), 2);
assert.equal(assetAttempts.get(appAsset), 2);
assert.equal(dom.window.innerWidth, 390);

dom.window.close();
console.log("Mobile/WebView DOM shell QA passed.");
