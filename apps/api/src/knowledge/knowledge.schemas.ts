import { z } from 'zod';

export const KNOWLEDGE_DEFAULT_PAGE_LIMIT = 20;
export const KNOWLEDGE_MAX_PAGE_LIMIT = 50;
export const KNOWLEDGE_MAX_BLOCKS = 100;
export const KNOWLEDGE_MAX_SOURCES = 20;
export const KNOWLEDGE_MAX_TOTAL_CONTENT_CODE_POINTS = 30_000;

function boundedText(maximum: number, label: string) {
  return z
    .string()
    .transform((value) => value.trim())
    .refine((value) => value.length > 0, `${label}不能为空`)
    .refine((value) => Array.from(value).length <= maximum, `${label}过长`);
}

const nullableBoundedText = (maximum: number, label: string) =>
  boundedText(maximum, label).nullable();

const isoDateTimeSchema = z
  .string()
  .datetime({ offset: true })
  .transform((value) => new Date(value).toISOString());

const httpsUrlSchema = z
  .string()
  .url()
  .max(2_048)
  .transform((value, context) => {
    const url = new URL(value);
    if (url.protocol !== 'https:' || url.username.length > 0 || url.password.length > 0) {
      context.addIssue({ code: 'custom', message: '来源地址必须是无凭据的 HTTPS URL' });
      return z.NEVER;
    }
    return url.toString();
  });

export const knowledgeArticleKeySchema = z
  .string()
  .min(1)
  .max(100)
  .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/u);

const knowledgeHeadingBlockSchema = z
  .object({
    type: z.literal('heading'),
    level: z.union([z.literal(2), z.literal(3)]),
    text: boundedText(160, '标题块'),
  })
  .strict();

const knowledgeParagraphBlockSchema = z
  .object({ type: z.literal('paragraph'), text: boundedText(2_000, '段落') })
  .strict();

const knowledgeListBlockSchema = z
  .object({
    type: z.literal('list'),
    style: z.enum(['ordered', 'unordered']),
    items: z.array(boundedText(500, '列表项')).min(1).max(20),
  })
  .strict();

const knowledgeCalloutBlockSchema = z
  .object({
    type: z.literal('callout'),
    tone: z.enum(['information', 'important']),
    text: boundedText(2_000, '提示块'),
  })
  .strict();

export const knowledgeContentBlockSchema = z.discriminatedUnion('type', [
  knowledgeHeadingBlockSchema,
  knowledgeParagraphBlockSchema,
  knowledgeListBlockSchema,
  knowledgeCalloutBlockSchema,
]);

export const knowledgeContentBlocksSchema = z
  .array(knowledgeContentBlockSchema)
  .min(1)
  .max(KNOWLEDGE_MAX_BLOCKS)
  .refine(
    (blocks) =>
      blocks.reduce((total, block) => {
        if (block.type === 'list') {
          return (
            total + block.items.reduce((itemTotal, item) => itemTotal + Array.from(item).length, 0)
          );
        }
        return total + Array.from(block.text).length;
      }, 0) <= KNOWLEDGE_MAX_TOTAL_CONTENT_CODE_POINTS,
    '知识正文总长度过长',
  );

export const knowledgeSourceInputSchema = z
  .object({
    publisherName: boundedText(160, '来源发布者'),
    sourceTitle: boundedText(320, '来源标题'),
    sourceUrl: httpsUrlSchema,
    sourcePublishedAt: isoDateTimeSchema.nullable(),
    sourceVersionLabel: nullableBoundedText(120, '来源版本'),
    sourceLocator: nullableBoundedText(160, '来源定位'),
    retrievedAt: isoDateTimeSchema,
  })
  .strict();

const manifestCommonShape = {
  articleKey: knowledgeArticleKeySchema,
  version: z.number().int().positive(),
  title: boundedText(160, '文章标题'),
  summary: boundedText(320, '文章摘要'),
  contentBlocks: knowledgeContentBlocksSchema,
  sources: z.array(knowledgeSourceInputSchema).min(1).max(KNOWLEDGE_MAX_SOURCES),
};

