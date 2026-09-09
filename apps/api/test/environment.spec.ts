import { parseEnvironment } from '../src/config/env';

const baseEnvironment: NodeJS.ProcessEnv = {
  DATABASE_URL: 'postgresql://test:test@localhost:5432/mental_health_test',
  SESSION_TTL_SECONDS: '604800',
  WEB_ORIGINS: 'http://localhost:5173',
  REQUIRED_TERMS_VERSION: '1.0',
  REQUIRED_PRIVACY_VERSION: '1.0',
};

describe('identity environment validation', () => {
  it.each(['development', 'test'] as const)('allows the mock provider in %s', (appEnvironment) => {
    expect(
      parseEnvironment({
        ...baseEnvironment,
        APP_ENV: appEnvironment,
        AGE_VERIFICATION_PROVIDER: 'mock',
      }).AGE_VERIFICATION_PROVIDER,
    ).toBe('mock');
  });

  it.each(['staging', 'production'] as const)(
    'fails fast when the mock provider is configured in %s',
    (appEnvironment) => {
      expect(() =>
        parseEnvironment({
          ...baseEnvironment,
          APP_ENV: appEnvironment,
          AGE_VERIFICATION_PROVIDER: 'mock',
        }),
      ).toThrow('Mock age verification is restricted to development and test');
    },
  );

  it('rejects a non-seven-day Phase 2A session lifetime', () => {
    expect(() =>
      parseEnvironment({
        ...baseEnvironment,
        APP_ENV: 'test',
        AGE_VERIFICATION_PROVIDER: 'mock',
        SESSION_TTL_SECONDS: '3600',
      }),
    ).toThrow('SESSION_TTL_SECONDS must be 604800');
  });
});
