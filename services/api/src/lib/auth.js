/**
 * Authentication service.
 *
 * Real, deployable server code. Passwords are hashed with scrypt (Node built
 * in, memory hard), never stored or logged in the clear. Session and reset
 * tokens are random, and only their hashes are stored, so a database leak
 * cannot be replayed against the service.
 *
 * `now` and `randomBytes` are injectable so expiry and single use behaviour
 * can be tested deterministically.
 */
import crypto from "node:crypto";

const SCRYPT = { N: 16384, r: 8, p: 1, keylen: 64 };
export const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;   // 30 days
export const VERIFY_TTL_MS = 24 * 60 * 60 * 1000;         // 1 day
export const RESET_TTL_MS = 60 * 60 * 1000;               // 1 hour
export const MAX_ATTEMPTS = 8;
export const LOCKOUT_MS = 15 * 60 * 1000;

export class AuthError extends Error {
  constructor(code, message, status = 400) {
    super(message);
    this.name = "AuthError";
    this.code = code;
    this.status = status;
  }
}

/* ---- passwords ---- */
export function hashPassword(password) {
  assertPasswordPolicy(password);
  const salt = crypto.randomBytes(16);
  const key = crypto.scryptSync(password, salt, SCRYPT.keylen, { N: SCRYPT.N, r: SCRYPT.r, p: SCRYPT.p });
  return `scrypt$${SCRYPT.N}$${SCRYPT.r}$${SCRYPT.p}$${salt.toString("base64")}$${key.toString("base64")}`;
}

export function verifyPassword(password, stored) {
  if (!stored || typeof stored !== "string") return false;
  const parts = stored.split("$");
  if (parts[0] !== "scrypt" || parts.length !== 6) return false;
  const [, N, r, p, salt, key] = parts;
  let derived;
  try {
    derived = crypto.scryptSync(String(password ?? ""), Buffer.from(salt, "base64"),
      Buffer.from(key, "base64").length, { N: +N, r: +r, p: +p });
  } catch { return false; }
  const expected = Buffer.from(key, "base64");
  /* constant time: a wrong password must not be distinguishable by timing */
  if (derived.length !== expected.length) return false;
  return crypto.timingSafeEqual(derived, expected);
}

/* Rejected weak passwords are refused at the source rather than warned about. */
export function assertPasswordPolicy(password) {
  const p = String(password ?? "");
  if (p.length < 10) throw new AuthError("weak_password", "Use at least 10 characters.");
  if (p.length > 200) throw new AuthError("weak_password", "That password is too long.");
  if (!/[a-zA-Z]/.test(p) || !/[0-9]/.test(p)) throw new AuthError("weak_password", "Include at least one letter and one number.");
  const common = ["password12", "1234567890", "qwertyuiop", "letmein123", "welcome123", "admin12345"];
  if (common.includes(p.toLowerCase())) throw new AuthError("weak_password", "That password is too easy to guess.");
  return true;
}

/* ---- emails ---- */
export function normaliseEmail(email) {
  const e = String(email ?? "").trim().toLowerCase();
  if (!/^[^@\s]+@[^@\s.]+\.[^@\s]+$/.test(e)) throw new AuthError("invalid_email", "Enter a valid email address.");
  return e;
}

/* ---- tokens: random, single use, stored only as a hash ---- */
export function newToken(randomBytes = crypto.randomBytes) {
  const raw = randomBytes(32).toString("base64url");
  return { raw, hash: hashToken(raw) };
}
export const hashToken = (raw) => crypto.createHash("sha256").update(String(raw)).digest("hex");

/* ---- sign up ----
   Always returns the same shape whether or not the email is taken, so the
   endpoint cannot be used to enumerate which addresses have accounts. */
