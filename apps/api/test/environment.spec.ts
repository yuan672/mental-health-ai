import { parseEnvironment } from '../src/config/env';

const baseEnvironment: NodeJS.ProcessEnv = {
  DATABASE_URL: 'postgresql://test:test@localhost:5432/mental_health_test',
  SESSION_TTL_SECONDS: '604800',
  WEB_ORIGINS: 'http://localhost:5173',
  REQUIRED_TERMS_VERSION: '1.0',
  REQUIRED_PRIVACY_VERSION: '1.0',
  FREE_DAILY_AI_LIMIT: '20',
  QUOTA_TIME_ZONE: 'Asia/Shanghai',
  AUDIT_RETENTION_DAYS: '90',
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

  it.each(['staging', 'production'] as const)(
    'allows the API to start with registration unavailable in %s',
    (appEnvironment) => {
      expect(
        parseEnvironment({
          ...baseEnvironment,
          APP_ENV: appEnvironment,
          AGE_VERIFICATION_PROVIDER: 'unconfigured',
        }).AGE_VERIFICATION_PROVIDER,
      ).toBe('unconfigured');
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

  it('requires a positive configured daily AI limit', () => {
    expect(() =>
      parseEnvironment({
        ...baseEnvironment,
        APP_ENV: 'test',
        AGE_VERIFICATION_PROVIDER: 'mock',
        FREE_DAILY_AI_LIMIT: '',
      }),
    ).toThrow();
  });

  it('rejects an unsupported quota time zone', () => {
    expect(() =>
      parseEnvironment({
        ...baseEnvironment,
        APP_ENV: 'test',
        AGE_VERIFICATION_PROVIDER: 'mock',
        QUOTA_TIME_ZONE: 'Not/A-Time-Zone',
      }),
    ).toThrow('QUOTA_TIME_ZONE must be a supported IANA time zone');
  });

  it('requires backend-only credentials and a model for SiliconFlow', () => {
    expect(() =>
      parseEnvironment({
        ...baseEnvironment,
        APP_ENV: 'test',
        AGE_VERIFICATION_PROVIDER: 'mock',
        LLM_PROVIDER: 'siliconflow',
        LLM_API_KEY: '',
        LLM_MODEL: '',
      }),
    ).toThrow('LLM_API_KEY is required for the SiliconFlow provider');

    const parsed = parseEnvironment({
      ...baseEnvironment,
      APP_ENV: 'test',
      AGE_VERIFICATION_PROVIDER: 'mock',
      LLM_PROVIDER: 'siliconflow',
      LLM_API_KEY: 'synthetic-test-key',
      LLM_MODEL: 'synthetic-test-model',
    });
    expect(parsed.LLM_PROVIDER).toBe('siliconflow');
  });

  it('rejects stream phase timeouts longer than the total timeout', () => {
    expect(() =>
      parseEnvironment({
        ...baseEnvironment,
        APP_ENV: 'test',
        AGE_VERIFICATION_PROVIDER: 'mock',
        LLM_FIRST_TOKEN_TIMEOUT_MS: '2000',
        LLM_TOTAL_TIMEOUT_MS: '1000',
      }),
    ).toThrow('First-token timeout cannot exceed total timeout');
  });
});
