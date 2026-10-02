'use client';

import { OctoVoiceError, VoiceClient, type CallStatus, type Message } from '@octo/web';
import { AudioLines, Headphones, Keyboard, Mic, MicOff, PhoneOff, Send, X } from 'lucide-react';
import Link from 'next/link';
import { Dialog as RadixDialog } from 'radix-ui';
import { useEffect, useRef, useState, type FormEvent } from 'react';
import { Button } from '@/components/ui/button';
import { Field } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { ApiError, errorMessage } from '@/lib/api/client';
import type { Assistant } from '@/lib/api/types';
import { cn } from '@/lib/cn';
import { humanize } from '@/lib/format';
import { useAssistantMutations } from './api';

interface Line {
  id: number;
  role: 'user' | 'assistant' | 'tool';
  text: string;
  final: boolean;
  interrupted?: boolean;
}

const STATUS_TEXT: Record<CallStatus, string> = {
  idle: 'Not connected',
  connecting: 'Connecting…',
  active: 'Connected',
  reconnecting: 'Connection lost, reconnecting…',
  ended: 'Call ended',
};

let lineId = 1;

/** Apply one SDK message to the transcript: partials are replaced by the next update for the same speaker. */
export function applyMessage(lines: Line[], message: Message): Line[] {
  if (message.type === 'transcript') {
    const last = lines.at(-1);
    if (last && last.role === message.role && !last.final) return [...lines.slice(0, -1), { ...last, text: message.text, final: message.final, interrupted: message.interrupted }];
    return [...lines, { id: lineId++, role: message.role, text: message.text, final: message.final, interrupted: message.interrupted }];
  }
  if (message.type === 'interrupted') {
    const index = lines.findLastIndex((l) => l.role === 'assistant');
    if (index < 0) return lines;
    return lines.map((l, i) => (i === index ? { ...l, text: message.heardText || l.text, interrupted: true, final: true } : l));
  }
  if (message.type === 'tool-call') return [...lines, { id: lineId++, role: 'tool', text: `${message.name}(${JSON.stringify(message.args)})`, final: true }];
  return lines;
}

/**
 * "Talk to assistant": a real browser call to the published version, created with the dashboard
 * session (POST /v1/assistants/{id}/test-call) and run by the web SDK. Voice uses the microphone;
 * text sends typed messages only.
 */
