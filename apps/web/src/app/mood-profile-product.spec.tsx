import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, useLocation } from 'react-router';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AppRoutes } from './app-routes';
import { SessionProvider } from './session-provider';

const USER_ID = '63000000-0000-4000-8000-000000000001';
const USER_B_ID = '63000000-0000-4000-8000-000000000004';
const SESSION_ID = '63000000-0000-4000-8000-000000000002';
const ENTRY_ID = '63000000-0000-4000-8000-000000000003';
const CREATED_AT = '2026-09-11T08:00:00.000Z';

function success(data: unknown): Response {
  return Response.json({ success: true, data });
}

function session(userId = USER_ID): Response {
  return success({
    user: { id: userId },
    session: { id: SESSION_ID, expiresAt: '2026-09-18T08:00:00.000Z' },
  });
}

function emptyHistoryResponse(): Response {
  return success({
    days: 7,
    timeZone: 'Asia/Shanghai',
    period: { startDate: '2026-09-05', endDate: '2026-09-11' },
    entries: [],
    dailyTrend: [],
    nextCursor: null,
  });
}

function historyResponse(
  note = '仅属于当前会话用户的合成心情正文',
  nextCursor: string | null = null,
) {
  return success({
    days: 7,
    timeZone: 'Asia/Shanghai',
    period: { startDate: '2026-09-05', endDate: '2026-09-11' },
    entries: [
      {
        id: ENTRY_ID,
        moodScore: 3,
        emotion: 'calm',
        note,
        stateRevision: 1,
        createdAt: CREATED_AT,
        updatedAt: CREATED_AT,
      },
    ],
    dailyTrend: [],
    nextCursor,
  });
}

function baseResponse(path: string): Response | null {
  if (path === '/auth/session') return session();
  if (path === '/capabilities') return success({ aiChatEnabled: false });
  if (path === '/quota') {
    return success({
      quota: { dailyLimit: 20, used: 20, remaining: 0, usageDate: '2026-09-11' },
    });
  }
  if (path === '/conversations?limit=20') {
    return success({ conversations: [], nextCursor: null });
  }
  return null;
}

function LocationProbe() {
  const location = useLocation();
  return <output data-testid="location">{location.pathname}</output>;
}

function renderProduct(path: string) {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <SessionProvider>
        <LocationProbe />
        <AppRoutes />
      </SessionProvider>
    </MemoryRouter>,
  );
}

describe('Mood/Profile product integration', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    document.cookie = 'mh_csrf=; Max-Age=0; Path=/';
  });

  it('keeps Mood and Profile available when AI is disabled without consulting AI Consent', async () => {
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async (input) => {
      const url = new URL(String(input));
      const base = baseResponse(`${url.pathname}${url.search}`);
      if (base) return base;
      if (url.pathname === '/mood-entries') return historyResponse();
      if (url.pathname === '/profile') {
        return success({
          email: 'phase5d-e2e@example.test',
          accountCreatedAt: '2026-01-01T00:00:00.000Z',
          adultEligibility: { verified: true, verifiedAt: '2026-01-02T00:00:00.000Z' },
        });
      }
      if (url.pathname === '/consents') throw new Error('Mood/Profile must not request Consent');
      throw new Error(`Unhandled request ${String(input)}`);
    });
    vi.stubGlobal('fetch', fetcher);
    renderProduct('/app/mood');

    expect(
      await screen.findByText('仅属于当前会话用户的合成心情正文', undefined, {
        timeout: 5_000,
      }),
    ).toBeInTheDocument();
    expect(screen.getByText(/不是医疗诊断、持续监测或紧急响应渠道/u)).toBeInTheDocument();
    await userEvent.click(screen.getAllByRole('link', { name: '账号信息' })[0]!);
    expect(await screen.findByText('phase5d-e2e@example.test')).toBeInTheDocument();
    expect(screen.getByText('成年资格已验证。此页面不展示验证方式或内部证据。')).toBeVisible();
    expect(
      fetcher.mock.calls.some(([input]) => new URL(String(input)).pathname === '/consents'),
    ).toBe(false);
  });

  it('clears Mood memory and ignores a late page after a protected mutation returns 401', async () => {
    document.cookie = 'mh_csrf=synthetic-csrf; Path=/';
    let resolveLatePage!: (response: Response) => void;
    let lateSignal: AbortSignal | undefined;
    const latePage = new Promise<Response>((resolve) => {
      resolveLatePage = resolve;
    });
    let userBAuthenticated = false;
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async (input, init) => {
      const url = new URL(String(input));
      if (url.pathname === '/auth/login') {
        userBAuthenticated = true;
        return session(USER_B_ID);
      }
      const base = baseResponse(`${url.pathname}${url.search}`);
      if (base) return base;
      if (url.pathname === `/mood-entries/${ENTRY_ID}` && init?.method === 'DELETE') {
        return Response.json(
          { success: false, error: { code: 'UNAUTHENTICATED', message: '登录已过期' } },
          { status: 401 },
        );
      }
      if (url.pathname === '/mood-entries' && url.searchParams.has('cursor')) {
        lateSignal = init?.signal ?? undefined;
        return latePage;
      }
      if (url.pathname === '/mood-entries') {
        return userBAuthenticated
          ? emptyHistoryResponse()
          : historyResponse(undefined, 'opaque-page-two');
      }
      throw new Error(`Unhandled request ${String(input)}`);
    });
    vi.stubGlobal('fetch', fetcher);
    renderProduct('/app/mood');

    const sensitive = await screen.findByText('仅属于当前会话用户的合成心情正文');
    await userEvent.click(screen.getByRole('button', { name: '加载更多' }));
    await waitFor(() => expect(lateSignal).toBeDefined());
    await userEvent.click(within(sensitive.closest('li')!).getByRole('button', { name: '删除' }));
    await userEvent.click(
      within(screen.getByRole('dialog')).getByRole('button', { name: '删除记录' }),
    );

    expect(await screen.findByRole('heading', { name: '登录' })).toBeInTheDocument();
    expect(screen.queryByText('仅属于当前会话用户的合成心情正文')).not.toBeInTheDocument();
    expect(lateSignal?.aborted).toBe(true);

    resolveLatePage(historyResponse('失效后迟到的合成心情正文'));
    await waitFor(() => expect(screen.getByTestId('location')).toHaveTextContent('/login'));
    expect(screen.queryByText('失效后迟到的合成心情正文')).not.toBeInTheDocument();

    await userEvent.type(screen.getByLabelText('邮箱'), 'user-b@example.test');
    await userEvent.type(screen.getByLabelText('密码'), 'Synthetic-Password-9!');
    await userEvent.click(screen.getByRole('button', { name: '登录' }));
    expect(await screen.findByText('这段时间还没有心情记录。')).toBeInTheDocument();
    expect(screen.queryByText('仅属于当前会话用户的合成心情正文')).not.toBeInTheDocument();
    expect(screen.queryByText('失效后迟到的合成心情正文')).not.toBeInTheDocument();
  });
});
