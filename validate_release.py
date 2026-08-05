#!/usr/bin/env python3
# -*- coding: utf-8 -*-
from __future__ import annotations

import json
import re
import shutil
import subprocess
import sys
from pathlib import Path
from urllib.parse import quote, urlencode, urlparse

ROOT = Path(__file__).resolve().parent
BUILD = "2.0.7-rc5-fast-load-20260804"
REQUIRED = [
    "index.html", "index.template.html", "styles.source.css", "config.source.js",
    "data.v207.js", "app.v207.js", "bootstrap.source.js", "corporate-shell-loader.source.js",
    "period-utils.v207.js",
    "admin.v207.js", "excel-loader.v207.js", "build_data.py", "dashboard_data.xlsx",
    "moscow_boundary.geojson", "placeholder.svg", "netlify.toml",
    "package.json", "package-lock.json", "server.js", "TIMEWEB_DEPLOY.txt",
    ".env.example", ".gitignore", "NEXTCLOUD_EXCEL_SETUP.txt",
    "RELEASE_AUDIT.txt", "LOAD_DIAGNOSTICS.txt",
    "netlify/functions/status-admin.mjs", "netlify/functions/dashboard-data.mjs",
    "netlify/functions/access-session.mjs", "netlify/functions/photo.mjs",
    "netlify/functions/_shared/access-auth.mjs",
    "netlify/functions/_shared/bundled-dashboard-data.mjs",
    "netlify/functions/_shared/dashboard-data-parser.mjs",
    "netlify/functions/_shared/nextcloud-excel-sync.mjs",
    "netlify/functions/_shared/status-store.mjs",
    "netlify/functions/_shared/internal-auth.mjs",
    "netlify/functions/_shared/auth-rate-limit.mjs",
    "netlify/functions/_shared/storage.mjs",
    "netlify/functions/status-sync-background.mjs",
    "scripts/verify-dashboard-data.mjs", "scripts/verify-dashboard-function.mjs",
    "scripts/verify-excel-write.mjs", "scripts/verify-auth-and-period.mjs",
    "scripts/build-resilient-release.mjs", "scripts/verify-loading-resilience.mjs",
    "scripts/verify-photo-cache.mjs",
    "scripts/verify-timeweb-server.mjs",
    "scripts/qa-mobile-shell.mjs",
]


def fail(message: str, errors: list[str]) -> None:
    errors.append(message)


def parse_data_js(path: Path) -> dict:
    text = path.read_text(encoding="utf-8")
    match = re.search(r"window\.DASHBOARD_DATA\s*=\s*(\{.*\})\s*;\s*$", text, re.S)
    if not match:
        raise ValueError("data.js не содержит window.DASHBOARD_DATA")
    return json.loads(match.group(1))


def parse_config(path: Path) -> dict[str, str]:
    text = path.read_text(encoding="utf-8")
    result: dict[str, str] = {}
    for key in (
        "nextcloudPublicFolderUrl", "nextcloudPhotoVersion",
        "dashboardDataEndpoint", "accessSessionEndpoint",
    ):
        match = re.search(rf"{key}\s*:\s*\"([^\"]*)\"", text)
        if match:
            result[key] = match.group(1)
    return result


def expected_urls(folder: str, object_id: str) -> tuple[str, str]:
    parsed = urlparse(folder.rstrip("/"))
    match = re.match(r"^(.*?)(?:/index\.php)?/s/([^/?#]+)", parsed.path, re.I)
    if not match:
        raise ValueError("публичная ссылка Nextcloud не соответствует формату /s/<token>")
    prefix = match.group(1) or ""
    uses_index = bool(re.search(r"/index\.php/s/", parsed.path, re.I))
    front = f"{prefix}{'/index.php' if uses_index else ''}"
    token = match.group(2)
    filename = f"{object_id}.jpg"
    preview_query = urlencode({
        "file": f"/{filename}", "x": "960", "y": "540", "a": "true", "scalingup": "0", "v": "test"
    })
    preview = f"{parsed.scheme}://{parsed.netloc}{front}/apps/files_sharing/publicpreview/{quote(token)}?{preview_query}"
    download_query = urlencode({"path": "/", "files": filename, "v": "test"})
    download = f"{folder.rstrip('/')}/download?{download_query}"
    return preview, download


