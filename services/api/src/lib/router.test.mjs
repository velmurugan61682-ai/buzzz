/** The router: every modality on one key, and every unit metered correctly.
 *  Mis-metering an image as if it were tokens is how a bill goes wrong. */
import {
  FUNCTIONS, CATALOG, OR_BASE, modelsFor, creditsForCall, validateProfile,
  defaultProfile, createRouter,
} from "./router.js";
import { CREDIT_USD } from "./llm.js";

let fails = 0;
const ok = (c, m) => { if (!c) { console.log("  FAIL:", m); fails++; } };
const json = (status, body) => ({ ok: status < 400, status, json: async () => body });

/* ---- every function has models, and every model declares its unit ---- */
Object.keys(FUNCTIONS).forEach((fn) => {
  if (fn === "video") return;
  ok(modelsFor(fn).length > 0, `${fn} has at least one model`);
});
Object.entries(CATALOG).forEach(([id, m]) => {
  ok(["token", "image", "minute", "char"].includes(m.unit), `${id} declares a billing unit`);
  ok(creditsForCall(id, { inTokens: 1000, outTokens: 200, images: 1, seconds: 60, characters: 1000 }) !== null,
     `${id} can be metered`);
});

/* ---- the units are genuinely different, and treated as such ---- */
const imageCredits = creditsForCall("black-forest-labs/flux-1.1-pro", { images: 1 });
const tokenCredits = creditsForCall("openai/gpt-4o-mini", { inTokens: 1000, outTokens: 200 });
ok(Math.round(imageCredits) === 40, "one image is metered per image, not per token (" + Math.round(imageCredits) + " credits)");
ok(imageCredits > tokenCredits * 50, "and costs far more than a short text call");
ok(creditsForCall("black-forest-labs/flux-1.1-pro", { images: 4 }) === imageCredits * 4, "four images cost four times one");

/* transcription is per minute, and part minutes are billed as whole ones */
const oneMin = creditsForCall("openai/whisper-1", { seconds: 60 });
ok(creditsForCall("openai/whisper-1", { seconds: 61 }) === oneMin * 2,
   "a 61 second recording bills as two minutes, because the provider bills that way");
ok(creditsForCall("openai/whisper-1", { seconds: 1 }) === oneMin, "a one second clip still bills a minute");

/* speech is per character */
const tts = creditsForCall("hexgrad/kokoro-82m", { characters: 1_000_000 });
ok(Math.round(tts) === Math.round(0.80 / CREDIT_USD), "speech is metered per character");
ok(creditsForCall("openai/gpt-4o-mini-tts", { characters: 1000 }) >
   creditsForCall("hexgrad/kokoro-82m", { characters: 1000 }) * 10,
   "an expensive voice costs proportionally more");

/* an unmetered model must never be callable */
ok(creditsForCall("someone/unknown-model", { inTokens: 1000 }) === null,
   "a model we cannot meter returns null rather than a guess of zero");

/* ---- a workspace picks a model per function ---- */
const good = validateProfile({
  assistant: "openai/gpt-4o-mini", agentReply: "google/gemini-2.0-flash-001",
  imageGen: "black-forest-labs/flux-1.1-pro", speechToText: "openai/whisper-1",
  textToSpeech: "hexgrad/kokoro-82m", embedding: "openai/text-embedding-3-small",
});
ok(good.ok, "a sensible mix and match profile is accepted");
ok(Object.keys(good.profile).length === 6, "and every choice is kept");

/* the mistakes people actually make */
const wrong = validateProfile({ assistant: "openai/gpt-4o-mini", agentReply: "google/gemini-2.0-flash-001",
  imageGen: "openai/whisper-1" });
ok(!wrong.ok, "a transcription model assigned to image generation is refused");
ok(wrong.errors.some((e) => e.code === "wrong_function"), "and the reason names the mismatch");

const missing = validateProfile({ imageGen: "black-forest-labs/flux-1.1-pro" });
ok(!missing.ok && missing.errors.some((e) => e.code === "required"),
   "a profile with no assistant model is refused: the product would not work");

const unknown = validateProfile({ assistant: "acme/does-not-exist", agentReply: "openai/gpt-4o-mini" });
ok(!unknown.ok && unknown.errors.some((e) => e.code === "unknown_model"), "an invented model is refused");
ok(!validateProfile({ dancing: "openai/gpt-4o-mini" }).ok, "an invented function is refused");

