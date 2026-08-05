(() => {
  "use strict";

  const BUILD = "2.0.7-rc5-fast-load-20260804";
  let bundledData = window.DASHBOARD_DATA;

  function isDashboardData(value) {
    return Boolean(value && Array.isArray(value.objects) && Array.isArray(value.visits));
  }

  function isLocalPreview() {
    return location.protocol === "file:" || ["127.0.0.1", "localhost"].includes(location.hostname);
  }

  function useBundledData(reason) {
    if (!isDashboardData(bundledData)) {
      throw new Error("Не найдена локальная резервная копия. Запустите PREVIEW_LOCAL.bat либо UPDATE_SOURCE_EXCEL.bat.");
    }
    window.DASHBOARD_DATA = {
      ...bundledData,
      meta: {
        ...(bundledData.meta || {}),
        sourceStatus: "local",
        sourceLabel: "Локальная резервная копия",
        liveSync: false,
        fallbackReason: reason || null
      }
    };
    return window.DASHBOARD_DATA;
  }

  window.captureBundledDashboardData = function captureBundledDashboardData() {
    if (!isDashboardData(window.DASHBOARD_DATA)) {
      throw new Error("Локальная резервная копия не содержит корректных данных.");
    }
    bundledData = window.DASHBOARD_DATA;
    return bundledData;
  };

  window.useBundledDashboardData = useBundledData;

  window.loadDashboardData = async function loadDashboardData({
    force = false,
    timeoutMs = 25000,
    allowFallback = true,
    mode = "data"
  } = {}) {
    if (isLocalPreview()) return useBundledData("Локальный предпросмотр не использует серверный API.");

    const endpoint = String(window.APP_CONFIG?.dashboardDataEndpoint || "/api/dashboard-data").trim();
    const url = new URL(endpoint, window.location.origin);
    if (force) url.searchParams.set("force", "1");
    if (mode && mode !== "data") url.searchParams.set("mode", mode);
    const controller = new AbortController();
    const timeout = window.setTimeout(() => controller.abort(), Math.max(1000, Number(timeoutMs) || 25000));

    try {
      const response = await fetch(url, {
        method: "GET",
        headers: { "Accept": "application/json" },
        cache: "no-store",
        credentials: "same-origin",
        signal: controller.signal
      });
      let payload = null;
      try {
        payload = await response.json();
      } catch (_) {
        payload = null;
      }
      if (!response.ok) {
        const error = new Error(payload?.details || payload?.error || `Сервер данных вернул HTTP ${response.status}.`);
        error.status = response.status;
        if (response.status === 401) window.dispatchEvent(new CustomEvent("dashboard:auth-expired"));
        throw error;
      }
      if (!isDashboardData(payload)) {
        throw new Error("Сервер вернул данные в неизвестном формате.");
      }
      window.DASHBOARD_DATA = payload;
      return payload;
    } catch (error) {
      const reason = error?.name === "AbortError"
        ? `Сервер данных не ответил за ${Math.round(timeoutMs / 1000)} секунд.`
        : error?.message;
      if (allowFallback && window.APP_CONFIG?.allowBundledDataFallback) {
        return useBundledData(reason || "Серверные данные недоступны.");
      }
      throw new Error(
        `${reason || "Не удалось получить Excel из Nextcloud"} ` +
        "Последняя рабочая версия на сервере пока недоступна."
      );
    } finally {
      window.clearTimeout(timeout);
    }
  };

  window.PHOTO_DASHBOARD_ASSETS ||= Object.create(null);
  window.PHOTO_DASHBOARD_ASSETS.excelLoader = BUILD;
})();
