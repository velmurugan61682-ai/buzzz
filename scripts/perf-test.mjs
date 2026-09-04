/** Performance: the landing page must not attach a listener per component,
 *  must idle at zero work, and must stop animating when nobody is looking. */
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
global.IS_REACT_ACT_ENVIRONMENT = true;
dom.window.Element.prototype.scrollIntoView = function () {};
dom.window.HTMLCanvasElement.prototype.getContext = () => null;

/* count what the page attaches and how often it asks for a frame */
let rafCalls = 0, intervals = 0;
const listeners = {};
const realAdd = dom.window.addEventListener.bind(dom.window);
dom.window.addEventListener = (t, f, o) => { listeners[t] = (listeners[t] || 0) + 1; return realAdd(t, f, o); };
global.requestAnimationFrame = (cb) => { rafCalls++; return setTimeout(cb, 16); };
global.cancelAnimationFrame = clearTimeout;
const realSetInterval = global.setInterval;
global.setInterval = (...a) => { intervals++; return realSetInterval(...a); };
dom.window.matchMedia = (q) => ({ matches: /pointer: fine/.test(q), addEventListener(){}, removeEventListener(){}, addListener(){}, removeListener(){} });

const React = require("react"); const { createRoot } = require("react-dom/client"); const { act } = require("react");
const App = require(${JSON.stringify(entry)}).default;
let fails = 0; const ok = (c, m) => { if (!c) { console.log("  FAIL:", m); fails++; } };

(async () => {
  const root = createRoot(document.getElementById("root"));
  await act(async () => { root.render(React.createElement(App, { __session: null })); });
  await act(async () => { await new Promise((r) => setTimeout(r, 700)); });

  const pm = listeners.pointermove || 0;
  console.log("  pointermove listeners:", pm, "| scroll:", listeners.scroll || 0, "| intervals:", intervals);
  ok(pm <= 1, "at most one pointermove listener for the whole page (" + pm + ")");
  ok((listeners.scroll || 0) <= 1, "at most one scroll listener (" + (listeners.scroll || 0) + ")");

  /* with no pointer movement the page should stop asking for frames */
  const before = rafCalls;
  await act(async () => { await new Promise((r) => setTimeout(r, 400)); });
  const idleFrames = rafCalls - before;
  console.log("  frames requested while idle:", idleFrames);
  ok(idleFrames <= 2, "an idle page requests almost no frames (" + idleFrames + ")");

  /* moving the pointer should wake it, then it should settle again */
  await act(async () => {
    for (let i = 0; i < 5; i++) dom.window.dispatchEvent(new dom.window.MouseEvent("pointermove", { clientX: 100 + i * 40, clientY: 200 }));
    await new Promise((r) => setTimeout(r, 120));
  });
  const woke = rafCalls;
  ok(woke > before + idleFrames, "pointer movement wakes the animation loop");
  await act(async () => { await new Promise((r) => setTimeout(r, 500)); });
  const settled = rafCalls - woke;
  console.log("  frames after the pointer stops:", settled);
  ok(settled <= 12, "the loop settles again once the pointer stops (" + settled + ")");

  console.log(fails ? ("performance: " + fails + " FAILED") : "performance: all checks passed");
  process.exit(fails ? 1 : 0);
})();
`;
const out = await build({ stdin:{contents:harness,resolveDir:path.join(dir,".."),loader:"js"}, bundle:true, platform:"node", format:"cjs", write:false, jsx:"automatic", loader:{".jsx":"jsx"}, external:["jsdom"], logLevel:"error" });
const require2 = createRequire(import.meta.url); const Module = require2("module");
const m = new Module("perf"); m.paths = Module._nodeModulePaths(path.join(dir,".."));
m._compile(out.outputFiles[0].text, path.join(dir,"..","perf-test.cjs"));
