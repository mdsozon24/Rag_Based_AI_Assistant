# Voice of Octo

A voice AI agent platform: create assistants, connect phone numbers, run browser and phone calls, chat, campaigns, webhooks and call analysis.

| Part | Folder | What it is |
|---|---|---|
| API | [apps/api](apps/api) | Public `/v1` REST + WebSocket API (Fastify, Postgres). Runs the call engine, campaign dialer and workers |
| Dashboard | [apps/dashboard](apps/dashboard) | Customer web app (Next.js). Talks only to the API |
| Engine | [packages/engine](packages/engine) | Real-time STT → LLM → TTS pipeline with provider fallbacks |
| Web SDK | [packages/sdk](packages/sdk) | Browser SDK and embeddable widget (`@octo/web`) |
| Examples | [examples](examples) | HTML, React and React Native integrations |

API reference: [docs/API.md](docs/API.md).

## Run locally

**Prerequisites:** Node.js 20 or newer. Python is not needed.

1. Install dependencies (first time, and after pulling changes):

   ```powershell
   npm install
   npm --prefix apps/dashboard install
   ```

2. Copy [.env.example](.env.example) to `.env` and set at least `GEMINI_API_KEY` (and `ELEVENLABS_API_KEY` for ElevenLabs voices). Every other setting has a working local default.

3. Start the API (terminal 1):

   ```powershell
   npm run api:dev
   ```

   It applies database migrations and serves on http://127.0.0.1:3300. The local database lives in `.data/api-db` (in-process Postgres, one process at a time).

4. Start the dashboard (terminal 2):

   ```powershell
   npm run dashboard:dev
   ```

   Open http://localhost:3000. The dashboard forwards `/v1/*` to the API.

5. Create your first account at http://localhost:3000/signup. Without `SMTP_HOST`, the verification email is printed in the **API terminal**: open the link from there, then sign in.

Use the microphone at `localhost`, not your computer's IP address. Browsers allow the microphone only on `localhost` or HTTPS.

## Other commands

| Command | Does |
|---|---|
| `npm test` | API and engine tests (Vitest) |
| `npm run dashboard:test` | Dashboard component tests |
| `npm run lint` | Strict type check of `apps/` and `packages/` |
| `npm run api:migrate` | Apply pending migrations to `DATABASE_URL` |
| `npm run voice:dev` | Engine-only dev server on port 3200 |
| `npm run sdk:build` | Build the web SDK and widget |
| `npm run test:e2e` | SDK and widget browser tests (Playwright) |

## Troubleshooting

- **`Applied migration ... is missing from the migrations folder`**: the local database was created by a migration that no longer exists. Stop the API, delete `.data/api-db`, and start it again (local data is lost).
- **Dashboard shows a CSS parse error**: stop it, delete `apps/dashboard/.next`, and start it again.

## Production

The API requires `NODE_ENV=production`, a real Postgres `DATABASE_URL`, `SMTP_HOST`, and HTTPS `API_PUBLIC_URL` / `DASHBOARD_URL`. See [apps/api/README.md](apps/api/README.md) for the database setup.
