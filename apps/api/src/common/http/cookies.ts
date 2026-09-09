import type { CookieOptions, Request, Response } from 'express';
import { env, type AppEnvironment } from '../../config/env';

export const SESSION_COOKIE_NAME = 'mh_session';
export const CSRF_COOKIE_NAME = 'mh_csrf';
export const CSRF_HEADER_NAME = 'x-csrf-token';

export function parseCookies(request: Request): ReadonlyMap<string, string> {
  const cookies = new Map<string, string>();
  const header = request.headers.cookie;
  if (!header) {
    return cookies;
  }

  for (const item of header.split(';')) {
    const separator = item.indexOf('=');
    if (separator < 1) {
      continue;
    }

    const name = item.slice(0, separator).trim();
    const rawValue = item.slice(separator + 1).trim();
    try {
      cookies.set(name, decodeURIComponent(rawValue));
    } catch {
      // Malformed cookie values are treated as absent by callers.
    }
  }

  return cookies;
}

export function authenticationCookieOptions(
  httpOnly: boolean,
  appEnvironment: AppEnvironment['APP_ENV'] = env.APP_ENV,
): CookieOptions {
  return {
    httpOnly,
    secure: appEnvironment === 'production',
    sameSite: 'lax',
    path: '/',
  };
}

export function setAuthenticationCookies(
  response: Response,
  rawSessionToken: string,
  csrfToken: string,
  expiresAt: Date,
): void {
  const maxAge = Math.max(0, expiresAt.getTime() - Date.now());
  response.cookie(SESSION_COOKIE_NAME, rawSessionToken, {
    ...authenticationCookieOptions(true),
    expires: expiresAt,
    maxAge,
  });
  response.cookie(CSRF_COOKIE_NAME, csrfToken, {
    ...authenticationCookieOptions(false),
    expires: expiresAt,
    maxAge,
  });
}

export function clearAuthenticationCookies(response: Response): void {
  response.clearCookie(SESSION_COOKIE_NAME, authenticationCookieOptions(true));
  response.clearCookie(CSRF_COOKIE_NAME, authenticationCookieOptions(false));
}
