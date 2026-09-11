import { assertSyntheticKnowledgeFixtureEnvironment } from '../src/knowledge/knowledge-fixture.service';
import {
  curatedKnowledgeManifestSchema,
  knowledgeArticleDetailResponseSchema,
  knowledgeManifestSchema,
  syntheticKnowledgeManifestSchema,
} from '../src/knowledge/knowledge.schemas';
import { KnowledgeVisibilityPolicy } from '../src/knowledge/knowledge-visibility.policy';

function syntheticManifest() {
  return {
    articleKey: 'synthetic-contract-article',
    version: 1,
    title: '合成测试标题',
    summary: '合成测试摘要',
    contentOrigin: 'synthetic_fixture',
    reviewStatus: 'unverified',
    reviewedBy: null,
    reviewedAt: null,
    contentBlocks: [
      { type: 'heading', level: 2, text: '合成标题块' },
      { type: 'paragraph', text: '<script>synthetic()</script>' },
      { type: 'list', style: 'unordered', items: ['合成列表项'] },
      { type: 'callout', tone: 'important', text: '仅供测试' },
    ],
    sources: [
      {
        publisherName: '合成发布者',
        sourceTitle: '合成来源',
        sourceUrl: 'https://synthetic.invalid/source',
        sourcePublishedAt: null,
        sourceVersionLabel: null,
        sourceLocator: null,
        retrievedAt: '2026-09-11T00:00:00.000Z',
      },
    ],
  };
}

describe('Knowledge Base bounded contracts', () => {
  it('accepts strict bounded structured synthetic content without treating text as HTML', () => {
    const manifest = syntheticKnowledgeManifestSchema.parse(syntheticManifest());
    expect(manifest.contentBlocks[1]).toEqual({
      type: 'paragraph',
      text: '<script>synthetic()</script>',
    });
    expect(knowledgeManifestSchema.parse(manifest).contentOrigin).toBe('synthetic_fixture');
  });

  it('rejects HTML-shaped fields, non-HTTPS sources, oversized text, and invented fixture review', () => {
    expect(() =>
      syntheticKnowledgeManifestSchema.parse({
        ...syntheticManifest(),
        contentBlocks: [{ type: 'html', value: '<b>unsafe</b>' }],
      }),
    ).toThrow();
    expect(() =>
      syntheticKnowledgeManifestSchema.parse({
        ...syntheticManifest(),
        sources: [{ ...syntheticManifest().sources[0], sourceUrl: 'http://example.test' }],
      }),
    ).toThrow();
    expect(() =>
      syntheticKnowledgeManifestSchema.parse({
        ...syntheticManifest(),
        contentBlocks: [{ type: 'paragraph', text: '文'.repeat(2_001) }],
      }),
    ).toThrow();
    expect(() =>
      syntheticKnowledgeManifestSchema.parse({
        ...syntheticManifest(),
        reviewedBy: 'invented-reviewer',
        reviewedAt: '2026-09-11T00:00:00.000Z',
      }),
    ).toThrow();
  });

  it('keeps curated publication on a separate source-verified contract', () => {
    expect(() => curatedKnowledgeManifestSchema.parse(syntheticManifest())).toThrow();
    expect(() =>
      curatedKnowledgeManifestSchema.parse({
        ...syntheticManifest(),
        contentOrigin: 'curated',
        reviewStatus: 'source_verified',
        reviewedBy: null,
        reviewedAt: null,
      }),
    ).toThrow();
  });

  it('fails the synthetic fixture guard closed outside Development/Test and on unsafe test DBs', () => {
    expect(() =>
      assertSyntheticKnowledgeFixtureEnvironment(
        'production',
        'postgresql://test:test@localhost/mental_health_test',
      ),
    ).toThrow();
    expect(() =>
      assertSyntheticKnowledgeFixtureEnvironment(
        'test',
        'postgresql://test:test@localhost/mental_health_development',
      ),
    ).toThrow();
    expect(() =>
      assertSyntheticKnowledgeFixtureEnvironment(
        'test',
        'postgresql://test:test@localhost/mental_health_test',
      ),
    ).not.toThrow();
    expect(() =>
      assertSyntheticKnowledgeFixtureEnvironment(
        'development',
        'postgresql://test:test@localhost/mental_health_development',
      ),
    ).not.toThrow();
  });

  it('never exposes synthetic content through staging or production visibility', () => {
    const policy = new KnowledgeVisibilityPolicy();
    expect(policy.isVisible('synthetic_fixture', 'unverified', 'test')).toBe(true);
    expect(policy.isVisible('synthetic_fixture', 'unverified', 'development')).toBe(true);
    expect(policy.isVisible('synthetic_fixture', 'unverified', 'staging')).toBe(false);
    expect(policy.isVisible('synthetic_fixture', 'unverified', 'production')).toBe(false);
    expect(policy.isVisible('curated', 'unverified', 'test')).toBe(false);
    expect(policy.isVisible('curated', 'source_verified', 'production')).toBe(true);
    expect(policy.isVisible('curated', 'professional_reviewed', 'production')).toBe(false);
  });

  it('validates public detail output and rejects extra/internal fields', () => {
    const manifest = syntheticKnowledgeManifestSchema.parse(syntheticManifest());
    const response = {
      success: true,
      data: {
        article: {
          articleKey: manifest.articleKey,
          title: manifest.title,
          summary: manifest.summary,
          version: manifest.version,
          contentOrigin: manifest.contentOrigin,
          reviewStatus: manifest.reviewStatus,
          reviewedAt: null,
          publishedAt: '2026-09-11T08:00:00.000Z',
          sourcePublishers: ['合成发布者'],
          contentBlocks: manifest.contentBlocks,
          sources: manifest.sources,
        },
      },
    };
    expect(knowledgeArticleDetailResponseSchema.parse(response)).toEqual(response);
    expect(() =>
      knowledgeArticleDetailResponseSchema.parse({
        ...response,
        data: { article: { ...response.data.article, reviewedBy: 'internal' } },
      }),
    ).toThrow();
  });
});
