(() => {
  "use strict";
  const assets = {
    config: "config.v207.c80c65f846b6.js",
    bootstrap: "bootstrap.v207.6667f45b6abb.js"
  };

  function assetUrl(fileName, attempt) {
    const url = new URL(fileName, window.location.href);
    if (attempt > 1) url.searchParams.set("retry", String(attempt));
    return url.toString();
  }

  async function fetchSource(name) {
    let lastError = null;
    for (let attempt = 1; attempt <= 2; attempt += 1) {
      const controller = new AbortController();
      const timer = window.setTimeout(() => controller.abort(), attempt === 1 ? 20000 : 45000);
      try {
        const response = await fetch(assetUrl(assets[name], attempt), {
          credentials: "same-origin",
          cache: "force-cache",
          signal: controller.signal
        });
        if (!response.ok) throw new Error(`${assets[name]} вернул HTTP ${response.status}.`);
        const source = await response.text();
        if (!source.trim()) throw new Error(`${assets[name]} загрузился пустым.`);
        return source;
      } catch (error) {
        lastError = error;
        window.PhotoDashboardDiagnostics?.warn(
          "shell-asset-retry",
          `${assets[name]}: попытка ${attempt} не удалась`,
          error
        );
      } finally {
        window.clearTimeout(timer);
      }
    }
    throw lastError || new Error(`${assets[name]} не загрузился.`);
  }

  function execute(name, source) {
    const script = document.createElement("script");
    script.textContent = `${source}\n//# sourceURL=/${assets[name]}`;
    document.body.appendChild(script);
    script.remove();
  }

  Promise.all([fetchSource("config"), fetchSource("bootstrap")])
    .then(([config, bootstrap]) => {
      execute("config", config);
      execute("bootstrap", bootstrap);
    })
    .catch(error => {
      window.PhotoDashboardDiagnostics?.fail("corporate-shell", error);
      const message = document.getElementById("authBootError");
      if (message) {
        message.textContent = "Не удалось загрузить оболочку. Обновите страницу: " +
          String(error?.message || error);
        message.classList.remove("hidden");
      }
    });
})();
