/**
 * The model layer.
 *
 * Three ways a workspace can reach a model:
 *   managed   - our OpenRouter account. We pay wholesale, the customer pays a
 *               package price, and we enforce the ceiling.
 *   byo       - the customer's own OpenAI or Anthropic key. No margin for us,
 *               no cost risk either, and it satisfies buyers whose procurement
 *               will not let data touch a reseller account.
 *   none      - not configured. The assistant falls back to its rule engine
 *               rather than pretending it has a model.
 *
 * The rule that matters commercially: a request is not a unit of cost. A short
 * question against a small model costs a fraction of a cent; a long thread with
 * retrieved documents against a frontier model can cost dollars. So a plan sells
 * a request quota, because that is what a customer understands, and this file
 * enforces a token budget underneath it, checked BEFORE the call is made.
 */

export class LlmError extends Error {
  constructor(code, message, { status, retryable } = {}) {
    super(message);
    this.name = "LlmError";
    this.code = code;
    this.status = status ?? null;
    this.retryable = !!retryable;
  }
}

/* ---- what each plan may reach ----
   Prices are per million tokens and are only used to estimate spend before a
   call and record it after. They are not billing: billing reads the provider's
   own usage record. */
export const MODELS = {
  "openai/gpt-4o-mini":            { label: "GPT-4o mini",   in: 0.15, out: 0.60, ctx: 128000, tier: "fast" },
  "anthropic/claude-3.5-haiku":    { label: "Claude Haiku",  in: 0.80, out: 4.00, ctx: 200000, tier: "fast" },
  "openai/gpt-4o":                 { label: "GPT-4o",        in: 2.50, out: 10.00, ctx: 128000, tier: "capable" },
  "anthropic/claude-sonnet-4":     { label: "Claude Sonnet", in: 3.00, out: 15.00, ctx: 200000, tier: "capable" },
  "google/gemini-2.0-flash-001":   { label: "Gemini Flash",  in: 0.10, out: 0.40, ctx: 1000000, tier: "fast" },
};

/* ---- credits ----
   A token budget does not cap cost, because cost depends on which model was
   used. Measured across the model list, the same token allowance can cost 25x
   more on the best model a plan allows than on the cheapest. So the allowance
   is denominated in cost, not tokens.

   One credit is one tenth of a US cent of provider spend. A model consumes
   credits at its own blended rate, so the ceiling holds whatever the customer
   picks, and a plan can safely offer strong models without the margin
   depending on customer restraint. */
export const CREDIT_USD = 0.001;

/* how many credits 1,000 tokens of each model consumes, at a 75/25 input to
   output split, which is what an assistant workload actually looks like */
export function creditsPerThousand(model) {
  const m = MODELS[model];
  if (!m) return null;
  return ((0.75 * m.in + 0.25 * m.out) / 1000) / CREDIT_USD;
}
export function creditsFor(model, inTokens, outTokens) {
  const m = MODELS[model];
  if (!m) return null;
  return (((inTokens / 1e6) * m.in) + ((outTokens / 1e6) * m.out)) / CREDIT_USD;
}

/**
 * Plans.
 *
 * `credits` is the ceiling on what a workspace can cost us in a period, so the
 * worst case is known in advance. `requests` remains because it is the unit a
 * customer understands when comparing plans.
 *
 * Bringing your own key is Enterprise only. That is not a concession: when a
 * customer pays their own provider, the subscription is almost entirely
 * margin, which makes it the most profitable tier sold.
 */
export const PLAN_LLM = {
  starter: {
    label: "Starter", priceUsd: 39,
    requests: 3000, credits: 6000,
    models: ["google/gemini-2.0-flash-001", "openai/gpt-4o-mini"],
    maxOutputTokens: 800, maxInputTokens: 12000,
    byoAllowed: false, overageAllowed: false,
  },
  growth: {
    label: "Growth", priceUsd: 129,
    requests: 20000, credits: 25000,
    models: ["google/gemini-2.0-flash-001", "openai/gpt-4o-mini", "anthropic/claude-3.5-haiku"],
    maxOutputTokens: 1500, maxInputTokens: 40000,
    byoAllowed: false, overageAllowed: true,
  },
  scale: {
    label: "Scale", priceUsd: 399,
    requests: 80000, credits: 90000,
    models: ["google/gemini-2.0-flash-001", "openai/gpt-4o-mini", "anthropic/claude-3.5-haiku", "openai/gpt-4o"],
    maxOutputTokens: 4000, maxInputTokens: 120000,
    byoAllowed: false, overageAllowed: true,
  },
  enterprise: {
    label: "Enterprise", priceUsd: 1490,
    requests: 300000, credits: 300000,
    models: Object.keys(MODELS),
    maxOutputTokens: 8000, maxInputTokens: 200000,
    /* the only tier that may use its own provider account */
    byoAllowed: true, overageAllowed: true,
  },
};

/* Sold above the cap, so a busy month is revenue rather than a customer
   hitting a wall and calling support. */
