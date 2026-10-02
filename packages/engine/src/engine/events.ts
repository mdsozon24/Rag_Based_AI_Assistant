import type { CallState } from './stateMachine.ts';
import type { EndReason, ProviderStage } from './endReason.ts';
import type { LatencyMetric, LatencySummary, TurnKind, TurnRecord } from './metrics.ts';
import type { StateChange } from './stateMachine.ts';
import type { UsageRecord } from './usage.ts';
import type { ChatMessage, ComponentKind } from '../providers/types.ts';

export interface HistoryEntry {
  role: 'user' | 'assistant';
  content: string;
  at: number;
  kind?: TurnKind;
  /** Assistant message cut short by a barge-in; content is what the caller heard. */
  interrupted?: boolean;
}

export interface CallSummary {
  callId: string;
  endReason: EndReason;
  startedAt: number;
  endedAt: number;
  durationMs: number;
  history: HistoryEntry[];
  turns: TurnRecord[];
  stateHistory: StateChange[];
  latency: Record<LatencyMetric, LatencySummary>;
  /** Provider/model actually used per component, whose key paid, and units consumed (billing). */
  usage: UsageRecord[];
  orgId?: string;
  error?: { stage: ProviderStage | 'internal' | 'transfer'; message: string };
  transferredTo?: string;
}

/**
 * Server-side diagnostics for the per-call debug view. Unlike SessionEvent these never reach the
 * transport (and so never reach a browser): LLM requests carry the system prompt and everything the
 * model was shown. Whoever runs the session decides what to keep (see apps/api: metadata always,
 * bodies only when the assistant turned capture on).
 */
export type DebugEvent =
  | {
      type: 'llm-request';
      at: number;
      turn: number;
      provider: string;
      model: string;
      messageCount: number;
      systemPromptChars: number;
      toolNames: string[];
      temperature?: number;
      maxTokens?: number;
      request: { systemPrompt: string; messages: ChatMessage[] };
    }
  | {
      type: 'llm-response';
      at: number;
      turn: number;
      provider: string;
      model: string;
      /** Request to first token; null when no token arrived. */
      firstTokenMs: number | null;
      durationMs: number;
      /** Tokens this request used, as metered (estimated when the provider reported none). */
      inputTokens: number;
      outputTokens: number;
      outcome: 'completed' | 'aborted' | 'error';
      error?: string;
      response: { text: string; toolCalls: { name: string; args: Record<string, unknown> }[] };
    }
  /** A provider failed for good: the call fails over (message, then end or transfer). */
  | { type: 'provider-error'; at: number; stage: ProviderStage; provider: string; model: string; code?: string; message: string; retryable: boolean }
  /** A provider failed and the next one in the chain took over. */
  | { type: 'provider-fallback'; at: number; component: ComponentKind; from: { provider: string; model: string }; to: { provider: string; model: string }; code?: string; message: string };

/** Events a session emits to its transport (control channel) and observers. */
export type SessionEvent =
  | { type: 'state'; state: CallState; at: number }
  | { type: 'user-speech'; speaking: boolean; at: number }
  /** Final lines carry when they were said (ms epoch on the voice node): speech onset to end for the caller, first audio to end of play-out for the agent. */
  | { type: 'transcript'; role: 'user'; text: string; final: boolean; startedAt?: number; endedAt?: number }
  | { type: 'transcript'; role: 'assistant'; text: string; final: boolean; interrupted?: boolean; startedAt?: number; endedAt?: number }
  | { type: 'interrupted'; at: number; heardText: string }
  | { type: 'turn'; turn: TurnRecord }
  /** The person asked not to be called again (campaign calls); the do-not-call list is updated before the call ends. */
  | { type: 'opt-out'; source: 'phrase' | 'tool'; phrase?: string }
  /** The assistant reported a campaign outcome label. */
  | { type: 'outcome'; label: string; notes?: string }
  /** The model called a tool (endCall, transferCall, ...). */
  | { type: 'tool-call'; name: string; args: Record<string, unknown>; at?: number }
  | { type: 'error'; stage: ProviderStage | 'internal'; message: string }
  | { type: 'ended'; reason: EndReason; summary: CallSummary };
