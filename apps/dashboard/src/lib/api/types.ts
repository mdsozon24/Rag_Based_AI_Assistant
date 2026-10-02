/**
 * Response shapes of the public API the dashboard reads (docs/API.md). Written out here rather than
 * imported, so the browser bundle never pulls server modules.
 */
import type { AssistantSpec } from '@/lib/schemas/assistant';

// ---------------------------------------------------------------- assistants

export interface Assistant {
  id: string;
  name: string;
  metadata: Record<string, unknown>;
  config: AssistantSpec;
  configSchema: number;
  publishedVersion: { id: string; version: number; publishedAt: string | null } | null;
  latestVersion: number | null;
  hasUnpublishedChanges: boolean;
  requiredVariables: string[];
  templateId: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface AssistantVersion {
  id: string;
  assistantId: string;
  version: number;
  configSchema: number;
  note: string | null;
  published: boolean;
  createdBy: { type: string; id: string | null };
  createdAt: string;
  config?: AssistantSpec;
}

export interface AssistantTemplate {
  id: string;
  name: string;
  description: string;
  config: AssistantSpec;
}

// ---------------------------------------------------------------- provider catalog (GET /v1/providers)

export type ComponentKind = 'transcriber' | 'model' | 'voice';

export interface FieldDescriptor {
  name: string;
  type: 'string' | 'number' | 'integer' | 'boolean' | 'enum' | 'string-list' | 'map' | 'object-list';
  required: boolean;
  values?: (string | number)[];
  min?: number;
  max?: number;
  exclusiveMin?: boolean;
  exclusiveMax?: boolean;
  maxItems?: number;
  format?: 'url';
  default?: unknown;
}

export interface ProviderDescriptor {
  id: string;
  description: string;
  defaultModel: string;
  suggestedModels: string[];
  credentialVendor: string;
  fields: FieldDescriptor[];
}

export interface PresetComponent {
  provider: string;
  model?: string;
  fallbacks?: { provider: string; model?: string }[];
}

export interface ProviderCatalog {
  components: Record<ComponentKind, { providers: ProviderDescriptor[]; policy: FieldDescriptor[] }>;
  presets: { name: 'fast' | 'balanced' | 'quality'; description: string; default: boolean; silenceMs: number; transcriber: PresetComponent; model: PresetComponent; voice: PresetComponent }[];
  credentialVendors: string[];
}

// ---------------------------------------------------------------- calls

export interface CreatedCall {
  id: string;
  status: string;
  assistantId: string | null;
  version: number | null;
  configSource: string;
  connectToken: string;
  tokenExpiresAt: string;
  wsUrl: string;
}

export interface AnalysisView {
  status: 'pending' | 'running' | 'succeeded' | 'failed' | 'skipped';
  skipReason: string | null;
  attempts: number;
  error: string | null;
  summary: string | null;
  summaryError?: string;
  successEvaluation: { rubric: string; passed: boolean | null; score: number | null; category: string | null; reason: string | null; error?: string } | null;
  structuredOutputs: { id: string | null; name: string; status: 'succeeded' | 'failed' | 'skipped'; values: Record<string, unknown> | null; error: string | null }[];
  usage: { inputTokens: number; outputTokens: number; requests: number };
  analysedAt: string | null;
  nextAttemptAt: string | null;
}

export interface CallListItem {
  id: string;
  assistantId: string | null;
  assistantName: string;
  type: string;
  direction: string;
  status: string;
  endReason: string | null;
  customerNumber: string | null;
  campaignId: string | null;
  createdAt: string;
  startedAt: string | null;
  endedAt: string | null;
  durationMs: number | null;
  analysis: AnalysisView | null;
}

export interface TranscriptEntry {
  id: string;
  seq: number;
  kind: 'speech' | 'tool-call';
  role: 'user' | 'assistant' | 'tool' | 'system';
  text: string;
  startedAt: string | null;
  endedAt: string | null;
  startOffsetMs: number | null;
  endOffsetMs: number | null;
  /** Speech only: the caller cut the assistant off; text is what they heard. */
  interrupted?: boolean;
  toolCall?: { name: string; arguments: Record<string, unknown>; result: unknown; status: string };
}

export interface UsageRecord {
  component: ComponentKind;
  provider: string;
  model: string;
  billing: 'platform' | 'customer';
  fallback: boolean;
  estimated: boolean;
  units: Partial<{ audioSeconds: number; inputTokens: number; outputTokens: number; characters: number; audioSecondsOut: number; requests: number }>;
}

export interface CallDetail {
  id: string;
  assistantId: string | null;
  assistantName: string;
  status: string;
  direction: string;
  customerNumber: string | null;
  providerCallId: string | null;
  createdAt: string;
  startedAt: string | null;
  endedAt: string | null;
  endReason: string | null;
  cost: UsageRecord[] | null;
  recordingUrl: string | null;
  timeline: { id: string; type: string; payload: Record<string, unknown>; createdAt: string }[];
  transcript: TranscriptEntry[];
  analysis: AnalysisView | null;
}

export interface CallDebug {
  call: { id: string; assistantId: string | null; assistantName: string; status: string; endReason: string | null; startedAt: string | null; endedAt: string | null; durationMs: number | null; captureLlm: boolean };
  summary: { events: number; byType: Record<string, number>; providerErrors: number; providerFallbacks: number; errors: number; llmRequests: number; droppedLogLines: number; droppedPartials: number };
  turns: { index: number; kind: string; interrupted: boolean; latency: Record<string, number | null> | null }[];
  truncated: boolean;
  timeline: { at: string; offsetMs: number; type: string; id: string; payload: Record<string, unknown>; body?: Record<string, unknown> }[];
}

export interface TranscriptHit {
  callId: string;
  assistantId: string | null;
  assistantName: string;
  seq: number;
  kind: string;
  role: string;
  text: string;
  snippet: string;
  startedAt: string | null;
  callCreatedAt: string;
}

// ---------------------------------------------------------------- tools, outputs, credentials

export type ToolType = 'function' | 'endCall' | 'transferCall' | 'dtmf' | 'kbQuery' | 'handoff' | 'mcp';

export interface Tool {
  id: string;
  name: string;
  description: string;
  type: ToolType | string;
  parameters: Record<string, unknown>;
  messages: Record<string, unknown> | null;
  endpointUrl: string | null;
  timeoutMs: number;
  retries: number;
  auth: { type: string; headerName?: string; configured: boolean };
  staticParameters: Record<string, unknown>;
  variableAliases: Record<string, string>;
  sensitivePaths: string[];
  rejectionRules: unknown[];
  createdAt: string;
  updatedAt: string;
}

export interface StructuredOutput {
  id: string;
  name: string;
  description: string;
  schema: Record<string, unknown>;
  prompt: string | null;
  assistantCount?: number;
  createdAt: string;
  updatedAt: string;
}

export interface Credential {
  id: string;
  provider: string;
  label: string;
  masked: string;
  createdAt: string;
  lastUsedAt: string | null;
}
