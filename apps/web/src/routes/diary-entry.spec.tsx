import type { DiaryContent, DiaryPage as Page } from '@mental-health/types';
import { StrictMode } from 'react';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { createMemoryRouter, RouterProvider } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DiaryPage } from './diary-page';

const mocks = vi.hoisted(() => ({
  entries: vi.fn(),
  page: vi.fn(),
  save: vi.fn(),
  capture: vi.fn(),
  play: vi.fn(),
}));
vi.mock('../api/diary', () => ({
  diaryApi: { entries: mocks.entries, page: mocks.page, save: mocks.save },
}));
vi.mock('../features/diary/book-motion', () => ({
  BOOK_OPEN_MS: 1680,
  BOOK_CLOSE_MS: 880,
  createBookModel: () => null,
  skipBookMotion: () => true,
  waitForRouteCat: () => Promise.resolve(true),
  runBookTimeline: () => Promise.resolve(true),
  captureNotebookReturn: vi.fn(),
  disposeNotebookReturn: vi.fn(),
  returnNotebookToShelf: vi.fn(),
}));
vi.mock('../features/diary/paper-turn', () => ({
  capturePaperTurn: mocks.capture,
  playPaperTurn: mocks.play,
}));

const bookId = '95000000-0000-4000-8000-000000000003';
const today = '2026-09-14';
const otherDay = '2026-09-13';
const book = {
  id: bookId,
  name: '日期隔离合成测试',
  cat: 'relaxed',
  revision: 1,
  createdAt: `${today}T00:00:00Z`,
  updatedAt: `${today}T00:00:00Z`,
};
const original: DiaryContent = {
  title: '第一天',
  body: '第一天的合成记录',
  mood: 'relaxed',
  weather: 'sun',
  photoIds: [],
};
const pages = new Map<string, Page>();
const empty = (day: string): Page => ({
  day,
  revision: 0,
  saved: null,
  draft: null,
  photos: [],
  updatedAt: null,
});
beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2026-09-14T10:00:00Z'));
  vi.clearAllMocks();
  pages.clear();
  pages.set(today, { ...empty(today), revision: 1, saved: structuredClone(original) });
  mocks.capture.mockReturnValue(null);
  mocks.play.mockResolvedValue(undefined);
  mocks.page.mockImplementation(async (_id: string, day: string) => ({
    data: { page: structuredClone(pages.get(day) ?? empty(day)) },
  }));
  mocks.entries.mockImplementation(async () => ({
    data: {
      book,
      nextBefore: null,
      entries: [...pages.values()].map((page) => ({
        day: page.day,
        title: page.saved?.title ?? '',
        mood: page.saved?.mood ?? null,
        weather: page.saved?.weather ?? null,
        hasDraft: Boolean(page.draft),
        published: Boolean(page.saved),
        revision: page.revision,
      })),
    },
  }));
  mocks.save.mockImplementation(
    async (
      _id: string,
      day: string,
      input: { content: DiaryContent; expectedRevision: number; publish: boolean },
    ) => {
      const previous = pages.get(day) ?? empty(day);
      if (input.expectedRevision !== previous.revision)
        throw new Error('Synthetic revision conflict');
      const updated = {
        ...previous,
        revision: previous.revision + 1,
        saved: input.publish ? structuredClone(input.content) : previous.saved,
        draft: input.publish ? null : structuredClone(input.content),
      };
      pages.set(day, updated);
      return { data: { page: structuredClone(updated) } };
    },
  );
});
afterEach(() => vi.useRealTimers());
async function open(path = `/app/diary/${bookId}/${today}`) {
  const router = createMemoryRouter(
    [{ path: '/app/diary/:bookId?/:day?', element: <DiaryPage /> }],
    { initialEntries: [path] },
  );
  render(
    <StrictMode>
      <RouterProvider router={router} />
    </StrictMode>,
  );
  await screen.findByText(original.body);
  return router;
}
async function chooseDate(day: string) {
  fireEvent.click(screen.getAllByRole('button', { name: '写新一天' })[0]!);
  fireEvent.change(await screen.findByLabelText('日记日期'), { target: { value: day } });
  fireEvent.click(screen.getByRole('button', { name: '打开这一天' }));
}

