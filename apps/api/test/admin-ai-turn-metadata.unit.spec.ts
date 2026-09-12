import { randomUUID } from 'node:crypto';
import { presentAdminAiTurnMetadata } from '../src/admin/admin-ai-turn-metadata.presenter';
import {
  adminAiTurnMetadataCursorSchema,
  adminAiTurnMetadataQuerySchema,
  type AdminAiTurnStatus,
  type StoredAdminAiTurnMetadata,
} from '../src/admin/admin-ai-turn-metadata.schemas';
import { encodeOpaqueCursor } from '../src/common/pagination/opaque-cursor';

const STARTED_AT = new Date('2026-09-11T10:00:00.000Z');
const OBSERVED_AT = new Date('2026-09-11T10:00:05.000Z');

function storedRow(overrides: Partial<StoredAdminAiTurnMetadata> = {}): StoredAdminAiTurnMetadata {
  return {
    id: randomUUID(),
    status: 'failed' as const,
    promptKey: 'supportive-chat',
    promptVersion: '1',
    failureCode: 'NETWORK',
    leaseExpiresAt: new Date('2026-09-11T10:01:00.000Z'),
    createdAt: STARTED_AT,
    startedAt: STARTED_AT,
    completedAt: new Date('2026-09-11T10:00:04.000Z'),
    ...overrides,
  };
}

