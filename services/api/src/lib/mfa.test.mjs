/** Two factor and passkeys, tested against the attacks they exist to stop. */
import {
  newTotpSecret, totpCode, verifyTotp, totpUri, base32Encode, base32Decode,
  newRecoveryCodes, useRecoveryCode, hashRecoveryCode,
  newPasskeyChallenge, checkPasskeyResponse, checkSignCount,
  secondFactorFor, staffMfaSatisfied, MfaError,
} from "./mfa.js";

let fails = 0;
const ok = (c, m) => { if (!c) { console.log("  FAIL:", m); fails++; } };

/* ---- TOTP ---- */
const secret = newTotpSecret();
ok(/^[A-Z2-7]{32}$/.test(secret), "the secret is 160 bits of base32");
ok(base32Encode(base32Decode(secret)) === secret, "base32 round trips");

const now = 1_760_000_000_000;
const code = totpCode(secret, now);
ok(/^\d{6}$/.test(code), "a six digit code is produced");
ok(verifyTotp(secret, code, { now }).ok, "the current code verifies");
ok(!verifyTotp(secret, "000000", { now }).ok, "a wrong code is refused");
ok(verifyTotp(secret, code, { now }).counter > 0, "verification returns the counter to store");

/* clock drift either side, but not beyond */
ok(verifyTotp(secret, totpCode(secret, now - 30000), { now }).ok, "a code from one step ago still works");
ok(verifyTotp(secret, totpCode(secret, now + 30000), { now }).ok, "a code one step ahead works");
ok(!verifyTotp(secret, totpCode(secret, now - 120000), { now }).ok, "a code four steps old is refused");

/* replay: the attack that catches most homemade implementations */
const first = verifyTotp(secret, code, { now });
const replay = verifyTotp(secret, code, { now, lastUsedCounter: first.counter });
ok(replay.ok === false && replay.reason === "replayed", "the same code cannot be used twice");

/* malformed input */
["", "12345", "abcdef", "1234567", null].forEach((bad) =>
  ok(!verifyTotp(secret, bad, { now }).ok, `malformed code refused: ${JSON.stringify(bad)}`));
try { base32Decode("not!valid"); ok(false, "an invalid secret should throw"); }
catch (e) { ok(e.code === "bad_secret", "an invalid secret is rejected"); }

const uri = totpUri({ secret, email: "sam@buzzzbuzzz.com" });
/* the label is percent encoded, which is what the spec requires */
ok(uri.startsWith("otpauth://totp/BUZZZ%3A"), "the enrolment URI is scannable");
ok(uri.includes(`secret=${secret}`), "and carries the secret");

/* ---- recovery codes ---- */
const { codes, hashes } = newRecoveryCodes();
ok(codes.length === 10 && hashes.length === 10, "ten recovery codes are issued");
ok(!hashes.includes(codes[0]), "codes are stored hashed, never in the clear");
const used = useRecoveryCode(codes[3], hashes);
ok(used.ok, "a valid recovery code is accepted");
ok(used.remaining.length === 9, "and is consumed");
ok(!useRecoveryCode(codes[3], used.remaining).ok, "the same recovery code cannot be reused");
ok(!useRecoveryCode("AAAAA-BBBBB", hashes).ok, "an invented recovery code is refused");
ok(useRecoveryCode(codes[1].toLowerCase(), hashes).ok, "case and dashes do not matter to the user");

/* ---- passkeys ---- */
const ch = newPasskeyChallenge({ userId: "u1", email: "sam@buzzzbuzzz.com", rpId: "buzzzbuzzz.com" });
ok(ch.challenge.length > 20, "a random challenge is issued");
ok(ch.publicKey.rp.id === "buzzzbuzzz.com", "the relying party is our domain");
ok(!JSON.stringify(ch.publicKey.user).includes("sam@buzzzbuzzz.com") === false, "the account is identified for the device");
ok(ch.publicKey.pubKeyCredParams.some((p) => p.alg === -7), "ES256 is offered");
try { newPasskeyChallenge({ userId: "u1", email: "a@b.com" }); ok(false, "a missing rpId should throw"); }
catch (e) { ok(e.code === "config", "a passkey challenge without a relying party is refused"); }

