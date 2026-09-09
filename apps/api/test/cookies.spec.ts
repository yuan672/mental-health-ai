import { authenticationCookieOptions } from '../src/common/http/cookies';

describe('authentication cookie policy', () => {
  it('uses HttpOnly, Secure, SameSite=Lax and Path=/ for production sessions', () => {
    expect(authenticationCookieOptions(true, 'production')).toEqual({
      httpOnly: true,
      secure: true,
      sameSite: 'lax',
      path: '/',
    });
  });

  it('keeps development cookies usable without weakening the other flags', () => {
    expect(authenticationCookieOptions(true, 'development')).toEqual({
      httpOnly: true,
      secure: false,
      sameSite: 'lax',
      path: '/',
    });
  });
});
