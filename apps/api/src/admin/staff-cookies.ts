import type { CookieOptions, Response } from 'express';
import { env, type AppEnvironment } from '../config/env';

export const STAFF_SESSION_COOKIE_NAME = 'mh_staff_session';
export const STAFF_CSRF_COOKIE_NAME = 'mh_staff_csrf';
export const STAFF_CSRF_HEADER_NAME = 'x-staff-csrf-token';

export function staffCookieOptions(
  httpOnly: boolean,
  appEnvironment: AppEnvironment['APP_ENV'] = env.APP_ENV,
): CookieOptions {
  return {
    httpOnly,
    secure: appEnvironment === 'production',
    sameSite: 'strict',
    path: '/admin',
  };
}

export function setStaffCookies(
  response: Response,
  rawToken: string,
  csrfToken: string,
  expiresAt: Date,
): void {
  const maxAge = Math.max(0, expiresAt.getTime() - Date.now());
  response.cookie(STAFF_SESSION_COOKIE_NAME, rawToken, {
    ...staffCookieOptions(true),
    expires: expiresAt,
    maxAge,
  });
  response.cookie(STAFF_CSRF_COOKIE_NAME, csrfToken, {
    ...staffCookieOptions(false),
    expires: expiresAt,
    maxAge,
  });
}

export function clearStaffCookies(response: Response): void {
  response.clearCookie(STAFF_SESSION_COOKIE_NAME, staffCookieOptions(true));
  response.clearCookie(STAFF_CSRF_COOKIE_NAME, staffCookieOptions(false));
}
