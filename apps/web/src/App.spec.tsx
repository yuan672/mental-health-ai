import { render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { App } from './App';

describe('App', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('renders the public product landing without requesting authenticated capabilities', async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValue(
        Response.json(
          { success: false, error: { code: 'UNAUTHENTICATED', message: '请先登录' } },
          { status: 401 },
        ),
      );
    vi.stubGlobal('fetch', fetcher);

    render(<App />);

    expect(screen.getByRole('heading', { name: '今天，也可以慢慢来。' })).toBeInTheDocument();
    expect(screen.getByText(/不提供医疗诊断/)).toBeInTheDocument();
    await waitFor(() => expect(fetcher).toHaveBeenCalledTimes(1));
    expect(String(fetcher.mock.calls[0]?.[0])).toContain('/auth/session');
    expect(String(fetcher.mock.calls[0]?.[0])).not.toContain('/capabilities');
  });
});
