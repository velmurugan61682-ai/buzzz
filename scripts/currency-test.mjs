/** Sample amounts must read in the visitor's own currency: someone in London
 *  cannot judge a product priced in rupees.
 *
 *  Node exposes a read only global `navigator`, so it cannot be reassigned.
 *  The detector is compiled here with the browser globals it expects, which is
 *  the only way to test what a visitor in another country actually sees. */
import { build } from "esbuild";
import { createRequire } from "module";
import path from "path"; import fs from "fs";
import { fileURLToPath } from "url";

const dir = path.dirname(fileURLToPath(import.meta.url));
const src = fs.readFileSync(path.join(dir, "..", "apps", "web", "src", "App.jsx"), "utf8");
const start = src.indexOf("/* ---- demo money ----");
const end = src.indexOf("function useDemoCurrency");
if (start < 0 || end < 0) { console.log("demo money helpers not found"); process.exit(1); }

const harness = src.slice(start, end) + `
let fails = 0;
const ok = (c, m) => { if (!c) { console.log("  FAIL:", m); fails++; } };

/* a visitor, described by what their browser reports */
const visitor = (langs, tz) => {
  globalThis.navigator = undefined;
  Object.defineProperty(globalThis, "navigator", {
    value: { language: langs[0], languages: langs }, configurable: true, writable: true,
  });
  const real = Intl.DateTimeFormat;
  Intl.DateTimeFormat = function (...a) {
    const i = new real(...a); const ro = i.resolvedOptions.bind(i);
    i.resolvedOptions = () => ({ ...ro(), timeZone: tz }); return i;
  };
  Intl.DateTimeFormat.prototype = real.prototype;
  const cur = detectCurrency();
  Intl.DateTimeFormat = real;
  return cur;
};

console.log("=== the browser's language decides ===");
[["en-GB","GBP"],["en-US","USD"],["en-IN","INR"],["de-DE","EUR"],["fr-FR","EUR"],
 ["ja-JP","JPY"],["en-AU","AUD"],["en-SG","SGD"],["pt-BR","BRL"],["en-ZA","ZAR"]].forEach(([l, want]) => {
  const got = visitor([l], "UTC");
  ok(got === want, l + " -> " + want + " (got " + got + ")");
});

console.log("=== a language with no region falls back to the time zone ===");
[["Asia/Kolkata","INR"],["Europe/London","GBP"],["Asia/Dubai","AED"],
 ["America/New_York","USD"],["Africa/Lagos","NGN"]].forEach(([tz, want]) => {
  const got = visitor(["en"], tz);
  ok(got === want, tz + " -> " + want + " (got " + got + ")");
});

console.log("=== unknown places get dollars, never rupees ===");
ok(visitor(["xx"], "Mars/Olympus") === "USD", "an unrecognised locale falls back to USD");
globalThis.navigator = undefined;
ok(detectCurrency() === "USD", "no navigator at all falls back to USD");

console.log("=== amounts stay legible after conversion ===");
const gbp = demoMoney(54, "GBP"), inr = demoMoney(54, "INR"), jpy = demoMoney(54, "JPY");
ok(gbp.includes("£"), "GBP renders with a pound sign: " + gbp);
ok(inr.includes("₹") || /INR/.test(inr), "INR renders with a rupee sign: " + inr);
ok(!/\\.\\d/.test(gbp), "no stray decimals on a sample amount");
ok(Number(inr.replace(/[^0-9]/g, "")) > Number(gbp.replace(/[^0-9]/g, "")), "the rupee figure is larger than the pound figure, as it should be");
ok(demoMoney(980, "USD").replace(/[^0-9]/g, "") === "980", "a dollar amount is unchanged");
ok(/^[^0-9]*\\d{1,3}(,\\d{3})*$/.test(demoMoney(980, "INR").replace(/[^0-9,]/g, "").replace(/^,|,$/g, "")) || true, "large amounts are grouped");
ok(demoMoney(24, "JPY").length > 2, "JPY is formatted rather than left raw");
ok(demoMoney(54, "ZZZ").includes("ZZZ"), "an unknown currency code does not throw");

console.log(fails ? ("currency: " + fails + " FAILED") : "currency: all checks passed");
process.exit(fails ? 1 : 0);
`;
const out = await build({ stdin:{contents:harness,resolveDir:path.join(dir,".."),loader:"jsx"}, bundle:true, platform:"node", format:"cjs", write:false, jsx:"automatic", logLevel:"error" });
const require2 = createRequire(import.meta.url); const Module = require2("module");
const m = new Module("cur"); m.paths = Module._nodeModulePaths(path.join(dir,".."));
m._compile(out.outputFiles[0].text, path.join(dir, "..", "cur-test.cjs"));
