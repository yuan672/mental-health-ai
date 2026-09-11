import { randomUUID } from 'node:crypto';
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createDatabaseClient, migrate } from '@mental-health/database';
import { ConsentDocumentRegistry } from '../src/consents/consent-document.registry';
import { ConsentLifecycleRepository } from '../src/consents/consent-lifecycle.repository';
import { ConsentPolicyService } from '../src/consents/consent-policy.service';
import { LedgerConsentAuthorizationSnapshotAdapter } from '../src/consents/runtime/consent-authorization.port';
import { DatabaseService } from '../src/database/database.service';

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
    consentVersion?: string;
  }): Promise<void> {
    await client.pool.query('INSERT INTO users (id, created_at) VALUES ($1, $2)', [
      input.userId,
      new Date('2026-09-01T00:00:00.000Z'),
    ]);
    await client.pool.query(
      `INSERT INTO consents
       (id, user_id, consent_type, consent_version, status, accepted_at, withdrawn_at)
       VALUES ($1, $2, 'privacy_policy', $3, $4, $5, $6)`,
      [
        input.consentId,
        input.userId,
        input.consentVersion ?? '1.0',
        input.status,
        input.acceptedAt,
        input.withdrawnAt,
      ],
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

  it('enforces projection ownership, applied-acceptance targets and cascade cleanup', async () => {
    const firstUserId = randomUUID();
    const secondUserId = randomUUID();
    const consentId = randomUUID();
    await insertUserAndConsent({
      userId: firstUserId,
      consentId,
      status: 'accepted',
      acceptedAt: new Date('2026-09-05T01:00:00.000Z'),
      withdrawnAt: null,
    });
    await client.pool.query('INSERT INTO users (id, created_at) VALUES ($1, $2)', [
      secondUserId,
      new Date('2026-09-05T01:00:00.000Z'),
    ]);
    await migrate(client.database, { migrationsFolder: through0005 });

    const applied = await client.pool.query<{ id: string }>(
      `SELECT id::text FROM consent_decisions
       WHERE consent_id = $1 AND decision = 'accepted' AND outcome = 'applied'`,
      [consentId],
    );
    const appliedId = applied.rows[0]?.id;
    expect(appliedId).toEqual(expect.any(String));

    await expect(
      client.pool.query(
        `INSERT INTO consent_decisions
         (id, consent_id, user_id, consent_type, consent_version, operation_id,
          decision, outcome, prior_revision, resulting_revision, occurred_at,
          document_key, document_revision, target_acceptance_decision_id, decision_source)
         VALUES ($1, $2, $3, 'privacy_policy', '1.0', $4,
                 'accepted', 'no_change', 1, 1, $5, NULL, NULL, NULL, 'legacy_backfill')`,
        [randomUUID(), consentId, secondUserId, randomUUID(), new Date()],
      ),
    ).rejects.toBeDefined();

    await expect(
      client.pool.query(
        `INSERT INTO consent_decisions
         (id, consent_id, user_id, consent_type, consent_version, operation_id,
          decision, outcome, prior_revision, resulting_revision, occurred_at,
          document_key, document_revision, target_acceptance_decision_id, decision_source)
         VALUES ($1, $2, $3, 'terms_of_service', '1.0', $4,
                 'accepted', 'no_change', 1, 1, $5, NULL, NULL, NULL, 'legacy_backfill')`,
        [randomUUID(), consentId, firstUserId, randomUUID(), new Date()],
      ),
    ).rejects.toBeDefined();

    const noChangeId = randomUUID();
    await client.pool.query(
      `INSERT INTO consent_decisions
       (id, consent_id, user_id, consent_type, consent_version, operation_id,
        decision, outcome, prior_revision, resulting_revision, occurred_at,
        document_key, document_revision, target_acceptance_decision_id, decision_source)
       VALUES ($1, $2, $3, 'privacy_policy', '1.0', $4,
               'accepted', 'no_change', 1, 1, $5, NULL, NULL, NULL, 'legacy_backfill')`,
      [noChangeId, consentId, firstUserId, randomUUID(), new Date()],
    );
    await expect(
      client.pool.query(
        `INSERT INTO consent_decisions
         (id, consent_id, user_id, consent_type, consent_version, operation_id,
          decision, outcome, prior_revision, resulting_revision, occurred_at,
          document_key, document_revision, target_acceptance_decision_id, decision_source)
         VALUES ($1, $2, $3, 'privacy_policy', '1.0', $4,
                 'withdrawn', 'applied', 1, 2, $5, NULL, NULL, $6, 'privacy_ui')`,
        [randomUUID(), consentId, firstUserId, randomUUID(), new Date(), noChangeId],
      ),
    ).rejects.toThrow(/applied acceptance/u);

    await expect(
      client.pool.query(
        `UPDATE consent_decisions SET decision_source = 'privacy_ui' WHERE id = $1`,
        [appliedId],
      ),
    ).rejects.toThrow(/append-only/u);
    const unchanged = await client.pool.query<{ decision_source: string }>(
      'SELECT decision_source FROM consent_decisions WHERE id = $1',
      [appliedId],
    );
    expect(unchanged.rows[0]?.decision_source).toBe('legacy_backfill');

    await client.pool.query('DELETE FROM users WHERE id = $1', [firstUserId]);
    const orphaned = await client.pool.query<{ count: number }>(
      'SELECT count(*)::int AS count FROM consent_decisions WHERE consent_id = $1',
      [consentId],
    );
    expect(orphaned.rows[0]?.count).toBe(0);
  });

  it('keeps unmapped legacy evidence withdrawable and restores admission through explicit document binding', async () => {
    const userId = randomUUID();
    const acceptedAt = new Date('2026-09-06T01:00:00.000Z');
    await insertUserAndConsent({
      userId,
      consentId: randomUUID(),
      status: 'accepted',
      acceptedAt,
      withdrawnAt: null,
      consentVersion: '1.1',
    });
    await client.pool.query(
      `INSERT INTO consents
       (id, user_id, consent_type, consent_version, status, accepted_at, withdrawn_at)
       VALUES ($1, $2, 'terms_of_service', '1.1', 'accepted', $3, NULL)`,
      [randomUUID(), userId, acceptedAt],
    );
    await migrate(client.database, { migrationsFolder: through0005 });

    const databaseService = { database: client.database } as unknown as DatabaseService;
    const lifecycle = new ConsentLifecycleRepository(databaseService);
    const policy = new ConsentPolicyService(new ConsentDocumentRegistry('test'));
    const authorization = new LedgerConsentAuthorizationSnapshotAdapter(policy, lifecycle);
    await expect(authorization.loadRequiredDependencies(userId)).rejects.toBeDefined();

    for (const [index, required] of policy.getRequiredPolicies().entries()) {
      const projection = await lifecycle.findProjection(
        userId,
        required.consentType,
        required.consentVersion,
      );
      expect(projection).not.toBeNull();
      const document = policy
        .getDocumentRegistry()
        .findEligible(required.consentType, required.consentVersion);
      if (!document) throw new Error('Synthetic document fixture is missing');

      let expectedRevision = projection?.stateRevision ?? -1;
      if (index === 1) {
        const withdrawal = await lifecycle.mutate(userId, {
          operationId: randomUUID(),
          action: 'withdraw',
          consentType: required.consentType,
          consentVersion: required.consentVersion,
          expectedRevision,
        });
        expect(withdrawal.receipt).toMatchObject({
          decision: 'withdrawn',
          targetDocumentKey: null,
          targetDocumentRevision: null,
        });
        expectedRevision = withdrawal.current.stateRevision;
      }

      const accepted = await lifecycle.mutate(userId, {
        operationId: randomUUID(),
        action: 'accept',
        consentType: required.consentType,
        consentVersion: required.consentVersion,
        documentKey: document.documentKey,
        documentRevision: document.documentRevision,
        expectedRevision,
      });
      expect(accepted.receipt).toMatchObject({
        decision: 'accepted',
        outcome: 'applied',
        documentKey: document.documentKey,
        documentRevision: document.documentRevision,
      });
    }

    const dependencies = await authorization.loadRequiredDependencies(userId);
    expect(dependencies).toHaveLength(2);
    expect(dependencies.map((dependency) => dependency.stateRevision).sort()).toEqual([2, 3]);
  });
});
