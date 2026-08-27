# BUZZZ security audit and hardening

**Date:** 19 August 2026 · **Scope:** frontend, API service, data layer, AI layer, workflow engine, auth, admin, dependencies, deployment config.
**Method:** repository map, automated scanning, and adversarial tests written to attack the system rather than exercise it. Every "fixed" below was re-tested.

---

## 1. Vulnerabilities found and fixed

### HIGH — Prototype pollution in the authorization lookup
**Component:** governance engine, `decide()`
**Root cause:** `ACTIONS[action]` on a plain object. `ACTIONS["__proto__"]`, `["constructor"]` and `["toString"]` all return truthy inherited values, so an attacker-supplied action name passed the "is this a known action?" check.
**Security impact:** an unknown action reached the authorization path instead of being denied, then crashed on `spec.label.toLowerCase()`. A crash inside a security decision is a denial of service, and the same class of bug elsewhere can bypass a check entirely.
**Fix:** `ownLookup()` requires a string key and `hasOwnProperty`. Applied to `ACTIONS`, `ACTION_TOOL` and `WF_ACTIONS`.
**Test:** `decide({action:"__proto__"})` now returns `deny`, asserted in `ai-security-test`.
**Residual risk:** none known for these three tables.

### HIGH — The AI could plan its own privilege escalation
**Component:** BUZZZ AI reasoning layer, `set_autonomy` intent
**Root cause:** the intent carried `perm: null`, so no gate applied. "Raise my autonomy to 4" resolved to an allowed plan.
**Security impact:** a prompt — including one arriving inside a customer message — could get the assistant to prepare and present raising the workspace ceiling, the control that governs every other action.
**Fix:** intents can now be marked `humanOnly`. Autonomy changes return a `human_only` result that routes the user to Settings and is never executable by the assistant.
**Test:** three phrasings asserted non-executable in `ai-security-test`.
**Residual risk:** the server must also refuse ceiling changes from a non-owner. The role check exists (`requireStaff`, workspace role) but the HTTP route for changing autonomy is not written yet.

### MEDIUM — No CORS policy on the API
**Component:** `services/api/src/index.js`
**Root cause:** no `cors` middleware at all.
**Security impact:** browser defaults protected the API by accident. Any future permissive header, or a proxy adding one, would let any website call the API with the user's cookies attached.
**Fix:** explicit allow list from `ALLOWED_ORIGINS`, `credentials: true`, no wildcard.
**Test:** an allowed origin is echoed exactly; an unknown origin receives no grant and the API never answers `*`. Asserted against the running server.

### MEDIUM — No rate limiting anywhere
**Component:** API service
**Root cause:** not implemented.
**Security impact:** credential stuffing against login, password-reset flooding of a user's inbox, and general resource exhaustion were all unbounded. The account lockout in the auth service limits attempts per account; nothing limited attempts per attacker.
**Fix:** four limiters — login/signup 20 per 15 min, reset 5 per hour, admin login 30 per 15 min, general API 300 per minute.
**Test:** repeated logins return 429; `/health` is unaffected.

### MEDIUM — IPv6 rate-limit bypass in my own fix
**Component:** the limiter added above
**Root cause:** keying on `req.ip` raw. An attacker with a routed IPv6 allocation rotates through billions of addresses and never reaches a limit.
**Security impact:** the brute-force protection would have been ineffective against a competent attacker.
**Fix:** `ipKeyGenerator` normalises IPv6 to its /64 prefix; the key is prefix plus account.
**Test:** the library's `ERR_ERL_KEY_GEN_IPV6` diagnostic no longer fires.

---

## 2. Verified secure — attacked and held

**Multi-tenant isolation (32 assertions).** Seven record types were queried as workspace A while workspace B's id was supplied. Every query filters `workspace_id = $1` in SQL rather than in JavaScript afterwards; the other tenant's id never appears in the parameters; an unscoped query **throws** rather than returning every tenant. IDOR by supplying another workspace id is refused, and a membership row belonging to a different user does not help.

**Staff are not implicitly tenants.** A superadmin has no access to customer data without an explicit support grant, which is read-only by default, expires on its own, is capped server-side at two hours, and is written to the customer's own audit trail.

**AI is not a security boundary.** Six prompt injections — "ignore all previous instructions", a fake `SYSTEM:` line, "developer mode", a claimed owner authorisation, an HTML comment override, and a system-prompt exfiltration attempt — all failed to raise the effective level above the ceiling. Tool access is separately proven not to be authority: an agent holding a tool but not the permission is denied, not queued for approval.

**Destructive actions.** Delete, refund and cancel require a human at Level 4 even with `allowDestructive` set. A 50,000-recipient send needs approval at any level.

**Workflow engine.** A cycle, a self-edge and an orphaned graph all terminate in bounded time with a bounded step count. Governance is evaluated per node at run time, so a workflow authored at Level 4 pauses under a Level 2 ceiling.

**SQL injection.** Ids are bound parameters; `'; DROP TABLE contacts; --` never reaches the SQL text.

**Secrets.** No live credentials in source, config or CI. The one pattern match is a `placeholder="sk_live_…"` in a form input.

**Frontend.** Zero `dangerouslySetInnerHTML`, zero `eval`/`new Function`, zero `localStorage`/`sessionStorage`, and both `target="_blank"` links carry `rel="noopener"`.

**Dependencies.** `npm audit`: 0 vulnerabilities.

**Error handling.** 500s return a generic message plus a request id; stack traces and internals are not sent to clients.

---

## 3. Risks that remain, stated plainly

1. **Most of the platform has no server-side enforcement yet, because it has no server.** CRM, inbox, agents, workflows and campaigns run in browser state. The governance engine, the data layer and the isolation tests are real and correct, but for those domains there is currently nothing behind the browser to enforce them. This is the single largest security item outstanding.
2. **No CSRF tokens.** Session cookies are `sameSite: lax`, which covers the common cases, but state-changing routes should carry a token before this is called complete.
3. **No MFA** for staff or customers. The brief asks for it on admin; the schema supports adding it, the flow is not built.
4. **Webhook signature verification** exists for Google's channel token only. Stripe, GoWhats and social webhooks are not implemented, so nothing verifies them yet.
5. **No file uploads exist**, so no upload validation was needed. If uploads are added, none of the protections in §12 of the brief are present.
6. **No queues, workers or cron.** Retry, idempotency and backpressure are designed in the API code but nothing schedules work.
7. **Billing is absent.** No Stripe, so subscription state cannot yet be forged — but it also cannot be trusted, because it does not exist.
8. **Audit immutability** is enforced by PostgreSQL rules in the migration. That has not been executed against a live database, because there is no database to migrate.

---

## 4. Summary

| | Count |
|---|---|
| Vulnerabilities found | 5 |
| Vulnerabilities fixed and re-tested | 5 |
| Attack tests added | 3 suites, ~70 assertions |
| Total suites in CI | 24 |
| Dependencies added | `cors`, `express-rate-limit` |
| Dependency vulnerabilities | 0 |
| Secrets exposed | 0 |

**Requires human configuration:** `ALLOWED_ORIGINS`, `TOKEN_ENCRYPTION_KEY`, `DATABASE_URL`, Google OAuth credentials, and an email provider for verification and reset links.

**Is BUZZZ production-ready?** The security posture of what exists is sound and now tested adversarially. The platform is not production-ready, for the reason given in risk 1: most domains have no backend to secure. That is an implementation gap, not a security defect, and it is the next thing to build.