export const curatedKnowledgeManifestSchema = z
  .object({
    ...manifestCommonShape,
    contentOrigin: z.literal('curated'),
    reviewStatus: z.literal('source_verified'),
    reviewedBy: boundedText(128, '核验人标识'),
    reviewedAt: isoDateTimeSchema,
  })
  .strict();

export const syntheticKnowledgeManifestSchema = z
  .object({
    ...manifestCommonShape,
    contentOrigin: z.literal('synthetic_fixture'),
    reviewStatus: z.literal('unverified'),
    reviewedBy: z.null(),
    reviewedAt: z.null(),
  })
  .strict();

export const knowledgeManifestSchema = z.discriminatedUnion('contentOrigin', [
  curatedKnowledgeManifestSchema,
  syntheticKnowledgeManifestSchema,
]);

export const knowledgeArticleListQuerySchema = z
  .object({
    cursor: z.string().min(1).max(1_024).optional(),
    limit: z.coerce
      .number()
      .int()
      .min(1)
      .max(KNOWLEDGE_MAX_PAGE_LIMIT)
      .default(KNOWLEDGE_DEFAULT_PAGE_LIMIT),
  })
  .strict();

export const knowledgeArticleParamsSchema = z
  .object({ articleKey: knowledgeArticleKeySchema })
  .strict();

export const knowledgeArticleCursorSchema = z
  .object({
    kind: z.literal('knowledge-articles'),
    version: z.literal(1),
    publishedAt: z.string().datetime({ offset: true }),
    versionId: z.string().uuid(),
  })
  .strict();

const publicKnowledgeSourceSchema = z
  .object({
    publisherName: z.string().min(1).max(160),
    sourceTitle: z.string().min(1).max(320),
    sourceUrl: z
      .string()
      .url()
      .refine((value) => new URL(value).protocol === 'https:'),
    sourcePublishedAt: z.string().datetime({ offset: true }).nullable(),
    sourceVersionLabel: z.string().min(1).max(120).nullable(),
    sourceLocator: z.string().min(1).max(160).nullable(),
    retrievedAt: z.string().datetime({ offset: true }),
  })
  .strict();

const publicKnowledgeSummarySchema = z
  .object({
    articleKey: knowledgeArticleKeySchema,
    title: z.string().min(1).max(160),
    summary: z.string().min(1).max(320),
    version: z.number().int().positive(),
    contentOrigin: z.enum(['curated', 'synthetic_fixture']),
    reviewStatus: z.enum(['unverified', 'source_verified', 'professional_reviewed']),
    reviewedAt: z.string().datetime({ offset: true }).nullable(),
    publishedAt: z.string().datetime({ offset: true }),
    sourcePublishers: z.array(z.string().min(1).max(160)).max(KNOWLEDGE_MAX_SOURCES),
  })
  .strict();

export const knowledgeArticleListResponseSchema = z
  .object({
    success: z.literal(true),
    data: z
      .object({
        items: z.array(publicKnowledgeSummarySchema),
        nextCursor: z.string().nullable(),
      })
      .strict(),
  })
  .strict();

export const knowledgeArticleDetailResponseSchema = z
  .object({
    success: z.literal(true),
    data: z
      .object({
        article: publicKnowledgeSummarySchema
          .extend({
            contentBlocks: knowledgeContentBlocksSchema,
            sources: z.array(publicKnowledgeSourceSchema).min(1).max(KNOWLEDGE_MAX_SOURCES),
          })
          .strict(),
      })
      .strict(),
  })
  .strict();

export type KnowledgeArticleListQuery = z.infer<typeof knowledgeArticleListQuerySchema>;
export type KnowledgeArticleParams = z.infer<typeof knowledgeArticleParamsSchema>;
export type KnowledgeManifest = z.infer<typeof knowledgeManifestSchema>;
export type CuratedKnowledgeManifest = z.infer<typeof curatedKnowledgeManifestSchema>;
export type SyntheticKnowledgeManifest = z.infer<typeof syntheticKnowledgeManifestSchema>;
