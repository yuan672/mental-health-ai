import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  ConversationHistory,
  ConversationHistoryProvider,
  useConversationHistory,
} from './conversation-history';

const FIRST_ID = '54000000-0000-4000-8000-000000000001';
const SECOND_ID = '54000000-0000-4000-8000-000000000002';

function page(id: string, nextCursor: string | null): Response {
  return Response.json({
    success: true,
    data: {
      conversations: [
        {
          id,
          createdAt: '2026-09-10T08:00:00.000Z',
          expiresAt: '2026-12-09T08:00:00.000Z',
          isSaved: false,
        },
      ],
      nextCursor,
    },
  });
}

function HistoryHarness() {
  const history = useConversationHistory();
  return (
    <>
      <ConversationHistory onNewChat={() => undefined} />
      <output data-testid="history-ids">
        {history.conversations.map((item) => item.id).join(',')}
      </output>
      <output data-testid="history-loading">{String(history.loading)}</output>
      <output data-testid="history-loading-more">{String(history.loadingMore)}</output>
      <button type="button" onClick={() => void history.refresh()}>
        refresh history state
      </button>
      <button type="button" onClick={history.clear}>
        clear history state
      </button>
    </>
  );
}

function renderHistory() {
  return render(
    <MemoryRouter>
      <ConversationHistoryProvider>
        <HistoryHarness />
      </ConversationHistoryProvider>
    </MemoryRouter>,
  );
}

describe('ConversationHistoryProvider', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('invalidates a pending refresh when local history is cleared', async () => {
    let resolveRefresh!: (response: Response) => void;
    const pending = new Promise<Response>((resolve) => {
      resolveRefresh = resolve;
    });
    const fetcher = vi.fn<typeof fetch>().mockReturnValue(pending);
    vi.stubGlobal('fetch', fetcher);
    renderHistory();
    await waitFor(() => expect(fetcher).toHaveBeenCalledTimes(1));
    await userEvent.click(screen.getByRole('button', { name: 'clear history state' }));
    resolveRefresh(page(FIRST_ID, null));

    await waitFor(() => expect(screen.getByTestId('history-loading')).toHaveTextContent('false'));
    expect(screen.getByTestId('history-ids')).toHaveTextContent('');
  });

  it('appends cursor pages without duplicating existing metadata', async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(page(FIRST_ID, 'synthetic-cursor'))
      .mockResolvedValueOnce(page(SECOND_ID, null));
    vi.stubGlobal('fetch', fetcher);
    renderHistory();
    await waitFor(() => expect(screen.getByTestId('history-ids')).toHaveTextContent(FIRST_ID));
    await userEvent.click(screen.getByRole('button', { name: '加载更多' }));
    await waitFor(() =>
      expect(screen.getByTestId('history-ids')).toHaveTextContent(`${FIRST_ID},${SECOND_ID}`),
    );
    expect(fetcher.mock.calls[1]?.[0].toString()).toContain('cursor=synthetic-cursor');
  });

  it('clears load-more busy state when a refresh supersedes the cursor request', async () => {
    let resolveLoadMore!: (response: Response) => void;
    const pendingLoadMore = new Promise<Response>((resolve) => {
      resolveLoadMore = resolve;
    });
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(page(FIRST_ID, 'synthetic-cursor'))
      .mockReturnValueOnce(pendingLoadMore)
      .mockResolvedValueOnce(page(FIRST_ID, null));
    vi.stubGlobal('fetch', fetcher);
    renderHistory();
    await waitFor(() => expect(screen.getByTestId('history-ids')).toHaveTextContent(FIRST_ID));

    await userEvent.click(screen.getByRole('button', { name: '加载更多' }));
    await waitFor(() =>
      expect(screen.getByTestId('history-loading-more')).toHaveTextContent('true'),
    );
    await userEvent.click(screen.getByRole('button', { name: 'refresh history state' }));
    await waitFor(() =>
      expect(screen.getByTestId('history-loading-more')).toHaveTextContent('false'),
    );

    resolveLoadMore(page(SECOND_ID, null));
    await waitFor(() => expect(fetcher).toHaveBeenCalledTimes(3));
    expect(screen.getByTestId('history-ids')).not.toHaveTextContent(SECOND_ID);
  });
});
