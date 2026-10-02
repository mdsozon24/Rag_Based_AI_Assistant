import { useState, type FormEvent } from 'react';
import { useVoiceCall } from './useVoiceCall.ts';

const config = {
  publicKey: import.meta.env.VITE_OCTO_PUBLIC_KEY ?? 'pk_your_public_key',
  apiUrl: import.meta.env.VITE_OCTO_API_URL ?? 'https://api.your-domain.com',
  assistantId: import.meta.env.VITE_OCTO_ASSISTANT_ID ?? 'your_assistant_id',
};

export function App() {
  const call = useVoiceCall(config);
  const [draft, setDraft] = useState('');
  const live = call.status === 'active' || call.status === 'reconnecting';

  function submit(event: FormEvent) {
    event.preventDefault();
    if (!draft.trim()) return;
    call.send(draft);
    setDraft('');
  }

  return (
    <main style={{ fontFamily: 'system-ui, sans-serif', maxWidth: 560, margin: '48px auto', padding: '0 16px' }}>
      <h1>Voice agent (React)</h1>
      <p role="status" aria-live="polite">
        Status: {call.status}
        {call.assistantSpeaking ? ' · agent speaking' : ''}
      </p>
      {call.error && <p role="alert" style={{ color: '#b91c1c' }}>{call.error.message}</p>}

      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
        {!live ? (
          <>
            <button type="button" onClick={() => call.start('voice')} disabled={call.status === 'connecting'}>
              Start voice call
            </button>
            <button type="button" onClick={() => call.start('chat')} disabled={call.status === 'connecting'}>
              Chat instead
            </button>
          </>
        ) : (
          <>
            <button type="button" aria-pressed={call.muted} onClick={() => call.setMuted(!call.muted)}>
              {call.muted ? 'Unmute' : 'Mute'}
            </button>
            <button type="button" onClick={() => call.stop()}>
              End call
            </button>
          </>
        )}
      </div>
      <div aria-hidden="true" style={{ height: 6, background: '#e5e7eb', marginTop: 12, borderRadius: 3 }}>
        <div style={{ height: '100%', width: `${Math.round(call.volume * 100)}%`, background: '#4f46e5', borderRadius: 3 }} />
      </div>

      <div role="log" aria-live="polite" style={{ border: '1px solid #ddd', borderRadius: 8, padding: 12, marginTop: 16, minHeight: 160 }}>
        {call.lines.map((line) => (
          <p key={line.id} style={{ opacity: line.final ? 1 : 0.6 }}>
            <strong>{line.role === 'user' ? 'You' : 'Agent'}:</strong> {line.text}
          </p>
        ))}
      </div>

      {live && (
        <form onSubmit={submit} style={{ display: 'flex', gap: 8, marginTop: 12 }}>
          <label htmlFor="message" style={{ position: 'absolute', left: -9999 }}>
            Message
          </label>
          <input id="message" value={draft} onChange={(e) => setDraft(e.target.value)} placeholder="Type a message" style={{ flex: 1 }} />
          <button type="submit">Send</button>
        </form>
      )}
    </main>
  );
}
