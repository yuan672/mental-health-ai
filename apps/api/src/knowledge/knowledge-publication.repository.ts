import { randomUUID } from 'node:crypto';
import {
  asc,
  desc,
  eq,
  knowledgeArticles,
  knowledgeArticleSources,
  knowledgeArticleVersions,
  type AppTransaction,
} from '@mental-health/database';
import { Injectable } from '@nestjs/common';
import { DatabaseService } from '../database/database.service';
import type { KnowledgeManifest } from './knowledge.schemas';

export type KnowledgeArticleRecord = typeof knowledgeArticles.$inferSelect;
export type KnowledgeVersionRecord = typeof knowledgeArticleVersions.$inferSelect;
export type KnowledgeSourceEvidenceRecord = typeof knowledgeArticleSources.$inferSelect;

@Injectable()
export class KnowledgePublicationRepository {
  constructor(private readonly database: DatabaseService) {}

  runInTransaction<T>(work: (transaction: AppTransaction) => Promise<T>): Promise<T> {
    return this.database.database.transaction(work);
  }

  async findHighestCommittedVersion(articleKey: string): Promise<number | null> {
    const [row] = await this.database.database
      .select({ version: knowledgeArticleVersions.version })
      .from(knowledgeArticleVersions)
      .innerJoin(knowledgeArticles, eq(knowledgeArticles.id, knowledgeArticleVersions.articleId))
      .where(eq(knowledgeArticles.articleKey, articleKey))
      .orderBy(desc(knowledgeArticleVersions.version))
      .limit(1);
    return row?.version ?? null;
  }

  async ensureAndLockArticle(
    transaction: AppTransaction,
    articleKey: string,
    now: Date,
  ): Promise<KnowledgeArticleRecord> {
    await transaction
      .insert(knowledgeArticles)
      .values({ id: randomUUID(), articleKey, createdAt: now })
      .onConflictDoNothing({ target: knowledgeArticles.articleKey });
    const [article] = await transaction
      .select()
      .from(knowledgeArticles)
      .where(eq(knowledgeArticles.articleKey, articleKey))
      .limit(1)
      .for('update');
    if (!article) throw new Error('Knowledge article lock target was not visible');
    return article;
  }

  async lockArticle(
    transaction: AppTransaction,
    articleKey: string,
  ): Promise<KnowledgeArticleRecord | null> {
    const [article] = await transaction
      .select()
      .from(knowledgeArticles)
      .where(eq(knowledgeArticles.articleKey, articleKey))
      .limit(1)
      .for('update');
    return article ?? null;
  }

  listVersions(transaction: AppTransaction, articleId: string): Promise<KnowledgeVersionRecord[]> {
    return transaction
      .select()
      .from(knowledgeArticleVersions)
      .where(eq(knowledgeArticleVersions.articleId, articleId))
      .orderBy(asc(knowledgeArticleVersions.version));
  }

  listSources(
    transaction: AppTransaction,
    articleVersionId: string,
  ): Promise<KnowledgeSourceEvidenceRecord[]> {
    return transaction
      .select()
      .from(knowledgeArticleSources)
      .where(eq(knowledgeArticleSources.articleVersionId, articleVersionId))
      .orderBy(asc(knowledgeArticleSources.ordinal));
  }

  async insertDraftVersion(
    transaction: AppTransaction,
    articleId: string,
    manifest: KnowledgeManifest,
    now: Date,
  ): Promise<KnowledgeVersionRecord> {
    const [version] = await transaction
      .insert(knowledgeArticleVersions)
      .values({
        id: randomUUID(),
        articleId,
        version: manifest.version,
        title: manifest.title,
        summary: manifest.summary,
        contentBlocks: manifest.contentBlocks,
        publicationStatus: 'draft',
        reviewStatus: manifest.reviewStatus,
        contentOrigin: manifest.contentOrigin,
        reviewedBy: manifest.reviewedBy,
        reviewedAt: manifest.reviewedAt ? new Date(manifest.reviewedAt) : null,
        publishedAt: null,
        withdrawnAt: null,
        createdAt: now,
      })
      .returning();
    if (!version) throw new Error('Knowledge version insert returned no row');
    return version;
  }

  async insertSources(
    transaction: AppTransaction,
    articleVersionId: string,
    manifest: KnowledgeManifest,
  ): Promise<void> {
    await transaction.insert(knowledgeArticleSources).values(
      manifest.sources.map((source, index) => ({
        id: randomUUID(),
        articleVersionId,
        ordinal: index + 1,
        publisherName: source.publisherName,
        sourceTitle: source.sourceTitle,
        sourceUrl: source.sourceUrl,
        sourcePublishedAt: source.sourcePublishedAt ? new Date(source.sourcePublishedAt) : null,
        sourceVersionLabel: source.sourceVersionLabel,
        sourceLocator: source.sourceLocator,
        retrievedAt: new Date(source.retrievedAt),
      })),
    );
  }

  async withdraw(
    transaction: AppTransaction,
    versionId: string,
    now: Date,
  ): Promise<KnowledgeVersionRecord> {
    const [version] = await transaction
      .update(knowledgeArticleVersions)
      .set({ publicationStatus: 'withdrawn', withdrawnAt: now })
      .where(eq(knowledgeArticleVersions.id, versionId))
      .returning();
    if (!version) throw new Error('Knowledge withdrawal target disappeared');
    return version;
  }

  async publishDraft(
    transaction: AppTransaction,
    versionId: string,
    now: Date,
  ): Promise<KnowledgeVersionRecord> {
    const [version] = await transaction
      .update(knowledgeArticleVersions)
      .set({ publicationStatus: 'published', publishedAt: now, withdrawnAt: null })
      .where(eq(knowledgeArticleVersions.id, versionId))
      .returning();
    if (!version) throw new Error('Knowledge draft target disappeared');
    return version;
  }
}
