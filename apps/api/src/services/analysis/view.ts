/**
 * How an analysis row looks in the API and in the end-of-call-report webhook.
 */
import { iso } from '../../http/validation.ts';
import type { OutputResult } from './analyzer.ts';

export interface AnalysisFullRow {
  id: string;
  call_id: string;
  status: 'pending' | 'running' | 'succeeded' | 'failed' | 'skipped';
  skip_reason: string | null;
  attempts: number;
  next_attempt_at: Date;
  last_error: string | null;
  summary: string | null;
  success_rubric: string | null;
  success_passed: boolean | null;
  success_score: number | null;
  success_category: string | null;
  success_reason: string | null;
  steps: Record<string, { status: string; error?: string }>;
  outputs: Record<string, OutputResult>;
  usage: { inputTokens?: number; outputTokens?: number; requests?: number; steps?: Record<string, unknown> };
  analysed_at: Date | null;
  report_enqueued_at: Date | null;
  created_at: Date;
  updated_at: Date;
}

export const ANALYSIS_COLUMNS =
  'id, call_id, status, skip_reason, attempts, next_attempt_at, last_error, summary, success_rubric, success_passed, success_score, success_category, success_reason, steps, outputs, usage, analysed_at, report_enqueued_at, created_at, updated_at';

export function analysisView(row: AnalysisFullRow | null | undefined) {
  if (!row) return null;
  const success = row.success_rubric
    ? { rubric: row.success_rubric, passed: row.success_passed, score: row.success_score, category: row.success_category, reason: row.success_reason, ...(row.steps.success?.status === 'failed' ? { error: row.steps.success.error ?? 'failed' } : {}) }
    : null;
  return {
    status: row.status,
    skipReason: row.skip_reason,
    attempts: row.attempts,
    error: row.last_error,
    summary: row.summary,
    ...(row.steps.summary?.status === 'failed' ? { summaryError: row.steps.summary.error ?? 'failed' } : {}),
    successEvaluation: success,
    structuredOutputs: Object.entries(row.outputs).map(([key, out]) => ({
      id: key === 'inline' ? null : key,
      name: out.name,
      status: out.status,
      values: out.values ?? null,
      error: out.error ?? null,
    })),
    usage: { inputTokens: row.usage.inputTokens ?? 0, outputTokens: row.usage.outputTokens ?? 0, requests: row.usage.requests ?? 0 },
    analysedAt: iso(row.analysed_at),
    nextAttemptAt: row.status === 'pending' ? iso(row.next_attempt_at) : null,
  };
}
