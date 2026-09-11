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

const MIGRATION_0007_CREATED_AT = 1_789_114_350_337;
const MIGRATION_0008_CREATED_AT = 1_789_129_853_897;

describe('migration 0008 assistant Knowledge references upgrade', () => {
  let client: ReturnType<typeof createDatabaseClient>;
  let temporaryRoot: string;
  let through0007: string;
  let through0008: string;

  beforeAll(async () => {
    const url = process.env.TEST_DATABASE_URL;
    if (!url) throw new Error('TEST_DATABASE_URL is required for migration upgrade tests');
    const databaseName = decodeURIComponent(new URL(url).pathname.slice(1));
    if (!databaseName.endsWith('_test')) {
      throw new Error('Migration upgrade tests refuse a database without an _test suffix');
    }
    client = createDatabaseClient(url);
    temporaryRoot = await mkdtemp(join(tmpdir(), 'mental-health-ai-migration-0008-'));
    through0007 = join(temporaryRoot, 'through-0007');
    through0008 = join(temporaryRoot, 'through-0008');
    await materialize(through0007, 7);
    await materialize(through0008, 8);
  });

  beforeEach(async () => {
    await resetPublicSchema();
    await migrate(client.database, { migrationsFolder: through0007 });
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

  async function insertConversationMessageFixture(role: 'user' | 'assistant'): Promise<{
    userId: string;
    conversationId: string;
    messageId: string;
  }> {
    const userId = randomUUID();
    const conversationId = randomUUID();
    const messageId = randomUUID();
    const now = new Date('2026-09-11T08:00:00.000Z');
    await client.pool.query('INSERT INTO users (id, created_at) VALUES ($1,$2)', [userId, now]);
    await client.pool.query(
      `INSERT INTO conversations
       (id,user_id,created_at,expires_at,is_saved,deleted_at)
       VALUES ($1,$2,$3,$4,false,NULL)`,
      [conversationId, userId, now, new Date('2026-12-10T08:00:00.000Z')],
    );
    await client.pool.query(
      `INSERT INTO messages
       (id,conversation_id,role,sequence_number,content,created_at)
       VALUES ($1,$2,$3,1,'synthetic message',$4)`,
      [messageId, conversationId, role, now],
    );
    return { userId, conversationId, messageId };
  }

  async function insertKnowledgeVersion(articleKey: string): Promise<string> {
    const articleId = randomUUID();
    const versionId = randomUUID();
    const now = new Date('2026-09-11T08:00:00.000Z');
    await client.pool.query(
      'INSERT INTO knowledge_articles (id,article_key,created_at) VALUES ($1,$2,$3)',
      [articleId, articleKey, now],
    );
    await client.pool.query(
      `INSERT INTO knowledge_article_versions
       (id,article_id,version,title,summary,content_blocks,publication_status,review_status,
        content_origin,reviewed_by,reviewed_at,published_at,withdrawn_at,created_at)
       VALUES ($1,$2,1,'合成标题','合成摘要',$3,'draft','unverified','synthetic_fixture',
        NULL,NULL,NULL,NULL,$4)`,
      [versionId, articleId, JSON.stringify([{ type: 'paragraph', text: '合成正文' }]), now],
    );
    return versionId;
  }

  it('applies every migration from an empty protected test database', async () => {
    await resetPublicSchema();
    await migrate(client.database, { migrationsFolder: through0008 });
    const table = await client.pool.query<{ table_name: string }>(
      `SELECT table_name FROM information_schema.tables
       WHERE table_schema='public' AND table_name='assistant_message_knowledge_references'`,
    );
    expect(table.rows).toEqual([{ table_name: 'assistant_message_knowledge_references' }]);
    const migrationState = await client.pool.query<{ count: number; maximum: string }>(
      `SELECT count(*)::int AS count,max(created_at)::text AS maximum
       FROM drizzle.__drizzle_migrations`,
    );
    expect(migrationState.rows[0]).toEqual({
      count: 9,
      maximum: String(MIGRATION_0008_CREATED_AT),
    });
  });

  it('upgrades a non-empty 0007 database without changing existing rows', async () => {
    const fixture = await insertConversationMessageFixture('assistant');
    const versionId = await insertKnowledgeVersion('synthetic-upgrade-preservation');

    await migrate(client.database, { migrationsFolder: through0008 });

    const message = await client.pool.query<{ id: string; content: string }>(
      'SELECT id::text,content FROM messages WHERE id=$1',
      [fixture.messageId],
    );
    const version = await client.pool.query<{ id: string; title: string }>(
      'SELECT id::text,title FROM knowledge_article_versions WHERE id=$1',
      [versionId],
    );
    expect(message.rows).toEqual([{ id: fixture.messageId, content: 'synthetic message' }]);
    expect(version.rows).toEqual([{ id: versionId, title: '合成标题' }]);
    const references = await client.pool.query<{ count: number }>(
      'SELECT count(*)::int AS count FROM assistant_message_knowledge_references',
    );
    expect(references.rows[0]?.count).toBe(0);
  });

  it('enforces assistant ownership, deterministic order, immutability, cascade, and restrict', async () => {
    await migrate(client.database, { migrationsFolder: through0008 });
    const assistant = await insertConversationMessageFixture('assistant');
    const user = await insertConversationMessageFixture('user');
    const firstVersionId = await insertKnowledgeVersion('synthetic-reference-first');
    const secondVersionId = await insertKnowledgeVersion('synthetic-reference-second');
    const thirdVersionId = await insertKnowledgeVersion('synthetic-reference-third');

    await expect(
      client.pool.query(
        `INSERT INTO assistant_message_knowledge_references
         (assistant_message_id,article_version_id,ordinal) VALUES ($1,$2,1)`,
        [user.messageId, firstVersionId],
      ),
    ).rejects.toBeDefined();

    await client.pool.query(
      `INSERT INTO assistant_message_knowledge_references
       (assistant_message_id,article_version_id,ordinal) VALUES ($1,$2,1),($1,$3,2)`,
      [assistant.messageId, firstVersionId, secondVersionId],
    );
    await expect(
      client.pool.query(
        `INSERT INTO assistant_message_knowledge_references
         (assistant_message_id,article_version_id,ordinal) VALUES ($1,$2,2)`,
        [assistant.messageId, thirdVersionId],
      ),
    ).rejects.toBeDefined();
    await expect(
      client.pool.query(
        `INSERT INTO assistant_message_knowledge_references
         (assistant_message_id,article_version_id,ordinal) VALUES ($1,$2,3)`,
        [assistant.messageId, thirdVersionId],
      ),
    ).rejects.toBeDefined();
    await expect(
      client.pool.query(
        `INSERT INTO assistant_message_knowledge_references
         (assistant_message_id,article_version_id,ordinal) VALUES ($1,$2,1)`,
        [assistant.messageId, firstVersionId],
      ),
    ).rejects.toBeDefined();
    await expect(
      client.pool.query(
        'UPDATE assistant_message_knowledge_references SET ordinal=2 WHERE assistant_message_id=$1 AND ordinal=1',
        [assistant.messageId],
      ),
    ).rejects.toBeDefined();
    await expect(
      client.pool.query("UPDATE messages SET role='user' WHERE id=$1", [assistant.messageId]),
    ).rejects.toBeDefined();
    await expect(
      client.pool.query('DELETE FROM knowledge_article_versions WHERE id=$1', [firstVersionId]),
    ).rejects.toBeDefined();

    const beforeDelete = await client.pool.query<{ ordinal: number; article_version_id: string }>(
      `SELECT ordinal,article_version_id::text FROM assistant_message_knowledge_references
       WHERE assistant_message_id=$1 ORDER BY ordinal`,
      [assistant.messageId],
    );
    expect(beforeDelete.rows).toEqual([
      { ordinal: 1, article_version_id: firstVersionId },
      { ordinal: 2, article_version_id: secondVersionId },
    ]);

    await client.pool.query('DELETE FROM messages WHERE id=$1', [assistant.messageId]);
    const afterDelete = await client.pool.query<{ count: number }>(
      `SELECT count(*)::int AS count FROM assistant_message_knowledge_references
       WHERE assistant_message_id=$1`,
      [assistant.messageId],
    );
    expect(afterDelete.rows[0]?.count).toBe(0);
    await expect(
      client.pool.query('DELETE FROM knowledge_article_versions WHERE id=$1', [firstVersionId]),
    ).resolves.toBeDefined();
  });

  it('fails atomically on a conflicting target table without recording 0008', async () => {
    const fixture = await insertConversationMessageFixture('assistant');
    await client.pool.query(
      'CREATE TABLE assistant_message_knowledge_references (placeholder integer NOT NULL)',
    );

    await expect(migrate(client.database, { migrationsFolder: through0008 })).rejects.toBeDefined();

    const migrationState = await client.pool.query<{ count: number; maximum: string }>(
      `SELECT count(*)::int AS count,max(created_at)::text AS maximum
       FROM drizzle.__drizzle_migrations`,
    );
    expect(migrationState.rows[0]).toEqual({
      count: 8,
      maximum: String(MIGRATION_0007_CREATED_AT),
    });
    const message = await client.pool.query<{ id: string }>(
      'SELECT id::text FROM messages WHERE id=$1',
      [fixture.messageId],
    );
    expect(message.rows).toEqual([{ id: fixture.messageId }]);
    const columns = await client.pool.query<{ column_name: string }>(
      `SELECT column_name FROM information_schema.columns
       WHERE table_schema='public' AND table_name='assistant_message_knowledge_references'`,
    );
    expect(columns.rows).toEqual([{ column_name: 'placeholder' }]);
  });
});
