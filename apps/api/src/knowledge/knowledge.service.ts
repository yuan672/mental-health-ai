import type {
  KnowledgeArticleDetail,
  KnowledgeArticleDetailResponse,
  KnowledgeArticleListResponse,
  KnowledgeArticleSource,
  KnowledgeArticleSummary,
} from '@mental-health/types';
import { Injectable } from '@nestjs/common';
import { DatabaseError, KnowledgeArticleNotFoundError } from '../common/errors';
import { decodeOpaqueCursor, encodeOpaqueCursor } from '../common/pagination/opaque-cursor';
import {
  knowledgeArticleCursorSchema,
  knowledgeArticleDetailResponseSchema,
  knowledgeArticleListResponseSchema,
  type KnowledgeArticleListQuery,
} from './knowledge.schemas';
import {
  KnowledgeRepository,
  type KnowledgeArticleReadRecord,
  type KnowledgeSourceRecord,
} from './knowledge.repository';
import { KnowledgeVisibilityPolicy } from './knowledge-visibility.policy';

function toSource(source: KnowledgeSourceRecord): KnowledgeArticleSource {
  return {
    publisherName: source.publisherName,
    sourceTitle: source.sourceTitle,
    sourceUrl: source.sourceUrl,
    sourcePublishedAt: source.sourcePublishedAt?.toISOString() ?? null,
    sourceVersionLabel: source.sourceVersionLabel,
    sourceLocator: source.sourceLocator,
    retrievedAt: source.retrievedAt.toISOString(),
  };
}

function toSummary(
  article: KnowledgeArticleReadRecord,
  sources: KnowledgeSourceRecord[],
): KnowledgeArticleSummary {
  return {
    articleKey: article.articleKey,
    title: article.title,
    summary: article.summary,
    version: article.version,
    contentOrigin: article.contentOrigin,
    reviewStatus: article.reviewStatus,
    reviewedAt: article.reviewedAt?.toISOString() ?? null,
    publishedAt: article.publishedAt.toISOString(),
    sourcePublishers: [...new Set(sources.map((source) => source.publisherName))],
  };
}

@Injectable()
export class KnowledgeService {
  constructor(
    private readonly repository: KnowledgeRepository,
    private readonly visibility: KnowledgeVisibilityPolicy,
  ) {}

  async list(query: KnowledgeArticleListQuery): Promise<KnowledgeArticleListResponse> {
    const cursor = decodeOpaqueCursor(query.cursor, knowledgeArticleCursorSchema);
    let rows: Awaited<ReturnType<KnowledgeRepository['listPublished']>>;
    try {
      rows = await this.repository.listPublished({
        permitSynthetic: this.visibility.permitsSynthetic(),
        cursor: cursor
          ? { publishedAt: new Date(cursor.publishedAt), versionId: cursor.versionId }
          : null,
        limit: query.limit + 1,
      });
    } catch {
      throw new DatabaseError();
    }
    const hasNextPage = rows.length > query.limit;
    const page = rows.slice(0, query.limit);
    const last = page.at(-1)?.article;
    return knowledgeArticleListResponseSchema.parse({
      success: true,
      data: {
        items: page.map(({ article, sources }) => toSummary(article, sources)),
        nextCursor:
          hasNextPage && last
            ? encodeOpaqueCursor({
                kind: 'knowledge-articles',
                version: 1,
                publishedAt: last.publishedAt.toISOString(),
                versionId: last.versionId,
              })
            : null,
      },
    });
  }

  async get(articleKey: string): Promise<KnowledgeArticleDetailResponse> {
    let row: Awaited<ReturnType<KnowledgeRepository['findPublishedByKey']>>;
    try {
      row = await this.repository.findPublishedByKey({
        articleKey,
        permitSynthetic: this.visibility.permitsSynthetic(),
      });
    } catch {
      throw new DatabaseError();
    }
    if (!row) throw new KnowledgeArticleNotFoundError();
    const article: KnowledgeArticleDetail = {
      ...toSummary(row.article, row.sources),
      contentBlocks: row.article.contentBlocks,
      sources: row.sources.map(toSource),
    };
    return knowledgeArticleDetailResponseSchema.parse({ success: true, data: { article } });
  }
}
