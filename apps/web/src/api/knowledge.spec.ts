import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApiClientError } from './client';
import {
  getKnowledgeArticle,
  knowledgeArticleDetailResponseSchema,
  knowledgeArticleListResponseSchema,
  listKnowledgeArticles,
} from './knowledge';

const publishedAt = '2026-09-11T08:00:00.000Z';

function summary(overrides: Record<string, unknown> = {}) {
  return {
    articleKey: 'synthetic-grounding',
    title: '合成知识文章',
    summary: '只用于测试的摘要。',
    version: 1,
    contentOrigin: 'synthetic_fixture',
    reviewStatus: 'unverified',
    reviewedAt: null,
    publishedAt,
    sourcePublishers: ['合成来源'],
    ...overrides,
  };
}

function detail(overrides: Record<string, unknown> = {}) {
  return {
    ...summary(),
    contentBlocks: [{ type: 'paragraph', text: '仅用于合约测试。' }],
    sources: [
      {
        publisherName: '合成来源',
        sourceTitle: '合成来源标题',
        sourceUrl: 'https://source.synthetic.test/document',
        sourcePublishedAt: null,
        sourceVersionLabel: 'fixture-v1',
        sourceLocator: '合成章节',
        retrievedAt: publishedAt,
      },
    ],
    ...overrides,
  };
}

describe('Knowledge API client contracts', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('passes an opaque cursor through without interpreting it', async () => {
    const cursor = 'opaque+/=cursor.value';
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValue(
        Response.json({ success: true, data: { items: [summary()], nextCursor: null } }),
      );
    vi.stubGlobal('fetch', fetcher);

    await listKnowledgeArticles(cursor);

    const requestUrl = new URL(String(fetcher.mock.calls[0]?.[0]));
    expect(requestUrl.pathname).toBe('/knowledge/articles');
    expect(requestUrl.searchParams.get('limit')).toBe('20');
    expect(requestUrl.searchParams.get('cursor')).toBe(cursor);
    expect(fetcher.mock.calls[0]?.[1]).toMatchObject({ credentials: 'include', method: 'GET' });
  });

  it('strictly validates the current public review and origin combinations', () => {
    expect(() =>
      knowledgeArticleListResponseSchema.parse({
        success: true,
        data: { items: [summary({ reviewStatus: 'source_verified' })], nextCursor: null },
      }),
    ).toThrow();
    expect(() =>
      knowledgeArticleListResponseSchema.parse({
        success: true,
        data: {
          items: [
            summary({
              contentOrigin: 'curated',
              reviewStatus: 'professional_reviewed',
              reviewedAt: publishedAt,
            }),
          ],
          nextCursor: null,
        },
      }),
    ).toThrow();
  });

  it('rejects unsafe source URLs, extra provider fields, and malformed blocks', () => {
    expect(() =>
      knowledgeArticleDetailResponseSchema.parse({
        success: true,
        data: {
          article: detail({
            sources: [{ ...detail().sources[0], sourceUrl: 'http://source.synthetic.test' }],
          }),
        },
      }),
    ).toThrow();
    expect(() =>
      knowledgeArticleDetailResponseSchema.parse({
        success: true,
        data: { article: detail({ providerPayload: { unsafe: true } }) },
      }),
    ).toThrow();
    expect(() =>
      knowledgeArticleDetailResponseSchema.parse({
        success: true,
        data: { article: detail({ contentBlocks: [{ type: 'html', text: '<script />' }] }) },
      }),
    ).toThrow();
  });

  it('maps a malformed detail response to the unified safe client error', async () => {
    vi.stubGlobal(
      'fetch',
      vi
        .fn<typeof fetch>()
        .mockResolvedValue(
          Response.json({ success: true, data: { article: detail({ unexpected: 'field' }) } }),
        ),
    );

    await expect(getKnowledgeArticle('synthetic-grounding')).rejects.toMatchObject({
      code: 'INVALID_API_RESPONSE',
      status: 502,
    } satisfies Partial<ApiClientError>);
  });
});
