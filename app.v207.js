
(() => {
  "use strict";

  const BUILD = "2.0.7-rc5-fast-load-20260804";
  const diag = window.PhotoDashboardDiagnostics || {
    log: () => {},
    warn: () => {},
    fail: () => {}
  };
  diag.log("app-script", "Main dashboard script started");

  const data = window.DASHBOARD_DATA;
  if (!data || !Array.isArray(data.objects) || !Array.isArray(data.visits)) {
    throw new Error("DASHBOARD_DATA отсутствует или имеет некорректный формат.");
  }
  if (!document.getElementById("app")) {
    throw new Error("Корневой элемент #app отсутствует.");
  }
  const objects = data.objects.filter(o => o.active && Number.isFinite(o.lat) && Number.isFinite(o.lon));
  const visits = data.visits.slice().sort((a, b) => a.date.localeCompare(b.date));
  visits.forEach(visit => {
    visit._baseStatus = visit.status || "Запланирован";
    visit._statusOverridden = false;
  });
  const objectByName = new Map(objects.map(o => [o.name, o]));
  const objectById = new Map(objects.map(o => [o.id, o]));
  const markers = new Map();
  const visitsByObject = new Map(objects.map(o => [o.name, []]));

  visits.forEach(visit => {
    visit.objects.forEach(name => {
      if (!visitsByObject.has(name)) visitsByObject.set(name, []);
      visitsByObject.get(name).push(visit);
    });
  });

  function groupColor(group) {
    const value = String(group || "");
    if (value.startsWith("Рублёво-Архангельская линия метрополитена")) return "#8655c7";
    if (value.startsWith("Бирюлёвская линия метрополитена")) return "#d5418c";
    if (value === "Другие объекты") return "#2d70b3";
    return "#60758e";
  }

  const defaultWorkType = "Фотопанорамная съёмка";
  const workTypeConfig = {
    "Фотопанорамная съёмка": {
      key: "panorama",
      label: "Фотопанорамная съёмка"
    },
    "Лазерное сканирование": {
      key: "laser",
      label: "Лазерное сканирование"
    }
  };

  function normalizedWorkType(value) {
    return workTypeConfig[value] ? value : defaultWorkType;
  }

  const $ = id => document.getElementById(id);
  const coarsePointer = window.matchMedia("(pointer: coarse)").matches;
  let currentDetailObjectId = null;

  function dashboardNow() {
    return typeof window.PhotoDashboardNow === "function" ? window.PhotoDashboardNow() : new Date();
  }

  function moscowParts(date = dashboardNow()) {
    const formatter = new Intl.DateTimeFormat("en-CA", {
      timeZone: "Europe/Moscow",
      year: "numeric",
      month: "2-digit",
      day: "2-digit"
    });
    return formatter.format(date);
  }

  function addDays(iso, days) {
    const dt = new Date(`${iso}T12:00:00+03:00`);
    dt.setUTCDate(dt.getUTCDate() + days);
    return new Intl.DateTimeFormat("en-CA", {
      timeZone: "Europe/Moscow", year: "numeric", month: "2-digit", day: "2-digit"
    }).format(dt);
  }

  function formatDate(iso, options = {}) {
    if (!iso) return "—";
    const date = new Date(`${iso}T12:00:00+03:00`);
    return new Intl.DateTimeFormat("ru-RU", {
      timeZone: "Europe/Moscow",
      day: "2-digit",
      month: options.longMonth ? "long" : "2-digit",
      year: options.noYear ? undefined : "numeric",
      weekday: options.weekday ? "long" : undefined
    }).format(date);
  }

  function formatDateTime(iso) {
    const date = new Date(iso);
    if (!iso || Number.isNaN(date.getTime())) return "—";
    return new Intl.DateTimeFormat("ru-RU", {
      timeZone: "Europe/Moscow",
      day: "2-digit", month: "long", year: "numeric",
      hour: "2-digit", minute: "2-digit"
    }).format(date) + " МСК";
  }

  function renderSyncStatus() {
    const target = $("syncText");
    if (!target) return;
    const meta = data.meta || {};
    const status = meta.sourceStatus || "local";
    const syncedAt = meta.lastSuccessfulSyncAt || meta.sourceUpdatedAt;
    target.classList.toggle("is-warning", status !== "ok");

    if (status === "ok") {
      target.textContent = `· Excel синхронизирован: ${formatDateTime(syncedAt)}`;
    } else if (status === "fallback") {
      target.textContent = `· Excel недоступен — данные от ${formatDateTime(syncedAt)}`;
    } else {
      target.textContent = "· Локальная резервная копия";
    }
    target.title = [
      `Источник: ${meta.sourceLabel || meta.sourceFile || "не указан"}`,
      meta.fallbackReason ? `Причина: ${meta.fallbackReason}` : ""
    ].filter(Boolean).join("\n");
  }

  function isActiveVisit(visit) {
    return !["Отменён", "Перенесён", "Завершено"].includes(visit.status);
  }

  function objectVisits(object) {
    return (visitsByObject.get(object.name) || []).slice().sort((a, b) => a.date.localeCompare(b.date));
  }

  function derivedVisitStatus(visit, today = moscowParts()) {
    if (visit.status === "Отменён") return "Отменён";
    if (visit.status === "Перенесён") return "Перенесён";
    if (visit.status === "Выполнен") return "Выполнен";
    if (visit.status === "Завершено") return "Завершено";
    if (visit.date < today && visit.status === "Запланирован") return "Требует подтверждения";
    if (visit.date === today) return "Сегодня";
    return visit.status || "Запланирован";
  }

  function objectSummary(object) {
    const today = moscowParts();
    const list = objectVisits(object);
    const completed = list.filter(v => v.status === "Выполнен");
    const finishedVisits = list.filter(v => v.status === "Завершено");
    const isFinished = finishedVisits.length > 0;
    const finalVisit = finishedVisits.at(-1) || null;
    const future = isFinished ? [] : list.filter(v => isActiveVisit(v) && v.status !== "Выполнен" && v.date >= today);
    const unconfirmed = list.filter(v => v.status === "Запланирован" && v.date < today);
    const todayVisit = isFinished ? null : list.find(v => isActiveVisit(v) && v.date === today);

    let displayStatus = "Следующая съёмка не запланирована";
    let statusClass = "warning";
    let statusIcon = "!";
    if (isFinished) {
      displayStatus = "Завершено";
      statusClass = "finished";
      statusIcon = "";
    } else if (todayVisit) {
      displayStatus = "Съёмка сегодня";
      statusClass = "today";
      statusIcon = "●";
    } else if (unconfirmed.length) {
      displayStatus = "Требует подтверждения";
      statusClass = "warning";
      statusIcon = "!";
    } else if (future.length) {
      displayStatus = "Запланирован";
      statusClass = "planned";
      statusIcon = "◷";
    } else if (completed.length) {
      displayStatus = "Следующая съёмка не запланирована";
      statusClass = "warning";
      statusIcon = "!";
    }

    const intervals = [];
    for (let i = 1; i < completed.length; i++) {
      const a = new Date(`${completed[i - 1].date}T12:00:00+03:00`);
      const b = new Date(`${completed[i].date}T12:00:00+03:00`);
      intervals.push(Math.round((b - a) / 86400000));
    }
    const avgInterval = intervals.length
      ? Math.round(intervals.reduce((a, b) => a + b, 0) / intervals.length)
      : null;

    return {
      list,
      completed,
      finishedVisits,
      isFinished,
      finalVisit,
      future,
      lastCompleted: completed.at(-1) || null,
      nextVisit: future[0] || null,
      firstCompleted: completed[0] || null,
      avgInterval,
      displayStatus,
      statusClass,
      statusIcon,
      markerVisit: finalVisit || todayVisit || future[0] || completed.at(-1) || list[0] || null,
      markerWorkType: normalizedWorkType(
        (finalVisit || todayVisit || future[0] || completed.at(-1) || list[0])?.workType
      )
    };
  }

  function hasDashboardPhoto(object) {
    return Boolean(object?.id && /^OBJ_\d{3}$/i.test(object.id));
  }

  function photoUrl() {
    return "placeholder.svg";
  }

  const NEXTCLOUD_PUBLIC_FOLDER_URL = String(
    window.APP_CONFIG?.nextcloudPublicFolderUrl || ""
  ).trim().replace(/\/$/, "");
  const NEXTCLOUD_PHOTO_VERSION = String(
    window.APP_CONFIG?.nextcloudPhotoVersion || "v118"
  );
  const PHOTO_ENDPOINT = String(window.APP_CONFIG?.photoEndpoint || "/api/photo").trim();
  const loadedPhotoUrls = new Map();
  const photoPrefetches = new Map();

  function parseNextcloudPublicFolder() {
    if (!NEXTCLOUD_PUBLIC_FOLDER_URL) {
      return { origin: "", token: "", frontControllerPath: "" };
    }
    try {
      const url = new URL(NEXTCLOUD_PUBLIC_FOLDER_URL);
      const match = url.pathname.match(/^(.*?)(?:\/index\.php)?\/s\/([^/?#]+)/i);
      if (!match) return { origin: "", token: "", frontControllerPath: "" };
      const prefix = match[1] || "";
      const usesIndexPhp = /\/index\.php\/s\//i.test(url.pathname);
      return {
        origin: url.origin,
        token: decodeURIComponent(match[2]),
        frontControllerPath: `${prefix}${usesIndexPhp ? "/index.php" : ""}`
      };
    } catch (_error) {
      return { origin: "", token: "", frontControllerPath: "" };
    }
  }

  const NEXTCLOUD_PUBLIC = parseNextcloudPublicFolder();

  function nextcloudFileName(objectId) {
    return `${String(objectId || "").toUpperCase()}.jpg`;
  }

  function nextcloudPreviewUrl(objectId) {
    const fileName = nextcloudFileName(objectId);
    if (!NEXTCLOUD_PUBLIC.origin || !NEXTCLOUD_PUBLIC.token) return "";
    const params = new URLSearchParams({
      file: `/${fileName}`,
      x: "960",
      y: "540",
      a: "true",
      scalingup: "0",
      v: NEXTCLOUD_PHOTO_VERSION
    });
    return `${NEXTCLOUD_PUBLIC.origin}${NEXTCLOUD_PUBLIC.frontControllerPath}/apps/files_sharing/publicpreview/${encodeURIComponent(NEXTCLOUD_PUBLIC.token)}?${params.toString()}`;
  }

  function nextcloudDownloadUrl(objectId) {
    const fileName = nextcloudFileName(objectId);
    if (!NEXTCLOUD_PUBLIC_FOLDER_URL) return "";
    const params = new URLSearchParams({
      path: "/",
      files: fileName,
      v: NEXTCLOUD_PHOTO_VERSION
    });
    return `${NEXTCLOUD_PUBLIC_FOLDER_URL}/download?${params.toString()}`;
  }

  function dashboardPhotoUrl(objectId) {
    if (!PHOTO_ENDPOINT || location.protocol === "file:" || ["127.0.0.1", "localhost"].includes(location.hostname)) {
      return "";
    }
    const url = new URL(PHOTO_ENDPOINT, window.location.origin);
    url.searchParams.set("id", String(objectId || "").toUpperCase());
    url.searchParams.set("v", NEXTCLOUD_PHOTO_VERSION);
    return url.toString();
  }

  function prefetchDashboardPhoto(objectId) {
    if (!objectId || loadedPhotoUrls.has(objectId) || photoPrefetches.has(objectId)) return;
    const src = dashboardPhotoUrl(objectId);
    if (!src) return;
    const image = new Image();
    image.decoding = "async";
    image.fetchPriority = "low";
    image.referrerPolicy = "no-referrer";
    const done = () => {
      image.onload = null;
      image.onerror = null;
      photoPrefetches.delete(objectId);
    };
    image.onload = () => {
      if (image.naturalWidth >= 120 && image.naturalHeight >= 80) loadedPhotoUrls.set(objectId, src);
      done();
    };
    image.onerror = done;
    photoPrefetches.set(objectId, image);
    image.src = src;
  }

  function photoWarningFor(image) {
    return image?.closest(".detail-hero")?.querySelector("[data-photo-warning]") || null;
  }

  function setPhotoWarning(image, text) {
    const warning = photoWarningFor(image);
    if (!warning) return;
    warning.textContent = text || "";
    warning.hidden = !text;
    warning.classList.toggle("is-loading", image?.dataset.photoState === "loading");
    warning.classList.toggle("is-error", image?.dataset.photoState === "error");
  }

  async function setImageSource(image, src, timeoutMs = 12000) {
    if (!src) throw new Error("Пустой адрес фотографии");
    await new Promise((resolve, reject) => {
      let settled = false;
      const cleanup = () => {
        image.onload = null;
        image.onerror = null;
      };
      const timeout = window.setTimeout(() => {
        if (settled) return;
        settled = true;
        cleanup();
        image.removeAttribute("src");
        reject(new Error("Тайм-аут загрузки фотографии"));
      }, timeoutMs);

      image.onload = () => {
        if (settled) return;
        if (image.naturalWidth < 120 || image.naturalHeight < 80) {
          settled = true;
          window.clearTimeout(timeout);
          cleanup();
          reject(new Error("Nextcloud вернул не фотографию, а миниатюрную заглушку"));
          return;
        }
        settled = true;
        window.clearTimeout(timeout);
        cleanup();
        resolve();
      };
      image.onerror = () => {
        if (settled) return;
        settled = true;
        window.clearTimeout(timeout);
        cleanup();
        reject(new Error("Nextcloud не вернул изображение"));
      };
      image.referrerPolicy = "no-referrer";
      image.decoding = "async";
      image.src = src;
    });
  }

  async function loadDashboardPhoto(image, objectId) {
    if (!image || !objectId) return;

    image.dataset.photoState = "loading";
    image.classList.add("photo-loading");
    setPhotoWarning(image, "Загрузка фото…");

    try {
      if (!NEXTCLOUD_PUBLIC_FOLDER_URL) {
        throw new Error("В конфигурации не указана nextcloudPublicFolderUrl");
      }
      if (!NEXTCLOUD_PUBLIC.origin || !NEXTCLOUD_PUBLIC.token) {
        throw new Error("Некорректная публичная ссылка Nextcloud");
      }

      const cachedUrl = loadedPhotoUrls.get(objectId);
      const candidates = cachedUrl
        ? [{ label: "кэш", url: cachedUrl, timeout: 5000 }]
        : [
            { label: "серверный кэш", url: dashboardPhotoUrl(objectId), timeout: 11000 },
            { label: "превью", url: nextcloudPreviewUrl(objectId), timeout: 7000 },
            { label: "исходный файл", url: nextcloudDownloadUrl(objectId), timeout: 12000 }
          ];

      let lastError = null;
      let loadedUrl = "";
      for (const candidate of candidates) {
        if (!candidate.url) continue;
        if (!image.isConnected || image.dataset.photoId !== objectId) return;
        setPhotoWarning(image, "Загрузка фото…");
        try {
          await setImageSource(image, candidate.url, candidate.timeout);
          loadedUrl = candidate.url;
          break;
        } catch (error) {
          lastError = error;
        }
      }

      if (!loadedUrl) throw lastError || new Error("Фотография не загрузилась");
      if (!image.isConnected || image.dataset.photoId !== objectId) return;

      loadedPhotoUrls.set(objectId, loadedUrl);
      image.dataset.photoState = "loaded";
      image.classList.remove("photo-loading");
      setPhotoWarning(image, "");
    } catch (error) {
      if (!image.isConnected || image.dataset.photoId !== objectId) return;
      image.dataset.photoState = "error";
      image.classList.remove("photo-loading");
      image.src = "placeholder.svg";
      setPhotoWarning(image, "Фотография недоступна");
      console.warn("Nextcloud photo error", objectId, error);
    }
  }

  window.PHOTO360_NEXTCLOUD = Object.freeze({
    publicFolderUrl: NEXTCLOUD_PUBLIC_FOLDER_URL,
    origin: NEXTCLOUD_PUBLIC.origin,
    token: NEXTCLOUD_PUBLIC.token,
    previewUrl: nextcloudPreviewUrl,
    downloadUrl: nextcloudDownloadUrl,
    cachedUrl: dashboardPhotoUrl,
    prefetch: prefetchDashboardPhoto
  });

  function escapeHtml(value) {
    return String(value ?? "")
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;")
      .replaceAll('"', "&quot;")
      .replaceAll("'", "&#039;");
  }

  function briefHtml(object) {
    const summary = objectSummary(object);
    const last = summary.lastCompleted ? formatDate(summary.lastCompleted.date) : "Выездов ещё не было";
    const next = summary.isFinished ? "Завершено" : (summary.nextVisit ? formatDate(summary.nextVisit.date) : "Не запланирован");
    const action = `<button class="album-button" type="button" data-open-object="${escapeHtml(object.id)}">Подробнее</button>`;
    return `
      <div class="brief-card">
        <h3>${escapeHtml(object.name)}</h3>
        <p>${escapeHtml(object.group)}</p>
        <p><b>Вид работ:</b> ${escapeHtml(summary.markerWorkType)}</p>
        <p><b>Последний выезд:</b> ${last}</p>
        <p><b>Следующий выезд:</b> ${next}</p>
        ${action}
      </div>`;
  }

  function cameraMarkerSvg(extraClass = "") {
    return `
      <svg class="ym-marker-work-icon ${extraClass}" viewBox="0 0 30 30" aria-hidden="true">
        <rect x="9" y="4" width="12" height="22" rx="6" fill="#fff"/>
        <circle cx="15" cy="10" r="3.8" fill="#17233a"/>
        <circle cx="15" cy="10" r="1.8" fill="#78c7ff"/>
        <circle cx="15" cy="19" r="1.4" fill="#c92743"/>
      </svg>`;
  }

  function laserScannerMarkerSvg(extraClass = "") {
    return `
      <svg class="ym-marker-work-icon ${extraClass}" viewBox="0 0 30 30" aria-hidden="true">
        <path d="M8 25h14M12 25l3-8 3 8" fill="none" stroke="#fff" stroke-width="2.2" stroke-linecap="round"/>
        <rect x="8" y="5" width="14" height="12" rx="3" fill="#fff"/>
        <circle cx="15" cy="11" r="3.4" fill="#17233a"/>
        <circle cx="15" cy="11" r="1.5" fill="#8de0ff"/>
        <path d="M21 8l5-2M21 11h6M21 14l5 2" fill="none" stroke="#fff" stroke-width="1.4" stroke-linecap="round"/>
      </svg>`;
  }

  function createWorkMarkerLayout(iconHtml, hovered = false) {
    return ymaps.templateLayoutFactory.createClass(`
      <div class="ym-object-marker $[properties.objectStateClass]${hovered ? " is-hovered" : ""}" data-object-id="$[properties.objectId]">
        <div class="ym-marker-pin" style="background:$[properties.markerColor]">
          ${iconHtml}
          <span class="ym-marker-status $[properties.statusClass]">$[properties.statusIcon]</span>
        </div>
        ${hovered ? "" : '<div class="ym-marker-label">$[properties.objectName]</div>'}
      </div>
    `);
  }

  let markerLayouts = null;

  function layoutForWorkType(workType, hovered = false) {
    if (!markerLayouts) return null;
    const key = workTypeConfig[normalizedWorkType(workType)].key;
    return markerLayouts[key][hovered ? "hover" : "normal"];
  }

  function workTypeIconHtml(workType, small = false) {
    const config = workTypeConfig[normalizedWorkType(workType)];
    const icon = config.key === "laser"
      ? laserScannerMarkerSvg(small ? "is-small" : "")
      : cameraMarkerSvg(small ? "is-small" : "");
    return `<span class="work-type-icon work-type-${config.key}">${icon}</span>`;
  }

  function setPlacemarkWorkType(placemark, workType) {
    if (!placemark || !markerLayouts) return;
    const normalized = normalizedWorkType(workType);
    placemark.properties.set("workType", normalized);
    placemark.options.set(
      "iconLayout",
      layoutForWorkType(normalized, placemark === activeHoverPlacemark)
    );
  }

  let map = null;
  let clusterer = null;
  let mapReady = false;
  let mapInitializationPromise = null;

  const hoverCard = $("mapHoverCard");
  let activeHoverPlacemark = null;
  let hoverCloseTimer = null;

  function clearHoverTimer() {
    if (hoverCloseTimer) {
      clearTimeout(hoverCloseTimer);
      hoverCloseTimer = null;
    }
  }

  function hideHoverCard() {
    clearHoverTimer();
    hoverCard.classList.add("hidden");
    if (activeHoverPlacemark) {
      activeHoverPlacemark.options.set(
        "iconLayout",
        layoutForWorkType(activeHoverPlacemark.properties.get("workType"), false)
      );
      activeHoverPlacemark = null;
    }
  }

  function scheduleHideHoverCard() {
    clearHoverTimer();
    hoverCloseTimer = window.setTimeout(hideHoverCard, 180);
  }

  function markerViewportCenter(placemark) {
    try {
      const objectId = String(placemark.properties.get("objectId") || "");
      if (objectId) {
        const markers = document.querySelectorAll(".ym-object-marker[data-object-id]");
        for (const marker of markers) {
          if (marker.getAttribute("data-object-id") !== objectId) continue;
          const pin = marker.querySelector(".ym-marker-pin") || marker;
          const rect = pin.getBoundingClientRect();
          if (rect.width > 0 && rect.height > 0) {
            return [rect.left + rect.width / 2, rect.top + rect.height / 2];
          }
        }
      }

      // Geometric fallback for the brief moment while Yandex replaces a layout.
      const coordinates = placemark.geometry.getCoordinates();
      const projection = map.options.get("projection");
      const globalPixels = projection.toGlobalPixels(coordinates, map.getZoom());
      const mapPixels = map.converter.globalToPage(globalPixels);
      const mapRect = map.container.getElement().getBoundingClientRect();
      return [mapRect.left + mapPixels[0], mapRect.top + mapPixels[1]];
    } catch (_) {
      return null;
    }
  }

  function positionHoverCard(viewportPixels) {
    if (!viewportPixels) return;
    const main = document.querySelector("main");
    const mainRect = main.getBoundingClientRect();
    const cardRect = hoverCard.getBoundingClientRect();
    const localX = viewportPixels[0] - mainRect.left;
    const localY = viewportPixels[1] - mainRect.top;

    let left = localX + 28;
    let cardIsLeft = false;
    if (left + cardRect.width > mainRect.width - 14) {
      left = localX - cardRect.width - 28;
      cardIsLeft = true;
    }

    let top = localY - cardRect.height / 2;
    top = Math.max(14, Math.min(top, mainRect.height - cardRect.height - 14));
    left = Math.max(14, Math.min(left, mainRect.width - cardRect.width - 14));

    // Keep the arrow's centre on the marker even when the card itself has to be
    // shifted away from the top or bottom edge of the map.
    const arrowSize = 14;
    const arrowHalf = arrowSize / 2;
    const safeInset = 17;
    const desiredArrowTop = localY - top - arrowHalf;
    const maxArrowTop = Math.max(safeInset, cardRect.height - arrowSize - safeInset);
    const arrowTop = Math.max(safeInset, Math.min(desiredArrowTop, maxArrowTop));

    hoverCard.classList.toggle("is-left-of-marker", cardIsLeft);
    hoverCard.style.setProperty("--hover-arrow-top", `${Math.round(arrowTop)}px`);
    hoverCard.style.left = `${Math.round(left)}px`;
    hoverCard.style.top = `${Math.round(top)}px`;
  }

  function positionHoverCardForPlacemark(placemark, fallbackPixels = null) {
    positionHoverCard(markerViewportCenter(placemark) || fallbackPixels);
  }

  function showHoverCard(object, event, placemark) {
    if (coarsePointer) return;
    clearHoverTimer();
    prefetchDashboardPhoto(object.id);

    if (activeHoverPlacemark && activeHoverPlacemark !== placemark) {
      activeHoverPlacemark.options.set(
        "iconLayout",
        layoutForWorkType(activeHoverPlacemark.properties.get("workType"), false)
      );
    }

    activeHoverPlacemark = placemark;
    placemark.options.set(
      "iconLayout",
      layoutForWorkType(placemark.properties.get("workType"), true)
    );
    hoverCard.innerHTML = briefHtml(object);
    hoverCard.classList.remove("hidden");

    const fallbackPixels = event.get("pagePixels") || event.get("position");
    requestAnimationFrame(() => positionHoverCardForPlacemark(placemark, fallbackPixels));
  }

  hoverCard.addEventListener("mouseenter", clearHoverTimer);
  hoverCard.addEventListener("mouseleave", scheduleHideHoverCard);

  function geoJsonPointToYandex(point) {
    if (!Array.isArray(point) || point.length < 2) return null;
    const lon = Number(point[0]);
    const lat = Number(point[1]);
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;
    return [lat, lon];
  }

  function convertLine(line) {
    return line.map(geoJsonPointToYandex).filter(Boolean);
  }

  function addPolygonGeometry(geometry, options) {
    if (!map || !window.ymaps || !geometry?.coordinates) return;

    const polygons = geometry.type === "Polygon"
      ? [geometry.coordinates]
      : geometry.type === "MultiPolygon"
        ? geometry.coordinates
        : [];

    polygons.forEach(polygon => {
      const rings = polygon.map(convertLine).filter(ring => ring.length >= 4);
      if (!rings.length) return;
      map.geoObjects.add(new ymaps.Polygon(rings, {}, options));
    });
  }

  function addLineGeometry(geometry, options) {
    if (!map || !window.ymaps || !geometry?.coordinates) return;

    const lines = geometry.type === "LineString"
      ? [geometry.coordinates]
      : geometry.type === "MultiLineString"
        ? geometry.coordinates
        : [];

    lines.forEach(line => {
      const coords = convertLine(line);
      if (coords.length >= 2) {
        map.geoObjects.add(new ymaps.Polyline(coords, {}, options));
      }
    });
  }

  async function addMoscowBoundaryLayer() {
    if (!mapReady) return;
    const controller = new AbortController();
    const timeout = window.setTimeout(() => controller.abort(), 8000);
    try {
      const response = await fetch(`moscow_boundary.geojson?v=${encodeURIComponent(BUILD)}`, {
        cache: "force-cache",
        signal: controller.signal
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const geojson = await response.json();

      for (const feature of geojson.features || []) {
        const layer = feature.properties?.layer;
        if (layer === "outside_mask") {
          addPolygonGeometry(feature.geometry, {
            fillColor: "#c92743",
            fillOpacity: 0.23,
            strokeOpacity: 0,
            zIndex: 1,
            interactivityModel: "default#transparent"
          });
        } else if (layer === "moscow_boundary") {
          addLineGeometry(feature.geometry, {
            strokeColor: "#b6253d",
            strokeOpacity: 0.9,
            strokeWidth: 2.5,
            zIndex: 2,
            interactivityModel: "default#transparent"
          });
        }
      }
    } catch (error) {
      diag.warn("load-boundary", "Moscow boundary layer failed", error);
      showToast("Слой границы Москвы не загрузился");
    } finally {
      window.clearTimeout(timeout);
    }
  }

  function objectBounds(list) {
    if (!list.length) return null;
    const latitudes = list.map(object => object.lat);
    const longitudes = list.map(object => object.lon);
    return [
      [Math.min(...latitudes), Math.min(...longitudes)],
      [Math.max(...latitudes), Math.max(...longitudes)]
    ];
  }

  function fitObjects(list, animate = false) {
    if (!map || !list.length) return;
    if (list.length === 1) {
      map.setCenter([list[0].lat, list[0].lon], 16, {
        duration: animate ? 350 : 0
      });
      return;
    }

    const mobile = window.innerWidth < 900;
    map.setBounds(objectBounds(list), {
      checkZoomRange: true,
      zoomMargin: mobile ? [50, 30, 260, 30] : [70, 300, 70, 455],
      duration: animate ? 350 : 0
    });
  }

  function initializeMap() {
    if (mapReady) return Promise.resolve(map);
    if (mapInitializationPromise) return mapInitializationPromise;

    mapInitializationPromise = Promise.resolve().then(() => {
      if (!window.ymaps?.Map || !window.ymaps?.Placemark || !window.ymaps?.Clusterer) {
        throw new Error("Не все обязательные модули Яндекс Карт доступны.");
      }

      markerLayouts = {
        panorama: {
          normal: createWorkMarkerLayout(cameraMarkerSvg()),
          hover: createWorkMarkerLayout(cameraMarkerSvg(), true)
        },
        laser: {
          normal: createWorkMarkerLayout(laserScannerMarkerSvg()),
          hover: createWorkMarkerLayout(laserScannerMarkerSvg(), true)
        }
      };

      map = new ymaps.Map("map", {
        center: [55.7558, 37.6176],
        zoom: 11,
        type: "yandex#map",
        controls: ["zoomControl", "fullscreenControl"]
      }, {
        suppressMapOpenBlock: true,
        restrictMapArea: [[54.2, 34.5], [57.2, 41.5]]
      });
      map.behaviors.enable("scrollZoom");

      try {
        map.controls.get("zoomControl").options.set({
          position: { right: 18, top: 18 }
        });
        map.controls.get("fullscreenControl").options.set({
          position: { right: 18, top: 116 }
        });
      } catch (_) {
        // The map remains usable even if a control position cannot be customized.
      }

      clusterer = new ymaps.Clusterer({
        preset: "islands#invertedRedClusterIcons",
        groupByCoordinates: false,
        clusterDisableClickZoom: false,
        clusterOpenBalloonOnClick: false,
        gridSize: 54,
        minClusterSize: 2
      });

      diag.log("build-map-objects", "Map marker construction started", { count: objects.length });
      objects.forEach(object => {
        const summary = objectSummary(object);
        const markerColor = groupColor(object.group);
        const markerWorkType = summary.markerWorkType;

        const placemark = new ymaps.Placemark(
          [object.lat, object.lon],
          {
            objectId: object.id,
            objectName: escapeHtml(object.name),
            markerColor,
            statusClass: summary.statusClass,
            statusIcon: summary.statusIcon,
            objectStateClass: summary.isFinished ? "is-finished" : "",
            workType: markerWorkType
          },
          {
            iconLayout: layoutForWorkType(markerWorkType, false),
            iconShape: {
              type: "Rectangle",
              coordinates: [[-24, -24], [24, 24]]
            },
            zIndex: 500,
            zIndexHover: 1000,
            hideIconOnBalloonOpen: false
          }
        );

        placemark.events.add("mouseenter", event => showHoverCard(object, event, placemark));
        placemark.events.add("mousedown", () => prefetchDashboardPhoto(object.id));
        placemark.events.add("mouseleave", scheduleHideHoverCard);
        placemark.events.add("click", event => {
          try {
            const domEvent = event.get("domEvent");
            domEvent?.preventDefault?.();
            domEvent?.stopPropagation?.();
          } catch (_) {
            // Yandex Maps does not always expose the browser event on touch devices.
          }
          hideHoverCard();
          openDetail(object.id);
        });

        markers.set(object.id, placemark);
        clusterer.add(placemark);
      });
      diag.log("build-map-objects", "Map marker construction completed", { count: markers.size });

      map.geoObjects.add(clusterer);
      fitObjects(objects);
      map.events.add("boundschange", () => {
        if (!activeHoverPlacemark || hoverCard.classList.contains("hidden")) return;
        requestAnimationFrame(() => positionHoverCardForPlacemark(activeHoverPlacemark));
      });
      map.events.add(["actionbegin", "boundschange"], hideHoverCard);
      mapReady = true;

      const scheduleBoundaryLayer = () => addMoscowBoundaryLayer();
      if ("requestIdleCallback" in window) {
        window.requestIdleCallback(scheduleBoundaryLayer, { timeout: 1400 });
      } else {
        window.setTimeout(scheduleBoundaryLayer, 450);
      }

      applyFilters();
      const linkedObject = new URL(window.location.href).searchParams.get("object");
      if (linkedObject && objectById.has(linkedObject)) {
        const object = objectById.get(linkedObject);
        map.setCenter([object.lat, object.lon], 16);
      }
      return map;
    }).catch(error => {
      mapInitializationPromise = null;
      mapReady = false;
      try { map?.destroy?.(); } catch (_) {}
      map = null;
      clusterer = null;
      markerLayouts = null;
      markers.clear();
      throw error;
    });

    return mapInitializationPromise;
  }

  function populateSelectors() {
    const groups = [...new Set(objects.map(o => o.group))].sort();
    const types = [...new Set(objects.map(o => o.type))].sort();
    const employees = [...new Set(visits.map(v => v.employee))].sort();
    const workTypes = [...new Set(visits.map(v => normalizedWorkType(v.workType)))].sort();

    groups.forEach(value => $("groupFilter").add(new Option(value, value)));
    types.forEach(value => $("typeFilter").add(new Option(value, value)));
    employees.forEach(value => $("employeeFilter").add(new Option(value, value)));
    workTypes.forEach(value => $("workTypeFilter").add(new Option(value, value)));

    $("legendItems").innerHTML = groups.map(group => `
      <div class="legend-row">
        <span class="legend-dot" style="background:${groupColor(group)}"></span>
        <span>${escapeHtml(group)}</span>
      </div>`).join("");

    $("workTypeLegendItems").innerHTML = workTypes.map(workType => `
      <div class="legend-row work-type-legend-row">
        ${workTypeIconHtml(workType, true)}
        <span>${escapeHtml(workType)}</span>
      </div>`).join("");
  }
  populateSelectors();


  function reportPeriodRange() {
    const calculate = window.PhotoDashboardPeriod?.reportPeriodRangeAt;
    if (typeof calculate !== "function") {
      throw new Error("Модуль автоматического периода не загружен.");
    }
    return calculate(dashboardNow());
  }

  function formatPeriod(start, endExclusive) {
    const end = addDays(endExclusive, -1);
    const startDate = new Date(`${start}T12:00:00+03:00`);
    const endDate = new Date(`${end}T12:00:00+03:00`);
    const sameMonth = start.slice(0, 7) === end.slice(0, 7);
    const startText = new Intl.DateTimeFormat("ru-RU", {
      timeZone: "Europe/Moscow", day: "numeric", month: sameMonth ? undefined : "long"
    }).format(startDate);
    const endText = new Intl.DateTimeFormat("ru-RU", {
      timeZone: "Europe/Moscow", day: "numeric", month: "long"
    }).format(endDate);
    return `${startText} — ${endText}`;
  }

  function weeklyReportVisits() {
    const [start, end] = reportPeriodRange();
    const allowedStatuses = new Set(["Выполнен", "Запланирован"]);
    return visits.filter(visit =>
      allowedStatuses.has(visit.status) &&
      visit.date >= start && visit.date < end &&
      visit.objects.length
    );
  }

  function renderWeeklySummary() {
    const [start, end] = reportPeriodRange();
    const reportVisits = weeklyReportVisits();
    const points = reportVisits.reduce((sum, visit) => sum + (Number(visit.pointsCount) || 0), 0);

    $("weekPeriod").textContent = formatPeriod(start, end);
    $("weekObjectsCount").textContent = new Intl.NumberFormat("ru-RU").format(reportVisits.length);
    $("weekPointsCount").textContent = new Intl.NumberFormat("ru-RU").format(points);

    $("weekObjectsList").innerHTML = reportVisits.length
      ? reportVisits.map(visit => `
          <button class="week-object-row" type="button" data-focus-visit="${escapeHtml(visit.id)}">
            <span class="week-object-date">${escapeHtml(formatDate(visit.date, { noYear: true }))}</span>
            <span class="week-object-main">
              <strong>${escapeHtml(visit.objects.join("; "))}</strong>
              <small>${escapeHtml(visit.employee || "Ответственный не указан")}</small>
            </span>
            <span class="week-object-points">${new Intl.NumberFormat("ru-RU").format(Number(visit.pointsCount) || 0)}<small> точек</small></span>
          </button>`).join("")
      : `<div class="empty-state">В отчётном периоде нет выполненных или запланированных съёмок</div>`;
  }

  function currentWeekRange() {
    const today = moscowParts();
    const date = new Date(`${today}T12:00:00+03:00`);
    const weekday = date.getUTCDay() || 7;
    const monday = addDays(today, 1 - weekday);
    const friday = addDays(monday, 4);
    return [monday, friday];
  }

  function visitsOn(date) {
    return visits.filter(v => v.date === date && isActiveVisit(v));
  }

  function renderVisitList(containerId, buttonId, list, emptyText) {
    const container = $(containerId);
    const button = $(buttonId);
    const expanded = button.dataset.expanded === "true";
    const shown = expanded ? list : list.slice(0, 5);

    container.innerHTML = shown.length ? shown.map(visit => `
      <button class="visit-row" type="button" data-focus-visit="${visit.id}">
        <span>
          <span class="visit-name">${escapeHtml(visit.objects.join("; "))}</span>
          <span class="visit-meta">${formatDate(visit.date, { weekday: true })}</span>
          <span class="visit-work-type">${workTypeIconHtml(visit.workType, true)}${escapeHtml(normalizedWorkType(visit.workType))}</span>
        </span>
        <span class="employee-pill">${escapeHtml(visit.employee)}</span>
      </button>`).join("") : `<div class="empty-state">${emptyText}</div>`;

    button.classList.toggle("hidden", list.length <= 5);
    button.textContent = expanded ? "Свернуть" : `Показать все (${list.length})`;
  }

  function renderOperations() {
    renderWeeklySummary();
    const today = moscowParts();
    const tomorrow = addDays(today, 1);
    $("currentDate").textContent = formatDate(today, { longMonth: true, weekday: true });
    $("todayDate").textContent = formatDate(today, { noYear: true });
    $("tomorrowDate").textContent = formatDate(tomorrow, { noYear: true });
    renderSyncStatus();

    renderVisitList("todayList", "todayMore", visitsOn(today), "На сегодня выезды не запланированы");
    renderVisitList("tomorrowList", "tomorrowMore", visitsOn(tomorrow), "На завтра выезды не запланированы");

    const [weekStart, weekEnd] = currentWeekRange();
    const month = today.slice(0, 7);
    const stats = [
      ["Всего объектов", objects.length],
      ["Выездов сегодня", visitsOn(today).length],
      ["Выездов завтра", visitsOn(tomorrow).length],
      ["В текущую рабочую неделю", visits.filter(v => isActiveVisit(v) && v.date >= weekStart && v.date <= weekEnd).length],
      ["Без следующего выезда", objects.filter(o => !objectSummary(o).nextVisit).length],
      ["Выполнено в текущем месяце", visits.filter(v => v.status === "Выполнен" && v.date.startsWith(month)).length]
    ];
    $("statsGrid").innerHTML = stats.map(([label, value]) => `
      <div class="stat-card"><div class="stat-value">${value}</div><div class="stat-label">${label}</div></div>
    `).join("");
  }
  renderOperations();

  function schedulePeriodSwitch() {
    window.clearTimeout(window.__PHOTO_DASHBOARD_PERIOD_TIMER);
    const now = dashboardNow();
    const nextSwitch = window.PhotoDashboardPeriod?.nextSwitchAt?.(now);
    if (!(nextSwitch instanceof Date) || Number.isNaN(nextSwitch.getTime())) return;
    const delay = Math.max(1000, nextSwitch.getTime() - now.getTime() + 1000);
    window.__PHOTO_DASHBOARD_PERIOD_TIMER = window.setTimeout(() => {
      renderOperations();
      schedulePeriodSwitch();
    }, delay);
  }
  schedulePeriodSwitch();

  function focusVisit(visitId) {
    const visit = visits.find(v => v.id === visitId);
    if (!visit) return;
    const targets = visit.objects.map(name => objectByName.get(name)).filter(Boolean);
    if (!targets.length) return;

    fitObjects(targets, true);
    if (targets.length === 1) {
      window.setTimeout(() => openDetail(targets[0].id), 380);
    }
  }

  function openDetail(objectId) {
    currentDetailObjectId = objectId;
    const object = objectById.get(objectId);
    if (!object) return;
    const summary = objectSummary(object);
    const historyEntries = summary.list
      .filter(v => v.status !== "Отменён")
      .slice().sort((a, b) => b.date.localeCompare(a.date));

    $("detailContent").innerHTML = `
      <div class="detail-hero">
        <img src="${photoUrl(object)}" alt="${escapeHtml(object.name)}"
             data-photo-id="${escapeHtml(object.id)}"
             decoding="async" fetchpriority="high">
        <div class="photo-status" data-photo-warning hidden aria-live="polite"></div>
      </div>
      <div class="detail-body">
        <div class="detail-heading">
          <h2 class="detail-title">${escapeHtml(object.name)}</h2>
          <div class="detail-chips">
            <span class="group-chip">${escapeHtml(object.group)}</span>
            ${summary.isFinished ? "" : `<span class="status-chip" style="background:${statusColor(summary.statusClass)}">${escapeHtml(summary.displayStatus)}</span>`}
          </div>
        </div>

        <div class="detail-grid">
          <div class="info-card"><div class="info-label">Текущий вид работ</div><div class="info-value work-type-info">${workTypeIconHtml(summary.markerWorkType, true)}${escapeHtml(summary.markerWorkType)}</div></div>
          <div class="info-card"><div class="info-label">Ответственный</div><div class="info-value">${escapeHtml(summary.nextVisit?.employee || summary.lastCompleted?.employee || "Не назначен")}</div></div>
          <div class="info-card"><div class="info-label">Последний выезд</div><div class="info-value">${summary.lastCompleted ? formatDate(summary.lastCompleted.date) : "Выездов ещё не было"}</div></div>
          <div class="info-card"><div class="info-label">Следующий выезд</div><div class="info-value">${summary.isFinished ? "Завершено" : (summary.nextVisit ? formatDate(summary.nextVisit.date) : "Не запланирован")}</div></div>
          <div class="info-card"><div class="info-label">Выполнено выездов</div><div class="info-value">${summary.completed.length}</div></div>
          <div class="info-card"><div class="info-label">Средний интервал</div><div class="info-value">${summary.avgInterval ? `${summary.avgInterval} дн.` : "Недостаточно данных"}</div></div>
          <div class="info-card"><div class="info-label">Первый выезд</div><div class="info-value">${summary.firstCompleted ? formatDate(summary.firstCompleted.date) : "—"}</div></div>
          <div class="info-card info-card-points"><div class="info-label">Количество точек</div><div class="info-value">${new Intl.NumberFormat("ru-RU").format(Number(object.pointsCount || 0))}</div></div>
        </div>

        <div class="detail-actions">
          ${object.albumUrl ? `<a class="button primary" href="${escapeHtml(object.albumUrl)}" target="_blank" rel="noopener noreferrer">Открыть панораму</a>` : ""}
          ${object.mapUrl ? `<a class="button primary" href="${escapeHtml(object.mapUrl)}" target="_blank" rel="noopener">Открыть в Яндекс Картах</a>` : ""}
          <button class="button secondary" type="button" data-copy-link="${object.id}">Скопировать ссылку</button>
        </div>

        ${object.comment ? `<div class="detail-section"><h3>Комментарий</h3><p>${escapeHtml(object.comment)}</p></div>` : ""}

        <div class="detail-section">
          <h3>История выездов</h3>
          <div class="history-list">
            ${historyEntries.length ? historyEntries.map(v => `
              <div class="history-row">
                <div class="history-date">${formatDate(v.date)}</div>
                <div>
                  <div class="history-person">${escapeHtml(v.employee)}</div>
                  <div class="visit-work-type">${workTypeIconHtml(v.workType, true)}${escapeHtml(normalizedWorkType(v.workType))}</div>
                  ${v.comment ? `<div class="visit-meta">${escapeHtml(v.comment)}</div>` : ""}
                </div>
                <div class="history-status">${escapeHtml(derivedVisitStatus(v))}</div>
              </div>`).join("") : `<div class="empty-state">История съёмок отсутствует</div>`}
          </div>
        </div>
      </div>`;

    const detailPhoto = $("detailContent").querySelector(".detail-hero img[data-photo-id]");
    if (hasDashboardPhoto(object)) {
      loadDashboardPhoto(detailPhoto, object.id);
    } else {
      setPhotoWarning(detailPhoto, "Фотография не добавлена");
    }

    $("detailDrawer").classList.add("open");
    $("detailDrawer").setAttribute("aria-hidden", "false");
    $("drawerBackdrop").classList.remove("hidden");
    const url = new URL(window.location.href);
    url.searchParams.set("object", object.id);
    history.replaceState({}, "", url);
  }

  function statusColor(statusClass) {
    return {
      completed: "#16845b",
      planned: "#2869ba",
      today: "#b6253d",
      warning: "#c27616",
      cancelled: "#be2d3e",
      finished: "#7c8797"
    }[statusClass] || "#60758e";
  }

  function closeDrawers() {
    $("detailDrawer").classList.remove("open");
    $("filterDrawer").classList.remove("open");
    $("detailDrawer").setAttribute("aria-hidden", "true");
    $("filterDrawer").setAttribute("aria-hidden", "true");
    $("drawerBackdrop").classList.add("hidden");
    currentDetailObjectId = null;
    const url = new URL(window.location.href);
    url.searchParams.delete("object");
    history.replaceState({}, "", url);
  }

  function objectHasVisitInRange(object, from, to, employee, workType) {
    return objectVisits(object).some(v => {
      if (employee && v.employee !== employee) return false;
      if (workType && normalizedWorkType(v.workType) !== workType) return false;
      if (from && v.date < from) return false;
      if (to && v.date > to) return false;
      return true;
    });
  }

  function applyFilters() {
    const group = $("groupFilter").value;
    const type = $("typeFilter").value;
    const employee = $("employeeFilter").value;
    const workType = $("workTypeFilter").value;
    const next = $("nextFilter").value;
    const quick = $("quickFilter").value;
    const from = $("dateFromFilter").value;
    const to = $("dateToFilter").value;
    const search = $("searchInput").value.trim().toLocaleLowerCase("ru");

    let quickFrom = "", quickTo = "";
    const today = moscowParts();
    if (quick === "today") quickFrom = quickTo = today;
    if (quick === "tomorrow") quickFrom = quickTo = addDays(today, 1);
    if (quick === "week") [quickFrom, quickTo] = currentWeekRange();

    const shownObjects = objects.filter(object => {
      if (group && object.group !== group) return false;
      if (type && object.type !== type) return false;
      if (search && !`${object.name} ${object.group} ${objectSummary(object).markerWorkType}`.toLocaleLowerCase("ru").includes(search)) return false;
      const summary = objectSummary(object);
      if (next === "yes" && !summary.nextVisit) return false;
      if (next === "no" && summary.nextVisit) return false;
      const rangeFrom = quickFrom || from;
      const rangeTo = quickTo || to;
      if ((employee || workType || rangeFrom || rangeTo) &&
          !objectHasVisitInRange(object, rangeFrom, rangeTo, employee, workType)) return false;
      return true;
    });

    hideHoverCard();
    if (clusterer) {
      clusterer.removeAll();
      shownObjects.forEach(object => {
        const placemark = markers.get(object.id);
        if (!placemark) return;
        setPlacemarkWorkType(
          placemark,
          workType || objectSummary(object).markerWorkType
        );
        clusterer.add(placemark);
      });
    }
    const mapCounter = $("mapCounter");
    if (mapCounter) mapCounter.textContent = `На карте: ${shownObjects.length} из ${objects.length}`;
    const count = [group, type, employee, workType, next, quick, from, to, search].filter(Boolean).length;
    $("filterCount").textContent = count;
    $("filterCount").classList.toggle("hidden", !count);

    if (mapReady && shownObjects.length) fitObjects(shownObjects);
    return shownObjects;
  }
  applyFilters();

  function resetFilters() {
    ["groupFilter", "typeFilter", "employeeFilter", "workTypeFilter", "nextFilter", "quickFilter", "dateFromFilter", "dateToFilter"]
      .forEach(id => $(id).value = "");
    $("searchInput").value = "";
    applyFilters();
  }

  function showToast(message) {
    $("toast").textContent = message;
    $("toast").classList.remove("hidden");
    clearTimeout(showToast.timer);
    showToast.timer = setTimeout(() => $("toast").classList.add("hidden"), 2600);
  }

  function exportVisits() {
    const from = $("exportFrom").value;
    const to = $("exportTo").value;
    if (!from || !to || from > to) {
      showToast("Проверьте выбранный период");
      return;
    }
    const rows = visits
      .filter(v => v.date >= from && v.date <= to)
      .map(v => ({
        "Дата выезда": formatDate(v.date),
        "Ответственный": v.employee,
        "Вид работ": normalizedWorkType(v.workType),
        "Объекты": v.objects.join("; "),
        "Статус": derivedVisitStatus(v),
        "Комментарий": v.comment || ""
      }));

    if (!rows.length) {
      showToast("В выбранном периоде выездов нет");
      return;
    }

    if (window.XLSX) {
      const ws = XLSX.utils.json_to_sheet(rows);
      ws["!cols"] = [{wch:14}, {wch:18}, {wch:28}, {wch:60}, {wch:24}, {wch:45}];
      const book = XLSX.utils.book_new();
      XLSX.utils.book_append_sheet(book, ws, "Выезды");
      XLSX.writeFile(book, `Выезды_${from}_${to}.xlsx`);
    } else {
      const header = Object.keys(rows[0]);
      const csv = [header, ...rows.map(row => header.map(key => row[key]))]
        .map(line => line.map(value => `"${String(value).replaceAll('"','""')}"`).join(";"))
        .join("\n");
      const blob = new Blob(["\ufeff" + csv], { type: "text/csv;charset=utf-8" });
      const link = document.createElement("a");
      link.href = URL.createObjectURL(blob);
      link.download = `Выезды_${from}_${to}.csv`;
      link.click();
      URL.revokeObjectURL(link.href);
    }
    $("exportDialog").close();
  }

  document.addEventListener("click", event => {
    const openButton = event.target.closest("[data-open-object]");
    if (openButton) openDetail(openButton.dataset.openObject);

    const visitButton = event.target.closest("[data-focus-visit]");
    if (visitButton) focusVisit(visitButton.dataset.focusVisit);

    const copyButton = event.target.closest("[data-copy-link]");
    if (copyButton) {
      const url = new URL(window.location.href);
      url.searchParams.set("object", copyButton.dataset.copyLink);
      navigator.clipboard?.writeText(url.href)
        .then(() => showToast("Ссылка на объект скопирована"))
        .catch(() => showToast(url.href));
    }
  });

  $("searchInput").addEventListener("input", applyFilters);
  $("searchInput").addEventListener("keydown", event => {
    if (event.key !== "Enter") return;
    const shown = applyFilters();
    if (shown.length === 1) openDetail(shown[0].id);
  });

  function setLegendVisible(visible) {
    const legend = $("mapLegend");
    const showButton = $("showLegend");
    if (!legend || !showButton) return;
    legend.classList.toggle("hidden", !visible);
    showButton.classList.toggle("hidden", visible);
    try {
      localStorage.setItem("photo360.legendVisible", visible ? "1" : "0");
    } catch (_) {}
  }

  $("hideLegend")?.addEventListener("click", () => setLegendVisible(false));
  $("showLegend")?.addEventListener("click", () => setLegendVisible(true));
  try {
    if (localStorage.getItem("photo360.legendVisible") === "0") setLegendVisible(false);
  } catch (_) {}

  $("filtersButton").addEventListener("click", () => {
    $("filterDrawer").classList.add("open");
    $("filterDrawer").setAttribute("aria-hidden", "false");
    $("drawerBackdrop").classList.remove("hidden");
  });
  $("closeFilters").addEventListener("click", closeDrawers);
  $("closeDetail").addEventListener("click", closeDrawers);
  $("drawerBackdrop").addEventListener("click", closeDrawers);
  $("applyFilters").addEventListener("click", () => { applyFilters(); closeDrawers(); });
  $("resetFilters").addEventListener("click", resetFilters);

  $("refreshButton").addEventListener("click", async () => {
    const button = $("refreshButton");
    button.disabled = true;
    const controller = new AbortController();
    const timeout = window.setTimeout(() => controller.abort(), 20000);
    try {
      if (window.DASHBOARD_DATA?.meta?.liveSync) {
        const endpoint = String(window.APP_CONFIG?.dashboardDataEndpoint || "/api/dashboard-data");
        const url = new URL(endpoint, window.location.origin);
        url.searchParams.set("force", "1");
        await fetch(url, {
          cache: "no-store",
          headers: { "Accept": "application/json" },
          signal: controller.signal
        });
      }
    } catch (error) {
      // После перезагрузки загрузчик покажет последнюю рабочую версию либо понятную ошибку.
      diag.warn("manual-refresh", "Manual data refresh failed", error);
    } finally {
      window.clearTimeout(timeout);
      window.location.reload();
    }
  });
  $("printButton").addEventListener("click", () => window.print());
  $("fullscreenButton").addEventListener("click", () => {
    if (!document.fullscreenElement) document.documentElement.requestFullscreen?.();
    else document.exitFullscreen?.();
  });

  $("weekObjectsCard").addEventListener("click", () => {
    const list = $("weekObjectsList");
    const button = $("weekObjectsCard");
    const hidden = list.classList.toggle("hidden");
    button.setAttribute("aria-expanded", String(!hidden));
    $("weekObjectsChevron").textContent = hidden ? "▾" : "▴";
  });

  $("collapseOperations").addEventListener("click", () => {
    const content = $("operationsContent");
    const button = $("collapseOperations");
    const hidden = content.classList.toggle("hidden");
    button.textContent = hidden ? "+" : "−";
    button.setAttribute("aria-expanded", String(!hidden));
    button.title = hidden ? "Развернуть оперативный график" : "Свернуть оперативный график";
  });
  $("statsToggle").addEventListener("click", () => {
    const grid = $("statsGrid");
    const hidden = grid.classList.toggle("hidden");
    $("statsToggle").textContent = hidden ? "Развернуть" : "Свернуть";
  });
  ["todayMore", "tomorrowMore"].forEach(id => {
    $(id).addEventListener("click", () => {
      $(id).dataset.expanded = $(id).dataset.expanded === "true" ? "false" : "true";
      renderOperations();
    });
  });

  const dates = visits.map(v => v.date).sort();
  $("exportFrom").value = dates[0];
  $("exportTo").value = dates.at(-1);
  $("exportButton").addEventListener("click", () => $("exportDialog").showModal());
  $("downloadExport").addEventListener("click", exportVisits);


  function refreshMarkerStatuses() {
    objects.forEach(object => {
      const placemark = markers.get(object.id);
      if (!placemark) return;
      const summary = objectSummary(object);
      placemark.properties.set("statusClass", summary.statusClass);
      placemark.properties.set("statusIcon", summary.statusIcon);
      placemark.properties.set("objectStateClass", summary.isFinished ? "is-finished" : "");
      setPlacemarkWorkType(placemark, summary.markerWorkType);
    });
  }

  function refreshStatusViews() {
    refreshMarkerStatuses();
    renderOperations();
    applyFilters();
    if (currentDetailObjectId && objectById.has(currentDetailObjectId)) {
      openDetail(currentDetailObjectId);
    }
  }

  function setVisitStatusLocally(visitId, status, overridden = true) {
    const visit = visits.find(item => item.id === visitId);
    if (!visit) return false;
    visit.status = status;
    visit._statusOverridden = overridden;
    if (!overridden) visit._baseStatus = status;
    refreshStatusViews();
    return true;
  }

  function resetVisitStatusLocally(visitId) {
    const visit = visits.find(item => item.id === visitId);
    if (!visit) return false;
    visit.status = visit._baseStatus;
    visit._statusOverridden = false;
    refreshStatusViews();
    return true;
  }

  function applyStatusOverrides(items = {}) {
    visits.forEach(visit => {
      const override = items?.[visit.id];
      if (override && typeof override.status === "string") {
        visit.status = override.status;
        visit._statusOverridden = true;
      } else {
        visit.status = visit._baseStatus;
        visit._statusOverridden = false;
      }
    });
    refreshStatusViews();
  }

  window.DASHBOARD_APP = {
    getVisits: () => visits.map(visit => ({
      ...visit,
      derivedStatus: derivedVisitStatus(visit),
      baseStatus: visit._baseStatus,
      statusOverridden: Boolean(visit._statusOverridden)
    })),
    applyStatusOverrides,
    setVisitStatusLocally,
    resetVisitStatusLocally,
    refreshStatusViews,
    initializeMap,
    filtersReady: true,
    get mapReady() { return mapReady; }
  };
  window.PHOTO_DASHBOARD_ASSETS ||= Object.create(null);
  window.PHOTO_DASHBOARD_ASSETS.app = BUILD;
  window.dispatchEvent(new CustomEvent("dashboard:ready"));

  const linkedObject = new URL(window.location.href).searchParams.get("object");
  if (linkedObject && objectById.has(linkedObject)) {
    openDetail(linkedObject);
  }

  window.addEventListener("resize", () => map?.container?.fitToViewport?.());
})();


// Серверный режим: проверяем Excel и автоматически перезагружаем данные после изменения.
(() => {
  const initialVersion = window.DASHBOARD_DATA?.meta?.version || "";
  const refreshSeconds = Number(window.DASHBOARD_DATA?.meta?.refreshSeconds || 30);
  let versionCheckInFlight = false;
  let stoppedForAuthentication = false;

  async function checkServerVersion() {
    if (document.hidden || versionCheckInFlight || stoppedForAuthentication) return;
    versionCheckInFlight = true;
    const controller = new AbortController();
    const timeout = window.setTimeout(() => controller.abort(), 25000);
    try {
      const endpoint = String(window.APP_CONFIG?.dashboardDataEndpoint || "/api/dashboard-data");
      const url = new URL(endpoint, window.location.origin);
      url.searchParams.set("mode", "version");
      const response = await fetch(url, {
        cache: "no-store",
        credentials: "same-origin",
        headers: { "Accept": "application/json" },
        signal: controller.signal
      });
      if (response.status === 401) {
        stoppedForAuthentication = true;
        window.dispatchEvent(new CustomEvent("dashboard:auth-expired"));
        return;
      }
      if (!response.ok) return;
      const state = await response.json();

      const syncText = document.getElementById("syncText");
      if (syncText) {
        const syncDate = new Date(state.lastSuccessfulSyncAt || state.sourceUpdatedAt || "");
        const formatted = Number.isNaN(syncDate.getTime()) ? "неизвестного времени" : new Intl.DateTimeFormat("ru-RU", {
          timeZone: "Europe/Moscow",
          day: "2-digit", month: "long", year: "numeric",
          hour: "2-digit", minute: "2-digit"
        }).format(syncDate) + " МСК";
        syncText.classList.toggle("is-warning", state.sourceStatus !== "ok");
        syncText.textContent = state.sourceStatus === "ok"
          ? `· Excel синхронизирован: ${formatted}`
          : `· Excel недоступен — данные от ${formatted}`;
      }

      if (state.version && initialVersion && state.version !== initialVersion) {
        window.location.reload();
      }
    } catch (error) {
      // При открытии index.html без сервера запрос недоступен — статический режим продолжает работать.
      window.PhotoDashboardDiagnostics?.warn("version-check", "Background version check failed", error);
    } finally {
      window.clearTimeout(timeout);
      versionCheckInFlight = false;
    }
  }

  if (location.protocol === "http:" || location.protocol === "https:") {
    window.clearInterval(window.__PHOTO_DASHBOARD_VERSION_TIMER);
    window.clearTimeout(window.__PHOTO_DASHBOARD_INITIAL_SYNC_TIMER);
    window.__PHOTO_DASHBOARD_INITIAL_SYNC_TIMER = window.setTimeout(checkServerVersion, 1200);
    window.__PHOTO_DASHBOARD_VERSION_TIMER = window.setInterval(
      checkServerVersion,
      Math.max(refreshSeconds, 10) * 1000
    );
    document.addEventListener("visibilitychange", () => {
      if (!document.hidden) checkServerVersion();
    });
    window.addEventListener("dashboard:authenticated", () => {
      stoppedForAuthentication = false;
      checkServerVersion();
    });
  }
})();
