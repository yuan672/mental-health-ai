import { randomUUID } from 'node:crypto';
import { presentAdminAuditRecord } from '../src/admin/admin-audit-read.presenter';
import {
  READABLE_AUDIT_ACTION_RESOURCE_PAIRS,
  adminAuditReadCursorSchema,
  adminAuditReadQuerySchema,
  isReadableAuditActionResourcePair,
  type ReadableAuditAction,
} from '../src/admin/admin-audit-read.schemas';
import { encodeOpaqueCursor } from '../src/common/pagination/opaque-cursor';

const occurredAt = new Date('2026-09-11T10:00:00.000Z');
const retentionUntil = new Date('2026-12-10T10:00:00.000Z');

function storedRow(overrides: Record<string, unknown> = {}) {
  return {
    id: randomUUID(),
    actorType: 'staff',
    actorId: randomUUID(),
    action: 'staff_role_granted',
    resourceType: 'staff_principal',
    resourceId: randomUUID(),
    occurredAt,
    retentionUntil,
    safeMetadata: { roleKey: 'audit_reader', resultingAuthorizationRevision: 2 },
    ...overrides,
  };
}

const validVariants: ReadonlyArray<
  readonly [string, string, Record<string, unknown>, Record<string, unknown>?]
> = [
  [
    'staff_principal_bootstrapped',
    'staff_principal',
    { roleKey: 'access_administrator' },
    { actorType: 'system', actorId: null },
  ],
  ['staff_principal_created', 'staff_principal', {}],
  [
    'staff_role_granted',
    'staff_principal',
    { roleKey: 'audit_reader', resultingAuthorizationRevision: 2 },
  ],
  [
    'staff_role_revoked',
    'staff_principal',
    { roleKey: 'audit_reader', resultingAuthorizationRevision: 3 },
  ],
  ['staff_principal_disabled', 'staff_principal', { resultingAuthorizationRevision: 4 }],
  ['staff_sessions_revoked', 'staff_principal', { sessionCount: 2 }],
  ['staff_directory_accessed', 'staff_principal_query', { filterCategory: 'id', returnedCount: 1 }],
  [
    'knowledge_directory_accessed',
    'knowledge_article_query',
    { filterCategory: 'all', returnedCount: 1 },
  ],
  [
    'knowledge_version_status_viewed',
    'knowledge_article_version',
    { accessCategory: 'status', version: 1 },
  ],
  ['knowledge_draft_viewed', 'knowledge_article_version', { accessCategory: 'draft', version: 1 }],
  [
    'knowledge_review_candidate_viewed',
    'knowledge_article_version',
    { accessCategory: 'review', version: 1 },
  ],
  [
    'knowledge_publication_state_viewed',
    'knowledge_article_version',
    { accessCategory: 'publication', version: 1 },
  ],
  [
    'knowledge_draft_created',
    'knowledge_article_version',
    { disposition: 'applied', version: 1, resultingDraftRevision: 1 },
  ],
  [
    'knowledge_draft_updated',
    'knowledge_article_version',
    { disposition: 'no_change', version: 1, resultingDraftRevision: 2 },
  ],
  [
    'knowledge_source_verified',
    'knowledge_article_version',
    { disposition: 'applied', version: 1, resultingDraftRevision: 3 },
  ],
  [
    'knowledge_version_published',
    'knowledge_article_version',
    {
      disposition: 'applied',
      version: 1,
      resultingDraftRevision: 3,
      publicationStatus: 'published',
    },
  ],
  [
    'knowledge_version_withdrawn',
    'knowledge_article_version',
    {
      disposition: 'applied',
      version: 1,
      resultingDraftRevision: 3,
      publicationStatus: 'withdrawn',
    },
  ],
  [
    'audit_log_accessed',
    'audit_log_query',
    { filterCategory: 'combined', pageKind: 'continuation', returnedCount: 2 },
  ],
  [
    'ai_quality_metadata_accessed',
    'ai_turn_query',
    { accessCategory: 'list', filterCategory: 'status_and_time', returnedCount: 2 },
  ],
  [
    'ai_quality_metadata_accessed',
    'ai_turn',
    { accessCategory: 'detail', filterCategory: 'id', returnedCount: 1 },
  ],
];

