/** The model layer, tested where mistakes cost money: entitlements, budgets,
 *  model selection, provider failure and metering. */
import {
  MODELS, PLAN_LLM, CREDIT_PACKS, CREDIT_USD, creditsFor, creditsPerThousand,
  estimateTokens, estimateCost, checkEntitlement, pickModel,
  createLlm, validateByoKey, usageRecord, LlmError,
} from "./llm.js";

let fails = 0;
const ok = (c, m) => { if (!c) { console.log("  FAIL:", m); fails++; } };
const json = (status, body) => ({ ok: status < 400, status, json: async () => body });

/* ---- a request is not a unit of cost ---- */
const cheap = estimateCost("openai/gpt-4o-mini", 500, 200);
const dear = estimateCost("anthropic/claude-sonnet-4", 50000, 2000);
ok(dear / cheap > 100, "one request can cost over a hundred times another (" + Math.round(dear / cheap) + "x)");
ok(estimateCost("nope", 1, 1) === null, "an unknown model has no price rather than a guessed one");

/* ---- credits cap cost, which tokens alone do not ---- */
const perK = creditsPerThousand("openai/gpt-4o");
const perKcheap = creditsPerThousand("google/gemini-2.0-flash-001");
ok(perK > perKcheap * 10, "an expensive model consumes credits far faster (" + Math.round(perK / perKcheap) + "x)");
ok(creditsFor("openai/gpt-4o-mini", 1000, 0) < creditsFor("anthropic/claude-sonnet-4", 1000, 0),
   "the same tokens cost more credits on a better model, which is the point");

const starter = { plan: "starter", model: "openai/gpt-4o-mini", inputTokens: 500, outputTokens: 400 };
ok(checkEntitlement({ ...starter, usage: { requests: 0, credits: 0 } }).ok, "a fresh workspace may call");
ok(!checkEntitlement({ ...starter, usage: { requests: 3000, credits: 0 } }).ok, "the request quota is enforced");

/* the protection that matters */
const burned = checkEntitlement({ ...starter, usage: { requests: 10, credits: 6000 } });
ok(!burned.ok && burned.code === "credit_cap",
   "a workspace with requests left but its allowance spent is stopped, which is what caps our cost");

/* the cost of THIS call is counted before it is made */
/* the call itself costs ~290 credits, so a workspace 100 credits from its cap
   is refused even though it has not technically reached the cap yet */
const edge = checkEntitlement({ plan: "scale", model: "openai/gpt-4o", inputTokens: 100000, outputTokens: 4000,
  usage: { requests: 1, credits: 89900 } });
ok(!edge.ok && edge.code === "credit_cap",
   "a call that WOULD breach the cap is refused before it is made, not billed after");
ok(checkEntitlement({ plan: "scale", model: "openai/gpt-4o", inputTokens: 100000, outputTokens: 4000,
   usage: { requests: 1, credits: 80000 } }).ok, "the same call is allowed with room left");
ok(checkEntitlement({ ...starter, usage: { requests: 1, credits: 10 } }).willCostCredits > 0,
   "the cost of the call is quoted up front");

/* top ups keep a busy customer working instead of stuck */
const topped = checkEntitlement({ plan: "growth", model: "openai/gpt-4o-mini", inputTokens: 500, outputTokens: 400,
  usage: { requests: 10, credits: 25000, topUpCredits: 10000 } });
ok(topped.ok, "bought credits extend the allowance");
ok(CREDIT_PACKS.length === 3 && CREDIT_PACKS.every((c) => c.priceUsd / (c.credits * CREDIT_USD) > 1.4),
   "every credit pack is sold above cost");

/* ---- plan boundaries ---- */
ok(!checkEntitlement({ ...starter, model: "anthropic/claude-sonnet-4", usage: {} }).ok,
   "a starter workspace cannot reach a frontier model");
ok(checkEntitlement({ ...starter, model: "anthropic/claude-sonnet-4", usage: {} }).upgrade === true,
   "and is told it is an upgrade, not a fault");
ok(!checkEntitlement({ plan: "scale", model: "anthropic/claude-sonnet-4", inputTokens: 100, outputTokens: 100, usage: {} }).ok,
   "even Scale does not get the dearest model: it is the Enterprise draw");
