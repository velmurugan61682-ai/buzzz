/** BUZZZ AI reasoning: entities, intent, clarification, memory, governance. */
import { build } from "esbuild";
import { createRequire } from "module";
import path from "path"; import fs from "fs";
import { fileURLToPath } from "url";
const dir = path.dirname(fileURLToPath(import.meta.url));
const src = fs.readFileSync(path.join(dir, "..", "client", "src", "App.jsx"), "utf8");
const gs = src.indexOf("const ACTIONS = {"), ge = src.indexOf("/* ---- guardrails are matched against");
const bs = src.indexOf("/* BUZZZ AI REASONING LAYER"), be = src.indexOf("function BuzzzAI({ close }) {");
if (gs < 0 || bs < 0) { console.log("reasoning layer not found"); process.exit(1); }
const names = [...new Set([...src.slice(gs, ge).matchAll(/Icon:\s*([A-Z]\w+)/g)].map((m) => m[1]))];
const stub = names.length ? "const " + names.map((n) => `${n}=null`).join(",") + ";\n" : "";
const harness = stub + 'const CH={whatsapp:{label:"WhatsApp"}};\n' + src.slice(gs, ge) + src.slice(bs - 75, be) + `
let fails=0; const ok=(c,m)=>{if(!c){console.log("  FAIL:",m);fails++;}};
const NOW="2026-08-19T09:00:00Z";
const agent={name:"A",status:"Active",autonomy:4,perms:Object.keys(ACTIONS).reduce((a,k)=>(a[k]=true,a),{}),
  tools:["CRM","GoWhats","Gmail","Calendar","Payments","MrAssistant.ai","Publisher","InstaxBot","Campaigns","Workflows"],channels:[],allowDestructive:false};
const U=(t,extra={})=>understandRequest(t,{now:NOW,agent,ceiling:4,knownNames:["Sarah Chen","Marcus Lee"],...extra});

console.log("=== dates are resolved, not echoed ===");
ok(U("book a meeting tomorrow at 3pm").entities.when.label==="tomorrow","understands tomorrow");
ok(new Date(U("book a meeting tomorrow at 3pm").entities.when.iso).getUTCDate()===20,"tomorrow is the 20th");
ok(U("book a meeting tomorrow at 3pm").entities.when.precise===true,"picks up the time");
ok(U("book a call on friday").entities.when.label==="friday","understands a weekday");
ok(U("book a call in 2 weeks").entities.when.label==="in 2 weeks","understands a relative window");
ok(U("why did conversions drop this week").entities.when.window==="this week","understands a period");

console.log("=== people and channels ===");
ok(U("book a meeting with Sarah Chen tomorrow").entities.who.known===true,"recognises a known contact");
ok(U("book a meeting with Priya Raman tomorrow").entities.who.name==="Priya Raman","picks up an unknown name");
ok(U("book me a slot tomorrow").entities.who===null,"does not turn 'me' into a person");
ok(U("send them a whatsapp").entities.channel==="whatsapp","picks up the channel");

console.log("=== intent ===");
ok(U("show me todays appointments").intent==="list_appointments","reads a list request");
ok(U("book an appointment tomorrow").intent==="book_appointment","reads a booking request");
ok(U("create a customer support agent").intent==="create_agent","reads an agent request");
ok(U("why did conversions drop this week").intent==="explain_metric","reads an analysis request");
ok(U("build a workflow for new leads").intent==="create_workflow","reads a workflow request");
ok(U("pause the sales agent").intent==="pause_agent","reads a pause request");

console.log("=== it asks instead of guessing ===");
const noWhen=U("book an appointment");
ok(noWhen.kind==="needs_detail"&&noWhen.missing[0]==="when","a booking with no date asks for the date");
ok(/when/i.test(noWhen.question),"and asks a real question");
const noSubject=U("follow up with them");
ok(noSubject.kind==="needs_subject","an unresolved 'them' asks who");
const resolved=U("follow up with them",{memory:{lastSubjects:["Sarah Chen","Marcus Lee"],lastIntent:"list_leads"}});
ok(resolved.kind==="plan","with memory, 'them' resolves");
ok(resolved.entities.reference.subjects.length===2,"and carries both subjects forward");

console.log("=== governance is asked before promising ===");
const l2=U("create a deal for Sarah Chen",{ceiling:2});
ok(l2.allowed===false,"creating a deal is blocked at level 2");
ok(l2.gate.code==="AUTONOMY","blocked for the right reason");
ok(!!l2.fallback,"and offers to prepare it instead");
ok(/prepare/i.test(narratePlan(l2)),"the sentence offers the alternative");
const l4=U("create a deal for Sarah Chen",{ceiling:4});
ok(l4.allowed===true,"and allowed at level 4");
const camp=U("launch a campaign",{ceiling:4,audienceSize:20000});
ok(camp.allowed===false,"a 20000 person campaign still needs approval at level 4");
const cancel=U("cancel the appointment",{ceiling:4});
ok(cancel.allowed===false,"cancelling always waits for a person");

console.log("=== it never just refuses ===");
const unknown=U("make me a sandwich");
ok(unknown.kind==="unknown","an unrelated request is not forced into an intent");
ok(unknown.suggestions.length>=3,"and it offers what it can do");
ok(!/i can'?t/i.test(narratePlan(unknown)),"the reply is not a bare refusal");

console.log("=== ambiguity ===");
const amb=U("cancel and reschedule the meeting");
ok(amb.kind==="ambiguous"||amb.kind==="plan","a two verb request is handled deliberately");
if(amb.kind==="ambiguous") ok(/or/.test(amb.question),"the clarifying question offers both");

console.log("=== narration says what it understood ===");
const nice=U("book a meeting with Sarah Chen tomorrow at 3pm",{ceiling:4});
const line=narratePlan(nice);
ok(/Sarah Chen/.test(line)&&/tomorrow/.test(line),"the reply repeats who and when");
console.log("   sample:", line);
console.log("   blocked:", narratePlan(l2));
console.log("   unknown:", narratePlan(unknown));
console.log(fails?("buzzz ai: "+fails+" FAILED"):"buzzz ai reasoning: all checks passed");
`;
const out = await build({ stdin:{contents:harness,resolveDir:path.join(dir,".."),loader:"jsx"}, bundle:true, platform:"node", format:"cjs", write:false, jsx:"automatic", logLevel:"error" });
const require2 = createRequire(import.meta.url); const Module = require2("module");
const m = new Module("brain"); m.paths = Module._nodeModulePaths(path.join(dir,".."));
m._compile(out.outputFiles[0].text, path.join(dir,"..","brain-test.cjs"));
