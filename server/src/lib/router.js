/**
 * The model router.
 *
 * Every modality runs through OpenRouter on one key and one base URL, using the
 * endpoint each call shape needs:
 *
 *   /chat/completions      text, vision, PDF, audio and video INPUT
 *   /images                image generation
 *   /videos                video generation (asynchronous, polled)
 *   /audio/speech          text to speech
 *   /audio/transcriptions  speech to text
 *   /embeddings            vectors for search and retrieval
 *
 * The part that matters commercially: these modalities are not priced in the
 * same unit. Text is per token, images are per image, speech is per character,
 * transcription is per minute. A budget denominated in tokens cannot meter any
 * of the others, so everything is converted into credits, which are cost.
 */
import { CREDIT_USD, LlmError } from "./llm.js";

export const OR_BASE = "https://openrouter.ai/api/v1";

/* Every function BUZZZ performs with a model. A workspace picks a model per
   function rather than one model for everything, because the best model for
   reading a customer's message is rarely the best for reading a receipt. */
export const FUNCTIONS = {
  assistant:    { label: "BUZZZ AI",            modality: "text",       required: true },
  agentReply:   { label: "Agent replies",       modality: "text",       required: true },
  summarise:    { label: "Summaries and notes", modality: "text",       required: false },
  vision:       { label: "Reading images",      modality: "vision",     required: false },
  imageGen:     { label: "Generating images",   modality: "image",      required: false },
  speechToText: { label: "Voice to text",       modality: "stt",        required: false },
  textToSpeech: { label: "Text to voice",       modality: "tts",        required: false },
  embedding:    { label: "Search and recall",   modality: "embedding",  required: false },
  video:        { label: "Video",               modality: "video",      required: false },
};

/**
 * The catalogue.
 *
 * `unit` is what the provider charges for, and `rate` is the price in that
 * unit. Keeping them explicit is what stops an image being metered as if it
 * were a thousand tokens.
 */
export const CATALOG = {
  /* ---- text ---- */
  "google/gemini-2.0-flash-001":   { fn: ["assistant","agentReply","summarise","vision"], label: "Gemini Flash",   unit: "token", in: 0.10, out: 0.40, tier: "fast", ctx: 1000000 },
  "openai/gpt-4o-mini":            { fn: ["assistant","agentReply","summarise","vision"], label: "GPT-4o mini",    unit: "token", in: 0.15, out: 0.60, tier: "fast", ctx: 128000 },
  "anthropic/claude-3.5-haiku":    { fn: ["assistant","agentReply","summarise"],          label: "Claude Haiku",   unit: "token", in: 0.80, out: 4.00, tier: "mid",  ctx: 200000 },
  "openai/gpt-4o":                 { fn: ["assistant","agentReply","summarise","vision"], label: "GPT-4o",         unit: "token", in: 2.50, out: 10.00, tier: "capable", ctx: 128000 },
  "anthropic/claude-sonnet-4":     { fn: ["assistant","agentReply","summarise","vision"], label: "Claude Sonnet",  unit: "token", in: 3.00, out: 15.00, tier: "frontier", ctx: 200000 },
  "google/gemini-2.5-pro":         { fn: ["assistant","agentReply","summarise","vision"], label: "Gemini Pro",     unit: "token", in: 1.25, out: 10.00, tier: "capable", ctx: 2000000 },

  /* ---- image generation: priced per image, not per token ---- */
  "google/gemini-2.5-flash-image": { fn: ["imageGen"], label: "Gemini Image",      unit: "image", perImage: 0.039, tier: "fast" },
  "black-forest-labs/flux-1.1-pro":{ fn: ["imageGen"], label: "FLUX 1.1 Pro",      unit: "image", perImage: 0.040, tier: "capable" },
  "openai/gpt-image-1":            { fn: ["imageGen"], label: "GPT Image",         unit: "image", perImage: 0.042, tier: "capable" },

  /* ---- speech to text: priced per minute of audio ---- */
  "openai/whisper-1":              { fn: ["speechToText"], label: "Whisper",       unit: "minute", perMinute: 0.006, tier: "fast" },
  "openai/gpt-4o-transcribe":      { fn: ["speechToText"], label: "GPT-4o transcribe", unit: "minute", perMinute: 0.010, tier: "capable" },

  /* ---- text to speech: priced per million characters ---- */
  "hexgrad/kokoro-82m":            { fn: ["textToSpeech"], label: "Kokoro",        unit: "char", perMillionChars: 0.80, tier: "fast" },
  "openai/gpt-4o-mini-tts":        { fn: ["textToSpeech"], label: "GPT-4o mini TTS", unit: "char", perMillionChars: 12.00, tier: "capable" },

  /* ---- embeddings ---- */
  "openai/text-embedding-3-small": { fn: ["embedding"], label: "Embed small",      unit: "token", in: 0.02, out: 0, tier: "fast" },
  "openai/text-embedding-3-large": { fn: ["embedding"], label: "Embed large",      unit: "token", in: 0.13, out: 0, tier: "capable" },
};

