import { cp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

// fileURLToPath is required here: URL.pathname leaves Windows drive letters
// and non-ASCII folder names in URL form (for example /C:/.../%D0%94...),
// which resolve() can turn into an invalid C:\\C:\\... path.
const root = fileURLToPath(new URL("..", import.meta.url));
const dist = resolve(root, "dist");

const [template, styles, config, bootstrapSource, corporateShellSource, localData] = await Promise.all([
  readFile(resolve(root, "index.template.html"), "utf8"),
  readFile(resolve(root, "styles.source.css"), "utf8"),
  readFile(resolve(root, "config.source.js"), "utf8"),
  readFile(resolve(root, "bootstrap.source.js"), "utf8"),
  readFile(resolve(root, "corporate-shell-loader.source.js"), "utf8"),
  readFile(resolve(root, "data.v207.js"), "utf8")
]);

const dataMatch = localData.match(/window\.DASHBOARD_DATA\s*=\s*(\{[\s\S]*\})\s*;\s*$/);
if (!dataMatch) throw new Error("data.v207.js does not contain window.DASHBOARD_DATA.");
const parsedData = JSON.parse(dataMatch[1]);

function hashedTarget(file, source) {
  const hash = createHash("sha256").update(source).digest("hex").slice(0, 12);
  const extensionIndex = file.lastIndexOf(".");
  return `${file.slice(0, extensionIndex)}.${hash}${file.slice(extensionIndex)}`;
}

const assetSources = new Map();
for (const file of ["app.v207.js", "admin.v207.js", "excel-loader.v207.js", "period-utils.v207.js"]) {
  const source = await readFile(resolve(root, file));
  assetSources.set(file, { source, target: hashedTarget(file, source) });
}

let bootstrap = bootstrapSource;
for (const [sourceName, { target }] of assetSources) {
  bootstrap = bootstrap.replaceAll(sourceName, target);
}

const corporateAssets = new Map([
  ["styles.v207.css", { source: styles }],
  ["config.v207.js", { source: config }],
  ["bootstrap.v207.js", { source: bootstrap }]
]);
for (const [file, item] of corporateAssets) {
  item.target = hashedTarget(file, item.source);
}

let corporateShell = corporateShellSource;
corporateShell = corporateShell
  .replaceAll("__APP_CONFIG_ASSET__", corporateAssets.get("config.v207.js").target)
  .replaceAll("__BOOTSTRAP_ASSET__", corporateAssets.get("bootstrap.v207.js").target);
corporateAssets.set("corporate-shell.v207.js", {
  source: corporateShell,
  target: hashedTarget("corporate-shell.v207.js", corporateShell)
});

const replacements = new Map([
  ["__MAIN_STYLES_ASSET__", corporateAssets.get("styles.v207.css").target],
  ["__CORPORATE_SHELL_ASSET__", corporateAssets.get("corporate-shell.v207.js").target]
]);

let index = template;
for (const [marker, value] of replacements) {
  if (!index.includes(marker)) throw new Error(`Missing release marker: ${marker}`);
  index = index.replaceAll(marker, value);
}

await writeFile(resolve(root, "index.html"), index, "utf8");
await writeFile(
  resolve(root, "netlify/functions/_shared/bundled-dashboard-data.mjs"),
  `// Generated from dashboard_data.xlsx. Served only by the authenticated function.\n` +
    `export const BUNDLED_DASHBOARD_DATA = ${JSON.stringify(parsedData)};\n`,
  "utf8"
);

await rm(dist, { recursive: true, force: true });
await mkdir(dist, { recursive: true });

const staticFiles = ["index.html", "moscow_boundary.geojson", "placeholder.svg"];
for (const file of staticFiles) {
  await cp(resolve(root, file), resolve(dist, file));
}
for (const { source, target } of assetSources.values()) {
  await writeFile(resolve(dist, target), source);
}
for (const { source, target } of corporateAssets.values()) {
  await writeFile(resolve(dist, target), source);
}

console.log(
  `Production shell built: ${Buffer.byteLength(index, "utf8")} bytes, ` +
  `${staticFiles.length + assetSources.size + corporateAssets.size} public files.`
);
console.log(
  `Hashed assets: ${[...assetSources.values(), ...corporateAssets.values()]
    .map(item => item.target).join(", ")}`
);
