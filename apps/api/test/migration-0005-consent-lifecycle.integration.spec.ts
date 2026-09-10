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

const MIGRATION_0004_CREATED_AT = 1_789_038_122_994;
const MIGRATION_0005_CREATED_AT = 1_789_053_242_026;

describe('migration 0005 Consent lifecycle upgrade', () => {
  let client: ReturnType<typeof createDatabaseClient>;
  let temporaryRoot: string;
  let through0004: string;
  let through0005: string;

  beforeAll(async () => {
    const url = process.env.TEST_DATABASE_URL;
    if (!url) throw new Error('TEST_DATABASE_URL is required for migration upgrade tests');
    const databaseName = decodeURIComponent(new URL(url).pathname.slice(1));
    if (!databaseName.endsWith('_test')) {
      throw new Error('Migration upgrade tests refuse a database without an _test suffix');
    }
    client = createDatabaseClient(url);
    temporaryRoot = await mkdtemp(join(tmpdir(), 'mental-health-ai-migration-0005-'));
    through0004 = join(temporaryRoot, 'through-0004');
    through0005 = join(temporaryRoot, 'through-0005');
    await materialize(through0004, 4);
    await materialize(through0005, 5);
  });

  beforeEach(async () => {
    await client.pool.query('DROP SCHEMA IF EXISTS drizzle CASCADE');
    await client.pool.query('DROP SCHEMA public CASCADE');
    await client.pool.query('CREATE SCHEMA public');
    await migrate(client.database, { migrationsFolder: through0004 });
  });

  afterAll(async () => {
    await client.pool.end();
    await rm(temporaryRoot, { recursive: true, force: true });
  });

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

  async function insertUserAndConsent(input: {
    userId: string;
    consentId: string;
    status: 'accepted' | 'withdrawn';
    acceptedAt: Date;
    withdrawnAt: Date | null;
  }): Promise<void> {
    await client.pool.query('INSERT INTO users (id, created_at) VALUES ($1, $2)', [
      input.userId,
      new Date('2026-09-01T00:00:00.000Z'),
    ]);
    await client.pool.query(
      `INSERT INTO consents
       (id, user_id, consent_type, consent_version, status, accepted_at, withdrawn_at)
       VALUES ($1, $2, 'privacy_policy', '1.0', $3, $4, $5)`,
      [input.consentId, input.userId, input.status, input.acceptedAt, input.withdrawnAt],
    );
  }

  it('losslessly backfills accepted and withdrawn projections from a non-empty 0004 database', async () => {
    const accepted = {
      userId: randomUUID(),
      consentId: randomUUID(),
      status: 'accepted' as const,
      acceptedAt: new Date('2026-09-02T03:04:05.000Z'),
      withdrawnAt: null,
    };
    const withdrawn = {
      userId: randomUUID(),
      consentId: randomUUID(),
      status: 'withdrawn' as const,
      acceptedAt: new Date('2026-09-03T03:04:05.000Z'),
      withdrawnAt: new Date('2026-09-04T03:04:05.000Z'),
    };
    await insertUserAndConsent(accepted);
    await insertUserAndConsent(withdrawn);

    await migrate(client.database, { migrationsFolder: through0005 });

    const projections = await client.pool.query<{
      id: string;
      status: string;
      accepted_at: Date;
      withdrawn_at: Date | null;
      state_revision: number;
      effective_at: Date;
    }>(
      `SELECT id::text, status, accepted_at, withdrawn_at, state_revision, effective_at
       FROM consents ORDER BY accepted_at`,
    );
    expect(projections.rows).toEqual([
      {
        id: accepted.consentId,
        status: 'accepted',
        accepted_at: accepted.acceptedAt,
        withdrawn_at: null,
        state_revision: 1,
        effective_at: accepted.acceptedAt,
      },
      {
        id: withdrawn.consentId,
        status: 'withdrawn',
        accepted_at: withdrawn.acceptedAt,
        withdrawn_at: withdrawn.withdrawnAt,
        state_revision: 2,
        effective_at: withdrawn.withdrawnAt,
      },
    ]);

    const decisions = await client.pool.query<{
      consent_id: string;
      decision: string;
      prior_revision: number;
      resulting_revision: number;
      occurred_at: Date;
      document_key: string | null;
      document_revision: string | null;
      target_acceptance_decision_id: string | null;
      decision_source: string;
    }>(
      `SELECT consent_id::text, decision, prior_revision, resulting_revision,
              occurred_at, document_key, document_revision,
              target_acceptance_decision_id::text, decision_source
       FROM consent_decisions
       ORDER BY consent_id, resulting_revision`,
    );
    expect(decisions.rows).toHaveLength(3);
    expect(decisions.rows).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          consent_id: accepted.consentId,
          decision: 'accepted',
          prior_revision: 0,
          resulting_revision: 1,
          occurred_at: accepted.acceptedAt,
          document_key: null,
          document_revision: null,
          target_acceptance_decision_id: null,
          decision_source: 'legacy_backfill',
        }),
        expect.objectContaining({
          consent_id: withdrawn.consentId,
          decision: 'withdrawn',
          prior_revision: 1,
          resulting_revision: 2,
          occurred_at: withdrawn.withdrawnAt,
          decision_source: 'legacy_backfill',
        }),
      ]),
    );
    const withdrawal = decisions.rows.find(
      (row) => row.consent_id === withdrawn.consentId && row.decision === 'withdrawn',
    );
    expect(withdrawal?.target_acceptance_decision_id).toEqual(expect.any(String));

    const migrationState = await client.pool.query<{ count: number; maximum: string }>(
      `SELECT count(*)::int AS count, max(created_at)::text AS maximum
       FROM drizzle.__drizzle_migrations`,
    );
    expect(migrationState.rows[0]).toEqual({
      count: 6,
      maximum: String(MIGRATION_0005_CREATED_AT),
    });
  });

  it('rolls an invalid legacy backfill back without schema or journal residue', async () => {
    const userId = randomUUID();
    const consentId = randomUUID();
    await client.pool.query(
      'ALTER TABLE consents DROP CONSTRAINT consents_status_timestamps_check',
    );
    await insertUserAndConsent({
      userId,
      consentId,
      status: 'withdrawn',
      acceptedAt: new Date('2026-09-03T03:04:05.000Z'),
      withdrawnAt: null,
    });

    await expect(migrate(client.database, { migrationsFolder: through0005 })).rejects.toBeDefined();

    const columnResult = await client.pool.query<{ column_name: string }>(
      `SELECT column_name FROM information_schema.columns
       WHERE table_schema = 'public' AND table_name = 'consents'
         AND column_name IN ('state_revision', 'effective_at')`,
    );
    expect(columnResult.rows).toHaveLength(0);
    const tableResult = await client.pool.query<{ table_name: string }>(
      `SELECT table_name FROM information_schema.tables
       WHERE table_schema = 'public' AND table_name = 'consent_decisions'`,
    );
    expect(tableResult.rows).toHaveLength(0);
    const migrationState = await client.pool.query<{ count: number; maximum: string }>(
      `SELECT count(*)::int AS count, max(created_at)::text AS maximum
       FROM drizzle.__drizzle_migrations`,
    );
    expect(migrationState.rows[0]).toEqual({
      count: 5,
      maximum: String(MIGRATION_0004_CREATED_AT),
    });
  });
});
