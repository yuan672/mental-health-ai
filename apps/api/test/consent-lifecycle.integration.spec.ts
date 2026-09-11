import { randomUUID } from 'node:crypto';
import {
  ageVerifications,
  consentDecisions,
  consents,
  count,
  createDatabaseClient,
  eq,
  migrate,
  passwordCredentials,
  users,
} from '@mental-health/database';
import { resolve } from 'node:path';
import { ConsentDocumentRegistry } from '../src/consents/consent-document.registry';
import {
  ConsentDocumentIdentityConflictRepositoryError,
  ConsentLifecycleRepository,
  ConsentOperationConflictRepositoryError,
  ConsentStateChangedRepositoryError,
} from '../src/consents/consent-lifecycle.repository';
import { ConsentPolicyService } from '../src/consents/consent-policy.service';
import { ConsentsService } from '../src/consents/consents.service';
import type { ConsentWithdrawalCoordinator } from '../src/consents/consent-withdrawal.coordinator';
import { DatabaseService } from '../src/database/database.service';
import { UsersRepository } from '../src/users/users.repository';
import { insertConsentFixture } from './consent-fixtures';

const PRIVACY_DOCUMENT = {
  documentKey: 'synthetic.privacy-policy',
  documentRevision: 'test-revision-2',
} as const;