export const CREDIT_PACKS = [
  { id: "small",  credits: 10000,  priceUsd: 25 },
  { id: "medium", credits: 50000,  priceUsd: 99 },
  { id: "large",  credits: 200000, priceUsd: 349 },
];

/* A rough token count. Deliberately conservative: over-estimating input costs
   a customer a little headroom, under-estimating costs us money. */
export const estimateTokens = (text) => Math.ceil(String(text || "").length / 3.5);

export function estimateCost(model, inTokens, outTokens) {
  const m = MODELS[model];
  if (!m) return null;
  return ((inTokens / 1e6) * m.in) + ((outTokens / 1e6) * m.out);
}

/**
 * Decide whether a call may proceed, before spending anything.
 *
 * Returns a verdict rather than a boolean so the assistant can explain the
 * limit instead of failing silently.
 */
export function checkEntitlement({ plan = "starter", usage = {}, model, inputTokens, outputTokens, byoKey = false }) {
  const p = PLAN_LLM[plan] || PLAN_LLM.starter;

  if (byoKey && !p.byoAllowed) {
    return { ok: false, code: "byo_not_in_plan",
      message: `Using your own model key is available on Enterprise. You are on ${p.label}.`,
      upgrade: true };
  }
  if (!p.models.includes(model)) {
    return { ok: false, code: "model_not_in_plan",
      message: `${(MODELS[model] || {}).label || model} is not available on ${p.label}.`,
      upgrade: true, allowed: p.models };
  }
  if (inputTokens > p.maxInputTokens) {
    return { ok: false, code: "input_too_large",
      message: "That is too much text for one request on this plan. Try a shorter selection." };
  }
  const capped = Math.min(outputTokens || p.maxOutputTokens, p.maxOutputTokens);

  /* a customer on their own key pays their own provider, so our ceiling does
     not apply to them */
  if (byoKey) return { ok: true, maxOutputTokens: capped, byoKey: true, warn: null };

  if ((usage.requests || 0) >= p.requests) {
    return { ok: false, code: "request_quota",
      message: `This workspace has used its ${p.requests.toLocaleString()} AI requests for the period.`,
      upgrade: true, topUp: p.overageAllowed };
  }

  /* the ceiling that actually protects the business: what this call will cost
     is checked before it is made, not counted after */
  const spend = usage.credits || 0;
  const allowance = (p.credits || 0) + (usage.topUpCredits || 0);
  const willCost = creditsFor(model, inputTokens || 0, capped) || 0;
  if (spend + willCost > allowance) {
    return { ok: false, code: "credit_cap",
      message: p.overageAllowed
        ? "This workspace has used its AI allowance for the period. Add credits to carry on."
        : "This workspace has used its AI allowance for the period.",
      upgrade: !p.overageAllowed, topUp: p.overageAllowed,
      remaining: Math.max(0, allowance - spend) };
  }

  const used = allowance ? spend / allowance : 0;
  return { ok: true, maxOutputTokens: capped,
    willCostCredits: Math.round(willCost * 100) / 100,
    warn: used > 0.85 ? `This workspace has used ${Math.round(used * 100)}% of its AI allowance.` : null,
    remaining: { requests: p.requests - (usage.requests || 0), credits: Math.round(allowance - spend) } };
}

/* Choose the cheapest model on the plan that can do the job. Sending every
   greeting to a frontier model is how a margin disappears. */
export function pickModel({ plan = "starter", need = "fast", preferred }) {
  const p = PLAN_LLM[plan] || PLAN_LLM.starter;
  if (preferred && p.models.includes(preferred)) return preferred;
  const wanted = p.models.filter((m) => MODELS[m] && (need === "capable" ? true : MODELS[m].tier === "fast"));
  const pool = wanted.length ? wanted : p.models;
  return pool.sort((a, b) => (MODELS[a].in + MODELS[a].out) - (MODELS[b].in + MODELS[b].out))[0];
}

const ENDPOINTS = {
  openrouter: { url: "https://openrouter.ai/api/v1/chat/completions", auth: (k) => `Bearer ${k}` },
  openai:     { url: "https://api.openai.com/v1/chat/completions",    auth: (k) => `Bearer ${k}` },
  anthropic:  { url: "https://api.anthropic.com/v1/messages",         auth: (k) => k },
};

/**
 * One call, whichever provider is behind it.
 *
 * The circuit breaker exists because a provider outage otherwise turns into a
 * queue of retries that costs money and makes the app feel dead.
 */
