import type { ConsentMutationRequest } from '@mental-health/types';
import { z } from 'zod';
import { CONSENT_TYPE_VALUES } from './consent-policy.service';

export const CONSENT_HISTORY_DEFAULT_PAGE_LIMIT = 20;
export const CONSENT_HISTORY_MAX_PAGE_LIMIT = 50;

export const consentHistoryQuerySchema = z
  .object({
    cursor: z.string().min(1).max(512).optional(),
    limit: z.coerce
      .number()
      .int()
      .min(1)
      .max(CONSENT_HISTORY_MAX_PAGE_LIMIT)
      .default(CONSENT_HISTORY_DEFAULT_PAGE_LIMIT),
  })
  .strict();

export const consentHistoryCursorSchema = z
  .object({
    kind: z.literal('consent-history'),
    version: z.literal(2),
    occurredAt: z.string().datetime({ offset: true }),
    id: z.string().uuid(),
  })
  .strict();

const consentMutationBase = {
  operationId: z.string().uuid(),
  consentType: z.enum(CONSENT_TYPE_VALUES),
  consentVersion: z.string().trim().min(1).max(64),
  expectedRevision: z.number().int().min(0),
} as const;

export const consentMutationSchema: z.ZodType<ConsentMutationRequest> = z.discriminatedUnion(
  'action',
  [
    z
      .object({
        ...consentMutationBase,
        action: z.literal('accept'),
        documentKey: z.string().trim().min(1).max(128),
        documentRevision: z.string().trim().min(1).max(64),
      })
      .strict(),
    z
      .object({
        ...consentMutationBase,
        action: z.literal('withdraw'),
      })
      .strict(),
  ],
);

export type ConsentHistoryQuery = z.infer<typeof consentHistoryQuerySchema>;
