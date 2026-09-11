import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, useLocation } from 'react-router';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AppRoutes } from './app-routes';
import { SessionProvider } from './session-provider';

const publishedAt = '2026-09-11T08:00:00.000Z';

function success(data: unknown): Response {
  return Response.json({ success: true, data });
}

function session(): Response {
  return success({
    user: { id: '65000000-0000-4000-8000-000000000001' },
    session: {
      id: '65000000-0000-4000-8000-000000000002',
      expiresAt: '2026-09-18T08:00:00.000Z',
    },
  });
}

function articleSummary() {
  return {
    articleKey: 'synthetic-session-boundary',
    title: '仅属于当前会话的合成知识内容',
    summary: '用于验证 Session 清理和 AI 独立性的摘要。',
    version: 1,
    contentOrigin: 'synthetic_fixture',
    reviewStatus: 'unverified',
    reviewedAt: null,
    publishedAt,
    sourcePublishers: ['合成发布者'],
  };
}

function commonResponse(path: string): Response | null {
  if (path === '/auth/session') return session();
  if (path === '/capabilities') return success({ aiChatEnabled: false });
  if (path === '/quota') {
    return success({ quota: { dailyLimit: 20, used: 20, remaining: 0, usageDate: '2026-09-11' } });
  }
  if (path === '/conversations?limit=20') {
    return success({ conversations: [], nextCursor: null });
  }
  return null;
}

function LocationProbe() {
  return <output data-testid="location">{useLocation().pathname}</output>;
}

function renderKnowledge(path = '/app/knowledge') {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <SessionProvider>
        <LocationProbe />
        <AppRoutes />
      </SessionProvider>
    </MemoryRouter>,
  );
}

describe('Knowledge product integration', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    document.cookie = 'mh_csrf=; Max-Age=0; Path=/';
  });

  it('remains readable when AI is disabled, quota is exhausted, and no AI Consent is read', async () => {
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async (input) => {
      const url = new URL(String(input));
      const common = commonResponse(`${url.pathname}${url.search}`);
      if (common) return common;
      if (url.pathname === '/knowledge/articles') {
        return success({ items: [articleSummary()], nextCursor: null });
      }
      if (url.pathname === '/consents')
        throw new Error('Knowledge reading must not request Consent');
      throw new Error(`Unhandled request ${String(input)}`);
    });
    vi.stubGlobal('fetch', fetcher);
    renderKnowledge();

    expect(await screen.findByText('仅属于当前会话的合成知识内容')).toBeVisible();
    expect(screen.getByText('测试内容 · 未核验')).toBeVisible();
    expect(
      fetcher.mock.calls.some(([input]) => new URL(String(input)).pathname === '/consents'),
    ).toBe(false);
  });

  it('clears rendered knowledge and leaves the protected application after an API 401', async () => {
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async (input) => {
      const url = new URL(String(input));
      const common = commonResponse(`${url.pathname}${url.search}`);
      if (common) return common;
      if (url.pathname === '/knowledge/articles' && url.searchParams.has('cursor')) {
        return Response.json(
          { success: false, error: { code: 'UNAUTHENTICATED', message: '登录已过期' } },
          { status: 401 },
        );
      }
      if (url.pathname === '/knowledge/articles') {
        return success({ items: [articleSummary()], nextCursor: 'opaque-expiry-page' });
      }
      throw new Error(`Unhandled request ${String(input)}`);
    });
    vi.stubGlobal('fetch', fetcher);
    renderKnowledge();

    expect(await screen.findByText('仅属于当前会话的合成知识内容')).toBeVisible();
    await userEvent.click(screen.getByRole('button', { name: '加载更多' }));

    expect(await screen.findByRole('heading', { name: '登录' })).toBeVisible();
    expect(screen.queryByText('仅属于当前会话的合成知识内容')).not.toBeInTheDocument();
    await waitFor(() => expect(screen.getByTestId('location')).toHaveTextContent('/login'));
  });

  it('aborts and ignores a late detail response after logout', async () => {
    document.cookie = 'mh_csrf=synthetic-csrf; Path=/';
    let resolveDetail!: (response: Response) => void;
    const detailResponse = new Promise<Response>((resolve) => {
      resolveDetail = resolve;
    });
    let detailSignal: AbortSignal | undefined;
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async (input, init) => {
      const url = new URL(String(input));
      if (url.pathname === '/auth/logout') {
        return success({ loggedOut: true });
      }
      const common = commonResponse(`${url.pathname}${url.search}`);
      if (common) return common;
      if (url.pathname === '/knowledge/articles/synthetic-session-boundary') {
        detailSignal = init?.signal ?? undefined;
        return detailResponse;
      }
      throw new Error(`Unhandled request ${String(input)}`);
    });
    vi.stubGlobal('fetch', fetcher);
    renderKnowledge('/app/knowledge/synthetic-session-boundary');
    await waitFor(() => expect(detailSignal).toBeDefined());

    await userEvent.click(screen.getByRole('button', { name: '退出' }));
    expect(await screen.findByRole('heading', { name: '登录' })).toBeVisible();
    expect(detailSignal?.aborted).toBe(true);
    resolveDetail(
      success({
        article: {
          ...articleSummary(),
          contentBlocks: [{ type: 'paragraph', text: '退出后迟到的合成正文' }],
          sources: [
            {
              publisherName: '合成发布者',
              sourceTitle: '合成来源',
              sourceUrl: 'https://source.synthetic.test/late',
              sourcePublishedAt: null,
              sourceVersionLabel: null,
              sourceLocator: null,
              retrievedAt: publishedAt,
            },
          ],
        },
      }),
    );
    await waitFor(() => expect(screen.getByTestId('location')).toHaveTextContent('/login'));
    expect(screen.queryByText('退出后迟到的合成正文')).not.toBeInTheDocument();
  });
});