export function createLlm({
  fetchImpl = fetch,
  now = Date.now,
  breaker = { failures: 0, openedAt: 0 },
  breakerThreshold = 5,
  breakerCooldownMs = 60_000,
  timeoutMs = 30_000,
  appUrl = "https://buzzzbuzzz.com",
} = {}) {

  const tripped = () => breaker.openedAt && (now() - breaker.openedAt) < breakerCooldownMs;

  async function complete({
    provider = "openrouter", apiKey, model, system, messages = [],
    maxOutputTokens = 800, temperature = 0.2, json = false, workspaceId,
  }) {
    if (!apiKey) throw new LlmError("no_key", "No model is configured for this workspace.");
    if (tripped()) {
      throw new LlmError("provider_down",
        "The model provider is not responding. BUZZZ is answering from its own rules until it recovers.",
        { retryable: true });
    }
    const ep = ENDPOINTS[provider];
    if (!ep) throw new LlmError("bad_provider", `${provider} is not a supported model provider.`);

    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    const anthropic = provider === "anthropic";
    const body = anthropic
      ? { model, system, messages, max_tokens: maxOutputTokens, temperature }
      : { model, messages: system ? [{ role: "system", content: system }, ...messages] : messages,
          max_tokens: maxOutputTokens, temperature,
          ...(json ? { response_format: { type: "json_object" } } : {}) };

    let res;
    try {
      res = await fetchImpl(ep.url, {
        method: "POST", signal: ctrl.signal,
        headers: {
          "content-type": "application/json",
          ...(anthropic
            ? { "x-api-key": apiKey, "anthropic-version": "2023-06-01" }
            : { authorization: ep.auth(apiKey) }),
          /* OpenRouter asks callers to identify themselves, and it is how our
             account's usage is attributed per workspace */
          ...(provider === "openrouter"
            ? { "HTTP-Referer": appUrl, "X-Title": "BUZZZ", ...(workspaceId ? { "X-Workspace": workspaceId } : {}) }
            : {}),
        },
        body: JSON.stringify(body),
      });
    } catch (e) {
      breaker.failures += 1;
      if (breaker.failures >= breakerThreshold) breaker.openedAt = now();
      throw new LlmError(e && e.name === "AbortError" ? "timeout" : "network",
        e && e.name === "AbortError" ? "The model took too long to answer." : "Could not reach the model provider.",
        { retryable: true });
    } finally { clearTimeout(timer); }

    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      /* a bad key is the customer's problem to fix and must not trip the
         breaker for everyone else */
      const badKey = res.status === 401 || res.status === 403;
      if (!badKey) {
        breaker.failures += 1;
        if (breaker.failures >= breakerThreshold) breaker.openedAt = now();
      }
      const msg = (data.error && (data.error.message || data.error)) || `The model provider returned ${res.status}.`;
      throw new LlmError(
        badKey ? "bad_key" : res.status === 429 ? "rate_limited" : "provider_error",
        badKey ? "That model API key was rejected. Check it in Settings." : String(msg),
        { status: res.status, retryable: !badKey });
    }

    breaker.failures = 0; breaker.openedAt = 0;

    const text = anthropic
      ? (data.content || []).filter((c) => c.type === "text").map((c) => c.text).join("")
      : ((data.choices || [])[0] || {}).message?.content || "";
    const usage = anthropic
      ? { in: data.usage?.input_tokens || 0, out: data.usage?.output_tokens || 0 }
      : { in: data.usage?.prompt_tokens || 0, out: data.usage?.completion_tokens || 0 };

    return {
      text,
      model: data.model || model,
      usage: { ...usage, total: usage.in + usage.out },
      /* what it cost us, for the managed account. Recorded, never shown to the
         customer as their price. */
      estimatedCost: estimateCost(model, usage.in, usage.out),
    };
  }

  return { complete, get breakerOpen() { return tripped(); } };
}

/** A customer's own key, checked before it is saved rather than on first use. */
export function validateByoKey(provider, key) {
  const k = String(key || "").trim();
  if (!k) return { ok: false, message: "Paste your API key." };
  /* sk-ant- and sk-or- also begin with sk-, so an Anthropic or OpenRouter key
     pasted into the OpenAI field would otherwise be accepted and then fail on
     first use, which is a confusing way to find out */
  if (provider === "openai" && (!/^sk-[A-Za-z0-9_-]{20,}$/.test(k) || /^sk-(ant|or)-/.test(k))) {
    return { ok: false, message: "That does not look like an OpenAI key. They start with sk-." };
  }
  if (provider === "anthropic" && !/^sk-ant-[A-Za-z0-9_-]{20,}$/.test(k)) {
    return { ok: false, message: "That does not look like an Anthropic key. They start with sk-ant-." };
  }
  if (provider === "openrouter" && !/^sk-or-[A-Za-z0-9_-]{20,}$/.test(k)) {
    return { ok: false, message: "That does not look like an OpenRouter key. They start with sk-or-." };
  }
  return { ok: true, hint: `${k.slice(0, 7)}…${k.slice(-4)}` };
}

/**
 * What to record after every call.
 * Usage is metered per workspace and per model, which is what makes both the
 * customer's quota and our margin visible.
 */
export function usageRecord({ workspaceId, model, provider, usage, cost, byoKey, purpose, outcome = "ok" }) {
  return {
    workspaceId, model, provider, purpose,
    inputTokens: usage.in, outputTokens: usage.out, totalTokens: usage.total,
    /* zero when the customer brought their own key: they paid their provider
       directly, and recording our price against it would misstate margin */
    costUsd: byoKey ? 0 : (cost ?? null),
    billable: !byoKey,
    outcome,
    at: new Date().toISOString(),
  };
}
