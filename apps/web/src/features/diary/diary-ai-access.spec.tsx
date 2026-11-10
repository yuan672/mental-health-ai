import { StrictMode } from 'react';
import { MemoryRouter } from 'react-router';
import { act, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DiaryAiAccess, DiaryTurnReferences } from './diary-ai-access';
import type { DiaryAccessPolicy } from '../../api/diary-memory';
const id = '42d31ea2-1c8e-44a0-920f-ff8e481a7f66';
const book = {
  id,
  name: '合成生活记录',
  cat: 'happy',
  revision: 1,
  createdAt: '2026-09-15',
  updatedAt: '2026-09-15',
};
const ok = (data: unknown) => Response.json({ success: true, data });
function mockApi(
  initial: DiaryAccessPolicy = { mode: 'none', revision: 0, notebookIds: [] },
  fail = false,
) {
  let stored = initial;
  const fetcher = vi.fn<typeof fetch>().mockImplementation(async (input, init) => {
    const url = String(input);
    if (url.endsWith('/diary/notebooks')) return ok({ books: [book] });
    if (init?.method === 'PATCH') {
      expect(new Headers(init.headers).get('x-csrf-token')).toBe('synthetic-csrf');
      if (fail)
        return Response.json(
          { success: false, error: { code: 'CONFLICT', message: '版本已改变' } },
          { status: 409 },
        );
      const body = JSON.parse(String(init.body));
      stored = {
        mode: body.mode,
        notebookIds: body.notebookIds,
        revision: body.expectedRevision + 1,
      };
    }
    return ok({ policy: stored });
  });
  vi.stubGlobal('fetch', fetcher);
  document.cookie = 'mh_csrf=synthetic-csrf; Path=/';
  return fetcher;
}
function mount() {
  return render(
    <StrictMode>
      <DiaryAiAccess />
    </StrictMode>,
  );
}
describe('Diary AI access interactions without browser automation', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    document.cookie = 'mh_csrf=; Max-Age=0; Path=/';
  });
  it('only saves selected books after explicit save, sends CSRF, and persists the selection', async () => {
    const fetcher = mockApi();
    const view = mount();
    await userEvent.click(await screen.findByRole('button', { name: 'AI 日记读取权限' }));
    await userEvent.click(await screen.findByRole('radio', { name: /仅允许指定日记本/ }));
    expect(screen.getByRole('button', { name: '保存设置' })).toBeDisabled();
    await userEvent.click(screen.getByRole('checkbox', { name: '合成生活记录' }));
    expect(fetcher.mock.calls.filter(([, init]) => init?.method === 'PATCH')).toHaveLength(0);
    await userEvent.click(screen.getByRole('button', { name: '保存设置' }));
    expect(await screen.findByRole('status')).toHaveTextContent('已保存');
    const writes = fetcher.mock.calls.filter(([, init]) => init?.method === 'PATCH');
    expect(writes).toHaveLength(1);
    expect(JSON.parse(String(writes[0]![1]!.body))).toEqual({
      mode: 'selected',
      notebookIds: [id],
      expectedRevision: 0,
    });
    view.unmount();
    mount();
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'AI 日记读取权限' })).toHaveTextContent(
        '可参考 1 本日记',
      ),
    );
  });
  it('all and none clear book IDs, while cancelling makes no change', async () => {
    const fetcher = mockApi({ mode: 'selected', revision: 3, notebookIds: [id] });
    mount();
    await userEvent.click(screen.getByRole('button', { name: 'AI 日记读取权限' }));
    await userEvent.click(await screen.findByRole('radio', { name: /允许所有日记本/ }));
    expect(screen.getByText(/包含现有及以后新建/)).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: '取消' }));
    expect(fetcher.mock.calls.filter(([, init]) => init?.method === 'PATCH')).toHaveLength(0);
    for (const mode of ['all', 'none']) {
      await userEvent.click(screen.getByRole('button', { name: 'AI 日记读取权限' }));
      await userEvent.click(
        await screen.findByRole('radio', {
          name: mode === 'all' ? /允许所有日记本/ : /完全不允许/,
        }),
      );
      await userEvent.click(screen.getByRole('button', { name: '保存设置' }));
      await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
      const writes = fetcher.mock.calls.filter(([, init]) => init?.method === 'PATCH');
      expect(JSON.parse(String(writes.at(-1)![1]!.body))).toMatchObject({ mode, notebookIds: [] });
    }
  });
  it('requires re-reading after an uncertain or conflicting write without automatic retries', async () => {
    const fetcher = mockApi(undefined, true);
    mount();
    await userEvent.click(screen.getByRole('button', { name: 'AI 日记读取权限' }));
    await userEvent.click(await screen.findByRole('radio', { name: /允许所有日记本/ }));
    await userEvent.click(screen.getByRole('button', { name: '保存设置' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('重新读取');
    expect(screen.getByRole('button', { name: '保存设置' })).toBeDisabled();
    expect(fetcher.mock.calls.filter(([, init]) => init?.method === 'PATCH')).toHaveLength(1);
    await userEvent.click(screen.getByRole('button', { name: '重新读取权限' }));
    await waitFor(() => expect(screen.getByRole('radio', { name: /完全不允许/ })).toBeChecked());
  });
  it('does not let an older background read replace the permission confirmed by a save', async () => {
    const fetcher = mockApi();
    const original = fetcher.getMockImplementation()!;
    let deferNextRead = false;
    let release!: (response: Response) => void;
    const pending = new Promise<Response>((resolve) => {
      release = resolve;
    });
    fetcher.mockImplementation((input, init) => {
      if (deferNextRead && String(input).endsWith('/diary/ai/access') && init?.method !== 'PATCH') {
        deferNextRead = false;
        return pending;
      }
      return original(input, init);
    });
    mount();
    const trigger = screen.getByRole('button', { name: 'AI 日记读取权限' });
    await waitFor(() => expect(trigger).toHaveTextContent('日记参考已关闭'));
    deferNextRead = true;
    act(() => window.dispatchEvent(new Event('focus')));
    expect(deferNextRead).toBe(false);
    await userEvent.click(trigger);
    await userEvent.click(await screen.findByRole('radio', { name: /允许所有日记本/ }));
    await userEvent.click(screen.getByRole('button', { name: '保存设置' }));
    await waitFor(() => expect(trigger).toHaveTextContent('可参考全部日记'));
    await act(async () => {
      release(ok({ policy: { mode: 'none', revision: 0, notebookIds: [] } }));
      await pending;
    });
    expect(trigger).toHaveTextContent('可参考全部日记');
    expect(fetcher.mock.calls.filter(([, init]) => init?.method === 'PATCH')).toHaveLength(1);
  });
  it('links only available reference metadata to the actual diary route', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        ok({
          recorded: true,
          entries: [
            {
              notebookId: id,
              day: '2026-09-15',
              title: '合成日记标题',
              revision: 1,
              available: true,
            },
            {
              notebookId: id,
              day: '2026-09-14',
              title: '日记已修改或删除',
              revision: 2,
              available: false,
            },
          ],
        }),
      ),
    );
    render(
      <MemoryRouter>
        <DiaryTurnReferences turnId={id} />
      </MemoryRouter>,
    );
    await userEvent.click(await screen.findByText('本次提供给 AI 的日记（2 篇）'));
    expect(screen.getByRole('link', { name: '合成日记标题' })).toHaveAttribute(
      'href',
      `/app/diary/${id}/2026-09-15`,
    );
    expect(screen.getAllByRole('link')).toHaveLength(1);
    expect(screen.getByText(/日记已修改或删除/)).toBeInTheDocument();
  });
});
