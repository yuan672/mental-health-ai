import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';
import { schema } from './schema.js';

export type AppDatabase = NodePgDatabase<typeof schema>;
export type AppTransaction = Parameters<Parameters<AppDatabase['transaction']>[0]>[0];

export type DatabaseClient = {
  database: AppDatabase;
  pool: Pool;
};

export type DatabaseClientOptions = Readonly<{
  connectionTimeoutMillis?: number;
  queryTimeoutMillis?: number;
}>;

export function createDatabaseClient(
  connectionString: string,
  options: DatabaseClientOptions = {},
): DatabaseClient {
  const pool = new Pool({
    connectionString,
    ...(options.connectionTimeoutMillis === undefined
      ? {}
      : { connectionTimeoutMillis: options.connectionTimeoutMillis }),
    ...(options.queryTimeoutMillis === undefined
      ? {}
      : {
          query_timeout: options.queryTimeoutMillis,
          statement_timeout: options.queryTimeoutMillis,
        }),
  });
  const database = drizzle(pool, { schema });

  return { database, pool };
}