export function TalkPanel({ assistant, open, onOpenChange }: { assistant: Assistant; open: boolean; onOpenChange: (open: boolean) => void }) {
  const { testCall } = useAssistantMutations(assistant.id);
  const [mode, setMode] = useState<'voice' | 'chat'>('voice');
  const [variables, setVariables] = useState<Record<string, string>>({});
  const [extraVariables, setExtraVariables] = useState<string[]>([]);
  const [status, setStatus] = useState<CallStatus>('idle');
  const [lines, setLines] = useState<Line[]>([]);
  const [callId, setCallId] = useState<string | null>(null);
  const [endReason, setEndReason] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [muted, setMuted] = useState(false);
  const [typed, setTyped] = useState('');
  const [speaking, setSpeaking] = useState<'user' | 'assistant' | null>(null);
  const clientRef = useRef<VoiceClient | null>(null);
  const logRef = useRef<HTMLDivElement>(null);

  const variableNames = [...new Set([...assistant.requiredVariables, ...extraVariables])];
  const live = status === 'connecting' || status === 'active' || status === 'reconnecting';

  // Hang up when the panel closes or the page goes away
  useEffect(() => () => void clientRef.current?.stop(), []);
  useEffect(() => {
    logRef.current?.scrollTo({ top: logRef.current.scrollHeight });
  }, [lines]);

  async function start() {
    setError(null);
    setLines([]);
    setEndReason(null);
    setCallId(null);
    setMuted(false);
    try {
      if (mode === 'voice') {
        // Ask for the microphone before a call is created, so a refusal costs nothing
        const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
        stream.getTracks().forEach((track) => track.stop());
      }
    } catch (e) {
      setError(new OctoVoiceError('mic-permission-denied', 'Microphone access is blocked. Allow it for this site, or switch to text.').message + (e instanceof Error && e.name === 'NotFoundError' ? ' No microphone was found.' : ''));
      return;
    }
    let call;
    try {
      setStatus('connecting');
      call = await testCall.mutateAsync({ variables });
    } catch (e) {
      setStatus('idle');
      const missing = e instanceof ApiError ? e.issues.filter((i) => i.path.startsWith('variables.')).map((i) => i.path.slice('variables.'.length)) : [];
      if (missing.length) {
        setExtraVariables((names) => [...new Set([...names, ...missing])]);
        setError('This assistant needs values for its variables. Fill them in and start again.');
      } else {
        setError(e instanceof ApiError && e.status === 409 ? 'Publish the assistant first: test calls use the published version.' : errorMessage(e));
      }
      return;
    }
    setCallId(call.id);
    const client = new VoiceClient({ apiUrl: window.location.origin });
    clientRef.current = client;
    client.on('status', setStatus);
    client.on('message', (message) => setLines((current) => applyMessage(current, message)));
    client.on('speech-start', ({ role }) => setSpeaking(role));
    client.on('speech-end', () => setSpeaking(null));
    client.on('call-end', ({ reason, error: failure }) => {
      setEndReason(reason);
      setSpeaking(null);
      if (failure) setError(failure.message);
    });
    try {
      await client.start({ call: { id: call.id, connectToken: call.connectToken, wsUrl: call.wsUrl } }, { mode });
    } catch (e) {
      setError(errorMessage(e));
    }
  }

  async function stop() {
    await clientRef.current?.stop();
  }

  function sendTyped(event: FormEvent) {
    event.preventDefault();
    const text = typed.trim();
    if (!text || status !== 'active') return;
    // The server answers with the message as a final transcript line, like speech
    clientRef.current?.send(text);
    setTyped('');
  }

  return (
    <RadixDialog.Root
      open={open}
      onOpenChange={(next) => {
        if (!next && live) void stop();
        onOpenChange(next);
      }}
    >
      <RadixDialog.Portal>
        <RadixDialog.Overlay className="fixed inset-0 z-40 bg-overlay" />
        <RadixDialog.Content className="fixed inset-y-0 right-0 z-50 flex w-full max-w-md flex-col border-l border-border bg-surface shadow-xl">
          <div className="flex items-start justify-between gap-3 border-b border-border px-5 py-4">
            <div>
              <RadixDialog.Title className="text-lg font-semibold text-text">Talk to {assistant.name}</RadixDialog.Title>
              <RadixDialog.Description className="mt-0.5 text-sm text-muted">
                {assistant.publishedVersion ? `A real call to the live version (v${assistant.publishedVersion.version}).` : 'Publish a version first.'}
                {assistant.hasUnpublishedChanges && assistant.publishedVersion ? ' Unpublished changes are not included.' : ''}
              </RadixDialog.Description>
            </div>
            <RadixDialog.Close asChild>
              <Button variant="ghost" size="sm" className="w-9 px-0" aria-label="Close">
                <X aria-hidden="true" />
              </Button>
            </RadixDialog.Close>
          </div>

          <div className="flex flex-col gap-3 border-b border-border px-5 py-3">
            <div className="flex items-center justify-between gap-3">
              <p role="status" className="flex items-center gap-2 text-sm font-medium text-text">
                <span aria-hidden="true" className={cn('size-2.5 rounded-full', status === 'active' ? 'bg-success' : status === 'connecting' || status === 'reconnecting' ? 'bg-warning' : 'bg-control')} />
                {STATUS_TEXT[status]}
                {status === 'ended' && endReason ? `: ${humanize(endReason)}` : ''}
              </p>
              {speaking && status === 'active' ? (
                <span className="flex items-center gap-1 text-xs text-muted">
                  <AudioLines aria-hidden="true" className="size-4 animate-pulse text-accent" />
                  {speaking === 'user' ? 'You are speaking' : 'Assistant is speaking'}
                </span>
              ) : null}
            </div>
            {!live ? (
              <fieldset className="flex gap-2">
                <legend className="sr-only">How to talk</legend>
                {(
                  [
                    ['voice', 'Voice', Headphones],
                    ['chat', 'Text', Keyboard],
                  ] as const
                ).map(([value, text, Icon]) => (
                  <label key={value} className={cn('flex flex-1 cursor-pointer items-center justify-center gap-2 rounded-md border px-3 py-2 text-sm font-medium has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-focus', mode === value ? 'border-accent bg-accent-soft text-accent-text' : 'border-border text-text')}>
                    <input type="radio" name="talk-mode" value={value} checked={mode === value} onChange={() => setMode(value)} className="sr-only" />
                    <Icon aria-hidden="true" className="size-4" />
                    {text}
                  </label>
                ))}
              </fieldset>
            ) : null}
            {!live && variableNames.length ? (
              <div className="flex flex-col gap-2">
                {variableNames.map((name) => (
                  <Field key={name} label={`{{${name}}}`} required>
                    {(props) => <Input {...props} value={variables[name] ?? ''} onChange={(e) => setVariables({ ...variables, [name]: e.target.value })} />}
                  </Field>
                ))}
              </div>
            ) : null}
            {error ? (
              <p role="alert" className="rounded-md bg-danger-soft px-3 py-2 text-sm text-danger">
                {error}
              </p>
            ) : null}
            <div className="flex flex-wrap gap-2">
              {live ? (
                <>
                  {mode === 'voice' ? (
                    <Button
                      aria-pressed={muted}
                      onClick={() => {
                        clientRef.current?.setMuted(!muted);
                        setMuted(!muted);
                      }}
                    >
                      {muted ? <MicOff aria-hidden="true" /> : <Mic aria-hidden="true" />}
                      {muted ? 'Unmute' : 'Mute'}
                    </Button>
                  ) : null}
                  <Button variant="danger" onClick={() => void stop()}>
                    <PhoneOff aria-hidden="true" />
                    End call
                  </Button>
                </>
              ) : (
                <Button variant="primary" onClick={() => void start()} loading={testCall.isPending} disabled={!assistant.publishedVersion}>
                  {mode === 'voice' ? <Mic aria-hidden="true" /> : <Keyboard aria-hidden="true" />}
                  {status === 'ended' ? 'Start again' : 'Start call'}
                </Button>
              )}
              {callId && status === 'ended' ? (
                <Link href={`/calls/${callId}`} className="inline-flex h-10 items-center rounded-md px-3 text-sm font-medium text-accent-text underline-offset-4 hover:underline">
                  View call details
                </Link>
              ) : null}
            </div>
          </div>

          <div ref={logRef} className="min-h-0 flex-1 overflow-y-auto px-5 py-4">
            {lines.length === 0 ? (
              <p className="text-sm text-muted">{live ? (mode === 'voice' ? 'Say something…' : 'Type a message below.') : 'The live transcript appears here.'}</p>
            ) : null}
            {/* Final lines are announced; the line still being spoken is shown but not read out word by word */}
            <ol role="log" aria-live="polite" aria-label="Transcript" className="flex flex-col gap-3">
              {lines
                .filter((l) => l.final)
                .map((line) => (
                  <TranscriptLine key={line.id} line={line} />
                ))}
            </ol>
            <div aria-hidden="true" className="mt-3 flex flex-col gap-3">
              {lines
                .filter((l) => !l.final)
                .map((line) => (
                  <TranscriptLine key={line.id} line={line} as="div" />
                ))}
            </div>
          </div>

          {live && status === 'active' ? (
            <form onSubmit={sendTyped} className="flex gap-2 border-t border-border px-5 py-3">
              <label htmlFor="talk-message" className="sr-only">
                Message to the assistant
              </label>
              <Input id="talk-message" value={typed} onChange={(e) => setTyped(e.target.value)} placeholder="Type a message" maxLength={2000} autoComplete="off" />
              <Button type="submit" variant="primary" className="w-10 px-0" aria-label="Send message" disabled={!typed.trim()}>
                <Send aria-hidden="true" />
              </Button>
            </form>
          ) : null}
        </RadixDialog.Content>
      </RadixDialog.Portal>
    </RadixDialog.Root>
  );
}

function TranscriptLine({ line, as = 'li' }: { line: Line; as?: 'li' | 'div' }) {
  const Tag = as;
  const who = line.role === 'user' ? 'You' : line.role === 'assistant' ? 'Assistant' : 'Tool call';
  return (
    <Tag className={cn('flex flex-col gap-0.5', line.role === 'user' ? 'items-end' : 'items-start')}>
      <span className="text-xs font-medium text-muted">{who}</span>
      <span
        className={cn(
          'max-w-[85%] rounded-lg px-3 py-2 text-sm break-words',
          line.role === 'user' ? 'bg-accent text-accent-fg' : line.role === 'tool' ? 'bg-info-soft font-mono text-xs text-info' : 'bg-surface-2 text-text',
          !line.final && 'opacity-70'
        )}
      >
        {line.text}
        {line.interrupted ? <span className="ml-1 text-xs italic">(interrupted)</span> : null}
      </span>
    </Tag>
  );
}
