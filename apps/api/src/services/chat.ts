/**
 * Text conversations (chat API, OpenAI-compatible API, SMS): sessions, turns, history, usage and
 * webhooks. The engine's runTextTurn does the thinking; this file loads and stores everything around
 * it, always under the session's org (tenants.withOrg → row-level security).
 *
 * - A session pins its config when it starts: a saved assistant's version, a transient spec
 *   (private keys), or every squad member's version. Later edits do not change a live session.
 * - History: every message is stored; the newest CHAT_MAX_HISTORY_MESSAGES go to the model.
 * - Expiry: CHAT_SESSION_IDLE_MINUTES after the last message; CHAT_MAX_MESSAGES_PER_SESSION ends it.
 * - Turns on one session run one at a time (queued in this process; a concurrent turn on another
 *   node fails with 409 instead of interleaving, through the message_count check).
 * - Each turn writes a usage_record in the org's billing unit (message or token).
 */
import type { FastifyBaseLogger } from 'fastify';
import { buildCallConfig } from '../../../../packages/engine/src/assistant/engineConfig.ts';
import { applyMergePatch } from '../../../../packages/engine/src/assistant/merge.ts';
import type { AssistantSpec } from '../../../../packages/engine/src/assistant/spec.ts';
import { MissingVariablesError } from '../../../../packages/engine/src/assistant/variables.ts';
import { runTextTurn, trimHistory, type TextAgent, type TextSquad, type TextTurnEvent } from '../../../../packages/engine/src/chat/textTurn.ts';
import { UsageMeter } from '../../../../packages/engine/src/engine/usage.ts';
import { ProviderResolutionError } from '../../../../packages/engine/src/providers/resolve.ts';
import { ProviderError, type ChatMessage, type ToolCall } from '../../../../packages/engine/src/providers/types.ts';
import { SquadSession, type SquadDefinition, type SquadState } from '../../../../packages/engine/src/squad/runtime.ts';
import { newId } from '../auth/crypto.ts';
import type { AppContext } from '../context.ts';
import type { Queryable } from '../db/database.ts';
import { ApiError } from '../http/errors.ts';
import { engineLogger } from '../voice/runtime.ts';
import type { Actor } from './audit.ts';
import { getAssistant, getVersion, requireValidSpec } from './assistants.ts';
import { loadToolSpecs } from './tools.ts';
import { enqueueChatEvent } from './webhooks.ts';

export type ChatChannel = 'api' | 'web' | 'openai' | 'sms';
export type BillingUnit = 'message' | 'token';

export const MAX_CHAT_MESSAGE_CHARS = 4000;

const CHANNEL_INSTRUCTIONS: Partial<Record<ChatChannel, string>> = {
  sms: 'This conversation is by SMS. Reply in plain text without markdown or links unless asked, in a few short sentences.',
};

interface SquadMemberSnapshot {
  id: string;
  name: string;
  spec: AssistantSpec;
  contextMode: 'full' | 'summary' | 'variables';
  contextSchema?: Record<string, unknown>;
  handoffTargets: Record<string, string>;
}

interface SquadSnapshot {
  squad: { maxHandoffs: number; members: SquadMemberSnapshot[] };
}

export interface SessionRow {
  id: string;
  org_id: string;
  channel: ChatChannel;
  assistant_id: string | null;
  assistant_version_id: string | null;
  squad_id: string | null;
  config_source: 'published' | 'version' | 'transient' | 'squad';
  assistant_name: string;
  config: AssistantSpec | SquadSnapshot;
  variable_values: Record<string, string>;
  squad_state: SquadState | null;
  instructions: string[];
  status: 'active' | 'ended';
  end_reason: string | null;
  origin: string | null;
  phone_number_id: string | null;
  customer_number: string | null;
  metadata: Record<string, unknown>;
  message_count: number;
  usage: { turns?: number; inputTokens?: number; outputTokens?: number };
  created_by_type: 'user' | 'api_key' | 'system';
  created_by_id: string | null;
  created_at: Date;
  last_activity_at: Date;
  expires_at: Date;
  ended_at: Date | null;
}

