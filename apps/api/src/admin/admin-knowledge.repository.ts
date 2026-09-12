import { randomUUID } from 'node:crypto';
import {
  and,
  asc,
  desc,
  eq,
  knowledgeArticles,
  knowledgeArticleSources,
  knowledgeArticleVersions,
  lt,
  or,
  type AppTransaction,
} from '@mental-health/database';
import { Injectable } from '@nestjs/common';
import { DatabaseService } from '../database/database.service';
import type { AdminKnowledgeCandidate } from './admin-knowledge.schemas';

export type AdminKnowledgeArticleRecord = typeof knowledgeArticles.$inferSelect;
export type AdminKnowledgeVersionRecord = typeof knowledgeArticleVersions.$inferSelect;
export type AdminKnowledgeSourceRecord = typeof knowledgeArticleSources.$inferSelect;

@Injectable()
export class AdminKnowledgeRepository {
  constructor(private readonly database: DatabaseService) {}

  transaction<T>(work: (tx: AppTransaction) => Promise<T>): Promise<T> {
    return this.database.database.transaction(work);
  }

  readTransaction<T>(work: (tx: AppTransaction) => Promise<T>): Promise<T> {
    return this.database.database.transaction(work, {
      isolationLevel: 'repeatable read',
      accessMode: 'read write',
    });
  }

  async ensureAndLockArticle(
    tx: AppTransaction,
    articleKey: string,
    now: Date,
  ): Promise<AdminKnowledgeArticleRecord> {
    await tx
      .insert(knowledgeArticles)
      .values({ id: randomUUID(), articleKey, createdAt: now })
      .onConflictDoNothing({ target: knowledgeArticles.articleKey });
    const article = await this.lockArticle(tx, articleKey);
    if (!article) throw new Error('Knowledge article lock target was not visible');
    return article;
  }

  async lockArticle(
    tx: AppTransaction,
    articleKey: string,
  ): Promise<AdminKnowledgeArticleRecord | null> {
    const [record] = await tx
      .select()
      .from(knowledgeArticles)
      .where(eq(knowledgeArticles.articleKey, articleKey))
      .limit(1)
      .for('update');
    return record ?? null;
  }

  async findArticle(
    tx: AppTransaction,
    articleKey: string,
  ): Promise<AdminKnowledgeArticleRecord | null> {
    const [record] = await tx
      .select()
      .from(knowledgeArticles)
      .where(eq(knowledgeArticles.articleKey, articleKey))
      .limit(1);
    return record ?? null;
  }

  async lockVersion(
    tx: AppTransaction,
    articleId: string,
    version: number,
  ): Promise<AdminKnowledgeVersionRecord | null> {
    const [record] = await tx
      .select()
      .from(knowledgeArticleVersions)
      .where(
        and(
          eq(knowledgeArticleVersions.articleId, articleId),
          eq(knowledgeArticleVersions.version, version),
        ),
      )
      .limit(1)
      .for('update');
    return record ?? null;
  }

  listArticles(
    tx: AppTransaction,
    limit: number,
    cursor: Readonly<{ createdAt: Date; id: string }> | null,
  ): Promise<AdminKnowledgeArticleRecord[]> {
    const cursorFilter = cursor
      ? or(
          lt(knowledgeArticles.createdAt, cursor.createdAt),
          and(
            eq(knowledgeArticles.createdAt, cursor.createdAt),
            lt(knowledgeArticles.id, cursor.id),
          ),
        )
      : undefined;
    return tx
      .selectDistinct({
        id: knowledgeArticles.id,
        articleKey: knowledgeArticles.articleKey,
        createdAt: knowledgeArticles.createdAt,
      })
      .from(knowledgeArticles)
      .innerJoin(
        knowledgeArticleVersions,
        eq(knowledgeArticleVersions.articleId, knowledgeArticles.id),
      )
      .where(and(eq(knowledgeArticleVersions.contentOrigin, 'curated'), cursorFilter))
      .orderBy(desc(knowledgeArticles.createdAt), desc(knowledgeArticles.id))
      .limit(limit);
  }

  listVersions(tx: AppTransaction, articleId: string): Promise<AdminKnowledgeVersionRecord[]> {
    return tx
      .select()
      .from(knowledgeArticleVersions)
      .where(eq(knowledgeArticleVersions.articleId, articleId))
      .orderBy(asc(knowledgeArticleVersions.version));
  }

