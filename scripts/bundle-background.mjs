/**
 * Emit a single-file ES module service worker. Multi-chunk SW graphs from Vite/Rollup
 * often cause "Service worker registration failed. Status code: 11" in Chrome.
 */
import * as esbuild from "esbuild";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(__dirname, "..");

await esbuild.build({
  entryPoints: [path.join(root, "src/background/index.ts")],
  bundle: true,
  outfile: path.join(root, "dist/background.js"),
  format: "esm",
  platform: "browser",
  target: "es2022",
  allowOverwrite: true,
  logLevel: "info",
});

const manifestPath = path.join(root, "dist/manifest.json");
const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
manifest.background = {
  service_worker: "background.js",
  type: "module",
};
fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + "\n");

const loader = path.join(root, "dist/service-worker-loader.js");
if (fs.existsSync(loader)) {
  fs.unlinkSync(loader);
}

console.log("Wrote dist/background.js and updated manifest (single-file service worker).");
