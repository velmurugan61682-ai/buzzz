# BUZZZ

An AI-native CRM, unified communication hub and agentic automation platform.

> **Read this first.** The web application in `apps/web` is complete and runs today. The API service in `services/api` is a **skeleton**: the security middleware is real, the domain routes return `501` until each is ported. There is no production backend yet. `docs/PRODUCTION_READINESS.md` is honest about exactly what is missing and why.

## What is actually here

| Part | State |
|---|---|
| `apps/web` | Runs. 18 views. Multi-currency, company hierarchy, field-level permissions, 8 locales including RTL, routing queues with shifts, recurring appointments. |
| `services/api` | Skeleton. Request id, auth, tenant scope and error handling are written; routes return 501. |
| `services/worker` | Not started. Specified in `docs/ARCHITECTURE.md`. |
| `database` | 52 tables across three migrations, with a cycle-prevention trigger on the company hierarchy and an exclusion constraint preventing double-booked staff. |
| `docs/openapi.yaml` | 294 operations across 28 domains. Validates against OpenAPI 3.1. |

## Architecture

```
Browser ──> apps/web (React + Vite)
               │
               ▼
        services/api (Express)          ← auth, tenancy, permissions, audit
               │
      ┌────────┼─────────┐
      ▼        ▼         ▼
  Postgres   Redis    services/worker   ← waits, campaign sends, ingestion, rollups
  (+pgvector)  │
               ▼
   GoWhats · MrAssistant.ai · Stripe · Google · Meta
```

The business logic is already written as **pure functions** in `apps/web/src/App.jsx` — governance, workflow execution, retrieval, approval policy, availability, identity resolution, pricing. They move to `services/api/src/services` unchanged. That is the largest shortcut available in this codebase.


## Open in VS Code

```bash
tar -xzf buzzz-repo.tar.gz
code repo
```

VS Code will offer the recommended extensions (ESLint, Tailwind IntelliSense, React snippets). Then:

- **Terminal → Run Task → dev server**, or just `npm run dev`, and open http://localhost:5173
- **Run and Debug → Open BUZZZ in Chrome** starts the server and attaches the debugger, so breakpoints in `apps/web/src/App.jsx` work
- **Terminal → Run Task → test** runs the 36-render suite and the symbol check

`apps/web/src/App.jsx` is around 16,000 lines. The workspace settings disable the minimap and format-on-save for it, which keeps the editor responsive.

## Run it locally

```bash
git clone <your-repo> buzzz && cd buzzz
npm install
cp .env.example .env          # fill in what you have; the web app runs without any of it

# web app only (works today)
npm run dev                   # http://localhost:5173

# with data services
docker compose -f infrastructure/docker-compose.yml up -d
npm run migrate               # applies database/migrations/0001_init.sql
npm run dev:api               # http://localhost:4000/health
```

## Verify

```bash
npm test        # 36 renders (every view, assistant open and closed) + undefined symbol check
npm run build   # production bundle
```

Both run in CI on every push and block deployment on failure.

## Build for production

```bash
npm run build                                              # apps/web/dist
docker build -f infrastructure/Dockerfile.web -t buzzz-web .
docker build -f infrastructure/Dockerfile.api -t buzzz-api .
```

## Documentation

| File | Contents |
|---|---|
| `docs/ARCHITECTURE.md` | Every subsystem: schema, engines, design decisions and the reasoning |
| `docs/API.md` | Conventions, tenancy, auth, errors, idempotency, rate limits |
| `docs/openapi.yaml` | The full specification |
| `docs/AUDIT.md` | Honest state of every feature, with evidence |
| `docs/PRODUCTION_READINESS.md` | What blocks launch and the order to fix it |
| `docs/SECURITY.md` | Secret scan result and the threat list |
| `docs/DEPLOYMENT.md` | Environments, migrations, backups, rollback |

## Security

No secrets are committed; CI fails the build if any appear. Provider credentials live server side only. See `docs/SECURITY.md`.

## Licence

Proprietary. All rights reserved.
