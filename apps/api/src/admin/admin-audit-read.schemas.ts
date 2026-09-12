import { z } from 'zod';
import { staffRoleSchema } from './staff-access.types';

export const readableAuditActionSchema = z.enum([
  'staff_principal_bootstrapped',
  'staff_principal_created',
  'staff_role_granted',
  'staff_role_revoked',
  'staff_principal_disabled',
  'staff_sessions_revoked',
  'staff_directory_accessed',
  'knowledge_directory_accessed',
  'knowledge_version_status_viewed',
  'knowledge_draft_viewed',
  'knowledge_review_candidate_viewed',
  'knowledge_publication_state_viewed',
  'knowledge_draft_created',
  'knowledge_draft_updated',
  'knowledge_source_verified',
  'knowledge_version_published',
  'knowledge_version_withdrawn',
  'audit_log_accessed',
  'ai_quality_metadata_accessed',
]);

export const readableAuditResourceTypeSchema = z.enum([
  'staff_principal',
  'staff_principal_query',
  'knowledge_article_query',
  'knowledge_article_version',
  'audit_log_query',
  'ai_turn_query',
  'ai_turn',
]);

export type ReadableAuditAction = z.infer<typeof readableAuditActionSchema>;
export type ReadableAuditResourceType = z.infer<typeof readableAuditResourceTypeSchema>;
export const READABLE_AUDIT_ACTIONS = readableAuditActionSchema.options;
export const READABLE_AUDIT_RESOURCE_TYPES = readableAuditResourceTypeSchema.options;

export const READABLE_AUDIT_ACTION_RESOURCE_PAIRS = [
  { action: 'staff_principal_bootstrapped', resourceType: 'staff_principal' },
  { action: 'staff_principal_created', resourceType: 'staff_principal' },
  { action: 'staff_role_granted', resourceType: 'staff_principal' },
  { action: 'staff_role_revoked', resourceType: 'staff_principal' },
  { action: 'staff_principal_disabled', resourceType: 'staff_principal' },
  { action: 'staff_sessions_revoked', resourceType: 'staff_principal' },
  { action: 'staff_directory_accessed', resourceType: 'staff_principal_query' },
  { action: 'knowledge_directory_accessed', resourceType: 'knowledge_article_query' },
  { action: 'knowledge_version_status_viewed', resourceType: 'knowledge_article_version' },
  { action: 'knowledge_draft_viewed', resourceType: 'knowledge_article_version' },
  { action: 'knowledge_review_candidate_viewed', resourceType: 'knowledge_article_version' },
  { action: 'knowledge_publication_state_viewed', resourceType: 'knowledge_article_version' },
  { action: 'knowledge_draft_created', resourceType: 'knowledge_article_version' },
  { action: 'knowledge_draft_updated', resourceType: 'knowledge_article_version' },
  { action: 'knowledge_source_verified', resourceType: 'knowledge_article_version' },
  { action: 'knowledge_version_published', resourceType: 'knowledge_article_version' },
  { action: 'knowledge_version_withdrawn', resourceType: 'knowledge_article_version' },
  { action: 'audit_log_accessed', resourceType: 'audit_log_query' },
  { action: 'ai_quality_metadata_accessed', resourceType: 'ai_turn_query' },
  { action: 'ai_quality_metadata_accessed', resourceType: 'ai_turn' },
] as const satisfies readonly Readonly<{
  action: ReadableAuditAction;
  resourceType: ReadableAuditResourceType;
}>[];

export function isReadableAuditActionResourcePair(
  action: ReadableAuditAction,
  resourceType: ReadableAuditResourceType,
): boolean {
  return READABLE_AUDIT_ACTION_RESOURCE_PAIRS.some(
    (pair) => pair.action === action && pair.resourceType === resourceType,
  );
}

const offsetTimestampSchema = z.string().datetime({ offset: true });
// PostgreSQL accepts the full UUID textual shape, including code-owned sentinel
// identifiers that do not carry an RFC version nibble. Resource IDs are opaque and
// never dereferenced by this API.
const postgresUuidSchema = z
  .string()
  .regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu);

