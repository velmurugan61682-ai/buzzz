/** Virtual appointment logic: link validation, confirmation gating, reminders,
 *  conflicts, timezones, analytics and agent honesty. */
import { build } from "esbuild";
import { createRequire } from "module";
import path from "path"; import fs from "fs";
import { fileURLToPath } from "url";
const dir = path.dirname(fileURLToPath(import.meta.url));
const src = fs.readFileSync(path.join(dir, "..", "client", "src", "App.jsx"), "utf8");
const start = src.indexOf("/* VIRTUAL APPOINTMENTS");
const end = src.indexOf("const NAV = [");
if (start < 0 || end < 0) { console.log("virtual appointment engine not found"); process.exit(1); }
const harness = src.slice(start - 75, end) + `
let fails=0; const ok=(c,m)=>{if(!c){console.log("  FAIL:",m);fails++;}};
const V=(x)=>({type:"virtual",start:new Date(Date.now()+864e5).toISOString(),durMin:30,...x});
// never invent a link
ok(meetingMessage(V({meetingState:"pending"}),{when:"3pm"})===null,"no message while the meeting is still pending");
ok(meetingMessage(V({meetingState:"failed"}),{when:"3pm"})===null,"no message when meeting creation failed");
const msg=meetingMessage(V({meetingState:"ready",meetUrl:"https://meet.google.com/abc-defg-hij"}),{contactName:"Sam",when:"20 Aug at 3:00 PM"});
ok(msg&&msg.includes("https://meet.google.com/abc-defg-hij"),"real link is included once ready");
ok(meetingMessage({type:"in_person",start:new Date().toISOString()},{when:"3pm"})!==null,"in person appointments still get a confirmation");
// link validation
ok(acceptMeetLink("https://meet.google.com/abc-defg-hij")!==null,"accepts a real Meet URL");
ok(acceptMeetLink("https://evil.com/meet")===null,"rejects a non Google link");
ok(acceptMeetLink("https://meet.google.com/")===null,"rejects a malformed Meet URL");
ok(acceptMeetLink("")===null,"rejects an empty link");
// confirmation gating
ok(canConfirmAppt(V({meetingState:"pending"})).ok===false,"cannot confirm before the meeting exists");
ok(canConfirmAppt(V({meetingState:"ready",meetUrl:"https://meet.google.com/abc-defg-hij"})).ok===true,"can confirm once ready");
ok(canConfirmAppt(V({meetingState:"failed",meetingError:"Google rejected the request"})).reason.includes("Google"),"failure reason is surfaced");
ok(canConfirmAppt({type:"in_person"}).ok===true,"in person needs no meeting");
// reminders
const a=V({start:new Date(Date.now()+2*864e5).toISOString()});
const rs=planReminders(a);
ok(rs.length===3,"three reminders planned by default");
ok(rs[0].offset===1440&&rs[2].offset===15,"reminders ordered furthest out first");
ok(planReminders(a,{existing:[{offset:1440,channel:"whatsapp"}]}).length===2,"never schedules a duplicate reminder");
ok(planReminders(V({start:new Date(Date.now()+10*60000).toISOString()})).length===0,"no reminders scheduled in the past");
ok(planReminders(a,{offsets:[60,60,60]}).length===1,"repeated offsets collapse to one");
const moved=reshiftReminders(rs,new Date(Date.now()+5*864e5).toISOString());
ok(moved.every(r=>new Date(r.sendAt)>new Date()),"reminders move with a reschedule");
ok(cancelReminders(rs).every(r=>r.status==="cancelled"),"cancelling kills pending reminders");
ok(reshiftReminders([{offset:15,channel:"x",status:"sent",sendAt:"2020-01-01"}],new Date().toISOString())[0].status==="sent","already sent reminders are untouched");
// conflicts
const base={id:"new",staffId:"st1",start:"2026-08-20T10:00:00Z",durMin:60};
const existing=[{id:"a1",staffId:"st1",start:"2026-08-20T10:30:00Z",durMin:60,status:"Confirmed",title:"Other"}];
ok(apptConflicts(base,existing).length===1,"overlapping appointment for the same staff is a conflict");
ok(apptConflicts(base,[{...existing[0],staffId:"st2"}]).length===0,"different staff is not a conflict");
ok(apptConflicts(base,[{...existing[0],status:"Cancelled"}]).length===0,"cancelled appointments do not block");
ok(apptConflicts(base,[],[{start:"2026-08-20T10:15:00Z",end:"2026-08-20T11:00:00Z"}]).length===1,"google busy block is a conflict");
ok(apptConflicts(base,[],[{start:"2026-08-20T12:00:00Z",end:"2026-08-20T13:00:00Z"}]).length===0,"non overlapping busy block is fine");
ok(apptConflicts(base,[{...existing[0],id:"new"}]).length===0,"an appointment never conflicts with itself");
// timezones
ok(fmtInZone("2026-08-20T09:30:00Z","Asia/Kolkata").includes("3:00"),"renders in the requested timezone");
ok(zoneNote("Asia/Kolkata","Europe/London")!==null,"flags a timezone difference");
ok(zoneNote("Asia/Kolkata","Asia/Kolkata")===null,"no note when zones match");
// analytics
const st=virtualStats([V({status:"Completed"}),V({status:"No show"}),V({status:"Cancelled"}),{type:"in_person",status:"Completed"}]);
ok(st.total===3,"counts only virtual appointments");
ok(st.attendanceRate===50,"attendance rate from completed versus no show");
ok(virtualStats([]).attendanceRate===null,"no attendance rate invented with no data");
// agent honesty
ok(bookingOutcome(VIRTUAL_STEPS).ok===true,"all steps done means booked");
const partial=bookingOutcome(["availability","staff","appointment","calendar"]);
ok(partial.ok===false&&partial.message.includes("not been told"),"agent must not claim success when a step failed");
console.log(fails?("virtual appointments: "+fails+" FAILED"):"virtual appointments: all 35 checks passed");
`;
const out = await build({ stdin:{contents:harness,resolveDir:path.join(dir,".."),loader:"jsx"}, bundle:true, platform:"node", format:"cjs", write:false, jsx:"automatic", logLevel:"error" });
const require2 = createRequire(import.meta.url); const Module = require2("module");
const m = new Module("va"); m.paths = Module._nodeModulePaths(path.join(dir,".."));
m._compile(out.outputFiles[0].text, path.join(dir,"..","va-test.cjs"));
