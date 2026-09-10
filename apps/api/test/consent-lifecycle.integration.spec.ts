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
import { DatabaseService } from '../src/database/database.service';
import { UsersRepository } from '../src/users/users.repository';

const PRIVACY_DOCUMENT = {
  documentKey: 'synthetic.privacy-policy',
  documentRevision: 'test-revision-1',
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
      consentVersion: '1.0',
      ...PRIVACY_DOCUMENT,
      expectedRevision,
    };
  }

  it('keeps synthetic documents test-only and fails closed in production', () => {
    const testRegistry = new ConsentDocumentRegistry('test');
    expect(testRegistry.findEligible('privacy_policy', '1.0')).toMatchObject(PRIVACY_DOCUMENT);
    expect(
      new ConsentDocumentRegistry('development').findEligible('privacy_policy', '1.0'),
    ).not.toBeNull();
    expect(new ConsentDocumentRegistry('staging').findEligible('privacy_policy', '1.0')).toBeNull();
    expect(
      new ConsentDocumentRegistry('production').findEligible('privacy_policy', '1.0'),
    ).toBeNull();
    expect(
      new ConsentDocumentRegistry('production').findVerifiedDocument(
        'privacy_policy',
        '1.0',
        PRIVACY_DOCUMENT.documentKey,
        PRIVACY_DOCUMENT.documentRevision,
      ),
    ).toBeNull();
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
          documentRevision: 'test-revision-1',
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
            consentVersion: '1.0',
            documentKey: 'synthetic.terms-of-service',
            documentRevision: 'test-revision-1',
            acceptedAt,
          },
          {
            id: randomUUID(),
            decisionId: duplicateDecisionId,
            operationId: randomUUID(),
            consentType: 'privacy_policy',
            consentVersion: '1.0',
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
      consentVersion: '1.0',
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
      consentVersion: '1.0',
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
      consentVersion: '1.0',
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
