import { config as loadDotEnv } from 'dotenv';
import { defineConfig } from 'drizzle-kit';
import { resolve } from 'node:path';

loadDotEnv({ path: resolve(process.cwd(), '../.env') });

if (!process.env.DATABASE_URL) {
  throw new Error('DATABASE_URL is required for database migration commands');
}

export default defineConfig({
  dialect: 'postgresql',
  schema: './src/schema.ts',
  out: './migrations',
  dbCredentials: {
    url: process.env.DATABASE_URL,
  },
  strict: true,
  verbose: true,
});
