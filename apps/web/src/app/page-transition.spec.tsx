import { act, fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter, useLocation, useNavigate } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PageTransition } from './page-transition';

function RouteHarness() {
  const navigate = useNavigate();
  const location = useLocation();
  return (
    <main>
      <h1>测试页面</h1>
      <button type="button" onClick={() => navigate('/app/chat')}>
        打开对话
      </button>
      <button type="button" onClick={() => navigate('/app/chat/conversation-1', { replace: true })}>
        绑定会话地址
      </button>
      <output>{location.pathname}</output>
    </main>
  );
}

describe('PageTransition', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.stubGlobal(
      'matchMedia',
      vi.fn().mockReturnValue({
        matches: false,
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
      }),
    );
  });

  afterEach(() => {
    vi.runOnlyPendingTimers();
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('keeps one transition alive when a new chat is rebound to its persistent route', () => {
    render(
      <MemoryRouter initialEntries={['/app/home']}>
        <PageTransition>
          <RouteHarness />
        </PageTransition>
      </MemoryRouter>,
    );

    fireEvent.click(screen.getByRole('button', { name: '打开对话' }));
    expect(screen.getByText('正在打开 · 聊一聊')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: '绑定会话地址' }));
    expect(screen.getByText('/app/chat/conversation-1')).toBeInTheDocument();
    expect(screen.getByText('正在打开 · 聊一聊')).toBeInTheDocument();

    act(() => vi.advanceTimersByTime(860));
    expect(screen.queryByText('正在打开 · 聊一聊')).not.toBeInTheDocument();
  });
});
