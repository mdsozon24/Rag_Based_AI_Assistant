/**
 * Campaigns: rows, views, input validation and the state machine (start, pause, resume, cancel).
 * Every function takes the org transaction and filters by org_id explicitly; row-level security is
 * the second layer.
 *
 * States: draft -> running <-> paused, and draft/running/paused -> cancelled. A running campaign becomes
 * completed on its own when no contact is left to call. Pausing stops new dials only; calls in progress
 * continue and their results are recorded. Cancelling also stops new dials and closes the pending contacts.
 */
import { z } from 'zod';
import type { AssistantSpec } from '../../../../../packages/engine/src/assistant/spec.ts';
import { newId } from '../../auth/crypto.ts';
import type { Queryable } from '../../db/database.ts';
import { ApiError } from '../../http/errors.ts';
import { iso } from '../../http/validation.ts';
import { getAssistant, getVersion } from '../assistants.ts';
import type { Actor } from '../audit.ts';
import { DEFAULT_HARD_CAP, effectiveWindow, isValidDate, isValidTimeZone, scheduleEnded, validateSchedule, type HardCap, type Schedule } from './schedule.ts';

export type CampaignStatus = 'draft' | 'running' | 'paused' | 'completed' | 'cancelled';

export interface CampaignRow {
  id: string;
  cursor_ts: string;
  org_id: string;
  name: string;
  status: CampaignStatus;
  status_reason: string | null;
  assistant_id: string | null;
  squad_id: string | null;
  start_date: string;
  end_date: string;
  allowed_days: number[];
  window_start: string;
  window_end: string;
  default_time_zone: string;
  default_country: string | null;
  max_concurrent_calls: number;
  calls_per_minute: number;
  max_retries: number;
  retry_delay_minutes: number;
  disclosure_text: string | null;
  opt_out_phrases: string[];
  opt_out_message: string | null;
  outcome_labels: string[];
  success_labels: string[];
  started_at: Date | null;
  completed_at: Date | null;
  created_at: Date;
  updated_at: Date;
  phone_number_ids: string[];
}

export const CAMPAIGN_SELECT = `
  SELECT c.id, c.created_at::text AS cursor_ts, c.org_id, c.name, c.status, c.status_reason, c.assistant_id, c.squad_id,
         c.start_date::text AS start_date, c.end_date::text AS end_date, c.allowed_days, c.window_start, c.window_end,
         c.default_time_zone, c.default_country::text AS default_country, c.max_concurrent_calls, c.calls_per_minute,
         c.max_retries, c.retry_delay_minutes, c.disclosure_text, c.opt_out_phrases, c.opt_out_message, c.outcome_labels,
         c.success_labels, c.started_at, c.completed_at, c.created_at, c.updated_at,
         coalesce((SELECT array_agg(p.phone_number_id::text ORDER BY p.position) FROM campaign_phone_number p
                   WHERE p.campaign_id = c.id AND p.org_id = c.org_id), '{}'::text[]) AS phone_number_ids
  FROM campaign c`;

export function campaignSchedule(row: CampaignRow): Schedule {
  return { startDate: row.start_date, endDate: row.end_date, allowedDays: row.allowed_days, windowStart: row.window_start, windowEnd: row.window_end };
}

export function campaignView(row: CampaignRow, cap: HardCap = DEFAULT_HARD_CAP) {
  const window = effectiveWindow({ windowStart: row.window_start, windowEnd: row.window_end }, cap);
  const pad = (minutes: number) => `${String(Math.floor(minutes / 60)).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')}`;
  return {
    id: row.id,
    name: row.name,
    status: row.status,
    statusReason: row.status_reason,
    assistantId: row.assistant_id,
    squadId: row.squad_id,
    phoneNumberIds: row.phone_number_ids,
    schedule: {
      startDate: row.start_date,
      endDate: row.end_date,
      allowedDays: row.allowed_days,
      windowStart: row.window_start,
      windowEnd: row.window_end,
      defaultTimeZone: row.default_time_zone,
      /** The hours calls can actually start, after the platform's calling-hours limit. */
      effectiveWindow: window ? { start: pad(window.start), end: pad(window.end) } : null,
    },
    maxConcurrentCalls: row.max_concurrent_calls,
    callsPerMinute: row.calls_per_minute,
    retry: { maxRetries: row.max_retries, delayMinutes: row.retry_delay_minutes },
    defaultCountry: row.default_country,
    disclosureText: row.disclosure_text,
    optOutPhrases: row.opt_out_phrases,
    optOutMessage: row.opt_out_message,
    outcomeLabels: row.outcome_labels,
    successLabels: row.success_labels,
    startedAt: iso(row.started_at),
    completedAt: iso(row.completed_at),
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
  };
}

