import { config as loadDotEnv } from 'dotenv';
import { resolve } from 'node:path';
import { z } from 'zod';

loadDotEnv({ path: resolve(process.cwd(), '../../.env'), quiet: true });

function isSupportedTimeZone(value: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: value }).format();
    return true;
  } catch {
    return false;
  }
}

const environmentSchema = z
  .object({
    APP_ENV: z.enum(['development', 'test', 'staging', 'production']).default('development'),
    APP_PORT: z.coerce.number().int().min(1).max(65535).default(3001),
    DATABASE_URL: z
      .string()
      .min(1)
      .refine((value) => value.startsWith('postgresql://') || value.startsWith('postgres://'), {
        message: 'DATABASE_URL must be a PostgreSQL connection string',
      }),
    DATABASE_CONNECTION_TIMEOUT_MS: z.coerce.number().int().positive().default(5_000),
    DATABASE_QUERY_TIMEOUT_MS: z.coerce.number().int().positive().default(30_000),
    LOG_LEVEL: z
      .enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent'])
      .default('info'),
    WEB_ORIGINS: z
      .string()
      .default('http://localhost:5173')
      .transform((value) => value.split(',').map((origin) => origin.trim()))
      .pipe(z.array(z.string().url()).min(1)),
    SESSION_TTL_SECONDS: z.coerce
      .number()
      .int()
      .refine((value) => value === 604_800, {
        message: 'SESSION_TTL_SECONDS must be 604800 during Phase 2A',
      })
      .default(604_800),
    AGE_VERIFICATION_PROVIDER: z.enum(['mock', 'unconfigured']).default('mock'),
    REQUIRED_TERMS_VERSION: z.string().min(1).max(64).default('1.1'),
    REQUIRED_PRIVACY_VERSION: z.string().min(1).max(64).default('1.1'),
    FREE_DAILY_AI_LIMIT: z.coerce.number().int().positive(),
    QUOTA_TIME_ZONE: z.string().min(1).refine(isSupportedTimeZone, {
      message: 'QUOTA_TIME_ZONE must be a supported IANA time zone',
    }),
    AI_CHAT_ENABLED: z
      .enum(['true', 'false'])
      .default('false')
      .transform((value) => value === 'true'),
    AI_KNOWLEDGE_ENABLED: z
      .enum(['true', 'false'])
      .default('false')
      .transform((value) => value === 'true'),
    AI_KNOWLEDGE_SYNTHETIC_FIXTURES_ENABLED: z
      .enum(['true', 'false'])
      .default('false')
      .transform((value) => value === 'true'),
    AI_KNOWLEDGE_RETRIEVAL_TIMEOUT_MS: z.coerce.number().int().positive().default(2_000),
    AI_KNOWLEDGE_CONTEXT_TOKEN_BUDGET: z.coerce.number().int().min(800).max(1_200).default(1_000),
    LLM_PROVIDER: z.enum(['none', 'siliconflow']).default('none'),
    LLM_API_KEY: z.string().default(''),
    LLM_BASE_URL: z.string().url().default('https://api.siliconflow.cn/v1'),
    LLM_MODEL: z.string().default(''),
    LLM_FIRST_TOKEN_TIMEOUT_MS: z.coerce.number().int().positive().default(30_000),
    LLM_STREAM_IDLE_TIMEOUT_MS: z.coerce.number().int().positive().default(20_000),
    LLM_TOTAL_TIMEOUT_MS: z.coerce.number().int().positive().default(120_000),
    LLM_LEASE_SAFETY_MARGIN_MS: z.coerce.number().int().min(1_000).default(5_000),
    LLM_MAX_OUTPUT_TOKENS: z.coerce.number().int().positive().default(1_024),
    LLM_CONTEXT_TOKEN_BUDGET: z.coerce.number().int().positive().default(6_000),
    AI_CONTEXT_MAX_MESSAGES: z.coerce.number().int().positive().max(100).default(20),
    AI_MESSAGE_MAX_CHARACTERS: z.coerce.number().int().positive().default(4_000),
    AI_SEGMENT_MAX_CHARACTERS: z.coerce.number().int().positive().default(200),
    AI_SEGMENT_MAX_WAIT_MS: z.coerce.number().int().positive().default(500),
    INCOGNITO_CONTEXT_TTL_SECONDS: z.coerce.number().int().positive().default(1_800),
    INCOGNITO_CONTEXT_CLEANUP_INTERVAL_MS: z.coerce.number().int().positive().default(30_000),
    INCOGNITO_CONTEXT_MAX_GLOBAL: z.coerce.number().int().positive().default(1_000),
    INCOGNITO_CONTEXT_MAX_PER_USER: z.coerce.number().int().positive().default(10),
    INCOGNITO_CONTEXT_MAX_PER_SESSION: z.coerce.number().int().positive().default(3),
    INCOGNITO_CONTEXT_MAX_REQUESTS: z.coerce.number().int().positive().default(20),
    INCOGNITO_CONTEXT_MAX_MESSAGES: z.coerce.number().int().positive().default(40),
    INCOGNITO_CONTEXT_MAX_CHARACTERS: z.coerce.number().int().positive().default(32_000),
    INCOGNITO_CONTEXT_MAX_MESSAGE_CHARACTERS: z.coerce.number().int().positive().default(16_384),
    CONSENT_LOCK_MAX_WAITERS_GLOBAL: z.coerce.number().int().positive().default(1_000),
    CONSENT_LOCK_MAX_WAITERS_PER_USER: z.coerce.number().int().positive().default(20),
    CONSENT_ACTIVE_EXECUTIONS_MAX_GLOBAL: z.coerce.number().int().positive().default(1_000),
    CONSENT_ACTIVE_EXECUTIONS_MAX_PER_USER: z.coerce.number().int().positive().default(10),
    CONSENT_REVOKED_MARKER_MAX_GLOBAL: z.coerce.number().int().positive().default(2_000),
    CONSENT_REVOKED_MARKER_MAX_LIFETIME_MS: z.coerce.number().int().positive().default(1_800_000),
    SAFETY_CONTEXT_MAX_MESSAGES: z.coerce.number().int().positive().max(40).default(8),
    SAFETY_CONTEXT_TOKEN_BUDGET: z.coerce.number().int().positive().default(2_000),
    SAFETY_CONTEXT_MAX_CHARACTERS: z.coerce.number().int().positive().default(6_000),
    RISK_CLASSIFIER_MIN_CONFIDENCE: z.coerce.number().min(0).max(1).default(0.65),
    SAFETY_CLASSIFIER_TIMEOUT_MS: z.coerce.number().int().positive().default(5_000),
    RISK_EVENT_RETENTION_DAYS: z.coerce.number().int().positive().default(180),
    AUDIT_RETENTION_DAYS: z.coerce.number().int().positive(),
    SAFETY_PROVIDER_PRIVACY_APPROVED: z
      .enum(['true', 'false'])
      .default('false')
      .transform((value) => value === 'true'),
    SAFETY_CONSENT_APPROVED: z
      .enum(['true', 'false'])
      .default('false')
      .transform((value) => value === 'true'),
    SAFETY_REVIEWER_ACCESS_READY: z
      .enum(['true', 'false'])
      .default('false')
      .transform((value) => value === 'true'),
    SAFETY_CORPUS_REVIEWED: z
      .enum(['true', 'false'])
      .default('false')
      .transform((value) => value === 'true'),
  })
  .superRefine((value, context) => {
    if (
      value.AGE_VERIFICATION_PROVIDER === 'mock' &&
      value.APP_ENV !== 'development' &&
      value.APP_ENV !== 'test'
    ) {
      context.addIssue({
        code: 'custom',
        path: ['AGE_VERIFICATION_PROVIDER'],
        message: 'Mock age verification is restricted to development and test',
      });
    }

    if (value.LLM_PROVIDER === 'siliconflow') {
      if (value.LLM_API_KEY.length === 0) {
        context.addIssue({
          code: 'custom',
          path: ['LLM_API_KEY'],
          message: 'LLM_API_KEY is required for the SiliconFlow provider',
        });
      }
      if (value.LLM_MODEL.length === 0) {
        context.addIssue({
          code: 'custom',
          path: ['LLM_MODEL'],
          message: 'LLM_MODEL is required for the SiliconFlow provider',
        });
      }
    }

    if (value.LLM_FIRST_TOKEN_TIMEOUT_MS > value.LLM_TOTAL_TIMEOUT_MS) {
      context.addIssue({
        code: 'custom',
        path: ['LLM_FIRST_TOKEN_TIMEOUT_MS'],
        message: 'First-token timeout cannot exceed total timeout',
      });
    }
    if (value.LLM_STREAM_IDLE_TIMEOUT_MS > value.LLM_TOTAL_TIMEOUT_MS) {
      context.addIssue({
        code: 'custom',
        path: ['LLM_STREAM_IDLE_TIMEOUT_MS'],
        message: 'Stream idle timeout cannot exceed total timeout',
      });
    }
    if (value.AI_KNOWLEDGE_RETRIEVAL_TIMEOUT_MS > value.LLM_TOTAL_TIMEOUT_MS) {
      context.addIssue({
        code: 'custom',
        path: ['AI_KNOWLEDGE_RETRIEVAL_TIMEOUT_MS'],
        message: 'Knowledge retrieval timeout cannot exceed total timeout',
      });
    }
    if (value.AI_KNOWLEDGE_CONTEXT_TOKEN_BUDGET >= value.LLM_CONTEXT_TOKEN_BUDGET) {
      context.addIssue({
        code: 'custom',
        path: ['AI_KNOWLEDGE_CONTEXT_TOKEN_BUDGET'],
        message: 'Knowledge context allowance must leave room in the total LLM context budget',
      });
    }

    if (
      value.AI_KNOWLEDGE_SYNTHETIC_FIXTURES_ENABLED &&
      value.APP_ENV !== 'development' &&
      value.APP_ENV !== 'test'
    ) {
      context.addIssue({
        code: 'custom',
        path: ['AI_KNOWLEDGE_SYNTHETIC_FIXTURES_ENABLED'],
        message: 'Synthetic Knowledge retrieval is restricted to development and test',
      });
    }

    if (value.INCOGNITO_CONTEXT_MAX_PER_SESSION > value.INCOGNITO_CONTEXT_MAX_PER_USER) {
      context.addIssue({
        code: 'custom',
        path: ['INCOGNITO_CONTEXT_MAX_PER_SESSION'],
        message: 'Incognito per-session context limit cannot exceed the per-user limit',
      });
    }
    if (value.INCOGNITO_CONTEXT_MAX_PER_USER > value.INCOGNITO_CONTEXT_MAX_GLOBAL) {
      context.addIssue({
        code: 'custom',
        path: ['INCOGNITO_CONTEXT_MAX_PER_USER'],
        message: 'Incognito per-user context limit cannot exceed the global limit',
      });
    }
    if (value.INCOGNITO_CONTEXT_MAX_MESSAGE_CHARACTERS > value.INCOGNITO_CONTEXT_MAX_CHARACTERS) {
      context.addIssue({
        code: 'custom',
        path: ['INCOGNITO_CONTEXT_MAX_MESSAGE_CHARACTERS'],
        message: 'Incognito single-message limit cannot exceed the context character limit',
      });
    }
    if (value.CONSENT_LOCK_MAX_WAITERS_PER_USER > value.CONSENT_LOCK_MAX_WAITERS_GLOBAL) {
      context.addIssue({
        code: 'custom',
        path: ['CONSENT_LOCK_MAX_WAITERS_PER_USER'],
        message: 'CONSENT_LOCK_MAX_WAITERS_PER_USER must not exceed the global waiter limit',
      });
    }
    if (value.CONSENT_ACTIVE_EXECUTIONS_MAX_PER_USER > value.CONSENT_ACTIVE_EXECUTIONS_MAX_GLOBAL) {
      context.addIssue({
        code: 'custom',
        path: ['CONSENT_ACTIVE_EXECUTIONS_MAX_PER_USER'],
        message:
          'CONSENT_ACTIVE_EXECUTIONS_MAX_PER_USER must not exceed the global execution limit',
      });
    }
  });

export type AppEnvironment = z.infer<typeof environmentSchema>;

export function parseEnvironment(input: NodeJS.ProcessEnv): AppEnvironment {
  return environmentSchema.parse(input);
}

export const env = parseEnvironment(process.env);
