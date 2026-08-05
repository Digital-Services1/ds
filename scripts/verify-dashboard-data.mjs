import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { deepStrictEqual } from "node:assert";
import { parseDashboardWorkbook } from "../netlify/functions/_shared/dashboard-data-parser.mjs";

const sourcePath = resolve(process.cwd(), "dashboard_data.xlsx");
const bundledPath = resolve(process.cwd(), "data.v207.js");
const buffer = await readFile(sourcePath);
const bundledText = await readFile(bundledPath, "utf8");
const bundledMatch = bundledText.match(/window\.DASHBOARD_DATA\s*=\s*(\{.*\})\s*;\s*$/s);
if (!bundledMatch) throw new Error("data.js не содержит window.DASHBOARD_DATA.");
const bundledData = JSON.parse(bundledMatch[1]);
const result = await parseDashboardWorkbook(buffer, {
  version: "local-verification",
  sourceFile: "dashboard_data.xlsx",
  sourceUpdatedAt: new Date().toISOString(),
  lastSuccessfulSyncAt: new Date().toISOString()
});

if (result.errors.length) {
  console.error("ПРОВЕРКА СЕРВЕРНОГО ПАРСЕРА НЕ ПРОЙДЕНА");
  for (const error of result.errors) console.error(`- ${error}`);
  process.exitCode = 1;
} else {
  deepStrictEqual(result.data.objects, bundledData.objects);
  deepStrictEqual(result.data.visits, bundledData.visits);
  deepStrictEqual(result.data.meta.reportPeriodStart, bundledData.meta.reportPeriodStart);
  deepStrictEqual(result.data.meta.reportPeriodEnd, bundledData.meta.reportPeriodEnd);
  console.log("ПРОВЕРКА СЕРВЕРНОГО ПАРСЕРА ПРОЙДЕНА");
  console.log(`- объектов: ${result.data.objects.length}`);
  console.log(`- выездов: ${result.data.visits.length}`);
  console.log("- результат совпадает с локальным build_data.py");
  console.log(`- предупреждений: ${result.warnings.length}`);
}