/** Which models a workspace may pick for a given function. */
export function modelsFor(fn, allowedTiers = null) {
  return Object.entries(CATALOG)
    .filter(([, m]) => m.fn.includes(fn))
    .filter(([, m]) => !allowedTiers || allowedTiers.includes(m.tier))
    .map(([id, m]) => ({ id, ...m }));
}

/* ---- providers ----
   A model id is "provider/model", so the provider is already in the data. It is
   named here so a workspace can choose a house first and then a model within
   it, which is how people actually decide: some will not send customer data to
   a particular company, and that is a provider level decision, not a model one. */
export const PROVIDERS = {
  google:              { label: "Google",        note: "Gemini. Fast, very large context." },
  openai:              { label: "OpenAI",        note: "GPT. Broadest coverage across jobs." },
  anthropic:           { label: "Anthropic",     note: "Claude. Strong at careful, long instructions." },
  "black-forest-labs": { label: "Black Forest",  note: "FLUX. Image generation." },
  hexgrad:             { label: "Hexgrad",       note: "Kokoro. Low cost open voice." },
};

export const providerOf = (modelId) => String(modelId || "").split("/")[0];

/** Which providers can do a job on this plan, and how many models each offers. */
export function providersFor(fn, allowedTiers = null) {
  const seen = new Map();
  for (const m of modelsFor(fn, allowedTiers)) {
    const id = providerOf(m.id);
    if (!seen.has(id)) seen.set(id, { id, ...(PROVIDERS[id] || { label: id, note: "" }), models: [] });
    seen.get(id).models.push(m);
  }
  /* cheapest provider first, so the affordable option is the one in front of
     someone who has not thought about it */
  return [...seen.values()].sort((a, b) =>
    (creditsForCall(a.models[0].id, { inTokens: 1000, outTokens: 300, images: 1, minutes: 1, characters: 1000 }) || 0) -
    (creditsForCall(b.models[0].id, { inTokens: 1000, outTokens: 300, images: 1, minutes: 1, characters: 1000 }) || 0));
}

/** The models one provider offers for one job, within the plan. */
export function modelsFrom(fn, provider, allowedTiers = null) {
  return modelsFor(fn, allowedTiers).filter((m) => providerOf(m.id) === provider);
}

/**
 * Cost of a call, in credits, whatever the unit.
 * Returning null for an unknown model is deliberate: an unmetered call is a
 * call we cannot charge for, and it must be refused rather than guessed.
 */
