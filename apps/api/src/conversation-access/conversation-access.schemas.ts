import { z } from 'zod';

export const DEFAULT_PAGE_LIMIT = 20;
export const MAX_PAGE_LIMIT = 100;

export const conversationIdParamsSchema = z
  .object({
    id: z.string().uuid(),
  })
  .strict();

export const paginationQuerySchema = z
  .object({
    cursor: z.string().min(1).max(512).optional(),
    limit: z.coerce.number().int().min(1).max(MAX_PAGE_LIMIT).default(DEFAULT_PAGE_LIMIT),
  })
  .strict();

export const conversationCursorSchema = z
  .object({
    kind: z.literal('conversation'),
    version: z.literal(1),
    createdAt: z.string().datetime({ offset: true }),
    id: z.string().uuid(),
  })
  .strict();

export const messageCursorSchema = z
  .object({
    kind: z.literal('message'),
    version: z.literal(1),
    sequence: z.number().int().positive(),
  })
  .strict();

export type ConversationIdParams = z.infer<typeof conversationIdParamsSchema>;
export type PaginationQuery = z.infer<typeof paginationQuerySchema>;
