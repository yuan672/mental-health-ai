import type {
  KnowledgeArticleDetailResponse,
  KnowledgeArticleListResponse,
} from '@mental-health/types';
import { z } from 'zod';
import { apiRequest } from './client';

const dateTimeSchema = z.string().datetime({ offset: true });
const boundedText = (maximum: number) => z.string().min(1).max(maximum);
const articleKeySchema = z
  .string()
  .min(1)
  .max(100)
  .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/u);
const safeSourceUrlSchema = z
  .string()
  .url()
  .max(2_048)
  .refine((value) => {
    const url = new URL(value);
    return url.protocol === 'https:' && url.username.length === 0 && url.password.length === 0;
  });

const headingBlockSchema = z
  .object({
    type: z.literal('heading'),
    level: z.union([z.literal(2), z.literal(3)]),
    text: boundedText(160),
  })
  .strict();
const paragraphBlockSchema = z
  .object({ type: z.literal('paragraph'), text: boundedText(2_000) })
  .strict();
const listBlockSchema = z
  .object({
    type: z.literal('list'),
    style: z.enum(['ordered', 'unordered']),
    items: z.array(boundedText(500)).min(1).max(20),
  })
  .strict();
const calloutBlockSchema = z
  .object({
    type: z.literal('callout'),
    tone: z.enum(['information', 'important']),
    text: boundedText(2_000),
  })
  .strict();
const contentBlockSchema = z.discriminatedUnion('type', [
  headingBlockSchema,
  paragraphBlockSchema,
  listBlockSchema,
  calloutBlockSchema,
]);

const publicSummarySchema = z
  .object({
    articleKey: articleKeySchema,
    title: boundedText(160),
    summary: boundedText(320),
    version: z.number().int().positive(),
    contentOrigin: z.enum(['curated', 'synthetic_fixture']),
    reviewStatus: z.enum(['unverified', 'source_verified']),
    reviewedAt: dateTimeSchema.nullable(),
    publishedAt: dateTimeSchema,
    sourcePublishers: z.array(boundedText(160)).max(20),
  })
  .strict()
  .superRefine((article, context) => {
    if (article.contentOrigin === 'synthetic_fixture') {
      if (article.reviewStatus !== 'unverified' || article.reviewedAt !== null) {
        context.addIssue({ code: 'custom', message: '测试内容的审核标记无效' });
      }
      return;
    }
    if (article.reviewStatus !== 'source_verified' || article.reviewedAt === null) {
      context.addIssue({ code: 'custom', message: '正式内容的来源核验标记无效' });
    }
  });

const sourceSchema = z
  .object({
    publisherName: boundedText(160),
    sourceTitle: boundedText(320),
    sourceUrl: safeSourceUrlSchema,
    sourcePublishedAt: dateTimeSchema.nullable(),
    sourceVersionLabel: boundedText(120).nullable(),
    sourceLocator: boundedText(160).nullable(),
    retrievedAt: dateTimeSchema,
  })
  .strict();

export const knowledgeArticleListResponseSchema = z
  .object({
    success: z.literal(true),
    data: z
      .object({
        items: z.array(publicSummarySchema),
        nextCursor: z.string().min(1).max(1_024).nullable(),
      })
      .strict(),
  })
  .strict();

export const knowledgeArticleDetailResponseSchema = z
  .object({
    success: z.literal(true),
    data: z
      .object({
        article: publicSummarySchema
          .safeExtend({
            contentBlocks: z.array(contentBlockSchema).min(1).max(100),
            sources: z.array(sourceSchema).min(1).max(20),
          })
          .strict(),
      })
      .strict(),
  })
  .strict();

export function listKnowledgeArticles(
  cursor?: string | null,
  signal?: AbortSignal,
): Promise<KnowledgeArticleListResponse> {
  const query = new URLSearchParams({ limit: '20' });
  if (cursor) query.set('cursor', cursor);
  return apiRequest(
    `/knowledge/articles?${query.toString()}`,
    knowledgeArticleListResponseSchema,
    signal ? { signal } : {},
  );
}

export function getKnowledgeArticle(
  articleKey: string,
  signal?: AbortSignal,
): Promise<KnowledgeArticleDetailResponse> {
  return apiRequest(
    `/knowledge/articles/${encodeURIComponent(articleKey)}`,
    knowledgeArticleDetailResponseSchema,
    signal ? { signal } : {},
  );
}
