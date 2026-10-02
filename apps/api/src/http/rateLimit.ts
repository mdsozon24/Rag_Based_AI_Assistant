/**
 * Token-bucket rate limiting. In memory for now (one API node); the interface lets a Redis
 * implementation replace it when the API runs on several nodes.
 */

export interface RateDecision {
  allowed: boolean;
  limit: number;
  remaining: number;
  /** Seconds until a request would be allowed again (0 when allowed). */
  retryAfterSeconds: number;
}

export interface RateLimiter {
  /** Take one token from `key`'s bucket, which holds `limit` tokens refilled over `windowMs`. */
  consume(key: string, limit: number, windowMs: number): RateDecision;
}

interface Bucket {
  tokens: number;
  updatedAt: number;
  windowMs: number;
}

export class MemoryRateLimiter implements RateLimiter {
  private readonly buckets = new Map<string, Bucket>();
  private lastSweep = 0;

  constructor(private readonly now: () => number = Date.now) {}

  consume(key: string, limit: number, windowMs: number): RateDecision {
    const now = this.now();
    this.sweep(now);
    const ratePerMs = limit / windowMs;
    let bucket = this.buckets.get(key);
    if (!bucket) {
      bucket = { tokens: limit, updatedAt: now, windowMs };
      this.buckets.set(key, bucket);
    } else {
      bucket.tokens = Math.min(limit, bucket.tokens + (now - bucket.updatedAt) * ratePerMs);
      bucket.updatedAt = now;
      bucket.windowMs = windowMs;
    }
    if (bucket.tokens >= 1) {
      bucket.tokens -= 1;
      return { allowed: true, limit, remaining: Math.floor(bucket.tokens), retryAfterSeconds: 0 };
    }
    const retryAfterSeconds = Math.max(1, Math.ceil((1 - bucket.tokens) / ratePerMs / 1000));
    return { allowed: false, limit, remaining: 0, retryAfterSeconds };
  }

  /** Drop buckets that have refilled completely (they behave like new ones). */
  private sweep(now: number): void {
    if (now - this.lastSweep < 60_000) return;
    this.lastSweep = now;
    for (const [key, bucket] of this.buckets) if (now - bucket.updatedAt > bucket.windowMs) this.buckets.delete(key);
  }
}