export function creditsForCall(model, usage = {}) {
  const m = CATALOG[model];
  if (!m) return null;
  let usd = 0;
  switch (m.unit) {
    case "token":
      usd = ((usage.inTokens || 0) / 1e6) * m.in + ((usage.outTokens || 0) / 1e6) * (m.out || 0);
      break;
    case "image":
      usd = (usage.images || 1) * m.perImage;
      break;
    case "minute":
      /* providers bill part minutes, so round up rather than absorbing it */
      usd = Math.ceil(usage.seconds ? usage.seconds / 60 : (usage.minutes || 1)) * m.perMinute;
      break;
    case "char":
      usd = ((usage.characters || 0) / 1e6) * m.perMillionChars;
      break;
    default:
      return null;
  }
  return usd / CREDIT_USD;
}

/**
 * A workspace's choices, validated.
 *
 * A profile is only saved if every model in it can actually do the job it was
 * assigned and is inside the plan. Otherwise the failure arrives later, in
 * front of a customer.
 */
export function validateProfile(profile = {}, { allowedTiers = null } = {}) {
  const errors = [];
  const clean = {};
  for (const [fn, model] of Object.entries(profile)) {
    if (!FUNCTIONS[fn]) { errors.push({ fn, code: "unknown_function", message: `${fn} is not something BUZZZ does.` }); continue; }
    if (!model) continue;
    const m = CATALOG[model];
    if (!m) { errors.push({ fn, code: "unknown_model", message: `${model} is not in the catalogue.` }); continue; }
    if (!m.fn.includes(fn)) {
      errors.push({ fn, code: "wrong_function",
        message: `${m.label} cannot do ${FUNCTIONS[fn].label.toLowerCase()}.` });
      continue;
    }
    if (allowedTiers && !allowedTiers.includes(m.tier)) {
      errors.push({ fn, code: "not_in_plan", message: `${m.label} is not available on this plan.`, upgrade: true });
      continue;
    }
    clean[fn] = model;
  }
  for (const [fn, spec] of Object.entries(FUNCTIONS)) {
    if (spec.required && !clean[fn]) {
      errors.push({ fn, code: "required", message: `${spec.label} needs a model.` });
    }
  }
  return { ok: errors.length === 0, profile: clean, errors };
}

/** A sensible starting point, so nobody has to configure nine things to begin. */
export function defaultProfile(allowedTiers = ["fast"]) {
  const pick = (fn) => {
    const options = modelsFor(fn, allowedTiers);
    if (!options.length) return null;
    /* cheapest that can do the job: an upgrade should be a decision, not a default */
    return options.sort((a, b) => (creditsForCall(a.id, { inTokens: 1000, outTokens: 300, images: 1, minutes: 1, characters: 1000 }) || 0)
      - (creditsForCall(b.id, { inTokens: 1000, outTokens: 300, images: 1, minutes: 1, characters: 1000 }) || 0))[0].id;
  };
  const out = {};
  for (const fn of Object.keys(FUNCTIONS)) { const m = pick(fn); if (m) out[fn] = m; }
  return out;
}

/* ---- the calls ---- */