export const adminAuditReadQuerySchema = z
  .object({
    action: readableAuditActionSchema.optional(),
    resourceType: readableAuditResourceTypeSchema.optional(),
    occurredFrom: offsetTimestampSchema.optional(),
    occurredBefore: offsetTimestampSchema.optional(),
    limit: z.coerce.number().int().min(1).max(50).default(20),
    cursor: z.string().min(1).max(512).optional(),
  })
  .strict()
  .superRefine((value, context) => {
    if ((value.occurredFrom === undefined) !== (value.occurredBefore === undefined)) {
      context.addIssue({
        code: 'custom',
        message: 'occurredFrom 与 occurredBefore 必须同时提供',
        path: value.occurredFrom === undefined ? ['occurredFrom'] : ['occurredBefore'],
      });
    }

    if (value.occurredFrom && value.occurredBefore) {
      const occurredFrom = Date.parse(value.occurredFrom);
      const occurredBefore = Date.parse(value.occurredBefore);
      if (occurredFrom >= occurredBefore) {
        context.addIssue({
          code: 'custom',
          message: '审计时间范围无效',
          path: ['occurredBefore'],
        });
      }
      if (occurredBefore - occurredFrom > 31 * 24 * 60 * 60 * 1_000) {
        context.addIssue({
          code: 'custom',
          message: '审计时间范围不能超过 31 天',
          path: ['occurredBefore'],
        });
      }
    }

    if (
      value.action &&
      value.resourceType &&
      !isReadableAuditActionResourcePair(value.action, value.resourceType)
    ) {
      context.addIssue({
        code: 'custom',
        message: '审计动作与资源类型不匹配',
        path: ['resourceType'],
      });
    }
  });

/**
 * Compact because the canonical base64url token is bounded to 512 characters.
 * Every field remains untrusted and is revalidated on continuation.
 */
export const adminAuditReadCursorSchema = z
  .object({
    k: z.literal('aal'),
    v: z.literal(1),
    a: readableAuditActionSchema.nullable(),
    r: readableAuditResourceTypeSchema.nullable(),
    f: offsetTimestampSchema,
    b: offsetTimestampSchema,
    m: z.enum(['d', 'e']),
    t: offsetTimestampSchema,
    i: z.string().uuid(),
  })
  .strict()
  .superRefine((value, context) => {
    const occurredFrom = Date.parse(value.f);
    const occurredBefore = Date.parse(value.b);
    const lastOccurredAt = Date.parse(value.t);

    if (occurredFrom >= occurredBefore) {
      context.addIssue({ code: 'custom', message: '审计游标时间范围无效', path: ['b'] });
    }
    if (occurredBefore - occurredFrom > 31 * 24 * 60 * 60 * 1_000) {
      context.addIssue({ code: 'custom', message: '审计游标时间范围超过上限', path: ['b'] });
    }
    if (lastOccurredAt < occurredFrom || lastOccurredAt >= occurredBefore) {
      context.addIssue({ code: 'custom', message: '审计游标末项时间无效', path: ['t'] });
    }
    if (value.a && value.r && !isReadableAuditActionResourcePair(value.a, value.r)) {
      context.addIssue({
        code: 'custom',
        message: '审计游标动作与资源类型不匹配',
        path: ['r'],
      });
    }
  });

const adminAuditActorSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('system'), id: z.null() }).strict(),
  z.object({ type: z.literal('staff'), id: z.string().uuid() }).strict(),
]);

const emptyMetadataSchema = z.object({}).strict();
const staffBootstrapMetadataSchema = z
  .object({ roleKey: z.literal('access_administrator') })
  .strict();
const staffRoleMetadataSchema = z
  .object({
    roleKey: staffRoleSchema,
    resultingAuthorizationRevision: z.number().int().positive(),
  })
  .strict();
const staffRevisionMetadataSchema = z
  .object({ resultingAuthorizationRevision: z.number().int().positive() })
  .strict();
const staffSessionMetadataSchema = z
  .object({ sessionCount: z.number().int().nonnegative() })
  .strict();
const staffDirectoryMetadataSchema = z
  .object({
    filterCategory: z.enum(['all', 'id']),
    returnedCount: z.number().int().nonnegative(),
  })
  .strict();
const knowledgeDirectoryMetadataSchema = z
  .object({
    filterCategory: z.literal('all'),
    returnedCount: z.number().int().nonnegative(),
  })
  .strict();
const knowledgeMutationMetadataSchema = z
  .object({
    disposition: z.enum(['applied', 'no_change']),
    version: z.number().int().positive(),
    resultingDraftRevision: z.number().int().positive(),
  })
  .strict();
const auditAccessMetadataSchema = z
  .object({
    filterCategory: z.enum(['all', 'action', 'resource_type', 'time_range', 'combined']),
    pageKind: z.enum(['initial', 'continuation']),
    returnedCount: z.number().int().nonnegative(),
  })
  .strict();
const aiQualityAccessMetadataSchema = z
  .object({
    accessCategory: z.enum(['list', 'detail']),
    filterCategory: z.enum(['all', 'status', 'time_range', 'status_and_time', 'id']),
    returnedCount: z.number().int().nonnegative(),
  })
  .strict();
const aiQualityListAccessMetadataSchema = aiQualityAccessMetadataSchema
  .extend({
    accessCategory: z.literal('list'),
    filterCategory: z.enum(['all', 'status', 'time_range', 'status_and_time']),
  })
  .strict();
