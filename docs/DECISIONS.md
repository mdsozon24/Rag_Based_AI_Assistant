# Voice of Octo: Decision log

Each entry has the decision, the alternatives considered, and why. Status is **Proposed** until the owner confirms it; confirmed entries become **Accepted**. To change a decision, add a new entry that supersedes the old one. Do not rewrite history.

Context for all entries: [ARCHITECTURE.md](ARCHITECTURE.md). Weakness IDs (W1-W27) refer to section 2 of that document.

| ID | Decision | Status |
|---|---|---|
| D1 | TypeScript on Node for all services | Proposed |
| D2 | Modular monolith, three process roles | Proposed |
| D3 | Fastify for the API | Proposed |
| D4 | pnpm monorepo; legacy app moved to `apps/legacy` | Proposed |
| D5 | PostgreSQL + Drizzle + forward-only SQL migrations | Proposed |
| D6 | Shared-schema tenancy with `org_id` + row-level security | Proposed |
| D7 | WebSocket transport first, WebRTC later | Proposed |
| D8 | Connection-owner session model | Proposed |
| D9 | Pipeline supports cascaded and realtime modes | Proposed |
| D10 | BullMQ on Redis for jobs | Proposed |
| D11 | Call events via Redis Streams, partitioned table | Proposed |
| D12 | S3-compatible object storage for recordings and files | Proposed |
| D13 | pgvector for knowledge-base search | Proposed |
| D14 | First-party auth + hashed API keys | Accepted (2026-10-01): email + argon2id; SSO later if needed |
| D15 | zod as the single schema source → OpenAPI → SDKs | Proposed |
| D16 | pino + OpenTelemetry + Prometheus + Sentry | Proposed |
| D17 | Env vars for platform secrets, envelope encryption for org credentials | Proposed |
| D18 | New Next.js dashboard; Vite app becomes the demo | Proposed |
| D19 | Vitest, provider fakes, real Postgres and Redis in tests | Proposed |
| D20 | Docker images; leave Render free | Proposed (host is an open question) |
| D21 | Strangler migration of the existing app | Proposed |
| D22 | Immutable assistant versions, calls pin a version | Proposed |
| D23 | Signed, retried webhooks with a delivery log | Proposed |
| D24 | Drop the voice-memory PII extractor | Proposed (open question) |
| D25 | ElevenLabs Scribe v2 Realtime for streaming STT, manual commits | Accepted (2026-10-01) |
| D26 | Build the engine in `packages/engine` before the monorepo; run standalone | Accepted (2026-10-01) |
| D27 | Energy VAD with a minimum-statistics noise floor for v1 | Proposed |
| D28 | Provider failure keeps its `error-*` end reason even when it transfers | Proposed (open question) |
| D29 | Latency definitions: voice-to-voice includes the endpointing wait | Proposed |
| D30 | Provider set v1: Deepgram, OpenAI, Cartesia added; custom endpoint per component | Accepted (2026-10-01) |
| D31 | Presets + per-component override; balanced = current stack | Proposed |
| D32 | Org credentials behind an org-scoped store interface; in-memory until Phase 2 | Accepted (2026-10-01) |
| D33 | Fallback only before output, sticky per call; retries per provider | Proposed |
| D34 | Usage metering in the engine; estimated tokens flagged | Proposed |
| D35 | Custom endpoint contract v1 and SSRF policy | Proposed |
| D36 | Hand-written SQL migrations + thin query layer instead of Drizzle (for now) | Proposed |
| D37 | Owner connection only for identity lookups; tenant work as octo_app under RLS | Proposed |
| D38 | PGlite for development and tests; real Postgres in production | Accepted (2026-10-01) |
| D39 | Server-side sessions in an HttpOnly cookie, CSRF by Origin check | Accepted (2026-10-01) |
| D40 | Permission matrix; private keys = admin set, public keys = calls only | Proposed |
| D41 | In-memory token-bucket rate limits behind an interface | Proposed |
| D42 | API conventions: error shape, cursor pagination, opt-in idempotency, 404 for foreign ids | Proposed |
| D43 | Browser calls over WebSocket with the browser's echo cancellation; WebRTC later | Accepted (2026-10-01) |
| D44 | Public keys: saved assistants and a safe override allowlist; inline configs via server-minted calls | Accepted (2026-10-01) |
| D45 | Browser media endpoint in `apps/api` (single node), token in the first frame, in-memory resume | Accepted (2026-10-01) |
| D46 | Mobile: React Native WebView hosting the widget | Accepted (2026-10-01) |
| D47 | Text conversations reuse the assistant engine through a stateless text turn; sessions in Postgres | Accepted (2026-10-01) |
| D48 | SMS is an optional channel behind a messaging adapter; org-wide opt-out; async replies | Accepted (2026-10-01) |
| D49 | Chat usage records with a per-org billing unit (message or token); webhooks as queued rows | Accepted (2026-10-01) |
| D50 | OpenAI-compatible endpoint keeps OpenAI semantics; the assistant's prompt and tools always apply | Accepted (2026-10-01) |
| D51 | Campaign dialer is a Postgres-backed queue with an attempt ledger, running in the API process for now | Accepted (2026-10-02) |
| D52 | At most one provider dial per attempt; unconfirmed and lost calls are never retried | Proposed |
| D53 | Calling hours: the contact's local schedule cut to a platform limit, checked at claim and again before every dial | Proposed (open question: legal hours per country) |
| D54 | Campaign outcomes come from the assistant's `reportOutcome` labels until structured outputs exist | Accepted (2026-10-02) |
| D55 | Campaign telephony scope: dialer plus a signed status callback; media gateway and per-number credentials stay in Phase 8 | Accepted (2026-10-02) |
| D56 | Campaign cost is reported as usage units, not money, until price tables exist | Accepted (2026-10-02) |
| D57 | What "completed conversation", retry and success rate mean for campaigns | Proposed (open question) |
| D58 | The analysis job is a Postgres row that is also its result, run by an in-process worker | Proposed |
| D59 | Analysis runs on the call's own model chain | Accepted (2026-10-02) |
| D60 | Structured outputs are reusable org resources; the inline schema stays; the schema dialect is restricted | Accepted (2026-10-02) for reuse and the inline schema; the dialect is Proposed |
| D61 | The end-of-call-report waits for the analysis, is sent once, and is delivered automatically; chat events are not | Accepted (2026-10-02) |
| D62 | Webhook delivery: guarded client, long backoff, at least once | Proposed |
| D63 | Transcript order, search and filter shape | Accepted (2026-10-02) for the filter shape; the rest is Proposed |
| D64 | Analysis covers every call that ends, and skips what it cannot analyse | Proposed |

---

## D1. TypeScript on Node for all services

**Decision:** API, voice engine, workers, SDKs, CLI and dashboard are all TypeScript on Node (LTS).

**Alternatives:**

- **Python + FastAPI**, optionally with pipecat or LiveKit Agents for the pipeline. This has the richest voice-AI framework ecosystem and is the natural choice if we wanted local ML models.
- **Go** for the voice engine: better CPU efficiency and goroutines for many concurrent sessions.
- **Mixed:** Python engine, TS API and dashboard.

**Why:**