export function createRouter({ fetchImpl = fetch, apiKey, appUrl = "https://buzzzbuzzz.com", timeoutMs = 60000, workspaceId } = {}) {

  async function send(path, body, { raw = false, method = "POST", timeout = timeoutMs } = {}) {
    if (!apiKey) throw new LlmError("no_key", "No model access is configured for this workspace.");
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeout);
    let res;
    try {
      res = await fetchImpl(`${OR_BASE}${path}`, {
        method, signal: ctrl.signal,
        headers: {
          authorization: `Bearer ${apiKey}`,
          "content-type": "application/json",
          "HTTP-Referer": appUrl,
          "X-Title": "BUZZZ",
          ...(workspaceId ? { "X-Workspace": workspaceId } : {}),
        },
        body: body ? JSON.stringify(body) : undefined,
      });
    } catch (e) {
      throw new LlmError(e && e.name === "AbortError" ? "timeout" : "network",
        e && e.name === "AbortError" ? "The model took too long." : "Could not reach the model provider.",
        { retryable: true });
    } finally { clearTimeout(timer); }

    if (raw) {
      if (!res.ok) throw new LlmError("provider_error", `The provider returned ${res.status}.`, { status: res.status, retryable: res.status >= 500 });
      return res;
    }
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      const badKey = res.status === 401 || res.status === 403;
      throw new LlmError(badKey ? "bad_key" : res.status === 429 ? "rate_limited" : "provider_error",
        (data.error && (data.error.message || data.error)) || `The provider returned ${res.status}.`,
        { status: res.status, retryable: !badKey });
    }
    return data;
  }

  return {
    /* text, and anything sent INTO a model: images, PDFs, audio, video */
    chat: async ({ model, system, messages, maxOutputTokens = 800, temperature = 0.2, json = false }) => {
      const d = await send("/chat/completions", {
        model,
        messages: system ? [{ role: "system", content: system }, ...messages] : messages,
        max_tokens: maxOutputTokens, temperature,
        ...(json ? { response_format: { type: "json_object" } } : {}),
      });
      const usage = { inTokens: d.usage?.prompt_tokens || 0, outTokens: d.usage?.completion_tokens || 0 };
      return { text: ((d.choices || [])[0] || {}).message?.content || "", model: d.model || model,
        usage, credits: creditsForCall(model, usage) };
    },

    /* image generation has its own endpoint and returns base64 images */
    image: async ({ model, prompt, n = 1, size, referenceImages }) => {
      const d = await send("/images", { model, prompt, n, ...(size ? { size } : {}),
        ...(referenceImages ? { image: referenceImages } : {}) });
      const images = (d.data || []).map((x) => x.b64_json || x.url).filter(Boolean);
      const usage = { images: images.length || n };
      return { images, model: d.model || model, usage, credits: creditsForCall(model, usage) };
    },

    /* speech to text */
    transcribe: async ({ model, audioBase64, mimeType = "audio/mpeg", language, durationSeconds }) => {
      const d = await send("/audio/transcriptions", {
        model, file: audioBase64, mime_type: mimeType, ...(language ? { language } : {}),
      });
      /* the provider bills by audio length, so the caller's measured duration
         is what meters it, not the length of the text that came back */
      const usage = { seconds: durationSeconds ?? d.duration ?? 0 };
      return { text: d.text || "", model: d.model || model, usage, credits: creditsForCall(model, usage) };
    },

    /* text to speech */
    speak: async ({ model, text, voice = "alloy", format = "mp3" }) => {
      const d = await send("/audio/speech", { model, input: text, voice, response_format: format });
      const usage = { characters: String(text || "").length };
      return { audio: d.audio || d.data || null, format, model, usage, credits: creditsForCall(model, usage) };
    },

    /* vectors for retrieval */
    embed: async ({ model, input }) => {
      const items = Array.isArray(input) ? input : [input];
      const d = await send("/embeddings", { model, input: items });
      const usage = { inTokens: d.usage?.prompt_tokens || 0, outTokens: 0 };
      return { vectors: (d.data || []).map((x) => x.embedding), model: d.model || model,
        usage, credits: creditsForCall(model, usage) };
    },

    /* video is asynchronous: a job is started and polled */
    startVideo: async ({ model, prompt, seconds, aspectRatio }) => {
      const d = await send("/videos", { model, prompt, ...(seconds ? { duration: seconds } : {}),
        ...(aspectRatio ? { aspect_ratio: aspectRatio } : {}) });
      return { jobId: d.id || d.job_id, status: d.status || "queued" };
    },
    videoStatus: (jobId) => send(`/videos/${encodeURIComponent(jobId)}`, null, { method: "GET" }),

    /* the live catalogue, so a new model appears without a deploy */
    listModels: (params) => send(`/models${params ? "?" + new URLSearchParams(params) : ""}`, null, { method: "GET" }),
  };
}
