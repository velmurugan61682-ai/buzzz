/** Google client tests. No network: a fake fetch returns recorded Google shapes,
 *  including the failures that matter (expiry, revocation, rate limits, no Meet). */
import assert from "node:assert";
import {
  buildAuthUrl, exchangeCode, refreshAccessToken, isExpired, validAccessToken,
  createEvent, updateEvent, cancelEvent, freeBusy, extractMeetLink, withRetry, GoogleError, SCOPES,
} from "./google.js";
import { sealToken, openToken } from "../routes/google.js";

let fails = 0;
const ok = (c, m) => { if (!c) { console.log("  FAIL:", m); fails++; } };
const json = (status, body) => ({ ok: status < 400, status, json: async () => body });
const fake = (handler) => async (url, opts) => handler(String(url), opts || {});

/* --- auth url --- */
const url = buildAuthUrl({ clientId: "cid", redirectUri: "https://x/cb", state: "s1" });
ok(url.includes("access_type=offline"), "asks for offline access so a refresh token is issued");
ok(url.includes("prompt=consent"), "forces consent so reconnecting returns a refresh token");
ok(!SCOPES.some((s) => /\/auth\/calendar$/.test(s)), "does not request full calendar scope");
ok(SCOPES.includes("https://www.googleapis.com/auth/calendar.events"), "requests events scope");

/* --- code exchange --- */
const tok = await exchangeCode({ code: "c", clientId: "i", clientSecret: "s", redirectUri: "r",
  fetchImpl: fake(async () => json(200, { access_token: "at", refresh_token: "rt", expires_in: 3600, scope: "x" })) });
ok(tok.refreshToken === "rt" && tok.accessToken === "at", "exchanges the code for tokens");
ok(new Date(tok.expiresAt).getTime() > Date.now(), "expiry is in the future");

/* --- revoked access --- */
try {
  await refreshAccessToken({ refreshToken: "dead", clientId: "i", clientSecret: "s",
    fetchImpl: fake(async () => json(400, { error: "invalid_grant", error_description: "Token has been expired or revoked." })) });
  ok(false, "revoked refresh token should throw");
} catch (e) {
  ok(e.needsReconnect === true, "revoked token asks for reconnection");
  ok(e.retryable === false, "revoked token is not retried forever");
}

/* --- expiry and auto refresh --- */
ok(isExpired(new Date(Date.now() + 10_000).toISOString()) === true, "token inside the safety skew counts as expired");
ok(isExpired(new Date(Date.now() + 600_000).toISOString()) === false, "healthy token is not expired");
let saved = null;
const at = await validAccessToken(
  { refreshToken: "rt", accessToken: "old", expiresAt: new Date(Date.now() - 1000).toISOString() },
  { clientId: "i", clientSecret: "s", save: (t) => { saved = t; },
    fetchImpl: fake(async () => json(200, { access_token: "fresh", expires_in: 3600 })) });
ok(at === "fresh", "expired token is refreshed automatically");
ok(saved && saved.accessToken === "fresh", "refreshed token is persisted");
try { await validAccessToken(null, { clientId: "i", clientSecret: "s" }); ok(false, "missing connection should throw"); }
catch (e) { ok(e.code === "not_connected", "missing Google connection is reported clearly"); }

/* --- creating a virtual appointment --- */
let seen = null;
const ev = await createEvent({
  accessToken: "at", summary: "Consult", startISO: "2026-08-20T15:00:00+05:30",
  endISO: "2026-08-20T15:30:00+05:30", timeZone: "Asia/Kolkata",
  attendees: ["a@b.com"], virtual: true, idempotencyKey: "appt-1",
  fetchImpl: fake(async (u, o) => { seen = { u, body: JSON.parse(o.body) };
    return json(200, { id: "ev1", htmlLink: "https://cal/ev1", status: "confirmed",
      hangoutLink: "https://meet.google.com/abc-defg-hij",
      conferenceData: { conferenceId: "abc-defg-hij", entryPoints: [{ entryPointType: "video", uri: "https://meet.google.com/abc-defg-hij" }] } }); }),
});
ok(ev.meetUrl === "https://meet.google.com/abc-defg-hij", "returns the real Meet URL from Google");
ok(ev.eventId === "ev1", "returns the calendar event id");
ok(seen.u.includes("conferenceDataVersion=1"), "requests conference data so Meet is created");
ok(seen.body.conferenceData.createRequest.requestId === "appt-1", "uses an idempotency key for the conference");
ok(seen.body.reminders.useDefault === false, "turns off Google reminders so BUZZZ owns them");

/* --- Meet creation failure must not look like success --- */
try {
  await createEvent({ accessToken: "at", startISO: "2026-08-20T15:00:00Z", endISO: "2026-08-20T15:30:00Z",
    virtual: true, idempotencyKey: "k",
    fetchImpl: fake(async () => json(200, { id: "ev2", status: "confirmed" })) });
  ok(false, "a missing Meet link should be an error");
} catch (e) { ok(e.code === "meet_missing", "event without a Meet link fails loudly"); }

