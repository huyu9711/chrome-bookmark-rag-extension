import fs from "node:fs";
import path from "node:path";

const root = process.cwd();
const distDir = path.join(root, "dist");
const manifestPath = path.join(distDir, "manifest.json");

function fail(msg) {
  console.error(`ERROR: ${msg}`);
  process.exit(1);
}

if (!fs.existsSync(distDir)) {
  fail("dist/ does not exist. Run `npm run build` first.");
}

if (!fs.existsSync(manifestPath)) {
  fail("dist/manifest.json not found.");
}

let manifest;
try {
  manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
} catch (e) {
  fail(`Invalid dist/manifest.json: ${e instanceof Error ? e.message : String(e)}`);
}

const required = [];

const sw = manifest?.background?.service_worker;
if (typeof sw === "string" && sw.trim()) required.push(sw);

const optionsPage = manifest?.options_ui?.page;
if (typeof optionsPage === "string" && optionsPage.trim()) required.push(optionsPage);

const sidePanelPath = manifest?.side_panel?.default_path;
if (typeof sidePanelPath === "string" && sidePanelPath.trim()) required.push(sidePanelPath);

if (required.length === 0) {
  fail("No required manifest paths found to validate.");
}

for (const rel of required) {
  const target = path.join(distDir, rel);
  if (!fs.existsSync(target)) {
    fail(`Missing required file in dist package: ${rel}`);
  }
}

console.log("Web Store package validation passed.");
console.log(`Validated files: ${required.join(", ")}`);
