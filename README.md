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
3. Run the app:
   `npm run dev`

The development server runs at `http://localhost:3100` by default. Set `PORT` in `.env` to use another port.

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
