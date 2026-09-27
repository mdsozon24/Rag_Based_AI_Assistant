<div align="center">
<img width="1200" height="475" alt="GHBanner" src="https://ai.google.dev/static/site-assets/images/share-ais-513315318.png" />
</div>

# BN AI Assistant

This contains everything you need to run your app locally.

## Run Locally

**Prerequisites:**  Node.js


1. Install dependencies:
   `npm install`
2. Set the `GEMINI_API_KEY` in [.env.local](.env.local) to your Gemini API key
3. Set `ADMIN_EMAILS` to a comma-separated list of administrator email addresses:

```text
ADMIN_EMAILS=admin@example.com
```

Administrator uploads and important voice statements are stored as shared knowledge in `data/custom_documents.json` and are available to every signed-in user. Regular user uploads and personal voice memories remain private.
4. Run the app:
   `npm run dev`

The development server runs at `http://localhost:3100` by default. Set `PORT` in `.env` to use another port.

## ElevenLabs voice (optional)

Set `ELEVENLABS_API_KEY` to speak every answer with ElevenLabs instead of Gemini's built-in voice. In live voice sessions, Gemini still understands and answers the user, and its reply text is streamed to ElevenLabs sentence by sentence.

```text
ELEVENLABS_API_KEY=your-elevenlabs-key
ELEVENLABS_VOICE_ID=voice-id-from-the-elevenlabs-voice-library
ELEVENLABS_MODEL_ID=eleven_v3_conversational
```

`eleven_v3_conversational` (the default) and `eleven_v3` are the ElevenLabs models that support Bengali. The conversational model starts speaking about three times sooner and generates audio about four times faster than real time, at half the cost. `eleven_v3` is barely faster than real time, which leaves audible gaps between words in live sessions. While one passage plays, the next one is already being synthesized, so there is no pause between sentences. If ElevenLabs fails, the fallback voice path uses Gemini TTS. `/api/health` reports the active `ttsProvider`.

### Choosing the voice

Administrators (`ADMIN_EMAILS`) see a **Voice** button next to their email. It lists every voice in the ElevenLabs account, with Bangla and Bengali-accented voices first. Admins can play a Bangla sample of a voice and save it as the voice for all users. The change applies to the next answer, including in live sessions that are already running.

Below that, the **ElevenLabs Voice Library** section searches the public library. By default it shows Bangla voices, both Bengali-language and Bengali-accented. Admins can search, filter by gender, or turn off "শুধু বাংলা" to browse every language. The play button speaks a Bangla sample in that voice. **যুক্ত করুন** adds the voice to the ElevenLabs account and selects it; click **সংরক্ষণ করুন** to use it. Each added voice uses one voice slot on the ElevenLabs plan, and the panel shows how many slots are used.

The selection is stored in `data/voice_settings.json`. Without it, `ELEVENLABS_VOICE_ID` is used, and without that, a premade English voice that speaks Bangla with a foreign accent. On hosts with an ephemeral filesystem (such as Render's free plan), the selection is lost on redeploy. Set `ELEVENLABS_VOICE_ID` to keep a voice permanently.

Tune how human the voice sounds with `ELEVENLABS_STABILITY` (0 = most expressive, 0.5 = natural, 1 = flattest; v3 models accept only these three values) and `ELEVENLABS_SPEED` (0.7–1.2).

## Authentication and password reset

Every chat and uploaded document requires an account with a unique email address. Passwords are stored as scrypt hashes, sessions use an HttpOnly cookie, and uploaded documents are filtered by the signed-in account on the server.

To enable automatic password-reset email, configure these environment variables:

```text
SMTP_HOST=smtp.example.com
SMTP_PORT=587
SMTP_USER=your-mailbox@example.com
SMTP_PASS=your-mailbox-password
SMTP_FROM=your-mailbox@example.com
APP_URL=https://your-domain.example
```

Without SMTP configuration, password reset requests cannot send email. The server stores accounts in `data/users.json`; keep that file private and back it up securely.

## Deploy to Render

This project is deployed as one Render Web Service. The Express server serves the built Vite frontend and the `/api/*` endpoints, while the same process handles the `/ws/live` WebSocket connection.

1. Push this repository to GitHub. Do not commit `.env`, API keys, or private files from `data/`.
2. In Render, choose **New > Blueprint** and select the repository. Render will read `render.yaml`.
3. Enter the secret value for `GEMINI_API_KEY` and deploy.
4. Set `APP_URL` to the generated Render URL, for example `https://bn-ai-assistant.onrender.com`.
5. If password reset is required, enter the `SMTP_*` values in the Render Environment settings.
6. Verify `https://your-app.onrender.com/api/health` returns `{ "status": "ok" }`.

The production commands are:

```text
Build: npm install && npm run build
Start: npm start
Health check: /api/health
```

The free Render filesystem is ephemeral. Accounts, uploaded documents, and voice memories stored under `data/` can be lost after a restart or redeploy. For persistent data, migrate these files to a database and object storage before using the app in production.