// ---------------------------------------------------------------- input

const date = z.string().refine(isValidDate, 'Must be a date like 2026-10-05');
const hhmm = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'Use 24-hour HH:MM, like 09:00');
const zone = z.string().refine(isValidTimeZone, 'Use an IANA time zone name like Asia/Dhaka');
const label = z.string().trim().min(1).max(50);

export const scheduleSchema = z
  .object({
    startDate: date,
    endDate: date,
    allowedDays: z.array(z.number().int().min(1).max(7)).min(1).max(7),
    windowStart: hhmm,
    windowEnd: hhmm,
    /** For contacts whose zone is neither in the CSV nor implied by their country code. */
    defaultTimeZone: zone,
  })
  .strict();

const retrySchema = z
  .object({
    maxRetries: z.number().int().min(0).max(10).default(2),
    delayMinutes: z.number().int().min(1).max(10080).default(60),
  })
  .strict();

export const campaignSchema = z
  .object({
    name: z.string().trim().min(1).max(100),
    assistantId: z.string().uuid().optional(),
    squadId: z.string().uuid().optional(),
    phoneNumberIds: z.array(z.string().uuid()).min(1).max(20),
    schedule: scheduleSchema,
    maxConcurrentCalls: z.number().int().min(1).max(100),
    callsPerMinute: z.number().int().min(1).max(600),
    retry: retrySchema.default({}),
    defaultCountry: z.string().regex(/^[A-Z]{2}$/, 'Two-letter country code like BD').nullable().optional(),
    disclosureText: z.string().trim().min(1).max(500).nullable().optional(),
    optOutPhrases: z.array(z.string().trim().min(2).max(100)).max(50).default([]),
    optOutMessage: z.string().trim().min(1).max(300).nullable().optional(),
    outcomeLabels: z.array(label).max(30).default([]),
    successLabels: z.array(label).max(30).default([]),
  })
  .strict();

export type CampaignInput = z.infer<typeof campaignSchema>;

/** PATCH: any field, but the assistant or squad only while the campaign is a draft. */
export const campaignPatchSchema = z
  .object({
    name: campaignSchema.shape.name,
    assistantId: campaignSchema.shape.assistantId,
    squadId: campaignSchema.shape.squadId,
    phoneNumberIds: campaignSchema.shape.phoneNumberIds,
    schedule: scheduleSchema.partial(),
    maxConcurrentCalls: campaignSchema.shape.maxConcurrentCalls,
    callsPerMinute: campaignSchema.shape.callsPerMinute,
    retry: retrySchema.partial(),
    defaultCountry: campaignSchema.shape.defaultCountry,
    disclosureText: campaignSchema.shape.disclosureText,
    optOutPhrases: campaignSchema.shape.optOutPhrases,
    optOutMessage: campaignSchema.shape.optOutMessage,
    outcomeLabels: campaignSchema.shape.outcomeLabels,
    successLabels: campaignSchema.shape.successLabels,
  })
  .partial()
  .strict();

