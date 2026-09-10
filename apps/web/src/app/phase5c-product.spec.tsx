import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { type ReactNode } from 'react';
import { MemoryRouter, useLocation } from 'react-router';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AppRoutes } from './app-routes';
import { SessionProvider } from './session-provider';

const USER_ID = '11111111-1111-4111-8111-111111111111';
const SESSION_ID = '22222222-2222-4222-8222-222222222222';
const CONTEXT_ID = '33333333-3333-4333-8333-333333333333';
const GENERATION_ID = '44444444-4444-4444-8444-444444444444';

function success(data: unknown): Response {
  return Response.json({ success: true, data });
}

function LocationProbe() {
  const location = useLocation();
  return <output data-testid="location">{location.pathname}</output>;
}

function TestRouter({ children, path }: { children: ReactNode; path: string }) {
  return <MemoryRouter initialEntries={[path]}>{children}</MemoryRouter>;
}

function renderProduct(path: string) {
  return render(
    <TestRouter path={path}>
      <SessionProvider>
        <LocationProbe />
        <AppRoutes />
      </SessionProvider>
    </TestRouter>,
  );
}

function baseResponse(path: string): Response | null {
  if (path === '/auth/session') {
    return success({
      user: { id: USER_ID },
      session: { id: SESSION_ID, expiresAt: '2026-09-17T08:00:00.000Z' },
    });
  }
  if (path === '/capabilities') return success({ aiChatEnabled: true });
  if (path === '/quota') {
    return success({
      quota: { dailyLimit: 20, used: 0, remaining: 20, usageDate: '2026-09-10' },
    });
  }
  if (path === '/conversations?limit=20') {
    return success({ conversations: [], nextCursor: null });
  }
  return null;
}

function incognitoStream(text = '这是合成的无痕安全回复。'): Response {
  return new Response(
    [
      `event: turn.started\ndata: {"mode":"incognito","generationId":"${GENERATION_ID}"}\n\n`,
      `event: message.segment\ndata: {"mode":"incognito","generationId":"${GENERATION_ID}","sequence":1,"text":"${text}"}\n\n`,
      `event: turn.completed\ndata: {"mode":"incognito","generationId":"${GENERATION_ID}","finishReason":"stop"}\n\n`,
    ].join(''),
    { headers: { 'content-type': 'text/event-stream' } },
  );
}

