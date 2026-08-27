/** The gate: a visitor never reaches onboarding, an onboarded user never
 *  returns to it, and an unfinished one resumes it. */
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

const render = async (props) => {
  document.getElementById("root").innerHTML = "";
  const root = createRoot(document.getElementById("root"));
  await act(async () => { root.render(React.createElement(App, props)); });
  await wait(300);
  return root;
};

(async () => {
  /* 1. a visitor with no session */
  await render({ __session: null });
  ok(has("BUZZZ"), "the public site renders for a visitor");
  ok(has("Get started") || has("Start free"), "the site shows a signup call to action");
  ok(!has("Tell me about your business"), "a visitor NEVER sees onboarding");
  ok(!has("Build my workspace"), "a visitor never sees the workspace builder");
  ok(!document.querySelector("aside") && !has("Approval Center"), "a visitor sees no application chrome");
  ok(has("Pricing") || has("pricing"), "the public site has pricing");

  /* live demo runs the real classifier */
  await render({ __session: null });
  ok(has("Try it now"), "the live demo is on the page");
  const demoIn = [...document.querySelectorAll("input")].find((i) => /dental clinic/i.test(i.getAttribute("placeholder") || ""));
  ok(!!demoIn, "the demo has an input");
  const typeD = async (el, v) => { await act(async () => {
    Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, "value").set.call(el, v);
    el.dispatchEvent(new dom.window.Event("input", { bubbles: true })); }); };
  await typeD(demoIn, "we run a dental clinic, patients ask about price on whatsapp");
  await click([...document.querySelectorAll("button")].find((b) => b.textContent.trim() === "Read it"));
  await wait(250);
  ok(has("Understood as"), "the demo returns a reading");
  ok(/healthcare|clinic/i.test(document.body.textContent), "it classifies a clinic correctly");
  ok(has("whatsapp") || has("WhatsApp"), "it picks the channel out of the sentence");
  ok(has("Booking needed"), "it reports whether booking matters");

  /* an e-commerce sentence gives a different reading */
  await typeD(demoIn, "online shop, customers ask where is my order and how to return");
  await click([...document.querySelectorAll("button")].find((b) => b.textContent.trim() === "Read it"));
  await wait(250);
  ok(/retail|shop|commerce/i.test(document.body.textContent), "a shop is read differently from a clinic");

  /* scroll progress and section nav exist */
  ok(!!document.querySelector(".bz-progress"), "a reading progress bar is present");

  /* CTA reaches signup */
  await click(btn("Get started")); await wait(200);
  ok(has("Create your account"), "Get started opens signup");
  ok(!has("Tell me about your business"), "signup is not onboarding");
  const backBtn = [...document.querySelectorAll("button")].find((b) => (b.textContent || "").includes("Back"));
  await click(backBtn); await wait(200);
  ok(has("Start free") || has("Get started"), "Back returns to the site");
  await click(btn("Log in")); await wait(200);
  ok(has("Welcome back"), "Log in opens the sign in screen");

  /* signup validation happens before any request */
  await click(btn("Create an account")); await wait(150);
  const inputs = () => [...document.querySelectorAll("input")];
  const type = async (el, v) => { await act(async () => {
    Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, "value").set.call(el, v);
    el.dispatchEvent(new dom.window.Event("input", { bubbles: true })); }); };
  const byPh = (re) => inputs().find((i) => re.test(i.getAttribute("placeholder") || ""));
  const emailIn = byPh(/email/i), passIn = byPh(/password/i);
  ok(!!emailIn && !!passIn, "signup form has email and password fields");
  if (emailIn) await type(emailIn, "not-an-email");
  if (passIn) await type(passIn, "short");
  await click(btn("Create account")); await wait(200);
  ok(has("valid email"), "an invalid email is rejected before the request");

  /* 2. authenticated, onboarding not finished */
  await render({ __session: { user: { id: "u1", email: "a@b.com" }, next: { screen: "onboarding", workspaceId: "w1" } } });
  ok(has("Tell me about your business"), "an authenticated user with unfinished onboarding sees onboarding");
  ok(!has("Start free"), "the public site is gone once signed in");

  /* 3. authenticated and already onboarded */
  await render({ __session: { user: { id: "u1", email: "a@b.com" }, next: { screen: "dashboard", workspaceId: "w1" } } });
  ok(!has("Tell me about your business"), "an onboarded user is NEVER sent back through onboarding");
  ok(has("Home") || has("Inbox"), "an onboarded user lands in the application");

  /* 4. unverified email */
  await render({ __session: { user: { id: "u1", email: "a@b.com" }, next: { screen: "verify_email" } } });
  ok(has("Confirm your email"), "an unverified account is asked to confirm first");
  ok(!has("Tell me about your business"), "an unverified account cannot reach onboarding");


  /* --- landing page: structure, interaction, no dead controls --- */
  await render({ __session: null });
  ok(has("Every message"), "hero headline renders");
  ok(has("work done"), "hero headline completes");
  ok(document.querySelectorAll("h1").length === 1, "exactly one h1");
  ok(document.querySelectorAll("h2").length >= 5, "section headings are structured");
  ["top","platform","brain","agents","automations","industries","pricing"].forEach((id) => {
    ok(!!document.getElementById(id), "section #" + id + " exists for its nav link");
  });
  const btns = [...document.querySelectorAll("button")];
  ok(btns.length > 30, "the page renders its controls (" + btns.length + ")");
  const dead = btns.filter((b) => !Object.keys(b).some((k) => k.startsWith("__react")));
  ok(dead.length === 0, "every button is wired (" + dead.length + " dead)");
  ok(!!document.querySelector("header") && !!document.querySelector("footer"), "semantic header and footer");

  ok(has("From a message"), "the scroll journey section renders");
  ok(has("An agent reads the history"), "journey steps render");
  ok(has("The parts that make it trustworthy"), "the bento section renders");
  ok(document.body.textContent.split("BUZZZ").length > 3, "the oversized wordmark is present");
  ok(has("Held for approval"), "the layered proof cards render");



  /* Martin-style hero furniture */
  ok(/Book Sarah for Friday/.test(document.body.textContent), "command chips ring the hero");
  ok(/Calendar/.test(document.body.textContent), "each chip names what it acts on");
  ok(/WhatsApp BUZZZ\./.test(document.body.textContent), "the channel litany renders");
  ok(/Instagram BUZZZ\./.test(document.body.textContent), "every channel gets its own line");
  ok(/Comment to DM/.test(document.body.textContent), "capability link cards render");
  const litany = [...document.querySelectorAll("button")].find((b) => /Call BUZZZ\./.test(b.textContent));
  ok(!!litany, "litany lines are interactive");
  await click(litany); await wait(200);
  ok(/transcribed/.test(document.body.textContent), "selecting a channel reveals its line");

  /* the hero laptop: it must open, and must show the product inside */
  const lid = document.querySelector(".bz-lid");
  ok(!!lid, "the laptop renders");
  ok(!!document.querySelector(".bz-deck"), "the deck renders under the lid");
  ok(lid && lid.className.includes("is-open"), "the lid opens rather than staying shut");
  ok(/Inbox/.test(document.body.textContent), "the screen shows the product chrome");
  ok(/friday evening/.test(document.body.textContent), "the story plays on the screen");
  /* legibility: a product shot nobody can read is worse than no product shot */
  const lidEl = document.querySelector(".bz-lid");
  const clsAll = [...lidEl.querySelectorAll("*")].map((e) => e.className || "").join(" ");
  const px = [...new Set(clsAll.match(/text-\[[0-9.]+px\]/g) || [])].map((x) => parseFloat(x.replace(/[^0-9.]/g, "")));
  ok(px.length > 0 && Math.min(...px) >= 9, "nothing on the screen is smaller than 9px (" + Math.min(...px) + ")");

  /* the window bar switches the screen between the two products */
  ok(lidEl.querySelectorAll("svg").length > 4, "channel glyphs render inside the screen");
  const pipeBtn = [...lidEl.querySelectorAll("button")].find((b) => b.textContent.trim() === "Pipeline");
  ok(!!pipeBtn, "the window bar offers the pipeline view");
  await click(pipeBtn); await wait(300);
  ok(/Pipeline/.test(document.body.textContent), "the pipeline opens inside the laptop");
  ["New", "Qualified", "Booked", "Won"].forEach((st) =>
    ok(document.body.textContent.includes(st), "the pipeline shows the " + st + " stage"));
  const inboxBtn = [...lidEl.querySelectorAll("button")].find((b) => b.textContent.trim() === "Inbox");
  ok(!!inboxBtn, "the window bar offers the inbox view");
  await click(inboxBtn); await wait(300);
  ok(/All conversations/.test(document.body.textContent), "and it switches back to the inbox");

  /* the four panes must share one baseline: a header that starts at a
     different height in each column is what reads as broken */
  const heads = [...lidEl.querySelectorAll("div")].filter((d) => (d.className || "").includes("h-7 shrink-0 flex items-center"));
  ok(heads.length === 4, "all four columns share a header row (" + heads.length + ")");
  const cols = [...lidEl.querySelectorAll("div")].filter((d) => /w-\[74px\]|w-\[30%\]|w-\[24%\]/.test(d.className || ""));
  ok(cols.every((c) => /flex flex-col/.test(c.className)), "every column lays out as a column");

  /* the screen shows the real product: nav, inbox, thread and the record */
  ok(/All conversations/.test(document.body.textContent), "the inbox renders inside the screen");
  ok(/Priya Raman/.test(document.body.textContent), "conversations are listed");
  ok(/CRM/.test(document.body.textContent) && /Agents/.test(document.body.textContent), "the nav rail renders");
  ok(/Customer/.test(document.body.textContent), "the customer record panel renders");
  ok(/What BUZZZ did/.test(document.body.textContent), "the action log renders under the thread");
  ok(/Level 3/.test(document.body.textContent), "the autonomy in force is shown on the thread");
  const convos = [...document.querySelectorAll("button")].filter((b) => /Northbridge Ltd|Daniel Okoye|Amelia Cruz/.test(b.textContent));
  ok(convos.length >= 3, "conversations are selectable inside the screen");
  await click(convos.find((b) => /Northbridge/.test(b.textContent))); await wait(250);
  ok(/never got the invoice/.test(document.body.textContent), "selecting a conversation opens its thread");
  ok(/Invoice resent/.test(document.body.textContent), "and shows what was done about it");

  /* every conversation row must carry its channel logo: this went missing once
     because a size change orphaned the replacement */
  const listCol = [...lidEl.querySelectorAll("div")].find((d) => (d.className || "").includes("w-[30%]"));
  ok(!!listCol, "the conversation list column exists");
  const rows = [...listCol.querySelectorAll("button")];
  ok(rows.length === 4, "four conversations are listed");
  ok(rows.every((r) => r.querySelectorAll("svg").length > 0), "every conversation row shows a channel logo");
  ok(listCol.querySelectorAll("svg").length >= 4, "the list renders one glyph per row");

  /* the wordmark must be embedded: an absolute path needs a web server behind
     it, so the logo silently vanished everywhere this runs as a single file */
  const logos = [...document.querySelectorAll("img")];
  ok(logos.length >= 2, "the logo renders on the page (" + logos.length + ")");
  ok(logos.every((i) => (i.getAttribute("src") || "").startsWith("data:image/png;base64,")),
     "every logo is embedded rather than fetched from a path");
  ok(logos.every((i) => i.getAttribute("alt") === "BUZZZ"), "every logo carries an alt of BUZZZ");
  ok(logos.every((i) => i.style.height && i.style.width), "the logo is sized so it cannot be stretched");
  ok(!/font-bold[^>]*>B</.test(document.body.innerHTML), "no hand built letter tiles remain");

  /* channel logos and the CRM board */
  ok(document.querySelectorAll("svg").length > 20, "channel glyphs render as icons");
  ok(/Pipeline/.test(document.body.textContent), "the CRM pipeline renders");
  ["New", "Qualified", "Booked", "Won"].forEach((st) => {
    ok(document.body.textContent.includes(st), "pipeline stage " + st + " renders");
  });
  ok(/Northbridge Ltd/.test(document.body.textContent), "deals appear on the board");
  ok(/Record/.test(document.body.textContent), "the customer record panel renders beside the board");
  ok(/Reminder in 24h/.test(document.body.textContent), "the record shows the next action");
  ok(!!document.getElementById("crm"), "the CRM section has an anchor for the nav");
  const stageBtn = [...document.querySelectorAll("button")].find((b) => /^Qualified/.test(b.textContent.trim()));
  ok(!!stageBtn, "pipeline stages are interactive");

  /* four tiers, and the AI allowance is what separates them */
  ["Starter", "Growth", "Scale", "Enterprise"].forEach((tier) =>
    ok(document.body.textContent.includes(tier), tier + " is offered"));
  ok(/AI requests/.test(document.body.textContent), "each plan states its AI allowance");
  ok(/Bring your own model key/.test(document.body.textContent), "bringing your own key is an Enterprise line");
  ok(!/Bring your own model key[\s\S]{0,400}Starter/.test(document.body.textContent), "and is not offered on Starter");

  /* capability tabs swap content */
  /* scope to the section: "CRM" also names a button inside the hero laptop */
  const platformSection = document.getElementById("platform");
  const crmTab = [...platformSection.querySelectorAll("button")].find((b) => b.textContent.trim() === "CRM");
  await click(crmTab); await wait(150);
  ok(has("A CRM that understands"), "the platform tabs switch content");
  const apptTab = [...platformSection.querySelectorAll("button")].find((b) => b.textContent.trim() === "Appointments");
  await click(apptTab); await wait(150);
  ok(has("Booked, reminded, rebooked"), "another tab switches too");

  /* autonomy explorer */
  const l4 = [...document.querySelectorAll("button")].find((b) => /L4/.test(b.textContent) && /Agentic/.test(b.textContent));
  await click(l4); await wait(150);
  ok(has("Place calls"), "level 4 shows what it may do");
  ok(has("Delete, refund or cancel without a person"), "level 4 still names what waits for a human");
  const l0 = [...document.querySelectorAll("button")].find((b) => /L0/.test(b.textContent));
  await click(l0); await wait(150);
  ok(has("Send anything"), "level 0 shows what it cannot do");

  /* industry switcher */
  const reInd = [...document.querySelectorAll("button")].find((b) => b.textContent.trim() === "Real estate");
  await click(reInd); await wait(200);
  ok(has("Viewings arranged"), "the industry switcher changes content");

  /* regional pricing */
  const india = [...document.querySelectorAll("button")].find((b) => b.textContent.trim() === "India");
  await click(india); await wait(200);
  ok(has("₹"), "India shows rupee prices");
  const us = [...document.querySelectorAll("button")].find((b) => b.textContent.trim() === "United States");
  await click(us); await wait(200);
  ok(has("\$"), "the United States shows dollar prices");

  /* the conversion strip is interactive */
  const igTab = [...document.querySelectorAll("button")].find((b) => b.textContent.trim() === "Instagram");
  await click(igTab); await wait(200);
  ok(has("price?"), "the hero strip switches channel");

  /* CTA reaches signup */
  const start = [...document.querySelectorAll("button")].find((b) => b.textContent.trim() === "Start free");
  await click(start); await wait(250);
  ok(has("Create your account"), "Start free opens signup");

  /* sign in options on the BUZZZ login page */
  await click(btn("Log in")); await wait(400);
  /* the passkey button is deliberately absent where the browser cannot do it:
     jsdom has no PublicKeyCredential, so its absence here is correct */
  ok(!/Sign in with a passkey/.test(document.body.textContent),
     "passkey sign in is hidden where the browser does not support it");
  ok(/or continue with/.test(document.body.textContent), "social sign in is offered");
  ["Google", "Apple"].forEach((p) =>
    ok(document.body.textContent.includes(p), p + " sign in is offered"));
  /* the label sits next to a mark, so the text node reads "GGoogle" */
  /* the providers publish sign in guidelines that require their own mark:
     a letter placeholder breaches the terms you accept when enabling them */
  const markOf = (name) => {
    const b = [...document.querySelectorAll("button")].find((x) => new RegExp(name + "$").test(x.textContent.trim()));
    return b ? b.querySelector("svg") : null;
  };
  const gMark = markOf("Google");
  ok(!!gMark, "the Google button carries a mark");
  ok(gMark && gMark.querySelectorAll("path").length === 4, "the Google G is the four colour mark");
  const gFills = gMark ? [...gMark.querySelectorAll("path")].map((p) => p.getAttribute("fill")) : [];
  ok(gFills.includes("#4285F4") && gFills.includes("#34A853") && gFills.includes("#FBBC05") && gFills.includes("#EA4335"),
     "the Google mark uses Google's own four brand colours");
  ok(!!markOf("Apple"), "the Apple button carries the Apple logo");
  const appleBtn = [...document.querySelectorAll("button")].find((b) => /Apple$/.test(b.textContent.trim()));
  const appleBg = ((appleBtn && appleBtn.style.background) || "").split(" ").join("");
  ok(appleBg === "rgb(0,0,0)" || appleBg === "#000",
     "the Apple button is black, as their guidelines require");
  ok([...document.querySelectorAll("button")].filter((b) => /Google$|Apple$/.test(b.textContent.trim()))
     .every((b) => b.getAttribute("aria-label")), "each social button has an accessible name");

  /* the logo is a wordmark, so printing BUZZZ beside it says the name twice */
  const brandImgs = [...document.querySelectorAll("img")].filter((i) => i.getAttribute("alt") === "BUZZZ");
  ok(brandImgs.length === 1, "the sign in screen shows the logo once (" + brandImgs.length + ")");
  ok(!document.body.textContent.includes("BUZZZ"), "and does not repeat the name as text beside it");

  ok(!document.body.textContent.includes("Discord"), "Discord is no longer offered");
  const google = [...document.querySelectorAll("button")].find((b) => /Google$/.test(b.textContent.trim()));
  ok(!!google, "the Google button is clickable");
  await click(google); await wait(300);
  ok(/needs its credentials|not configured/i.test(document.body.textContent),
     "an unconfigured provider says so rather than redirecting to a broken screen");

  /* --- demo account --- */
  await click(btn("Log in")); await wait(200);
  ok(has("Demo account"), "the login screen offers the demo account");
  ok(has("demo@buzzzbuzzz.com"), "the demo email is shown");
  const openDemo = btn("Open the demo workspace");
  ok(!!openDemo, "there is a one click demo button");
  await click(openDemo); await wait(600);
  ok(!has("Welcome back"), "the demo signs in");
  ok(!has("Tell me about your business"), "the demo account is already onboarded, so no onboarding");
  ok(has("Home") || has("Inbox"), "the demo lands in the application");

  /* wrong credentials still fail */
  await render({ __session: null });
  await click(btn("Log in")); await wait(200);
  const ins = () => [...document.querySelectorAll("input")];
  const byPh2 = (re) => ins().find((i) => re.test(i.getAttribute("placeholder") || ""));
  const typeIn = async (el, v) => { await act(async () => {
    Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, "value").set.call(el, v);
    el.dispatchEvent(new dom.window.Event("input", { bubbles: true })); }); };
  await typeIn(byPh2(/email/i), "someone@else.com");
  await typeIn(byPh2(/password/i), "wrong-password-99");
  await click(btn("Sign in")); await wait(300);
  ok(has("Home") === false, "wrong credentials do not sign in");
  ok(has("demo account") || has("Demo account"), "the failure points at the demo account");

  /* try onboarding instead */
  await render({ __session: null });
  await click(btn("Log in")); await wait(200);
  await click(btn("Try onboarding instead")); await wait(600);
  ok(has("Tell me about your business"), "the demo can also start at onboarding");

  console.error = orig;
  const real = errs.filter((e) => /Cannot read|is not a function|Maximum update depth|is not defined/.test(e));
  if (real.length) { console.log("  RUNTIME:", real[0].slice(0, 160)); fails++; }
  console.log(fails ? ("auth gate: " + fails + " FAILED") : "auth gate: all checks passed");
  process.exit(fails ? 1 : 0);
})();
`;
const out = await build({ stdin:{contents:harness,resolveDir:path.join(dir,".."),loader:"js"}, bundle:true, platform:"node", format:"cjs", write:false, jsx:"automatic", loader:{".jsx":"jsx"}, external:["jsdom"], logLevel:"error" });
const require2 = createRequire(import.meta.url); const Module = require2("module");
const m = new Module("gate"); m.paths = Module._nodeModulePaths(path.join(dir,".."));
m._compile(out.outputFiles[0].text, path.join(dir,"..","gate-test.cjs"));
