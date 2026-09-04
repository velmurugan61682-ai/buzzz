/** Clicks through every view after onboarding and fires the interactions
 *  that static analysis cannot reach: tabs, buttons, inputs, modals. */
import { build } from "esbuild";
import { createRequire } from "module";
import path from "path";
import { fileURLToPath } from "url";
const dir = path.dirname(fileURLToPath(import.meta.url));
const entry = path.join(dir, "..", "client", "src", "App.jsx");
const harness = `
const { JSDOM } = require("jsdom");
const dom = new JSDOM("<!doctype html><html><body><div id='root'></div></body></html>", { pretendToBeVisual: true, url: "http://localhost/" });
global.window = dom.window; global.document = dom.window.document;
global.HTMLElement = dom.window.HTMLElement; global.Element = dom.window.Element; global.Node = dom.window.Node;
global.requestAnimationFrame = (cb) => setTimeout(cb, 0); global.cancelAnimationFrame = clearTimeout;
global.IS_REACT_ACT_ENVIRONMENT = true;
dom.window.Element.prototype.scrollIntoView = function () {};
dom.window.HTMLCanvasElement.prototype.getContext = () => null;

const React = require("react");
const { createRoot } = require("react-dom/client");
const { act } = require("react");
const App = require(${JSON.stringify(entry)}).default;

const errors = [];
const orig = console.error;
console.error = (...a) => { const m = a.map(String).join(" "); if (!/not wrapped in act|useLayoutEffect|Each child in a list/.test(m)) errors.push(m); };
const wait = (ms) => act(async () => { await new Promise((r) => setTimeout(r, ms)); });
const click = async (el) => { await act(async () => { el.dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true })); }); };
const byText = (t) => [...document.querySelectorAll("button")].find((b) => (b.textContent || "").trim() === t);

(async () => {
  const root = createRoot(document.getElementById("root"));
  await act(async () => { root.render(React.createElement(App, { __session: { user: { id: "u1", email: "t@e.com" }, next: { screen: "onboarding", workspaceId: "w1" } } })); });

  // complete onboarding
  const type = async (text) => {
    const input = [...document.querySelectorAll("input")].find((i) => /Tell me about your business/i.test(i.getAttribute("placeholder") || ""));
    if (!input) return;
    await act(async () => {
      Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, "value").set.call(input, text);
      input.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
      input.dispatchEvent(new dom.window.KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    });
    await wait(650);
  };
  for (const t of ["we run a dental clinic", "we keep missing calls", "whatsapp mostly", "just me and two nurses", "three of us"]) {
    if (document.body.textContent.includes("Build my workspace")) break;
    await type(t);
  }
  const build = byText("Build my workspace") || [...document.querySelectorAll("button")].find((b) => (b.textContent||"").includes("Build my workspace"));
  if (build) { await click(build); await wait(4500); }
  console.log("onboarding completed:", !document.body.textContent.includes("Build my workspace"));

  // visit every nav item and click every tab inside it
  const navButtons = () => [...document.querySelectorAll("button")].filter((b) => b.textContent && b.textContent.length < 24);
  const views = ["Home","Inbox","CRM","Revenue","Appointments","Social","Campaigns","Calls","Agents","Agent Library","Automations","Knowledge","Approvals","Analytics","AI Activity","Integrations","Settings","Operations"];
  let visited = 0, tabClicks = 0;
  for (const v of views) {
    const nav = navButtons().find((b) => b.textContent.trim() === v);
    if (!nav) continue;
    await click(nav); await wait(120); visited++;
    // click through the tabs on this screen
    const tabs = [...document.querySelectorAll("button")].filter((b) => { const t=(b.textContent||"").trim(); return t && t.length<20 && !views.includes(t); }).slice(0, 12);
    for (const t of tabs) { try { await click(t); await wait(60); tabClicks++; } catch (e) {} }
  }
  console.log("views visited:", visited, "| tab/button clicks:", tabClicks);

  await wait(500);
  console.error = orig;
  const real = errors.filter((e) => /Cannot read|is not a function|undefined is not|Maximum update depth|Rendered more hooks/.test(e));
  if (real.length) {
    console.log("DEFECTS FOUND:", real.length);
    [...new Set(real.map((e) => e.split("\\n")[0].slice(0, 180)))].slice(0, 8).forEach((e) => console.log("  -", e));
    process.exit(1);
  }
  console.log("deep interaction: no runtime errors");
  process.exit(0);
})();
`;
const out = await build({ stdin:{contents:harness,resolveDir:path.join(dir,".."),loader:"js"}, bundle:true, platform:"node", format:"cjs", write:false, jsx:"automatic", loader:{".jsx":"jsx"}, external:["jsdom"], logLevel:"error" });
const require2 = createRequire(import.meta.url); const Module = require2("module");
const m = new Module("deep"); m.paths = Module._nodeModulePaths(path.join(dir,".."));
m._compile(out.outputFiles[0].text, path.join(dir,"..","deep-test.cjs"));
