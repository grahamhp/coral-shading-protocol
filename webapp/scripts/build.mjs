// Build the app into ONE offline HTML file: dist/index.html.
// No Vite/esbuild/Rollup: TypeScript's own transpiler (in-process) turns each module into CommonJS, and a
// tiny registry links them. Leaflet, the Inter font, styles and all data (light tables, coral presets,
// Sipaway example, references) are inlined, so the file opens from a double-click with no server.
import { readFileSync, writeFileSync, mkdirSync, statSync } from "node:fs";
import { dirname, resolve, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

const WEB = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SRC = resolve(WEB, "src");
const SHARED = resolve(WEB, "..", "shared");
const NM = resolve(WEB, "node_modules");
const read = (p) => readFileSync(p, "utf8");
const id = (abs) => relative(SRC, abs).split(sep).join("/");

function bundle(entry) {
  const mods = new Map();
  const visit = (file) => {
    if (mods.has(file)) return;
    mods.set(file, "");
    const src = read(file);
    const out = ts.transpileModule(src, {
      fileName: file,
      compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, verbatimModuleSyntax: false, isolatedModules: true, removeComments: false },
    }).outputText;
    const linked = out.replace(/require\("(\.{1,2}\/[^"]+)"\)/g, (_, p) => {
      const dep = resolve(dirname(file), p);
      visit(dep);
      return `__r(${JSON.stringify(id(dep))})`;
    });
    mods.set(file, linked);
  };
  visit(entry);
  const defs = [...mods].map(([f, code]) => `__m[${JSON.stringify(id(f))}]=function(require,module,exports){${code}\n};`).join("\n");
  return `(function(){"use strict";var __m={},__c={};function __r(k){var c=__c[k];if(c)return c.exports;var mod={exports:{}};__c[k]=mod;__m[k](__r,mod,mod.exports);return mod.exports}\n${defs}\n__r(${JSON.stringify(id(entry))});})();`;
}

const b64 = (p) => readFileSync(p).toString("base64");
const jsonSafe = (o) => JSON.stringify(o).replace(/</g, "\\u003c");

const pkg = JSON.parse(read(resolve(WEB, "package.json")));
const worker = bundle(resolve(SRC, "ui", "worker.ts"));
const app = bundle(resolve(SRC, "ui", "app.ts"));
const boot = {
  tables: JSON.parse(read(resolve(SHARED, "tables", "light_tables.json"))),
  presets: JSON.parse(read(resolve(SHARED, "corals", "pe_presets.json"))),
  // example reefs, Sipaway first (ids as in python/src/coralshading/examples.py)
  examples: ["sipaway", "florida_keys", "belize", "bonaire", "eilat", "mombasa", "maldives", "lizard_island", "kaneohe", "moorea"]
    .map((id) => JSON.parse(read(resolve(SHARED, "examples", `${id}.json`)))),
  references: JSON.parse(read(resolve(SHARED, "references.json"))),
  workerSource: worker,
};
let leafletCss = read(resolve(NM, "leaflet", "dist", "leaflet.css"));
leafletCss = leafletCss.replace(/url\(images\/([a-z0-9-]+\.png)\)/g, (_, f) => `url(data:image/png;base64,${b64(resolve(NM, "leaflet", "dist", "images", f))})`);
const font = `@font-face{font-family:"Inter";font-style:normal;font-display:swap;font-weight:100 900;src:url(data:font/woff2;base64,${b64(resolve(NM, "@fontsource-variable", "inter", "files", "inter-latin-wght-normal.woff2"))}) format("woff2-variations")}`;
const css = font + "\n" + leafletCss + "\n" + read(resolve(SRC, "ui", "styles.css"));
const html = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Coral Shading Protocol v${pkg.version}</title>
<meta name="description" content="Plan coral shading for heat stress: size a shade cloth or a midday canopy for your reef and see the light your corals receive, day by day.">
<style id="css">${css}</style>
</head><body><noscript>This app needs JavaScript.</noscript>
<script>${read(resolve(NM, "leaflet", "dist", "leaflet.js"))}</script>
<script type="application/json" id="boot">${jsonSafe(boot)}</script>
<script>var CSP_BOOT=JSON.parse(document.getElementById("boot").textContent);</script>
<script>${app}</script>
</body></html>`;
mkdirSync(resolve(WEB, "dist"), { recursive: true });
const outp = resolve(WEB, "dist", "index.html");
writeFileSync(outp, html);
console.log(`wrote ${outp} (${(statSync(outp).size / 1e6).toFixed(2)} MB; app ${(app.length / 1e3).toFixed(0)} kB, worker ${(worker.length / 1e3).toFixed(0)} kB)`);
