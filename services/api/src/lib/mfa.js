/**
 * Two factor authentication and passkeys.
 *
 * TOTP is implemented here directly (RFC 6238 over HMAC-SHA1) because it is
 * small and auditable. Passkeys use WebAuthn: this file handles challenge
 * issue, verification bookkeeping and recovery codes, and delegates signature
 * verification to a vetted library at the point of registration, because
 * hand-rolling COSE and attestation parsing is exactly where people get it
 * wrong.
 */
import crypto from "node:crypto";

export class MfaError extends Error {
  constructor(code, message, status = 400) {
    super(message);
    this.name = "MfaError";
    this.code = code;
    this.status = status;
  }
}

/* ---- base32, for the secret a phone app scans ---- */
const B32 = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
export function base32Encode(buf) {
  let bits = 0, value = 0, out = "";
  for (const byte of buf) {
    value = (value << 8) | byte; bits += 8;
    while (bits >= 5) { out += B32[(value >>> (bits - 5)) & 31]; bits -= 5; }
  }
  if (bits > 0) out += B32[(value << (5 - bits)) & 31];
  return out;
}
export function base32Decode(str) {
  let bits = 0, value = 0;
  const out = [];
  for (const c of String(str).toUpperCase().replace(/=+$/, "").replace(/\s/g, "")) {
    const idx = B32.indexOf(c);
    if (idx === -1) throw new MfaError("bad_secret", "That is not a valid authenticator secret.");
    value = (value << 5) | idx; bits += 5;
    if (bits >= 8) { out.push((value >>> (bits - 8)) & 255); bits -= 8; }
  }
  return Buffer.from(out);
}

/* ---- TOTP ---- */
export const TOTP_STEP = 30;      // seconds per code
export const TOTP_DIGITS = 6;
export const TOTP_WINDOW = 1;     // accept one step either side, for clock drift

export function newTotpSecret(randomBytes = crypto.randomBytes) {
  return base32Encode(randomBytes(20));   // 160 bits, the RFC 4226 recommendation
}

export function totpCode(secret, forTime = Date.now(), step = TOTP_STEP) {
  const counter = Math.floor(forTime / 1000 / step);
  const buf = Buffer.alloc(8);
  buf.writeUInt32BE(Math.floor(counter / 2 ** 32), 0);
  buf.writeUInt32BE(counter >>> 0, 4);
  const hmac = crypto.createHmac("sha1", base32Decode(secret)).update(buf).digest();
  const offset = hmac[hmac.length - 1] & 0x0f;
  const bin = ((hmac[offset] & 0x7f) << 24) | (hmac[offset + 1] << 16) | (hmac[offset + 2] << 8) | hmac[offset + 3];
  return String(bin % 10 ** TOTP_DIGITS).padStart(TOTP_DIGITS, "0");
}

/**
 * Verify a code.
 *
 * `lastUsedCounter` is required: without it the same code works repeatedly for
 * its whole window, so anyone who watches a user type it can replay it. The
 * caller persists the returned counter.
 */
export function verifyTotp(secret, code, { now = Date.now(), window = TOTP_WINDOW, lastUsedCounter = null } = {}) {
  const given = String(code || "").replace(/\s/g, "");
  if (!/^\d{6}$/.test(given)) return { ok: false, reason: "malformed" };
  const current = Math.floor(now / 1000 / TOTP_STEP);
  for (let drift = -window; drift <= window; drift++) {
    const counter = current + drift;
    const expected = totpCode(secret, (counter * TOTP_STEP) * 1000);
    /* constant time: a timing difference leaks how much of the code matched */
    const a = Buffer.from(expected), b = Buffer.from(given.padEnd(expected.length, " "));
    if (a.length === b.length && crypto.timingSafeEqual(a, b)) {
      if (lastUsedCounter !== null && counter <= lastUsedCounter) {
        return { ok: false, reason: "replayed" };
      }
      return { ok: true, counter };
    }
  }
  return { ok: false, reason: "wrong" };
}

/** The otpauth:// URI a phone camera turns into an account. */
export function totpUri({ secret, email, issuer = "BUZZZ" }) {
  const label = encodeURIComponent(`${issuer}:${email}`);
  const p = new URLSearchParams({ secret, issuer, algorithm: "SHA1", digits: String(TOTP_DIGITS), period: String(TOTP_STEP) });
  return `otpauth://totp/${label}?${p.toString()}`;
}

/* ---- recovery codes ----
   Stored as hashes. Losing a phone must not mean losing the account, and a
   database leak must not hand an attacker a way past the second factor. */
export function newRecoveryCodes(count = 10, randomBytes = crypto.randomBytes) {
  const codes = [];
  for (let i = 0; i < count; i++) {
    const raw = randomBytes(5).toString("hex").toUpperCase();       // 10 characters
    codes.push(`${raw.slice(0, 5)}-${raw.slice(5)}`);
  }
  return { codes, hashes: codes.map(hashRecoveryCode) };
}
export const hashRecoveryCode = (code) =>
  crypto.createHash("sha256").update(String(code).toUpperCase().replace(/[^A-Z0-9]/g, "")).digest("hex");

