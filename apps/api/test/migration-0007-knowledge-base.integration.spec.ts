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

const MIGRATION_0006_CREATED_AT = 1_789_101_771_120;
const MIGRATION_0007_CREATED_AT = 1_789_114_350_337;

describe('migration 0007 Knowledge Base upgrade', () => {
  let client: ReturnType<typeof createDatabaseClient>;
  let temporaryRoot: string;
  let through0006: string;
  let through0007: string;

  beforeAll(async () => {
    const url = process.env.TEST_DATABASE_URL;
    if (!url) throw new Error('TEST_DATABASE_URL is required for migration upgrade tests');
    const databaseName = decodeURIComponent(new URL(url).pathname.slice(1));
    if (!databaseName.endsWith('_test')) {
      throw new Error('Migration upgrade tests refuse a database without an _test suffix');
    }
    client = createDatabaseClient(url);
    temporaryRoot = await mkdtemp(join(tmpdir(), 'mental-health-ai-migration-0007-'));
    through0006 = join(temporaryRoot, 'through-0006');
    through0007 = join(temporaryRoot, 'through-0007');
    await materialize(through0006, 6);
    await materialize(through0007, 7);
  });

  beforeEach(async () => {
    await resetPublicSchema();
    await migrate(client.database, { migrationsFolder: through0006 });
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

  it('applies every migration from an empty protected test database', async () => {
    await resetPublicSchema();
    await migrate(client.database, { migrationsFolder: through0007 });
    const tables = await client.pool.query<{ table_name: string }>(
      `SELECT table_name FROM information_schema.tables
       WHERE table_schema = 'public' ORDER BY table_name`,
    );
    expect(tables.rows.map((row) => row.table_name)).toEqual(
      expect.arrayContaining([
        'knowledge_articles',
        'knowledge_article_versions',
        'knowledge_article_sources',
      ]),
    );
    const migrationState = await client.pool.query<{ count: number; maximum: string }>(
      `SELECT count(*)::int AS count, max(created_at)::text AS maximum
       FROM drizzle.__drizzle_migrations`,
    );
    expect(migrationState.rows[0]).toEqual({
      count: 8,
      maximum: String(MIGRATION_0007_CREATED_AT),
    });
  });

  it('upgrades a non-empty 0006 database without changing existing rows', async () => {
    const userId = randomUUID();
    const moodId = randomUUID();
    const createdAt = new Date('2026-09-10T10:00:00.000Z');
    await client.pool.query('INSERT INTO users (id, created_at) VALUES ($1, $2)', [
      userId,
      createdAt,
    ]);
    await client.pool.query(
      `INSERT INTO mood_entries
       (id, user_id, client_request_id, mood_score, emotion, note,
        state_revision, created_at, updated_at)
       VALUES ($1,$2,$3,4,'calm','synthetic-existing-row',1,$4,$4)`,
      [moodId, userId, randomUUID(), createdAt],
    );

    await migrate(client.database, { migrationsFolder: through0007 });

    const existing = await client.pool.query<{
      id: string;
      user_id: string;
      mood_score: number;
      note: string;
    }>('SELECT id::text, user_id::text, mood_score, note FROM mood_entries WHERE id = $1', [
      moodId,
    ]);
    expect(existing.rows).toEqual([
      { id: moodId, user_id: userId, mood_score: 4, note: 'synthetic-existing-row' },
    ]);
    const knowledgeCount = await client.pool.query<{ count: number }>(
      'SELECT count(*)::int AS count FROM knowledge_articles',
    );
    expect(knowledgeCount.rows[0]?.count).toBe(0);
  });

  it('enforces published source evidence and immutable published versions', async () => {
    await migrate(client.database, { migrationsFolder: through0007 });
    const articleId = randomUUID();
    const versionId = randomUUID();
    const now = new Date('2026-09-11T08:00:00.000Z');
    await client.pool.query(
      'INSERT INTO knowledge_articles (id, article_key, created_at) VALUES ($1,$2,$3)',
      [articleId, 'synthetic-migration-contract', now],
    );
    await client.pool.query(
      `INSERT INTO knowledge_article_versions
       (id, article_id, version, title, summary, content_blocks, publication_status,
        review_status, content_origin, reviewed_by, reviewed_at, published_at,
        withdrawn_at, created_at)
       VALUES ($1,$2,1,'合成标题','合成摘要',$3,'draft','unverified',
        'synthetic_fixture',NULL,NULL,NULL,NULL,$4)`,
      [versionId, articleId, JSON.stringify([{ type: 'paragraph', text: '合成正文' }]), now],
    );
    await client.pool.query(
      `INSERT INTO knowledge_article_sources
       (id, article_version_id, ordinal, publisher_name, source_title, source_url,
        source_published_at, source_version_label, source_locator, retrieved_at)
       VALUES ($1,$2,1,'合成发布者','合成来源','https://synthetic.invalid/source',
        NULL,NULL,NULL,$3)`,
      [randomUUID(), versionId, now],
    );
    await client.pool.query(
      `UPDATE knowledge_article_versions
       SET publication_status='published', published_at=$2 WHERE id=$1`,
      [versionId, now],
    );

    await expect(
      client.pool.query("UPDATE knowledge_article_versions SET title='被篡改标题' WHERE id=$1", [
        versionId,
      ]),
    ).rejects.toBeDefined();
    await expect(
      client.pool.query(
        `UPDATE knowledge_article_sources SET source_title='被篡改来源'
         WHERE article_version_id=$1`,
        [versionId],
      ),
    ).rejects.toBeDefined();
    await expect(
      client.pool.query(
        `INSERT INTO knowledge_article_sources
         (id, article_version_id, ordinal, publisher_name, source_title, source_url,
          source_published_at, source_version_label, source_locator, retrieved_at)
         VALUES ($1,$2,2,'新增发布者','新增来源','https://synthetic.invalid/extra',
          NULL,NULL,NULL,$3)`,
        [randomUUID(), versionId, now],
      ),
    ).rejects.toBeDefined();

    const emptyArticleId = randomUUID();
    const emptyVersionId = randomUUID();
    await client.pool.query(
      'INSERT INTO knowledge_articles (id, article_key, created_at) VALUES ($1,$2,$3)',
      [emptyArticleId, 'synthetic-missing-source', now],
    );
    await client.pool.query('BEGIN');
    try {
      await client.pool.query(
        `INSERT INTO knowledge_article_versions
         (id, article_id, version, title, summary, content_blocks, publication_status,
          review_status, content_origin, reviewed_by, reviewed_at, published_at,
          withdrawn_at, created_at)
         VALUES ($1,$2,2,'无来源','无来源',$3,'published','unverified',
          'synthetic_fixture',NULL,NULL,$4,NULL,$4)`,
        [
          emptyVersionId,
          emptyArticleId,
          JSON.stringify([{ type: 'paragraph', text: '合成正文' }]),
          now,
        ],
      );
      await expect(client.pool.query('COMMIT')).rejects.toBeDefined();
    } finally {
      await client.pool.query('ROLLBACK').catch(() => undefined);
    }
    const missing = await client.pool.query<{ count: number }>(
      'SELECT count(*)::int AS count FROM knowledge_article_versions WHERE id=$1',
      [emptyVersionId],
    );
    expect(missing.rows[0]?.count).toBe(0);
  });

  it('fails atomically on a conflicting target table without recording 0007', async () => {
    const userId = randomUUID();
    await client.pool.query('INSERT INTO users (id, created_at) VALUES ($1, $2)', [
      userId,
      new Date('2026-09-11T00:00:00.000Z'),
    ]);
    await client.pool.query('CREATE TABLE knowledge_articles (placeholder integer NOT NULL)');

    await expect(migrate(client.database, { migrationsFolder: through0007 })).rejects.toBeDefined();

    const migrationState = await client.pool.query<{ count: number; maximum: string }>(
      `SELECT count(*)::int AS count, max(created_at)::text AS maximum
       FROM drizzle.__drizzle_migrations`,
    );
    expect(migrationState.rows[0]).toEqual({
      count: 7,
      maximum: String(MIGRATION_0006_CREATED_AT),
    });
    const usersAfter = await client.pool.query<{ id: string }>(
      'SELECT id::text FROM users WHERE id=$1',
      [userId],
    );
    expect(usersAfter.rows).toEqual([{ id: userId }]);
    const columns = await client.pool.query<{ column_name: string }>(
      `SELECT column_name FROM information_schema.columns
       WHERE table_schema='public' AND table_name='knowledge_articles'`,
    );
    expect(columns.rows).toEqual([{ column_name: 'placeholder' }]);
  });
});