export async function signUp({ email, password, name }, { db, now = Date.now, randomBytes = crypto.randomBytes, sendEmail }) {
  const e = normaliseEmail(email);
  assertPasswordPolicy(password);
  const existing = await db.findUserByEmail(e);
  const token = newToken(randomBytes);
  if (existing) {
    /* do not reveal the account exists; send a "you already have an account"
       email instead, which is useful to the real owner and useless to a prober */
    if (sendEmail) await sendEmail({ to: e, kind: "already_registered" });
    return { created: false, enumerationSafe: true };
  }
  const user = await db.createUser({
    email: e, name: String(name || "").trim() || null,
    passwordHash: hashPassword(password),
    emailVerified: false, createdAt: new Date(now()).toISOString(),
  });
  await db.createEmailVerification({
    userId: user.id, tokenHash: token.hash,
    expiresAt: new Date(now() + VERIFY_TTL_MS).toISOString(),
  });
  if (sendEmail) await sendEmail({ to: e, kind: "verify", token: token.raw });
  return { created: true, userId: user.id, enumerationSafe: true };
}

export async function verifyEmail({ token }, { db, now = Date.now }) {
  const rec = await db.findEmailVerification(hashToken(token));
  if (!rec) throw new AuthError("invalid_token", "That verification link is not valid.", 400);
  if (rec.consumedAt) throw new AuthError("used_token", "That link has already been used.", 400);
  if (new Date(rec.expiresAt).getTime() <= now()) throw new AuthError("expired_token", "That link has expired. Request a new one.", 400);
  await db.consumeEmailVerification(rec.id, new Date(now()).toISOString());
  await db.markEmailVerified(rec.userId);
  return { verified: true, userId: rec.userId };
}

/* ---- log in ---- */
export async function logIn({ email, password, ip, userAgent }, { db, now = Date.now, randomBytes = crypto.randomBytes, requireVerified = true }) {
  const e = normaliseEmail(email);
  const attempts = await db.recentFailedLogins(e, new Date(now() - LOCKOUT_MS).toISOString());
  if (attempts >= MAX_ATTEMPTS) {
    throw new AuthError("locked_out", "Too many attempts. Try again in a few minutes.", 429);
  }
  const user = await db.findUserByEmail(e);
  /* same error and similar work for unknown user and wrong password */
  const okPassword = user ? verifyPassword(password, user.passwordHash) : verifyPassword(password, "scrypt$16384$8$1$AAAA$AAAA");
  if (!user || !okPassword) {
    await db.recordFailedLogin({ email: e, ip, at: new Date(now()).toISOString() });
    throw new AuthError("invalid_credentials", "That email and password do not match.", 401);
  }
  if (user.status === "suspended") throw new AuthError("suspended", "This account is suspended. Contact support.", 403);
  if (requireVerified && !user.emailVerified) {
    throw new AuthError("unverified", "Confirm your email address first. We sent you a link.", 403);
  }
  await db.clearFailedLogins(e);
  const token = newToken(randomBytes);
  const session = await db.createSession({
    userId: user.id, tokenHash: token.hash, ip: ip || null, userAgent: userAgent || null,
    createdAt: new Date(now()).toISOString(),
    expiresAt: new Date(now() + SESSION_TTL_MS).toISOString(),
  });
  const memberships = await db.listMemberships(user.id);
  return {
    token: token.raw, sessionId: session.id,
    user: publicUser(user),
    workspaces: memberships,
    /* the client uses this to decide between onboarding and the dashboard;
       the server decides it, not the browser */
    next: routeAfterLogin(user, memberships),
  };
}

/* Never send the hash, the salt or anything else sensitive to a browser. */
export function publicUser(user) {
  return { id: user.id, email: user.email, name: user.name || null,
    emailVerified: !!user.emailVerified, createdAt: user.createdAt || null };
}

/**
 * Where a user belongs after authenticating.
 * An onboarded user must never be sent back through onboarding.
 */
export function routeAfterLogin(user, memberships = []) {
  if (!user.emailVerified) return { screen: "verify_email" };
  if (!memberships.length) return { screen: "create_workspace" };
  const active = memberships.find((m) => m.lastActiveAt) || memberships[0];
  if (memberships.length > 1 && !active.lastActiveAt) return { screen: "choose_workspace", workspaces: memberships };
  if (!active.onboardingComplete) return { screen: "onboarding", workspaceId: active.workspaceId, resumeFrom: active.onboardingStep || null };
  return { screen: "dashboard", workspaceId: active.workspaceId };
}

