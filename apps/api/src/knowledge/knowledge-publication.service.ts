import type { AppTransaction } from '@mental-health/database';
import { isDeepStrictEqual } from 'node:util';
import { Injectable } from '@nestjs/common';
import { KnowledgeArticleNotFoundError, KnowledgePublicationConflictError } from '../common/errors';
import {
  curatedKnowledgeManifestSchema,
  knowledgeManifestSchema,
  type KnowledgeManifest,
} from './knowledge.schemas';
import {
  KnowledgePublicationRepository,
  type KnowledgeSourceEvidenceRecord,
  type KnowledgeVersionRecord,
} from './knowledge-publication.repository';

export type KnowledgePublishResult = Readonly<{
  articleKey: string;
  version: number;
  disposition: 'published' | 'existing';
  publishedAt: string;
}>;

export type KnowledgeWithdrawResult = Readonly<{
  articleKey: string;
  version: number;
  disposition: 'withdrawn' | 'existing';
  withdrawnAt: string;
}>;

function sameDate(record: Date | null, value: string | null): boolean {
  return record === null ? value === null : record.toISOString() === value;
}

function immutableManifestMatches(
  version: KnowledgeVersionRecord,
  sources: KnowledgeSourceEvidenceRecord[],
  manifest: KnowledgeManifest,
): boolean {
  if (
    version.version !== manifest.version ||
    version.title !== manifest.title ||
    version.summary !== manifest.summary ||
    version.contentOrigin !== manifest.contentOrigin ||
    version.reviewStatus !== manifest.reviewStatus ||
    version.reviewedBy !== manifest.reviewedBy ||
    !sameDate(version.reviewedAt, manifest.reviewedAt) ||
    !isDeepStrictEqual(version.contentBlocks, manifest.contentBlocks) ||
    sources.length !== manifest.sources.length
  ) {
    return false;
  }

  return sources.every((source, index) => {
    const candidate = manifest.sources[index];
    return (
      candidate !== undefined &&
      source.ordinal === index + 1 &&
      source.publisherName === candidate.publisherName &&
      source.sourceTitle === candidate.sourceTitle &&
      source.sourceUrl === candidate.sourceUrl &&
      sameDate(source.sourcePublishedAt, candidate.sourcePublishedAt) &&
      source.sourceVersionLabel === candidate.sourceVersionLabel &&
      source.sourceLocator === candidate.sourceLocator &&
      source.retrievedAt.toISOString() === candidate.retrievedAt
    );
  });
}

@Injectable()
export class KnowledgePublicationService {
  constructor(protected readonly repository: KnowledgePublicationRepository) {}

  async publishCurated(input: unknown, now = new Date()): Promise<KnowledgePublishResult> {
    const manifest = curatedKnowledgeManifestSchema.parse(input);
    return this.publishValidated(manifest, now);
  }

  protected async publishValidated(
    input: KnowledgeManifest,
    now: Date,
  ): Promise<KnowledgePublishResult> {
    const manifest = knowledgeManifestSchema.parse(input);
    const highestAtInvocation = await this.repository.findHighestCommittedVersion(
      manifest.articleKey,
    );
    if (
      (highestAtInvocation === null && manifest.version !== 1) ||
      (highestAtInvocation !== null && manifest.version > highestAtInvocation + 1)
    ) {
      throw new KnowledgePublicationConflictError('知识内容版本必须按顺序发布');
    }

    return this.repository.runInTransaction(async (transaction) => {
      const article = await this.repository.ensureAndLockArticle(
        transaction,
        manifest.articleKey,
        now,
      );
      const versions = await this.repository.listVersions(transaction, article.id);
      if (versions.some((version) => version.contentOrigin !== manifest.contentOrigin)) {
        throw new KnowledgePublicationConflictError('知识内容来源类型不能在版本间改变');
      }

      const target = versions.find((version) => version.version === manifest.version);
      if (target) return this.publishExisting(transaction, versions, target, manifest, now);

      const highest = versions.at(-1)?.version ?? 0;
      if (manifest.version !== highest + 1) {
        throw new KnowledgePublicationConflictError('知识内容版本必须按顺序发布');
      }

      const current = versions.find((version) => version.publicationStatus === 'published');
      if (current) await this.repository.withdraw(transaction, current.id, now);
      const inserted = await this.repository.insertDraftVersion(
        transaction,
        article.id,
        manifest,
        now,
      );
      await this.repository.insertSources(transaction, inserted.id, manifest);
      const published = await this.repository.publishDraft(transaction, inserted.id, manifest, now);
      return {
        articleKey: manifest.articleKey,
        version: manifest.version,
        disposition: 'published',
        publishedAt: published.publishedAt!.toISOString(),
      };
    });
  }

  private async publishExisting(
    transaction: AppTransaction,
    versions: KnowledgeVersionRecord[],
    target: KnowledgeVersionRecord,
    manifest: KnowledgeManifest,
    now: Date,
  ): Promise<KnowledgePublishResult> {
    const sources = await this.repository.listSources(transaction, target.id);
    if (!immutableManifestMatches(target, sources, manifest)) {
      throw new KnowledgePublicationConflictError('同一知识版本的正文或来源证据不一致');
    }
    if (target.publicationStatus === 'withdrawn') {
      throw new KnowledgePublicationConflictError('已撤下的知识版本不能重新发布');
    }
    if (target.publicationStatus === 'published') {
      return {
        articleKey: manifest.articleKey,
        version: manifest.version,
        disposition: 'existing',
        publishedAt: target.publishedAt!.toISOString(),
      };
    }

    const higher = versions.some((version) => version.version > target.version);
    const previousHighest = versions
      .filter((version) => version.version < target.version)
      .at(-1)?.version;
    if (higher || target.version !== (previousHighest ?? 0) + 1) {
      throw new KnowledgePublicationConflictError('知识内容版本必须按顺序发布');
    }
    const current = versions.find((version) => version.publicationStatus === 'published');
    if (current) await this.repository.withdraw(transaction, current.id, now);
    const published = await this.repository.publishDraft(transaction, target.id, manifest, now);
    return {
      articleKey: manifest.articleKey,
      version: manifest.version,
      disposition: 'published',
      publishedAt: published.publishedAt!.toISOString(),
    };
  }

  async withdraw(
    articleKey: string,
    version: number,
    now = new Date(),
  ): Promise<KnowledgeWithdrawResult> {
    return this.repository.runInTransaction(async (transaction) => {
      const article = await this.repository.lockArticle(transaction, articleKey);
      if (!article) throw new KnowledgeArticleNotFoundError();
      const versions = await this.repository.listVersions(transaction, article.id);
      const target = versions.find((candidate) => candidate.version === version);
      if (!target) throw new KnowledgeArticleNotFoundError();
      if (target.publicationStatus === 'draft') {
        throw new KnowledgePublicationConflictError('草稿不能通过撤下命令处理');
      }
      if (target.publicationStatus === 'withdrawn') {
        return {
          articleKey,
          version,
          disposition: 'existing',
          withdrawnAt: target.withdrawnAt!.toISOString(),
        };
      }
      const withdrawn = await this.repository.withdraw(transaction, target.id, now);
      return {
        articleKey,
        version,
        disposition: 'withdrawn',
        withdrawnAt: withdrawn.withdrawnAt!.toISOString(),
      };
    });
  }
}
