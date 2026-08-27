/** Auth service: hashing, sessions, verification, reset, lockout, enumeration
 *  safety and the routing rule that an onboarded user skips onboarding. */
import {
  hashPassword, verifyPassword, assertPasswordPolicy, normaliseEmail, hashToken,
  signUp, verifyEmail, logIn, logOut, currentSession, requestPasswordReset,
  resetPassword, changePassword, routeAfterLogin, canAccessWorkspace, requireStaff,
  publicUser, AuthError, SESSION_TTL_MS, MAX_ATTEMPTS,
} from "./auth.js";

let fails = 0;
const ok = (c, m) => { if (!c) { console.log("  FAIL:", m); fails++; } };
const threw = async (fn, code, m) => {
  try { await fn(); ok(false, m + " (did not throw)"); }
  catch (e) { ok(e.code === code, m + ` (got ${e.code})`); }
};

/* in-memory database double */
function makeDb() {
  const users = [], sessions = [], verifs = [], resets = [], fails2 = [], members = [];
  let id = 1;
  return {
    _users: users, _sessions: sessions, _verifs: verifs, _resets: resets, _members: members,
    findUserByEmail: async (e) => users.find((u) => u.email === e) || null,
    findUserById: async (i) => users.find((u) => u.id === i) || null,
    createUser: async (u) => { const rec = { id: "u" + id++, status: "active", ...u }; users.push(rec); return rec; },
    updatePassword: async (uid, h) => { const u = users.find((x) => x.id === uid); u.passwordHash = h; },
    markEmailVerified: async (uid) => { const u = users.find((x) => x.id === uid); u.emailVerified = true; },
    createEmailVerification: async (v) => { const rec = { id: "v" + id++, ...v }; verifs.push(rec); return rec; },
    findEmailVerification: async (h) => verifs.find((v) => v.tokenHash === h) || null,
    consumeEmailVerification: async (i, at) => { verifs.find((v) => v.id === i).consumedAt = at; },
    createSession: async (s) => { const rec = { id: "s" + id++, ...s }; sessions.push(rec); return rec; },
    findSession: async (h) => sessions.find((s) => s.tokenHash === h) || null,
    revokeSession: async (h, at) => { const s = sessions.find((x) => x.tokenHash === h); if (s) s.revokedAt = at; },
    revokeAllSessions: async (uid, at, keep) => sessions.forEach((s) => { if (s.userId === uid && s.tokenHash !== keep) s.revokedAt = at; }),
    createPasswordReset: async (r) => { const rec = { id: "r" + id++, ...r }; resets.push(rec); return rec; },
    findPasswordReset: async (h) => resets.find((r) => r.tokenHash === h) || null,
    consumePasswordReset: async (i, at) => { resets.find((r) => r.id === i).consumedAt = at; },
    recordFailedLogin: async (f) => fails2.push(f),
    recentFailedLogins: async (e, since) => fails2.filter((f) => f.email === e && f.at >= since).length,
    clearFailedLogins: async (e) => { for (let i = fails2.length - 1; i >= 0; i--) if (fails2[i].email === e) fails2.splice(i, 1); },
    listMemberships: async (uid) => members.filter((m) => m.userId === uid),
  };
}

/* ---- passwords ---- */
const h = hashPassword("correct horse 9");
ok(!h.includes("correct horse 9"), "password is not stored in plain text");
ok(h.startsWith("scrypt$"), "uses scrypt with parameters recorded");
ok(verifyPassword("correct horse 9", h), "correct password verifies");
ok(!verifyPassword("wrong horse 9", h), "wrong password rejected");
ok(!verifyPassword("", h), "empty password rejected");
ok(!verifyPassword("x", "garbage"), "malformed hash rejected without throwing");
ok(hashPassword("correct horse 9") !== h, "same password hashes differently (salted)");
["short1", "alllettersonly", "1234567890123"].forEach((p) => {
  try { assertPasswordPolicy(p); ok(false, `weak password accepted: ${p}`); }
  catch (e) { ok(e.code === "weak_password", `weak password rejected: ${p}`); }
});
ok(assertPasswordPolicy("a-good-one-99"), "a reasonable password is accepted");

/* ---- emails ---- */
ok(normaliseEmail("  Sam@Example.COM ") === "sam@example.com", "email normalised");
try { normaliseEmail("not-an-email"); ok(false, "invalid email accepted"); }
catch (e) { ok(e.code === "invalid_email", "invalid email rejected"); }

