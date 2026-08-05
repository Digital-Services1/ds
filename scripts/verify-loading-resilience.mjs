import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import vm from "node:vm";

const bootstrap = await readFile(new URL("../bootstrap.source.js", import.meta.url), "utf8");
const netlify = await readFile(new URL("../netlify.toml", import.meta.url), "utf8");
const loader = await readFile(new URL("../excel-loader.v207.js", import.meta.url), "utf8");
const index = await readFile(new URL("../index.html", import.meta.url), "utf8");
const serverData = await readFile(new URL("../netlify/functions/dashboard-data.mjs", import.meta.url), "utf8");
const photoFunction = await readFile(new URL("../netlify/functions/photo.mjs", import.meta.url), "utf8");

assert.doesNotMatch(bootstrap, /if \(localPreview \|\| bundledFallbackEnabled\)/);
assert.match(bootstrap, /allowFallback: false/);
assert.match(bootstrap, /mode: "cache"/);
assert.match(bootstrap, /mode: "bundled"/);
assert.match(bootstrap, /fetchScriptSource/);
assert.match(bootstrap, /asset-load-retry/);
assert.match(bootstrap, /cache: "force-cache"/);
assert.match(bootstrap, /preloadDashboardAssets/);
assert.match(bootstrap, /const yandexWarmup = loadYandexApi/);
assert.match(bootstrap, /Bundled fallback data deferred until the server data request fails/);

assert.match(loader, /allowFallback = true/);
assert.match(loader, /allowFallback && window\.APP_CONFIG\?\.allowBundledDataFallback/);
assert.match(loader, /window\.captureBundledDashboardData/);
assert.match(loader, /window\.useBundledDashboardData/);

assert.match(netlify, /publish = "dist"/);
assert.match(netlify, /from = "\/api\/photo"/);
assert.match(index, /<link id="mainStyles" rel="stylesheet" href="styles\.v207\.[a-f0-9]{12}\.css">/);
assert.match(index, /<script src="corporate-shell\.v207\.[a-f0-9]{12}\.js" defer><\/script>/);
assert.doesNotMatch(index, /window\.APP_CONFIG = \{/);
assert.doesNotMatch(index, /App script started/);
assert.match(index, /\.password-gate \{/);
assert.ok(index.indexOf('id="passwordGate"') > 0 && index.indexOf('id="passwordGate"') < 8000);
assert.ok(index.indexOf('id="mainStyles"') > index.indexOf('id="passwordGate"'));
assert.match(serverData, /BUNDLED_DASHBOARD_DATA/);
assert.match(serverData, /mode === "cache"/);
assert.match(serverData, /mode === "bundled"/);
assert.match(serverData, /readCached\(store, "eventual"\)/);
assert.match(photoFunction, /photo360-photo-cache/);
assert.match(photoFunction, /isAccessAuthorized/);
assert.match(photoFunction, /Cache-Control": "private, max-age=86400/);

const publicFiles = (await readdir(new URL("../dist", import.meta.url))).sort();
assert.equal(publicFiles.length, 11);
for (const prefix of ["admin", "app", "excel-loader", "period-utils"]) {
  assert.equal(
    publicFiles.filter(file => new RegExp(`^${prefix}\\.v207\\.[a-f0-9]{12}\\.js$`).test(file)).length,
    1,
    `${prefix} must be published with a content hash`
  );
}
for (const prefix of ["bootstrap", "config", "corporate-shell"]) {
  assert.equal(
    publicFiles.filter(file => new RegExp(`^${prefix}\\.v207\\.[a-f0-9]{12}\\.js$`).test(file)).length,
    1,
    `${prefix} must be published with a content hash`
  );
}
assert.equal(
  publicFiles.filter(file => /^styles\.v207\.[a-f0-9]{12}\.css$/.test(file)).length,
  1,
  "styles must be published with a content hash"
);
for (const file of ["index.html", "moscow_boundary.geojson", "placeholder.svg"]) {
  assert.ok(publicFiles.includes(file));
}
const builtBootstrapName = publicFiles.find(file => /^bootstrap\.v207\.[a-f0-9]{12}\.js$/.test(file));
const builtConfigName = publicFiles.find(file => /^config\.v207\.[a-f0-9]{12}\.js$/.test(file));
const builtCorporateShellName = publicFiles.find(file => /^corporate-shell\.v207\.[a-f0-9]{12}\.js$/.test(file));
const [builtBootstrap, builtConfig, builtCorporateShell] = await Promise.all([
  readFile(new URL(`../dist/${builtBootstrapName}`, import.meta.url), "utf8"),
  readFile(new URL(`../dist/${builtConfigName}`, import.meta.url), "utf8"),
  readFile(new URL(`../dist/${builtCorporateShellName}`, import.meta.url), "utf8")
]);
assert.match(builtConfig, /window\.APP_CONFIG = \{/);
assert.match(builtBootstrap, /App script started/);
assert.match(builtBootstrap, /app\.v207\.[a-f0-9]{12}\.js/);
assert.match(builtCorporateShell, /Promise\.all\(\[fetchSource\("config"\), fetchSource\("bootstrap"\)\]\)/);
assert.match(builtCorporateShell, /cache: "force-cache"/);
assert.match(builtCorporateShell, /config\.v207\.[a-f0-9]{12}\.js/);
assert.match(builtCorporateShell, /bootstrap\.v207\.[a-f0-9]{12}\.js/);

function createLoaderContext(fetchImpl) {
  const location = {
    protocol: "https:",
    hostname: "example.test",
    origin: "https://example.test"
  };
  const window = {
    APP_CONFIG: {
      dashboardDataEndpoint: "/api/dashboard-data",
      allowBundledDataFallback: true
    },
    PHOTO_DASHBOARD_ASSETS: Object.create(null),
    location,
    setTimeout,
    clearTimeout
  };
  const context = {
    window,
    location,
    fetch: fetchImpl,
    URL,
    AbortController,
    console,
    setTimeout,
    clearTimeout
  };
  vm.runInNewContext(loader, context, { filename: "excel-loader.v207.js" });
  return window;
}

const liveData = {
  meta: { sourceStatus: "live" },
  objects: [{ id: "OBJ_001" }],
  visits: [{ id: "VIS_001" }]
};
const liveWindow = createLoaderContext(async () => new Response(JSON.stringify(liveData), {
  status: 200,
  headers: { "Content-Type": "application/json" }
}));
await liveWindow.loadDashboardData({ allowFallback: false, timeoutMs: 1000 });
assert.equal(liveWindow.DASHBOARD_DATA.meta.sourceStatus, "live");

const fallbackWindow = createLoaderContext(async () => {
  throw new Error("network-offline");
});
await assert.rejects(
  fallbackWindow.loadDashboardData({ allowFallback: false, timeoutMs: 1000 }),
  /network-offline/
);
fallbackWindow.DASHBOARD_DATA = {
  meta: { sourceStatus: "local" },
  objects: [{ id: "OBJ_FALLBACK" }],
  visits: [{ id: "VIS_FALLBACK" }]
};
fallbackWindow.captureBundledDashboardData();
await fallbackWindow.loadDashboardData({ allowFallback: true, timeoutMs: 1000 });
assert.equal(fallbackWindow.DASHBOARD_DATA.meta.sourceStatus, "local");
assert.equal(fallbackWindow.DASHBOARD_DATA.meta.liveSync, false);
assert.match(fallbackWindow.DASHBOARD_DATA.meta.fallbackReason, /network-offline/);

console.log("Проверка устойчивой загрузки и кэширования 2.0.7 пройдена.");
