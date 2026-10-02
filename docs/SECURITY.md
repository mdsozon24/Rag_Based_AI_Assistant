# Security and Privacy

Status: review snapshot, 2026-10-02. This document describes the repository as it exists today; it is not a certification, penetration-test report, or legal opinion.

## Scope and Threat Model

The review covers the Fastify multi-tenant API and voice engine, the legacy Express application, provider/tool/webhook integrations, persistence, and the installed npm dependency tree. The main assets are organization data, call transcripts and debug payloads, user-uploaded documents, provider credentials, webhook secrets, API/session credentials, and phone numbers.

Trust boundaries include:

- Authenticated organizations and other organizations sharing the database.
- Public clients and unauthenticated provider callback endpoints.
- Customer-configured tool, webhook, routing, and custom-provider URLs.
- Caller messages, documents, model output, and tool output, all of which may be attacker-controlled.
- Application processes and the database, SMTP service, provider APIs, and deployment ingress.

The principal risks are cross-tenant disclosure, forged callbacks, server-side request forgery, prompt injection, credential disclosure, unbounded upload/resource use, and retaining sensitive data longer than intended.

## Controls Verified or Added

- **API authentication and authorization:** Fastify routes default to organization authentication. The shared auth hook resolves one org, rechecks session membership, applies role/API-key permissions and rate limits, and scopes tenant SQL through `request.org.run()`. PostgreSQL row-level security is an additional boundary. Public callback and browser routes are individually marked and use signatures or single-use call tokens where applicable. The route-coverage tests could not be collected in this checkout because `apps/api/src/app.ts` imports a missing `routes/ops.ts`.
- **SQL:** application values use parameterized queries. Dynamic SQL fragments in list/statistics helpers are built from fixed code paths and validated pagination/filter inputs.
- **SSRF:** customer endpoints use HTTPS validation and connect-time DNS checks that reject private, loopback, link-local, reserved, multicast, and metadata addresses. The API's default fetch now uses that guarded client, covering runtime tool calls, telephony routing, and manual webhook redelivery as well as fixed vendor calls. Redirects are not followed by the guarded Node HTTP client. The development-only private-network override is disabled in production.
- **Provider callbacks:** production inbound telephony now accepts only Twilio with a configured signing secret; production SMS callbacks refuse an empty signing secret. Stand-in telephony providers already reject campaign status callbacks in production. Provider-specific signature verification still depends on correct account configuration.
- **Uploads:** the legacy document endpoint now accepts only TXT, MD, JSON, CSV, and PDF, checks base64, UTF-8 text and PDF magic bytes, validates MIME/extension agreement, and caps decoded documents at 10 MiB. The campaign CSV endpoint has its own body and row limits.
- **Tenant privacy:** legacy admin prompts now receive only that admin's own documents/memories plus intentionally shared documents; they no longer load every user's private uploads and voice memories.
- **Prompt injection:** retrieved legacy reference data and platform text-mode tool results are explicitly framed as untrusted data. This is defense-in-depth, not a guarantee: models can still follow adversarial content. Do not put secrets or privileged instructions in tool output or uploaded documents.
- **Secrets and logs:** API keys/session tokens are stored as hashes. Org provider credentials and tool/webhook secrets use AES-256-GCM envelope encryption with org/record-associated data and key IDs, using an environment-managed master key with rotation support. Sentry strips request/user/breadcrumb data and scrubs common secrets; per-call log capture omits content fields. SMTP requires TLS (implicit TLS on port 465, STARTTLS otherwise).
- **TLS:** production API and dashboard public URLs, and enabled Google OAuth callback URLs, must use HTTPS. The app is normally deployed behind a TLS-terminating ingress; the internal listener itself is plain HTTP. Configure the ingress to redirect/reject cleartext traffic and set secure cookies and trusted-proxy settings correctly.
- **Dependencies:** `npm audit` reports zero known vulnerabilities after updating `qs` transitively, Nodemailer to patched 10.x, and Vitest to patched 5.x.

## Remaining Risks and Gaps

- **Tracked private data:** `data/custom_documents.json` and four `data/user_data/*.json` files are tracked by Git. They contain user-owned content. This audit did not overwrite or remove them. Removing them from the current tree is not enough; purge them from repository history and rotate any exposed credentials after an owner-approved history rewrite.
- **At-rest encryption:** provider/tool/webhook secrets have application-level envelope encryption, but the master key is supplied through environment configuration rather than a KMS-backed key provider. Call transcripts, call events, debug bodies, analysis, and legacy JSON documents/memories are not application-encrypted. Database/disk encryption is an infrastructure responsibility and is not verified here. No recordings/object-storage path currently exists.
- **Retention and deletion:** debug LLM bodies have a configured retention job. There is no per-org transcript/recording retention policy, zero-data-retention mode, per-call delete/export workflow, or complete org data export. Existing org deletion is not a substitute for a verified export/deletion workflow or legal-retention policy.
- **PII:** optional transcript/log redaction for phone numbers, email, payment-card numbers, and national IDs is not implemented. Do not assume stored transcripts or logs are de-identified.
- **Compliance mode:** provider eligibility metadata and enforcement are not implemented. The platform does not establish HIPAA compliance or a BAA. A provider's certification alone is insufficient; eligible products, regions, configuration, contracts, and operational controls must be verified before making a compliance claim.
- **Enterprise identity/network isolation:** SAML/OIDC organization SSO, enforced MFA, organization IP allowlists, and separate per-org environments are not implemented. Google OAuth is not a substitute for these controls.
- **Transport encryption:** production URL checks do not prove that the ingress uses TLS. The Postgres pool currently relies on deployment connection settings; TLS mode and certificate verification were not verified for a selected hosting provider. Choose and enforce the production database TLS/CA policy before launch.
- **Legacy parser resource use:** Express parses JSON bodies up to 50 MiB before the document-specific 10 MiB check. Audio and other legacy endpoints share that parser limit; a lower global limit requires an endpoint-specific streaming/parser design to avoid breaking them.
- **Authorization verification:** the central Fastify auth/RLS model and legacy route guards were inspected, but the full API isolation/RBAC test suites cannot run until the missing `apps/api/src/routes/ops.ts` import is restored.

## Verification Snapshot

- Focused network/SSRF tests: 23 passed.
- Focused webhook gate tests: 4 passed.
- Focused upload validator tests: 3 passed.
- Focused text-turn tests: 9 passed.
- Production build: passed.
- Full suite: 392 passed, 6 skipped; 16 API suites failed to load because `apps/api/src/routes/ops.ts` is missing.
- Typecheck/lint: blocked by the same missing import; the Nodemailer 10 type mismatch introduced during dependency remediation was fixed.
- Dependency audit: `npm audit` found 0 vulnerabilities.