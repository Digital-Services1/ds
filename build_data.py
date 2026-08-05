#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Build the local-preview data.v207.js from dashboard_data.xlsx.

The browser no longer needs SheetJS or any other Excel-reading CDN. Run this
script after replacing dashboard_data.xlsx, or use UPDATE_SOURCE_EXCEL.bat.
"""
from __future__ import annotations

import json
import math
import os
import re
import sys
import zipfile
from datetime import date, datetime, timedelta, timezone
from pathlib import Path
import xml.etree.ElementTree as ET

ROOT = Path(__file__).resolve().parent
SOURCE_FILE = ROOT / "dashboard_data.xlsx"
OUTPUT_FILE = ROOT / "data.v207.js"

MAIN_NS = "http://schemas.openxmlformats.org/spreadsheetml/2006/main"
DOC_REL_NS = "http://schemas.openxmlformats.org/officeDocument/2006/relationships"
PKG_REL_NS = "http://schemas.openxmlformats.org/package/2006/relationships"
NS = {"m": MAIN_NS, "r": DOC_REL_NS}
CELL_REF_RE = re.compile(r"^([A-Z]+)(\d+)$")


def clean(value) -> str:
    if value is None:
        return ""
    if isinstance(value, bool):
        return "Да" if value else "Нет"
    if isinstance(value, float) and value.is_integer():
        return str(int(value))
    return str(value).strip()


def number_or_none(value):
    if value is None or value == "":
        return None
    if isinstance(value, (int, float)) and not isinstance(value, bool):
        if isinstance(value, float) and not math.isfinite(value):
            return None
        return value
    text = clean(value).replace("\u00a0", "").replace(" ", "").replace(",", ".")
    try:
        result = float(text)
    except (TypeError, ValueError):
        return None
    return int(result) if result.is_integer() else result


def is_yes(value) -> bool:
    return clean(value).lower() in {"да", "yes", "true", "1"}


def base_name(value) -> str:
    text = clean(value)
    if not text:
        return ""
    return re.split(r"[\\/]", text)[-1]


def resolve_photo_file(object_id: str, source_value) -> str:
    """Return the canonical Nextcloud file name for an object.

    The Excel source still contains historical local PNG paths. The deployed
    dashboard does not read those paths: public photos are stored in Nextcloud
    as OBJ_###.jpg. Keeping the canonical name here prevents PREVIEW_LOCAL.bat
    and UPDATE_SOURCE_EXCEL.bat from silently switching photo support off.
    """
    if re.fullmatch(r"OBJ_\d{3}", object_id, flags=re.IGNORECASE):
        return f"{object_id.upper()}.jpg"
    source_name = base_name(source_value)
    return source_name or ""


def normalize_object_key(value) -> str:
    text = clean(value).lower()
    text = re.sub(r"^ст\.?\s+", "", text)
    text = re.sub(r"[«»\"']", "", text)
    return re.sub(r"\s+", " ", text).strip()


def excel_serial_to_iso(value) -> str:
    number = number_or_none(value)
    if number is None:
        return ""
    try:
        # Excel's 1900 date system, including the historical leap-year quirk.
        result = datetime(1899, 12, 30) + timedelta(days=float(number))
        return result.date().isoformat()
    except (OverflowError, ValueError):
        return ""


def date_to_iso(value) -> str:
    if isinstance(value, datetime):
        return value.date().isoformat()
    if isinstance(value, date):
        return value.isoformat()
    if isinstance(value, (int, float)) and not isinstance(value, bool):
        return excel_serial_to_iso(value)
    text = clean(value)
    if not text:
        return ""
    match = re.match(r"^(\d{4})-(\d{2})-(\d{2})", text)
    if match:
        return f"{match.group(1)}-{match.group(2)}-{match.group(3)}"
    match = re.match(r"^(\d{1,2})[./-](\d{1,2})[./-](\d{4})$", text)
    if match:
        return f"{match.group(3)}-{int(match.group(2)):02d}-{int(match.group(1)):02d}"
    return ""


def column_number(ref: str) -> int:
    match = CELL_REF_RE.match(ref)
    if not match:
        return 0
    value = 0
    for char in match.group(1):
        value = value * 26 + (ord(char) - 64)
    return value


class SimpleXlsx:
    def __init__(self, path: Path):
        self.path = path
        self.archive = zipfile.ZipFile(path)
        self.shared_strings = self._read_shared_strings()
        self.sheet_paths = self._read_sheet_paths()
        self._sheet_cache: dict[str, dict[str, object]] = {}
        self._row_cache: dict[str, list[tuple[int, dict[int, object]]]] = {}

    def close(self):
        self.archive.close()

    def _read_shared_strings(self) -> list[str]:
        try:
            root = ET.fromstring(self.archive.read("xl/sharedStrings.xml"))
        except KeyError:
            return []
        values = []
        for item in root.findall("m:si", NS):
            values.append("".join(node.text or "" for node in item.findall(".//m:t", NS)))
        return values

    def _read_sheet_paths(self) -> dict[str, str]:
        workbook = ET.fromstring(self.archive.read("xl/workbook.xml"))
        relationships = ET.fromstring(self.archive.read("xl/_rels/workbook.xml.rels"))
        relation_map = {
            relation.attrib["Id"]: relation.attrib["Target"]
            for relation in relationships.findall(f"{{{PKG_REL_NS}}}Relationship")
        }
        result = {}
        for sheet in workbook.findall(".//m:sheet", NS):
            relation_id = sheet.attrib[f"{{{DOC_REL_NS}}}id"]
            target = relation_map[relation_id].replace("\\", "/")
            if target.startswith("/"):
                target = target.lstrip("/")
            elif not target.startswith("xl/"):
                target = "xl/" + target
            result[sheet.attrib["name"]] = target
        return result

    def _cell_value(self, cell: ET.Element):
        cell_type = cell.attrib.get("t", "")
        value_node = cell.find("m:v", NS)
        raw = value_node.text if value_node is not None else None

        if cell_type == "inlineStr":
            inline = cell.find("m:is", NS)
            return "" if inline is None else "".join(n.text or "" for n in inline.findall(".//m:t", NS))
        if raw is None:
            return None
        if cell_type == "s":
            try:
                return self.shared_strings[int(raw)]
            except (ValueError, IndexError):
                return raw
        if cell_type in {"str", "e"}:
            return raw
        if cell_type == "b":
            return raw == "1"

        try:
            number = float(raw)
        except ValueError:
            return raw
        return int(number) if number.is_integer() else number

    def rows(self, sheet_name: str) -> list[tuple[int, dict[int, object]]]:
        if sheet_name in self._row_cache:
            return self._row_cache[sheet_name]
        path = self.sheet_paths.get(sheet_name)
        if not path:
            raise KeyError(f"В Excel отсутствует лист «{sheet_name}».")
        root = ET.fromstring(self.archive.read(path))
        rows: list[tuple[int, dict[int, object]]] = []
        for row in root.findall(".//m:sheetData/m:row", NS):
            row_number = int(row.attrib.get("r", "0") or 0)
            cells: dict[int, object] = {}
            for cell in row.findall("m:c", NS):
                ref = cell.attrib.get("r", "")
                col = column_number(ref)
                if col:
                    cells[col] = self._cell_value(cell)
            rows.append((row_number, cells))
        self._row_cache[sheet_name] = rows
        return rows

    def cell(self, sheet_name: str, ref: str):
        match = CELL_REF_RE.match(ref.upper())
        if not match:
            return None
        col = column_number(ref.upper())
        row_target = int(match.group(2))
        for row_number, cells in self.rows(sheet_name):
            if row_number == row_target:
                return cells.get(col)
        return None

    def table_rows(self, sheet_name: str, header_row: int = 4) -> list[dict[str, object]]:
        headers: dict[int, str] = {}
        rows = self.rows(sheet_name)
        for row_number, cells in rows:
            if row_number == header_row:
                headers = {col: clean(value) for col, value in cells.items() if clean(value)}
                break
        if not headers:
            raise ValueError(f"На листе «{sheet_name}» не найдена строка заголовков {header_row}.")

        output = []
        for row_number, cells in rows:
            if row_number <= header_row:
                continue
            item = {header: cells.get(col) for col, header in headers.items()}
            if any(value not in (None, "") for value in item.values()):
                output.append(item)
        return output


def build_dashboard_data(source_path: Path) -> dict:
    workbook = SimpleXlsx(source_path)
    try:
        object_rows = workbook.table_rows("Объекты")
        visit_rows = workbook.table_rows("Выезды")
        period_start = date_to_iso(workbook.cell("План недели", "B4"))
        period_end = date_to_iso(workbook.cell("План недели", "D4"))
    finally:
        workbook.close()

    objects = []
    for row in object_rows:
        object_id = clean(row.get("OBJECT_ID"))
        object_name = clean(row.get("OBJECT_NAME"))
        if not object_id or not object_name:
            continue
        objects.append({
            "id": object_id,
            "name": object_name,
            "pointsCount": number_or_none(row.get("POINTS_COUNT")),
            "group": clean(row.get("OBJECT_GROUP")) or "Другие объекты",
            "type": clean(row.get("OBJECT_TYPE")) or "Другой объект",
            "address": clean(row.get("ADDRESS")) or None,
            "lat": number_or_none(row.get("LATITUDE")),
            "lon": number_or_none(row.get("LONGITUDE")),
            "mapUrl": clean(row.get("YANDEX_MAP_URL")) or None,
            "albumUrl": clean(row.get("ALBUM_URL")) or None,
            "photoFile": resolve_photo_file(object_id, row.get("PHOTO_PATH")),
            "active": is_yes(row.get("IS_ACTIVE")),
            "comment": clean(row.get("COMMENT")) or None,
        })

    object_by_name = {item["name"]: item for item in objects}
    object_by_key = {}
    for item in objects:
        object_by_key[normalize_object_key(item["name"])] = item
        object_by_key[normalize_object_key(item["id"])] = item

    def resolve_object(raw_name):
        name = clean(raw_name)
        if not name:
            return None
        return object_by_name.get(name) or object_by_key.get(normalize_object_key(name))

    visits = []
    for index, row in enumerate(visit_rows, start=1):
        source_name = clean(row.get("OBJECTS"))
        if not source_name:
            continue
        obj = resolve_object(source_name)
        canonical_name = obj["name"] if obj else source_name
        visit_date = date_to_iso(row.get("VISIT_DATE"))
        if not visit_date:
            continue
        visit_id = clean(row.get("VISIT_ID")) or f"VIS_{visit_date.replace('-', '')}_{index:03d}"
        points = number_or_none(row.get("Количество точек"))
        if points is None:
            points = obj.get("pointsCount") if obj else 0
        visits.append({
            "id": visit_id,
            "date": visit_date,
            "employee": clean(row.get("EMPLOYEE")),
            "objects": [canonical_name],
            "status": clean(row.get("STATUS")),
            "comment": clean(row.get("COMMENT")) or None,
            "workType": clean(row.get("WORK_TYPE")) or "Фотопанорамная съёмка",
            "pointsCount": points or 0,
        })

    stat = source_path.stat()
    modified = datetime.fromtimestamp(stat.st_mtime, tz=timezone.utc).isoformat().replace("+00:00", "Z")
    return {
        "meta": {
            "version": f"{stat.st_mtime_ns}-{stat.st_size}",
            "refreshSeconds": 30,
            "sourceFile": source_path.name,
            "sourceUpdatedAt": modified,
            "lastSuccessfulSyncAt": modified,
            "sourceStatus": "local",
            "sourceLabel": "Локальная резервная копия",
            "liveSync": False,
            "reportPeriodStart": period_start,
            "reportPeriodEnd": period_end,
        },
        "objects": objects,
        "visits": visits,
    }


def validate_dashboard_data(data: dict) -> list[str]:
    errors: list[str] = []
    objects = data.get("objects") or []
    visits = data.get("visits") or []

    object_ids = [str(item.get("id") or "") for item in objects]
    object_names = [str(item.get("name") or "") for item in objects]
    visit_ids = [str(item.get("id") or "") for item in visits]

    def duplicates(values: list[str]) -> list[str]:
        seen: set[str] = set()
        repeated: set[str] = set()
        for value in values:
            if value in seen:
                repeated.add(value)
            seen.add(value)
        return sorted(value for value in repeated if value)

    for label, values in (("OBJECT_ID", object_ids), ("OBJECT_NAME", object_names), ("VISIT_ID", visit_ids)):
        repeated = duplicates(values)
        if repeated:
            errors.append(f"Дублируются {label}: {', '.join(repeated)}")

    known_statuses = {"Запланирован", "Выполнен", "Перенесён", "Отменён", "Завершено"}
    known_objects = set(object_names)
    for item in objects:
        object_id = str(item.get("id") or "")
        if not re.fullmatch(r"OBJ_\d{3}", object_id):
            errors.append(f"Некорректный OBJECT_ID: {object_id or '<пусто>'}")
        if item.get("photoFile") != f"{object_id}.jpg":
            errors.append(f"Некорректное имя фото для {object_id}: {item.get('photoFile')}")
        lat, lon = item.get("lat"), item.get("lon")
        if lat is None or lon is None or not (-90 <= float(lat) <= 90) or not (-180 <= float(lon) <= 180):
            errors.append(f"Некорректные координаты объекта {object_id}")

    for visit in visits:
        visit_id = str(visit.get("id") or "")
        status = str(visit.get("status") or "")
        if status not in known_statuses:
            errors.append(f"Неизвестный статус в {visit_id}: {status or '<пусто>'}")
        for object_name in visit.get("objects") or []:
            if object_name not in known_objects:
                errors.append(f"В {visit_id} указан неизвестный объект: {object_name}")

    return errors


def main() -> int:
    if not SOURCE_FILE.exists():
        print(f"Ошибка: не найден файл {SOURCE_FILE.name}", file=sys.stderr)
        return 1
    try:
        data = build_dashboard_data(SOURCE_FILE)
    except Exception as exc:
        print(f"Ошибка чтения Excel: {exc}", file=sys.stderr)
        return 1

    validation_errors = validate_dashboard_data(data)
    if validation_errors:
        print("Ошибка проверки данных:", file=sys.stderr)
        for item in validation_errors:
            print(f"- {item}", file=sys.stderr)
        return 1

    payload = json.dumps(data, ensure_ascii=False, separators=(",", ":"))
    OUTPUT_FILE.write_text(
        "// Generated automatically from dashboard_data.xlsx. Do not edit manually.\n"
        f"window.DASHBOARD_DATA={payload};\n",
        encoding="utf-8",
    )

    allowed = {"Выполнен", "Запланирован"}
    start = data["meta"].get("reportPeriodStart") or ""
    end = data["meta"].get("reportPeriodEnd") or ""
    report_visits = [
        item for item in data["visits"]
        if item.get("status") in allowed and start <= item.get("date", "") < end
    ] if start and end else []
    front = sum(float(item.get("pointsCount") or 0) for item in report_visits)
    front_text = str(int(front)) if front.is_integer() else str(front)
    print(f"Источник обработан: объектов {len(data['objects'])}, выездов {len(data['visits'])}.")
    print(f"До штаба: снято объектов {len(report_visits)}, фронт работ {front_text}.")
    print(f"Создан файл: {OUTPUT_FILE.name}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