const aiQualityDetailAccessMetadataSchema = aiQualityAccessMetadataSchema
  .extend({ accessCategory: z.literal('detail'), filterCategory: z.literal('id') })
  .strict();

function recordSchema<
  const TAction extends ReadableAuditAction,
  const TResource extends ReadableAuditResourceType,
  TMetadata extends z.ZodType,
>(action: TAction, resourceType: TResource, safeMetadata: TMetadata) {
  return z
    .object({
      id: z.string().uuid(),
      actor: adminAuditActorSchema,
      action: z.literal(action),
      resource: z.object({ type: z.literal(resourceType), id: postgresUuidSchema }).strict(),
      occurredAt: offsetTimestampSchema,
      retentionUntil: offsetTimestampSchema,
      safeMetadata,
    })
    .strict();
}

export const adminAuditRecordSchema = z.union([
  recordSchema('staff_principal_bootstrapped', 'staff_principal', staffBootstrapMetadataSchema),
  recordSchema('staff_principal_created', 'staff_principal', emptyMetadataSchema),
  recordSchema('staff_role_granted', 'staff_principal', staffRoleMetadataSchema),
  recordSchema('staff_role_revoked', 'staff_principal', staffRoleMetadataSchema),
  recordSchema('staff_principal_disabled', 'staff_principal', staffRevisionMetadataSchema),
  recordSchema('staff_sessions_revoked', 'staff_principal', staffSessionMetadataSchema),
  recordSchema('staff_directory_accessed', 'staff_principal_query', staffDirectoryMetadataSchema),
  recordSchema(
    'knowledge_directory_accessed',
    'knowledge_article_query',
    knowledgeDirectoryMetadataSchema,
  ),
  recordSchema(
    'knowledge_version_status_viewed',
    'knowledge_article_version',
    z
      .object({ accessCategory: z.literal('status'), version: z.number().int().positive() })
      .strict(),
  ),
  recordSchema(
    'knowledge_draft_viewed',
    'knowledge_article_version',
    z.object({ accessCategory: z.literal('draft'), version: z.number().int().positive() }).strict(),
  ),
  recordSchema(
    'knowledge_review_candidate_viewed',
    'knowledge_article_version',
    z
      .object({ accessCategory: z.literal('review'), version: z.number().int().positive() })
      .strict(),
  ),
  recordSchema(
    'knowledge_publication_state_viewed',
    'knowledge_article_version',
    z
      .object({ accessCategory: z.literal('publication'), version: z.number().int().positive() })
      .strict(),
  ),
  recordSchema(
    'knowledge_draft_created',
    'knowledge_article_version',
    knowledgeMutationMetadataSchema,
  ),
  recordSchema(
    'knowledge_draft_updated',
    'knowledge_article_version',
    knowledgeMutationMetadataSchema,
  ),
  recordSchema(
    'knowledge_source_verified',
    'knowledge_article_version',
    knowledgeMutationMetadataSchema,
  ),
  recordSchema(
    'knowledge_version_published',
    'knowledge_article_version',
    knowledgeMutationMetadataSchema.extend({ publicationStatus: z.literal('published') }).strict(),
  ),
  recordSchema(
    'knowledge_version_withdrawn',
    'knowledge_article_version',
    knowledgeMutationMetadataSchema.extend({ publicationStatus: z.literal('withdrawn') }).strict(),
  ),
  recordSchema('audit_log_accessed', 'audit_log_query', auditAccessMetadataSchema),
  recordSchema('ai_quality_metadata_accessed', 'ai_turn_query', aiQualityListAccessMetadataSchema),
  recordSchema('ai_quality_metadata_accessed', 'ai_turn', aiQualityDetailAccessMetadataSchema),
]);

export const adminAuditReadDataSchema = z
  .object({
    observedAt: offsetTimestampSchema,
    period: z
      .object({ occurredFrom: offsetTimestampSchema, occurredBefore: offsetTimestampSchema })
      .strict(),
    records: z.array(adminAuditRecordSchema).max(50),
    nextCursor: z.string().min(1).max(512).nullable(),
  })
  .strict();

export const storedAuditReadRowSchema = z
  .object({
    id: z.string().uuid(),
    actorType: z.string(),
    actorId: z.string().nullable(),
    action: z.string(),
    resourceType: z.string(),
    resourceId: postgresUuidSchema,
    occurredAt: z.date(),
    safeMetadata: z.unknown(),
    retentionUntil: z.date(),
  })
  .strict();

export type AdminAuditReadQuery = z.infer<typeof adminAuditReadQuerySchema>;
export type AdminAuditReadCursor = z.infer<typeof adminAuditReadCursorSchema>;
export type AdminAuditRecord = z.infer<typeof adminAuditRecordSchema>;
export type AdminAuditReadData = z.infer<typeof adminAuditReadDataSchema>;
export type StoredAuditReadRow = z.infer<typeof storedAuditReadRowSchema>;
