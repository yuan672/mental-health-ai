import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes, useNavigate } from 'react-router';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApiClientError } from '../api/client';
import * as knowledgeApi from '../api/knowledge';
import { KnowledgeDetailPage } from './knowledge-detail-page';
import { KnowledgeListPage } from './knowledge-list-page';

const publishedAt = '2026-09-11T08:00:00.000Z';
const reviewedAt = '2026-08-17T09:00:00.000Z';
const retrievedAt = '2026-09-03T10:00:00.000Z';

function article(articleKey = 'synthetic-grounding') {
  return {
    articleKey,
    title: `合成文章 ${articleKey}`,
    summary: '测试分页与阅读状态的合成摘要。',
    version: 2,
    contentOrigin: 'synthetic_fixture' as const,
    reviewStatus: 'unverified' as const,
    reviewedAt: null,
    publishedAt,
    sourcePublishers: ['合成发布者'],
  };
}

function detail(articleKey = 'synthetic-grounding') {
  return {
    ...article(articleKey),
    contentBlocks: [
      { type: 'heading' as const, level: 2 as const, text: '合成章节' },
      { type: 'paragraph' as const, text: '<script>alert(1)</script>' },
      { type: 'list' as const, style: 'unordered' as const, items: ['第一项', '第二项'] },
      { type: 'callout' as const, tone: 'important' as const, text: '合成提醒' },
    ],
    sources: [
      {
        publisherName: '合成发布者',
        sourceTitle: '合成来源标题',
        sourceUrl: 'https://source.synthetic.test/document',
        sourcePublishedAt: '2026-09-01T00:00:00.000Z',
        sourceVersionLabel: 'fixture-v2',
        sourceLocator: '第 2 节',
        retrievedAt,
      },
    ],
  };
}

function renderList() {
  return render(
    <MemoryRouter>
      <Routes>
        <Route path="*" element={<KnowledgeListPage />} />
      </Routes>
    </MemoryRouter>,
  );
}

function RouteSwitch() {
  const navigate = useNavigate();
  return (
    <>
      <button type="button" onClick={() => navigate('/app/knowledge/new-article')}>
        切换文章
      </button>
      <Routes>
        <Route path="/app/knowledge/:articleKey" element={<KnowledgeDetailPage />} />
      </Routes>
    </>
  );
}

