import { randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import type { AppTransaction } from '@mental-health/database';
import { Injectable } from '@nestjs/common';
import {
  AdminKnowledgeResultUnknownError,
  AuthorizationError,
  DatabaseError,
  KnowledgeArticleNotFoundError,
  KnowledgePublicationConflictError,
  ValidationError,
} from '../common/errors';
import { decodeOpaqueCursor, encodeOpaqueCursor } from '../common/pagination/opaque-cursor';
import { AuditLogRepository } from '../safety/audit/audit-log.repository';
import { DatabaseStaffAuthorizer } from './staff-authorizer.service';
import type { StaffAuthorizationContext, StaffPermission } from './staff-access.types';
import {
  adminKnowledgeCandidateSchema,
  adminKnowledgeCursorSchema,
  type AdminKnowledgeCandidate,
  type AdminKnowledgeListQuery,
} from './admin-knowledge.schemas';
import {
  AdminKnowledgeRepository,
  type AdminKnowledgeArticleRecord,
  type AdminKnowledgeSourceRecord,
  type AdminKnowledgeVersionRecord,
} from './admin-knowledge.repository';

const KNOWLEDGE_DIRECTORY_RESOURCE_ID = '00000000-0000-0000-0000-000000000001';
const KNOWLEDGE_PERMISSIONS: readonly StaffPermission[] = [
  'knowledge:draft_write',
  'knowledge:source_review',
  'knowledge:publish',
];

type Disposition = 'applied' | 'no_change';

@Injectable()
export class AdminKnowledgeService {
  constructor(
    private readonly repository: AdminKnowledgeRepository,
    private readonly authorizer: DatabaseStaffAuthorizer,
    private readonly audits: AuditLogRepository,
  ) {}

  async list(actor: StaffAuthorizationContext, query: AdminKnowledgeListQuery, now = new Date()) {
    const cursor = decodeOpaqueCursor(query.cursor, adminKnowledgeCursorSchema);
    try {
      return await this.repository.readTransaction(async (tx) => {
        await this.authorizer.authorizeAnyWithinTransaction(tx, actor, KNOWLEDGE_PERMISSIONS);
        const rows = await this.repository.listArticles(
          tx,
          query.limit + 1,
          cursor ? { createdAt: new Date(cursor.createdAt), id: cursor.id } : null,
        );
        const selected = rows.slice(0, query.limit);
        const items = await Promise.all(
          selected.map(async (article) =>
            directoryItem(article, await this.repository.listVersions(tx, article.id)),
          ),
        );
        const last = selected.at(-1);
        await this.auditRead(
          tx,
          actor.id,
          'knowledge_directory_accessed',
          'knowledge_article_query',
          KNOWLEDGE_DIRECTORY_RESOURCE_ID,
          { filterCategory: 'all', returnedCount: items.length },
          now,
        );
        return {
          items,
          nextCursor:
            rows.length > query.limit && last
              ? encodeOpaqueCursor({
                  kind: 'admin-knowledge-articles',
                  version: 1,
                  createdAt: last.createdAt.toISOString(),
                  id: last.id,
                })
              : null,
        };
      });
    } catch (error) {
      this.rethrowRead(error);
    }
  }

  getStatus(
    actor: StaffAuthorizationContext,
    articleKey: string,
    version: number,
    now = new Date(),
  ) {
    return this.readExact(actor, articleKey, version, 'status', now);
  }

  getDraft(
    actor: StaffAuthorizationContext,
    articleKey: string,
    version: number,
    now = new Date(),
  ) {
    return this.readCandidate(actor, articleKey, version, 'knowledge:draft_write', 'draft', now);
  }

  getReviewCandidate(
    actor: StaffAuthorizationContext,
    articleKey: string,
    version: number,
    now = new Date(),
  ) {
    return this.readCandidate(actor, articleKey, version, 'knowledge:source_review', 'review', now);
  }

  async getPublicationState(
    actor: StaffAuthorizationContext,
    articleKey: string,
    version: number,
    now = new Date(),
  ) {
    try {
      return await this.repository.readTransaction(async (tx) => {
        await this.authorizer.authorizeWithinTransaction(tx, actor, 'knowledge:publish');
        const exact = await this.loadExact(tx, articleKey, version);
        const sources = await this.repository.listSources(tx, exact.target.id);
        await this.auditRead(
          tx,
          actor.id,
          'knowledge_publication_state_viewed',
          'knowledge_article_version',
          exact.target.id,
          { accessCategory: 'publication', version },
          now,
        );
        return {
          state: workflowState(exact.article, exact.target, exact.versions),
          reviewedBy: exact.target.reviewedBy,
          sources: sources.map(publicationSource),
        };
      });
    } catch (error) {
      this.rethrowRead(error);
    }
  }

  async create(
    actor: StaffAuthorizationContext,
    articleKey: string,
    version: number,
    input: AdminKnowledgeCandidate,
    now = new Date(),
  ) {
    const candidate = adminKnowledgeCandidateSchema.parse(input);
    return this.runMutation(async (tx) => {
      await this.authorizer.authorizeWithinTransaction(tx, actor, 'knowledge:draft_write');
      const article = await this.repository.ensureAndLockArticle(tx, articleKey, now);
      const versions = await this.repository.listVersions(tx, article.id);
      const target = versions.find((item) => item.version === version);
      if (target) {
        const lockedTarget = await this.repository.lockVersion(tx, article.id, version);
        if (!lockedTarget) throw new KnowledgeArticleNotFoundError();
        this.assertCurated(lockedTarget);
        const stored = await this.candidate(tx, lockedTarget);
        if (!isDeepStrictEqual(stored, candidate)) {
          throw new KnowledgePublicationConflictError('同一知识版本的候选内容不一致');
        }
        await this.auditMutation(
          tx,
          actor.id,
          'knowledge_draft_created',
          lockedTarget,
          'no_change',
          now,
        );
        return {
          disposition: 'no_change' as const,
          state: workflowState(article, lockedTarget, replaceVersion(versions, lockedTarget)),
        };
      }
      const highest = versions.at(-1);
      if (version !== (highest?.version ?? 0) + 1 || hasEditableDraft(versions)) {
        throw new KnowledgePublicationConflictError('知识内容版本必须按顺序创建');
      }
      if (versions.some((item) => item.contentOrigin !== 'curated')) {
        throw new KnowledgePublicationConflictError('知识内容来源类型不能在版本间改变');
      }
      const created = await this.repository.insertDraft(tx, article.id, version, candidate, now);
      const updatedVersions = [...versions, created];
      await this.auditMutation(tx, actor.id, 'knowledge_draft_created', created, 'applied', now);
      return {
        disposition: 'applied' as const,
        state: workflowState(article, created, updatedVersions),
      };
    });
  }

  async replace(
    actor: StaffAuthorizationContext,
    articleKey: string,
    version: number,
    expectedDraftRevision: number,
    input: AdminKnowledgeCandidate,
    now = new Date(),
  ) {
    const candidate = adminKnowledgeCandidateSchema.parse(input);
    return this.runMutation(async (tx) => {
      await this.authorizer.authorizeWithinTransaction(tx, actor, 'knowledge:draft_write');
      const exact = await this.lockExact(tx, articleKey, version);
      if (
        exact.target.draftRevision !== expectedDraftRevision ||
        exact.target.publicationStatus !== 'draft' ||
        exact.target.reviewStatus !== 'unverified' ||
        exact.target.version !== exact.versions.at(-1)?.version
      ) {
        throw new KnowledgePublicationConflictError('候选内容状态或版本已发生变化');
      }
      const stored = await this.candidate(tx, exact.target);
      if (isDeepStrictEqual(stored, candidate)) {
        await this.auditMutation(
          tx,
          actor.id,
          'knowledge_draft_updated',
          exact.target,
          'no_change',
          now,
        );
        return {
          disposition: 'no_change' as const,
          state: workflowState(exact.article, exact.target, exact.versions),
        };
      }
      const updated = await this.repository.replaceCandidate(tx, exact.target.id, candidate);
      const versions = replaceVersion(exact.versions, updated);
      await this.auditMutation(tx, actor.id, 'knowledge_draft_updated', updated, 'applied', now);
      return {
        disposition: 'applied' as const,
        state: workflowState(exact.article, updated, versions),
      };
    });
  }

  async sourceReview(
    actor: StaffAuthorizationContext,
    articleKey: string,
    version: number,
    expectedDraftRevision: number,
    now = new Date(),
  ) {
    return this.runMutation(async (tx) => {
      await this.authorizer.authorizeWithinTransaction(tx, actor, 'knowledge:source_review');
      const exact = await this.lockExact(tx, articleKey, version);
      if (exact.target.draftRevision !== expectedDraftRevision) {
        throw new KnowledgePublicationConflictError('候选内容版本已发生变化');
      }
      if (exact.target.reviewStatus === 'source_verified') {
        await this.auditMutation(
          tx,
          actor.id,
          'knowledge_source_verified',
          exact.target,
          'no_change',
          now,
        );
        return reviewResult('no_change', exact.target, articleKey);
      }
      if (
        exact.target.reviewStatus !== 'unverified' ||
        exact.target.publicationStatus !== 'draft'
      ) {
        throw new KnowledgePublicationConflictError('候选内容当前不能进行来源核验');
      }
      adminKnowledgeCandidateSchema.parse(await this.candidate(tx, exact.target));
      const reviewed = await this.repository.markSourceVerified(tx, exact.target.id, actor.id, now);
      await this.auditMutation(tx, actor.id, 'knowledge_source_verified', reviewed, 'applied', now);
      return reviewResult('applied', reviewed, articleKey);
    });
  }

  async publish(
    actor: StaffAuthorizationContext,
    articleKey: string,
    version: number,
    expectedDraftRevision: number,
    now = new Date(),
  ) {
    return this.runMutation(async (tx) => {
      await this.authorizer.authorizeWithinTransaction(tx, actor, 'knowledge:publish');
      const exact = await this.lockExact(tx, articleKey, version);
      if (exact.target.draftRevision !== expectedDraftRevision) {
        throw new KnowledgePublicationConflictError('候选内容版本已发生变化');
      }
      if (exact.target.publicationStatus === 'published') {
        await this.auditMutation(
          tx,
          actor.id,
          'knowledge_version_published',
          exact.target,
          'no_change',
          now,
        );
        return mutationResult('no_change', exact.article, exact.target, exact.versions);
      }
      if (
        exact.target.publicationStatus !== 'draft' ||
        exact.target.reviewStatus !== 'source_verified' ||
        exact.versions.some((item) => item.version < version && item.publicationStatus === 'draft')
      ) {
        throw new KnowledgePublicationConflictError('知识内容当前不满足发布顺序或核验要求');
      }
      if ((await this.repository.listSources(tx, exact.target.id)).length === 0) {
        throw new KnowledgePublicationConflictError('知识内容缺少来源证据');
      }
      let versions = exact.versions;
      const current = versions.find((item) => item.publicationStatus === 'published');
      if (current) {
        const withdrawn = await this.repository.markWithdrawn(tx, current.id, now);
        versions = replaceVersion(versions, withdrawn);
      }
      const published = await this.repository.markPublished(tx, exact.target.id, now);
      versions = replaceVersion(versions, published);
      await this.auditMutation(
        tx,
        actor.id,
        'knowledge_version_published',
        published,
        'applied',
        now,
      );
      return mutationResult('applied', exact.article, published, versions);
    });
  }

  async withdraw(
    actor: StaffAuthorizationContext,
    articleKey: string,
    version: number,
    expectedDraftRevision: number,
    now = new Date(),
  ) {
    return this.runMutation(async (tx) => {
      await this.authorizer.authorizeWithinTransaction(tx, actor, 'knowledge:publish');
      const exact = await this.lockExact(tx, articleKey, version);
      if (exact.target.draftRevision !== expectedDraftRevision) {
        throw new KnowledgePublicationConflictError('候选内容版本已发生变化');
      }
      if (exact.target.publicationStatus === 'withdrawn') {
        await this.auditMutation(
          tx,
          actor.id,
          'knowledge_version_withdrawn',
          exact.target,
          'no_change',
          now,
        );
        return mutationResult('no_change', exact.article, exact.target, exact.versions);
      }
      if (
        exact.target.publicationStatus !== 'published' &&
        !(
          exact.target.publicationStatus === 'draft' &&
          exact.target.reviewStatus === 'source_verified'
        )
      ) {
        throw new KnowledgePublicationConflictError('知识内容当前不能撤下或退役');
      }
      const withdrawn = await this.repository.markWithdrawn(tx, exact.target.id, now);
      const versions = replaceVersion(exact.versions, withdrawn);
      await this.auditMutation(
        tx,
        actor.id,
        'knowledge_version_withdrawn',
        withdrawn,
        'applied',
        now,
      );
      return mutationResult('applied', exact.article, withdrawn, versions);
    });
  }

  private async readExact(
    actor: StaffAuthorizationContext,
    articleKey: string,
    version: number,
    access: 'status',
    now: Date,
  ) {
    try {
      return await this.repository.readTransaction(async (tx) => {
        await this.authorizer.authorizeAnyWithinTransaction(tx, actor, KNOWLEDGE_PERMISSIONS);
        const exact = await this.loadExact(tx, articleKey, version);
        await this.auditRead(
          tx,
          actor.id,
          'knowledge_version_status_viewed',
          'knowledge_article_version',
          exact.target.id,
          { accessCategory: access, version },
          now,
        );
        return { state: workflowState(exact.article, exact.target, exact.versions) };
      });
    } catch (error) {
      this.rethrowRead(error);
    }
  }

  private async readCandidate(
    actor: StaffAuthorizationContext,
    articleKey: string,
    version: number,
    permission: StaffPermission,
    access: 'draft' | 'review',
    now: Date,
  ) {
    try {
      return await this.repository.readTransaction(async (tx) => {
        await this.authorizer.authorizeWithinTransaction(tx, actor, permission);
        const exact = await this.loadExact(tx, articleKey, version);
        if (
          access === 'draft' &&
          (exact.target.publicationStatus !== 'draft' ||
            exact.target.reviewStatus !== 'unverified' ||
            exact.target.version !== exact.versions.at(-1)?.version)
        ) {
          throw new KnowledgePublicationConflictError('候选内容已不再是可编辑草稿');
        }
        const candidate = await this.candidate(tx, exact.target);
        await this.auditRead(
          tx,
          actor.id,
          access === 'draft' ? 'knowledge_draft_viewed' : 'knowledge_review_candidate_viewed',
          'knowledge_article_version',
          exact.target.id,
          { accessCategory: access, version },
          now,
        );
        return { state: workflowState(exact.article, exact.target, exact.versions), candidate };
      });
    } catch (error) {
      this.rethrowRead(error);
    }
  }

  private async lockExact(tx: AppTransaction, articleKey: string, version: number) {
    const article = await this.repository.lockArticle(tx, articleKey);
    if (!article) throw new KnowledgeArticleNotFoundError();
    const target = await this.repository.lockVersion(tx, article.id, version);
    if (!target) throw new KnowledgeArticleNotFoundError();
    this.assertCurated(target);
    const versions = await this.repository.listVersions(tx, article.id);
    return { article, target, versions: replaceVersion(versions, target) };
  }

  private async loadExact(tx: AppTransaction, articleKey: string, version: number) {
    const article = await this.repository.findArticle(tx, articleKey);
    if (!article) throw new KnowledgeArticleNotFoundError();
    return this.resolveExact(tx, article, version);
  }

  private async resolveExact(
    tx: AppTransaction,
    article: AdminKnowledgeArticleRecord,
    version: number,
  ) {
    const versions = await this.repository.listVersions(tx, article.id);
    const target = versions.find((item) => item.version === version);
    if (!target) throw new KnowledgeArticleNotFoundError();
    this.assertCurated(target);
    return { article, target, versions };
  }

  private assertCurated(target: AdminKnowledgeVersionRecord): void {
    if (target.contentOrigin !== 'curated') throw new KnowledgeArticleNotFoundError();
  }

  private async candidate(
    tx: AppTransaction,
    version: AdminKnowledgeVersionRecord,
  ): Promise<AdminKnowledgeCandidate> {
    const sources = await this.repository.listSources(tx, version.id);
    return adminKnowledgeCandidateSchema.parse({
      title: version.title,
      summary: version.summary,
      contentBlocks: version.contentBlocks,
      sources: sources.map(sourceView),
    });
  }

  private async runMutation<T>(work: (tx: AppTransaction) => Promise<T>): Promise<T> {
    let transactionStarted = false;
    let workCompleted = false;
    try {
      return await this.repository.transaction(async (tx) => {
        transactionStarted = true;
        const result = await work(tx);
        workCompleted = true;
        return result;
      });
    } catch (error) {
      if (
        error instanceof AuthorizationError ||
        error instanceof KnowledgeArticleNotFoundError ||
        error instanceof KnowledgePublicationConflictError ||
        error instanceof ValidationError
      ) {
        throw error;
      }
      if (!transactionStarted || !workCompleted) {
        throw new DatabaseError();
      }
      throw new AdminKnowledgeResultUnknownError();
    }
  }

  private rethrowRead(error: unknown): never {
    if (
      error instanceof AuthorizationError ||
      error instanceof KnowledgeArticleNotFoundError ||
      error instanceof KnowledgePublicationConflictError ||
      error instanceof ValidationError
    ) {
      throw error;
    }
    throw new DatabaseError();
  }

  private auditRead(
    tx: AppTransaction,
    actorId: string,
    action:
      | 'knowledge_directory_accessed'
      | 'knowledge_version_status_viewed'
      | 'knowledge_draft_viewed'
      | 'knowledge_review_candidate_viewed'
      | 'knowledge_publication_state_viewed',
    resourceType: 'knowledge_article_query' | 'knowledge_article_version',
    resourceId: string,
    safeMetadata: unknown,
    now: Date,
  ) {
    return this.audits.appendWithinTransaction(tx, {
      actorType: 'staff',
      actorId,
      action,
      resourceType,
      resourceId,
      idempotencyKey: `${action}:${randomUUID()}`,
      safeMetadata,
      occurredAt: now,
    });
  }

  private auditMutation(
    tx: AppTransaction,
    actorId: string,
    action:
      | 'knowledge_draft_created'
      | 'knowledge_draft_updated'
      | 'knowledge_source_verified'
      | 'knowledge_version_published'
      | 'knowledge_version_withdrawn',
    target: AdminKnowledgeVersionRecord,
    disposition: Disposition,
    now: Date,
  ) {
    const appliedKeys = {
      knowledge_draft_created: `knowledge-draft-created:${target.id}`,
      knowledge_draft_updated: `knowledge-draft-updated:${target.id}:${target.draftRevision}`,
      knowledge_source_verified: `knowledge-source-verified:${target.id}:${target.draftRevision}`,
      knowledge_version_published: `knowledge-version-published:${target.id}`,
      knowledge_version_withdrawn: `knowledge-version-withdrawn:${target.id}`,
    } as const;
    return this.audits.appendWithinTransaction(tx, {
      actorType: 'staff',
      actorId,
      action,
      resourceType: 'knowledge_article_version',
      resourceId: target.id,
      idempotencyKey:
        disposition === 'applied' ? appliedKeys[action] : `${action}:no-change:${randomUUID()}`,
      safeMetadata: {
        disposition,
        version: target.version,
        resultingDraftRevision: target.draftRevision,
        ...(action === 'knowledge_version_published' || action === 'knowledge_version_withdrawn'
          ? { publicationStatus: target.publicationStatus }
          : {}),
      },
      occurredAt: now,
    });
  }
}

function sourceView(source: AdminKnowledgeSourceRecord) {
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

function publicationSource(source: AdminKnowledgeSourceRecord) {
  return {
    publisherName: source.publisherName,
    sourceTitle: source.sourceTitle,
    sourcePublishedAt: source.sourcePublishedAt?.toISOString() ?? null,
    sourceVersionLabel: source.sourceVersionLabel,
    sourceLocator: source.sourceLocator,
    retrievedAt: source.retrievedAt.toISOString(),
  };
}

function hasEditableDraft(versions: readonly AdminKnowledgeVersionRecord[]): boolean {
  return versions.some(
    (item) => item.publicationStatus === 'draft' && item.reviewStatus === 'unverified',
  );
}

function isPublicationEligible(
  target: AdminKnowledgeVersionRecord,
  versions: readonly AdminKnowledgeVersionRecord[],
): boolean {
  return (
    target.contentOrigin === 'curated' &&
    target.reviewStatus === 'source_verified' &&
    target.publicationStatus === 'draft' &&
    !versions.some((item) => item.version < target.version && item.publicationStatus === 'draft')
  );
}

function workflowState(
  article: AdminKnowledgeArticleRecord,
  target: AdminKnowledgeVersionRecord,
  versions: readonly AdminKnowledgeVersionRecord[],
) {
  return {
    articleId: article.id,
    articleKey: article.articleKey,
    versionId: target.id,
    version: target.version,
    draftRevision: target.draftRevision,
    contentOrigin: 'curated' as const,
    reviewStatus: target.reviewStatus,
    publicationStatus: target.publicationStatus,
    publicationEligible: isPublicationEligible(target, versions),
    createdAt: target.createdAt.toISOString(),
    reviewedAt: target.reviewedAt?.toISOString() ?? null,
    publishedAt: target.publishedAt?.toISOString() ?? null,
    withdrawnAt: target.withdrawnAt?.toISOString() ?? null,
  };
}

function directoryItem(
  article: AdminKnowledgeArticleRecord,
  allVersions: readonly AdminKnowledgeVersionRecord[],
) {
  const versions = allVersions.filter((item) => item.contentOrigin === 'curated');
  const highest = versions.at(-1);
  if (!highest) throw new Error('Curated directory article had no curated version');
  return {
    articleId: article.id,
    articleKey: article.articleKey,
    highestVersion: highest.version,
    currentPublishedVersion:
      versions.find((item) => item.publicationStatus === 'published')?.version ?? null,
    editableDraftVersion:
      versions.find(
        (item) => item.publicationStatus === 'draft' && item.reviewStatus === 'unverified',
      )?.version ?? null,
    latestVerifiedCandidateVersion:
      versions
        .filter(
          (item) => item.publicationStatus === 'draft' && item.reviewStatus === 'source_verified',
        )
        .at(-1)?.version ?? null,
    articleCreatedAt: article.createdAt.toISOString(),
  };
}

function replaceVersion(
  versions: readonly AdminKnowledgeVersionRecord[],
  updated: AdminKnowledgeVersionRecord,
): AdminKnowledgeVersionRecord[] {
  return versions.map((item) => (item.id === updated.id ? updated : item));
}

function mutationResult(
  disposition: Disposition,
  article: AdminKnowledgeArticleRecord,
  target: AdminKnowledgeVersionRecord,
  versions: readonly AdminKnowledgeVersionRecord[],
) {
  return { disposition, state: workflowState(article, target, versions) };
}

function reviewResult(
  disposition: Disposition,
  target: AdminKnowledgeVersionRecord,
  articleKey: string,
) {
  if (!target.reviewedBy || !target.reviewedAt || target.reviewStatus !== 'source_verified') {
    throw new Error('Source review result lacked immutable evidence');
  }
  return {
    disposition,
    articleKey,
    version: target.version,
    draftRevision: target.draftRevision,
    reviewStatus: 'source_verified' as const,
    reviewedBy: target.reviewedBy,
    reviewedAt: target.reviewedAt.toISOString(),
  };
}
