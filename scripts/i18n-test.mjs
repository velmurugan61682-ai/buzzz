/** Internationalisation: registry scale, fallback chain, placeholder safety,
 *  catalog health, region suggestion, detection, language memory, formatting,
 *  RTL, campaign localisation, and governance parity across languages. */
import { build } from "esbuild";
import { createRequire } from "module";
import path from "path"; import fs from "fs";
import { fileURLToPath } from "url";
const dir = path.dirname(fileURLToPath(import.meta.url));
const src = fs.readFileSync(path.join(dir, "..", "apps", "web", "src", "App.jsx"), "utf8");
const i18nStart = src.indexOf("/* INTERNATIONALISATION");
const i18nEnd = src.indexOf("const LOCALES = {");
const govStart = src.indexOf("const ACTIONS = {");
const govEnd = src.indexOf("/* ---- guardrails are matched against");
if (i18nStart < 0 || govStart < 0) { console.log("engines not found"); process.exit(1); }
const names = [...new Set([...src.slice(govStart, govEnd).matchAll(/Icon:\s*([A-Z]\w+)/g)].map((m) => m[1]))];
const stub = names.length ? "const " + names.map((n) => `${n}=null`).join(",") + ";\n" : "";
const harness = stub + 'const CH={whatsapp:{label:"WhatsApp"}};\n'
  + src.slice(govStart, govEnd) + src.slice(i18nStart - 75, i18nEnd) + `
let fails=0; const ok=(c,m)=>{if(!c){console.log("  FAIL:",m);fails++;}};
console.log("=== scale ===");
ok(Object.keys(LANGS).length>=40,"registry covers 40+ languages ("+Object.keys(LANGS).length+")");
ok(Object.keys(REGIONS).length>=25,"regions cover every major market ("+Object.keys(REGIONS).length+")");
// adding a language is data only
LANGS.qq={name:"Testish",native:"Testish",dir:"rtl"}; CATALOGS.qq={"action.save":"Qsave"};
ok(translate("action.save","qq")==="Qsave","a new language works with no logic change");
ok(isRTL("qq")===true,"direction comes from the registry row");
ok(translate("action.cancel","qq")==="Cancel","untranslated key falls back to English");
delete LANGS.qq; delete CATALOGS.qq;
console.log("=== fallback chain never shows undefined ===");
["en","ta","hi","zh","ms","ar","es","fr","de"].forEach(l=>{
  Object.keys(CATALOGS.en).forEach(k=>{
    const v=translate(k,l);
    if(!v||/undefined|null|missing_key/.test(v)) { ok(false,"bad value for "+k+" in "+l); }
  });
});
ok(true,"every key resolves in all 9 test languages");
ok(translate("totally.unknown.key","ta")==="Key","an unknown key still renders readable text");
ok(translate("nav.home","zh-HK")==="首页","a regional variant falls back to its base language");
console.log("=== placeholders survive translation ===");
ok(translate("appointment.confirmed","ta",{when:"நாளை"}).includes("நாளை"),"variable is filled in Tamil");
ok(translate("appointment.confirmed","ar",{when:"غدا"}).includes("غدا"),"variable is filled in Arabic");
ok(translate("appointment.confirmed","en",{}).includes("{{when}}"),"missing variable stays visible, never undefined");
ok(interpolate("Hello {{name}}",{name:"Sam"})==="Hello Sam","basic interpolation");
console.log("=== catalog health ===");
const rep=catalogReport("ta");
ok(rep.percent>0&&rep.percent<100,"Tamil is partially translated and says so ("+rep.percent+"%)");
ok(rep.missing.length>0,"missing keys are listed for the admin screen");
ok(catalogReport("en").percent===100,"English is the reference at 100%");
CATALOGS.ta["appointment.reminder"]="நினைவூட்டல்: உங்கள் சந்திப்பு.";
ok(catalogReport("ta").placeholderIssues.length===1,"a dropped {{variable}} is detected");
delete CATALOGS.ta["appointment.reminder"];
ok(catalogCoverage()[0].lang==="en","coverage is ranked for the admin view");
console.log("=== region suggests, never imposes ===");
const sg=suggestLocale({country:"SG",browserLangs:["ta-IN","en"]});
ok(sg.language==="ta","a Tamil speaker in Singapore is offered Tamil, not defaulted to English");
ok(sg.options.length===4,"Singapore offers all four official languages");
ok(sg.suggested===true,"the result is explicitly a suggestion");
ok(suggestLocale({country:"CA"}).options.includes("fr"),"Canada offers French");
ok(suggestLocale({country:"SG"}).currency==="SGD","currency comes with the region");
ok(suggestLocale({country:"XX"}).language==="en","an unknown country still yields something usable");
console.log("=== staff and customer languages are separate ===");
ok(resolveLanguage({user:"ta",workspace:"en"},"ui")==="ta","the employee sees Tamil");
ok(resolveLanguage({customer:"zh",user:"ta",workspace:"en"},"customer")==="zh","the customer receives Mandarin");
ok(resolveLanguage({agent:"ms",workspace:"en"},"customer")==="ms","agent language is used when the customer has none");
ok(resolveLanguage({},"ui")==="en","falls back to English");
ok(resolveLanguage({user:"xx"},"ui")==="en","an unsupported code falls back");
console.log("=== detection: explicit beats guessing ===");
ok(detectLanguage("வணக்கம், நாளை சந்திப்பு உண்டா?").lang==="ta","Tamil script detected");
ok(detectLanguage("你好，我想预约").lang==="zh","Chinese script detected");
ok(detectLanguage("مرحبا").lang==="ar","Arabic script detected");
ok(detectLanguage("please reply to me in Tamil").confidence==="explicit","an explicit request is explicit");
ok(detectLanguage("please reply to me in Tamil").lang==="ta","and resolves to the right code");
ok(detectLanguage("hello there").confidence==="low","latin text is only a low confidence guess");
console.log("=== language memory never guesses from identity ===");
const c1=rememberLanguage({id:"c1",name:"Priya Raman",country:"IN"},detectLanguage("hello there"));
ok(c1.preferredLanguage===undefined,"a low confidence guess is not stored");
const c2=rememberLanguage({id:"c2"},detectLanguage("please reply to me in Tamil"));
ok(c2.preferredLanguage==="ta"&&c2.languageLocked===true,"an explicit request is stored and locked");
const c3=rememberLanguage(c2,detectLanguage("你好"));
ok(c3.preferredLanguage==="ta","a locked preference is not overwritten by a script guess");
const c4=rememberLanguage(c2,detectLanguage("please reply to me in mandarin"));
ok(c4.preferredLanguage==="zh","the customer can change it explicitly");
console.log("=== formatting ===");
ok(fmtMoneyI18n(1234.5,"INR","hi").includes("1,234"),"INR formatted for Hindi");
ok(fmtMoneyI18n(1234.5,"JPY","ja").length>0,"JPY formatted for Japanese");
ok(fmtMoneyI18n(99,"SGD","en")!==fmtMoneyI18n(99,"USD","en"),"currency is not conversion, only formatting");
ok(fmtDateI18n("2026-08-20","en","US")!==fmtDateI18n("2026-08-20","en","GB"),"US and UK date formats differ");
ok(fmtNumberI18n(1234567.89,"de").includes("."),"German thousands separator");
ok(fmtDateI18n("bad-date","en").length>0,"an invalid date never crashes the UI");
console.log("=== RTL ===");
["ar","he","fa","ur"].forEach(l=>ok(isRTL(l),l+" is right to left"));
["en","ta","zh","ms"].forEach(l=>ok(!isRTL(l),l+" is left to right"));
console.log("=== campaigns localise automatically ===");
const aud=[{id:1,preferredLanguage:"ta"},{id:2,preferredLanguage:"zh"},{id:3},{id:4,preferredLanguage:"ta"}];
const groups=localiseAudience(aud,{defaultLang:"en"});
ok(groups.length===3,"one campaign splits into three language groups");
ok(groups.find(g=>g.lang==="ta").contacts.length===2,"Tamil group has both Tamil contacts");
ok(groups.find(g=>g.lang==="en").contacts.length===1,"contacts without a preference get the default");
ok(localiseAudience(aud,{enabled:false}).length===1,"localisation can be turned off");
console.log(fails?("i18n: "+fails+" FAILED"):"i18n: all checks passed");

/* language must never be a governance bypass: the same request in Tamil,
   Arabic and English must reach the identical decision */
console.log("=== language cannot bypass governance ===");
const agent={name:"A",status:"Active",autonomy:4,perms:Object.keys(ACTIONS).reduce((a,k)=>(a[k]=true,a),{}),
  tools:["CRM","GoWhats","Gmail","Calendar","Payments","MrAssistant.ai","Publisher","InstaxBot","Campaigns","Workflows"],channels:[],allowDestructive:false};
[["CAN_CREATE_DEAL",2],["CAN_START_CAMPAIGN",2],["CAN_ISSUE_REFUND",4],["CAN_SEND_WHATSAPP",2]].forEach(([action,ceiling])=>{
  const en=decide({action,agent,ceiling,ctx:{requestedBy:"user",lang:"en"}});
  const ta=decide({action,agent,ceiling,ctx:{requestedBy:"user",lang:"ta"}});
  const ar=decide({action,agent,ceiling,ctx:{requestedBy:"user",lang:"ar"}});
  ok(en.verdict===ta.verdict&&en.verdict===ar.verdict,action+" decided identically in en, ta and ar");
  ok(en.required===ta.required,action+" requires the same level regardless of language");
});
console.log(fails?("i18n+governance: "+fails+" FAILED"):"i18n + governance: language is not a bypass");
`;
const out = await build({ stdin:{contents:harness,resolveDir:path.join(dir,".."),loader:"jsx"}, bundle:true, platform:"node", format:"cjs", write:false, jsx:"automatic", logLevel:"error" });
const require2 = createRequire(import.meta.url); const Module = require2("module");
const m = new Module("i18n"); m.paths = Module._nodeModulePaths(path.join(dir,".."));
m._compile(out.outputFiles[0].text, path.join(dir,"..","i18n-test.cjs"));
