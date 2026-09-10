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
import { DatabaseService } from '../src/database/database.service';
import { UsersRepository } from '../src/users/users.repository';

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
    { consentType: 'terms_of_service', consentVersion: '1.0', accepted: true as const },
    { consentType: 'privacy_policy', consentVersion: '1.0', accepted: true as const },
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
            version: '1.0',
            displayKey: 'consent.termsOfService',
          },
          {
            type: 'privacy_policy',
            version: '1.0',
            displayKey: 'consent.privacyPolicy',
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
            consentType: 'terms_of_service',
            consentVersion: '1.0',
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
      consentVersion: '1.0',
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
          { id: randomUUID(), ...duplicateConsent },
          { id: randomUUID(), ...duplicateConsent },
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
      .send({ consentType: 'research_optional', consentVersion: '1.0', action: 'accept' })
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
      .send({ consentType: 'research_optional', consentVersion: '1.0', action: 'accept' })
      .expect(403);
    expect(response.body.error.code).toBe('FORBIDDEN');
  });

  it('accepts and withdraws consent, then revokes logout immediately', async () => {
    const agent = request.agent(app.getHttpServer());
    const login = await agent
      .post('/auth/login')
      .set('Origin', WEB_ORIGIN)
      .send({ email: registeredEmail, password: VALID_PASSWORD })
      .expect(200);
    const setCookies = login.headers['set-cookie'] as unknown as string[];
    const csrfToken = cookieValue(setCookies, 'mh_csrf');

    const accepted = await agent
      .post('/consents')
      .set('Origin', WEB_ORIGIN)
      .set('x-csrf-token', csrfToken)
      .send({ consentType: 'research_optional', consentVersion: '1.0', action: 'accept' })
      .expect(200);
    expect(accepted.body.data.consent).toMatchObject({
      consentType: 'research_optional',
      consentVersion: '1.0',
      status: 'accepted',
      withdrawnAt: null,
    });

    const listed = await agent.get('/consents').expect(200);
    expect(listed.body.data.consents).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          consentType: 'research_optional',
          consentVersion: '1.0',
          status: 'accepted',
        }),
      ]),
    );

    const withdrawn = await agent
      .post('/consents')
      .set('Origin', WEB_ORIGIN)
      .set('x-csrf-token', csrfToken)
      .send({ consentType: 'research_optional', consentVersion: '1.0', action: 'withdraw' })
      .expect(200);
    expect(withdrawn.body.data.consent).toMatchObject({
      status: 'withdrawn',
      withdrawnAt: expect.any(String),
    });

    await agent
      .post('/consents')
      .set('Origin', WEB_ORIGIN)
      .set('x-csrf-token', csrfToken)
      .send({ consentType: 'research_optional', consentVersion: '1.0', action: 'accept' })
      .expect(409);

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
