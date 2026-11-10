import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApiClientError } from './client';
import { diaryApi } from './diary';

const id = '84000000-0000-4000-8000-000000000001';
describe('Diary transport contract', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    document.cookie = 'mh_csrf=; Max-Age=0; Path=/';
  });
  it('sends authenticated multipart uploads without overriding the browser boundary', async () => {
    document.cookie = 'mh_csrf=synthetic-upload-csrf; Path=/';
    const response = {
      success: true,
      data: { photo: { id, name: 'synthetic.png', mime: 'image/png', size: 4 } },
    };
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(Response.json(response));
    vi.stubGlobal('fetch', fetcher);
    const file = new File(['test'], 'synthetic.png', { type: 'image/png' });
    expect(await diaryApi.upload(id, '2026-09-01', file, id)).toEqual(response);
    const options = fetcher.mock.calls[0]?.[1];
    expect(options?.credentials).toBe('include');
    expect(new Headers(options?.headers).get('Content-Type')).toBeNull();
    expect(new Headers(options?.headers).get('x-csrf-token')).toBe('synthetic-upload-csrf');
    expect(options?.body).toBeInstanceOf(FormData);
    expect((options?.body as FormData).get('image')).toBe(file);
    expect((options?.body as FormData).get('photoId')).toBe(id);
  });
  it('keeps expected revision and draft intent; a lost response never retries automatically', async () => {
    document.cookie = 'mh_csrf=synthetic-save-csrf; Path=/';
    const fetcher = vi
      .fn<typeof fetch>()
      .mockRejectedValue(new TypeError('synthetic connection lost'));
    vi.stubGlobal('fetch', fetcher);
    const input = {
      expectedRevision: 3,
      content: {
        title: 'Synthetic',
        body: 'Synthetic draft',
        mood: null,
        weather: null,
        photoIds: [],
      },
      publish: false,
    };
    await expect(diaryApi.save(id, '2026-09-01', input)).rejects.toThrow(
      'synthetic connection lost',
    );
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(JSON.parse(String(fetcher.mock.calls[0]?.[1]?.body))).toEqual(input);
  });
  it('surfaces revision conflicts instead of treating the write as successful', async () => {
    document.cookie = 'mh_csrf=synthetic-save-csrf; Path=/';
    vi.stubGlobal(
      'fetch',
      vi
        .fn<typeof fetch>()
        .mockResolvedValue(
          Response.json(
            { success: false, error: { code: 'CONFLICT', message: '内容已改变' } },
            { status: 409 },
          ),
        ),
    );
    await expect(
      diaryApi.updateSettings({
        expectedRevision: 2,
        displayName: 'Synthetic',
        biography: '',
        avatarId: null,
        cat: 'happy',
        readingSize: 18,
        bookmarks: [],
      }),
    ).rejects.toEqual(new ApiClientError('CONFLICT', '内容已改变', 409));
  });
});
