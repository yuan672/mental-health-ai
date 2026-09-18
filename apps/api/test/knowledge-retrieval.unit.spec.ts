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
import contextCases from './fixtures/knowledge-context-cases.json';

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

  it.each(contextCases.queries)(
    'preserves complete context for fixed query: $query',
    (testCase) => {
      const candidates = contextCases.articles.map((article) =>
        knowledgeRetrievalCandidateSchema.parse({
          ...parsedCandidate(candidate(article.articleKey)),
          ...article,
          contentOrigin: 'synthetic_fixture',
          reviewStatus: 'unverified',
          reviewedBy: null,
          reviewedAt: null,
        }),
      );
      const selected = policy.select(testCase.query, candidates, 1_000);
      // The natural-language miss retained by v2 is now an expected hit in v3.
      if (testCase.expectedArticle === null) {
        expect(selected).toEqual([]);
        return;
      }
      const match = selected.find((bundle) => bundle.articleKey === testCase.expectedArticle);
      expect(match?.blocks.map((block) => block.ordinal)).toEqual(testCase.requiredOrdinals);
      expect(
        selected.reduce((total, bundle) => total + bundle.estimatedTokens, 0),
      ).toBeLessThanOrEqual(1_000);
    },
  );

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

  it('skips oversized sections intact and never falls back to a heading-only hit', () => {
    const record = candidate('bounded-blocks');
    record.contentBlocks.splice(
      0,
      record.contentBlocks.length,
      { type: 'heading', level: 2, text: '工作压力完整长章节' },
      { type: 'paragraph', text: `工作压力${'很大'.repeat(700)}` },
      { type: 'heading', level: 2, text: '日常自我照顾' },
      { type: 'paragraph', text: '工作压力可以通过一些日常自我照顾来缓解。' },
    );
    const selected = policy.select('工作压力 日常自我照顾', [parsedCandidate(record)], 800);
    expect(selected).toHaveLength(1);
    expect(selected[0]!.blocks.map((block) => block.ordinal)).toEqual([3, 4]);

    const titleOnly = candidate('title-only', '工作压力');
    titleOnly.contentBlocks.splice(0, titleOnly.contentBlocks.length, {
      type: 'paragraph',
      text: '这段内容与查询没有共同词项。',
    });
    expect(policy.select('工作压力', [parsedCandidate(titleOnly)], 800)).toEqual([]);
    titleOnly.contentBlocks.splice(0, 1, { type: 'heading', level: 2, text: '工作压力' });
    expect(policy.select('工作压力', [parsedCandidate(titleOnly)], 800)).toEqual([]);
  });

  it('retains same-version section conditions, subheadings and article callouts without duplication', () => {
    const record = candidate('complete-context');
    record.contentBlocks.splice(
      0,
      record.contentBlocks.length,
      { type: 'paragraph', text: '合成演示，不能视为效果证明。' },
      { type: 'heading', level: 2, text: '工作压力' },
      { type: 'paragraph', text: '工作压力示例步骤。' },
      { type: 'heading', level: 3, text: '适用边界' },
      { type: 'paragraph', text: '仅在本人愿意且条件允许时尝试，并非必须完成。' },
      { type: 'heading', level: 2, text: '其他说明' },
      { type: 'callout', tone: 'important', text: '不能替代专业帮助。' },
    );
    const parsed = parsedCandidate(record);
    const selected = policy.select('工作压力', [parsed], 800);
    expect(selected).toHaveLength(1);
    expect(selected[0]!.versionId).toBe(parsed.versionId);
    expect(selected[0]!.sources).toEqual(parsed.sources);
    expect(selected[0]!.blocks.map((block) => block.ordinal)).toEqual([1, 2, 3, 4, 5, 6, 7]);
    expect(selected[0]!.estimatedTokens).toBeLessThanOrEqual(800);
    for (const selectedBlock of selected[0]!.blocks) {
      expect(selectedBlock.block).toEqual(parsed.contentBlocks[selectedBlock.ordinal - 1]);
    }
  });

  it('treats an unsectioned article as a whole and cannot drop a large caveat to fit', () => {
    const record = candidate('unsectioned');
    record.contentBlocks.splice(
      0,
      record.contentBlocks.length,
      { type: 'paragraph', text: '工作压力示例。' },
      { type: 'paragraph', text: '仅在条件允许时尝试。' },
    );
    expect(
      policy
        .select('工作压力', [parsedCandidate(record)], 800)[0]!
        .blocks.map((block) => block.ordinal),
    ).toEqual([1, 2]);
    record.contentBlocks.push({ type: 'callout', tone: 'important', text: '边界'.repeat(450) });
    expect(policy.select('工作压力', [parsedCandidate(record)], 800)).toEqual([]);
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
  it('rechecks the total deadline after synchronous indexing instead of delivering a late hit', async () => {
    const repository = repositoryMock();
    repository.readCandidateSnapshot.mockResolvedValue({
      candidateLimitExceeded: false,
      candidates: [],
    });
    const policy = new KnowledgeRetrievalPolicy();
    const deadlineAt = new Date(Date.now() + 5_000);
    jest.spyOn(policy, 'select').mockImplementation(() => {
      jest.spyOn(Date, 'now').mockReturnValue(deadlineAt.getTime() + 1);
      return [];
    });
    const service = new KnowledgeRetrievalService(repository, policy, runtimeConfig());
    try {
      await expect(
        service.retrieve({ query: '工作压力', signal: new AbortController().signal, deadlineAt }),
      ).rejects.toBeInstanceOf(KnowledgeRetrievalDeadlineExceededError);
    } finally {
      jest.restoreAllMocks();
    }
  });

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
    ).resolves.toMatchObject({
      kind: 'corpus_limit_exceeded',
      policyVersion: 'lexical-children-v3',
    });
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
