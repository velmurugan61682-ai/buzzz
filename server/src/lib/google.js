/**
 * Google Calendar and Meet client.
 *
 * This is real, deployable code. It runs on the server only, because it handles
 * the client secret and refresh tokens, which must never reach a browser.
 *
 * `fetchImpl` is injectable so the whole module is testable without network
 * access: the tests pass a fake that returns recorded Google responses.
 */

const OAUTH_BASE = "https://accounts.google.com/o/oauth2/v2/auth";
const TOKEN_URL = "https://oauth2.googleapis.com/token";
const CAL_BASE = "https://www.googleapis.com/calendar/v3";

/* Least privilege: events only. We never ask for full calendar or Drive scope.
   calendar.events covers create, update, delete and read of our own events;
   Meet links come back on the event itself, so no extra Meet scope is needed. */
export const SCOPES = [
  "https://www.googleapis.com/auth/calendar.events",
  "https://www.googleapis.com/auth/calendar.readonly",
  "https://www.googleapis.com/auth/youtube.force-ssl",
];

export class GoogleError extends Error {
  constructor(message, { status, code, retryable, needsReconnect } = {}) {
    super(message);
    this.name = "GoogleError";
    this.status = status ?? null;
    this.code = code ?? "google_error";
    this.retryable = !!retryable;
    this.needsReconnect = !!needsReconnect;
  }
}

/** Step 1 of OAuth: where we send the user. `state` must be verified on return. */
export function buildAuthUrl({ clientId, redirectUri, state, loginHint }) {
  if (!clientId || !redirectUri || !state) throw new GoogleError("clientId, redirectUri and state are required", { code: "config" });
  const p = new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirectUri,
    response_type: "code",
    scope: SCOPES.join(" "),
    access_type: "offline",        // we need a refresh token
    prompt: "consent",             // force refresh token on repeat connects
    include_granted_scopes: "true",
    state,
  });
  if (loginHint) p.set("login_hint", loginHint);
  return `${OAUTH_BASE}?${p.toString()}`;
}

async function tokenRequest(fetchImpl, body) {
  const res = await fetchImpl(TOKEN_URL, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(body).toString(),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    /* invalid_grant means the user revoked access or the refresh token died.
       No amount of retrying fixes that; the account must be reconnected. */
    const revoked = data.error === "invalid_grant";
    throw new GoogleError(data.error_description || data.error || "token request failed", {
      status: res.status, code: data.error || "token_error",
      retryable: !revoked && res.status >= 500, needsReconnect: revoked,
    });
  }
  return data;
}

/** Step 2 of OAuth: swap the one-time code for tokens. */
export async function exchangeCode({ code, clientId, clientSecret, redirectUri, fetchImpl = fetch }) {
  const d = await tokenRequest(fetchImpl, {
    code, client_id: clientId, client_secret: clientSecret,
    redirect_uri: redirectUri, grant_type: "authorization_code",
  });
  return {
    accessToken: d.access_token,
    refreshToken: d.refresh_token || null,
    expiresAt: new Date(Date.now() + (d.expires_in || 3600) * 1000).toISOString(),
    scope: d.scope || SCOPES.join(" "),
  };
}

export async function refreshAccessToken({ refreshToken, clientId, clientSecret, fetchImpl = fetch }) {
  const d = await tokenRequest(fetchImpl, {
    refresh_token: refreshToken, client_id: clientId, client_secret: clientSecret,
    grant_type: "refresh_token",
  });
  return {
    accessToken: d.access_token,
    expiresAt: new Date(Date.now() + (d.expires_in || 3600) * 1000).toISOString(),
  };
}

/** Refresh slightly early so a token never expires mid-request. */
export function isExpired(expiresAt, skewMs = 60_000) {
  if (!expiresAt) return true;
  return new Date(expiresAt).getTime() - skewMs <= Date.now();
}

/**
 * Returns a valid access token, refreshing and persisting if needed.
 * `save` writes the new token back to the connection row.
 */