- All existing, working code is TypeScript. That includes the parts worth keeping: `ElevenLabsLiveRelay`, `MainSpeakerGate`, `BargeInDetector`, and the interrupt protocol. The Python files in the repo are unused.
- One language lets the web SDK, engine and API share types (control-message protocol, assistant config schema) with no translation layer.
- The engine is I/O-bound (streaming to providers). Node's event loop suits it, as long as we keep sync work off the hot path (see W9).
- A mixed stack doubles CI, tooling and hiring surface for a small team.

**Revisit if:** we need local models (VAD / turn detection / STT) in-process. That could be a small Python or ONNX sidecar later, without changing this decision for the rest.

## D2. Modular monolith with three process roles

**Decision:** one codebase and one Docker image, run as `api`, `voice` or `worker` via a role flag, plus a separate Next.js `dashboard`. Code is split into modules with explicit interfaces (packages in the monorepo).

**Alternatives:**

- **Single process** (today): simplest, but a deploy or crash drops every call, and API load competes with audio.
- **Microservices per module:** independent scaling, but distributed-systems cost (network calls, versioning, tracing, deploys) long before we need it.

**Why:** `voice` has different operational needs:

- Long-lived connections
- Graceful drain measured in minutes
- Sensitivity to event-loop lag
- Scaling on concurrent calls, not requests

So it runs as its own process from the start. Nothing else has a reason to be separate yet. Module boundaries keep a later split cheap.

## D3. Fastify for the API

**Decision:** Fastify with `@fastify/websocket`, zod type provider, and OpenAPI generation from route schemas.

**Alternatives:**