export async function currentSession({ token }, { db, now = Date.now }) {
  if (!token) return null;
  const s = await db.findSession(hashToken(token));
  if (!s) return null;
  if (s.revokedAt) return null;
  if (new Date(s.expiresAt).getTime() <= now()) return null;
  const user = await db.findUserById(s.userId);
  if (!user || user.status === "suspended") return null;
  return { session: s, user: publicUser(user) };
}

export async function logOut({ token }, { db, now = Date.now }) {
  if (!token) return { ok: true };
  await db.revokeSession(hashToken(token), new Date(now()).toISOString());
  return { ok: true };
}

/* ---- password reset ----
   Always reports success, so the endpoint cannot confirm whether an address
   has an account. */
export async function requestPasswordReset({ email }, { db, now = Date.now, randomBytes = crypto.randomBytes, sendEmail }) {
  let e;
  try { e = normaliseEmail(email); } catch { return { sent: true, enumerationSafe: true }; }
  const user = await db.findUserByEmail(e);
  if (user) {
    const token = newToken(randomBytes);
    await db.createPasswordReset({ userId: user.id, tokenHash: token.hash,
      expiresAt: new Date(now() + RESET_TTL_MS).toISOString() });
    if (sendEmail) await sendEmail({ to: e, kind: "reset", token: token.raw });
  }
  return { sent: true, enumerationSafe: true };
}

export async function resetPassword({ token, password }, { db, now = Date.now }) {
  const rec = await db.findPasswordReset(hashToken(token));
  if (!rec) throw new AuthError("invalid_token", "That reset link is not valid.", 400);
  if (rec.consumedAt) throw new AuthError("used_token", "That reset link has already been used.", 400);
  if (new Date(rec.expiresAt).getTime() <= now()) throw new AuthError("expired_token", "That reset link has expired.", 400);
  assertPasswordPolicy(password);
  await db.consumePasswordReset(rec.id, new Date(now()).toISOString());
  await db.updatePassword(rec.userId, hashPassword(password));
  /* every existing session dies with the old password, which is the point of
     resetting it after a compromise */
  await db.revokeAllSessions(rec.userId, new Date(now()).toISOString());
  return { reset: true, userId: rec.userId, sessionsRevoked: true };
}

export async function changePassword({ userId, currentPassword, newPassword, keepSessionToken }, { db, now = Date.now }) {
  const user = await db.findUserById(userId);
  if (!user) throw new AuthError("not_found", "Account not found.", 404);
  if (!verifyPassword(currentPassword, user.passwordHash)) {
    throw new AuthError("invalid_credentials", "Your current password is not correct.", 401);
  }
  assertPasswordPolicy(newPassword);
  await db.updatePassword(userId, hashPassword(newPassword));
  await db.revokeAllSessions(userId, new Date(now()).toISOString(), keepSessionToken ? hashToken(keepSessionToken) : null);
  return { changed: true };
}

/* ---- authorization boundary ----
   Customer users and BUZZZ staff are different populations. Staff access is
   never granted by a workspace role, and workspace access is never granted by
   a staff role without an explicit, logged support grant. */
export const ROLES = ["owner", "admin", "member", "viewer"];
export const STAFF_ROLES = ["support", "ops", "superadmin"];

export function canAccessWorkspace(session, workspaceId, memberships = []) {
  if (!session || !session.user) return { ok: false, reason: "not_authenticated" };
  const m = memberships.find((x) => x.workspaceId === workspaceId && x.userId === session.user.id);
  if (m) return { ok: true, role: m.role };
  /* staff do not get in implicitly; they need a time boxed support grant */
  if (session.staff && session.supportGrant &&
      session.supportGrant.workspaceId === workspaceId &&
      new Date(session.supportGrant.expiresAt).getTime() > Date.now()) {
    return { ok: true, role: "support", impersonating: true, readOnly: session.supportGrant.readOnly !== false };
  }
  return { ok: false, reason: "not_a_member" };
}

export function requireStaff(session, role = "support") {
  if (!session || !session.staff) return { ok: false, reason: "not_staff" };
  const rank = STAFF_ROLES.indexOf(session.staff.role);
  const need = STAFF_ROLES.indexOf(role);
  if (rank < 0 || rank < need) return { ok: false, reason: "insufficient_staff_role" };
  return { ok: true, role: session.staff.role };
}