/* the plan still decides what may be chosen */
const tooGood = validateProfile(
  { assistant: "anthropic/claude-sonnet-4", agentReply: "openai/gpt-4o-mini" },
  { allowedTiers: ["fast"] });
ok(!tooGood.ok && tooGood.errors.some((e) => e.upgrade), "a model outside the plan is an upgrade prompt, not a fault");

/* ---- defaults ---- */
const def = defaultProfile(["fast"]);
ok(def.assistant && def.agentReply, "a starting profile covers the required functions");
ok(CATALOG[def.assistant].tier === "fast", "and defaults to a cheap model rather than the best one");
ok(Object.keys(def).length >= 5, "with a sensible choice for the optional functions too");

/* ---- the calls ---- */
let seen = [];
const r = createRouter({ apiKey: "sk-or-x", workspaceId: "w1",
  fetchImpl: async (url, o) => {
    seen.push({ url, body: o.body ? JSON.parse(o.body) : null, headers: o.headers, method: o.method });
    if (url.includes("/chat/completions")) return json(200, { model: "m", choices: [{ message: { content: "hi" } }], usage: { prompt_tokens: 100, completion_tokens: 20 } });
    if (url.includes("/images")) return json(200, { data: [{ b64_json: "AAA" }] });
    if (url.includes("/audio/transcriptions")) return json(200, { text: "hello there", duration: 30 });
    if (url.includes("/audio/speech")) return json(200, { audio: "BBB" });
    if (url.includes("/embeddings")) return json(200, { data: [{ embedding: [0.1, 0.2] }], usage: { prompt_tokens: 8 } });
    if (url.includes("/videos")) return json(200, { id: "job1", status: "queued" });
    return json(200, {});
  } });

const chat = await r.chat({ model: "openai/gpt-4o-mini", messages: [{ role: "user", content: "hi" }] });
ok(chat.text === "hi" && chat.credits > 0, "a chat call returns text and its cost");
ok(seen[0].url === OR_BASE + "/chat/completions", "chat uses the chat endpoint");
ok(seen[0].headers["X-Workspace"] === "w1", "usage is attributed to the workspace");
ok(seen[0].headers.authorization === "Bearer sk-or-x", "one key for every modality");

const img = await r.image({ model: "black-forest-labs/flux-1.1-pro", prompt: "a shopfront" });
ok(img.images.length === 1, "an image comes back");
ok(seen[1].url === OR_BASE + "/images", "image generation uses its own endpoint, not chat");
ok(Math.round(img.credits) === 40, "and is metered per image");

const stt = await r.transcribe({ model: "openai/whisper-1", audioBase64: "AAA", durationSeconds: 90 });
ok(stt.text === "hello there", "transcription returns text");
ok(seen[2].url === OR_BASE + "/audio/transcriptions", "transcription uses its own endpoint");
ok(stt.credits === creditsForCall("openai/whisper-1", { seconds: 90 }),
   "and is metered on the audio length the caller measured, not the text returned");

const spoken = await r.speak({ model: "hexgrad/kokoro-82m", text: "hello" });
ok(spoken.audio === "BBB" && seen[3].url === OR_BASE + "/audio/speech", "speech uses its own endpoint");
ok(spoken.usage.characters === 5, "and is metered on the characters spoken");

const emb = await r.embed({ model: "openai/text-embedding-3-small", input: ["a", "b"] });
ok(emb.vectors.length === 1 && seen[4].url === OR_BASE + "/embeddings", "embeddings use their own endpoint");

const vid = await r.startVideo({ model: "x", prompt: "y" });
ok(vid.jobId === "job1" && vid.status === "queued", "video starts a job rather than blocking");

/* ---- failures ---- */
const bad = createRouter({ apiKey: "k", fetchImpl: async () => json(401, { error: { message: "no" } }) });
try { await bad.chat({ model: "openai/gpt-4o-mini", messages: [] }); ok(false, "401 should throw"); }
catch (e) { ok(e.code === "bad_key" && !e.retryable, "a rejected key is not retried"); }
const nokey = createRouter({ fetchImpl: async () => json(200, {}) });
try { await nokey.chat({ model: "x", messages: [] }); ok(false, "no key should throw"); }
catch (e) { ok(e.code === "no_key", "an unconfigured workspace is told so"); }

console.log(fails ? `router: ${fails} FAILED` : "model router: all checks passed");
process.exit(fails ? 1 : 0);
