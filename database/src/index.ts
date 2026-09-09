export { createDatabaseClient, type AppDatabase, type DatabaseClient } from './client.js';
export { and, count, eq, sql } from 'drizzle-orm';
export { migrate } from 'drizzle-orm/node-postgres/migrator';
export {
  ageVerifications,
  consents,
  consentStatus,
  passwordCredentials,
  schema,
  sessions,
  users,
  type ConsentStatus,
} from './schema.js';