/* --- rescheduling keeps the same Meet room --- */
let patch = null;
const up = await updateEvent({ accessToken: "at", eventId: "ev1", startISO: "2026-08-21T15:00:00+05:30",
  endISO: "2026-08-21T15:30:00+05:30", timeZone: "Asia/Kolkata",
  fetchImpl: fake(async (u, o) => { patch = { u, method: o.method };
    return json(200, { id: "ev1", status: "confirmed", hangoutLink: "https://meet.google.com/abc-defg-hij",
      conferenceData: { conferenceId: "abc-defg-hij", entryPoints: [{ entryPointType: "video", uri: "https://meet.google.com/abc-defg-hij" }] } }); }) });
ok(patch.method === "PATCH", "reschedule patches rather than recreating the event");
ok(up.meetUrl === "https://meet.google.com/abc-defg-hij", "Meet link survives a reschedule");

/* --- cancellation --- */
const del = await cancelEvent({ accessToken: "at", eventId: "gone",
  fetchImpl: fake(async () => json(404, { error: { message: "Not Found" } })) });
ok(del.cancelled === true && del.alreadyGone === true, "cancelling an already deleted event is not an error");

/* --- conflicts --- */
const busy = await freeBusy({ accessToken: "at", calendarIds: ["primary"], startISO: "a", endISO: "b",
  fetchImpl: fake(async () => json(200, { calendars: { primary: { busy: [{ start: "s", end: "e" }] } } })) });
ok(busy.primary.length === 1, "free busy returns real busy blocks for conflict checks");

/* --- retries --- */
let n = 0;
const out = await withRetry(async () => { n++; if (n < 3) throw new GoogleError("rate limited", { status: 429, retryable: true }); return "done"; }, { baseMs: 1, sleep: async () => {} });
ok(out === "done" && n === 3, "retries transient rate limiting");
n = 0;
try { await withRetry(async () => { n++; throw new GoogleError("forbidden", { status: 403 }); }, { baseMs: 1, sleep: async () => {} }); }
catch { ok(n === 1, "does not retry a permanent failure"); }

/* --- token encryption at rest --- */
const key = "11".repeat(32);
const sealed = sealToken("super-secret-refresh", key);
ok(!sealed.includes("super-secret-refresh"), "refresh token is not stored in plain text");
ok(openToken(sealed, key) === "super-secret-refresh", "sealed token decrypts correctly");
let tampered = sealed.split("."); tampered[2] = Buffer.from("evil").toString("base64");
try { openToken(tampered.join("."), key); ok(false, "tampered token should not decrypt"); }
catch { ok(true, "tampering with the stored token is detected"); }

ok(extractMeetLink({ conferenceData: { entryPoints: [{ entryPointType: "phone", uri: "tel:+1" }] } }).url === null, "a phone entry point is not a Meet link");

/* --- YouTube Data API tests --- */
import { listCommentThreads, insertComment, setModerationStatus } from "./google.js";

// listCommentThreads with delta sync publishedAfter
const ytRes = await listCommentThreads({
  accessToken: "at",
  allThreadsRelatedToChannelId: "ch123",
  publishedAfter: "2026-08-01T00:00:00Z",
  fetchImpl: fake(async (u) => {
    ok(u.includes("allThreadsRelatedToChannelId=ch123"), "passes channelId parameter");
    return json(200, {
      items: [
        { id: "cmt1", snippet: { topLevelComment: { snippet: { textOriginal: "Great video!", publishedAt: "2026-08-15T10:00:00Z" } } } },
        { id: "cmt2", snippet: { topLevelComment: { snippet: { textOriginal: "Old comment", publishedAt: "2026-07-15T10:00:00Z" } } } },
      ],
      nextPageToken: "page2",
    });
  }),
});
ok(ytRes.items.length === 1 && ytRes.items[0].id === "cmt1", "filters out comments older than publishedAfter cutoff");

// insertComment reply
let postedBody = null;
const postRes = await insertComment({
  accessToken: "at",
  parentId: "cmt1",
  text: "Thank you!",
  fetchImpl: fake(async (u, o) => {
    postedBody = JSON.parse(o.body);
    return json(200, { id: "reply1", snippet: { textOriginal: "Thank you!" } });
  }),
});
ok(postRes.id === "reply1" && postedBody.snippet.parentId === "cmt1", "posts reply to parent comment thread");

// setModerationStatus
let modQuery = null;
const modRes = await setModerationStatus({
  accessToken: "at",
  commentId: "cmt1",
  status: "published",
  fetchImpl: fake(async (u) => {
    modQuery = u;
    return json(204, null);
  }),
});
ok(modRes.ok === true && modQuery.includes("moderationStatus=published"), "sets moderation status for comment");

console.log(fails ? `google client: ${fails} FAILED` : "google client: all 33 checks passed");
process.exit(fails ? 1 : 0);
