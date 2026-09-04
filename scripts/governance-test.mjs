/** Governance: all five levels across the action matrix, destructive and bulk
 *  protection, tool-versus-permission separation, and parity between the
 *  client bundle and the server policy engine. */
import { build } from "esbuild";
import { createRequire } from "module";
import path from "path"; import fs from "fs";
import { fileURLToPath } from "url";
import * as server from "../server/src/lib/governance.js";

const dir = path.dirname(fileURLToPath(import.meta.url));
const src = fs.readFileSync(path.join(dir, "..", "client", "src", "App.jsx"), "utf8");
const st = src.indexOf("const ACTIONS = {");
const en = src.indexOf("/* ---- guardrails are matched against");
if (st < 0 || en < 0) { console.log("governance engine not found"); process.exit(1); }
const names = [...new Set([...src.slice(st, en).matchAll(/Icon:\s*([A-Z]\w+)/g)].map((m) => m[1]))];
const stub = names.length ? "const " + names.map((n) => `${n}=null`).join(",") + ";\n" : "";
const harness = stub + 'const CH={whatsapp:{label:"WhatsApp"}};\n' + src.slice(st, en) + `
let fails=0; const ok=(c,m)=>{if(!c){console.log("  FAIL:",m);fails++;}};
globalThis.__decide = decide; globalThis.__ACTIONS = ACTIONS; globalThis.__audit = auditFor;
globalThis.__parse = parseAutonomyCommand;
const mkAgent=(lvl,extra={})=>({name:"A",status:"Active",autonomy:lvl,
  perms:Object.keys(ACTIONS).reduce((a,k)=>(a[k]=true,a),{}),
  tools:["CRM","GoWhats","Gmail","Calendar","Payments","MrAssistant.ai","Publisher","InstaxBot","Campaigns","Workflows"],
  channels:[],allowDestructive:false,...extra});
globalThis.__mkAgent = mkAgent;

const MATRIX=[["CAN_READ_CRM",0],["CAN_CREATE_TASK",2],["CAN_UPDATE_CONTACT",2],["CAN_SEND_WHATSAPP",2],
 ["CAN_BOOK_APPOINTMENT",3],["CAN_WRITE_CRM",3],["CAN_CREATE_DEAL",4],["CAN_PLACE_CALL",4],
 ["CAN_START_CAMPAIGN",4],["CAN_CREATE_PAYMENT_LINK",4]];
globalThis.__MATRIX = MATRIX;
for(let lvl=0;lvl<=4;lvl++) MATRIX.forEach(([a,min])=>{
  const d=decide({action:a,agent:mkAgent(4),ceiling:lvl});
  if(lvl>=min && lvl>0) ok(d.verdict==="allow",\`L\${lvl} should allow \${a}\`);
  if(lvl<min) ok(d.verdict!=="allow",\`L\${lvl} must not allow \${a}\`);
});
// ceiling beats agent level
ok(decide({action:"CAN_BOOK_APPOINTMENT",agent:mkAgent(4),ceiling:2}).verdict==="approve","ceiling caps a level 4 agent");
ok(decide({action:"CAN_CREATE_TASK",agent:mkAgent(1),ceiling:4}).effective===1,"agent level caps below ceiling");
// destructive and bulk
["CAN_DELETE_CRM","CAN_ISSUE_REFUND","CAN_CANCEL_APPOINTMENT"].forEach(a=>
  ok(decide({action:a,agent:mkAgent(4,{allowDestructive:true}),ceiling:4}).verdict==="approve",a+" always needs a human"));
ok(decide({action:"CAN_SEND_WHATSAPP",agent:mkAgent(4),ceiling:4,ctx:{audienceSize:20000}}).code==="BULK","bulk send needs approval at level 4");
// tool access is not authority
ok(decide({action:"CAN_CREATE_PAYMENT_LINK",agent:mkAgent(4,{perms:{CAN_READ_CRM:true}}),ceiling:4}).verdict==="deny","a connected tool grants no authority");
ok(decide({action:"CAN_SEND_WHATSAPP",agent:mkAgent(4),ceiling:4,ctx:{isConnected:()=>false}}).code==="NO_INTEGRATION","disconnected integration blocks");
// never a bare refusal
let missing=0;
MATRIX.forEach(([a])=>{for(let l=0;l<=4;l++){const d=decide({action:a,agent:mkAgent(4),ceiling:l}); if(d.verdict!=="allow"&&!d.fallback)missing++;}});
ok(missing===0,"every block offers an alternative");
// audit completeness
const rec=auditFor(decide({action:"CAN_CREATE_DEAL",agent:mkAgent(2),ceiling:2}));
["at","actor","agent","action","requestedLevel","effectiveLevel","ceiling","verdict","reason","approvalRequired"].forEach(f=>ok(rec[f]!==undefined,"audit has "+f));
// natural language
ok(parseAutonomyCommand("set my workspace to level 3").level===3,"parses ceiling change");
ok(parseAutonomyCommand("pause all autonomous actions").level===0,"pause means level 0");
ok(parseAutonomyCommand("what is the weather")===null,"unrelated text ignored");
globalThis.__fails = fails;
`;
const out = await build({ stdin:{contents:harness,resolveDir:path.join(dir,".."),loader:"jsx"}, bundle:true, platform:"node", format:"cjs", write:false, jsx:"automatic", logLevel:"error" });
const require2 = createRequire(import.meta.url); const Module = require2("module");
const m = new Module("gov"); m.paths = Module._nodeModulePaths(path.join(dir,".."));
m._compile(out.outputFiles[0].text, path.join(dir,"..","gov-test.cjs"));

/* client and server must reach the same verdict for every cell of the matrix */
let fails = globalThis.__fails || 0;
const mkAgent = globalThis.__mkAgent;
let mismatches = 0;
for (const [action] of globalThis.__MATRIX) {
  for (let lvl = 0; lvl <= 4; lvl++) {
    const a = mkAgent(4);
    const c = globalThis.__decide({ action, agent: a, ceiling: lvl }).verdict;
    const s2 = server.decide({ action, agent: a, ceiling: lvl }).verdict;
    if (c !== s2) { console.log(`  FAIL parity: ${action} @L${lvl} client=${c} server=${s2}`); mismatches++; }
  }
}
if (mismatches) fails += mismatches;
else console.log("  client and server agree on all 50 matrix cells");
console.log(fails ? `governance: ${fails} FAILED` : "governance: all checks passed");
process.exit(fails ? 1 : 0);
