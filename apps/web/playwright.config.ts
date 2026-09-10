import { fileURLToPath } from 'node:url';
import { defineConfig, devices } from '@playwright/test';

const repoRoot = fileURLToPath(new URL('../..', import.meta.url));
const databaseUrl =
  process.env.TEST_DATABASE_URL ??
  'postgresql://mental_health:change-me-local-only@127.0.0.1:5432/mental_health_test';

if (!new URL(databaseUrl).pathname.slice(1).endsWith('_test')) {
  throw new Error('Playwright requires a dedicated PostgreSQL database ending in _test');
}

const apiEnvironment = {
  APP_ENV: 'test',
  APP_PORT: '3101',
  WEB_ORIGINS: 'http://127.0.0.1:4173',
  DATABASE_URL: databaseUrl,
  TEST_DATABASE_URL: databaseUrl,
  LOG_LEVEL: 'silent',
  SESSION_TTL_SECONDS: '604800',
  AGE_VERIFICATION_PROVIDER: 'mock',
  REQUIRED_TERMS_VERSION: '1.0',
  REQUIRED_PRIVACY_VERSION: '1.0',
  FREE_DAILY_AI_LIMIT: '20',
  QUOTA_TIME_ZONE: 'Asia/Shanghai',
  AI_CHAT_ENABLED: 'true',
  LLM_PROVIDER: 'siliconflow',
  LLM_API_KEY: 'synthetic-e2e-key',
  LLM_BASE_URL: 'http://127.0.0.1:4010/v1',
  LLM_MODEL: 'synthetic-phase5b-model',
  LLM_FIRST_TOKEN_TIMEOUT_MS: '5000',
  LLM_STREAM_IDLE_TIMEOUT_MS: '5000',
  LLM_TOTAL_TIMEOUT_MS: '15000',
  LLM_LEASE_SAFETY_MARGIN_MS: '5000',
  LLM_MAX_OUTPUT_TOKENS: '256',
  LLM_CONTEXT_TOKEN_BUDGET: '2000',
  AI_CONTEXT_MAX_MESSAGES: '10',
  AI_MESSAGE_MAX_CHARACTERS: '4000',
  AI_SEGMENT_MAX_CHARACTERS: '120',
  AI_SEGMENT_MAX_WAIT_MS: '100',
  INCOGNITO_CONTEXT_TTL_SECONDS: '300',
  SAFETY_CONTEXT_MAX_MESSAGES: '6',
  SAFETY_CONTEXT_TOKEN_BUDGET: '1200',
  SAFETY_CONTEXT_MAX_CHARACTERS: '3000',
  RISK_CLASSIFIER_MIN_CONFIDENCE: '0.65',
  SAFETY_CLASSIFIER_TIMEOUT_MS: '5000',
  RISK_EVENT_RETENTION_DAYS: '180',
  AUDIT_RETENTION_DAYS: '90',
  SAFETY_PROVIDER_PRIVACY_APPROVED: 'false',
  SAFETY_CONSENT_APPROVED: 'false',
  SAFETY_REVIEWER_ACCESS_READY: 'false',
  SAFETY_CORPUS_REVIEWED: 'false',
};

export default defineConfig({
  testDir: './e2e',
  fullyParallel: false,
  workers: 1,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? 'github' : 'list',
  timeout: 30_000,
  expect: { timeout: 8_000 },
  use: {
    baseURL: 'http://127.0.0.1:4173',
    screenshot: 'only-on-failure',
    trace: 'retain-on-failure',
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  webServer: [
    {
      command: 'node apps/web/e2e/support/synthetic-provider.mjs',
      cwd: repoRoot,
      env: { SYNTHETIC_PROVIDER_PORT: '4010' },
      port: 4010,
      reuseExistingServer: false,
      timeout: 30_000,
    },
    {
      command: 'pnpm --filter @mental-health/api seed:e2e && node apps/api/dist/src/main.js',
      cwd: repoRoot,
      env: apiEnvironment,
      port: 3101,
      reuseExistingServer: false,
      timeout: 120_000,
    },
    {
      command: 'pnpm --filter @mental-health/web exec vite --host 127.0.0.1 --port 4173',
      cwd: repoRoot,
      env: { VITE_API_BASE_URL: 'http://127.0.0.1:3101' },
      port: 4173,
      reuseExistingServer: false,
      timeout: 60_000,
    },
  ],
});
