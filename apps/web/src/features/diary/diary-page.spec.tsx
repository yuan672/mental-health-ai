import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { DiaryPage } from './diary-page';
import { loadDiaryShelf, saveDiaryShelf, type DiaryShelf } from './diary-store';

const userId = '11111111-1111-4111-8111-111111111111';
const shelf: DiaryShelf = {
  userId,
  activeId: 'notebook-one',
  closed: true,
  books: [
    {
      id: 'notebook-one',
      name: '给自己的日记',
      createdAt: 1,
      updatedAt: 1,
      entries: [],
      drafts: {},
    },
  ],
};

vi.mock('../../app/session-provider', () => ({
  useSession: () => ({
    state: {
      status: 'authenticated',
      value: { user: { id: '11111111-1111-4111-8111-111111111111' } },
    },
  }),
}));

vi.mock('./diary-store', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./diary-store')>();
  return {
    ...actual,
    loadDiaryShelf: vi.fn(),
    saveDiaryShelf: vi.fn(),
  };
});

function renderDiary() {
  return render(
    <MemoryRouter initialEntries={['/app/diary/shelf']}>
      <Routes>
        <Route path="/app/diary/*" element={<DiaryPage />} />
      </Routes>
    </MemoryRouter>,
  );
}

describe('DiaryPage', () => {
  beforeEach(() => {
    vi.mocked(loadDiaryShelf).mockResolvedValue(structuredClone(shelf));
    vi.mocked(saveDiaryShelf).mockResolvedValue();
    vi.stubGlobal(
      'matchMedia',
      vi.fn().mockReturnValue({
        matches: true,
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
      }),
    );
  });

  it('opens a notebook and saves a mood, weather and plain-text entry', async () => {
    const user = userEvent.setup();
    renderDiary();

    await user.click(await screen.findByRole('button', { name: '打开日记本：给自己的日记' }));
    expect(
      await screen.findByRole('heading', { name: '今天，你更像哪只小猫？' }),
    ).toBeInTheDocument();

    await user.click(screen.getByRole('radio', { name: /开心/u }));
    await user.click(screen.getByRole('button', { name: '接着选天气' }));
    await user.click(screen.getByRole('radio', { name: /晴天/u }));
    await user.click(screen.getByRole('button', { name: '开始写日记' }));
    await user.type(screen.getByLabelText('日记标题'), '今天的小事');
    await user.type(
      screen.getByLabelText('日记正文'),
      '<script>alert(1)</script> 今天晒到了太阳。',
    );
    await user.click(screen.getByRole('button', { name: '保存这一页' }));

    expect(await screen.findByRole('heading', { name: '今天的小事' })).toBeInTheDocument();
    expect(screen.getByText('<script>alert(1)</script> 今天晒到了太阳。')).toBeInTheDocument();
    expect(document.querySelector('script')).toBeNull();
    await waitFor(() => expect(saveDiaryShelf).toHaveBeenCalled());
  });

  it('uses the authenticated user identity as the local shelf boundary', async () => {
    renderDiary();
    await screen.findByRole('heading', { name: '我的小书架' });
    expect(loadDiaryShelf).toHaveBeenCalledWith(userId);
  });
});
