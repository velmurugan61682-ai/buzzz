# Deployment

## Environments

Three, with separate databases, credentials and provider accounts. **Staging uses provider test modes; never live keys.**

| | development | staging | production |
|---|---|---|---|
| Database | local Docker | managed, small | managed, HA |
| Stripe | test | test | live |
| GoWhats / MrAssistant | sandbox | sandbox | live |

## Pipeline

`install → symbol check → render test → build → OpenAPI validation → dependency audit → secret scan → deploy staging → smoke → manual approval → production`

A failing check blocks production. There is no override path.

## Migrations

Versioned, forward-only, additive first. **Never a destructive migration in the same deploy as the code that needs it.** Add a column, backfill, switch reads, drop the old column in a later release. Test against a staging clone before production.

```bash
psql "$DATABASE_URL" -f database/migrations/0001_init.sql
```

## Health

- `/health` — process alive
- `/health/ready` — database, Redis and queue reachable; the load balancer uses **this**, not `/health`
- `/health/version` — commit SHA

## Backups

- Continuous WAL archiving plus nightly snapshots
- Retention: 30 days point-in-time, 12 monthly archives
- **RPO 5 minutes, RTO 1 hour**
- Quarterly restore drill into an isolated environment, result recorded

**A backup that has never been restored is not a backup.** Do not launch until one restore has succeeded end to end.

## Rollback

Web is a static bundle: redeploy the previous image. API is stateless: redeploy the previous image. Database rolls forward, never back — which is why migrations must be additive.
