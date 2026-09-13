import type { KnowledgeReference } from '@mental-health/types';
import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { KnowledgeReferences } from './knowledge-references';

const curatedReference: KnowledgeReference = {
  articleKey: 'synthetic-reference-boundary',
  title: '<script>不可执行的标题</script>',
  version: 2,
  contentOrigin: 'curated',
  reviewStatus: 'source_verified',
  reviewedAt: '2026-09-13T08:00:00.000Z',
  availability: 'currently_published',
  sources: [
    {
      linkState: 'available',
      ordinal: 1,
      publisherName: '合成来源发布者',
      sourceTitle: '<img src=x onerror=alert(1)>',
      sourcePublishedAt: null,
      sourceVersionLabel: null,
      sourceLocator: null,
      retrievedAt: '2026-09-13T08:00:00.000Z',
      sourceUrl: 'https://example.test/source',
    },
  ],
};

describe('KnowledgeReferences', () => {
  it('renders validated references as text and protects outbound links', () => {
    const { container } = render(<KnowledgeReferences references={[curatedReference]} />);

    expect(screen.getByText('<script>不可执行的标题</script>')).toBeInTheDocument();
    expect(screen.getByText(/<img src=x onerror=alert\(1\)>/u)).toBeInTheDocument();
    expect(container.querySelector('script')).toBeNull();
    expect(container.querySelector('img')).toBeNull();
    expect(screen.getByRole('link', { name: /合成来源发布者/u })).toHaveAttribute(
      'rel',
      'noopener noreferrer',
    );
    expect(screen.getByRole('link', { name: /合成来源发布者/u })).toHaveAttribute(
      'referrerpolicy',
      'no-referrer',
    );
  });

  it('labels synthetic and unavailable evidence without creating a link', () => {
    const reference: KnowledgeReference = {
      ...curatedReference,
      contentOrigin: 'synthetic_fixture',
      reviewStatus: 'unverified',
      reviewedAt: null,
      availability: 'no_longer_available',
      sources: [
        {
          linkState: 'unavailable',
          ordinal: 1,
          publisherName: '测试发布者',
          sourceTitle: '已冻结的历史来源',
          sourcePublishedAt: null,
          sourceVersionLabel: null,
          sourceLocator: null,
          retrievedAt: '2026-09-13T08:00:00.000Z',
        },
      ],
    };

    render(<KnowledgeReferences references={[reference]} />);

    expect(screen.getByText('测试内容 · 未核验 · 当前版本不可用')).toBeInTheDocument();
    expect(screen.getByText(/链接当前不可用/u)).toBeInTheDocument();
    expect(screen.queryByRole('link')).not.toBeInTheDocument();
  });
});
