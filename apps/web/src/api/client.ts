import type { ApiErrorResponse } from '@mental-health/types';
import { z } from 'zod';
import { publicEnv } from '../config/env';
import { notifySessionInvalidated } from './session-events';

const apiErrorResponseSchema = z
  .object({
    success: z.literal(false),
    error: z.object({ code: z.string().min(1), message: z.string().min(1) }).strict(),
  })
  .strict();

export class ApiClientError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly status: number,
  ) {
    super(message);
    this.name = ApiClientError.name;
  }
}

export function readCsrfToken(cookie = document.cookie): string | null {
  for (const item of cookie.split(';')) {
    const [name, ...value] = item.trim().split('=');
    if (name === 'mh_csrf') return decodeURIComponent(value.join('='));
  }
  return null;
}

export async function parseApiError(response: Response): Promise<ApiErrorResponse['error']> {
  try {
    return apiErrorResponseSchema.parse(await response.json()).error;
  } catch {
    return { code: 'REQUEST_FAILED', message: '请求失败，请稍后重试' };
  }
}

type ApiRequestOptions = Readonly<{
  method?: 'GET' | 'POST' | 'PATCH' | 'DELETE';
  body?: unknown;
  signal?: AbortSignal;
  csrf?: boolean;
  notifyOnUnauthorized?: boolean;
  headers?: Readonly<Record<string, string>>;
  validateResponse?: (response: Response) => void;
}>;

export async function apiRequest<T>(
  path: string,
  schema: z.ZodType<T>,
  options: ApiRequestOptions = {},
  fetcher: typeof fetch = globalThis.fetch,
): Promise<T> {
  const method = options.method ?? 'GET';
  const headers = new Headers({ Accept: 'application/json' });
  for (const [name, value] of Object.entries(options.headers ?? {})) headers.set(name, value);
  if (options.body !== undefined) headers.set('Content-Type', 'application/json');
  if (options.csrf) {
    const token = readCsrfToken();
    if (!token)
      throw new ApiClientError('CSRF_TOKEN_MISSING', '安全校验信息缺失，请刷新后重试', 400);
    headers.set('x-csrf-token', token);
  }

  const response = await fetcher(new URL(path, publicEnv.VITE_API_BASE_URL), {
    method,
    credentials: 'include',
    headers,
    ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
    ...(options.signal ? { signal: options.signal } : {}),
  });

  if (!response.ok) {
    const error = await parseApiError(response);
    if (response.status === 401 && options.notifyOnUnauthorized !== false) {
      notifySessionInvalidated();
    }
    throw new ApiClientError(error.code, error.message, response.status);
  }

  options.validateResponse?.(response);

  try {
    return schema.parse(await response.json());
  } catch {
    throw new ApiClientError('INVALID_API_RESPONSE', '服务响应格式无效', 502);
  }
}
