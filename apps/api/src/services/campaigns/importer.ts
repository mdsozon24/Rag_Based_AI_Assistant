/**
 * Uploading a contact list into a campaign: the CSV rules of contacts.ts plus what only the database
 * knows (numbers already in the campaign, numbers on the do-not-call list, the campaign's size limit).
 * Every rejected row is reported with its line number and reason; accepted rows are saved in one
 * transaction, so an upload either lands completely or not at all.
 */
import { z } from 'zod';
import { newId } from '../../auth/crypto.ts';
import type { Queryable } from '../../db/database.ts';
import { ApiError } from '../../http/errors.ts';
import { callConfig, resolveTarget, type CampaignRow } from './campaigns.ts';
import { CsvError, parseContactCsv, type RejectedRow } from './contacts.ts';
import { listedNumbers } from './dnc.ts';

export const importSchema = z
  .object({
    /** The file's text (UTF-8, comma separated, header in the first line). */
    csv: z.string().min(1).max(8_000_000),
    /** Which columns hold what. Without it: phone/number/mobile..., name, timezone; other columns become variables of the same name. */
    mapping: z
      .object({
        phone: z.string().max(100).optional(),
        name: z.string().max(100).optional(),
        timezone: z.string().max(100).optional(),
        /** {{variable}} name in the assistant -> CSV column. */
        variables: z.record(z.string().max(100)).optional(),
      })
      .strict()
      .optional(),
    /** Accept national numbers (BD: 01712345678) as this country's. Defaults to the campaign's. */
    defaultCountry: z.string().regex(/^[A-Z]{2}$/, 'Two-letter country code like BD').optional(),
    /** Validate and report only; save nothing. */
    dryRun: z.boolean().default(false),
  })
  .strict();

export type ImportBody = z.infer<typeof importSchema>;

export interface ImportReport {
  dryRun: boolean;
  /** Data rows in the file (blank lines excluded). */
  totalRows: number;
  imported: number;
  rejectedCount: number;
  rejected: RejectedRow[];
}

const BATCH = 200;

export async function importContacts(tx: Queryable, orgId: string, campaign: CampaignRow, body: ImportBody, limits: { maxUploadRows: number; maxContacts: number }): Promise<ImportReport> {
  if (campaign.status === 'completed' || campaign.status === 'cancelled') {
    throw new ApiError('conflict', `Contacts cannot be added to a ${campaign.status} campaign`, { status: campaign.status });
  }
  const target = await resolveTarget(tx, orgId, campaign, { requirePublished: false });
  const config = callConfig(target.config, campaign.disclosure_text);
  let parsed;
  try {
    parsed = parseContactCsv(body.csv, {
      mapping: body.mapping,
      defaultCountry: body.defaultCountry ?? campaign.default_country ?? undefined,
      defaultTimeZone: campaign.default_time_zone,
      requiredFields: { firstMessage: config.firstMessage, systemPrompt: config.systemPrompt },
      variableDefaults: config.variableDefaults,
      maxRows: limits.maxUploadRows,
    });
  } catch (err) {
    if (err instanceof CsvError) throw new ApiError('validation_error', 'The contact file cannot be used', { issues: [{ path: 'csv', message: err.message }] });
    throw err;
  }

  const rejected: RejectedRow[] = [...parsed.rejected];
  const numbers = parsed.contacts.map((c) => c.e164);
  const existing = new Set(
    numbers.length ? (await tx.query<{ e164: string }>('SELECT e164 FROM campaign_contact WHERE org_id = $1 AND campaign_id = $2 AND e164 = ANY ($3::text[])', [orgId, campaign.id, numbers])).rows.map((r) => r.e164) : []
  );
  const listed = await listedNumbers(tx, orgId, numbers);
  const accepted = parsed.contacts.filter((contact) => {
    if (existing.has(contact.e164)) rejected.push({ row: contact.rowNumber, value: contact.e164, reason: 'Already in this campaign' });
    else if (listed.has(contact.e164)) rejected.push({ row: contact.rowNumber, value: contact.e164, reason: 'On the do-not-call list' });
    else return true;
    return false;
  });

  const total = Number((await tx.query<{ n: string }>('SELECT count(*)::text AS n FROM campaign_contact WHERE org_id = $1 AND campaign_id = $2', [orgId, campaign.id])).rows[0].n);
  if (total + accepted.length > limits.maxContacts) {
    throw new ApiError('conflict', `A campaign holds at most ${limits.maxContacts} contacts (it has ${total}; this upload adds ${accepted.length})`, { reason: 'contact_limit' });
  }

  let imported = 0;
  if (!body.dryRun) {
    for (let i = 0; i < accepted.length; i += BATCH) {
      const batch = accepted.slice(i, i + BATCH);
      const params: unknown[] = [];
      const values = batch.map((c, index) => {
        const o = index * 8;
        params.push(newId(), orgId, campaign.id, c.e164, c.name, c.timeZone, JSON.stringify(c.variables), c.rowNumber);
        return `($${o + 1}, $${o + 2}, $${o + 3}, $${o + 4}, $${o + 5}, $${o + 6}, $${o + 7}::jsonb, $${o + 8})`;
      });
      const inserted = new Set(
        (await tx.query<{ e164: string }>(`INSERT INTO campaign_contact (id, org_id, campaign_id, e164, name, time_zone, variables, source_row) VALUES ${values.join(', ')} ON CONFLICT (campaign_id, e164) DO NOTHING RETURNING e164`, params)).rows.map((r) => r.e164)
      );
      for (const c of batch) {
        if (inserted.has(c.e164)) imported++;
        else rejected.push({ row: c.rowNumber, value: c.e164, reason: 'Already in this campaign' });
      }
    }
  } else {
    imported = accepted.length;
  }
  rejected.sort((a, b) => a.row - b.row);
  return { dryRun: body.dryRun, totalRows: parsed.totalRows, imported, rejectedCount: rejected.length, rejected };
}
