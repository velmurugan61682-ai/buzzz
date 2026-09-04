/**
 * Multi-Tenant LinkedIn Integration Client.
 *
 * Handles OAuth 2.0 authorization URL generation, code exchange, profile
 * resolution, and UGC post publishing via LinkedIn REST API.
 */

import { openCredential } from "./credential-store.js";

export class LinkedInError extends Error {
  constructor(code, message, status = 400) {
    super(message);
    this.name = "LinkedInError";
    this.code = code;
    this.status = status;
  }
}

export function getLinkedInAuthUrl({ clientId, redirectUri, state }) {
  if (!clientId || !redirectUri || !state) {
    throw new LinkedInError("invalid_input", "clientId, redirectUri, and state are required", 400);
  }
  const scopes = encodeURIComponent("openid profile email w_member_social");
  return `https://www.linkedin.com/oauth/v2/authorization?response_type=code&client_id=${encodeURIComponent(clientId)}&redirect_uri=${encodeURIComponent(redirectUri)}&state=${encodeURIComponent(state)}&scope=${scopes}`;
}

export async function exchangeLinkedInCode({
  code,
  clientId,
  clientSecret,
  redirectUri,
  fetchFn = globalThis.fetch,
}) {
  if (!code || !clientId || !clientSecret || !redirectUri) {
    throw new LinkedInError("invalid_input", "Missing required OAuth exchange parameter", 400);
  }

  const res = await fetchFn("https://www.linkedin.com/oauth/v2/accessToken", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      code: String(code),
      client_id: clientId,
      client_secret: clientSecret,
      redirect_uri: redirectUri,
    }).toString(),
  });

  const data = await res.json().catch(() => ({}));
  if (!res.ok || !data.access_token) {
    throw new LinkedInError(
      "oauth_exchange_failed",
      data.error_description || "Failed to exchange authorization code for access token.",
      res.status || 400,
    );
  }

  const accessToken = data.access_token;
  const expiresIn = data.expires_in || 5184000;
  const expiresAt = Date.now() + expiresIn * 1000;

  // Resolve user info (Person URN)
  let personUrn = null;
  try {
    const userinfoRes = await fetchFn("https://api.linkedin.com/v2/userinfo", {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    if (userinfoRes.ok) {
      const userInfo = await userinfoRes.json();
      if (userInfo.sub) {
        personUrn = `urn:li:person:${userInfo.sub}`;
      }
    }
  } catch {
    // Non-blocking fallback
  }

  return {
    accessToken,
    expiresIn,
    expiresAt,
    personUrn,
  };
}

export async function publishLinkedInPost({
  text,
  accessToken,
  personUrn,
  fetchFn = globalThis.fetch,
}) {
  if (!text || !text.trim()) {
    throw new LinkedInError("invalid_input", "Text body is required to publish a LinkedIn post", 400);
  }
  if (!accessToken) {
    throw new LinkedInError("auth_error", "LinkedIn access token is required", 401);
  }

  let authorUrn = personUrn;
  if (!authorUrn) {
    try {
      const userinfoRes = await fetchFn("https://api.linkedin.com/v2/userinfo", {
        headers: { Authorization: `Bearer ${accessToken}` },
      });
      if (userinfoRes.ok) {
        const userInfo = await userinfoRes.json();
        if (userInfo.sub) {
          authorUrn = `urn:li:person:${userInfo.sub}`;
        }
      }
    } catch {
      // Fallback
    }
  }

  if (!authorUrn) {
    throw new LinkedInError("profile_fetch_failed", "Unable to determine LinkedIn member identity for posting.", 500);
  }

  const ugcPayload = {
    author: authorUrn,
    lifecycleState: "PUBLISHED",
    specificContent: {
      "com.linkedin.ugc.ShareContent": {
        shareCommentary: { text: text.trim() },
        shareMediaCategory: "NONE",
      },
    },
    visibility: {
      "com.linkedin.ugc.MemberNetworkVisibility": "PUBLIC",
    },
  };

  const res = await fetchFn("https://api.linkedin.com/v2/ugcPosts", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json",
      "X-Restli-Protocol-Version": "2.0.0",
    },
    body: JSON.stringify(ugcPayload),
  });

  const resBody = await res.json().catch(() => ({}));

  if (res.status === 401) {
    throw new LinkedInError("token_expired", "LinkedIn access token is invalid or expired. Re-connection required.", 401);
  }

  if (!res.ok) {
    throw new LinkedInError("post_failed", resBody.message || "Failed to publish post to LinkedIn.", res.status);
  }

  return {
    ok: true,
    postId: resBody.id || `urn:li:share:${Date.now()}`,
    status: "published",
  };
}

export async function sendLinkedInPostFromStore({ text }, { workspaceId, db, credentialKey, fetchFn }) {
  const integ = await db.getIntegration(workspaceId, "linkedin");
  if (!integ || !integ.credential_ref) {
    throw new LinkedInError("not_connected", "LinkedIn integration is not connected for this workspace.", 401);
  }

  const cfg = integ.config || {};
  if (cfg.expiresAt && Date.now() >= cfg.expiresAt) {
    throw new LinkedInError("token_expired", "LinkedIn access token has expired. Re-authentication required.", 401);
  }

  const accessToken = openCredential(integ.credential_ref, credentialKey);
  return publishLinkedInPost({
    text,
    accessToken,
    personUrn: cfg.personUrn,
    fetchFn,
  });
}
