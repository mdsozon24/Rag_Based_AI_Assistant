# @octo/web

Put a Voice of Octo assistant on a website or in an app: an embeddable widget (one `<script>` tag) and a TypeScript SDK for your own UI. Protocol and endpoint details: [docs/API.md](../../docs/API.md#browser-and-app-calls-web-sdk).

## Before you start

1. Publish the assistant (dashboard or `POST /v1/assistants/{id}/publish`).
2. Create a **public** key (`POST /v1/api-keys` with `type: "public"`). List every website origin that may use it in `allowedOrigins` (e.g. `https://www.example.com`), and optionally restrict `allowedAssistantIds`.
3. Never put a private key (`sk_...`) in a page or app. The SDK refuses one.

## Widget: one script tag

```html
<script
  src="https://api.your-domain.com/sdk/widget.js"
  data-public-key="pk_..."
  data-assistant-id="..."
  async
></script>
```

| Attribute | Default | |
|---|---|---|
| `data-public-key`, `data-assistant-id` | required | |
| `data-api-url` | the script's origin | API base URL |
| `data-title` | `Talk to us` | Launcher and panel title |
| `data-position` | `bottom-right` | or `bottom-left` |
| `data-primary-color` | `#4f46e5` | Any CSS colour; text on it is black or white for contrast |
| `data-mode` | `both` | `voice`, `chat` (text only), or `both` (voice with a "Type instead" fallback) |
| `data-language` | assistant's | Language override, e.g. `bn` |
| `data-variables` | | JSON object for the assistant's `{{variables}}` |

The widget has a floating button, a panel with a live transcript, mute and end buttons, and a text box. It renders in a shadow root, so page CSS does not affect it. Keyboard and screen readers: real buttons, `aria-expanded` / `aria-pressed`, live regions for transcript, status and errors, Escape closes, and focus returns to the launcher. On phones (under 480 px) the panel becomes a bottom sheet with 44 px touch targets. If the microphone is blocked, the error says how to fix it and "Type instead" starts a text chat with the same assistant.

Control it from the page: `window.OctoVoice.widgets[0].open()`, `.close()`, `.client` (a `VoiceClient`), or `window.OctoVoice.mount({ ...options })`.

## SDK

```ts
import { VoiceClient } from '@octo/web'; // or https://api.your-domain.com/sdk/octo-web.js

const client = new VoiceClient({ publicKey: 'pk_...', apiUrl: 'https://api.your-domain.com' });

client.on('message', (m) => {
  if (m.type === 'transcript' && m.final) console.log(m.role, m.text);
});
client.on('error', (e) => showError(e.message)); // e.code: 'mic-permission-denied', 'origin-not-allowed', ...

await client.start('assistant-id', { variables: { name: 'Ada' } }); // must run in a click handler
client.setMuted(true);
client.send('I would like to book Tuesday'); // typed message, answered like speech
client.say('One moment please');             // the assistant says this
await client.stop();
```

**`start(assistantId | { call }, { variables?, overrides?, version?, mode? })`**

- `mode: 'voice'` (default) uses the microphone and speaker. `mode: 'chat'` is text only and never asks for the microphone.
- With a public key, `overrides` may only set `firstMessage`, `firstMessageMode`, `language`, `endpointing`, `interruption`, `idle` and `voice.voiceId`.
- **Inline assistants or other overrides:** create the call on your server with a private key (`POST /v1/calls`, with `origin` set to your site), send `{ id, connectToken, wsUrl }` to the page, then call `client.start({ call })`.
- `start` resolves when the call is live and rejects with an `OctoVoiceError`.

**Events**

| Event | Payload |
|---|---|
| `call-start` | `{ id, mode }` |
| `call-end` | `{ reason, error? }`. `reason` is the server's end reason (`assistant-ended`, `silence-timeout`, `customer-hung-up`, ...), `client-ended`, or `error`. Also fires after a failed `start` |
| `speech-start`, `speech-end` | `{ role: 'user' \| 'assistant' }`. User speech comes from the server's voice detection, assistant speech from local playback |
| `message` | `transcript` (`role`, `text`, `final`, `interrupted?`), `interrupted` (`heardText`), `tool-call` (`name`, `args`), `transfer` (`destination`) |
| `volume-level` | `(level 0..1, 'user' \| 'assistant')`, about 20 times a second |
| `error` | `OctoVoiceError` with `code`, `message`, `details` |
| `status` | `idle`, `connecting`, `active`, `reconnecting`, `ended` |

**Error codes:** `mic-permission-denied`, `mic-not-found`, `mic-in-use`, `mic-unsupported` (including non-https pages), `invalid-key`, `origin-not-allowed`, `assistant-not-allowed`, `override-not-allowed`, `rate-limited`, `concurrency-limit`, `server-busy`, `call-expired`, `invalid-request`, `network`, `connection-lost`, `not-active`, `server-error`.

**Reconnect.** If the connection drops (Wi-Fi to mobile data, a short outage), the status goes to `reconnecting` and the SDK resumes the same call with backoff, for as long as the server keeps it (`VOICE_RESUME_GRACE_MS`, 15 s by default). A connection that goes silent for 10 s is treated as dropped. Agent audio produced during the gap is not replayed; transcript events are.

**Audio.** The microphone is requested with echo cancellation, noise suppression and auto gain, so speakerphone use works. Capture is resampled to 16 kHz in an AudioWorklet; playback is gapless 24 kHz. The worklet loads from a `blob:` URL: pages with a Content-Security-Policy need `worker-src blob:` (or `script-src blob:` where `worker-src` is not set) and `connect-src` for the API's `https:` and `wss:` URLs.

## Mobile apps

See [examples/react-native](../../examples/react-native/README.md): the widget in a WebView, with microphone permissions set up for iOS and Android.

## Build and test

```bash
npm run sdk:build   # dist/octo-web.js (ESM) and dist/widget.js (IIFE), served by the API at /sdk/*
npx vitest run packages/sdk   # unit tests (fake socket and audio)
npm run test:e2e    # Playwright: widget and SDK in Chromium against the API with fake providers
```
