import { z } from 'zod';

export const adminAiTurnStatusSchema = z.enum([
  'claimed',
  'streaming',
  'completed',
  'failed',
  'cancelled',
]);

export const adminAiTurnFailureCategorySchema = z.enum([
  'quota_exhausted',
  'concurrency_conflict',
  'stale_recovery',
  'cancelled_before_dispatch',
  'cancelled',
  'timeout_before_dispatch',
  'timeout',
  'provider_rate_limited',
  'provider_authentication',
  'provider_unavailable',
  'provider_malformed',
  'preparation',
  'safety',
  'persistence',
  'internal',
  'unknown',
]);

const offsetTimestampSchema = z.string().datetime({ offset: true });

export const adminAiTurnMetadataQuerySchema = z
  .object({
    status: adminAiTurnStatusSchema.optional(),
    createdFrom: offsetTimestampSchema.optional(),
    createdBefore: offsetTimestampSchema.optional(),
    limit: z.coerce.number().int().min(1).max(50).default(20),
    cursor: z.string().min(1).max(512).optional(),
  })
  .strict()
  .superRefine((value, context) => {
    if ((value.createdFrom === undefined) !== (value.createdBefore === undefined)) {
      context.addIssue({
        code: 'custom',
        message: 'createdFrom 与 createdBefore 必须同时提供',
        path: value.createdFrom === undefined ? ['createdFrom'] : ['createdBefore'],
      });
    }
    if (value.createdFrom && value.createdBefore) {
      const createdFrom = Date.parse(value.createdFrom);
      const createdBefore = Date.parse(value.createdBefore);
      if (createdFrom >= createdBefore) {
        context.addIssue({
          code: 'custom',
          message: 'AI Turn 时间范围无效',
          path: ['createdBefore'],
        });
      }
      if (createdBefore - createdFrom > 31 * 24 * 60 * 60 * 1_000) {
        context.addIssue({
          code: 'custom',
          message: 'AI Turn 时间范围不能超过 31 天',
          path: ['createdBefore'],
        });
      }
    }
  });

export const adminAiTurnMetadataCursorSchema = z
  .object({
    k: z.literal('aqt'),
    v: z.literal(1),
    s: adminAiTurnStatusSchema.nullable(),
    f: offsetTimestampSchema,
    b: offsetTimestampSchema,
    m: z.enum(['d', 'e']),
    t: offsetTimestampSchema,
    i: z.string().uuid(),
  })
  .strict()
  .superRefine((value, context) => {
    const createdFrom = Date.parse(value.f);
    const createdBefore = Date.parse(value.b);
    const lastCreatedAt = Date.parse(value.t);
    if (createdFrom >= createdBefore) {
      context.addIssue({ code: 'custom', message: 'AI Turn 游标时间范围无效', path: ['b'] });
    }
    if (createdBefore - createdFrom > 31 * 24 * 60 * 60 * 1_000) {
      context.addIssue({ code: 'custom', message: 'AI Turn 游标时间范围超过上限', path: ['b'] });
    }
    if (lastCreatedAt < createdFrom || lastCreatedAt >= createdBefore) {
      context.addIssue({ code: 'custom', message: 'AI Turn 游标末项时间无效', path: ['t'] });
    }
  });

export const adminAiTurnIdSchema = z.string().uuid();

const promptIdentitySchema = z.discriminatedUnion('availability', [
  z
    .object({
      availability: z.literal('available'),
      key: z
        .string()
        .min(1)
        .max(64)
        .regex(/^[a-z0-9][a-z0-9._-]*$/u),
      version: z
        .string()
        .min(1)
        .max(64)
        .regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/u),
    })
    .strict(),
  z.object({ availability: z.literal('unavailable') }).strict(),
]);

export const adminAiTurnMetadataSchema = z
  .object({
    turnId: z.string().uuid(),
    status: adminAiTurnStatusSchema,
    promptIdentity: promptIdentitySchema,
    failureCategory: adminAiTurnFailureCategorySchema.nullable(),
    lifecycleStartedAt: offsetTimestampSchema,
    terminalAt: offsetTimestampSchema.nullable(),
    lifecycleDurationMs: z.number().int().nonnegative().nullable(),
    leaseState: z.enum(['valid', 'expired', 'not_applicable']),
  })
  .strict();

export const adminAiTurnMetadataListDataSchema = z
  .object({
    observedAt: offsetTimestampSchema,
    period: z
      .object({ createdFrom: offsetTimestampSchema, createdBefore: offsetTimestampSchema })
      .strict(),
    turns: z.array(adminAiTurnMetadataSchema).max(50),
    nextCursor: z.string().min(1).max(512).nullable(),
  })
  .strict();

export const adminAiTurnMetadataDetailDataSchema = z
  .object({
    observedAt: offsetTimestampSchema,
    turn: adminAiTurnMetadataSchema,
  })
  .strict();

export const storedAdminAiTurnMetadataSchema = z
  .object({
    id: z.string().uuid(),
    status: adminAiTurnStatusSchema,
    promptKey: z.string().max(64),
    promptVersion: z.string().max(64),
    failureCode: z.string().max(64).nullable(),
    leaseExpiresAt: z.date(),
    createdAt: z.date(),
    startedAt: z.date(),
    completedAt: z.date().nullable(),
  })
  .strict();

export type AdminAiTurnStatus = z.infer<typeof adminAiTurnStatusSchema>;
export type AdminAiTurnFailureCategory = z.infer<typeof adminAiTurnFailureCategorySchema>;
export type AdminAiTurnMetadataQuery = z.infer<typeof adminAiTurnMetadataQuerySchema>;
export type AdminAiTurnMetadataCursor = z.infer<typeof adminAiTurnMetadataCursorSchema>;
export type AdminAiTurnMetadata = z.infer<typeof adminAiTurnMetadataSchema>;
export type AdminAiTurnMetadataListData = z.infer<typeof adminAiTurnMetadataListDataSchema>;
export type AdminAiTurnMetadataDetailData = z.infer<typeof adminAiTurnMetadataDetailDataSchema>;
export type StoredAdminAiTurnMetadata = z.infer<typeof storedAdminAiTurnMetadataSchema>;
