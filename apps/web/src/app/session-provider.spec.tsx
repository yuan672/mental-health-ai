import { act, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { notifySessionInvalidated } from '../api/session-events';
import { SessionProvider, useSession } from './session-provider';

const USER_ID = '53000000-0000-4000-8000-000000000001';
const SESSION_ID = '53000000-0000-4000-8000-000000000002';

function successSession(userId = USER_ID): Response {
  return Response.json({
    success: true,
    data: {
      user: { id: userId },
      session: { id: SESSION_ID, expiresAt: '2026-09-17T08:00:00.000Z' },
    },
  });
}

function SessionProbe() {
  const session = useSession();
  return (
    <div>
      <output data-testid="session-status">{session.state.status}</output>
      {session.state.status === 'authenticated' ? (
        <output data-testid="session-user">{session.state.value.user.id}</output>
      ) : null}
      <button
        type="button"
        onClick={() => void session.login('synthetic@example.test', 'safe-test-password')}
      >
        login
      </button>
    </div>
  );
}

describe('SessionProvider', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('keeps a server bootstrap failure distinct from a guest session', async () => {
    vi.stubGlobal(
      'fetch',
      vi
        .fn<typeof fetch>()
        .mockResolvedValue(
          Response.json(
            { success: false, error: { code: 'INTERNAL_ERROR', message: '服务暂时不可用' } },
            { status: 500 },
          ),
        ),
    );
    render(
      <SessionProvider>
        <SessionProbe />
      </SessionProvider>,
    );
    expect(await screen.findByTestId('session-status')).toHaveTextContent('error');
  });

  it('moves from guest to the authenticated session returned by login', async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        Response.json(
          { success: false, error: { code: 'UNAUTHENTICATED', message: '请先登录' } },
          { status: 401 },
        ),
      )
      .mockResolvedValueOnce(successSession());
    vi.stubGlobal('fetch', fetcher);
    render(
      <SessionProvider>
        <SessionProbe />
      </SessionProvider>,
    );
    expect(await screen.findByTestId('session-status')).toHaveTextContent('guest');
    await userEvent.click(screen.getByRole('button', { name: 'login' }));
    expect(await screen.findByTestId('session-user')).toHaveTextContent(USER_ID);
  });

  it('ignores a stale bootstrap response after session invalidation', async () => {
    let resolveBootstrap!: (response: Response) => void;
    const bootstrap = new Promise<Response>((resolve) => {
      resolveBootstrap = resolve;
    });
    const fetcher = vi.fn<typeof fetch>().mockReturnValue(bootstrap);
    vi.stubGlobal('fetch', fetcher);
    render(
      <SessionProvider>
        <SessionProbe />
      </SessionProvider>,
    );
    expect(screen.getByTestId('session-status')).toHaveTextContent('bootstrapping');
    await waitFor(() => expect(fetcher).toHaveBeenCalledTimes(1));

    act(() => notifySessionInvalidated());
    expect(await screen.findByTestId('session-status')).toHaveTextContent('guest');
    resolveBootstrap(successSession());
    await waitFor(() => expect(screen.getByTestId('session-status')).toHaveTextContent('guest'));
    expect(screen.queryByTestId('session-user')).not.toBeInTheDocument();
  });
});
