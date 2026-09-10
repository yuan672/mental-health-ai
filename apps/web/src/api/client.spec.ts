import { z } from 'zod';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { apiRequest, ApiClientError } from './client';

const responseSchema = z.object({
  success: z.literal(true),
  data: z.object({ ok: z.literal(true) }),
});

describe('apiClient', () => {
  afterEach(() => {
    document.cookie = 'mh_csrf=; Max-Age=0; Path=/';
  });

  it('uses cookies without a CSRF header for GET requests', async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValue(Response.json({ success: true, data: { ok: true } }));
    await apiRequest('/example', responseSchema, {}, fetcher);
    const request = fetcher.mock.calls[0]?.[1];
    expect(request).toMatchObject({ method: 'GET', credentials: 'include' });
    expect(new Headers(request?.headers).has('x-csrf-token')).toBe(false);
  });

  it('adds the double-submit CSRF value only to mutations', async () => {
    document.cookie = 'mh_csrf=synthetic-csrf; Path=/';
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValue(Response.json({ success: true, data: { ok: true } }));
    await apiRequest(
      '/example',
      responseSchema,
      { method: 'POST', csrf: true, body: { safe: true } },
      fetcher,
    );
    const headers = new Headers(fetcher.mock.calls[0]?.[1]?.headers);
    expect(headers.get('x-csrf-token')).toBe('synthetic-csrf');
    expect(fetcher.mock.calls[0]?.[1]?.credentials).toBe('include');
  });

  it('maps only the public error envelope and rejects malformed success responses', async () => {
    const denied = vi
      .fn<typeof fetch>()
      .mockResolvedValue(
        Response.json(
          { success: false, error: { code: 'FORBIDDEN', message: '无权执行此操作' } },
          { status: 403 },
        ),
      );
    await expect(apiRequest('/example', responseSchema, {}, denied)).rejects.toMatchObject({
      code: 'FORBIDDEN',
      status: 403,
    });

    const malformed = vi
      .fn<typeof fetch>()
      .mockResolvedValue(Response.json({ secret: 'must-not-pass' }));
    await expect(apiRequest('/example', responseSchema, {}, malformed)).rejects.toBeInstanceOf(
      ApiClientError,
    );
  });
});
