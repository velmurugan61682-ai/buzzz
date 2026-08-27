# Security report

## Secret scan

The full workspace was scanned for committed credentials: API keys, passwords, tokens, private keys, cloud credentials, Stripe secrets and webhook secrets.

**Result: no live secrets found.** The single pattern match was `placeholder="sk_live_…"` in a form input — display text, not a credential.

**Nothing requires rotation.** No secret has ever been committed to this codebase.

CI runs the same scan on every push and fails the build on a match.

## Threats to test before launch

Ordered by likelihood of causing a breach:

1. **IDOR across workspaces.** Every endpoint must be probed with another tenant's ids. Cross-tenant reads must return 404, never 403, because 403 confirms existence.
2. **Privilege escalation.** Editing role claims client-side must not grant authority; roles are read from the session, never the request.
3. **Agent autonomy escalation.** Calling an action API directly with a higher autonomy claim must be rejected against the stored agent record.
4. **SSRF through the workflow API node.** *This is the highest-risk surface in the product.* It lets a customer make the server issue arbitrary outbound requests. Requires an egress allowlist (`WORKFLOW_EGRESS_ALLOWLIST`), private address range blocking, and a timeout before it is enabled for anyone.
5. **Webhook forgery and replay.** Signature verified before parsing; idempotent on the provider event id.
6. **Secret leakage into logs and audit text.** Logger redacts `authorization` and `cookie`; audit descriptions must never interpolate credentials.
7. **Unrestricted file upload.** Validate type and size, sanitise names, store per workspace, serve only via signed URLs.
8. **Rate limit bypass** on auth and AI endpoints; auth is limited per IP as well as per account.

## Current posture

**All authorization runs client-side today.** The governance engines are real and tested but execute in the browser, so devtools bypasses them. This is not a hardening task; it is the reason the platform cannot be sold yet. Porting the engines behind the API middleware is the fix.
