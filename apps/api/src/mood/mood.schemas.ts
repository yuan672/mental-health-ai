import { z } from 'zod';

export const MOOD_DEFAULT_PAGE_LIMIT = 20;
export const MOOD_MAX_PAGE_LIMIT = 100;
export const MOOD_EMOTION_VALUES = [
  'joyful',
  'calm',
  'hopeful',
  'neutral',
  'tired',
  'stressed',
  'sad',
  'angry',
  'overwhelmed',
] as const;

const moodEmotionSchema = z.enum(MOOD_EMOTION_VALUES);
const normalizedMoodNoteSchema = z
  .string()
  .transform((value) => value.trim())
  .refine((value) => Array.from(value).length <= 500, {
    message: '心情备注不能超过 500 个 Unicode code points',
  })
  .transform((value) => (value.length === 0 ? null : value));

export const createMoodEntryRequestSchema = z
  .object({
    clientRequestId: z.string().uuid(),
    moodScore: z.number().int().min(1).max(5),
    emotion: moodEmotionSchema.nullable().optional(),
    note: normalizedMoodNoteSchema.nullable().optional(),
  })
  .strict();

export const updateMoodEntryRequestSchema = z
  .object({
    expectedRevision: z.number().int().positive(),
    moodScore: z.number().int().min(1).max(5),
    emotion: moodEmotionSchema.nullable(),
    note: normalizedMoodNoteSchema.nullable(),
  })
  .strict();

export const deleteMoodEntryRequestSchema = z
  .object({ expectedRevision: z.number().int().positive() })
  .strict();

export const moodEntryIdParamsSchema = z.object({ id: z.string().uuid() }).strict();
export const moodCreationStatusParamsSchema = z
  .object({ clientRequestId: z.string().uuid() })
  .strict();

export const moodHistoryQuerySchema = z
  .object({
    days: z.coerce
      .number()
      .pipe(z.union([z.literal(7), z.literal(30)]))
      .default(7),
    cursor: z.string().min(1).max(1024).optional(),
    limit: z.coerce.number().int().min(1).max(MOOD_MAX_PAGE_LIMIT).default(MOOD_DEFAULT_PAGE_LIMIT),
  })
  .strict();

export const moodHistoryCursorSchema = z
  .object({
    kind: z.literal('mood-history'),
    version: z.literal(1),
    days: z.union([z.literal(7), z.literal(30)]),
    rangeStart: z.string().datetime({ offset: true }),
    rangeEnd: z.string().datetime({ offset: true }),
    createdAtCeiling: z.string().datetime({ offset: true }),
    createdAt: z.string().datetime({ offset: true }),
    id: z.string().uuid(),
  })
  .strict();

export const moodEntryResponseValueSchema = z
  .object({
    id: z.string().uuid(),
    moodScore: z.number().int().min(1).max(5),
    emotion: moodEmotionSchema.nullable(),
    note: z.string().nullable(),
    stateRevision: z.number().int().positive(),
    createdAt: z.string().datetime({ offset: true }),
    updatedAt: z.string().datetime({ offset: true }),
  })
  .strict();

export const createMoodEntryResponseSchema = z
  .object({
    success: z.literal(true),
    data: z
      .object({
        entry: moodEntryResponseValueSchema,
        disposition: z.enum(['created', 'existing']),
      })
      .strict(),
  })
  .strict();

export const moodCreationStatusResponseSchema = z
  .object({
    success: z.literal(true),
    data: z.discriminatedUnion('status', [
      z.object({ status: z.literal('present'), entry: moodEntryResponseValueSchema }).strict(),
      z.object({ status: z.literal('absent') }).strict(),
    ]),
  })
  .strict();

export const moodHistoryResponseSchema = z
  .object({
    success: z.literal(true),
    data: z
      .object({
        days: z.union([z.literal(7), z.literal(30)]),
        timeZone: z.literal('Asia/Shanghai'),
        period: z
          .object({
            startDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/u),
            endDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/u),
          })
          .strict(),
        entries: z.array(moodEntryResponseValueSchema),
        dailyTrend: z.array(
          z
            .object({
              localDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/u),
              entryCount: z.number().int().positive(),
              averageMoodScore: z.number().min(1).max(5),
            })
            .strict(),
        ),
        nextCursor: z.string().nullable(),
      })
      .strict(),
  })
  .strict();

export type MoodEntryIdParams = z.infer<typeof moodEntryIdParamsSchema>;
export type MoodCreationStatusParams = z.infer<typeof moodCreationStatusParamsSchema>;
export type MoodHistoryQuery = z.infer<typeof moodHistoryQuerySchema>;
