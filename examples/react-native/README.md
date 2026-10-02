# React Native example (Expo + WebView)

A minimal app that hosts the Voice of Octo widget in a WebView. You get the browser's echo cancellation and noise suppression, and the same SDK as the website, with no native audio code.

## Setup

1. In `App.tsx`, set `API_URL`, `PUBLIC_KEY`, `ASSISTANT_ID` and `BASE_URL`.
2. Add `BASE_URL`'s origin (e.g. `https://app.your-domain.com`) to the public key's `allowedOrigins`. The page runs under that origin, and it must be `https` for the microphone to work.
3. Install and run on a device:

```bash
cd examples/react-native
npm install
npx expo run:ios      # or: npx expo run:android
```

Use a development build (`expo run:*`), not Expo Go: the microphone permission strings in `app.json` must be compiled into the app.

## How it works

- **iOS:** `NSMicrophoneUsageDescription` in `app.json`. `mediaCapturePermissionGrantType="grant"` stops the WebView from asking a second time after the app permission.
- **Android:** `RECORD_AUDIO` and `MODIFY_AUDIO_SETTINGS` in `app.json`. The app requests `RECORD_AUDIO` at start; the WebView then grants the page's microphone request.
- The page posts call status and errors to the app (`window.ReactNativeWebView.postMessage`), shown above the WebView.
- If the microphone is refused, the widget offers "Type instead" (text chat).

## Status

Not run on a device or simulator in this repository: there is no mobile toolchain in CI. The page inside the WebView is the same widget the Playwright tests cover. Versions in `package.json` are Expo SDK 54's bundled ones (React Native 0.81.5, react-native-webview 13.15.0).
