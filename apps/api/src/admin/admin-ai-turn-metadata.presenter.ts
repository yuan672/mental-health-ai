import {
  adminAiTurnMetadataSchema,
  storedAdminAiTurnMetadataSchema,
  type AdminAiTurnFailureCategory,
  type AdminAiTurnMetadata,
  type AdminAiTurnStatus,
  type StoredAdminAiTurnMetadata,
} from './admin-ai-turn-metadata.schemas';

const PROMPT_KEY_PATTERN = /^[a-z0-9][a-z0-9._-]*$/u;
const PROMPT_VERSION_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/u;

const FAILURE_CATEGORIES = {
  QUOTA_EXCEEDED: 'quota_exhausted',
  AI_TURN_IN_PROGRESS: 'concurrency_conflict',
  STALE_TURN: 'stale_recovery',
  CANCELLED_BEFORE_PROVIDER: 'cancelled_before_dispatch',
  CLIENT_CANCELLED: 'cancelled',
  EXECUTION_CANCELLED: 'cancelled',
  STREAM_DELIVERY_TERMINATED: 'cancelled',
  TOTAL_TIMEOUT_BEFORE_PROVIDER: 'timeout_before_dispatch',
  TIMEOUT: 'timeout',
  RATE_LIMITED: 'provider_rate_limited',
  AUTHENTICATION: 'provider_authentication',
  UPSTREAM: 'provider_unavailable',
  NETWORK: 'provider_unavailable',
  ABORTED: 'provider_unavailable',
  UNCONFIGURED: 'provider_unavailable',
  MALFORMED_STREAM: 'provider_malformed',
  MALFORMED_RESPONSE: 'provider_malformed',
  PREPARATION_FAILED: 'preparation',
  SAFETY: 'safety',
  PERSISTENCE: 'persistence',
  TRUSTED_SAFETY_PERSISTENCE_FAILED: 'persistence',
  SAFETY_RESPONSE_PERSISTENCE_FAILED: 'persistence',
  INTERNAL: 'internal',
} as const satisfies Readonly<Record<string, AdminAiTurnFailureCategory>>;

const ACTIVE_STATUSES = new Set<AdminAiTurnStatus>(['claimed', 'streaming']);
const FAILURE_STATUSES = new Set<AdminAiTurnStatus>(['failed', 'cancelled']);

export function presentAdminAiTurnMetadata(
  input: StoredAdminAiTurnMetadata,
  observedAt: Date,
): AdminAiTurnMetadata {
  const row = storedAdminAiTurnMetadataSchema.parse(input);
  const active = ACTIVE_STATUSES.has(row.status);
  const validTerminal =
    !active && row.completedAt !== null && row.completedAt.getTime() >= row.startedAt.getTime();

  return adminAiTurnMetadataSchema.parse({
    turnId: row.id,
    status: row.status,
    promptIdentity:
      row.promptKey.length >= 1 &&
      PROMPT_KEY_PATTERN.test(row.promptKey) &&
      row.promptVersion.length >= 1 &&
      PROMPT_VERSION_PATTERN.test(row.promptVersion)
        ? { availability: 'available', key: row.promptKey, version: row.promptVersion }
        : { availability: 'unavailable' },
    failureCategory: failureCategory(row.status, row.failureCode),
    lifecycleStartedAt: row.startedAt.toISOString(),
    terminalAt: validTerminal ? row.completedAt!.toISOString() : null,
    lifecycleDurationMs: validTerminal
      ? row.completedAt!.getTime() - row.startedAt.getTime()
      : null,
    leaseState: active
      ? row.leaseExpiresAt.getTime() > observedAt.getTime()
        ? 'valid'
        : 'expired'
      : 'not_applicable',
  });
}

function failureCategory(
  status: AdminAiTurnStatus,
  failureCode: string | null,
): AdminAiTurnFailureCategory | null {
  if (!FAILURE_STATUSES.has(status)) {
    return failureCode === null ? null : 'unknown';
  }
  if (failureCode === null) return 'unknown';
  return FAILURE_CATEGORIES[failureCode as keyof typeof FAILURE_CATEGORIES] ?? 'unknown';
}
