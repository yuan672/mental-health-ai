import type { AuthSession } from '@mental-health/types';
import { getSession, login as loginRequest } from '../api/auth';
import { ApiClientError } from '../api/client';

/**
 * 本地预览用的开发态自动登录。
 *
 * 仅在 Vite 开发服务器（`import.meta.env.DEV` 且 `MODE === 'development'`）
 * 并且显式设置 `VITE_DEV_AUTH_BYPASS=true` 时生效，构建产物与测试环境不会触发。
 *
 * 与纯前端假会话不同，这里用 `.env` 里配置的预览账号真正调用 `POST /auth/login`，
 * 拿到服务端 session cookie，因此登录后的所有接口都能正常访问。
 */
export function isDevAuthBypassEnabled(): boolean {
  return (
    import.meta.env.DEV &&
    import.meta.env.MODE === 'development' &&
    import.meta.env.VITE_DEV_AUTH_BYPASS === 'true'
  );
}

/**
 * 复用浏览器里已有的会话；没有或已过期（401）时，用预览账号静默登录。
 */
export async function resolveDevSession(signal?: AbortSignal): Promise<AuthSession> {
  try {
    const existing = await getSession(signal);
    return existing.data;
  } catch (error) {
    if (!(error instanceof ApiClientError) || error.status !== 401) throw error;
  }

  const email: string | undefined = import.meta.env.VITE_DEV_AUTO_LOGIN_EMAIL;
  const password: string | undefined = import.meta.env.VITE_DEV_AUTO_LOGIN_PASSWORD;
  if (!email || !password) {
    throw new ApiClientError(
      'DEV_AUTO_LOGIN_NOT_CONFIGURED',
      '缺少 VITE_DEV_AUTO_LOGIN_EMAIL / VITE_DEV_AUTO_LOGIN_PASSWORD 配置',
      500,
    );
  }

  const response = await loginRequest(email, password);
  return response.data;
}
