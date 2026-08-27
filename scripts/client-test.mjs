/**
 * Browser-accurate test: mounts the app with react-dom/client inside jsdom so
 * useEffect actually runs, then fires the events a real user produces.
 * The SSR render test cannot catch effect-time errors; this can.
 */
import { build } from "esbuild";
import { createRequire } from "module";
import path from "path";
import { fileURLToPath } from "url";
const dir = path.dirname(fileURLToPath(import.meta.url));
const entry = path.join(dir, "..", "apps", "web", "src", "App.jsx");

const harness = `
const { JSDOM } = require("jsdom");
const dom = new JSDOM("<!doctype html><html><body><div id='root'></div></body></html>", { pretendToBeVisual: true, url: "http://localhost/" });
global.window = dom.window; global.document = dom.window.document;
global.HTMLElement = dom.window.HTMLElement; global.Element = dom.window.Element; global.Node = dom.window.Node;
global.requestAnimationFrame = (cb) => setTimeout(cb, 0); global.cancelAnimationFrame = clearTimeout;
global.IS_REACT_ACT_ENVIRONMENT = true;
dom.window.Element.prototype.scrollIntoView = function () {};  // jsdom lacks it

const React = require("react");
const { createRoot } = require("react-dom/client");
const { act } = require("react");
const App = require(${JSON.stringify(entry)}).default;

const errors = [];
const orig = console.error;
console.error = (...a) => { const m = a.map(String).join(" "); if (!/not wrapped in act|useLayoutEffect does nothing/.test(m)) errors.push(m); };

(async () => {
  const root = createRoot(document.getElementById("root"));
  await act(async () => { root.render(React.createElement(React.StrictMode, null, React.createElement(App, { __session: { user: { id: "u1", email: "t@e.com" }, next: { screen: "onboarding", workspaceId: "w1" } } }))); });
  console.log("client mount with effects:", "OK");

  // the event that crashed the artifact: keydown with no key property
  const ev = new dom.window.KeyboardEvent("keydown", { bubbles: true });
  Object.defineProperty(ev, "key", { get: () => undefined });
  await act(async () => { dom.window.dispatchEvent(ev); });
  console.log("keydown with undefined key :", "survived");

  // Ctrl+K and Escape still work
  await act(async () => {
    dom.window.dispatchEvent(new dom.window.KeyboardEvent("keydown", { key: "k", ctrlKey: true, bubbles: true }));
    dom.window.dispatchEvent(new dom.window.KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
  });
  console.log("ctrl+k and escape          :", "survived");

  // ctrl held WITH an undefined key — the only path that reaches toLowerCase
  const ev2 = new dom.window.KeyboardEvent("keydown", { ctrlKey: true, bubbles: true });
  Object.defineProperty(ev2, "key", { get: () => undefined });
  await act(async () => { dom.window.dispatchEvent(ev2); });
  console.log("ctrl + undefined key       :", "survived");

  // let every interval-based effect fire at least once
  await act(async () => { await new Promise((r) => setTimeout(r, 100)); });

  console.error = orig;
  const real = errors.filter((e) => /undefined|not a function|Cannot read/.test(e));
  if (real.length) { console.error("RUNTIME ERRORS:", real[0].slice(0, 300)); process.exit(1); }
  console.log("no runtime errors");
  process.exit(0);
})();
`;
const out = await build({
  stdin: { contents: harness, resolveDir: path.join(dir, ".."), loader: "js" },
  bundle: true, platform: "node", format: "cjs", write: false,
  jsx: "automatic", loader: { ".jsx": "jsx" }, external: ["jsdom"], logLevel: "error",
});
const require2 = createRequire(import.meta.url);
const Module = require2("module");
const m = new Module("client-test");
m.paths = Module._nodeModulePaths(path.join(dir, ".."));
m._compile(out.outputFiles[0].text, path.join(dir, "..", "client-test.cjs"));
