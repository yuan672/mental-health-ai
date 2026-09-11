import { randomUUID } from 'node:crypto';
import {
  extractKnowledgeLexicalTerms,
  KnowledgeRetrievalPolicy,
} from '../src/knowledge/knowledge-retrieval.policy';
import type {
  KnowledgeRetrievalCandidateRecord,
  KnowledgeRetrievalRepository,
} from '../src/knowledge/knowledge-retrieval.repository';
import {
  KnowledgeRetrievalDeadlineExceededError,
  KnowledgeRetrievalService,
  type KnowledgeRetrievalRuntimeConfig,
} from '../src/knowledge/knowledge-retrieval.service';
import { knowledgeRetrievalCandidateSchema } from '../src/knowledge/knowledge-retrieval.schemas';

const NOW = new Date('2026-09-11T08:00:00.000Z');

function candidate(
  articleKey: string,
  marker = '工作压力和日常自我照顾',
): KnowledgeRetrievalCandidateRecord {
  return {
    articleKey,
    versionId: randomUUID(),
    version: 1,
    title: marker,
    summary: `了解${marker}`,
    contentBlocks: [
      { type: 'heading', level: 2, text: marker },
      { type: 'paragraph', text: `这是仅供合成工程测试的${marker}内容。` },
    ],
    publicationStatus: 'published',
    contentOrigin: 'curated',
    reviewStatus: 'source_verified',
    reviewedBy: 'synthetic-test-reviewer',
    reviewedAt: NOW,
    publishedAt: NOW,
    sources: [
      {
        articleVersionId: randomUUID(),
        ordinal: 1,
        publisherName: '合成发布者',
        sourceTitle: '合成来源',
        sourceUrl: `https://synthetic.invalid/${articleKey}`,
        sourcePublishedAt: null,
        sourceVersionLabel: 'synthetic-v1',
        sourceLocator: '合成章节',
        retrievedAt: NOW,
      },
    ],
  };
}

function parsedCandidate(record: KnowledgeRetrievalCandidateRecord) {
  return knowledgeRetrievalCandidateSchema.parse({
    ...record,
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
  });
}

function runtimeConfig(
  override: Partial<KnowledgeRetrievalRuntimeConfig> = {},
): KnowledgeRetrievalRuntimeConfig {
  return {
    appEnvironment: 'test',
    syntheticFixturesEnabled: true,
    statementTimeoutMs: 1_000,
    contextTokenBudget: 1_000,
    ...override,
  };
}

function repositoryMock() {
  return {
    readCandidateSnapshot: jest.fn(),
    areExactVersionsCurrent: jest.fn(),
  } as unknown as jest.Mocked<KnowledgeRetrievalRepository>;
}

describe('KnowledgeRetrievalPolicy', () => {
  const policy = new KnowledgeRetrievalPolicy();

  it('normalizes NFKC/ASCII case and produces bounded Chinese bi- and trigrams', () => {
    const terms = extractKnowledgeLexicalTerms('ＳＴＲＥＳＳ stress 工作压力');
    expect(terms.filter((term) => term === 'stress')).toHaveLength(1);
    expect(terms).toEqual(expect.arrayContaining(['工作', '压力', '工作压', '作压力']));
  });

  it('uses stable article/version ties and selects no more than two exact versions', () => {
    const selected = policy.select(
      '工作压力怎样做日常自我照顾',
      [candidate('b-article'), candidate('a-article'), candidate('c-article')].map(parsedCandidate),
      1_000,
    );
    expect(selected.map((bundle) => bundle.articleKey)).toEqual(['a-article', 'b-article']);
    expect(selected.map((bundle) => bundle.referenceId)).toEqual(['K1', 'K2']);
  });

  it('skips an oversized whole block, preserves original order, and rejects title-only hits', () => {
    const record = candidate('bounded-blocks');
    record.contentBlocks.splice(
      0,
      record.contentBlocks.length,
      { type: 'paragraph', text: `工作压力${'很大'.repeat(700)}` },
      { type: 'paragraph', text: '工作压力可以通过一些日常自我照顾来缓解。' },
      { type: 'heading', level: 3, text: '日常自我照顾' },
    );
    const selected = policy.select('工作压力 日常自我照顾', [parsedCandidate(record)], 800);
    expect(selected).toHaveLength(1);
    expect(selected[0]!.blocks.map((block) => block.ordinal)).toEqual([2, 3]);

    const titleOnly = candidate('title-only', '工作压力');
    titleOnly.contentBlocks.splice(0, titleOnly.contentBlocks.length, {
      type: 'paragraph',
      text: '这段内容与查询没有共同词项。',
    });
    expect(policy.select('工作压力', [parsedCandidate(titleOnly)], 800)).toEqual([]);
  });

  it('admits synthetic content only behind the explicit Development/Test fixture flag', () => {
    const synthetic = parsedCandidate({
      ...candidate('synthetic-policy'),
      contentOrigin: 'synthetic_fixture',
      reviewStatus: 'unverified',
      reviewedBy: null,
      reviewedAt: null,
    });
    expect(
      policy.isEligible(synthetic, {
        appEnvironment: 'test',
        syntheticFixturesEnabled: true,
      }),
    ).toBe(true);
    expect(
      policy.isEligible(synthetic, {
        appEnvironment: 'test',
        syntheticFixturesEnabled: false,
      }),
    ).toBe(false);
    expect(
      policy.isEligible(synthetic, {
        appEnvironment: 'production',
        syntheticFixturesEnabled: true,
      }),
    ).toBe(false);
  });
});

