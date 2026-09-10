import { describe, expect, it } from 'vitest';
import { safeReturnTo } from './return-to';

describe('safeReturnTo', () => {
  it('accepts only internal app routes', () => {
    expect(safeReturnTo('/app/chat/11111111-1111-4111-8111-111111111111?from=test')).toBe(
      '/app/chat/11111111-1111-4111-8111-111111111111?from=test',
    );
  });

  it.each([
    'https://example.test/app/chat',
    '//example.test/app/chat',
    'javascript:alert(1)',
    '%2F%2Fevil.test%2Fapp',
    '/\\evil.test/app',
    '/login',
  ])('rejects unsafe or non-app redirect %s', (value) => {
    expect(safeReturnTo(value)).toBe('/app/chat');
  });
});
