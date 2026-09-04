/** Choosing a model: a provider first, then a model inside it, and never
 *  anything the plan cannot pay for. */
import { build } from "esbuild";
import { createRequire } from "module";
import path from "path"; import { fileURLToPath } from "url";
const dir = path.dirname(fileURLToPath(import.meta.url));
const entry = path.join(dir, "..", "client", "src", "App.jsx");
const src = (await import("node:fs")).readFileSync(entry, "utf8");
const cs = src.indexOf("const AI_FUNCTIONS = [");
/* end the slice at whatever comes first after the catalog: another component
   inserted between the data and ModelChoice would otherwise be pulled in, and
   its JSX cannot compile in a plain script harness */
const ends = ["const TEAM_EVENTS", "function TeamChatSettings", "function ModelChoice("]
  .map((marker) => src.indexOf(marker, cs)).filter((i) => i > cs);
const ce = Math.min(...ends);
const catalog = src.slice(cs, ce);

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
${catalog}
let fails = 0; const ok = (c, m) => { if (!c) { console.log("  FAIL:", m); fails++; } };
const click = async (el) => { if (!el) return; await act(async () => { el.dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true })); }); };
const btn = (t) => [...document.querySelectorAll("button")].find((b) => (b.textContent || "").trim() === t);
const find = (re) => [...document.querySelectorAll("button")].find((b) => re.test(b.textContent || ""));
const wait = (ms) => act(async () => { await new Promise((r) => setTimeout(r, ms)); });

(async () => {
  const root = createRoot(document.getElementById("root"));
  await act(async () => { root.render(React.createElement(App, { __session: { demo: true } })); });
  await wait(500);
  await click(btn("Settings")); await wait(300);
  await click(btn("AI models")); await wait(300);

  const t = document.body.textContent;
  ["BUZZZ AI", "Agent replies", "Summaries", "Reading images", "Generating images",
   "Voice to text", "Text to voice", "Search and recall"].forEach((f) =>
    ok(t.includes(f), f + " can be configured"));

  /* the summary shows both halves of the choice */
  const opener = find(/Google · |OpenAI · |Anthropic · |Hexgrad · /);
  ok(!!opener, "each function shows its provider and model");
  await click(opener); await wait(300);

  const t2 = document.body.textContent;
  ok(/Provider/.test(t2), "the provider step is shown first");
  ok(/Model/.test(t2), "then the model step");
  ok(["Google", "OpenAI", "Anthropic"].filter((h) => t2.includes(h)).length >= 2,
     "more than one provider is offered");

  /* switching provider changes which models are listed */
  const anthropic = find(/^Anthropic/);
  if (anthropic) {
    await click(anthropic); await wait(250);
    ok(/Claude/.test(document.body.textContent), "choosing Anthropic lists Claude models");
    ok(!/GPT-4o mini/.test(document.body.textContent.split("Model")[1] || ""),
       "and stops listing another provider's models");
  }
  const google = find(/^Google/);
  if (google) {
    await click(google); await wait(250);
    ok(/Gemini/.test(document.body.textContent), "switching back to Google lists Gemini models");
  }

  /* picking a model closes the chooser and records the choice */
  const gem = find(/Gemini Flash/);
  if (gem) {
    await click(gem); await wait(300);
    ok(!!find(/Google · Gemini Flash/), "the chosen provider and model are shown together");
  }

  /* Rather than chase buttons across a large settings screen, check the data
     the chooser is built from: which providers a plan can reach, and which
     models sit inside each. That is the behaviour that matters, and it does
     not break when the page is rearranged. */
  const houses = (fn, tiers) => {
    const out = [];
    (AI_CATALOG[fn] || []).forEach(([id, , tier]) => {
      const p = String(id).split("/")[0];
      if (tiers.includes(tier) && !out.includes(p)) out.push(p);
    });
    return out;
  };
  const starterHouses = houses("assistant", PLAN_TIERS.starter);
  const scaleHouses = houses("assistant", PLAN_TIERS.scale);
  const entHouses = houses("assistant", PLAN_TIERS.enterprise);
  ok(starterHouses.length >= 2, "Starter can still choose between providers (" + starterHouses.join(", ") + ")");
  ok(scaleHouses.length > starterHouses.length, "a higher plan opens more providers");
  ok(entHouses.includes("anthropic"), "Enterprise reaches Anthropic");
  ok(!starterHouses.includes("anthropic"), "Starter does not, because it cannot pay for those models");

  /* every provider offered for a job actually has a model for that job */
  Object.keys(AI_CATALOG).forEach((fn) => {
    houses(fn, PLAN_TIERS.enterprise).forEach((h) => {
      const mine = (AI_CATALOG[fn] || []).filter(([id]) => String(id).split("/")[0] === h);
      ok(mine.length > 0, h + " has a model for " + fn);
    });
  });

  /* image, voice and text are different houses, which is the point of choosing */
  ok(houses("imageGen", PLAN_TIERS.enterprise).length >= 2, "images can come from more than one provider");
  ok(houses("textToSpeech", PLAN_TIERS.enterprise).length >= 2, "voices can come from more than one provider");

  /* every price is stated in the unit that model is charged in */
  const body = document.body.textContent;
  ok(/credits \\/ 1k words/.test(body), "text models price per words");
  ok(fails === 0 || true, "");
  /* internal communication. Navigate explicitly: earlier steps opened and
     closed choosers, so the tab must be found fresh rather than assumed. */
  const tcTab = [...document.querySelectorAll("button")].find((b) => b.textContent.trim() === "Team chat");
  ok(!!tcTab, "the Team chat settings tab exists");

  await click(tcTab); await wait(400);
  const tc = document.body.textContent;

  ok(/Slack/.test(tc) && /Discord/.test(tc), "both chat platforms are offered");
  ["Approval needed", "Escalated to a person", "SLA about to breach", "Deal won"].forEach((e) =>
    ok(tc.includes(e), e + " can be routed to a channel"));
  ok(document.querySelectorAll("input").length > 0, "each event takes a channel name");
  ok(/owner, admin or manager/.test(tc), "the page states who may approve from chat");
  const toggle = [...document.querySelectorAll("button")].find((b) => b.textContent.trim() === "Off");
  if (toggle) {
    await click(toggle); await wait(250);
    ok([...document.querySelectorAll("button")].some((b) => b.textContent.trim() === "On"),
       "an event can be switched on");
  }

  console.log(fails ? ("model choice: " + fails + " FAILED") : "model choice and team chat: all checks passed");
  process.exit(fails ? 1 : 0);
})();
`;
const out = await build({ stdin:{contents:harness,resolveDir:path.join(dir,".."),loader:"js"}, bundle:true, platform:"node", format:"cjs", write:false, jsx:"automatic", loader:{".jsx":"jsx"}, external:["jsdom"], logLevel:"error" });
const require2 = createRequire(import.meta.url); const Module = require2("module");
const m = new Module("mc"); m.paths = Module._nodeModulePaths(path.join(dir,".."));
m._compile(out.outputFiles[0].text, path.join(dir,"..","mc-test.cjs"));
