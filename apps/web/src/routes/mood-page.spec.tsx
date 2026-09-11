import type {
  CreateMoodEntryResponse,
  MoodCreationStatusResponse,
  MoodEntry,
  MoodEntryResponse,
  MoodHistoryResponse,
  ProfileResponse,
} from '@mental-health/types';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApiClientError } from '../api/client';
import { MoodPage } from './mood-page';
import { ProfilePage } from './profile-page';

const mocks = vi.hoisted(() => ({
  create: vi.fn(),
  creationStatus: vi.fn(),
  list: vi.fn(),
  get: vi.fn(),
  update: vi.fn(),
  delete: vi.fn(),
  deleteAll: vi.fn(),
  profile: vi.fn(),
}));

vi.mock('../api/mood', () => ({
  createMoodEntry: mocks.create,
  getMoodCreationStatus: mocks.creationStatus,
  listMoodEntries: mocks.list,
  getMoodEntry: mocks.get,
  updateMoodEntry: mocks.update,
  deleteMoodEntry: mocks.delete,
  deleteAllMoodEntries: mocks.deleteAll,
  getProfile: mocks.profile,
}));

const ENTRY_ID = '62000000-0000-4000-8000-000000000001';
const SECOND_ENTRY_ID = '62000000-0000-4000-8000-000000000002';
const CREATED_AT = '2026-09-11T08:00:00.000Z';

function moodEntry(overrides: Partial<MoodEntry> = {}): MoodEntry {
  return {
    id: ENTRY_ID,
    moodScore: 3,
    emotion: 'calm',
    note: '合成心情正文',
    stateRevision: 1,
    createdAt: CREATED_AT,
    updatedAt: CREATED_AT,
    ...overrides,
  };
}

function history(
  entries: MoodEntry[] = [],
  options: Partial<MoodHistoryResponse['data']> = {},
): MoodHistoryResponse {
  return {
    success: true,
    data: {
      days: 7,
      timeZone: 'Asia/Shanghai',
      period: { startDate: '2026-09-05', endDate: '2026-09-11' },
      entries,
      dailyTrend:
        entries.length === 0
          ? []
          : [{ localDate: '2026-09-11', entryCount: entries.length, averageMoodScore: 3.5 }],
      nextCursor: null,
      ...options,
    },
  };
}

function renderMood() {
  return render(
    <MemoryRouter>
      <MoodPage />
    </MemoryRouter>,
  );
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((next) => {
    resolve = next;
  });
  return { promise, resolve };
}

