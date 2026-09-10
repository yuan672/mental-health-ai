import { randomUUID } from 'node:crypto';
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createDatabaseClient, migrate } from '@mental-health/database';

type MigrationJournal = {
  version: string;
  dialect: string;
  entries: Array<{
    idx: number;
    version: string;
    when: number;
    tag: string;
    breakpoints: boolean;
  }>;
};

type QuotaRow = {
  id: string;
  user_id: string;
  usage_date: string;
  idempotency_key: string;
  created_at: Date;
};

type AggregateRow = {
  user_id: string;
  usage_date: string;
  daily_limit: number;
  used_count: number;
  created_at: Date;
  updated_at: Date;
};

const MIGRATION_0003_CREATED_AT = 1_789_003_803_563;
const MIGRATION_0004_CREATED_AT = 1_789_038_122_994;

function findPostgresErrorCode(error: unknown): string | null {
  let current = error;
  for (let depth = 0; depth < 4; depth += 1) {
    if (typeof current !== 'object' || current === null) return null;
    const record = current as Record<string, unknown>;
    if (typeof record.code === 'string') return record.code;
    current = record.cause;
  }
  return null;
}

describe('migration 0004 quota idempotency upgrade', () => {
  let client: ReturnType<typeof createDatabaseClient>;
  let temporaryRoot: string;
  let migrationsThrough0003: string;
  let migrationsThrough0004: string;

  beforeAll(async () => {
    const url = process.env.TEST_DATABASE_URL;
    if (!url) throw new Error('TEST_DATABASE_URL is required for migration upgrade tests');
    const databaseName = decodeURIComponent(new URL(url).pathname.slice(1));
    if (!databaseName.endsWith('_test')) {
      throw new Error('Migration upgrade tests refuse a database without an _test suffix');
    }

    client = createDatabaseClient(url);
    temporaryRoot = await mkdtemp(join(tmpdir(), 'mental-health-ai-migration-0004-'));
    migrationsThrough0003 = join(temporaryRoot, 'through-0003');
    migrationsThrough0004 = join(temporaryRoot, 'through-0004');
    await materializeRealMigrations(migrationsThrough0003, 3);
    await materializeRealMigrations(migrationsThrough0004, 4);
  });

  beforeEach(async () => {
    await client.pool.query('DROP SCHEMA IF EXISTS drizzle CASCADE');
    await client.pool.query('DROP SCHEMA public CASCADE');
    await client.pool.query('CREATE SCHEMA public');
    await migrate(client.database, { migrationsFolder: migrationsThrough0003 });
    expect(await appliedMigrationState()).toEqual({
      count: 4,
      maximumCreatedAt: MIGRATION_0003_CREATED_AT,
    });
  });

  afterAll(async () => {
    if (client) await client.pool.end();
    if (temporaryRoot) await rm(temporaryRoot, { recursive: true, force: true });
  });

  async function materializeRealMigrations(target: string, maximumIndex: number): Promise<void> {
    const source = resolve(process.cwd(), '../../database/migrations');
    const journal = JSON.parse(
      await readFile(join(source, 'meta', '_journal.json'), 'utf8'),
    ) as MigrationJournal;
    const entries = journal.entries.filter((entry) => entry.idx <= maximumIndex);
    await mkdir(join(target, 'meta'), { recursive: true });
    for (const entry of entries) {
      await copyFile(join(source, `${entry.tag}.sql`), join(target, `${entry.tag}.sql`));
    }
    await writeFile(
      join(target, 'meta', '_journal.json'),
      JSON.stringify({ ...journal, entries }, null, 2),
      'utf8',
    );
  }

  async function insertUser(userId: string): Promise<void> {
    await client.pool.query('INSERT INTO users (id, created_at) VALUES ($1, $2)', [
      userId,
      new Date('2026-09-10T00:00:00.000Z'),
    ]);
  }

  async function insertAggregate(
    userId: string,
    usageDate: string,
    usedCount: number,
  ): Promise<void> {
    await client.pool.query(
      `INSERT INTO daily_usage_quotas
        (user_id, usage_date, daily_limit, used_count, created_at, updated_at)
       VALUES ($1, $2, 20, $3, $4, $4)`,
      [userId, usageDate, usedCount, new Date(`${usageDate}T00:00:00.000Z`)],
    );
  }

  async function insertConsumption(
    userId: string,
    usageDate: string,
    idempotencyKey: string,
  ): Promise<void> {
    await client.pool.query(
      `INSERT INTO quota_consumptions
        (id, user_id, usage_date, idempotency_key, created_at)
       VALUES ($1, $2, $3, $4, $5)`,
      [randomUUID(), userId, usageDate, idempotencyKey, new Date(`${usageDate}T00:01:00.000Z`)],
    );
  }

  async function quotaRows(): Promise<QuotaRow[]> {
    const result = await client.pool.query<QuotaRow>(
      `SELECT id::text, user_id::text, usage_date::text, idempotency_key, created_at
       FROM quota_consumptions
       ORDER BY user_id, usage_date, idempotency_key, id`,
    );
    return result.rows;
  }

  async function aggregateRows(): Promise<AggregateRow[]> {
    const result = await client.pool.query<AggregateRow>(
      `SELECT user_id::text, usage_date::text, daily_limit, used_count, created_at, updated_at
       FROM daily_usage_quotas
       ORDER BY user_id, usage_date`,
    );
    return result.rows;
  }

  async function indexNames(): Promise<string[]> {
    const result = await client.pool.query<{ indexname: string }>(
      `SELECT indexname
       FROM pg_indexes
       WHERE schemaname = 'public' AND tablename = 'quota_consumptions'
       ORDER BY indexname`,
    );
    return result.rows.map((row) => row.indexname);
  }

  async function appliedMigrationState(): Promise<{
    count: number;
    maximumCreatedAt: number;
  }> {
    const result = await client.pool.query<{ count: number; maximum_created_at: string }>(
      `SELECT count(*)::int AS count, max(created_at)::text AS maximum_created_at
       FROM drizzle.__drizzle_migrations`,
    );
    return {
      count: result.rows[0]?.count ?? -1,
      maximumCreatedAt: Number(result.rows[0]?.maximum_created_at ?? Number.NaN),
    };
  }

  it('preserves non-conflicting ledger dates and aggregates while installing global per-user idempotency', async () => {
    const firstUserId = randomUUID();
    const secondUserId = randomUUID();
    await insertUser(firstUserId);
    await insertUser(secondUserId);
    await insertAggregate(firstUserId, '2026-09-09', 1);
    await insertAggregate(firstUserId, '2026-09-10', 1);
    await insertAggregate(secondUserId, '2026-09-10', 1);
    await insertConsumption(firstUserId, '2026-09-09', 'shared-across-users');
    await insertConsumption(firstUserId, '2026-09-10', 'second-request');
    await insertConsumption(secondUserId, '2026-09-10', 'shared-across-users');
    const ledgerBefore = await quotaRows();
    const aggregatesBefore = await aggregateRows();

    await migrate(client.database, { migrationsFolder: migrationsThrough0004 });

    expect(await quotaRows()).toEqual(ledgerBefore);
    expect(await aggregateRows()).toEqual(aggregatesBefore);
    expect(await indexNames()).toEqual(
      expect.arrayContaining([
        'quota_consumptions_user_date_idx',
        'quota_consumptions_user_key_unique',
      ]),
    );
    expect(await indexNames()).not.toContain('quota_consumptions_user_date_key_unique');
    expect(await appliedMigrationState()).toEqual({
      count: 5,
      maximumCreatedAt: MIGRATION_0004_CREATED_AT,
    });

    await expect(
      insertConsumption(firstUserId, '2026-09-11', 'shared-across-users'),
    ).rejects.toMatchObject({ code: '23505' });
    await insertConsumption(secondUserId, '2026-09-11', 'second-request');
  });

  it('fails conflicting cross-day history atomically without changing data, aggregates, indexes, or journal', async () => {
    const userId = randomUUID();
    await insertUser(userId);
    await insertAggregate(userId, '2026-09-09', 1);
    await insertAggregate(userId, '2026-09-10', 1);
    await insertConsumption(userId, '2026-09-09', 'cross-day-duplicate');
    await insertConsumption(userId, '2026-09-10', 'cross-day-duplicate');
    const ledgerBefore = await quotaRows();
    const aggregatesBefore = await aggregateRows();

    let migrationFailure: unknown;
    try {
      await migrate(client.database, { migrationsFolder: migrationsThrough0004 });
    } catch (error) {
      migrationFailure = error;
    }
    expect(findPostgresErrorCode(migrationFailure)).toBe('23505');

    expect(await quotaRows()).toEqual(ledgerBefore);
    expect(await aggregateRows()).toEqual(aggregatesBefore);
    expect(await indexNames()).toContain('quota_consumptions_user_date_key_unique');
    expect(await indexNames()).not.toContain('quota_consumptions_user_key_unique');
    expect(await appliedMigrationState()).toEqual({
      count: 4,
      maximumCreatedAt: MIGRATION_0003_CREATED_AT,
    });
  });
});
