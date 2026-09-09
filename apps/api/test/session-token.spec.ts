import { createHash } from 'node:crypto';
import { hashSessionToken } from '../src/auth/sessions.service';

describe('session token verifier', () => {
  it('uses the SHA-256 digest of the opaque token', () => {
    const rawToken = 'a-private-opaque-session-token';
    expect(hashSessionToken(rawToken)).toBe(
      createHash('sha256').update(rawToken, 'utf8').digest('hex'),
    );
    expect(hashSessionToken(rawToken)).not.toContain(rawToken);
  });
});