interface MessageRow {
  seq: number;
  role: 'user' | 'assistant' | 'tool';
  content: string;
  tool_calls: ToolCall[] | null;
  tool_call_id: string | null;
  tool_name: string | null;
  member_id: string | null;
  created_at: Date;
}

export interface CreateSessionInput {
  channel: ChatChannel;
  actor: Actor | { type: 'system'; id: null };
  assistantId?: string;
  squadId?: string;
  /** Transient spec (private keys only; the route checks). */
  assistant?: Record<string, unknown>;
  version?: number;
  variables?: Record<string, string>;
  overrides?: Record<string, unknown>;
  origin?: string | null;
  phoneNumberId?: string | null;
  customerNumber?: string | null;
  metadata?: Record<string, unknown>;
}

export interface TurnOptions {
  logger: FastifyBaseLogger;
  signal: AbortSignal;
  onEvent?: (event: TextTurnEvent) => void;
  /** Extra system instructions for this turn only (OpenAI-style system messages). */
  instructions?: string[];
  /** History supplied by the client (OpenAI semantics) instead of the stored one. */
  history?: ChatMessage[];
  /** Inbound SMS id: a webhook retry of the same message is not answered twice. */
  providerMessageId?: string;
  /** Per-request model parameters (private keys). */
  model?: { temperature?: number; maxTokens?: number };
}

export interface TurnOutcome {
  sessionId: string;
  reply: string;
  ended: boolean;
  endReason: string | null;
  memberId: string | null;
  toolCalls: { name: string; status: string; latencyMs: number }[];
  usage: { inputTokens: number; outputTokens: number; estimated: boolean; billingUnit: BillingUnit; quantity: number };
}

export function sessionView(row: SessionRow) {
  return {
    id: row.id,
    channel: row.channel,
    status: row.status,
    endReason: row.end_reason,
    assistantId: row.assistant_id,
    squadId: row.squad_id,
    assistantName: row.assistant_name,
    currentMemberId: row.squad_state?.currentMemberId ?? null,
    messageCount: row.message_count,
    usage: row.usage,
    customerNumber: row.customer_number,
    metadata: row.metadata,
    createdAt: row.created_at.toISOString(),
    lastActivityAt: row.last_activity_at.toISOString(),
    expiresAt: row.expires_at.toISOString(),
    endedAt: row.ended_at?.toISOString() ?? null,
  };
}

function toChatMessage(row: MessageRow): ChatMessage {
  if (row.role === 'tool') return { role: 'tool', toolCallId: row.tool_call_id ?? '', name: row.tool_name ?? '', content: row.content };
  if (row.role === 'assistant') return { role: 'assistant', content: row.content, ...(row.tool_calls?.length ? { toolCalls: row.tool_calls } : {}) };
  return { role: 'user', content: row.content };
}

function missingVariables(error: MissingVariablesError): ApiError {
  return new ApiError('validation_error', 'The conversation is missing required assistant variables', {
    issues: error.missing.map((item) => ({ path: `variables.${item.name}`, message: `Required by ${item.usedIn.join(' and ')}` })),
  });
}

export class ChatService {
  /** Per-session turn queue (this process). */
  private readonly queues = new Map<string, Promise<unknown>>();

  constructor(private readonly ctx: AppContext) {}

  private get specContext() {
    return { registry: this.ctx.voice.registry, endpointPolicy: this.ctx.voice.endpointPolicy };
  }

  // ---------------------------------------------------------------- sessions

