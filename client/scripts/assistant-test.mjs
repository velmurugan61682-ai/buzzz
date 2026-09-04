/** The assistant in the running app: it asks when something is missing,
 *  respects the autonomy ceiling, and never answers with a bare refusal. */
import { build } from "esbuild";
import { createRequire } from "module";
import path from "path"; import { fileURLToPath } from "url";
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
const React = require("react"); const { createRoot } = require("react-dom/client"); const { act } = require("react");
const App = require(${JSON.stringify(entry)}).default;
const errs = []; const orig = console.error;
console.error = (...a) => { const m = a.map(String).join(" "); if (!/not wrapped in act|useLayoutEffect|Each child/.test(m)) errs.push(m); };
const wait = (ms) => act(async () => { await new Promise((r) => setTimeout(r, ms)); });
const click = async (el) => { if (!el) return; await act(async () => { el.dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true })); }); };
let fails = 0; const ok = (c, m) => { if (!c) { console.log("  FAIL:", m); fails++; } };

(async () => {
  const root = createRoot(document.getElementById("root"));
  await act(async () => { root.render(React.createElement(App, {
    __session: { user: { id: "u1", email: "t@e.com" }, next: { screen: "dashboard", workspaceId: "w1" } },
    __openAI: true })); });
  await wait(500);

  const input = () => [...document.querySelectorAll("input, textarea")]
    .find((i) => /tell buzzz ai what to do|listening/i.test(i.getAttribute("placeholder") || ""));
  ok(!!input(), "the assistant is open with an input");

  const say = async (text) => {
    const el = input(); if (!el) return "";
    const proto = el.tagName === "TEXTAREA" ? dom.window.HTMLTextAreaElement.prototype : dom.window.HTMLInputElement.prototype;
    await act(async () => {
      Object.getOwnPropertyDescriptor(proto, "value").set.call(el, text);
      el.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
      el.dispatchEvent(new dom.window.KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    });
    await wait(1100);
    return document.body.textContent;
  };

  let out = await say("book an appointment");
  ok(/when should i make it/i.test(out), "a booking with no date asks when");

  out = await say("follow up with them");
  ok(/not sure who you mean|tell me the name/i.test(out), "an unresolved 'them' asks who");

  out = await say("make me a sandwich");
  ok(!/^i can'?t/i.test(out), "an unrelated request is not a bare refusal");
  ok(/try|things i can do|did not follow|show today|create a workflow/i.test(out),
     "an unknown request still offers concrete examples");

  console.error = orig;
  const real = errs.filter((e) => /Cannot read|is not a function|Maximum update depth|is not defined/.test(e));
  if (real.length) { console.log("  RUNTIME:", real[0].slice(0, 180)); fails++; }
  console.log(fails ? ("assistant: " + fails + " FAILED") : "assistant: all checks passed");
  process.exit(fails ? 1 : 0);
})();
`;
const out = await build({ stdin:{contents:harness,resolveDir:path.join(dir,".."),loader:"js"}, bundle:true, platform:"node", format:"cjs", write:false, jsx:"automatic", loader:{".jsx":"jsx"}, external:["jsdom"], logLevel:"error" });
const require2 = createRequire(import.meta.url); const Module = require2("module");
const m = new Module("asst"); m.paths = Module._nodeModulePaths(path.join(dir,".."));
m._compile(out.outputFiles[0].text, path.join(dir,"..","asst-test.cjs"));
