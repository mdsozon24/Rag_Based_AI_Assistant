<div align="center">
<img width="1200" height="475" alt="GHBanner" src="https://ai.google.dev/static/site-assets/images/share-ais-513315318.png" />
</div>

# Run and deploy your AI Studio app

This contains everything you need to run your app locally.

View your app in AI Studio: https://ai.studio/apps/633cb63f-c0c5-4599-850d-2529d2fb23a2

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