  listSources(tx: AppTransaction, versionId: string): Promise<AdminKnowledgeSourceRecord[]> {
    return tx
      .select()
      .from(knowledgeArticleSources)
      .where(eq(knowledgeArticleSources.articleVersionId, versionId))
      .orderBy(asc(knowledgeArticleSources.ordinal));
  }

  async insertDraft(
    tx: AppTransaction,
    articleId: string,
    version: number,
    candidate: AdminKnowledgeCandidate,
    now: Date,
  ): Promise<AdminKnowledgeVersionRecord> {
    const [record] = await tx
      .insert(knowledgeArticleVersions)
      .values({
        id: randomUUID(),
        articleId,
        version,
        title: candidate.title,
        summary: candidate.summary,
        contentBlocks: candidate.contentBlocks,
        publicationStatus: 'draft',
        reviewStatus: 'unverified',
        contentOrigin: 'curated',
        reviewedBy: null,
        reviewedAt: null,
        publishedAt: null,
        withdrawnAt: null,
        createdAt: now,
      })
      .returning();
    if (!record) throw new Error('Knowledge draft insert returned no row');
    await this.insertSources(tx, record.id, candidate.sources);
    return (await this.findVersion(tx, record.id))!;
  }

  async replaceCandidate(
    tx: AppTransaction,
    versionId: string,
    candidate: AdminKnowledgeCandidate,
  ): Promise<AdminKnowledgeVersionRecord> {
    await tx
      .update(knowledgeArticleVersions)
      .set({
        title: candidate.title,
        summary: candidate.summary,
        contentBlocks: candidate.contentBlocks,
      })
      .where(eq(knowledgeArticleVersions.id, versionId));
    await tx
      .delete(knowledgeArticleSources)
      .where(eq(knowledgeArticleSources.articleVersionId, versionId));
    await this.insertSources(tx, versionId, candidate.sources);
    const record = await this.findVersion(tx, versionId);
    if (!record) throw new Error('Knowledge candidate disappeared after replacement');
    return record;
  }

  async markSourceVerified(
    tx: AppTransaction,
    versionId: string,
    reviewerId: string,
    now: Date,
  ): Promise<AdminKnowledgeVersionRecord> {
    const [record] = await tx
      .update(knowledgeArticleVersions)
      .set({ reviewStatus: 'source_verified', reviewedBy: reviewerId, reviewedAt: now })
      .where(eq(knowledgeArticleVersions.id, versionId))
      .returning();
    if (!record) throw new Error('Knowledge review target disappeared');
    return record;
  }

  async markPublished(
    tx: AppTransaction,
    versionId: string,
    now: Date,
  ): Promise<AdminKnowledgeVersionRecord> {
    const [record] = await tx
      .update(knowledgeArticleVersions)
      .set({ publicationStatus: 'published', publishedAt: now, withdrawnAt: null })
      .where(eq(knowledgeArticleVersions.id, versionId))
      .returning();
    if (!record) throw new Error('Knowledge publication target disappeared');
    return record;
  }

  async markWithdrawn(
    tx: AppTransaction,
    versionId: string,
    now: Date,
  ): Promise<AdminKnowledgeVersionRecord> {
    const [record] = await tx
      .update(knowledgeArticleVersions)
      .set({ publicationStatus: 'withdrawn', withdrawnAt: now })
      .where(eq(knowledgeArticleVersions.id, versionId))
      .returning();
    if (!record) throw new Error('Knowledge withdrawal target disappeared');
    return record;
  }

  private async findVersion(
    tx: AppTransaction,
    versionId: string,
  ): Promise<AdminKnowledgeVersionRecord | null> {
    const [record] = await tx
      .select()
      .from(knowledgeArticleVersions)
      .where(eq(knowledgeArticleVersions.id, versionId))
      .limit(1);
    return record ?? null;
  }

  private async insertSources(
    tx: AppTransaction,
    versionId: string,
    sources: AdminKnowledgeCandidate['sources'],
  ): Promise<void> {
    await tx.insert(knowledgeArticleSources).values(
      sources.map((source, index) => ({
        id: randomUUID(),
        articleVersionId: versionId,
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
}
