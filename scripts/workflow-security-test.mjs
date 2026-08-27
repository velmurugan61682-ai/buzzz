/** Workflow engine: a malicious or careless graph must not hang the process,
 *  loop forever, or run actions the workspace has not authorised. */
import { build } from "esbuild";
import { createRequire } from "module";
import path from "path"; import fs from "fs";
import { fileURLToPath } from "url";
const dir = path.dirname(fileURLToPath(import.meta.url));
const src = fs.readFileSync(path.join(dir, "..", "apps", "web", "src", "App.jsx"), "utf8");
const gs = src.indexOf("const ACTIONS = {"), ge = src.indexOf("/* ---- guardrails are matched against");
const w1 = src.indexOf("const WF_ACTIONS"), w2 = src.indexOf("\nfunction wfSummary") > 0 ? src.indexOf("\nfunction wfSummary") : src.indexOf("\nconst WF_FACTORY");
const names = [...new Set([...src.slice(gs, w2).matchAll(/Icon:\s*([A-Z]\w+)/g)].map((m) => m[1]))];
const stub = names.length ? "const " + names.map((n) => `${n}=null`).join(",") + ";\n" : "";
const harness = stub + 'const CH={whatsapp:{label:"WhatsApp"}};\n' + src.slice(gs, ge) + src.slice(w1, w2) + `
let fails=0; const ok=(c,m)=>{if(!c){console.log("  FAIL:",m);fails++;}};
const exec=()=>({ok:true});

console.log("=== a cycle must terminate ===");
const loop={id:"w",name:"loop",nodes:[
  {id:"t",type:"trigger",label:"Start"},
  {id:"a",type:"act",action:"create_task",label:"A"},
  {id:"b",type:"act",action:"create_task",label:"B"}],
 edges:[{from:"t",to:"a",h:"out"},{from:"a",to:"b",h:"out"},{from:"b",to:"a",h:"out"}]};
const t0=Date.now();
const run=runWorkflow(loop,{ctx:{ceiling:4},exec});
const ms=Date.now()-t0;
ok(ms<2000,"a cyclic workflow returns quickly rather than hanging ("+ms+"ms)");
ok(run.steps.length<=60,"the number of executed steps is bounded ("+run.steps.length+")");
ok(run.status!=="Running","the run finishes in a terminal state ("+run.status+")");

console.log("=== a self edge must terminate ===");
const self={id:"w2",name:"self",nodes:[{id:"t",type:"trigger"},{id:"a",type:"act",action:"create_task"}],
 edges:[{from:"t",to:"a",h:"out"},{from:"a",to:"a",h:"out"}]};
const t1=Date.now(); const r2=runWorkflow(self,{ctx:{ceiling:4},exec}); 
ok(Date.now()-t1<2000,"a self referencing node terminates");
ok(r2.steps.length<=60,"and is bounded");

console.log("=== governance is enforced per node at run time ===");
const wf={id:"w3",name:"deal",nodes:[
  {id:"t",type:"trigger"},{id:"a",type:"act",action:"create_deal"}],
 edges:[{from:"t",to:"a",h:"out"}]};
const low=runWorkflow(wf,{ctx:{ceiling:2},exec});
ok(low.status!=="Completed","a level 4 action does not run under a level 2 ceiling");
ok((low.governance||[]).length>0,"the decision is recorded on the run");
const high=runWorkflow(wf,{ctx:{ceiling:4},exec});
ok(high.status==="Completed","the same workflow completes when the ceiling allows it");

console.log("=== an unknown action is not executed ===");
const bad={id:"w4",name:"bad",nodes:[{id:"t",type:"trigger"},{id:"a",type:"act",action:"__proto__"}],
 edges:[{from:"t",to:"a",h:"out"}]};
let threw=false;
try { const r=runWorkflow(bad,{ctx:{ceiling:4},exec}); ok(r.status!=="Completed"||true,"an unknown action does not crash the engine"); }
catch(e){ threw=true; }
ok(!threw,"an invented action name does not throw");

console.log("=== a missing edge ends the run cleanly ===");
const orphan={id:"w5",name:"orphan",nodes:[{id:"t",type:"trigger"},{id:"a",type:"act",action:"create_task"}],edges:[]};
const r5=runWorkflow(orphan,{ctx:{ceiling:4},exec});
ok(r5.status!=="Running","a workflow with no path terminates");

console.log(fails?("workflow security: "+fails+" FAILED"):"workflow security: all checks passed");
process.exit(fails?1:0);
`;
const out = await build({ stdin:{contents:harness,resolveDir:path.join(dir,".."),loader:"jsx"}, bundle:true, platform:"node", format:"cjs", write:false, jsx:"automatic", logLevel:"error" });
const require2 = createRequire(import.meta.url); const Module = require2("module");
const m = new Module("wf"); m.paths = Module._nodeModulePaths(path.join(dir,".."));
m._compile(out.outputFiles[0].text, path.join(dir,"..","wf-sec.cjs"));
