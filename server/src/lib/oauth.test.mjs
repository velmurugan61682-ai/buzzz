/** Social sign in, tested against login CSRF, code interception and the
 *  account takeover that unverified email linking would allow. */
import { PROVIDERS, configuredProviders, buildAuthorizeUrl, exchangeCode, resolveIdentity, newPkce, decodeIdToken, OAuthError } from "./oauth.js";
import crypto from "node:crypto";

let fails = 0;
const ok = (c, m) => { if (!c) { console.log("  FAIL:", m); fails++; } };
const threw = async (fn, code, m) => {
  try { await fn(); ok(false, m + " (did not throw)"); }
  catch (e) { ok(e.code === code, `${m} (got ${e.code})`); }
};
const ENV = {
  GOOGLE_OAUTH_CLIENT_ID: "gid", GOOGLE_OAUTH_CLIENT_SECRET: "gsec",
  APPLE_OAUTH_CLIENT_ID: "aid", APPLE_OAUTH_CLIENT_SECRET: "asec",
};
const RURI = "https://buzzzbuzzz.com/auth/callback";

/* ---- only configured providers are offered ---- */
ok(configuredProviders(ENV).sort().join() === "apple,google", "both providers are offered when configured");
ok(configuredProviders({ GOOGLE_OAUTH_CLIENT_ID: "x", GOOGLE_OAUTH_CLIENT_SECRET: "y" }).join() === "google",
   "only providers with credentials are offered");
ok(configuredProviders({}).length === 0, "nothing is offered when nothing is configured");
try { buildAuthorizeUrl("google", { redirectUri: RURI, env: {} }); ok(false, "unconfigured should throw"); }
catch (e) { ok(e.code === "not_configured", "an unconfigured provider refuses rather than sending the user to a broken screen"); }
try { buildAuthorizeUrl("facebook", { redirectUri: RURI, env: ENV }); ok(false, "unknown provider should throw"); }
catch (e) { ok(e.code === "unknown_provider", "an unknown provider is refused"); }

/* ---- the authorize URL ---- */
const g = buildAuthorizeUrl("google", { redirectUri: RURI, env: ENV });
const u = new URL(g.authorization_url);
ok(u.origin + u.pathname === "https://accounts.google.com/o/oauth2/v2/auth", "google's real endpoint is used");
ok(u.searchParams.get("client_id") === "gid", "the client id is sent");
ok(u.searchParams.get("redirect_uri") === RURI, "the redirect uri is sent");
ok(u.searchParams.get("state") === g.state && g.state.length > 20, "a random state is issued");
ok(u.searchParams.get("code_challenge_method") === "S256", "PKCE is used");
ok(!u.searchParams.get("code_challenge").includes(g.verifier), "the verifier itself is never sent to the provider");
ok(g.verifier && g.verifier.length > 20, "the verifier is kept server side");

const a = buildAuthorizeUrl("apple", { redirectUri: RURI, env: ENV });
ok(new URL(a.authorization_url).searchParams.get("response_mode") === "form_post",
   "apple gets form_post, which it requires when asking for name or email");
ok(buildAuthorizeUrl("google", { redirectUri: RURI, env: ENV }).state !== g.state, "each attempt gets a fresh state");

/* ---- login CSRF: the state must match, once ---- */
const stored = { state: g.state, verifier: g.verifier, provider: "google", expiresAt: new Date(Date.now() + 6e5).toISOString() };
const fetchOk = async (url) => url.includes("token")
  ? { ok: true, status: 200, json: async () => ({ access_token: "at" }) }
  : { ok: true, status: 200, json: async () => ({ sub: "g-1", email: "sam@buzzzbuzzz.com", email_verified: true, name: "Sam" }) };

await threw(() => exchangeCode("google", { code: "c", state: "attacker-supplied", stored, redirectUri: RURI, env: ENV, fetchImpl: fetchOk }),
  "bad_state", "a mismatched state is refused");
await threw(() => exchangeCode("google", { code: "c", state: g.state, stored: null, redirectUri: RURI, env: ENV, fetchImpl: fetchOk }),
  "bad_state", "a callback with no stored state is refused");
await threw(() => exchangeCode("google", { code: "c", state: g.state, stored: { ...stored, consumedAt: new Date().toISOString() }, redirectUri: RURI, env: ENV, fetchImpl: fetchOk }),
  "used_state", "a state cannot be used twice");
