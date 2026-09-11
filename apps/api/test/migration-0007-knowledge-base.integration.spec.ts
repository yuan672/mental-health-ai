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

  async function waitForDatabaseBlock(blockedPid: number, blockingPid: number): Promise<void> {
    const deadline = Date.now() + 5_000;
    while (Date.now() < deadline) {
      const result = await client.pool.query<{ blocked: boolean }>(
        'SELECT $1::int = ANY(pg_blocking_pids($2::int)) AS blocked',
        [blockingPid, blockedPid],
      );
      if (result.rows[0]?.blocked) return;
      await new Promise<void>((resolvePromise) => setImmediate(resolvePromise));
    }
    throw new Error('Expected PostgreSQL operation did not reach the controlled lock barrier');
  }

  async function insertUnverifiedDraft(articleKey: string): Promise<{
    articleId: string;
    versionId: string;
    sourceId: string;
  }> {
    const articleId = randomUUID();
    const versionId = randomUUID();
    const sourceId = randomUUID();
    const now = new Date('2026-09-11T08:00:00.000Z');
    await client.pool.query(
      'INSERT INTO knowledge_articles (id, article_key, created_at) VALUES ($1,$2,$3)',
      [articleId, articleKey, now],
    );
    await client.pool.query(
      `INSERT INTO knowledge_article_versions
       (id, article_id, version, title, summary, content_blocks, publication_status,
        review_status, content_origin, reviewed_by, reviewed_at, published_at,
        withdrawn_at, created_at)
       VALUES ($1,$2,1,'合成标题','合成摘要',$3,'draft','unverified',
        'curated',NULL,NULL,NULL,NULL,$4)`,
      [versionId, articleId, JSON.stringify([{ type: 'paragraph', text: '合成正文' }]), now],
    );
    await client.pool.query(
      `INSERT INTO knowledge_article_sources
       (id, article_version_id, ordinal, publisher_name, source_title, source_url,
        source_published_at, source_version_label, source_locator, retrieved_at)
       VALUES ($1,$2,1,'合成发布者','合成来源','https://synthetic.invalid/source',
        NULL,'synthetic-v1',NULL,$3)`,
      [sourceId, versionId, now],
    );
    return { articleId, versionId, sourceId };
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

  it('freezes source membership and ordering for verified, published, and withdrawn versions', async () => {
    await migrate(client.database, { migrationsFolder: through0007 });
    const verified = await insertUnverifiedDraft('synthetic-verified-source-freeze');
    const target = await insertUnverifiedDraft('synthetic-reparent-target');
    const verifiedAt = new Date('2026-09-11T09:00:00.000Z');
    await client.pool.query(
      `UPDATE knowledge_article_versions
       SET review_status='source_verified', reviewed_by='synthetic-test-reviewer', reviewed_at=$2
       WHERE id=$1`,
      [verified.versionId, verifiedAt],
    );

    const assertFrozen = async (): Promise<void> => {
      await expect(
        client.pool.query(
          `INSERT INTO knowledge_article_sources
           (id, article_version_id, ordinal, publisher_name, source_title, source_url,
            source_published_at, source_version_label, source_locator, retrieved_at)
           VALUES ($1,$2,2,'新增发布者','新增来源','https://synthetic.invalid/extra',
            NULL,NULL,NULL,$3)`,
          [randomUUID(), verified.versionId, verifiedAt],
        ),
      ).rejects.toBeDefined();
      await expect(
        client.pool.query(
          "UPDATE knowledge_article_sources SET source_title='被篡改来源' WHERE id=$1",
          [verified.sourceId],
        ),
      ).rejects.toBeDefined();
      await expect(
        client.pool.query(
          'UPDATE knowledge_article_sources SET article_version_id=$2 WHERE id=$1',
          [verified.sourceId, target.versionId],
        ),
      ).rejects.toBeDefined();
      await expect(
        client.pool.query('DELETE FROM knowledge_article_sources WHERE id=$1', [verified.sourceId]),
      ).rejects.toBeDefined();
      const sources = await client.pool.query<{
        id: string;
        article_version_id: string;
        ordinal: number;
        source_title: string;
      }>(
        `SELECT id::text, article_version_id::text, ordinal, source_title
         FROM knowledge_article_sources WHERE id=$1`,
        [verified.sourceId],
      );
      expect(sources.rows).toEqual([
        {
          id: verified.sourceId,
          article_version_id: verified.versionId,
          ordinal: 1,
          source_title: '合成来源',
        },
      ]);
      const targetSources = await client.pool.query<{ count: number }>(
        'SELECT count(*)::int AS count FROM knowledge_article_sources WHERE article_version_id=$1',
        [target.versionId],
      );
      expect(targetSources.rows[0]?.count).toBe(1);
    };

    await assertFrozen();
    await client.pool.query(
      `UPDATE knowledge_article_versions
       SET publication_status='published', published_at=$2 WHERE id=$1`,
      [verified.versionId, new Date('2026-09-11T10:00:00.000Z')],
    );
    await assertFrozen();
    await client.pool.query(
      `UPDATE knowledge_article_versions
       SET publication_status='withdrawn', withdrawn_at=$2 WHERE id=$1`,
      [verified.versionId, new Date('2026-09-11T11:00:00.000Z')],
    );
    await assertFrozen();
    const state = await client.pool.query<{
      publication_status: string;
      review_status: string;
    }>(
      `SELECT publication_status::text, review_status::text
       FROM knowledge_article_versions WHERE id=$1`,
      [verified.versionId],
    );
    expect(state.rows).toEqual([
      { publication_status: 'withdrawn', review_status: 'source_verified' },
    ]);

    await client.pool.query('DELETE FROM knowledge_articles WHERE id=$1', [verified.articleId]);
    const dependencyClosed = await client.pool.query<{ versions: number; sources: number }>(
      `SELECT
         (SELECT count(*)::int FROM knowledge_article_versions WHERE article_id=$1) AS versions,
         (SELECT count(*)::int FROM knowledge_article_sources WHERE id=$2) AS sources`,
      [verified.articleId, verified.sourceId],
    );
    expect(dependencyClosed.rows).toEqual([{ versions: 0, sources: 0 }]);
  });

  it('serializes source writes with the verification and publication boundary', async () => {
    await migrate(client.database, { migrationsFolder: through0007 });
    const boundaryFirst = await insertUnverifiedDraft('synthetic-boundary-first');
    const sourceFirst = await insertUnverifiedDraft('synthetic-source-first');
    const boundaryClient = await client.pool.connect();
    const sourceClient = await client.pool.connect();
    try {
      const boundaryPid = (
        await boundaryClient.query<{ pid: number }>('SELECT pg_backend_pid() AS pid')
      ).rows[0]!.pid;
      const sourcePid = (
        await sourceClient.query<{ pid: number }>('SELECT pg_backend_pid() AS pid')
      ).rows[0]!.pid;
      const reviewedAt = new Date('2026-09-11T09:00:00.000Z');

      await boundaryClient.query('BEGIN');
      await sourceClient.query('BEGIN');
      await boundaryClient.query(
        `UPDATE knowledge_article_versions
         SET review_status='source_verified', reviewed_by='synthetic-test-reviewer', reviewed_at=$2,
             publication_status='published', published_at=$2
         WHERE id=$1`,
        [boundaryFirst.versionId, reviewedAt],
      );
      const lateSource = sourceClient
        .query(
          `INSERT INTO knowledge_article_sources
           (id, article_version_id, ordinal, publisher_name, source_title, source_url,
            source_published_at, source_version_label, source_locator, retrieved_at)
           VALUES ($1,$2,2,'迟到发布者','迟到来源','https://synthetic.invalid/late',
            NULL,NULL,NULL,$3)`,
          [randomUUID(), boundaryFirst.versionId, reviewedAt],
        )
        .then(
          () => ({ accepted: true as const }),
          (error: unknown) => ({ accepted: false as const, error }),
        );
      await waitForDatabaseBlock(sourcePid, boundaryPid);
      await boundaryClient.query('COMMIT');
      expect(await lateSource).toEqual(expect.objectContaining({ accepted: false }));
      await sourceClient.query('ROLLBACK');

      await sourceClient.query('BEGIN');
      await boundaryClient.query('BEGIN');
      await sourceClient.query(
        `INSERT INTO knowledge_article_sources
         (id, article_version_id, ordinal, publisher_name, source_title, source_url,
          source_published_at, source_version_label, source_locator, retrieved_at)
         VALUES ($1,$2,2,'先到发布者','先到来源','https://synthetic.invalid/before',
          NULL,NULL,NULL,$3)`,
        [randomUUID(), sourceFirst.versionId, reviewedAt],
      );
      const publication = boundaryClient
        .query(
          `UPDATE knowledge_article_versions
           SET review_status='source_verified', reviewed_by='synthetic-test-reviewer', reviewed_at=$2,
               publication_status='published', published_at=$2
           WHERE id=$1`,
          [sourceFirst.versionId, reviewedAt],
        )
        .then(
          () => ({ accepted: true as const }),
          (error: unknown) => ({ accepted: false as const, error }),
        );
      await waitForDatabaseBlock(boundaryPid, sourcePid);
      await sourceClient.query('COMMIT');
      expect(await publication).toEqual({ accepted: true });
      await boundaryClient.query('COMMIT');

      const boundarySources = await client.pool.query<{ count: number }>(
        'SELECT count(*)::int AS count FROM knowledge_article_sources WHERE article_version_id=$1',
        [boundaryFirst.versionId],
      );
      expect(boundarySources.rows[0]?.count).toBe(1);
      const sourceFirstRows = await client.pool.query<{ ordinal: number; source_title: string }>(
        `SELECT ordinal, source_title FROM knowledge_article_sources
         WHERE article_version_id=$1 ORDER BY ordinal`,
        [sourceFirst.versionId],
      );
      expect(sourceFirstRows.rows).toEqual([
        { ordinal: 1, source_title: '合成来源' },
        { ordinal: 2, source_title: '先到来源' },
      ]);
      await expect(
        client.pool.query('DELETE FROM knowledge_article_sources WHERE article_version_id=$1', [
          sourceFirst.versionId,
        ]),
      ).rejects.toBeDefined();
    } finally {
      await boundaryClient.query('ROLLBACK').catch(() => undefined);
      await sourceClient.query('ROLLBACK').catch(() => undefined);
      boundaryClient.release();
      sourceClient.release();
    }
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
