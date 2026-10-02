/**
 * React hook around VoiceClient: call status, transcript, mute, volume, and errors as state.
 * One client per hook instance; the call is stopped when the component unmounts.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { VoiceClient, type CallMode, type CallStatus, type OctoVoiceError, type StartOptions } from '@octo/web';

export interface TranscriptLine {
  id: number;
  role: 'user' | 'assistant';
  text: string;
  final: boolean;
}

export function useVoiceCall(config: { publicKey: string; apiUrl: string; assistantId: string }) {
  const clientRef = useRef<VoiceClient | null>(null);
  const [status, setStatus] = useState<CallStatus>('idle');
  const [lines, setLines] = useState<TranscriptLine[]>([]);
  const [error, setError] = useState<OctoVoiceError | null>(null);
  const [muted, setMutedState] = useState(false);
  const [volume, setVolume] = useState(0);
  const [assistantSpeaking, setAssistantSpeaking] = useState(false);

  useEffect(() => {
    const client = new VoiceClient({ publicKey: config.publicKey, apiUrl: config.apiUrl });
    clientRef.current = client;
    let nextId = 0;
    const offs = [
      client.on('status', setStatus),
      client.on('error', setError),
      client.on('volume-level', (level, source) => source === 'user' && setVolume(level)),
      client.on('speech-start', ({ role }) => role === 'assistant' && setAssistantSpeaking(true)),
      client.on('speech-end', ({ role }) => role === 'assistant' && setAssistantSpeaking(false)),
      client.on('call-end', () => {
        setMutedState(false);
        setVolume(0);
      }),
      client.on('message', (message) => {
        if (message.type !== 'transcript') return;
        setLines((current) => {
          // Replace this role's partial line; assistant partials arrive sentence by sentence
          let last = -1;
          for (let i = current.length - 1; i >= 0 && last === -1; i--) if (current[i].role === message.role && !current[i].final) last = i;
          if (last === -1) return [...current, { id: nextId++, role: message.role, text: message.text, final: message.final }];
          const previous = current[last];
          const text = message.final || message.role === 'user' ? message.text : `${previous.text} ${message.text}`;
          return current.map((line, i) => (i === last ? { ...line, text, final: message.final } : line));
        });
      }),
    ];
    return () => {
      offs.forEach((off) => off());
      void client.stop();
      clientRef.current = null;
    };
  }, [config.publicKey, config.apiUrl]);

  const start = useCallback(
    async (mode: CallMode = 'voice', options: Omit<StartOptions, 'mode'> = {}) => {
      setError(null);
      setLines([]);
      await clientRef.current?.start(config.assistantId, { ...options, mode }).catch(() => {});
    },
    [config.assistantId]
  );
  const stop = useCallback(() => clientRef.current?.stop(), []);
  const send = useCallback((text: string) => clientRef.current?.send(text), []);
  const setMuted = useCallback((value: boolean) => {
    clientRef.current?.setMuted(value);
    setMutedState(value);
  }, []);

  return { status, lines, error, muted, volume, assistantSpeaking, start, stop, send, setMuted };
}
