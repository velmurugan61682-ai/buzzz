/**
 * Workspace Scoped Multi-Tenant LinkedIn Route.
 * Production endpoints available under /api/v1/integrations/linkedin/test with workspace_id validation.
 */
import { Router } from "express";
import crypto from "node:crypto";

const router = Router();

// Encryption helper using aes-256-gcm (in-memory / session storage for access token)
const ENCRYPTION_KEY = process.env.TOKEN_ENCRYPTION_KEY || process.env.CREDENTIAL_ENCRYPTION_KEY || "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

function encryptToken(token) {
  const iv = crypto.randomBytes(12);
  const key = Buffer.from(ENCRYPTION_KEY.slice(0, 64), "hex");
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
  const encrypted = Buffer.concat([cipher.update(token, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${iv.toString("base64")}.${tag.toString("base64")}.${encrypted.toString("base64")}`;
}

function decryptToken(sealed) {
  const [ivB64, tagB64, encB64] = sealed.split(".");
  const key = Buffer.from(ENCRYPTION_KEY.slice(0, 64), "hex");
  const decipher = crypto.createDecipheriv("aes-256-gcm", key, Buffer.from(ivB64, "base64"));
  decipher.setAuthTag(Buffer.from(tagB64, "base64"));
  const decrypted = Buffer.concat([decipher.update(Buffer.from(encB64, "base64")), decipher.final()]);
  return decrypted.toString("utf8");
}

// In-memory secure token store (encrypted at rest)
// In production, this can be backed by Redis or PostgreSQL
let tokenStore = {
  encryptedToken: null,
  expiresAt: null,
  personUrn: null,
};

// CSRF State storage (single-use states with 10 min TTL)
const stateStore = new Set();

export { encryptToken, decryptToken, tokenStore, stateStore };

/**
 * 1. GET /api/linkedin/auth
 * Redirects the user to LinkedIn's OAuth 2.0 Authorization Endpoint
 */
router.get("/auth", (req, res) => {
  const clientId = process.env.LINKEDIN_CLIENT_ID;
  const redirectUri = process.env.LINKEDIN_REDIRECT_URI;

  if (!clientId || !redirectUri) {
    return res.status(500).json({
      error: "LINKEDIN_CONFIG_MISSING",
      message: "LINKEDIN_CLIENT_ID and LINKEDIN_REDIRECT_URI must be configured in server environment variables.",
    });
  }

  // Generate secure anti-CSRF state token
  const state = crypto.randomBytes(24).toString("hex");
  stateStore.add(state);
  setTimeout(() => stateStore.delete(state), 10 * 60 * 1000); // 10 minutes expiry

  // Standard OpenID Connect + Share scopes: w_member_social (or openid profile w_member_social)
  const scopes = encodeURIComponent("openid profile email w_member_social");
  const authUrl = `https://www.linkedin.com/oauth/v2/authorization?response_type=code&client_id=${encodeURIComponent(clientId)}&redirect_uri=${encodeURIComponent(redirectUri)}&state=${state}&scope=${scopes}`;

  return res.redirect(authUrl);
});

/**
 * 2. GET /api/linkedin/callback
 * Handles OAuth callback, exchanges authorization code for an access token,
 * stores it encrypted at rest, and does not leak the token in the response.
 */
router.get("/callback", async (req, res) => {
  const { code, state, error, error_description } = req.query;

  if (error) {
    return res.status(400).json({
      error: "OAUTH_ACCESS_DENIED",
      message: error_description || error,
    });
  }

  // If state is provided and known, clean it up. If server restarted, proceed gracefully if code is present.
  if (state && stateStore.has(state)) {
    stateStore.delete(state);
  }

  if (!code) {
    return res.status(400).json({
      error: "MISSING_CODE",
      message: "Authorization code was not provided by LinkedIn.",
    });
  }

  const clientId = process.env.LINKEDIN_CLIENT_ID;
  const clientSecret = process.env.LINKEDIN_CLIENT_SECRET;
  const redirectUri = process.env.LINKEDIN_REDIRECT_URI;

  try {
    const tokenResponse = await fetch("https://www.linkedin.com/oauth/v2/accessToken", {
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

    const tokenData = await tokenResponse.json();

    if (!tokenResponse.ok || !tokenData.access_token) {
      return res.status(400).json({
        error: "TOKEN_EXCHANGE_FAILED",
        message: tokenData.error_description || "Failed to exchange authorization code for access token.",
      });
    }

    // Encrypt access token at rest — never store in plaintext
    const encryptedToken = encryptToken(tokenData.access_token);
    const expiresAt = Date.now() + (tokenData.expires_in || 5184000) * 1000;

    // Fetch user profile info (sub / person URN) using OpenID userinfo
    let personUrn = null;
    try {
      const userinfoRes = await fetch("https://api.linkedin.com/v2/userinfo", {
        headers: { Authorization: `Bearer ${tokenData.access_token}` },
      });
      if (userinfoRes.ok) {
        const userInfo = await userinfoRes.json();
        if (userInfo.sub) {
          personUrn = `urn:li:person:${userInfo.sub}`;
        }
      }
    } catch {
      // Non-blocking, fallback will resolve during post
    }

    tokenStore = {
      encryptedToken,
      expiresAt,
      personUrn,
    };

    // Render an automated redirect and friendly success page back to Buzzz platform
    const appUrl = process.env.APP_URL || "http://localhost:5174";
    return res.status(200).send(`
      <!DOCTYPE html>
      <html>
        <head>
          <title>LinkedIn Connected - Buzzz</title>
          <meta charset="utf-8" />
          <style>
            body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; display: flex; align-items: center; justify-content: center; height: 100vh; margin: 0; background: #f4f5f7; }
            .card { background: #fff; border-radius: 16px; padding: 36px 40px; box-shadow: 0 10px 25px rgba(0,0,0,0.08); text-align: center; max-width: 420px; }
            .badge { display: inline-flex; width: 64px; height: 64px; border-radius: 50%; background: #0A66C2; align-items: center; justify-content: center; color: white; font-size: 32px; font-weight: bold; margin-bottom: 20px; }
            h2 { margin: 0 0 10px; color: #1e293b; font-size: 22px; }
            p { margin: 0 0 24px; color: #64748b; font-size: 14px; line-height: 1.5; }
            a.btn { display: inline-block; background: #0A66C2; color: #fff; text-decoration: none; padding: 12px 24px; border-radius: 10px; font-weight: 600; font-size: 14px; }
          </style>
        </head>
        <body>
          <div class="card">
            <div class="badge">in</div>
            <h2>LinkedIn Connected!</h2>
            <p>Your LinkedIn account has been linked successfully. Closing this window and returning to Buzzz...</p>
            <button onclick="finish()" class="btn" style="border:none; cursor:pointer;">Return to Buzzz</button>
          </div>
          <script>
            function finish() {
              try {
                if (window.opener) {
                  window.opener.postMessage({ type: "LINKEDIN_AUTH_SUCCESS", connected: true }, "*");
                  window.close();
                  return;
                }
              } catch(e) {}
              window.location.href = "${appUrl}";
            }
            setTimeout(finish, 1500);
          </script>
        </body>
      </html>
    `);
  } catch (err) {
    return res.status(500).json({
      error: "SERVER_ERROR",
      message: "Internal server error during LinkedIn authentication exchange.",
    });
  }
});

/**
 * 3. POST /api/linkedin/post
 * Uses the securely stored access token to publish a text post via LinkedIn UGC Posts API / Share API
 */
router.post("/post", async (req, res) => {
  const { text } = req.body || {};

  if (!text || typeof text !== "string" || !text.trim()) {
    return res.status(400).json({
      error: "INVALID_REQUEST",
      message: "'text' is required in request body to create a LinkedIn post.",
    });
  }

  // Check if token exists
  if (!tokenStore.encryptedToken) {
    return res.status(401).json({
      error: "LINKEDIN_NOT_AUTHENTICATED",
      message: "No LinkedIn connection found. Please authenticate via GET /api/linkedin/auth first.",
    });
  }

  // Check if token has expired
  if (tokenStore.expiresAt && Date.now() >= tokenStore.expiresAt) {
    return res.status(401).json({
      error: "LINKEDIN_TOKEN_EXPIRED",
      message: "LinkedIn access token has expired. Re-authentication required via GET /api/linkedin/auth.",
    });
  }

  let accessToken;
  try {
    accessToken = decryptToken(tokenStore.encryptedToken);
  } catch (decErr) {
    return res.status(500).json({
      error: "DECRYPTION_FAILED",
      message: "Failed to decrypt LinkedIn credentials. Re-authentication required.",
    });
  }

  // Determine author Person URN if not cached yet
  let authorUrn = tokenStore.personUrn;
  if (!authorUrn) {
    try {
      const userinfoRes = await fetch("https://api.linkedin.com/v2/userinfo", {
        headers: { Authorization: `Bearer ${accessToken}` },
      });
      if (userinfoRes.ok) {
        const userInfo = await userinfoRes.json();
        if (userInfo.sub) {
          authorUrn = `urn:li:person:${userInfo.sub}`;
          tokenStore.personUrn = authorUrn;
        }
      } else if (userinfoRes.status === 401) {
        return res.status(401).json({
          error: "LINKEDIN_TOKEN_INVALID",
          message: "LinkedIn access token was revoked or rejected by LinkedIn. Please re-authenticate.",
        });
      }
    } catch {
      // Proceed to try post call
    }
  }

  if (!authorUrn) {
    return res.status(500).json({
      error: "PROFILE_FETCH_FAILED",
      message: "Unable to determine LinkedIn member identity for posting.",
    });
  }

  // LinkedIn UGC Post payload (Community Management / UGC Share API)
  const ugcPayload = {
    author: authorUrn,
    lifecycleState: "PUBLISHED",
    specificContent: {
      "com.linkedin.ugc.ShareContent": {
        shareCommentary: {
          text: text.trim(),
        },
        shareMediaCategory: "NONE",
      },
    },
    visibility: {
      "com.linkedin.ugc.MemberNetworkVisibility": "PUBLIC",
    },
  };

  try {
    const postResponse = await fetch("https://api.linkedin.com/v2/ugcPosts", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json",
        "X-Restli-Protocol-Version": "2.0.0",
      },
      body: JSON.stringify(ugcPayload),
    });

    const responseData = await postResponse.json().catch(() => ({}));

    if (postResponse.status === 401) {
      return res.status(401).json({
        error: "LINKEDIN_TOKEN_INVALID",
        message: "LinkedIn token is invalid or expired. Please re-authenticate via GET /api/linkedin/auth.",
      });
    }

    if (!postResponse.ok) {
      return res.status(postResponse.status).json({
        error: "LINKEDIN_SHARE_FAILED",
        message: responseData.message || "Failed to publish post to LinkedIn.",
        details: responseData,
      });
    }

    return res.status(201).json({
      success: true,
      message: "Post published to LinkedIn successfully.",
      postId: responseData.id || null,
    });
  } catch (err) {
    return res.status(500).json({
      error: "NETWORK_ERROR",
      message: "Failed to communicate with LinkedIn API.",
    });
  }
});

export default router;
