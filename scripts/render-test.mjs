/**
 * Render every view, with the assistant closed and open.
 * This catches the failure class that repeatedly escaped a default-screen render:
 * constants and context values used only inside tabs, modals and drawers.
 */
import { build } from "esbuild";
import { createRequire } from "module";
import path from "path";
import { fileURLToPath } from "url";

const dir = path.dirname(fileURLToPath(import.meta.url));
const entry = path.join(dir, "..", "client", "src", "App.jsx");

const VIEWS = ["home","inbox","crm","agents","library","approvals","activity","automations",
  "campaigns","calls","knowledge","analytics","integrations","settings","appointments","social","admin","revenue"];

const harness = `
import React from "react";
import { renderToString } from "react-dom/server";
import App from ${JSON.stringify(entry)};
const views = ${JSON.stringify(VIEWS)};
let failures = 0;
for (const v of views) {
  for (const ai of [false, true]) {
    try { renderToString(React.createElement(App, { __session: { user: { id: "u1", email: "t@e.com" }, next: { screen: "dashboard", workspaceId: "w1" } }, __initialView: v, __openAI: ai })); }
    catch (e) { console.error("FAIL", v, ai ? "(assistant open)" : "", e.message); failures++; }
  }
}
if (failures) { console.error(failures + " render failures"); process.exit(1); }
console.log("render test: " + (views.length * 2) + " renders passed");
`;

const out = await build({
  stdin: { contents: harness, resolveDir: dir, loader: "jsx" },
  bundle: true, platform: "node", format: "cjs", write: false,
  jsx: "automatic", loader: { ".jsx": "jsx" }, logLevel: "error",
});
const require = createRequire(import.meta.url);
const Module = require("module");
const m = new Module("render-test");
m._compile(out.outputFiles[0].text, "render-test.cjs");
