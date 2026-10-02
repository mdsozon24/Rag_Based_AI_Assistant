/**
 * Analysing one finished call: summary, success evaluation and structured outputs, each one a
 * separate model request on the call's own model chain (org key, else platform key; retries and
 * fallbacks as on the call).
 *
 * Progress is saved after every step, so a retried job only redoes what is missing:
 * - a provider failure (timeout, quota, bad key) ends the attempt; the job is retried later with backoff;
 * - a reply that never validates (after one corrective retry) is final for that step: it is recorded
 *   as failed with the reason, and the other steps carry on.
 * Every model request writes a usage_record (channel "analysis"), including requests that failed.
 */
import type { FastifyBaseLogger } from 'fastify';
import { parseAssistantConfig } from '../../../../../packages/engine/src/engine/config.ts';
import { toEngineInput } from '../../../../../packages/engine/src/assistant/engineConfig.ts';
import type { AssistantSpec } from '../../../../../packages/engine/src/assistant/spec.ts';
import { UsageMeter } from '../../../../../packages/engine/src/engine/usage.ts';
import { ModelChain, type ProviderChain } from '../../../../../packages/engine/src/providers/chain.ts';
import { ProviderResolutionError } from '../../../../../packages/engine/src/providers/resolve.ts';
import type { ChatMessage, LanguageModel } from '../../../../../packages/engine/src/providers/types.ts';
import { newId } from '../../auth/crypto.ts';
import type { AppContext } from '../../context.ts';
import type { Queryable } from '../../db/database.ts';
import { engineLogger } from '../../voice/runtime.ts';
import { checkSchema, validateAgainst } from './jsonSchema.ts';
import { callBlock, correctionTask, extractionTask, MAX_SUMMARY_CHARS, parseJsonObject, parseSuccess, successTask, summaryTask, SYSTEM_PROMPT, type Rubric, type SuccessResult } from './prompts.ts';
import { loadTranscript, transcriptForModel } from './transcript.ts';

export type SkipReason = 'analysis-disabled' | 'no-transcript';
export type Outcome = { kind: 'done'; skipped?: SkipReason } | { kind: 'retry'; error: string };

export interface OutputResult {
  name: string;
  status: 'succeeded' | 'failed' | 'skipped';
  values?: Record<string, unknown>;
  error?: string;
  /** The schema the values were checked against (so old results stay readable after the resource changes). */
  schema?: Record<string, unknown>;
}

interface Usage {
  inputTokens: number;
  outputTokens: number;
  requests: number;
  steps?: Record<string, { inputTokens: number; outputTokens: number; requests: number }>;
}

interface CallRow {
  id: string;
  assistant_name: string;
  config: AssistantSpec;
  variable_values: Record<string, string>;
  started_at: Date | null;
  duration_ms: number | null;
  end_reason: string | null;
  direction: string;
}

interface AnalysisRow {
  steps: Record<string, { status: string; error?: string }>;
  outputs: Record<string, OutputResult>;
  usage: Usage;
}

interface OutputDef {
  key: string;
  name: string;
  schema: Record<string, unknown>;
  prompt?: string;
}

/** A model request failed for a reason a later attempt may fix. */
class StepFailed extends Error {}

const ASK_TIMEOUT_MS = 120_000;
const FIRST_TOKEN_TIMEOUT_MS = 45_000;
const IDLE_TIMEOUT_MS = 30_000;

export interface Plan {
  summary: boolean;
  success: { rubric: Rubric; categories?: string[]; prompt?: string } | null;
  inline: { schema: Record<string, unknown>; prompt?: string } | null;
  outputIds: string[];
}

/** What the assistant's analysis settings ask for. */
export function planOf(config: AssistantSpec): Plan {
  const analysis = config.analysis ?? {};
  const success = analysis.successEvaluation;
  const inline = analysis.structuredData;
  return {
    summary: analysis.summary?.enabled === true,
    success: success?.enabled ? { rubric: success.rubric ?? 'pass-fail', categories: success.categories, prompt: success.prompt } : null,
    inline: inline?.enabled && inline.schema ? { schema: inline.schema, prompt: inline.prompt } : null,
    outputIds: analysis.structuredOutputIds ?? [],
  };
}

