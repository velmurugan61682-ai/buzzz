/**
 * Google connection and virtual appointment routes.
 *
 * Tokens never leave this service. The browser only ever sees a connection
 * status and, once an appointment exists, the Meet URL for that appointment.
 */
import { Router } from "express";
import crypto from "node:crypto";
import {
  buildAuthUrl, exchangeCode, validAccessToken, createEvent, updateEvent,
  cancelEvent, freeBusy, revoke, withRetry, GoogleError, SCOPES,
} from "../lib/google.js";

/* Refresh tokens are encrypted at rest with a key held only by the service.
   A database dump alone is therefore not enough to impersonate a customer. */
export function sealToken(plain, keyHex) {
  const key = Buffer.from(keyHex, "hex");
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv("aes-256-gcm", key, iv);
  const enc = Buffer.concat([c.update(String(plain), "utf8"), c.final()]);
  return [iv.toString("base64"), c.getAuthTag().toString("base64"), enc.toString("base64")].join(".");
}
export function openToken(sealed, keyHex) {
  const [iv, tag, data] = String(sealed).split(".");
  const d = crypto.createDecipheriv("aes-256-gcm", Buffer.from(keyHex, "hex"), Buffer.from(iv, "base64"));
  d.setAuthTag(Buffer.from(tag, "base64"));
  return Buffer.concat([d.update(Buffer.from(data, "base64")), d.final()]).toString("utf8");
}

