/** Discovery must adapt: different businesses get different interviews,
 *  irrelevant questions are never asked, and it never becomes a form. */
import { build } from "esbuild";
import { createRequire } from "module";
import path from "path"; import fs from "fs";
import { fileURLToPath } from "url";
const dir = path.dirname(fileURLToPath(import.meta.url));
const src = fs.readFileSync(path.join(dir, "..", "client", "src", "App.jsx"), "utf8");
const start = src.indexOf("/* ==================================================================== */\n/* ONBOARDING UNDERSTANDING ENGINE");
const end = src.indexOf("\nfunction Onboarding");
const harness = `const CH={whatsapp:{label:"WhatsApp"}};\n` + src.slice(start, end) + `
let fails = 0;
const ok = (c, m) => { if (!c) { console.log("  FAIL:", m); fails++; } };
function interview(answers) {
  let f = {}; const asked = [];
  while (asked.length < 15) {
    const q = nextQuestion(f); if (!q) break;
    asked.push(q.id);
    f = mergeFacts({ ...f, pending: q.id }, understand(answers[asked.length - 1] ?? "not sure"));
  }
  return { asked, f };
}
const clinic = interview(["we run a dental clinic in chennai","cleanings and implants for families",
  "missing calls and no shows","whatsapp and phone","three dentists",
  "patients call or whatsapp about 60 a week","reception books them",
  "price and timings, clinical goes to a dentist","reminders take forever","draft them first","our website","9 to 6"]);
const shop = interview(["we sell clothing online on shopify","womens fashion, repeat buyers",
  "abandoned carts and where is my order","instagram and whatsapp","just me",
  "instagram dms and website","returns and delivery questions",
  "order updates eat the day","handle the routine ones","our site","10 to 7"]);
const b2b = interview(["b2b saas selling to hospitals","subscription software for clinics",
  "leads go cold before demo","email and webchat","twelve of us",
  "website and referrals, 30 a week","demo then proposal, four follow ups",
  "pricing and integration questions","chasing proposals","approve everything","our docs site","9 to 6"]);

console.log("clinic:", clinic.asked.join(" > "));
console.log("shop  :", shop.asked.join(" > "));
console.log("b2b   :", b2b.asked.join(" > "));

ok(clinic.asked.includes("appointments"), "clinic should be asked about appointments");
ok(!shop.asked.includes("appointments"), "a shop must never be asked about appointments");
ok(shop.asked.includes("orders"), "shop should be asked about orders and returns");
ok(!clinic.asked.includes("orders"), "a clinic must not be asked about orders");
ok(b2b.asked.includes("sales"), "a b2b business should be asked about its sales process");
ok(clinic.asked.length <= 9 && shop.asked.length <= 9, "discovery must stay under ten questions");
ok(new Set(clinic.asked).size === clinic.asked.length, "no question may be asked twice");
ok(blueprintReady(clinic.f).ready, "clinic blueprint should be ready");
ok(blueprintReady(shop.f).ready, "shop blueprint should be ready");

/* the blueprint must carry real understanding, not empty scaffolding */
const bp = buildBlueprint(clinic.f);
ok(bp.profile.industry === "healthcare", "blueprint industry");
ok(bp.appointments.relevant === true, "clinic blueprint marks appointments relevant");
ok(buildBlueprint(shop.f).appointments.relevant === false, "shop blueprint marks appointments irrelevant");
ok((bp.communication.channels || []).length > 0, "blueprint captured channels");
ok((bp.customers.sources || []).length > 0, "blueprint captured lead sources");

/* configuration derived from the blueprint */
const cfg = blueprintConfig(bp);
ok(cfg.tags.length > 0, "tags derived from blueprint");
ok(cfg.escalation.some((e) => /person/i.test(e.when)), "human handoff rule always present");
ok(cfg.escalation.some((e) => /clinical/i.test(e.when)), "clinical escalation for healthcare");
ok(!blueprintConfig(buildBlueprint(shop.f)).escalation.some((e) => /clinical/i.test(e.when)), "no clinical rule for a shop");

/* skipping: facts already given must not be asked again */
const known = interview(["we run a dental clinic in chennai with 3 dentists, patients reach us on whatsapp and phone, we are losing money on no shows"]);
ok(!known.asked.slice(1).includes("channels"), "channels stated up front must not be asked again");
ok(!known.asked.slice(1).includes("size"), "team size stated up front must not be asked again");

console.log(fails ? "discovery test: " + fails + " FAILED" : "discovery test: all checks passed");
process.exit(fails ? 1 : 0);
`;
const out = await build({ stdin:{contents:harness,resolveDir:path.join(dir,".."),loader:"jsx"}, bundle:true, platform:"node", format:"cjs", write:false, jsx:"automatic", logLevel:"error" });
const require2 = createRequire(import.meta.url); const Module = require2("module");
const m = new Module("disc"); m.paths = Module._nodeModulePaths(path.join(dir,".."));
m._compile(out.outputFiles[0].text, path.join(dir,"..","discovery-test.cjs"));
