/**
 * The engine's campaign hooks for one call (opt-out detection and outcome reporting), backed by the
 * database. Whatever runs a CallSession for a call row (today the browser gateway, later the Phase 8
 * telephony media gateway) passes `await campaignHooksForCall(ctx, orgId, callId)` as the session's
 * `campaign` option; it is null for calls that do not belong to a campaign.
 *
 * Opt-outs are saved before the call ends (the engine awaits onOptOut), so a person who says "stop
 * calling me" is on the do-not-call list even if the line drops a moment later.
 */
import type { FastifyBaseLogger } from 'fastify';
import { DEFAULT_OPT_OUT_MESSAGE, DEFAULT_OPT_OUT_PHRASES, type CampaignHooks } from '../../../../../packages/engine/src/engine/campaign.ts';
import type { AppContext } from '../../context.ts';
import { addToDnc } from './dnc.ts';

export async function campaignHooksForCall(ctx: AppContext, orgId: string, callId: string, log: FastifyBaseLogger): Promise<CampaignHooks | null> {
  const row = (
    await ctx.tenants.withOrg(orgId, async (tx) =>
      (
        await tx.query<{ campaign_id: string; contact_id: string; e164: string; opt_out_phrases: string[]; opt_out_message: string | null; outcome_labels: string[] }>(
          `SELECT c.campaign_id, c.campaign_contact_id AS contact_id, k.e164, p.opt_out_phrases, p.opt_out_message, p.outcome_labels
           FROM call c
           JOIN campaign_contact k ON k.id = c.campaign_contact_id AND k.org_id = c.org_id
           JOIN campaign p ON p.id = c.campaign_id AND p.org_id = c.org_id
           WHERE c.org_id = $1 AND c.id = $2`,
          [orgId, callId]
        )
      ).rows[0]
    )
  ) ?? null;
  if (!row) return null;
  const callLog = log.child({ org_id: orgId, call_id: callId, campaign_id: row.campaign_id, contact_id: row.contact_id });
  return {
    optOutPhrases: [...DEFAULT_OPT_OUT_PHRASES, ...row.opt_out_phrases],
    optOutMessage: row.opt_out_message ?? DEFAULT_OPT_OUT_MESSAGE,
    outcomeLabels: row.outcome_labels,
    async onOptOut(info) {
      await ctx.tenants.withOrg(orgId, async (tx) => {
        const added = await addToDnc(tx, orgId, row.e164, {
          source: 'opt-out',
          reason: info.source === 'phrase' ? `Said "${info.phrase ?? info.text}" during the call` : 'Asked not to be called again (assistant tool)',
          campaignId: row.campaign_id,
          callId,
          actor: { type: 'system', id: null },
        });
        // This call's own contact is mid-call (not pending), so close it explicitly
        await tx.query(`UPDATE campaign_contact SET status = 'do_not_call', next_attempt_at = NULL, updated_at = now() WHERE org_id = $1 AND id = $2 AND status IN ('pending', 'calling')`, [orgId, row.contact_id]);
        callLog.info({ source: info.source, newly_listed: added }, 'opt-out recorded; number added to the do-not-call list');
      });
    },
    async onOutcome(outcome) {
      await ctx.tenants.withOrg(orgId, (tx) =>
        tx.query('UPDATE campaign_contact SET outcome_label = $3, outcome_notes = $4, updated_at = now() WHERE org_id = $1 AND id = $2', [orgId, row.contact_id, outcome.label, outcome.notes?.slice(0, 1000) ?? null])
      );
      callLog.info({ label: outcome.label }, 'campaign outcome reported');
    },
  };
}
