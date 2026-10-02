# Voice of Octo: Progress

This file tracks the platform build phase by phase. Tick an item only when it meets the definition of done:

- It type-checks and passes lint.
- Tests pass.
- It was exercised manually.
- The docs are updated.

Design: [ARCHITECTURE.md](ARCHITECTURE.md). Decisions: [DECISIONS.md](DECISIONS.md).

The phase numbering and scope below were proposed in Phase 0. Confirm or reorder them before Phase 1 starts.

| Phase | Name | Status |
|---|---|---|
| 0 | Audit and target architecture | Done (2026-09-30) |
| 1 | Foundations | Partly done (2026-10-01): API server, DB + migrations, tests; monorepo, CI and Docker open |
| 2 | Auth, orgs, API keys | Done (2026-10-01) except the legacy user import (owner chose to leave legacy users alone) |
| 3 | Provider layer | Mostly done (2026-10-01): interfaces, 9 providers, registry, presets, BYOK credentials, fallbacks, usage; see below |
| 4 | Assistants API and tools | Partly done (2026-10-01): Assistant resource, tools API/executor, versioning, templates, variables, transient/override calls; transport adapters and knowledge-base joins open |
| 5 | Voice engine v1 + web SDK | Mostly done (2026-10-01): cascaded `CallSession`, live control API, browser media socket with resume, call persistence, `@octo/web` SDK and widget; `apps/voice` split, Redis registry and recordings open |
| 6 | Knowledge base | Not started |
| 7 | Webhooks and observability | Partly done (2026-10-01): scoped signed webhook endpoints, sync fallback helper, async delivery/dead-letter logs, retries, and manual redelivery; worker queue and event wiring open |
| 8 | Telephony | Partly done (2026-10-01): provider contract, Twilio signing/outbound adapter, SIP/fake boundary, PhoneNumber API, inbound/outbound routing, +880 validation and concurrency; live media gateway and provider provisioning adapters open |
| 9 | Dashboard | Not started |
| 10 | Squads, chat and SMS | Mostly done (2026-10-01): squads with live handoffs in text conversations, chat API with sessions and SSE, OpenAI-compatible API, optional SMS; live squad switching inside voice calls, WhatsApp and the dashboard open |
| 11 | Campaigns and call analysis | Mostly done (2026-10-02): campaigns, contacts, dialer, retries, do-not-call, controls and results; post-call analysis (summary, success evaluation, reusable structured outputs), transcripts with search, call filters and the end-of-call-report webhook with automatic delivery; dashboard, live phone conversation (Phase 8 gateway) and real-model verification open |
| 12 | Evals and simulations | Not started |
| 13 | Billing, compliance, SDKs/CLI, launch hardening | Partly done (baseline security review and hardening; privacy/compliance/enterprise controls open) |

---

## Call analysis and transcripts (built 2026-10-02) ✅

