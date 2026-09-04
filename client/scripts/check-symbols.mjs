import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const appJsxPath = path.join(__dirname, "..", "client", "src", "App.jsx");
const src = fs.readFileSync(appJsxPath, "utf-8");

const matches = [...src.matchAll(/\b([A-Z][A-Z0-9_]{2,})\s*\[/g)].map((m) => m[1]);
const used = new Set(matches);
const missing = [...used].filter((n) => {
  const declRegex = new RegExp(`\\b(?:const|let|var)\\s+${n}\\b`);
  const propRegex = new RegExp(`\\b${n}\\s*[:,]`);
  return !declRegex.test(src) && !propRegex.test(src);
}).sort();

if (missing.length > 0) {
  console.error("UNDEFINED LOOKUP TABLES:", missing.join(", "));
  process.exit(1);
}
console.log(`symbol check: clean (${used.size} lookup tables verified)`);

// Check import.meta in App.jsx
const stripped = src
  .replace(/\/\*[\s\S]*?\*\//g, "")
  .replace(/\/\/.*$/gm, "");

if (stripped.includes("import.meta")) {
  console.error("FAIL: import.meta is not allowed in App.jsx (breaks script-mode artifact rendering)");
  process.exit(1);
}
console.log("script-mode check: no import.meta");

// Tailwind check
const html = fs.readFileSync(path.join(__dirname, "..", "client", "index.html"), "utf-8");
if (html.includes("cdn.tailwindcss.com")) {
  console.error("FAIL: client/index.html loads Tailwind from the CDN; build it instead");
  process.exit(1);
}
const mainJsx = fs.readFileSync(path.join(__dirname, "..", "client", "src", "main.jsx"), "utf-8");
if (!mainJsx.includes("index.css")) {
  console.error("FAIL: main.jsx does not import the compiled stylesheet");
  process.exit(1);
}
console.log("stylesheet check: Tailwind is compiled, not CDN");
