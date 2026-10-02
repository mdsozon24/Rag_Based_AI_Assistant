# Voice engine (`packages/engine`)

Real-time cascaded voice pipeline for Voice of Octo:

```
caller audio ─► decode/resample ─► VAD + endpointing ─► STT (streaming) ─► LLM (streaming) ─► sentence chunker ─► TTS (streaming) ─► encode/resample ─► caller
```

One `CallSession` owns one conversation. It runs the state machine, keeps the history, applies the assistant config, and records timestamps for every stage. The engine has no database. Persisting calls and events comes in Phases 5 and 7.

Status: v1. Built ahead of the phase order on 2026-10-01. See [docs/PROGRESS.md](../../docs/PROGRESS.md).

## Quick start

```bash
npm test                 # all engine tests, offline (fake providers)
npm run voice:dev        # mic test page on http://localhost:3200 (real providers, needs .env keys)
npm run voice:smoke      # scripted real-provider call in Bangla, prints latency and usage
npm run voice:smoke -- en fast   # English, "fast" preset (needs Deepgram, OpenAI and Cartesia keys)
```

`voice:dev` and `voice:smoke` use the platform keys in `.env` (the default `balanced` preset needs `GEMINI_API_KEY` and `ELEVENLABS_API_KEY`), and they spend API credit. The dev page has a preset picker. The dev server listens on `127.0.0.1` only and has no authentication. Use headphones when you test barge-in.

## Layout

| Path | What |
|---|---|
| `src/engine/callSession.ts` | `CallSession`: turn flow, barge-in, idle and max-duration handling, failover |
| `src/engine/stateMachine.ts` | States `connecting`, `listening`, `thinking`, `speaking`, `transferring`, `ended`, with validated, timestamped transitions |
| `src/engine/config.ts` | Per-assistant config (zod) |
| `src/engine/endReason.ts` | `EndReason` enum |
| `src/engine/metrics.ts` | Per-turn timestamps, latency breakdown, p50/p95 |
| `src/engine/sentenceChunker.ts` | Cuts LLM text into speakable chunks (handles the Bangla `।`, decimals, clause-first chunk) |
| `src/engine/speechPipeline.ts` | Text chunks → ordered TTS audio, two requests in flight |
| `src/engine/playout.ts` | Play-head tracking: what the caller actually heard |
| `src/vad/speechDetector.ts` | Energy VAD with a minimum-statistics noise floor, plus endpointing |
| `src/audio/` | μ-law codec, streaming polyphase resampler, `AudioConverter` (the only place formats are converted) |
| `src/providers/types.ts` | `Transcriber`, `LanguageModel`, `VoiceSynthesizer` interfaces and `ProviderError` |
| `src/providers/adapters/` | ElevenLabs, Deepgram, custom (STT); Google, OpenAI, custom (LLM); ElevenLabs, Cartesia, custom (TTS) |
| `src/providers/registry.ts`, `catalog.ts` | Provider registry and the built-in provider specs (zod schema + build) |
| `src/providers/presets.ts` | `fast`, `balanced`, `quality` presets and the override rules |
| `src/providers/resolve.ts` | Per-call resolution: org key or platform key, primary and fallbacks |
| `src/providers/chain.ts` | Timeouts, retries, ordered fallback and usage metering per component |
| `src/providers/net.ts` | HTTP client abstraction, SSE parsing, SSRF guard for custom endpoints |
| `src/credentials/` | Envelope encryption, masked views, org-scoped store and service (BYOK) |
| `src/engine/usage.ts` | Per-call usage records for billing |
| `src/platform.ts` | Wires registry, credentials and policy from env |
| `src/transport/` | `Transport` interface, browser WebSocket transport, in-process loopback |
| `src/testing/` | Fake STT/LLM/TTS and a simulated caller (also for future simulations) |
| `dev/` | Mic dev server and page, smoke script, assistant presets |
| `test/` | Unit, integration, provider contract (`test/contracts/`), registry, credential and fallback tests |

## How a turn works

