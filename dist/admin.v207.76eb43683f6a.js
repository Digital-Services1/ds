(() => {
  "use strict";

  const BUILD = "2.0.7-rc5-fast-load-20260804";
  const endpoint = "/api/status-admin";
  const allowedStatuses = ["Запланирован", "Выполнен", "Перенесён", "Отменён", "Завершено"];
  const tokenKey = "photoDashboardAdminToken";
  let adminToken = sessionStorage.getItem(tokenKey) || "";
  let appReady = Boolean(window.DASHBOARD_APP);
  let clickCount = 0;
  let clickTimer = null;
  let overrideSyncInfo = Object.create(null);
  const operationIds = new Map();

  const $ = id => document.getElementById(id);

  function escapeHtml(value) {
    return String(value ?? "")
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;")
      .replaceAll('"', "&quot;")
      .replaceAll("'", "&#039;");
  }

  function formatDate(iso) {
    if (!iso) return "—";
    return new Intl.DateTimeFormat("ru-RU", {
      timeZone: "Europe/Moscow", day: "2-digit", month: "2-digit", year: "numeric"
    }).format(new Date(`${iso}T12:00:00+03:00`));
  }

  function pluralVisits(value) {
    const n = Math.abs(value) % 100;
    const n1 = n % 10;
    if (n > 10 && n < 20) return "выездов";
    if (n1 > 1 && n1 < 5) return "выезда";
    if (n1 === 1) return "выезд";
    return "выездов";
  }

  async function api(body, { auth = false, method = "POST", timeoutMs = 15000 } = {}) {
    const headers = { "Content-Type": "application/json", "Accept": "application/json" };
    if (auth && adminToken) headers.Authorization = `Bearer ${adminToken}`;
    const controller = new AbortController();
    const timeout = window.setTimeout(() => controller.abort(), timeoutMs);
    let response;
    try {
      response = await fetch(endpoint, {
        method,
        headers,
        cache: "no-store",
        body: method === "GET" ? undefined : JSON.stringify(body || {}),
        signal: controller.signal
      });
    } catch (error) {
      if (error?.name === "AbortError") {
        throw new Error(`Сервер администратора не завершил операцию за ${Math.round(timeoutMs / 1000)} секунд.`);
      }
      throw error;
    } finally {
      window.clearTimeout(timeout);
    }
    let payload = {};
    try { payload = await response.json(); } catch (_) { payload = {}; }
    if (!response.ok) {
      const error = new Error(payload.error || `Ошибка сервера: ${response.status}`);
      error.status = response.status;
      throw error;
    }
    return payload;
  }

  function newOperationId() {
    if (window.crypto?.randomUUID) return window.crypto.randomUUID().replaceAll("-", "");
    const random = new Uint8Array(18);
    window.crypto?.getRandomValues?.(random);
    return Array.from(random, value => value.toString(16).padStart(2, "0")).join("") ||
      `${Date.now()}_${Math.random().toString(36).slice(2)}`;
  }

  async function waitForExcelSync(row, visitId, operationId, status) {
    for (let attempt = 0; attempt < 18; attempt += 1) {
      await new Promise(resolve => window.setTimeout(resolve, attempt ? 4000 : 1800));
      const response = await api(null, { method: "GET", timeoutMs: 15000 });
      const item = response.items?.[visitId];
      if (!item) {
        delete overrideSyncInfo[visitId];
        operationIds.delete(visitId);
        window.DASHBOARD_APP.setVisitStatusLocally(visitId, status, false);
        setRowMessage(row, "Статус сохранён в Excel на Nextcloud", "success");
        row.classList.remove("is-overridden");
        row.querySelector(".admin-reset-button")?.classList.add("hidden");
        return "synced";
      }
      overrideSyncInfo[visitId] = item;
      if (item.operationId !== operationId) return "superseded";
      if (item.sync?.status === "conflict") {
        setRowMessage(row, `Конфликт Excel: ${item.sync.error || "файл изменён параллельно"}`, "error");
        return "conflict";
      }
      setRowMessage(row, `Excel: автоматическая попытка ${item.sync?.attempts || 1}…`);
    }
    setRowMessage(row, "Excel всё ещё ожидает записи. Нажмите «Повторить синхронизацию».", "error");
    return "pending";
  }

  async function loadOverrides() {
    if (!appReady || !window.DASHBOARD_APP) return;
    try {
      const response = await api(null, { method: "GET" });
      overrideSyncInfo = response.items || Object.create(null);
      window.DASHBOARD_APP.applyStatusOverrides(response.items || {});
    } catch (error) {
      // Local Python preview has no server API. The Excel statuses remain usable.
      console.info("Admin status overrides are unavailable in this environment:", error.message);
    }
  }

  function openLogin() {
    const dialog = $("adminLoginDialog");
    const error = $("adminLoginError");
    if (!dialog) return;
    error?.classList.add("hidden");
    if (error) error.textContent = "";
    if (typeof dialog.showModal === "function") dialog.showModal();
    else dialog.setAttribute("open", "");
    window.setTimeout(() => $("adminPasswordInput")?.focus(), 60);
  }

  function closeLogin() {
    const dialog = $("adminLoginDialog");
    const input = $("adminPasswordInput");
    const error = $("adminLoginError");
    if (!dialog) return;
    if (input) input.value = "";
    if (error) {
      error.textContent = "";
      error.classList.add("hidden");
    }
    if (dialog.open && typeof dialog.close === "function") dialog.close();
    else dialog.removeAttribute("open");
  }

  function openAdminDrawer() {
    if (!appReady) return;
    $("adminDrawer")?.classList.add("open");
    $("adminDrawer")?.setAttribute("aria-hidden", "false");
    $("adminBackdrop")?.classList.remove("hidden");
    $("adminModeBadge")?.classList.remove("hidden");
    renderAdminVisits();
  }

  function closeAdminDrawer() {
    $("adminDrawer")?.classList.remove("open");
    $("adminDrawer")?.setAttribute("aria-hidden", "true");
    $("adminBackdrop")?.classList.add("hidden");
  }

  async function login() {
    const input = $("adminPasswordInput");
    const button = $("adminLoginSubmit");
    const error = $("adminLoginError");
    const password = input?.value || "";
    if (!password) return;
    button.disabled = true;
    error?.classList.add("hidden");
    try {
      const response = await api({ action: "login", password });
      adminToken = response.token || "";
      if (!adminToken) throw new Error("Сервер не вернул ключ сессии");
      sessionStorage.setItem(tokenKey, adminToken);
      if (input) input.value = "";
      closeLogin();
      openAdminDrawer();
    } catch (err) {
      if (error) {
        error.textContent = err.status === 404
          ? "Админ-API не найден. Он работает после публикации полного проекта на сервере."
          : err.message;
        error.classList.remove("hidden");
      }
      input?.select();
    } finally {
      button.disabled = false;
    }
  }

  function logout() {
    adminToken = "";
    sessionStorage.removeItem(tokenKey);
    $("adminModeBadge")?.classList.add("hidden");
    closeAdminDrawer();
  }

  function filteredVisits() {
    const visits = window.DASHBOARD_APP?.getVisits?.() || [];
    const filter = $("adminStatusFilter")?.value || "";
    const search = ($("adminSearchInput")?.value || "").trim().toLocaleLowerCase("ru");
    return visits
      .filter(visit => !filter || visit.derivedStatus === filter || visit.status === filter)
      .filter(visit => {
        if (!search) return true;
        const haystack = `${visit.id} ${visit.date} ${visit.employee} ${(visit.objects || []).join(" ")} ${visit.status}`.toLocaleLowerCase("ru");
        return haystack.includes(search);
      })
      .sort((a, b) => b.date.localeCompare(a.date) || b.id.localeCompare(a.id));
  }

  function renderAdminVisits() {
    const list = $("adminVisitList");
    if (!list || !window.DASHBOARD_APP) return;
    const visits = filteredVisits();
    $("adminVisitCount").textContent = `${visits.length} ${pluralVisits(visits.length)}`;
    if (!visits.length) {
      list.innerHTML = '<div class="empty-state">Выезды по выбранному фильтру не найдены</div>';
      return;
    }
    list.innerHTML = visits.map(visit => {
      const sync = overrideSyncInfo[visit.id]?.sync || null;
      const syncText = sync?.status === "pending"
          ? `Excel: ожидает записи${sync.error ? ` — ${sync.error}` : ""}`
          : sync?.status === "conflict"
            ? `Excel: конфликт — ${sync.error || "файл изменён параллельно"}`
          : "";
      const options = allowedStatuses.map(status =>
        `<option value="${escapeHtml(status)}"${status === visit.status ? " selected" : ""}>${escapeHtml(status)}</option>`
      ).join("");
      return `
        <article class="admin-visit-row${visit.statusOverridden ? " is-overridden" : ""}" data-admin-visit="${escapeHtml(visit.id)}">
          <div>
            <div class="admin-visit-date">${escapeHtml(formatDate(visit.date))}</div>
            <div class="admin-visit-id">${escapeHtml(visit.id)}</div>
          </div>
          <div>
            <div class="admin-visit-name">${escapeHtml((visit.objects || []).join("; "))}</div>
            <div class="admin-visit-meta">${escapeHtml(visit.employee || "Ответственный не указан")} · исходный статус: ${escapeHtml(visit.baseStatus)}</div>
            <div class="admin-status-controls">
              <select class="admin-status-select" aria-label="Статус выезда">${options}</select>
              <button class="button primary admin-save-button" type="button">${sync?.status === "pending" ? "Повторить синхронизацию" : "Сохранить"}</button>
              <button class="button secondary admin-reset-button${visit.statusOverridden ? "" : " hidden"}" type="button">Как в Excel</button>
            </div>
            <div class="admin-row-message${sync?.status === "pending" || sync?.status === "conflict" ? " error" : ""}">${escapeHtml(syncText)}</div>
          </div>
        </article>`;
    }).join("");
  }

  function setRowMessage(row, text, type = "") {
    const target = row.querySelector(".admin-row-message");
    if (!target) return;
    target.textContent = text;
    target.className = `admin-row-message${type ? ` ${type}` : ""}`;
  }

  async function saveRow(row) {
    const visitId = row.dataset.adminVisit;
    const select = row.querySelector(".admin-status-select");
    const button = row.querySelector(".admin-save-button");
    const status = select?.value;
    if (!visitId || !allowedStatuses.includes(status)) return;
    const existingOperation = overrideSyncInfo[visitId];
    const rememberedOperation = operationIds.get(visitId);
    const operationId = existingOperation?.status === status && existingOperation?.operationId
      ? existingOperation.operationId
      : rememberedOperation?.status === status
        ? rememberedOperation.id
        : newOperationId();
    operationIds.set(visitId, { id: operationId, status });
    button.disabled = true;
    button.textContent = "Сохраняем…";
    setRowMessage(row, "Скачиваем и проверяем Excel…");
    try {
      const response = await api(
        { action: "set-status", visitId, status, operationId },
        { auth: true, timeoutMs: 50000 }
      );
      overrideSyncInfo[visitId] = {
        status,
        operationId,
        updatedAt: response.updatedAt,
        sync: response.excelSync || { status: "pending", error: "Нет ответа синхронизации" }
      };
      if (response.excelSync?.status === "synced") {
        delete overrideSyncInfo[visitId];
        operationIds.delete(visitId);
        window.DASHBOARD_APP.setVisitStatusLocally(visitId, status, false);
        setRowMessage(row, "Статус сохранён в Excel на Nextcloud", "success");
        row.classList.remove("is-overridden");
        row.querySelector(".admin-reset-button")?.classList.add("hidden");
      } else {
        window.DASHBOARD_APP.setVisitStatusLocally(visitId, status, true);
        setRowMessage(
          row,
          response.excelSync?.status === "conflict"
            ? `Конфликт Excel: ${response.excelSync?.error || "файл изменён параллельно"}`
            : "Статус принят. Excel синхронизируется автоматически…",
          "error"
        );
        row.classList.add("is-overridden");
        row.querySelector(".admin-reset-button")?.classList.remove("hidden");
        if (response.excelSync?.status === "pending") {
          await waitForExcelSync(row, visitId, operationId, status);
        }
      }
    } catch (err) {
      if (err.status === 401) {
        logout();
        openLogin();
      }
      setRowMessage(row, err.message, "error");
    } finally {
      button.disabled = false;
      button.textContent = overrideSyncInfo[visitId]?.sync?.status === "pending"
        ? "Повторить синхронизацию"
        : "Сохранить";
    }
  }

  async function resetRow(row) {
    const visitId = row.dataset.adminVisit;
    const button = row.querySelector(".admin-reset-button");
    if (!visitId) return;
    button.disabled = true;
    setRowMessage(row, "Возвращаем статус из Excel…");
    try {
      await api({ action: "reset-status", visitId }, { auth: true });
      delete overrideSyncInfo[visitId];
      window.DASHBOARD_APP.resetVisitStatusLocally(visitId);
      setRowMessage(row, "Используется статус из Excel", "success");
      window.setTimeout(renderAdminVisits, 450);
    } catch (err) {
      if (err.status === 401) {
        logout();
        openLogin();
      }
      setRowMessage(row, err.message, "error");
    } finally {
      button.disabled = false;
    }
  }

  function activateHiddenTrigger() {
    clickCount += 1;
    window.clearTimeout(clickTimer);
    clickTimer = window.setTimeout(() => { clickCount = 0; }, 3200);
    if (clickCount < 5) return;
    clickCount = 0;
    const camera = $("cameraBrand");
    camera?.classList.remove("admin-triggered");
    void camera?.offsetWidth;
    camera?.classList.add("admin-triggered");
    if (adminToken) openAdminDrawer();
    else openLogin();
  }

  $("cameraBrand")?.addEventListener("click", activateHiddenTrigger);
  $("cameraBrand")?.addEventListener("keydown", event => {
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      activateHiddenTrigger();
    }
  });
  $("adminLoginSubmit")?.addEventListener("click", login);
  $("closeAdminLogin")?.addEventListener("click", closeLogin);
  $("cancelAdminLogin")?.addEventListener("click", closeLogin);
  $("adminLoginDialog")?.addEventListener("cancel", event => {
    event.preventDefault();
    closeLogin();
  });
  $("adminLoginForm")?.addEventListener("submit", event => {
    event.preventDefault();
    login();
  });
  $("closeAdminDrawer")?.addEventListener("click", closeAdminDrawer);
  $("adminBackdrop")?.addEventListener("click", closeAdminDrawer);
  $("adminLogout")?.addEventListener("click", logout);
  $("adminStatusFilter")?.addEventListener("change", renderAdminVisits);
  $("adminSearchInput")?.addEventListener("input", renderAdminVisits);
  $("adminVisitList")?.addEventListener("click", event => {
    const row = event.target.closest("[data-admin-visit]");
    if (!row) return;
    if (event.target.closest(".admin-save-button")) saveRow(row);
    if (event.target.closest(".admin-reset-button")) resetRow(row);
  });

  window.addEventListener("dashboard:ready", () => {
    appReady = true;
    loadOverrides();
  });
  if (appReady) loadOverrides();
  window.PHOTO_DASHBOARD_ASSETS ||= Object.create(null);
  window.PHOTO_DASHBOARD_ASSETS.admin = BUILD;
})();
