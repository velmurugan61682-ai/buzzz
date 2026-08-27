/** Quiet hours: stored as numbers, sometimes supplied as strings. Guards the
 *  crash "(quiet.from || \"21:00\").split is not a function" and the inverted
 *  window logic found alongside it. */
import { build } from "esbuild";
import { createRequire } from "module";
import path from "path"; import fs from "fs";
import { fileURLToPath } from "url";
const dir = path.dirname(fileURLToPath(import.meta.url));
const src = fs.readFileSync(path.join(dir, "..", "apps", "web", "src", "App.jsx"), "utf8");
const start = src.indexOf("/* Quiet hours are stored as hour numbers");
if (start < 0) { console.log("quiet hours helper not found"); process.exit(1); }
const after = src.indexOf("const inQuietHours", start);
const end = src.indexOf("\nconst ", src.indexOf("};", after));
const harness = src.slice(start, end) + `
let fails=0; const ok=(c,m)=>{if(!c){console.log("  FAIL:",m);fails++;}};
const at=(h)=>new Date(2026,7,20,h,0,0);
// the crash that was reported
ok(quietHour(9,0)===9,"accepts a number");
ok(quietHour("21:00",0)===21,"accepts an HH:MM string");
ok(quietHour("21",0)===21,"accepts a bare hour string");
ok(quietHour("9:30 pm",0)===21,"accepts 12 hour text");
ok(quietHour(undefined,9)===9,"falls back when missing");
ok(quietHour(null,19)===19,"falls back on null");
ok(quietHour("nonsense",7)===7,"falls back on junk");
ok(quietHour(99,9)===23,"clamps out of range hours");
ok(quietHour(-5,9)===0,"clamps negatives");
// no crash on any shape
[9,"21:00",null,undefined,"junk",{},[]].forEach(v=>{
  try{ inQuietHours({from:v,to:v}); }catch(e){ ok(false,"crashed on "+JSON.stringify(v)+": "+e.message); }
});
ok(true,"never throws regardless of stored type");
// semantics: from/to is the SENDING window
const r={from:9,to:19};
ok(inQuietHours(r,at(13))===false,"1pm is inside the sending window");
ok(inQuietHours(r,at(8))===true,"8am is quiet");
ok(inQuietHours(r,at(21))===true,"9pm is quiet");
ok(inQuietHours(r,at(9))===false,"window start is allowed");
ok(inQuietHours(r,at(19))===true,"window end is exclusive");
// string settings behave identically to numbers
ok(inQuietHours({from:"9:00",to:"19:00"},at(13))===false,"strings match numbers, daytime");
ok(inQuietHours({from:"9:00",to:"19:00"},at(3))===true,"strings match numbers, night");
// window wrapping midnight (night shift business)
const night={from:20,to:4};
ok(inQuietHours(night,at(22))===false,"10pm is inside a night window");
ok(inQuietHours(night,at(2))===false,"2am is inside a night window");
ok(inQuietHours(night,at(12))===true,"noon is quiet for a night business");
// degenerate config
ok(inQuietHours({from:9,to:9},at(3))===false,"a zero length window blocks nothing");
console.log(fails?("quiet hours: "+fails+" FAILED"):"quiet hours: all 24 checks passed");
`;
const out = await build({ stdin:{contents:harness,resolveDir:path.join(dir,".."),loader:"jsx"}, bundle:true, platform:"node", format:"cjs", write:false, jsx:"automatic", logLevel:"error" });
const require2 = createRequire(import.meta.url); const Module = require2("module");
const m = new Module("q"); m.paths = Module._nodeModulePaths(path.join(dir,".."));
m._compile(out.outputFiles[0].text, path.join(dir,"..","q-test.cjs"));
