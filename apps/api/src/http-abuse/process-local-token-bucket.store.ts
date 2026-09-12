import { Inject, Injectable, OnModuleDestroy } from '@nestjs/common';
import {
  HTTP_RATE_LIMIT_CONFIG,
  HTTP_RATE_LIMIT_POLICIES,
  MONOTONIC_CLOCK,
  type HttpRateLimitConfiguration,
  type HttpRateLimitPolicy,
  type MonotonicClock,
} from './http-abuse.types';

type Bucket = {
  tokens: number;
  lastRefillMonotonic: number;
  lastSeenMonotonic: number;
};

export type TokenConsumeResult =
  | Readonly<{ allowed: true }>
  | Readonly<{
      allowed: false;
      reason: 'token_exhausted' | 'key_capacity';
      retryAfterSeconds?: number;
    }>;

@Injectable()
export class ProcessLocalTokenBucketStore implements OnModuleDestroy {
  private readonly buckets = new Map<HttpRateLimitPolicy, Map<string, Bucket>>();
  private readonly sweepIterators = new Map<
    HttpRateLimitPolicy,
    IterableIterator<[string, Bucket]>
  >();
  private readonly cleanupTimer: NodeJS.Timeout;
  private sweepPolicyIndex = 0;

  constructor(
    @Inject(HTTP_RATE_LIMIT_CONFIG) private readonly config: HttpRateLimitConfiguration,
    @Inject(MONOTONIC_CLOCK) private readonly clock: MonotonicClock,
  ) {
    for (const policy of HTTP_RATE_LIMIT_POLICIES) this.buckets.set(policy, new Map());
    this.cleanupTimer = setInterval(() => this.sweepExpired(), config.sweepIntervalMs);
    this.cleanupTimer.unref();
  }

  consume(policy: HttpRateLimitPolicy, key: string): TokenConsumeResult {
    const now = this.clock.now();
    this.sweepExpired(now);
    const policyConfig = this.config.policies[policy];
    const policyBuckets = this.buckets.get(policy);
    if (!policyBuckets) throw new Error('Unknown HTTP rate-limit policy');

    let bucket = policyBuckets.get(key);
    if (!bucket) {
      if (policyBuckets.size >= policyConfig.maxKeys) {
        return { allowed: false, reason: 'key_capacity' };
      }
      bucket = {
        tokens: policyConfig.capacity,
        lastRefillMonotonic: now,
        lastSeenMonotonic: now,
      };
      policyBuckets.set(key, bucket);
    }

    const elapsedMs = Math.max(0, now - bucket.lastRefillMonotonic);
    bucket.tokens = Math.min(
      policyConfig.capacity,
      bucket.tokens + (elapsedMs / 1_000) * policyConfig.refillTokensPerSecond,
    );
    bucket.lastRefillMonotonic = now;
    bucket.lastSeenMonotonic = now;
    if (bucket.tokens >= 1) {
      bucket.tokens -= 1;
      return { allowed: true };
    }

    const waitSeconds = (1 - bucket.tokens) / policyConfig.refillTokensPerSecond;
    return {
      allowed: false,
      reason: 'token_exhausted',
      retryAfterSeconds: Math.min(
        this.config.retryAfterMaximumSeconds,
        Math.max(1, Math.ceil(waitSeconds)),
      ),
    };
  }

  size(policy: HttpRateLimitPolicy): number {
    return this.buckets.get(policy)?.size ?? 0;
  }

  sweepExpired(now = this.clock.now()): void {
    const policy = HTTP_RATE_LIMIT_POLICIES[
      this.sweepPolicyIndex % HTTP_RATE_LIMIT_POLICIES.length
    ] as HttpRateLimitPolicy;
    this.sweepPolicyIndex = (this.sweepPolicyIndex + 1) % HTTP_RATE_LIMIT_POLICIES.length;
    const policyBuckets = this.buckets.get(policy);
    if (!policyBuckets) return;
    const policyConfig = this.config.policies[policy];
    let iterator = this.sweepIterators.get(policy);
    if (!iterator) {
      iterator = policyBuckets.entries();
      this.sweepIterators.set(policy, iterator);
    }
    let inspected = 0;
    while (inspected < this.config.sweepBatchSize) {
      const next = iterator.next();
      if (next.done) {
        this.sweepIterators.delete(policy);
        break;
      }
      const [key, bucket] = next.value;
      inspected += 1;
      const elapsedMs = Math.max(0, now - bucket.lastRefillMonotonic);
      const availableTokens = Math.min(
        policyConfig.capacity,
        bucket.tokens + (elapsedMs / 1_000) * policyConfig.refillTokensPerSecond,
      );
      if (
        now - bucket.lastSeenMonotonic >= this.config.keyTtlMs &&
        availableTokens >= policyConfig.capacity
      ) {
        policyBuckets.delete(key);
      }
    }
  }

  onModuleDestroy(): void {
    clearInterval(this.cleanupTimer);
    this.sweepIterators.clear();
    for (const bucket of this.buckets.values()) bucket.clear();
  }
}
