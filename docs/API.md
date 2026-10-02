# Voice of Octo API reference (v1)

The REST API lives in `apps/api` (Fastify). Built on 2026-10-01: identity, organizations, members and invitations, API keys, provider credentials, the audit log, assistants and browser calls.

## Conventions

| Topic | Rule |
|---|---|
| Base path | `/v1`. Breaking changes get a new version. |
| Format | JSON in and out, with `Content-Type: application/json`. Fields are camelCase. Timestamps are ISO 8601 UTC. Ids are UUIDs. |
| Errors | Always `{"code": "...", "message": "...", "details": {...}}`, with the HTTP status from the table below. `X-Request-Id` is on every response; quote it to support. |
| Pagination | List endpoints take `?limit=` (1–100, default 20) and `?cursor=`, and return `{"data": [...], "nextCursor": "..." \| null}`. Order is newest first. Pass `nextCursor` back unchanged. |
| Idempotency | POSTs that create calls or charge money accept `Idempotency-Key: <1-255 chars>`. Keys are scoped to the org and kept for 24 h. A repeat with the same request replays the first response (`Idempotent-Replayed: true`). The same key with a different request gets `422 idempotency_key_reused`; a repeat while the first is still running gets `409 idempotency_in_progress`. 5xx responses are not stored, so retry with the same key. No current endpoint uses it yet. |
| Rate limits | Per API key (default 600/min) and per org (default 1200/min), configurable per key and per org. Responses carry `X-RateLimit-Limit` and `X-RateLimit-Remaining`. Over the limit: `429 rate_limited` with `Retry-After` (seconds) and `details.scope` set to `key` or `org`. Sign-in, sign-up and reset endpoints are limited per IP and per email (default 10 per 15 min). |

In production, `API_PUBLIC_URL`, `DASHBOARD_URL`, and an enabled Google OAuth redirect URI must use HTTPS. Terminate inbound TLS at the deployment ingress and set `COOKIE_SECURE=true` (the production default). SMTP on port 465 uses implicit TLS; other configured SMTP ports require STARTTLS.

## Authentication

Every request resolves to **exactly one org**:

| Caller | How | Org |
|---|---|---|
| Server | `Authorization: Bearer sk_...` (private key) | The key's org |
| Browser widget | `Authorization: Bearer pk_...` (public key) from an allowed `Origin` | The key's org. Public keys can only start web calls, and every other endpoint answers `403 forbidden_key_type` |
| Dashboard | `octo_session` cookie (HttpOnly, SameSite=Lax, Secure in production) | The session's active org (`PUT /v1/me/active-org`). Membership is re-checked on every request |

Requests that change state using the session cookie must send an `Origin` from `DASHBOARD_ORIGINS`; otherwise they get `403 csrf_origin_mismatch`.

API keys:
- They look like `sk_` or `pk_` followed by 43 random characters.
- The full key is returned once, by `POST /v1/api-keys`. Only a SHA-256 hash is stored, and listings show `sk_AbCdEf••••••••`.
- Revoked and expired keys stop working immediately (`401 invalid_api_key`).

## Roles and permissions

| Permission | owner | admin | member | viewer | private key | public key |
|---|:-:|:-:|:-:|:-:|:-:|:-:|
| `org:read` | ✓ | ✓ | ✓ | ✓ | ✓ | |
| `org:update` | ✓ | ✓ | | | ✓ | |
| `org:delete` | ✓ | | | | | |
| `members:read` | ✓ | ✓ | ✓ | ✓ | ✓ | |
| `members:manage` | ✓ | ✓ | | | ✓ | |
| `invitations:read`, `invitations:manage` | ✓ | ✓ | | | ✓ | |
| `api_keys:read` | ✓ | ✓ | ✓ | | ✓ | |
| `api_keys:manage` | ✓ | ✓ | | | ✓ | |
| `credentials:read` | ✓ | ✓ | ✓ | | ✓ | |
| `credentials:manage` | ✓ | ✓ | | | ✓ | |
| `audit:read` | ✓ | ✓ | | | ✓ | |
| `assistants:read` (assistants, tools, squads, numbers, structured outputs, provider catalog) | ✓ | ✓ | ✓ | ✓ | ✓ | |
| `assistants:manage` | ✓ | ✓ | ✓ | | ✓ | |
| `calls:read` (calls, transcripts, analysis, boards, debug view) | ✓ | ✓ | ✓ | ✓ | ✓ | |
| `calls:create` (Phase 5) | ✓ | ✓ | ✓ | | ✓ | ✓ (allowed origins and assistants only) |
| `chat:read` | ✓ | ✓ | ✓ | ✓ | ✓ | |
| `chat:create` | ✓ | ✓ | ✓ | | ✓ | ✓ (`POST /v1/chat` only; allowed origins and assistants) |
| `campaigns:read` | ✓ | ✓ | ✓ | ✓ | ✓ | |
| `campaigns:manage` | ✓ | ✓ | ✓ | | ✓ | |
| `dnc:remove` | ✓ | ✓ | | | ✓ | |
| `monitoring:read` (scorecards, alert policies, alerts) | ✓ | ✓ | ✓ | ✓ | ✓ | |
| `monitoring:manage` | ✓ | ✓ | | | ✓ | |

Owner rules:
- Only owners can grant, change or remove the owner role.
- An org always keeps at least one owner (`409 conflict`).
- Any member can leave an org (`DELETE /v1/members/{own id}`).

The matrix lives in code in `apps/api/src/auth/permissions.ts`; the table above mirrors it.

## Endpoints

### Auth (no authentication needed)

| Method and path | Body | Response |
|---|---|---|
| `POST /v1/auth/signup` | `{email, password (10–200 chars), name, orgName?}` | `202 {status: "verification_sent"}`, whether or not the email already exists (no account enumeration). Creates the user and an org where they are owner |
| `POST /v1/auth/verify-email` | `{token}` (from the email) | `200 {user}`. Tokens are single use and valid 24 h |
| `POST /v1/auth/resend-verification` | `{email}` | `202` |
| `POST /v1/auth/login` | `{email, password}` | `200 {user, orgs, activeOrgId}` and sets the session cookie. `401` for a wrong email or password (same answer for both). `403 email_not_verified` |
| `POST /v1/auth/logout` | (session) | `204` |
| `POST /v1/auth/forgot-password` | `{email}` | `202` (always) |
| `POST /v1/auth/reset-password` | `{token, password}` | `200`. Signs out every session. Tokens are single use and valid 1 h |
| `GET /v1/auth/google/start` | (when `GOOGLE_OAUTH_ENABLED`) | `302` to Google, with state and PKCE |
| `GET /v1/auth/google/callback` | `?code&state` | `302` to the dashboard, with a session. The Google email must be verified, and an existing account with the same email is linked |

### Signed-in user (dashboard session only)

| Method and path | Body | Response |
|---|---|---|
| `GET /v1/me` | | `{user, orgs: [{id, name, slug, role, status}], activeOrgId}` |
| `PUT /v1/me/active-org` | `{orgId}` | `{activeOrgId}`. `404` if the caller is not a member |
| `POST /v1/orgs` | `{name}` | `201 {id, name, slug, role: "owner"}` and makes it the active org |
| `POST /v1/invitations/accept` | `{token}` | `{orgId, role}`. The signed-in email must match the invitation |

### Organization (session or private key)