1. Caller audio (μ-law 8 kHz or PCM16 16/24 kHz) is converted to PCM16 16 kHz. It goes to the speech detector and is streamed to STT.
2. **Endpointing.** After `endpointing.silenceMs` of silence following speech, the session commits the STT segment and waits for the final transcript (up to `sttFinalTimeoutMs`; after that it uses the last partial). An empty transcript (noise) goes back to listening without calling the LLM.
3. The LLM streams tokens. The chunker sends the first sentence to TTS as soon as it is complete, or the first clause if that is long enough. Later sentences are synthesized while earlier ones play. Audio streams to the transport, and the state becomes `speaking` on the first audio byte.
4. **User keeps talking.** If the user speaks again before any agent audio (state `thinking`), the reply is cancelled and both utterances are merged into one turn.
5. **Barge-in.** Speech of at least `interruption.minSpeechMs` while the agent is audible triggers four steps. The transport is told to `clear` (stop playback now). LLM and TTS are aborted. History records only the text the caller heard, from the play-head. Then the session goes back to `listening`. While the agent talks, STT receives silence, so it doesn't transcribe echo. The last 400 ms of real audio are replayed to STT at the barge-in, so the caller's first words are kept.
6. After the audio finishes playing, the session goes back to `listening` and the idle timer starts.

## Assistant config

All fields have defaults (`parseAssistantConfig({})` is valid).

| Field | Default | Meaning |
|---|---|---|
| `language` | `en` | Drives STT, TTS and sentence splitting (`bn`, `en`, ...) |
| `systemPrompt` | short generic prompt | LLM system instruction |
| `firstMessage.mode` | `assistant-speaks-first` | Or `wait-for-user` |
| `firstMessage.text` | `Hello! How can I help you today?` | Greeting (interruptible) |
| `endpointing.silenceMs` | 600 | Silence that ends the user's turn |
| `endpointing.minSpeechMs` | 120 | Speech needed to open a turn |
| `endpointing.vadMarginDb` / `vadMinSpeechDb` | 12 / -50 | VAD sensitivity |
| `endpointing.sttFinalTimeoutMs` | 1500 | Wait for the STT final, then use the last partial |
| `interruption.enabled` | true | Barge-in on or off |
| `interruption.minSpeechMs` | 140 | Speech needed to interrupt (keeps the stop under 200 ms) |
| `interruption.echoGuardDb` | 6 | Extra threshold while the agent talks |
| `idle.timeoutMs` | 10000 | Silence before a reminder (0 = off) |
| `idle.message` / `idle.maxPrompts` / `idle.endMessage` | "Are you still there?" / 2 / "" | Reminder text, reminders before `silence-timeout`, optional goodbye |
| `maxDurationMs` / `maxDurationMessage` | 600000 / "" | Hard call limit (0 = off) |
| `fallback.message` | apology | Spoken when a provider fails after its retry |
| `fallback.action` / `fallback.transferTo` | `end` / – | `end`, or `transfer` to a named destination |
| `fallback.prefetchAudio` | true | Synthesize the fallback message once at the start, so it can play even if TTS later fails |
| `tools.endCall.enabled` | true | Lets the LLM hang up (after its goodbye has played) |
| `tools.transferCall.destinations` | [] | `{ name, target, description?, message? }` |
| `preset` | `balanced` | `fast`, `balanced` or `quality` (see Providers) |
| `transcriber` | from preset | `{provider, model?, language?, ...provider fields, fallbacks?, retries?, connectTimeoutMs?}` |
| `model` | from preset | `{provider, model?, temperature?, maxTokens?, ...provider fields, fallbacks?, retries?, firstTokenTimeoutMs?, idleTimeoutMs?}` |
| `voice` | from preset | `{provider, voiceId?, model?, ...provider fields, fallbacks?, retries?, firstByteTimeoutMs?, idleTimeoutMs?}` |
| `*.retries` | 1 | Attempts per provider after the first, when it failed before producing output |
| `*.fallbacks` | from preset | Ordered list of other providers for the component (max 3) |
| `transcriber.connectTimeoutMs` | 5000 | |
| `model.firstTokenTimeoutMs` / `idleTimeoutMs` | 5000 / 10000 | |
| `voice.firstByteTimeoutMs` / `idleTimeoutMs` | 5000 / 10000 | |

## Providers

### Interfaces

`src/providers/types.ts` defines the three interfaces. All of them stream, take an `AbortSignal`, report failures as `ProviderError` (`stage`, `provider`, `retryable`, `code`), and identify themselves with `provider` and `model`.

| Interface | Method | Streams |
|---|---|---|
| `Transcriber` | `connect(options, handlers, ctx)` → `TranscriberStream` (`sendAudio`, `commit`, `close`) | partial and final transcripts via handlers |
| `LanguageModel` | `stream(request, ctx)` | `text`, `tool-call` (`id`, `name`, `args`) and `usage` (`inputTokens`, `outputTokens`) events |
| `VoiceSynthesizer` | `stream(request, ctx)`, `outputFormat` | PCM16 audio chunks (whole samples) |