export function inputFromRow(row: CampaignRow): CampaignInput {
  return {
    name: row.name,
    ...(row.assistant_id ? { assistantId: row.assistant_id } : {}),
    ...(row.squad_id ? { squadId: row.squad_id } : {}),
    phoneNumberIds: row.phone_number_ids,
    schedule: { startDate: row.start_date, endDate: row.end_date, allowedDays: row.allowed_days, windowStart: row.window_start, windowEnd: row.window_end, defaultTimeZone: row.default_time_zone },
    maxConcurrentCalls: row.max_concurrent_calls,
    callsPerMinute: row.calls_per_minute,
    retry: { maxRetries: row.max_retries, delayMinutes: row.retry_delay_minutes },
    defaultCountry: row.default_country,
    disclosureText: row.disclosure_text,
    optOutPhrases: row.opt_out_phrases,
    optOutMessage: row.opt_out_message,
    outcomeLabels: row.outcome_labels,
    successLabels: row.success_labels,
  };
}

/** Rules that span fields. Throws a 400 listing every problem. */
export function assertValidInput(input: CampaignInput, cap: HardCap): void {
  const issues: { path: string; message: string }[] = [];
  if (!!input.assistantId === !!input.squadId) issues.push({ path: 'assistantId', message: 'Give exactly one of assistantId or squadId' });
  if (new Set(input.schedule.allowedDays).size !== input.schedule.allowedDays.length) issues.push({ path: 'schedule.allowedDays', message: 'Each weekday only once' });
  issues.push(...validateSchedule(input.schedule, cap));
  if (new Set(input.phoneNumberIds).size !== input.phoneNumberIds.length) issues.push({ path: 'phoneNumberIds', message: 'Each phone number only once' });
  const unknown = input.successLabels.filter((l) => !input.outcomeLabels.includes(l));
  if (unknown.length) issues.push({ path: 'successLabels', message: `Not in outcomeLabels: ${unknown.join(', ')}` });
  if (issues.length) throw new ApiError('validation_error', 'The request is invalid', { issues });
}

// ---------------------------------------------------------------- lookups

export async function getCampaign(tx: Queryable, orgId: string, id: string, options: { lock?: boolean } = {}): Promise<CampaignRow> {
  if (options.lock) {
    const locked = await tx.query('SELECT 1 FROM campaign WHERE org_id = $1 AND id = $2 FOR UPDATE', [orgId, id]);
    if (locked.rowCount === 0) throw new ApiError('not_found', 'Campaign not found');
  }
  const row = (await tx.query<CampaignRow>(`${CAMPAIGN_SELECT} WHERE c.org_id = $1 AND c.id = $2`, [orgId, id])).rows[0];
  if (!row) throw new ApiError('not_found', 'Campaign not found');
  return row;
}

export interface PhoneRow {
  id: string;
  provider: 'twilio' | 'telnyx' | 'vonage' | 'sip';
  provider_number_id: string;
  e164: string;
  capabilities: string[];
}

/** The campaign's numbers that can place calls now, in rotation order. */
export async function activeNumbers(tx: Queryable, orgId: string, campaignId: string): Promise<PhoneRow[]> {
  return (
    await tx.query<PhoneRow>(
      `SELECT pn.id, pn.provider, pn.provider_number_id, pn.e164, pn.capabilities
       FROM campaign_phone_number cpn
       JOIN phone_number pn ON pn.id = cpn.phone_number_id AND pn.org_id = cpn.org_id
       WHERE cpn.org_id = $1 AND cpn.campaign_id = $2 AND pn.status = 'active' AND 'voice' = ANY (pn.capabilities)
       ORDER BY cpn.position`,
      [orgId, campaignId]
    )
  ).rows;
}

export interface Target {
  assistantId: string;
  assistantName: string;
  squadId: string | null;
  /** The published version a call would pin; null while nothing is published. */
  versionId: string | null;
  /** The published config, or the draft when nothing is published yet (for validating variables). */
  config: AssistantSpec;
  configSchema: number;
}

