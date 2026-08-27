# BUZZZ — what is in this archive

Everything below is the working repository, not a snapshot of fragments. It
builds, the tests run, and the test suite is what backs every claim here.

## Running it

```bash
npm ci
npm test          # 33 suites
npm run build     # production build of the web app
npm run dev       # local dev server
npm run preview:admin   # rebuild the standalone admin console file
```

## Layout

| Path | What it is |
|---|---|
| `apps/web/src/App.jsx` | The entire product: landing page, auth, workspace, admin console |
| `apps/web/public/` | Logo, favicons, share image, robots and sitemap |
| `services/api/src/lib/` | The real backend logic. Every file here is tested |
| `services/api/src/routes/` | HTTP routes: auth, OAuth, passkeys, Google, admin |
| `database/migrations/` | Eight migrations, in order |
| `scripts/` | The test suite and the preview build script |
| `docs/` | Architecture, API, security audit, deployment, environment |
| `infrastructure/` | Dockerfiles, compose, nginx |

## The backend libraries, and what each is for

| File | Purpose | Tests |
|---|---|---|
| `db.js` | Data access. Workspace isolation is enforced here, in SQL | 30 |
| `auth.js` | Passwords, sessions, verification, reset, lockout | 60 |
| `mfa.js` | TOTP, passkeys, recovery codes | 45 |
| `oauth.js` | Google and Apple sign in | 38 |
| `llm.js` | Plans, credits, entitlements, cost control | 40 |
| `router.js` | Every model modality through OpenRouter | 40 |
| `teamchat.js` | Slack and Discord, signatures and authorisation | 44 |
| `google.js` | Calendar and Meet | 30 |
| `mrassistant.js` | Voice platform client | 22 |
| `governance.js` | The autonomy engine, identical to the client copy | shared |

## What needs configuration before it runs for real

Nothing here is faked, which means nothing here works without credentials.
`docs/ENVIRONMENT.md` lists every variable. The short version:

- `DATABASE_URL` and the eight migrations applied
- `TOKEN_ENCRYPTION_KEY` for sealing provider credentials at rest
- `OPENROUTER_API_KEY` for the model layer
- Google and Apple OAuth client ids and secrets, for social sign in
- Slack app credentials or a Discord application public key, for team chat
- An email provider, for verification and password reset

## Honest status

The frontend is complete and deployable. The backend libraries are real,
tested code. What is missing is the wiring between most product domains and a
database: CRM, inbox, campaigns and agents still run in browser state. See
`docs/PRODUCTION_READINESS.md` for the specific gaps and
`docs/buzzz_security_audit.md` for the security position.