`LlmRequest` carries `systemPrompt`, `messages`, `tools`, `temperature` and `maxTokens`. Messages may already include assistant `toolCalls` and `tool` results, and every adapter maps them, so the tool runtime can plug in later without interface changes.

### Built-in providers

| Component | `provider` | Default model | Provider fields | Platform key |
|---|---|---|---|---|
| transcriber | `elevenlabs` | `scribe_v2_realtime` | `model`, `language`, `keyterms` | `ELEVENLABS_API_KEY` |
| transcriber | `deepgram` | `nova-3` | `model`, `language`, `keyterms`, `smartFormat` | `DEEPGRAM_API_KEY` |
| transcriber | `custom` | – | `url` (wss), `credentialId`, `headers`, `model`, `language` | – |
| model | `google` | `gemini-3.1-flash-lite` | `model`, `temperature`, `maxTokens`, `thinkingLevel` | `GEMINI_API_KEY` |
| model | `openai` | `gpt-4.1-mini` | `model`, `temperature`, `maxTokens` | `OPENAI_API_KEY` |
| model | `custom` | – | `url` (https, OpenAI-compatible), `credentialId`, `headers`, `model`, `temperature`, `maxTokens`, `maxTokensField` | – |
| voice | `elevenlabs` | `eleven_v3_conversational` | `voiceId`, `model`, `stability`, `similarityBoost`, `style`, `speed` | `ELEVENLABS_API_KEY` |
| voice | `cartesia` | `sonic-3.6` | `voiceId`, `model`, `speed` | `CARTESIA_API_KEY` |
| voice | `custom` | – | `url` (https), `credentialId`, `headers`, `voiceId`, `model`, `sampleRate` | – |

Unknown providers and unknown fields are rejected with the list of valid options, for example `Unknown transcriber provider "whisperx". Available transcriber providers: elevenlabs, deepgram, custom` or `voice: unknown field(s) voiceID for provider "elevenlabs"`.

Bangla (`bn`) support was checked in each vendor's docs on 2026-10-01: Scribe v2, Deepgram Nova-3, Gemini, OpenAI, ElevenLabs v3 and Cartesia Sonic 3.6.

### Presets

| Preset | Transcriber | Model | Voice | `silenceMs` |
|---|---|---|---|---|
| `fast` | deepgram nova-3 → elevenlabs | openai gpt-4.1-mini → google flash-lite | cartesia sonic-3.6 → elevenlabs | 400 |
| `balanced` (default) | elevenlabs scribe → deepgram | google gemini-3.1-flash-lite → openai gpt-4.1-mini | elevenlabs v3 conversational → cartesia | 600 |
| `quality` | elevenlabs scribe → deepgram | openai gpt-4.1 → google gemini-3.8-flash | elevenlabs v3 → cartesia | 800 |

`→` marks the fallback. Override rules for an assistant component:

- **Same provider (or no provider given):** the fields are merged over the preset, and the preset's fallbacks are kept unless `fallbacks` is given.
- **Different provider:** the override replaces the preset component, fallbacks included.

```json
{ "preset": "balanced", "voice": { "voiceId": "my-bangla-voice" } }
{ "preset": "fast", "model": { "provider": "google", "model": "gemini-3.1-flash-lite", "temperature": 0.3, "maxTokens": 200,
  "fallbacks": [{ "provider": "openai", "model": "gpt-4.1-mini" }] } }
```

### Credentials (bring your own key)

- **Storage:** an org stores a key per vendor through `CredentialService.create(orgId, {provider, secret, label})`. The key is encrypted at rest with AES-256-GCM envelope encryption: a per-record data key, wrapped by `CREDENTIALS_ENCRYPTION_KEY`. Both layers are bound to org id, record id and provider, so a record cannot be decrypted as another org's.
- **Reading:** `create`, `list` and `get` return only `{id, orgId, provider, label, masked: "••••abcd", createdAt, lastUsedAt}`. Secrets are never returned. Internally they travel as `Secret` objects, which print `[REDACTED]` in JSON, string conversion and logs.
- **Key choice per call:** the org's key if it stored one, which is `customer`-billed. Otherwise the platform key, which is `platform`-billed. With neither, the call fails before it starts, with a message naming the env var. Fallbacks without a key are skipped with a warning.
- **Storage backend:** the store is in memory for now, and every method takes `orgId`. The Postgres table, row-level security and the authenticated HTTP API arrive with Phase 2.

