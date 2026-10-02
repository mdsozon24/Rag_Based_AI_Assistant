/**
 * Minimal React Native (Expo) voice agent: the Voice of Octo widget inside a WebView.
 *
 * Why a WebView: it gives the app the browser's echo cancellation and noise suppression and the
 * exact same SDK as the website, with no native audio code. The page's origin is BASE_URL, which
 * must be listed in the public key's allowed origins.
 */
import { useEffect, useState } from 'react';
import { Linking, PermissionsAndroid, Platform, SafeAreaView, StatusBar, StyleSheet, Text, View } from 'react-native';
import { WebView, type WebViewMessageEvent } from 'react-native-webview';

const API_URL = 'https://api.your-domain.com';
const PUBLIC_KEY = 'pk_your_public_key';
const ASSISTANT_ID = 'your_assistant_id';
/** The origin the page runs under (https, so the microphone is allowed). Add it to the key's allowed origins. */
const BASE_URL = 'https://app.your-domain.com';

const html = `<!doctype html>
<html><head><meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover"></head>
<body style="margin:0;background:transparent">
<script src="${API_URL}/sdk/widget.js" data-public-key="${PUBLIC_KEY}" data-assistant-id="${ASSISTANT_ID}"
  data-title="Voice assistant" data-mode="both"></script>
<script>
  // Open the panel at once and tell the app about the call
  function wire() {
    var widget = window.OctoVoice && window.OctoVoice.widgets[0];
    if (!widget) return setTimeout(wire, 50);
    widget.open();
    var post = function (msg) { window.ReactNativeWebView.postMessage(JSON.stringify(msg)); };
    widget.client.on('status', function (status) { post({ type: 'status', status: status }); });
    widget.client.on('error', function (error) { post({ type: 'error', code: error.code, message: error.message }); });
  }
  wire();
</script>
</body></html>`;

async function askForMicrophone(): Promise<boolean> {
  if (Platform.OS !== 'android') return true; // iOS asks on first use (NSMicrophoneUsageDescription)
  const result = await PermissionsAndroid.request(PermissionsAndroid.PERMISSIONS.RECORD_AUDIO, {
    title: 'Microphone',
    message: 'The voice assistant needs the microphone to hear you.',
    buttonPositive: 'Allow',
  });
  return result === PermissionsAndroid.RESULTS.GRANTED;
}

export default function App() {
  const [micAllowed, setMicAllowed] = useState<boolean | null>(null);
  const [status, setStatus] = useState('idle');

  useEffect(() => {
    void askForMicrophone().then(setMicAllowed);
  }, []);

  function onMessage(event: WebViewMessageEvent) {
    const message = JSON.parse(event.nativeEvent.data) as { type: string; status?: string; message?: string };
    if (message.type === 'status' && message.status) setStatus(message.status);
    if (message.type === 'error' && message.message) setStatus(`error: ${message.message}`);
  }

  return (
    <SafeAreaView style={styles.screen}>
      <StatusBar barStyle="dark-content" />
      <View style={styles.header}>
        <Text style={styles.title} accessibilityRole="header">
          Voice of Octo
        </Text>
        <Text accessibilityLiveRegion="polite">Call: {status}</Text>
        {micAllowed === false && (
          <Text style={styles.warning} onPress={() => Linking.openSettings()} accessibilityRole="link">
            Microphone access is off. Tap to open settings, or type instead.
          </Text>
        )}
      </View>
      <WebView
        style={styles.web}
        originWhitelist={['https://*']}
        source={{ html, baseUrl: BASE_URL }}
        onMessage={onMessage}
        javaScriptEnabled
        // Microphone and audio in the page
        mediaCapturePermissionGrantType="grant"
        allowsInlineMediaPlayback
        mediaPlaybackRequiresUserAction={false}
      />
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: '#f9fafb' },
  header: { padding: 16, gap: 4 },
  title: { fontSize: 20, fontWeight: '600' },
  warning: { color: '#b91c1c', textDecorationLine: 'underline' },
  web: { flex: 1, backgroundColor: 'transparent' },
});
