export const HTTP_RATE_LIMIT_POLICIES = [
  'network_standard',
  'network_control',
  'network_mixed_probe',
  'public_read',
  'user_credential',
  'registration',
  'staff_credential',
  'classification_probe',
  'principal_general',
  'ai_new_work',
  'staff_sensitive',
  'control_recovery',
] as const;

export type HttpRateLimitPolicy = (typeof HTTP_RATE_LIMIT_POLICIES)[number];
export type HttpRateLimitIdentityKind = 'network' | 'user' | 'staff';
export type HttpRateLimitReason = 'token_exhausted' | 'key_capacity' | 'concurrency_capacity';

export type TokenBucketPolicy = Readonly<{
  capacity: number;
  refillTokensPerSecond: number;
  maxKeys: number;
}>;

export type HttpRateLimitConfiguration = Readonly<{
  policies: Readonly<Record<HttpRateLimitPolicy, TokenBucketPolicy>>;
  keyTtlMs: number;
  sweepIntervalMs: number;
  sweepBatchSize: number;
  retryAfterMaximumSeconds: number;
  credentialMaxConcurrency: number;
  credentialOperationTimeoutMs: number;
}>;

export const HTTP_RATE_LIMIT_CONFIG = Symbol('HTTP_RATE_LIMIT_CONFIG');
export const MONOTONIC_CLOCK = Symbol('MONOTONIC_CLOCK');

export interface MonotonicClock {
  now(): number;
}
