# Release checklist

Tick honestly. Unticked items are the reason BUZZZ cannot be sold yet.

## Blocks launch — no exceptions
- [ ] Authentication implemented (registration, login, sessions, reset)
- [ ] Tenant isolation enforced in query middleware, verified by IDOR testing
- [ ] Postgres provisioned, migration applied, backups configured
- [ ] Governance engines ported server-side (client-side checks are bypassable)
- [ ] One backup restore drill completed successfully

## Blocks revenue
- [ ] Stripe products and regional prices created
- [ ] Checkout and customer portal working
- [ ] Webhooks verified and idempotent
- [ ] Entitlements enforced server-side

## Blocks the core promise
- [ ] GoWhats webhook receiving inbound messages
- [ ] GoWhats outbound sending
- [ ] MrAssistant proxy placing and recording calls
- [ ] Queue and scheduler running (workflow waits, campaign sends, ingestion)
- [ ] Campaign delivery replaced with a real send worker

## Should be done
- [ ] LLM behind BUZZZ AI via the model router
- [ ] Neural embeddings for knowledge retrieval
- [ ] SSRF allowlist on the workflow API node
- [ ] Rate limiting on auth and AI endpoints
- [ ] Load tested at 10k contacts
- [ ] Error tracking wired

## Already done
- [x] Web application builds and runs
- [x] 34-render test suite passing in CI
- [x] Undefined symbol check passing in CI
- [x] Database schema written and tenant scoped
- [x] OpenAPI 3.1 spec, 237 operations, validating
- [x] Secret scan clean, enforced in CI
- [x] Docker and nginx production configuration
- [x] No hardcoded analytics anywhere in the product
