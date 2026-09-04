/** Business metrics: revenue, satisfaction and fault ranking. */
import { build } from "esbuild";
import { createRequire } from "module";
import path from "path"; import fs from "fs";
import { fileURLToPath } from "url";
const dir = path.dirname(fileURLToPath(import.meta.url));
const src = fs.readFileSync(path.join(dir, "..", "client", "src", "App.jsx"), "utf8");
const st = src.indexOf("/* BUSINESS METRICS"), en = src.indexOf("function workspaceSnapshot()");
if (st < 0 || en < 0) { console.log("metrics engine not found"); process.exit(1); }
const harness = src.slice(st - 75, en) + `
let fails=0; const ok=(c,m)=>{if(!c){console.log("  FAIL:",m);fails++;}};
console.log("=== revenue ===");
const deals=[{stage:"Won",value:10000},{stage:"Won",value:30000},{stage:"Lost",value:5000},
 {stage:"Proposal",value:20000,prob:60},{stage:"New",value:8000,prob:20}];
const r=revenueMetrics(deals);
ok(r.wonValue===40000,"won revenue is the sum of won deals");
ok(r.won===2&&r.lost===1&&r.open===2,"deals are split by stage");
ok(r.winRate===66.7,"win rate counts decided deals only, not open ones");
ok(r.averageDeal===20000,"average deal size from won deals");
ok(r.weightedPipeline===13600,"pipeline is weighted by each deal's own probability");
ok(r.weightedPipeline!==r.openValue,"forecast is never reported as revenue");
ok(r.lostToDate===5000,"lost value is tracked");
ok(r.stalled.length===1,"deals below 30% are flagged as stalled");
ok(r.biggestOpen.value===20000,"the biggest open deal is surfaced");
ok(revenueMetrics([]).hasData===false,"no deals means no data, not zero revenue");
ok(revenueMetrics([{stage:"New",value:100,prob:50}]).winRate===null,"win rate is null when nothing has been decided");

console.log("=== satisfaction ===");
const sat=satisfactionMetrics({
  conversations:[{sentiment:"Positive",ai:true},{sentiment:"Negative",state:"Human"},{sentiment:"Positive",ai:true},{sentiment:"Neutral"}],
  calls:[{sentiment:"Positive"}],
  tickets:[{pri:"Critical",st:"In progress",sla:"2h 12m left"},{pri:"Normal",st:"Closed"}]});
ok(sat.rated===5,"every rated conversation and call counts");
ok(sat.positive===3&&sat.negative===1,"sentiment is tallied correctly");
ok(sat.sentimentScore===75,"score is positive against positive plus negative");
ok(sat.csat===null&&sat.nps===null,"CSAT and NPS stay null until a real survey exists");
ok(/not a survey/.test(sat.source),"the score states what it is measured from");
ok(sat.openTickets===1,"open tickets counted");
ok(sat.critical===1,"critical tickets counted");
ok(sat.slaAtRisk===1,"an SLA running down is flagged");
ok(sat.escalationRate===25,"escalation rate from conversations");
ok(sat.unhappy.length===1,"unhappy customers are listed, not just counted");
ok(satisfactionMetrics({}).hasData===false,"nothing to measure means no data");

console.log("=== faults, ranked by cost ===");
const f=faultReport({
  tickets:[{id:"T1",s:"WMS sync failure",who:"Northbridge",pri:"Critical",st:"In progress",sla:"2h left"}],
  conversations:[{sentiment:"Negative",unread:8},{sentiment:"Negative",unread:6}],
  agents:[{name:"Sales",autonomy:4,guardrails:[]},{name:"Support",autonomy:2,status:"Paused",guardrails:["x"]}],
  integrations:[{name:"GoWhats",connected:false},{name:"Cal",connected:true}],
  deals:[{stage:"New",value:20000,prob:10}]});
ok(f.faults[0].severity==="critical","the critical fault is ranked first");
ok(/Northbridge/.test(f.faults[0].what),"and names the affected account");
ok(f.faults.every(x=>x.fix),"every fault says what to do about it");
ok(f.faults.every(x=>x.why),"and why it matters");
ok(f.faults.some(x=>x.area==="Governance"),"an unguarded high autonomy agent is a fault");
ok(f.faults.some(x=>x.area==="Revenue"),"stalled pipeline is a fault");
ok(f.faults.some(x=>x.area==="Inbox"),"unread backlog is a fault");
ok(f.counts.critical===1,"counts are grouped by severity");
ok(faultReport({}).faults.length===0,"a clean business reports no faults");
console.log("   sample fault:", JSON.stringify(f.faults[0]));
console.log(fails?("metrics: "+fails+" FAILED"):"business metrics: all 30 checks passed");
`;
const out = await build({ stdin:{contents:harness,resolveDir:path.join(dir,".."),loader:"jsx"}, bundle:true, platform:"node", format:"cjs", write:false, jsx:"automatic", logLevel:"error" });
const require2 = createRequire(import.meta.url); const Module = require2("module");
const m = new Module("mt"); m.paths = Module._nodeModulePaths(path.join(dir,".."));
m._compile(out.outputFiles[0].text, path.join(dir,"..","mt-test.cjs"));