Task: analyse every call after it ends. Design: [ARCHITECTURE section 3.22](ARCHITECTURE.md#322-call-analysis-and-transcripts-v1-as-built). Endpoints: [API.md](API.md#call-analysis-transcripts-and-structured-outputs). Decisions D58-D64. The owner chose on 2026-10-02: the call's own model chain for the analysis, automatic delivery of call webhooks (chat events stay manual), `output.<field>=value` filters, and the inline schema kept next to reusable outputs.

- [x] Transcript (`0010_call_analysis`): turn by turn with speaker, text, start and end times (engine now reports them), interruption flag, and tool calls inline with their arguments; `seq` order; full-text search per org (`GET /v1/transcripts/search`, Bangla and English, phrases and exclusions, snippets)
- [x] Analysis job per call: Postgres queue with a lease (`FOR UPDATE SKIP LOCKED`), idempotent enqueue on every call end, exponential backoff (30 s, 2 min, 8 min), a retry only redoes missing steps, crash recovery, a job that keeps killing its worker ends as failed
- [x] Steps per the assistant's `analysis` settings: summary (configurable prompt); success evaluation (pass-fail, numeric 1-10, custom categories, or descriptive; configurable question); structured outputs (JSON Schema, extracted, validated with Ajv, one corrective retry feeding back the errors)
- [x] Structured outputs as reusable org resources (CRUD, soft delete, schema snapshot on each result), attached to many assistants with `analysis.structuredOutputIds` (checked on create, edit and publish); the inline schema still works; schemas restricted for safety (no `pattern`, local `$ref` only)
- [x] Results on the call (`GET /v1/calls/{id}`, `/analysis`, re-run endpoint), in the `end-of-call-report` webhook (queued once when analysis reaches a final state; transcript only for opted-in endpoints), and filterable in `GET /v1/calls` (`output.appointment_booked=true`, numeric ranges, success, status, assistant, dates, text)
- [x] Webhook delivery worker for call events: signed, SSRF-guarded client, lease, 8 attempts over about 11 hours, dead-lettering, visible in `GET /v1/webhook-deliveries`
- [x] Cost: a `usage_record` per analysis model request (channel `analysis`, tokens, provider, model, platform or customer key), failed requests included, plus totals on the analysis
- [x] Tests: 74 new (analysis API and job 61, parsing and schema units 13), engine tests updated for the new event fields; the suite went from 625 to 699 passing (6 skipped as before). Mutation checks: removing the corrective retry or the send-once guard each fails a test
- [x] Exercised by hand on 2026-10-02 against the real HTTP server with the workers running (fake model, request-logging webhook client): created a reusable output (a regex schema was refused), an assistant with summary, a 1-10 rubric and the output, a webhook endpoint with transcript opt-in; ran a chat-mode call over the media socket; saw the 8-entry transcript with offsets and the `endCall` tool entry, the analysis (summary, score 8, validated values), the filter `output.appointment_booked=true` (one call; `=false` none; unknown filter 400), search with «table» marked, the signed report delivered with the transcript, and a re-run that added usage without a second report

**Open items:**

- **Not run with a real model.** Everything above used fake models; no provider key was available for a live analysis. The prompts, the JSON-only reply format and the timeouts (45 s first token) are untested on a real model, and Bangla summaries are unchecked. Try one call with real keys before relying on it.
- **Phone calls have no transcript** until the Phase 8 media gateway exists, so their analysis is skipped (their report still goes out with the call facts). Campaign outcomes still come from `reportOutcome` labels (D54); structured outputs are ready to replace them once phone calls have transcripts.
- **Privacy.** Analysis sends transcripts to the call's model provider and stores summaries and values. No per-call opt-out, retention or redaction yet (Phase 13); an assistant opts out by leaving `analysis` empty.
- **Cost of the choice D59:** the live model also runs the analysis. A dedicated `analysis.model` is a small addition if wanted.
- **Voice tool results:** tool-call entries have no `result` or `status` until `CallSession` runs function tools (Phase 5 open).
- **Webhook window:** retries cover about 11 hours, not the 24 hours of D23. The manual redeliver route still uses an unguarded client, and chat events are still not delivered automatically.
- **Scale:** `output.*` filters scan JSON; a flattened indexed table is the next step for very large orgs. The worker has not run on two real Postgres connections.
- **Not built:** dashboard (Phase 9), analysis of chat sessions, sentiment as its own step (use a structured output with an enum), per-step model choice.

## Outbound campaigns (built 2026-10-02) ✅

Task: let an org call a list of contacts automatically with an assistant. Design: [ARCHITECTURE section 3.21](ARCHITECTURE.md#321-outbound-campaigns-v1-as-built). Endpoints: [API.md](API.md#campaigns-calling-a-contact-list). Decisions D51-D57. The owner chose on 2026-10-02: a Postgres queue, outcomes from `reportOutcome` labels, the dialer plus a signed status callback, and usage units for cost.

- [x] Campaign resource (`0009_campaigns`): name, assistant or squad, several phone numbers (rotated), schedule in the contact's time zone (dates, weekdays, window), max concurrent calls, calls per minute, retry policy, optional disclosure line, outcome and success labels; create, list, read, edit (draft or paused), delete (draft), `Idempotency-Key` on create
- [x] Contacts: CSV upload (E.164 with Bangladesh national numbers, dedupe in the file and in the campaign, do-not-call rows refused, time zone by column or country, per-contact `{{variables}}` with column mapping, missing variables refused), a report of every bad row, dry run, limits
- [x] Dialer: Postgres queue (per-org advisory lock, `FOR UPDATE SKIP LOCKED`, attempt ledger with a unique live-attempt index), campaign and org concurrency, calls-per-minute pacing, contact-local calling hours cut to a platform limit, claim → re-check → dial, reconcile after crashes (released claims, `unconfirmed`, `lost`), provider timeout and structured logs with `org_id`, `campaign_id`, `contact_id`, `attempt_id`, `call_id`
- [x] Provider callback: `POST /v1/telephony/{provider}/status/{attemptId}`, signature-verified, idempotent, order-tolerant; Twilio adapter sends the callback URL and says whether a failed dial may have placed a call
- [x] Retry rules: no-answer, busy, voicemail and provider server errors retried after a delay up to N times; never after a completed conversation or an opt-out; unconfirmed, lost and rejected calls not retried
- [x] Compliance: org-level do-not-call list (API, checked at claim and before every dial, closes waiting contacts), engine opt-out and `reportOutcome` hooks backed by the database (`campaignHooksForCall`), disclosure line prepended to the call, hard block outside calling hours
- [x] Controls: start, pause (new dials only), resume, cancel; a running campaign completes itself; the platform pauses a campaign with a reason when its numbers, assistant or provider configuration are gone
- [x] Results: per-contact status and outcome, stats (dialled, attempts, answered, voicemail, completed, rates, labels, call minutes and provider usage units), CSV export with spreadsheet-formula neutralisation
- [x] Permissions `campaigns:read`, `campaigns:manage`, `dnc:remove`; audit entries; org isolation for every route and table
- [x] Tests: 100 new (outcome rules and provider events 16, API and dialer 70, Twilio adapter 4, plus the route-coverage and permission probes); the suite went from 525 to 625 passing (6 skipped as before). Mutation checks: removing the pre-dial do-not-call check or the pre-dial hours check each fails a test
- [x] Exercised by hand against `npm run api:dev` with the fake SIP provider on 2026-10-02: create, upload (good, duplicate, bad and missing-variable rows), start (Dhaka contacts held until 09:00 Dhaka, in-window contacts dialed up to the concurrency limit), provider callbacks (answered, no-answer retried in 60 min, duplicate, foreign and malformed callbacks), pause, do-not-call, resume, export, cancel

**Open items:**

- **No live conversation yet.** The Twilio media gateway and per-number credentials (Phase 8) are missing, so a campaign call rings and is tracked but no `CallSession` runs on it. The gateway must pass `campaignHooksForCall` as the session's `campaign` option, so opt-outs and outcome labels are saved.
- **Only Twilio can run campaigns in production.** SIP, Telnyx and Vonage are stand-ins: campaigns on them pause in production rather than pretend to dial. Separately, the existing inbound webhook `/v1/telephony/{provider}/webhook` accepts any caller when the provider is a stand-in or `TWILIO_WEBHOOK_SECRET` is empty (not changed by this task).
- **Not run against Twilio.** The status-callback fields and `AnsweredBy` handling follow Twilio's documentation; no account was available.
- **Calling hours need a legal check.** The 08:00-21:00 default is a conservative guess (D53); the right limit differs by country.
- **Definitions to confirm (D57):** completed conversation, retry, success rate.
- **Dialer location and scale:** it runs in the API process. Two real Postgres connections racing are not exercised (PGlite has one), so run a multi-node test before scaling out, or move it to `apps/worker`.
- **Not built:** structured outputs (Phase 11) and money (Phase 13) in the results, voicemail messages, customer webhooks for campaign events, the dashboard (Phase 9), a reusable contact-list resource, and pulling forward contacts that were deferred when a schedule is widened.

## Text conversations: chat API, OpenAI-compatible API, SMS (built 2026-10-01) ✅

Task: let the same assistants work over text: API chat, web chat and SMS. Design: [ARCHITECTURE section 3.20](ARCHITECTURE.md#320-text-conversations-v1-as-built). Endpoints: [API.md](API.md#chat-text-conversations). Decisions D47–D50. The owner chose on 2026-10-01: chat and OpenAI compatibility now and SMS as an optional channel (Bangladesh priority: phone, web voice, WhatsApp, chat, SMS); metering and webhooks now, knowledge base and analysis later; public keys for web chat; OpenAI semantics.

- [x] Engine text mode: `runTextTurn` with the same config, model chain (retries, fallback, usage), function tools, `endCall` and squad handoff; voice-only settings ignored safely
- [x] `POST /v1/chat`: JSON and SSE streaming; `GET /v1/chat/sessions/{id}`, `POST /v1/chat/sessions/{id}/end`
- [x] Sessions: pinned config, stored history, max history sent to the model, idle expiry, max messages, per-session turn queue (migration `0008_chat`)
- [x] Web chat with public keys: allowed origins and assistants, override allowlist, session bound to key and origin, 20 messages/min, CORS
- [x] `POST /v1/chat/completions` (OpenAI shape, streaming and not, OpenAI error format), tested with the official `openai` client
- [x] SMS (optional per number): signed Twilio webhook (form body), async reply via REST, opt-out/opt-in/help keywords, GSM-7/UCS-2 splitting (Bangla aware), retry dedupe
- [x] Usage records per turn in the org's billing unit (`PATCH /v1/org {chatBillingUnit}`); chat webhook events queued as delivery rows
- [x] Tests: engine text turn (9), SMS rules and Twilio adapter (18), chat API including OpenAI client (22), SMS channel (7)
- [x] Exercised by hand against the fake-engine server (curl JSON and SSE, Bangla UTF-8 round trip, official OpenAI client, SMS webhooks) on 2026-10-01

**Open items:**

- **Not run against real providers.** Not tried with a real LLM key, a real Twilio number, or Bangladeshi carriers. Local SMS in Bangladesh likely needs an aggregator adapter (e.g. SSL Wireless, BulkSMSBD).
- **Webhooks are not sent automatically:** no delivery worker yet (Phase 7); rows wait for `redeliver`.
- **Not built:** knowledge base retrieval (Phase 6) and post-conversation analysis (Phase 11) for chat, the same as for calls.
- **WhatsApp:** next channel through the messaging adapter interface.
- **Per-number provider credentials** (`phone_number.credential_id`) are not wired; Twilio uses platform env vars.
- **Browser SDK:** the SDK's text mode still uses the WebSocket chat mode; a `ChatClient` for `/v1/chat` could follow.
- **Scaling:** turns on one session are queued per process; across nodes a race answers `409 turn_in_progress`.

## Browser calls, web SDK and widget (built 2026-10-01) ✅

Task: let customers put voice agents on websites and in mobile apps. Design: [ARCHITECTURE section 3.19](ARCHITECTURE.md#319-browser-calls-and-web-sdk-v1-as-built). Protocol and endpoints: [API.md](API.md#browser-and-app-calls-web-sdk). Decisions D43–D46. The owner chose on 2026-10-01: WebSocket (not WebRTC) for now, the media endpoint in `apps/api`, public keys locked to saved assistants plus server-minted calls for inline configs, and a React Native WebView example.

- [x] Browser transport: WebSocket protocol v1 (`GET /v1/calls/{id}/connect`), PCM16 16 kHz in and 24 kHz out, browser echo cancellation, noise suppression and auto gain
- [x] Handshake in the first frame: single-use token, expiry, origin bound to the call, org status, node capacity (`VOICE_MAX_SESSIONS`), org concurrency; 44xx close codes
- [x] Engine: chat mode (text only), typed messages (`submitUserText`), `tool-call` events, `api-ended` and `server-shutdown` end reasons
- [x] Reconnect: resumable `BrowserTransport` (grace period, buffered events, heartbeats), rotating resume token; the SDK retries with backoff and detects silent connections
- [x] Public keys: allowed origins and assistants enforced on create and connect; override allowlist; inline configs via `start({ call })`; CORS for `POST /v1/calls`; typed messages rate-limited per call
- [x] Live web calls work with the control API (`say`, `context`, `mute`, `end`, `transfer`, live listener); transcript, timeline, status, duration and usage are stored
- [x] SDK `@octo/web`: `start`, `stop`, `setMuted`, `send`, `say`; events `call-start`, `call-end`, `speech-start`, `speech-end`, `message`, `volume-level`, `error` (+ `status`); typed error codes with clear microphone messages
- [x] Widget: one `<script>` tag with data attributes; floating button, live transcript, mute, end, theme colour, position, text-chat fallback; keyboard and ARIA; phone layout
- [x] Examples: [plain HTML](../examples/html) (widget, custom buttons), [React](../examples/react) (`useVoiceCall` hook), [React Native](../examples/react-native) (Expo + WebView)
- [x] Tests: engine (chat mode, typed input, transport: 14), API integration (connect, origins, tokens, limits, resume, control, persistence, CORS: 15), SDK unit with a mocked transport (28), Playwright in Chromium against a fake engine (6)
- [x] Exercised with curl and a scripted browser-style client against the fake engine (2026-10-01)

**Open items:**

- **Not run with real providers or real devices yet.** Try `npm run api:dev` plus the widget on a page with real keys. The React Native app is not run on a device (no mobile toolchain here).
- **Single API node:** resume and the control API need the call in the same process. Two or more nodes need the Redis registry and control channel (section 3.5), then the move to `apps/voice`.
- **WebRTC** (D43): revisit when mobile call-quality data shows gaps.
- **Per-key opt-in** for inline configs and full overrides from the browser (D44), if customers ask.
- **Not stored yet:** recordings (opt-in), and webhooks for web call events (Phase 7 wiring).
- **Not served yet:** `/sdk/*` is served by the API with `Cache-Control: no-store`. Production should serve versioned bundles from a CDN; the npm package is not published.

## Voice pipeline v1 (built ahead of the phase order, 2026-10-01) ✅

Task: a production-grade, fully streaming cascaded pipeline (audio in → STT → LLM → TTS → audio out). It lives in [packages/engine](../packages/engine/README.md); design in [ARCHITECTURE section 3.10](ARCHITECTURE.md#310-voice-engine-v1-as-built); decisions D25–D29. The owner chose Scribe STT, the `packages/engine` location and standalone running on 2026-10-01.

- [x] `CallSession`:
  - [x] State machine (`connecting`, `listening`, `thinking`, `speaking`, `transferring`, `ended`) with validated, timestamped transitions
  - [x] History, config and per-stage timestamps
- [x] Streaming everywhere:
  - [x] Audio streamed to STT, partial transcripts
  - [x] LLM tokens streamed
  - [x] TTS starts on the first sentence or clause
  - [x] TTS audio streamed out, two requests in flight
- [x] VAD and endpointing with per-assistant `silenceMs` / `minSpeechMs`; the user continuing to talk is merged into one turn
- [x] Barge-in:
  - [x] Playback cleared in ≤ 200 ms (138–181 ms measured with real providers)
  - [x] LLM and TTS aborted
  - [x] History keeps only the heard text
- [x] First message: assistant speaks first (configurable text) or waits for the user
- [x] Idle timeout → reminder → end after N reminders (`silence-timeout`); max call duration
- [x] `EndReason` enum recorded on every call (plus `error-internal`, see D28)
- [x] Per-turn latency (STT final, LLM first token, TTS first byte, voice-to-voice, pipeline, barge-in stop) with p50/p95 per call and across calls
- [x] Audio formats: μ-law 8 kHz and PCM16 16/24 kHz through one converter (polyphase resampler, tested for level, frequency, aliasing and chunking)
- [x] Graceful failure:
  - [x] Timeouts on every provider call
  - [x] One safe retry
  - [x] Fallback message (prefetched audio), then end or transfer; never silent
- [x] Tests (offline, fake providers): 91 passing
  - [x] Unit tests for the state machine, VAD, chunker, play-out, metrics and resilience
  - [x] `CallSession` behaviour (26 scenarios)
  - [x] Adapters against local fakes
  - [x] Scripted phone-format integration test
- [x] Manual tools:
  - [x] `npm run voice:dev` (talk from the mic)
  - [x] `npm run voice:smoke` (scripted real-provider call)
  - [x] Both exercised on 2026-10-01, in Bangla and English
- [x] `.env.example` and docs updated

**Latency baseline (2026-10-01, `npm run voice:smoke`, dev machine, `silenceMs` 600):**

| Metric | English p50 | Bangla p50 |
|---|---|---|
| Endpointing (silence wait) | 600 ms | 602 ms |
| STT final (Scribe) | 435 ms | 395 ms |
| LLM first token (`gemini-3.1-flash-lite`) | 1089 ms | 1052 ms |
| TTS first byte (`eleven_v3_conversational`) | 434 ms | 415 ms |
| Pipeline (endpoint → first audio) | 2039 ms | 1957 ms |
| **Voice-to-voice** | **2639 ms** | **2559 ms** |
| Barge-in stop | 160 ms | 138 ms |

The 800 ms voice-to-voice target is **not met**. Each run had only 3 reply turns, so p95 is not meaningful yet. `VOICE_LLM_THINKING_LEVEL=MINIMAL` made no measurable difference. Options to close the gap, roughly in order of payoff:

1. Faster LLM path: a lower-latency model or region, prompt caching, or starting the LLM speculatively on the stable partial transcript before the endpoint.
2. Smarter endpointing: shorter `silenceMs` plus semantic end-of-turn detection, so the 600 ms wait is not paid on every turn.
3. Faster TTS model for the first sentence (check which low-latency ElevenLabs models support Bengali), or the WebSocket input-streaming TTS API.
4. Earlier STT finals: commit sooner, or use partials when they are stable.

**Follow-ups:**

- Wire the engine to the platform: `apps/voice`, call tokens, persistence of calls, events and transcripts (Phase 5).
- Telephony transports (Phase 8).
- A second provider of each kind, a fallback chain and a circuit breaker (Phase 3).
- Neural VAD (D27).
- Client-reported playback position for exact "heard text".
- `bun.lock` is now stale: dependencies were installed with npm (see open question on lockfiles).

## Multi-tenant foundation (built 2026-10-01) ✅

Task: users, orgs, roles, API keys, org-scoped access in one shared layer, RBAC, rate limits, API conventions and an audit log. Design: [ARCHITECTURE section 3.12](ARCHITECTURE.md#312-identity-and-tenancy-v1-as-built). Endpoint reference: [API.md](API.md). Decisions: D36–D42 (D14 accepted).

**Owner choices on 2026-10-01:**

- PGlite for dev and tests, Postgres in production.
- Server-side sessions.
- Scope: the provider credentials API, but no assistants or calls endpoints yet.
- Legacy users left untouched.

**Built:**

- [x] Models with a migration: `org`, `app_user`, `membership` (owner/admin/member/viewer), `api_key`, plus `session`, `email_token`, `invitation`, `audit_log`, `idempotency_key` and `provider_credential`
- [x] Dashboard auth:
  - [x] Email + password (argon2id)
  - [x] Email verification
  - [x] Password reset (revokes sessions)
  - [x] Server-side sessions with a CSRF origin check
  - [x] Google OAuth behind a flag (PKCE, verified email only)
- [x] API keys:
  - [x] Private and public types
  - [x] Shown once, stored as a hash, listed masked
  - [x] Named, revocable, with last-used time and optional expiry
  - [x] Public keys restricted by origin and assistant
- [x] One org per request, resolved in one hook. Handlers only get `request.org.run()`; row-level security is the second layer
- [x] Permission matrix, enforced per route; owner protections
- [x] Rate limits per key and per org (configurable), 429 + `Retry-After`; auth endpoints limited per IP and email
- [x] `/v1`, `{code, message, details}` errors, `limit` + `cursor` pagination, `Idempotency-Key` (opt-in)
- [x] Audit log: logins, failed logins, key use, every create/update/delete; append-only for the app role
- [x] Provider credentials moved to Postgres behind the engine's `CredentialStore`, with a `/v1/credentials` API
- [x] Tests: 129 API tests, 353 in total
  - [x] Cross-org isolation over every endpoint, plus a check that every route is covered
  - [x] Auth flows
  - [x] Key revocation and expiry
  - [x] Rate limits
  - [x] RBAC matrix
  - [x] Migrations
- [x] Exercised with curl against `npm run api:dev` on 2026-10-01
- [x] Type checks: strict mode for `apps/` and `packages/` added to `npm run lint`

**Open items:**

- **Real Postgres not exercised.** It needs Postgres or CI; the same SQL runs on PGlite.
- **Redis rate limiter** needed before running more than one API node.
- **Calls:** `POST /v1/calls` with public keys and idempotency comes in Phase 5. Assistant ids on public keys are not yet validated.
- **Account features:** no MFA; no admin endpoint to suspend an org.

## Provider abstraction (built 2026-10-01) ✅

Task: each assistant chooses its own transcriber, model and voice (presets and bring-your-own-key), with fallbacks and per-call usage for billing. Design: [ARCHITECTURE section 3.11](ARCHITECTURE.md#311-provider-layer-v1-as-built); decisions D30–D35. The owner chose Deepgram, OpenAI, Cartesia and the store-interface approach on 2026-10-01.

- [x] Interfaces `Transcriber`, `LanguageModel`, `VoiceSynthesizer`: streaming, cancellable, common `ProviderError`
- [x] Existing providers moved behind them: ElevenLabs Scribe, Gemini, ElevenLabs TTS
- [x] New providers:
  - [x] Deepgram Nova-3
  - [x] OpenAI Chat Completions
  - [x] Cartesia Sonic 3.6
- [x] A `custom` option per component, with an SSRF guard
- [x] Registry: `{provider, model, language, ...}` → instance; clear errors for unknown providers and fields
- [x] Presets `fast`, `balanced` (default), `quality`, with override rules
- [x] Org credentials:
  - [x] Encrypted at rest (envelope AES-256-GCM, key rotation)
  - [x] Masked views only
  - [x] Org-scoped
  - [x] Platform key fallback marked `platform`-billed
- [x] Ordered fallbacks per component (before output only, sticky per call)
- [x] LLM options: system prompt, temperature, max tokens, tools, and tool messages (interface ready for the tool runtime)
- [x] Per-call usage: provider/model actually used, audio seconds, tokens in/out, characters, requests, billing source
- [x] Tests: 224 passing
  - [x] Provider contract suite for all 9 adapters and the fakes
  - [x] Registry and preset tests
  - [x] Credential, masking and encryption tests
  - [x] Fallback and usage tests
  - [x] SSRF tests
- [x] Exercised live on 2026-10-01:
  - [x] Balanced preset smoke call with usage records
  - [x] Org Gemini key used and billed to the customer
  - [x] Real Cartesia 401 fell back to ElevenLabs
  - [x] Clear failure message for `fast` without keys

**Open items:**

- **Live checks of Deepgram, OpenAI and Cartesia success paths.** No keys are available; the contract fixtures were assembled from vendor docs, not captured. Capture real fixtures once keys exist, and measure the `fast` preset latency.
- **Credential storage.** The Postgres `provider_credential` table, row-level security and the authenticated credential API come in Phase 2.
- **Billing.** `usage_record` persistence and pricing come in Phase 13.
- **Reliability.** No circuit breaker across calls yet.

## Phase 0: Audit and target architecture ✅

- [x] Explore the whole repo and document the current system (ARCHITECTURE section 1)
- [x] List weaknesses and risks, with file and line references (ARCHITECTURE section 2, W1-W27)
- [x] Design the target module architecture (ARCHITECTURE section 3)
- [x] Choose service boundaries, real-time transport, job queue, recording storage and voice scaling model (ARCHITECTURE sections 3.2-3.5, DECISIONS D2, D7, D8, D10, D12)
- [x] Define the core data model (ARCHITECTURE section 4)
- [x] Write DECISIONS.md (D1-D24)
- [x] Record the baseline: `npm run lint` (`tsc --noEmit`) passes; there is no test suite; no secrets in tracked files
- [x] List open questions for the owner (below)

No application code was changed in Phase 0.

## Phase 1: Foundations

- [ ] Repo hygiene, with owner approval:
  - [ ] Untrack `.venv/`, `data/`, stale Python files
  - [ ] Pick one lockfile
  - [ ] Decide whether to purge private data from git history (W1, W27)
- [ ] pnpm monorepo skeleton (`apps/*`, `packages/*`); move today's app to `apps/legacy` unchanged, and confirm it still builds and runs
- [ ] `packages/core`:
  - [ ] zod-validated env config
  - [ ] pino logger with request, call and org context
  - [ ] Error types
  - [ ] UUIDv7 ids
- [x] Database: first migration, migration runner with checksums, role `octo_app` without row-level-security bypass (2026-10-01, `apps/api/src/db`; plain SQL instead of Drizzle, D36)
- [ ] `apps/api` Fastify skeleton (built 2026-10-01 without workspace tooling):
  - [x] `/health` (liveness); `/ready` still to do
  - [x] Request id
  - [x] Error handler
  - [x] Rate-limit plugin
  - [ ] OpenAPI output (hand-written API.md for now)
- [ ] `apps/worker` skeleton with BullMQ connection and one no-op queue
- [ ] `docker-compose.yml`: Postgres 16 + pgvector, Redis 7, MinIO
- [ ] Vitest set up for unit and integration tests; first tests for the legacy pure logic:
  - [ ] `MainSpeakerGate`
  - [ ] `BargeInDetector`
  - [ ] `ElevenLabsLiveRelay` batching
  - [ ] `toFriendlyError`
- [ ] CI: install, type-check, lint (ESLint + Prettier), unit + integration tests, Docker build
- [ ] `.env.example` updated with every new variable
- [ ] Decide the hosting target; verify it supports long-lived WebSockets and a long stop timeout

## Phase 2: Auth, orgs, API keys

- [x] Sign up, login, logout, email verification, password reset (async hashing, tokens in the database, rate-limited)
- [x] Orgs, memberships, roles, invitations, active-org switching
- [x] Row-level-security policies on all tenant tables + `withOrg(orgId, tx)` helper; cross-org access tests
- [x] API keys:
  - [x] Private and public types
  - [x] Create (shown once), list, revoke
  - [x] Hashed storage
  - [x] `last_used_at`
  - [x] Public-key origin and assistant restrictions
- [x] Audit log for auth and key events
- [ ] Import script: legacy `data/users.json` → default org (idempotent, dry-run mode)
- [x] API docs for all auth endpoints ([API.md](API.md))

## Phase 3: Provider layer

- [ ] Interfaces: `SttProvider`, `LlmProvider` (streaming + tool calls), `TtsProvider` (streaming), `RealtimeProvider`, `EmbeddingProvider`. Done 2026-10-01 as `Transcriber`, `LanguageModel`, `VoiceSynthesizer`; realtime and embedding interfaces still to do
- [ ] Resilience wrapper:
  - [x] Timeouts with abort (2026-10-01, `providers/resilience.ts`)
  - [x] Retries only where safe (2026-10-01)
  - [ ] Circuit breaker
  - [x] Fallback chain (2026-10-01, `providers/chain.ts`)
  - [ ] Structured logs and metrics per call
- [ ] Adapters:
  - [ ] Gemini: LLM, Live realtime, transcription, TTS, embeddings
  - [x] ElevenLabs: streaming TTS (2026-10-01, `providers/elevenlabsTts.ts`)
  - [x] ElevenLabs: Scribe v2 Realtime STT (2026-10-01, D25)
  - [x] Gemini: streaming LLM with function calling (2026-10-01); Live realtime, transcription, TTS and embeddings still to do
- [ ] Deterministic fakes for every interface (scripted text, audio, latency, errors). STT, LLM and TTS done (2026-10-01, `testing/fakes.ts`); realtime and embeddings still to do
- [x] `ProviderCredential` (bring your own key) with envelope encryption (2026-10-01, in-memory store; Postgres in Phase 2)
- [x] Contract tests run against the adapters and fakes (2026-10-01); live smoke via `npm run voice:smoke`

## Phase 4: Assistants API and tools

- [ ] `assistant`, `assistant_version`, `tool` tables + join tables (migration)
- [ ] Versioned assistant config schema (zod), including language, pipeline mode, turn-taking and voice
- [ ] CRUD, create version, publish, rollback, list versions
- [ ] Tools CRUD; built-ins (`endCall`, `transferCall`, `dtmf`, `kbQuery`); function-tool webhook runner (signed, timeout, filler messages)
- [ ] Text-mode "chat with assistant" endpoint (same turn manager, no audio) for fast testing
- [ ] Legacy Bangla assistant expressed as a config fixture (prompt, greeting, voice, models)

## Phase 5: Voice engine v1 + web SDK

- [ ] `apps/voice` process: WebSocket transport, binary PCM protocol v1, auth by short-lived call token. Protocol v1 and token auth built 2026-10-01 inside `apps/api` (D45); the separate process is still open
- [ ] `CallSession` (cascaded mode built 2026-10-01; see the voice pipeline section above):
  - [ ] Cascaded and realtime modes (cascaded done)
  - [ ] Realtime + external TTS mode (today's hybrid)
  - [x] Turn manager and interruption with history truncation
  - [ ] Tool calls
  - [x] Maximum duration and silence timeout
- [x] Heartbeats, backpressure, per-org concurrency limit, clean teardown on every path (fixes W16, W18) (2026-10-01, browser calls)
- [ ] Call registry, control channel, readiness-based capacity, graceful drain, dead-node reaper
- [ ] `call`, `call_event`, `transcript` tables; events via Redis Streams → worker persister. Browser calls write transcript, timeline and final status directly (2026-10-01); Redis Streams and the worker are open
- [ ] Stereo recording to object storage (opt-in per assistant)
- [ ] `POST /v1/calls` (web), `GET /v1/calls`, `GET /v1/calls/:id`, `POST /v1/calls/:id/end`. All but the `GET /v1/calls` list are done (2026-10-01)
- [x] `@octo/web` SDK: AudioWorklet capture, playback, events, reconnect, widget (2026-10-01). Not ported: `MainSpeakerGate` / `BargeInDetector` (the server's VAD and browser echo cancellation do this job)
- [ ] Legacy UI rebuilt on the SDK against the default-org assistant (parity check with today's app)
- [x] Per-turn latency measured and recorded; first baseline numbers written here (see the voice pipeline section above)
- [ ] Engine tests with the loopback transport and recorded audio fixtures (loopback tests done 2026-10-01; recorded audio fixtures still to do)

## Phase 6: Knowledge base

- [ ] `knowledge_base`, `file`, `knowledge_chunk` (pgvector) tables
- [ ] Presigned upload → `kb-ingest` job:
  - [ ] Text extraction (PDF via provider, text formats directly)
  - [ ] Chunking
  - [ ] Embedding
  - [ ] Status tracking
- [ ] Hybrid search (vector + full-text), org-scoped; `kbQuery` tool and pre-turn retrieval option
- [ ] Import legacy seed docs and uploaded documents into the default org
- [ ] Retrieval quality test set (Bangla and English questions → expected chunks)

## Phase 7: Webhooks and observability

- [ ] `webhook`, `webhook_delivery` tables; CRUD; test-send endpoint
- [ ] Events:
  - [ ] `call.started`
  - [ ] `status-update`
  - [ ] `transcript`
  - [ ] `tool-calls`
  - [ ] `end-of-call-report`
  - [ ] `assistant-request` (synchronous)
- [ ] HMAC signing, retries with backoff, dead-lettering, idempotent `event_id`
- [ ] OpenTelemetry traces across api, voice, worker and providers; Prometheus `/metrics`; Sentry
- [ ] Latency and error dashboards (Grafana or vendor); alerts on p95 turn latency, provider error rate, event-loop lag

## Phase 8: Telephony

- [ ] Telephony adapter interface; first provider (Twilio or Telnyx, to be decided)
- [ ] Phone numbers: search, buy, import, release; `phone_number` table; routing to an assistant or squad
- [ ] Inbound: signed webhook → create call → media stream to the voice engine; μ-law 8 kHz transcoding
- [ ] Outbound: `POST /v1/calls` with `phoneNumberId` + `customer.number`; answering-machine and voicemail detection
- [ ] Transfer (cold, then warm), DTMF send and receive, hang-up handling
- [ ] Fallback destination when the platform fails

## Phase 9: Dashboard

- [ ] Next.js app: auth, org switcher, team and roles
- [ ] Assistants editor with versions, diff, publish and rollback; test in browser via `@octo/web`
- [ ] Call logs:
  - [ ] Filters
  - [ ] Recording player
  - [ ] Transcript
  - [ ] Event timeline
  - [ ] Latency waterfall
  - [ ] Cost
- [ ] Knowledge bases, tools, phone numbers, webhooks (with delivery log), API keys

## Phase 10: Squads, chat and SMS

- [ ] `squad`, `squad_member` tables; handoff tool; context carry-over; per-member voice
- [x] `conversation` table; chat API (streaming); SMS via the telephony provider's messaging webhooks (2026-10-01, as `chat_session` / `chat_message`; see the text conversations section)
- [ ] Squads and chat in the dashboard

## Phase 11: Campaigns and call analysis

- [x] `campaign`, `campaign_contact`, `do_not_call` tables (plus `campaign_phone_number` and the `campaign_attempt` ledger); CSV contact import (2026-10-02, see the campaigns section above)
- [x] Scheduler:
  - [x] Calling windows per time zone
  - [x] Maximum concurrency
  - [x] Dial rate limit
  - [x] Retry policy
  - [x] Pause and resume
- [x] Post-call analysis job: summary, structured data (reusable schemas, plus the inline one), success rubric (pass-fail, 1-10, categories) → `call_analysis` (2026-10-02, see the call analysis section above). Sentiment is a structured output with an enum. Campaign outcomes still use `reportOutcome` labels (D54)
- [ ] Campaign progress and analysis results in the dashboard. Progress is in the API (stats, export); analysis results are in the API and in the end-of-call-report webhook

## Phase 12: Evals and simulations

- [ ] `eval`, `eval_case`, `eval_run` tables; text-mode runner; LLM judge + deterministic assertions
- [ ] `simulation`, `simulation_run` tables:
  - [ ] Simulated caller (LLM persona + TTS + noise profile, generalising `mictest.tmp.ts`)
  - [ ] Runs over the loopback transport
- [ ] Compare two assistant versions; run from the dashboard and the CLI (CI gate)

## Phase 13: Billing, compliance, SDKs/CLI, launch hardening

- [ ] `usage_record` metering from the engine and workers; price tables; daily aggregates
- [ ] Payments integration (provider to be decided), credits and hard limits enforced at call start and mid-call
- [ ] Compliance:
  - [ ] Recording consent message
  - [ ] Retention jobs
  - [ ] PII redaction option
  - [ ] Data export and delete per org
  - [ ] Audit log UI
- [ ] Generated TS and Python SDKs from OpenAPI; `octo` CLI (login, assistants as code, evals, logs tail, webhook forwarding)
- [ ] Public API reference and quick-start docs
- [ ] Load test to target concurrency; security review; backup and restore drill; runbooks
- [ ] Optional: WebRTC transport via LiveKit
- [ ] Retire `apps/legacy`

## Security review and baseline hardening (2026-10-02)

- [x] SSRF guard on API outbound requests to customer-configured URLs, including tool calls, telephony routing and manual webhook redelivery; connect-time DNS checks remain in place for custom providers and delivery workers
- [x] Production inbound telephony callback gate: Twilio only with a configured signing secret; production SMS refuses an empty signing secret; production URLs require HTTPS; SMTP requires TLS
- [x] Legacy upload validation: supported document formats, canonical base64, MIME/extension and PDF signature checks, UTF-8 validation, 10 MiB decoded-size limit
- [x] Legacy prompt data scoped to the current user plus intentionally shared documents; text-mode tool results and retrieved document context are framed as untrusted data
- [x] Dependency audit clean after upgrading Nodemailer and Vitest and applying compatible transitive fixes
- [x] Threat model and residual-risk register: [SECURITY.md](SECURITY.md)
- [ ] Encrypt transcripts, events and recordings with a selected managed KMS; select database TLS/CA policy and object-storage deployment
- [ ] Per-org retention, zero-data-retention, PII redaction, call/org export and deletion workflows
- [ ] Compliance-mode provider qualification/enforcement and enterprise SSO, MFA, IP allowlists and environment isolation
- [ ] Remove private JSON data from Git and purge repository history after owner approval; current private data files remain tracked
- [ ] Full API test/typecheck gate remains blocked by the missing `apps/api/src/routes/ops.ts` import

---

## Open questions (asked 2026-09-30, blocking Phase 1)

Tracked here until answered; answers are recorded in DECISIONS.md.

1. Confirm the stack: TypeScript on Node + Fastify for the backend (D1, D3)?
2. Hosting target and region?
3. Repo restructure: move the current app into `apps/legacy` in this repo, or start the platform in a new repo?
4. Git history: untrack `.venv/` and `data/`; purge the committed private documents from history (needs a force-push)?
5. What to do with the uncommitted change to `data/custom_documents.json`?
6. Voice-memory feature: drop it (D24)? Migrate existing users and documents into a default org?
7. Telephony provider and the countries you need numbers in?
8. Auth: first-party, or Clerk/WorkOS? Is enterprise SSO needed within 6 months?
9. Billing: prepaid credits or postpaid invoices; which payment provider works for your company's country?
10. Compliance regimes, recording-consent rules, data-residency needs?
11. Languages after Bangla and English; confirm the latency target (p50 ≤ 1.0 s, p95 ≤ 1.8 s)?
12. Allow customers to bring their own provider keys?
13. Scale targets: concurrent calls at launch and in 12 months?
14. Is the phase order OK?