// Non-visual API / router / draft tests. No screenshot or browser acceptance.
describe('new diary dates and turning between saved entries', () => {
  it('saves a different day in the same notebook without replacing the existing diary', async () => {
    const router = await open();
    await chooseDate(otherDay);
    await waitFor(() =>
      expect(router.state.location.pathname).toBe(`/app/diary/${bookId}/${otherDay}`),
    );
    fireEvent.click(await screen.findByRole('button', { name: '开心' }));
    fireEvent.click(screen.getByRole('button', { name: '选天气' }));
    fireEvent.click(screen.getByRole('button', { name: '晴天' }));
    fireEvent.click(screen.getByRole('button', { name: '写日记' }));
    fireEvent.change(screen.getByLabelText('日记正文'), {
      target: { value: '另一天独立的合成记录' },
    });
    fireEvent.click(screen.getByRole('button', { name: '保存这一页' }));
    await screen.findByText('另一天独立的合成记录');
    expect(mocks.save).toHaveBeenCalledWith(
      bookId,
      otherDay,
      expect.objectContaining({ expectedRevision: 0, publish: true }),
    );
    expect(pages.get(otherDay)?.saved?.body).toBe('另一天独立的合成记录');
    expect(pages.get(today)?.saved).toEqual(original);
  });
  it('opens an already written date for editing without clearing or saving it', async () => {
    const router = await open();
    await chooseDate(today);
    expect(screen.getByLabelText('日记正文')).toHaveValue(original.body);
    expect(router.state.location.pathname).toContain(today);
    expect(mocks.save).not.toHaveBeenCalled();
  });
  it('keeps an unsaved draft when the user cancels a date change', async () => {
    await open();
    fireEvent.click(screen.getByRole('button', { name: '编辑这一页' }));
    fireEvent.change(screen.getByLabelText('日记正文'), {
      target: { value: '还没保存的合成修改' },
    });
    await chooseDate(otherDay);
    await screen.findByRole('dialog', { name: '这一页还没有保存' });
    fireEvent.click(screen.getByRole('button', { name: '取消' }));
    expect(screen.getByLabelText('日记正文')).toHaveValue('还没保存的合成修改');
    expect(mocks.page.mock.calls.some(([, day]) => day === otherDay)).toBe(false);
  });
  it('keeps the source visible while fetching and consumes the prefetched page once', async () => {
    const router = await open();
    let finish!: (response: { data: { page: Page } }) => void;
    mocks.page.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    await chooseDate(otherDay);
    expect(router.state.location.pathname).toContain(today);
    expect(screen.getByText(original.body)).toBeInTheDocument();
    expect(mocks.capture).not.toHaveBeenCalled();
    await act(async () => {
      finish({ data: { page: empty(otherDay) } });
    });
    await waitFor(() => expect(router.state.location.pathname).toContain(otherDay));
    expect(mocks.capture).toHaveBeenCalledWith(expect.any(HTMLElement), 'back');
    expect(mocks.play).toHaveBeenCalled();
    expect(mocks.page.mock.calls.filter(([, day]) => day === otherDay)).toHaveLength(1);
  });
  it('turns backward and forward from the page edges using the approved paper surface', async () => {
    pages.set(otherDay, {
      ...empty(otherDay),
      revision: 1,
      saved: { ...original, title: '更早的一天', body: '更早的合成记录' },
    });
    const router = await open();
    fireEvent.click(screen.getByRole('button', { name: '上一篇日记' }));
    await screen.findByText('更早的合成记录');
    expect(mocks.capture).toHaveBeenLastCalledWith(expect.any(HTMLElement), 'back');
    fireEvent.click(screen.getByRole('button', { name: '下一篇日记' }));
    await screen.findByText(original.body);
    expect(mocks.capture).toHaveBeenLastCalledWith(expect.any(HTMLElement), 'forward');
    expect(router.state.location.pathname).toContain(today);
    expect(mocks.save).not.toHaveBeenCalled();
  });
  it('leaves the current page untouched when the destination request fails', async () => {
    const router = await open();
    mocks.page.mockRejectedValueOnce(new Error('Synthetic offline'));
    await chooseDate(otherDay);
    expect(await screen.findByRole('alert')).toHaveTextContent('当前内容仍保留');
    expect(screen.getByText(original.body)).toBeInTheDocument();
    expect(router.state.location.pathname).toContain(today);
    expect(mocks.capture).not.toHaveBeenCalled();
  });
  it('anchors the open page to its date after midnight while the today shortcut updates', async () => {
    const router = await open(`/app/diary/${bookId}`);
    await waitFor(() => expect(router.state.location.pathname).toContain(today));
    fireEvent.click(screen.getByRole('button', { name: '编辑这一页' }));
    fireEvent.change(screen.getByLabelText('日记正文'), {
      target: { value: '跨午夜仍属于这一天' },
    });
    vi.setSystemTime(new Date('2026-09-15T01:00:00Z'));
    act(() => window.dispatchEvent(new Event('focus')));
    expect(router.state.location.pathname).toContain(today);
    expect(screen.getByLabelText('日记正文')).toHaveValue('跨午夜仍属于这一天');
    fireEvent.click(screen.getByRole('button', { name: '写新一天' }));
    expect(await screen.findByLabelText('日记日期')).toHaveValue('2026-09-15');
  });
  it('rejects future dates before starting a request', async () => {
    await open();
    fireEvent.click(screen.getAllByRole('button', { name: '写新一天' })[0]!);
    fireEvent.change(await screen.findByLabelText('日记日期'), { target: { value: '2026-09-15' } });
    expect(screen.getByRole('button', { name: '打开这一天' })).toBeDisabled();
    expect(mocks.page.mock.calls.some(([, day]) => day === '2026-09-15')).toBe(false);
  });
});
