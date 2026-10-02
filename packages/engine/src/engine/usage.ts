/**
 * Per-call provider usage for billing: which provider/model actually ran for each component, whose
 * key paid for it, and the units consumed. Persisted as usage records in the billing phase; for now
 * part of the call summary and the "call ended" log line.
 */
import type { ComponentKind } from '../providers/types.ts';

export type CredentialSourceOrNone = 'org' | 'platform' | 'none';

export interface UsageUnits {
  /** Transcriber: seconds of audio streamed to the provider. */
  audioSeconds: number;
  /** Model: prompt tokens. */
  inputTokens: number;
  /** Model: completion tokens. */
  outputTokens: number;
  /** Voice: characters sent for synthesis (requests that produced audio). */
  characters: number;
  /** Voice: seconds of audio received. */
  audioSecondsOut: number;
  /** Provider requests / sessions made. */
  requests: number;
}

export interface UsageRecord {
  component: ComponentKind;
  provider: string;
  model: string;
  credentialSource: CredentialSourceOrNone;
  credentialId?: string;
  /** "platform": billed to the platform's own key (platform-billed); "customer": org key or custom endpoint. */
  billing: 'platform' | 'customer';
  /** True when this provider was a fallback (not the component's primary). */
  fallback: boolean;
  units: Partial<UsageUnits>;
  /** Token counts were estimated (provider reported none, e.g. the stream was interrupted). */
  estimated: boolean;
}

export interface MeteredProvider {
  component: ComponentKind;
  provider: string;
  model: string;
  credentialSource: CredentialSourceOrNone;
  credentialId?: string;
  billing: 'platform' | 'customer';
  index: number;
}

const ROUND: Partial<Record<keyof UsageUnits, number>> = { audioSeconds: 100, audioSecondsOut: 100 };

export class UsageMeter {
  private readonly records = new Map<string, UsageRecord>();

  private record(entry: MeteredProvider): UsageRecord {
    const key = `${entry.component}|${entry.provider}|${entry.model}|${entry.credentialSource}|${entry.credentialId ?? ''}`;
    let record = this.records.get(key);
    if (!record) {
      record = {
        component: entry.component,
        provider: entry.provider,
        model: entry.model,
        credentialSource: entry.credentialSource,
        ...(entry.credentialId ? { credentialId: entry.credentialId } : {}),
        billing: entry.billing,
        fallback: entry.index > 0,
        units: {},
        estimated: false,
      };
      this.records.set(key, record);
    }
    return record;
  }

  add(entry: MeteredProvider, units: Partial<UsageUnits>, options: { estimated?: boolean } = {}): void {
    if (!Object.values(units).some((v) => v)) return;
    const record = this.record(entry);
    for (const [name, value] of Object.entries(units) as [keyof UsageUnits, number][]) {
      if (!value) continue;
      record.units[name] = (record.units[name] ?? 0) + value;
    }
    if (options.estimated) record.estimated = true;
  }

  /** Snapshot for the call summary. */
  snapshot(): UsageRecord[] {
    return [...this.records.values()].map((r) => {
      const units: Partial<UsageUnits> = {};
      for (const [name, value] of Object.entries(r.units) as [keyof UsageUnits, number][]) {
        const factor = ROUND[name];
        units[name] = factor ? Math.round(value * factor) / factor : value;
      }
      return { ...r, units };
    });
  }
}

/** Rough token estimate when a provider reports none (≈4 characters per token; flagged as estimated). */
export function estimateTokens(characters: number): number {
  return Math.ceil(characters / 4);
}
