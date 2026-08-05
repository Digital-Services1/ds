import compression from "compression";
import express from "express";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, resolve } from "node:path";

const ROOT = dirname(fileURLToPath(import.meta.url));
const DIST = resolve(ROOT, "dist");
const BUILD = "2.0.7-rc5-fast-load-20260804-timeweb-pilot1";

process.env.RUNTIME_PLATFORM ||= "timeweb";
process.env.DASHBOARD_STORAGE_DIR ||= resolve(ROOT, ".runtime-data");

function firstHeader(value) {
  return String(value || "").split(",")[0].trim();
}

function requestOrigin(req) {
  const protocol = firstHeader(req.headers["x-forwarded-proto"]) || req.protocol || "http";
  const host = firstHeader(req.headers["x-forwarded-host"]) || req.headers.host || "localhost";
  return `${protocol}://${host}`;
}

function webRequest(req, transformUrl = null) {
  const url = new URL(req.originalUrl, requestOrigin(req));
  if (transformUrl) transformUrl(url);
  const headers = new Headers();
  for (const [name, value] of Object.entries(req.headers)) {
    if (Array.isArray(value)) value.forEach(item => headers.append(name, item));
    else if (value != null) headers.set(name, String(value));
  }
  const init = { method: req.method, headers };
  if (req.method !== "GET" && req.method !== "HEAD" && req.body?.length) {
    init.body = req.body;
  }
  return new Request(url, init);
}

async function sendWebResponse(response, res) {
  res.status(response.status);
  for (const [name, value] of response.headers.entries()) res.setHeader(name, value);
  if (!response.body || response.status === 204 || response.status === 304) {
    res.end();
    return;
  }
  res.send(Buffer.from(await response.arrayBuffer()));
}

function staticCacheHeaders(res, filePath) {
  const file = filePath.replaceAll("\\", "/").split("/").at(-1) || "";
  res.setHeader("X-PhotoDashboard-Build", BUILD);
  if (file === "index.html") {
    res.setHeader("Cache-Control", "no-cache, no-store, must-revalidate, max-age=0");
  } else if (/\.v207\.[a-f0-9]{12}\.(?:js|css)$/.test(file)) {
    res.setHeader("Cache-Control", "public, max-age=31536000, immutable");
  } else if (file === "moscow_boundary.geojson" || file === "placeholder.svg") {
    res.setHeader("Cache-Control", "public, max-age=604800, stale-while-revalidate=86400");
  } else {
    res.setHeader("Cache-Control", "public, max-age=0, must-revalidate");
  }
}

export async function createApp() {
  const [
    { default: accessSession },
    { default: dashboardData },
    { default: photo },
    { default: statusAdmin },
    { default: statusSyncBackground }
  ] = await Promise.all([
    import("./netlify/functions/access-session.mjs"),
    import("./netlify/functions/dashboard-data.mjs"),
    import("./netlify/functions/photo.mjs"),
    import("./netlify/functions/status-admin.mjs"),
    import("./netlify/functions/status-sync-background.mjs")
  ]);

  const app = express();
  app.disable("x-powered-by");
  app.set("trust proxy", true);
  app.use(compression({ threshold: 1024 }));
  app.use((req, res, next) => {
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Referrer-Policy", "strict-origin-when-cross-origin");
    res.setHeader("X-PhotoDashboard-Build", BUILD);
    next();
  });

  app.get("/health", (_req, res) => {
    res.setHeader("Cache-Control", "no-store");
    res.status(200).json({ ok: true, build: BUILD });
  });

  app.use(express.raw({ type: () => true, limit: "25mb" }));

  const forward = handler => async (req, res, next) => {
    try {
      const background = [];
      const response = await handler(webRequest(req), {
        waitUntil(promise) {
          const tracked = Promise.resolve(promise).catch(error => {
            console.error("[PhotoDashboard][background]", String(error?.message || error));
          });
          background.push(tracked);
        }
      });
      await sendWebResponse(response, res);
    } catch (error) {
      next(error);
    }
  };

  app.all(["/api/access-session", "/.netlify/functions/access-session"], forward(accessSession));
  app.all(["/api/dashboard-data", "/.netlify/functions/dashboard-data"], forward(dashboardData));
  app.all(["/api/photo", "/.netlify/functions/photo"], forward(photo));
  app.all(["/api/status-admin", "/.netlify/functions/status-admin"], forward(statusAdmin));
  app.all("/.netlify/functions/status-sync-background", forward(statusSyncBackground));

  app.get("/api/version", async (req, res, next) => {
    try {
      const response = await dashboardData(webRequest(req, url => url.searchParams.set("mode", "version")));
      await sendWebResponse(response, res);
    } catch (error) {
      next(error);
    }
  });

  app.use(express.static(DIST, {
    fallthrough: true,
    index: "index.html",
    setHeaders: staticCacheHeaders
  }));

  app.use((req, res) => {
    if (req.path.startsWith("/api/") || req.path.startsWith("/.netlify/functions/")) {
      res.status(404).json({ error: "Маршрут API не найден." });
      return;
    }
    if (req.method !== "GET" && req.method !== "HEAD") {
      res.status(404).end();
      return;
    }
    staticCacheHeaders(res, "index.html");
    res.sendFile(resolve(DIST, "index.html"));
  });

  app.use((error, _req, res, _next) => {
    console.error("[PhotoDashboard][server]", String(error?.stack || error?.message || error));
    if (res.headersSent) return;
    res.status(500).json({ error: "Внутренняя ошибка сервера." });
  });

  return app;
}

export async function startServer({ port = Number(process.env.PORT || 8080), host = "0.0.0.0" } = {}) {
  const app = await createApp();
  return await new Promise((resolveServer, reject) => {
    const server = app.listen(port, host, () => {
      console.log(`[PhotoDashboard] Timeweb server listening on ${host}:${port}`);
      resolveServer(server);
    });
    server.once("error", reject);
  });
}

const executedDirectly = process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href;
if (executedDirectly) {
  startServer().catch(error => {
    console.error("[PhotoDashboard] Server failed to start", error);
    process.exitCode = 1;
  });
}
