/** Internal chat: a button press from Slack or Discord is a request, never an
 *  authorisation. These tests try to forge, replay and escalate. */
import crypto from "node:crypto";
import {
  PLATFORMS, EVENTS, verifySlack, verifyDiscord, verifyInbound, ed25519KeyFromHex,
  renderMessage, parseAction, authoriseAction, createTeamChat, ChatError,
} from "./teamchat.js";

let fails = 0;
const ok = (c, m) => { if (!c) { console.log("  FAIL:", m); fails++; } };

/* ---- Slack signatures ---- */
const SECRET = "s3cr3t";
const sign = (ts, body) => "v0=" + crypto.createHmac("sha256", SECRET).update(`v0:${ts}:${body}`).digest("hex");
const nowSec = 1_760_000_000;
const now = () => nowSec * 1000;
const body = JSON.stringify({ actions: [{ action_id: "bz_approve", value: "{}" }] });

ok(verifySlack({ signingSecret: SECRET, signature: sign(nowSec, body), timestamp: String(nowSec), rawBody: body, now }).ok,
   "a correctly signed Slack request is accepted");
ok(!verifySlack({ signingSecret: SECRET, signature: "v0=deadbeef", timestamp: String(nowSec), rawBody: body, now }).ok,
   "a forged Slack signature is refused");
ok(verifySlack({ signingSecret: SECRET, signature: sign(nowSec, body), timestamp: String(nowSec), rawBody: body + "x", now }).reason === "bad_signature",
   "a tampered body is refused, even with a real signature");
ok(verifySlack({ signingSecret: SECRET, signature: sign(nowSec - 600, body), timestamp: String(nowSec - 600), rawBody: body, now }).reason === "stale",
   "a replayed request from ten minutes ago is refused");
ok(verifySlack({ signingSecret: SECRET, signature: sign(nowSec, body), timestamp: null, rawBody: body, now }).reason === "unsigned",
   "an unsigned request is refused");
ok(verifySlack({ signingSecret: null, signature: "x", timestamp: "1", rawBody: body, now }).reason === "not_configured",
   "an unconfigured workspace refuses rather than accepting everything");
/* the secret of one workspace must not verify another's traffic */
ok(!verifySlack({ signingSecret: "other", signature: sign(nowSec, body), timestamp: String(nowSec), rawBody: body, now }).ok,
   "a signature from a different secret is refused");

/* ---- Discord signatures ---- */
const { publicKey, privateKey } = crypto.generateKeyPairSync("ed25519");
const pubHex = publicKey.export({ format: "der", type: "spki" }).subarray(12).toString("hex");
const dsign = (ts, b) => crypto.sign(null, Buffer.from(ts + b), privateKey).toString("hex");

ok(verifyDiscord({ publicKey: pubHex, signature: dsign(String(nowSec), body), timestamp: String(nowSec), rawBody: body, now }).ok,
   "a correctly signed Discord interaction is accepted");
ok(!verifyDiscord({ publicKey: pubHex, signature: "00".repeat(64), timestamp: String(nowSec), rawBody: body, now }).ok,
   "a forged Discord signature is refused");
ok(verifyDiscord({ publicKey: pubHex, signature: dsign(String(nowSec), body), timestamp: String(nowSec), rawBody: body + "x", now }).reason === "bad_signature",
   "a tampered Discord body is refused");
ok(verifyDiscord({ publicKey: pubHex, signature: dsign(String(nowSec - 900), body), timestamp: String(nowSec - 900), rawBody: body, now }).reason === "stale",
   "a replayed Discord interaction is refused");
const other = crypto.generateKeyPairSync("ed25519");
const otherHex = other.publicKey.export({ format: "der", type: "spki" }).subarray(12).toString("hex");
ok(!verifyDiscord({ publicKey: otherHex, signature: dsign(String(nowSec), body), timestamp: String(nowSec), rawBody: body, now }).ok,
   "a signature from another application is refused");
try { ed25519KeyFromHex("abcd"); ok(false, "a short key should throw"); }
catch (e) { ok(e.code === "bad_key", "a malformed public key is refused"); }
ok(verifyInbound("teams", {}).reason === "unknown_platform", "an unknown platform is refused");

/* ---- what the team sees ---- */
const slackMsg = renderMessage("slack", "approval.waiting", { who: "Northbridge Ltd", targetId: "ap1", workspaceId: "w1", lines: ["Refund of $240"] });
ok(slackMsg.text.includes("Approval needed"), "the Slack notification has a plain text fallback");
ok(slackMsg.blocks.some((b) => b.type === "actions"), "and buttons to act from");
const approve = slackMsg.blocks.find((b) => b.type === "actions").elements.find((e) => e.action_id === "bz_approve");
ok(approve.style === "primary", "approve is the primary button");
ok(JSON.parse(approve.value).ws === "w1", "the button carries the workspace it belongs to");

