import {
  and,
  asc,
  eq,
  inArray,
  isNotNull,
  isNull,
  knowledgeArticles,
  knowledgeArticleSources,
  knowledgeArticleVersions,
  or,
  sql,
  type AppTransaction,
  type KnowledgeContentBlockRecord,
  type KnowledgeContentOrigin,
  type KnowledgeReviewStatus,
} from '@mental-health/database';
import { Injectable } from '@nestjs/common';
import { DatabaseService } from '../database/database.service';
import { KNOWLEDGE_RETRIEVAL_SCAN_LIMIT } from './knowledge-retrieval.policy';

export type KnowledgeRetrievalCandidateRecord = Readonly<{
  articleKey: string;
  versionId: string;
  version: number;
  title: string;
  summary: string;
  contentBlocks: KnowledgeContentBlockRecord[];
  publicationStatus: 'published';
  contentOrigin: KnowledgeContentOrigin;
  reviewStatus: KnowledgeReviewStatus;
  reviewedBy: string | null;
  reviewedAt: Date | null;
  publishedAt: Date;
  sources: readonly KnowledgeRetrievalSourceRecord[];
}>;

export type KnowledgeRetrievalSourceRecord = Readonly<{
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

export type KnowledgeRetrievalSnapshot = Readonly<
  | { candidateLimitExceeded: true; candidates: readonly [] }
  | {
      candidateLimitExceeded: false;
      candidates: readonly KnowledgeRetrievalCandidateRecord[];
    }
>;

@Injectable()
export class KnowledgeRetrievalRepository {
  constructor(private readonly database: DatabaseService) {}

  protected async afterCandidateVersionsRead(_transaction: AppTransaction): Promise<void> {
    void _transaction;
    return Promise.resolve();
  }

  protected async afterCurrentnessRead(_transaction: AppTransaction): Promise<void> {
    void _transaction;
    return Promise.resolve();
  }

  async readCandidateSnapshot(input: {
    permitSynthetic: boolean;
    statementTimeoutMs: number;
  }): Promise<KnowledgeRetrievalSnapshot> {
    return this.database.database.transaction(
      async (transaction) => {
        await this.setStatementTimeout(transaction, input.statementTimeoutMs);
        const rows = await transaction
          .select({
            articleKey: knowledgeArticles.articleKey,
            versionId: knowledgeArticleVersions.id,
            version: knowledgeArticleVersions.version,
            title: knowledgeArticleVersions.title,
            summary: knowledgeArticleVersions.summary,
            contentBlocks: knowledgeArticleVersions.contentBlocks,
            publicationStatus: knowledgeArticleVersions.publicationStatus,
            contentOrigin: knowledgeArticleVersions.contentOrigin,
            reviewStatus: knowledgeArticleVersions.reviewStatus,
            reviewedBy: knowledgeArticleVersions.reviewedBy,
            reviewedAt: knowledgeArticleVersions.reviewedAt,
            publishedAt: knowledgeArticleVersions.publishedAt,
          })
          .from(knowledgeArticleVersions)
          .innerJoin(
            knowledgeArticles,
            eq(knowledgeArticles.id, knowledgeArticleVersions.articleId),
          )
          .where(this.eligiblePredicate(input.permitSynthetic))
          .orderBy(asc(knowledgeArticles.articleKey), asc(knowledgeArticleVersions.version))
          .limit(KNOWLEDGE_RETRIEVAL_SCAN_LIMIT);
        await this.afterCandidateVersionsRead(transaction);

        if (rows.length === KNOWLEDGE_RETRIEVAL_SCAN_LIMIT) {
          return { candidateLimitExceeded: true, candidates: [] };
        }

        const eligibleRows = rows.flatMap((row) =>
          row.publicationStatus === 'published' && row.publishedAt
            ? [{ ...row, publicationStatus: 'published' as const, publishedAt: row.publishedAt }]
            : [],
        );
        const versionIds = eligibleRows.map((row) => row.versionId);
        const sources =
          versionIds.length === 0
            ? []
            : await transaction
                .select({
                  articleVersionId: knowledgeArticleSources.articleVersionId,
                  ordinal: knowledgeArticleSources.ordinal,
                  publisherName: knowledgeArticleSources.publisherName,
                  sourceTitle: knowledgeArticleSources.sourceTitle,
                  sourceUrl: knowledgeArticleSources.sourceUrl,
                  sourcePublishedAt: knowledgeArticleSources.sourcePublishedAt,
                  sourceVersionLabel: knowledgeArticleSources.sourceVersionLabel,
                  sourceLocator: knowledgeArticleSources.sourceLocator,
                  retrievedAt: knowledgeArticleSources.retrievedAt,
                })
                .from(knowledgeArticleSources)
                .where(inArray(knowledgeArticleSources.articleVersionId, versionIds))
                .orderBy(
                  asc(knowledgeArticleSources.articleVersionId),
                  asc(knowledgeArticleSources.ordinal),
                );

        return {
          candidateLimitExceeded: false,
          candidates: eligibleRows.map((row) => ({
            ...row,
            sources: sources.filter((source) => source.articleVersionId === row.versionId),
          })),
        };
      },
      { isolationLevel: 'repeatable read', accessMode: 'read only' },
    );
  }

  async areExactVersionsCurrent(input: {
    versionIds: readonly string[];
    permitSynthetic: boolean;
    statementTimeoutMs: number;
  }): Promise<boolean> {
    if (input.versionIds.length === 0) return true;
    const uniqueVersionIds = Array.from(new Set(input.versionIds));
    if (uniqueVersionIds.length !== input.versionIds.length) return false;

    return this.database.database.transaction(
      async (transaction) => {
        await this.setStatementTimeout(transaction, input.statementTimeoutMs);
        const rows = await transaction
          .select({ versionId: knowledgeArticleVersions.id })
          .from(knowledgeArticleVersions)
          .innerJoin(
            knowledgeArticles,
            eq(knowledgeArticles.id, knowledgeArticleVersions.articleId),
          )
          .where(
            and(
              inArray(knowledgeArticleVersions.id, uniqueVersionIds),
              this.eligiblePredicate(input.permitSynthetic),
            ),
          );
        await this.afterCurrentnessRead(transaction);
        return (
          rows.length === uniqueVersionIds.length &&
          rows.every((row) => uniqueVersionIds.includes(row.versionId))
        );
      },
      { isolationLevel: 'repeatable read', accessMode: 'read only' },
    );
  }

  private eligiblePredicate(permitSynthetic: boolean) {
    return and(
      eq(knowledgeArticleVersions.publicationStatus, 'published'),
      isNotNull(knowledgeArticleVersions.publishedAt),
      sql`EXISTS (
        SELECT 1
        FROM knowledge_article_sources AS retrieval_source
        WHERE retrieval_source.article_version_id = ${knowledgeArticleVersions.id}
      )`,
      or(
        and(
          eq(knowledgeArticleVersions.contentOrigin, 'curated'),
          eq(knowledgeArticleVersions.reviewStatus, 'source_verified'),
          isNotNull(knowledgeArticleVersions.reviewedBy),
          isNotNull(knowledgeArticleVersions.reviewedAt),
        ),
        permitSynthetic
          ? and(
              eq(knowledgeArticleVersions.contentOrigin, 'synthetic_fixture'),
              eq(knowledgeArticleVersions.reviewStatus, 'unverified'),
              isNull(knowledgeArticleVersions.reviewedBy),
              isNull(knowledgeArticleVersions.reviewedAt),
            )
          : undefined,
      ),
    );
  }

  private async setStatementTimeout(
    transaction: AppTransaction,
    statementTimeoutMs: number,
  ): Promise<void> {
    const timeout = `${Math.max(1, Math.floor(statementTimeoutMs))}ms`;
    await transaction.execute(sql`SELECT set_config('statement_timeout', ${timeout}, true)`);
  }
}
