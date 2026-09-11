import { Inject, Injectable } from '@nestjs/common';
import { isDeepStrictEqual } from 'node:util';
import { env, type AppEnvironment } from '../config/env';
import {
  KNOWLEDGE_RETRIEVAL_MAX_TOKEN_BUDGET,
  KNOWLEDGE_RETRIEVAL_MIN_TOKEN_BUDGET,
  KNOWLEDGE_RETRIEVAL_POLICY_VERSION,
  KnowledgeRetrievalPolicy,
  type KnowledgePromptBundle,
} from './knowledge-retrieval.policy';
import {
  KnowledgeRetrievalRepository,
  type KnowledgeRetrievalCandidateRecord,
} from './knowledge-retrieval.repository';
import {
  knowledgeRetrievalCandidateSchema,
  type KnowledgeRetrievalCandidate,
} from './knowledge-retrieval.schemas';

export const KNOWLEDGE_RETRIEVAL_RUNTIME_CONFIG = Symbol('KNOWLEDGE_RETRIEVAL_RUNTIME_CONFIG');

export type KnowledgeRetrievalRuntimeConfig = Readonly<{
  appEnvironment: AppEnvironment['APP_ENV'];
  syntheticFixturesEnabled: boolean;
  statementTimeoutMs: number;
  contextTokenBudget: number;
}>;

type KnowledgeEnvironment = AppEnvironment &
  Readonly<{
    AI_KNOWLEDGE_SYNTHETIC_FIXTURES_ENABLED?: boolean;
    AI_KNOWLEDGE_RETRIEVAL_TIMEOUT_MS?: number;
    AI_KNOWLEDGE_CONTEXT_TOKEN_BUDGET?: number;
  }>;

export function createKnowledgeRetrievalRuntimeConfig(): KnowledgeRetrievalRuntimeConfig {
  const knowledgeEnvironment = env as KnowledgeEnvironment;
  return {
    appEnvironment: knowledgeEnvironment.APP_ENV,
    syntheticFixturesEnabled: knowledgeEnvironment.AI_KNOWLEDGE_SYNTHETIC_FIXTURES_ENABLED ?? false,
    statementTimeoutMs: knowledgeEnvironment.AI_KNOWLEDGE_RETRIEVAL_TIMEOUT_MS ?? 2_000,
    contextTokenBudget: knowledgeEnvironment.AI_KNOWLEDGE_CONTEXT_TOKEN_BUDGET ?? 1_000,
  };
}

export class KnowledgeRetrievalDeadlineExceededError extends Error {
  constructor() {
    super('knowledge_retrieval_deadline_exceeded');
    this.name = 'KnowledgeRetrievalDeadlineExceededError';
  }
}

export type KnowledgeRetrievalResult = Readonly<
  | {
      kind: 'hit';
      policyVersion: typeof KNOWLEDGE_RETRIEVAL_POLICY_VERSION;
      bundles: readonly KnowledgePromptBundle[];
    }
  | {
      kind: 'no_hit';
      policyVersion: typeof KNOWLEDGE_RETRIEVAL_POLICY_VERSION;
    }
  | {
      kind: 'corpus_limit_exceeded';
      policyVersion: typeof KNOWLEDGE_RETRIEVAL_POLICY_VERSION;
    }
  | {
      kind: 'unavailable';
      policyVersion: typeof KNOWLEDGE_RETRIEVAL_POLICY_VERSION;
      reason: 'invalid_candidate' | 'storage_timeout' | 'storage_error';
    }
>;

export type KnowledgeCurrentnessResult = Readonly<
  | { kind: 'current' }
  | { kind: 'stale' }
  | { kind: 'unavailable'; reason: 'storage_timeout' | 'storage_error' }
>;

function throwIfTerminated(signal: AbortSignal, deadlineAt: Date): void {
  if (signal.aborted) {
    if (signal.reason instanceof Error) throw signal.reason;
    throw new DOMException('Knowledge retrieval aborted', 'AbortError');
  }
  if (deadlineAt.getTime() <= Date.now()) throw new KnowledgeRetrievalDeadlineExceededError();
}

function isDatabaseStatementTimeout(error: unknown): boolean {
  let current: unknown = error;
  for (let depth = 0; depth < 4; depth += 1) {
    if (typeof current !== 'object' || current === null) return false;
    if ('code' in current && current.code === '57014') return true;
    current = 'cause' in current ? current.cause : undefined;
  }
  return false;
}

function remainingStatementTimeout(
  configuredTimeoutMs: number,
  deadlineAt: Date,
  signal: AbortSignal,
): number {
  throwIfTerminated(signal, deadlineAt);
  return Math.max(1, Math.min(configuredTimeoutMs, deadlineAt.getTime() - Date.now()));
}

