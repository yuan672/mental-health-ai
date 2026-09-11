import { randomBytes, randomUUID } from 'node:crypto';
import {
  ageVerifications,
  count,
  consents,
  createDatabaseClient,
  eq,
  migrate,
  passwordCredentials,
  sessions,
  users,
} from '@mental-health/database';
import { type INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { resolve } from 'node:path';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { PasswordHasherService } from '../src/auth/password-hasher.service';
import { hashSessionToken } from '../src/auth/sessions.service';
import { AppExceptionFilter } from '../src/common/filters/app-exception.filter';
import { env } from '../src/config/env';
import { ConsentLifecycleRepository } from '../src/consents/consent-lifecycle.repository';
import { ConsentsService } from '../src/consents/consents.service';
import { DatabaseService } from '../src/database/database.service';
import { UsersRepository } from '../src/users/users.repository';
import { insertConsentFixture } from './consent-fixtures';

const WEB_ORIGIN = 'http://localhost:5173';
const VALID_PASSWORD = 'Correct-Horse-9-Battery!';

type AccountCounts = {
  users: number;
  credentials: number;
  ageVerifications: number;
  consents: number;
};

function requiredConsents() {
  return [
    {
      consentType: 'terms_of_service',
      consentVersion: '1.1',
      documentKey: 'synthetic.terms-of-service',
      documentRevision: 'test-revision-2',
      accepted: true as const,
    },
    {
      consentType: 'privacy_policy',
      consentVersion: '1.1',
      documentKey: 'synthetic.privacy-policy',
      documentRevision: 'test-revision-2',
      accepted: true as const,
    },
  ];
}

function registrationBody(email: string, evidenceToken = 'mock-adult') {
  return {
    email,
    password: VALID_PASSWORD,
    ageVerification: { evidenceToken },
    consents: requiredConsents(),
  };
}

function cookieValue(setCookies: string[], name: string): string {
  const cookie = setCookies.find((candidate) => candidate.startsWith(name + '='));
  if (!cookie) {
    throw new Error('Missing ' + name + ' cookie');
  }
  return decodeURIComponent(cookie.slice(name.length + 1).split(';')[0] ?? '');
}

describe('Phase 2A identity and access integration', () => {
  let app: INestApplication;
  let migrationClient: ReturnType<typeof createDatabaseClient>;
  let databaseService: DatabaseService;
  let consentLifecycle: ConsentLifecycleRepository;
  let consentsService: ConsentsService;
  let usersRepository: UsersRepository;
  let passwordHasher: PasswordHasherService;
  let registeredEmail: string;
  let registeredUserId: string;

  beforeAll(async () => {
    const testDatabaseUrl = process.env.TEST_DATABASE_URL;
    if (!testDatabaseUrl) {
      throw new Error('TEST_DATABASE_URL is required for integration tests');
    }

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

    databaseService = moduleRef.get(DatabaseService);
    consentLifecycle = moduleRef.get(ConsentLifecycleRepository);
    consentsService = moduleRef.get(ConsentsService);
    usersRepository = moduleRef.get(UsersRepository);
    passwordHasher = moduleRef.get(PasswordHasherService);
  }, 60_000);

  afterAll(async () => {
    await app.close();
    await migrationClient.pool.end();
  });

  async function counts(): Promise<AccountCounts> {
    const [userCount] = await databaseService.database.select({ value: count() }).from(users);
    const [credentialCount] = await databaseService.database
      .select({ value: count() })
      .from(passwordCredentials);
    const [verificationCount] = await databaseService.database
      .select({ value: count() })
      .from(ageVerifications);
    const [consentCount] = await databaseService.database.select({ value: count() }).from(consents);

    return {
      users: userCount?.value ?? -1,
      credentials: credentialCount?.value ?? -1,
      ageVerifications: verificationCount?.value ?? -1,
      consents: consentCount?.value ?? -1,
    };
  }

  it('applies every migration to an empty test database', async () => {
    const result = await migrationClient.pool.query<{ table_name: string }>(
      "select table_name from information_schema.tables where table_schema = 'public' order by table_name",
    );

    expect(result.rows.map((row) => row.table_name)).toEqual(
      expect.arrayContaining([
        'users',
        'password_credentials',
        'sessions',
        'age_verifications',
        'consents',
      ]),
    );
  });

  it('publishes only safe registration requirements and fails closed when unavailable', async () => {
    const enabled = await request(app.getHttpServer())
      .get('/auth/registration-requirements')
      .expect('Cache-Control', 'no-store')
      .expect(200);
    expect(enabled.body).toEqual({
      success: true,
      data: {
        registrationEnabled: true,
        minimumAge: 18,
        requiredConsents: [
          {
            type: 'terms_of_service',
            version: '1.1',
            displayKey: 'consent.termsOfService',
            documentKey: 'synthetic.terms-of-service',
            documentRevision: 'test-revision-2',
            documentUrl: '/consent-documents/synthetic.terms-of-service/1.1/test-revision-2.html',
          },
          {
            type: 'privacy_policy',
            version: '1.1',
            displayKey: 'consent.privacyPolicy',
            documentKey: 'synthetic.privacy-policy',
            documentRevision: 'test-revision-2',
            documentUrl: '/consent-documents/synthetic.privacy-policy/1.1/test-revision-2.html',
          },
        ],
      },
    });
    expect(JSON.stringify(enabled.body)).not.toMatch(/provider|blocker|secret|internal/iu);

    const previousProvider = env.AGE_VERIFICATION_PROVIDER;
    env.AGE_VERIFICATION_PROVIDER = 'unconfigured';
    try {
      const disabled = await request(app.getHttpServer())
        .get('/auth/registration-requirements')
        .expect(200);
      expect(disabled.body.data.registrationEnabled).toBe(false);

      const before = await counts();
      const response = await request(app.getHttpServer())
        .post('/auth/register')
        .set('Origin', WEB_ORIGIN)
        .send(registrationBody(`disabled-${randomUUID()}@example.test`))
        .expect(503);
      expect(response.body).toEqual({
        success: false,
        error: { code: 'REGISTRATION_UNAVAILABLE', message: '注册暂不可用' },
      });
      expect(await counts()).toEqual(before);
    } finally {
      env.AGE_VERIFICATION_PROVIDER = previousProvider;
    }
  });

  it('registers an age-verified adult atomically without leaking credential storage', async () => {
    registeredEmail = 'adult-' + randomUUID() + '@example.test';
    const response = await request(app.getHttpServer())
      .post('/auth/register')
      .set('Origin', WEB_ORIGIN)
      .send(registrationBody(registeredEmail))
      .expect(201);

    registeredUserId = response.body.data.user.id as string;
    expect(response.body).toMatchObject({
      success: true,
      data: {
        user: { id: expect.any(String) },
        ageVerification: { verified: true, method: 'mock' },
      },
    });
    expect(JSON.stringify(response.body)).not.toMatch(/password_hash|passwordHash/u);
    expect(await counts()).toEqual({ users: 1, credentials: 1, ageVerifications: 1, consents: 2 });
  });

  it('rejects invalid input and a weak password before persistence', async () => {
    const before = await counts();
    await request(app.getHttpServer())
      .post('/auth/register')
      .set('Origin', WEB_ORIGIN)
      .send(registrationBody('not-an-email'))
      .expect(400);
    await request(app.getHttpServer())
      .post('/auth/register')
      .set('Origin', WEB_ORIGIN)
      .send({ ...registrationBody('weak-' + randomUUID() + '@example.test'), password: 'password' })
      .expect(400);
    expect(await counts()).toEqual(before);
  });

  it('rejects stale required-consent versions without persisting an account', async () => {
    const before = await counts();
    const body = registrationBody('stale-consent-' + randomUUID() + '@example.test');
    body.consents[1] = {
      consentType: 'privacy_policy',
      consentVersion: '0.9',
      documentKey: 'synthetic.privacy-policy',
      documentRevision: 'test-revision-2',
      accepted: true,
    };

    const response = await request(app.getHttpServer())
      .post('/auth/register')
      .set('Origin', WEB_ORIGIN)
      .send(body)
      .expect(400);
    expect(response.body.error.code).toBe('CONSENT_REQUIRED');
    expect(await counts()).toEqual(before);
  });

  it.each([
    ['mock-underage', 403, 'AGE_VERIFICATION_FAILED'],
    ['mock-provider-error', 503, 'AGE_VERIFICATION_UNAVAILABLE'],
  ] as const)(
    'leaves zero account data when age verification uses %s',
    async (evidenceToken, expectedStatus, expectedCode) => {
      const before = await counts();
      const response = await request(app.getHttpServer())
        .post('/auth/register')
        .set('Origin', WEB_ORIGIN)
        .send(registrationBody(evidenceToken + '-' + randomUUID() + '@example.test', evidenceToken))
        .expect(expectedStatus);

      expect(response.body).toEqual({
        success: false,
        error: { code: expectedCode, message: expect.any(String) },
      });
      expect(await counts()).toEqual(before);
    },
  );

  it('rejects duplicate identifiers without adding any records', async () => {
    const before = await counts();
    await request(app.getHttpServer())
      .post('/auth/register')
      .set('Origin', WEB_ORIGIN)
      .send(registrationBody(registeredEmail.toUpperCase()))
      .expect(409);
    expect(await counts()).toEqual(before);
  });

  it('rolls back a user when the credential insert fails', async () => {
    const candidateUserId = randomUUID();
    const before = await counts();

    await expect(
      usersRepository.createVerifiedRegistration({
        userId: candidateUserId,
        email: registeredEmail,
        passwordHash: await passwordHasher.hash(VALID_PASSWORD),
        verificationMethod: 'mock',
        verifiedAt: new Date(),
        consents: [
          {
            id: randomUUID(),
            decisionId: randomUUID(),
            operationId: randomUUID(),
            consentType: 'terms_of_service',
            consentVersion: '1.1',
            documentKey: 'synthetic.terms-of-service',
            documentRevision: 'test-revision-2',
            acceptedAt: new Date(),
          },
        ],
      }),
    ).rejects.toBeDefined();

    expect(await counts()).toEqual(before);
    const candidate = await databaseService.database
      .select()
      .from(users)
      .where(eq(users.id, candidateUserId));
    expect(candidate).toHaveLength(0);
  });

  it('rolls back user, credential and age verification when consent insert fails', async () => {
    const candidateUserId = randomUUID();
    const before = await counts();
    const duplicateConsent = {
      consentType: 'terms_of_service',
      consentVersion: '1.1',
      acceptedAt: new Date(),
    };

    await expect(
      usersRepository.createVerifiedRegistration({
        userId: candidateUserId,
        email: 'rollback-' + randomUUID() + '@example.test',
        passwordHash: await passwordHasher.hash(VALID_PASSWORD),
        verificationMethod: 'mock',
        verifiedAt: new Date(),
        consents: [
          {
            id: randomUUID(),
            decisionId: randomUUID(),
            operationId: randomUUID(),
            documentKey: 'synthetic.terms-of-service',
            documentRevision: 'test-revision-2',
            ...duplicateConsent,
          },
          {
            id: randomUUID(),
            decisionId: randomUUID(),
            operationId: randomUUID(),
            documentKey: 'synthetic.terms-of-service',
            documentRevision: 'test-revision-2',
            ...duplicateConsent,
          },
        ],
      }),
    ).rejects.toBeDefined();

    expect(await counts()).toEqual(before);
  });

  it('uses indistinguishable responses and an Argon2 path for both login failures', async () => {
    const realVerify = jest.spyOn(passwordHasher, 'verify');
    const dummyVerify = jest.spyOn(passwordHasher, 'verifyDummy');

    const wrongPassword = await request(app.getHttpServer())
      .post('/auth/login')
      .set('Origin', WEB_ORIGIN)
      .send({ email: registeredEmail, password: 'Wrong-Password-9!' })
      .expect(401);
    const unknownAccount = await request(app.getHttpServer())
      .post('/auth/login')
      .set('Origin', WEB_ORIGIN)
      .send({
        email: 'missing-' + randomUUID() + '@example.test',
        password: 'Wrong-Password-9!',
      })
      .expect(401);

    expect(wrongPassword.body).toEqual(unknownAccount.body);
    expect(wrongPassword.body.error.code).toBe('INVALID_CREDENTIALS');
    expect(realVerify).toHaveBeenCalled();
    expect(dummyVerify).toHaveBeenCalled();
  });

  it('creates a server-side session cookie and returns no token hash', async () => {
    const response = await request(app.getHttpServer())
      .post('/auth/login')
      .set('Origin', WEB_ORIGIN)
      .send({ email: registeredEmail, password: VALID_PASSWORD })
      .expect(200);
    const setCookies = response.headers['set-cookie'] as unknown as string[];
    const rawSessionToken = cookieValue(setCookies, 'mh_session');

    expect(setCookies.find((cookie) => cookie.startsWith('mh_session='))).toMatch(
      /HttpOnly;.*SameSite=Lax/u,
    );
    expect(setCookies.find((cookie) => cookie.startsWith('mh_csrf='))).toMatch(/SameSite=Lax/u);
    expect(setCookies.find((cookie) => cookie.startsWith('mh_csrf='))).not.toContain('HttpOnly');
    expect(JSON.stringify(response.body)).not.toMatch(/tokenHash|token_hash|rawToken/u);

    const [storedSession] = await databaseService.database
      .select({ tokenHash: sessions.tokenHash })
      .from(sessions)
      .where(eq(sessions.id, response.body.data.session.id as string));
    expect(storedSession?.tokenHash).toBe(hashSessionToken(rawSessionToken));
    expect(storedSession?.tokenHash).not.toBe(rawSessionToken);

    const sessionResponse = await request(app.getHttpServer())
      .get('/auth/session')
      .set('Cookie', 'mh_session=' + rawSessionToken)
      .expect(200);
    expect(sessionResponse.body).toMatchObject({
      success: true,
      data: {
        user: { id: registeredUserId },
        session: { id: response.body.data.session.id },
      },
    });
    expect(JSON.stringify(sessionResponse.body)).not.toMatch(/tokenHash|token_hash|rawToken/u);
  });

  it('rejects an expired session with the unified authentication error', async () => {
    const rawToken = randomBytes(32).toString('base64url');
    await usersRepository.createSession({
      id: randomUUID(),
      userId: registeredUserId,
      tokenHash: hashSessionToken(rawToken),
      expiresAt: new Date(Date.now() - 1000),
    });

    const response = await request(app.getHttpServer())
      .get('/auth/session')
      .set('Cookie', 'mh_session=' + rawToken)
      .expect(401);
    expect(response.body).toMatchObject({
      success: false,
      error: { code: 'UNAUTHENTICATED' },
    });
  });

  it('requires authentication and CSRF for consent mutations', async () => {
    await request(app.getHttpServer())
      .post('/consents')
      .set('Origin', WEB_ORIGIN)
      .send({ consentType: 'terms_of_service', consentVersion: '1.1', action: 'accept' })
      .expect(401);

    const agent = request.agent(app.getHttpServer());
    await agent
      .post('/auth/login')
      .set('Origin', WEB_ORIGIN)
      .send({ email: registeredEmail, password: VALID_PASSWORD })
      .expect(200);
    const response = await agent
      .post('/consents')
      .set('Origin', WEB_ORIGIN)
      .send({ consentType: 'terms_of_service', consentVersion: '1.1', action: 'accept' })
      .expect(403);
    expect(response.body.error.code).toBe('FORBIDDEN');
  });

  it('returns a private, sanitized and stably paginated consent history', async () => {
    const agent = request.agent(app.getHttpServer());
    const login = await agent
      .post('/auth/login')
      .set('Origin', WEB_ORIGIN)
      .send({ email: registeredEmail, password: VALID_PASSWORD })
      .expect(200);
    const setCookies = login.headers['set-cookie'] as unknown as string[];
    const csrfToken = cookieValue(setCookies, 'mh_csrf');

    await insertConsentFixture(databaseService.database, {
      userId: registeredUserId,
      consentType: 'privacy_policy',
      consentVersion: '0.9',
      acceptedAt: new Date(Date.now() - 86_400_000),
      documentBound: false,
    });

    const first = await agent
      .get('/consents?limit=1')
      .expect('Cache-Control', 'private, no-store')
      .expect(200);
    expect(first.body.data.consents).toHaveLength(1);
    expect(first.body.data.nextCursor).toEqual(expect.any(String));
    expect(JSON.stringify(first.body.data.consents)).not.toMatch(/"(?:id|userId)"/u);

    const second = await agent
      .get(`/consents?limit=1&cursor=${encodeURIComponent(first.body.data.nextCursor as string)}`)
      .expect(200);
    const third = await agent
      .get(`/consents?limit=1&cursor=${encodeURIComponent(second.body.data.nextCursor as string)}`)
      .expect(200);
    expect(third.body.data.nextCursor).toBeNull();

    const history = [
      ...first.body.data.consents,
      ...second.body.data.consents,
      ...third.body.data.consents,
    ] as Array<{ consentType: string; consentVersion: string }>;
    expect(history).toHaveLength(3);
    expect(history).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ consentType: 'terms_of_service', consentVersion: '1.1' }),
        expect.objectContaining({ consentType: 'privacy_policy', consentVersion: '1.1' }),
        expect.objectContaining({ consentType: 'privacy_policy', consentVersion: '0.9' }),
      ]),
    );

    await agent.get('/consents?limit=51').expect(400);
    await agent.get('/consents?limit=1&cursor=not-a-valid-cursor').expect(400);

    const idempotentCurrentAcceptance = await agent
      .post('/consents')
      .set('Origin', WEB_ORIGIN)
      .set('x-csrf-token', csrfToken)
      .send({
        operationId: randomUUID(),
        action: 'accept',
        consentType: 'terms_of_service',
        consentVersion: '1.1',
        documentKey: 'synthetic.terms-of-service',
        documentRevision: 'test-revision-2',
        expectedRevision: 1,
      })
      .expect('Cache-Control', 'private, no-store')
      .expect(200);
    expect(idempotentCurrentAcceptance.body.data.current).toMatchObject({
      consentType: 'terms_of_service',
      consentVersion: '1.1',
      status: 'accepted',
      withdrawnAt: null,
    });
    expect(idempotentCurrentAcceptance.body.data.receipt).toMatchObject({
      action: 'accept',
      outcome: 'no_change',
      priorRevision: 1,
      resultingRevision: 1,
    });
    expect(JSON.stringify(idempotentCurrentAcceptance.body.data.current)).not.toMatch(
      /"(?:id|userId)"/u,
    );
  });

  it('accepts only current known policies while preserving historical withdrawal', async () => {
    const agent = request.agent(app.getHttpServer());
    const login = await agent
      .post('/auth/login')
      .set('Origin', WEB_ORIGIN)
      .send({ email: registeredEmail, password: VALID_PASSWORD })
      .expect(200);
    const setCookies = login.headers['set-cookie'] as unknown as string[];
    const csrfToken = cookieValue(setCookies, 'mh_csrf');

    await expect(
      consentsService.mutate(registeredUserId, {
        operationId: randomUUID(),
        action: 'accept',
        consentType: 'research_optional' as never,
        consentVersion: '1.0',
        documentKey: 'synthetic.research-optional',
        documentRevision: 'synthetic-r1',
        expectedRevision: 0,
      }),
    ).rejects.toMatchObject({ code: 'VALIDATION_ERROR', statusCode: 400 });

    await agent
      .post('/consents')
      .set('Origin', WEB_ORIGIN)
      .set('x-csrf-token', csrfToken)
      .send({ consentType: 'research_optional', consentVersion: '1.0', action: 'accept' })
      .expect(400);

    await agent
      .post('/consents')
      .set('Origin', WEB_ORIGIN)
      .set('x-csrf-token', csrfToken)
      .send({
        operationId: randomUUID(),
        action: 'accept',
        consentType: 'privacy_policy',
        consentVersion: '0.9',
        documentKey: 'synthetic.privacy-policy-legacy',
        documentRevision: 'test-revision-legacy',
        expectedRevision: 1,
      })
      .expect(409);

    const otherEmail = `consent-owner-${randomUUID()}@example.test`;
    await request(app.getHttpServer())
      .post('/auth/register')
      .set('Origin', WEB_ORIGIN)
      .send(registrationBody(otherEmail))
      .expect(201);
    const otherAgent = request.agent(app.getHttpServer());
    const otherLogin = await otherAgent
      .post('/auth/login')
      .set('Origin', WEB_ORIGIN)
      .send({ email: otherEmail, password: VALID_PASSWORD })
      .expect(200);
    const otherCsrfToken = cookieValue(
      otherLogin.headers['set-cookie'] as unknown as string[],
      'mh_csrf',
    );
    await otherAgent
      .post('/consents')
      .set('Origin', WEB_ORIGIN)
      .set('x-csrf-token', otherCsrfToken)
      .send({
        operationId: randomUUID(),
        action: 'withdraw',
        consentType: 'privacy_policy',
        consentVersion: '0.9',
        expectedRevision: 0,
      })
      .expect(409);

    const withdrawn = await agent
      .post('/consents')
      .set('Origin', WEB_ORIGIN)
      .set('x-csrf-token', csrfToken)
      .send({
        operationId: randomUUID(),
        action: 'withdraw',
        consentType: 'privacy_policy',
        consentVersion: '0.9',
        expectedRevision: 1,
      })
      .expect(200);
    expect(withdrawn.body.data.current).toMatchObject({
      consentType: 'privacy_policy',
      consentVersion: '0.9',
      status: 'withdrawn',
      withdrawnAt: expect.any(String),
    });

    await agent
      .post('/consents')
      .set('Origin', WEB_ORIGIN)
      .set('x-csrf-token', csrfToken)
      .send({
        operationId: randomUUID(),
        action: 'accept',
        consentType: 'privacy_policy',
        consentVersion: '0.9',
        documentKey: 'synthetic.privacy-policy-legacy',
        documentRevision: 'test-revision-legacy',
        expectedRevision: 2,
      })
      .expect(409);

    const repeatOperationId = randomUUID();
    const withdrawnAgain = await agent
      .post('/consents')
      .set('Origin', WEB_ORIGIN)
      .set('x-csrf-token', csrfToken)
      .send({
        operationId: repeatOperationId,
        action: 'withdraw',
        consentType: 'privacy_policy',
        consentVersion: '0.9',
        expectedRevision: 2,
      })
      .expect(200);
    expect(withdrawnAgain.body.data).toMatchObject({
      receipt: { operationId: repeatOperationId, action: 'withdraw', outcome: 'no_change' },
      current: { status: 'withdrawn', stateRevision: 2 },
    });
  });

  it('distinguishes a mutation that never entered coordination from an unknown committed result', async () => {
    const agent = request.agent(app.getHttpServer());
    const login = await agent
      .post('/auth/login')
      .set('Origin', WEB_ORIGIN)
      .send({ email: registeredEmail, password: VALID_PASSWORD })
      .expect(200);
    const csrfToken = cookieValue(login.headers['set-cookie'] as unknown as string[], 'mh_csrf');
    const operationId = randomUUID();
    const findOperation = jest
      .spyOn(consentLifecycle, 'findOperation')
      .mockRejectedValueOnce(new Error('synthetic pre-coordination database failure'));

    try {
      const response = await agent
        .post('/consents')
        .set('Origin', WEB_ORIGIN)
        .set('x-csrf-token', csrfToken)
        .send({
          operationId,
          action: 'accept',
          consentType: 'terms_of_service',
          consentVersion: '1.1',
          documentKey: 'synthetic.terms-of-service',
          documentRevision: 'test-revision-2',
          expectedRevision: 1,
        })
        .expect('Cache-Control', 'private, no-store')
        .expect(503);
      expect(response.body.error).toEqual({
        code: 'CONSENT_UNAVAILABLE',
        message: '授权服务暂时不可用，请稍后重试',
      });
    } finally {
      findOperation.mockRestore();
    }

    expect(await consentLifecycle.findOperation(registeredUserId, operationId)).toBeNull();
  });

  it('revokes logout immediately', async () => {
    const agent = request.agent(app.getHttpServer());
    const login = await agent
      .post('/auth/login')
      .set('Origin', WEB_ORIGIN)
      .send({ email: registeredEmail, password: VALID_PASSWORD })
      .expect(200);
    const setCookies = login.headers['set-cookie'] as unknown as string[];
    const csrfToken = cookieValue(setCookies, 'mh_csrf');

    await agent
      .post('/auth/logout')
      .set('Origin', WEB_ORIGIN)
      .set('x-csrf-token', csrfToken)
      .expect(200);
    await agent.get('/auth/session').expect(401);

    const [revokedSession] = await databaseService.database
      .select({ revokedAt: sessions.revokedAt })
      .from(sessions)
      .where(eq(sessions.id, login.body.data.session.id as string));
    expect(revokedSession?.revokedAt).toBeInstanceOf(Date);
  });

  it('enforces trusted origins and keeps age verification internal', async () => {
    await request(app.getHttpServer())
      .post('/auth/register')
      .send(registrationBody('origin-' + randomUUID() + '@example.test'))
      .expect(403);
    await request(app.getHttpServer())
      .post('/age-verification/verify')
      .set('Origin', WEB_ORIGIN)
      .send({ evidenceToken: 'mock-adult' })
      .expect(404);
  });
});
