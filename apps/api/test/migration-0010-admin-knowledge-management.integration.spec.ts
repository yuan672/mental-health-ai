import { randomUUID } from 'node:crypto';
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createDatabaseClient, migrate } from '@mental-health/database';

type Journal = {
  version: string;
  dialect: string;
  entries: Array<{ idx: number; version: string; when: number; tag: string; breakpoints: boolean }>;
};

describe('migration 0010 Admin Knowledge Management', () => {
  let client: ReturnType<typeof createDatabaseClient>;
  let temporaryRoot: string;
  let through0009: string;
  let through0010: string;

  beforeAll(async () => {
    const url = process.env.TEST_DATABASE_URL;
    if (!url) throw new Error('TEST_DATABASE_URL is required');
    const name = decodeURIComponent(new URL(url).pathname.slice(1));
    if (!name.endsWith('_test')) throw new Error('Refusing non-test database');
    client = createDatabaseClient(url);
    temporaryRoot = await mkdtemp(join(tmpdir(), 'mental-health-ai-migration-0010-'));
    through0009 = join(temporaryRoot, 'through-0009');
    through0010 = join(temporaryRoot, 'through-0010');
    await materialize(through0009, 9);
    await materialize(through0010, 10);
  });

  beforeEach(async () => {
    await reset();
    await migrate(client.database, { migrationsFolder: through0009 });
  });

  afterAll(async () => {
    await client.pool.end();
    await rm(temporaryRoot, { recursive: true, force: true });
  });

  async function reset(): Promise<void> {
    await client.pool.query('DROP SCHEMA IF EXISTS drizzle CASCADE');
    await client.pool.query('DROP SCHEMA public CASCADE');
    await client.pool.query('CREATE SCHEMA public');
  }

  async function materialize(target: string, maximum: number): Promise<void> {
    const source = resolve(process.cwd(), '../../database/migrations');
    const journal = JSON.parse(
      await readFile(join(source, 'meta', '_journal.json'), 'utf8'),
    ) as Journal;
    const entries = journal.entries.filter((entry) => entry.idx <= maximum);
    await mkdir(join(target, 'meta'), { recursive: true });
    for (const entry of entries) {
      await copyFile(join(source, `${entry.tag}.sql`), join(target, `${entry.tag}.sql`));
    }
    await writeFile(join(target, 'meta', '_journal.json'), JSON.stringify({ ...journal, entries }));
  }

  async function insertDraft(input: {
    articleKey: string;
    reviewStatus?: 'unverified' | 'source_verified';
  }) {
    const articleId = randomUUID();
    const versionId = randomUUID();
    const reviewed = input.reviewStatus === 'source_verified';
    await client.pool.query(
      'INSERT INTO knowledge_articles (id,article_key,created_at) VALUES ($1,$2,$3)',
      [articleId, input.articleKey, '2026-09-12T01:00:00.000Z'],
    );
    await client.pool.query(
      `INSERT INTO knowledge_article_versions
       (id,article_id,version,title,summary,content_blocks,publication_status,review_status,
        content_origin,reviewed_by,reviewed_at,published_at,withdrawn_at,created_at)
       VALUES ($1,$2,1,'合成标题','合成摘要',$3,'draft','unverified','curated',NULL,NULL,NULL,NULL,$4)`,
      [
        versionId,
        articleId,
        JSON.stringify([{ type: 'paragraph', text: '合成正文' }]),
        '2026-09-12T01:00:00.000Z',
      ],
    );
    await client.pool.query(
      `INSERT INTO knowledge_article_sources
       (id,article_version_id,ordinal,publisher_name,source_title,source_url,retrieved_at)
       VALUES ($1,$2,1,'合成发布者','合成来源','https://source.test.invalid/one',$3)`,
      [randomUUID(), versionId, '2026-09-12T00:00:00.000Z'],
    );
    if (reviewed) {
      await client.pool.query(
        `UPDATE knowledge_article_versions
         SET review_status='source_verified',reviewed_by='synthetic-reviewer',reviewed_at=$1
         WHERE id=$2`,
        ['2026-09-12T02:00:00.000Z', versionId],
      );
    }
    return { articleId, versionId };
  }

  it('applies all migrations to an empty protected database', async () => {
    await reset();
    await migrate(client.database, { migrationsFolder: through0010 });
    const column = await client.pool.query<{ column_default: string; is_nullable: string }>(
      `SELECT column_default,is_nullable FROM information_schema.columns
       WHERE table_schema='public' AND table_name='knowledge_article_versions'
         AND column_name='draft_revision'`,
    );
    expect(column.rows).toEqual([{ column_default: '1', is_nullable: 'NO' }]);
  });

  it('upgrades populated 0009 data without rewriting content or review evidence', async () => {
    const existing = await insertDraft({
      articleKey: 'preserved-reviewed-candidate',
      reviewStatus: 'source_verified',
    });
    await migrate(client.database, { migrationsFolder: through0010 });
    const result = await client.pool.query<{
      draft_revision: number;
      title: string;
      review_status: string;
      reviewed_by: string;
      source_title: string;
    }>(
      `SELECT v.draft_revision,v.title,v.review_status,v.reviewed_by,s.source_title
       FROM knowledge_article_versions v
       JOIN knowledge_article_sources s ON s.article_version_id=v.id
       WHERE v.id=$1`,
      [existing.versionId],
    );
    expect(result.rows).toEqual([
      {
        draft_revision: 1,
        title: '合成标题',
        review_status: 'source_verified',
        reviewed_by: 'synthetic-reviewer',
        source_title: '合成来源',
      },
    ]);
  });

  it('fails an incompatible upgrade atomically and does not mark 0010 applied', async () => {
    await client.pool.query(
      'ALTER TABLE knowledge_article_versions ADD COLUMN draft_revision integer NOT NULL DEFAULT 9',
    );
    await expect(migrate(client.database, { migrationsFolder: through0010 })).rejects.toBeDefined();
    const constraint = await client.pool.query<{ count: number }>(
      `SELECT count(*)::int AS count FROM pg_constraint
       WHERE conname='knowledge_article_versions_status_timestamps_check'`,
    );
    expect(constraint.rows[0]?.count).toBe(1);
    const history = await client.pool.query<{ count: number }>(
      'SELECT count(*)::int AS count FROM drizzle.__drizzle_migrations',
    );
    expect(history.rows[0]?.count).toBe(10);
  });

  it('advances opaque revisions and freezes reviewed candidate and source evidence', async () => {
    await migrate(client.database, { migrationsFolder: through0010 });
    const { versionId } = await insertDraft({ articleKey: 'revision-and-freeze' });
    const afterInsert = await client.pool.query<{ draft_revision: number }>(
      'SELECT draft_revision FROM knowledge_article_versions WHERE id=$1',
      [versionId],
    );
    expect(afterInsert.rows[0]?.draft_revision).toBe(2);

    await client.pool.query('UPDATE knowledge_article_versions SET title=$1 WHERE id=$2', [
      '修订标题',
      versionId,
    ]);
    await client.pool.query(
      'UPDATE knowledge_article_sources SET source_title=$1 WHERE article_version_id=$2',
      ['修订来源', versionId],
    );
    const afterChanges = await client.pool.query<{ draft_revision: number }>(
      'SELECT draft_revision FROM knowledge_article_versions WHERE id=$1',
      [versionId],
    );
    expect(afterChanges.rows[0]?.draft_revision).toBe(4);
    await expect(
      client.pool.query(
        'UPDATE knowledge_article_versions SET draft_revision=draft_revision+10 WHERE id=$1',
        [versionId],
      ),
    ).rejects.toBeDefined();

    await client.pool.query(
      `UPDATE knowledge_article_versions
       SET review_status='source_verified',reviewed_by='synthetic-reviewer',reviewed_at=$1
       WHERE id=$2`,
      ['2026-09-12T03:00:00.000Z', versionId],
    );
    await expect(
      client.pool.query('UPDATE knowledge_article_versions SET title=$1 WHERE id=$2', [
        '禁止修改',
        versionId,
      ]),
    ).rejects.toBeDefined();
    await expect(
      client.pool.query(
        `INSERT INTO knowledge_article_sources
         (id,article_version_id,ordinal,publisher_name,source_title,source_url,retrieved_at)
         VALUES ($1,$2,2,'新增','新增','https://source.test.invalid/two',$3)`,
        [randomUUID(), versionId, '2026-09-12T03:00:00.000Z'],
      ),
    ).rejects.toBeDefined();
    await expect(
      client.pool.query(
        'UPDATE knowledge_article_sources SET source_title=$1 WHERE article_version_id=$2',
        ['禁止修改', versionId],
      ),
    ).rejects.toBeDefined();
    await expect(
      client.pool.query('DELETE FROM knowledge_article_sources WHERE article_version_id=$1', [
        versionId,
      ]),
    ).rejects.toBeDefined();
    await client.pool.query(
      `UPDATE knowledge_article_versions
       SET publication_status='withdrawn',withdrawn_at=$1 WHERE id=$2`,
      ['2026-09-12T04:00:00.000Z', versionId],
    );
    const retired = await client.pool.query<{
      publication_status: string;
      published_at: Date | null;
      withdrawn_at: Date;
    }>(
      `SELECT publication_status,published_at,withdrawn_at
       FROM knowledge_article_versions WHERE id=$1`,
      [versionId],
    );
    expect(retired.rows[0]).toEqual(
      expect.objectContaining({ publication_status: 'withdrawn', published_at: null }),
    );
  });
});