export function googleRoutes({ db, config, fetchImpl = fetch }) {
  const r = Router();
  const { clientId, clientSecret, redirectUri, tokenKey, webhookUrl } = config;

  const conn = async (workspaceId) => {
    const row = await db.getGoogleConnection(workspaceId);
    if (!row) return null;
    return { ...row, refreshToken: row.refreshTokenSealed ? openToken(row.refreshTokenSealed, tokenKey) : null };
  };
  const token = (workspaceId, c) => validAccessToken(c, {
    clientId, clientSecret, fetchImpl,
    save: (t) => db.updateGoogleTokens(workspaceId, t),
  });

  /* --- connection lifecycle --- */
  r.get("/status", async (req, res, next) => {
    try {
      const c = await db.getGoogleConnection(req.workspaceId);
      res.json({ connected: !!c, email: c ? c.email : null, scopes: c ? c.scope : null,
        needsReconnect: c ? !!c.needsReconnect : false });
    } catch (e) { next(e); }
  });

  r.post("/connect", async (req, res, next) => {
    try {
      /* state is signed and single use, which is what stops an attacker
         attaching their own Google account to someone else's workspace */
      const state = crypto.randomBytes(24).toString("base64url");
      await db.saveOAuthState({ state, workspaceId: req.workspaceId, userId: req.userId, expiresAt: new Date(Date.now() + 6e5).toISOString() });
      res.json({ url: buildAuthUrl({ clientId, redirectUri, state }), scopes: SCOPES });
    } catch (e) { next(e); }
  });

  r.get("/callback", async (req, res, next) => {
    try {
      const { code, state, error } = req.query;
      if (error) return res.status(400).json({ code: "oauth_denied", message: "Google access was declined" });
      const st = await db.consumeOAuthState(String(state || ""));
      if (!st) return res.status(400).json({ code: "bad_state", message: "This sign in link is no longer valid. Start again." });
      const t = await exchangeCode({ code: String(code), clientId, clientSecret, redirectUri, fetchImpl });
      if (!t.refreshToken) {
        return res.status(400).json({ code: "no_refresh_token",
          message: "Google did not return a refresh token. Remove BUZZZ from your Google account permissions and connect again." });
      }
      await db.saveGoogleConnection({
        workspaceId: st.workspaceId, userId: st.userId,
        refreshTokenSealed: sealToken(t.refreshToken, tokenKey),
        accessToken: t.accessToken, expiresAt: t.expiresAt, scope: t.scope, needsReconnect: false,
      });
      res.json({ connected: true });
    } catch (e) { next(e); }
  });

  r.post("/disconnect", async (req, res, next) => {
    try {
      const c = await conn(req.workspaceId);
      if (c && c.refreshToken) await revoke({ token: c.refreshToken, fetchImpl });
      await db.deleteGoogleConnection(req.workspaceId);
      res.json({ connected: false });
    } catch (e) { next(e); }
  });

  /* --- availability --- */
  r.post("/freebusy", async (req, res, next) => {
    try {
      const c = await conn(req.workspaceId);
      if (!c) return res.status(409).json({ code: "not_connected", message: "Connect Google Calendar first" });
      const at = await token(req.workspaceId, c);
      const busy = await freeBusy({ accessToken: at, calendarIds: req.body.calendarIds, startISO: req.body.start, endISO: req.body.end, timeZone: req.body.timeZone, fetchImpl });
      res.json({ busy });
    } catch (e) { next(e); }
  });

  /**
   * Create the Google side of an appointment.
   * The appointment is only marked confirmed once this returns a Meet link,
   * which is what stops BUZZZ telling a customer about a meeting that does
   * not exist.
   */
  r.post("/appointments/:id/meeting", async (req, res, next) => {
    try {
      const appt = await db.getAppointment(req.workspaceId, req.params.id);
      if (!appt) return res.status(404).json({ code: "not_found", message: "Appointment not found" });
      /* idempotency: a retry of the same request returns the first result
         rather than creating a second event and a second Meet room */
      if (appt.googleEventId) {
        return res.json({ eventId: appt.googleEventId, meetUrl: appt.meetUrl, meetId: appt.meetId, reused: true });
      }
      const c = await conn(req.workspaceId);
      if (!c) return res.status(409).json({ code: "not_connected", message: "Connect Google Calendar first" });
      const at = await token(req.workspaceId, c);
      const key = `appt-${appt.id}`;
      const out = await withRetry(() => createEvent({
        accessToken: at, summary: appt.title, description: appt.description || "",
        startISO: appt.startISO, endISO: appt.endISO, timeZone: appt.timeZone,
        attendees: [appt.customerEmail, appt.staffEmail], virtual: appt.type === "virtual",
        idempotencyKey: key, fetchImpl,
      }));
      await db.attachGoogleEvent(req.workspaceId, appt.id, {
        googleEventId: out.eventId, meetUrl: out.meetUrl, meetId: out.meetId,
        htmlLink: out.htmlLink, syncedAt: new Date().toISOString(),
      });
      await db.writeAudit(req.workspaceId, { action: "appointment.meeting.created", appointmentId: appt.id, eventId: out.eventId });
      res.status(201).json({ eventId: out.eventId, meetUrl: out.meetUrl, meetId: out.meetId, htmlLink: out.htmlLink });
    } catch (e) { next(e); }
  });

  r.patch("/appointments/:id/meeting", async (req, res, next) => {
    try {
      const appt = await db.getAppointment(req.workspaceId, req.params.id);
      if (!appt || !appt.googleEventId) return res.status(404).json({ code: "not_found", message: "No Google event for this appointment" });
      const c = await conn(req.workspaceId);
      if (!c) return res.status(409).json({ code: "not_connected", message: "Connect Google Calendar first" });
      const at = await token(req.workspaceId, c);
      const out = await withRetry(() => updateEvent({
        accessToken: at, eventId: appt.googleEventId,
        startISO: req.body.start, endISO: req.body.end, timeZone: appt.timeZone, fetchImpl,
      }));
      await db.attachGoogleEvent(req.workspaceId, appt.id, { meetUrl: out.meetUrl || appt.meetUrl, syncedAt: new Date().toISOString() });
      await db.writeAudit(req.workspaceId, { action: "appointment.meeting.rescheduled", appointmentId: appt.id, eventId: appt.googleEventId });
      res.json({ eventId: out.eventId, meetUrl: out.meetUrl || appt.meetUrl });
    } catch (e) { next(e); }
  });

  r.delete("/appointments/:id/meeting", async (req, res, next) => {
    try {
      const appt = await db.getAppointment(req.workspaceId, req.params.id);
      if (!appt || !appt.googleEventId) return res.json({ cancelled: true, alreadyGone: true });
      const c = await conn(req.workspaceId);
      if (!c) return res.status(409).json({ code: "not_connected", message: "Connect Google Calendar first" });
      const at = await token(req.workspaceId, c);
      const out = await withRetry(() => cancelEvent({ accessToken: at, eventId: appt.googleEventId, fetchImpl }));
      await db.clearGoogleEvent(req.workspaceId, appt.id);
      await db.writeAudit(req.workspaceId, { action: "appointment.meeting.cancelled", appointmentId: appt.id });
      res.json(out);
    } catch (e) { next(e); }
  });

  /**
   * Google push notification endpoint. Google sends headers only, so we
   * re-read the changed events and reconcile. The channel token proves the
   * call came from our own watch registration.
   */
  r.post("/webhook", async (req, res) => {
    const channelToken = req.get("x-goog-channel-token");
    const resourceState = req.get("x-goog-resource-state");
    const channelId = req.get("x-goog-channel-id");
    if (!channelToken || !(await db.verifyChannelToken(channelId, channelToken))) return res.sendStatus(404);
    /* Acknowledge immediately; reconciliation happens on the worker so a slow
       sync never makes Google retry the notification. */
    res.sendStatus(200);
    if (resourceState === "sync") return;
    await db.enqueueCalendarSync({ channelId, resourceState }).catch(() => {});
  });

  return r;
}

/** Maps Google failures onto responses that say what actually happened. */
export function googleErrorHandler(err, req, res, next) {
  if (!(err instanceof GoogleError)) return next(err);
  if (err.needsReconnect) {
    return res.status(409).json({ code: "reconnect_required",
      message: "Google access has expired or was revoked. Reconnect the account to continue.", retryable: false });
  }
  return res.status(err.status && err.status < 500 ? err.status : 502).json({
    code: err.code, message: err.message, retryable: err.retryable,
  });
}
