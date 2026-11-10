import type { PersonalSettings } from '@mental-health/types';
import { StrictMode } from 'react';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { PersonalSettingsProvider } from '../app/personal-settings';
import { PersonalPreferences } from './personal-preferences';

const original: PersonalSettings = {
  displayName: '',
  biography: '',
  avatarId: null,
  cat: 'relaxed',
  readingSize: 20,
  bookmarks: ['synthetic-article'],
  revision: 0,
};
const success = (settings: PersonalSettings) =>
  Response.json({ success: true, data: { settings } });
const fail = (status: number, code: string, message: string) =>
  Response.json({ success: false, error: { code, message } }, { status });
function renderPreferences() {
  return render(
    <StrictMode>
      <PersonalSettingsProvider>
        <PersonalPreferences />
      </PersonalSettingsProvider>
    </StrictMode>,
  );
}

describe('Personal settings save and recovery', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    document.cookie = 'mh_csrf=; Max-Age=0; Path=/';
  });

  it('previews an uploaded avatar and saves it with the name and biography in one request', async () => {
    document.cookie = 'mh_csrf=synthetic-settings-csrf; Path=/';
    const revoke = vi.fn();
    const OriginalURL = URL;
    vi.stubGlobal(
      'URL',
      class extends OriginalURL {
        static createObjectURL = vi.fn(() => 'blob:synthetic-avatar');
        static revokeObjectURL = revoke;
      },
    );
    const id = '93b909c2-ea26-4533-92a3-c1f96cbb4c21';
    let stored = { ...original };
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async (_input, init) => {
      if (init?.method === 'POST') {
        expect(init.body).toBeInstanceOf(FormData);
        const form = init.body as FormData;
        expect(form.get('image')).toBeInstanceOf(File);
        const { expectedRevision, ...fields } = JSON.parse(String(form.get('settings')));
        expect(expectedRevision).toBe(0);
        stored = { ...fields, avatarId: id, revision: 1 };
      } else if (init?.method === 'PATCH') {
        const { expectedRevision, ...fields } = JSON.parse(String(init.body));
        expect(expectedRevision).toBe(1);
        stored = { ...fields, revision: 2 };
      }
      return success(stored);
    });
    vi.stubGlobal('fetch', fetcher);
    const view = renderPreferences();
    await userEvent.type(await screen.findByLabelText('怎么称呼你（选填）'), '合成头像');
    await userEvent.type(screen.getByLabelText('个人简介（选填）'), '喜欢小猫和散步。');
    await userEvent.upload(
      screen.getByLabelText('上传头像图片'),
      new File(['synthetic-image'], 'avatar.png', { type: 'image/png' }),
    );
    expect(screen.getByRole('img', { name: '我的头像' }).querySelector('img')).toHaveAttribute(
      'src',
      'blob:synthetic-avatar',
    );
    expect(fetcher.mock.calls.filter(([, init]) => init?.method === 'POST')).toHaveLength(0);
    await userEvent.click(screen.getByRole('button', { name: '保存个人设置' }));
    expect(await screen.findByRole('status')).toHaveTextContent('已经保存好了。');
    expect(stored).toMatchObject({
      displayName: '合成头像',
      biography: '喜欢小猫和散步。',
      avatarId: id,
    });
    expect(revoke).toHaveBeenCalledWith('blob:synthetic-avatar');
    view.unmount();
    renderPreferences();
    expect(await screen.findByLabelText('个人简介（选填）')).toHaveValue('喜欢小猫和散步。');
    expect(
      screen.getByRole('img', { name: '我的头像' }).querySelector('img')?.getAttribute('src'),
    ).toContain(id);
    await userEvent.click(screen.getByRole('radio', { name: '期待' }));
    await userEvent.click(screen.getByRole('button', { name: '保存个人设置' }));
    expect(await screen.findByRole('status')).toHaveTextContent('已经保存好了。');
    expect(stored).toMatchObject({ cat: 'hopeful', avatarId: null, biography: '喜欢小猫和散步。' });
  });

  it('rejects oversized avatars and overlong biographies before sending a mutation', async () => {
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => success(original));
    vi.stubGlobal('fetch', fetcher);
    renderPreferences();
    const bio = await screen.findByLabelText('个人简介（选填）');
    fireEvent.change(bio, { target: { value: '🐱'.repeat(201) } });
    expect(screen.getByRole('button', { name: '保存个人设置' })).toBeDisabled();
    fireEvent.change(bio, { target: { value: '🐱'.repeat(200) } });
    expect(screen.getByRole('button', { name: '保存个人设置' })).toBeEnabled();
    await userEvent.upload(
      screen.getByLabelText('上传头像图片'),
      new File([new Uint8Array(5 * 1024 * 1024 + 1)], 'large.png', { type: 'image/png' }),
    );
    expect(await screen.findByRole('alert')).toHaveTextContent('请选择 5 MB 以内');
    expect(fetcher.mock.calls.every(([, init]) => !init?.method || init.method === 'GET')).toBe(
      true,
    );
  });

  it('allows correcting a definite validation failure without discarding the biography', async () => {
    document.cookie = 'mh_csrf=synthetic-settings-csrf; Path=/';
    let rejected = false;
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async (_input, init) => {
      if (init?.method !== 'PATCH') return success(original);
      if (!rejected) {
        rejected = true;
        return fail(400, 'VALIDATION_ERROR', '这张图片无法读取');
      }
      const { expectedRevision, ...fields } = JSON.parse(String(init.body));
      expect(expectedRevision).toBe(0);
      return success({ ...fields, revision: 1 });
    });
    vi.stubGlobal('fetch', fetcher);
    renderPreferences();
    await userEvent.type(await screen.findByLabelText('个人简介（选填）'), '保留这段合成简介');
    await userEvent.click(screen.getByRole('button', { name: '保存个人设置' }));
    expect(await screen.findAllByText('这张图片无法读取')).not.toHaveLength(0);
    expect(screen.getByLabelText('个人简介（选填）')).toHaveValue('保留这段合成简介');
    await userEvent.click(screen.getByRole('radio', { name: '开心' }));
    await userEvent.click(screen.getByRole('button', { name: '保存个人设置' }));
    expect(await screen.findByRole('status')).toHaveTextContent('已经保存好了。');
    expect(fetcher.mock.calls.filter(([, init]) => init?.method === 'PATCH')).toHaveLength(2);
  });

  it('keeps the save acknowledgement after revision changes and reloads the persisted name and cat', async () => {
    document.cookie = 'mh_csrf=synthetic-settings-csrf; Path=/';
    let stored = { ...original };
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async (input, init) => {
      expect(new URL(String(input)).pathname).toBe('/profile/settings');
      expect(init?.credentials).toBe('include');
      if (init?.method === 'PATCH') {
        expect(new Headers(init.headers).get('x-csrf-token')).toBe('synthetic-settings-csrf');
        const { expectedRevision, ...fields } = JSON.parse(String(init.body));
        expect(expectedRevision).toBe(stored.revision);
        stored = { ...fields, revision: stored.revision + 1 };
      }
      return success(stored);
    });
    vi.stubGlobal('fetch', fetcher);
    const view = renderPreferences();
    const name = await screen.findByLabelText('怎么称呼你（选填）');
    await userEvent.type(name, '  合成小猫  ');
    await userEvent.click(screen.getByRole('radio', { name: '害羞' }));
    await userEvent.click(screen.getByRole('button', { name: '保存个人设置' }));
    expect(await screen.findByRole('status')).toHaveTextContent('已经保存好了。');
    expect(stored).toEqual({ ...original, displayName: '合成小猫', cat: 'shy', revision: 1 });
    expect(screen.getByLabelText('怎么称呼你（选填）')).toHaveValue('合成小猫');
    expect(screen.getByRole('radio', { name: '害羞' })).toBeChecked();
    expect(fetcher.mock.calls.filter(([, init]) => init?.method === 'PATCH')).toHaveLength(1);
    view.unmount();
    renderPreferences();
    expect(await screen.findByLabelText('怎么称呼你（选填）')).toHaveValue('合成小猫');
    expect(screen.getByRole('radio', { name: '害羞' })).toBeChecked();
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
  });

  it('keeps an unsuccessful draft and never reports success or retries an uncertain write', async () => {
    document.cookie = 'mh_csrf=synthetic-settings-csrf; Path=/';
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async (_input, init) => {
      if (init?.method === 'PATCH') throw new TypeError('synthetic acknowledgement lost');
      return success(original);
    });
    vi.stubGlobal('fetch', fetcher);
    renderPreferences();
    await userEvent.type(await screen.findByLabelText('怎么称呼你（选填）'), '保留合成草稿');
    await userEvent.type(screen.getByLabelText('个人简介（选填）'), '未确认的简介也应该保留');
    await userEvent.click(screen.getByRole('radio', { name: '期待' }));
    await userEvent.click(screen.getByRole('button', { name: '保存个人设置' }));
    expect(await screen.findByText('保存未确认，请重新读取设置核对后再操作。')).toBeInTheDocument();
    expect(screen.getByLabelText('怎么称呼你（选填）')).toHaveValue('保留合成草稿');
    expect(screen.getByLabelText('个人简介（选填）')).toHaveValue('未确认的简介也应该保留');
    expect(screen.getByRole('radio', { name: '期待' })).toBeChecked();
    expect(screen.queryByText('已经保存好了。')).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: '保存个人设置' }));
    expect(fetcher.mock.calls.filter(([, init]) => init?.method === 'PATCH')).toHaveLength(1);
  });

  it('uses a newly read revision after a conflict without losing unrelated reading preferences', async () => {
    document.cookie = 'mh_csrf=synthetic-settings-csrf; Path=/';
    let stored = { ...original, revision: 2 };
    let firstRead = true;
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async (_input, init) => {
      if (init?.method !== 'PATCH') {
        if (firstRead) {
          firstRead = false;
          return success(original);
        }
        return success(stored);
      }
      const { expectedRevision, ...fields } = JSON.parse(String(init.body));
      if (expectedRevision !== stored.revision)
        return fail(409, 'CONFLICT', '个人设置已改变，请重新读取后再保存');
      stored = { ...fields, revision: stored.revision + 1 };
      return success(stored);
    });
    vi.stubGlobal('fetch', fetcher);
    // A single initial read keeps this fixture independent of StrictMode's mount replay.
    render(
      <PersonalSettingsProvider>
        <PersonalPreferences />
      </PersonalSettingsProvider>,
    );
    await userEvent.type(await screen.findByLabelText('怎么称呼你（选填）'), '合成更新');
    await userEvent.click(screen.getByRole('button', { name: '保存个人设置' }));
    await screen.findByText('保存未确认，请重新读取设置核对后再操作。');
    await userEvent.click(screen.getByRole('button', { name: '重新读取设置' }));
    await waitFor(() => expect(screen.getByLabelText('怎么称呼你（选填）')).toHaveValue(''));
    await userEvent.type(screen.getByLabelText('怎么称呼你（选填）'), '再次合成更新');
    await userEvent.click(screen.getByRole('button', { name: '保存个人设置' }));
    expect(await screen.findByRole('status')).toHaveTextContent('已经保存好了。');
    expect(stored).toEqual({ ...original, revision: 3, displayName: '再次合成更新' });
  });

  it('blocks duplicate submissions while saving and enforces the Unicode name limit', async () => {
    document.cookie = 'mh_csrf=synthetic-settings-csrf; Path=/';
    let finish!: (response: Response) => void;
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async (_input, init) => {
      if (init?.method === 'PATCH')
        return new Promise<Response>((resolve) => {
          finish = resolve;
        });
      return success(original);
    });
    vi.stubGlobal('fetch', fetcher);
    renderPreferences();
    const name = await screen.findByLabelText('怎么称呼你（选填）');
    fireEvent.change(name, { target: { value: '🐱'.repeat(25) } });
    expect(screen.getByRole('button', { name: '保存个人设置' })).toBeDisabled();
    fireEvent.change(name, { target: { value: '🐱'.repeat(24) } });
    const button = screen.getByRole('button', { name: '保存个人设置' });
    fireEvent.click(button);
    fireEvent.click(button);
    expect(screen.getByRole('button', { name: '正在保存…' })).toBeDisabled();
    expect(fetcher.mock.calls.filter(([, init]) => init?.method === 'PATCH')).toHaveLength(1);
    finish(success({ ...original, displayName: '🐱'.repeat(24), revision: 1 }));
    expect(await screen.findByRole('status')).toHaveTextContent('已经保存好了。');
  });
});