ok(checkEntitlement({ plan: "enterprise", model: "anthropic/claude-sonnet-4", inputTokens: 100, outputTokens: 100, usage: {} }).ok,
   "Enterprise reaches every model");

/* ---- output is capped, whatever was asked for ---- */
const capped = checkEntitlement({ ...starter, outputTokens: 999999, usage: {} });
ok(capped.maxOutputTokens === PLAN_LLM.starter.maxOutputTokens,
   "a request for a huge answer is capped to the plan, not refused");
ok(!checkEntitlement({ ...starter, inputTokens: 999999, usage: {} }).ok, "an oversized input is refused");

/* ---- warn before the wall ---- */
ok(checkEntitlement({ ...starter, usage: { requests: 10, credits: 5600 } }).warn,
   "a workspace near its limit is warned before it is cut off");

/* ---- bring your own key is Enterprise only ---- */
ok(PLAN_LLM.starter.byoAllowed === false && PLAN_LLM.growth.byoAllowed === false
   && PLAN_LLM.scale.byoAllowed === false && PLAN_LLM.enterprise.byoAllowed === true,
   "only Enterprise may use its own model key");
const byoTooLow = checkEntitlement({ ...starter, plan: "growth", usage: {}, byoKey: true });
ok(!byoTooLow.ok && byoTooLow.code === "byo_not_in_plan", "a lower plan is told it is an Enterprise feature");
const byoEnt = checkEntitlement({ plan: "enterprise", model: "anthropic/claude-sonnet-4",
  inputTokens: 500, outputTokens: 400, usage: { requests: 999999, credits: 99999999 }, byoKey: true });
ok(byoEnt.ok, "an Enterprise workspace on its own key is not limited by our allowance");
ok(byoEnt.byoKey === true, "and the call is marked as theirs to pay for");

/* the commercial reason it is the best tier we sell */
const ent = PLAN_LLM.enterprise;
ok(ent.priceUsd - (ent.credits * CREDIT_USD) < ent.priceUsd,
   "managed Enterprise carries real provider cost");
ok((ent.priceUsd * 0.94) > (ent.priceUsd - ent.credits * CREDIT_USD),
   "the same price on the customer's own key is worth more to us, which is why it sits here");

/* ---- model choice protects the margin ---- */
ok(MODELS[pickModel({ plan: "growth", need: "fast" })].tier === "fast",
   "a simple job goes to a fast model");
const chosen = pickModel({ plan: "growth", need: "fast" });
const dearest = "openai/gpt-4o";
ok(MODELS[chosen].in < MODELS[dearest].in, "and it is cheaper than the frontier option");
ok(pickModel({ plan: "starter", preferred: "anthropic/claude-sonnet-4" }) !== "anthropic/claude-sonnet-4",
   "a preference outside the plan is ignored rather than honoured");
ok(PLAN_LLM.starter.models.includes(pickModel({ plan: "starter", need: "capable" })),
   "a capable request on starter still stays inside the plan");

/* ---- keys ---- */
ok(!validateByoKey("openai", "hello").ok, "a key that is not a key is refused before it is saved");
ok(validateByoKey("openai", "sk-" + "a".repeat(40)).ok, "a plausible OpenAI key is accepted");
ok(validateByoKey("anthropic", "sk-ant-" + "a".repeat(40)).ok, "an Anthropic key is accepted");
ok(validateByoKey("openrouter", "sk-or-" + "a".repeat(40)).ok, "an OpenRouter key is accepted");
ok(!validateByoKey("openai", "sk-ant-" + "a".repeat(40)).ok, "a key for the wrong provider is caught");
ok(!validateByoKey("openai", "sk-" + "a".repeat(40)).hint.includes("aaaa" + "a".repeat(30)),
   "only a hint of the key is ever echoed back");

/* ---- calling ---- */
const okBody = { model: "openai/gpt-4o-mini", choices: [{ message: { content: "hello" } }],
  usage: { prompt_tokens: 100, completion_tokens: 20 } };
