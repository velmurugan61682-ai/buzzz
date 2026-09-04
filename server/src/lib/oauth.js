/**
 * Social sign in for BUZZZ.
 *
 * Google and Apple, implemented against each provider's own OAuth 2.0
 * endpoints. The security decisions worth knowing about:
 *
 *   - `state` is single use and stored server side. Without it, a third party
 *     can complete a sign in on someone else's behalf (login CSRF).
 *   - PKCE is used everywhere it is supported, so an intercepted code is
 *     useless without the verifier.
 *   - An existing account is only ever linked when the provider states the
 *     email is verified. Otherwise anyone who can create an account at a
 *     provider with your address takes over your BUZZZ workspace.
 *   - Apple returns the name once, on the first authorisation, and never again.
 */
import crypto from "node:crypto";

export class OAuthError extends Error {
  constructor(code, message, status = 400) {
    super(message);
    this.name = "OAuthError";
    this.code = code;
    this.status = status;
  }
}

/* Each provider, described rather than special cased through the code. */
export const PROVIDERS = {
  google: {
    label: "Google",
    authorize: "https://accounts.google.com/o/oauth2/v2/auth",
    token: "https://oauth2.googleapis.com/token",
    userInfo: "https://openidconnect.googleapis.com/v1/userinfo",
    scope: "openid email profile",
    pkce: true,
    env: { id: "GOOGLE_OAUTH_CLIENT_ID", secret: "GOOGLE_OAUTH_CLIENT_SECRET" },
    /* Google's userinfo marks whether it has verified the address itself */
    profile: (u) => ({ uid: u.sub, email: u.email, emailVerified: u.email_verified === true, name: u.name || null, avatar: u.picture || null }),
  },
  apple: {
    label: "Apple",
    authorize: "https://appleid.apple.com/auth/authorize",
    token: "https://appleid.apple.com/auth/token",
    userInfo: null,                      // the identity token carries the claims
    scope: "name email",
    pkce: true,
    responseMode: "form_post",           // Apple requires this when asking for name or email
    env: { id: "APPLE_OAUTH_CLIENT_ID", secret: "APPLE_OAUTH_CLIENT_SECRET" },
    profile: (claims, extra = {}) => ({
      uid: claims.sub,
      email: claims.email || null,
      emailVerified: claims.email_verified === true || claims.email_verified === "true",
      /* Apple sends the name once, in the first callback body, and never again.
         If it is not captured here it is gone for good. */
      name: extra.name || null,
      avatar: null,
      isPrivateRelay: typeof claims.email === "string" && claims.email.endsWith("@privaterelay.appleid.com"),
    }),
  },
};

/** Which providers are actually usable, so no dead button is ever shown. */
export function configuredProviders(env = process.env) {
  return Object.keys(PROVIDERS).filter((k) => {
    const { id, secret } = PROVIDERS[k].env;
    return !!(env[id] && env[secret]);
  });
}

const b64url = (buf) => Buffer.from(buf).toString("base64url");

/** PKCE: a verifier the browser never sees, and its hash sent up front. */
export function newPkce(randomBytes = crypto.randomBytes) {
  const verifier = b64url(randomBytes(32));
  const challenge = b64url(crypto.createHash("sha256").update(verifier).digest());
  return { verifier, challenge, method: "S256" };
}

/**
 * Step one: where to send the user.
 * The caller persists `state` and `verifier`; neither is trusted from the
 * browser on the way back.
 */
export function buildAuthorizeUrl(provider, { redirectUri, env = process.env, randomBytes = crypto.randomBytes, prompt } = {}) {
  const p = PROVIDERS[provider];
  if (!p) throw new OAuthError("unknown_provider", "That sign in method is not supported.");
  const clientId = env[p.env.id];
  if (!clientId || !env[p.env.secret]) {
    throw new OAuthError("not_configured", `${p.label} sign in is not configured.`, 503);
  }
  if (!redirectUri) throw new OAuthError("config", "A redirect URI is required.");

  const state = b64url(randomBytes(24));
  const pkce = p.pkce ? newPkce(randomBytes) : null;
  const params = new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirectUri,
    response_type: "code",
    scope: p.scope,
    state,
  });
  if (pkce) { params.set("code_challenge", pkce.challenge); params.set("code_challenge_method", pkce.method); }
  if (p.responseMode) params.set("response_mode", p.responseMode);
  if (prompt) params.set("prompt", prompt);
  if (provider === "google") params.set("access_type", "offline");

  return {
    authorization_url: `${p.authorize}?${params.toString()}`,
    provider,
    state,
    verifier: pkce ? pkce.verifier : null,
  };
}