  async createSession(orgId: string, input: CreateSessionInput): Promise<SessionRow> {
    const id = newId();
    const now = new Date();
    const variables = input.variables ?? {};
    const overrides = input.overrides ?? {};
    return this.ctx.tenants.withOrg(orgId, async (tx) => {
      let name = 'Transient assistant';
      let source: SessionRow['config_source'] = 'transient';
      let versionId: string | null = null;
      let config: AssistantSpec | SquadSnapshot;
      let firstSpec: AssistantSpec;
      if (input.squadId) {
        const snapshot = await this.squadSnapshot(tx, orgId, input.squadId, overrides);
        config = snapshot.snapshot;
        name = snapshot.name;
        source = 'squad';
        firstSpec = snapshot.snapshot.squad.members[0].spec;
      } else if (input.assistantId) {
        const assistant = await getAssistant(tx, orgId, input.assistantId);
        name = assistant.name;
        const version = input.version === undefined ? (assistant.published_version ? await getVersion(tx, orgId, input.assistantId, assistant.published_version) : null) : await getVersion(tx, orgId, input.assistantId, input.version);
        if (!version) throw new ApiError('conflict', 'Assistant has no published version');
        config = firstSpec = requireValidSpec(applyMergePatch(version.config, overrides), this.specContext, 'overrides');
        source = input.version === undefined ? 'published' : 'version';
        versionId = version.id;
      } else {
        config = requireValidSpec(input.assistant, this.specContext, 'assistant');
        if (Object.keys(overrides).length) config = requireValidSpec(applyMergePatch(config, overrides), this.specContext, 'overrides');
        firstSpec = config;
      }
      // Fail now, not on the first message, when variables are missing
      try {
        buildCallConfig({ spec: firstSpec, name, callId: id, startedAt: now, variables }, this.ctx.voice.registry);
      } catch (error) {
        if (error instanceof MissingVariablesError) throw missingVariables(error);
        throw error;
      }
      const squadState = input.squadId ? new SquadSession({ id: input.squadId, members: (config as SquadSnapshot).squad.members.map(toMemberDefinition), maxHandoffs: (config as SquadSnapshot).squad.maxHandoffs }).toState() : null;
      const row = (
        await tx.query<SessionRow>(
          `INSERT INTO chat_session (id, org_id, channel, assistant_id, assistant_version_id, squad_id, config_source, assistant_name, config, variable_values,
             squad_state, origin, phone_number_id, customer_number, metadata, created_by_type, created_by_id, expires_at)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17, now() + ($18::bigint * interval '1 millisecond'))
           RETURNING *`,
          [
            id, orgId, input.channel, input.assistantId ?? null, versionId, input.squadId ?? null, source, name, JSON.stringify(config), JSON.stringify(variables),
            squadState ? JSON.stringify(squadState) : null, input.origin ?? null, input.phoneNumberId ?? null, input.customerNumber ?? null, JSON.stringify(input.metadata ?? {}),
            input.actor.type, input.actor.id, this.ctx.config.chat.sessionIdleMs,
          ]
        )
      ).rows[0];
      await enqueueChatEvent(tx, this.webhookSubject(row), 'chat.started', { channel: row.channel, assistantId: row.assistant_id, squadId: row.squad_id, customerNumber: row.customer_number }, ['customerNumber']);
      return row;
    });
  }

  /** Pin every member's spec (published version + squad and member overrides). */
  private async squadSnapshot(tx: Queryable, orgId: string, squadId: string, overrides: Record<string, unknown>): Promise<{ name: string; snapshot: SquadSnapshot }> {
    const squad = (await tx.query<{ name: string; max_handoffs: number; overrides: Record<string, unknown> }>('SELECT name, max_handoffs, overrides FROM squad WHERE org_id = $1 AND id = $2', [orgId, squadId])).rows[0];
    if (!squad) throw new ApiError('not_found', 'Squad not found');
    const rows = (
      await tx.query<{ id: string; assistant_id: string | null; inline_config: Record<string, unknown> | null; member_overrides: Record<string, unknown>; context_mode: SquadMemberSnapshot['contextMode']; context_schema: Record<string, unknown> | null; handoff_targets: Record<string, string> }>(
        'SELECT id, assistant_id, inline_config, member_overrides, context_mode, context_schema, handoff_targets FROM squad_member WHERE org_id = $1 AND squad_id = $2 ORDER BY position',
        [orgId, squadId]
      )
    ).rows;
    if (!rows.length) throw new ApiError('conflict', 'Squad has no members');
    const members: SquadMemberSnapshot[] = [];
    for (const [index, row] of rows.entries()) {
      let base: Record<string, unknown>;
      let name = `Member ${index + 1}`;
      if (row.assistant_id) {
        const assistant = await getAssistant(tx, orgId, row.assistant_id);
        if (!assistant.published_version) throw new ApiError('conflict', `Squad member ${index + 1} (${assistant.name}) has no published version`);
        base = (await getVersion(tx, orgId, row.assistant_id, assistant.published_version)).config as Record<string, unknown>;
        name = assistant.name;
      } else {
        base = row.inline_config ?? {};
      }
      // Squad-wide overrides, then the member's own, then the request's
      const merged = applyMergePatch(applyMergePatch(applyMergePatch(base, squad.overrides), row.member_overrides), overrides);
      members.push({
        id: row.id,
        name,
        spec: requireValidSpec(merged, this.specContext, `members.${index}`),
        contextMode: row.context_mode,
        ...(row.context_schema ? { contextSchema: row.context_schema } : {}),
        handoffTargets: row.handoff_targets,
      });
    }
    return { name: squad.name, snapshot: { squad: { maxHandoffs: squad.max_handoffs, members } } };
  }