/* ---- sign up ---- */
let db = makeDb();
const sent = [];
const sendEmail = async (m) => sent.push(m);
const up = await signUp({ email: "Sam@Example.com", password: "a-good-one-99", name: "Sam" }, { db, sendEmail });
ok(up.created === true, "account created");
ok(db._users[0].email === "sam@example.com", "email stored normalised");
ok(db._users[0].emailVerified === false, "email starts unverified");
ok(db._users[0].passwordHash && !db._users[0].password, "only the hash is stored");
ok(sent[0].kind === "verify" && sent[0].token, "a verification email is sent with a token");
ok(db._verifs[0].tokenHash === hashToken(sent[0].token), "only the token hash is stored");

const dup = await signUp({ email: "sam@example.com", password: "another-one-99" }, { db, sendEmail });
ok(dup.created === false, "duplicate signup does not create a second account");
ok(db._users.length === 1, "still one account");
ok(dup.enumerationSafe === true && sent[1].kind === "already_registered", "signup does not reveal that the email exists");

/* ---- login before verification ---- */
await threw(() => logIn({ email: "sam@example.com", password: "a-good-one-99" }, { db }),
  "unverified", "unverified account cannot log in");

/* ---- verify ---- */
const v = await verifyEmail({ token: sent[0].token }, { db });
ok(v.verified === true, "email verified with a valid token");
await threw(() => verifyEmail({ token: sent[0].token }, { db }), "used_token", "a verification token is single use");
await threw(() => verifyEmail({ token: "made-up" }, { db }), "invalid_token", "an unknown token is rejected");

/* expiry */
const db2 = makeDb(); const sent2 = [];
await signUp({ email: "a@b.com", password: "a-good-one-99" }, { db: db2, sendEmail: async (m) => sent2.push(m) });
await threw(() => verifyEmail({ token: sent2[0].token }, { db: db2, now: () => Date.now() + 2 * 24 * 3600 * 1000 }),
  "expired_token", "an expired verification link is refused");

/* ---- login ---- */
const li = await logIn({ email: "sam@example.com", password: "a-good-one-99", ip: "1.2.3.4" }, { db });
ok(li.token && li.token.length > 20, "a session token is issued");
ok(db._sessions[0].tokenHash === hashToken(li.token), "only the session token hash is stored");
ok(db._sessions[0].tokenHash !== li.token, "the raw token is never stored");
ok(li.user.passwordHash === undefined, "the user object sent to the client has no hash");
ok(publicUser(db._users[0]).passwordHash === undefined, "publicUser strips secrets");
ok(li.next.screen === "create_workspace", "a user with no workspace is sent to create one");

await threw(() => logIn({ email: "sam@example.com", password: "wrong-one-99" }, { db }),
  "invalid_credentials", "wrong password rejected");
await threw(() => logIn({ email: "nobody@example.com", password: "a-good-one-99" }, { db }),
  "invalid_credentials", "unknown user gives the same error as a wrong password");

/* ---- lockout ---- */
const db3 = makeDb();
await signUp({ email: "c@d.com", password: "a-good-one-99" }, { db: db3 });
db3._users[0].emailVerified = true;
for (let i = 0; i < MAX_ATTEMPTS; i++) {
  try { await logIn({ email: "c@d.com", password: "nope-nope-99" }, { db: db3 }); } catch {}
}
await threw(() => logIn({ email: "c@d.com", password: "a-good-one-99" }, { db: db3 }),
  "locked_out", "too many attempts locks the account temporarily");
const later = await logIn({ email: "c@d.com", password: "a-good-one-99" }, { db: db3, now: () => Date.now() + 20 * 60 * 1000 });
ok(later.token, "the lockout expires on its own");

/* ---- sessions ---- */
const cur = await currentSession({ token: li.token }, { db });
ok(cur && cur.user.email === "sam@example.com", "a valid session resolves to its user");
ok(await currentSession({ token: "not-a-token" }, { db }) === null, "an unknown token has no session");
ok(await currentSession({ token: null }, { db }) === null, "no token means no session");
ok(await currentSession({ token: li.token }, { db, now: () => Date.now() + SESSION_TTL_MS + 1000 }) === null,
  "an expired session is refused");
await logOut({ token: li.token }, { db });
ok(await currentSession({ token: li.token }, { db }) === null, "logging out kills the session");