let seen = null;
const llm = createLlm({ fetchImpl: async (url, o) => { seen = { url, o }; return json(200, okBody); } });
const out = await llm.complete({ apiKey: "sk-or-x", model: "openai/gpt-4o-mini", messages: [{ role: "user", content: "hi" }], workspaceId: "w1" });
ok(out.text === "hello", "a completion comes back");
ok(out.usage.total === 120, "token usage is read from the provider, not estimated");
ok(out.estimatedCost > 0, "the cost of the call is recorded");
ok(seen.url.includes("openrouter.ai"), "managed calls go through OpenRouter");
ok(seen.o.headers["X-Workspace"] === "w1", "usage is attributed to the workspace");

/* anthropic speaks a different shape */
const anth = createLlm({ fetchImpl: async () => json(200, { content: [{ type: "text", text: "hey" }], usage: { input_tokens: 5, output_tokens: 3 } }) });
const ares = await anth.complete({ provider: "anthropic", apiKey: "sk-ant-x", model: "anthropic/claude-3.5-haiku", messages: [] });
ok(ares.text === "hey" && ares.usage.total === 8, "an Anthropic response is normalised to the same shape");

/* ---- failure handling ---- */
const bad = createLlm({ fetchImpl: async () => json(401, { error: { message: "bad key" } }) });
try { await bad.complete({ apiKey: "sk-x", model: "openai/gpt-4o-mini", messages: [] }); ok(false, "401 should throw"); }
catch (e) { ok(e.code === "bad_key" && !e.retryable, "a rejected key is the customer's to fix and is not retried"); }

let calls = 0;
const down = createLlm({ fetchImpl: async () => { calls++; return json(500, {}); }, breakerThreshold: 3 });
for (let i = 0; i < 5; i++) {
  try { await down.complete({ apiKey: "k", model: "openai/gpt-4o-mini", messages: [] }); } catch {}
}
ok(down.breakerOpen, "repeated provider failures open the circuit breaker");
ok(calls <= 3, "and further calls stop rather than piling up (" + calls + ")");
try { await down.complete({ apiKey: "k", model: "openai/gpt-4o-mini", messages: [] }); }
catch (e) { ok(e.code === "provider_down" && /own rules/.test(e.message), "and the message says the assistant falls back"); }

/* a bad key must not break the provider for everyone */
let keyCalls = 0;
const keyBad = createLlm({ fetchImpl: async () => { keyCalls++; return json(401, {}); }, breakerThreshold: 2 });
for (let i = 0; i < 4; i++) { try { await keyBad.complete({ apiKey: "k", model: "openai/gpt-4o-mini", messages: [] }); } catch {} }
ok(!keyBad.breakerOpen, "one customer's bad key does not trip the breaker for everyone");

const slow = createLlm({ timeoutMs: 20, fetchImpl: (u, o) => new Promise((_, rej) => o.signal.addEventListener("abort", () => rej(Object.assign(new Error("x"), { name: "AbortError" })))) });
try { await slow.complete({ apiKey: "k", model: "openai/gpt-4o-mini", messages: [] }); ok(false, "a hung provider should throw"); }
catch (e) { ok(e.code === "timeout", "a hung provider times out"); }

try { await llm.complete({ model: "openai/gpt-4o-mini", messages: [] }); ok(false, "no key should throw"); }
catch (e) { ok(e.code === "no_key", "a workspace with no model configured is told so"); }

/* ---- metering ---- */
const rec = usageRecord({ workspaceId: "w1", model: "openai/gpt-4o-mini", provider: "openrouter",
  usage: { in: 100, out: 20, total: 120 }, cost: 0.0002, byoKey: false, purpose: "assistant" });
ok(rec.billable === true && rec.costUsd === 0.0002, "a managed call records what it cost us");
const rec2 = usageRecord({ workspaceId: "w1", model: "openai/gpt-4o", provider: "openai",
  usage: { in: 100, out: 20, total: 120 }, cost: 0.5, byoKey: true, purpose: "assistant" });
ok(rec2.billable === false && rec2.costUsd === 0,
   "a bring your own key call records zero cost to us, so margin is not misstated");

ok(estimateTokens("a".repeat(350)) === 100, "token estimation is conservative and predictable");

console.log(fails ? `llm layer: ${fails} FAILED` : "llm layer: all checks passed");
process.exit(fails ? 1 : 0);