describe('ADR-016 Consent lifecycle persistence', () => {
  let client: ReturnType<typeof createDatabaseClient>;
  let lifecycle: ConsentLifecycleRepository;
  let usersRepository: UsersRepository;

  beforeAll(async () => {
    const url = process.env.TEST_DATABASE_URL;
    if (!url) throw new Error('TEST_DATABASE_URL is required for Consent lifecycle tests');
    const databaseName = decodeURIComponent(new URL(url).pathname.slice(1));
    if (!databaseName.endsWith('_test')) {
      throw new Error('Consent lifecycle tests refuse a database without an _test suffix');
    }
    client = createDatabaseClient(url);
    await client.pool.query('DROP SCHEMA IF EXISTS drizzle CASCADE');
    await client.pool.query('DROP SCHEMA public CASCADE');
    await client.pool.query('CREATE SCHEMA public');
    await migrate(client.database, {
      migrationsFolder: resolve(process.cwd(), '../../database/migrations'),
    });
    const databaseService = {
      database: client.database,
    } as unknown as DatabaseService;
    lifecycle = new ConsentLifecycleRepository(databaseService);
    usersRepository = new UsersRepository(databaseService);
  });

  afterAll(async () => {
    await client.pool.end();
  });

  async function createUser(): Promise<string> {
    const userId = randomUUID();
    await client.database.insert(users).values({ id: userId });
    return userId;
  }

  function acceptRequest(operationId: string, expectedRevision: number) {
    return {
      operationId,
      action: 'accept' as const,
      consentType: 'privacy_policy' as const,
      consentVersion: '1.1',
      ...PRIVACY_DOCUMENT,
      expectedRevision,
    };
  }

  async function waitUntilResolverIsBlockedBy(blockerProcessId: number): Promise<void> {
    for (let attempt = 0; attempt < 100; attempt += 1) {
      const result = await client.pool.query<{ blocked: boolean }>(
        `SELECT EXISTS (
           SELECT 1
           FROM pg_stat_activity activity
           WHERE $1 = ANY(pg_blocking_pids(activity.pid))
         ) AS blocked`,
        [blockerProcessId],
      );
      if (result.rows[0]?.blocked) return;
      await new Promise<void>((resolveImmediate) => setImmediate(resolveImmediate));
    }
    throw new Error('Consent resolution did not wait on the mutation owner-row lock');
  }

  it('keeps synthetic documents test-only and fails closed in production', () => {
    const testRegistry = new ConsentDocumentRegistry('test');
    expect(testRegistry.findEligible('privacy_policy', '1.1')).toMatchObject(PRIVACY_DOCUMENT);
    expect(
      new ConsentDocumentRegistry('development').findEligible('privacy_policy', '1.1'),
    ).not.toBeNull();
    expect(new ConsentDocumentRegistry('staging').findEligible('privacy_policy', '1.1')).toBeNull();
    expect(
      new ConsentDocumentRegistry('production').findEligible('privacy_policy', '1.1'),
    ).toBeNull();
    expect(
      new ConsentDocumentRegistry('production').findVerifiedDocument(
        'privacy_policy',
        '1.1',
        PRIVACY_DOCUMENT.documentKey,
        PRIVACY_DOCUMENT.documentRevision,
      ),
    ).toBeNull();
  });

  it('filters unavailable document identity from current, history and replay responses', async () => {
    const userId = await createUser();
    const operationId = randomUUID();
    await lifecycle.mutate(userId, acceptRequest(operationId, 0));
    const directCoordinator = {
      mutate: (_input: unknown, commit: () => Promise<unknown>) => commit(),
    } as unknown as ConsentWithdrawalCoordinator;
    const service = new ConsentsService(
      new ConsentPolicyService(new ConsentDocumentRegistry('production')),
      directCoordinator,
      lifecycle,
    );

    const listed = await service.list(userId, { limit: 20 });
    const current = listed.data.currentRequiredConsents.find(
      (item) => item.consentType === 'privacy_policy',
    );
    expect(current).toMatchObject({
      status: 'accepted',
      authorizationStatus: 'confirmation_required',
      documentKey: null,
      documentRevision: null,
      documentUrl: null,
      documentEvidenceStatus: 'unavailable',
      acceptableDocument: null,
      acceptanceEnabled: false,
    });
    expect(listed.data.consents).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          operationId,
          action: 'accept',
          documentKey: null,
          documentRevision: null,
          documentEvidenceStatus: 'unavailable',
        }),
      ]),
    );

    const replay = await service.mutate(userId, acceptRequest(operationId, 0));
    expect(replay.data.receipt).toMatchObject({
      operationId,
      action: 'accept',
      documentKey: null,
      documentRevision: null,
      documentEvidenceStatus: 'unavailable',
    });
    expect(replay.data.current).toMatchObject({
      documentKey: null,
      documentRevision: null,
      documentEvidenceStatus: 'unavailable',
      acceptableDocument: null,
    });

    const withdrawalOperationId = randomUUID();
    const withdrawal = {
      operationId: withdrawalOperationId,
      action: 'withdraw' as const,
      consentType: 'privacy_policy' as const,
      consentVersion: '1.1',
      expectedRevision: 1,
    };
    const firstWithdrawal = await service.mutate(userId, withdrawal);
    expect(firstWithdrawal.data.current).toMatchObject({ status: 'withdrawn', stateRevision: 2 });
    const withdrawalReplay = await service.mutate(userId, withdrawal);
    expect(withdrawalReplay.data.receipt).toMatchObject({
      operationId: withdrawalOperationId,
      action: 'withdraw',
      targetDocumentKey: null,
      targetDocumentRevision: null,
      targetDocumentEvidenceStatus: 'unavailable',
    });
    expect(withdrawalReplay.data.current).toMatchObject({
      status: 'withdrawn',
      stateRevision: 2,
      documentKey: null,
      documentRevision: null,
      documentEvidenceStatus: 'unavailable',
      acceptableDocument: null,
    });
  });

  it('separates current acceptable documents from historical evidence and projection revisions', async () => {
    const userId = await createUser();
    await insertConsentFixture(client.database, {
      userId,
      consentType: 'privacy_policy',
      consentVersion: '1.1',
      acceptedAt: new Date('2026-09-10T10:00:00.000Z'),
      documentBound: false,
    });
    await insertConsentFixture(client.database, {
      userId,
      consentType: 'terms_of_service',
      consentVersion: '0.9',
      status: 'withdrawn',
      acceptedAt: new Date('2026-09-09T10:00:00.000Z'),
      withdrawnAt: new Date('2026-09-09T11:00:00.000Z'),
      documentBound: false,
    });
    const directCoordinator = {
      mutate: (_input: unknown, commit: () => Promise<unknown>) => commit(),
    } as unknown as ConsentWithdrawalCoordinator;
    const service = new ConsentsService(
      new ConsentPolicyService(new ConsentDocumentRegistry('test')),
      directCoordinator,
      lifecycle,
    );

    const listed = await service.list(userId, { limit: 20 });
    const legacyCurrent = listed.data.currentRequiredConsents.find(
      (item) => item.consentType === 'privacy_policy',
    );
    expect(legacyCurrent).toMatchObject({
      status: 'accepted',
      stateRevision: 1,
      authorizationStatus: 'confirmation_required',
      documentEvidenceStatus: 'unmapped_legacy',
      documentKey: null,
      documentRevision: null,
      acceptableDocument: {
        documentKey: 'synthetic.privacy-policy',
        documentRevision: 'test-revision-2',
      },
      acceptanceEnabled: true,
      withdrawalEnabled: true,
    });
    expect(listed.data.consentStates).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          consentType: 'terms_of_service',
          consentVersion: '0.9',
          isCurrentRequired: false,
          status: 'withdrawn',
          stateRevision: 2,
          acceptableDocument: null,
          acceptanceEnabled: false,
          withdrawalEnabled: false,
        }),
      ]),
    );
  });

  it('exposes a missing current projection separately from an accepted historical version', async () => {
    const userId = await createUser();
    await insertConsentFixture(client.database, {
      userId,
      consentType: 'privacy_policy',
      consentVersion: '0.9',
      acceptedAt: new Date('2026-09-08T10:00:00.000Z'),
      documentBound: false,
    });
    const service = new ConsentsService(
      new ConsentPolicyService(new ConsentDocumentRegistry('test')),
      {} as ConsentWithdrawalCoordinator,
      lifecycle,
    );

    const listed = await service.list(userId, { limit: 20 });
    expect(listed.data.consentStates).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          consentType: 'privacy_policy',
          consentVersion: '1.1',
          isCurrentRequired: true,
          status: 'not_accepted',
          stateRevision: 0,
          documentKey: null,
          documentRevision: null,
          acceptableDocument: expect.objectContaining({
            documentKey: 'synthetic.privacy-policy',
            documentRevision: 'test-revision-2',
          }),
          acceptanceEnabled: true,
          withdrawalEnabled: false,
        }),
        expect.objectContaining({
          consentType: 'privacy_policy',
          consentVersion: '0.9',
          isCurrentRequired: false,
          status: 'accepted',
          stateRevision: 1,
          documentEvidenceStatus: 'unmapped_legacy',
          acceptableDocument: null,
          acceptanceEnabled: false,
          withdrawalEnabled: true,
        }),
      ]),
    );
  });

  it('preserves 1.0 evidence and restores eligibility only after explicit acceptance of the new 1.1 documents', async () => {
    const userId = await createUser();
    for (const consentType of ['terms_of_service', 'privacy_policy'] as const) {
      await insertConsentFixture(client.database, {
        userId,
        consentType,
        consentVersion: '1.0',
        acceptedAt: new Date('2026-09-08T10:00:00.000Z'),
        documentBound: true,
        documentRevision: 'test-revision-1',
      });
    }
    const directCoordinator = {
      mutate: (_input: unknown, commit: () => Promise<unknown>) => commit(),
    } as unknown as ConsentWithdrawalCoordinator;
    const service = new ConsentsService(
      new ConsentPolicyService(new ConsentDocumentRegistry('test')),
      directCoordinator,
      lifecycle,
    );

    const listed = await service.list(userId, { limit: 20 });
    expect(listed.data.currentRequiredConsents).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          consentVersion: '1.1',
          status: 'not_accepted',
          stateRevision: 0,
          authorizationStatus: 'inactive',
          documentEvidenceStatus: 'unavailable',
          acceptableDocument: expect.objectContaining({
            documentRevision: 'test-revision-2',
            documentUrl: expect.stringContaining('/1.1/test-revision-2.html'),
          }),
        }),
      ]),
    );
    expect(listed.data.consentStates.filter((item) => item.consentVersion === '1.0')).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          isCurrentRequired: false,
          status: 'accepted',
          authorizationStatus: 'inactive',
          documentKey: null,
          documentRevision: null,
          documentUrl: null,
          documentEvidenceStatus: 'unavailable',
          acceptableDocument: null,
        }),
      ]),
    );
    expect(listed.data.consents).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          action: 'accept',
          documentKey: null,
          documentRevision: null,
          documentEvidenceStatus: 'unavailable',
        }),
      ]),
    );

    for (const current of listed.data.currentRequiredConsents) {
      const document = current.acceptableDocument;
      if (!document) throw new Error('Current synthetic document is missing');
      await service.mutate(userId, {
        operationId: randomUUID(),
        action: 'accept',
        consentType: current.consentType,
        consentVersion: current.consentVersion,
        documentKey: document.documentKey,
        documentRevision: document.documentRevision,
        expectedRevision: current.stateRevision,
      });
    }
    await expect(service.ensureRequiredConsentsActive(userId)).resolves.toBeUndefined();
    const restored = await service.list(userId, { limit: 20 });
    expect(restored.data.currentRequiredConsents).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          consentVersion: '1.1',
          authorizationStatus: 'active',
          documentEvidenceStatus: 'verified',
        }),
      ]),
    );
  });

  it('reports each required policy availability independently when the registry is partial', async () => {
    const userId = await createUser();
    const registry = new ConsentDocumentRegistry('test', [
      {
        consentType: 'privacy_policy',
        consentVersion: '1.1',
        documentKey: 'synthetic.privacy-policy',
        documentRevision: 'test-revision-2',
        displayKey: 'consent.privacyPolicy',
        documentUrl: '/consent-documents/synthetic.privacy-policy/1.1/test-revision-2.html',
        approvalStatus: 'test_fixture',
        effectiveFrom: new Date('2026-01-01T00:00:00.000Z'),
      },
    ]);
    const service = new ConsentsService(
      new ConsentPolicyService(registry),
      {} as ConsentWithdrawalCoordinator,
      lifecycle,
    );

    const listed = await service.list(userId, { limit: 20 });
    expect(listed.data.currentRequiredConsents).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          consentType: 'terms_of_service',
          status: 'not_accepted',
          acceptableDocument: null,
          acceptanceEnabled: false,
        }),
        expect.objectContaining({
          consentType: 'privacy_policy',
          status: 'not_accepted',
          acceptableDocument: expect.objectContaining({
            documentKey: 'synthetic.privacy-policy',
            documentRevision: 'test-revision-2',
          }),
          acceptanceEnabled: true,
        }),
      ]),
    );
  });

  it('creates registration projections and immutable document-bound decisions atomically', async () => {
    const policy = new ConsentPolicyService(new ConsentDocumentRegistry('test'));
    const acceptedAt = new Date('2026-09-10T10:00:00.000Z');
    const prepared = policy.prepareRequiredConsents(
      policy.getRequiredDocuments().map((document) => {
        if (!document) throw new Error('Synthetic test document is missing');
        return {
          consentType: document.consentType,
          consentVersion: document.consentVersion,
          documentKey: document.documentKey,
          documentRevision: document.documentRevision,
          accepted: true as const,
        };
      }),
      acceptedAt,
    );
    const userId = randomUUID();
    await usersRepository.createVerifiedRegistration({
      userId,
      email: `consent-ledger-${randomUUID()}@example.test`,
      passwordHash: 'synthetic-password-hash',
      verificationMethod: 'mock',
      verifiedAt: acceptedAt,
      consents: prepared,
    });

    const projectionRows = await client.database
      .select()
      .from(consents)
      .where(eq(consents.userId, userId));
    const decisionRows = await client.database
      .select()
      .from(consentDecisions)
      .where(eq(consentDecisions.userId, userId));
    expect(projectionRows).toHaveLength(2);
    expect(projectionRows).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          status: 'accepted',
          stateRevision: 1,
          effectiveAt: acceptedAt,
        }),
      ]),
    );
    expect(decisionRows).toHaveLength(2);
    expect(decisionRows).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          decision: 'accepted',
          outcome: 'applied',
          decisionSource: 'registration',
          priorRevision: 0,
          resultingRevision: 1,
          documentKey: expect.stringMatching(/^synthetic[.]/u),
          documentRevision: 'test-revision-2',
        }),
      ]),
    );
  });

  it('rolls registration back when immutable decision evidence cannot be inserted', async () => {
    const userId = randomUUID();
    const duplicateDecisionId = randomUUID();
    const acceptedAt = new Date('2026-09-10T10:00:00.000Z');
    await expect(
      usersRepository.createVerifiedRegistration({
        userId,
        email: `consent-rollback-${randomUUID()}@example.test`,
        passwordHash: 'synthetic-password-hash',
        verificationMethod: 'mock',
        verifiedAt: acceptedAt,
        consents: [
          {
            id: randomUUID(),
            decisionId: duplicateDecisionId,
            operationId: randomUUID(),
            consentType: 'terms_of_service',
            consentVersion: '1.1',
            documentKey: 'synthetic.terms-of-service',
            documentRevision: 'test-revision-2',
            acceptedAt,
          },
          {
            id: randomUUID(),
            decisionId: duplicateDecisionId,
            operationId: randomUUID(),
            consentType: 'privacy_policy',
            consentVersion: '1.1',
            ...PRIVACY_DOCUMENT,
            acceptedAt,
          },
        ],
      }),
    ).rejects.toBeDefined();

    const [userCount] = await client.database
      .select({ value: count() })
      .from(users)
      .where(eq(users.id, userId));
    const [credentialCount] = await client.database
      .select({ value: count() })
      .from(passwordCredentials)
      .where(eq(passwordCredentials.userId, userId));
    const [ageCount] = await client.database
      .select({ value: count() })
      .from(ageVerifications)
      .where(eq(ageVerifications.userId, userId));
    const [projectionCount] = await client.database
      .select({ value: count() })
      .from(consents)
      .where(eq(consents.userId, userId));
    const [decisionCount] = await client.database
      .select({ value: count() })
      .from(consentDecisions)
      .where(eq(consentDecisions.userId, userId));
    expect([
      userCount?.value,
      credentialCount?.value,
      ageCount?.value,
      projectionCount?.value,
      decisionCount?.value,
    ]).toEqual([0, 0, 0, 0, 0]);
  });

  it('replays one operation exactly and rejects operation-id reuse with different semantics', async () => {
    const userId = await createUser();
    const operationId = randomUUID();
    const first = await lifecycle.mutate(userId, acceptRequest(operationId, 0));
    const replay = await lifecycle.mutate(userId, acceptRequest(operationId, 0));
    expect(replay.replayed).toBe(true);
    expect(replay.receipt.id).toBe(first.receipt.id);
    expect(replay.current.stateRevision).toBe(1);
    await expect(
      lifecycle.mutate(userId, { ...acceptRequest(operationId, 0), documentRevision: 'other' }),
    ).rejects.toBeInstanceOf(ConsentOperationConflictRepositoryError);
    const [decisionCount] = await client.database
      .select({ value: count() })
      .from(consentDecisions)
      .where(eq(consentDecisions.userId, userId));
    expect(decisionCount?.value).toBe(1);
  });

  it('waits for an in-progress withdrawal commit before resolving a lost acknowledgement', async () => {
    const userId = await createUser();
    const accepted = await lifecycle.mutate(userId, acceptRequest(randomUUID(), 0));
    const operationId = randomUUID();
    const occurredAt = new Date('2026-09-11T08:00:00.000Z');
    const input = {
      operationId,
      action: 'withdraw' as const,
      consentType: 'privacy_policy' as const,
      consentVersion: '1.1',
      expectedRevision: 1,
    };
    const blocker = await client.pool.connect();
    let transactionOpen = false;

    try {
      await blocker.query('BEGIN');
      transactionOpen = true;
      const blockerPid = (await blocker.query<{ pid: number }>('SELECT pg_backend_pid() AS pid'))
        .rows[0]?.pid;
      if (!blockerPid) throw new Error('Unable to identify the blocking PostgreSQL session');
      await blocker.query('SELECT id FROM users WHERE id = $1 FOR UPDATE', [userId]);
      await blocker.query(
        `UPDATE consents
         SET status = 'withdrawn', withdrawn_at = $2, state_revision = 2, effective_at = $2
         WHERE id = $1`,
        [accepted.current.id, occurredAt],
      );
      await blocker.query(
        `INSERT INTO consent_decisions (
           id, consent_id, user_id, consent_type, consent_version,
           operation_id, decision, outcome, prior_revision, resulting_revision,
           occurred_at, document_key, document_revision,
           target_acceptance_decision_id, decision_source
         ) VALUES (
           $1, $2, $3, 'privacy_policy', '1.1',
           $4, 'withdrawn', 'applied', 1, 2,
           $5, NULL, NULL, $6, 'privacy_ui'
         )`,
        [randomUUID(), accepted.current.id, userId, operationId, occurredAt, accepted.receipt.id],
      );

      const resolution = lifecycle.resolveCommittedOperation(
        userId,
        input,
        new Date(Date.now() + 5_000),
      );
      await waitUntilResolverIsBlockedBy(blockerPid);
      await blocker.query('COMMIT');
      transactionOpen = false;

      await expect(resolution).resolves.toMatchObject({
        replayed: true,
        receipt: {
          operationId,
          decision: 'withdrawn',
          targetAcceptanceDecisionId: accepted.receipt.id,
        },
        current: { status: 'withdrawn', stateRevision: 2 },
      });
    } finally {
      if (transactionOpen) await blocker.query('ROLLBACK');
      blocker.release();
    }
  });

  it('waits for an in-progress rollback before confirming that no operation committed', async () => {
    const userId = await createUser();
    const accepted = await lifecycle.mutate(userId, acceptRequest(randomUUID(), 0));
    const operationId = randomUUID();
    const occurredAt = new Date('2026-09-11T09:00:00.000Z');
    const input = {
      operationId,
      action: 'withdraw' as const,
      consentType: 'privacy_policy' as const,
      consentVersion: '1.1',
      expectedRevision: 1,
    };
    const blocker = await client.pool.connect();
    let transactionOpen = false;

    try {
      await blocker.query('BEGIN');
      transactionOpen = true;
      const blockerPid = (await blocker.query<{ pid: number }>('SELECT pg_backend_pid() AS pid'))
        .rows[0]?.pid;
      if (!blockerPid) throw new Error('Unable to identify the blocking PostgreSQL session');
      await blocker.query('SELECT id FROM users WHERE id = $1 FOR UPDATE', [userId]);
      await blocker.query(
        `UPDATE consents
         SET status = 'withdrawn', withdrawn_at = $2, state_revision = 2, effective_at = $2
         WHERE id = $1`,
        [accepted.current.id, occurredAt],
      );
      await blocker.query(
        `INSERT INTO consent_decisions (
           id, consent_id, user_id, consent_type, consent_version,
           operation_id, decision, outcome, prior_revision, resulting_revision,
           occurred_at, document_key, document_revision,
           target_acceptance_decision_id, decision_source
         ) VALUES (
           $1, $2, $3, 'privacy_policy', '1.1',
           $4, 'withdrawn', 'applied', 1, 2,
           $5, NULL, NULL, $6, 'privacy_ui'
         )`,
        [randomUUID(), accepted.current.id, userId, operationId, occurredAt, accepted.receipt.id],
      );

      const resolution = lifecycle.resolveCommittedOperation(
        userId,
        input,
        new Date(Date.now() + 5_000),
      );
      await waitUntilResolverIsBlockedBy(blockerPid);
      await blocker.query('ROLLBACK');
      transactionOpen = false;

      await expect(resolution).resolves.toBeNull();
      await expect(lifecycle.findOperation(userId, operationId)).resolves.toBeNull();
      await expect(
        lifecycle.findProjection(userId, 'privacy_policy', '1.1'),
      ).resolves.toMatchObject({ status: 'accepted', stateRevision: 1 });
    } finally {
      if (transactionOpen) await blocker.query('ROLLBACK');
      blocker.release();
    }
  });

  it('replays committed operations after state changes and rejects same-version document replacement', async () => {
    const userId = await createUser();
    const acceptanceOperationId = randomUUID();
    const accepted = await lifecycle.mutate(userId, acceptRequest(acceptanceOperationId, 0));
    await expect(
      lifecycle.mutate(userId, {
        ...acceptRequest(randomUUID(), 1),
        documentKey: 'synthetic.replacement-privacy-policy',
        documentRevision: 'replacement-revision',
      }),
    ).rejects.toBeInstanceOf(ConsentDocumentIdentityConflictRepositoryError);
    await lifecycle.mutate(userId, {
      operationId: randomUUID(),
      action: 'withdraw',
      consentType: 'privacy_policy',
      consentVersion: '1.1',
      expectedRevision: 1,
    });

    const replay = await lifecycle.mutate(userId, acceptRequest(acceptanceOperationId, 0));
    expect(replay).toMatchObject({
      replayed: true,
      receipt: { id: accepted.receipt.id },
      current: { status: 'withdrawn', stateRevision: 2 },
    });
  });

  it('serializes 20 concurrent identical first submissions into one receipt', async () => {
    const userId = await createUser();
    const operationId = randomUUID();
    const results = await Promise.all(
      Array.from({ length: 20 }, () => lifecycle.mutate(userId, acceptRequest(operationId, 0))),
    );
    expect(new Set(results.map((result) => result.receipt.id)).size).toBe(1);
    expect(results.filter((result) => !result.replayed)).toHaveLength(1);
    const [decisionCount] = await client.database
      .select({ value: count() })
      .from(consentDecisions)
      .where(eq(consentDecisions.userId, userId));
    expect(decisionCount?.value).toBe(1);
  });

  it('allows only one different operation from the same expected revision', async () => {
    const userId = await createUser();
    const attempts = await Promise.allSettled([
      lifecycle.mutate(userId, acceptRequest(randomUUID(), 0)),
      lifecycle.mutate(userId, acceptRequest(randomUUID(), 0)),
    ]);
    expect(attempts.filter((attempt) => attempt.status === 'fulfilled')).toHaveLength(1);
    const rejected = attempts.find((attempt) => attempt.status === 'rejected');
    expect(rejected).toMatchObject({
      status: 'rejected',
      reason: expect.any(ConsentStateChangedRepositoryError),
    });
  });

  it('preserves withdraw, same-version reaccept, no-change receipts and ordered evidence', async () => {
    const userId = await createUser();
    await lifecycle.mutate(userId, acceptRequest(randomUUID(), 0));
    const withdrawal = await lifecycle.mutate(userId, {
      operationId: randomUUID(),
      action: 'withdraw',
      consentType: 'privacy_policy',
      consentVersion: '1.1',
      expectedRevision: 1,
    });
    expect(withdrawal.receipt).toMatchObject({
      decision: 'withdrawn',
      outcome: 'applied',
      priorRevision: 1,
      resultingRevision: 2,
      targetDocumentKey: PRIVACY_DOCUMENT.documentKey,
    });
    const reaccepted = await lifecycle.mutate(userId, acceptRequest(randomUUID(), 2));
    expect(reaccepted.current).toMatchObject({ status: 'accepted', stateRevision: 3 });
    const noChange = await lifecycle.mutate(userId, acceptRequest(randomUUID(), 3));
    expect(noChange.receipt).toMatchObject({
      decision: 'accepted',
      outcome: 'no_change',
      priorRevision: 3,
      resultingRevision: 3,
    });
    const secondWithdrawal = await lifecycle.mutate(userId, {
      operationId: randomUUID(),
      action: 'withdraw',
      consentType: 'privacy_policy',
      consentVersion: '1.1',
      expectedRevision: 3,
    });
    expect(secondWithdrawal.receipt.targetAcceptanceDecisionId).toBe(reaccepted.receipt.id);
    expect(secondWithdrawal.receipt.targetAcceptanceDecisionId).not.toBe(noChange.receipt.id);
    const history = await lifecycle.listDecisionHistoryPage(
      userId,
      ['terms_of_service', 'privacy_policy'],
      10,
      null,
    );
    expect(history).toHaveLength(5);
    expect(
      history.filter((item) => item.outcome === 'applied').map((item) => item.resultingRevision),
    ).toEqual(expect.arrayContaining([1, 2, 3]));
  });

  it('keeps operation and projection ownership isolated between users', async () => {
    const firstUser = await createUser();
    const secondUser = await createUser();
    const sharedOperationId = randomUUID();
    const [first, second] = await Promise.all([
      lifecycle.mutate(firstUser, acceptRequest(sharedOperationId, 0)),
      lifecycle.mutate(secondUser, acceptRequest(sharedOperationId, 0)),
    ]);
    expect(first.receipt.id).not.toBe(second.receipt.id);
    expect(await lifecycle.findOperation(firstUser, sharedOperationId)).toMatchObject({
      userId: firstUser,
    });
    expect(await lifecycle.findOperation(secondUser, sharedOperationId)).toMatchObject({
      userId: secondUser,
    });
  });
});