/** The assistant a campaign call runs: its assistant, or the first member of its squad (as /v1/telephony/outbound does). */
export async function resolveTarget(tx: Queryable, orgId: string, campaign: Pick<CampaignRow, 'assistant_id' | 'squad_id'>, options: { requirePublished: boolean }): Promise<Target> {
  let assistantId = campaign.assistant_id;
  if (!assistantId && campaign.squad_id) {
    const member = (await tx.query<{ assistant_id: string | null }>('SELECT assistant_id FROM squad_member WHERE org_id = $1 AND squad_id = $2 ORDER BY position LIMIT 1', [orgId, campaign.squad_id])).rows[0];
    assistantId = member?.assistant_id ?? null;
    if (!assistantId) throw new ApiError('conflict', 'The squad needs a saved first assistant member to place campaign calls');
  }
  if (!assistantId) throw new ApiError('conflict', 'The campaign has no assistant or squad');
  const assistant = await getAssistant(tx, orgId, assistantId);
  if (!assistant.published_version) {
    if (options.requirePublished) throw new ApiError('conflict', 'The assistant has no published version; publish it before calling');
    return { assistantId, assistantName: assistant.name, squadId: campaign.squad_id, versionId: null, config: assistant.draft, configSchema: assistant.draft_schema };
  }
  const version = await getVersion(tx, orgId, assistantId, assistant.published_version);
  return { assistantId, assistantName: assistant.name, squadId: campaign.squad_id, versionId: version.id, config: version.config, configSchema: version.config_schema };
}

/** The config a campaign call pins: the assistant's, with the disclosure line spoken first when the campaign has one. */
export function callConfig(config: AssistantSpec, disclosureText: string | null): AssistantSpec {
  if (!disclosureText) return config;
  const first = config.firstMessage?.trim();
  return { ...config, firstMessage: first ? `${disclosureText} ${first}` : disclosureText, firstMessageMode: 'assistant-speaks-first' };
}

async function assertNumbersUsable(tx: Queryable, orgId: string, ids: string[]): Promise<void> {
  const found = (
    await tx.query<{ id: string; status: string; capabilities: string[] }>('SELECT id, status, capabilities FROM phone_number WHERE org_id = $1 AND id = ANY ($2::uuid[])', [orgId, ids])
  ).rows;
  const issues: { path: string; message: string }[] = [];
  ids.forEach((id, index) => {
    const row = found.find((r) => r.id === id);
    if (!row) issues.push({ path: `phoneNumberIds.${index}`, message: 'Phone number not found' });
    else if (row.status !== 'active') issues.push({ path: `phoneNumberIds.${index}`, message: 'This phone number was released' });
    else if (!row.capabilities.includes('voice')) issues.push({ path: `phoneNumberIds.${index}`, message: 'This phone number cannot place voice calls' });
  });
  if (issues.length) throw new ApiError('validation_error', 'The request is invalid', { issues });
}

// ---------------------------------------------------------------- create, update, delete

export async function createCampaign(tx: Queryable, orgId: string, actor: Actor, input: CampaignInput, cap: HardCap): Promise<CampaignRow> {
  assertValidInput(input, cap);
  await assertNumbersUsable(tx, orgId, input.phoneNumberIds);
  // The assistant or squad must exist in this org (404 otherwise)
  await resolveTarget(tx, orgId, { assistant_id: input.assistantId ?? null, squad_id: input.squadId ?? null }, { requirePublished: false });
  const id = newId();
  await tx.query(
    `INSERT INTO campaign (id, org_id, name, assistant_id, squad_id, start_date, end_date, allowed_days, window_start, window_end, default_time_zone,
       default_country, max_concurrent_calls, calls_per_minute, max_retries, retry_delay_minutes, disclosure_text, opt_out_phrases, opt_out_message,
       outcome_labels, success_labels, created_by_type, created_by_id)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23)`,
    [id, orgId, input.name, input.assistantId ?? null, input.squadId ?? null, input.schedule.startDate, input.schedule.endDate, input.schedule.allowedDays, input.schedule.windowStart,
      input.schedule.windowEnd, input.schedule.defaultTimeZone, input.defaultCountry ?? null, input.maxConcurrentCalls, input.callsPerMinute, input.retry.maxRetries, input.retry.delayMinutes,
      input.disclosureText ?? null, input.optOutPhrases, input.optOutMessage ?? null, input.outcomeLabels, input.successLabels, actor.type, actor.id]
  );
  await setNumbers(tx, orgId, id, input.phoneNumberIds);
  return getCampaign(tx, orgId, id);
}

