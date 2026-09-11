import {
  and,
  asc,
  desc,
  eq,
  inArray,
  knowledgeArticles,
  knowledgeArticleSources,
  knowledgeArticleVersions,
  lt,
  or,
  type KnowledgeContentBlockRecord,
  type KnowledgeContentOrigin,
  type KnowledgeReviewStatus,
} from '@mental-health/database';
import { Injectable } from '@nestjs/common';
import { DatabaseService } from '../database/database.service';

export type KnowledgeArticleReadRecord = Readonly<{
  articleKey: string;
  versionId: string;
  version: number;
  title: string;
  summary: string;
  contentBlocks: KnowledgeContentBlockRecord[];
  contentOrigin: KnowledgeContentOrigin;
  reviewStatus: KnowledgeReviewStatus;
  reviewedAt: Date | null;
  publishedAt: Date;
}>;

export type KnowledgeSourceRecord = Readonly<{
  articleVersionId: string;
  ordinal: number;
  publisherName: string;
  sourceTitle: string;
  sourceUrl: string;
  sourcePublishedAt: Date | null;
  sourceVersionLabel: string | null;
  sourceLocator: string | null;
  retrievedAt: Date;
}>;

type KnowledgeCursor = Readonly<{ publishedAt: Date; versionId: string }>;

@Injectable()
export class KnowledgeRepository {
  constructor(private readonly database: DatabaseService) {}

  protected async afterPublishedVersionsRead(): Promise<void> {
    return Promise.resolve();
  }

  private visiblePredicate(permitSynthetic: boolean) {
    return and(
      eq(knowledgeArticleVersions.publicationStatus, 'published'),
      or(
        and(
          eq(knowledgeArticleVersions.contentOrigin, 'curated'),
          eq(knowledgeArticleVersions.reviewStatus, 'source_verified'),
        ),
        permitSynthetic
          ? and(
              eq(knowledgeArticleVersions.contentOrigin, 'synthetic_fixture'),
              eq(knowledgeArticleVersions.reviewStatus, 'unverified'),
            )
          : undefined,
      ),
    );
  }

  async listPublished(input: {
    permitSynthetic: boolean;
    cursor: KnowledgeCursor | null;
    limit: number;
  }): Promise<Array<{ article: KnowledgeArticleReadRecord; sources: KnowledgeSourceRecord[] }>> {
    return this.database.database.transaction(
      async (transaction) => {
        const cursorPredicate = input.cursor
          ? or(
              lt(knowledgeArticleVersions.publishedAt, input.cursor.publishedAt),
              and(
                eq(knowledgeArticleVersions.publishedAt, input.cursor.publishedAt),
                lt(knowledgeArticleVersions.id, input.cursor.versionId),
              ),
            )
          : undefined;
        const rows = await transaction
          .select({
            articleKey: knowledgeArticles.articleKey,
            versionId: knowledgeArticleVersions.id,
            version: knowledgeArticleVersions.version,
            title: knowledgeArticleVersions.title,
            summary: knowledgeArticleVersions.summary,
            contentBlocks: knowledgeArticleVersions.contentBlocks,
            contentOrigin: knowledgeArticleVersions.contentOrigin,
            reviewStatus: knowledgeArticleVersions.reviewStatus,
            reviewedAt: knowledgeArticleVersions.reviewedAt,
            publishedAt: knowledgeArticleVersions.publishedAt,
          })
          .from(knowledgeArticleVersions)
          .innerJoin(
            knowledgeArticles,
            eq(knowledgeArticles.id, knowledgeArticleVersions.articleId),
          )
          .where(and(this.visiblePredicate(input.permitSynthetic), cursorPredicate))
          .orderBy(desc(knowledgeArticleVersions.publishedAt), desc(knowledgeArticleVersions.id))
          .limit(input.limit);
        await this.afterPublishedVersionsRead();

        const versionIds = rows.map((row) => row.versionId);
        const sources =
          versionIds.length === 0
            ? []
            : await transaction
                .select()
                .from(knowledgeArticleSources)
                .where(inArray(knowledgeArticleSources.articleVersionId, versionIds))
                .orderBy(
                  asc(knowledgeArticleSources.articleVersionId),
                  asc(knowledgeArticleSources.ordinal),
                );
        return rows.flatMap((row) => {
          if (!row.publishedAt) return [];
          return [
            {
              article: { ...row, publishedAt: row.publishedAt },
              sources: sources.filter((source) => source.articleVersionId === row.versionId),
            },
          ];
        });
      },
      { isolationLevel: 'repeatable read', accessMode: 'read only' },
    );
  }

  async findPublishedByKey(input: {
    articleKey: string;
    permitSynthetic: boolean;
  }): Promise<{ article: KnowledgeArticleReadRecord; sources: KnowledgeSourceRecord[] } | null> {
    return this.database.database.transaction(
      async (transaction) => {
        const [row] = await transaction
          .select({
            articleKey: knowledgeArticles.articleKey,
            versionId: knowledgeArticleVersions.id,
            version: knowledgeArticleVersions.version,
            title: knowledgeArticleVersions.title,
            summary: knowledgeArticleVersions.summary,
            contentBlocks: knowledgeArticleVersions.contentBlocks,
            contentOrigin: knowledgeArticleVersions.contentOrigin,
            reviewStatus: knowledgeArticleVersions.reviewStatus,
            reviewedAt: knowledgeArticleVersions.reviewedAt,
            publishedAt: knowledgeArticleVersions.publishedAt,
          })
          .from(knowledgeArticleVersions)
          .innerJoin(
            knowledgeArticles,
            eq(knowledgeArticles.id, knowledgeArticleVersions.articleId),
          )
          .where(
            and(
              eq(knowledgeArticles.articleKey, input.articleKey),
              this.visiblePredicate(input.permitSynthetic),
            ),
          )
          .limit(1);
        if (!row?.publishedAt) return null;
        await this.afterPublishedVersionsRead();
        const sources = await transaction
          .select()
          .from(knowledgeArticleSources)
          .where(eq(knowledgeArticleSources.articleVersionId, row.versionId))
          .orderBy(asc(knowledgeArticleSources.ordinal));
        return { article: { ...row, publishedAt: row.publishedAt }, sources };
      },
      { isolationLevel: 'repeatable read', accessMode: 'read only' },
    );
  }
}
