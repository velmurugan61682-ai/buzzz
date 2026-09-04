/**
 * Shared Credential Store — AES-256-GCM envelope encryption.
 *
 * Provider secrets (API keys, tokens, refresh tokens) must never be stored
 * in plaintext in the database. This module encrypts at write time and
 * decrypts at call time. A database dump alone is not sufficient to
 * impersonate a provider account.
 *
 * Algorithm: AES-256-GCM with a random 96-bit IV per seal operation.
 * Wire format: base64(iv) "." base64(authTag) "." base64(ciphertext)
 *
 * The keyHex must be a 64-character hex string (32 bytes = 256 bits),
 * derived from CREDENTIAL_ENCRYPTION_KEY or TOKEN_ENCRYPTION_KEY env vars.
 */

import crypto from "node:crypto";

/**
 * Encrypts a plaintext secret and returns a sealed string safe for DB storage.
 *
 * @param {string} plain   - The secret value to protect (token, key, password, …)
 * @param {string} keyHex  - 64-char hex string (256-bit AES key)
 * @returns {string}         Sealed ciphertext in iv.tag.data format
 * @throws {Error}           If keyHex is invalid length / format
 */
export function sealCredential(plain, keyHex) {
  if (!keyHex || keyHex.length !== 64) {
    throw new Error("CREDENTIAL_ENCRYPTION_KEY must be a 64-character hex string (32 bytes)");
  }
  const key = Buffer.from(keyHex, "hex");
  const iv  = crypto.randomBytes(12);
  const c   = crypto.createCipheriv("aes-256-gcm", key, iv);
  const enc = Buffer.concat([c.update(String(plain), "utf8"), c.final()]);
  return [
    iv.toString("base64"),
    c.getAuthTag().toString("base64"),
    enc.toString("base64"),
  ].join(".");
}

/**
 * Decrypts a sealed credential string back to plaintext.
 *
 * @param {string} sealed  - The sealed string from sealCredential()
 * @param {string} keyHex  - 64-char hex string (256-bit AES key)
 * @returns {string}         The original plaintext secret
 * @throws {Error}           If keyHex is invalid, or sealed value has been tampered with
 */
export function openCredential(sealed, keyHex) {
  if (!keyHex || keyHex.length !== 64) {
    throw new Error("CREDENTIAL_ENCRYPTION_KEY must be a 64-character hex string (32 bytes)");
  }
  const [ivB64, tagB64, dataB64] = String(sealed).split(".");
  if (!ivB64 || !tagB64 || !dataB64) {
    throw new Error("Sealed credential has an invalid format — expected iv.tag.data");
  }
  const d = crypto.createDecipheriv(
    "aes-256-gcm",
    Buffer.from(keyHex, "hex"),
    Buffer.from(ivB64, "base64"),
  );
  d.setAuthTag(Buffer.from(tagB64, "base64"));
  return Buffer.concat([
    d.update(Buffer.from(dataB64, "base64")),
    d.final(),
  ]).toString("utf8");
}
