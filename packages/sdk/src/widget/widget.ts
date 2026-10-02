/**
 * The embeddable voice widget: a floating button that opens a panel with a live transcript, mute
 * and end buttons, and a text box. Voice is the default; "Type instead" (or a blocked microphone)
 * falls back to a text chat with the same assistant.
 *
 * Rendered in an open shadow root, so the host page's CSS cannot break it and it cannot break the
 * page. Accessible: real buttons, aria-expanded/pressed, a polite live region for the transcript and
 * status, an assertive alert for errors, Escape to close, focus moved in and back out.
 */
import { VoiceClient } from '../client.ts';
import type { OctoVoiceError } from '../errors.ts';
import type { CallMode, Message, Role, VoiceClientOptions } from '../types.ts';
import { WIDGET_CSS } from './styles.ts';

export interface WidgetLabels {
  launcher: string;
  start: string;
  connecting: string;
  listening: string;
  speaking: string;
  reconnecting: string;
  ended: string;
  mute: string;
  unmute: string;
  end: string;
  close: string;
  typeInstead: string;
  placeholder: string;
  send: string;
  empty: string;
  you: string;
  assistant: string;
}

export const DEFAULT_LABELS: WidgetLabels = {
  launcher: 'Talk to us',
  start: 'Start voice call',
  connecting: 'Connecting…',
  listening: 'Listening',
  speaking: 'Speaking',
  reconnecting: 'Reconnecting…',
  ended: 'Call ended',
  mute: 'Mute',
  unmute: 'Unmute',
  end: 'End call',
  close: 'Close',
  typeInstead: 'Type instead',
  placeholder: 'Type a message',
  send: 'Send',
  empty: 'Press “Start voice call” and speak, or type a message.',
  you: 'You',
  assistant: 'Assistant',
};

export interface WidgetOptions {
  publicKey: string;
  assistantId: string;
  apiUrl: string;
  /** Panel title (default: labels.launcher). */
  title?: string;
  position?: 'bottom-right' | 'bottom-left';
  /** Any CSS colour; text on it is black or white, whichever reads better. */
  primaryColor?: string;
  /** voice: voice only. chat: text only. both (default): voice, with a typed fallback. */
  mode?: 'voice' | 'chat' | 'both';
  variables?: Record<string, string>;
  /** Assistant language override (e.g. "bn"); allowed for public keys. */
  language?: string;
  labels?: Partial<WidgetLabels>;
  /** Element the widget host is appended to (default document.body). */
  container?: HTMLElement;
  /** Advanced: client options (tests inject audio and sockets). */
  client?: Partial<VoiceClientOptions>;
}

export interface VoiceWidget {
  readonly client: VoiceClient;
  readonly element: HTMLElement;
  open(): void;
  close(): void;
  destroy(): Promise<void>;
}

const ICONS = {
  mic: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><rect x="9" y="3" width="6" height="12" rx="3"/><path d="M5 11a7 7 0 0 0 14 0M12 18v3"/></svg>',
  close: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18"/></svg>',
};

