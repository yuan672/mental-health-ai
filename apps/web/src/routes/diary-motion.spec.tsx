import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { createMemoryRouter, RouterProvider } from 'react-router';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { DiaryPage } from './diary-page';

const mocks = vi.hoisted(() => ({
  entries: vi.fn(),
  page: vi.fn(),
  list: vi.fn(),
  timeline: vi.fn(),
  capture: vi.fn(),
  dispose: vi.fn(),
  paint: vi.fn(),
}));
vi.mock('../api/diary', () => ({
  diaryApi: { entries: mocks.entries, page: mocks.page, list: mocks.list },
}));
// These tests cover navigation and draft protection only, not rendered motion.
vi.mock('../features/diary/book-motion', () => ({
  BOOK_OPEN_MS: 1680,
  BOOK_CLOSE_MS: 880,
  createBookModel: () => ({ paint: mocks.paint, dispose: mocks.dispose }),
  skipBookMotion: () => false,
  waitForRouteCat: () => Promise.resolve(true),
  runBookTimeline: mocks.timeline,
  captureNotebookReturn: mocks.capture,
  disposeNotebookReturn: vi.fn(),
  returnNotebookToShelf: vi.fn(() => Promise.resolve(true)),
}));
const bookId = '95000000-0000-4000-8000-000000000001';
const day = '2026-09-14';
const book = {
  id: bookId,
  name: '合成测试日记',
  cat: 'relaxed',
  revision: 1,
  createdAt: `${day}T00:00:00Z`,
  updatedAt: `${day}T00:00:00Z`,
};
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: Error) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
beforeEach(() => {
  vi.clearAllMocks();
  mocks.entries.mockResolvedValue({ data: { book, entries: [], nextBefore: null } });
  mocks.page.mockResolvedValue({
    data: { page: { day, revision: 0, saved: null, draft: null, photos: [], updatedAt: null } },
  });
  mocks.list.mockResolvedValue({ data: { books: [book] } });
  mocks.timeline.mockResolvedValue(true);
  mocks.capture.mockReturnValue(null);
});
async function openBook() {
  const router = createMemoryRouter(
    [{ path: '/app/diary/:bookId?/:day?', element: <DiaryPage /> }],
    { initialEntries: [`/app/diary/${bookId}/${day}`] },
  );
  render(<RouterProvider router={router} />);
  await screen.findByRole('group', { name: '选择小猫心情' });
  await waitFor(() =>
    expect(mocks.timeline).toHaveBeenCalledWith(
      1680,
      expect.any(Function),
      expect.any(AbortSignal),
    ),
  );
  return router;
}

describe('diary open / close orchestration', () => {
  it('keeps the book mounted until both closing and shelf data are ready', async () => {
    const router = await openBook();
    const closing = deferred<boolean>();
    const shelf = deferred<{ data: { books: (typeof book)[] } }>();
    mocks.timeline.mockReturnValueOnce(closing.promise);
    mocks.list.mockReturnValueOnce(shelf.promise);
    fireEvent.click(screen.getByRole('button', { name: '合上日记本' }));
    await act(async () => {
      closing.resolve(true);
    });
    expect(router.state.location.pathname).toContain(bookId);
    expect(mocks.capture).not.toHaveBeenCalled();
    await act(async () => {
      shelf.resolve({ data: { books: [book] } });
    });
    await waitFor(() => expect(router.state.location.pathname).toBe('/app/diary'));
    expect(mocks.capture).toHaveBeenCalledTimes(1);
    await screen.findByRole('heading', { name: '我的小书架' });
  });
  it('lets the user cancel closing without losing an unsaved mood choice', async () => {
    const router = await openBook();
    fireEvent.click(screen.getByRole('button', { name: '开心' }));
    fireEvent.click(screen.getByRole('button', { name: '合上日记本' }));
    await screen.findByRole('dialog', { name: '这一页还没有保存' });
    expect(mocks.list).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: '取消' }));
    expect(router.state.location.pathname).toContain(bookId);
    expect(screen.getByRole('button', { name: '开心' })).toHaveAttribute('aria-pressed', 'true');
    expect(mocks.timeline).toHaveBeenCalledTimes(1);
  });
  it('runs the same close animation after confirming unsaved changes', async () => {
    const router = await openBook();
    fireEvent.click(screen.getByRole('button', { name: '开心' }));
    fireEvent.click(screen.getByRole('button', { name: '合上日记本' }));
    fireEvent.click(await screen.findByRole('button', { name: '放下修改并离开' }));
    await waitFor(() => expect(router.state.location.pathname).toBe('/app/diary'));
    expect(mocks.timeline).toHaveBeenLastCalledWith(
      880,
      expect.any(Function),
      expect.any(AbortSignal),
    );
    expect(mocks.capture).toHaveBeenCalledTimes(1);
  });
  it('restores the editable book and unsaved choice if fetching the shelf fails', async () => {
    const router = await openBook();
    fireEvent.click(screen.getByRole('button', { name: '开心' }));
    mocks.list.mockRejectedValueOnce(new Error('synthetic offline'));
    fireEvent.click(screen.getByRole('button', { name: '合上日记本' }));
    fireEvent.click(await screen.findByRole('button', { name: '放下修改并离开' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('日记和当前输入仍在这里');
    expect(router.state.location.pathname).toContain(bookId);
    expect(screen.getByRole('button', { name: '开心' })).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByRole('button', { name: '合上日记本' })).toBeEnabled();
    expect(mocks.capture).not.toHaveBeenCalled();
    // The failed close must restore the dirty-navigation guard too.
    fireEvent.click(screen.getByRole('button', { name: '合上日记本' }));
    await screen.findByRole('dialog', { name: '这一页还没有保存' });
  });
  it('does not replay opening when navigating to another entry in the same book', async () => {
    const router = await openBook();
    await act(async () => {
      await router.navigate(`/app/diary/${bookId}/2026-09-13`);
    });
    await screen.findByRole('group', { name: '选择小猫心情' });
    expect(mocks.timeline).toHaveBeenCalledTimes(1);
  });
  it('does not return to the shelf after the user leaves during closing', async () => {
    const router = await openBook();
    const shelf = deferred<{ data: { books: (typeof book)[] } }>();
    mocks.list.mockReturnValueOnce(shelf.promise);
    fireEvent.click(screen.getByRole('button', { name: '合上日记本' }));
    await act(async () => {
      await router.navigate('/app/diary/95000000-0000-4000-8000-000000000002');
    });
    await act(async () => {
      shelf.resolve({ data: { books: [book] } });
    });
    expect(router.state.location.pathname).toContain('000000000002');
    expect(mocks.capture).not.toHaveBeenCalled();
  });
});
