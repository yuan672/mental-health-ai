import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';
import { schema } from './schema.js';

export type AppDatabase = NodePgDatabase<typeof schema>;
export type AppTransaction = Parameters<Parameters<AppDatabase['transaction']>[0]>[0];

export type DatabaseClient = {
  database: AppDatabase;
  pool: Pool;
};

export function createDatabaseClient(connectionString: string): DatabaseClient {
  const pool = new Pool({ connectionString });
  const database = drizzle(pool, { schema });

  return { database, pool };
}