| Method and path | Permission | Body / query | Response |
|---|---|---|---|
| `GET /v1/org` | `org:read` | | `{id, name, slug, status, rateLimitPerMinute, createdAt}` |
| `PATCH /v1/org` | `org:update` | `{name?, chatBillingUnit?: "message" \| "token"}` | org |
| `DELETE /v1/org` | `org:delete` | `{confirm: "delete"}` | `204`. Deletes all of the org's data |
| `GET /v1/members` | `members:read` | `limit, cursor` | page of `{userId, email, name, role, joinedAt}` |
| `PATCH /v1/members/{userId}` | `members:manage` | `{role}` | member |
| `DELETE /v1/members/{userId}` | `members:manage` (or yourself) | | `204` |
| `POST /v1/invitations` | `invitations:manage` | `{email, role: admin\|member\|viewer}` | `201 {id, email, role, status, expiresAt, createdAt}`. The link goes by email only and is valid 7 days |
| `GET /v1/invitations` | `invitations:read` | `limit, cursor` | page of invitations |
| `DELETE /v1/invitations/{id}` | `invitations:manage` | | the revoked invitation |
| `POST /v1/api-keys` | `api_keys:manage` | `{name, type: private\|public, allowedOrigins?, allowedAssistantIds?, rateLimitPerMinute?, expiresAt?}` | `201` with the **full `key`, shown once** |
| `GET /v1/api-keys` | `api_keys:read` | `limit, cursor` | page of masked keys `{id, name, type, key: "sk_AbCdEf••••••••", allowedOrigins, allowedAssistantIds, rateLimitPerMinute, status, createdAt, lastUsedAt, expiresAt, revokedAt}` |
| `GET /v1/api-keys/{id}` | `api_keys:read` | | masked key |
| `DELETE /v1/api-keys/{id}` | `api_keys:manage` | | revoked key (`status: "revoked"`) |
| `POST /v1/credentials` | `credentials:manage` | `{provider, secret, label?}` | `201 {id, provider, label, masked, createdAt, lastUsedAt}`. The secret is never returned. `503 not_configured` without `CREDENTIALS_ENCRYPTION_KEY` |
| `GET /v1/credentials` | `credentials:read` | `limit, cursor` | page of masked credentials |
| `GET /v1/credentials/{id}` | `credentials:read` | | masked credential |
| `DELETE /v1/credentials/{id}` | `credentials:manage` | | `204` |
| `GET /v1/audit-logs` | `audit:read` | `limit, cursor, action?` | page of `{id, actor: {type, id}, action, target, metadata, ip, createdAt}` |

Public key rules:
- `allowedOrigins` is required, as exact origins such as `https://shop.example.com` (`http://` only for localhost).
- `allowedAssistantIds` is optional; empty means any of the org's assistants.
- Private keys cannot carry restrictions.

Another org's resources answer `404 not_found`, never `403`, so ids cannot be probed.

### Other

`GET /health` (no auth): `{ok: true}` once the database answers. This is the liveness check.

`GET /ready` (no auth): readiness for the load balancer. `200` with `{ok: true, version, uptimeSeconds, checks: {database: "ok", capacity: "ok"}, liveSessions, maxSessions}`. It answers `503` with the same body (`ok: false`, and `checks.database: "failed"` or `checks.capacity: "full"`) when the database does not answer within 2 s, or when this node already runs `VOICE_MAX_SESSIONS` browser calls. New connections then go to another node; calls already on this node carry on.

`GET /metrics` (operator only): Prometheus text format, for `Authorization: Bearer <METRICS_TOKEN>`. Without `METRICS_TOKEN` configured it answers `404`, and with a wrong or missing token `401`. Labels are bounded sets (provider, model, stage, reason, queue), never org, call or customer identifiers; per-org numbers come from the boards below.

## Audit actions

| Area | Actions |
|---|---|
| Auth | `auth.signup`, `auth.email_verified`, `auth.login`, `auth.login_failed`, `auth.logout`, `auth.password_reset_requested`, `auth.password_reset`, `auth.google_linked`, `auth.org_switched` |
| Orgs | `org.created`, `org.updated`, `org.deleted` |
| Members | `member.role_changed`, `member.removed`, `member.left` |
| Invitations | `invitation.created`, `invitation.revoked`, `invitation.accepted` |
| API keys | `api_key.created`, `api_key.revoked`, `api_key.used` (at most every 10 min per key; `lastUsedAt` is updated every minute) |
| Credentials | `credential.created`, `credential.deleted` |
| Call analysis | `structured_output.created`, `structured_output.updated`, `structured_output.deleted`, `call.analysis_rerun` |
| Campaigns | `campaign.created`, `campaign.updated`, `campaign.deleted`, `campaign.start`, `campaign.pause`, `campaign.resume`, `campaign.cancel`, `campaign.contacts_imported`, `do_not_call.added`, `do_not_call.removed` |

User-level events without an org are stored with no org and are not visible through `/v1/audit-logs`: sign-up, failed sign-in, password reset, and `org.deleted` after the org is gone. Sign-ins are recorded in the org the session opens.

## Error codes

| Status | Codes |
|---|---|
| 400 | `bad_request`, `validation_error` (`details.issues: [{path, message}]`) |
| 401 | `unauthorized`, `invalid_api_key`, `session_expired` |
| 403 | `forbidden` (`details.permission`), `forbidden_key_type`, `origin_not_allowed`, `csrf_origin_mismatch`, `email_not_verified`, `org_suspended` |
| 404 | `not_found` |
| 409 | `conflict`, `no_active_org`, `idempotency_in_progress` |
| 422 | `idempotency_key_reused` |
| 429 | `rate_limited` |
| 500 | `internal_error` (`details.requestId`) |
| 503 | `not_configured`, `upstream_unavailable` (the AI provider failed after retries and fallbacks; safe to retry) |

## Assistants and browser calls

