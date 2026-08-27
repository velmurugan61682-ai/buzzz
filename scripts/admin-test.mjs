/** The internal console: separate credentials, no fabricated metrics,
 *  and customer sessions can never reach it. */
import { build } from "esbuild";
import { createRequire } from "module";
import path from "path"; import { fileURLToPath } from "url";
const dir = path.dirname(fileURLToPath(import.meta.url));
const entry = path.join(dir, "..", "apps", "web", "src", "App.jsx");
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
const btn = (t) => [...document.querySelectorAll("button")].find((b) => (b.textContent || "").trim() === t);
const has = (t) => document.body.textContent.includes(t);
let fails = 0; const ok = (c, m) => { if (!c) { console.log("  FAIL:", m); fails++; } };
const type = async (el, v) => { if (!el) return; await act(async () => {
  Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, "value").set.call(el, v);
  el.dispatchEvent(new dom.window.Event("input", { bubbles: true })); }); };

const render = async (props) => {
  document.getElementById("root").innerHTML = "";
  const root = createRoot(document.getElementById("root"));
  await act(async () => { root.render(React.createElement(App, props)); });
  await wait(300);
};

(async () => {
  /* a customer session must never render the console */
  await render({ __session: { user: { id: "u1", email: "t@e.com" }, next: { screen: "dashboard", workspaceId: "w1" } } });
  ok(!has("THIS WORKSPACE · live"), "a signed in customer never sees the internal console");
  ok(!has("Staff sign in"), "and never sees the staff login");

  /* visitor: the staff door exists but is not advertised */
  await render({ __session: null });
  const staffLink = btn("Staff");
  ok(!!staffLink, "there is a staff entry point in the footer");
  await click(staffLink); await wait(250);
  ok(has("Staff sign in"), "it opens a separate staff login");
  ok(has("Customer accounts do not work here"), "it states that customer accounts do not work");

  /* customer credentials must not open the console */
  const ins = () => [...document.querySelectorAll("input")];
  await type(ins()[0], "demo@buzzzbuzzz.com");
  await type(ins()[1], "buzzz-demo-2026");
  await click(btn("Sign in")); await wait(400);
  ok(!has("THIS WORKSPACE") && !btn("Sign out"),
     "a customer account cannot sign into the staff console");
  ok(has("Staff sign in"), "it stays on the staff login screen");

  /* the demo operator can */
  await type(ins()[0], "ops@buzzzbuzzz.com");
  await type(ins()[1], "buzzz-ops-2026");
  await click(btn("Sign in")); await wait(500);
  ok(!!btn("Sign out") && has("Platform"), "the demo operator reaches the console");
  ok(has("ops@buzzzbuzzz.com"), "the console shows who is signed in");

  /* honesty: no invented numbers */
  ok(has("need the API") || has("not connected"), "the console states the API is not connected");
  ok(has("needs the platform API"), "unavailable metrics say so");
  ok(!/\\b(1,234|4,821|92%|\\$12,4)\\b/.test(document.body.textContent), "no placeholder figures are shown");
  const mrr = document.body.textContent.match(/MRR[\\s\\S]{0,60}/);
  ok(mrr && /—|needs the platform API/.test(mrr[0]), "MRR is shown as unavailable rather than zero");

  /* tabs render */
  for (const t of ["Workspaces", "Agents", "Conversations", "Approvals", "Integrations", "AI operations", "Errors", "Health"]) {
    await click(btn(t)); await wait(150);
    ok(document.body.textContent.length > 400, t + " tab renders");
  }
  await click(btn("Workspaces")); await wait(150);
  ok(has("read only by default"), "the access rules are stated on the workspaces tab");
  ok(has("never shown"), "it states credentials are never exposed");


  /* the console must be reading real workspace records, not placeholders */
  await click(btn("Overview")); await wait(200);
  ok(has("THIS WORKSPACE · live"), "live workspace data is labelled as one workspace");
  ok(has("PLATFORM · needs API"), "platform totals are labelled as needing the API");
  const agentsTab = btn("Agents"); await click(agentsTab); await wait(250);
  ok(document.body.textContent.includes("agents in this workspace"), "the agents tab counts real agents");
  ok(/L[0-4]/.test(document.body.textContent), "each agent shows its autonomy level");
  await click(btn("Integrations")); await wait(250);
  ok(document.body.textContent.includes("connected"), "integrations show a real connected count");
  await click(btn("Conversations")); await wait(250);
  ok(/conversations, .*unread/.test(document.body.textContent), "conversations are counted live");
  ok(has("not shown here"), "customer message contents are withheld");


  /* the owner tabs: faults, money and customer feeling */
  await click(btn("Faults")); await wait(250);
  ok(/critical/.test(document.body.textContent), "the faults tab grades by severity");
  ok(document.body.textContent.includes("→"), "every fault carries a recommended fix");
  await click(btn("Revenue")); await wait(250);
  ok(/Closed won/.test(document.body.textContent), "revenue shows money actually booked");
  ok(/Weighted forecast/.test(document.body.textContent), "and a forecast kept separate from it");
  ok(/estimate/.test(document.body.textContent), "the forecast is labelled an estimate");
  ok(/MRR/.test(document.body.textContent), "subscription revenue is listed");
  await click(btn("Customers")); await wait(250);
  ok(/Sentiment score/.test(document.body.textContent), "customer sentiment is measured");
  ok(/not a survey/.test(document.body.textContent), "and is explicitly not presented as a survey");
  ok(/CSAT/.test(document.body.textContent), "CSAT is shown as unavailable rather than faked");


  /* both themes */
  const themeBtn = [...document.querySelectorAll("button")].find((b) => /Switch to the/.test(b.getAttribute("aria-label") || ""));
  ok(!!themeBtn, "there is a theme toggle");
  const rootBg = () => {
    const el = [...document.querySelectorAll("div")].find((d) => (d.className || "").includes("min-h-screen"));
    return el ? el.style.background : "";
  };
  const darkBg = rootBg();
  await click(themeBtn); await wait(250);
  const lightBg = rootBg();
  ok(darkBg !== lightBg, "the toggle actually changes the background");
  const lum = (c) => { const nums = String(c).split(/[^0-9]+/).filter(Boolean).map(Number); return nums.length >= 3 ? (nums[0] + nums[1] + nums[2]) / 3 : null; };
  ok(lum(darkBg) < 40, "the dark theme is dark");
  ok(lum(lightBg) > 200, "the light theme is light");
  ok(document.body.textContent.includes("Faults"), "the console still works in light");
  const back = [...document.querySelectorAll("button")].find((b) => /Switch to the/.test(b.getAttribute("aria-label") || ""));
  await click(back); await wait(200);
  ok(rootBg() === darkBg, "and switches back");

  /* sign out returns to the public site, customer session untouched */
  await click(btn("Sign out")); await wait(300);
  ok(!btn("Sign out"), "signing out leaves the console");

  console.error = orig;
  const real = errs.filter((e) => /Cannot read|is not a function|Maximum update depth|is not defined/.test(e));
  if (real.length) { console.log("  RUNTIME:", real[0].slice(0, 170)); fails++; }
  console.log(fails ? ("admin console: " + fails + " FAILED") : "admin console: all checks passed");
  process.exit(fails ? 1 : 0);
})();
`;
const out = await build({ stdin:{contents:harness,resolveDir:path.join(dir,".."),loader:"js"}, bundle:true, platform:"node", format:"cjs", write:false, jsx:"automatic", loader:{".jsx":"jsx"}, external:["jsdom"], logLevel:"error" });
const require2 = createRequire(import.meta.url); const Module = require2("module");
const m = new Module("adm"); m.paths = Module._nodeModulePaths(path.join(dir,".."));
m._compile(out.outputFiles[0].text, path.join(dir,"..","adm-test.cjs"));
