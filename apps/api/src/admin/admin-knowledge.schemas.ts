import { z } from 'zod';
import {
  KNOWLEDGE_MAX_SOURCES,
  knowledgeArticleKeySchema,
  knowledgeContentBlocksSchema,
  knowledgeSourceInputSchema,
} from '../knowledge/knowledge.schemas';

function boundedText(maximum: number, label: string) {
  return z
    .string()
    .transform((value) => value.trim())
    .refine((value) => value.length > 0, `${label}不能为空`)
    .refine((value) => Array.from(value).length <= maximum, `${label}过长`);
}

export const adminKnowledgeVersionParamsSchema = z
  .object({
    articleKey: knowledgeArticleKeySchema,
    version: z.coerce.number().int().positive(),
  })
  .strict();

export const adminKnowledgeCandidateSchema = z
  .object({
    title: boundedText(160, '文章标题'),
    summary: boundedText(320, '文章摘要'),
    contentBlocks: knowledgeContentBlocksSchema,
    sources: z.array(knowledgeSourceInputSchema).min(1).max(KNOWLEDGE_MAX_SOURCES),
  })
  .strict();

export const adminKnowledgeReplaceSchema = z
  .object({
    expectedDraftRevision: z.number().int().positive(),
    candidate: adminKnowledgeCandidateSchema,
  })
  .strict();

export const adminKnowledgeExpectedRevisionSchema = z
  .object({ expectedDraftRevision: z.number().int().positive() })
  .strict();

export const adminKnowledgeSourceReviewSchema = adminKnowledgeExpectedRevisionSchema
  .extend({ confirmation: z.literal('source_verified') })
  .strict();

export const adminKnowledgeListQuerySchema = z
  .object({
    cursor: z.string().min(1).max(1_024).optional(),
    limit: z.coerce.number().int().min(1).max(50).default(20),
  })
  .strict();

export const adminKnowledgeCursorSchema = z
  .object({
    kind: z.literal('admin-knowledge-articles'),
    version: z.literal(1),
    createdAt: z.string().datetime({ offset: true }),
    id: z.string().uuid(),
  })
  .strict();

export const adminKnowledgeWorkflowStateSchema = z
  .object({
    articleId: z.string().uuid(),
    articleKey: knowledgeArticleKeySchema,
    versionId: z.string().uuid(),
    version: z.number().int().positive(),
    draftRevision: z.number().int().positive(),
    contentOrigin: z.literal('curated'),
    reviewStatus: z.enum(['unverified', 'source_verified', 'professional_reviewed']),
    publicationStatus: z.enum(['draft', 'published', 'withdrawn']),
    publicationEligible: z.boolean(),
    createdAt: z.string().datetime({ offset: true }),
    reviewedAt: z.string().datetime({ offset: true }).nullable(),
    publishedAt: z.string().datetime({ offset: true }).nullable(),
    withdrawnAt: z.string().datetime({ offset: true }).nullable(),
  })
  .strict();

export const adminKnowledgeDirectoryItemSchema = z
  .object({
    articleId: z.string().uuid(),
    articleKey: knowledgeArticleKeySchema,
    highestVersion: z.number().int().positive(),
    currentPublishedVersion: z.number().int().positive().nullable(),
    editableDraftVersion: z.number().int().positive().nullable(),
    latestVerifiedCandidateVersion: z.number().int().positive().nullable(),
    articleCreatedAt: z.string().datetime({ offset: true }),
  })
  .strict();

export const adminKnowledgeDirectoryDataSchema = z
  .object({
    items: z.array(adminKnowledgeDirectoryItemSchema),
    nextCursor: z.string().nullable(),
  })
  .strict();

export const adminKnowledgeStatusDataSchema = z
  .object({ state: adminKnowledgeWorkflowStateSchema })
  .strict();

export const adminKnowledgeMutationDataSchema = z
  .object({
    disposition: z.enum(['applied', 'no_change']),
    state: adminKnowledgeWorkflowStateSchema,
  })
  .strict();

export const adminKnowledgeCandidateDataSchema = z
  .object({
    state: adminKnowledgeWorkflowStateSchema,
    candidate: adminKnowledgeCandidateSchema,
  })
  .strict();

export const adminKnowledgeSourceReviewDataSchema = z
  .object({
    disposition: z.enum(['applied', 'no_change']),
    articleKey: knowledgeArticleKeySchema,
    version: z.number().int().positive(),
    draftRevision: z.number().int().positive(),
    reviewStatus: z.literal('source_verified'),
    reviewedBy: z.string().uuid(),
    reviewedAt: z.string().datetime({ offset: true }),
  })
  .strict();

export const adminKnowledgePublicationSourceSchema = knowledgeSourceInputSchema.omit({
  sourceUrl: true,
});

export const adminKnowledgePublicationStateDataSchema = z
  .object({
    state: adminKnowledgeWorkflowStateSchema,
    reviewedBy: z.string().min(1).max(128).nullable(),
    sources: z.array(adminKnowledgePublicationSourceSchema).min(1).max(KNOWLEDGE_MAX_SOURCES),
  })
  .strict();

export type AdminKnowledgeVersionParams = z.infer<typeof adminKnowledgeVersionParamsSchema>;
export type AdminKnowledgeCandidate = z.infer<typeof adminKnowledgeCandidateSchema>;
export type AdminKnowledgeReplaceRequest = z.infer<typeof adminKnowledgeReplaceSchema>;
export type AdminKnowledgeExpectedRevisionRequest = z.infer<
  typeof adminKnowledgeExpectedRevisionSchema
>;
export type AdminKnowledgeSourceReviewRequest = z.infer<typeof adminKnowledgeSourceReviewSchema>;
export type AdminKnowledgeListQuery = z.infer<typeof adminKnowledgeListQuerySchema>;
