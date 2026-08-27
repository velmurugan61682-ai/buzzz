/**
 * Builds the standalone admin console preview.
 *
 * Two traps this script exists to avoid, both of which broke a shipped file:
 *   1. Splicing a bundle into HTML by searching for "<script>" — React's own
 *      minified source contains that string, so the splice cut the bundle in
 *      half and the page died with a syntax error. The file is written whole.
 *   2. A bundle containing "</script>" ends the tag early; the slash is escaped.
 * It also inlines the compiled stylesheet rather than loading the Tailwind CDN,
 * which warns in the console and is not meant for anything but prototyping.
 */
import { build } from "esbuild";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const dir = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(dir, "..");
const out = process.argv[2] || "/mnt/user-data/outputs/buzzz_admin_console.html";

const bundle = await build({
  entryPoints: [path.join(root, "apps/web/src/admin-preview.jsx")],
  bundle: true, format: "iife", jsx: "automatic", minify: true, write: false,
  loader: { ".jsx": "jsx" }, define: { "process.env.NODE_ENV": '"production"' },
  logLevel: "error",
});
const js = bundle.outputFiles[0].text.replace(/<\/script>/g, "<\\/script>");

const cssDir = path.join(root, "apps/web/dist/assets");
const cssFile = fs.existsSync(cssDir) && fs.readdirSync(cssDir).find((f) => f.endsWith(".css"));
if (!cssFile) {
  console.error("No compiled stylesheet found. Run `npm run build` first so the preview is styled.");
  process.exit(1);
}
const css = fs.readFileSync(path.join(cssDir, cssFile), "utf8");

const html = `<!doctype html>
<html lang="en"><head><meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>BUZZZ — internal operations console</title>
<link href="https://fonts.googleapis.com/css2?family=Space+Grotesk:wght@500;600;700&family=Inter:wght@400;500;600;700&display=swap" rel="stylesheet" />
<style>${css}</style>
<style>body{margin:0;background:#08090A}.bz-display{font-family:'Space Grotesk',sans-serif}</style>
</head><body><div id="root"></div>
<script>window.BUZZZ_API_BASE = "";</script>
<script>${js}</script></body></html>`;

fs.writeFileSync(out, html);

/* fail loudly rather than shipping a broken file */
const problems = [];
if (html.includes("cdn.tailwindcss.com")) problems.push("the Tailwind CDN is still referenced");
if ((html.match(/<\/script>/g) || []).length !== 2) problems.push("the bundle contains an unescaped </script>");
if (!html.includes("<style>")) problems.push("no stylesheet was inlined");
if (problems.length) { console.error("preview is not shippable: " + problems.join("; ")); process.exit(1); }

console.log(`admin preview written: ${Math.round(html.length / 1024)} KB, styles inlined, no CDN`);