- **Keep Express:** the team knows it, but it has no schema-first routing, weaker typing, and ad-hoc validation (as in today's routes).
- **NestJS:** heavy DI and decorators; slows small teams.
- **Hono:** lean and fast; fewer mature plugins for rate limiting, multipart and OpenAPI.

**Why:** route schemas give us validation, TS types and OpenAPI docs from one definition. We need all three for a public API and generated SDKs. The Fastify plugin ecosystem covers cookies, CORS, rate limiting, multipart and helmet. The existing Express app stays as-is in `apps/legacy` (D21), so no Express code is rewritten just to switch frameworks.

## D4. pnpm monorepo; legacy app moved to `apps/legacy`

**Decision:** pnpm workspaces with `apps/*` and `packages/*` (layout in ARCHITECTURE section 3.7). Turborepo only if build times need caching.

**Alternatives:**

- **Separate repos per service or SDK:** cross-repo changes to the shared protocol and config types are painful.
- **npm workspaces:** works, but slower installs and weaker strictness around phantom dependencies.
- **Nx:** powerful but heavy.

**Why:** the engine, SDK and API share types that must change together. pnpm's strict `node_modules` catches undeclared dependencies.

**Note:** moving today's files into `apps/legacy` is a pure move with no code changes. It needs the owner's approval (open question).

## D5. PostgreSQL + Drizzle + forward-only SQL migrations

**Decision:** PostgreSQL 16. Drizzle ORM for typed queries. drizzle-kit generates SQL migration files that are reviewed, committed, and never edited after merge. Every schema change is a new migration.

**Alternatives:**

- **Prisma:** popular and good DX, but its own query engine makes RLS session variables (`SET LOCAL`) and pgvector awkward.
- **Kysely + node-pg-migrate:** excellent typed SQL; more hand-written schema code.
- **TypeORM:** decorator-heavy; migrations are unreliable.
- **Mongo / Dynamo:** poor fit for relational tenancy and reporting.

**Why:** Drizzle stays close to SQL. It supports pgvector and transactions where we can `set_config('app.org_id', …, true)`, and migrations are plain SQL we can review.

## D6. Shared-schema tenancy with `org_id` + row-level security

**Decision:** all tenants share tables. Every tenant table has `org_id NOT NULL`. Two layers enforce isolation:

1. Repository functions require `orgId`.
2. Postgres row-level security policies check `current_setting('app.org_id')`, set per transaction.

The app connects as a non-owner role, so row-level security applies to it.

**Alternatives:**

- **Schema per tenant:** stronger isolation, but migrations run N times and connection pooling gets harder.
- **Database per tenant:** strongest isolation and good for enterprise residency, but expensive and operationally heavy early on.

**Why:** cheapest to run and query across orgs for billing and ops. Row-level security means one missing `WHERE org_id =` cannot leak data (requirement: "never allow cross-org access").

**Cost:** background jobs must set the org context too, and admin or ops queries use a separate role that bypasses row-level security. Both are covered by tests.

## D7. WebSocket first for real-time audio, WebRTC later

**Decision:** the voice engine speaks WebSocket first: binary PCM frames plus JSON control frames, with a versioned protocol. All transports implement one `Transport` interface. WebRTC is added later by having the voice node join a LiveKit room as a participant.

**Alternatives:**

- **WebRTC first:** better on lossy mobile networks (UDP, Opus, built-in jitter buffer and echo cancellation), but needs TURN/SFU infrastructure and a more complex server.
- **SIP/RTP directly:** needed eventually for bring-your-own carrier, but not for launch.

**Why:**

- Twilio and Telnyx deliver call media over WebSocket anyway.
- Today's app already works over WebSocket with good client-side voice activity detection.
- Server-to-server integrations ("stream audio from my backend") want WebSocket.

Binary frames remove today's base64-in-JSON overhead (W14).

**Revisit:** when web-call quality data shows packet loss or jitter problems, or a customer needs mobile-network robustness.

## D8. Connection-owner session model

**Decision:** the voice node that accepts a call's media connection owns that `CallSession` for its whole life. Ownership and node heartbeats go to Redis. Control messages go over the Redis pub/sub channel `call:{id}:control`. Nodes advertise capacity through readiness checks. Deploys drain gracefully. A reaper closes out calls on dead nodes.

**Alternatives:**

- **Pre-allocate a node in the API and route to it** (sticky routing or per-node hostnames, for example Fly's `fly-replay`): more control over placement, but needs special load-balancer routing on every host.
- **One container or process per call** (spawned on demand): strongest isolation, but start-up latency and cost are unacceptable for inbound calls.
- **Agent-dispatch frameworks** (for example LiveKit Agents workers): good, but tie us to that framework and to WebRTC.

**Why:** it works behind any least-connections load balancer, needs no routing tricks, and the API never needs to know where a call lives.

**Risk:** calls on a crashed node are lost. We accept this for v1; mid-call migration is out of scope.

## D9. Pipeline supports cascaded and realtime modes

**Decision:** `CallSession` supports three modes:

1. **Cascaded:** streaming STT → LLM → TTS.
2. **Realtime:** a speech-to-speech provider handles both directions.
3. **Realtime-LLM + external TTS:** today's Gemini Live + ElevenLabs setup.

The mode is per assistant.

**Alternatives:**

- **Cascaded only:** most control, and every stage can be swapped, but it loses the latency and prosody advantages of realtime models.
- **Realtime only:** fewer vendors, but limited voices, languages and tool control.

**Why:** Bangla quality differs a lot by vendor. Today's hybrid exists precisely because Gemini's own Bangla voice was not good enough. Customers will want to choose.

**Known cost:** in mode 3, the realtime provider may still bill for audio output that we discard (W12). The adapter should request text-only output where the provider allows it.

## D10. BullMQ on Redis for background jobs

**Decision:** BullMQ queues: `webhooks`, `kb-ingest`, `call-finalize`, `call-analysis`, `campaign-dial`, `evals`, `simulations`, `usage-aggregate`, `retention`. Repeatable jobs handle schedules.

**Alternatives:**

- **pg-boss:** Postgres-only, so one less system, but we need Redis anyway for the registry and pub/sub, and BullMQ has built-in rate limiting and flows.
- **AWS SQS:** ties us to AWS; no delayed jobs beyond 15 minutes.
- **Temporal / Inngest:** great for long workflows such as campaigns, but a big operational and learning cost for now.

**Why:** we already need Redis. BullMQ gives retries with backoff, delays (campaign calling windows, webhook retries), per-queue concurrency, rate limiting (outbound dial rate), and a dashboard.

## D11. Call events via Redis Streams into a partitioned Postgres table

**Decision:** the voice engine `XADD`s events to a Redis Stream. A worker consumer group batch-inserts them into `call_event`, which is partitioned monthly. Transcript segments go the same way. Call start and end state changes are written directly.

**Alternatives:**

- **Direct Postgres writes from the voice engine:** simpler, but a database slowdown would then stall audio.
- **ClickHouse or another time-series store:** better for analytics at scale; add later if Postgres partitions are not enough.

**Why:** keeps database latency off the audio hot path. Events survive a node crash because they are already in Redis. Monthly partitions make retention a cheap `DROP PARTITION`.

## D12. S3-compatible object storage for recordings and files

**Decision:** S3-compatible storage: AWS S3 or Cloudflare R2 in production, MinIO in docker compose for dev and tests.

- Keys: `org/{org_id}/recordings/{call_id}.wav` and `org/{org_id}/files/{file_id}`.
- Server-side encryption.
- Access only via short-lived presigned URLs.
- Lifecycle rules enforce retention.
- Uploads go straight from the client via presigned PUT.

**Alternatives:**

- **Postgres bytea:** simple, but bloats backups and costs a lot per GB.
- **Local disk** (today): ephemeral on most hosts, and cannot work with more than one node.

**Why:** cheap, durable, streamable and host-independent. R2 has no egress fees, which matters for recording playback. Per-org prefixes simplify export and delete requests.

## D13. pgvector for knowledge-base search

**Decision:** embeddings live in `knowledge_chunk.embedding` with an HNSW index. Every search filters by `org_id` and `knowledge_base_id`.

**Alternatives:** Pinecone, Qdrant or Weaviate. They are better at very large scale and have hybrid search built in, but they add a service, a bill, and a second place to enforce tenancy.

**Why:** tenancy and row-level security apply automatically, it runs in the same transaction as the metadata, and there is one fewer system. Postgres full-text or trigram search can provide the lexical half of hybrid search.

**Revisit:** above tens of millions of chunks, or if query latency beats our budget.

## D14. First-party auth for the dashboard; hashed API keys

**Decision (proposed):** keep first-party email + password auth, ported and hardened from today's code:

- Async scrypt or argon2 instead of `scryptSync`.
- Sessions and reset tokens in Postgres, not in memory.
- Email verification.
- Rate limits.
- Invitations to orgs.

API keys come in two types:

- **Private** (`sk_…`): full org scope, server-side only.
- **Public** (`pk_…`): restricted to assistants and origins; exchanged for a short-lived call token.

Keys are shown once and stored as a SHA-256 hash.

**Alternatives:**

- **Clerk / Auth0 / WorkOS:** SSO, MFA and orgs out of the box, and enterprise SSO (SAML) becomes easy. Costs money per user and adds an external dependency on the login path.
- **better-auth / Lucia-style library:** less code to own, still self-hosted.

**Why:** today's model (scrypt + hashed session tokens + HttpOnly cookie) is sound and only needs hardening. The choice is **open**: if enterprise SSO is needed soon, WorkOS or Clerk is the better call.

## D15. zod as the single schema source → OpenAPI → SDKs

**Decision:** zod schemas define env config, request and response bodies, assistant config, and the WebSocket control protocol. They generate the OpenAPI 3.1 document, which generates the TS and Python SDKs.

**Alternatives:**

- **TypeBox:** JSON Schema native and fast in Fastify, but less ergonomic for complex config validation.
- **Hand-written OpenAPI:** drifts from the code.

**Why:** one definition gives runtime validation, types, docs and SDKs, and avoids drift in a public API.

## D16. pino + OpenTelemetry + Prometheus + Sentry

**Decision:**

- pino for structured JSON logs, with a context logger carrying `request_id`, `call_id`, `org_id`.
- OpenTelemetry SDK for traces.
- `prom-client` for metrics at `/metrics`.
- Sentry for exceptions.

**Alternatives:** a single vendor such as Datadog (easiest, expensive at call-event volume), or plain logs only (what we have; no latency visibility).

**Why:** vendor-neutral. Any backend works (Grafana Cloud, Honeycomb, Datadog). Latency per turn is the product's core quality metric and needs histograms and traces, not log grepping.

## D17. Env vars for platform secrets, envelope encryption for org credentials

**Decision:**

- Platform secrets (provider keys, database URL, signing keys) come only from environment variables. They are validated at boot by a zod env schema and documented in `.env.example`.
- Org-provided secrets (bring-your-own provider keys, telephony credentials, webhook signing secrets) are encrypted with AES-256-GCM.
- The data key is wrapped by KMS in production, or by `CREDENTIALS_ENCRYPTION_KEY` elsewhere. A key version is stored for rotation.

**Alternatives:** HashiCorp Vault (strong, but heavy to run), or storing org secrets in plain text (unacceptable).

**Why:** meets the "never hard-code secrets" rule and keeps a database dump from leaking customer keys.

## D18. New Next.js dashboard; the existing Vite app becomes the demo

**Decision:** build `apps/dashboard` in Next.js (App Router) + Tailwind. The existing Vite/React Bangla UI stays in `apps/legacy` unchanged. In Phase 5 it is rebuilt on `@octo/web` as the reference demo and playground.

**Alternatives:** grow the existing Vite SPA into the dashboard. It works, but it has no routing, auth-aware server rendering or layout system, and it would need restructuring anyway.

**Why:** requested stack; a clean start for a multi-page authenticated app; the legacy app keeps working meanwhile.

## D19. Vitest, provider fakes, real Postgres and Redis in tests

**Decision:**

- **Unit:** Vitest for pure logic (audio gate, barge-in, relay batching, turn manager, config validation, signing).
- **Integration:** Fastify `inject` against real Postgres and Redis from docker compose or Testcontainers.
- **Providers:** faked with deterministic in-memory adapters that implement the same interfaces, with scripted latency and errors, so tests run offline.
- **Voice:** an engine test harness drives a `CallSession` through the loopback transport with recorded PCM fixtures.
- **Load:** k6, or a simulation runner for concurrent sessions, before GA.

**Alternatives:** Jest (slower, weaker ESM/TS support), or mocking the database (misses row-level security and migration bugs).

**Why:** row-level security and migrations must be tested against real Postgres. Offline provider fakes keep CI free and deterministic.

## D20. Docker images; leave Render free

**Decision (host open):** everything ships as Docker images with `docker-compose.yml` for local dev (Postgres + pgvector, Redis, MinIO). Production host is still to be chosen. Requirements:

- Managed Postgres and Redis
- Long-lived WebSockets
- Configurable stop timeout of several minutes for draining
- A region near the main user base (for Bangladesh: Singapore or Mumbai)

**Options:**

- **Fly.io:** simple, regional, WebSocket-friendly, and `fly-replay` if we ever need routing.
- **AWS ECS/Fargate + RDS + ElastiCache:** most enterprise-ready, but more setup, and ECS caps the stop timeout (verify it fits our drain need).
- **A VPS with Docker Compose:** cheapest, and fine for the first customers, but no automatic failover.

**Why not Render free:** ephemeral disk, instances spin down (dropping calls), single instance (W26).

## D21. Strangler migration of the existing app

**Decision:**

- The platform is built alongside today's app.
- Today's app keeps running until the platform reaches feature parity for its use case (Phase 5 web calls + Phase 6 knowledge base).
- Its behaviour then becomes data: a default org, one Assistant whose config holds today's Bangla prompt, greeting, voice and model settings, and a knowledge base imported from the seed docs and uploads.
- A one-off, idempotent import script migrates users and documents.

**Alternatives:** rewrite in place (breaks the working product for weeks), or freeze and abandon the old app (loses the one real user base and the test bed).

**Why:** follows rule 4 (do not break existing behaviour), and gives us a real assistant to validate every phase against.

## D22. Immutable assistant versions; calls pin a version

**Decision:** editing an assistant creates a new `AssistantVersion`. Publishing points `assistant.published_version_id` at it. Every `Call` stores the version it ran on. Evals run against a specific version.

**Alternatives:** a mutable assistant row with an audit log. Simpler, but you cannot reproduce a past call, compare versions in evals, or roll back safely.

**Why:** debugging ("why did it say that on Tuesday?"), safe rollbacks, and eval comparisons all need exact configs.

## D23. Signed, retried webhooks with a delivery log

**Decision:**

- Outbound events are signed: an `X-Octo-Signature` header with HMAC-SHA256 over `timestamp + "." + body`, rejected if older than 5 minutes.
- Delivered by BullMQ with exponential backoff (about 24 h total) and logged in `webhook_delivery`.
- Idempotent through `event_id`.
- **Synchronous** hooks (`assistant-request` on inbound calls, function-tool calls) have strict timeouts and **no retries**, because the caller is waiting. They fall back to the configured assistant or tool failure message.

**Alternatives:** fire-and-forget POSTs (lost events), or a third-party service such as Svix (good; consider if webhook volume or features grow).

**Why:** customers build billing and CRM on these events, so they need reliability and verifiability.

## D24. Drop the voice-memory PII extractor

**Decision (proposed):** do not port `storeImportantVoiceData`. It extracts and stores passwords, OTPs, card data and health data (W3). Long-term memory, if wanted, becomes an opt-in, per-assistant feature with:

- An explicit allow-list of fields
- Redaction of secrets and card data
- Retention limits

**Alternatives:** port it as-is (compliance risk: storing card or authentication data breaks PCI-DSS), or fix only the keyword trigger.

**Why:** a platform cannot ship a feature that collects the most sensitive data categories by default. **Open question:** does any current user depend on it?

## D25. ElevenLabs Scribe v2 Realtime for streaming STT, manual commits

**Decision:** the cascaded pipeline's first STT adapter is ElevenLabs Scribe v2 Realtime over WebSocket, with `commit_strategy=manual`. The engine's own endpointer decides when the user finished and sends the commit. The owner chose the provider on 2026-10-01.

**Alternatives:**

- **Deepgram:** very low latency, but a new vendor, and its Bangla support is weaker or unclear.
- **Gemini batch transcription after the endpoint:** no new vendor, but adds about 0.5–1.5 s per turn and has no partials.
- **Scribe with `commit_strategy=vad`:** less code, but the endpointing would sit inside the vendor. Then per-assistant `silenceMs`, barge-in and the latency timestamps would depend on the vendor's VAD.

**Why:** the existing `ELEVENLABS_API_KEY` works, it supports Bengali, it streams partials with about 150 ms latency, and manual commits keep turn-taking provider-independent. **Measured:** commit → final is about 0.4 s.

## D26. Build the engine in `packages/engine` before the monorepo; run standalone

**Decision:** the voice engine was built as a self-contained folder that matches the proposed layout (section 3.7 of ARCHITECTURE). It does not use pnpm workspaces yet. It runs through its own dev server (`npm run voice:dev`). The legacy `/ws/live` Gemini Live path is unchanged. The owner chose this on 2026-10-01.

**Alternatives:** do the Phase 1 monorepo restructure first (blocked on open questions 3 and 4), or build inside `server/` (couples the engine to code we plan to retire).

**Why:** it unblocks the core engine without deciding repo hygiene. The engine imports nothing from the legacy app, so it moves into the monorepo unchanged. **Cost:** dependencies (`zod`, `vitest`) went into the root `package.json` for now.

## D27. Energy VAD with a minimum-statistics noise floor for v1

**Decision:** speech is a 20 ms frame more than `vadMarginDb` above the noise floor. The floor is the quietest frame in the last 1.5 s, seeded with a quiet-room prior of −65 dBFS. Turn start needs `minSpeechMs`; turn end needs `silenceMs`. While the agent talks, the threshold rises by `echoGuardDb`.

**Alternatives:**

- **Exponential-average floor with warm-up:** tried first. It learned a caller who talks immediately as "noise" and missed their first turn.
- **Neural VAD (Silero via onnxruntime):** more robust to background speech, but adds a native dependency and per-frame CPU.
- **The STT vendor's VAD:** see D25.

**Why:** no dependencies, deterministic, testable, and good enough with browser noise suppression and telephony audio. **Known gap:** TV or other people talking nearby can trigger turns or barge-ins. Revisit with Silero or a semantic turn detector once evals exist (Phase 12).

## D28. Provider failure keeps its `error-*` end reason even when it transfers

**Decision (proposed):** when a provider fails and `fallback.action` is `transfer`, the call's `endReason` stays `error-stt` / `error-llm` / `error-tts`, and the summary also carries `transferredTo`. `transferred` is used only when the model asked to transfer. An extra value, `error-internal`, covers engine bugs and failed transfers.

**Alternatives:** report `transferred` (hides the failure from error-rate dashboards), or add combined values such as `error-llm-transferred`.

**Why:** error-rate metrics and alerts must count every provider failure. **Open question:** does the owner want transfers counted under `transferred` for billing or reporting?

## D29. Latency definitions: voice-to-voice includes the endpointing wait

**Decision (proposed):** `voiceToVoiceMs` runs from the end of the user's speech (last VAD speech frame) to the first agent audio leaving the engine, so it includes the `silenceMs` wait. `pipelineMs` runs from the endpoint to the first audio and excludes that wait. Both get p50/p95.

**Alternatives:** measure from the endpoint only (looks better, but hides the biggest part of perceived delay), or to client playback (needs client reports; add later from the web SDK).

**Why:** it matches what the caller experiences. With a fixed `silenceMs` of 600, an 800 ms voice-to-voice target leaves only 200 ms for STT, LLM and TTS together. So the target needs smarter endpointing (shorter silence plus semantic end-of-turn detection) as well as faster providers.

## D30. Provider set v1: Deepgram, OpenAI, Cartesia added; custom endpoint per component

**Decision:** behind the new `Transcriber` / `LanguageModel` / `VoiceSynthesizer` interfaces:

- Transcribers: ElevenLabs Scribe (existing), Deepgram Nova-3 and custom.
- Models: Google Gemini (existing), OpenAI Chat Completions and custom.
- Voices: ElevenLabs (existing), Cartesia Sonic 3.6 and custom.

The owner chose the vendors on 2026-10-01. All support Bengali per their docs, checked the same day.

**Alternatives offered:** OpenAI, Azure or Google STT; Anthropic Claude or Groq for the LLM; Azure or OpenAI TTS. They are easy to add later through the registry and the contract suite.

**Why:** these are the common low-latency choices, and they give each component a second vendor for fallbacks. OpenAI's wire format doubles as the protocol for custom LLMs.

## D31. Presets + per-component override; balanced = current stack

**Decision (proposed):**

- `fast`: Deepgram, GPT-4.1 mini, Cartesia, `silenceMs` 400.
- `balanced` (default): Scribe, Gemini 3.1 Flash-Lite, ElevenLabs v3 conversational, `silenceMs` 600.
- `quality`: Scribe, GPT-4.1, ElevenLabs v3, `silenceMs` 800.

Each preset falls back to the other vendors.

An assistant component with the same provider merges into the preset's component. A component with a different provider replaces it, fallbacks included.

**Why:** the default must not change behaviour, so `balanced` is exactly the stack measured on 2026-10-01. The replace-on-provider-change rule avoids invalid mixes, such as Cartesia fields on an ElevenLabs voice. **Open:** the model choices in `fast` and `quality` are educated defaults, not yet measured (no keys).

## D32. Org credentials behind an org-scoped store interface; in-memory until Phase 2

**Decision:**

- `CredentialService` does AES-256-GCM envelope encryption (D17), with AAD = org + record + provider, master key ids for rotation, masked views only, and `Secret` objects that redact themselves.
- It sits on a `CredentialStore` interface where every method takes `orgId`.
- The only store for now is in memory. The Postgres table with row-level security and the HTTP endpoints come with Phase 2 auth.

The owner chose this on 2026-10-01.

**Alternatives:** an encrypted local file store; doing Phase 1–2 first.

**Why:** no database, orgs or auth exist yet (and no Postgres on the dev machine). Exposing key endpoints without auth would be unsafe.

## D33. Fallback only before output, sticky per call; retries per provider

**Decision (proposed):**

- Each component is an ordered chain.
- A provider is retried `retries` times (default 1) and then abandoned for the next one, but only if it failed before producing output. Non-retryable errors (bad key) skip the retry.
- A switch is sticky for the rest of the call.
- Voice fallbacks are converted to the primary's audio format.
- Fallbacks without credentials are skipped at call start.

**Alternatives:** switch mid-utterance (would repeat or mix speech), or retry the primary on every turn (adds the failure latency to every turn).

**Why:** the caller should never hear a sentence twice or wait for a known-bad provider again. **Not yet:** a circuit breaker across calls.

## D34. Usage metering in the engine; estimated tokens flagged

**Decision (proposed):** the chains meter units against the provider that actually ran. The units are audio seconds sent to STT, LLM tokens as reported by the provider, characters of TTS requests that produced audio, audio seconds received, and requests. Each record also carries the credential source and billing (`platform` or `customer`).

When an LLM stream is cut off (barge-in) and the provider sends no counts, tokens are estimated at about 4 characters per token and the record is flagged `estimated`.

**Why:** billing needs who-paid-for-what per call. Vendors still bill for interrupted streams, so dropping those would under-count.

**Open question:** should platform pricing for BYOK calls charge a platform fee per minute only? (Phase 13.)

## D35. Custom endpoint contract v1 and SSRF policy

**Decision (proposed):**

- **Custom model:** OpenAI-compatible SSE chat completions.
- **Custom voice:** POST JSON, returns streamed raw PCM16.
- **Custom transcriber:** WebSocket with `start`/`commit` JSON control messages, binary PCM16 frames, and `partial`/`final` replies.
- **Auth:** an optional bearer secret, stored as an org credential.
- **Allowed endpoints:** `https`/`wss` only, no credentials in the URL.
- **Blocked addresses:** every address a host resolves to is checked at connect time. Private, loopback, link-local, CGNAT, multicast and metadata ranges are refused. The check runs inside the connection's lookup, so DNS rebinding cannot slip past it.
- **Dev override:** `CUSTOM_ENDPOINTS_ALLOW_PRIVATE=true` relaxes this, and is refused in production.

**Why:** these endpoints are customer-controlled URLs called from our network, a classic SSRF vector. The formats follow Vapi's conventions, which customers already know. This is a public API, so changes need a version bump.

## D36. Hand-written SQL migrations + thin query layer instead of Drizzle (for now)

**Decision (proposed):**

- **Migrations** are numbered `.sql` files. They are applied in order, each in its own transaction, recorded in `schema_migration`, and pinned by checksum in `migrations/checksums.json`. Editing an applied migration fails the tests and fails startup.
- **Queries** are parameterized SQL through a small `Database` interface over node-postgres or PGlite. There is no ORM.

This supersedes the "Drizzle" part of D5. The forward-only migrations of D5 stand.

**Alternatives:** Drizzle schema plus drizzle-kit generated migrations, with custom SQL for roles, RLS and grants.

**Why:** the security-critical parts (roles, row-level security policies, column grants) are SQL anyway, and reviewing them in one plain file is easier. Keeping a TypeScript schema and a SQL schema in sync would add a source of drift. Revisit if query volume makes a query builder worth it.

## D37. Owner connection only for identity lookups; tenant work as octo_app under RLS

**Decision (proposed):**

- Tenant tables have row-level security enabled but not `FORCE`d.
- All tenant work runs in `withOrg` transactions as the non-owner role `octo_app`, so the policies always apply.
- The owner connection, which bypasses the policies, is used only for lookups that happen before an org is known, and for org creation and deletion. These are users by email, sessions and API keys by hash, and invitations by token, all in `apps/api/src/auth` and the org-lifecycle routes.
- `octo_app` can only insert and read audit rows, and cannot read password hashes.

**Alternatives:** `FORCE ROW LEVEL SECURITY` plus a `BYPASSRLS` role or `SECURITY DEFINER` functions for lookups. That needs superuser-only role attributes, which managed Postgres often restricts, and adds more moving parts.

**Why:** both layers stay in place for all tenant data, and the bypass is small and in one place. Tests prove a query without an org filter still sees one org, and mutation-testing showed the suite catches a leak when both layers are removed.

## D38. PGlite for development and tests; real Postgres in production

**Decision:** tests and local development run PGlite, which is PostgreSQL 18 compiled to WASM, running in-process. Production uses node-postgres against PostgreSQL 16+, and refuses PGlite when `NODE_ENV=production`. The owner chose this on 2026-10-01.

**Why:** there is no Docker or Postgres on the development machine, and PGlite runs the same SQL, row-level security and roles, verified before adoption. **Caveats:** a PGlite folder must only be opened by one process at a time. The real-Postgres path is not yet exercised in CI.

## D39. Server-side sessions in an HttpOnly cookie, CSRF by Origin check

**Decision:**

- The session token is 256 random bits, sent in the `octo_session` cookie (HttpOnly, SameSite=Lax, Secure in production) and stored as SHA-256.
- Sessions last 30 days, and end after 7 days without activity.
- State-changing cookie requests must carry an `Origin` from `DASHBOARD_ORIGINS`.
- Logout and password reset revoke sessions instantly.

The owner chose this on 2026-10-01.

**Alternatives:** JWT access tokens plus refresh tokens. Revocation would lag by the access token's lifetime, and the code is more complex.

## D40. Permission matrix; private keys = admin set, public keys = calls only

**Decision (proposed):** one matrix in `permissions.ts` drives enforcement, tests and docs.

- **Private keys** get the admin permission set: full server access, but no org deletion and no owner changes.
- **Public keys** only get `calls:create`, from allowed origins, for allowed assistants. An empty assistant list means any of the org's assistants.
- **Owners:** only owners touch the owner role, and an org always keeps one owner.
- **Foreign ids** answer 404, never 403.

**Open question:** should private keys be able to create or revoke other keys? They can now, which matches Vapi. Scoped keys (`scopes`) are a later addition.

## D41. In-memory token-bucket rate limits behind an interface

**Decision (proposed):**

- Token buckets per API key and per org, with defaults from env and overrides per key and per org.
- Auth endpoints are limited per IP and per email.
- Over the limit: 429 with `Retry-After`. Responses also carry the `X-RateLimit-*` headers.

**Why:** simple and exact on one node. **Must change before scaling out:** a Redis implementation of the same `RateLimiter` interface.

## D42. API conventions: error shape, cursor pagination, opt-in idempotency, 404 for foreign ids

**Decision (proposed):**

- Errors always use `{code, message, details}`, with stable codes.
- Lists use `limit` plus an opaque keyset cursor. The cursor carries Postgres' microsecond timestamp, so rows created in the same millisecond are never skipped.
- `Idempotency-Key` is supported on routes that opt in (call creation and charges). It is org-scoped, kept 24 h, replays the stored response, answers 422 on reuse with a different body, and doesn't store 5xx responses.
- Bodies and fields are camelCase.

See [API.md](API.md).

## D43. Browser calls over WebSocket with the browser's echo cancellation; WebRTC later

**Decision (accepted 2026-10-01):** confirms D7 for the web SDK. Browsers send PCM16 16 kHz and receive PCM16 24 kHz over one WebSocket (protocol v1). Echo cancellation, noise suppression and auto gain come from `getUserMedia` constraints, so the browser's own audio processing runs before our AudioWorklet.

**Alternatives:** WebRTC through LiveKit (better on lossy mobile networks, Opus, jitter buffer) needs a LiveKit deployment and TURN, roughly doubling the scope.

**Why:** no new infrastructure; telephony already uses WebSocket media; the `Transport` interface keeps WebRTC additive. **Revisit:** when call-quality data from mobile networks shows audio gaps.

## D44. Public keys: saved assistants and a safe override allowlist; inline configs via server-minted calls

**Decision (accepted 2026-10-01):**

- A public key can start calls only for saved, published assistants (in its `allowedAssistantIds` when set), from its `allowedOrigins`.
- Its overrides are limited to `firstMessage`, `firstMessageMode`, `language`, `endpointing`, `interruption`, `idle` and `voice.voiceId`.
- Inline assistants and other overrides are done by the customer's server with a private key; the browser connects that call with `start({ call })`.
- The media socket is bound to the origin the call was created for.

**Alternatives:** per-key opt-in flags for inline configs and full overrides; keeping unrestricted overrides.

**Why:** public keys are readable by anyone who opens the page. Unrestricted overrides let a copied key rewrite the system prompt and model and spend the org's LLM credit on arbitrary use. **Open:** an opt-in flag per key, if customers ask for it.

## D45. Browser media endpoint in `apps/api` (single node), token in the first frame, in-memory resume

**Decision (accepted 2026-10-01):**

- `GET /v1/calls/{id}/connect` runs in the API process.
- The connect token goes in the first WebSocket frame, not the URL, so it never reaches access logs.
- The resume token and the live session are in memory; a dropped client has `VOICE_RESUME_GRACE_MS` to come back.

**Alternatives:** a separate `apps/voice` process now (target architecture, D2/D8), which without Redis cannot share the control channel or resume state.

**Why:** the control API's `LiveCallRegistry` works unchanged, and nothing else is needed to ship. **Must change before running two API nodes:** the Redis call registry and control channel (3.5), then move the endpoint to `apps/voice`.

## D46. Mobile: React Native WebView hosting the widget

**Decision (accepted 2026-10-01):** the mobile example is an Expo app that loads the widget in `react-native-webview`, with the page's `baseUrl` as an allowed origin.

**Alternatives:** React Native with native audio modules (no reliable echo cancellation on speakerphone), or a Flutter client (a second protocol implementation to maintain).

**Why:** the same SDK and the browser's echo cancellation, with no native audio code. **Revisit:** if customers need background audio or a native UI, build a native audio module against protocol v1.

## D47. Text conversations reuse the assistant engine through a stateless text turn; sessions in Postgres

**Decision (accepted 2026-10-01):** a `runTextTurn` in the engine runs one message through the same config, model chain, function tools and squad handoffs as a call, skipping STT/TTS. Sessions and messages live in Postgres, so any API node can answer the next message. A session pins its spec (or each squad member's) when it starts.

**Alternatives:** reuse `CallSession`'s chat mode (WebSocket, one process, real-time timers) for HTTP and SMS too.

**Why:** HTTP and SMS conversations span minutes to days and many requests; a stateless turn plus stored history scales across nodes and survives restarts. The WebSocket chat mode stays for live widget sessions.

## D48. SMS is an optional channel behind a messaging adapter; org-wide opt-out; async replies

**Decision (accepted 2026-10-01):**

- SMS answers only on numbers with the `sms` capability.
- Twilio is the first adapter, behind an interface WhatsApp can use next.
- Webhooks are acknowledged at once and answered asynchronously through the REST API.
- STOP-style keywords opt the customer out for the whole org.

**Alternatives:** reply inside the webhook (TwiML `<Message>`), which risks the provider's webhook timeout when tools are slow; opt-out per number.

**Why:** in Bangladesh, SMS is lower priority than phone, web voice and WhatsApp (owner, 2026-10-01). An org-wide opt-out is the stricter, safer reading of carrier rules. Sends are not retried after a timeout, since the provider may have accepted the message.

## D49. Chat usage records with a per-org billing unit (message or token); webhooks as queued rows

**Decision (accepted 2026-10-01):**

- Each chat turn writes a `usage_record` with messages, tokens, provider, model and payer.
- Its `quantity` is in the org's `chat_billing_unit`.
- Chat events are written as pending `webhook_delivery` rows.
- Knowledge base and analysis are deferred to their phases.

**Alternatives:** building price tables, analysis and a minimal knowledge base now.

**Why:** metering is the input billing needs, and prices belong to Phase 13. Analysis and the knowledge base don't exist for calls either; building them for chat alone would split the design.

## D50. OpenAI-compatible endpoint keeps OpenAI semantics; the assistant's prompt and tools always apply

**Decision (accepted 2026-10-01):**

- `model` is the assistant (or `squad:<id>`); the client's `messages` are the history.
- The assistant's system prompt, tools and squad always apply; client system messages are appended as instructions.
- Client-defined tools are refused.
- Private keys only.
- Every request is a recorded session; `x-octo-session-id` groups requests.

**Alternatives:** server sessions only (surprising for OpenAI client code that sends full history).

**Why:** existing OpenAI client code works unchanged, while the assistant's guardrails stay in force.

## D51. Campaign dialer is a Postgres-backed queue with an attempt ledger, running in the API process for now

**Decision (accepted 2026-10-02):** the dialer is a loop in the API process (`CAMPAIGN_DIALER_ENABLED`). Work is claimed from Postgres, not from Redis:

- A tick takes a per-org advisory lock, counts the concurrency and pacing budgets, picks due contacts with `FOR UPDATE SKIP LOCKED`, marks each contact `calling`, and inserts a `campaign_attempt` row, all in one transaction.
- A unique index on live attempts `(contact_id, attempt_no)` is the idempotency guard.
- The provider request is never inside a transaction.

**Alternatives:** BullMQ + Redis, as D10 and ARCHITECTURE 3.2 describe (needs Redis and new dependencies, and tests need a Redis fake or Docker; the attempt ledger would still live in Postgres for idempotency).

**Why:** no new infrastructure, restart safety comes from rows that survive a crash instead of queue state, and the guarantee is a database constraint that tests exercise. The owner chose this on 2026-10-02. **Revisit:** when the dialer moves to `apps/worker` (the same code runs there unchanged), or when dial volume makes polling Postgres costly. **Not yet exercised:** two real Postgres connections racing. PGlite has one connection, so tests prove the constraint and the claim logic, not lock contention.

## D52. At most one provider dial per attempt; unconfirmed and lost calls are never retried

**Decision (proposed):** an attempt moves `claimed` (nothing sent, safe to release) → `dialing` (the provider request is being or was made) → `ringing` → `in-progress` → `done`.

- Just before the request the dialer re-checks the campaign state, the do-not-call list and the calling hours, and only then marks the attempt `dialing` and creates the call row.
- A `claimed` row older than a minute is released (the process died before dialing): the contact goes back to `pending` with its attempt counter restored.
- A `dialing` row with no provider report after `CAMPAIGN_DIAL_CONFIRM_SECONDS` becomes `unconfirmed`. A ringing or connected call with no final event after `CAMPAIGN_CALL_TIMEOUT_MINUTES` becomes `lost`. Neither is retried.
- A late provider report can still correct an `unconfirmed` or `lost` attempt (for example to `answered`), unless a later attempt has started.
- Dial errors: the provider answering `5xx`/`429` is retried (nothing was placed); `4xx` is a permanent failure; a timeout or a lost connection is `unconfirmed`.

**Alternatives:** retry unconfirmed dials (risks ringing someone twice), or keep the call in `dialing` forever (a leaked concurrency slot).

**Why:** the requirement is "never double-call anyone"; Twilio's call API has no idempotency key, so the only safe rule is that a request that may have been sent is not sent again. The cost is that a lost provider callback can cost a contact their retries.

## D53. Calling hours: the contact's local schedule cut to a platform limit, checked at claim and again before every dial

**Decision (proposed):** a campaign schedule is local dates, ISO weekdays and a same-day window, all evaluated in the **contact's** time zone (CSV column, else the country's single zone, else the campaign default). The effective window is the intersection with the platform limit `CAMPAIGN_HARD_CAP_START`..`CAMPAIGN_HARD_CAP_END`, 08:00-21:00 by default. A window wholly outside the limit is refused at creation. Contacts outside their window are deferred to the next allowed instant, not scanned again every tick.

**Alternatives:** the campaign's own window only (a misconfigured campaign could call at night); the org's time zone (wrong for contacts elsewhere).

**Why:** the "hard block" has to hold even when the campaign is wrong. **Open question for the owner:** the right limit differs by country and by regulator, and this has not been reviewed by anyone qualified. The default is a conservative general-purpose choice, not legal advice. Ask counsel what applies to the countries you call (including Bangladesh) before widening it.

## D54. Campaign outcomes come from the assistant's `reportOutcome` labels until structured outputs exist

**Decision (accepted 2026-10-02):** each campaign lists `outcomeLabels` (and the subset `successLabels`). The engine offers the assistant a `reportOutcome` tool restricted to those labels; the chosen label and notes are saved on the contact. The task text pointed at "structured outputs in Phase 8", but telephony is Phase 8 and post-call analysis is Phase 11 and unbuilt.

**Alternatives:** build a minimal per-assistant extraction schema now (Phase 11 scope), or report status only.

**Why:** the hook already exists in the engine and is tested. When structured outputs exist they can fill the same contact fields.

## D55. Campaign telephony scope: dialer plus a signed status callback; media gateway and per-number credentials stay in Phase 8

**Decision (accepted 2026-10-02):**

- The dialer places calls through the existing `TelephonyAdapter` and gives the provider a status-callback URL per attempt. The callback endpoint verifies the provider signature and feeds `applyProviderEvent`.
- Twilio dial errors say whether a call may have been placed (`TelephonyDialError`).
- Twilio credentials for campaigns come from the platform env vars, as SMS does. A Twilio number without them pauses the campaign (`telephony-not-configured`) without spending attempts.

- In production only providers with a real adapter (`twilio`, see `services/campaigns/providers.ts`) may dial or send callbacks. The SIP, Telnyx and Vonage adapters are stand-ins whose signature check accepts everything and whose dials place no call, so a campaign on them would silently "dial" nobody, and a callback could be forged. A Twilio callback with no `TWILIO_WEBHOOK_SECRET` is refused too, because an empty-key HMAC is computable by anyone. (The existing inbound webhook, `/v1/telephony/{provider}/webhook`, has the same exposure and is outside this task.)

**Not done:** the media-stream gateway (`createTransport` still throws), so a campaign call connects but no `CallSession` runs on it; per-number provider credentials. Until then outcomes beyond answered/voicemail/no-answer/busy need the gateway to call `campaignHooksForCall` (provided and tested).

## D56. Campaign cost is reported as usage units, not money, until price tables exist

**Decision (accepted 2026-10-02):** campaign stats report call seconds and the provider units summed from `call.usage` (STT audio seconds, LLM tokens, TTS characters). No currency amount is computed.

**Alternatives:** env-configured rates (estimates that would be mistaken for billing), or leaving cost out.

**Why:** pricing and who pays (platform or the org's own key) belong to Phase 13. The units are the input it will need.

## D57. What "completed conversation", retry and success rate mean for campaigns

**Decision (proposed, an assumption the owner has not confirmed):**

- **Completed conversation:** the provider reports the call answered by a person (or unknown) and the platform did not fail during it. It is never retried. A platform failure (an `error-*`, `worker-lost` or `server-shutdown` end reason) makes it retryable. There is no minimum call length.
- **Voicemail:** an answering machine or fax detected by the provider counts as a voicemail and is retried like no-answer. No message is left yet.
- **Retry:** `maxRetries` extra attempts after the first, `delayMinutes` apart, each passing the calling-hours check again.
- **Success rate:** contacts reported with a success label ÷ contacts answered at least once.

**Alternatives:** require a minimum duration or a reported outcome label before a call counts as completed; treat a hang-up in the first seconds as not answered.

**Why:** these need no thresholds that would be guesses, and every rule is covered by a test. Teams that need "answered but hung up immediately" retried can raise this with the owner.

## D58. The analysis job is a Postgres row that is also its result, run by an in-process worker

**Decision (proposed, follows D51):** one `call_analysis` row per call holds the job state (status, attempts, `next_attempt_at`, lease) and the results. `AnalysisWorker` claims due rows per org with `FOR UPDATE SKIP LOCKED` and a lease, runs the model calls outside any transaction, saves after every step, and retries provider failures with backoff (30 s, 2 min, 8 min, ×4, at most an hour; `ANALYSIS_MAX_ATTEMPTS`, default 4). Every claim counts as an attempt, so a job that keeps killing its worker still ends as failed. Enqueueing is `INSERT ... ON CONFLICT DO NOTHING`.

**Alternatives:** BullMQ (D10; needs Redis); a separate results table (two rows to keep consistent).

**Why:** no new infrastructure, restart safety from durable rows, and the same pattern as the dialer. **Revisit** with D51: when this moves to `apps/worker`, and after a two-node test on real Postgres (PGlite has one connection).

## D59. Analysis runs on the call's own model chain

**Decision (accepted 2026-10-02):** the summary, success evaluation and extraction use the model component the call was configured with (the org's key if it stored one, else the platform key; the same timeouts, retries and fallbacks as the call). Cost is recorded as `platform` or `customer` accordingly. The analysis timeouts are longer than a live turn's (45 s to first token), because a finished call's transcript is large and nobody is waiting.

**Alternatives:** a dedicated `analysis.model` component, with platform defaults, so analysis could use a cheaper or stronger model.

**Why:** no new setting, no second place to configure keys, and costs follow the same key as the call. **Cost of the choice:** a fast, expensive live model also runs the analysis; add `analysis.model` if that matters.

## D60. Structured outputs are reusable org resources; the inline schema stays; the schema dialect is restricted

**Decision (accepted 2026-10-02 for the first two points):**

- A structured output is an org resource (name, JSON Schema, optional prompt) listed by many assistants in `analysis.structuredOutputIds`. Deleting is soft: finished calls keep a snapshot of the schema they were checked against, and an assistant that still lists a deleted output skips it.
- The assistant's inline `analysis.structuredData.schema` keeps working and is analysed like an output named `inline`. Nothing existing breaks.
- (Proposed) The accepted dialect is Ajv's JSON Schema with formats, an object at the top, at most 20,000 characters and 12 levels. `pattern` and `patternProperties` are refused, and `$ref` must point inside the schema. A customer-written regular expression run against model output on a shared process is a denial-of-service vector (ReDoS), and a remote `$ref` is an SSRF vector.
- Values are validated after every extraction. An invalid reply gets one corrective retry (with the validation errors fed back), then the output is recorded as failed and the other steps carry on.

**Alternatives:** replace the inline schema (a breaking API change); allow `pattern` with a regex-safety library (more code and risk).

**Why:** reuse without breaking anything; the restrictions close two abuse paths at no real cost (`enum`, `format`, length limits cover the common cases). **Adds** `ajv` and `ajv-formats` as direct dependencies (they were already installed through Fastify).

## D61. The end-of-call-report waits for the analysis, is sent once, and is delivered automatically; chat events are not

**Decision (accepted 2026-10-02):**

- The report is queued when the analysis reaches a final state (including `failed` and `skipped`), so it carries the results and is never stuck behind a failing model. Re-running an analysis does not send it again.
- The transcript is in the payload only for endpoints with `transcriptOptIn`; the call facts and analysis always are.
- A delivery worker sends call events (`call_id` set) automatically. Chat events keep waiting for manual redelivery, because turning delivery on for them would start traffic to endpoints that have never received any.

**Alternatives:** queue only (results not pushed); deliver everything (surprise traffic for chat endpoints).

**Why:** requirement 4 asks for the results in the webhook, which needs delivery. **Open:** whether chat events should follow now that a worker exists.

## D62. Webhook delivery: guarded client, long backoff, at least once

**Decision (proposed):** the worker uses the engine's guarded HTTP client (https only; private, loopback, link-local and metadata addresses refused at connect time, DNS rebinding included), a 10 s timeout, a lease so a crash mid-send is retried and two nodes never send one row, and 8 attempts at 30 s, 2 min, 10 min, 30 min, 1 h, 3 h and 6 h (about 11 hours) before the row is `dead`. Delivery is at least once; receivers de-duplicate on the event `id`. A deleted or disabled endpoint kills the row at once.

**Alternatives:** the existing redeliver route's unguarded `fetch` and 60-second cap (not safe to run automatically; D23 asks for about 24 h of retries).

**Why:** automatic sending to customer-supplied URLs is a classic SSRF risk, and a receiver outage of an hour should not lose the report. **Open:** D23's 24-hour window (this is about 11 hours; extending it is one array); the manual redeliver route still uses the unguarded client.

## D63. Transcript order, search and filter shape

**Decision (transcript and search proposed; the filter shape accepted 2026-10-02):**

- `seq` is the order; times say when something was said, so a tool call can start slightly after the assistant line it belongs to.
- Transcript search is full text with the `'simple'` configuration (whole words, no stemming), so it behaves the same in Bangla and English. Results are newest first, not ranked.
- Calls are filtered with `output.<field>=value` (any output of the call; `outputId` restricts it), `output.<field>.gte|gt|lte|lt=number`, plus fixed filters. Values are compared as text; ranges only on number fields.

**Alternatives:** `output.<name>.<field>`; a JSON search body; stemming per language; ranked search.

**Why:** the owner's choice for the filter; the rest avoids language-specific configuration for a first version. **Limit:** `output.*` filters scan JSON (see ARCHITECTURE 3.22).

## D64. Analysis covers every call that ends, and skips what it cannot analyse

**Decision (proposed):** a job is created for every call that ends (web calls, failed setups, campaign call results). It is skipped (`analysis-disabled` or `no-transcript`) when the assistant enables no step or the call has no spoken transcript, and the end-of-call-report is still sent. There is no per-call opt-out; an assistant opts out by leaving `analysis` empty.

**Alternatives:** create jobs only for assistants with analysis on (no report for the others); analyse chat sessions too.

**Why:** a uniform report for every call, and no assistant is analysed unless it asked. **Privacy note:** analysing sends transcripts to the model provider; retention and redaction controls arrive with Phase 13.