describe('Admin AI Turn metadata contracts', () => {
  it('parses only the bounded list query', () => {
    expect(adminAiTurnMetadataQuerySchema.parse({})).toEqual({ limit: 20 });
    expect(adminAiTurnMetadataQuerySchema.parse({ status: 'completed', limit: '50' })).toEqual({
      status: 'completed',
      limit: 50,
    });
    expect(() => adminAiTurnMetadataQuerySchema.parse({ status: 'unknown' })).toThrow();
    expect(() => adminAiTurnMetadataQuerySchema.parse({ limit: 51 })).toThrow();
    expect(() => adminAiTurnMetadataQuerySchema.parse({ extra: true })).toThrow();
    expect(() =>
      adminAiTurnMetadataQuerySchema.parse({ createdFrom: '2026-09-01T00:00:00.000Z' }),
    ).toThrow();
  });

  it('uses a strict compact cursor inside the shared bound', () => {
    const cursor = adminAiTurnMetadataCursorSchema.parse({
      k: 'aqt',
      v: 1,
      s: 'failed',
      f: '2026-08-12T10:00:00.000Z',
      b: '2026-09-12T10:00:00.000Z',
      m: 'e',
      t: '2026-09-11T10:00:00.000Z',
      i: randomUUID(),
    });
    expect(encodeOpaqueCursor(cursor).length).toBeLessThanOrEqual(512);
    expect(() => adminAiTurnMetadataCursorSchema.parse({ ...cursor, extra: true })).toThrow();
    expect(() =>
      adminAiTurnMetadataCursorSchema.parse({ ...cursor, t: '2026-09-12T10:00:00.000Z' }),
    ).toThrow();
  });

  it.each([
    ['QUOTA_EXCEEDED', 'quota_exhausted'],
    ['AI_TURN_IN_PROGRESS', 'concurrency_conflict'],
    ['STALE_TURN', 'stale_recovery'],
    ['CANCELLED_BEFORE_PROVIDER', 'cancelled_before_dispatch'],
    ['CLIENT_CANCELLED', 'cancelled'],
    ['EXECUTION_CANCELLED', 'cancelled'],
    ['STREAM_DELIVERY_TERMINATED', 'cancelled'],
    ['TOTAL_TIMEOUT_BEFORE_PROVIDER', 'timeout_before_dispatch'],
    ['TIMEOUT', 'timeout'],
    ['RATE_LIMITED', 'provider_rate_limited'],
    ['AUTHENTICATION', 'provider_authentication'],
    ['UPSTREAM', 'provider_unavailable'],
    ['NETWORK', 'provider_unavailable'],
    ['ABORTED', 'provider_unavailable'],
    ['UNCONFIGURED', 'provider_unavailable'],
    ['MALFORMED_STREAM', 'provider_malformed'],
    ['MALFORMED_RESPONSE', 'provider_malformed'],
    ['PREPARATION_FAILED', 'preparation'],
    ['SAFETY', 'safety'],
    ['PERSISTENCE', 'persistence'],
    ['TRUSTED_SAFETY_PERSISTENCE_FAILED', 'persistence'],
    ['SAFETY_RESPONSE_PERSISTENCE_FAILED', 'persistence'],
    ['INTERNAL', 'internal'],
  ])('maps stored failure %s to %s without returning the raw code', (failureCode, expected) => {
    const projected = presentAdminAiTurnMetadata(storedRow({ failureCode }), OBSERVED_AT);
    expect(projected.failureCategory).toBe(expected);
    expect(JSON.stringify(projected)).not.toContain(failureCode);
  });

  it('maps missing, unknown, and status-inconsistent failure evidence safely', () => {
    expect(
      presentAdminAiTurnMetadata(storedRow({ failureCode: null }), OBSERVED_AT).failureCategory,
    ).toBe('unknown');
    expect(
      presentAdminAiTurnMetadata(storedRow({ failureCode: 'FUTURE_FAILURE' }), OBSERVED_AT)
        .failureCategory,
    ).toBe('unknown');
    expect(
      presentAdminAiTurnMetadata(
        storedRow({ status: 'completed', failureCode: 'NETWORK' }),
        OBSERVED_AT,
      ).failureCategory,
    ).toBe('unknown');
    expect(
      presentAdminAiTurnMetadata(storedRow({ status: 'completed', failureCode: null }), OBSERVED_AT)
        .failureCategory,
    ).toBeNull();
  });

  it.each(['toString', 'constructor', '__proto__'])(
    'treats prototype property name %s as an unknown stored failure code',
    (failureCode) => {
      const projected = presentAdminAiTurnMetadata(storedRow({ failureCode }), OBSERVED_AT);
      expect(projected.failureCategory).toBe('unknown');
      expect(JSON.stringify(projected)).not.toContain(failureCode);
    },
  );

  it('limits prompt identity and derives terminal lifecycle semantics', () => {
    const valid = presentAdminAiTurnMetadata(storedRow(), OBSERVED_AT);
    expect(valid).toMatchObject({
      promptIdentity: { availability: 'available', key: 'supportive-chat', version: '1' },
      lifecycleStartedAt: STARTED_AT.toISOString(),
      terminalAt: '2026-09-11T10:00:04.000Z',
      lifecycleDurationMs: 4_000,
      leaseState: 'not_applicable',
    });
    expect(
      presentAdminAiTurnMetadata(storedRow({ promptKey: 'Supportive Chat' }), OBSERVED_AT)
        .promptIdentity,
    ).toEqual({ availability: 'unavailable' });
    expect(
      presentAdminAiTurnMetadata(storedRow({ promptVersion: 'bad version' }), OBSERVED_AT)
        .promptIdentity,
    ).toEqual({ availability: 'unavailable' });
    const invalidTerminal = presentAdminAiTurnMetadata(
      storedRow({ completedAt: new Date(STARTED_AT.getTime() - 1) }),
      OBSERVED_AT,
    );
    expect(invalidTerminal.terminalAt).toBeNull();
    expect(invalidTerminal.lifecycleDurationMs).toBeNull();
  });

  it.each([
    ['claimed', new Date(OBSERVED_AT.getTime() + 1), 'valid'],
    ['streaming', OBSERVED_AT, 'expired'],
  ])(
    'derives active %s lease state without projecting malformed terminal data',
    (status, leaseExpiresAt, leaseState) => {
      const projected = presentAdminAiTurnMetadata(
        storedRow({
          status: status as AdminAiTurnStatus,
          failureCode: null,
          leaseExpiresAt,
          completedAt: new Date(OBSERVED_AT.getTime() + 10_000),
        }),
        OBSERVED_AT,
      );
      expect(projected).toMatchObject({
        status,
        failureCategory: null,
        terminalAt: null,
        lifecycleDurationMs: null,
        leaseState,
      });
    },
  );
});
