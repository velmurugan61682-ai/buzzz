/**
 * MrAssistant.ai client.
 *
 * Built against the published API (https://docs.mrassistant.ai). Paths and
 * response shapes below come from that specification rather than from guesswork:
 *   GET  /auth/oauth/providers            -> which social logins are configured
 *   GET  /auth/oauth/{provider}/authorize -> { authorization_url, provider, state }
 *   POST /auth/login                      -> access + refresh tokens
 *   POST /auth/refresh                    -> new access token
 *   POST /calls/outbound, /calls/{id}/end, /calls/{id}/transfer
 *   GET  /agents, /agents/{id}/transcripts, /agents/{id}/recordings
 *   GET  /analytics/realtime, /analytics/calls
 *
 * This runs server side. The MrAssistant tokens are tenant credentials and are
 * never handed to a browser.
 */

const DEFAULT_BASE = "https://api.mrassistant.ai";

export class MrAssistantError extends Error {
  constructor(message, { status, code, retryable } = {}) {
    super(message);
    this.name = "MrAssistantError";
    this.status = status ?? null;
    this.code = code ?? "mrassistant_error";
    this.retryable = !!retryable;
  }
}

export function createMrAssistant({
  baseUrl = process.env.MRASSISTANT_BASE_URL || DEFAULT_BASE,
  getToken,                 // async () => access token for this workspace
  onTokenExpired,           // async () => refreshed token, or null
  fetchImpl = fetch,
  timeoutMs = 20000,
} = {}) {

  async function call(path, { method = "GET", body, query, token, retryOnAuth = true } = {}) {
    const url = `${baseUrl}${path}${query ? "?" + new URLSearchParams(query) : ""}`;
    const bearer = token || (getToken ? await getToken() : null);
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    let res;
    try {
      res = await fetchImpl(url, {
        method, signal: ctrl.signal,
        headers: {
          "content-type": "application/json",
          ...(bearer ? { authorization: `Bearer ${bearer}` } : {}),
        },
        body: body ? JSON.stringify(body) : undefined,
      });
    } catch (e) {
      throw new MrAssistantError(
        e && e.name === "AbortError" ? "MrAssistant did not respond in time" : "Could not reach MrAssistant",
        { status: 0, code: e && e.name === "AbortError" ? "timeout" : "network", retryable: true });
    } finally { clearTimeout(timer); }

    if (res.status === 204) return null;
    const data = await res.json().catch(() => ({}));

    /* an expired tenant token is refreshed once, then the call is retried.
       Retrying more than once turns a bad credential into a request loop. */
    if (res.status === 401 && retryOnAuth && onTokenExpired) {
      const fresh = await onTokenExpired();
      if (fresh) return call(path, { method, body, query, token: fresh, retryOnAuth: false });
    }
    if (!res.ok) {
      /* FastAPI reports validation problems under `detail`, which is an array */
      const detail = Array.isArray(data.detail)
        ? data.detail.map((d) => `${(d.loc || []).join(".")}: ${d.msg}`).join("; ")
        : data.detail || data.message;
      throw new MrAssistantError(detail || `MrAssistant returned ${res.status}`, {
        status: res.status,
        code: res.status === 401 ? "unauthorised" : res.status === 422 ? "invalid_request" : "api_error",
        retryable: res.status === 429 || res.status >= 500,
      });
    }
    return data;
  }

  return {
    /* ---- who can sign in with what ----
       The provider list is read from MrAssistant rather than hardcoded, so a
       button never appears for a provider that is not actually configured. */
    listOAuthProviders: () => call("/auth/oauth/providers"),
    authorizeUrl: (provider) => call(`/auth/oauth/${encodeURIComponent(provider)}/authorize`),
    oauthCallback: (provider, params) =>
      call(`/auth/oauth/${encodeURIComponent(provider)}/callback`, { query: params }),

    /* ---- tenant session ---- */
    login: (email, password) => call("/auth/login", { method: "POST", body: { email, password } }),
    refresh: (refreshToken) => call("/auth/refresh", { method: "POST", body: { refresh_token: refreshToken } }),
    me: () => call("/auth/me"),

    /* ---- voice agents ---- */
    listAgents: () => call("/agents"),
    getAgent: (id) => call(`/agents/${encodeURIComponent(id)}`),
    agentStatus: (id) => call(`/agents/${encodeURIComponent(id)}/status`),

    /* ---- calls ---- */
    placeCall: ({ agentId, to, metadata }) =>
      call("/calls/outbound", { method: "POST", body: { agent_id: agentId, to_number: to, metadata } }),
    callStatus: (callId) => call(`/calls/${encodeURIComponent(callId)}`),
    endCall: (callId) => call(`/calls/${encodeURIComponent(callId)}/end`, { method: "POST" }),
    transferCall: (callId, target) =>
      call(`/calls/${encodeURIComponent(callId)}/transfer`, { method: "POST", body: { target } }),
    listCalls: (agentId, query) => call(`/agents/${encodeURIComponent(agentId)}/calls`, { query }),

    /* ---- what was said ---- */
    listTranscripts: (agentId) => call(`/agents/${encodeURIComponent(agentId)}/transcripts`),
    getTranscript: (agentId, sessionId) =>
      call(`/agents/${encodeURIComponent(agentId)}/transcripts/${encodeURIComponent(sessionId)}`),
    listRecordings: (agentId) => call(`/agents/${encodeURIComponent(agentId)}/recordings`),

    /* ---- numbers and health ---- */
    listPhoneNumbers: (agentId) => call(`/agents/${encodeURIComponent(agentId)}/phone-numbers`),
    realtimeMetrics: () => call("/analytics/realtime"),
    health: () => call("/health"),
  };
}

/**
 * Turns a MrAssistant call into the shape BUZZZ stores.
 *
 * The two systems name things differently, and letting their field names spread
 * through the app would mean every screen breaks when their API changes.
 */
export function normaliseCall(raw) {
  if (!raw) return null;
  return {
    externalId: raw.id || raw.call_id || null,
    agentId: raw.agent_id || null,
    direction: raw.direction || (raw.to_number ? "outbound" : "inbound"),
    from: raw.from_number || null,
    to: raw.to_number || null,
    status: raw.status || "unknown",
    startedAt: raw.started_at || raw.created_at || null,
    endedAt: raw.ended_at || null,
    durationSec: raw.duration_seconds ?? raw.duration ?? null,
    recordingUrl: raw.recording_url || null,
    transcriptId: raw.transcript_id || raw.session_id || null,
    /* never trust a provider's own cost figure as revenue: keep it labelled */
    providerCost: raw.cost ?? null,
  };
}
