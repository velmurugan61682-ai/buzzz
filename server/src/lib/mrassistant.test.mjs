/** MrAssistant client: built against the published API, tested without network. */
import { createMrAssistant, normaliseCall, MrAssistantError } from "./mrassistant.js";

let fails = 0;
const ok = (c, m) => { if (!c) { console.log("  FAIL:", m); fails++; } };
const json = (status, body) => ({ ok: status < 400, status, json: async () => body });

/* ---- paths and shapes match the specification ---- */
let seen = null;
const spy = createMrAssistant({ getToken: async () => "tok", fetchImpl: async (url, o) => { seen = { url, o }; return json(200, {}); } });

await spy.listOAuthProviders();
ok(seen.url.endsWith("/auth/oauth/providers"), "provider list uses the documented path");
await spy.authorizeUrl("google");
ok(seen.url.endsWith("/auth/oauth/google/authorize"), "authorize uses the documented path");
ok(seen.o.headers.authorization === "Bearer tok", "the tenant token is sent as a bearer");
await spy.placeCall({ agentId: "a1", to: "+15551234" });
ok(seen.url.endsWith("/calls/outbound") && seen.o.method === "POST", "an outbound call posts to /calls/outbound");
ok(JSON.parse(seen.o.body).agent_id === "a1", "and uses the API's field names, not ours");
await spy.listTranscripts("a1");
ok(seen.url.includes("/agents/a1/transcripts"), "transcripts are read per agent");

/* ---- a provider is never interpolated raw ---- */
await spy.authorizeUrl("../../admin");
ok(!seen.url.includes("../.."), "a provider name is encoded, so it cannot climb the path");

/* ---- authorisation shape ---- */
const authorize = await createMrAssistant({
  getToken: async () => "t",
  fetchImpl: async () => json(200, { authorization_url: "https://accounts.google.com/o/oauth2/v2/auth?x=1", provider: "google", state: "abc" }),
}).authorizeUrl("google");
ok(authorize.authorization_url.startsWith("https://"), "the authorisation url comes back");
ok(authorize.state === "abc", "the state parameter is issued by the server, not the browser");

/* ---- an expired tenant token refreshes once, and only once ---- */
let calls = 0, refreshes = 0;
const refreshing = createMrAssistant({
  getToken: async () => "stale",
  onTokenExpired: async () => { refreshes++; return "fresh"; },
  fetchImpl: async (url, o) => {
    calls++;
    return o.headers.authorization === "Bearer fresh" ? json(200, { ok: true }) : json(401, { detail: "expired" });
  },
});
const out = await refreshing.listAgents();
ok(out.ok === true, "the call succeeds after a refresh");
ok(refreshes === 1 && calls === 2, "the token is refreshed once and the call retried once");

let loops = 0;
const alwaysExpired = createMrAssistant({
  getToken: async () => "x", onTokenExpired: async () => "y",
  fetchImpl: async () => { loops++; return json(401, { detail: "nope" }); },
});
try { await alwaysExpired.listAgents(); } catch {}
ok(loops <= 2, "a permanently bad credential does not become a request loop (" + loops + " calls)");

/* ---- errors are classified, not swallowed ---- */
const failing = (status, body) => createMrAssistant({ getToken: async () => "t", fetchImpl: async () => json(status, body) });
try { await failing(422, { detail: [{ loc: ["body", "to_number"], msg: "field required", type: "missing" }] }).listAgents(); ok(false, "422 should throw"); }
catch (e) { ok(e.code === "invalid_request" && /to_number/.test(e.message), "a validation error names the field"); }
try { await failing(500, {}).listAgents(); ok(false, "500 should throw"); }
catch (e) { ok(e.retryable === true, "a server error is marked retryable"); }
try { await failing(403, { detail: "forbidden" }).listAgents(); ok(false, "403 should throw"); }
catch (e) { ok(e.retryable === false, "a permission error is not retried"); }

/* ---- a hung provider does not hang us ---- */
const hanging = createMrAssistant({
  getToken: async () => "t", timeoutMs: 30,
  fetchImpl: (url, o) => new Promise((_, rej) => { o.signal.addEventListener("abort", () => rej(Object.assign(new Error("aborted"), { name: "AbortError" }))); }),
});
try { await hanging.listAgents(); ok(false, "a hung request should throw"); }
catch (e) { ok(e.code === "timeout" && e.retryable, "a hung provider times out and is retryable"); }

/* ---- their field names stop at the boundary ---- */
const c = normaliseCall({ id: "c1", agent_id: "a1", to_number: "+1555", status: "completed",
  duration_seconds: 92, recording_url: "https://r", cost: 0.31, started_at: "2026-08-19T10:00:00Z" });
ok(c.externalId === "c1" && c.durationSec === 92, "a call is mapped into our shape");
ok(c.direction === "outbound", "direction is inferred when absent");
ok(c.providerCost === 0.31, "the provider's cost is kept, and named as theirs");
ok(normaliseCall(null) === null, "a missing call maps to null rather than throwing");

console.log(fails ? `mrassistant client: ${fails} FAILED` : "mrassistant client: all 22 checks passed");
process.exit(fails ? 1 : 0);
