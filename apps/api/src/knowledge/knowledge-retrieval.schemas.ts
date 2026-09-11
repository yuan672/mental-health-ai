import { z } from 'zod';
import {
  KNOWLEDGE_MAX_SOURCES,
  knowledgeArticleKeySchema,
  knowledgeContentBlocksSchema,
} from './knowledge.schemas';

function boundedStoredText(maximum: number, label: string) {
  return z
    .string()
    .refine((value) => value.trim().length > 0, `${label}不能为空`)
    .refine((value) => Array.from(value).length <= maximum, `${label}过长`);
}

const storedIsoDateTimeSchema = z.string().datetime({ offset: true });

export const credentialFreeHttpsUrlSchema = z
  .string()
  .url()
  .max(2_048)
  .refine((value) => {
    const url = new URL(value);
    return url.protocol === 'https:' && url.username.length === 0 && url.password.length === 0;
  }, '来源地址必须是无凭据的 HTTPS URL');

export const knowledgeRetrievalSourceSchema = z
  .object({
    ordinal: z.number().int().positive(),
    publisherName: boundedStoredText(160, '来源发布者'),
    sourceTitle: boundedStoredText(320, '来源标题'),
    sourceUrl: credentialFreeHttpsUrlSchema,
    sourcePublishedAt: storedIsoDateTimeSchema.nullable(),
    sourceVersionLabel: boundedStoredText(120, '来源版本').nullable(),
    sourceLocator: boundedStoredText(160, '来源定位').nullable(),
    retrievedAt: storedIsoDateTimeSchema,
  })
  .strict();

export const knowledgeRetrievalCandidateSchema = z
  .object({
    articleKey: knowledgeArticleKeySchema,
    versionId: z.string().uuid(),
    version: z.number().int().positive(),
    title: boundedStoredText(160, '文章标题'),
    summary: boundedStoredText(320, '文章摘要'),
    contentBlocks: knowledgeContentBlocksSchema,
    publicationStatus: z.literal('published'),
    contentOrigin: z.enum(['curated', 'synthetic_fixture']),
    reviewStatus: z.enum(['unverified', 'source_verified', 'professional_reviewed']),
    reviewedBy: boundedStoredText(128, '核验人标识').nullable(),
    reviewedAt: storedIsoDateTimeSchema.nullable(),
    publishedAt: storedIsoDateTimeSchema,
    sources: z.array(knowledgeRetrievalSourceSchema).min(1).max(KNOWLEDGE_MAX_SOURCES),
  })
  .strict()
  .superRefine((candidate, context) => {
    for (const [index, source] of candidate.sources.entries()) {
      if (source.ordinal !== index + 1) {
        context.addIssue({
          code: 'custom',
          path: ['sources', index, 'ordinal'],
          message: '来源顺序必须从 1 连续递增',
        });
      }
    }
  });

export type KnowledgeRetrievalSource = z.infer<typeof knowledgeRetrievalSourceSchema>;
export type KnowledgeRetrievalCandidate = z.infer<typeof knowledgeRetrievalCandidateSchema>;
