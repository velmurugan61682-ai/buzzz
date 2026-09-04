/** Drives onboarding to completion, then exercises the workspace that loads after. */
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

const React = require("react");
const { createRoot } = require("react-dom/client");
const { act } = require("react");
const App = require(${JSON.stringify(entry)}).default;

const errors = [];
const orig = console.error;
console.error = (...a) => { const m = a.map(String).join(" "); if (!/not wrapped in act|useLayoutEffect/.test(m)) errors.push(m); };
const logs = [];
const origLog = console.log;

const type = async (text) => {
  const inputs = [...document.querySelectorAll("input")];
  const input = inputs.find((i) => /Tell me about your business/i.test(i.getAttribute("placeholder") || "")) || inputs[inputs.length - 1];
  if (!input) { console.log("  no input found"); return; }
  await act(async () => {
    const setter = Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, "value").set;
    setter.call(input, text);
    input.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
    input.dispatchEvent(new dom.window.KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }));
  });
  await act(async () => { await new Promise((r) => setTimeout(r, 700)); });
};
const clickText = async (label) => {
  const btn = [...document.querySelectorAll("button")].find((b) => (b.textContent || "").includes(label));
  if (!btn) return false;
  await act(async () => { btn.dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true })); });
  await act(async () => { await new Promise((r) => setTimeout(r, 800)); });
  return true;
};

(async () => {
  const root = createRoot(document.getElementById("root"));
  await act(async () => { root.render(React.createElement(App, { __session: { user: { id: "u1", email: "t@e.com" }, next: { screen: "onboarding", workspaceId: "w1" } } })); });
  console.log("1 onboarding mounted:", document.body.textContent.includes("I am BUZZZ"));

  /* discovery is adaptive, so answer until the plan appears rather than
     assuming a fixed number of questions */
  const answers = ["we run a dental clinic", "cleanings and implants for local families",
    "we keep missing calls and get no shows", "whatsapp mostly", "just me and two nurses",
    "patients call or whatsapp, about 60 a week", "reception books them, no shows we lose",
    "price and timings, clinical goes to a dentist", "reminder calls take forever",
    "draft them for me first", "our website and a price list", "9 to 6"];
  for (const a of answers) {
    if (document.body.textContent.includes("Build my workspace")) break;
    await type(a);
  }
  await act(async () => { await new Promise((r) => setTimeout(r, 1200)); });
  await act(async () => { await new Promise((r) => setTimeout(r, 1200)); });
  console.log("   placeholders:", [...document.querySelectorAll("input")].map((i) => i.getAttribute("placeholder")).join(" | "));
  console.log("   messages:", document.querySelectorAll(".rounded-2xl").length);
  const bubbles = [...document.querySelectorAll("div")].map((d) => d.textContent).filter((t) => t && t.length < 200);
  console.log("   last exchanges:");
  [...new Set(bubbles)].slice(-8).forEach((t) => console.log("     ", t.replace(/\s+/g, " ").slice(0, 120)));
  console.log("2 plan offered:", document.body.textContent.includes("Build my workspace"));

  const built = await clickText("Build my workspace");
  console.log("   building card shown:", document.body.textContent.includes("Creating your agents"));
  console.log("3 build clicked:", built);
  await act(async () => { await new Promise((r) => setTimeout(r, 3600)); });
  const snap = document.body.textContent.replace(/\s+/g," ");
  ["did not complete","could not finish","paused for your review","Provisioning"].forEach((p2) => { const at = snap.indexOf(p2); if (at>=0) console.log("   TOAST:", snap.slice(at-60, at+140)); });
  await act(async () => { await new Promise((r) => setTimeout(r, 900)); });
  console.log("4 workspace loaded:", !document.body.textContent.includes("I am BUZZZ"));
  const txt = document.body.textContent.replace(/\s+/g," ");
  const idx = txt.indexOf("could not finish");
  console.log("   failure message:", idx >= 0 ? txt.slice(idx-40, idx+160) : "(none shown)");
  console.log("   all console errors:", errors.length ? errors[0].slice(0,300) : "none");
  const toastTxt = document.body.textContent.replace(/\s+/g," ");
  ["Setup could not finish","paused for your review","agents and","Provisioning blocked"].forEach((probe) => {
    const at = toastTxt.indexOf(probe);
    if (at >= 0) console.log("   found:", toastTxt.slice(at, at + 130));
  });

  console.error = orig;
  const real = errors.filter((e) => /Cannot read|undefined|not a function/.test(e));
  if (real.length) { console.log("RUNTIME ERROR AFTER ONBOARDING:"); console.log(real[0].slice(0, 500)); process.exit(1); }
  console.log("no runtime errors through the full flow");
  process.exit(0);
})();
`;
const out = await build({ stdin:{contents:harness,resolveDir:path.join(dir,".."),loader:"js"}, bundle:true, platform:"node", format:"cjs", write:false, jsx:"automatic", loader:{".jsx":"jsx"}, external:["jsdom"], logLevel:"error" });
const require2 = createRequire(import.meta.url); const Module = require2("module");
const m = new Module("flow"); m.paths = Module._nodeModulePaths(path.join(dir,".."));
m._compile(out.outputFiles[0].text, path.join(dir,"..","flow-test.cjs"));