### Custom endpoints (public contract, v1)

- **Security:** customer endpoints must use `https`/`wss`. URLs with embedded credentials are refused. Every resolved address is checked when connecting, and private, loopback, link-local, CGNAT and metadata ranges (e.g. `169.254.169.254`) are blocked. An optional secret, stored as an org credential of provider `custom` and referenced by `credentialId`, is sent as `Authorization: Bearer <secret>`.
- **Model:** an OpenAI-compatible `POST {url}/chat/completions` with `stream: true`, returning SSE `chat.completion.chunk` events. Tools use the OpenAI `tools` / `tool_calls` format; usage comes from the final chunk if sent. It uses `max_tokens` unless `maxTokensField` says otherwise.
- **Voice:** `POST {url}` with `{"text","language","voiceId","sampleRate","encoding":"pcm_s16le"}`. The response is `200` with raw PCM16 LE mono at `sampleRate`, streamed.
- **Transcriber:** a WebSocket at `{url}`. The client sends `{"type":"start","encoding":"pcm_s16le","sampleRate":16000,"language":"bn"}`, then binary PCM16 frames, then `{"type":"commit"}` at the end of each user turn. The server sends `{"type":"partial","text"}`, `{"type":"final","text"}` (one per commit) and `{"type":"error","message","fatal"}`.

### Usage records (billing)

Each call summary has `usage`, with one record per component, provider, model and credential:

```json
{ "component": "voice", "provider": "elevenlabs", "model": "eleven_v3_conversational", "credentialSource": "platform",
  "billing": "platform", "fallback": true, "estimated": false,
  "units": { "requests": 1, "characters": 13, "audioSecondsOut": 1.44 } }
```

| Field | Values |
|---|---|
| Units | transcriber `audioSeconds` (audio streamed); model `inputTokens` / `outputTokens`; voice `characters` (requests that produced audio) and `audioSecondsOut`; `requests` for all |
| `billing` | `platform` (platform key) or `customer` (org key or custom endpoint) |
| `estimated` | Set when tokens were estimated (about 4 characters per token) because the provider reported none, e.g. the stream was cut by a barge-in |

Records are in the summary and the `call ended` log line. Persisting them as `usage_record` comes with billing (Phase 13).

### Adding a provider

1. Implement the interface in `src/providers/adapters/`. Use `ProviderError` with a correct `retryable`, honour the `AbortSignal`, and for audio yield whole PCM16 samples.
2. Register a spec in `src/providers/catalog.ts`: id, strict zod schema, default model, and a build function that calls `vendorKey(context, '<vendor>')`. Add the vendor to `PLATFORM_KEY_ENV` in `src/credentials/service.ts`.
3. Add a harness entry to `test/contracts/providers.contract.test.ts` and make the whole contract pass.

## Failure handling

Every provider call has a timeout: STT connect, STT final, LLM first token and idle, TTS first byte and idle.

- **Each provider** is retried `retries` times (default 1), but only if it failed before producing any output. Retrying after output would repeat audio the caller already heard.
- **Then the next fallback** in the component's list is tried, under the same rule. A switch is sticky for the rest of the call.
- **STT:** a dropped stream gets one reconnect, which goes through the same chain.
- **Errors that won't go away** (bad key, quota) skip the retry and go straight to the next fallback.

When the last provider in the chain also fails, the session stops any playback and speaks `fallback.message`. It then ends with `error-stt`, `error-llm` or `error-tts`, or transfers to `fallback.transferTo`. If TTS itself is down and no prefetched audio exists, it ends without speaking. It never stays silent with the line open.

## End reasons (`EndReason`)

`customer-hung-up`, `assistant-ended`, `silence-timeout`, `max-duration`, `error-stt`, `error-llm`, `error-tts`, `transferred`, `error-internal`.

`error-internal` is for engine bugs and failed transfers. A provider failure that ends in a fallback transfer keeps its `error-*` reason, and the summary also records `transferredTo`. See DECISIONS D28.

## Latency fields (per reply turn)

| Field | From → to |
|---|---|
| `endpointingMs` | end of user speech (VAD) → endpoint decided (≈ `silenceMs`) |
| `sttFinalMs` | STT commit → final transcript |
| `llmFirstTokenMs` | LLM request → first token |
| `ttsFirstByteMs` | first TTS request → first audio byte |
| `pipelineMs` | endpoint → first agent audio leaving the engine |
| `voiceToVoiceMs` | end of user speech → first agent audio leaving the engine (= endpointing + pipeline) |
| `bargeInStopMs` | onset of the interrupting speech → `clear` sent |

