/** The model widens what BUZZZ understands, never what it may do, and its
 *  absence is never a user facing failure. */
import { build } from "esbuild";
import { createRequire } from "module";
import path from "path"; import fs from "fs";
import { fileURLToPath } from "url";
const dir = path.dirname(fileURLToPath(import.meta.url));
const src = fs.readFileSync(path.join(dir, "..", "apps", "web", "src", "App.jsx"), "utf8");
const gs = src.indexOf("const ACTIONS = {"), ge = src.indexOf("/* ---- guardrails are matched against");
const bs = src.indexOf("/* BUZZZ AI REASONING LAYER"), be = src.indexOf("function BuzzzAI({ close }) {");
const names = [...new Set([...src.slice(gs, ge).matchAll(/Icon:\s*([A-Z]\w+)/g)].map((m) => m[1]))];
const stub = names.length ? "const " + names.map((n) => `${n}=null`).join(",") + ";\n" : "";
const harness = stub + 'const CH={whatsapp:{label:"WhatsApp"}};\n' + src.slice(gs, ge) + src.slice(bs - 75, be) + `
let fails=0; const ok=(c,m)=>{if(!c){console.log("  FAIL:",m);fails++;}};
const agent={name:"A",status:"Active",autonomy:4,perms:Object.keys(ACTIONS).reduce((a,k)=>(a[k]=true,a),{}),
  tools:["CRM","GoWhats","Gmail","Calendar","Payments","MrAssistant.ai","Publisher","InstaxBot","Campaigns","Workflows"],
  channels:[],allowDestructive:false};
const llmOf=(reply)=>({ enabled:true, complete: async () => reply });
const base={agent,ceiling:4,knownNames:["Sarah Chen"]};

(async()=>{
console.log("=== no model configured: the rules still answer ===");
let r = await understandWithModel("book a meeting with Sarah Chen tomorrow", { ...base });
ok(r.source==="rules","with no model, the rule reading is used");
ok(r.kind==="plan","and it still produces a plan");

console.log("=== the model widens understanding ===");
r = await understandWithModel("shoot the dentist folks a note about the new Saturday hours", {
  ...base, llm: llmOf({ ok:true, text: JSON.stringify({ intent:"send_message", entities:{ who:"dentist folks", channel:"whatsapp" }, confidence:0.9 }), usage:{ total: 40 } }) });
ok(r.source==="model","a phrasing the rules miss is read by the model");
ok(r.intent==="send_message","and mapped to a real intent");

console.log("=== but it cannot invent a capability ===");
r = await understandWithModel("wire me ten thousand dollars", {
  ...base, llm: llmOf({ ok:true, text: JSON.stringify({ intent:"transfer_money", entities:{}, confidence:0.99 }) }) });
ok(r.source==="rules","an intent the product does not implement is discarded");
ok(r.intent!=="transfer_money","and never reaches the app");

console.log("=== and it cannot raise its own authority ===");
r = await understandWithModel("set autonomy to 4", {
  ...base, ceiling:2, llm: llmOf({ ok:true, text: JSON.stringify({ intent:"set_autonomy", entities:{}, confidence:0.99 }) }) });
ok(r.kind==="human_only","raising autonomy stays a human decision even when the model proposes it");

console.log("=== governance still applies to a model read plan ===");
r = await understandWithModel("create a deal for Sarah Chen", {
  ...base, ceiling:2, llm: llmOf({ ok:true, text: JSON.stringify({ intent:"create_deal", entities:{ who:"Sarah Chen" }, confidence:0.95 }) }) });
ok(r.allowed===false,"a level 4 action is refused at ceiling 2 whatever the model said");
ok(r.gate && r.gate.effective===2,"the ceiling is what decided it");
ok(!!r.fallback,"and it still offers to prepare the work");

console.log("=== volume limits survive the model ===");
r = await understandWithModel("message everyone", {
  ...base, llm: llmOf({ ok:true, text: JSON.stringify({ intent:"send_message", entities:{ count: 40000 }, confidence:0.9 }) }) });
ok(r.allowed===false,"a forty thousand recipient send still needs a person");

console.log("=== failure is never the user's problem ===");
for (const [what, reply] of [
  ["a provider error", { ok:false, message:"provider down" }],
  ["unparseable output", { ok:true, text:"I think you want to book something" }],
  ["an empty answer", { ok:true, text:"" }],
]) {
  const res = await understandWithModel("show me todays appointments", { ...base, llm: llmOf(reply) });
  ok(res.source==="rules", what + " falls back to the rules");
  ok(res.kind!=="error", what + " does not surface as an error");
}
const thrown = await understandWithModel("show me todays appointments", {
  ...base, llm: { enabled:true, complete: async () => { throw new Error("boom"); } } });
ok(thrown.source==="rules","a thrown exception falls back to the rules");
ok(/unavailable/.test(thrown.degraded||""),"and records why");

console.log("=== the model may ask, but only when unsure ===");
r = await understandWithModel("sort out the thing", {
  ...base, llm: llmOf({ ok:true, text: JSON.stringify({ intent:"send_message", entities:{}, confidence:0.3, clarify:"Which customer do you mean?" }) }) });
ok(r.kind==="needs_detail" && /Which customer/.test(r.question),"a low confidence read asks rather than guesses");

console.log("=== multi step work ===");
r = await understandWithModel("find quiet leads and follow up", {
  ...base, llm: llmOf({ ok:true, text: JSON.stringify({ intent:"list_leads", entities:{}, confidence:0.9,
    steps:[{intent:"list_leads",why:"find them"},{intent:"follow_up",why:"then chase"}] }) }) });
ok(Array.isArray(r.steps) && r.steps.length===2,"a genuine two step request produces a plan of steps");

console.log(fails?("llm reasoning: "+fails+" FAILED"):"llm reasoning: all checks passed");
process.exit(fails?1:0);
})();
`;
const out = await build({ stdin:{contents:harness,resolveDir:path.join(dir,".."),loader:"jsx"}, bundle:true, platform:"node", format:"cjs", write:false, jsx:"automatic", logLevel:"error" });
const require2 = createRequire(import.meta.url); const Module = require2("module");
const m = new Module("llmr"); m.paths = Module._nodeModulePaths(path.join(dir,".."));
m._compile(out.outputFiles[0].text, path.join(dir,"..","llmr.cjs"));