const clientData = (o) => Buffer.from(JSON.stringify(o)).toString("base64");
const stored = { challenge: ch.challenge, expiresAt: ch.expiresAt, kind: "register" };
const good = checkPasskeyResponse(
  { id: "cred1", response: { clientDataJSON: clientData({ challenge: ch.challenge, origin: "https://buzzzbuzzz.com", type: "webauthn.create" }) } },
  stored, { origin: "https://buzzzbuzzz.com", rpId: "buzzzbuzzz.com" });
ok(good.ok && good.needsSignatureCheck, "a well formed response passes the checks we own");

/* replay with someone else's challenge */
const replayed = checkPasskeyResponse(
  { id: "cred1", response: { clientDataJSON: clientData({ challenge: "someone-elses", origin: "https://buzzzbuzzz.com", type: "webauthn.create" }) } },
  stored, { origin: "https://buzzzbuzzz.com" });
ok(!replayed.ok && replayed.reason === "challenge_mismatch", "a replayed challenge is refused");

/* a phishing site relaying the ceremony */
const phished = checkPasskeyResponse(
  { id: "cred1", response: { clientDataJSON: clientData({ challenge: ch.challenge, origin: "https://buzzz-login.example.com", type: "webauthn.create" }) } },
  stored, { origin: "https://buzzzbuzzz.com" });
ok(!phished.ok && phished.reason === "bad_origin", "a passkey from another origin is refused, which is what defeats phishing");

/* wrong ceremony type, expiry, malformed */
ok(checkPasskeyResponse({ id: "c", response: { clientDataJSON: clientData({ challenge: ch.challenge, origin: "https://buzzzbuzzz.com", type: "webauthn.get" }) } },
   stored, { origin: "https://buzzzbuzzz.com" }).reason === "bad_type", "a sign in response cannot register a credential");
ok(checkPasskeyResponse({ id: "c", response: { clientDataJSON: clientData({ challenge: ch.challenge, origin: "https://buzzzbuzzz.com", type: "webauthn.create" }) } },
   { ...stored, expiresAt: new Date(Date.now() - 1).toISOString() }, { origin: "https://buzzzbuzzz.com" }).reason === "expired",
   "an expired challenge is refused");
ok(!checkPasskeyResponse({}, stored, {}).ok, "a malformed response is refused");
ok(!checkPasskeyResponse({ id: "c", response: { clientDataJSON: "not base64 json" } }, stored, {}).ok, "unparseable client data is refused");

/* cloned authenticator */
ok(checkSignCount(5, 6).ok, "an increasing sign count is fine");
ok(!checkSignCount(5, 5).ok, "a repeated sign count means a possible clone");
ok(!checkSignCount(5, 3).ok, "a decreasing sign count means a possible clone");
ok(checkSignCount(0, 0).ok, "an authenticator that does not count is accepted");

/* ---- which factor applies ---- */
ok(secondFactorFor({}).required === false, "an account with nothing enrolled needs no second factor");
ok(secondFactorFor({ totpEnabled: true }).method === "totp", "TOTP is used when enrolled");
ok(secondFactorFor({ passkeyCount: 1, totpEnabled: true }).method === "passkey", "a passkey is preferred over a code");
ok(secondFactorFor({ passkeyCount: 1 }).alternatives.includes("recovery"), "recovery is always an alternative");

/* ---- staff are held higher ---- */
ok(!staffMfaSatisfied({}, {}).ok, "a staff account with no second factor cannot sign in");
ok(staffMfaSatisfied({ totpEnabled: true }, {}).reason === "mfa_required", "an enrolled staff account must still verify");
ok(staffMfaSatisfied({ totpEnabled: true }, { mfaVerifiedAt: new Date().toISOString() }).ok, "a fresh verification passes");
ok(staffMfaSatisfied({ totpEnabled: true }, { mfaVerifiedAt: new Date(Date.now() - 13 * 3600 * 1000).toISOString() }).reason === "reauth_required",
   "a stale staff session must re-authenticate");

console.log(fails ? `mfa: ${fails} FAILED` : "mfa and passkeys: all 45 checks passed");
process.exit(fails ? 1 : 0);