The raw timestamps are in `turn.timestamps`. The call summary has `latency[metric] = { count, p50, p95, min, max }` over reply turns. `LatencyRecorder` aggregates across calls (the dev server serves it at `GET /stats`). Each turn is logged as a `turn complete` JSON line, and each call as a `call ended` line with p50/p95. Every log line carries `call_id`.

## WebSocket protocol v1 (dev server; basis for `/v1/calls/{id}/ws` in Phase 5)

Endpoint (dev): `ws://127.0.0.1:3200/ws?lang=bn|en&preset=fast|balanced|quality&greet=1|0&silenceMs=600`

| Direction | Frame | Content |
|---|---|---|
| client → server | binary | Caller audio, PCM16 LE mono 16 kHz, any frame size (20 ms recommended) |
| client → server | text | `{"type":"hangup"}` |
| server → client | binary | Agent audio, PCM16 LE mono 24 kHz, sent faster than real time; buffer and play in order |
| server → client | text | `{"type":"clear"}`: stop playback now and drop everything buffered |
| server → client | text | `{"type":"state","state":"listening","at":<ms>}` |
| server → client | text | `{"type":"user-speech","speaking":true,"at":<ms>}` |
| server → client | text | `{"type":"transcript","role":"user"\|"assistant","text":"...","final":bool,"interrupted"?:true}` |
| server → client | text | `{"type":"interrupted","at":<ms>,"heardText":"..."}` |
| server → client | text | `{"type":"turn","turn":{index,kind,userText,generatedText,heardText,interrupted,timestamps,latency}}` |
| server → client | text | `{"type":"error","stage":"stt"\|"llm"\|"tts"\|"internal","message":"..."}` |
| server → client | text | `{"type":"transfer","destination":{"name","target"}}` (web calls can't be bridged; telephony comes in Phase 8) |
| server → client | text | `{"type":"ended","reason":"<EndReason>","summary":{...}}`; then the socket closes |

Dev HTTP endpoints: `GET /` (test page), `GET /health`, `GET /stats` (active calls and p50/p95 across calls).

## Environment variables

| Variable | Purpose |
|---|---|
| `GEMINI_API_KEY`, `ELEVENLABS_API_KEY`, `DEEPGRAM_API_KEY`, `OPENAI_API_KEY`, `CARTESIA_API_KEY` | Platform keys per vendor (platform-billed). Shared with the legacy app where the names overlap |
| `ELEVENLABS_VOICE_ID`, `CARTESIA_VOICE_ID` | Default voice per vendor when an assistant sets none |
| `CREDENTIALS_ENCRYPTION_KEY`, `CREDENTIALS_KEY_ID`, `CREDENTIALS_PREVIOUS_KEYS` | Master key(s) for org credentials (32 bytes, base64; rotation) |
| `CUSTOM_ENDPOINTS_ALLOW_PRIVATE` | Development only: allow custom endpoints on private networks and without TLS |
| `VOICE_DEV_PORT`, `LOG_LEVEL` | Dev server port; log level |

All are documented in [.env.example](../../.env.example). The `VOICE_LLM_MODEL` / `VOICE_STT_MODEL` / `VOICE_TTS_MODEL` / `VOICE_LLM_THINKING_LEVEL` variables from v1 were removed; models are now assistant config (presets).

## Known limitations

- **The 800 ms target is not met with the current providers.** Measured on 2026-10-01 from this machine: pipeline p50 ≈ 1.9–2.0 s, voice-to-voice p50 ≈ 2.4–2.6 s with `silenceMs` 600. Gemini's first token is about 1.0 s, Scribe's final about 0.4 s and ElevenLabs' first byte about 0.4 s. See PROGRESS for options.
- **The VAD is energy-based.** Loud background talkers or TV can trigger turns or barge-ins. A neural VAD (Silero) or semantic turn detection is the planned upgrade.
- **"What was heard" is a server-side estimate** (play-head plus the client's start-up lead). Clients don't yet report their playback position.
- **No telephony transport yet.** The μ-law/8 kHz path is implemented and tested through the loopback transport, and Twilio/Telnyx media streams arrive in Phase 8. Transfer on a web call only notifies the client.
- **Fallbacks are per call.** A provider that fails is skipped for the rest of that call only; there is no cross-call circuit breaker yet.
- **The dev page resamples the mic with linear interpolation** (no anti-alias filter). That's fine for testing, but the web SDK (Phase 5) should use the polyphase resampler.
