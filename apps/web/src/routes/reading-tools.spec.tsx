import type { PersonalSettings } from '@mental-health/types';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, expect, it, vi } from 'vitest';
import { PersonalSettingsProvider } from '../app/personal-settings';
import { ReadingTools } from './reading-tools';

const initial: PersonalSettings = {
  displayName: '合成读者',
  biography: '合成个人简介',
  avatarId: null,
  cat: 'shy',
  readingSize: 18,
  bookmarks: [],
  revision: 0,
};
const success = (settings: PersonalSettings) =>
  Response.json({ success: true, data: { settings } });
afterEach(() => {
  vi.unstubAllGlobals();
  document.cookie = 'mh_csrf=; Max-Age=0; Path=/';
});
function mount(articleKey = 'synthetic-reading') {
  document.cookie = 'mh_csrf=synthetic-csrf; Path=/';
  return render(
    <PersonalSettingsProvider>
      <ReadingTools articleKey={articleKey} />
    </PersonalSettingsProvider>,
  );
}

it('persists the reading size and bookmark, preserves name and cat, and can remove the bookmark after remount', async () => {
  let stored = { ...initial };
  vi.stubGlobal(
    'fetch',
    vi.fn<typeof fetch>().mockImplementation(async (_input, init) => {
      if (init?.method === 'PATCH') {
        const { expectedRevision, ...fields } = JSON.parse(String(init.body));
        expect(expectedRevision).toBe(stored.revision);
        stored = { ...fields, revision: stored.revision + 1 };
      }
      return success(stored);
    }),
  );
  const view = mount();
  await userEvent.click(await screen.findByRole('button', { name: '大' }));
  await waitFor(() =>
    expect(screen.getByRole('button', { name: '大' })).toHaveAttribute('aria-pressed', 'true'),
  );
  await userEvent.click(screen.getByRole('button', { name: '收藏这篇文章' }));
  expect(await screen.findByRole('button', { name: '已收藏' })).toHaveAttribute(
    'aria-pressed',
    'true',
  );
  expect(stored).toEqual({
    ...initial,
    readingSize: 20,
    bookmarks: ['synthetic-reading'],
    revision: 2,
  });
  view.unmount();
  mount();
  await userEvent.click(await screen.findByRole('button', { name: '已收藏' }));
  await screen.findByRole('button', { name: '收藏这篇文章' });
  expect(stored.bookmarks).toEqual([]);
});

it('allows recovery when the initial settings request fails', async () => {
  const fetcher = vi
    .fn<typeof fetch>()
    .mockRejectedValueOnce(new TypeError('synthetic offline'))
    .mockImplementation(async () => success(initial));
  vi.stubGlobal('fetch', fetcher);
  mount();
  expect(await screen.findByRole('alert')).toBeInTheDocument();
  await userEvent.click(screen.getByRole('button', { name: '重新读取' }));
  await screen.findByRole('button', { name: '收藏这篇文章' });
  expect(screen.queryByRole('alert')).not.toBeInTheDocument();
});

it('clears an uncertain-write error after rereading the saved result without repeating the mutation', async () => {
  let stored = { ...initial };
  const fetcher = vi.fn<typeof fetch>().mockImplementation(async (_input, init) => {
    if (init?.method === 'PATCH') {
      stored = { ...initial, bookmarks: ['synthetic-reading'], revision: 1 };
      throw new TypeError('synthetic response lost');
    }
    return success(stored);
  });
  vi.stubGlobal('fetch', fetcher);
  mount();
  await userEvent.click(await screen.findByRole('button', { name: '收藏这篇文章' }));
  await screen.findByRole('alert');
  await userEvent.click(screen.getByRole('button', { name: '重新读取' }));
  expect(await screen.findByRole('button', { name: '已收藏' })).toHaveAttribute(
    'aria-pressed',
    'true',
  );
  expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  expect(fetcher.mock.calls.filter(([, init]) => init?.method === 'PATCH')).toHaveLength(1);
});

it('limits adding bookmarks to 100 while still allowing removal', async () => {
  const settings = {
    ...initial,
    bookmarks: Array.from({ length: 100 }, (_, i) => `synthetic-${i}`),
  };
  vi.stubGlobal(
    'fetch',
    vi.fn<typeof fetch>().mockImplementation(async () => success(settings)),
  );
  const view = mount();
  expect(await screen.findByRole('button', { name: '收藏这篇文章' })).toBeDisabled();
  view.unmount();
  mount('synthetic-0');
  expect(await screen.findByRole('button', { name: '已收藏' })).toBeEnabled();
});