  /** The session, ended first if it has expired. 404 for another org's (or unknown) id. */
  async getSession(orgId: string, id: string): Promise<SessionRow> {
    const row = await this.ctx.tenants.withOrg(orgId, async (tx) => {
      const current = (await tx.query<SessionRow>('SELECT * FROM chat_session WHERE org_id = $1 AND id = $2', [orgId, id])).rows[0];
      if (!current) throw new ApiError('not_found', 'Chat session not found');
      if (current.status === 'active' && current.expires_at.getTime() <= Date.now()) return this.end(tx, current, 'expired');
      return current;
    });
    return row;
  }

  async messages(orgId: string, sessionId: string): Promise<(ChatMessage & { seq: number; memberId: string | null; createdAt: string })[]> {
    const rows = await this.ctx.tenants.withOrg(orgId, async (tx) => (await tx.query<MessageRow>('SELECT seq, role, content, tool_calls, tool_call_id, tool_name, member_id, created_at FROM chat_message WHERE org_id = $1 AND session_id = $2 ORDER BY seq', [orgId, sessionId])).rows);
    return rows.map((row) => ({ ...toChatMessage(row), seq: row.seq, memberId: row.member_id, createdAt: row.created_at.toISOString() }));
  }

  async endSession(orgId: string, id: string, reason: string): Promise<SessionRow> {
    return this.ctx.tenants.withOrg(orgId, async (tx) => {
      const current = (await tx.query<SessionRow>('SELECT * FROM chat_session WHERE org_id = $1 AND id = $2 FOR UPDATE', [orgId, id])).rows[0];
      if (!current) throw new ApiError('not_found', 'Chat session not found');
      return current.status === 'active' ? this.end(tx, current, reason) : current;
    });
  }

  private async end(tx: Queryable, session: SessionRow, reason: string): Promise<SessionRow> {
    const ended = (await tx.query<SessionRow>(`UPDATE chat_session SET status = 'ended', end_reason = $3, ended_at = now() WHERE org_id = $1 AND id = $2 RETURNING *`, [session.org_id, session.id, reason])).rows[0];
    await enqueueChatEvent(tx, this.webhookSubject(ended), 'chat.ended', {
      endReason: reason,
      messageCount: ended.message_count,
      usage: ended.usage,
      durationMs: (ended.ended_at ?? new Date()).getTime() - ended.created_at.getTime(),
    });
    return ended;
  }

  /** The active SMS conversation between our number and a customer, if any (expired ones are ended). */
  async findSmsSession(orgId: string, phoneNumberId: string, customerNumber: string): Promise<SessionRow | null> {
    return this.ctx.tenants.withOrg(orgId, async (tx) => {
      const rows = (await tx.query<SessionRow>(`SELECT * FROM chat_session WHERE org_id = $1 AND channel = 'sms' AND phone_number_id = $2 AND customer_number = $3 AND status = 'active' ORDER BY created_at DESC`, [orgId, phoneNumberId, customerNumber])).rows;
      for (const row of rows) {
        if (row.expires_at.getTime() > Date.now()) return row;
        await this.end(tx, row, 'expired');
      }
      return null;
    });
  }

