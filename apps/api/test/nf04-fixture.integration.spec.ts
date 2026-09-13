import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { createDatabaseClient, migrate, type DatabaseClient } from '@mental-health/database';
import { nf04FixtureSecretsSchema } from '../src/nf04/nf04-contract';
import {
  loadNf04Fixture,
  NF04_FIXTURE_IDS,
  NF04_FIXTURE_VALUES,
  validateNf04Fixture,
} from '../src/nf04/nf04-fixture';
import { readNf04DatabaseIdentity } from '../src/nf04/nf04-guards';
import { readNf04MigrationHashes } from '../src/nf04/nf04-migrations';

describe('NF-04 protected synthetic fixture', () => {
  let manager: DatabaseClient;
  let target: DatabaseClient;
  let targetName: string;
  let targetUrl: string;
  let managerSystemIdentifier: string;
  let migrationHashes: readonly string[];
  const createdTargetNames: string[] = [];

  beforeAll(async () => {
    const managerUrl = process.env.TEST_DATABASE_URL;
    if (!managerUrl) throw new Error('TEST_DATABASE_URL is required');
    const managerName = decodeURIComponent(new URL(managerUrl).pathname.slice(1));
    if (!managerName.endsWith('_test')) {
      throw new Error('NF-04 integration manager must itself be a protected _test database');
    }
    manager = createDatabaseClient(managerUrl, {
      connectionTimeoutMillis: 5_000,
      queryTimeoutMillis: 10_000,
    });
    managerSystemIdentifier = (await readNf04DatabaseIdentity(manager.pool)).systemIdentifier;
    migrationHashes = await readNf04MigrationHashes(
      resolve(process.cwd(), '../../database/migrations'),
    );
  });

  beforeEach(async () => {
    targetName = `mh_nf04_fixture_${randomUUID().replaceAll('-', '').slice(0, 12)}_test`;
    assertGeneratedTarget(targetName);
    await manager.pool.query(`CREATE DATABASE ${quoteIdentifier(targetName)}`);
    createdTargetNames.push(targetName);
    const parsedTarget = new URL(process.env.TEST_DATABASE_URL!);
    parsedTarget.pathname = `/${targetName}`;
    targetUrl = parsedTarget.toString();
    target = createDatabaseClient(targetUrl, {
      connectionTimeoutMillis: 5_000,
      queryTimeoutMillis: 10_000,
    });
    await migrate(target.database, {
      migrationsFolder: resolve(process.cwd(), '../../database/migrations'),
    });
  });

  afterEach(async () => {
    await target.pool.end();
    assertGeneratedTarget(targetName);
    const currentManagerIdentity = await readNf04DatabaseIdentity(manager.pool);
    if (currentManagerIdentity.systemIdentifier !== managerSystemIdentifier) {
      throw new Error('NF-04 test server identity changed before cleanup');
    }
    await manager.pool.query(`DROP DATABASE ${quoteIdentifier(targetName)} WITH (FORCE)`);
  }, 15_000);

  afterAll(async () => {
    const remaining = await manager.pool.query<{ count: number }>(
      `SELECT count(*)::int AS count FROM pg_database
       WHERE datname = ANY($1::text[])`,
      [createdTargetNames],
    );
    expect(remaining.rows[0]?.count).toBe(0);
    await manager.pool.end();
  });

  function secrets() {
    return nf04FixtureSecretsSchema.parse({
      databaseUrl: targetUrl,
      userEmail: 'nf04-user@example.test',
      userPassword: 'Synthetic-NF04-User-Password-9!',
      sessionToken: 'nf04-synthetic-session-token-000000000001',
      staffEmail: 'nf04-staff@example.test',
      staffPassword: 'Synthetic-NF04-Staff-Password-9!',
    });
  }

  async function load(hooks?: Parameters<typeof loadNf04Fixture>[0]['hooks']) {
    const identity = await readNf04DatabaseIdentity(target.pool);
    return loadNf04Fixture({
      pool: target.pool,
      secrets: secrets(),
      appEnvironment: 'test',
      expectedDatabaseName: targetName,
      expectedDatabaseOid: identity.databaseOid,
      expectedSystemIdentifier: identity.systemIdentifier,
      expectedDatabaseRole: identity.currentUser,
      expectedMigrationHashes: migrationHashes,
      ...(hooks ? { hooks } : {}),
    });
  }

  it('migrates an empty dedicated database and loads the complete neutral relationship set', async () => {
    await expect(load()).resolves.toEqual({
      status: 'created',
      userId: NF04_FIXTURE_IDS.user,
      sessionId: NF04_FIXTURE_IDS.session,
      accountDeletionOperationId: NF04_FIXTURE_IDS.accountDeletionOperation,
    });
    await expect(validateNf04Fixture(target.pool)).resolves.toBeUndefined();

    const relationships = await target.pool.query<{
      message_count: number;
      reference_count: number;
      queue_count: number;
      quota_used: number;
      source_origin: string;
    }>(
      `SELECT
        (SELECT count(*)::int FROM messages WHERE conversation_id=$1) AS message_count,
        (SELECT count(*)::int FROM assistant_message_knowledge_references
          WHERE assistant_message_id=$2) AS reference_count,
        (SELECT count(*)::int FROM human_review_queue_items WHERE risk_event_id=$3) AS queue_count,
        (SELECT used_count FROM daily_usage_quotas WHERE user_id=$4 AND usage_date='2026-09-13') AS quota_used,
        (SELECT content_origin::text FROM knowledge_article_versions WHERE id=$5) AS source_origin`,
      [
        NF04_FIXTURE_IDS.conversation,
        NF04_FIXTURE_IDS.assistantMessage,
        NF04_FIXTURE_IDS.riskEvent,
        NF04_FIXTURE_IDS.user,
        NF04_FIXTURE_IDS.knowledgeVersion,
      ],
    );
    expect(relationships.rows).toEqual([
      {
        message_count: 2,
        reference_count: 1,
        queue_count: 1,
        quota_used: 1,
        source_origin: 'synthetic_fixture',
      },
    ]);
  });

  it('is exactly reentrant and rejects altered or conflicting existing fixture state', async () => {
    await expect(load()).resolves.toEqual(expect.objectContaining({ status: 'created' }));
    await expect(load()).resolves.toEqual(expect.objectContaining({ status: 'existing' }));
    await target.pool.query('UPDATE messages SET content=$1 WHERE id=$2', [
      'altered content',
      NF04_FIXTURE_IDS.assistantMessage,
    ]);
    await expect(load()).rejects.toThrow(/incomplete|conflicting|content/i);
    const content = await target.pool.query<{ content: string }>(
      'SELECT content FROM messages WHERE id=$1',
      [NF04_FIXTURE_IDS.assistantMessage],
    );
    expect(content.rows[0]?.content).toBe('altered content');
  });

  it('rolls back a fault after global inserts and can then load once without partial state', async () => {
    await expect(
      load({ afterGlobalRecords: () => Promise.reject(new Error('synthetic fault')) }),
    ).rejects.toThrow(/transaction failed/i);
    const footprint = await target.pool.query<{ count: number }>(
      `SELECT (
         (SELECT count(*) FROM users WHERE id=$1) +
         (SELECT count(*) FROM staff_principals WHERE id=$2) +
         (SELECT count(*) FROM knowledge_articles WHERE id=$3)
       )::int AS count`,
      [NF04_FIXTURE_IDS.user, NF04_FIXTURE_IDS.staffPrincipal, NF04_FIXTURE_IDS.knowledgeArticle],
    );
    expect(footprint.rows[0]?.count).toBe(0);
    await expect(load()).resolves.toEqual(expect.objectContaining({ status: 'created' }));
  });

  it('fails closed before mutation for a non-test environment or mismatched identity', async () => {
    const identity = await readNf04DatabaseIdentity(target.pool);
    await expect(
      loadNf04Fixture({
        pool: target.pool,
        secrets: secrets(),
        appEnvironment: 'production',
        expectedDatabaseName: targetName,
        expectedDatabaseOid: identity.databaseOid,
        expectedSystemIdentifier: identity.systemIdentifier,
        expectedDatabaseRole: identity.currentUser,
        expectedMigrationHashes: migrationHashes,
      }),
    ).rejects.toThrow(/APP_ENV=test/i);
    await expect(
      loadNf04Fixture({
        pool: target.pool,
        secrets: secrets(),
        appEnvironment: 'test',
        expectedDatabaseName: targetName,
        expectedDatabaseOid: identity.databaseOid + 1,
        expectedSystemIdentifier: identity.systemIdentifier,
        expectedDatabaseRole: identity.currentUser,
        expectedMigrationHashes: migrationHashes,
      }),
    ).rejects.toThrow(/OID/i);
    const users = await target.pool.query<{ count: number }>(
      'SELECT count(*)::int AS count FROM users',
    );
    expect(users.rows[0]?.count).toBe(0);
  });

  it('rejects a migration-history hash mismatch before any fixture mutation', async () => {
    await target.pool.query(
      `UPDATE drizzle.__drizzle_migrations SET hash=$1
       WHERE id=(SELECT min(id) FROM drizzle.__drizzle_migrations)`,
      ['0'.repeat(64)],
    );
    await expect(load()).rejects.toThrow(/migration head/i);
    const users = await target.pool.query<{ count: number }>(
      'SELECT count(*)::int AS count FROM users',
    );
    expect(users.rows[0]?.count).toBe(0);
  });

  it('contains only the reviewed neutral fixture rather than candidate or real user content', async () => {
    await load();
    const messages = await target.pool.query<{ content: string }>(
      'SELECT content FROM messages ORDER BY sequence_number',
    );
    expect(messages.rows.map((row) => row.content)).toEqual([
      NF04_FIXTURE_VALUES.conversationUserText,
      NF04_FIXTURE_VALUES.conversationAssistantText,
    ]);
    const articles = await target.pool.query<{ article_key: string; content_origin: string }>(
      `SELECT a.article_key,v.content_origin::text
       FROM knowledge_articles a JOIN knowledge_article_versions v ON v.article_id=a.id`,
    );
    expect(articles.rows).toEqual([
      {
        article_key: NF04_FIXTURE_VALUES.knowledgeArticleKey,
        content_origin: 'synthetic_fixture',
      },
    ]);
  });
});

function assertGeneratedTarget(name: string): void {
  if (!/^mh_nf04_fixture_[a-f0-9]{12}_test$/.test(name)) {
    throw new Error('Refusing to operate on a non-generated NF-04 integration database');
  }
}

function quoteIdentifier(identifier: string): string {
  assertGeneratedTarget(identifier);
  return `"${identifier}"`;
}
