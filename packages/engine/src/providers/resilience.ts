/**
 * Timeouts and safe retries for provider calls.
 *
 * Streams are retried only if they failed before yielding anything: once audio has been played or
 * text spoken, a retry would repeat it, so a mid-stream failure is reported to the caller instead.
 */
import type { Logger } from '../logger.ts';
import type { ProviderStage } from '../engine/endReason.ts';
import { ProviderError } from './types.ts';

export class TimeoutError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TimeoutError';
  }
}

export function isAbortError(error: unknown): boolean {
  return error instanceof Error && (error.name === 'AbortError' || (error as { code?: string }).code === 'ABORT_ERR');
}

/** Non-retryable failures: wrong key, no credit, rejected request. */
export function isFatalProviderError(error: unknown): boolean {
  if (error instanceof ProviderError) return !error.retryable;
  const text = error instanceof Error ? error.message : String(error);
  return /\b(401|402|403)\b|unauthori[sz]ed|invalid api key|api key not valid|quota|billing|permission denied/i.test(text);
}

export function toProviderError(error: unknown, stage: ProviderStage, provider: string): ProviderError {
  if (error instanceof ProviderError) return error;
  if (error instanceof TimeoutError) return new ProviderError(error.message, stage, provider, { code: 'timeout', cause: error });
  const message = error instanceof Error ? error.message : String(error);
  return new ProviderError(message, stage, provider, { retryable: !isFatalProviderError(error), cause: error });
}

/** Reject with TimeoutError if `promise` does not settle within `ms`. */
export async function withTimeout<T>(promise: Promise<T>, ms: number, what: string, onTimeout?: () => void): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          onTimeout?.();
          reject(new TimeoutError(`${what} timed out after ${ms} ms`));
        }, ms);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** An AbortController that also aborts when `parent` aborts. */
export function linkedController(parent: AbortSignal): { controller: AbortController; dispose: () => void } {
  const controller = new AbortController();
  const onAbort = () => controller.abort(parent.reason);
  if (parent.aborted) controller.abort(parent.reason);
  else parent.addEventListener('abort', onAbort, { once: true });
  return { controller, dispose: () => parent.removeEventListener('abort', onAbort) };
}

export interface StreamRetryOptions {
  stage: ProviderStage;
  provider: string;
  logger: Logger;
  /** Cancels the whole operation (turn interrupted, call ended). Aborting ends the stream quietly. */
  signal: AbortSignal;
  firstChunkTimeoutMs: number;
  idleTimeoutMs: number;
  /** Extra attempts when the stream fails before producing anything. */
  retries?: number;
  retryDelayMs?: number;
  /** Called with each attempt number (0-based) when it starts. */
  onAttempt?: (attempt: number) => void;
}

/**
 * Iterate a provider stream with first-chunk and idle timeouts, retrying `retries` times while
 * nothing has been yielded yet. Throws ProviderError on failure; returns quietly on abort.
 */
export async function* streamWithRetry<T>(open: (signal: AbortSignal) => AsyncIterable<T>, options: StreamRetryOptions): AsyncGenerator<T> {
  const retries = options.retries ?? 1;
  const { logger, stage, provider, signal } = options;
  for (let attempt = 0; ; attempt++) {
    if (signal.aborted) return;
    options.onAttempt?.(attempt);
    const { controller, dispose } = linkedController(signal);
    const iterator = open(controller.signal)[Symbol.asyncIterator]();
    let yielded = false;
    const startedAt = Date.now();
    try {
      for (;;) {
        const timeoutMs = yielded ? options.idleTimeoutMs : options.firstChunkTimeoutMs;
        const label = yielded ? `${provider} ${stage} stream stalled` : `${provider} ${stage} first chunk`;
        const result = await withTimeout(iterator.next(), timeoutMs, label, () => controller.abort(new TimeoutError(label)));
        if (result.done) return;
        if (signal.aborted) return;
        if (!yielded) logger.debug({ stage, provider, attempt, first_chunk_ms: Date.now() - startedAt }, 'provider first chunk');
        yielded = true;
        yield result.value;
      }
    } catch (error) {
      if (signal.aborted) return;
      const providerError = toProviderError(error, stage, provider);
      const canRetry = !yielded && attempt < retries && providerError.retryable;
      logger.warn(
        { stage, provider, attempt, err: providerError, code: providerError.code, retrying: canRetry, after_output: yielded },
        canRetry ? 'provider stream failed, retrying' : 'provider stream failed'
      );
      if (!canRetry) throw providerError;
      const delay = options.retryDelayMs ?? 100;
      if (delay > 0) await new Promise((resolve) => setTimeout(resolve, delay));
    } finally {
      dispose();
      if (!controller.signal.aborted) controller.abort();
      // Do not await: a stuck provider must not block cleanup
      void Promise.resolve(iterator.return?.()).catch(() => {});
    }
  }
}
