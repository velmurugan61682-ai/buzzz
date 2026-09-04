/**
 * Multi-Tenant LinkedIn Integration Client Tests.
 */
import { strict as assert } from "node:assert";
import {
  getLinkedInAuthUrl,
  exchangeLinkedInCode,
  publishLinkedInPost,
  sendLinkedInPostFromStore,
  LinkedInError,
} from "./linkedin.js";
import { sealCredential } from "./credential-store.js";

let fails = 0;
const ok = (cond, msg) => {
  if (!cond) {
    console.error("  FAIL:", msg);
    fails++;
  }
};

const credKey = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
const wsId = "11111111-1111-1111-1111-111111111111";

async function runLinkedInTests() {
  console.log("=== Multi-Tenant LinkedIn Integration Test Suite ===");

  /* 1. Auth URL Generation */
  const authUrl = getLinkedInAuthUrl({
    clientId: "test_client_id",
    redirectUri: "http://localhost:4000/api/v1/integrations/linkedin/callback",
    state: "test_state_123",
  });
  ok(authUrl.includes("www.linkedin.com/oauth/v2/authorization"), "generates LinkedIn auth endpoint URL");
  ok(authUrl.includes("client_id=test_client_id"), "includes client_id in auth URL");
  ok(authUrl.includes("w_member_social"), "includes required w_member_social scope");

  /* 2. OAuth Code Exchange (Mock fetch) */
  const fakeTokenFetch = async (url) => {
    if (url.includes("accessToken")) {
      return {
        ok: true,
        json: async () => ({ access_token: "lk_access_token_xyz", expires_in: 5184000 }),
      };
    }
    if (url.includes("userinfo")) {
      return {
        ok: true,
        json: async () => ({ sub: "member_999", name: "Jane Doe" }),
      };
    }
    return { ok: false };
  };

  const exchangeRes = await exchangeLinkedInCode({
    code: "auth_code_123",
    clientId: "test_client_id",
    clientSecret: "test_client_secret",
    redirectUri: "http://localhost:4000/api/v1/integrations/linkedin/callback",
    fetchFn: fakeTokenFetch,
  });

  ok(exchangeRes.accessToken === "lk_access_token_xyz", "exchanges code for access_token");
  ok(exchangeRes.personUrn === "urn:li:person:member_999", "resolves Person URN from userinfo");

  /* 3. Publish LinkedIn Post (Mock fetch) */
  let postUrl = "";
  let postBody = null;
  let postHeaders = null;

  const fakePostFetch = async (url, opts) => {
    postUrl = url;
    postBody = JSON.parse(opts.body);
    postHeaders = opts.headers;
    return {
      ok: true,
      status: 201,
      json: async () => ({ id: "urn:li:share:123456789" }),
    };
  };

  const postRes = await publishLinkedInPost({
    text: "Building an agentic communication hub on BUZZZ!",
    accessToken: "lk_access_token_xyz",
    personUrn: "urn:li:person:member_999",
    fetchFn: fakePostFetch,
  });

  ok(postRes.ok === true, "publishes post successfully");
  ok(postRes.postId === "urn:li:share:123456789", "returns post ID from LinkedIn");
  ok(postUrl === "https://api.linkedin.com/v2/ugcPosts", "hits ugcPosts endpoint");
  ok(postHeaders["Authorization"] === "Bearer lk_access_token_xyz", "passes Authorization header");
  ok(postBody.author === "urn:li:person:member_999", "sets author Person URN");

  /* 4. Store Wrapper & Expired Token handling */
  const sealedToken = sealCredential("lk_access_token_xyz", credKey);
  const mockDbExpired = {
    async getIntegration(workspaceId, provider) {
      if (provider === "linkedin") {
        return {
          id: "integ_lk_1",
          credential_ref: sealedToken,
          config: { expiresAt: Date.now() - 1000, personUrn: "urn:li:person:member_999" },
        };
      }
      return null;
    },
  };

  let caughtExpiredErr = false;
  try {
    await sendLinkedInPostFromStore(
      { text: "Test post" },
      { workspaceId: wsId, db: mockDbExpired, credentialKey: credKey, fetchFn: fakePostFetch },
    );
  } catch (e) {
    if (e instanceof LinkedInError && e.code === "token_expired") {
      caughtExpiredErr = true;
    }
  }

  ok(caughtExpiredErr, "throws token_expired LinkedInError when token has passed expiration time");

  console.log(fails ? `linkedin client: ${fails} FAILED` : "linkedin client: all checks passed");
  process.exit(fails ? 1 : 0);
}

runLinkedInTests().catch((err) => {
  console.error("linkedin test suite FAILED:", err);
  process.exit(1);
});
