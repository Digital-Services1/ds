(() => {
  "use strict";
  const build = "2.0.7-rc5-fast-load-20260804";
  window.PhotoDashboardDiagnostics?.log("load-config", "Configuration loading started");

  window.APP_CONFIG = {
  mapProvider: "yandex",
  staticDemo: false,
  accessSessionEndpoint: "/api/access-session",
  dashboardDataEndpoint: "/api/dashboard-data",
  photoEndpoint: "/api/photo",
  allowBundledDataFallback: true,

  // Публичная папка Nextcloud с файлами OBJ_001.jpg–OBJ_019.jpg.
  nextcloudPublicFolderUrl: "https://disk2.mosinzhproekt.ru/index.php/s/gRLKm39AAWy59Sy",
  nextcloudPhotoVersion: "20260729-v1183"
  };

  window.PHOTO_DASHBOARD_ASSETS ||= Object.create(null);
  window.PHOTO_DASHBOARD_ASSETS.config = build;
  window.PhotoDashboardDiagnostics?.log("load-config", "Configuration loading completed");
})();
