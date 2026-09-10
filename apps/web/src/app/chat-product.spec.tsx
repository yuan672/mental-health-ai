import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { type ReactNode } from 'react';
import { MemoryRouter, useLocation } from 'react-router';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AppRoutes } from './app-routes';
import { SessionProvider } from './session-provider';

const USER_A = '11111111-1111-4111-8111-111111111111';
const USER_B = '22222222-2222-4222-8222-222222222222';
const SESSION_ID = '33333333-3333-4333-8333-333333333333';
const CONVERSATION_ID = '44444444-4444-4444-8444-444444444444';
const OTHER_CONVERSATION_ID = '44444444-4444-4444-8444-444444444445';
const TURN_ID = '55555555-5555-4555-8555-555555555555';
const ASSISTANT_ID = '66666666-6666-4666-8666-666666666666';
const CREATED_AT = '2026-09-10T08:00:00.000Z';

function success(data: unknown): Response {
  return Response.json({ success: true, data });
}

function session(userId = USER_A): Response {
  return success({
    user: { id: userId },
    session: { id: SESSION_ID, expiresAt: '2026-09-17T08:00:00.000Z' },
  });
}

function baseJsonResponse(path: string): Response | null {
  if (path === '/auth/session') return session();
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

function LocationProbe() {
  const location = useLocation();
  return (
    <output data-testid="location">
      {location.pathname}
      {location.search}
    </output>
  );
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

describe('Phase 5B product flows', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    document.cookie = 'mh_csrf=; Max-Age=0; Path=/';
  });

  it('distinguishes an unauthenticated session from a retryable bootstrap failure', async () => {
    const guestFetch = vi
      .fn<typeof fetch>()
      .mockResolvedValue(
        Response.json(
          { success: false, error: { code: 'UNAUTHENTICATED', message: '请先登录' } },
          { status: 401 },
        ),
      );
    vi.stubGlobal('fetch', guestFetch);
    const guestView = renderProduct('/app/chat');
    expect(await screen.findByRole('heading', { name: '登录' })).toBeInTheDocument();
    expect(screen.getByTestId('location')).toHaveTextContent('/login?returnTo=%2Fapp%2Fchat');
    guestView.unmount();

    const retryFetch = vi
      .fn<typeof fetch>()
      .mockRejectedValueOnce(new TypeError('synthetic network failure'))
      .mockImplementation(async (input) => {
        const response = baseJsonResponse(
          new URL(String(input)).pathname + new URL(String(input)).search,
        );
        if (!response) throw new Error(`Unhandled request ${String(input)}`);
        return response;
      });
    vi.stubGlobal('fetch', retryFetch);
    renderProduct('/app/chat');
    expect(await screen.findByRole('alert')).toHaveTextContent('无法确认登录状态');
    await userEvent.click(screen.getByRole('button', { name: '重试' }));
    expect(await screen.findByRole('heading', { name: '新对话' })).toBeInTheDocument();
  });

  it('fails the registration UI closed when requirements are unavailable', async () => {
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async (input) => {
      const path = new URL(String(input)).pathname;
      if (path === '/auth/session') {
        return Response.json(
          { success: false, error: { code: 'UNAUTHENTICATED', message: '请先登录' } },
          { status: 401 },
        );
      }
      if (path === '/auth/registration-requirements') {
        return success({
          registrationEnabled: false,
          minimumAge: 18,
          requiredConsents: [],
        });
      }
      throw new Error(`Unhandled request ${String(input)}`);
    });
    vi.stubGlobal('fetch', fetcher);
    renderProduct('/register');
    expect(await screen.findByRole('heading', { name: '注册暂不可用' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '注册' })).not.toBeInTheDocument();
    expect(fetcher.mock.calls.some(([input]) => String(input).includes('/auth/register'))).toBe(
      false,
    );
  });

  it('submits only server-provided consent versions in the synthetic registration contract', async () => {
    let submittedBody: unknown;
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async (input, init) => {
      const path = new URL(String(input)).pathname;
      if (path === '/auth/session') {
        return Response.json(
          { success: false, error: { code: 'UNAUTHENTICATED', message: '请先登录' } },
          { status: 401 },
        );
      }
      if (path === '/auth/registration-requirements') {
        return success({
          registrationEnabled: true,
          minimumAge: 18,
          requiredConsents: [
            {
              type: 'terms_of_service',
              version: 'synthetic-terms-v7',
              displayKey: 'consent.termsOfService',
            },
            {
              type: 'privacy_policy',
              version: 'synthetic-privacy-v8',
              displayKey: 'consent.privacyPolicy',
            },
          ],
        });
      }
      if (path === '/auth/register') {
        submittedBody = JSON.parse(String(init?.body));
        return success({
          user: { id: USER_A },
          ageVerification: { verified: true, method: 'synthetic', verifiedAt: CREATED_AT },
          consents: [],
        });
      }
      throw new Error(`Unhandled request ${String(input)}`);
    });
    vi.stubGlobal('fetch', fetcher);
    renderProduct('/register');
    await userEvent.type(await screen.findByLabelText('邮箱'), 'synthetic@example.test');
    await userEvent.type(screen.getByLabelText('密码'), 'Synthetic-Password-9!');
    await userEvent.type(screen.getByLabelText('年龄验证凭证'), 'provided-by-test-harness');
    await userEvent.click(screen.getByLabelText(/服务条款/));
    await userEvent.click(screen.getByLabelText(/隐私政策/));
    await userEvent.click(screen.getByRole('button', { name: '注册' }));
    await waitFor(() =>
      expect(screen.getByTestId('location')).toHaveTextContent('/login?registered=1'),
    );
    expect(submittedBody).toMatchObject({
      consents: [
        { consentType: 'terms_of_service', consentVersion: 'synthetic-terms-v7', accepted: true },
        { consentType: 'privacy_policy', consentVersion: 'synthetic-privacy-v8', accepted: true },
      ],
    });
  });

  it('keeps one stream alive while turn.started replaces the new-chat route', async () => {
    document.cookie = 'mh_csrf=synthetic-csrf; Path=/';
    const encoder = new TextEncoder();
    const streamState: {
      controller?: ReadableStreamDefaultController<Uint8Array>;
      signal?: AbortSignal;
    } = {};
    let historyReady = false;
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        streamState.controller = controller;
        controller.enqueue(
          encoder.encode(
            `event: turn.started\ndata: {"mode":"persistent","turnId":"${TURN_ID}","conversationId":"${CONVERSATION_ID}"}\n\n`,
          ),
        );
      },
    });
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async (input, init) => {
      const url = new URL(String(input));
      const path = url.pathname + url.search;
      const base = baseJsonResponse(path);
      if (base) {
        if (path === '/conversations?limit=20' && historyReady) {
          return success({
            conversations: [
              {
                id: CONVERSATION_ID,
                createdAt: CREATED_AT,
                expiresAt: '2026-12-09T08:00:00.000Z',
                isSaved: false,
              },
            ],
            nextCursor: null,
          });
        }
        return base;
      }
      if (url.pathname === '/ai/chat/stream') {
        if (init?.signal) {
          streamState.signal = init.signal;
        }
        return new Response(stream, { headers: { 'content-type': 'text/event-stream' } });
      }
      if (url.pathname === `/conversations/${CONVERSATION_ID}`) {
        return success({
          conversation: {
            id: CONVERSATION_ID,
            createdAt: CREATED_AT,
            expiresAt: '2026-12-09T08:00:00.000Z',
            isSaved: false,
          },
        });
      }
      if (url.pathname === `/conversations/${CONVERSATION_ID}/messages`) {
        return success({
          messages: historyReady
            ? [
                {
                  id: '77777777-7777-4777-8777-777777777777',
                  role: 'user',
                  content: '合成页面消息',
                  sequence: 1,
                  createdAt: CREATED_AT,
                },
                {
                  id: ASSISTANT_ID,
                  role: 'assistant',
                  content: '合成流式回复。',
                  sequence: 2,
                  createdAt: CREATED_AT,
                },
              ]
            : [],
          nextCursor: null,
        });
      }
      throw new Error(`Unhandled request ${String(input)}`);
    });
    vi.stubGlobal('fetch', fetcher);
    renderProduct('/app/chat');
    const composer = await screen.findByLabelText('输入消息');
    await waitFor(() => expect(composer).toBeEnabled());
    await userEvent.type(composer, '合成页面消息');
    await userEvent.click(screen.getByRole('button', { name: '发送' }));
    await waitFor(() => expect(streamState.signal).toBeDefined());
    await waitFor(() =>
      expect(screen.getByTestId('location')).toHaveTextContent(`/app/chat/${CONVERSATION_ID}`),
    );
    expect(streamState.signal?.aborted).toBe(false);
    streamState.controller?.enqueue(
      encoder.encode(
        `event: message.segment\ndata: {"mode":"persistent","turnId":"${TURN_ID}","sequence":1,"text":"合成流式回复。"}\n\nevent: turn.completed\ndata: {"mode":"persistent","turnId":"${TURN_ID}","assistantMessageId":"${ASSISTANT_ID}","finishReason":"stop"}\n\n`,
      ),
    );
    historyReady = true;
    streamState.controller?.close();
    expect(await screen.findByText('合成流式回复。')).toBeInTheDocument();
    await waitFor(() => expect(screen.getByText('今日剩余 20/20')).toBeInTheDocument());
    expect(streamState.signal?.aborted).toBe(false);
  });

  it('disables only AI sending when authenticated capabilities are off', async () => {
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async (input) => {
      const url = new URL(String(input));
      if (url.pathname === '/auth/session') return session();
      if (url.pathname === '/capabilities') return success({ aiChatEnabled: false });
      if (url.pathname === '/quota')
        return success({
          quota: { dailyLimit: 20, used: 0, remaining: 20, usageDate: '2026-09-10' },
        });
      if (url.pathname === '/conversations')
        return success({ conversations: [], nextCursor: null });
      throw new Error(`Unhandled request ${String(input)}`);
    });
    vi.stubGlobal('fetch', fetcher);
    renderProduct('/app/chat');
    expect(
      await screen.findByText('AI 对话当前未开放。聊天记录仍可查看、保留或删除。'),
    ).toBeInTheDocument();
    expect(screen.getByLabelText('输入消息')).toBeDisabled();
    expect(fetcher.mock.calls.some(([input]) => String(input).includes('/ai/chat/stream'))).toBe(
      false,
    );
  });

  it('allows quota-exhausted input to reach the server safety route', async () => {
    document.cookie = 'mh_csrf=synthetic-csrf; Path=/';
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async (input) => {
      const url = new URL(String(input));
      if (url.pathname === '/auth/session') return session();
      if (url.pathname === '/capabilities') return success({ aiChatEnabled: true });
      if (url.pathname === '/quota') {
        return success({
          quota: { dailyLimit: 20, used: 20, remaining: 0, usageDate: '2026-09-10' },
        });
      }
      if (url.pathname === '/conversations' && url.search === '?limit=20') {
        return success({ conversations: [], nextCursor: null });
      }
      if (url.pathname === '/ai/chat/stream') {
        return Response.json({
          success: true,
          data: {
            turn: {
              id: TURN_ID,
              conversationId: CONVERSATION_ID,
              status: 'failed',
              assistantMessageId: null,
            },
          },
        });
      }
      if (url.pathname === `/conversations/${CONVERSATION_ID}`) {
        return success({
          conversation: {
            id: CONVERSATION_ID,
            createdAt: CREATED_AT,
            expiresAt: '2026-12-09T08:00:00.000Z',
            isSaved: false,
          },
        });
      }
      if (url.pathname === `/conversations/${CONVERSATION_ID}/messages`) {
        return success({ messages: [], nextCursor: null });
      }
      throw new Error(`Unhandled request ${String(input)}`);
    });
    vi.stubGlobal('fetch', fetcher);
    renderProduct('/app/chat');
    expect(await screen.findByText(/普通 AI 对话额度已用完/)).toBeInTheDocument();
    const composer = screen.getByLabelText('输入消息');
    expect(composer).toBeEnabled();
    await userEvent.type(composer, '合成额度边界消息');
    await userEvent.click(screen.getByRole('button', { name: '发送' }));
    await waitFor(() =>
      expect(fetcher.mock.calls.some(([input]) => String(input).includes('/ai/chat/stream'))).toBe(
        true,
      ),
    );
  });

  it('retains approved safety text when the terminal event reports persistence failure', async () => {
    document.cookie = 'mh_csrf=synthetic-csrf; Path=/';
    const body = [
      `event: turn.started\ndata: {"mode":"persistent","turnId":"${TURN_ID}","conversationId":"${CONVERSATION_ID}"}\n\n`,
      `event: message.segment\ndata: {"mode":"persistent","turnId":"${TURN_ID}","sequence":1,"text":"合成最低安全提示。"}\n\n`,
      `event: turn.failed\ndata: {"mode":"persistent","turnId":"${TURN_ID}","code":"DATABASE_ERROR","message":"本轮未能保存"}\n\n`,
    ].join('');
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async (input) => {
      const url = new URL(String(input));
      const base = baseJsonResponse(url.pathname + url.search);
      if (base) return base;
      if (url.pathname === '/ai/chat/stream') {
        return new Response(body, { headers: { 'content-type': 'text/event-stream' } });
      }
      throw new Error(`Unhandled request ${String(input)}`);
    });
    vi.stubGlobal('fetch', fetcher);
    renderProduct('/app/chat');
    const composer = await screen.findByLabelText('输入消息');
    await waitFor(() => expect(composer).toBeEnabled());
    await userEvent.type(composer, '合成安全提示持久化失败');
    await userEvent.click(screen.getByRole('button', { name: '发送' }));
    expect(await screen.findByText('合成最低安全提示。')).toBeInTheDocument();
    expect(screen.getByText('内容已显示，但本轮未成功保存。')).toBeInTheDocument();
    expect(screen.getByText('本轮未能保存')).toBeInTheDocument();
  });

  it('aborts active generation and removes user A chat memory before user B logs in', async () => {
    document.cookie = 'mh_csrf=synthetic-csrf; Path=/';
    const encoder = new TextEncoder();
    const streamState: {
      controller?: ReadableStreamDefaultController<Uint8Array>;
      signal?: AbortSignal;
    } = {};
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        streamState.controller = controller;
        controller.enqueue(
          encoder.encode(
            `event: turn.started\ndata: {"mode":"persistent","turnId":"${TURN_ID}","conversationId":"${CONVERSATION_ID}"}\n\n`,
          ),
        );
      },
    });
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async (input, init) => {
      const url = new URL(String(input));
      if (url.pathname === '/auth/session') return session(USER_A);
      if (url.pathname === '/auth/logout') return success({ loggedOut: true });
      if (url.pathname === '/auth/login') return session(USER_B);
      if (url.pathname === '/capabilities') return success({ aiChatEnabled: true });
      if (url.pathname === '/quota') {
        return success({
          quota: { dailyLimit: 20, used: 0, remaining: 20, usageDate: '2026-09-10' },
        });
      }
      if (url.pathname === '/conversations')
        return success({ conversations: [], nextCursor: null });
      if (url.pathname === '/ai/chat/stream') {
        if (init?.signal) {
          streamState.signal = init.signal;
          init.signal.addEventListener('abort', () =>
            streamState.controller?.error(init.signal?.reason),
          );
        }
        return new Response(stream, { headers: { 'content-type': 'text/event-stream' } });
      }
      throw new Error(`Unhandled request ${String(input)}`);
    });
    vi.stubGlobal('fetch', fetcher);
    renderProduct('/app/chat');
    const composer = await screen.findByLabelText('输入消息');
    await waitFor(() => expect(composer).toBeEnabled());
    await userEvent.type(composer, '仅属于用户 A 的合成正文');
    await userEvent.click(screen.getByRole('button', { name: '发送' }));
    await waitFor(() => expect(streamState.signal).toBeDefined());
    await userEvent.click(screen.getByRole('button', { name: '退出' }));
    expect(await screen.findByRole('heading', { name: '登录' })).toBeInTheDocument();
    expect(streamState.signal?.aborted).toBe(true);

    await userEvent.type(screen.getByLabelText('邮箱'), 'user-b@example.test');
    await userEvent.type(screen.getByLabelText('密码'), 'Synthetic-Password-9!');
    await userEvent.click(screen.getByRole('button', { name: '登录' }));
    expect(await screen.findByRole('heading', { name: '新对话' })).toBeInTheDocument();
    expect(screen.queryByText('仅属于用户 A 的合成正文')).not.toBeInTheDocument();
    expect(screen.getByLabelText('输入消息')).toHaveValue('');
  });

  it('clears authenticated chat and ignores stale work after a protected API returns 401', async () => {
    document.cookie = 'mh_csrf=synthetic-csrf; Path=/';
    const initialSensitiveText = '仅属于已过期会话用户的合成正文';
    const lateSensitiveText = '失效后迟到的合成正文';
    const encoder = new TextEncoder();
    let resolveOlderMessages!: (response: Response) => void;
    const olderMessages = new Promise<Response>((resolve) => {
      resolveOlderMessages = resolve;
    });
    const streamState: {
      controller?: ReadableStreamDefaultController<Uint8Array>;
      signal?: AbortSignal;
    } = {};
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        streamState.controller = controller;
        controller.enqueue(
          encoder.encode(
            `event: turn.started\ndata: {"mode":"persistent","turnId":"${TURN_ID}","conversationId":"${CONVERSATION_ID}"}\n\nevent: message.segment\ndata: {"mode":"persistent","turnId":"${TURN_ID}","sequence":1,"text":"合成流式敏感正文"}\n\n`,
          ),
        );
      },
    });
    const metadata = {
      id: CONVERSATION_ID,
      createdAt: CREATED_AT,
      expiresAt: '2026-12-09T08:00:00.000Z',
      isSaved: false,
    };
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async (input, init) => {
      const url = new URL(String(input));
      if (url.pathname === '/auth/session') return session(USER_A);
      if (url.pathname === '/capabilities') return success({ aiChatEnabled: true });
      if (url.pathname === '/quota') {
        return success({
          quota: { dailyLimit: 20, used: 0, remaining: 20, usageDate: '2026-09-10' },
        });
      }
      if (url.pathname === '/conversations' && url.search === '?limit=20') {
        return success({ conversations: [metadata], nextCursor: null });
      }
      if (url.pathname === `/conversations/${CONVERSATION_ID}`) {
        return success({ conversation: metadata });
      }
      if (url.pathname === `/conversations/${CONVERSATION_ID}/messages`) {
        if (url.searchParams.has('cursor')) return olderMessages;
        return success({
          messages: [
            {
              id: ASSISTANT_ID,
              role: 'assistant',
              content: initialSensitiveText,
              sequence: 2,
              createdAt: CREATED_AT,
            },
          ],
          nextCursor: 'synthetic-message-cursor',
        });
      }
      if (url.pathname === '/ai/chat/stream') {
        if (init?.signal) {
          streamState.signal = init.signal;
          init.signal.addEventListener('abort', () =>
            streamState.controller?.error(init.signal?.reason),
          );
        }
        return new Response(stream, { headers: { 'content-type': 'text/event-stream' } });
      }
      if (url.pathname === `/conversations/${CONVERSATION_ID}/save`) {
        return Response.json(
          { success: false, error: { code: 'UNAUTHENTICATED', message: '登录已过期' } },
          { status: 401 },
        );
      }
      throw new Error(`Unhandled request ${String(input)}`);
    });
    vi.stubGlobal('fetch', fetcher);
    renderProduct(`/app/chat/${CONVERSATION_ID}`);

    expect(await screen.findByText(initialSensitiveText)).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: '加载更早消息' }));
    await waitFor(() =>
      expect(fetcher.mock.calls.some(([request]) => String(request).includes('cursor='))).toBe(
        true,
      ),
    );
    await userEvent.type(screen.getByLabelText('输入消息'), '合成会话失效测试');
    await userEvent.click(screen.getByRole('button', { name: '发送' }));
    expect(await screen.findByText('合成流式敏感正文')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: '保留对话' }));

    expect(await screen.findByRole('heading', { name: '登录' })).toBeInTheDocument();
    expect(streamState.signal?.aborted).toBe(true);
    expect(screen.queryByText(initialSensitiveText)).not.toBeInTheDocument();
    expect(screen.queryByText('合成流式敏感正文')).not.toBeInTheDocument();

    resolveOlderMessages(
      success({
        messages: [
          {
            id: '66666666-6666-4666-8666-666666666667',
            role: 'assistant',
            content: lateSensitiveText,
            sequence: 1,
            createdAt: CREATED_AT,
          },
        ],
        nextCursor: null,
      }),
    );
    await waitFor(() =>
      expect(screen.getByTestId('location')).toHaveTextContent(
        `/login?returnTo=%2Fapp%2Fchat%2F${CONVERSATION_ID}`,
      ),
    );
    expect(screen.queryByText(lateSensitiveText)).not.toBeInTheDocument();
  });

  it('renders message-shaped HTML and script payloads only as plain text', async () => {
    const payload = '<img src=x onerror=alert(1)><script>alert(1)</script>';
    const metadata = {
      id: CONVERSATION_ID,
      createdAt: CREATED_AT,
      expiresAt: '2026-12-09T08:00:00.000Z',
      isSaved: false,
    };
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async (input) => {
      const url = new URL(String(input));
      const base = baseJsonResponse(url.pathname + url.search);
      if (base) return base;
      if (url.pathname === `/conversations/${CONVERSATION_ID}`) {
        return success({ conversation: metadata });
      }
      if (url.pathname === `/conversations/${CONVERSATION_ID}/messages`) {
        return success({
          messages: [
            {
              id: ASSISTANT_ID,
              role: 'assistant',
              content: payload,
              sequence: 1,
              createdAt: CREATED_AT,
            },
          ],
          nextCursor: null,
        });
      }
      throw new Error(`Unhandled request ${String(input)}`);
    });
    vi.stubGlobal('fetch', fetcher);
    renderProduct(`/app/chat/${CONVERSATION_ID}`);

    expect(await screen.findByText(payload)).toBeInTheDocument();
    const messageRegion = screen.getByRole('region', { name: '聊天消息' });
    expect(messageRegion.querySelector('img')).toBeNull();
    expect(messageRegion.querySelector('script')).toBeNull();
  });

  it('ignores stale conversation responses after a rapid route selection', async () => {
    const conversationB = '44444444-4444-4444-8444-444444444445';
    let resolveDetailA!: (response: Response) => void;
    let resolveMessagesA!: (response: Response) => void;
    const detailA = new Promise<Response>((resolve) => {
      resolveDetailA = resolve;
    });
    const messagesA = new Promise<Response>((resolve) => {
      resolveMessagesA = resolve;
    });
    const metadata = (id: string, createdAt: string) => ({
      id,
      createdAt,
      expiresAt: '2026-12-09T08:00:00.000Z',
      isSaved: false,
    });
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async (input) => {
      const url = new URL(String(input));
      if (url.pathname === '/auth/session') return session();
      if (url.pathname === '/capabilities') return success({ aiChatEnabled: true });
      if (url.pathname === '/quota')
        return success({
          quota: { dailyLimit: 20, used: 0, remaining: 20, usageDate: '2026-09-10' },
        });
      if (url.pathname === '/conversations') {
        return success({
          conversations: [
            metadata(CONVERSATION_ID, CREATED_AT),
            metadata(conversationB, '2026-09-10T09:00:00.000Z'),
          ],
          nextCursor: null,
        });
      }
      if (url.pathname === `/conversations/${CONVERSATION_ID}`) return detailA;
      if (url.pathname === `/conversations/${CONVERSATION_ID}/messages`) return messagesA;
      if (url.pathname === `/conversations/${conversationB}`)
        return success({ conversation: metadata(conversationB, '2026-09-10T09:00:00.000Z') });
      if (url.pathname === `/conversations/${conversationB}/messages`) {
        return success({
          messages: [
            {
              id: ASSISTANT_ID,
              role: 'assistant',
              content: '用户 B 选择的合成聊天',
              sequence: 1,
              createdAt: CREATED_AT,
            },
          ],
          nextCursor: null,
        });
      }
      throw new Error(`Unhandled request ${String(input)}`);
    });
    vi.stubGlobal('fetch', fetcher);
    renderProduct(`/app/chat/${CONVERSATION_ID}`);
    await waitFor(() =>
      expect(document.querySelector(`a[href="/app/chat/${conversationB}"]`)).not.toBeNull(),
    );
    await userEvent.click(document.querySelector(`a[href="/app/chat/${conversationB}"]`)!);
    expect(await screen.findByText('用户 B 选择的合成聊天')).toBeInTheDocument();

    resolveDetailA(success({ conversation: metadata(CONVERSATION_ID, CREATED_AT) }));
    resolveMessagesA(
      success({
        messages: [
          {
            id: '77777777-7777-4777-8777-777777777777',
            role: 'assistant',
            content: '迟到的用户 A 合成聊天',
            sequence: 1,
            createdAt: CREATED_AT,
          },
        ],
        nextCursor: null,
      }),
    );
    await waitFor(() =>
      expect(screen.queryByText('迟到的用户 A 合成聊天')).not.toBeInTheDocument(),
    );
    expect(screen.getByText('用户 B 选择的合成聊天')).toBeInTheDocument();
  });

  it('uses a new clientRequestId for an explicit retry after a definite failure', async () => {
    document.cookie = 'mh_csrf=synthetic-csrf; Path=/';
    const requestBodies: Array<{ clientRequestId: string }> = [];
    let streamNumber = 0;
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async (input, init) => {
      const url = new URL(String(input));
      const base = baseJsonResponse(url.pathname + url.search);
      if (base) return base;
      if (url.pathname === '/ai/chat/stream') {
        requestBodies.push(JSON.parse(String(init?.body)) as { clientRequestId: string });
        streamNumber += 1;
        const turnId = streamNumber === 1 ? TURN_ID : '55555555-5555-4555-8555-555555555556';
        return new Response(
          `event: turn.started\ndata: {"mode":"persistent","turnId":"${turnId}","conversationId":"${CONVERSATION_ID}"}\n\nevent: turn.failed\ndata: {"mode":"persistent","turnId":"${turnId}","code":"AI_PROVIDER_UNAVAILABLE","message":"合成失败"}\n\n`,
          { headers: { 'content-type': 'text/event-stream' } },
        );
      }
      throw new Error(`Unhandled request ${String(input)}`);
    });
    vi.stubGlobal('fetch', fetcher);
    renderProduct('/app/chat');
    const composer = await screen.findByLabelText('输入消息');
    await waitFor(() => expect(composer).toBeEnabled());
    await userEvent.type(composer, '合成明确失败重试');
    await userEvent.click(screen.getByRole('button', { name: '发送' }));
    await userEvent.click(await screen.findByRole('button', { name: '重新发送' }));
    await waitFor(() => expect(requestBodies).toHaveLength(2));
    expect(requestBodies[1]?.clientRequestId).not.toBe(requestBodies[0]?.clientRequestId);
  });

  it('reuses clientRequestId only when reconciling a network-uncertain result', async () => {
    document.cookie = 'mh_csrf=synthetic-csrf; Path=/';
    const requestBodies: Array<{ clientRequestId: string }> = [];
    let attempt = 0;
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async (input, init) => {
      const url = new URL(String(input));
      if (url.pathname === '/conversations' && url.search === '?limit=20') {
        return success({
          conversations: [
            {
              id: OTHER_CONVERSATION_ID,
              createdAt: CREATED_AT,
              expiresAt: '2026-12-09T08:00:00.000Z',
              isSaved: false,
            },
          ],
          nextCursor: null,
        });
      }
      const base = baseJsonResponse(url.pathname + url.search);
      if (base) return base;
      if (url.pathname === '/ai/chat/stream') {
        requestBodies.push(JSON.parse(String(init?.body)) as { clientRequestId: string });
        attempt += 1;
        if (attempt === 1) throw new TypeError('synthetic uncertain network result');
        return Response.json({
          success: true,
          data: {
            turn: {
              id: TURN_ID,
              conversationId: CONVERSATION_ID,
              status: 'streaming',
              assistantMessageId: null,
            },
          },
        });
      }
      if (url.pathname === `/conversations/${CONVERSATION_ID}`) {
        return success({
          conversation: {
            id: CONVERSATION_ID,
            createdAt: CREATED_AT,
            expiresAt: '2026-12-09T08:00:00.000Z',
            isSaved: false,
          },
        });
      }
      if (url.pathname === `/conversations/${CONVERSATION_ID}/messages`) {
        return success({ messages: [], nextCursor: null });
      }
      throw new Error(`Unhandled request ${String(input)}`);
    });
    vi.stubGlobal('fetch', fetcher);
    renderProduct('/app/chat');
    const composer = await screen.findByLabelText('输入消息');
    await waitFor(() => expect(composer).toBeEnabled());
    await userEvent.type(composer, '合成不确定结果核对');
    await userEvent.click(screen.getByRole('button', { name: '发送' }));
    await userEvent.click(await screen.findByRole('button', { name: '核对本轮结果' }));
    await waitFor(() => expect(requestBodies).toHaveLength(2));
    expect(requestBodies[1]?.clientRequestId).toBe(requestBodies[0]?.clientRequestId);
    expect(screen.getByRole('button', { name: '核对本轮结果' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '重新发送' })).not.toBeInTheDocument();
    expect(composer).toBeDisabled();
    expect(screen.getByRole('button', { name: '新对话' })).toBeDisabled();

    const historyLink = screen.getByRole('link', { name: /9月10日/u });
    expect(historyLink).toHaveAttribute('aria-disabled', 'true');
    await userEvent.click(historyLink);
    expect(screen.getByTestId('location')).toHaveTextContent(`/app/chat/${CONVERSATION_ID}`);
    expect(
      fetcher.mock.calls.filter(([request]) => String(request).includes('/ai/chat/stream')),
    ).toHaveLength(2);
  });

  it('uses the server delete-all count and clears the product history state', async () => {
    document.cookie = 'mh_csrf=synthetic-csrf; Path=/';
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async (input, init) => {
      const url = new URL(String(input));
      const base = baseJsonResponse(url.pathname + url.search);
      if (base) return base;
      if (url.pathname === '/conversations' && init?.method === 'DELETE') {
        return success({ deleted: true, conversationCount: 3 });
      }
      throw new Error(`Unhandled request ${String(input)}`);
    });
    vi.stubGlobal('fetch', fetcher);
    renderProduct('/app/chat');
    await screen.findByRole('heading', { name: '新对话' });

    await userEvent.click(screen.getByRole('button', { name: '删除全部聊天' }));
    expect(screen.getByText(/这会删除所有普通聊天正文，包括已保留的聊天/)).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: '删除全部' }));

    expect(await screen.findByText('已删除 3 次普通聊天。')).toBeInTheDocument();
    expect(
      fetcher.mock.calls.some(
        ([input, init]) =>
          new URL(String(input)).pathname === '/conversations' && init?.method === 'DELETE',
      ),
    ).toBe(true);
  });

  it('cancels the single active stream and reconciles persisted history', async () => {
    document.cookie = 'mh_csrf=synthetic-csrf; Path=/';
    const encoder = new TextEncoder();
    const active: {
      controller?: ReadableStreamDefaultController<Uint8Array>;
      signal?: AbortSignal;
    } = {};
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        active.controller = controller;
        controller.enqueue(
          encoder.encode(
            `event: turn.started\ndata: {"mode":"persistent","turnId":"${TURN_ID}","conversationId":"${CONVERSATION_ID}"}\n\n`,
          ),
        );
      },
    });
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async (input, init) => {
      const url = new URL(String(input));
      const base = baseJsonResponse(url.pathname + url.search);
      if (base) return base;
      if (url.pathname === '/ai/chat/stream') {
        if (init?.signal) {
          active.signal = init.signal;
          init.signal.addEventListener('abort', () =>
            active.controller?.error(init.signal?.reason),
          );
        }
        return new Response(stream, { headers: { 'content-type': 'text/event-stream' } });
      }
      if (url.pathname === `/conversations/${CONVERSATION_ID}`) {
        return success({
          conversation: {
            id: CONVERSATION_ID,
            createdAt: CREATED_AT,
            expiresAt: '2026-12-09T08:00:00.000Z',
            isSaved: false,
          },
        });
      }
      if (url.pathname === `/conversations/${CONVERSATION_ID}/messages`) {
        return success({ messages: [], nextCursor: null });
      }
      throw new Error(`Unhandled request ${String(input)}`);
    });
    vi.stubGlobal('fetch', fetcher);
    renderProduct('/app/chat');
    const composer = await screen.findByLabelText('输入消息');
    await waitFor(() => expect(composer).toBeEnabled());
    await userEvent.type(composer, '合成取消消息');
    await userEvent.click(screen.getByRole('button', { name: '发送' }));
    await userEvent.click(await screen.findByRole('button', { name: '停止' }));
    expect(active.signal?.aborted).toBe(true);
    expect(await screen.findByText('已停止本轮回复。')).toBeInTheDocument();
  });
});