describe('Mood page', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.clearAllMocks();
  });

  it('shows server trend values, missing dates, opaque pagination, and plain-text notes', async () => {
    const unsafeText = '<img src=x onerror=alert(1)><script>alert(1)</script>';
    mocks.list
      .mockResolvedValueOnce(
        history([moodEntry({ note: unsafeText })], { nextCursor: 'opaque+/=cursor' }),
      )
      .mockResolvedValueOnce(
        history([moodEntry({ id: SECOND_ENTRY_ID, moodScore: 4, note: null })]),
      );
    const view = renderMood();

    expect(await screen.findByText('平均 3.5 分 · 1 条')).toBeInTheDocument();
    expect(screen.getAllByText('未记录')).toHaveLength(6);
    expect(screen.getByText(unsafeText)).toBeInTheDocument();
    expect(view.container.querySelector('img')).toBeNull();
    expect(view.container.querySelector('script')).toBeNull();

    await userEvent.click(screen.getByRole('button', { name: '加载更多' }));
    await waitFor(() => expect(mocks.list).toHaveBeenCalledTimes(2));
    expect(mocks.list).toHaveBeenNthCalledWith(2, 7, 'opaque+/=cursor', expect.any(AbortSignal));
    expect(screen.getByText('4 分')).toBeInTheDocument();
  });

  it('preserves an already selected range and loads only genuine 7/30-day switches', async () => {
    const sevenDayEntry = moodEntry({ note: '七天范围内容' });
    const thirtyDayEntry = moodEntry({ note: '三十天范围内容' });
    mocks.list
      .mockResolvedValueOnce(history([sevenDayEntry]))
      .mockResolvedValueOnce(
        history([thirtyDayEntry], {
          days: 30,
          period: { startDate: '2026-08-13', endDate: '2026-09-11' },
        }),
      )
      .mockResolvedValueOnce(history([sevenDayEntry]));
    renderMood();

    expect(await screen.findByText('七天范围内容')).toBeVisible();
    await userEvent.click(screen.getByRole('button', { name: '7 天' }));
    expect(screen.getByText('七天范围内容')).toBeVisible();
    expect(mocks.list).toHaveBeenCalledTimes(1);

    await userEvent.click(screen.getByRole('button', { name: '30 天' }));
    expect(await screen.findByText('三十天范围内容')).toBeVisible();
    expect(mocks.list).toHaveBeenCalledTimes(2);
    await userEvent.click(screen.getByRole('button', { name: '30 天' }));
    expect(screen.getByText('三十天范围内容')).toBeVisible();
    expect(mocks.list).toHaveBeenCalledTimes(2);

    await userEvent.click(screen.getByRole('button', { name: '7 天' }));
    expect(await screen.findByText('七天范围内容')).toBeVisible();
    expect(mocks.list).toHaveBeenCalledTimes(3);
  });

  it('counts trimmed Unicode code points and prevents a duplicate create click', async () => {
    const localStorageWrite = vi.spyOn(Storage.prototype, 'setItem');
    const created = moodEntry({ moodScore: 5, emotion: 'joyful', note: '🙂' });
    const response: CreateMoodEntryResponse = {
      success: true,
      data: { entry: created, disposition: 'created' },
    };
    mocks.list.mockResolvedValueOnce(history()).mockResolvedValueOnce(history([created]));
    mocks.create.mockResolvedValue(response);
    renderMood();

    await screen.findByText('这段时间还没有心情记录。');
    const note = screen.getByLabelText('备注（可选）');
    fireEvent.change(note, { target: { value: ` ${'🙂'.repeat(500)} ` } });
    expect(screen.getByText(/500\/500/u)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '保存心情记录' })).toBeEnabled();
    fireEvent.change(note, { target: { value: '🙂'.repeat(501) } });
    expect(screen.getByText(/501\/500/u)).toHaveClass('inline-error');
    expect(screen.getByRole('button', { name: '保存心情记录' })).toBeDisabled();

    fireEvent.change(note, { target: { value: '  🙂  ' } });
    await userEvent.click(screen.getByLabelText('5'));
    await userEvent.selectOptions(screen.getByLabelText('日常情绪（可选）'), 'joyful');
    const submit = screen.getByRole('button', { name: '保存心情记录' });
    fireEvent.click(submit);
    fireEvent.click(submit);

    await waitFor(() => expect(mocks.create).toHaveBeenCalledTimes(1));
    expect(mocks.create.mock.calls[0]?.[0]).toMatchObject({
      clientRequestId: expect.any(String),
      moodScore: 5,
      emotion: 'joyful',
      note: '🙂',
    });
    expect(localStorageWrite).not.toHaveBeenCalled();
  });

  it('uses read-only creation status for an unknown result and a new ID for a fresh action', async () => {
    const created = moodEntry({ note: '结果未知的合成记录' });
    const response: CreateMoodEntryResponse = {
      success: true,
      data: { entry: created, disposition: 'created' },
    };
    const absent: MoodCreationStatusResponse = { success: true, data: { status: 'absent' } };
    mocks.list.mockResolvedValue(history());
    mocks.create.mockRejectedValueOnce(new TypeError('synthetic acknowledgement loss'));
    mocks.create.mockResolvedValueOnce(response);
    mocks.creationStatus.mockResolvedValue(absent);
    renderMood();

    await screen.findByText('这段时间还没有心情记录。');
    fireEvent.change(screen.getByLabelText('备注（可选）'), {
      target: { value: '结果未知的合成记录' },
    });
    await userEvent.click(screen.getByRole('button', { name: '保存心情记录' }));
    expect(await screen.findByText(/不会自动重新提交原创建请求/u)).toBeInTheDocument();
    const firstId = mocks.create.mock.calls[0]?.[0].clientRequestId;

    await userEvent.click(screen.getByRole('button', { name: '核对创建结果' }));
    expect(await screen.findByText(/不保证它以后不会提交/u)).toBeInTheDocument();
    expect(mocks.create).toHaveBeenCalledTimes(1);
    expect(mocks.creationStatus).toHaveBeenCalledWith(firstId, expect.any(AbortSignal));

    await userEvent.click(screen.getByRole('button', { name: '放弃核对并开始新的记录' }));
    await userEvent.click(screen.getByRole('button', { name: '保存心情记录' }));
    await waitFor(() => expect(mocks.create).toHaveBeenCalledTimes(2));
    expect(mocks.create.mock.calls[1]?.[0].clientRequestId).not.toBe(firstId);
  });

  it('keeps unknown-create recovery available across range changes and pagination', async () => {
    const absent: MoodCreationStatusResponse = { success: true, data: { status: 'absent' } };
    mocks.list
      .mockResolvedValueOnce(history())
      .mockResolvedValueOnce(
        history([], {
          days: 30,
          period: { startDate: '2026-08-13', endDate: '2026-09-11' },
          nextCursor: 'opaque-next-page',
        }),
      )
      .mockResolvedValueOnce(
        history([], {
          days: 30,
          period: { startDate: '2026-08-13', endDate: '2026-09-11' },
        }),
      );
    mocks.create.mockRejectedValueOnce(new TypeError('synthetic acknowledgement loss'));
    mocks.creationStatus.mockResolvedValue(absent);
    renderMood();

    await screen.findByText('这段时间还没有心情记录。');
    fireEvent.change(screen.getByLabelText('备注（可选）'), {
      target: { value: '等待核对的合成创建' },
    });
    await userEvent.click(screen.getByRole('button', { name: '保存心情记录' }));
    const requestId = mocks.create.mock.calls[0]?.[0].clientRequestId;
    expect(await screen.findByRole('button', { name: '核对创建结果' })).toBeVisible();

    await userEvent.click(screen.getByRole('button', { name: '30 天' }));
    expect(await screen.findByRole('list', { name: '30 天每日趋势' })).toBeVisible();
    expect(screen.getByRole('button', { name: '核对创建结果' })).toBeVisible();
    await userEvent.click(screen.getByRole('button', { name: '加载更多' }));
    await waitFor(() => expect(mocks.list).toHaveBeenCalledTimes(3));
    expect(screen.getByRole('button', { name: '核对创建结果' })).toBeVisible();

    await userEvent.click(screen.getByRole('button', { name: '核对创建结果' }));
    expect(await screen.findByText(/不保证它以后不会提交/u)).toBeVisible();
    expect(mocks.creationStatus).toHaveBeenCalledWith(requestId, expect.any(AbortSignal));
    expect(mocks.create).toHaveBeenCalledTimes(1);
  });

  it('renders the server current row when create resolves an existing live key', async () => {
    const current = moodEntry({ stateRevision: 3, moodScore: 4, note: '后来编辑后的服务器内容' });
    mocks.list.mockResolvedValueOnce(history()).mockResolvedValueOnce(history([current]));
    mocks.create.mockResolvedValue({
      success: true,
      data: { entry: current, disposition: 'existing' },
    });
    renderMood();

    await screen.findByText('这段时间还没有心情记录。');
    fireEvent.change(screen.getByLabelText('备注（可选）'), { target: { value: '原创建正文' } });
    await userEvent.click(screen.getByRole('button', { name: '保存心情记录' }));

    expect(await screen.findByText(/显示服务器上的最新内容/u)).toBeInTheDocument();
    expect(screen.getByText('后来编辑后的服务器内容')).toBeInTheDocument();
    expect(screen.queryByText('原创建正文')).not.toBeInTheDocument();
  });

  it('accepts a present creation-status observation without replaying the old POST', async () => {
    const current = moodEntry({ note: '只读核对时当前存在的记录' });
    mocks.list.mockResolvedValueOnce(history()).mockResolvedValueOnce(history([current]));
    mocks.create.mockRejectedValueOnce(new TypeError('synthetic acknowledgement loss'));
    mocks.creationStatus.mockResolvedValue({
      success: true,
      data: { status: 'present', entry: current },
    });
    renderMood();

    await screen.findByText('这段时间还没有心情记录。');
    await userEvent.click(screen.getByRole('button', { name: '保存心情记录' }));
    await userEvent.click(await screen.findByRole('button', { name: '核对创建结果' }));

    expect(await screen.findByText('只读核对时当前存在的记录')).toBeInTheDocument();
    expect(screen.getByText(/只表示它现在可见/u)).toBeInTheDocument();
    expect(mocks.create).toHaveBeenCalledTimes(1);
  });

  it('refreshes both the authoritative row and daily trend after an edit conflict', async () => {
    const original = moodEntry({ moodScore: 2 });
    const current = moodEntry({ moodScore: 5, stateRevision: 2, note: '另一标签页的内容' });
    const currentResponse: MoodEntryResponse = { success: true, data: { entry: current } };
    mocks.list
      .mockResolvedValueOnce(
        history([original], {
          dailyTrend: [{ localDate: '2026-09-11', entryCount: 1, averageMoodScore: 2 }],
        }),
      )
      .mockResolvedValueOnce(
        history([current], {
          dailyTrend: [{ localDate: '2026-09-11', entryCount: 1, averageMoodScore: 5 }],
        }),
      );
    mocks.update.mockRejectedValueOnce(
      new ApiClientError('MOOD_STATE_CHANGED', '记录已经变化', 409),
    );
    mocks.get.mockResolvedValue(currentResponse);
    renderMood();

    const entry = await screen.findByText('合成心情正文');
    await userEvent.click(within(entry.closest('li')!).getByRole('button', { name: '编辑' }));
    const editForm = screen.getByRole('heading', { name: '编辑记录' }).closest('form')!;
    await userEvent.click(within(editForm).getByLabelText('5'));
    await userEvent.click(within(editForm).getByRole('button', { name: '保存修改' }));

    expect(await screen.findByText(/已读取服务器当前内容/u)).toBeInTheDocument();
    expect(screen.getByText('另一标签页的内容')).toBeInTheDocument();
    expect(screen.getByText('平均 5.0 分 · 1 条')).toBeVisible();
    expect(mocks.update).toHaveBeenCalledTimes(1);
    expect(mocks.update.mock.calls[0]?.[1]).toMatchObject({ expectedRevision: 1, moodScore: 5 });
    expect(mocks.get).toHaveBeenCalledWith(ENTRY_ID, expect.any(AbortSignal));
    expect(mocks.list).toHaveBeenCalledTimes(2);
  });

  it('aborts a stale pagination read before publishing reconciled history and trend', async () => {
    const original = moodEntry({ moodScore: 2 });
    const current = moodEntry({ moodScore: 5, stateRevision: 2, note: '权威恢复内容' });
    const lateEntry = moodEntry({ id: SECOND_ENTRY_ID, note: '迟到分页内容' });
    const latePage = deferred<MoodHistoryResponse>();
    let appendSignal: AbortSignal | undefined;
    mocks.list
      .mockResolvedValueOnce(history([original], { nextCursor: 'opaque-page-two' }))
      .mockImplementationOnce((_days: number, _cursor: string, signal: AbortSignal) => {
        appendSignal = signal;
        return latePage.promise;
      })
      .mockResolvedValueOnce(
        history([current], {
          dailyTrend: [{ localDate: '2026-09-11', entryCount: 1, averageMoodScore: 5 }],
        }),
      );
    mocks.update.mockRejectedValueOnce(
      new ApiClientError('MOOD_STATE_CHANGED', '记录已经变化', 409),
    );
    mocks.get.mockResolvedValue({ success: true, data: { entry: current } });
    renderMood();

    const entry = await screen.findByText('合成心情正文');
    await userEvent.click(within(entry.closest('li')!).getByRole('button', { name: '编辑' }));
    await userEvent.click(screen.getByRole('button', { name: '加载更多' }));
    await waitFor(() => expect(appendSignal).toBeDefined());
    await userEvent.click(screen.getByRole('button', { name: '保存修改' }));

    expect(await screen.findByText('权威恢复内容')).toBeVisible();
    expect(screen.getByText('平均 5.0 分 · 1 条')).toBeVisible();
    expect(appendSignal?.aborted).toBe(true);
    latePage.resolve(history([lateEntry]));
    await waitFor(() => expect(screen.queryByText('迟到分页内容')).not.toBeInTheDocument());
  });

  it('keeps recovery incomplete when the point read succeeds but full trend refresh fails', async () => {
    const original = moodEntry({ moodScore: 2 });
    const current = moodEntry({ moodScore: 5, stateRevision: 2 });
    mocks.list
      .mockResolvedValueOnce(
        history([original], {
          dailyTrend: [{ localDate: '2026-09-11', entryCount: 1, averageMoodScore: 2 }],
        }),
      )
      .mockRejectedValueOnce(new TypeError('synthetic list refresh failure'));
    mocks.update.mockRejectedValueOnce(
      new ApiClientError('MOOD_STATE_CHANGED', '记录已经变化', 409),
    );
    mocks.get.mockResolvedValue({ success: true, data: { entry: current } });
    renderMood();

    const entry = await screen.findByText('合成心情正文');
    await userEvent.click(within(entry.closest('li')!).getByRole('button', { name: '编辑' }));
    await userEvent.click(screen.getByRole('button', { name: '保存修改' }));

    expect(await screen.findByText(/无法同步完整列表与趋势/u)).toBeVisible();
    expect(screen.getByText('平均 2.0 分 · 1 条')).toBeVisible();
    expect(screen.getByRole('button', { name: '保存修改' })).toBeDisabled();
    expect(mocks.update).toHaveBeenCalledTimes(1);
  });

  it('discards a stale edit snapshot after an authoritative reload and requires a new edit', async () => {
    const original = moodEntry({ moodScore: 2 });
    const current = moodEntry({ moodScore: 5, stateRevision: 2, note: '服务器 revision 2' });
    const updated = moodEntry({ moodScore: 4, stateRevision: 3, note: '服务器 revision 2' });
    mocks.list
      .mockResolvedValueOnce(history([original]))
      .mockResolvedValueOnce(history([current]))
      .mockResolvedValueOnce(history([updated]));
    mocks.update
      .mockRejectedValueOnce(new ApiClientError('MOOD_STATE_CHANGED', '记录已经变化', 409))
      .mockResolvedValueOnce({ success: true, data: { entry: updated } });
    mocks.get.mockRejectedValueOnce(new TypeError('synthetic point read failure'));
    renderMood();

    const entry = await screen.findByText('合成心情正文');
    await userEvent.click(within(entry.closest('li')!).getByRole('button', { name: '编辑' }));
    await userEvent.click(screen.getByRole('button', { name: '保存修改' }));
    expect(await screen.findByText(/刷新成功前不能继续使用旧修订/u)).toBeVisible();
    expect(screen.getByRole('button', { name: '保存修改' })).toBeDisabled();

    await userEvent.click(screen.getByRole('button', { name: '重新加载' }));
    expect(await screen.findByText('服务器 revision 2')).toBeVisible();
    expect(screen.queryByRole('heading', { name: '编辑记录' })).not.toBeInTheDocument();
    expect(screen.getByText(/原编辑草稿未提交/u)).toBeVisible();

    const currentEntry = screen.getByText('服务器 revision 2').closest('li')!;
    await userEvent.click(within(currentEntry).getByRole('button', { name: '编辑' }));
    const freshForm = screen.getByRole('heading', { name: '编辑记录' }).closest('form')!;
    await userEvent.click(within(freshForm).getByLabelText('4'));
    await userEvent.click(within(freshForm).getByRole('button', { name: '保存修改' }));

    await waitFor(() => expect(mocks.update).toHaveBeenCalledTimes(2));
    expect(mocks.update.mock.calls.map((call) => call[1].expectedRevision)).toEqual([1, 2]);
  });

  it('does not claim a refresh after an uncertain delete when the authoritative read fails', async () => {
    const original = moodEntry();
    mocks.list.mockResolvedValue(history([original]));
    mocks.delete.mockRejectedValueOnce(new TypeError('synthetic acknowledgement loss'));
    mocks.get.mockRejectedValueOnce(new TypeError('synthetic read failure'));
    renderMood();

    const entry = await screen.findByText('合成心情正文');
    await userEvent.click(within(entry.closest('li')!).getByRole('button', { name: '删除' }));
    await userEvent.click(
      within(screen.getByRole('dialog')).getByRole('button', { name: '删除记录' }),
    );

    expect(await screen.findByText(/刷新成功前不能继续使用旧修订/u)).toBeInTheDocument();
    expect(mocks.delete).toHaveBeenCalledTimes(1);
    expect(screen.getByRole('button', { name: '编辑' })).toBeDisabled();
  });

  it('uses the server delete-all count and explains the all-history boundary', async () => {
    mocks.list.mockResolvedValue(history());
    mocks.deleteAll.mockResolvedValue({
      success: true,
      data: { deleted: true, entryCount: 12 },
    });
    renderMood();

    await screen.findByText('这段时间还没有心情记录。');
    await userEvent.click(screen.getByRole('button', { name: '删除全部心情记录' }));
    const dialog = screen.getByRole('dialog', { name: '删除全部心情记录？' });
    expect(dialog).toHaveTextContent('包括当前 7 天或 30 天窗口之外');
    expect(dialog).toHaveTextContent('独立 Audit 和备份');
    expect(document.activeElement).toBe(within(dialog).getByRole('button', { name: '取消' }));
    await userEvent.click(within(dialog).getByRole('button', { name: '删除全部' }));

    expect(await screen.findByText('服务器实际删除了 12 条心情记录。')).toBeInTheDocument();
    expect(mocks.deleteAll).toHaveBeenCalledTimes(1);
  });

  it('never automatically repeats an uncertain delete-all request', async () => {
    mocks.list
      .mockResolvedValueOnce(history([moodEntry()]))
      .mockResolvedValueOnce(history([moodEntry({ note: '服务器当前仍可见的记录' })]));
    mocks.deleteAll.mockRejectedValueOnce(new TypeError('synthetic acknowledgement loss'));
    renderMood();

    await screen.findByText('合成心情正文');
    await userEvent.click(screen.getByRole('button', { name: '删除全部心情记录' }));
    await userEvent.click(
      within(screen.getByRole('dialog')).getByRole('button', { name: '删除全部' }),
    );

    expect(await screen.findByText(/删除全部的结果无法确认，已重新读取当前记录/u)).toBeVisible();
    expect(screen.getByText('服务器当前仍可见的记录')).toBeVisible();
    expect(mocks.deleteAll).toHaveBeenCalledTimes(1);
    expect(mocks.list).toHaveBeenCalledTimes(2);
  });
});

describe('Profile page', () => {
  afterEach(() => vi.clearAllMocks());

  it('shows only the minimal server-provided account facts and a Privacy link', async () => {
    const response: ProfileResponse = {
      success: true,
      data: {
        email: 'synthetic-profile@example.test',
        accountCreatedAt: '2026-09-01T00:00:00.000Z',
        adultEligibility: { verified: true, verifiedAt: '2026-09-01T00:01:00.000Z' },
      },
    };
    mocks.profile.mockResolvedValue(response);
    render(
      <MemoryRouter>
        <ProfilePage />
      </MemoryRouter>,
    );

    expect(await screen.findByText('synthetic-profile@example.test')).toBeInTheDocument();
    expect(screen.getByText('成年资格已验证。此页面不展示验证方式或内部证据。')).toBeVisible();
    expect(screen.getByRole('link', { name: '隐私与数据' })).toHaveAttribute(
      'href',
      '/app/privacy',
    );
    expect(screen.queryByRole('textbox')).not.toBeInTheDocument();
  });
});
