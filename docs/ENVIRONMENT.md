# Environment variables

Every variable in `.env.example`, what it does, and whether the platform runs without it.

| Variable | Required for | Without it |
|---|---|---|
| `DATABASE_URL` | everything persistent | API cannot start |
| `REDIS_URL` | queue, rate limits, cache | no background work |
| `SESSION_SECRET`, `JWT_SECRET` | authentication | no login |
| `ENCRYPTION_KEY` | provider credential storage | integrations cannot be saved |
| `AI_PROVIDER_KEY` | BUZZZ AI, agent replies | assistant falls back to rule-based routing |
| `EMBEDDING_PROVIDER_KEY` | knowledge retrieval | keyword retrieval only |
| `GOWHATS_API_KEY` / `_WEBHOOK_SECRET` | WhatsApp in and out | inbox has no WhatsApp |
| `MRASSISTANT_API_KEY` / `_WEBHOOK_SECRET` | calls | calls section is read-only |
| `STRIPE_SECRET_KEY` / `_WEBHOOK_SECRET` | billing | no checkout, no subscription state |
| `GOOGLE_CLIENT_ID` / `_SECRET` | Calendar, Gmail | those integrations cannot connect |
| `META_APP_ID` / `_SECRET` | Instagram, Facebook | social publishing unavailable |
| `S3_*` | uploads, recordings | no file storage |
| `SENTRY_DSN` | error tracking | errors only in logs |
| `WORKFLOW_EGRESS_ALLOWLIST` | **SSRF protection** | **do not enable the API node without it** |

Generate secrets with `openssl rand -base64 48`. Store them in your host's secret manager, never in the repository.
