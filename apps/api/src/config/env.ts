import { config as loadDotEnv } from 'dotenv';
import { resolve } from 'node:path';
import { z } from 'zod';

loadDotEnv({ path: resolve(process.cwd(), '../../.env'), quiet: true });

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
    REQUIRED_TERMS_VERSION: z.string().min(1).max(64).default('1.0'),
    REQUIRED_PRIVACY_VERSION: z.string().min(1).max(64).default('1.0'),
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
  });

export type AppEnvironment = z.infer<typeof environmentSchema>;

export function parseEnvironment(input: NodeJS.ProcessEnv): AppEnvironment {
  return environmentSchema.parse(input);
}

export const env = parseEnvironment(process.env);
