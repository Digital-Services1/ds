(() => {
  "use strict";

  const BUILD = "2.0.7-rc5-fast-load-20260804";
  const diag = window.PhotoDashboardDiagnostics || {
    log: () => {},
    warn: () => {},
    fail: () => {}
  };

  diag.log("bootstrap-start", "App script started");

  const $ = id => document.getElementById(id);
  const gate = $("passwordGate");
  const form = $("passwordForm");
  const input = $("passwordInput");
  const passwordError = $("passwordError");
  const authBootError = $("authBootError");
  const visibilityButton = $("passwordVisibility");
  const app = $("app");
  const loading = $("mapLoading");
  const loadingTitle = $("mapLoadingTitle");
  const loadingMessage = $("mapLoadingMessage");
  const retryButton = $("retryMapLoading");

  let initializationPromise = null;
  let yandexApiPromise = null;
  let yandexMapsPromise = null;
  let retryMode = "dashboard";
  let authBootstrapped = false;
  let dashboardUnlocked = false;
  let sessionExpiryTimer = null;
  const assetPromises = new Map();
  let preloadStarted = false;
  let externalPreconnectStarted = false;

  function setElementHidden(element, hidden) {
    if (!element) return;
    element.classList.toggle("hidden", hidden);
    element.setAttribute("aria-hidden", String(hidden));
  }

  function setLoadingState(title, message, { errorState = false, retry = false } = {}) {
    if (!loading) return;
    loading.classList.remove("hidden");
    loading.classList.toggle("error", errorState);
    if (loadingTitle) loadingTitle.textContent = title;
    if (loadingMessage) loadingMessage.textContent = message;
    loading.querySelector(".loader-spinner")?.classList.toggle("hidden", errorState);
    retryButton?.classList.toggle("hidden", !retry);
    if (retryButton) {
      retryButton.disabled = false;
      retryButton.textContent = "Повторить загрузку";
    }
  }

  function showStageFailure(stage, error, mode = "dashboard") {
    retryMode = mode;
    const message = String(error?.message || error || "Неизвестная ошибка");
    diag.fail(stage, error);
    setLoadingState(
      stage === "load-yandex-maps" || stage === "create-map"
        ? "Карта временно недоступна"
        : "Не удалось запустить дашборд",
      `${message} Остальная страница не будет скрыта.`,
      { errorState: true, retry: true }
    );
  }

  function assertRequiredElements() {
    const missing = [
      ["passwordGate", gate],
      ["passwordForm", form],
      ["passwordInput", input],
      ["app", app],
      ["mapLoading", loading]
    ].filter(([, element]) => !element).map(([id]) => id);
    diag.log("root-check", `Root element check completed: ${missing.length ? "missing elements" : "ok"}`, { missing });
    if (missing.length) throw new Error(`В index.html отсутствуют элементы: ${missing.join(", ")}.`);
  }

  function showAuthBootError(message) {
    if (!authBootError) return;
    authBootError.textContent = message;
    authBootError.classList.remove("hidden");
  }

  function showAuthScreen() {
    diag.log("auth-render", "Auth screen rendering started");
    document.body.classList.remove("dashboard-active");
    document.body.classList.add("auth-active");
    setElementHidden(gate, false);
    app?.setAttribute("aria-hidden", "true");
    diag.log("auth-render", "Auth screen rendered");
  }

  function assetUrl(fileName, attempt = 1) {
    const url = new URL(fileName, window.location.href);
    url.searchParams.set("v", BUILD);
    if (attempt > 1) url.searchParams.set("retry", String(attempt));
    return url.toString();
  }

  async function fetchScriptSource(name, timeoutMs, attempt) {
    const fileName = fileNameFor(name);
    const controller = new AbortController();
    const timer = window.setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetch(assetUrl(fileName, attempt), {
        method: "GET",
        headers: { "Accept": "application/javascript, text/javascript, */*;q=0.1" },
        credentials: "same-origin",
        cache: "force-cache",
        signal: controller.signal
      });
      if (!response.ok) throw new Error(`${fileName} вернул HTTP ${response.status}.`);
      const source = await response.text();
      if (!source.trim()) throw new Error(`${fileName} загрузился пустым.`);
      return source;
    } catch (error) {
      if (error?.name === "AbortError") {
        throw new Error(`${fileName} не загрузился за ${Math.round(timeoutMs / 1000)} секунд.`);
      }
      throw error;
    } finally {
      window.clearTimeout(timer);
    }
  }

  function executeScriptSource(name, source) {
    const fileName = fileNameFor(name);
    const script = document.createElement("script");
    script.dataset.dashboardAsset = name;
    script.textContent = `${source}\n//# sourceURL=/${fileName}`;
    document.body.appendChild(script);
    script.remove();
  }

  function registerScript(name, timeoutMs = 20000) {
    if (window.PHOTO_DASHBOARD_ASSETS?.[name] === BUILD) return Promise.resolve();
    if (assetPromises.has(name)) return assetPromises.get(name);

    const promise = (async () => {
      const attempts = [timeoutMs, Math.max(45000, timeoutMs * 2)];
      let lastError = null;
      for (let index = 0; index < attempts.length; index += 1) {
        try {
          const source = await fetchScriptSource(name, attempts[index], index + 1);
          executeScriptSource(name, source);

          const version = window.PHOTO_DASHBOARD_ASSETS?.[name];
          if (name !== "data" && version !== BUILD) {
            throw new Error(
              `${fileNameFor(name)} имеет несовместимую версию (${version || "не определена"}).`
            );
          }
          if (name === "data") {
            const data = window.DASHBOARD_DATA;
            if (!data || !Array.isArray(data.objects) || !Array.isArray(data.visits)) {
              throw new Error("Локальная резервная копия загрузилась, но не содержит корректных данных.");
            }
            window.PHOTO_DASHBOARD_ASSETS.data = BUILD;
          }
          return;
        } catch (error) {
          lastError = error;
          diag.warn("asset-load-retry", `${fileNameFor(name)}: попытка ${index + 1} не удалась`, error);
        }
      }
      throw lastError || new Error(`${fileNameFor(name)} не загрузился.`);
    })().catch(error => {
      assetPromises.delete(name);
      throw error;
    });

    assetPromises.set(name, promise);
    return promise;
  }

  function fileNameFor(name) {
    return {
      data: "data.v207.js",
      period: "period-utils.v207.js",
      excelLoader: "excel-loader.v207.js",
      app: "app.v207.js",
      admin: "admin.v207.js"
    }[name] || name;
  }

  function preloadDashboardAssets() {
    if (preloadStarted) return;
    preloadStarted = true;
    for (const name of ["period", "excelLoader", "app"]) {
      const link = document.createElement("link");
      link.rel = "preload";
      link.as = "script";
      link.href = assetUrl(fileNameFor(name));
      link.dataset.dashboardPreload = name;
      document.head.appendChild(link);
    }
    diag.log("asset-preload", "Dashboard scripts preloading started");
  }

  function preconnectExternalOrigins() {
    if (externalPreconnectStarted) return;
    externalPreconnectStarted = true;
    for (const origin of ["https://api-maps.yandex.ru", "https://disk2.mosinzhproekt.ru"]) {
      const link = document.createElement("link");
      link.rel = "preconnect";
      link.href = origin;
      link.crossOrigin = "anonymous";
      document.head.appendChild(link);
    }
  }

  async function loadApplicationScriptsAndData() {
    const localPreview = location.protocol === "file:" || ["127.0.0.1", "localhost"].includes(location.hostname);
    const bundledFallbackEnabled = Boolean(window.APP_CONFIG?.allowBundledDataFallback);
    if (localPreview) {
      diag.log("load-bundled-data", "Bundled fallback data loading started");
      await registerScript("data", 30000);
      diag.log("load-bundled-data", "Bundled fallback data loading completed");
    } else {
      diag.log("load-bundled-data", "Bundled fallback data deferred until the server data request fails");
    }

    diag.log("load-excel-library", "Excel library loading started");
    diag.log(
      "load-excel-library",
      "Excel library loading completed: browser parsing is not required; server API returns validated JSON"
    );

    diag.log("load-data-loader", "Data loader script loading started");
    await Promise.all([
      registerScript("period", 20000),
      registerScript("excelLoader", 20000)
    ]);
    diag.log("load-data-loader", "Data loader script loading completed");

    if (typeof window.PhotoDashboardPeriod?.reportPeriodRangeAt !== "function") {
      throw new Error("period-utils.js загрузился, но расчёт периода недоступен.");
    }
    if (typeof window.loadDashboardData !== "function") {
      throw new Error("excel-loader.js загрузился, но функция loadDashboardData отсутствует.");
    }

    diag.log("load-data", "Data loading started");
    try {
      await window.loadDashboardData({ timeoutMs: 12000, allowFallback: false, mode: "cache" });
    } catch (error) {
      if (!bundledFallbackEnabled || localPreview) throw error;
      diag.warn(
        "load-data-cache",
        "Fast server cache is unavailable; protected bundled fallback loading started",
        error
      );
      await window.loadDashboardData({ timeoutMs: 30000, allowFallback: false, mode: "bundled" });
      diag.log("load-bundled-data", "Bundled fallback data loading completed");
    }
    diag.log("load-data", "Data loading completed", {
      objects: window.DASHBOARD_DATA?.objects?.length || 0,
      visits: window.DASHBOARD_DATA?.visits?.length || 0,
      sourceStatus: window.DASHBOARD_DATA?.meta?.sourceStatus || "unknown"
    });
  }

  function waitForDashboardReady(timeoutMs = 50000) {
    if (window.DASHBOARD_APP) return Promise.resolve();
    return new Promise((resolve, reject) => {
      const timer = window.setTimeout(() => {
        window.removeEventListener("dashboard:ready", ready);
        reject(new Error("app.js загрузился, но не завершил построение интерфейса."));
      }, timeoutMs);
      const ready = () => {
        window.clearTimeout(timer);
        resolve();
      };
      window.addEventListener("dashboard:ready", ready, { once: true });
    });
  }

  async function initializeDashboardUi() {
    diag.log("build-objects", "Object rendering started");
    const ready = waitForDashboardReady();
    await Promise.all([
      registerScript("app", 20000),
      ready
    ]);
    diag.log("build-objects", "Object rendering completed");

    diag.log("prepare-filters", "Filter preparation started");
    if (!window.DASHBOARD_APP?.filtersReady) {
      throw new Error("Фильтры не были подготовлены app.js.");
    }
    diag.log("prepare-filters", "Filter preparation completed");

    try {
      await registerScript("admin", 15000);
    } catch (error) {
      diag.warn("load-admin", "Administrator module is unavailable; viewer mode remains operational", error);
    }
  }

  function removeYandexScript() {
    document.getElementById("yandexMapsApiScript")?.remove();
  }

  function waitForYandexReady(timeoutMs = 12000) {
    return new Promise((resolve, reject) => {
      let settled = false;
      const timer = window.setTimeout(() => {
        if (settled) return;
        settled = true;
        reject(new Error("API Яндекс Карт загрузился, но не перешёл в состояние ready."));
      }, timeoutMs);
      try {
        window.ymaps.ready(() => {
          if (settled) return;
          settled = true;
          window.clearTimeout(timer);
          resolve();
        });
      } catch (error) {
        settled = true;
        window.clearTimeout(timer);
        reject(error);
      }
    });
  }

  function loadYandexApi({ force = false } = {}) {
    if (window.ymaps) return waitForYandexReady();
    if (yandexApiPromise && !force) return yandexApiPromise;
    if (force) {
      yandexApiPromise = null;
      removeYandexScript();
    }

    const key = String(window.RUNTIME_CONFIG?.yandexMapsApiKey || "").trim();
    if (!key) {
      return Promise.reject(new Error("На сервере не задана переменная YANDEX_MAPS_API_KEY."));
    }

    yandexApiPromise = (async () => {
      diag.log("load-yandex-maps", "Yandex Maps loading started");
      const modules = [
        "Map",
        "Placemark",
        "Polygon",
        "Polyline",
        "Clusterer",
        "templateLayoutFactory",
        "control.ZoomControl",
        "control.FullscreenControl"
      ].join(",");
      const attempts = [20000, 40000];
      let lastError = null;

      for (let attempt = 0; attempt < attempts.length && !window.ymaps; attempt += 1) {
        try {
          await new Promise((resolve, reject) => {
            const api = document.createElement("script");
            let settled = false;
            const timer = window.setTimeout(() => {
              if (settled) return;
              settled = true;
              api.remove();
              reject(new Error(`Яндекс Карты не ответили за ${Math.round(attempts[attempt] / 1000)} секунд.`));
            }, attempts[attempt]);

            api.id = "yandexMapsApiScript";
            api.src = `https://api-maps.yandex.ru/2.1/?apikey=${encodeURIComponent(key)}&lang=ru_RU&mode=release&load=${encodeURIComponent(modules)}&retry=${attempt + 1}`;
            api.async = true;
            api.onload = () => {
              if (settled) return;
              settled = true;
              window.clearTimeout(timer);
              if (!window.ymaps) reject(new Error("Скрипт Яндекс Карт загружен, но объект ymaps отсутствует."));
              else resolve();
            };
            api.onerror = () => {
              if (settled) return;
              settled = true;
              window.clearTimeout(timer);
              api.remove();
              reject(new Error("API Яндекс Карт заблокирован сетью, VPN, браузером или ограничениями ключа."));
            };
            document.head.appendChild(api);
          });
        } catch (error) {
          lastError = error;
          removeYandexScript();
          diag.warn("load-yandex-maps-retry", `Yandex Maps attempt ${attempt + 1} failed`, error);
        }
      }
      if (!window.ymaps) throw lastError || new Error("Яндекс Карты временно недоступны.");

      await waitForYandexReady();
      diag.log("load-yandex-maps", "Yandex Maps loading completed");
      return true;
    })().catch(error => {
      yandexApiPromise = null;
      throw error;
    });

    return yandexApiPromise;
  }

  async function loadYandexMaps({ force = false } = {}) {
    if (window.DASHBOARD_APP?.mapReady) {
      loading?.classList.add("hidden");
      return true;
    }
    if (yandexMapsPromise && !force) return yandexMapsPromise;
    if (force) {
      yandexMapsPromise = null;
      yandexApiPromise = null;
      removeYandexScript();
    }

    yandexMapsPromise = (async () => {
      setLoadingState(
        "Загружаем Яндекс Карты",
        "Карточки, показатели и фильтры уже доступны. Карта подключается отдельно."
      );
      await loadYandexApi({ force });
      diag.log("create-map", "Map creation started");
      await window.DASHBOARD_APP.initializeMap();
      diag.log("create-map", "Map creation completed");
      loading?.classList.add("hidden");
      return true;
    })().catch(error => {
      yandexMapsPromise = null;
      showStageFailure("load-yandex-maps", error, "map");
      return false;
    });

    return yandexMapsPromise;
  }

  async function initializeDashboard() {
    const stage = { value: "load-config" };
    try {
      setLoadingState("Подготавливаем дашборд", "Загружаем только необходимые локальные компоненты");

      diag.log("load-config", "Configuration validation started");
      if (!window.APP_CONFIG || window.PHOTO_DASHBOARD_ASSETS?.config !== BUILD) {
        throw new Error("Встроенная конфигурация отсутствует либо не соответствует текущей версии.");
      }
      diag.log("load-config", "Configuration validation completed");

      // The API key is available only after successful authentication. Start
      // downloading Yandex Maps immediately, while protected data and local
      // scripts are prepared in parallel.
      const yandexWarmup = loadYandexApi().catch(error => {
        diag.warn("load-yandex-maps-warmup", "Yandex Maps warmup failed; normal retry remains available", error);
        return false;
      });

      stage.value = "load-data";
      await loadApplicationScriptsAndData();

      stage.value = "initialize-ui";
      await initializeDashboardUi();

      stage.value = "load-yandex-maps";
      await yandexWarmup;
      const connection = navigator.connection || navigator.mozConnection || navigator.webkitConnection;
      const slowConnection = Boolean(connection?.saveData) || /(^|-)2g$/.test(String(connection?.effectiveType || ""));
      await new Promise(resolve => window.requestAnimationFrame(() => {
        window.setTimeout(resolve, slowConnection ? 1500 : 150);
      }));
      const mapReady = await loadYandexMaps();

      diag.log("initialization-complete", "Initialization completed", {
        mapReady,
        sourceStatus: window.DASHBOARD_DATA?.meta?.sourceStatus || "unknown"
      });
      return { mapReady };
    } catch (error) {
      initializationPromise = null;
      showStageFailure(stage.value, error, "dashboard");
      throw error;
    }
  }

  function startDashboardInitialization() {
    if (!initializationPromise) {
      diag.log("initialization-start", "Main initialization started");
      initializationPromise = initializeDashboard().catch(error => {
        initializationPromise = null;
        throw error;
      });
    } else {
      diag.log("initialization-start", "Main initialization already running; duplicate start ignored");
    }
    return initializationPromise;
  }

  function isLocalPreview() {
    return location.protocol === "file:" || ["127.0.0.1", "localhost"].includes(location.hostname);
  }

  function applyRuntimeConfig(payload) {
    const serverNowMs = Date.parse(payload?.serverNow || "");
    const clockOffsetMs = Number.isFinite(serverNowMs) ? serverNowMs - Date.now() : 0;
    const expiresIn = Math.max(0, Number(payload?.expiresIn || 0));
    const expiresAtMs = expiresIn ? Date.now() + expiresIn * 1000 : 0;
    window.RUNTIME_CONFIG = Object.freeze({
      yandexMapsApiKey: String(payload?.yandexMapsApiKey || "").trim(),
      clockOffsetMs,
      expiresAtMs
    });
    window.PhotoDashboardNow = () => new Date(Date.now() + clockOffsetMs);
    const sessionText = $("sessionText");
    if (sessionText && expiresAtMs) {
      sessionText.textContent = `Сессия до ${new Intl.DateTimeFormat("ru-RU", {
        hour: "2-digit", minute: "2-digit"
      }).format(new Date(expiresAtMs))}`;
    }
    window.clearTimeout(sessionExpiryTimer);
    if (expiresAtMs) {
      sessionExpiryTimer = window.setTimeout(
        () => requireLogin("Сессия истекла. Введите пароль повторно."),
        Math.max(1000, expiresAtMs - Date.now() + 1000)
      );
    }
  }

  async function requestAccessSession({ password, action } = {}) {
    const endpoint = String(window.APP_CONFIG?.accessSessionEndpoint || "/api/access-session");
    const timeouts = [10000, 25000];
    let lastError = null;

    for (let attempt = 0; attempt < timeouts.length; attempt += 1) {
      const controller = new AbortController();
      const timer = window.setTimeout(() => controller.abort(), timeouts[attempt]);
      try {
        const url = new URL(endpoint, window.location.origin);
        if (attempt) url.searchParams.set("retry", String(attempt + 1));
        const isPost = password !== undefined || action;
        const response = await fetch(url, {
          method: isPost ? "POST" : "GET",
          headers: {
            "Accept": "application/json",
            ...(isPost ? { "Content-Type": "application/json" } : {})
          },
          credentials: "same-origin",
          cache: "no-store",
          signal: controller.signal,
          body: isPost ? JSON.stringify({ action: action || "login", ...(password === undefined ? {} : { password }) }) : undefined
        });
        let payload = null;
        try {
          payload = await response.json();
        } catch (_) {
          payload = null;
        }
        if (!response.ok) {
          const error = new Error(payload?.error || `Сервер авторизации вернул HTTP ${response.status}.`);
          error.status = response.status;
          throw error;
        }
        return payload || {};
      } catch (error) {
        if (error?.status === 401 || error?.status === 503) throw error;
        lastError = error?.name === "AbortError"
          ? new Error(`Сервер входа не ответил за ${Math.round(timeouts[attempt] / 1000)} секунд.`)
          : error;
        diag.warn("auth-retry", `Authorization request attempt ${attempt + 1} failed`, lastError);
      } finally {
        window.clearTimeout(timer);
      }
    }
    throw lastError || new Error("Сервер входа временно недоступен.");
  }

  function requireLogin(message = "Сессия завершена. Введите пароль повторно.") {
    dashboardUnlocked = false;
    window.clearTimeout(sessionExpiryTimer);
    document.body.classList.remove("dashboard-active");
    showAuthScreen();
    if (passwordError) {
      passwordError.textContent = message;
      passwordError.classList.remove("hidden");
    }
    $("sessionText") && ($("sessionText").textContent = "");
    window.setTimeout(() => input?.focus(), 50);
  }

  async function logoutDashboard() {
    const button = $("logoutButton");
    if (button) button.disabled = true;
    try {
      await requestAccessSession({ action: "logout" });
    } catch (error) {
      diag.warn("logout", "Server logout failed; local session will still be closed", error);
    } finally {
      if (button) button.disabled = false;
      requireLogin("Вы вышли из дашборда.");
    }
  }

  function unlockDashboard() {
    if (dashboardUnlocked) return;
    dashboardUnlocked = true;
    document.body.classList.remove("auth-pending", "auth-active");
    document.body.classList.add("dashboard-active");
    setElementHidden(gate, true);
    app?.setAttribute("aria-hidden", "false");
    diag.log("auth-state", "Authorization completed; dashboard shell revealed");
    preconnectExternalOrigins();
    window.dispatchEvent(new CustomEvent("dashboard:authenticated"));
    startDashboardInitialization().catch(() => {});
  }

  async function submitPassword(event) {
    event.preventDefault();
    passwordError?.classList.add("hidden");
    const submit = form?.querySelector('[type="submit"]');
    if (submit) {
      submit.disabled = true;
      submit.textContent = "Проверяем…";
    }
    try {
      const payload = await requestAccessSession({ password: input?.value || "" });
      if (!payload.authenticated) throw new Error("Сервер не подтвердил вход.");
      applyRuntimeConfig(payload);
      if (input) input.value = "";
      unlockDashboard();
    } catch (error) {
      diag.fail("auth-check", error);
      if (passwordError) {
        passwordError.textContent = error?.status === 401
          ? "Неверный пароль"
          : (error?.message || "Не удалось проверить пароль.");
        passwordError.classList.remove("hidden");
      }
      input?.select();
    } finally {
      if (submit) {
        submit.disabled = false;
        submit.textContent = "Открыть дашборд";
      }
    }
  }

  function togglePasswordVisibility() {
    if (!input || !visibilityButton) return;
    const visible = input.type === "password";
    input.type = visible ? "text" : "password";
    visibilityButton.textContent = visible ? "Скрыть" : "Показать";
    visibilityButton.setAttribute("aria-pressed", String(visible));
    input.focus();
  }

  function cleanupLegacyRuntime() {
    if ("serviceWorker" in navigator) {
      navigator.serviceWorker.getRegistrations()
        .then(registrations => Promise.all(registrations.map(registration => registration.unregister())))
        .then(results => {
          if (results.some(Boolean)) {
            diag.warn("cache-cleanup", "Legacy Service Worker unregistered; next navigation will bypass it");
          } else {
            diag.log("cache-cleanup", "No active Service Worker found");
          }
        })
        .catch(error => diag.warn("cache-cleanup", "Service Worker check failed", error));
    }
    if ("caches" in window) {
      caches.keys()
        .then(keys => keys.filter(key => /photo.?dashboard|photo360/i.test(key)))
        .then(keys => Promise.all(keys.map(key => caches.delete(key))))
        .catch(error => diag.warn("cache-cleanup", "Legacy cache cleanup failed", error));
    }
  }

  async function bootstrapAuth() {
    if (authBootstrapped) return;
    authBootstrapped = true;
    try {
      assertRequiredElements();
      showAuthScreen();
      cleanupLegacyRuntime();

      const submit = form?.querySelector('[type="submit"]');
      if (submit) {
        submit.disabled = false;
        submit.textContent = "Открыть дашборд";
      }

      if (window.PHOTO_DASHBOARD_STYLE_FAILED) {
        showAuthBootError("Основные стили не загрузились. Экран входа работает в резервном режиме.");
      }

      if (!window.APP_CONFIG || window.PHOTO_DASHBOARD_ASSETS?.config !== BUILD) {
        showAuthBootError(
          "Не удалось прочитать встроенную конфигурацию или браузер использует старую страницу. " +
          "Обновите страницу без кэша."
        );
        diag.fail("load-config", new Error("Configuration is missing or version-mismatched."));
        return;
      }

      form?.addEventListener("submit", submitPassword);
      visibilityButton?.addEventListener("click", togglePasswordVisibility);
      $("logoutButton")?.addEventListener("click", logoutDashboard);
      input?.addEventListener("focus", preloadDashboardAssets, { once: true });
      window.setTimeout(preloadDashboardAssets, 600);

      if (isLocalPreview()) {
        applyRuntimeConfig({});
        diag.log("auth-state", "Local preview bypassed server authorization");
        unlockDashboard();
        return;
      }

      const session = await requestAccessSession();
      if (dashboardUnlocked) return;
      diag.log("auth-state", "Server authorization state checked", {
        configured: Boolean(session.configured),
        sessionAuthorized: Boolean(session.authenticated)
      });
      if (session.authenticated) {
        applyRuntimeConfig(session);
        unlockDashboard();
        return;
      }
      window.setTimeout(() => input?.focus(), 50);
    } catch (error) {
      diag.fail("auth-bootstrap", error);
      showAuthScreen();
      if (error?.status === 401) {
        window.setTimeout(() => input?.focus(), 50);
      } else {
        showAuthBootError(`Ошибка запуска экрана входа: ${error?.message || "неизвестная ошибка"}`);
      }
    }
  }

  retryButton?.addEventListener("click", async () => {
    retryButton.disabled = true;
    retryButton.textContent = "Повторяем…";
    if (retryMode === "map") {
      if (window.ymaps && !window.DASHBOARD_APP?.mapReady) {
        window.location.reload();
        return;
      }
      await loadYandexMaps({ force: true });
      return;
    }
    initializationPromise = null;
    startDashboardInitialization().catch(() => {});
  });

  window.addEventListener("online", () => {
    diag.log("network-online", "Network connection restored");
    if (!dashboardUnlocked) {
      authBootstrapped = false;
      bootstrapAuth().catch(error => diag.fail("auth-bootstrap", error));
      return;
    }
    if (!window.DASHBOARD_APP?.mapReady) loadYandexMaps({ force: true }).catch(() => {});
  });

  window.addEventListener("dashboard:auth-expired", () => {
    requireLogin("Сессия истекла. Введите пароль повторно.");
  });

  window.addEventListener("load", () => {
    diag.log("window-load", "Window load event received");
  }, { once: true });

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", () => {
      diag.log("dom-content-loaded", "DOMContentLoaded received");
      bootstrapAuth().catch(error => diag.fail("auth-bootstrap", error));
    }, { once: true });
  } else {
    diag.log("dom-content-loaded", "DOMContentLoaded already completed");
    bootstrapAuth().catch(error => diag.fail("auth-bootstrap", error));
  }

  window.PHOTO_DASHBOARD_ASSETS.bootstrap = BUILD;
})();
