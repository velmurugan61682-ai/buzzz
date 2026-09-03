import assert from "node:assert";
import linkedinRouter, { encryptToken, decryptToken, tokenStore, stateStore } from "./linkedin.js";

console.log("Testing LinkedIn route and encryption logic...");

// 1. Test token encryption and decryption at rest
const testToken = "AQV9...sample-linkedin-access-token...xyz";
const sealed = encryptToken(testToken);
assert.notStrictEqual(sealed, testToken, "Token must be encrypted, not plaintext");
assert.strictEqual(sealed.split(".").length, 3, "Sealed token must be iv.tag.ciphertext format");

const unsealed = decryptToken(sealed);
assert.strictEqual(unsealed, testToken, "Decrypted token must match original plaintext");
console.log("✓ AES-256-GCM token encryption and decryption passed");

// 2. Test tampering detection
const parts = sealed.split(".");
parts[2] = Buffer.from("tampered_ciphertext").toString("base64");
assert.throws(() => {
  decryptToken(parts.join("."));
}, "Tampered token must throw an error");
console.log("✓ Encryption tampering detection passed");

// 3. Verify router structure
assert.ok(linkedinRouter && typeof linkedinRouter === "function", "LinkedIn router should be an Express Router function");
const routePaths = linkedinRouter.stack.map(layer => layer.route ? `${Object.keys(layer.route.methods)[0].toUpperCase()} ${layer.route.path}` : null).filter(Boolean);
console.log("Registered routes:", routePaths);

assert.ok(routePaths.includes("GET /auth"), "Must have GET /auth route");
assert.ok(routePaths.includes("GET /callback"), "Must have GET /callback route");
assert.ok(routePaths.includes("POST /post"), "Must have POST /post route");
console.log("✓ All requested endpoints (/auth, /callback, /post) are registered");

console.log("\nAll LinkedIn integration checks passed successfully!");