describe('Phase 5C Incognito and privacy product flows', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    document.cookie = 'mh_csrf=; Max-Age=0; Path=/';
  });

  it('uses the fixed Incognito route and keeps context identifiers in request memory only', async () => {
    document.cookie = 'mh_csrf=synthetic-csrf; Path=/';
    const bodies: unknown[] = [];
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async (input, init) => {
      const url = new URL(String(input));
      const base = baseResponse(url.pathname + url.search);
      if (base) return base;
      if (url.pathname === '/incognito-contexts' && init?.method === 'POST') {
        return success({ context: { id: CONTEXT_ID, expiresAt: '2026-09-10T09:00:00.000Z' } });
      }
      if (url.pathname === '/ai/chat/stream') {
        bodies.push(JSON.parse(String(init?.body)));
        return incognitoStream();
      }
      if (url.pathname === `/incognito-contexts/${CONTEXT_ID}` && init?.method === 'DELETE') {
        return success({ ended: true });
      }
      throw new Error(`Unhandled request ${String(input)}`);
    });
    vi.stubGlobal('fetch', fetcher);

    renderProduct('/app/chat/incognito');
    expect(await screen.findByRole('heading', { name: '临时对话空间' })).toBeInTheDocument();
    expect(screen.getByTestId('location')).toHaveTextContent('/app/chat/incognito');
    await userEvent.click(screen.getByRole('button', { name: '开始无痕对话' }));
    const composer = await screen.findByLabelText('输入无痕消息');
    await userEvent.type(composer, '合成无痕消息');
    await userEvent.click(screen.getByRole('button', { name: '发送' }));

    expect(await screen.findByText('这是合成的无痕安全回复。')).toBeInTheDocument();
    expect(bodies).toHaveLength(1);
    expect(bodies[0]).toMatchObject({
      mode: 'incognito',
      contextId: CONTEXT_ID,
      message: '合成无痕消息',
    });
    expect(screen.getByTestId('location').textContent).not.toContain(CONTEXT_ID);
    expect(localStorage.length).toBe(0);
    expect(sessionStorage.length).toBe(0);
  });

  it('explicitly ends Incognito mode, clears bodies, and does not expose it in history', async () => {
    document.cookie = 'mh_csrf=synthetic-csrf; Path=/';
    let ended = 0;
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async (input, init) => {
      const url = new URL(String(input));
      const base = baseResponse(url.pathname + url.search);
      if (base) return base;
      if (url.pathname === '/incognito-contexts' && init?.method === 'POST') {
        return success({ context: { id: CONTEXT_ID, expiresAt: '2026-09-10T09:00:00.000Z' } });
      }
      if (url.pathname === '/ai/chat/stream') return incognitoStream();
      if (url.pathname === `/incognito-contexts/${CONTEXT_ID}` && init?.method === 'DELETE') {
        ended += 1;
        return success({ ended: true });
      }
      throw new Error(`Unhandled request ${String(input)}`);
    });
    vi.stubGlobal('fetch', fetcher);
    renderProduct('/app/chat/incognito');
    await userEvent.click(await screen.findByRole('button', { name: '开始无痕对话' }));
    await userEvent.type(screen.getByLabelText('输入无痕消息'), '只在内存中的正文');
    await userEvent.click(screen.getByRole('button', { name: '发送' }));
    expect(await screen.findByText('这是合成的无痕安全回复。')).toBeInTheDocument();

    await userEvent.click(screen.getByRole('button', { name: '结束无痕对话' }));
    expect(
      await screen.findByText('无痕对话已结束，当前页面中的普通聊天内容已清除。'),
    ).toBeInTheDocument();
    expect(screen.queryByText('只在内存中的正文')).not.toBeInTheDocument();
    expect(screen.queryByText('这是合成的无痕安全回复。')).not.toBeInTheDocument();
    expect(ended).toBe(1);
    expect(screen.getByText('还没有保存的普通聊天。')).toBeInTheDocument();
  });

  it('retains an approved safety segment after failure and a later send', async () => {
    document.cookie = 'mh_csrf=synthetic-csrf; Path=/';
    let streamRequestCount = 0;
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async (input, init) => {
      const url = new URL(String(input));
      const base = baseResponse(url.pathname + url.search);
      if (base) return base;
      if (url.pathname === '/incognito-contexts' && init?.method === 'POST') {
        return success({ context: { id: CONTEXT_ID, expiresAt: '2026-09-10T09:00:00.000Z' } });
      }
      if (url.pathname === '/ai/chat/stream') {
        streamRequestCount += 1;
        if (streamRequestCount === 1) {
          return new Response(
            [
              `event: turn.started\ndata: {"mode":"incognito","generationId":"${GENERATION_ID}"}\n\n`,
              `event: message.segment\ndata: {"mode":"incognito","generationId":"${GENERATION_ID}","sequence":1,"text":"已显示的最低安全提示。"}\n\n`,
              `event: turn.failed\ndata: {"mode":"incognito","generationId":"${GENERATION_ID}","code":"DATABASE_ERROR","message":"本轮未完成"}\n\n`,
            ].join(''),
            { headers: { 'content-type': 'text/event-stream' } },
          );
        }
        return incognitoStream('第二轮合成回复。');
      }
      if (url.pathname === `/incognito-contexts/${CONTEXT_ID}` && init?.method === 'DELETE') {
        return success({ ended: true });
      }
      throw new Error(`Unhandled request ${String(input)}`);
    });
    vi.stubGlobal('fetch', fetcher);
    renderProduct('/app/chat/incognito');
    await userEvent.click(await screen.findByRole('button', { name: '开始无痕对话' }));

    await userEvent.type(screen.getByLabelText('输入无痕消息'), '第一轮合成内容');
    await userEvent.click(screen.getByRole('button', { name: '发送' }));
    expect(await screen.findByText('已显示的最低安全提示。')).toBeInTheDocument();
    expect(screen.getAllByText('已显示的最低安全提示。')).toHaveLength(1);
    expect(screen.getByText('本轮未完成')).toBeInTheDocument();

    await userEvent.type(screen.getByLabelText('输入无痕消息'), '第二轮合成内容');
    await userEvent.click(screen.getByRole('button', { name: '发送' }));
    expect(await screen.findByText('第二轮合成回复。')).toBeInTheDocument();
    expect(screen.getAllByText('已显示的最低安全提示。')).toHaveLength(1);
  });

  it('allows only one Incognito context create request while creation is pending', async () => {
    document.cookie = 'mh_csrf=synthetic-csrf; Path=/';
    let createCalls = 0;
    let resolveCreate: ((response: Response) => void) | undefined;
    const createResponse = new Promise<Response>((resolve) => {
      resolveCreate = resolve;
    });
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async (input, init) => {
      const url = new URL(String(input));
      const base = baseResponse(url.pathname + url.search);
      if (base) return base;
      if (url.pathname === '/incognito-contexts' && init?.method === 'POST') {
        createCalls += 1;
        return createResponse;
      }
      if (url.pathname === `/incognito-contexts/${CONTEXT_ID}` && init?.method === 'DELETE') {
        return success({ ended: true });
      }
      throw new Error(`Unhandled request ${String(input)}`);
    });
    vi.stubGlobal('fetch', fetcher);
    renderProduct('/app/chat/incognito');
    const start = await screen.findByRole('button', { name: '开始无痕对话' });

    await userEvent.click(start);
    await userEvent.click(start);
    expect(createCalls).toBe(1);
    resolveCreate?.(
      success({ context: { id: CONTEXT_ID, expiresAt: '2026-09-10T09:00:00.000Z' } }),
    );
    expect(await screen.findByLabelText('输入无痕消息')).toBeInTheDocument();
  });

  it('clears Incognito body and ignores a late stream result when switching mode', async () => {
    document.cookie = 'mh_csrf=synthetic-csrf; Path=/';
    const encoder = new TextEncoder();
    let streamController: ReadableStreamDefaultController<Uint8Array> | undefined;
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        streamController = controller;
        controller.enqueue(
          encoder.encode(
            `event: turn.started\ndata: {"mode":"incognito","generationId":"${GENERATION_ID}"}\n\n`,
          ),
        );
      },
    });
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async (input, init) => {
      const url = new URL(String(input));
      const base = baseResponse(url.pathname + url.search);
      if (base) return base;
      if (url.pathname === '/incognito-contexts' && init?.method === 'POST') {
        return success({ context: { id: CONTEXT_ID, expiresAt: '2026-09-10T09:00:00.000Z' } });
      }
      if (url.pathname === '/ai/chat/stream')
        return new Response(body, { headers: { 'content-type': 'text/event-stream' } });
      if (url.pathname === `/incognito-contexts/${CONTEXT_ID}` && init?.method === 'DELETE') {
        return success({ ended: true });
      }
      throw new Error(`Unhandled request ${String(input)}`);
    });
    vi.stubGlobal('fetch', fetcher);
    renderProduct('/app/chat/incognito');
    await userEvent.click(await screen.findByRole('button', { name: '开始无痕对话' }));
    await userEvent.type(screen.getByLabelText('输入无痕消息'), '不可串到普通聊天');
    await userEvent.click(screen.getByRole('button', { name: '发送' }));
    await userEvent.click(screen.getByRole('button', { name: '普通聊天' }));
    expect(await screen.findByRole('heading', { name: '新对话' })).toBeInTheDocument();
    expect(screen.queryByText('不可串到普通聊天')).not.toBeInTheDocument();

    streamController?.enqueue(
      encoder.encode(
        `event: message.segment\ndata: {"mode":"incognito","generationId":"${GENERATION_ID}","sequence":1,"text":"迟到内容"}\n\n`,
      ),
    );
    streamController?.close();
    await waitFor(() => expect(screen.queryByText('迟到内容')).not.toBeInTheDocument());
  });

  it('treats a lost server context as unrecoverable and clears local body memory', async () => {
    document.cookie = 'mh_csrf=synthetic-csrf; Path=/';
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async (input, init) => {
      const url = new URL(String(input));
      const base = baseResponse(url.pathname + url.search);
      if (base) return base;
      if (url.pathname === '/incognito-contexts' && init?.method === 'POST') {
        return success({ context: { id: CONTEXT_ID, expiresAt: '2026-09-10T09:00:00.000Z' } });
      }
      if (url.pathname === '/ai/chat/stream') {
        return Response.json(
          {
            success: false,
            error: { code: 'AI_INCOGNITO_CONTEXT_LOST', message: '无痕上下文已失效' },
          },
          { status: 409 },
        );
      }
      if (url.pathname === `/incognito-contexts/${CONTEXT_ID}` && init?.method === 'DELETE') {
        return success({ ended: true });
      }
      throw new Error(`Unhandled request ${String(input)}`);
    });
    vi.stubGlobal('fetch', fetcher);
    renderProduct('/app/chat/incognito');
    await userEvent.click(await screen.findByRole('button', { name: '开始无痕对话' }));
    await userEvent.type(screen.getByLabelText('输入无痕消息'), '刷新后不能恢复的正文');
    await userEvent.click(screen.getByRole('button', { name: '发送' }));

    expect(await screen.findByRole('heading', { name: '无痕上下文已失效' })).toBeInTheDocument();
    expect(screen.queryByText('刷新后不能恢复的正文')).not.toBeInTheDocument();
    expect(screen.getByText(/旧内容无法恢复/)).toBeInTheDocument();
  });

  it('clears Incognito content when logout removes the protected application', async () => {
    document.cookie = 'mh_csrf=synthetic-csrf; Path=/';
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async (input, init) => {
      const url = new URL(String(input));
      const base = baseResponse(url.pathname + url.search);
      if (base) return base;
      if (url.pathname === '/incognito-contexts' && init?.method === 'POST') {
        return success({ context: { id: CONTEXT_ID, expiresAt: '2026-09-10T09:00:00.000Z' } });
      }
      if (url.pathname === '/') return success({});
      if (url.pathname === '/ai/chat/stream') return incognitoStream();
      if (url.pathname === '/auth/logout' && init?.method === 'POST') {
        return success({ loggedOut: true });
      }
      if (url.pathname === `/incognito-contexts/${CONTEXT_ID}` && init?.method === 'DELETE') {
        return success({ ended: true });
      }
      throw new Error(`Unhandled request ${String(input)}`);
    });
    vi.stubGlobal('fetch', fetcher);
    renderProduct('/app/chat/incognito');
    await userEvent.click(await screen.findByRole('button', { name: '开始无痕对话' }));
    await userEvent.type(screen.getByLabelText('输入无痕消息'), '退出后必须清除的正文');
    await userEvent.click(screen.getByRole('button', { name: '发送' }));
    expect(await screen.findByText('退出后必须清除的正文')).toBeInTheDocument();

    await userEvent.click(screen.getByRole('button', { name: '退出' }));
    expect(await screen.findByRole('heading', { name: '登录' })).toBeInTheDocument();
    expect(screen.queryByText('退出后必须清除的正文')).not.toBeInTheDocument();
  });

  it('renders sanitized current consent state and bounded history without lifecycle controls', async () => {
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async (input) => {
      const url = new URL(String(input));
      const base = baseResponse(url.pathname + url.search);
      if (base) return base;
      if (url.pathname === '/consents') {
        expect(url.searchParams.get('limit')).toBe('20');
        return success({
          currentRequiredConsents: [
            {
              consentType: 'terms_of_service',
              consentVersion: 'terms-v1',
              status: 'accepted',
              acceptedAt: '2026-09-10T08:00:00.000Z',
              withdrawnAt: null,
            },
            {
              consentType: 'privacy_policy',
              consentVersion: 'privacy-v2',
              status: 'not_accepted',
              acceptedAt: null,
              withdrawnAt: null,
            },
          ],
          consents: [
            {
              consentType: 'terms_of_service',
              consentVersion: 'terms-v1',
              status: 'accepted',
              acceptedAt: '2026-09-10T08:00:00.000Z',
              withdrawnAt: null,
            },
          ],
          nextCursor: null,
        });
      }
      throw new Error(`Unhandled request ${String(input)}`);
    });
    vi.stubGlobal('fetch', fetcher);
    renderProduct('/app/privacy');

    expect(await screen.findByRole('heading', { name: '了解当前的数据边界' })).toBeInTheDocument();
    expect(await screen.findAllByText('版本 terms-v1')).toHaveLength(2);
    expect(screen.getByText('尚未接受')).toBeInTheDocument();
    expect(screen.getByText(/必要的 Risk Event、审计记录和备份/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /撤回|接受/u })).not.toBeInTheDocument();
  });
});