/** Black or white text, whichever contrasts more with `color` (any CSS colour the browser parses). */
function textColorFor(color: string, probe: HTMLElement): string {
  probe.style.color = color;
  const match = /rgba?\((\d+),\s*(\d+),\s*(\d+)/.exec(getComputedStyle(probe).color);
  probe.style.color = '';
  if (!match) return '#ffffff';
  const [r, g, b] = match.slice(1, 4).map((v) => {
    const c = Number(v) / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  const luminance = 0.2126 * r + 0.7152 * g + 0.0722 * b;
  return (luminance + 0.05) / 0.05 > 1.05 / (luminance + 0.05) ? '#111111' : '#ffffff';
}

let instanceCount = 0;

export function mountVoiceWidget(options: WidgetOptions): VoiceWidget {
  const labels = { ...DEFAULT_LABELS, ...options.labels };
  const title = options.title ?? labels.launcher;
  const mode = options.mode ?? 'both';
  const id = `octo-voice-${++instanceCount}`;
  const client = new VoiceClient({ publicKey: options.publicKey, apiUrl: options.apiUrl, ...options.client });

  const host = document.createElement('div');
  host.className = 'octo-voice-widget';
  host.dataset.position = options.position === 'bottom-left' ? 'bottom-left' : 'bottom-right';
  const root = host.attachShadow({ mode: 'open' });
  root.innerHTML = `
    <style>${WIDGET_CSS}</style>
    <button type="button" class="launcher" aria-expanded="false" aria-controls="${id}-panel">${ICONS.mic}<span></span></button>
    <section class="panel" id="${id}-panel" role="dialog" aria-modal="false" aria-labelledby="${id}-title" hidden>
      <header>
        <div class="titles">
          <h2 id="${id}-title"></h2>
          <p class="status" role="status" aria-live="polite"></p>
        </div>
        <button type="button" class="icon-button close">${ICONS.close}</button>
      </header>
      <div class="log" role="log" aria-live="polite" aria-relevant="additions text" tabindex="0" aria-labelledby="${id}-title">
        <p class="empty"></p>
      </div>
      <p class="error" role="alert"></p>
      <div class="controls">
        <button type="button" class="primary start"></button>
        <button type="button" class="link type-instead"></button>
        <div class="meter" aria-hidden="true" hidden><span></span></div>
        <button type="button" class="secondary mute" aria-pressed="false" hidden></button>
        <button type="button" class="danger end" hidden></button>
      </div>
      <form class="composer" hidden>
        <label class="sr-only" for="${id}-input"></label>
        <input id="${id}-input" type="text" autocomplete="off" maxlength="2000" enterkeyhint="send" />
        <button type="submit" class="primary send"></button>
      </form>
    </section>`;

  const $ = <T extends Element>(selector: string) => root.querySelector(selector) as T;
  const launcher = $<HTMLButtonElement>('.launcher');
  const panel = $<HTMLElement>('.panel');
  const status = $<HTMLElement>('.status');
  const log = $<HTMLElement>('.log');
  const empty = $<HTMLElement>('.empty');
  const errorBox = $<HTMLElement>('.error');
  const startButton = $<HTMLButtonElement>('.start');
  const typeInstead = $<HTMLButtonElement>('.type-instead');
  const meter = $<HTMLElement>('.meter');
  const meterBar = $<HTMLElement>('.meter span');
  const muteButton = $<HTMLButtonElement>('.mute');
  const endButton = $<HTMLButtonElement>('.end');
  const closeButton = $<HTMLButtonElement>('.close');
  const composer = $<HTMLFormElement>('.composer');
  const input = $<HTMLInputElement>('.composer input');

  launcher.querySelector('span')!.textContent = title;
  launcher.setAttribute('aria-label', title);
  $<HTMLElement>('h2').textContent = title;
  closeButton.setAttribute('aria-label', labels.close);
  empty.textContent = mode === 'chat' ? labels.placeholder : labels.empty;
  startButton.textContent = mode === 'chat' ? labels.send : labels.start;
  typeInstead.textContent = labels.typeInstead;
  typeInstead.hidden = mode !== 'both';
  muteButton.textContent = labels.mute;
  endButton.textContent = labels.end;
  $<HTMLLabelElement>('label').textContent = labels.placeholder;
  input.placeholder = labels.placeholder;
  $<HTMLButtonElement>('.send').textContent = labels.send;

  (options.container ?? document.body).appendChild(host);
  if (options.primaryColor) {
    host.style.setProperty('--octo-primary', options.primaryColor);
    host.style.setProperty('--octo-on-primary', textColorFor(options.primaryColor, launcher));
  }

  // ---------------------------------------------------------------- transcript

  const partial: Partial<Record<Role, HTMLElement>> = {};
  function addBubble(role: Role | 'note', text: string, isPartial = false): HTMLElement {
    empty.remove();
    const bubble = document.createElement('div');
    bubble.className = `bubble ${role}${isPartial ? ' partial' : ''}`;
    if (role !== 'note') {
      const who = document.createElement('span');
      who.className = 'sr-only';
      who.textContent = `${role === 'user' ? labels.you : labels.assistant}: `;
      bubble.append(who);
    }
    bubble.append(document.createTextNode(text));
    log.append(bubble);
    log.scrollTop = log.scrollHeight;
    return bubble;
  }
  function setBubbleText(bubble: HTMLElement, text: string): void {
    bubble.lastChild!.textContent = text;
    log.scrollTop = log.scrollHeight;
  }
  function onTranscript(message: Extract<Message, { type: 'transcript' }>): void {
    const current = partial[message.role];
    if (message.final) {
      if (current) {
        setBubbleText(current, message.text);
        current.classList.remove('partial');
        delete partial[message.role];
      } else {
        addBubble(message.role, message.text);
      }
      return;
    }
    if (!current) {
      partial[message.role] = addBubble(message.role, message.text, true);
      return;
    }
    // User partials are the whole utterance so far; assistant partials arrive sentence by sentence
    const text = message.role === 'user' ? message.text : `${current.lastChild!.textContent ?? ''} ${message.text}`.trim();
    setBubbleText(current, text);
  }

  // ---------------------------------------------------------------- state → UI

  let callMode: CallMode | null = null;
  function render(): void {
    const s = client.status;
    const live = s === 'connecting' || s === 'active' || s === 'reconnecting';
    startButton.hidden = live || mode === 'chat';
    typeInstead.hidden = live || mode !== 'both';
    muteButton.hidden = !live || callMode !== 'voice';
    meter.hidden = !live || callMode !== 'voice';
    endButton.hidden = !live;
    composer.hidden = !(s === 'active' || s === 'reconnecting') && mode !== 'chat';
    input.disabled = s === 'connecting' || s === 'reconnecting';
    status.textContent = s === 'connecting' ? labels.connecting : s === 'reconnecting' ? labels.reconnecting : s === 'active' ? (callMode === 'chat' ? '' : labels.listening) : s === 'ended' ? labels.ended : '';
    host.toggleAttribute('data-live', live);
  }

  function showError(error: OctoVoiceError | null): void {
    errorBox.textContent = error ? error.message : '';
    // A blocked or missing microphone: offer the typed chat right away
    if (error && mode === 'both' && error.code.startsWith('mic-')) typeInstead.hidden = false;
  }

  client.on('status', render);
  client.on('message', (message) => {
    if (message.type === 'transcript') onTranscript(message);
    else if (message.type === 'transfer') addBubble('note', `${message.destination.name}`);
  });
  client.on('speech-start', ({ role }) => {
    if (role === 'assistant' && client.status === 'active') status.textContent = labels.speaking;
  });
  client.on('speech-end', ({ role }) => {
    if (role === 'assistant' && client.status === 'active') status.textContent = labels.listening;
  });
  client.on('volume-level', (level, source) => {
    if (source === 'user') meterBar.style.width = `${Math.round(level * 100)}%`;
  });
  client.on('error', (error) => showError(error));
  client.on('call-end', ({ error }) => {
    for (const role of ['user', 'assistant'] as Role[]) {
      partial[role]?.classList.remove('partial');
      delete partial[role];
    }
    muteButton.setAttribute('aria-pressed', 'false');
    muteButton.textContent = labels.mute;
    meterBar.style.width = '0';
    if (!error) addBubble('note', labels.ended);
    render();
    if (panel.contains(root.activeElement) || root.activeElement === null) (mode === 'chat' ? input : startButton).focus();
  });

  async function startCall(requested: CallMode, firstMessage?: string): Promise<void> {
    showError(null);
    callMode = requested;
    render();
    try {
      await client.start(options.assistantId, {
        mode: requested,
        variables: options.variables,
        ...(options.language ? { overrides: { language: options.language } } : {}),
      });
      if (firstMessage) client.send(firstMessage);
      (requested === 'chat' ? input : endButton).focus();
    } catch {
      // Already shown through the error event
    }
  }

  // ---------------------------------------------------------------- interactions

  function open(): void {
    panel.hidden = false;
    launcher.setAttribute('aria-expanded', 'true');
    host.setAttribute('data-open', '');
    render();
    const live = client.status === 'active' || client.status === 'reconnecting';
    (mode === 'chat' || (live && callMode === 'chat') ? input : live ? endButton : startButton).focus();
  }
  function close(): void {
    panel.hidden = true;
    launcher.setAttribute('aria-expanded', 'false');
    host.removeAttribute('data-open');
    launcher.focus();
  }

  launcher.addEventListener('click', open);
  closeButton.addEventListener('click', close);
  panel.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') {
      event.stopPropagation();
      close();
    }
  });
  startButton.addEventListener('click', () => void startCall(mode === 'chat' ? 'chat' : 'voice'));
  typeInstead.addEventListener('click', () => {
    if (client.status !== 'active') void startCall('chat');
  });
  muteButton.addEventListener('click', () => {
    const muted = !client.isMuted;
    client.setMuted(muted);
    muteButton.setAttribute('aria-pressed', String(muted));
    muteButton.textContent = muted ? labels.unmute : labels.mute;
  });
  endButton.addEventListener('click', () => void client.stop());
  composer.addEventListener('submit', (event) => {
    event.preventDefault();
    const text = input.value.trim();
    if (!text) return;
    input.value = '';
    if (client.status === 'active') {
      try {
        client.send(text);
      } catch (error) {
        showError(error as OctoVoiceError);
      }
    } else if (client.status === 'idle' || client.status === 'ended') {
      // Chat mode: the first message starts the conversation
      void startCall('chat', text);
    }
  });

  render();
  return {
    client,
    element: host,
    open,
    close,
    async destroy() {
      await client.stop();
      host.remove();
    },
  };
}