function toCandidate(record: KnowledgeRetrievalCandidateRecord): unknown {
  return {
    articleKey: record.articleKey,
    versionId: record.versionId,
    version: record.version,
    title: record.title,
    summary: record.summary,
    contentBlocks: record.contentBlocks,
    publicationStatus: record.publicationStatus,
    contentOrigin: record.contentOrigin,
    reviewStatus: record.reviewStatus,
    reviewedBy: record.reviewedBy,
    reviewedAt: record.reviewedAt?.toISOString() ?? null,
    publishedAt: record.publishedAt.toISOString(),
    sources: record.sources.map((source) => ({
      ordinal: source.ordinal,
      publisherName: source.publisherName,
      sourceTitle: source.sourceTitle,
      sourceUrl: source.sourceUrl,
      sourcePublishedAt: source.sourcePublishedAt?.toISOString() ?? null,
      sourceVersionLabel: source.sourceVersionLabel,
      sourceLocator: source.sourceLocator,
      retrievedAt: source.retrievedAt.toISOString(),
    })),
  };
}

@Injectable()
export class KnowledgeRetrievalService {
  constructor(
    private readonly repository: KnowledgeRetrievalRepository,
    private readonly policy: KnowledgeRetrievalPolicy,
    @Inject(KNOWLEDGE_RETRIEVAL_RUNTIME_CONFIG)
    private readonly config: KnowledgeRetrievalRuntimeConfig,
  ) {}

  async retrieve(input: {
    query: string;
    signal: AbortSignal;
    deadlineAt: Date;
  }): Promise<KnowledgeRetrievalResult> {
    throwIfTerminated(input.signal, input.deadlineAt);
    this.assertConfiguration();
    const permitSynthetic = this.policy.permitsSynthetic(
      this.config.appEnvironment,
      this.config.syntheticFixturesEnabled,
    );

    try {
      const snapshot = await this.repository.readCandidateSnapshot({
        permitSynthetic,
        statementTimeoutMs: remainingStatementTimeout(
          this.config.statementTimeoutMs,
          input.deadlineAt,
          input.signal,
        ),
      });
      throwIfTerminated(input.signal, input.deadlineAt);
      if (snapshot.candidateLimitExceeded) {
        return { kind: 'corpus_limit_exceeded', policyVersion: KNOWLEDGE_RETRIEVAL_POLICY_VERSION };
      }

      const candidates: KnowledgeRetrievalCandidate[] = [];
      for (const record of snapshot.candidates) {
        const parsed = knowledgeRetrievalCandidateSchema.safeParse(toCandidate(record));
        if (
          !parsed.success ||
          !isDeepStrictEqual(parsed.data.contentBlocks, record.contentBlocks) ||
          !this.policy.isEligible(parsed.data, {
            appEnvironment: this.config.appEnvironment,
            syntheticFixturesEnabled: this.config.syntheticFixturesEnabled,
          })
        ) {
          return {
            kind: 'unavailable',
            policyVersion: KNOWLEDGE_RETRIEVAL_POLICY_VERSION,
            reason: 'invalid_candidate',
          };
        }
        candidates.push(parsed.data);
      }

      const bundles = this.policy.select(input.query, candidates, this.config.contextTokenBudget);
      return bundles.length === 0
        ? { kind: 'no_hit', policyVersion: KNOWLEDGE_RETRIEVAL_POLICY_VERSION }
        : { kind: 'hit', policyVersion: KNOWLEDGE_RETRIEVAL_POLICY_VERSION, bundles };
    } catch (error) {
      throwIfTerminated(input.signal, input.deadlineAt);
      return {
        kind: 'unavailable',
        policyVersion: KNOWLEDGE_RETRIEVAL_POLICY_VERSION,
        reason: isDatabaseStatementTimeout(error) ? 'storage_timeout' : 'storage_error',
      };
    }
  }

  async recheckCurrent(input: {
    bundles: readonly KnowledgePromptBundle[];
    signal: AbortSignal;
    deadlineAt: Date;
  }): Promise<KnowledgeCurrentnessResult> {
    throwIfTerminated(input.signal, input.deadlineAt);
    this.assertConfiguration();
    const permitSynthetic = this.policy.permitsSynthetic(
      this.config.appEnvironment,
      this.config.syntheticFixturesEnabled,
    );

    try {
      const current = await this.repository.areExactVersionsCurrent({
        versionIds: input.bundles.map((bundle) => bundle.versionId),
        permitSynthetic,
        statementTimeoutMs: remainingStatementTimeout(
          this.config.statementTimeoutMs,
          input.deadlineAt,
          input.signal,
        ),
      });
      throwIfTerminated(input.signal, input.deadlineAt);
      return current ? { kind: 'current' } : { kind: 'stale' };
    } catch (error) {
      throwIfTerminated(input.signal, input.deadlineAt);
      return {
        kind: 'unavailable',
        reason: isDatabaseStatementTimeout(error) ? 'storage_timeout' : 'storage_error',
      };
    }
  }

  private assertConfiguration(): void {
    if (!Number.isInteger(this.config.statementTimeoutMs) || this.config.statementTimeoutMs <= 0) {
      throw new RangeError('knowledge_retrieval_statement_timeout_invalid');
    }
    if (
      !Number.isInteger(this.config.contextTokenBudget) ||
      this.config.contextTokenBudget < KNOWLEDGE_RETRIEVAL_MIN_TOKEN_BUDGET ||
      this.config.contextTokenBudget > KNOWLEDGE_RETRIEVAL_MAX_TOKEN_BUDGET
    ) {
      throw new RangeError('knowledge_retrieval_token_budget_out_of_range');
    }
  }
}