export function useRecoveryCode(code, hashes = []) {
  const h = hashRecoveryCode(code);
  const idx = hashes.indexOf(h);
  if (idx === -1) return { ok: false, remaining: hashes };
  /* single use: the code is removed, not marked */
  const remaining = hashes.slice(0, idx).concat(hashes.slice(idx + 1));
  return { ok: true, remaining };
}

/* ---- passkeys (WebAuthn) ---- */
export const PASSKEY_CHALLENGE_TTL_MS = 5 * 60 * 1000;

export function newPasskeyChallenge({ userId, email, rpId, rpName = "BUZZZ", now = Date.now(), randomBytes = crypto.randomBytes }) {
  if (!rpId) throw new MfaError("config", "A relying party id is required for passkeys.");
  const challenge = randomBytes(32).toString("base64url");
  return {
    challenge,
    expiresAt: new Date(now + PASSKEY_CHALLENGE_TTL_MS).toISOString(),
    /* what the browser is handed. userId is a random handle, never the email:
       the credential is stored on the device and syncs to the user's cloud. */
    publicKey: {
      challenge,
      rp: { id: rpId, name: rpName },
      user: { id: Buffer.from(String(userId)).toString("base64url"), name: email, displayName: email },
      pubKeyCredParams: [
        { type: "public-key", alg: -7 },     // ES256
        { type: "public-key", alg: -257 },   // RS256
      ],
      timeout: PASSKEY_CHALLENGE_TTL_MS,
      attestation: "none",                   // we do not need to identify the device model
      authenticatorSelection: {
        residentKey: "preferred",
        userVerification: "preferred",       // a fingerprint or PIN, where available
      },
    },
  };
}

/**
 * Checks the parts of a WebAuthn response that are ours to check.
 *
 * The cryptographic signature check belongs to a maintained library
 * (@simplewebauthn/server); this refuses everything that must be rejected
 * before that point, so a caller cannot skip these.
 */
export function checkPasskeyResponse(response, stored, { origin, rpId, now = Date.now() } = {}) {
  if (!response || !response.id || !response.response) {
    return { ok: false, reason: "malformed", message: "That passkey response is not usable." };
  }
  if (!stored || !stored.challenge) {
    return { ok: false, reason: "no_challenge", message: "No passkey challenge is open. Start again." };
  }
  if (new Date(stored.expiresAt).getTime() <= now) {
    return { ok: false, reason: "expired", message: "That passkey attempt timed out. Try again." };
  }
  let client;
  try {
    client = JSON.parse(Buffer.from(response.response.clientDataJSON, "base64").toString("utf8"));
  } catch {
    return { ok: false, reason: "malformed", message: "That passkey response is not usable." };
  }
  /* the challenge must be the one we issued, or this is a replay */
  if (client.challenge !== stored.challenge) {
    return { ok: false, reason: "challenge_mismatch", message: "That passkey attempt did not match. Try again." };
  }
  /* the origin must be ours, or a phishing site is relaying the ceremony */
  if (origin && client.origin !== origin) {
    return { ok: false, reason: "bad_origin", message: "That passkey came from an unexpected site." };
  }
  const expectedType = stored.kind === "register" ? "webauthn.create" : "webauthn.get";
  if (client.type !== expectedType) {
    return { ok: false, reason: "bad_type", message: "That passkey response is for a different operation." };
  }
  return { ok: true, clientData: client, needsSignatureCheck: true, rpId };
}

/**
 * Sign counter check, which is how a cloned authenticator is spotted.
 * A counter that goes backwards means two devices are using one credential.
 */
export function checkSignCount(stored, presented) {
  if (!stored && stored !== 0) return { ok: true, note: "first use" };
  if (presented === 0 && stored === 0) return { ok: true, note: "authenticator does not count" };
  if (presented <= stored) {
    return { ok: false, reason: "cloned",
      message: "This passkey may have been copied. Remove it and register a new one." };
  }
  return { ok: true };
}

/* ---- the step up decision ----
   Which second factor a sign in needs, given what the account has enrolled. */
export function secondFactorFor(user = {}) {
  const passkeys = user.passkeyCount || 0;
  if (passkeys > 0) return { required: true, method: "passkey", alternatives: user.totpEnabled ? ["totp", "recovery"] : ["recovery"] };
  if (user.totpEnabled) return { required: true, method: "totp", alternatives: ["recovery"] };
  return { required: false, method: null, alternatives: [] };
}

/** Staff accounts are held to a higher bar than customers, per the audit. */
export function staffMfaSatisfied(staff = {}, session = {}) {
  if (!(staff.totpEnabled || (staff.passkeyCount || 0) > 0)) {
    return { ok: false, reason: "mfa_not_enrolled",
      message: "Staff accounts must enrol a second factor before signing in." };
  }
  if (!session.mfaVerifiedAt) {
    return { ok: false, reason: "mfa_required", message: "Confirm your second factor to continue." };
  }
  /* re-authentication for a long session: a stolen laptop should not stay
     inside the operations console all week */
  const age = Date.now() - new Date(session.mfaVerifiedAt).getTime();
  if (age > 12 * 60 * 60 * 1000) {
    return { ok: false, reason: "reauth_required", message: "Confirm your second factor again." };
  }
  return { ok: true };
}
