# API (`apps/api`)

Multi-tenant REST API: users, organizations, roles, invitations, API keys, provider credentials and the audit log. The endpoint reference is in [docs/API.md](../../docs/API.md).

```bash
npm run api:dev        # migrate, then serve on http://127.0.0.1:3300
npm run api:migrate    # apply pending migrations to DATABASE_URL
npm test               # includes apps/api/test (in-memory Postgres, no Docker)
```

## Database

| `DATABASE_URL` | Use |
|---|---|
| `pglite://./.data/api-db` (default) | Local development: real Postgres 18 compiled to WASM, persisted in `.data/` (git-ignored). **One process at a time**: stop `api:dev` before running `api:migrate` against the same folder |
| `pglite://memory` | Tests |
| `postgres://user:pass@host/db` | Production (PostgreSQL 16+). Required when `NODE_ENV=production` |

**Migrations:**
- SQL files live in `migrations/`, are applied in order and are forward-only.
- Each one is pinned in `migrations/checksums.json`. Editing an applied migration fails the tests, and fails startup on any database that already ran it. Add a new numbered file instead and pin it.

**Tenant isolation:** two layers, so one bug cannot leak data.
- Every tenant table has `org_id`.
- **Layer 1:** handlers only reach the database through `request.org.run(...)`, which also filters by `org_id`.
- **Layer 2:** row-level security. `run()` opens a transaction as the non-owner role `octo_app` with `app.org_id` set, and the policies allow only that org's rows. `octo_app` also cannot update or delete audit entries, and cannot read password hashes.
- **Identity lookups** happen before an org is known: user by email, session or API key by hash, org creation and deletion. They use the owner connection, but only in `src/auth/*` and the org-lifecycle routes.

**Production setup:** the app logs in as the role that owns the tables, so it can run migrations. Row-level security applies once the app switches to `octo_app`, and the login role must be allowed to do that. As the database admin:

```sql
GRANT octo_app TO <app_login_role>;   -- lets the app SET ROLE octo_app
```

The login role must not be a superuser, since superusers bypass row-level security.

## Configuration

All settings are in [.env.example](../../.env.example) under "API":

| Area | Variables |
|---|---|
| Database and server | `DATABASE_URL`, `API_HOST`, `API_PORT` |
| Dashboard | `DASHBOARD_URL` (email links), `DASHBOARD_ORIGINS` (CSRF allow-list) |
| Sessions and network | `SESSION_TTL_DAYS`, `SESSION_IDLE_DAYS`, `COOKIE_SECURE`, `TRUST_PROXY` |
| Rate limits | `RATE_LIMIT_KEY_PER_MINUTE`, `RATE_LIMIT_ORG_PER_MINUTE`, `AUTH_RATE_LIMIT_PER_15_MIN` |
| Google sign-in | `GOOGLE_OAUTH_ENABLED`, `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `GOOGLE_REDIRECT_URI` |
| Email | `SMTP_*` (shared with the legacy app) |
| Provider credentials | `CREDENTIALS_ENCRYPTION_KEY` (from the engine) |
| Call analysis and webhooks | `ANALYSIS_ENABLED`, `ANALYSIS_TICK_SECONDS`, `ANALYSIS_CONCURRENCY`, `ANALYSIS_MAX_ATTEMPTS`, `ANALYSIS_RETRY_BASE_SECONDS`, `ANALYSIS_LEASE_SECONDS`, `ANALYSIS_MAX_TRANSCRIPT_CHARS`, `WEBHOOK_DELIVERY_ENABLED`, `WEBHOOK_DELIVERY_TICK_SECONDS` |
| Campaigns | `CAMPAIGN_DIALER_ENABLED`, `CAMPAIGN_TICK_SECONDS`, `CAMPAIGN_HARD_CAP_START`, `CAMPAIGN_HARD_CAP_END`, `CAMPAIGN_DIAL_TIMEOUT_SECONDS`, `CAMPAIGN_DIAL_CONFIRM_SECONDS`, `CAMPAIGN_CALL_TIMEOUT_MINUTES`, `CAMPAIGN_MAX_CONTACTS`, `CAMPAIGN_MAX_UPLOAD_ROWS` (plus `MAX_CONCURRENT_CALLS_PER_ORG`, `TWILIO_WEBHOOK_SECRET`) |

**Email:** without `SMTP_HOST`, messages go to an in-memory outbox and are logged, including verification and reset links, so local sign-up works. Production refuses to start without SMTP.

## Layout

| Path | What |
|---|---|
| `src/app.ts` | Builds the server: error shape, request ids, hooks, routes |
| `src/auth/authenticate.ts` | One hook for every route: session or key → one org, CSRF, public-key origin check, rate limits, permission check |
| `src/auth/permissions.ts` | Roles and the permission matrix |
| `src/auth/crypto.ts` | argon2id passwords, tokens, API key format |
| `src/auth/identity.ts` | Identity lookups (users, sessions, email tokens, key by hash) |
| `src/db/` | Database (PGlite or pg), migrations, `TenantDb.withOrg` |
| `src/http/` | Errors, validation, pagination, idempotency, rate limiter |
| `src/routes/` | `auth`, `me`, `org` (org, members, invitations), `apiKeys`, `credentials`, `auditLogs` |
| `src/services/` | Mailer, audit log, Postgres credential store (used by the engine's `CredentialService`) |
| `src/routes/campaigns.ts`, `src/services/campaigns/` | Outbound campaigns: schedule, CSV import, the dialer (a Postgres queue run by the API process), retry rules, do-not-call, results. See [ARCHITECTURE 3.21](../../docs/ARCHITECTURE.md#321-outbound-campaigns-v1-as-built) |
| `src/routes/callAnalysis.ts`, `src/routes/structuredOutputs.ts`, `src/services/analysis/`, `src/services/webhookDelivery.ts` | Call analysis: transcripts, the analysis job and worker, structured outputs, call filters, transcript search, the end-of-call-report and its delivery. See [ARCHITECTURE 3.22](../../docs/ARCHITECTURE.md#322-call-analysis-and-transcripts-v1-as-built) |
| `test/` | Auth flows, cross-org isolation (every endpoint), API keys and conventions, RBAC matrix, rate limits, migrations |

## Known limitations

- **Rate limits** are in memory: correct for one API process only. Use Redis before running several.
- **Assistants and calls don't exist yet.** Public keys and idempotency are proven on a test-only route until `POST /v1/calls` arrives. Assistant ids on public keys are not yet checked against real assistants.
- **No account security features yet:** no MFA, and no "sign out other sessions" or account deletion endpoints.
- **Org suspension** exists in the schema, but there is no admin endpoint to suspend an org.
