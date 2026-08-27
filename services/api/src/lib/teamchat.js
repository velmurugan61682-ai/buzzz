/**
 * Internal team communication: Slack and Discord.
 *
 * The point is not to add another place to chat. Teams already live in Slack or
 * Discord all day, and a notification they have to leave in order to act on is
 * a notification they will act on late. So this does two things:
 *
 *   out  - BUZZZ tells the team what needs a person: approvals, escalations,
 *          SLA about to breach, an agent flagged, a deal won.
 *   back - the team acts from there. Approve, deny, claim, reply, snooze.
 *
 * The security rule that matters: a button press arriving from Slack or Discord
 * is a REQUEST, never an authorisation. Every action is re-checked server side
 * against the same governance the app uses, because a payload can be forged and
 * a channel can contain people who are not staff.
 */
import crypto from "node:crypto";

export class ChatError extends Error {
  constructor(code, message, status = 400) {
    super(message);
    this.name = "ChatError";
    this.code = code;
    this.status = status;
  }
}

export const PLATFORMS = {
  slack: {
    label: "Slack",
    postUrl: "https://slack.com/api/chat.postMessage",
    scopes: ["chat:write", "commands", "channels:read", "users:read", "im:write"],
    /* Slack signs with HMAC SHA256 over a versioned base string */
    verify: verifySlack,
  },
  discord: {
    label: "Discord",
    postUrl: (channelId) => `https://discord.com/api/v10/channels/${channelId}/messages`,
    scopes: ["bot", "applications.commands"],
    /* Discord signs with Ed25519 over timestamp + body */
    verify: verifyDiscord,
  },
};

/* ---- signature verification ----
   Without this, anyone who learns a webhook URL can approve their own refund. */

const REPLAY_WINDOW_SEC = 300;

export function verifySlack({ signingSecret, signature, timestamp, rawBody, now = Date.now }) {
  if (!signingSecret) return { ok: false, reason: "not_configured" };
  if (!signature || !timestamp) return { ok: false, reason: "unsigned" };
  /* an old signature is a replay: the same valid payload sent again later */
  const age = Math.abs(Math.floor(now() / 1000) - Number(timestamp));
  if (!Number.isFinite(age) || age > REPLAY_WINDOW_SEC) return { ok: false, reason: "stale" };

  const base = `v0:${timestamp}:${rawBody}`;
  const expected = "v0=" + crypto.createHmac("sha256", signingSecret).update(base).digest("hex");
  const a = Buffer.from(expected), b = Buffer.from(String(signature));
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return { ok: false, reason: "bad_signature" };
  return { ok: true };
}

/* Discord hands out a hex public key; Node needs it wrapped as SPKI DER. */
const ED25519_SPKI_PREFIX = Buffer.from("302a300506032b6570032100", "hex");
export function ed25519KeyFromHex(hex) {
  const raw = Buffer.from(String(hex), "hex");
  if (raw.length !== 32) throw new ChatError("bad_key", "That is not a valid Discord public key.");
  return crypto.createPublicKey({
    key: Buffer.concat([ED25519_SPKI_PREFIX, raw]), format: "der", type: "spki",
  });
}

export function verifyDiscord({ publicKey, signature, timestamp, rawBody, now = Date.now }) {
  if (!publicKey) return { ok: false, reason: "not_configured" };
  if (!signature || !timestamp) return { ok: false, reason: "unsigned" };
  const age = Math.abs(Math.floor(now() / 1000) - Number(timestamp));
  if (!Number.isFinite(age) || age > REPLAY_WINDOW_SEC) return { ok: false, reason: "stale" };
  try {
    const ok = crypto.verify(null, Buffer.from(timestamp + rawBody),
      ed25519KeyFromHex(publicKey), Buffer.from(String(signature), "hex"));
    return ok ? { ok: true } : { ok: false, reason: "bad_signature" };
  } catch {
    return { ok: false, reason: "bad_signature" };
  }
}

