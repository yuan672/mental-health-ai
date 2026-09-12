import { performance } from 'node:perf_hooks';
import { env } from '../config/env';
import type {
  HttpRateLimitConfiguration,
  HttpRateLimitPolicy,
  MonotonicClock,
  TokenBucketPolicy,
} from './http-abuse.types';

const BASE_POLICIES: Readonly<Record<HttpRateLimitPolicy, Omit<TokenBucketPolicy, 'maxKeys'>>> = {
  network_standard: { capacity: 60, refillTokensPerSecond: 2 },
  network_control: { capacity: 20, refillTokensPerSecond: 1 / 3 },
  network_mixed_probe: { capacity: 20, refillTokensPerSecond: 1 / 3 },
  public_read: { capacity: 30, refillTokensPerSecond: 1 },
  user_credential: { capacity: 5, refillTokensPerSecond: 1 / 30 },
  registration: { capacity: 3, refillTokensPerSecond: 1 / 60 },
  staff_credential: { capacity: 3, refillTokensPerSecond: 1 / 60 },
  classification_probe: { capacity: 12, refillTokensPerSecond: 1 / 3 },
  principal_general: { capacity: 60, refillTokensPerSecond: 1 },
  ai_new_work: { capacity: 2, refillTokensPerSecond: 1 / 15 },
  staff_sensitive: { capacity: 30, refillTokensPerSecond: 1 / 2 },
  control_recovery: { capacity: 20, refillTokensPerSecond: 1 / 3 },
};

export function httpRateLimitConfiguration(): HttpRateLimitConfiguration {
  const entries = Object.entries(BASE_POLICIES).map(([policy, value]) => [
    policy,
    {
      capacity: value.capacity * env.HTTP_RATE_LIMIT_CAPACITY_SCALE,
      refillTokensPerSecond: value.refillTokensPerSecond * env.HTTP_RATE_LIMIT_CAPACITY_SCALE,
      maxKeys: env.HTTP_RATE_LIMIT_MAX_KEYS_PER_POLICY,
    },
  ]);
  return {
    policies: Object.fromEntries(entries) as Record<HttpRateLimitPolicy, TokenBucketPolicy>,
    keyTtlMs: env.HTTP_RATE_LIMIT_KEY_TTL_SECONDS * 1_000,
    sweepIntervalMs: env.HTTP_RATE_LIMIT_SWEEP_INTERVAL_SECONDS * 1_000,
    sweepBatchSize: 64,
    retryAfterMaximumSeconds: 3_600,
    credentialMaxConcurrency: env.HTTP_CREDENTIAL_MAX_CONCURRENCY,
    credentialOperationTimeoutMs: env.HTTP_CREDENTIAL_OPERATION_TIMEOUT_MS,
  };
}

export const monotonicClock: MonotonicClock = {
  now: () => performance.now(),
};