describe('Admin Audit Read contracts', () => {
  it('parses bounded queries and rejects impossible action/resource pairs', () => {
    expect(adminAuditReadQuerySchema.parse({})).toEqual({ limit: 20 });
    expect(() => adminAuditReadQuerySchema.parse({ unexpected: 'field' })).toThrow();
  });

  it('rejects invalid query ranges and action/resource combinations', () => {
    expect(() =>
      adminAuditReadQuerySchema.parse({ occurredFrom: '2026-09-01T00:00:00.000Z' }),
    ).toThrow();
    expect(() =>
      adminAuditReadQuerySchema.parse({
        action: 'staff_role_granted',
        resourceType: 'knowledge_article_version',
      }),
    ).toThrow();
    expect(() => adminAuditReadQuerySchema.parse({ limit: 51 })).toThrow();
  });

  it('keeps the readable action/resource matrix closed', () => {
    for (const pair of READABLE_AUDIT_ACTION_RESOURCE_PAIRS) {
      expect(isReadableAuditActionResourcePair(pair.action, pair.resourceType)).toBe(true);
    }
    expect(
      isReadableAuditActionResourcePair('staff_principal_created', 'knowledge_article_version'),
    ).toBe(false);
  });

  it('builds a strict compact cursor within the shared 512-character boundary', () => {
    const cursor = adminAuditReadCursorSchema.parse({
      k: 'aal',
      v: 1,
      a: 'knowledge_publication_state_viewed',
      r: 'knowledge_article_version',
      f: '2026-08-12T10:00:00.000Z',
      b: '2026-09-12T10:00:00.000Z',
      m: 'e',
      t: '2026-09-11T10:00:00.000Z',
      i: randomUUID(),
    });
    expect(encodeOpaqueCursor(cursor).length).toBeLessThanOrEqual(512);
    expect(() => adminAuditReadCursorSchema.parse({ ...cursor, extra: true })).toThrow();
    expect(() =>
      adminAuditReadCursorSchema.parse({ ...cursor, t: '2026-09-12T10:00:00.000Z' }),
    ).toThrow();
  });

  it('projects only the strict public record shape', () => {
    const result = presentAdminAuditRecord(storedRow());
    expect(result).toEqual({
      id: expect.any(String),
      actor: { type: 'staff', id: expect.any(String) },
      action: 'staff_role_granted',
      resource: { type: 'staff_principal', id: expect.any(String) },
      occurredAt: occurredAt.toISOString(),
      retentionUntil: retentionUntil.toISOString(),
      safeMetadata: { roleKey: 'audit_reader', resultingAuthorizationRevision: 2 },
    });
    expect(result).not.toHaveProperty('idempotencyKey');
  });

  it('accepts every exact public action/resource/metadata variant', () => {
    for (const [action, resourceType, safeMetadata, actorOverrides] of validVariants) {
      expect(() =>
        presentAdminAuditRecord(
          storedRow({ action, resourceType, safeMetadata, ...(actorOverrides ?? {}) }),
        ),
      ).not.toThrow();
    }
  });

  it.each([
    ['ordinary user actor', { actorType: 'user', actorId: randomUUID() }],
    ['staff actor without id', { actorType: 'staff', actorId: null }],
    ['wrong resource', { resourceType: 'knowledge_article_version' }],
    ['wrong metadata', { safeMetadata: { arbitrary: 'raw-json' } }],
    [
      'wrong action-specific access category',
      {
        action: 'knowledge_draft_viewed',
        resourceType: 'knowledge_article_version',
        safeMetadata: { accessCategory: 'review', version: 1 },
      },
    ],
  ])('fails closed for %s', (_name, overrides) => {
    expect(() => presentAdminAuditRecord(storedRow(overrides))).toThrow();
  });

  it('does not accept arbitrary strings as readable actions', () => {
    expect(() => presentAdminAuditRecord(storedRow({ action: 'risk_event_created' }))).toThrow();
    const actions = new Set(
      READABLE_AUDIT_ACTION_RESOURCE_PAIRS.map((pair) => pair.action as ReadableAuditAction),
    );
    expect(actions.has('audit_log_accessed')).toBe(true);
    expect(actions.has('ai_quality_metadata_accessed')).toBe(true);
  });
});