/** Reads an Apple identity token's claims. Signature verification is separate. */
export function decodeIdToken(idToken) {
  const parts = String(idToken || "").split(".");
  if (parts.length !== 3) throw new OAuthError("bad_token", "That sign in response was not usable.");
  try { return JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8")); }
  catch { throw new OAuthError("bad_token", "That sign in response was not usable."); }
}

/**
 * Step two: turn the code into a profile.
 *
 * `stored` is what we saved when we sent the user away. If the state does not
 * match, this is not our sign in and it stops here.
 */
export async function exchangeCode(provider, { code, state, stored, redirectUri, env = process.env, fetchImpl = fetch, now = Date.now } = {}) {
  const p = PROVIDERS[provider];
  if (!p) throw new OAuthError("unknown_provider", "That sign in method is not supported.");
  if (!stored) throw new OAuthError("bad_state", "That sign in link is no longer valid. Start again.");
  if (stored.consumedAt) throw new OAuthError("used_state", "That sign in link has already been used.");
  if (new Date(stored.expiresAt).getTime() <= now()) throw new OAuthError("expired_state", "That sign in attempt timed out. Try again.");
  /* compared in constant time: the state is a secret for the length of the round trip */
  const a = Buffer.from(String(state || "")), b = Buffer.from(String(stored.state));
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
    throw new OAuthError("bad_state", "That sign in did not match the request that started it.");
  }
  if (stored.provider !== provider) throw new OAuthError("bad_state", "That sign in was started for a different provider.");

  const body = new URLSearchParams({
    grant_type: "authorization_code",
    code: String(code || ""),
    redirect_uri: redirectUri,
    client_id: env[p.env.id],
    client_secret: env[p.env.secret],
  });
  if (stored.verifier) body.set("code_verifier", stored.verifier);

  const res = await fetchImpl(p.token, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
    body: body.toString(),
  });
  const tok = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new OAuthError("exchange_failed", tok.error_description || tok.error || `${p.label} rejected the sign in.`, 502);
  }

  let profile;
  if (p.userInfo) {
    const ures = await fetchImpl(p.userInfo, { headers: { authorization: `Bearer ${tok.access_token}` } });
    const u = await ures.json().catch(() => ({}));
    if (!ures.ok) throw new OAuthError("profile_failed", `Could not read your ${p.label} profile.`, 502);
    profile = p.profile(u);
  } else {
    profile = p.profile(decodeIdToken(tok.id_token), { name: stored.appleName || null });
  }

  if (!profile.uid) throw new OAuthError("no_identity", `${p.label} did not return an account id.`, 502);
  return { profile, tokens: { access: tok.access_token || null, refresh: tok.refresh_token || null } };
}

/**
 * What to do with the profile.
 *
 * This is the decision that account takeovers hinge on, so it is a pure
 * function and is tested directly.
 */
export function resolveIdentity({ provider, profile, existingIdentity, existingUserByEmail }) {
  /* already linked: sign that user in, whatever the email now says */
  if (existingIdentity) {
    return { action: "login", userId: existingIdentity.userId, reason: "this social account is already linked" };
  }
  /* no account with that address: make one */
  if (!existingUserByEmail) {
    if (!profile.email) {
      return { action: "needs_email",
        reason: `${PROVIDERS[provider].label} did not share an email address, so an account cannot be created automatically.` };
    }
    return { action: "create", email: profile.email, name: profile.name,
      emailVerified: profile.emailVerified === true };
  }
  /* an account exists with this address. Linking it is only safe when the
     provider has verified the address; otherwise anyone who signs up at that
     provider using your address inherits your workspace. */
  if (profile.emailVerified !== true) {
    return { action: "verify_first", userId: existingUserByEmail.id,
      reason: `${PROVIDERS[provider].label} has not verified that address. Sign in with your password first, then link ${PROVIDERS[provider].label} from settings.` };
  }
  return { action: "link", userId: existingUserByEmail.id, reason: "the address is verified by the provider" };
}
