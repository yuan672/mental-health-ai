import {
  and,
  asc,
  assistantMessageKnowledgeReferences,
  conversations,
  eq,
  inArray,
  knowledgeArticles,
  knowledgeArticleSources,
  knowledgeArticleVersions,
  messages,
  type AppTransaction,
  type KnowledgeContentOrigin,
  type KnowledgePublicationStatus,
  type KnowledgeReviewStatus,
} from '@mental-health/database';
import { Injectable } from '@nestjs/common';
import { DatabaseService } from '../database/database.service';

export type StoredKnowledgeReferenceSource = Readonly<{
  ordinal: number;
  publisherName: string;
  sourceTitle: string;
  sourceUrl: string;
  sourcePublishedAt: Date | null;
  sourceVersionLabel: string | null;
  sourceLocator: string | null;
  retrievedAt: Date;
}>;

export type StoredKnowledgeReference = Readonly<{
  assistantMessageId: string;
  ordinal: number;
  articleVersionId: string;
  articleKey: string;
  version: number;
  title: string;
  publicationStatus: KnowledgePublicationStatus;
  contentOrigin: KnowledgeContentOrigin;
  reviewStatus: KnowledgeReviewStatus;
  reviewedAt: Date | null;
  sources: readonly StoredKnowledgeReferenceSource[];
}>;

export class KnowledgeReferenceInvariantError extends Error {
  constructor(message: string) {
    super(message);
    this.name = KnowledgeReferenceInvariantError.name;
  }
}

@Injectable()
export class KnowledgeMessageReferenceRepository {
  constructor(private readonly database: DatabaseService) {}

  async persistWithinTransaction(
    transaction: AppTransaction,
    input: Readonly<{
      assistantMessageId: string;
      articleVersionIds: readonly string[];
    }>,
  ): Promise<void> {
    if (input.articleVersionIds.length < 1 || input.articleVersionIds.length > 2) {
      throw new KnowledgeReferenceInvariantError(
        'Knowledge references must contain one or two versions',
      );
    }
    if (new Set(input.articleVersionIds).size !== input.articleVersionIds.length) {
      throw new KnowledgeReferenceInvariantError('Knowledge reference versions must be unique');
    }

    await transaction.insert(assistantMessageKnowledgeReferences).values(
      input.articleVersionIds.map((articleVersionId, index) => ({
        assistantMessageId: input.assistantMessageId,
        articleVersionId,
        ordinal: index + 1,
      })),
    );
  }

  async findOwnedByMessageIds(
    userId: string,
    assistantMessageIds: readonly string[],
  ): Promise<StoredKnowledgeReference[]> {
    if (assistantMessageIds.length === 0) return [];

    return this.database.database.transaction(
      async (transaction) => {
        const references = await transaction
          .select({
            assistantMessageId: assistantMessageKnowledgeReferences.assistantMessageId,
            ordinal: assistantMessageKnowledgeReferences.ordinal,
            articleVersionId: knowledgeArticleVersions.id,
            articleKey: knowledgeArticles.articleKey,
            version: knowledgeArticleVersions.version,
            title: knowledgeArticleVersions.title,
            publicationStatus: knowledgeArticleVersions.publicationStatus,
            contentOrigin: knowledgeArticleVersions.contentOrigin,
            reviewStatus: knowledgeArticleVersions.reviewStatus,
            reviewedAt: knowledgeArticleVersions.reviewedAt,
          })
          .from(assistantMessageKnowledgeReferences)
          .innerJoin(
            messages,
            eq(messages.id, assistantMessageKnowledgeReferences.assistantMessageId),
          )
          .innerJoin(conversations, eq(conversations.id, messages.conversationId))
          .innerJoin(
            knowledgeArticleVersions,
            eq(knowledgeArticleVersions.id, assistantMessageKnowledgeReferences.articleVersionId),
          )
          .innerJoin(
            knowledgeArticles,
            eq(knowledgeArticles.id, knowledgeArticleVersions.articleId),
          )
          .where(
            and(
              eq(conversations.userId, userId),
              inArray(messages.id, [...assistantMessageIds]),
              eq(messages.role, 'assistant'),
            ),
          )
          .orderBy(
            asc(assistantMessageKnowledgeReferences.assistantMessageId),
            asc(assistantMessageKnowledgeReferences.ordinal),
          );

        const versionIds = [...new Set(references.map((reference) => reference.articleVersionId))];
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

        return references.map((reference) => ({
          ...reference,
          sources: sources
            .filter((source) => source.articleVersionId === reference.articleVersionId)
            .map((source) => ({
              ordinal: source.ordinal,
              publisherName: source.publisherName,
              sourceTitle: source.sourceTitle,
              sourceUrl: source.sourceUrl,
              sourcePublishedAt: source.sourcePublishedAt,
              sourceVersionLabel: source.sourceVersionLabel,
              sourceLocator: source.sourceLocator,
              retrievedAt: source.retrievedAt,
            })),
        }));
      },
      { isolationLevel: 'repeatable read', accessMode: 'read only' },
    );
  }
}
