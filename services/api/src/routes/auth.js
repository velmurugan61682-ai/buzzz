/**
 * Authentication routes.
 *
 * Thin HTTP wrappers over lib/auth.js. The service holds the rules; this file
 * only translates them into requests, responses and cookies. Tokens are set as
 * http-only cookies and never returned in a response body, so a script on the
 * page cannot read a session.
 */
import { Router } from "express";
import crypto from "node:crypto";
import { configuredProviders, buildAuthorizeUrl, exchangeCode, resolveIdentity, PROVIDERS, OAuthError } from "../lib/oauth.js";
import { newPasskeyChallenge, checkPasskeyResponse, checkSignCount, verifyTotp, useRecoveryCode, secondFactorFor } from "../lib/mfa.js";
import {
  signUp, verifyEmail, logIn, logOut, currentSession,
  requestPasswordReset, resetPassword, changePassword,
  routeAfterLogin, AuthError, SESSION_TTL_MS,
} from "../lib/auth.js";

const cookieOpts = {
  httpOnly: true,
  secure: process.env.NODE_ENV === "production",
  sameSite: "lax",
  maxAge: SESSION_TTL_MS,
  path: "/",
};

export function authRoutes({ db, config = {} }) {
  const r = Router();
  const deps = { db, sendEmail: config.sendEmail };

  const handle = (fn) => async (req, res, next) => {
    try { await fn(req, res); }
    catch (e) {
      if (e instanceof OAuthError) {
        return res.status(e.status || 400).json({ code: e.code, message: e.message });
      }
      if (e instanceof AuthError) {
        return res.status(e.status || 400).json({ code: e.code, message: e.message });
      }
      next(e);
    }
  };

  r.post("/signup", handle(async (req, res) => {
    const out = await signUp(req.body || {}, deps);
    /* the same response either way: this endpoint must not reveal which
       addresses already have accounts */
    res.status(201).json({ created: true, message: "Check your email to confirm the address." });
  }));

  r.post("/verify", handle(async (req, res) => {
    const out = await verifyEmail({ token: (req.body || {}).token }, { db });
    res.json(out);
  }));

  r.post("/login", handle(async (req, res) => {
    const out = await logIn({ ...(req.body || {}), ip: req.ip, userAgent: req.get("user-agent") }, { db });
    res.cookie("bz_session", out.token, cookieOpts);
    /* the token itself stays out of the body */
    res.json({ user: out.user, workspaces: out.workspaces, next: out.next });
  }));

  r.post("/logout", handle(async (req, res) => {
    await logOut({ token: req.cookies && req.cookies.bz_session }, { db });
    res.clearCookie("bz_session", { path: "/" });
    res.json({ ok: true });
  }));

  r.get("/session", handle(async (req, res) => {
    const s = await currentSession({ token: req.cookies && req.cookies.bz_session }, { db });
    if (!s) return res.status(401).json({ code: "not_authenticated", message: "No active session." });
    const memberships = await db.listMemberships(s.user.id);
    /* the destination is decided here, on the server, so a browser cannot talk
       its way past onboarding or into a workspace it does not belong to */
    res.json({ user: s.user, workspaces: memberships, next: routeAfterLogin({ ...s.user }, memberships) });
  }));

  r.post("/reset", handle(async (req, res) => {
    await requestPasswordReset({ email: (req.body || {}).email }, deps);
    res.json({ sent: true, message: "If that address has an account, a reset link is on its way." });
  }));

  r.post("/reset/confirm", handle(async (req, res) => {
    const out = await resetPassword(req.body || {}, { db });
    res.clearCookie("bz_session", { path: "/" });   // every session died with the old password
    res.json(out);
  }));

  r.post("/password", handle(async (req, res) => {
    const s = await currentSession({ token: req.cookies && req.cookies.bz_session }, { db });
    if (!s) return res.status(401).json({ code: "not_authenticated", message: "Sign in first." });
    const out = await changePassword({
      userId: s.user.id,
      currentPassword: (req.body || {}).currentPassword,
      newPassword: (req.body || {}).newPassword,
      keepSessionToken: req.cookies.bz_session,
    }, { db });
    res.json(out);
  }));

  /* ---- social sign in ----
     The browser never sees a client secret, and never chooses the state. */

  r.get("/oauth/providers", (req, res) => {
    /* the login page renders a button per entry, so an unconfigured provider
       simply does not appear rather than failing when clicked */
    res.json({ providers: configuredProviders().map((id) => ({ id, label: PROVIDERS[id].label })) });
  });

  r.get("/oauth/:provider/authorize", handle(async (req, res) => {
    const out = buildAuthorizeUrl(req.params.provider, {
      redirectUri: `${config.appUrl || ""}/auth/callback/${req.params.provider}`,
    });
    /* state and verifier are held here; only the URL goes to the browser */
    await db.saveOAuthLoginState({
      state: out.state, provider: out.provider, verifier: out.verifier,
      redirectTo: typeof req.query.next === "string" ? req.query.next : null,
      expiresAt: new Date(Date.now() + 10 * 60 * 1000).toISOString(),
    });
    res.json({ authorization_url: out.authorization_url, provider: out.provider, state: out.state });
  }));

  r.post("/oauth/:provider/callback", handle(async (req, res) => {
    const provider = req.params.provider;
    const { code, state } = req.body || {};
    const stored = await db.consumeOAuthLoginState(String(state || ""));
    const { profile } = await exchangeCode(provider, {
      code, state, stored,
      redirectUri: `${config.appUrl || ""}/auth/callback/${provider}`,
    });

    const identity = await db.findOAuthIdentity(provider, profile.uid);
    const byEmail = profile.email ? await db.findUserByEmail(profile.email) : null;
    const decision = resolveIdentity({ provider, profile, existingIdentity: identity, existingUserByEmail: byEmail });

    if (decision.action === "needs_email" || decision.action === "verify_first") {
      /* refusing to link is a deliberate answer, not an error */
      return res.status(409).json({ code: decision.action, message: decision.reason });
    }

    let userId = decision.userId;
    if (decision.action === "create") {
      const user = await db.createUser({
        email: decision.email, name: decision.name,
        passwordHash: null,                 // this account signs in with the provider
        emailVerified: decision.emailVerified,
      });
      userId = user.id;
    }
    if (decision.action !== "login") {
      await db.linkOAuthIdentity({ userId, provider, providerUid: profile.uid,
        email: profile.email, emailVerified: profile.emailVerified === true });
    }

    const user = await db.findUserById(userId);
    /* a social sign in does not skip the second factor */
    const second = secondFactorFor({ totpEnabled: user.totpEnabled, passkeyCount: await db.countPasskeys(userId) });
    if (second.required) {
      const pending = crypto.randomBytes(24).toString("base64url");
      await db.createPendingSession({ userId, token: pending, expiresAt: new Date(Date.now() + 6e5).toISOString() });
      return res.json({ mfaRequired: true, challenge: { ...second, pending } });
    }
    await issueSession(res, user);
    res.json({ user: publicUser(user), next: routeAfterLogin(user, await db.listMemberships(user.id)) });
  }));

  /* ---- passkeys ---- */

  r.post("/passkey/challenge", handle(async (req, res) => {
    const email = String((req.body || {}).email || "").trim().toLowerCase();
    const user = email ? await db.findUserByEmail(email) : null;
    /* an unknown address still gets a challenge, so this endpoint cannot be
       used to discover which addresses have accounts */
    const ch = newPasskeyChallenge({
      userId: user ? user.id : crypto.randomUUID(),
      email: email || "unknown", rpId: config.rpId,
    });
    await db.saveWebauthnChallenge({ userId: user ? user.id : null, challenge: ch.challenge,
      kind: "authenticate", expiresAt: ch.expiresAt });
    const creds = user ? await db.listPasskeys(user.id) : [];
    res.json({ publicKey: { ...ch.publicKey,
      allowCredentials: creds.map((c) => ({ type: "public-key", id: c.credentialId, transports: c.transports || undefined })) } });
  }));

  r.post("/passkey/verify", handle(async (req, res) => {
    const { credential } = req.body || {};
    const stored = await db.findWebauthnChallenge(credential && credential.challenge);
    const check = checkPasskeyResponse(credential, stored && { ...stored, kind: "authenticate" },
      { origin: config.appUrl, rpId: config.rpId });
    if (!check.ok) return res.status(401).json({ code: check.reason, message: check.message });

    const cred = await db.findPasskeyByCredentialId(credential.id);
    if (!cred) return res.status(401).json({ code: "unknown_passkey", message: "That passkey is not registered here." });

    /* signature verification belongs to @simplewebauthn/server and is wired in
       verifyPasskeySignature; refuse rather than assume when it is absent */
    if (!config.verifyPasskeySignature) {
      return res.status(503).json({ code: "passkey_unavailable",
        message: "Passkey sign in is not fully configured on this server yet." });
    }
    const sig = await config.verifyPasskeySignature({ credential, publicKey: cred.publicKey, challenge: stored.challenge });
    if (!sig || !sig.verified) return res.status(401).json({ code: "bad_signature", message: "That passkey could not be verified." });

    const counter = checkSignCount(cred.signCount, sig.newSignCount);
    if (!counter.ok) {
      await db.writeAudit(null, { actorType: "user", actorId: cred.userId, action: "passkey.clone_suspected", severity: "critical" });
      return res.status(401).json({ code: counter.reason, message: counter.message });
    }
    await db.touchPasskey(cred.id, sig.newSignCount);
    await db.consumeWebauthnChallenge(stored.id);

    const user = await db.findUserById(cred.userId);
    await issueSession(res, user);
    res.json({ user: publicUser(user), next: routeAfterLogin(user, await db.listMemberships(user.id)) });
  }));

  /* ---- second factor for a password or social sign in ---- */
  r.post("/mfa/verify", handle(async (req, res) => {
    const { pending, method, code } = req.body || {};
    const p = await db.consumePendingSession(String(pending || ""));
    if (!p) return res.status(401).json({ code: "expired", message: "That sign in attempt expired. Start again." });
    const user = await db.findUserById(p.userId);
    if (!user) return res.status(401).json({ code: "invalid", message: "Sign in again." });

    if (method === "totp") {
      const v = verifyTotp(user.totpSecret, code, { lastUsedCounter: user.totpLastCounter });
      if (!v.ok) return res.status(401).json({ code: v.reason, message: "That code is not right. Try the next one." });
      await db.setTotpCounter(user.id, v.counter);
    } else if (method === "recovery") {
      const hashes = await db.listRecoveryCodeHashes(user.id);
      const used = useRecoveryCode(code, hashes);
      if (!used.ok) return res.status(401).json({ code: "wrong", message: "That recovery code is not valid." });
      await db.consumeRecoveryCode(user.id, code);
    } else {
      return res.status(400).json({ code: "bad_method", message: "Choose a verification method." });
    }
    await issueSession(res, user);
    res.json({ user: publicUser(user), next: routeAfterLogin(user, await db.listMemberships(user.id)) });
  }));

  return r;
}