  private webhookSubject(row: SessionRow) {
    return { id: row.id, orgId: row.org_id, assistantId: row.assistant_id, phoneNumberId: row.phone_number_id };
  }

  // ---------------------------------------------------------------- turns

  /** Run one user message through the session's assistant. Turns on a session run one at a time. */
  runTurn(orgId: string, sessionId: string, userText: string, options: TurnOptions): Promise<TurnOutcome> {
    const previous = this.queues.get(sessionId) ?? Promise.resolve();
    const next = previous.catch(() => undefined).then(() => this.turn(orgId, sessionId, userText, options));
    this.queues.set(sessionId, next);
    void next.finally(() => {
      if (this.queues.get(sessionId) === next) this.queues.delete(sessionId);
    }).catch(() => undefined);
    return next;
  }

  private async turn(orgId: string, sessionId: string, input: string, options: TurnOptions): Promise<TurnOutcome> {
    const text = input.trim();
    if (!text || text.length > MAX_CHAT_MESSAGE_CHARS) throw new ApiError('validation_error', 'The request is invalid', { issues: [{ path: 'message', message: `Must be 1 to ${MAX_CHAT_MESSAGE_CHARS} characters` }] });
    const session = await this.getSession(orgId, sessionId);
    if (session.status !== 'active') throw new ApiError('conflict', 'This chat session has ended; start a new one', { reason: session.end_reason === 'expired' ? 'session_expired' : 'session_ended', endReason: session.end_reason });
    const log = options.logger.child({ session_id: session.id, org_id: orgId });
    const logger = engineLogger(log);

    const { stored, billingUnit } = await this.ctx.tenants.withOrg(orgId, async (tx) => {
      if (options.providerMessageId) {
        const seen = await tx.query('SELECT 1 FROM chat_message WHERE org_id = $1 AND provider_message_id = $2', [orgId, options.providerMessageId]);
        if (seen.rows.length) throw new ApiError('conflict', 'This message was already answered', { reason: 'duplicate_message' });
      }
      const history = options.history ? [] : (await tx.query<MessageRow>('SELECT seq, role, content, tool_calls, tool_call_id, tool_name, member_id, created_at FROM chat_message WHERE org_id = $1 AND session_id = $2 ORDER BY seq', [orgId, session.id])).rows.map(toChatMessage);
      const unit = (await tx.query<{ chat_billing_unit: BillingUnit }>('SELECT chat_billing_unit FROM org WHERE id = $1', [orgId])).rows[0]?.chat_billing_unit ?? 'message';
      return { stored: history, billingUnit: unit };
    });
    const agents = new AgentFactory(this.ctx, orgId, session, logger, options.model);

    const squad = isSquad(session.config) ? this.squadRuntime(session, agents) : null;
    const agent = await agents.agent(squad ? squad.currentMember : null);
    const meter = new UsageMeter();
    let result;
    try {
      result = await runTextTurn({
        sessionId: session.id,
        agent,
        history: trimHistory(options.history ?? stored, this.ctx.config.chat.maxHistoryMessages),
        userText: text,
        instructions: [...(CHANNEL_INSTRUCTIONS[session.channel] ? [CHANNEL_INSTRUCTIONS[session.channel] as string] : []), ...session.instructions, ...(options.instructions ?? [])],
        squad: squad?.text ?? null,
        toolContext: { fetch: this.ctx.fetch, variables: session.variable_values },
        toolSecrets: agents.secrets,
        meter,
        logger,
        signal: options.signal,
        onEvent: options.onEvent,
      });
    } catch (error) {
      if (error instanceof ProviderError) {
        log.error({ err: error, stage: error.stage, provider: error.provider }, 'chat turn failed');
        throw new ApiError('upstream_unavailable', 'The assistant could not answer right now; try again', { stage: error.stage, provider: error.provider });
      }
      throw error;
    }

    // Usage: tokens from the model meter (estimated when the provider reported none)
    const usage = meter.snapshot();
    const inputTokens = usage.reduce((n, r) => n + (r.units.inputTokens ?? 0), 0);
    const outputTokens = usage.reduce((n, r) => n + (r.units.outputTokens ?? 0), 0);
    const estimated = usage.some((r) => r.estimated);
    const used = usage.at(-1);
    const quantity = billingUnit === 'token' ? inputTokens + outputTokens : 1;
    const storeMessages = result.messages;

    const saved = await this.ctx.tenants.withOrg(orgId, async (tx) => {
      const base = session.message_count;
      for (const [i, message] of storeMessages.entries()) {
        await tx.query(
          `INSERT INTO chat_message (id, org_id, session_id, seq, role, content, tool_calls, tool_call_id, tool_name, member_id, provider_message_id)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
          [
            newId(), orgId, session.id, base + i, message.role, message.content,
            message.role === 'assistant' && message.toolCalls?.length ? JSON.stringify(message.toolCalls) : null,
            message.role === 'tool' ? message.toolCallId : null,
            message.role === 'tool' ? message.name : null,
            message.memberId ?? null,
            i === 0 ? options.providerMessageId ?? null : null,
          ]
        );
      }
      const count = base + storeMessages.length;
      const reachedLimit = count >= this.ctx.config.chat.maxMessagesPerSession;
      const totals = { turns: (session.usage.turns ?? 0) + 1, inputTokens: (session.usage.inputTokens ?? 0) + inputTokens, outputTokens: (session.usage.outputTokens ?? 0) + outputTokens };
      const updated = (
        await tx.query<SessionRow>(
          `UPDATE chat_session SET message_count = $4, last_activity_at = now(), expires_at = now() + ($5::bigint * interval '1 millisecond'),
             usage = $6, squad_state = $7, instructions = $8
           WHERE org_id = $1 AND id = $2 AND message_count = $3 AND status = 'active' RETURNING *`,
          [orgId, session.id, base, count, this.ctx.config.chat.sessionIdleMs, JSON.stringify(totals), squad ? JSON.stringify(squad.state()) : null, JSON.stringify([...session.instructions, ...result.instructions])]
        )
      ).rows[0];
      // Another node answered on this session meanwhile: roll back rather than interleave
      if (!updated) throw new ApiError('conflict', 'Another message on this session is being answered; retry', { reason: 'turn_in_progress' });
      await tx.query(
        `INSERT INTO usage_record (id, org_id, subject_type, subject_id, channel, billing_unit, quantity, messages, input_tokens, output_tokens, tokens_estimated, provider, model, billing)
         VALUES ($1,$2,'chat_session',$3,$4,$5,$6,1,$7,$8,$9,$10,$11,$12)`,
        [newId(), orgId, session.id, session.channel, billingUnit, quantity, inputTokens, outputTokens, estimated, used?.provider ?? null, used?.model ?? null, usage.some((r) => r.billing === 'platform') || !used ? 'platform' : 'customer']
      );
      const subject = this.webhookSubject(updated);
      await enqueueChatEvent(tx, subject, 'chat.message', { role: 'user', content: text }, ['content']);
      if (result.toolExecutions.length) await enqueueChatEvent(tx, subject, 'chat.tool-calls', { toolCalls: result.toolExecutions });
      if (result.reply) await enqueueChatEvent(tx, subject, 'chat.message', { role: 'assistant', content: result.reply, memberId: result.agent.memberId ?? null }, ['content']);
      const endReason = result.ended ? 'assistant-ended' : reachedLimit ? 'max-messages' : null;
      return endReason ? this.end(tx, updated, endReason) : updated;
    });

    log.info({ turn_messages: storeMessages.length, input_tokens: inputTokens, output_tokens: outputTokens, ended: saved.status === 'ended' }, 'chat turn');
    return {
      sessionId: session.id,
      reply: result.reply,
      ended: saved.status === 'ended',
      endReason: saved.end_reason,
      memberId: result.agent.memberId ?? null,
      toolCalls: result.toolExecutions,
      usage: { inputTokens, outputTokens, estimated, billingUnit, quantity },
    };
  }

  private squadRuntime(session: SessionRow, agents: AgentFactory) {
    const snapshot = (session.config as SquadSnapshot).squad;
    const definition: SquadDefinition = { id: session.squad_id ?? session.id, members: snapshot.members.map(toMemberDefinition), maxHandoffs: snapshot.maxHandoffs };
    const runtime = SquadSession.restore(definition, session.squad_state);
    const member = (id: string) => snapshot.members.find((m) => m.id === id) as SquadMemberSnapshot;
    const text: TextSquad = {
      targets: () => runtime.current.handoffTargets,
      handoff: async (target, input, history) => {
        const result = await runtime.handoff(target, { ...input, history: history.filter((m) => m.role !== 'tool').map((m) => ({ role: m.role, content: m.content })) });
        const next = member(result.member.id);
        const agent = await agents.agent(next);
        if (next.contextMode === 'full') return { agent, history: history.filter((m) => m.role !== 'tool' && !(m.role === 'assistant' && m.toolCalls?.length)) };
        const parts = [
          result.context.summary ? `Context from the previous assistant: ${result.context.summary}` : '',
          result.context.variables ? `Details collected so far: ${JSON.stringify(result.context.variables)}` : '',
        ].filter(Boolean);
        return { agent, instructions: parts.join('\n') || undefined };
      },
    };
    return { text, currentMember: member(runtime.current.id), state: () => runtime.toState() };
  }
}

function isSquad(config: SessionRow['config']): config is SquadSnapshot {
  return Boolean((config as SquadSnapshot).squad);
}

function toMemberDefinition(member: SquadMemberSnapshot) {
  return { id: member.id, contextMode: member.contextMode, ...(member.contextSchema ? { contextSchema: member.contextSchema } : {}), handoffTargets: member.handoffTargets };
}

/** Builds the TextAgent for the session's assistant or a squad member: engine config, model, tools. */
class AgentFactory {
  readonly secrets: Record<string, string | undefined> = {};
  constructor(
    private readonly ctx: AppContext,
    private readonly orgId: string,
    private readonly session: SessionRow,
    private readonly logger: ReturnType<typeof engineLogger>,
    private readonly modelParams?: { temperature?: number; maxTokens?: number }
  ) {}

  async agent(member: SquadMemberSnapshot | null): Promise<TextAgent> {
    let spec = member ? member.spec : (this.session.config as AssistantSpec);
    if (this.modelParams && (this.modelParams.temperature !== undefined || this.modelParams.maxTokens !== undefined)) {
      spec = applyMergePatch(spec, { model: { ...(this.modelParams.temperature !== undefined ? { temperature: this.modelParams.temperature } : {}), ...(this.modelParams.maxTokens !== undefined ? { maxTokens: this.modelParams.maxTokens } : {}) } });
    }
    let config;
    try {
      config = buildCallConfig({ spec, name: member?.name ?? this.session.assistant_name, callId: this.session.id, startedAt: this.session.created_at, variables: this.session.variable_values }, this.ctx.voice.registry);
    } catch (error) {
      if (error instanceof MissingVariablesError) throw missingVariables(error);
      throw new ApiError('validation_error', error instanceof Error ? error.message : 'Invalid assistant configuration');
    }
    let model;
    try {
      model = await this.ctx.voice.modelForCall(config, this.orgId, this.logger);
    } catch (error) {
      if (error instanceof ProviderResolutionError) throw new ApiError('not_configured', error.message, { component: 'model' });
      throw error;
    }
    // Tools come from the pinned spec; loaded outside the turn transaction (a short read)
    const { specs, secrets } = await this.ctx.tenants.withOrg(this.orgId, (tx) => loadToolSpecs(tx, this.orgId, spec.toolIds ?? [], this.ctx.toolCipher));
    Object.assign(this.secrets, secrets);
    return { config, model, tools: specs, ...(member ? { memberId: member.id } : {}) };
  }
}