async function setNumbers(tx: Queryable, orgId: string, campaignId: string, ids: string[]): Promise<void> {
  await tx.query('DELETE FROM campaign_phone_number WHERE org_id = $1 AND campaign_id = $2', [orgId, campaignId]);
  for (const [position, phoneNumberId] of ids.entries()) {
    await tx.query('INSERT INTO campaign_phone_number (org_id, campaign_id, phone_number_id, position) VALUES ($1, $2, $3, $4)', [orgId, campaignId, phoneNumberId, position]);
  }
}

export async function updateCampaign(tx: Queryable, orgId: string, id: string, patch: z.infer<typeof campaignPatchSchema>, cap: HardCap): Promise<CampaignRow> {
  const current = await getCampaign(tx, orgId, id, { lock: true });
  if (current.status !== 'draft' && current.status !== 'paused') {
    throw new ApiError('conflict', `A ${current.status} campaign cannot be edited; only draft and paused campaigns can`, { status: current.status });
  }
  if ((patch.assistantId !== undefined || patch.squadId !== undefined) && current.status !== 'draft') {
    throw new ApiError('conflict', 'The assistant or squad can only be changed while the campaign is a draft', { status: current.status });
  }
  const base = inputFromRow(current);
  const changesTarget = patch.assistantId !== undefined || patch.squadId !== undefined;
  const merged: CampaignInput = {
    ...base,
    ...(patch.name !== undefined ? { name: patch.name } : {}),
    ...(changesTarget ? { assistantId: patch.assistantId, squadId: patch.squadId } : {}),
    ...(patch.phoneNumberIds !== undefined ? { phoneNumberIds: patch.phoneNumberIds } : {}),
    schedule: { ...base.schedule, ...(patch.schedule ?? {}) },
    ...(patch.maxConcurrentCalls !== undefined ? { maxConcurrentCalls: patch.maxConcurrentCalls } : {}),
    ...(patch.callsPerMinute !== undefined ? { callsPerMinute: patch.callsPerMinute } : {}),
    retry: { ...base.retry, ...(patch.retry ?? {}) },
    ...(patch.defaultCountry !== undefined ? { defaultCountry: patch.defaultCountry } : {}),
    ...(patch.disclosureText !== undefined ? { disclosureText: patch.disclosureText } : {}),
    ...(patch.optOutPhrases !== undefined ? { optOutPhrases: patch.optOutPhrases } : {}),
    ...(patch.optOutMessage !== undefined ? { optOutMessage: patch.optOutMessage } : {}),
    ...(patch.outcomeLabels !== undefined ? { outcomeLabels: patch.outcomeLabels } : {}),
    ...(patch.successLabels !== undefined ? { successLabels: patch.successLabels } : {}),
  };
  assertValidInput(merged, cap);
  if (patch.phoneNumberIds !== undefined) await assertNumbersUsable(tx, orgId, merged.phoneNumberIds);
  if (changesTarget) await resolveTarget(tx, orgId, { assistant_id: merged.assistantId ?? null, squad_id: merged.squadId ?? null }, { requirePublished: false });
  await tx.query(
    `UPDATE campaign SET name=$3, assistant_id=$4, squad_id=$5, start_date=$6, end_date=$7, allowed_days=$8, window_start=$9, window_end=$10, default_time_zone=$11,
       default_country=$12, max_concurrent_calls=$13, calls_per_minute=$14, max_retries=$15, retry_delay_minutes=$16, disclosure_text=$17, opt_out_phrases=$18,
       opt_out_message=$19, outcome_labels=$20, success_labels=$21, updated_at=now()
     WHERE org_id=$1 AND id=$2`,
    [orgId, id, merged.name, merged.assistantId ?? null, merged.squadId ?? null, merged.schedule.startDate, merged.schedule.endDate, merged.schedule.allowedDays, merged.schedule.windowStart,
      merged.schedule.windowEnd, merged.schedule.defaultTimeZone, merged.defaultCountry ?? null, merged.maxConcurrentCalls, merged.callsPerMinute, merged.retry.maxRetries, merged.retry.delayMinutes,
      merged.disclosureText ?? null, merged.optOutPhrases, merged.optOutMessage ?? null, merged.outcomeLabels, merged.successLabels]
  );
  if (patch.phoneNumberIds !== undefined) await setNumbers(tx, orgId, id, merged.phoneNumberIds);
  return getCampaign(tx, orgId, id);
}

