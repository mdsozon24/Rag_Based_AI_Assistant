/**
 * <script> embed: bundled as dist/widget.js (served at {API}/sdk/widget.js).
 *
 *   <script src="https://api.example.com/sdk/widget.js"
 *     data-public-key="pk_..." data-assistant-id="..." async></script>
 *
 * Optional: data-api-url (default: the script's origin), data-title, data-position
 * (bottom-right | bottom-left), data-primary-color, data-mode (voice | chat | both),
 * data-language, data-variables (JSON object of strings).
 * Programmatic access: window.OctoVoice.widgets[0].open(), window.OctoVoice.mount({...}).
 */
import { VoiceClient } from '../client.ts';
import { mountVoiceWidget, type VoiceWidget, type WidgetOptions } from './widget.ts';

interface OctoVoiceGlobal {
  mount(options: WidgetOptions): VoiceWidget;
  widgets: VoiceWidget[];
  VoiceClient: typeof VoiceClient;
}

declare global {
  interface Window {
    OctoVoice?: OctoVoiceGlobal;
  }
}

function parseVariables(raw: string | undefined): Record<string, string> | undefined {
  if (!raw) return undefined;
  try {
    const value = JSON.parse(raw);
    if (value && typeof value === 'object' && !Array.isArray(value)) return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, String(v)]));
  } catch {
    // reported below
  }
  console.error('[octo-voice] data-variables must be a JSON object, e.g. {"name":"Ada"}');
  return undefined;
}

function fromScript(script: HTMLScriptElement): WidgetOptions | null {
  const data = script.dataset;
  if (!data.publicKey || !data.assistantId) {
    console.error('[octo-voice] The widget script needs data-public-key and data-assistant-id.');
    return null;
  }
  const mode = data.mode === 'voice' || data.mode === 'chat' ? data.mode : 'both';
  return {
    publicKey: data.publicKey,
    assistantId: data.assistantId,
    apiUrl: data.apiUrl || new URL(script.src, location.href).origin,
    title: data.title,
    position: data.position === 'bottom-left' ? 'bottom-left' : 'bottom-right',
    primaryColor: data.primaryColor,
    mode,
    language: data.language,
    variables: parseVariables(data.variables),
  };
}

const global: OctoVoiceGlobal = window.OctoVoice ?? { widgets: [], mount: (options) => mountVoiceWidget(options), VoiceClient };
global.mount = (options) => {
  const widget = mountVoiceWidget(options);
  global.widgets.push(widget);
  return widget;
};
window.OctoVoice = global;

const script = document.currentScript as HTMLScriptElement | null;
const options = script ? fromScript(script) : null;
if (options) {
  const mount = () => global.mount(options);
  if (document.body) mount();
  else document.addEventListener('DOMContentLoaded', mount, { once: true });
}
