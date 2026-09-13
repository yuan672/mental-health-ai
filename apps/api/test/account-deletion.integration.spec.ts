import { randomBytes, randomUUID } from 'node:crypto';
import {
  ageVerifications,
  aiTurns,
  auditLogs,
  conversations,
  consents,
  count,
  createDatabaseClient,
  dailyUsageQuotas,
  eq,
  humanReviewQueueItems,
  messages,
  migrate,
  moodEntries,
  passwordCredentials,
  quotaConsumptions,
  riskEvents,
  sessions,
  users,
} from '@mental-health/database';
import { type INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { resolve } from 'node:path';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import {
  ACCOUNT_DELETION_REPOSITORY_HOOKS,
  AccountDeletionRepository,
  type AccountDeletionRepositoryHooks,
} from '../src/account-deletion/account-deletion.repository';
import { AccountDeletionService } from '../src/account-deletion/account-deletion.service';
import { PasswordHasherService } from '../src/auth/password-hasher.service';
import { hashSessionToken } from '../src/auth/sessions.service';
import { AppExceptionFilter } from '../src/common/filters/app-exception.filter';
import { env } from '../src/config/env';
import { ConsentExecutionCoordinator } from '../src/consents/runtime/consent-execution.coordinator';
import { DatabaseService } from '../src/database/database.service';
import { UsersRepository } from '../src/users/users.repository';
import { InMemoryIncognitoContextStore } from '../src/ai/incognito/incognito-context.store';
import { AuditLogRepository } from '../src/safety/audit/audit-log.repository';

const WEB_ORIGIN = 'http://localhost:5173';
const VALID_PASSWORD = 'Correct-Horse-9-Battery!';

type SeededAccount = Readonly<{
  userId: string;
  sessionId: string;
  rawToken: string;
  csrfToken: string;
  cookie: string;
}>;

function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

describe('ADR-022 account deletion backend integration', () => {
  let app: INestApplication;
  let migrationClient: ReturnType<typeof createDatabaseClient>;
  let database: DatabaseService;
  let usersRepository: UsersRepository;
  let passwordHash: string;
  let repository: AccountDeletionRepository;
  let audits: AuditLogRepository;
  let hooks: AccountDeletionRepositoryHooks & {
    afterCommitted?: AccountDeletionRepositoryHooks['afterCommitted'];
    afterRequiredAuditInserted?: AccountDeletionRepositoryHooks['afterRequiredAuditInserted'];
    whileConfirmationUserLockPending?: AccountDeletionRepositoryHooks['whileConfirmationUserLockPending'];
  };

  beforeAll(async () => {
    const testDatabaseUrl = process.env.TEST_DATABASE_URL;
    if (!testDatabaseUrl) throw new Error('TEST_DATABASE_URL is required for integration tests');
    const databaseName = decodeURIComponent(new URL(testDatabaseUrl).pathname.slice(1));
    if (!databaseName.endsWith('_test')) {
      throw new Error('Integration tests refuse to reset a database without an _test suffix');
    }
    migrationClient = createDatabaseClient(testDatabaseUrl);
    await migrationClient.pool.query('DROP SCHEMA IF EXISTS drizzle CASCADE');
    await migrationClient.pool.query('DROP SCHEMA public CASCADE');
    await migrationClient.pool.query('CREATE SCHEMA public');
    await migrate(migrationClient.database, {
      migrationsFolder: resolve(process.cwd(), '../../database/migrations'),
    });

    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    app.useLogger(false);
    app.useGlobalFilters(new AppExceptionFilter());
    await app.init();
    database = moduleRef.get(DatabaseService);
    usersRepository = moduleRef.get(UsersRepository);
    repository = moduleRef.get(AccountDeletionRepository);
    audits = moduleRef.get(AuditLogRepository);
    hooks = moduleRef.get(ACCOUNT_DELETION_REPOSITORY_HOOKS);
    passwordHash = await moduleRef.get(PasswordHasherService).hash(VALID_PASSWORD);
  }, 60_000);

  beforeEach(async () => {
    await database.database.delete(humanReviewQueueItems);
    await database.database.delete(riskEvents);
    await database.database.delete(auditLogs);
    await database.database.delete(users);
  });

  afterEach(() => {
    delete hooks.afterCommitted;
    delete hooks.afterRequiredAuditInserted;
    delete hooks.whileConfirmationUserLockPending;
  });

  afterAll(async () => {
    await app.close();
    await migrationClient.pool.end();
  });

  async function seedAccount(): Promise<SeededAccount> {
    const userId = randomUUID();
    const now = new Date();
    await usersRepository.createVerifiedRegistration({
      userId,
      email: `account-delete-${randomUUID()}@example.test`,
      passwordHash,
      verificationMethod: 'synthetic-test',
      verifiedAt: now,
      consents: [
        {
          id: randomUUID(),
          decisionId: randomUUID(),
          operationId: randomUUID(),
          consentType: 'terms_of_service',
          consentVersion: '1.1',
          documentKey: 'synthetic.terms-of-service',
          documentRevision: 'test-revision-2',
          acceptedAt: now,
        },
        {
          id: randomUUID(),
          decisionId: randomUUID(),
          operationId: randomUUID(),
          consentType: 'privacy_policy',
          consentVersion: '1.1',
          documentKey: 'synthetic.privacy-policy',
          documentRevision: 'test-revision-2',
          acceptedAt: now,
        },
      ],
    });
    const rawToken = randomBytes(32).toString('base64url');
    const csrfToken = randomBytes(32).toString('base64url');
    const sessionId = randomUUID();
    await usersRepository.createSession({
      id: sessionId,
      userId,
      tokenHash: hashSessionToken(rawToken),
      expiresAt: new Date(Date.now() + 60_000),
    });
    return {
      userId,
      sessionId,
      rawToken,
      csrfToken,
      cookie: `mh_session=${rawToken}; mh_csrf=${csrfToken}`,
    };
  }

  function command(operationId = randomUUID()) {
    return {
      operationId,
      currentPassword: VALID_PASSWORD,
      acknowledgeIrreversible: true,
    };
  }

  function post(account: SeededAccount, body: ReturnType<typeof command>) {
    return request(app.getHttpServer())
      .post('/account/deletion')
      .set('Origin', WEB_ORIGIN)
      .set('Cookie', account.cookie)
      .set('x-csrf-token', account.csrfToken)
      .send(body);
  }

  it('requires authentication, trusted Origin, CSRF, strict acknowledgement and current password', async () => {
    const account = await seedAccount();
    await request(app.getHttpServer())
      .post('/account/deletion')
      .set('Origin', WEB_ORIGIN)
      .send(command())
      .expect(401);
    await request(app.getHttpServer())
      .post('/account/deletion')
      .set('Cookie', account.cookie)
      .set('x-csrf-token', account.csrfToken)
      .send(command())
      .expect(403);
    await post(account, { ...command(), acknowledgeIrreversible: false } as never).expect(400);
    const wrongPassword = await post(account, {
      ...command(),
      currentPassword: 'Wrong-Password-9!',
    }).expect(401);
    expect(wrongPassword.body.error.code).toBe('INVALID_CREDENTIALS');
    expect(
      await database.database.select().from(users).where(eq(users.id, account.userId)),
    ).toHaveLength(1);
  });

  it('atomically removes the owned account graph while retaining independent Risk and Audit data', async () => {
    const account = await seedAccount();
    const now = new Date();
    const conversationId = randomUUID();
    const userMessageId = randomUUID();
    const turnId = randomUUID();
    const riskEventId = randomUUID();
    await database.database.insert(moodEntries).values({
      id: randomUUID(),
      userId: account.userId,
      clientRequestId: randomUUID(),
      moodScore: 3,
      stateRevision: 1,
      createdAt: now,
      updatedAt: now,
    });
    await database.database.insert(dailyUsageQuotas).values({
      userId: account.userId,
      usageDate: '2026-09-13',
      dailyLimit: 20,
      usedCount: 1,
      createdAt: now,
      updatedAt: now,
    });
    await database.database.insert(quotaConsumptions).values({
      id: randomUUID(),
      userId: account.userId,
      usageDate: '2026-09-13',
      idempotencyKey: randomUUID(),
      createdAt: now,
    });
    await database.database.insert(conversations).values({
      id: conversationId,
      userId: account.userId,
      createdAt: now,
      expiresAt: new Date(now.getTime() + 60_000),
      isSaved: false,
    });
    await database.database.insert(messages).values({
      id: userMessageId,
      conversationId,
      role: 'user',
      sequenceNumber: 1,
      content: 'synthetic account lifecycle content',
      createdAt: now,
    });
    await database.database.insert(aiTurns).values({
      id: turnId,
      userId: account.userId,
      conversationId,
      clientRequestId: randomUUID(),
      status: 'completed',
      promptKey: 'supportive-chat',
      promptVersion: '1',
      userMessageId,
      leaseExpiresAt: new Date(now.getTime() + 60_000),
      createdAt: now,
      startedAt: now,
      completedAt: now,
    });
    await database.database.insert(riskEvents).values({
      id: riskEventId,
      userId: account.userId,
      conversationId,
      aiTurnId: turnId,
      triggerMessageId: userMessageId,
      clientRequestId: randomUUID(),
      isIncognito: false,
      level: 'HIGH',
      riskCategories: ['self_harm'],
      reasonCodes: ['SELF_HARM_IDEATION'],
      detectionSource: 'synthetic_test',
      policyVersion: 'synthetic-test',
      createdAt: now,
      retentionUntil: new Date(now.getTime() + 60_000),
    });
    await database.database.insert(humanReviewQueueItems).values({
      id: randomUUID(),
      riskEventId,
      priority: 'high',
      state: 'pending',
      createdAt: now,
    });
    const retainedAuditId = randomUUID();
    await database.database.insert(auditLogs).values({
      id: retainedAuditId,
      actorType: 'system',
      actorId: null,
      action: 'safety_output_blocked',
      resourceType: 'ai_turn',
      resourceId: turnId,
      idempotencyKey: `synthetic-retained:${randomUUID()}`,
      occurredAt: now,
      safeMetadata: {},
      retentionUntil: new Date(now.getTime() + 60_000),
    });

    const operationId = randomUUID();
    const response = await post(account, command(operationId)).expect(204);
    expect(response.text).toBe('');
    expect(response.headers['set-cookie']).toEqual(
      expect.arrayContaining([
        expect.stringContaining('mh_session=;'),
        expect.stringContaining('mh_csrf=;'),
      ]),
    );

    for (const table of [
      users,
      passwordCredentials,
      sessions,
      ageVerifications,
      conversations,
      messages,
      aiTurns,
      moodEntries,
      dailyUsageQuotas,
      quotaConsumptions,
    ]) {
      const [rowCount] = await database.database.select({ value: count() }).from(table);
      expect(rowCount?.value).toBe(0);
    }
    const [retainedRisk] = await database.database
      .select()
      .from(riskEvents)
      .where(eq(riskEvents.id, riskEventId));
    expect(retainedRisk).toMatchObject({
      userId: null,
      conversationId: null,
      aiTurnId: null,
      triggerMessageId: null,
    });
    expect(
      await database.database
        .select()
        .from(humanReviewQueueItems)
        .where(eq(humanReviewQueueItems.riskEventId, riskEventId)),
    ).toHaveLength(1);
    expect(
      await database.database.select().from(auditLogs).where(eq(auditLogs.id, retainedAuditId)),
    ).toHaveLength(1);
    const [deletionAudit] = await database.database
      .select()
      .from(auditLogs)
      .where(eq(auditLogs.idempotencyKey, `account-deleted:${operationId}`));
    expect(deletionAudit).toMatchObject({
      actorType: 'user',
      actorId: null,
      action: 'account_deleted',
      resourceType: 'account_deletion',
      resourceId: operationId,
      safeMetadata: { initiator: 'self_service' },
    });
  });

  it('recovers a committed deletion when acknowledgement delivery from the repository is lost', async () => {
    const account = await seedAccount();
    const operationId = randomUUID();
    hooks.afterCommitted = () => {
      throw new Error('synthetic_commit_acknowledgement_lost');
    };
    await post(account, command(operationId)).expect(204);
    expect(
      await database.database.select().from(users).where(eq(users.id, account.userId)),
    ).toHaveLength(0);
    expect(
      await database.database
        .select()
        .from(auditLogs)
        .where(eq(auditLogs.idempotencyKey, `account-deleted:${operationId}`)),
    ).toHaveLength(1);
  });

  it('rejects a pre-existing global Audit key without deleting the authenticated User', async () => {
    const account = await seedAccount();
    const operationId = randomUUID();
    const now = new Date();
    await database.database.insert(auditLogs).values({
      id: randomUUID(),
      actorType: 'system',
      actorId: null,
      action: 'account_deleted',
      resourceType: 'account_deletion',
      resourceId: operationId,
      idempotencyKey: `account-deleted:${operationId}`,
      occurredAt: now,
      safeMetadata: { initiator: 'self_service' },
      retentionUntil: new Date(now.getTime() + 60_000),
    });
    const response = await post(account, command(operationId)).expect(409);
    expect(response.body.error.code).toBe('ACCOUNT_DELETION_OPERATION_CONFLICT');
    expect(
      await database.database.select().from(users).where(eq(users.id, account.userId)),
    ).toHaveLength(1);
  });

  it('rolls back the whole transaction when the required deletion Audit cannot be inserted', async () => {
    const account = await seedAccount();
    const operationId = randomUUID();
    const append = jest
      .spyOn(audits, 'appendRequiredWithinTransaction')
      .mockRejectedValueOnce(new Error('synthetic_required_audit_failure'));
    try {
      const response = await post(account, command(operationId)).expect(500);
      expect(response.body.error.code).toBe('DATABASE_ERROR');
    } finally {
      append.mockRestore();
    }
    expect(
      await database.database.select().from(users).where(eq(users.id, account.userId)),
    ).toHaveLength(1);
    expect(
      await database.database
        .select()
        .from(auditLogs)
        .where(eq(auditLogs.idempotencyKey, `account-deleted:${operationId}`)),
    ).toHaveLength(0);
    expect(app.get(AccountDeletionService).diagnostics()).toEqual({ unresolved: 0, users: 0 });
    expect(app.get(ConsentExecutionCoordinator).accountTerminationDiagnostics()).toEqual({
      terminals: 0,
    });
  });

  it('rolls back the required Audit when deletion fails after the Audit insert', async () => {
    const account = await seedAccount();
    const operationId = randomUUID();
    hooks.afterRequiredAuditInserted = () => {
      throw new Error('synthetic_delete_statement_failure');
    };
    const response = await post(account, command(operationId)).expect(500);
    expect(response.body.error.code).toBe('DATABASE_ERROR');
    expect(
      await database.database.select().from(users).where(eq(users.id, account.userId)),
    ).toHaveLength(1);
    expect(
      await database.database
        .select()
        .from(auditLogs)
        .where(eq(auditLogs.idempotencyKey, `account-deleted:${operationId}`)),
    ).toHaveLength(0);
  });

  it('remains available when required AI Consent projections are withdrawn', async () => {
    const account = await seedAccount();
    const now = new Date();
    await database.database
      .update(consents)
      .set({ status: 'withdrawn', withdrawnAt: now, effectiveAt: now, stateRevision: 2 })
      .where(eq(consents.userId, account.userId));
    await post(account, command()).expect(204);
    expect(
      await database.database.select().from(users).where(eq(users.id, account.userId)),
    ).toHaveLength(0);
  });

  it.each(['COMMIT', 'ROLLBACK'] as const)(
    'waits on the original User serialization point before confirming %s',
    async (resolution) => {
      const account = await seedAccount();
      const operationId = randomUUID();
      const client = await migrationClient.pool.connect();
      const confirmationStarted = deferred();
      const releaseConfirmationHook = deferred();
      try {
        await client.query('BEGIN');
        await client.query('SELECT id FROM users WHERE id = $1 FOR UPDATE', [account.userId]);
        await client.query(
          `INSERT INTO audit_logs
             (id, actor_type, actor_id, action, resource_type, resource_id, idempotency_key,
              occurred_at, safe_metadata, retention_until)
           VALUES ($1, 'user', NULL, 'account_deleted', 'account_deletion', $2, $3,
                   now(), '{"initiator":"self_service"}'::jsonb, now() + interval '1 day')`,
          [randomUUID(), operationId, `account-deleted:${operationId}`],
        );
        await client.query('DELETE FROM users WHERE id = $1', [account.userId]);
        hooks.whileConfirmationUserLockPending = async () => {
          confirmationStarted.resolve(undefined);
          await releaseConfirmationHook.promise;
        };
        const confirmation = repository.confirmResult({
          userId: account.userId,
          operationId,
          ownAuditInserted: true,
          deadlineAt: new Date(Date.now() + 10_000),
        });
        await confirmationStarted.promise;
        await client.query(resolution);
        releaseConfirmationHook.resolve(undefined);
        await expect(confirmation).resolves.toEqual({
          status: resolution === 'COMMIT' ? 'committed' : 'rolled_back',
        });
      } finally {
        releaseConfirmationHook.resolve(undefined);
        await client.query('ROLLBACK').catch(() => undefined);
        client.release();
      }
    },
  );

  it('aborts bound execution, clears Incognito context and blocks late third-party dispatch', async () => {
    const account = await seedAccount();
    const coordinator = app.get(ConsentExecutionCoordinator);
    const contexts = app.get(InMemoryIncognitoContextStore);
    const pending = coordinator.registerPending({
      userId: account.userId,
      sessionId: account.sessionId,
      clientSignal: new AbortController().signal,
    });
    const execution = await coordinator.bindRequired(pending);
    const context = await coordinator.createIncognitoContext({
      userId: account.userId,
      sessionId: account.sessionId,
      sessionExpiresAt: new Date(Date.now() + 60_000),
      signal: new AbortController().signal,
      deadlineAt: new Date(Date.now() + 5_000),
    });

    await post(account, command()).expect(204);
    expect(execution.signal.aborted).toBe(true);
    expect(contexts.get(account.userId, account.sessionId, context.id)).toBeNull();
    let dispatches = 0;
    for (const kind of ['risk_classification', 'generation', 'output_classification'] as const) {
      await expect(
        coordinator.start(execution, kind, () => {
          dispatches += 1;
          return Promise.resolve('unexpected');
        }),
      ).rejects.toBeDefined();
    }
    expect(dispatches).toBe(0);
    await expect(
      coordinator.createIncognitoContext({
        userId: account.userId,
        sessionId: account.sessionId,
        sessionExpiresAt: new Date(Date.now() + 60_000),
        signal: new AbortController().signal,
        deadlineAt: new Date(Date.now() + 5_000),
      }),
    ).rejects.toBeDefined();
    expect(context.id).toEqual(expect.any(String));
    execution.dispose();
  });

  it('fails closed when the local/demo feature switch is disabled', async () => {
    const account = await seedAccount();
    const original = env.ACCOUNT_DELETION_ENABLED;
    env.ACCOUNT_DELETION_ENABLED = false;
    try {
      const response = await post(account, command()).expect(503);
      expect(response.body.error.code).toBe('ACCOUNT_DELETION_DISABLED');
    } finally {
      env.ACCOUNT_DELETION_ENABLED = original;
    }
    expect(
      await database.database.select().from(users).where(eq(users.id, account.userId)),
    ).toHaveLength(1);
  });

  it('keeps runtime terminal protection when a committed result cannot be reconciled', async () => {
    const account = await seedAccount();
    const coordinator = app.get(ConsentExecutionCoordinator);
    const accountDeletion = app.get(AccountDeletionService);
    const contexts = app.get(InMemoryIncognitoContextStore);
    const pending = coordinator.registerPending({
      userId: account.userId,
      sessionId: account.sessionId,
      clientSignal: new AbortController().signal,
    });
    const execution = await coordinator.bindRequired(pending);
    const context = await coordinator.createIncognitoContext({
      userId: account.userId,
      sessionId: account.sessionId,
      sessionExpiresAt: new Date(Date.now() + 60_000),
      signal: new AbortController().signal,
      deadlineAt: new Date(Date.now() + 5_000),
    });
    hooks.afterCommitted = () => {
      throw new Error('synthetic_commit_acknowledgement_lost');
    };
    const confirmation = jest
      .spyOn(repository, 'confirmResult')
      .mockRejectedValueOnce(new Error('synthetic_confirmation_unavailable'));
    try {
      const response = await post(account, command()).expect(503);
      expect(response.body.error.code).toBe('ACCOUNT_DELETION_RESULT_UNKNOWN');
    } finally {
      confirmation.mockRestore();
    }
    expect(
      await database.database.select().from(users).where(eq(users.id, account.userId)),
    ).toHaveLength(0);
    expect(execution.signal.aborted).toBe(true);
    expect(contexts.get(account.userId, account.sessionId, context.id)).toBeNull();
    expect(accountDeletion.diagnostics().unresolved).toBe(1);
    expect(coordinator.accountTerminationDiagnostics().terminals).toBe(1);
    let dispatches = 0;
    for (const kind of ['risk_classification', 'generation', 'output_classification'] as const) {
      await expect(
        coordinator.start(execution, kind, () => {
          dispatches += 1;
          return Promise.resolve('unexpected');
        }),
      ).rejects.toBeDefined();
    }
    expect(dispatches).toBe(0);
    execution.dispose();
  });
});