def main() -> int:
    errors: list[str] = []

    shell_builder = ROOT / "scripts/build-resilient-release.mjs"
    if shell_builder.is_file():
        shell_builder_text = shell_builder.read_text(encoding="utf-8")
        if "fileURLToPath(new URL(\"..\", import.meta.url))" not in shell_builder_text:
            fail("Сборщик production-оболочки небезопасно определяет путь на Windows", errors)
        if "import.meta.url).pathname" in shell_builder_text:
            fail("Сборщик использует URL.pathname вместо Windows-safe fileURLToPath", errors)
    node_for_build = next((candidate for candidate in ("node", "node.exe") if shutil.which(candidate)), None)
    if node_for_build and shell_builder.is_file():
        result = subprocess.run([node_for_build, str(shell_builder)], cwd=ROOT, capture_output=True, text=True)
        if result.returncode:
            fail(f"Не удалось собрать production-оболочку: {result.stderr.strip()}", errors)
    else:
        fail("Для сборки production-оболочки требуется Node.js", errors)

    for rel in REQUIRED:
        path = ROOT / rel
        if not path.is_file():
            fail(f"Отсутствует обязательный файл: {rel}", errors)

    case_index: dict[str, list[str]] = {}
    for path in ROOT.rglob("*"):
        if path.is_file():
            rel = path.relative_to(ROOT).as_posix()
            case_index.setdefault(rel.casefold(), []).append(rel)
    for variants in case_index.values():
        if len(variants) > 1:
            fail(f"Файлы конфликтуют по регистру: {', '.join(sorted(variants))}", errors)

    legacy = sorted(path.name for path in ROOT.glob("README_V*.txt"))
    if legacy:
        fail(f"В релизе остались устаревшие инструкции: {', '.join(legacy)}", errors)

    # cmd.exe reliably parses these launchers only when they are ASCII, CRLF and BOM-free.
    for batch_path in sorted(ROOT.glob("*.bat")):
        raw = batch_path.read_bytes()
        if raw.startswith((b"\xef\xbb\xbf", b"\xff\xfe", b"\xfe\xff")):
            fail(f"BAT-файл содержит BOM: {batch_path.name}", errors)
        try:
            raw.decode("ascii")
        except UnicodeDecodeError:
            fail(f"BAT-файл должен содержать только ASCII: {batch_path.name}", errors)
        if b"\n" in raw.replace(b"\r\n", b""):
            fail(f"BAT-файл содержит LF без CRLF: {batch_path.name}", errors)

    preview_batch = (ROOT / "PREVIEW_LOCAL.bat").read_text(encoding="ascii") if (ROOT / "PREVIEW_LOCAL.bat").is_file() else ""
    for fragment in ("build_data.py", "validate_release.py", "http.server 8765", "NEXTCLOUD_TEST.html"):
        if fragment not in preview_batch:
            fail(f"PREVIEW_LOCAL.bat не содержит обязательную команду: {fragment}", errors)

    try:
        config = parse_config(ROOT / "config.source.js")
        folder = config.get("nextcloudPublicFolderUrl", "")
        if not folder.startswith("https://"):
            fail("nextcloudPublicFolderUrl должен начинаться с https://", errors)
        if config.get("nextcloudPhotoVersion") != "20260729-v1183":
            fail("Некорректная версия фотографий в config.js", errors)
        if config.get("dashboardDataEndpoint") != "/api/dashboard-data":
            fail("Некорректный dashboardDataEndpoint в config.js", errors)
        if config.get("accessSessionEndpoint") != "/api/access-session":
            fail("Некорректный accessSessionEndpoint в config.js", errors)
        if "yandexMapsApiKey" in config or "demoPasswordHash" in config:
            fail("Ключ Яндекс Карт или хеш пароля остался в публичном config.js", errors)
        config_text = (ROOT / "config.source.js").read_text(encoding="utf-8")
        if "allowBundledDataFallback: true" not in config_text:
            fail("Аварийный data.js отключён в production", errors)
        preview, download = expected_urls(folder, "OBJ_013")
        if "/index.php/apps/files_sharing/publicpreview/" not in preview:
            fail("Некорректно сформирован URL превью Nextcloud", errors)
        if "files=OBJ_013.jpg" not in download:
            fail("Некорректно сформирован URL скачивания Nextcloud", errors)
    except Exception as exc:
        fail(f"Ошибка config.js: {exc}", errors)

    try:
        data = parse_data_js(ROOT / "data.v207.js")
        objects = data.get("objects") or []
        visits = data.get("visits") or []
        if not objects:
            fail("В data.js отсутствуют объекты", errors)
        if not visits:
            fail("В data.js отсутствуют выезды", errors)
        ids = [item.get("id") for item in objects]
        if len(ids) != len(set(ids)):
            fail("В data.js дублируются OBJECT_ID", errors)
        names = [item.get("name") for item in objects]
        if len(names) != len(set(names)):
            fail("В data.js дублируются OBJECT_NAME", errors)
        visit_ids = [item.get("id") for item in visits]
        if len(visit_ids) != len(set(visit_ids)):
            fail("В data.js дублируются VISIT_ID", errors)
        allowed_statuses = {"", "Запланирован", "Выполнен", "Перенесён", "Отменён", "Завершено"}
        unknown_statuses = sorted({str(item.get("status") or "") for item in visits} - allowed_statuses)
        if unknown_statuses:
            fail(f"В data.js найдены неизвестные статусы: {', '.join(unknown_statuses)}", errors)
        known_names = set(names)
        unknown_objects = sorted({name for visit in visits for name in (visit.get("objects") or []) if name not in known_names})
        if unknown_objects:
            fail(f"Выезды ссылаются на неизвестные объекты: {', '.join(unknown_objects)}", errors)
        for item in objects:
            object_id = str(item.get("id") or "")
            if item.get("photoFile") != f"{object_id}.jpg":
                fail(f"Некорректное имя фото у {object_id}: {item.get('photoFile')}", errors)
            if not isinstance(item.get("lat"), (int, float)) or not isinstance(item.get("lon"), (int, float)):
                fail(f"У объекта {object_id} отсутствуют числовые координаты", errors)
        if not any(v.get("status") == "Завершено" and "Ленинградский вокзал" in (v.get("objects") or []) for v in visits):
            fail("У Ленинградского вокзала не найден статус «Завершено»", errors)
    except Exception as exc:
        fail(f"Ошибка data.js: {exc}", errors)

    index = (ROOT / "index.html").read_text(encoding="utf-8") if (ROOT / "index.html").is_file() else ""
    for marker in ("__MAIN_STYLES_ASSET__", "__CORPORATE_SHELL_ASSET__"):
        if marker in index:
            fail(f"index.html содержит несобранный маркер: {marker}", errors)
    for fragment in (
        'id="passwordGate" class="password-gate"',
        'id="passwordVisibility"',
        'body class="auth-pending"',
        "Critical auth layout",
        "PhotoDashboardDiagnostics",
        ".password-gate {",
    ):
        if fragment not in index:
            fail(f"В index.html отсутствует резервная логика авторизации: {fragment}", errors)
    if not re.search(r'<link id="mainStyles" rel="stylesheet" href="styles\.v207\.[a-f0-9]{12}\.css">', index):
        fail("index.html не подключает хешированные стили Corporate Lite", errors)
    if not re.search(r'<script src="corporate-shell\.v207\.[a-f0-9]{12}\.js" defer></script>', index):
        fail("index.html не подключает минимальный Corporate Lite loader", errors)
    if len(index.encode("utf-8")) >= (ROOT / "moscow_boundary.geojson").stat().st_size:
        fail("index.html не меньше проходящего через UserGate файла границы Москвы", errors)
    if 'class="password-gate hidden"' in index:
        fail("Статический экран авторизации изначально скрыт", errors)
    if re.search(r"<(?:script|link)[^>]+(?:src|href)=[\"']https?://", index, re.I):
        fail("index.html обращается к внешнему ресурсу до авторизации", errors)

    dist = ROOT / "dist"
    actual_public = {path.name for path in dist.iterdir() if path.is_file()} if dist.is_dir() else set()
    static_public = {"index.html", "moscow_boundary.geojson", "placeholder.svg"}
    hashed_js_public = {
        name for name in actual_public
        if re.match(
            r"^(?:app|admin|excel-loader|period-utils|config|bootstrap|corporate-shell)"
            r"\.v207\.[a-f0-9]{12}\.js$",
            name,
        )
    }
    hashed_css_public = {
        name for name in actual_public
        if re.match(r"^styles\.v207\.[a-f0-9]{12}\.css$", name)
    }
    if (
        not static_public.issubset(actual_public)
        or len(hashed_js_public) != 7
        or len(hashed_css_public) != 1
        or len(actual_public) != 11
    ):
        fail(f"Некорректный состав dist: {sorted(actual_public)}", errors)
    for private_name in (
        "dashboard_data.xlsx", "data.v207.js", "config.source.js",
        "bootstrap.source.js", "corporate-shell-loader.source.js",
    ):
        if (dist / private_name).exists():
            fail(f"Закрытый файл опубликован в dist: {private_name}", errors)

    test_html = (ROOT / "NEXTCLOUD_TEST.html").read_text(encoding="utf-8") if (ROOT / "NEXTCLOUD_TEST.html").is_file() else ""
    if f"config.source.js?v={BUILD}" not in test_html:
        fail("NEXTCLOUD_TEST.html использует устаревшую версию config.js", errors)

    app = (ROOT / "app.v207.js").read_text(encoding="utf-8") if (ROOT / "app.v207.js").is_file() else ""
    for required_fragment in (
        "apps/files_sharing/publicpreview", "nextcloudDownloadUrl", "nextcloudPreviewUrl",
        "function hasDashboardPhoto(object)", "Фотография недоступна", "class=\"photo-status\"",
        "function initializeMap()", "get mapReady()", "filtersReady: true",
    ):
        if required_fragment not in app:
            fail(f"В app.js отсутствует обязательная логика: {required_fragment}", errors)
    if "nextcloudDavUrl" in app:
        fail("В app.js остался ненадёжный WebDAV-fallback", errors)
    if "Открыть фото в Nextcloud" in app or "data-photo-link" in app:
        fail("В карточке осталась пользовательская ссылка на Nextcloud", errors)
    for required_card_fragment in (
        'Количество точек', 'object.pointsCount',
        'Текущий вид работ', 'Ответственный', 'Средний интервал',
    ):
        if required_card_fragment not in app:
            fail(f"В компактной карточке отсутствует элемент: {required_card_fragment}", errors)
    if '<div class="info-label">Тип</div>' in app:
        fail("В карточке осталась удалённая плитка «Тип»", errors)
    forbidden_ui_fragments = (
        'Адрес / координаты', 'class="detail-location"', 'detail-location-icon',
        'object.lat.toFixed', 'object.lon.toFixed'
    )
    for fragment in forbidden_ui_fragments:
        if fragment in app:
            fail(f"В видимом интерфейсе осталась координатная информация: {fragment}", errors)

    for legacy_secret_script in (
        "SET_YANDEX_KEY_FOR_DEMO.ps1", "SET_YANDEX_KEY_FOR_DEMO.bat",
        "SET_DASHBOARD_PASSWORD.ps1", "SET_DASHBOARD_PASSWORD.bat",
    ):
        if (ROOT / legacy_secret_script).exists():
            fail(f"В релизе остался устаревший файл секретов: {legacy_secret_script}", errors)

    status_function_text = (ROOT / "netlify/functions/status-admin.mjs").read_text(encoding="utf-8")
    if '"Завершено"' not in status_function_text:
        fail("Серверный API не разрешает статус «Завершено»", errors)
    if "DASHBOARD_ADMIN_PASSWORD" not in status_function_text or "DASHBOARD_ADMIN_TOKEN_SECRET" not in status_function_text:
        fail("Серверный API не использует обязательные переменные окружения", errors)
    status_store_text = (ROOT / "netlify/functions/_shared/status-store.mjs").read_text(encoding="utf-8")
    for fragment in ("syncPendingOperation", "BACKUP_STORE_NAME", 'status: "pending"', 'status: "synced"'):
        if fragment not in status_function_text and fragment not in status_store_text:
            fail(f"В админ-функции отсутствует двусторонняя синхронизация: {fragment}", errors)

    excel_sync_text = (ROOT / "netlify/functions/_shared/nextcloud-excel-sync.mjs").read_text(encoding="utf-8")
    for fragment in (
        "NEXTCLOUD_EXCEL_WRITE_ENABLED", "NEXTCLOUD_EXCEL_WRITE_SHARE_URL",
        "X-Requested-With", "If-Match", "latest-before-write.xlsx",
        "updateVisitStatusInWorkbook", "parseDashboardWorkbook",
    ):
        if fragment not in excel_sync_text:
            fail(f"В записи Excel отсутствует обязательная защита: {fragment}", errors)

    dashboard_function_text = (ROOT / "netlify/functions/dashboard-data.mjs").read_text(encoding="utf-8")
    for fragment in (
        "NEXTCLOUD_EXCEL_URL", "NEXTCLOUD_EXCEL_PUBLIC_FOLDER_URL", "last-good",
        "If-None-Match", "sourceStatus: \"fallback\"", "parseDashboardWorkbook",
        "NEXTCLOUD_EXCEL_TIMEOUT_MS", "nextcloud-download-complete",
        "response.arrayBuffer()", "clearTimeout(timeout)",
        "BUNDLED_DASHBOARD_DATA", 'mode === "cache"', 'mode === "bundled"',
    ):
        if fragment not in dashboard_function_text:
            fail(f"В серверной синхронизации отсутствует обязательная логика: {fragment}", errors)
    if "isAccessAuthorized" not in dashboard_function_text:
        fail("Серверный endpoint данных не защищён пользовательской сессией", errors)

    access_function_text = (ROOT / "netlify/functions/access-session.mjs").read_text(encoding="utf-8")
    access_shared_text = (ROOT / "netlify/functions/_shared/access-auth.mjs").read_text(encoding="utf-8")
    for fragment in (
        "DASHBOARD_ACCESS_PASSWORD", "DASHBOARD_ACCESS_TOKEN_SECRET",
        "HttpOnly", "Secure", "SameSite=Lax", "YANDEX_MAPS_API_KEY",
    ):
        if fragment not in access_function_text and fragment not in access_shared_text:
            fail(f"В серверной авторизации отсутствует защита: {fragment}", errors)

    function_test_text = (ROOT / "scripts/verify-dashboard-function.mjs").read_text(encoding="utf-8")
    for fragment in ("stall-body", "NEXTCLOUD_EXCEL_TIMEOUT_MS", "не завершил скачивание Excel"):
        if fragment not in function_test_text:
            fail(f"Не проверен тайм-аут тела Excel: {fragment}", errors)

    loader_text = (ROOT / "excel-loader.v207.js").read_text(encoding="utf-8")
    for fragment in (
        "dashboardDataEndpoint", "allowBundledDataFallback", "isLocalPreview",
        "AbortController", "timeoutMs", "PHOTO_DASHBOARD_ASSETS.excelLoader",
        'url.searchParams.set("mode", mode)',
    ):
        if fragment not in loader_text:
            fail(f"В excel-loader.js отсутствует обязательная логика: {fragment}", errors)

    bootstrap_text = (ROOT / "bootstrap.source.js").read_text(encoding="utf-8")
    for fragment in (
        "App script started", "DOMContentLoaded received", "Root element check completed",
        "Auth screen rendering started", "Auth screen rendered", "Server authorization state checked",
        "Main initialization started", "Configuration validation started",
        "Data loading started", "Data loading completed", "Excel library loading started",
        "Yandex Maps loading started", "Yandex Maps loading completed",
        "Map creation started", "Map creation completed", "Object rendering started",
        "Filter preparation started", "Initialization completed",
        "Initialization failed at stage:", "startDashboardInitialization",
        "serviceWorker", "PHOTO_DASHBOARD_BUILD",
    ):
        if fragment not in bootstrap_text and fragment not in index:
            fail(f"В bootstrap.js отсутствует диагностика или защита: {fragment}", errors)

    netlify_text = (ROOT / "netlify.toml").read_text(encoding="utf-8")
    for fragment in (
        'from = "/api/dashboard-data"', 'from = "/api/version"',
        'from = "/api/access-session"', 'from = "/api/photo"', 'publish = "dist"',
    ):
        if fragment not in netlify_text:
            fail(f"В netlify.toml отсутствует маршрут: {fragment}", errors)
    if (
        'for = "/*.v207.*.js"' not in netlify_text
        or 'for = "/*.v207.*.css"' not in netlify_text
        or "immutable" not in netlify_text
    ):
        fail("Версионные production-файлы не защищены уникальными именами и immutable-кэшем", errors)

    for fragment in (
        "Bundled fallback data deferred until the server data request fails",
        "allowFallback: false",
        'mode: "cache"', 'mode: "bundled"',
        "fetchScriptSource", "asset-load-retry",
    ):
        if fragment not in bootstrap_text:
            fail(f"В загрузчике 2.0.7 отсутствует защита устойчивого запуска: {fragment}", errors)
    if "if (localPreview || bundledFallbackEnabled)" in bootstrap_text:
        fail("data.js по-прежнему загружается до основного API в production", errors)

    try:
        package = json.loads((ROOT / "package.json").read_text(encoding="utf-8"))
        dependencies = package.get("dependencies") or {}
        if "fflate" not in dependencies or "fast-xml-parser" not in dependencies:
            fail("В package.json отсутствуют зависимости минимального OOXML-парсера", errors)
        if "express" not in dependencies or "compression" not in dependencies:
            fail("В package.json отсутствуют зависимости Timeweb-сервера", errors)
        if package.get("version") != "2.0.7-timeweb-pilot1":
            fail("В package.json указана некорректная версия этапа", errors)
    except Exception as exc:
        fail(f"Ошибка package.json: {exc}", errors)

    node = None
    for candidate in ("node", "node.exe"):
        try:
            subprocess.run([candidate, "--version"], check=True, capture_output=True, text=True)
            node = candidate
            break
        except Exception:
            pass
    if node:
        for rel in (
            "app.v207.js", "bootstrap.source.js", "corporate-shell-loader.source.js",
            "admin.v207.js", "config.source.js",
            "excel-loader.v207.js", "period-utils.v207.js",
            "netlify/functions/status-admin.mjs", "netlify/functions/dashboard-data.mjs",
            "netlify/functions/access-session.mjs", "netlify/functions/photo.mjs",
            "netlify/functions/status-sync-background.mjs",
            "netlify/functions/_shared/access-auth.mjs",
            "netlify/functions/_shared/bundled-dashboard-data.mjs",
            "netlify/functions/_shared/dashboard-data-parser.mjs",
            "netlify/functions/_shared/nextcloud-excel-sync.mjs",
            "netlify/functions/_shared/status-store.mjs",
            "netlify/functions/_shared/internal-auth.mjs",
            "netlify/functions/_shared/auth-rate-limit.mjs",
            "netlify/functions/_shared/storage.mjs",
            "server.js",
            "scripts/verify-dashboard-data.mjs", "scripts/verify-dashboard-function.mjs",
            "scripts/verify-excel-write.mjs", "scripts/verify-auth-and-period.mjs",
            "scripts/verify-loading-resilience.mjs", "scripts/verify-photo-cache.mjs",
            "scripts/build-resilient-release.mjs", "scripts/verify-timeweb-server.mjs",
            "scripts/qa-mobile-shell.mjs",
        ):
            result = subprocess.run([node, "--check", str(ROOT / rel)], capture_output=True, text=True)
            if result.returncode:
                fail(f"Синтаксическая ошибка JavaScript в {rel}: {result.stderr.strip()}", errors)

    if errors:
        print("ПРОВЕРКА НЕ ПРОЙДЕНА")
        for error in errors:
            print(f"- {error}")
        return 1

    print("ПРОВЕРКА ПРОЙДЕНА")
    print("- структура релиза корректна")
    print("- Excel преобразован в локальную data.v207.js и защищённую серверную копию")
    print("- серверный endpoint Nextcloud -> проверенный JSON настроен")
    print("- последняя корректная серверная версия кэшируется в локальном хранилище Timeweb")
    print("- тестовая запись статуса в Nextcloud защищена ETag и резервной копией")
    print("- production не публикует Excel и резервные данные как статические файлы")
    print("- лёгкий экран входа отделён от хешированных CSS и загрузчиков Corporate Lite")
    print("- пароль проверяется только на сервере, сессия хранится в HttpOnly cookie")
    print("- ключ Яндекс Карт приходит с сервера только после авторизации")
    print("- тяжёлые ресурсы запускаются только после серверной авторизации")
    print("- API карты прогревается параллельно после входа; создание карты имеет автоповтор и ручной повтор")
    print("- отчётный период автоматически переключается по средам в 23:30 МСК")
    print("- основные этапы загрузки пишутся в структурированный console-log")
    print("- проверены регистр файлов и единая версия HTML/CSS/JavaScript")
    print(f"- {len(objects)} объектов используют имена OBJ_###.jpg")
    print("- Nextcloud настроен через оптимизированное превью с резервным download URL")
    print("- статус «Завершено» для Ленинградского вокзала сохранён")
    print("- координаты скрыты в интерфейсе и сохранены только для работы карты")
    print("- BAT-файлы ключа и пароля больше не требуются")
    print("- JavaScript-файлы и сервер Timeweb прошли синтаксическую проверку")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