describe('Knowledge pages', () => {
  afterEach(() => vi.restoreAllMocks());

  it('keeps existing articles when loading another opaque page fails', async () => {
    const list = vi.spyOn(knowledgeApi, 'listKnowledgeArticles');
    list.mockResolvedValueOnce({
      success: true,
      data: { items: [article()], nextCursor: 'opaque-next-page' },
    });
    list.mockRejectedValueOnce(new Error('synthetic page failure'));
    list.mockResolvedValueOnce({
      success: true,
      data: { items: [article('second-page')], nextCursor: null },
    });
    renderList();

    expect(await screen.findByText('合成文章 synthetic-grounding')).toBeVisible();
    expect(screen.getByText('测试内容 · 未核验')).toBeVisible();
    expect(screen.queryByText('来源核验日期')).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: '加载更多' }));
    expect(await screen.findByText('无法加载更多内容，已显示的文章仍可阅读。')).toBeVisible();
    expect(screen.getByText('合成文章 synthetic-grounding')).toBeVisible();
    expect(list.mock.calls[1]?.[0]).toBe('opaque-next-page');
    await userEvent.click(screen.getByRole('button', { name: '加载更多' }));
    expect(await screen.findByText('合成文章 second-page')).toBeVisible();
    expect(screen.queryByText('无法加载更多内容，已显示的文章仍可阅读。')).not.toBeInTheDocument();
    expect(list.mock.calls[2]?.[0]).toBe('opaque-next-page');
  });

  it('distinguishes an empty list from a failed initial load and supports retry', async () => {
    const list = vi.spyOn(knowledgeApi, 'listKnowledgeArticles');
    list.mockRejectedValueOnce(new Error('synthetic failure')).mockResolvedValueOnce({
      success: true,
      data: { items: [], nextCursor: null },
    });
    renderList();

    expect(await screen.findByText('暂时无法读取知识内容，请稍后重试。')).toBeVisible();
    expect(screen.queryByText('当前没有可阅读的内容')).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: '重试' }));
    expect(await screen.findByText('当前没有可阅读的内容')).toBeVisible();
    expect(screen.getByRole('button', { name: '重新加载' })).toBeVisible();
  });

  it('reloads a successful empty list without duplicate reads and distinguishes later failure', async () => {
    let resolveReload!: (
      value: Awaited<ReturnType<typeof knowledgeApi.listKnowledgeArticles>>,
    ) => void;
    const pendingReload = new Promise<
      Awaited<ReturnType<typeof knowledgeApi.listKnowledgeArticles>>
    >((resolve) => {
      resolveReload = resolve;
    });
    const list = vi
      .spyOn(knowledgeApi, 'listKnowledgeArticles')
      .mockResolvedValueOnce({ success: true, data: { items: [], nextCursor: null } })
      .mockReturnValueOnce(pendingReload)
      .mockRejectedValueOnce(new Error('synthetic reload failure'))
      .mockResolvedValueOnce({
        success: true,
        data: { items: [article('available-after-retry')], nextCursor: null },
      });
    renderList();

    const reload = await screen.findByRole('button', { name: '重新加载' });
    await userEvent.click(reload);
    expect(screen.getByText('正在加载知识内容…')).toBeVisible();
    const pendingButton = screen.getByRole('button', { name: '正在重新加载…' });
    expect(pendingButton).toBeDisabled();
    await userEvent.click(pendingButton);
    expect(list).toHaveBeenCalledTimes(2);
    expect(list.mock.calls[1]?.[0]).toBeNull();
    resolveReload({ success: true, data: { items: [], nextCursor: null } });
    await waitFor(() => expect(screen.getByRole('button', { name: '重新加载' })).toBeVisible());

    await userEvent.click(screen.getByRole('button', { name: '重新加载' }));
    expect(await screen.findByText('暂时无法读取知识内容，请稍后重试。')).toBeVisible();
    expect(screen.queryByText('当前没有可阅读的内容')).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: '重试' }));
    expect(await screen.findByText('合成文章 available-after-retry')).toBeVisible();
    expect(list).toHaveBeenCalledTimes(4);
    expect(list.mock.calls.map(([cursor]) => cursor)).toEqual([null, null, null, null]);
  });

  it('shows the exact curated version review date instead of its publication date', async () => {
    vi.spyOn(knowledgeApi, 'listKnowledgeArticles').mockResolvedValue({
      success: true,
      data: {
        items: [
          {
            ...article('curated-list-article'),
            version: 1,
            contentOrigin: 'curated',
            reviewStatus: 'source_verified',
            reviewedAt,
          },
        ],
        nextCursor: null,
      },
    });
    renderList();

    expect(await screen.findByText('来源核验日期')).toBeVisible();
    expect(screen.getByText('版本 1')).toBeVisible();
    expect(screen.getByText('2026年8月17日')).toBeVisible();
    expect(screen.getByText('2026年9月11日')).toBeVisible();
  });

  it('renders bounded content as text and gives external sources safe link attributes', async () => {
    vi.spyOn(knowledgeApi, 'getKnowledgeArticle').mockResolvedValue({
      success: true,
      data: { article: detail() },
    });
    render(
      <MemoryRouter initialEntries={['/app/knowledge/synthetic-grounding']}>
        <Routes>
          <Route path="/app/knowledge/:articleKey" element={<KnowledgeDetailPage />} />
        </Routes>
      </MemoryRouter>,
    );

    expect(
      await screen.findByRole('heading', { name: '合成文章 synthetic-grounding' }),
    ).toBeVisible();
    expect(screen.getByText('<script>alert(1)</script>')).toBeVisible();
    expect(document.querySelector('script')).toBeNull();
    expect(screen.getByText('测试内容 · 未核验')).toBeVisible();
    expect(screen.getByText(/不是正式发布或审核通过/u)).toBeVisible();
    expect(screen.queryByText(/来源核验日期/u)).not.toBeInTheDocument();
    expect(screen.getByText('合成提醒')).toBeVisible();
    const link = screen.getByRole('link', { name: '打开外部来源（离开本站）' });
    expect(link).toHaveAttribute('href', 'https://source.synthetic.test/document');
    expect(link).toHaveAttribute('target', '_blank');
    expect(link).toHaveAttribute('rel', 'noopener noreferrer');
    expect(link).toHaveAttribute('referrerpolicy', 'no-referrer');
  });

  it('uses a single generic unavailable state for a hidden or missing article', async () => {
    vi.spyOn(knowledgeApi, 'getKnowledgeArticle').mockRejectedValue(
      new ApiClientError('KNOWLEDGE_ARTICLE_NOT_FOUND', 'not found', 404),
    );
    render(
      <MemoryRouter initialEntries={['/app/knowledge/missing']}>
        <Routes>
          <Route path="/app/knowledge/:articleKey" element={<KnowledgeDetailPage />} />
        </Routes>
      </MemoryRouter>,
    );

    expect(await screen.findByRole('heading', { name: '内容当前不可用' })).toBeVisible();
    expect(screen.queryByText(/草稿|撤下/u)).not.toBeInTheDocument();
  });

  it('ignores the old detail response after navigating to another article', async () => {
    let resolveOld!: (value: Awaited<ReturnType<typeof knowledgeApi.getKnowledgeArticle>>) => void;
    const oldResult = new Promise<Awaited<ReturnType<typeof knowledgeApi.getKnowledgeArticle>>>(
      (resolve) => {
        resolveOld = resolve;
      },
    );
    const get = vi.spyOn(knowledgeApi, 'getKnowledgeArticle').mockImplementation((key) => {
      if (key === 'old-article') return oldResult;
      return Promise.resolve({ success: true, data: { article: detail('new-article') } });
    });
    render(
      <MemoryRouter initialEntries={['/app/knowledge/old-article']}>
        <RouteSwitch />
      </MemoryRouter>,
    );

    await userEvent.click(screen.getByRole('button', { name: '切换文章' }));
    expect(await screen.findByRole('heading', { name: '合成文章 new-article' })).toBeVisible();
    resolveOld({ success: true, data: { article: detail('old-article') } });
    await waitFor(() => expect(get).toHaveBeenCalledTimes(2));
    expect(screen.queryByText('合成文章 old-article')).not.toBeInTheDocument();
    expect(screen.getByRole('heading', { name: '合成文章 new-article' })).toBeVisible();
  });

  it('uses exact detail source evidence rather than list summary publishers', async () => {
    vi.spyOn(knowledgeApi, 'getKnowledgeArticle').mockResolvedValue({
      success: true,
      data: { article: detail() },
    });
    render(
      <MemoryRouter initialEntries={['/app/knowledge/synthetic-grounding']}>
        <Routes>
          <Route path="/app/knowledge/:articleKey" element={<KnowledgeDetailPage />} />
        </Routes>
      </MemoryRouter>,
    );
    const sources = await screen.findByRole('heading', { name: '来源' });
    const region = sources.closest('section');
    expect(region).not.toBeNull();
    expect(within(region!).getByText('fixture-v2')).toBeVisible();
    expect(within(region!).getByText('第 2 节')).toBeVisible();
  });

  it('labels a curated article only as source-verified and explains that bounded status', async () => {
    vi.spyOn(knowledgeApi, 'getKnowledgeArticle').mockResolvedValue({
      success: true,
      data: {
        article: {
          ...detail(),
          contentOrigin: 'curated',
          reviewStatus: 'source_verified',
          reviewedAt,
        },
      },
    });
    render(
      <MemoryRouter initialEntries={['/app/knowledge/curated-article']}>
        <Routes>
          <Route path="/app/knowledge/:articleKey" element={<KnowledgeDetailPage />} />
        </Routes>
      </MemoryRouter>,
    );

    expect(await screen.findByText('来源已核对')).toBeVisible();
    expect(screen.getByText('版本 2')).toBeVisible();
    expect(screen.getByText(/不表示专家医疗审核、临床验证/u)).toBeVisible();
    expect(screen.getByText(/来源核验日期/u)).toHaveTextContent('2026年8月17日');
    expect(screen.getByText(/发布于/u)).toHaveTextContent('2026年9月11日');
    expect(screen.getByText('检索时间').closest('div')).toHaveTextContent('2026年9月3日');
    expect(screen.queryByText(/专业审核通过/u)).not.toBeInTheDocument();
  });
});