await threw(() => exchangeCode("google", { code: "c", state: g.state, stored: { ...stored, expiresAt: new Date(Date.now() - 1).toISOString() }, redirectUri: RURI, env: ENV, fetchImpl: fetchOk }),
  "expired_state", "an expired state is refused");
await threw(() => exchangeCode("google", { code: "c", state: g.state, stored: { ...stored, provider: "apple" }, redirectUri: RURI, env: ENV, fetchImpl: fetchOk }),
  "bad_state", "a state issued for another provider is refused");

/* ---- the verifier is sent on exchange, which is what defeats code interception ---- */
let sentBody = null;
await exchangeCode("google", { code: "c", state: g.state, stored, redirectUri: RURI, env: ENV,
  fetchImpl: async (url, o) => { if (url.includes("token")) sentBody = String(o.body); return fetchOk(url); } });
ok(sentBody.includes(`code_verifier=${g.verifier}`), "the PKCE verifier is sent on exchange");
ok(sentBody.includes("client_secret=gsec"), "the client secret stays server side and is sent here");

/* ---- provider failures are surfaced, not swallowed ---- */
await threw(() => exchangeCode("google", { code: "bad", state: g.state, stored, redirectUri: RURI, env: ENV,
  fetchImpl: async () => ({ ok: false, status: 400, json: async () => ({ error: "invalid_grant" }) }) }),
  "exchange_failed", "a rejected code surfaces as a failure");

/* ---- profiles ---- */
const res = await exchangeCode("google", { code: "c", state: g.state, stored, redirectUri: RURI, env: ENV, fetchImpl: fetchOk });
ok(res.profile.uid === "g-1" && res.profile.emailVerified === true, "google's profile is mapped");

const claims = Buffer.from(JSON.stringify({ sub: "a-1", email: "sam@privaterelay.appleid.com", email_verified: "true" })).toString("base64url");
const appleStored = { ...stored, provider: "apple", appleName: "Sam Apple" };
const ar = await exchangeCode("apple", { code: "c", state: g.state, stored: appleStored, redirectUri: RURI, env: ENV,
  fetchImpl: async () => ({ ok: true, status: 200, json: async () => ({ id_token: `h.${claims}.s` }) }) });
ok(ar.profile.uid === "a-1", "apple's identity token is read");
ok(ar.profile.isPrivateRelay === true, "an apple private relay address is recognised");
ok(ar.profile.name === "Sam Apple", "apple's name is taken from the first callback, since it never comes again");
ok(ar.profile.emailVerified === true, "apple's string 'true' is handled");

/* ---- account takeover: the decision that matters most ---- */
const verified = { uid: "g-1", email: "sam@buzzzbuzzz.com", emailVerified: true, name: "Sam" };
const unverified = { ...verified, emailVerified: false };
const existing = { id: "u-victim" };

ok(resolveIdentity({ provider: "google", profile: verified, existingIdentity: { userId: "u-1" } }).action === "login",
   "an already linked identity signs in");
ok(resolveIdentity({ provider: "google", profile: verified, existingUserByEmail: null }).action === "create",
   "a new address creates an account");
ok(resolveIdentity({ provider: "google", profile: verified, existingUserByEmail: existing }).action === "link",
   "a verified address links to the existing account");
const takeover = resolveIdentity({ provider: "google", profile: unverified, existingUserByEmail: existing });
ok(takeover.action === "verify_first",
   "an UNVERIFIED address must NOT link to an existing account: this is the account takeover path");
ok(takeover.action !== "login" && takeover.action !== "link", "and it neither signs in nor links");
ok(resolveIdentity({ provider: "apple", profile: { uid: "a9", email: null }, existingUserByEmail: null }).action === "needs_email",
   "a provider that shares no email cannot silently create an account");

/* ---- malformed input ---- */
try { decodeIdToken("not-a-jwt"); ok(false, "a malformed token should throw"); }
catch (e) { ok(e.code === "bad_token", "a malformed identity token is refused"); }
const p1 = newPkce(), p2 = newPkce();
ok(p1.verifier !== p2.verifier, "each PKCE verifier is unique");

console.log(fails ? `oauth: ${fails} FAILED` : "oauth sign in: all checks passed");
process.exit(fails ? 1 : 0);