/** One entry point, so no caller can forget which scheme a platform uses. */
export function verifyInbound(platform, args) {
  const p = PLATFORMS[platform];
  if (!p) return { ok: false, reason: "unknown_platform" };
  return p.verify(args);
}

/* ---- what BUZZZ sends the team ----
   Written as a neutral shape and rendered per platform, so a new platform is a
   renderer rather than a rewrite of every notification. */
export const EVENTS = {
  "approval.waiting":  { title: "Approval needed", urgency: "high",
    actions: [["approve", "Approve"], ["deny", "Deny"], ["open", "Open in BUZZZ"]] },
  "escalation.raised": { title: "Escalated to a person", urgency: "high",
    actions: [["claim", "I'll take it"], ["open", "Open thread"]] },
  "sla.at_risk":       { title: "SLA about to breach", urgency: "high",
    actions: [["claim", "I'll take it"], ["snooze", "Snooze 1h"]] },
  "agent.flagged":     { title: "An agent needs attention", urgency: "medium",
    actions: [["open", "Review agent"]] },
  "deal.won":          { title: "Deal won", urgency: "low", actions: [["open", "Open deal"]] },
  "handover.shift":    { title: "Shift handover", urgency: "low", actions: [] },
};

export function renderMessage(platform, event, payload = {}) {
  const spec = EVENTS[event];
  if (!spec) throw new ChatError("unknown_event", `${event} is not a notification BUZZZ sends.`);
  const lines = (payload.lines || []).filter(Boolean);
  const title = `${spec.title}${payload.who ? ` · ${payload.who}` : ""}`;

  if (platform === "slack") {
    return {
      text: title,                       // the notification preview and a fallback
      blocks: [
        { type: "section", text: { type: "mrkdwn", text: `*${title}*` } },
        ...(lines.length ? [{ type: "section", text: { type: "mrkdwn", text: lines.join("\n") } }] : []),
        ...(spec.actions.length ? [{
          type: "actions",
          elements: spec.actions.map(([id, label]) => ({
            type: "button", text: { type: "plain_text", text: label },
            /* the id carries what to act on; the server still decides whether
               this person may do it */
            action_id: `bz_${id}`,
            value: JSON.stringify({ event, id: payload.targetId, ws: payload.workspaceId }),
            ...(id === "deny" ? { style: "danger" } : id === "approve" ? { style: "primary" } : {}),
          })),
        }] : []),
      ],
    };
  }
  if (platform === "discord") {
    return {
      content: title,
      embeds: lines.length ? [{ description: lines.join("\n"),
        color: spec.urgency === "high" ? 0xef2b13 : spec.urgency === "medium" ? 0xf5a623 : 0x30a46c }] : [],
      components: spec.actions.length ? [{
        type: 1,
        components: spec.actions.slice(0, 5).map(([id, label]) => ({
          type: 2,
          style: id === "deny" ? 4 : id === "approve" ? 3 : 2,
          label,
          custom_id: `bz_${id}:${payload.targetId || ""}:${payload.workspaceId || ""}`,
        })),
      }] : [],
    };
  }
  throw new ChatError("unknown_platform", `${platform} is not supported.`);
}

/** Reads a button press back into the same shape, whichever platform sent it. */
export function parseAction(platform, body = {}) {
  if (platform === "slack") {
    const action = ((body.actions || [])[0]) || {};
    if (!action.action_id || !action.action_id.startsWith("bz_")) return null;
    let value = {};
    try { value = JSON.parse(action.value || "{}"); } catch { /* keep going: the ids matter, not the blob */ }
    return {
      action: action.action_id.slice(3),
      targetId: value.id || null,
      workspaceId: value.ws || null,
      actorExternalId: (body.user || {}).id || null,
      channelId: (body.channel || {}).id || null,
      responseUrl: body.response_url || null,
    };
  }
  if (platform === "discord") {
    const custom = (body.data || {}).custom_id || "";
    if (!custom.startsWith("bz_")) return null;
    const [act, targetId, workspaceId] = custom.slice(3).split(":");
    return {
      action: act, targetId: targetId || null, workspaceId: workspaceId || null,
      actorExternalId: ((body.member || {}).user || body.user || {}).id || null,
      channelId: body.channel_id || null,
      interactionToken: body.token || null,
    };
  }
  return null;
}