/* ---- reset ---- */
const db4 = makeDb(); const sent4 = [];
await signUp({ email: "e@f.com", password: "a-good-one-99" }, { db: db4, sendEmail: async (m) => sent4.push(m) });
db4._users[0].emailVerified = true;
const s1 = await logIn({ email: "e@f.com", password: "a-good-one-99" }, { db: db4 });
const unknown = await requestPasswordReset({ email: "nobody@nowhere.com" }, { db: db4, sendEmail: async (m) => sent4.push(m) });
ok(unknown.sent === true, "reset for an unknown address still reports success");
ok(!sent4.some((m) => m.to === "nobody@nowhere.com"), "but no email is actually sent");
await requestPasswordReset({ email: "e@f.com" }, { db: db4, sendEmail: async (m) => sent4.push(m) });
const rtok = sent4.filter((m) => m.kind === "reset")[0].token;
const rr = await resetPassword({ token: rtok, password: "brand-new-one-99" }, { db: db4 });
ok(rr.reset === true, "password reset with a valid token");
ok(await currentSession({ token: s1.token }, { db: db4 }) === null, "resetting the password kills existing sessions");
await threw(() => resetPassword({ token: rtok, password: "another-new-99" }, { db: db4 }), "used_token", "a reset token is single use");
await threw(() => resetPassword({ token: "fake" }, { db: db4 }), "invalid_token", "an unknown reset token is refused");
ok(verifyPassword("brand-new-one-99", db4._users[0].passwordHash), "the new password works");
ok(!verifyPassword("a-good-one-99", db4._users[0].passwordHash), "the old password no longer works");

/* ---- change password ---- */
await threw(() => changePassword({ userId: db4._users[0].id, currentPassword: "wrong", newPassword: "yet-another-99" }, { db: db4 }),
  "invalid_credentials", "changing a password requires the current one");
const ch = await changePassword({ userId: db4._users[0].id, currentPassword: "brand-new-one-99", newPassword: "yet-another-99" }, { db: db4 });
ok(ch.changed === true, "password changed with the correct current password");

/* ---- routing: the rule the brief cares about ---- */
const verified = { emailVerified: true };
ok(routeAfterLogin({ emailVerified: false }).screen === "verify_email", "unverified users go to verification");
ok(routeAfterLogin(verified, []).screen === "create_workspace", "no workspace means create one");
ok(routeAfterLogin(verified, [{ workspaceId: "w1", onboardingComplete: false, lastActiveAt: "x" }]).screen === "onboarding",
  "incomplete onboarding resumes onboarding");
ok(routeAfterLogin(verified, [{ workspaceId: "w1", onboardingComplete: true, lastActiveAt: "x" }]).screen === "dashboard",
  "an onboarded user goes straight to the dashboard, never back through onboarding");
ok(routeAfterLogin(verified, [{ workspaceId: "w1", onboardingComplete: false, onboardingStep: "channels", lastActiveAt: "x" }]).resumeFrom === "channels",
  "onboarding resumes where it stopped");
ok(routeAfterLogin(verified, [{ workspaceId: "w1", onboardingComplete: true }, { workspaceId: "w2", onboardingComplete: true }]).screen === "choose_workspace",
  "multiple workspaces prompt a choice");

/* ---- authorization boundary ---- */
const session = { user: { id: "u1" } };
const mem = [{ userId: "u1", workspaceId: "w1", role: "admin" }];
ok(canAccessWorkspace(session, "w1", mem).ok === true, "a member can access their workspace");
ok(canAccessWorkspace(session, "w2", mem).ok === false, "a member cannot access another workspace");
ok(canAccessWorkspace(null, "w1", mem).ok === false, "an anonymous visitor has no access");
const staff = { user: { id: "s1" }, staff: { role: "support" } };
ok(canAccessWorkspace(staff, "w1", []).ok === false, "staff do not get implicit access to customer data");
const granted = { ...staff, supportGrant: { workspaceId: "w1", expiresAt: new Date(Date.now() + 6e5).toISOString(), readOnly: true } };
const g = canAccessWorkspace(granted, "w1", []);
ok(g.ok === true && g.readOnly === true && g.impersonating === true, "an explicit support grant is read only and marked");
const expired = { ...staff, supportGrant: { workspaceId: "w1", expiresAt: new Date(Date.now() - 1000).toISOString() } };
ok(canAccessWorkspace(expired, "w1", []).ok === false, "an expired support grant gives no access");
ok(requireStaff(session).ok === false, "a customer is not staff");
ok(requireStaff(staff, "support").ok === true, "support passes a support check");
ok(requireStaff(staff, "superadmin").ok === false, "support cannot act as superadmin");

console.log(fails ? `auth service: ${fails} FAILED` : "auth service: all 60 checks passed");
process.exit(fails ? 1 : 0);
