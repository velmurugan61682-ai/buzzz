/** Comment to DM engine tests: keyword matching, follow gate, rate limits,
 *  tracked links, validation and BUZZZ's own campaign suggestions. */
import { build } from "esbuild";
import { createRequire } from "module";
import path from "path"; import fs from "fs";
import { fileURLToPath } from "url";
const dir = path.dirname(fileURLToPath(import.meta.url));
const src = fs.readFileSync(path.join(dir, "..", "apps", "web", "src", "App.jsx"), "utf8");
const start = src.indexOf("/* COMMENT TO DM ENGINE");
const end = src.indexOf("const NAV = [");
if (start < 0 || end < 0) { console.log("comment-to-dm engine not found"); process.exit(1); }
const harness = src.slice(start - 75, end) + `
let fails=0; const ok=(c,m)=>{ if(!c){console.log("  FAIL:",m); fails++;} };
// keyword matching
ok(matchKeywords("send me the LINK please",["link"])==="link","whole word match, case insensitive");
ok(matchKeywords("I linked it",["link"])===null,"whole word must not fire on linked");
ok(matchKeywords("I linked it",["link"],"partial")==="link","partial mode matches inside words");
ok(matchKeywords("price?",["price"])==="price","punctuation adjacent still matches");
ok(matchKeywords("nothing here",["link"])===null,"no match returns null");
ok(matchKeywords("¿precio?",["precio"])==="precio","non ascii boundaries work");
// personalisation
ok(renderDM("Hi {username}!",{username:"sam"})==="Hi @sam!","username token");
ok(renderDM("Hi {username}",{})==="Hi there","missing username falls back");
ok(renderDM("Hi {username}",{username:"@sam"})==="Hi @sam","no double at sign");
// decisions
const camp={id:"c1",status:"active",keywords:["link"],message:"hi {username}",accountHandle:"mystore",buttons:[]};
ok(evaluateComment({text:"link",username:"buyer"},camp,{}).action==="send","matching comment sends");
ok(evaluateComment({text:"link",username:"mystore"},camp,{}).reason==="your own comment","self comment filtered");
ok(evaluateComment({text:"hello",username:"b"},camp,{}).action==="skip","non matching skipped");
ok(evaluateComment({text:"link",username:"b"},{...camp,status:"paused"},{}).action==="skip","paused campaign skipped");
ok(evaluateComment({text:"link",username:"b"},camp,{alreadyReplied:true}).action==="skip","no duplicate DM");
// rate limit
const many=Array.from({length:750},()=>Date.now());
ok(evaluateComment({text:"link",username:"b"},camp,{sentTimes:many}).action==="queue","over limit queues not drops");
const old=Array.from({length:750},()=>Date.now()-2*60*60*1000);
ok(evaluateComment({text:"link",username:"b"},camp,{sentTimes:old}).action==="send","old sends fall out of the window");
// follow gate
const gated={...camp,followGate:true};
ok(evaluateComment({text:"link",username:"b"},gated,{}).action==="gate","follow gate asks first");
ok(evaluateComment({text:"link",username:"b"},gated,{followConfirmed:true}).action==="send","confirmed follower gets link");
ok(evaluateComment({text:"link",username:"b"},gated,{followStatusUnknown:true}).action==="send","fails open when status unknown");
// compose
const c2={...camp,businessName:"Acme",publicReply:true,publicReplyText:"sent {username}",buttons:[{id:"b1",label:"Open",url:"https://a.com"},{id:"b2",label:"Book",url:"https://b.com"},{id:"b3",label:"x",url:"https://c.com"}]};
const dm=composeDM(c2,{username:"sam"},"link");
ok(dm.buttons.length===2,"never more than two buttons");
ok(dm.buttons[0].short.startsWith("bzz.to/"),"tracked link generated");
ok(dm.buttons[0].code!==dm.buttons[1].code,"each button tracked separately");
ok(dm.publicReply==="sent @sam","public reply personalised");
// validation
ok(!validateCdmCampaign({name:"",keywords:[],message:""}).ok,"empty campaign rejected");
ok(validateCdmCampaign({name:"A",keywords:["x"],message:"hi"}).ok,"minimal valid campaign accepted");
ok(!validateCdmCampaign({name:"A",keywords:["x"],message:"hi",buttons:[{label:"Go",url:"nope"}]}).ok,"bad url rejected");
ok(!validateCdmCampaign({name:"A",keywords:["x"],message:"x".repeat(1001)}).ok,"over long DM rejected");
// stats
ok(linkStats(25,100).ctr===25,"ctr computed");
ok(linkStats(0,0).ctr===0,"no divide by zero");
// suggestions
ok(suggestCdmCampaigns({profile:{industry:"healthcare"},appointments:{relevant:true},goals:[]}).includes("booking"),"clinic gets a booking campaign");
ok(suggestCdmCampaigns({profile:{industry:"hospitality"},appointments:{relevant:false},goals:[]}).includes("menu"),"restaurant gets a menu campaign");
ok(suggestCdmCampaigns({profile:{industry:"retail"},appointments:{relevant:false},goals:["sales"]}).length>0,"shop gets something");
console.log(fails?("comment-to-dm engine: "+fails+" FAILED"):"comment-to-dm engine: all 30 checks passed");
`;
const out = await build({ stdin:{contents:harness,resolveDir:path.join(dir,".."),loader:"jsx"}, bundle:true, platform:"node", format:"cjs", write:false, jsx:"automatic", logLevel:"error" });
const require2 = createRequire(import.meta.url); const Module = require2("module");
const m = new Module("cdm"); m.paths = Module._nodeModulePaths(path.join(dir,".."));
m._compile(out.outputFiles[0].text, path.join(dir,"..","cdm-test.cjs"));
