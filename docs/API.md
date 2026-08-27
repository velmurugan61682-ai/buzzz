# BUZZZ API architecture

**Companion files:** `buzzz_openapi.yaml` (validated OpenAPI 3.1, 237 operations) · `buzzz_api_inventory.csv` (every endpoint)

---

## 1. Audit result

I searched the codebase for every form of backend surface. The result is unambiguous:

| Looked for | Found |
|---|---|
| Express/router routes | **0** |
| Route handler exports | **0** |
| Versioned `/api/v1` paths | **0** |
| Existing OpenAPI/Swagger spec | **0** |
| `fetch()` calls | **1** (voice provider stub, pointing at a backend that does not exist) |

So there are **no existing APIs to classify** — nothing functional, nothing partial, nothing broken, nothing duplicate. The categories in the brief collapse to one: everything is ⚫ **Missing**.

The one thing that does exist and is worth preserving: 22 verified MrAssistant endpoint contracts read from their published documentation, already wrapped in a provider abstraction. That is the pattern the rest should follow.

This is therefore a **design deliverable**, not a repair job. The spec below is what to build, derived from the domain model that already exists in the product rather than invented from a checklist.

## 2. Conventions

**Base:** `https://api.buzzzbuzzz.com/api/v1` — one version prefix, no mixed conventions.

**Resources are plural nouns; actions are sub-resources.** `POST /contacts/{id}/merge`, not `POST /mergeContact`. Methods carry meaning: GET reads, POST creates or acts, PATCH partially updates, DELETE archives. **Nothing is hard deleted** — DELETE sets an archive flag, because audit records must survive.

**Pagination is keyset, not offset.** `?cursor=&limit=` returning `{data, next_cursor, has_more}`. Offset pagination degrades linearly; at 100k conversations page 500 would time out.

**Filtering is uniform:** `?filter=status:eq:Qualified&filter=score:gt:70`, repeatable, same grammar on every collection.

**Timestamps are RFC 3339 UTC.** Display timezone is a workspace setting, never a storage decision.

**Money is minor units as integers.** No floats anywhere near currency.

## 3. Tenancy — the rule that matters most

**The workspace comes from the token, never from the request.** No endpoint accepts a `workspace_id` parameter. Every query carries `where workspace_id = $auth.workspace` applied by middleware, not by the individual handler, because a handler that forgets is a data breach.

**Cross-tenant reads return 404, not 403.** A 403 confirms the resource exists, which lets an attacker enumerate ids across tenants. 404 reveals nothing.

## 4. Authorization

Three layers, all server-side, in order:

1. **User role** — Owner, Admin, Manager, Finance Manager, Marketing Manager, Sales Manager, Support Lead, Agent.
2. **Agent governance** — for anything an AI initiates: permission grant, required tool, action minimum autonomy, workspace ceiling, channel.
3. **Approval policy** — financial thresholds, recipient volume, destructive classification.

**BUZZZ AI has no privileged path.** `POST /buzz/execute` runs the identical checks as the equivalent human endpoint. An AI request is an authenticated user request with a model attached.

## 5. Errors

```json
{ "code": "autonomy_insufficient",
  "message": "Create deals needs autonomy Level 3. Kai runs at Level 2.",
  "request_id": "req_01H...",
  "fields": { "value": "must be a positive integer" },
  "docs": "https://docs.buzzzbuzzz.com/errors/autonomy_insufficient" }
```

Machine-readable `code`, human-readable `message` that names the actual constraint, and a `request_id` that appears in the logs. Never a stack trace, never a secret, never "Something went wrong."

`402` is used deliberately for plan and usage limits, distinct from `403` for permission.

## 6. Idempotency

**73 of the 237 operations accept `Idempotency-Key`** — everything that sends, dials, charges, books or launches. The key is stored with the response; a repeat returns the original result rather than acting twice.

This is not optional politeness. Without it, one dropped connection during a campaign launch sends the whole audience twice.

## 7. Async work

Anything that cannot finish inside an HTTP request returns `202` with a job id: knowledge ingestion, website crawling, embedding, campaign sending, bulk import, analytics rollups, audit export, workflow waits.

**Workflow waits are the clearest case.** A workflow that pauses three days cannot hold a connection; it becomes a scheduled job that resumes from the last persisted node execution.

## 8. Webhooks

**Inbound** (`/webhooks/gowhats`, `/webhooks/mrassistant`, `/webhooks/stripe`): signature verified before parsing, idempotent on the provider event id, always `200` on receipt with processing queued — a slow handler causes provider retries and duplicate work.

**Outbound**: customers subscribe to events, deliveries are HMAC signed so they can verify origin, retried with exponential backoff, with a delivery log and replay.

## 9. Rate limits

Per workspace and per plan, returned in `X-RateLimit-*` headers with `Retry-After` on 429. Auth endpoints are limited per IP as well as per account, since credential stuffing does not respect account boundaries. AI endpoints are limited against the plan's action allowance, so rate limiting and entitlement enforcement are the same mechanism.

## 10. Implementation order

The engines already written in the product are **pure functions** — `canAgentDo`, `runWorkflow`, `retrieve`, `evaluatePolicy`, `availability`, `resolveIdentity`, `checkEntitlement` and the rest. They move to the server unchanged and become the service layer. That is the single biggest accelerator available here: the business logic is already written and tested; only the transport, persistence and identity layers are missing.

1. Auth, workspaces, tenancy middleware, error envelope, pagination — the spine everything else assumes.
2. CRM, Inbox, Appointments, Agents, Workflows — port the engines behind the endpoints.
3. Queue and scheduler; move ingestion, sending and waits off the request path.
4. Provider proxies and inbound webhooks.
5. Billing with server-resolved pricing.
6. Analytics rollups, audit query, admin.

## 11. What must never be accepted from the client

A short list worth pinning above a developer's desk, because every item is a real vulnerability class:

- `workspace_id` — comes from the token
- Prices, currencies or provider price ids — resolved server-side from billing country
- Autonomy levels or permission flags on an action request — read from the stored agent
- Approval decisions without a role check — verified against the signed-in user
- Webhook payloads without signature verification
- Arbitrary URLs for the workflow API node — allowlist and block private address ranges

That last one is the highest-risk surface in the product: it lets a customer make your server issue outbound requests on their behalf.