export const planIsEmpty = (plan: Plan) => !plan.summary && !plan.success && !plan.inline && plan.outputIds.length === 0;

export async function analyzeCall(ctx: AppContext, orgId: string, analysisId: string, callId: string, log: FastifyBaseLogger): Promise<Outcome> {
  const limits = ctx.config.analysis;
  const loaded = await ctx.tenants.withOrg(orgId, async (tx) => {
    const call = (
      await tx.query<CallRow>('SELECT id, assistant_name, config, variable_values, started_at, duration_ms, end_reason, direction FROM call WHERE org_id = $1 AND id = $2', [orgId, callId])
    ).rows[0];
    const row = (await tx.query<AnalysisRow>('SELECT steps, outputs, usage FROM call_analysis WHERE org_id = $1 AND id = $2', [orgId, analysisId])).rows[0];
    if (!call || !row) return null;
    const plan = planOf(call.config);
    const transcript = await loadTranscript(tx, orgId, callId);
    const stored = plan.outputIds.length
      ? (await tx.query<{ id: string; name: string; schema: Record<string, unknown>; prompt: string | null; deleted_at: Date | null }>('SELECT id, name, schema, prompt, deleted_at FROM structured_output WHERE org_id = $1 AND id = ANY ($2::uuid[])', [orgId, plan.outputIds])).rows
      : [];
    return { call, row, plan, transcript, stored };
  });
  if (!loaded) return { kind: 'done', skipped: 'no-transcript' };
  const { call, row, plan, transcript, stored } = loaded;
  if (planIsEmpty(plan)) return { kind: 'done', skipped: 'analysis-disabled' };
  if (!transcript.some((entry) => entry.kind === 'speech')) return { kind: 'done', skipped: 'no-transcript' };

  const usage: Usage = { inputTokens: row.usage.inputTokens ?? 0, outputTokens: row.usage.outputTokens ?? 0, requests: row.usage.requests ?? 0, steps: { ...(row.usage.steps ?? {}) } };
  const done = (key: string) => row.steps[key] !== undefined;
  const outputDone = (key: string) => row.outputs[key] !== undefined;

  // Structured outputs: the assistant's inline schema, then each reusable one in the order configured
  const defs: OutputDef[] = [];
  const skippedOutputs: Record<string, OutputResult> = {};
  if (plan.inline) defs.push({ key: 'inline', name: 'inline', schema: plan.inline.schema, prompt: plan.inline.prompt });
  for (const id of plan.outputIds) {
    const found = stored.find((s) => s.id === id);
    if (!found || found.deleted_at) skippedOutputs[id] = { name: found?.name ?? id, status: 'skipped', error: 'This structured output was deleted' };
    else defs.push({ key: id, name: found.name, schema: found.schema, prompt: found.prompt ?? undefined });
  }
  const pendingDefs = defs.filter((d) => !outputDone(d.key));
  const newSkips = Object.entries(skippedOutputs).filter(([key]) => !outputDone(key));
  const pendingSummary = plan.summary && !done('summary');
  const pendingSuccess = !!plan.success && !done('success');
  if (!pendingSummary && !pendingSuccess && !pendingDefs.length && !newSkips.length) return { kind: 'done' };

  const logger = engineLogger(log);
  let chain: ProviderChain<LanguageModel>;
  try {
    // Only the model is needed: analysis never touches the call's STT or TTS
    const config = parseAssistantConfig(toEngineInput(call.config, { name: call.assistant_name, firstMessage: '', systemPrompt: '' }), ctx.voice.registry);
    chain = await ctx.voice.modelForCall(config, orgId, logger);
  } catch (error) {
    const message = error instanceof ProviderResolutionError ? error.message : `Could not set up the analysis model: ${error instanceof Error ? error.message : String(error)}`;
    return { kind: 'retry', error: message.slice(0, 900) };
  }

  const facts = { assistantName: call.assistant_name, endReason: call.end_reason, durationSeconds: call.duration_ms === null ? null : Math.round(call.duration_ms / 1000), direction: call.direction };
  const block = callBlock(facts, transcriptForModel(transcript, call.started_at, limits.maxTranscriptChars));

  /** One model request: usage is recorded even when it fails. */
  const ask = async (step: string, messages: ChatMessage[], maxTokens: number): Promise<string> => {
    const meter = new UsageMeter();
    const model = new ModelChain(chain, { component: 'model', callId, logger, meter, retries: 1 }, { firstTokenTimeoutMs: FIRST_TOKEN_TIMEOUT_MS, idleTimeoutMs: IDLE_TIMEOUT_MS });
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), ASK_TIMEOUT_MS);
    let text = '';
    try {
      for await (const event of model.stream({ systemPrompt: SYSTEM_PROMPT, messages, tools: [], temperature: 0, maxTokens }, controller.signal)) if (event.type === 'text') text += event.text;
      if (controller.signal.aborted) throw new Error(`the model did not answer within ${ASK_TIMEOUT_MS / 1000} seconds`);
      return text;
    } catch (error) {
      throw new StepFailed(`${step}: ${error instanceof Error ? error.message : String(error)}`.slice(0, 900));
    } finally {
      clearTimeout(timer);
      const records = meter.snapshot();
      const input = records.reduce((n, r) => n + (r.units.inputTokens ?? 0), 0);
      const output = records.reduce((n, r) => n + (r.units.outputTokens ?? 0), 0);
      const requests = records.reduce((n, r) => n + (r.units.requests ?? 0), 0);
      usage.inputTokens += input;
      usage.outputTokens += output;
      usage.requests += requests;
      const bucket = usage.steps![step] ?? { inputTokens: 0, outputTokens: 0, requests: 0 };
      usage.steps![step] = { inputTokens: bucket.inputTokens + input, outputTokens: bucket.outputTokens + output, requests: bucket.requests + requests };
      await ctx.tenants.withOrg(orgId, async (tx) => {
        for (const record of records) {
          const inTokens = record.units.inputTokens ?? 0;
          const outTokens = record.units.outputTokens ?? 0;
          if (!inTokens && !outTokens) continue;
          await tx.query(
            `INSERT INTO usage_record (id, org_id, subject_type, subject_id, channel, billing_unit, quantity, messages, input_tokens, output_tokens, tokens_estimated, provider, model, billing)
             VALUES ($1, $2, 'call', $3, 'analysis', 'token', $4, 0, $5, $6, $7, $8, $9, $10)`,
            [newId(), orgId, callId, inTokens + outTokens, inTokens, outTokens, record.estimated, record.provider, record.model, record.billing]
          );
        }
        await tx.query('UPDATE call_analysis SET usage = $3::jsonb, updated_at = now() WHERE org_id = $1 AND id = $2', [orgId, analysisId, JSON.stringify(usage)]);
      }).catch((err: unknown) => log.error({ err, call_id: callId }, 'could not record analysis usage'));
    }
  };

  /** A JSON object reply, checked by `check`; one corrective retry, then a final failure for the step. */
  const askForJson = async <T>(step: string, task: string, maxTokens: number, check: (value: Record<string, unknown>) => { ok: true; result: T } | { ok: false; errors: string[] }): Promise<{ ok: true; result: T } | { ok: false; error: string }> => {
    const first: ChatMessage = { role: 'user', content: `${block}\n\n${task}` };
    let reply = await ask(step, [first], maxTokens);
    let problems: string[] = [];
    for (let attempt = 0; attempt < 2; attempt++) {
      const parsed = parseJsonObject(reply);
      if (parsed.ok) {
        const checked = check(parsed.value);
        if (checked.ok) return checked;
        problems = checked.errors;
      } else {
        problems = [parsed.error];
      }
      if (attempt === 0) reply = await ask(step, [first, { role: 'assistant', content: reply.slice(0, 4000) }, { role: 'user', content: correctionTask(problems) }], maxTokens);
    }
    return { ok: false, error: `The model's answer did not validate after a retry: ${problems.join('; ')}`.slice(0, 900) };
  };

  const save = (fn: (tx: Queryable) => Promise<unknown>) => ctx.tenants.withOrg(orgId, async (tx) => void (await fn(tx)));

  try {
    if (pendingSummary) {
      const text = (await ask('summary', [{ role: 'user', content: `${block}\n\n${summaryTask(plan.summary ? call.config.analysis?.summary?.prompt : undefined)}` }], 1000)).trim().slice(0, MAX_SUMMARY_CHARS);
      await save((tx) =>
        tx.query(`UPDATE call_analysis SET summary = $3, steps = steps || $4::jsonb, updated_at = now() WHERE org_id = $1 AND id = $2`, [orgId, analysisId, text || null, JSON.stringify({ summary: text ? { status: 'succeeded' } : { status: 'failed', error: 'The model returned an empty summary' } })])
      );
    }
    if (pendingSuccess && plan.success) {
      const { rubric, categories, prompt } = plan.success;
      const result = await askForJson<SuccessResult>('success', successTask(rubric, categories, prompt), 600, (value) => parseSuccess(rubric, categories, value));
      await save((tx) =>
        result.ok
          ? tx.query(
              `UPDATE call_analysis SET success_rubric = $3, success_passed = $4, success_score = $5, success_category = $6, success_reason = $7, steps = steps || $8::jsonb, updated_at = now() WHERE org_id = $1 AND id = $2`,
              [orgId, analysisId, rubric, result.result.passed, result.result.score, result.result.category, result.result.reason, JSON.stringify({ success: { status: 'succeeded' } })]
            )
          : tx.query(`UPDATE call_analysis SET success_rubric = $3, steps = steps || $4::jsonb, updated_at = now() WHERE org_id = $1 AND id = $2`, [orgId, analysisId, rubric, JSON.stringify({ success: { status: 'failed', error: result.error } })])
      );
    }
    for (const def of pendingDefs) {
      const entry = await extract(def, askForJson);
      await save((tx) => tx.query(`UPDATE call_analysis SET outputs = outputs || $3::jsonb, updated_at = now() WHERE org_id = $1 AND id = $2`, [orgId, analysisId, JSON.stringify({ [def.key]: entry })]));
    }
    if (newSkips.length) await save((tx) => tx.query(`UPDATE call_analysis SET outputs = outputs || $3::jsonb, updated_at = now() WHERE org_id = $1 AND id = $2`, [orgId, analysisId, JSON.stringify(Object.fromEntries(newSkips))]));
  } catch (error) {
    if (error instanceof StepFailed) return { kind: 'retry', error: error.message };
    throw error;
  }
  return { kind: 'done' };
}

type AskForJson = <T>(step: string, task: string, maxTokens: number, check: (value: Record<string, unknown>) => { ok: true; result: T } | { ok: false; errors: string[] }) => Promise<{ ok: true; result: T } | { ok: false; error: string }>;

async function extract(def: OutputDef, askForJson: AskForJson): Promise<OutputResult> {
  // An inline schema was only shape-checked when the assistant was saved; check it fully now
  const problems = checkSchema(def.schema);
  if (problems.length) return { name: def.name, status: 'failed', error: `The schema cannot be used: ${problems.map((p) => p.message).join('; ')}`.slice(0, 900), schema: def.schema };
  const result = await askForJson<Record<string, unknown>>(`output:${def.key}`, extractionTask(def.name, def.schema, def.prompt), 2048, (value) => {
    const checked = validateAgainst(def.schema, value);
    return checked.ok ? { ok: true, result: value } : { ok: false, errors: checked.errors };
  });
  return result.ok ? { name: def.name, status: 'succeeded', values: result.result, schema: def.schema } : { name: def.name, status: 'failed', error: result.error, schema: def.schema };
}