/**
 * Whether this press may do what it asks.
 *
 * Three separate questions, and all three must pass. Anyone in a Slack channel
 * can press a button, including a contractor who was never given a BUZZZ seat.
 */
export function authoriseAction({ action, workspaceId, link, member, governanceVerdict }) {
  if (!link || link.workspaceId !== workspaceId) {
    return { ok: false, code: "wrong_workspace",
      message: "That button belongs to a different workspace." };
  }
  if (!member) {
    return { ok: false, code: "not_linked",
      message: "Link your chat account to BUZZZ before acting on these." };
  }
  if (member.workspaceId !== workspaceId) {
    return { ok: false, code: "not_a_member", message: "You are not a member of that workspace." };
  }
  /* approving is not a chat permission, it is a BUZZZ permission */
  const needsApprover = ["approve", "deny"].includes(action);
  if (needsApprover && !["owner", "admin", "manager"].includes(member.role)) {
    return { ok: false, code: "insufficient_role",
      message: "Approving needs an owner, admin or manager." };
  }
  /* and the underlying action still faces the same governance as in the app */
  if (needsApprover && governanceVerdict && governanceVerdict.verdict === "deny") {
    return { ok: false, code: "denied_by_governance", message: governanceVerdict.reason };
  }
  return { ok: true, role: member.role };
}

/* ---- sending ---- */
export function createTeamChat({ fetchImpl = fetch, timeoutMs = 10000 } = {}) {
  async function post(url, { token, body, discord = false }) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    let res;
    try {
      res = await fetchImpl(url, {
        method: "POST", signal: ctrl.signal,
        headers: {
          "content-type": "application/json",
          authorization: discord ? `Bot ${token}` : `Bearer ${token}`,
        },
        body: JSON.stringify(body),
      });
    } catch (e) {
      throw new ChatError(e && e.name === "AbortError" ? "timeout" : "network",
        "Could not reach the chat platform.", 502);
    } finally { clearTimeout(timer); }

    const data = await res.json().catch(() => ({}));
    /* Slack answers 200 with ok:false, which is easy to miss and then every
       failed notification looks like a success */
    if (!discord && data.ok === false) {
      throw new ChatError("post_failed", slackErrorMessage(data.error), 502);
    }
    if (!res.ok) throw new ChatError("post_failed", `The chat platform returned ${res.status}.`, 502);
    return data;
  }

  return {
    notify: async ({ platform, token, channelId, event, payload }) => {
      const message = renderMessage(platform, event, payload);
      if (platform === "slack") {
        return post(PLATFORMS.slack.postUrl, { token, body: { channel: channelId, ...message } });
      }
      return post(PLATFORMS.discord.postUrl(channelId), { token, body: message, discord: true });
    },
    /* a short acknowledgement in the channel, so the team can see it was handled
       and by whom, rather than two people picking up the same escalation */
    acknowledge: async ({ platform, token, channelId, text, threadTs }) => {
      if (platform === "slack") {
        return post(PLATFORMS.slack.postUrl, { token, body: { channel: channelId, text, thread_ts: threadTs } });
      }
      return post(PLATFORMS.discord.postUrl(channelId), { token, body: { content: text }, discord: true });
    },
  };
}

function slackErrorMessage(code) {
  const known = {
    channel_not_found: "That channel no longer exists, or BUZZZ was removed from it.",
    not_in_channel: "Invite BUZZZ to that channel first.",
    invalid_auth: "The Slack connection needs reauthorising.",
    account_inactive: "That Slack workspace has been deactivated.",
    rate_limited: "Slack is rate limiting BUZZZ. The message will be retried.",
  };
  return known[code] || `Slack refused the message: ${code || "unknown error"}`;
}