const dMsg = renderMessage("discord", "sla.at_risk", { who: "Priya", targetId: "t1", workspaceId: "w1", lines: ["2h left"] });
ok(dMsg.components[0].components.length === 2, "the Discord message has its buttons");
ok(dMsg.embeds[0].color === 0xef2b13, "an urgent event is coloured urgently");
ok(dMsg.components[0].components[0].custom_id.startsWith("bz_claim:t1:w1"), "the id carries what to act on");
try { renderMessage("slack", "nonsense.event", {}); ok(false, "an unknown event should throw"); }
catch (e) { ok(e.code === "unknown_event", "an event BUZZZ does not send is refused"); }

/* ---- reading a press back ---- */
const parsedSlack = parseAction("slack", { actions: [{ action_id: "bz_approve", value: JSON.stringify({ id: "ap1", ws: "w1" }) }],
  user: { id: "U123" }, channel: { id: "C1" }, response_url: "https://hooks.slack.com/x" });
ok(parsedSlack.action === "approve" && parsedSlack.targetId === "ap1", "a Slack press is read");
ok(parsedSlack.actorExternalId === "U123", "and the person who pressed it is identified");
const parsedDiscord = parseAction("discord", { data: { custom_id: "bz_deny:ap1:w1" }, member: { user: { id: "D9" } }, channel_id: "C2", token: "tok" });
ok(parsedDiscord.action === "deny" && parsedDiscord.workspaceId === "w1", "a Discord press is read into the same shape");
ok(parseAction("slack", { actions: [{ action_id: "other_thing" }] }) === null, "a press from another app is ignored");
ok(parseAction("slack", {}) === null, "a malformed payload is ignored rather than crashing");
ok(parseAction("discord", { data: { custom_id: "bz_approve::" } }).targetId === null, "a press with no target is read as having none");

/* ---- authorisation: the part that matters ---- */
const link = { workspaceId: "w1" };
const manager = { workspaceId: "w1", role: "manager" };
const employee = { workspaceId: "w1", role: "employee" };

ok(authoriseAction({ action: "approve", workspaceId: "w1", link, member: manager }).ok,
   "a manager may approve");
ok(!authoriseAction({ action: "approve", workspaceId: "w1", link, member: employee }).ok,
   "an employee may not approve, even though they can press the button");
ok(authoriseAction({ action: "approve", workspaceId: "w1", link, member: employee }).code === "insufficient_role",
   "and is told why");
ok(!authoriseAction({ action: "approve", workspaceId: "w1", link, member: null }).ok,
   "somebody in the channel with no BUZZZ account cannot act at all");
ok(!authoriseAction({ action: "approve", workspaceId: "w1", link, member: { workspaceId: "w2", role: "owner" } }).ok,
   "an owner of ANOTHER workspace cannot approve here");
ok(!authoriseAction({ action: "approve", workspaceId: "w2", link, member: manager }).ok,
   "a button pointing at a different workspace is refused");
ok(authoriseAction({ action: "claim", workspaceId: "w1", link, member: employee }).ok,
   "but an employee may claim an escalation, which is not a privileged action");
ok(!authoriseAction({ action: "approve", workspaceId: "w1", link, member: manager,
   governanceVerdict: { verdict: "deny", reason: "Refunds always need the owner." } }).ok,
   "governance still applies: chat is not a way around the rules in the app");

/* ---- sending ---- */
let sent = null;
const chat = createTeamChat({ fetchImpl: async (url, o) => { sent = { url, body: JSON.parse(o.body), headers: o.headers }; return { ok: true, status: 200, json: async () => ({ ok: true, ts: "1.2" }) }; } });
await chat.notify({ platform: "slack", token: "xoxb-1", channelId: "C1", event: "deal.won", payload: { who: "Acme" } });
ok(sent.url === PLATFORMS.slack.postUrl && sent.body.channel === "C1", "a Slack notification posts to the channel");
ok(sent.headers.authorization === "Bearer xoxb-1", "with the workspace's bot token");
await chat.notify({ platform: "discord", token: "bot-1", channelId: "C9", event: "deal.won", payload: { who: "Acme" } });
ok(sent.url.includes("/channels/C9/messages"), "a Discord notification posts to its channel");
ok(sent.headers.authorization === "Bot bot-1", "using Discord's own auth scheme");

/* Slack answers 200 with ok:false, which is the easy failure to miss */
const failing = createTeamChat({ fetchImpl: async () => ({ ok: true, status: 200, json: async () => ({ ok: false, error: "not_in_channel" }) }) });
try { await failing.notify({ platform: "slack", token: "x", channelId: "C1", event: "deal.won", payload: {} }); ok(false, "should throw"); }
catch (e) { ok(/Invite BUZZZ/.test(e.message), "a Slack 200 with ok:false is treated as the failure it is, in plain words"); }

const hung = createTeamChat({ timeoutMs: 20, fetchImpl: (u, o) => new Promise((_, rej) => o.signal.addEventListener("abort", () => rej(Object.assign(new Error("x"), { name: "AbortError" })))) });
try { await hung.notify({ platform: "slack", token: "x", channelId: "C1", event: "deal.won", payload: {} }); ok(false, "should throw"); }
catch (e) { ok(e.code === "timeout", "a hung platform times out rather than hanging the caller"); }

console.log(fails ? `team chat: ${fails} FAILED` : "team chat: all 44 checks passed");
process.exit(fails ? 1 : 0);