describe('KnowledgeRetrievalService', () => {
  it('detects the 51-row sentinel instead of ranking a truncated corpus', async () => {
    const repository = repositoryMock();
    repository.readCandidateSnapshot.mockResolvedValue({
      candidateLimitExceeded: true,
      candidates: [],
    });
    const service = new KnowledgeRetrievalService(
      repository,
      new KnowledgeRetrievalPolicy(),
      runtimeConfig(),
    );

    await expect(
      service.retrieve({
        query: '工作压力',
        signal: new AbortController().signal,
        deadlineAt: new Date(Date.now() + 5_000),
      }),
    ).resolves.toMatchObject({ kind: 'corpus_limit_exceeded', policyVersion: 'lexical-v1' });
  });

  it('fails soft without leaking a malformed credential-bearing source into a bundle', async () => {
    const repository = repositoryMock();
    repository.readCandidateSnapshot.mockResolvedValue({
      candidateLimitExceeded: false,
      candidates: [
        {
          ...candidate('invalid-source'),
          sources: [
            {
              ...candidate('invalid-source').sources[0]!,
              sourceUrl: 'https://user:secret@synthetic.invalid/source',
            },
          ],
        },
      ],
    });
    const service = new KnowledgeRetrievalService(
      repository,
      new KnowledgeRetrievalPolicy(),
      runtimeConfig(),
    );

    await expect(
      service.retrieve({
        query: '工作压力',
        signal: new AbortController().signal,
        deadlineAt: new Date(Date.now() + 5_000),
      }),
    ).resolves.toMatchObject({ kind: 'unavailable', reason: 'invalid_candidate' });
  });

  it('rejects a database body that would require normalization instead of changing the snapshot', async () => {
    const repository = repositoryMock();
    const stored = candidate('noncanonical-body');
    stored.contentBlocks.splice(0, stored.contentBlocks.length, {
      type: 'paragraph',
      text: '  工作压力合成内容  ',
    });
    repository.readCandidateSnapshot.mockResolvedValue({
      candidateLimitExceeded: false,
      candidates: [stored],
    });
    const service = new KnowledgeRetrievalService(
      repository,
      new KnowledgeRetrievalPolicy(),
      runtimeConfig(),
    );

    await expect(
      service.retrieve({
        query: '工作压力',
        signal: new AbortController().signal,
        deadlineAt: new Date(Date.now() + 5_000),
      }),
    ).resolves.toMatchObject({ kind: 'unavailable', reason: 'invalid_candidate' });
  });

  it('does not convert cancellation or the total deadline into an ordinary miss', async () => {
    const repository = repositoryMock();
    const cancelled = new AbortController();
    cancelled.abort(new Error('synthetic cancellation'));
    const service = new KnowledgeRetrievalService(
      repository,
      new KnowledgeRetrievalPolicy(),
      runtimeConfig(),
    );

    await expect(
      service.retrieve({
        query: '工作压力',
        signal: cancelled.signal,
        deadlineAt: new Date(Date.now() + 5_000),
      }),
    ).rejects.toThrow('synthetic cancellation');
    await expect(
      service.retrieve({
        query: '工作压力',
        signal: new AbortController().signal,
        deadlineAt: new Date(Date.now() - 1),
      }),
    ).rejects.toBeInstanceOf(KnowledgeRetrievalDeadlineExceededError);
    expect(repository.readCandidateSnapshot).not.toHaveBeenCalled();
  });

  it('rechecks only the selected exact version IDs and reports stale without substitution', async () => {
    const repository = repositoryMock();
    repository.readCandidateSnapshot.mockResolvedValue({
      candidateLimitExceeded: false,
      candidates: [candidate('exact-version')],
    });
    repository.areExactVersionsCurrent.mockResolvedValue(false);
    const service = new KnowledgeRetrievalService(
      repository,
      new KnowledgeRetrievalPolicy(),
      runtimeConfig(),
    );
    const signal = new AbortController().signal;
    const deadlineAt = new Date(Date.now() + 5_000);
    const result = await service.retrieve({ query: '工作压力', signal, deadlineAt });
    expect(result.kind).toBe('hit');
    if (result.kind !== 'hit') throw new Error('Expected a synthetic hit');

    await expect(
      service.recheckCurrent({ bundles: result.bundles, signal, deadlineAt }),
    ).resolves.toEqual({ kind: 'stale' });
    expect(repository.areExactVersionsCurrent).toHaveBeenCalledWith(
      expect.objectContaining({
        versionIds: [result.bundles[0]!.versionId],
      }),
    );
  });
});
