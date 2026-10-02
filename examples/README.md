# Examples: voice agents on websites and in apps

Each example needs an API base URL, a **public** key whose `allowedOrigins` include the page's origin, and a published assistant id. SDK reference: [packages/sdk](../packages/sdk/README.md).

| Example | What it shows | Run |
|---|---|---|
| [html/index.html](html/index.html) | The widget: one `<script>` tag with data attributes | Replace the three placeholders and serve the file over http(s) |
| [html/custom-button.html](html/custom-button.html) | Your own buttons and transcript with the ES module SDK | Same |
| [react](react) | A `useVoiceCall` hook: status, transcript, mute, volume, typed messages, chat mode | `VITE_OCTO_API_URL=... VITE_OCTO_PUBLIC_KEY=... VITE_OCTO_ASSISTANT_ID=... npx vite --config examples/react/vite.config.ts`, then open http://localhost:5174 (add that origin to the key) |
| [react-native](react-native) | Expo app with the widget in a WebView, microphone permissions for iOS and Android | See its README |

To try the HTML pages without real providers, `npm run sdk:build && npx tsx packages/sdk/e2e/server.ts` starts the API with fake providers and serves both pages, already filled in, at http://127.0.0.1:4310/widget and /custom.