/** Only a draft campaign (never run) is deleted; anything that has run is kept for its results. */
export async function deleteCampaign(tx: Queryable, orgId: string, id: string): Promise<void> {
  const current = await getCampaign(tx, orgId, id, { lock: true });
  if (current.status !== 'draft') throw new ApiError('conflict', 'Only a draft campaign can be deleted; cancel a running one to keep its results', { status: current.status });
  await tx.query('DELETE FROM campaign WHERE org_id = $1 AND id = $2', [orgId, id]);
}

// ---------------------------------------------------------------- state machine

export type Control = 'start' | 'pause' | 'resume' | 'cancel';

const TRANSITIONS: Record<Control, { from: CampaignStatus[]; to: CampaignStatus }> = {
  start: { from: ['draft'], to: 'running' },
  pause: { from: ['running'], to: 'paused' },
  resume: { from: ['paused'], to: 'running' },
  cancel: { from: ['draft', 'running', 'paused'], to: 'cancelled' },
};

/** What must hold before dialing can begin (start) or begin again (resume). */
async function assertRunnable(tx: Queryable, orgId: string, campaign: CampaignRow, now: Date): Promise<void> {
  if (scheduleEnded(now, campaign.end_date)) throw new ApiError('conflict', `The schedule ended on ${campaign.end_date}; edit the dates first`, { reason: 'schedule_ended' });
  if (!(await activeNumbers(tx, orgId, campaign.id)).length) throw new ApiError('conflict', 'None of the campaign phone numbers can place calls (released or not voice-capable)', { reason: 'no_active_phone_number' });
  await resolveTarget(tx, orgId, campaign, { requirePublished: true });
  const pending = (await tx.query<{ n: string }>(`SELECT count(*)::text AS n FROM campaign_contact WHERE org_id = $1 AND campaign_id = $2 AND status = 'pending'`, [orgId, campaign.id])).rows[0];
  if (Number(pending.n) === 0) throw new ApiError('conflict', 'The campaign has no contacts left to call; upload a contact list first', { reason: 'no_contacts' });
}

export async function controlCampaign(tx: Queryable, orgId: string, id: string, control: Control, now: Date): Promise<CampaignRow> {
  const current = await getCampaign(tx, orgId, id, { lock: true });
  const rule = TRANSITIONS[control];
  if (!rule.from.includes(current.status)) {
    throw new ApiError('conflict', `Cannot ${control} a ${current.status} campaign`, { status: current.status, allowedFrom: rule.from });
  }
  if (control === 'start' || control === 'resume') await assertRunnable(tx, orgId, current, now);
  await tx.query(
    `UPDATE campaign SET status = $3, status_reason = NULL,
       started_at = CASE WHEN $4 THEN coalesce(started_at, $5::timestamptz) ELSE started_at END,
       completed_at = CASE WHEN $3 = 'cancelled' THEN $5::timestamptz ELSE completed_at END,
       updated_at = now()
     WHERE org_id = $1 AND id = $2`,
    [orgId, id, rule.to, control === 'start', now.toISOString()]
  );
  if (control === 'cancel') {
    // Calls already in flight finish; nobody else is called
    await tx.query(`UPDATE campaign_contact SET status = 'cancelled', next_attempt_at = NULL, updated_at = now() WHERE org_id = $1 AND campaign_id = $2 AND status = 'pending'`, [orgId, id]);
  }
  return getCampaign(tx, orgId, id);
}

/** The platform pausing a campaign (not a person): recorded with a reason for the dashboard. */
export async function pauseForReason(tx: Queryable, orgId: string, campaignId: string, reason: string): Promise<void> {
  await tx.query(`UPDATE campaign SET status = 'paused', status_reason = $3, updated_at = now() WHERE org_id = $1 AND id = $2 AND status = 'running'`, [orgId, campaignId, reason]);
}
