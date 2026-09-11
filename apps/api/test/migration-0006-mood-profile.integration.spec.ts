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

const MIGRATION_0005_CREATED_AT = 1_789_053_242_026;
const MIGRATION_0006_CREATED_AT = 1_789_101_771_120;

describe('migration 0006 Mood/Profile backend upgrade', () => {
  let client: ReturnType<typeof createDatabaseClient>;
  let temporaryRoot: string;
  let through0005: string;
  let through0006: string;

  beforeAll(async () => {
    const url = process.env.TEST_DATABASE_URL;
    if (!url) throw new Error('TEST_DATABASE_URL is required for migration upgrade tests');
    const databaseName = decodeURIComponent(new URL(url).pathname.slice(1));
    if (!databaseName.endsWith('_test')) {
      throw new Error('Migration upgrade tests refuse a database without an _test suffix');
    }
    client = createDatabaseClient(url);
    temporaryRoot = await mkdtemp(join(tmpdir(), 'mental-health-ai-migration-0006-'));
    through0005 = join(temporaryRoot, 'through-0005');
    through0006 = join(temporaryRoot, 'through-0006');
    await materialize(through0005, 5);
    await materialize(through0006, 6);
  });

  beforeEach(async () => {
    await resetPublicSchema();
    await migrate(client.database, { migrationsFolder: through0005 });
  });

  afterAll(async () => {
    await client.pool.end();
    await rm(temporaryRoot, { recursive: true, force: true });
  });

  async function resetPublicSchema(): Promise<void> {
    await client.pool.query('DROP SCHEMA IF EXISTS drizzle CASCADE');
    await client.pool.query('DROP SCHEMA public CASCADE');
    await client.pool.query('CREATE SCHEMA public');
  }

  async function materialize(target: string, maximumIndex: number): Promise<void> {
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

  it('applies all migrations from an empty database', async () => {
    await resetPublicSchema();
    await migrate(client.database, { migrationsFolder: through0006 });
    const tables = await client.pool.query<{ table_name: string }>(
      `SELECT table_name FROM information_schema.tables
       WHERE table_schema = 'public' ORDER BY table_name`,
    );
    expect(tables.rows.map((row) => row.table_name)).toContain('mood_entries');
    const migrationState = await client.pool.query<{ count: number; maximum: string }>(
      `SELECT count(*)::int AS count, max(created_at)::text AS maximum
       FROM drizzle.__drizzle_migrations`,
    );
    expect(migrationState.rows[0]).toEqual({
      count: 7,
      maximum: String(MIGRATION_0006_CREATED_AT),
    });
  });

  it('upgrades a non-empty 0005 database without changing existing rows', async () => {
    const userId = randomUUID();
    const conversationId = randomUUID();
    const createdAt = new Date('2026-09-01T00:00:00.000Z');
    const expiresAt = new Date('2026-11-30T00:00:00.000Z');
    await client.pool.query('INSERT INTO users (id, created_at) VALUES ($1, $2)', [
      userId,
      createdAt,
    ]);
    await client.pool.query(
      `INSERT INTO conversations
       (id, user_id, created_at, expires_at, is_saved, deleted_at)
       VALUES ($1, $2, $3, $4, false, null)`,
      [conversationId, userId, createdAt, expiresAt],
    );

    await migrate(client.database, { migrationsFolder: through0006 });

    const existing = await client.pool.query<{
      id: string;
      user_id: string;
      created_at: Date;
      expires_at: Date;
    }>(
      `SELECT id::text, user_id::text, created_at, expires_at
       FROM conversations WHERE id = $1`,
      [conversationId],
    );
    expect(existing.rows).toEqual([
      { id: conversationId, user_id: userId, created_at: createdAt, expires_at: expiresAt },
    ]);
    const moods = await client.pool.query<{ count: number }>(
      'SELECT count(*)::int AS count FROM mood_entries',
    );
    expect(moods.rows[0]?.count).toBe(0);
  });

  it('rejects invalid Mood data and cascades rows with their account lifecycle', async () => {
    const userId = randomUUID();
    const now = new Date('2026-09-11T00:00:00.000Z');
    await client.pool.query('INSERT INTO users (id, created_at) VALUES ($1, $2)', [userId, now]);
    await migrate(client.database, { migrationsFolder: through0006 });

    const insert = (overrides: Partial<Record<string, unknown>> = {}) => {
      const value = {
        id: randomUUID(),
        userId,
        clientRequestId: randomUUID(),
        moodScore: 3,
        emotion: 'calm',
        note: 'synthetic',
        stateRevision: 1,
        createdAt: now,
        updatedAt: now,
        ...overrides,
      };
      return client.pool.query(
        `INSERT INTO mood_entries
         (id, user_id, client_request_id, mood_score, emotion, note,
          state_revision, created_at, updated_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
        [
          value.id,
          value.userId,
          value.clientRequestId,
          value.moodScore,
          value.emotion,
          value.note,
          value.stateRevision,
          value.createdAt,
          value.updatedAt,
        ],
      );
    };

    await insert();
    await expect(insert({ moodScore: 6 })).rejects.toBeDefined();
    await expect(insert({ emotion: 'diagnosed' })).rejects.toBeDefined();
    await expect(insert({ note: '🙂'.repeat(501) })).rejects.toBeDefined();
    await expect(insert({ stateRevision: 0 })).rejects.toBeDefined();
    await expect(insert({ updatedAt: new Date(now.getTime() - 1) })).rejects.toBeDefined();

    await client.pool.query('DELETE FROM users WHERE id = $1', [userId]);
    const remaining = await client.pool.query<{ count: number }>(
      'SELECT count(*)::int AS count FROM mood_entries WHERE user_id = $1',
      [userId],
    );
    expect(remaining.rows[0]?.count).toBe(0);
  });

  it('fails atomically on a conflicting target table without recording 0006 as applied', async () => {
    const userId = randomUUID();
    await client.pool.query('INSERT INTO users (id, created_at) VALUES ($1, $2)', [
      userId,
      new Date('2026-09-01T00:00:00.000Z'),
    ]);
    await client.pool.query('CREATE TABLE mood_entries (placeholder integer NOT NULL)');

    await expect(migrate(client.database, { migrationsFolder: through0006 })).rejects.toBeDefined();

    const migrationState = await client.pool.query<{ count: number; maximum: string }>(
      `SELECT count(*)::int AS count, max(created_at)::text AS maximum
       FROM drizzle.__drizzle_migrations`,
    );
    expect(migrationState.rows[0]).toEqual({
      count: 6,
      maximum: String(MIGRATION_0005_CREATED_AT),
    });
    const usersAfter = await client.pool.query<{ id: string }>(
      'SELECT id::text FROM users WHERE id = $1',
      [userId],
    );
    expect(usersAfter.rows).toEqual([{ id: userId }]);
    const columns = await client.pool.query<{ column_name: string }>(
      `SELECT column_name FROM information_schema.columns
       WHERE table_schema = 'public' AND table_name = 'mood_entries'`,
    );
    expect(columns.rows).toEqual([{ column_name: 'placeholder' }]);
  });
});