| Method and path | Permission | Body / purpose |
|---|---|---|
| `GET /v1/assistant-templates` | `assistants:read` | Starter configurations for customer support, appointment booking and lead qualification |
| `POST /v1/assistants` | `assistants:manage` | `{name, templateId?, metadata?, config?}`. Creates a mutable draft. Config uses strict camelCase fields including provider components, endpointing/idle limits, analysis, webhooks and `{{variable}}` placeholders. |
| `GET /v1/assistants` | `assistants:read` | `limit, cursor, search`; searches names and returns draft plus published-version summary |
| `GET /v1/assistants/{id}` | `assistants:read` | Assistant draft and publication state |
| `PATCH /v1/assistants/{id}` | `assistants:manage` | JSON merge patches `{name?, metadata?, config?}` against the draft |
| `DELETE /v1/assistants/{id}` | `assistants:manage` | Soft-deletes the assistant |
| `POST /v1/assistants/{id}/publish` | `assistants:manage` | `{note?}`. Creates immutable version N and makes it live for new calls |
| `GET /v1/assistants/{id}/versions` | `assistants:read` | Immutable version history |
| `GET /v1/assistants/{id}/versions/{version}` | `assistants:read` | One immutable version, including config |
| `POST /v1/assistants/{id}/rollback` | `assistants:manage` | `{version, restoreDraft?}`. Points new calls at an existing version |
| `POST /v1/calls` | `calls:create` | `{assistantId? or assistant?, version?, variables?, overrides?, origin?, test?}`. Starts a published, transient, or overridden browser call and returns a one-time `connectToken` and `wsUrl` (see [Browser and app calls](#browser-and-app-calls-web-sdk) for public-key rules). |
| `POST /v1/assistants/{id}/test-call` | `calls:create` | `{variables?, overrides?, origin?}`. Dashboard “Talk to assistant” call using the current published version |

### Provider catalog

`GET /v1/providers` (`assistants:read`) lists what an assistant's `transcriber`, `model` and `voice` can be. It is derived from the same schemas that validate assistants, is the same for every org, and holds no org data.

```jsonc
{
  "components": {
    "voice": {
      "providers": [
        { "id": "elevenlabs", "description": "ElevenLabs streaming TTS", "defaultModel": "eleven_v3_conversational",
          "suggestedModels": ["eleven_v3_conversational", "eleven_v3"],   // the default and the presets' models; any model string is accepted
          "credentialVendor": "elevenlabs",                                // the `provider` of an org key (POST /v1/credentials)
          "fields": [ { "name": "voiceId", "type": "string", "required": false, "min": 1, "max": 200 },
                      { "name": "speed", "type": "number", "required": false, "min": 0.7, "max": 1.2 } ] }
      ],
      "policy": [ { "name": "retries", "type": "integer", "required": false, "default": 1, "min": 0, "max": 2 }, { "name": "fallbacks", "type": "object-list", "required": false, "default": [], "maxItems": 3 } ]
    },
    "transcriber": { ... }, "model": { ... }
  },
  "presets": [ { "name": "balanced", "description": "...", "default": true, "silenceMs": 600, "transcriber": {...}, "model": {...}, "voice": {...} } ],
  "credentialVendors": ["elevenlabs", "deepgram", "google", "openai", "cartesia", "custom"]
}
```

Field `type` is one of `string`, `number`, `integer`, `boolean`, `enum` (with `values`), `string-list`, `map` (string to string) or `object-list`. `min`/`max` are value bounds for numbers and length bounds for strings; `exclusiveMin`/`exclusiveMax` mark a decimal bound that is itself not allowed; `format: "url"` marks URLs. There is no voice list: `voiceId` is the vendor's own voice id.

Saved assistants require a published version before a call can start. Inline `assistant` configs are validated with the same schema. Overrides are applied only to the call snapshot. Variables are resolved from call values, then assistant defaults; built-ins are `now`, `date`, `time` and `call_id`. Missing values return field-level `validation_error` issues before the call is queued. Rendering is single-pass and values are not recursively interpreted.

## Browser and app calls (web SDK)

A web call is created over REST, then its audio runs over one WebSocket. The `@octo/web` SDK and the widget do both (see [packages/sdk](../packages/sdk/README.md)); this section is the contract for anyone writing another client.

**Creating the call from a browser** (`POST /v1/calls` with a public key):

| Rule | Detail |
|---|---|
| Key | `Authorization: Bearer pk_...`. Private keys must never be used in a browser or app. |
| Origin | The `Origin` header must be in the key's `allowedOrigins`, else `403 origin_not_allowed`. The call is bound to that origin. |
| Assistant | `assistantId` only (and in the key's `allowedAssistantIds`, when set). Inline `assistant` → `403 forbidden_key_type`. |
| Overrides | Only `firstMessage`, `firstMessageMode`, `language`, `endpointing`, `interruption`, `idle` and `voice.voiceId`. Anything else → `403 forbidden` with `details.fields` (the refused paths) and `details.allowed`. |
| CORS | `OPTIONS /v1/calls` answers the preflight for any origin (`POST`; `authorization, content-type, idempotency-key, x-request-id`). Responses reflect the `Origin` so the SDK can read errors. Credentials (cookies) are never allowed cross-origin. |

**Inline assistants and full overrides** need a private key, so they go through the customer's server: it calls `POST /v1/calls` with `sk_...` (optionally with `origin` set to the browser's origin, which then binds the media socket to it), and passes `{id, connectToken, wsUrl}` to the browser, which calls `client.start({ call })`. Calls created with a dashboard session are bound to the dashboard origin. Calls created with a private key and no `origin` accept any origin; the single-use token is the only credential.

**Media socket** `GET /v1/calls/{id}/connect` (the `wsUrl` from `POST /v1/calls`). No cookie or key: the first text frame authenticates, within 5 s.

| Frame | Direction | Content |
|---|---|---|
| `{"type":"hello","protocol":1,"token":"<connectToken>","mode":"voice"\|"chat"}` | client → server | First frame of a new call. `chat`: typed text only; no STT, no TTS, no idle reminders. Tokens are single use and expire 10 minutes after creation. |
| `{"type":"resume","protocol":1,"resumeToken":"..."}` | client → server | First frame when reconnecting after a drop (instead of `hello`). |
| `{"type":"ready","protocol":1,"callId","mode","resumeToken","resumeGraceMs","inputFormat","outputFormat","state"}` | server → client | The call is live. Keep `resumeToken`: it rotates on every `ready`. |
| binary | client → server | Caller audio, PCM16 mono 16 kHz, little-endian (20 ms frames recommended). Send silence while muted. |
| binary | server → client | Agent audio, PCM16 mono 24 kHz. Sent faster than real time; buffer and play gaplessly. |
| `{"type":"message","text"}` | client → server | Typed user message (1–2000 characters). Interrupts the agent and is answered like speech. |
| `{"type":"say","text"}` | client → server | The assistant speaks this text. |
| `{"type":"ping"}` / `{"type":"pong"}` | both | Liveness. The server also sends WebSocket pings every 15 s. |
| `{"type":"hangup"}` | client → server | End the call (`customer-hung-up`). |
| `{"type":"clear"}` | server → client | Stop playback now and drop buffered audio (barge-in). |
| `state`, `user-speech`, `transcript`, `interrupted`, `tool-call`, `turn`, `error`, `ended`, `transfer` | server → client | Session events (JSON). `transcript` has `role`, `text`, `final`; assistant partials arrive sentence by sentence. `ended` carries the end reason; the socket then closes with 1000. |

`message` and `say` are limited to 20 per call per minute (an `error` event is sent when exceeded).

**Close codes** (the reason string is the code name):

| Code | Reason | Meaning |
|---|---|---|
| 1000 | `call ended` | Normal end |
| 4400 | `bad_handshake` | First frame missing, binary, malformed, or wrong protocol version |
| 4401 | `invalid_token` / `token_expired` | Unknown or already-used token / token older than 10 minutes |
| 4403 | `origin_not_allowed` / `org_suspended` | `Origin` differs from the origin the call was created for / the org is suspended |
| 4408 | `handshake_timeout` | No first frame within 5 s |
| 4409 | `call_not_resumable` | Resume refused: the call ended, the token is stale, or the call is on another node |
| 4429 | `concurrency_limit` | The org already has `MAX_CONCURRENT_CALLS_PER_ORG` calls in progress |
| 4500 | `internal_error` | The call could not be set up (e.g. a provider has no key); the call is marked `error-internal` |
| 4503 | `server_busy` | This node is at `VOICE_MAX_SESSIONS` |

**Reconnect.** If the socket drops without a close frame (network change, lost Wi-Fi), the call keeps running on the server for `VOICE_RESUME_GRACE_MS` (default 15 s). Agent audio produced meanwhile is dropped; events are buffered and replayed after `ready`. A normal close (1000/1001) or a `hangup` ends the call at once. The call's transcript, timeline (`call.connected`, `client.connected` / `client.disconnected`, `turn`, `tool-call`, `interrupted`, `error`, `ended`), status, end reason, duration and usage are stored and shown by `GET /v1/calls/{id}`. The live call accepts the control routes below (`say`, `context`, `mute`, `end`, `transfer`).

**SDK bundles** `GET /sdk/widget.js` (the `<script>` embed) and `GET /sdk/octo-web.js` (ES module), plus their `.map` files. Public, `Access-Control-Allow-Origin: *`. `503 not_configured` until `npm run sdk:build` has run on the server.

## Chat: text conversations

The same assistants (config, function tools and squads) answer in text. STT, TTS and voice-only settings (voice, endpointing, interruption, idle reminders, `transferCall`, tool filler messages) are ignored. Not available in text yet: knowledge base (Phase 6) and post-conversation analysis (Phase 11).

| Method and path | Permission | Body / purpose |
|---|---|---|
| `POST /v1/chat` | `chat:create` | Send one user message; see below |
| `GET /v1/chat/sessions/{id}` | `chat:read` | Session (status, end reason, channel, current squad member, usage, expiry) with every stored message |
| `POST /v1/chat/sessions/{id}/end` | `chat:create` | End the session (`api-ended`) |
| `POST /v1/chat/completions` | `chat:create` (not public keys) | OpenAI-compatible; see below |
| `POST /v1/messaging/{provider}/webhook` | public, signed | Inbound SMS (`twilio`); see below |

**`POST /v1/chat`** `{message, sessionId?, assistantId? | squadId? | assistant?, version?, variables?, overrides?, metadata?, stream?}`

- **New conversation:** exactly one of `assistantId` (published, or the given `version`), `squadId`, or an inline `assistant` (private keys). The session pins that config, like a call pins a version.
- **Continue:** `sessionId` and `message` only; the session keeps its assistant, variables and overrides.
- **Response** (`stream` false): `{sessionId, message: {role: "assistant", content}, ended, endReason, memberId, toolCalls: [{name, status, latencyMs}], usage: {inputTokens, outputTokens, estimated, billingUnit, quantity}}`.
- **Streaming** (`stream: true`): `text/event-stream` with `event: session` `{sessionId}`, `event: delta` `{text}` (repeated), `event: tool-call` `{name, args}`, `event: tool-result` `{name, status}`, `event: handoff` `{from, to}`, then `event: done` (the response object above) or `event: error` (`{code, message, details}`). A comment line is sent every 15 s.
- **A failed turn** (`503 upstream_unavailable`, or an `error` event) stores nothing; retry the same message.
- **Sessions:** history is stored in full; the newest `CHAT_MAX_HISTORY_MESSAGES` (40) earlier messages go to the model with each new message, starting at a user message. A session expires after `CHAT_SESSION_IDLE_MINUTES` (24 h) without a message. It ends at `CHAT_MAX_MESSAGES_PER_SESSION` (400) stored messages (`max-messages`) or when the assistant calls `endCall` (`assistant-ended`). Sending to an ended session answers `409 conflict` with `details.reason` `session_expired` or `session_ended`. Turns on one session run one at a time (`409 turn_in_progress` if two API nodes race).
- **Public keys (web chat):** the same rules as web calls. The origin and assistant must be allowed, with the same override allowlist; no squads or inline assistants. The session continues only from the key and origin that started it (404 otherwise). 20 messages per session per minute (`429`). CORS preflight: `OPTIONS /v1/chat`.
- **Squads:** members hand off with a built-in `handoff` tool, limited to each member's declared targets, the squad's `maxHandoffs`, and ping-pong protection. The next member answers the same message with full history, a summary, or variables (its `contextMode`), and stays on for later messages.

**`POST /v1/chat/completions`** (OpenAI Chat Completions shape; works with the official OpenAI SDKs: `new OpenAI({ apiKey: 'sk_...', baseURL: 'https://api.example.com/v1' })`)

- `model`: an assistant id, `assistant:<id>`, or `squad:<id>`.
- `messages` is the history (stateless, as with OpenAI). The last message must be a user message. The assistant's own system prompt, tools and squad always apply. `system`/`developer` messages are added as extra instructions, and client `tool` messages are ignored.
- Supported: `stream`, `stream_options.include_usage`, `temperature`, `max_tokens` / `max_completion_tokens`, and `variables` (an extension, for new sessions). Refused with `400`: `tools` / `functions` (the assistant's tools run on the server) and `n` > 1. Other OpenAI fields are ignored.
- Every request is recorded as a chat session (channel `openai`, for usage and webhooks), returned in the `x-octo-session-id` header. Without that header on the request, the session ends after the response (`completed`). Send the header to add requests to an existing `openai` session.
- Errors use OpenAI's shape: `{"error": {"message", "type", "param", "code"}}`, where `code` is the error code above. The OpenAI SDK raises them as `NotFoundError`, `AuthenticationError`, `BadRequestError`, and so on.

**SMS** (optional channel): a number answers SMS only when its `capabilities` include `"sms"`, with its assigned assistant or squad.

- Point the provider's messaging webhook at `POST /v1/messaging/twilio/webhook`. It is verified with `X-Twilio-Signature` (`TWILIO_WEBHOOK_SECRET`) and acknowledged at once (`<Response></Response>`). The reply is sent afterwards through the Twilio REST API (`TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`).
- One active session per (our number, customer number), with the usual expiry. Variables `customer_number` and `phone_number` are filled in. The model is told to answer briefly in plain text.
- Replies are split at sentence (and Bangla `।`) boundaries into messages of at most `SMS_MAX_SEGMENTS_PER_MESSAGE` segments: 160 GSM-7 or 70 Unicode characters for one segment, 153/67 per segment when longer. A reply is at most `SMS_MAX_MESSAGES_PER_REPLY` messages; the rest is cut with "…".
- Keywords (the whole message, any case and punctuation): `STOP`, `STOPALL`, `UNSUBSCRIBE`, `CANCEL`, `END`, `QUIT`, `OPTOUT`, `REVOKE` record an org-wide opt-out, end the conversation and send one confirmation. `START`, `UNSTOP`, `OPTIN` resubscribe. `HELP`, `INFO` answer with how to opt out. Opted-out numbers get no reply at all.
- A provider retry of the same message (same `MessageSid`) is answered once. If the model fails, the assistant's `fallbackMessage` is sent when it has one.

**Usage and billing.** Every turn writes a `usage_record` (`subject_type: chat_session`) with messages, input and output tokens (flagged when estimated), provider, model, and who paid (platform or the org's own key). Its `quantity` is in the org's `chatBillingUnit` at the time: `message` (1 per turn, the default) or `token` (input + output). Set the unit with `PATCH /v1/org`. Prices and invoices come in the billing phase.

**Webhooks.** Endpoints can subscribe to `chat.started`, `chat.message` (`role`, `content`, `memberId`), `chat.tool-calls` and `chat.ended` (`endReason`, `messageCount`, `usage`, `durationMs`). The scopes are assistant, phone or org, and the most specific wins. Payloads carry `sessionId` and a per-session `sequence`. Message text (`content`) and customer numbers are included only for endpoints with `transcriptOptIn`. Events are queued as delivery rows; until the delivery worker exists (Phase 7), they are sent by `POST /v1/webhook-deliveries/{id}/redeliver`.

## Tools

| Method and path | Permission | Body / purpose |
|---|---|---|
| `POST /v1/tools` | `assistants:manage` | Creates a tool with `{name, description, type, parameters, messages?, endpointUrl?, timeoutMs?, retries?, auth?, authSecret?, staticParameters?, variableAliases?, sensitivePaths?, rejectionRules?}`. `authSecret` is encrypted and never returned. |
| `GET /v1/tools` | `assistants:read` | Tenant-scoped cursor-paginated tool list |
| `GET /v1/tools/{id}` | `assistants:read` | Tool definition without secrets |
| `PATCH /v1/tools/{id}` | `assistants:manage` | Updates tool configuration after strict validation |
| `DELETE /v1/tools/{id}` | `assistants:manage` | Deletes a tool |
| `POST /v1/tools/{id}/test` | `assistants:manage` | Runs the tool with a sample JSON argument object and returns status, output, error and latency |

Function tools POST JSON to `endpointUrl` with a timeout (20 seconds by default), bounded retries, bearer/header auth or an `x-octo-signature` HMAC-SHA256 header. Other tool types have validated interfaces and return an explicit `not_implemented` result until their call transport adapter is enabled. Sensitive argument paths are protected in call-tool logs. `staticParameters` override model arguments; `variableAliases` copy hidden call variables into arguments. Rejection rules can refuse a call based on the latest user message.

## Telephony and phone numbers

| Method and path | Permission | Purpose |
|---|---|---|
| `POST /v1/phone-numbers/import` | `assistants:manage` | Import an org-owned provider number, including `+880` Bangladesh numbers, and assign an assistant |
| `POST /v1/phone-numbers/buy` | `assistants:manage` | Buy a provider number through the configured adapter |
| `GET /v1/phone-numbers` | `assistants:read` | List org numbers |
| `GET/PATCH/DELETE /v1/phone-numbers/{id}` | read/manage | Read, assign/reconfigure, or release a number |
| `POST /v1/telephony/{provider}/webhook` | public, signed | Verify the provider signature, resolve the number, enforce concurrency, pin the published assistant version, and return a bidirectional media-stream response |
| `POST /v1/telephony/outbound` | `calls:create` | Dial an E.164 destination from an assigned number with voicemail detection |

The v1 adapter contract covers Twilio-compatible international providers and a generic SIP/WebSocket provider boundary. `TWILIO_WEBHOOK_SECRET` is required for real Twilio webhook verification. Inbound routing may call the configured phone-number hook with a bounded timeout; the static number assignment is the fallback. Recording storage is intentionally deferred.

## Campaigns: calling a contact list

A campaign calls a list of contacts with an assistant (or the first member of a squad), from one or more of the org's phone numbers. Schedules are in the **contact's** time zone. Design: [ARCHITECTURE section 3.21](ARCHITECTURE.md#321-outbound-campaigns-v1-as-built).

| Method and path | Permission | Purpose |
|---|---|---|
| `POST /v1/campaigns` | `campaigns:manage` | Create a draft. Honours `Idempotency-Key` |
| `GET /v1/campaigns` | `campaigns:read` | List (`status`, `limit`, `cursor`) |
| `GET /v1/campaigns/{id}` | `campaigns:read` | Read |
| `PATCH /v1/campaigns/{id}` | `campaigns:manage` | Edit a draft or paused campaign (the assistant or squad only while draft) |
| `DELETE /v1/campaigns/{id}` | `campaigns:manage` | Delete a draft. Anything that has run is kept (cancel it instead) |
| `POST /v1/campaigns/{id}/start` | `campaigns:manage` | draft → running |
| `POST /v1/campaigns/{id}/pause` | `campaigns:manage` | running → paused: **no new dials**; calls in progress finish and are recorded |
| `POST /v1/campaigns/{id}/resume` | `campaigns:manage` | paused → running |
| `POST /v1/campaigns/{id}/cancel` | `campaigns:manage` | Stop dialing and close the waiting contacts (`cancelled`); calls in progress finish |
| `POST /v1/campaigns/{id}/contacts` | `campaigns:manage` | Upload contacts (CSV text in JSON, up to 8 MB); see below |
| `GET /v1/campaigns/{id}/contacts` | `campaigns:read` | Contacts with status and outcome (`status`, `limit`, `cursor`) |
| `GET /v1/campaigns/{id}/stats` | `campaigns:read` | Dashboard statistics |
| `GET /v1/campaigns/{id}/export.csv` | `campaigns:read` | Per-contact results as CSV |
| `GET /v1/do-not-call` | `campaigns:read` | The org's do-not-call list |
| `POST /v1/do-not-call` | `campaigns:manage` | `{numbers: [...], reason?, defaultCountry?}` (up to 1000). Returns `{added, alreadyListed, invalid: [{value, reason}]}` |
| `DELETE /v1/do-not-call/{number}` | `dnc:remove` | Take a number off the list (URL-encode the `+`). Admins only |
| `POST /v1/telephony/{provider}/status/{attemptId}` | public, signed | The provider's call-progress callback (Twilio field names: `CallSid`, `CallStatus`, `AnsweredBy`, `CallDuration`, `ErrorCode`). The dialer gives this URL to the provider when it dials |

**Campaign body** (`POST`; `PATCH` takes any subset):

```jsonc
{
  "name": "Autumn outreach",
  "assistantId": "…",             // or "squadId": "…" (exactly one)
  "phoneNumberIds": ["…"],        // 1-20 active voice numbers, used in rotation
  "schedule": {
    "startDate": "2026-10-05", "endDate": "2026-10-30",   // contact-local dates, inclusive
    "allowedDays": [1, 2, 3, 4, 5],                       // ISO weekdays, 1 = Monday
    "windowStart": "09:00", "windowEnd": "17:00",         // contact-local, end exclusive, no overnight windows
    "defaultTimeZone": "Asia/Dhaka"                       // for contacts with no zone of their own
  },
  "maxConcurrentCalls": 5,        // 1-100, also capped by the org limit (MAX_CONCURRENT_CALLS_PER_ORG)
  "callsPerMinute": 60,           // 1-600, a sliding 60-second budget
  "retry": { "maxRetries": 2, "delayMinutes": 60 },   // total attempts = 1 + maxRetries
  "defaultCountry": "BD",         // optional: accept national numbers like 01712345678
  "disclosureText": "This is an AI assistant calling on behalf of Octo.",   // optional, spoken first
  "optOutPhrases": ["leave me alone"],   // optional, on top of the built-in English and Bangla list
  "optOutMessage": "Understood. Goodbye.",
  "outcomeLabels": ["interested", "not-interested"],  // what the assistant may report (reportOutcome tool)
  "successLabels": ["interested"]                      // subset of outcomeLabels counted as a success
}
```

The response adds `id`, `status` (`draft`, `running`, `paused`, `completed`, `cancelled`), `statusReason` (why the platform paused it, for example `no-active-phone-number`, `assistant-unavailable`, `telephony-not-configured`), `schedule.effectiveWindow` (the hours calls can actually start, see below) and timestamps. A running campaign becomes `completed` on its own when no contact is left to call.

**Calling hours.** A call may start only when, in the contact's own time zone, the date is inside `startDate`..`endDate`, the weekday is allowed, and the time is inside the window **cut to the platform calling hours** (`CAMPAIGN_HARD_CAP_START`..`CAMPAIGN_HARD_CAP_END`, default 08:00-21:00). No campaign can exceed the platform limit; a campaign window wholly outside it is refused. The check runs when a contact is claimed and again immediately before every dial, so pausing, resuming, retries or a slow queue cannot get around it. A contact's zone is the CSV `timezone` column, else the zone implied by the number's country (single-zone countries only, for example `+880` Asia/Dhaka), else `schedule.defaultTimeZone`.

**Contact upload** (`POST /v1/campaigns/{id}/contacts`):

```json
{ "csv": "phone,first_name,city\n+8801811000001,Asha,Dhaka\n", "mapping": { "phone": "phone", "variables": { "first_name": "Given name" } }, "defaultCountry": "BD", "dryRun": false }
```

- The first line is the header. The phone column is `phone`, `number`, `mobile`, `msisdn` or `e164` unless `mapping.phone` names it. `name` and `timezone` columns are recognised. Every other column becomes a `{{variable}}` of the same name (letters, digits, underscore), or is mapped with `mapping.variables` (`{{variable}}` → column). A `name` column also fills `{{customer_name}}`.
- Numbers must be E.164. Spaces, dashes, dots, brackets and a leading `00` are removed. With `defaultCountry` `BD`, `01712345678` and `8801712345678` are accepted.
- Rows are rejected, not the file, for: an invalid number, a duplicate (in the file, or already in the campaign), a number on the do-not-call list, an unknown time zone, a value over 1000 characters, or a missing `{{variable}}` the assistant needs and has no default for. The response lists every rejected row; `row` counts file lines with the header as line 1:

```json
{ "dryRun": false, "totalRows": 6, "imported": 3, "rejectedCount": 3,
  "rejected": [ { "row": 5, "value": "+8801811000001", "reason": "Duplicate of row 2" } ] }
```

- `dryRun: true` reports without saving. A whole-file problem (no phone column, a mapped column that is not in the header) is a `400` whose `details.issues[0].path` is `csv`.
- Limits: `CAMPAIGN_MAX_UPLOAD_ROWS` rows per upload (default 10,000) and `CAMPAIGN_MAX_CONTACTS` contacts per campaign (default 50,000). Uploading the same file twice adds nobody twice. Contacts can be added to a draft, running or paused campaign.

**Contact status and outcome.** `status` is `pending`, `calling`, `completed` (the conversation finished), `failed` (retries used up, or the call could not be placed), `do_not_call`, `cancelled`, or `expired` (the schedule ended first). `outcome` is how the latest attempt ended: `answered`, `voicemail`, `no-answer`, `busy`, `failed`, `canceled`, `dial-error`, `unconfirmed` or `lost`; contacts that were never dialed show `do-not-call` or `schedule-ended`. `outcomeLabel` and `outcomeNotes` are what the assistant reported with its `reportOutcome` tool, one of the campaign's `outcomeLabels`.

**Retry rules.**

- `no-answer`, `busy`, `voicemail` (an answering machine or fax) and a dial the provider rejected with a server error (`5xx`, `429`) are retried after `retry.delayMinutes`, until `1 + maxRetries` attempts were made. A retry goes through the calling-hours check again.
- An `answered` call is a completed conversation and is **never retried**, unless the platform itself failed during it (an `error-*` end reason).
- An opt-out ends everything for that number.
- Never retried: a number the provider rejected for good (`failed`), a call cancelled by us (`canceled`), and anything we cannot account for. `unconfirmed` means the dial request may have reached the provider. `lost` means no final event arrived within `CAMPAIGN_CALL_TIMEOUT_MINUTES`. A retry there could ring someone who already picked up.

**Compliance.**

- The org-level do-not-call list is checked before every dial, across all of the org's campaigns. Adding a number closes its waiting contacts at once. Removing a number does not reopen contacts already closed as `do_not_call`.
- A person who asks to stop during a call (the built-in English and Bangla phrases plus the campaign's own, or the assistant's opt-out tool) is added to the list before the call ends, and the call ends as `opted-out`.
- `disclosureText`, when set, is spoken before the assistant's first message on every campaign call. The assistant then speaks first even if it normally waits for the caller.

**Stats** (`GET /v1/campaigns/{id}/stats`):

| Field | Meaning |
|---|---|
| `contacts` | Counts by status, and `total` |
| `dialled`, `attempts` | Contacts with at least one dial; dials made (a retry is another attempt) |
| `answered`, `voicemail` | Contacts answered at least once by a person / by a machine |
| `completed` | Contacts whose conversation finished |
| `answerRate`, `completionRate` | `answered` and `completed` over `dialled` (`null` when nothing was dialed) |
| `successRate` | Contacts reported with one of `successLabels`, over `answered` (`null` without success labels or answers) |
| `outcomes` | Contacts per reported outcome label |
| `usage` | `callSeconds`, `callMinutes`, and provider units summed over the campaign's calls: `sttAudioSeconds`, `llmInputTokens`, `llmOutputTokens`, `ttsCharacters`. **Units, not money**: price tables arrive with billing (Phase 13) |

**Export** (`export.csv`): one line per contact: `phone, name, time_zone, status, outcome, outcome_label, outcome_notes, attempts, last_attempt_ended_at, next_attempt_at, call_id, duration_seconds, answered_by, end_reason`, then one `var.<name>` column per variable. A cell that starts with `=`, `+`, `-` or `@` is prefixed with an apostrophe so a spreadsheet cannot run contact-supplied formulas.

**Provider callbacks and stand-in providers.** The status callback refuses (`503 not_configured`) Twilio callbacks while `TWILIO_WEBHOOK_SECRET` is unset, because an HMAC with an empty key is one anyone can compute. In production it also refuses `sip`, `telnyx` and `vonage` callbacks, and campaigns on numbers of those providers pause (`telephony-not-configured`) instead of dialing: their adapters are stand-ins that accept any signature and place no call. Only `twilio` is live.

Errors: `409 conflict` for a control that does not fit the state (`details.status`, `details.allowedFrom`), for a start that could not dial (`details.reason`: `no_contacts`, `no_active_phone_number`, `schedule_ended`), and for an assistant with no published version.

## Call analysis, transcripts and structured outputs

When a call ends, the platform analyses it in the background (a queued job, retried on failure) according to the assistant's `analysis` settings, and stores the results on the call. Design: [ARCHITECTURE section 3.22](ARCHITECTURE.md#322-call-analysis-and-transcripts-v1-as-built).

| Method and path | Permission | Purpose |
|---|---|---|
| `GET /v1/calls` | `calls:read` | List calls with their analysis; filters below |
| `GET /v1/calls/{id}` | `calls:read` | One call: transcript (turn by turn, tool calls inline), timeline and `analysis` |
| `GET /v1/calls/{id}/analysis` | `calls:read` | The analysis alone (`404` until the call has ended) |
| `POST /v1/calls/{id}/analysis` | `calls:create` | Run the analysis again from scratch (`202`). Refused with `409` while it is queued or running, or if the call has not ended |
| `GET /v1/transcripts/search` | `calls:read` | Full-text search over the org's transcripts |
| `POST /v1/structured-outputs` | `assistants:manage` | Create a reusable structured output |
| `GET /v1/structured-outputs`, `GET /v1/structured-outputs/{id}` | `assistants:read` | List and read (with `assistantCount`, the assistants that list it) |
| `PATCH /v1/structured-outputs/{id}` | `assistants:manage` | Edit name, description, schema or prompt |
| `DELETE /v1/structured-outputs/{id}` | `assistants:manage` | Delete (soft): finished calls keep their results and the schema snapshot |

### Analysis settings (on the assistant: `config.analysis`)

```jsonc
{
  "analysis": {
    "summary": { "enabled": true, "prompt": "Summarise in one sentence, in English." },     // prompt optional
    "successEvaluation": {
      "enabled": true,
      "rubric": "pass-fail",            // pass-fail | numeric-scale (whole score 1-10) | categories | descriptive (free-text verdict)
      "categories": ["resolved", "escalated", "abandoned"],   // only with rubric "categories" (2-20, each once)
      "prompt": "Did the caller get the appointment they asked for?"                          // the question; optional
    },
    "structuredOutputIds": ["<id>", "<id>"],   // reusable structured outputs (up to 16), extracted after every call
    "structuredData": { "enabled": true, "prompt": "...", "schema": { "type": "object", "properties": {} } }   // an assistant's own schema; still supported, appears as the output named "inline"
  }
}
```

Each enabled step is a separate request to the call's own model chain (the org's key if set, else the platform key; same retries and fallbacks). The transcript is given to the model as data, and replies are accepted only in the exact JSON shape asked for. Transcripts longer than `ANALYSIS_MAX_TRANSCRIPT_CHARS` keep their start and end.

### Structured outputs

```json
{
  "name": "Booking",
  "description": "Did the caller book an appointment?",
  "schema": {
    "type": "object",
    "properties": {
      "appointment_booked": { "type": "boolean" },
      "date": { "type": "string", "format": "date" },
      "sentiment": { "type": "string", "enum": ["positive", "neutral", "negative"] }
    },
    "required": ["appointment_booked", "sentiment"],
    "additionalProperties": false
  },
  "prompt": "Only count bookings the assistant confirmed."
}
```

- The schema is a JSON Schema object (`"type": "object"`, at most 20,000 characters, at most 12 levels deep). It is checked with Ajv when saved and refused with `400` and the reason if it does not compile.
- **Not supported, by design:** `pattern` and `patternProperties` (a hostile regular expression could stall the service for every tenant), and `$ref` to anything but the same schema (`#/$defs/...`; nothing is ever fetched). Use `enum`, `format`, `minLength`, `maxLength` instead.
- Names are unique per org, ignoring case. One output can be listed by many assistants. An assistant may only list outputs of its own org that are not deleted (`400` at save and at publish otherwise). An output deleted later is skipped for calls of assistants that still list it.
- **Validation:** the model's values are validated against the schema. If the reply is not JSON or does not validate, the model is asked once more, shown what was wrong. If it still does not validate, that output is recorded as `failed` with the reason and the other steps carry on.

### The analysis object

On `GET /v1/calls/{id}`, `GET /v1/calls/{id}/analysis`, each item of `GET /v1/calls`, and in the webhook:

```jsonc
{
  "status": "succeeded",           // pending | running | succeeded | failed | skipped
  "skipReason": null,              // analysis-disabled | no-transcript (when skipped)
  "attempts": 1, "error": null,    // error: the last provider error (set while retrying, and when failed)
  "summary": "The caller booked...",
  "successEvaluation": { "rubric": "pass-fail", "passed": true, "score": null, "category": null, "reason": "Booked." },
  "structuredOutputs": [
    { "id": "<id>", "name": "Booking", "status": "succeeded", "values": { "appointment_booked": true, "sentiment": "positive" }, "error": null }
    // status: succeeded | failed | skipped; "id": null for the assistant's inline schema
  ],
  "usage": { "inputTokens": 855, "outputTokens": 55, "requests": 3 },   // the analysis model requests, all attempts
  "analysedAt": "2026-10-05T04:02:11.000Z", "nextAttemptAt": null
}
```

- **Job states.** `pending` (waiting, or waiting to retry at `nextAttemptAt`), `running`, `succeeded` (every enabled step ended; a step that never validated is shown inside the result as `failed`), `failed` (provider failures used up `ANALYSIS_MAX_ATTEMPTS`; steps that did succeed are kept), `skipped` (nothing to do). Provider failures are retried after 30 s, 2 min, 8 min (each ×4, at most an hour); a retry only redoes the steps that are missing. A worker that disappears is replaced when its lease ends.
- **Skipped:** the assistant has no analysis steps enabled, or the call has no spoken transcript. Phone calls have no transcript until the telephony media gateway (Phase 8) exists, so they are skipped for now.
- **Cost:** every request writes a `usage_record` (`subject_type` `call`, `channel` `analysis`, `billing_unit` `token`, with provider, model and `billing` `platform` or `customer`), including requests that failed after producing tokens. `usage` on the analysis sums them.

### Transcript entries

Each item of `transcript`, ordered by `seq` (the order things happened):

```jsonc
{ "seq": 3, "kind": "speech", "role": "user", "text": "I want to book Friday",
  "startedAt": "...", "endedAt": "...", "startOffsetMs": 5200, "endOffsetMs": 7900, "interrupted": false,
  "id": "...", "final": true, "createdAt": "..." }
{ "seq": 4, "kind": "tool-call", "role": "tool", "text": "bookAppointment",
  "toolCall": { "name": "bookAppointment", "arguments": { "day": "Friday" }, "result": null, "status": "requested" },
  "startedAt": "...", "endedAt": "...", "startOffsetMs": 8000, "endOffsetMs": 8000 }
```

- Times are when it was said: the caller from the start of their speech to its end, the assistant from its first audio to the end of play-out (typed text has equal start and end). Offsets are milliseconds since the call began. An assistant line cut short by the caller has `interrupted: true`, and its text is what the caller heard.
- A tool call is placed where the model asked for it, so its time can be a little after the start of the assistant line it belongs to. `result` and `status` are filled only when the tool ran through the tool executor (`null` and `requested` otherwise; the voice call path does not run function tools yet).
- `id`, `final` and `createdAt` are kept for older clients.

### Filtering calls

`GET /v1/calls` takes `limit` and `cursor` (newest first) and any of:

| Filter | Meaning |
|---|---|
| `assistantId`, `campaignId`, `status`, `type`, `direction` | The call's own fields |
| `endReason` | One end reason, or up to 10 separated by commas (any of them): `endReason=customer-ended-call,silence-timeout`. Kebab-case words only |
| `from`, `to` | Created at or after `from`, before `to` (ISO date or date-time) |
| `analysisStatus` | `pending`, `running`, `succeeded`, `failed` or `skipped` |
| `success=true\|false` | Pass-fail verdict |
| `successScore.gte`, `successScore.lte` | Numeric-scale score (1-10) |
| `successCategory` | Category rubric result |
| `output.<field>=value` | A structured output value, in **any** of the call's outputs. Example: `output.appointment_booked=true`. Compared as text, so `true`, `false`, numbers and strings all work |
| `output.<field>.gte\|gt\|lte\|lt=number` | A numeric range on a number field: `output.score.gte=7` |
| `outputId=<id>` (or `inline`) | Restrict every `output.*` filter to that one output |
| `q=text` | Calls whose transcript contains the words (same search as below) |

Filters combine with AND; each `output.*` filter may match a different output unless `outputId` is given. An unknown filter, a repeated filter, or a malformed value is `400`. Only succeeded outputs are matched, and only top-level fields of the extracted object.

### Transcript search

`GET /v1/transcripts/search?q=...` returns lines (speech and tool calls) of the org's calls whose text contains the words, newest first, with `limit`, `cursor`, and optional `assistantId`, `callId`, `from`, `to`. `q` follows web-search rules: words are ANDed, `"a phrase"`, `-excluded`, `or`. Matching is by whole word without stemming (works the same for Bangla and English). Each hit has `callId`, `assistantId`, `seq`, `kind`, `role`, `text`, `startedAt` and a `snippet` with the match marked as «word» (plain text; transcripts are caller-controlled, so escape it as usual before putting it in HTML).

### The end-of-call-report webhook

Queued once per call when its analysis reaches a final state (`succeeded`, `failed` or `skipped`), for the most specific enabled endpoint that subscribes to `end-of-call-report` (call > assistant > phone number > org). Re-running an analysis does not send it again. Payload `data`:

```jsonc
{ "call": { "id": "...", "type": "web", "direction": "web", "assistantId": "...", "assistantName": "...", "customerNumber": null, "campaignId": null,
            "status": "ended", "endReason": "assistant-ended", "startedAt": "...", "endedAt": "...", "durationMs": 91000, "usage": [] },
  "analysis": { /* the analysis object above */ },
  "transcript": [ /* transcript entries; only for endpoints with transcriptOptIn */ ] }
```

The summary and extracted values are always included (they are the point of the report); the transcript lines only for endpoints created with `transcriptOptIn: true`.

**Delivery** is automatic for call events (`WEBHOOK_DELIVERY_ENABLED`): signed (`x-octo-signature: t=<unix>,v1=<hex HMAC-SHA256 of "<t>.<body>">`, plus `x-octo-event` and `x-octo-delivery`), 10 s timeout, https only, and connections to private, loopback or metadata addresses are refused. A non-2xx answer or a timeout is retried after 30 s, 2 min, 10 min, 30 min, 1 h, 3 h and 6 h; the 8th failed attempt marks the delivery `dead`. Deliveries can arrive more than once; de-duplicate on the event `id` (`evt_<callId>_<sequence>`). Chat events are still queued only (use `POST /v1/webhook-deliveries/{id}/redeliver`). Progress is visible at `GET /v1/webhook-deliveries`.

## Boards, scorecards and monitoring policies

Per-org numbers about calls, org-defined metrics, and alert rules. One definition of each metric is shared by the three, so a board and the alert watching it never disagree. Rates are percentages (0-100) and money is not reported (usage units only, until billing).

| Method and path | Permission | Purpose |
|---|---|---|
| `GET /v1/boards/overview` | `calls:read` | Totals over a range |
| `GET /v1/boards/series` | `calls:read` | The same numbers per hour or day |
| `POST /v1/scorecards` | `monitoring:manage` | Create a scorecard |
| `GET /v1/scorecards`, `GET /v1/scorecards/{id}` | `monitoring:read` | List and read |
| `PATCH /v1/scorecards/{id}` | `monitoring:manage` | Edit `name`, `description`, `spec` |
| `DELETE /v1/scorecards/{id}` | `monitoring:manage` | Soft delete. `409` (`details.reason: in_use`, `details.policies`) while an alert policy watches it |
| `GET /v1/scorecards/{id}/value` | `monitoring:read` | Its value over a range |
| `GET /v1/scorecards/{id}/series` | `monitoring:read` | Its value per hour or day |
| `POST /v1/alert-policies` | `monitoring:manage` | Create a monitoring policy |
| `GET /v1/alert-policies` | `monitoring:read` | List (`state` = `unknown`, `ok` or `firing`) |
| `GET /v1/alert-policies/{id}` | `monitoring:read` | Read, with its current state |
| `PATCH /v1/alert-policies/{id}` | `monitoring:manage` | Edit any field |
| `DELETE /v1/alert-policies/{id}` | `monitoring:manage` | Delete, with its alert history |
| `POST /v1/alert-policies/{id}/test` | `monitoring:read` | What the rule says right now; records and notifies nothing |
| `GET /v1/alert-events` | `monitoring:read` | Alerts (`fired`, `reminder`, `resolved`) with their notifications (`policyId`, `type`) |

**Range** (boards and scorecard values): `from` and `to` (ISO date or date-time; `to` is exclusive, default now; `from` defaults to 7 days before `to`), at most `BOARD_MAX_RANGE_DAYS` (92) days; `assistantId` and `phoneNumberId` narrow the calls; `interval` is `hour` or `day` (default: hourly up to 3 days, daily above), at most 800 buckets. Buckets start on UTC hours or days.

**Overview** (`GET /v1/boards/overview`):

```jsonc
{ "range": { "from": "...", "to": "..." }, "filters": { "assistantId": null, "phoneNumberId": null },
  "calls": { "total": 120, "finished": 118, "errored": 3 },          // errored: error-* or worker-lost end reasons
  "errorRatePercent": 2.54, "avgDurationSeconds": 74.2,
  "success": { "evaluated": 90, "passed": 81, "ratePercent": 90, "scored": 0, "avgScore": null },   // pass-fail and 1-10 verdicts of the analysis
  "endReasons": [ { "reason": "customer-ended-call", "count": 70 } ],
  "latency": { "voiceToVoiceMs": { "samples": 640, "p50": 1450, "p95": 2600, "p99": 3100 } },          // spoken reply turns only
  "usage": { "callSeconds": 8900, "callMinutes": 148.33, "sttAudioSeconds": 4100, "llmInputTokens": 912000, "llmOutputTokens": 51000, "ttsCharacters": 230000 } }
```

**Series** (`GET /v1/boards/series`): `{range, interval, filters, buckets: [{bucket, calls, finished, errored, errorRatePercent, avgDurationSeconds, callSeconds, success: {evaluated, passed, ratePercent, avgScore}, latencyMs: {samples, p50, p95, p99}}]}`, one entry per bucket including empty ones.

**Scorecards** compute one number from the calls' analysis: `{name, description?, spec}` with

```jsonc
{ "source": { "type": "output", "field": "appointment_booked", "outputId": "<id> | inline (optional)" },   // or { "type": "success", "property": "passed" | "score" | "category" }
  "aggregate": "rate",            // rate | avg | min | max | sum | count
  "equals": true,                 // rate only: the value that counts as a hit (success.passed defaults to true)
  "filters": { "assistantId": "...", "phoneNumberId": "..." } }   // optional
```

`success.passed` and `success.category` allow `rate` and `count`; `success.score` allows `avg`, `min`, `max`, `sum`, `count`. Names are unique per org (ignoring case). `/value` answers `{scorecardId, name, range, value, sample, unit}` (`unit`: `percent`, `count`, `score` or `value`; `value` is `null` without data); `/series` answers `{scorecardId, name, range, interval, points: [{bucket, value, sample, unit}]}`. Values are computed from the calls on every request, so a new scorecard has history at once.

**Monitoring policies** watch one metric over a sliding window and notify on changes:

```jsonc
{ "name": "Error rate", "enabled": true,
  "metric": "error_rate",         // success_rate | error_rate | latency_p50_ms | latency_p95_ms | latency_p99_ms | call_count | avg_duration_ms | scorecard
  "scorecardId": null,            // required with metric "scorecard", and only then
  "comparison": "gt", "threshold": 5,          // rates are 0-100; latency and duration in ms
  "windowMinutes": 60,            // calls created in the last 5 minutes to 7 days
  "minSamples": 5,                // fewer calls (turns for latency) and the rule says nothing either way
  "assistantId": null, "phoneNumberId": null,
  "notify": { "email": true, "userIds": [], "webhookEndpointId": null },   // no userIds: every owner and admin; the webhook must be an org-scoped endpoint
  "renotifyMinutes": 360 }        // reminder while still breaching; 0 never
```

Responses add `unit`, `status: {state, since, lastValue, lastSample, lastEvaluatedAt, lastNotifiedAt}` and timestamps. The monitoring worker (`MONITORING_ENABLED`, every `MONITORING_TICK_SECONDS`) evaluates enabled policies: `ok` or `unknown` to breach is `fired`, still breaching after `renotifyMinutes` is a `reminder`, back within the threshold is `resolved`. Each is an alert event, and each recipient gets one email (with a link to `/monitoring/policies/{id}` on the dashboard) or one signed webhook (`x-octo-event: alert.fired`, `alert.reminder` or `alert.resolved`; body `{id: "alert_<eventId>", type, createdAt, data: {policy, state, value, sample, unit, description}}`), retried up to 5 times. `/test` answers `{policyId, status: "breach" | "ok" | "no-data", value, sample, unit, threshold, comparison, windowMinutes, minSamples}`. Alert events: `{id, policyId, policyName, type, value, sample, rule: {metric, comparison, threshold, windowMinutes}, createdAt, notifications: [{channel, target, status, attempts, error, sentAt}]}`.

Validation answers `400` with field paths: a rate threshold outside 0-100, `scorecardId` without metric `scorecard` (or the reverse), `notify` with neither email nor a webhook, and references to assistants, numbers, scorecards, members or webhook endpoints that are not the org's own.

## Per-call debug view

`GET /v1/calls/{id}/debug` (`calls:read`): everything recorded for one call in the order it happened, to answer "why did it say that, and why was it slow".

- Query: `types` (comma-separated event types to keep) and `bodies=true` (include the stored LLM prompt and reply text, kept only for assistants with `debug.captureLlm: true`, for `DEBUG_RETENTION_DAYS`).
- Response: `{call: {id, assistantId, assistantName, status, endReason, startedAt, endedAt, durationMs, captureLlm}, summary: {events, byType, providerErrors, providerFallbacks, errors, llmRequests, droppedLogLines, droppedPartials}, turns: [{index, kind, interrupted, latency}], truncated, timeline: [{at, offsetMs, type, id, payload, body?}]}`.
- `timeline` holds state changes, partial and final transcripts (`transcript`), LLM requests and responses, tool calls, provider errors and fallbacks, the call's own log lines (up to `DEBUG_LOG_LINES_PER_CALL`) and turn latency, at most 5000 entries (`truncated`).

## Live call control

All control and status routes require an authenticated session or private org key. The call id is
looked up inside the authenticated org transaction; another org receives `404`.

| Method and path | Body / purpose |
|---|---|
| `POST /v1/calls/{id}/say` | `{message}`: speak an operator message |
| `POST /v1/calls/{id}/context` | `{context}`: inject trusted operator context into future LLM turns |
| `POST /v1/calls/{id}/mute` | `{muted}`: suppress/resume assistant audio |
| `POST /v1/calls/{id}/end` | End the active call with `api-ended` |
| `POST /v1/calls/{id}/transfer` | `{destination, mode: cold|warm, summary?, failureAction}`; failure actions are `return-to-agent`, `take-message`, or `end` |
| `GET /v1/calls/{id}` | Status, timeline, transcript (turn by turn with times and tool calls), `analysis`, usage/cost, recording URL, and end reason. See [call analysis](#call-analysis-transcripts-and-structured-outputs) |
| `GET /v1/calls/{id}/live` | Authorized WebSocket stream of live call events and transcript/control events |

Transfer destinations should be declared in the assistant's `transferCall` configuration with a
description of when each is appropriate. Engine transfers emit the final `transferred` reason after
successful connection; warm transfers speak the summary before connecting.

## Squads

| Method and path | Permission | Purpose |
|---|---|---|
| `POST /v1/squads` | `assistants:manage` | Create an ordered squad with saved `assistantId` or validated `inlineConfig` members |
| `GET /v1/squads` | `assistants:read` | List org squads |
| `GET/PATCH/DELETE /v1/squads/{id}` | read/manage | Inspect, update, or delete a squad |

Each member has `contextMode` (`full`, `summary`, or `variables`), optional extracted-variable JSON
Schema, member-only overrides, and `handoffTargets` containing descriptions. `maxHandoffs` and
ping-pong detection protect calls from routing loops. Squad-wide overrides apply without modifying
saved assistants. Bangladesh phone numbers can assign a squad through `squadId`; the first ordered
saved member starts the call.

## Customer webhooks

Create endpoints with `POST /v1/webhooks`. Endpoints can be scoped to `org`, `phone`, `assistant`, or
`call`; the most specific enabled endpoint wins. `GET /v1/webhook-deliveries` shows delivery attempts,
and `POST /v1/webhook-deliveries/{id}/redeliver` manually retries one delivery. Async events are
persisted as pending queue rows with exponential backoff and become `dead` after repeated failures.
Decision events (`assistant-request`, `tool-calls`, and `transfer-destination-request`) use the same
payload contract synchronously with a strict timeout and a configured fallback.

Every request includes `X-Octo-Signature: t=UNIX_SECONDS,v1=HEX_HMAC`, signing `timestamp + "." + raw_body`
with the endpoint secret. Reject timestamps older than five minutes and compare the digest in constant
time.

JavaScript:

```js
const raw = await request.text();
const signature = request.headers.get('x-octo-signature');
const [, timestamp, digest] = /^t=(\d+),v1=([a-f0-9]+)$/.exec(signature) || [];
const expected = crypto.createHmac('sha256', process.env.OCTO_WEBHOOK_SECRET)
	.update(`${timestamp}.${raw}`).digest('hex');
if (Math.abs(Date.now() / 1000 - Number(timestamp)) > 300 || !crypto.timingSafeEqual(Buffer.from(digest), Buffer.from(expected))) throw new Error('invalid webhook');
```

Python:

```python
import hashlib, hmac, time
raw = request.get_data()
timestamp, digest = request.headers["X-Octo-Signature"].split(",")
timestamp = int(timestamp.removeprefix("t=")); digest = digest.removeprefix("v1=")
expected = hmac.new(SECRET.encode(), f"{timestamp}.".encode() + raw, hashlib.sha256).hexdigest()
if abs(time.time() - timestamp) > 300 or not hmac.compare_digest(digest, expected): raise ValueError("invalid webhook")
```

Go:

```go
raw, _ := io.ReadAll(r.Body)
parts := strings.Split(r.Header.Get("X-Octo-Signature"), ",")
ts, _ := strconv.ParseInt(strings.TrimPrefix(parts[0], "t="), 10, 64)
h := hmac.New(sha256.New, []byte(secret)); h.Write([]byte(fmt.Sprintf("%d.", ts))); h.Write(raw)
if time.Since(time.Unix(ts, 0)) > 5*time.Minute || !hmac.Equal([]byte(strings.TrimPrefix(parts[1], "v1=")), []byte(hex.EncodeToString(h.Sum(nil)))) { http.Error(w, "invalid webhook", 401); return }
```

For local Bangladesh development, expose the HTTPS API with `ngrok http 3300` or `cloudflared
tunnel --url http://127.0.0.1:3300`, then register the generated HTTPS URL. A local event-forwarding
CLI is reserved for Phase 12; manual redelivery is available now.