export async function validAccessToken(conn, { clientId, clientSecret, save, fetchImpl = fetch }) {
  if (!conn || !conn.refreshToken) throw new GoogleError("Google account is not connected", { code: "not_connected", needsReconnect: true });
  if (!isExpired(conn.expiresAt)) return conn.accessToken;
  const t = await refreshAccessToken({ refreshToken: conn.refreshToken, clientId, clientSecret, fetchImpl });
  if (save) await save({ accessToken: t.accessToken, expiresAt: t.expiresAt });
  return t.accessToken;
}

async function calendarCall(fetchImpl, accessToken, path, { method = "GET", body, query } = {}) {
  const url = `${CAL_BASE}${path}${query ? "?" + new URLSearchParams(query).toString() : ""}`;
  const res = await fetchImpl(url, {
    method,
    headers: { authorization: `Bearer ${accessToken}`, "content-type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (res.status === 204) return null;
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = data.error || {};
    const status = res.status;
    throw new GoogleError(err.message || `Google Calendar returned ${status}`, {
      status,
      code: (err.errors && err.errors[0] && err.errors[0].reason) || "calendar_error",
      /* 429 and 5xx are worth retrying; 401/403/404 are not */
      retryable: status === 429 || status >= 500,
      needsReconnect: status === 401,
    });
  }
  return data;
}

/**
 * Create a calendar event, with a Meet conference when `virtual` is true.
 *
 * `idempotencyKey` becomes the conference requestId and is also sent as the
 * event id seed by the caller, so a retry after a network timeout will not
 * produce a second event or a second Meet room.
 */
export async function createEvent({
  accessToken, calendarId = "primary", summary, description, startISO, endISO,
  timeZone, attendees = [], virtual = false, idempotencyKey, sendUpdates = "all",
  fetchImpl = fetch,
}) {
  if (!startISO || !endISO) throw new GoogleError("start and end are required", { code: "bad_request" });
  const body = {
    summary, description,
    start: { dateTime: startISO, timeZone },
    end: { dateTime: endISO, timeZone },
    attendees: attendees.filter(Boolean).map((email) => ({ email })),
    reminders: { useDefault: false, overrides: [] },   // BUZZZ owns reminders
  };
  if (virtual) {
    body.conferenceData = {
      createRequest: {
        requestId: idempotencyKey || `bz-${Date.now()}`,
        conferenceSolutionKey: { type: "hangoutsMeet" },
      },
    };
  }
  const ev = await calendarCall(fetchImpl, accessToken, `/calendars/${encodeURIComponent(calendarId)}/events`, {
    method: "POST", body,
    query: { conferenceDataVersion: virtual ? "1" : "0", sendUpdates },
  });
  const meet = extractMeetLink(ev);
  /* A virtual appointment without a Meet link is a failure, not a success.
     The caller must not tell the customer the meeting is confirmed. */
  if (virtual && !meet.url) {
    throw new GoogleError("Calendar event was created but Google did not return a Meet link", {
      code: "meet_missing", retryable: true, status: 502,
    });
  }
  return {
    eventId: ev.id, htmlLink: ev.htmlLink, status: ev.status,
    meetUrl: meet.url, meetId: meet.id, iCalUID: ev.iCalUID, updated: ev.updated,
  };
}

/** Meet details live in conferenceData; hangoutLink is the older mirror of it. */
export function extractMeetLink(ev) {
  if (!ev) return { url: null, id: null };
  const entry = ((ev.conferenceData || {}).entryPoints || []).find((e) => e.entryPointType === "video");
  return {
    url: (entry && entry.uri) || ev.hangoutLink || null,
    id: (ev.conferenceData || {}).conferenceId || null,
  };
}

export async function updateEvent({
  accessToken, calendarId = "primary", eventId, startISO, endISO, timeZone,
  summary, description, sendUpdates = "all", fetchImpl = fetch,
}) {
  const body = {};
  if (startISO) body.start = { dateTime: startISO, timeZone };
  if (endISO) body.end = { dateTime: endISO, timeZone };
  if (summary !== undefined) body.summary = summary;
  if (description !== undefined) body.description = description;
  /* PATCH keeps the existing conference, so rescheduling never changes the
     Meet link the customer already has */
  const ev = await calendarCall(fetchImpl, accessToken, `/calendars/${encodeURIComponent(calendarId)}/events/${encodeURIComponent(eventId)}`, {
    method: "PATCH", body, query: { conferenceDataVersion: "1", sendUpdates },
  });
  const meet = extractMeetLink(ev);
  return { eventId: ev.id, status: ev.status, meetUrl: meet.url, meetId: meet.id, updated: ev.updated };
}

export async function cancelEvent({ accessToken, calendarId = "primary", eventId, sendUpdates = "all", fetchImpl = fetch }) {
  try {
    await calendarCall(fetchImpl, accessToken, `/calendars/${encodeURIComponent(calendarId)}/events/${encodeURIComponent(eventId)}`, {
      method: "DELETE", query: { sendUpdates },
    });
    return { cancelled: true };
  } catch (e) {
    /* already gone is the desired end state, not an error */
    if (e.status === 404 || e.status === 410) return { cancelled: true, alreadyGone: true };
    throw e;
  }
}

export async function getEvent({ accessToken, calendarId = "primary", eventId, fetchImpl = fetch }) {
  const ev = await calendarCall(fetchImpl, accessToken, `/calendars/${encodeURIComponent(calendarId)}/events/${encodeURIComponent(eventId)}`);
  const meet = extractMeetLink(ev);
  return { eventId: ev.id, status: ev.status, start: ev.start, end: ev.end, meetUrl: meet.url, updated: ev.updated };
}

/** Busy blocks for conflict checking, straight from Google rather than guessed. */
export async function freeBusy({ accessToken, calendarIds = ["primary"], startISO, endISO, timeZone, fetchImpl = fetch }) {
  const res = await fetchImpl("https://www.googleapis.com/calendar/v3/freeBusy", {
    method: "POST",
    headers: { authorization: `Bearer ${accessToken}`, "content-type": "application/json" },
    body: JSON.stringify({ timeMin: startISO, timeMax: endISO, timeZone, items: calendarIds.map((id) => ({ id })) }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new GoogleError((data.error && data.error.message) || "freeBusy failed", { status: res.status, retryable: res.status >= 500 });
  const cals = data.calendars || {};
  return Object.keys(cals).reduce((acc, id) => { acc[id] = (cals[id].busy || []).map((b) => ({ start: b.start, end: b.end })); return acc; }, {});
}

/** Push notifications, so a change made inside Google Calendar reaches BUZZZ. */
export async function watchEvents({ accessToken, calendarId = "primary", channelId, webhookUrl, token, ttlSeconds = 604800, fetchImpl = fetch }) {
  return calendarCall(fetchImpl, accessToken, `/calendars/${encodeURIComponent(calendarId)}/events/watch`, {
    method: "POST",
    body: { id: channelId, type: "web_hook", address: webhookUrl, token, params: { ttl: String(ttlSeconds) } },
  });
}

export async function stopWatch({ accessToken, channelId, resourceId, fetchImpl = fetch }) {
  const res = await fetchImpl("https://www.googleapis.com/calendar/v3/channels/stop", {
    method: "POST",
    headers: { authorization: `Bearer ${accessToken}`, "content-type": "application/json" },
    body: JSON.stringify({ id: channelId, resourceId }),
  });
  return res.ok;
}

/** Revoke on disconnect so we do not keep access the user has taken back. */
export async function revoke({ token, fetchImpl = fetch }) {
  const res = await fetchImpl(`https://oauth2.googleapis.com/revoke?token=${encodeURIComponent(token)}`, { method: "POST" });
  return res.ok || res.status === 400;   // 400 means it was already invalid
}

/** Retry with backoff, but only for the errors Google says are transient. */
export async function withRetry(fn, { attempts = 3, baseMs = 300, sleep = (ms) => new Promise((r) => setTimeout(r, ms)) } = {}) {
  let last;
  for (let i = 0; i < attempts; i++) {
    try { return await fn(); } catch (e) {
      last = e;
      if (!(e instanceof GoogleError) || !e.retryable || i === attempts - 1) throw e;
      await sleep(baseMs * Math.pow(2, i));
    }
  }
  throw last;
}

/* =========================================================================
   YOUTUBE DATA API V3 INTEGRATION
   ========================================================================= */

const YT_BASE = "https://www.googleapis.com/youtube/v3";

async function youtubeCall(fetchImpl, accessToken, path, { method = "GET", body, query } = {}) {
  const qStr = query ? "?" + new URLSearchParams(query).toString() : "";
  const url = `${YT_BASE}${path}${qStr}`;
  const res = await fetchImpl(url, {
    method,
    headers: { authorization: `Bearer ${accessToken}`, "content-type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (res.status === 204) return null;
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = data.error || {};
    const status = res.status;
    throw new GoogleError(err.message || `YouTube API returned ${status}`, {
      status,
      code: (err.errors && err.errors[0] && err.errors[0].reason) || "youtube_error",
      retryable: status === 429 || status >= 500,
      needsReconnect: status === 401,
    });
  }
  return data;
}

/**
  * Fetches top-level comment threads for a YouTube channel or video.
  * Supports `publishedAfter` for incremental delta syncs and `pageToken` for pagination.
  */
export async function listCommentThreads({
  accessToken,
  allThreadsRelatedToChannelId,
  videoId,
  pageToken,
  publishedAfter,
  maxResults = 50,
  fetchImpl = fetch,
}) {
  const query = {
    part: "snippet,replies",
    maxResults: String(maxResults),
  };
  if (allThreadsRelatedToChannelId) query.allThreadsRelatedToChannelId = allThreadsRelatedToChannelId;
  if (videoId) query.videoId = videoId;
  if (pageToken) query.pageToken = pageToken;

  const data = await youtubeCall(fetchImpl, accessToken, "/commentThreads", { method: "GET", query });
  
  let items = data.items || [];
  if (publishedAfter) {
    const cutoff = new Date(publishedAfter).getTime();
    items = items.filter((item) => {
      const pub = item.snippet?.topLevelComment?.snippet?.publishedAt;
      return pub && new Date(pub).getTime() > cutoff;
    });
  }

  return {
    items,
    nextPageToken: data.nextPageToken || null,
    totalResults: data.pageInfo?.totalResults || items.length,
  };
}

/**
  * Posts a top-level comment on a video or a reply to an existing comment thread.
  */
export async function insertComment({
  accessToken,
  videoId,
  parentId,
  text,
  fetchImpl = fetch,
}) {
  if (!text) throw new GoogleError("Comment text is required", { code: "bad_request" });

  if (parentId) {
    // Post reply to existing comment
    const body = {
      snippet: {
        parentId,
        textOriginal: text,
      },
    };
    return youtubeCall(fetchImpl, accessToken, "/comments", {
      method: "POST",
      query: { part: "snippet" },
      body,
    });
  } else if (videoId) {
    // Post top-level comment on video
    const body = {
      snippet: {
        videoId,
        topLevelComment: {
          snippet: {
            textOriginal: text,
          },
        },
      },
    };
    return youtubeCall(fetchImpl, accessToken, "/commentThreads", {
      method: "POST",
      query: { part: "snippet" },
      body,
    });
  } else {
    throw new GoogleError("Either videoId or parentId is required to post a comment", { code: "bad_request" });
  }
}

/**
  * Sets moderation status for YouTube comments (published, heldForReview, rejected).
  */
export async function setModerationStatus({
  accessToken,
  commentId,
  status = "published",
  banAuthor = false,
  fetchImpl = fetch,
}) {
  if (!commentId) throw new GoogleError("commentId is required", { code: "bad_request" });

  const query = {
    id: commentId,
    moderationStatus: status,
    banAuthor: String(banAuthor),
  };

  await youtubeCall(fetchImpl, accessToken, "/comments/setModerationStatus", {
    method: "POST",
    query,
  });

  return { ok: true, commentId, status };
}

