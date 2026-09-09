import { config as loadDotEnv } from 'dotenv';
import { resolve } from 'node:path';

loadDotEnv({ path: resolve(process.cwd(), '../../.env'), quiet: true });

process.env.APP_ENV = 'test';
process.env.DATABASE_URL = process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL;
process.env.WEB_ORIGINS ??= 'http://localhost:5173';
process.env.SESSION_TTL_SECONDS ??= '604800';
process.env.AGE_VERIFICATION_PROVIDER = 'mock';
process.env.REQUIRED_TERMS_VERSION ??= '1.0';
process.env.REQUIRED_PRIVACY_VERSION ??= '1.0';
process.env.LOG_LEVEL = 'silent';
