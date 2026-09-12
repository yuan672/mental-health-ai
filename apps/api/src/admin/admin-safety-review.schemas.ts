import { z } from 'zod';
import {
  detectionSourceSchema,
  riskCategorySchema,
  riskLevelSchema,
  riskReasonCodeSchema,
} from '../safety/safety.types';
import { reviewResolutionCodeSchema } from '../safety/review/human-review-queue.service';

const optionalBooleanQuerySchema = z
  .enum(['true', 'false'])
  .transform((value) => value === 'true')
  .optional();

export const adminResourceIdSchema = z.string().uuid();

export const adminRiskEventListQuerySchema = z
  .object({
    cursor: z.string().min(1).max(512).optional(),
    limit: z.coerce.number().int().min(1).max(50).default(20),
    level: riskLevelSchema.optional(),
    isIncognito: optionalBooleanQuerySchema,
  })
  .strict();

export const adminReviewQueueListQuerySchema = z
  .object({
    cursor: z.string().min(1).max(512).optional(),
    limit: z.coerce.number().int().min(1).max(50).default(20),
    state: z.enum(['pending', 'in_review', 'resolved']).optional(),
    priority: z.enum(['high', 'urgent']).optional(),
  })
  .strict();

export const adminReviewQueueClaimSchema = z.object({}).strict();
export const adminReviewQueueResolveSchema = z
  .object({ resolutionCode: reviewResolutionCodeSchema })
  .strict();

export const adminRiskEventCursorSchema = z
  .object({
    kind: z.literal('admin-risk-events'),
    version: z.literal(1),
    createdAt: z.string().datetime({ offset: true }),
    id: z.string().uuid(),
    filters: z
      .object({
        level: riskLevelSchema.nullable(),
        isIncognito: z.boolean().nullable(),
      })
      .strict(),
  })
  .strict();

export const adminReviewQueueCursorSchema = z
  .object({
    kind: z.literal('admin-review-queue'),
    version: z.literal(1),
    priority: z.enum(['high', 'urgent']),
    createdAt: z.string().datetime({ offset: true }),
    id: z.string().uuid(),
    filters: z
      .object({
        state: z.enum(['pending', 'in_review', 'resolved']).nullable(),
        priority: z.enum(['high', 'urgent']).nullable(),
      })
      .strict(),
  })
  .strict();

export const adminRiskEventViewSchema = z
  .object({
    id: z.string().uuid(),
    isIncognito: z.boolean(),
    ordinaryContextReferenceAvailable: z.boolean(),
    level: riskLevelSchema,
    riskCategories: z.array(riskCategorySchema).max(8),
    reasonCodes: z.array(riskReasonCodeSchema).max(32),
    detectionSource: detectionSourceSchema,
    policyVersion: z.string().min(1).max(64),
    classifierKey: z.string().min(1).max(64).nullable(),
    classifierVersion: z.string().min(1).max(64).nullable(),
    createdAt: z.string().datetime({ offset: true }),
    retentionUntil: z.string().datetime({ offset: true }),
  })
  .strict();

export const adminReviewQueueItemViewSchema = z
  .object({
    id: z.string().uuid(),
    riskEventId: z.string().uuid(),
    priority: z.enum(['high', 'urgent']),
    state: z.enum(['pending', 'in_review', 'resolved']),
    assignedReviewerId: z.string().min(1).max(128).nullable(),
    createdAt: z.string().datetime({ offset: true }),
    startedAt: z.string().datetime({ offset: true }).nullable(),
    reviewedAt: z.string().datetime({ offset: true }).nullable(),
    resolutionCode: reviewResolutionCodeSchema.nullable(),
  })
  .strict();

export const adminRiskEventListDataSchema = z
  .object({
    riskEvents: z.array(adminRiskEventViewSchema),
    nextCursor: z.string().nullable(),
  })
  .strict();

export const adminRiskEventDetailDataSchema = z
  .object({
    riskEvent: adminRiskEventViewSchema,
    reviewQueueItem: adminReviewQueueItemViewSchema.nullable(),
  })
  .strict();

export const adminReviewQueueListDataSchema = z
  .object({
    queueItems: z.array(
      z
        .object({
          queueItem: adminReviewQueueItemViewSchema,
          riskEvent: adminRiskEventViewSchema,
        })
        .strict(),
    ),
    nextCursor: z.string().nullable(),
  })
  .strict();

export const adminReviewQueueMutationDataSchema = z
  .object({ queueItem: adminReviewQueueItemViewSchema })
  .strict();

export type AdminRiskEventListQuery = z.infer<typeof adminRiskEventListQuerySchema>;
export type AdminReviewQueueListQuery = z.infer<typeof adminReviewQueueListQuerySchema>;
export type AdminReviewQueueResolveRequest = z.infer<typeof adminReviewQueueResolveSchema>;
