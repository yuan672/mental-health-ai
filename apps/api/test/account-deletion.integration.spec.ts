import { randomBytes, randomUUID } from 'node:crypto';
import { request as createHttpRequest } from 'node:http';
import type { AddressInfo } from 'node:net';
import {
  ageVerifications,
  assistantMessageKnowledgeReferences,
  aiTurns,
  auditLogs,
  consentDecisions,
  conversations,
  consents,
  count,
  createDatabaseClient,
  dailyUsageQuotas,
  eq,
  humanReviewQueueItems,
  knowledgeArticles,
  knowledgeArticleSources,
  knowledgeArticleVersions,
  messages,
  migrate,
  moodEntries,
  passwordCredentials,
  quotaConsumptions,
  riskEvents,
  sessions,
  staffPrincipals,
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
import {
  AccountDeletionInProgressError,
  AccountDeletionOperationConflictError,
  RateLimitError,
} from '../src/common/errors';
import {
  PASSWORD_HASH_VERIFIER,
  PasswordHasherService,
  type PasswordHashVerifier,
} from '../src/auth/password-hasher.service';
import { hashSessionToken } from '../src/auth/sessions.service';
import { AppExceptionFilter } from '../src/common/filters/app-exception.filter';
import { env } from '../src/config/env';
import { ConsentExecutionCoordinator } from '../src/consents/runtime/consent-execution.coordinator';
import { DatabaseService } from '../src/database/database.service';
import { UsersRepository } from '../src/users/users.repository';
import { InMemoryIncognitoContextStore } from '../src/ai/incognito/incognito-context.store';
import { AuditLogRepository } from '../src/safety/audit/audit-log.repository';
import { CredentialWorkAdmissionService } from '../src/http-abuse/credential-work-admission.service';

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
    afterUserLocked?: AccountDeletionRepositoryHooks['afterUserLocked'];
    afterSessionValidated?: AccountDeletionRepositoryHooks['afterSessionValidated'];
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
    await app.listen(0, '127.0.0.1');
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
    delete hooks.afterUserLocked;
    delete hooks.afterSessionValidated;
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

  function command(operationId: string = randomUUID()) {
    return {
      operationId,
      currentPassword: VALID_PASSWORD,
      acknowledgeIrreversible: true as const,
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

  function socketPost(account: SeededAccount, body: ReturnType<typeof command>) {
    const address = app.getHttpServer().address() as AddressInfo;
    const serialized = JSON.stringify(body);
    const finished = deferred();
    const client = createHttpRequest({
      hostname: '127.0.0.1',
      port: address.port,
      path: '/account/deletion',
      method: 'POST',
      headers: {
        Origin: WEB_ORIGIN,
        Cookie: account.cookie,
        'x-csrf-token': account.csrfToken,
        'content-type': 'application/json',
        'content-length': Buffer.byteLength(serialized).toString(),
      },
    });
    client.once('error', () => finished.resolve(undefined));
    client.end(serialized);
    return { client, finished: finished.promise };
  }

  async function waitForCondition(check: () => Promise<boolean> | boolean): Promise<void> {
    const deadline = Date.now() + 5_000;
    while (Date.now() < deadline) {
      if (await check()) return;
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
    throw new Error('Timed out waiting for deterministic integration condition');
  }

  async function waitUntilBackendBlockedBy(lockerPid: number): Promise<void> {
    await waitForCondition(async () => {
      const result = await migrationClient.pool.query<{ blocked: boolean }>(
        `SELECT EXISTS (
           SELECT 1
           FROM pg_stat_activity
           WHERE datname = current_database()
             AND $1 = ANY(pg_blocking_pids(pid))
         ) AS blocked`,
        [lockerPid],
      );
      return result.rows[0]?.blocked === true;
    });
  }

  async function waitUntilPidBlocked(pid: number): Promise<void> {
    await waitForCondition(async () => {
      const result = await migrationClient.pool.query<{ blocked: boolean }>(
        'SELECT cardinality(pg_blocking_pids($1)) > 0 AS blocked',
        [pid],
      );
      return result.rows[0]?.blocked === true;
    });
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
    await request(app.getHttpServer())
      .post('/account/deletion')
      .set('Origin', WEB_ORIGIN)
      .set('Cookie', account.cookie)
      .set('x-csrf-token', 'synthetic-wrong-csrf')
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

  it('routes current-password verification through bounded Argon2 work admission', async () => {
    const account = await seedAccount();
    const verifier = app.get<PasswordHashVerifier>(PASSWORD_HASH_VERIFIER);
    const admission = app.get(CredentialWorkAdmissionService);
    const verify = jest.spyOn(verifier, 'verify');
    const admitted = jest.spyOn(admission, 'run');
    try {
      const response = await post(account, {
        ...command(),
        currentPassword: 'Wrong-Password-9!',
      }).expect(401);
      expect(response.body.error.code).toBe('INVALID_CREDENTIALS');
      expect(verify).toHaveBeenCalledTimes(1);
      expect(admitted).toHaveBeenCalledTimes(1);
      expect(admitted.mock.calls[0]?.[0]).toBeInstanceOf(AbortSignal);
    } finally {
      verify.mockRestore();
      admitted.mockRestore();
    }
  });

  it('atomically removes the owned account graph while retaining independent Risk and Audit data', async () => {
    const account = await seedAccount();
    const now = new Date();
    const conversationId = randomUUID();
    const userMessageId = randomUUID();
    const assistantMessageId = randomUUID();
    const turnId = randomUUID();
    const riskEventId = randomUUID();
    const knowledgeArticleId = randomUUID();
    const knowledgeVersionId = randomUUID();
    const staffPrincipalId = randomUUID();
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
    await database.database.insert(messages).values({
      id: assistantMessageId,
      conversationId,
      role: 'assistant',
      sequenceNumber: 2,
      content: 'synthetic grounded response',
      createdAt: now,
    });
    await database.database.insert(knowledgeArticles).values({
      id: knowledgeArticleId,
      articleKey: `synthetic-account-lifecycle-${randomUUID()}`,
      createdAt: now,
    });
    await database.database.insert(knowledgeArticleVersions).values({
      id: knowledgeVersionId,
      articleId: knowledgeArticleId,
      version: 1,
      title: 'Synthetic lifecycle article',
      summary: 'Synthetic lifecycle summary',
      contentBlocks: [{ type: 'paragraph', text: 'Synthetic test-only content.' }],
      draftRevision: 1,
      publicationStatus: 'draft',
      reviewStatus: 'unverified',
      contentOrigin: 'synthetic_fixture',
      createdAt: now,
    });
    await database.database.insert(knowledgeArticleSources).values({
      id: randomUUID(),
      articleVersionId: knowledgeVersionId,
      ordinal: 1,
      publisherName: 'Synthetic publisher',
      sourceTitle: 'Synthetic source',
      sourceUrl: 'https://example.test/synthetic-source',
      retrievedAt: now,
    });
    await database.database
      .update(knowledgeArticleVersions)
      .set({ publicationStatus: 'published', publishedAt: now })
      .where(eq(knowledgeArticleVersions.id, knowledgeVersionId));
    await database.database.insert(assistantMessageKnowledgeReferences).values({
      assistantMessageId,
      articleVersionId: knowledgeVersionId,
      ordinal: 1,
    });
    await database.database.insert(staffPrincipals).values({
      id: staffPrincipalId,
      status: 'active',
      authorizationRevision: 1,
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
      consents,
      consentDecisions,
      conversations,
      messages,
      assistantMessageKnowledgeReferences,
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
    expect(
      await database.database
        .select()
        .from(knowledgeArticleVersions)
        .where(eq(knowledgeArticleVersions.id, knowledgeVersionId)),
    ).toHaveLength(1);
    expect(
      await database.database
        .select()
        .from(knowledgeArticleSources)
        .where(eq(knowledgeArticleSources.articleVersionId, knowledgeVersionId)),
    ).toHaveLength(1);
    expect(
      await database.database
        .select()
        .from(staffPrincipals)
        .where(eq(staffPrincipals.id, staffPrincipalId)),
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

  it('executes one real PostgreSQL delete and required Audit for exact concurrent service calls', async () => {
    const account = await seedAccount();
    const operationId = randomUUID();
    const auditInserted = deferred();
    const releaseDelete = deferred();
    hooks.afterRequiredAuditInserted = async () => {
      auditInserted.resolve(undefined);
      await releaseDelete.promise;
    };
    const service = app.get(AccountDeletionService);
    const input = () => ({
      session: {
        id: account.sessionId,
        userId: account.userId,
        expiresAt: new Date(Date.now() + 60_000),
        revokedAt: null,
      },
      request: command(operationId),
      signal: new AbortController().signal,
      deadlineAt: new Date(Date.now() + 10_000),
    });
    const first = service.deleteCurrentAccount(input());
    const second = service.deleteCurrentAccount(input());
    try {
      await auditInserted.promise;
      expect(service.diagnostics()).toEqual({ unresolved: 1, users: 1 });
      releaseDelete.resolve(undefined);
      await expect(Promise.all([first, second])).resolves.toHaveLength(2);
    } finally {
      releaseDelete.resolve(undefined);
    }
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

  it('does not let a different operation or User borrow an active attempt', async () => {
    const owner = await seedAccount();
    const other = await seedAccount();
    const operationId = randomUUID();
    const auditInserted = deferred();
    const releaseDelete = deferred();
    hooks.afterRequiredAuditInserted = async () => {
      auditInserted.resolve(undefined);
      await releaseDelete.promise;
    };
    const service = app.get(AccountDeletionService);
    const invoke = (account: SeededAccount, requestedOperationId: string) =>
      service.deleteCurrentAccount({
        session: {
          id: account.sessionId,
          userId: account.userId,
          expiresAt: new Date(Date.now() + 60_000),
          revokedAt: null,
        },
        request: command(requestedOperationId),
        signal: new AbortController().signal,
        deadlineAt: new Date(Date.now() + 10_000),
      });
    const owning = invoke(owner, operationId);
    try {
      await auditInserted.promise;
      await expect(invoke(owner, randomUUID())).rejects.toBeInstanceOf(
        AccountDeletionInProgressError,
      );
      await expect(invoke(other, operationId)).rejects.toBeInstanceOf(
        AccountDeletionOperationConflictError,
      );
      releaseDelete.resolve(undefined);
      await expect(owning).resolves.toBeUndefined();
    } finally {
      releaseDelete.resolve(undefined);
    }
    expect(
      await database.database.select().from(users).where(eq(users.id, other.userId)),
    ).toHaveLength(1);
  });

  it('rejects capacity overflow without deleting the other User', async () => {
    const first = await seedAccount();
    const second = await seedAccount();
    const auditInserted = deferred();
    const finishMutation = deferred();
    hooks.afterRequiredAuditInserted = async () => {
      auditInserted.resolve(undefined);
      await finishMutation.promise;
    };
    const deletion = app.get(AccountDeletionService);
    const originalLimit = env.ACCOUNT_DELETION_MAX_UNRESOLVED_GLOBAL;
    env.ACCOUNT_DELETION_MAX_UNRESOLVED_GLOBAL = 1;
    const firstRun = deletion.deleteCurrentAccount({
      session: {
        id: first.sessionId,
        userId: first.userId,
        expiresAt: new Date(Date.now() + 60_000),
        revokedAt: null,
      },
      request: command(),
      signal: new AbortController().signal,
      deadlineAt: new Date(Date.now() + 5_000),
    });
    try {
      await auditInserted.promise;
      await expect(
        deletion.deleteCurrentAccount({
          session: {
            id: second.sessionId,
            userId: second.userId,
            expiresAt: new Date(Date.now() + 60_000),
            revokedAt: null,
          },
          request: command(),
          signal: new AbortController().signal,
          deadlineAt: new Date(Date.now() + 5_000),
        }),
      ).rejects.toBeInstanceOf(RateLimitError);
      expect(
        await database.database.select().from(users).where(eq(users.id, second.userId)),
      ).toHaveLength(1);
    } finally {
      finishMutation.resolve(undefined);
      env.ACCOUNT_DELETION_MAX_UNRESOLVED_GLOBAL = originalLimit;
    }
    await expect(firstRun).resolves.toBeUndefined();
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

  it('rejects a Session that expires after the early guard but before the locked final check', async () => {
    const account = await seedAccount();
    const userLocked = deferred();
    const continueFinalCheck = deferred();
    hooks.afterUserLocked = async () => {
      userLocked.resolve(undefined);
      await continueFinalCheck.promise;
    };
    const response = post(account, command())
      .expect(401)
      .then((value) => value);
    try {
      await userLocked.promise;
      await database.database
        .update(sessions)
        .set({ expiresAt: new Date(Date.now() - 1_000) })
        .where(eq(sessions.id, account.sessionId));
      continueFinalCheck.resolve(undefined);
      const result = await response;
      expect(result.body.error.code).toBe('UNAUTHENTICATED');
    } finally {
      continueFinalCheck.resolve(undefined);
    }
    expect(
      await database.database.select().from(users).where(eq(users.id, account.userId)),
    ).toHaveLength(1);
    expect(
      await database.database
        .select()
        .from(auditLogs)
        .where(eq(auditLogs.action, 'account_deleted')),
    ).toHaveLength(0);
  });

  it('lets a valid locked final Session check win before a concurrent revoke', async () => {
    const account = await seedAccount();
    const validated = deferred();
    const releaseDeletion = deferred();
    hooks.afterSessionValidated = async () => {
      validated.resolve(undefined);
      await releaseDeletion.promise;
    };
    const response = post(account, command())
      .expect(204)
      .then((value) => value);
    const logoutClient = await migrationClient.pool.connect();
    try {
      await validated.promise;
      const [backend] = (
        await logoutClient.query<{ pid: number }>('SELECT pg_backend_pid() AS pid')
      ).rows;
      if (!backend) throw new Error('Missing logout backend PID');
      const revoke = logoutClient.query('UPDATE sessions SET revoked_at = now() WHERE id = $1', [
        account.sessionId,
      ]);
      await waitUntilPidBlocked(backend.pid);
      releaseDeletion.resolve(undefined);
      await response;
      expect((await revoke).rowCount).toBe(0);
    } finally {
      releaseDeletion.resolve(undefined);
      logoutClient.release();
    }
  });

  it('returns the deletion-specific unknown result when its HTTP deadline wins after mutation start', async () => {
    const account = await seedAccount();
    const operationId = randomUUID();
    const auditInserted = deferred();
    const finishMutation = deferred();
    hooks.afterRequiredAuditInserted = async () => {
      auditInserted.resolve(undefined);
      await finishMutation.promise;
    };
    const previousTimeout = env.ACCOUNT_DELETION_TIMEOUT_MS;
    env.ACCOUNT_DELETION_TIMEOUT_MS = 1_000;
    try {
      const response = post(account, command(operationId))
        .expect(503)
        .then((value) => value);
      await auditInserted.promise;
      const result = await response;
      expect(result.body.error.code).toBe('ACCOUNT_DELETION_RESULT_UNKNOWN');
      expect(result.headers['set-cookie']).toBeUndefined();
      expect(app.get(AccountDeletionService).diagnostics()).toEqual({ unresolved: 1, users: 1 });
      expect(app.get(ConsentExecutionCoordinator).accountTerminationDiagnostics()).toEqual({
        terminals: 1,
      });
      finishMutation.resolve(undefined);
      await waitForCondition(() => app.get(AccountDeletionService).diagnostics().unresolved === 0);
      expect(
        await database.database.select().from(users).where(eq(users.id, account.userId)),
      ).toHaveLength(0);
      expect(
        await database.database
          .select()
          .from(auditLogs)
          .where(eq(auditLogs.idempotencyKey, `account-deleted:${operationId}`)),
      ).toHaveLength(1);
    } finally {
      finishMutation.resolve(undefined);
      env.ACCOUNT_DELETION_TIMEOUT_MS = previousTimeout;
    }
  });

  it('continues the one server-owned deletion after a real client socket disconnects', async () => {
    const account = await seedAccount();
    const operationId = randomUUID();
    const auditInserted = deferred();
    const finishMutation = deferred();
    hooks.afterRequiredAuditInserted = async () => {
      auditInserted.resolve(undefined);
      await finishMutation.promise;
    };
    const socket = socketPost(account, command(operationId));
    try {
      await auditInserted.promise;
      socket.client.destroy(new Error('synthetic_client_disconnect'));
      await socket.finished;
      finishMutation.resolve(undefined);
      await waitForCondition(async () => {
        const rows = await database.database
          .select()
          .from(users)
          .where(eq(users.id, account.userId));
        return rows.length === 0;
      });
      expect(
        await database.database
          .select()
          .from(auditLogs)
          .where(eq(auditLogs.idempotencyKey, `account-deleted:${operationId}`)),
      ).toHaveLength(1);
      expect(app.get(AccountDeletionService).diagnostics()).toEqual({ unresolved: 0, users: 0 });
    } finally {
      finishMutation.resolve(undefined);
      socket.client.destroy();
    }
  });

  it('does not enter lifecycle coordination when a real socket closes during password work', async () => {
    const account = await seedAccount();
    const verifier = app.get<PasswordHashVerifier>(PASSWORD_HASH_VERIFIER);
    const verificationStarted = deferred();
    const verificationCancelled = deferred();
    const verify = jest.spyOn(verifier, 'verify').mockImplementation((_hash, _password, signal) => {
      verificationStarted.resolve(undefined);
      return new Promise<boolean>((_resolve, reject) => {
        const aborted = () => {
          verificationCancelled.resolve(undefined);
          reject(signal?.reason ?? new Error('synthetic_client_disconnect'));
        };
        signal?.addEventListener('abort', aborted, { once: true });
      });
    });
    const socket = socketPost(account, command());
    try {
      await verificationStarted.promise;
      socket.client.destroy(new Error('synthetic_pre_mutation_disconnect'));
      await Promise.all([socket.finished, verificationCancelled.promise]);
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(app.get(AccountDeletionService).diagnostics()).toEqual({ unresolved: 0, users: 0 });
      expect(app.get(ConsentExecutionCoordinator).accountTerminationDiagnostics()).toEqual({
        terminals: 0,
      });
      expect(
        await database.database.select().from(users).where(eq(users.id, account.userId)),
      ).toHaveLength(1);
      expect(
        await database.database
          .select()
          .from(auditLogs)
          .where(eq(auditLogs.action, 'account_deleted')),
      ).toHaveLength(0);
    } finally {
      verify.mockRestore();
      socket.client.destroy();
    }
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
        const [locker] = (await client.query<{ pid: number }>('SELECT pg_backend_pid() AS pid'))
          .rows;
        if (!locker) throw new Error('Missing confirmation locker backend PID');
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
        await waitUntilBackendBlockedBy(locker.pid);
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

  it('bounds a real PostgreSQL confirmation lock wait and permits a fresh confirmation afterward', async () => {
    const account = await seedAccount();
    const operationId = randomUUID();
    const client = await migrationClient.pool.connect();
    try {
      const [locker] = (await client.query<{ pid: number }>('SELECT pg_backend_pid() AS pid')).rows;
      if (!locker) throw new Error('Missing confirmation-timeout locker backend PID');
      await client.query('BEGIN');
      await client.query('SELECT id FROM users WHERE id = $1 FOR UPDATE', [account.userId]);

      const confirmation = repository.confirmResult({
        userId: account.userId,
        operationId,
        ownAuditInserted: false,
        deadlineAt: new Date(Date.now() + 500),
      });
      await waitUntilBackendBlockedBy(locker.pid);
      await expect(confirmation).rejects.toBeDefined();

      await client.query('ROLLBACK');
      await expect(
        repository.confirmResult({
          userId: account.userId,
          operationId,
          ownAuditInserted: false,
          deadlineAt: new Date(Date.now() + 5_000),
        }),
      ).resolves.toEqual({ status: 'rolled_back' });
    } finally {
      await client.query('ROLLBACK').catch(() => undefined);
      client.release();
    }
  });

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
