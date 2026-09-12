import { randomUUID } from 'node:crypto';
import {
  auditLogs,
  count,
  createDatabaseClient,
  eq,
  migrate,
  staffPasswordCredentials,
  staffRoleGrants,
  humanReviewQueueItems,
  riskEvents,
} from '@mental-health/database';
import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { resolve } from 'node:path';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { DatabaseStaffSafetyReviewerAuthorizer } from '../src/admin/staff-safety-reviewer-authorizer';
import { StaffAccessService } from '../src/admin/staff-access.service';
import { StaffAuthService } from '../src/admin/staff-auth.service';
import { StaffBootstrapService } from '../src/admin/staff-bootstrap.service';
import {
  AuthenticationError,
  AuthorizationError,
  ConflictError,
  DatabaseError,
} from '../src/common/errors';
import { AppExceptionFilter } from '../src/common/filters/app-exception.filter';
import { env } from '../src/config/env';
import { DatabaseService } from '../src/database/database.service';
import { AuditLogRepository } from '../src/safety/audit/audit-log.repository';
import { HumanReviewQueueService } from '../src/safety/review/human-review-queue.service';

const ADMIN_ORIGIN = 'http://localhost:5174';
const PASSWORD = 'Synthetic-Staff-Password-9!';

function cookieValue(setCookies: string[], name: string): string {
  const cookie = setCookies.find((value) => value.startsWith(`${name}=`));
  if (!cookie) throw new Error(`Missing cookie ${name}`);
  return decodeURIComponent(cookie.slice(name.length + 1).split(';')[0] ?? '');
}

describe('Admin identity and least-privilege backend', () => {
  let app: INestApplication;
  let migrationClient: ReturnType<typeof createDatabaseClient>;
  let database: DatabaseService;
  let bootstrap: StaffBootstrapService;
  let auth: StaffAuthService;
  let access: StaffAccessService;
  let reviewer: DatabaseStaffSafetyReviewerAuthorizer;
  let audits: AuditLogRepository;
  let reviewQueue: HumanReviewQueueService;
  let adminId: string;
  let adminEmail: string;
  let adminSession: Awaited<ReturnType<StaffAuthService['login']>>;
  let bootstrapResults: PromiseSettledResult<
    Awaited<ReturnType<StaffBootstrapService['bootstrap']>>
  >[];

  async function waitForLockWaiters(fragment: string, minimum: number): Promise<void> {
    const deadline = Date.now() + 10_000;
    while (Date.now() < deadline) {
      const result = await migrationClient.pool.query<{ count: number }>(
        `SELECT count(*)::int AS count FROM pg_stat_activity
         WHERE pid <> pg_backend_pid() AND wait_event_type='Lock' AND query ILIKE $1`,
        [`%${fragment}%`],
      );
      if ((result.rows[0]?.count ?? 0) >= minimum) return;
      await new Promise<void>((resolveTick) => setImmediate(resolveTick));
    }
    throw new Error(`Timed out waiting for ${minimum} database lock waiters`);
  }

  beforeAll(async () => {
    const url = process.env.TEST_DATABASE_URL;
    if (!url) throw new Error('TEST_DATABASE_URL is required');
    const name = decodeURIComponent(new URL(url).pathname.slice(1));
    if (!name.endsWith('_test')) throw new Error('Refusing non-test database');
    migrationClient = createDatabaseClient(url);
    await migrationClient.pool.query('DROP SCHEMA IF EXISTS drizzle CASCADE');
    await migrationClient.pool.query('DROP SCHEMA public CASCADE');
    await migrationClient.pool.query('CREATE SCHEMA public');
    await migrate(migrationClient.database, {
      migrationsFolder: resolve(process.cwd(), '../../database/migrations'),
    });
    env.ADMIN_AUTH_ENABLED = true;
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    app.useLogger(false);
    app.useGlobalFilters(new AppExceptionFilter());
    await app.init();
    database = moduleRef.get(DatabaseService);
    bootstrap = moduleRef.get(StaffBootstrapService);
    auth = moduleRef.get(StaffAuthService);
    access = moduleRef.get(StaffAccessService);
    reviewer = moduleRef.get(DatabaseStaffSafetyReviewerAuthorizer);
    audits = moduleRef.get(AuditLogRepository);
    reviewQueue = moduleRef.get(HumanReviewQueueService);
    const firstId = randomUUID();
    const secondId = randomUUID();
    const bootstrapBlocker = await migrationClient.pool.connect();
    await bootstrapBlocker.query('BEGIN');
    await bootstrapBlocker.query('SELECT pg_advisory_xact_lock(771420020)');
    const bootstrapAttempts = [
      bootstrap.bootstrap({
        staffPrincipalId: firstId,
        email: 'root-a@example.test',
        password: PASSWORD,
      }),
      bootstrap.bootstrap({
        staffPrincipalId: secondId,
        email: 'root-b@example.test',
        password: PASSWORD,
      }),
    ];
    await waitForLockWaiters('pg_advisory_xact_lock', 2);
    await bootstrapBlocker.query('COMMIT');
    bootstrapBlocker.release();
    bootstrapResults = await Promise.allSettled(bootstrapAttempts);
    const winner = bootstrapResults.find(
      (
        result,
      ): result is PromiseFulfilledResult<
        Awaited<ReturnType<StaffBootstrapService['bootstrap']>>
      > => result.status === 'fulfilled',
    );
    if (!winner) throw new Error('Expected one bootstrap winner');
    adminId = winner.value.id;
    adminEmail = winner.value.email;
    adminSession = await auth.login(adminEmail, PASSWORD);
  }, 90_000);

  afterAll(async () => {
    env.ADMIN_AUTH_ENABLED = false;
    await app.close();
    await migrationClient.pool.end();
  });

  it('keeps ordinary and forged identities outside the staff security domain', async () => {
    await request(app.getHttpServer())
      .get('/admin/auth/session')
      .set('Cookie', 'mh_session=ordinary-session')
      .expect(401);
    await expect(reviewer.authorize({ id: adminId }, 'risk_event:read')).rejects.toBeInstanceOf(
      AuthorizationError,
    );
    await expect(
      reviewer.authorize(
        { id: adminId, sessionId: randomUUID(), authorizationRevision: 1 },
        'risk_event:read',
      ),
    ).rejects.toBeInstanceOf(AuthorizationError);
    await expect(reviewer.authorize(adminSession, 'risk_event:read')).rejects.toBeInstanceOf(
      AuthorizationError,
    );
  });

  it('uses separate strict cookies, trusted origin, CSRF, and indistinguishable login failures', async () => {
    const unknown = await request(app.getHttpServer())
      .post('/admin/auth/login')
      .set('Origin', ADMIN_ORIGIN)
      .send({ email: 'unknown@example.test', password: 'wrong' })
      .expect(401);
    const wrong = await request(app.getHttpServer())
      .post('/admin/auth/login')
      .set('Origin', ADMIN_ORIGIN)
      .send({ email: adminEmail, password: 'wrong' })
      .expect(401);
    expect(unknown.body).toEqual(wrong.body);

    const response = await request(app.getHttpServer())
      .post('/admin/auth/login')
      .set('Origin', ADMIN_ORIGIN)
      .send({ email: adminEmail.toUpperCase(), password: PASSWORD })
      .expect('Cache-Control', 'private, no-store')
      .expect(200);
    const cookies = response.headers['set-cookie'] as unknown as string[];
    expect(cookies.join('\n')).toContain('mh_staff_session=');
    expect(cookies.join('\n')).toContain('mh_staff_csrf=');
    expect(cookies.join('\n')).toContain('SameSite=Strict');
    expect(cookies.join('\n')).toContain('Path=/admin');

    const staffSession = cookieValue(cookies, 'mh_staff_session');
    await request(app.getHttpServer())
      .post(`/admin/staff-principals/${adminId}/revoke-sessions`)
      .set('Origin', ADMIN_ORIGIN)
      .set('Cookie', `mh_staff_session=${staffSession}`)
      .send({ expectedAuthorizationRevision: 1 })
      .expect(403);
  });

  it('keeps the one-time bootstrap invariant after committed initialization', async () => {
    expect(bootstrapResults.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    expect(bootstrapResults.filter((result) => result.status === 'rejected')).toHaveLength(1);
    expect(bootstrapResults.find((result) => result.status === 'rejected')).toMatchObject({
      reason: expect.any(ConflictError),
    });
    const [bootstrapCount] = await database.database
      .select({ value: count() })
      .from(staffRoleGrants)
      .where(eq(staffRoleGrants.grantSource, 'bootstrap'));
    expect(bootstrapCount?.value).toBe(1);
  });

  it('creates staff idempotently without overwriting credentials and audits atomically', async () => {
    const id = randomUUID();
    const input = {
      staffPrincipalId: id,
      email: 'reviewer@example.test',
      initialPassword: PASSWORD,
    };
    const [first, second] = await Promise.all([
      access.create(adminSession, input),
      access.create(adminSession, input),
    ]);
    expect([first.outcome, second.outcome].sort()).toEqual(['applied', 'no_change']);
    const before = await database.database
      .select({ passwordHash: staffPasswordCredentials.passwordHash })
      .from(staffPasswordCredentials)
      .where(eq(staffPasswordCredentials.staffPrincipalId, id));
    await expect(
      access.create(adminSession, { ...input, initialPassword: 'Different-Password-8!' }),
    ).resolves.toMatchObject({ outcome: 'no_change' });
    const after = await database.database
      .select({ passwordHash: staffPasswordCredentials.passwordHash })
      .from(staffPasswordCredentials)
      .where(eq(staffPasswordCredentials.staffPrincipalId, id));
    expect(after).toEqual(before);
    await expect(
      access.create(adminSession, { ...input, staffPrincipalId: randomUUID() }),
    ).rejects.toBeInstanceOf(ConflictError);
    const createdAudit = await database.database
      .select()
      .from(auditLogs)
      .where(eq(auditLogs.idempotencyKey, `staff-principal-created:${id}`));
    expect(createdAudit).toHaveLength(1);
  }, 60_000);

  it('applies bounded roles, invalidates old sessions, and permits only mapped reviewer access', async () => {
    const target = await access.create(adminSession, {
      staffPrincipalId: randomUUID(),
      email: 'safety@example.test',
      initialPassword: PASSWORD,
    });
    const targetSession = await auth.login('safety@example.test', PASSWORD);
    const grant = await access.grantRole(
      adminSession,
      target.principal.id,
      'safety_reviewer',
      target.principal.authorizationRevision,
    );
    expect(grant).toMatchObject({ outcome: 'applied', sessionCount: 1 });
    await expect(auth.validate(targetSession.rawToken)).rejects.toBeInstanceOf(AuthenticationError);
    const fresh = await auth.login('safety@example.test', PASSWORD);
    await expect(reviewer.authorize(fresh, 'risk_event:read')).resolves.toBeUndefined();
    await expect(
      access.grantRole(adminSession, target.principal.id, 'safety_reviewer', 1),
    ).resolves.toMatchObject({ outcome: 'no_change' });
  });

  it('uses revoke-sessions as an applied revision boundary even with zero visible sessions', async () => {
    const created = await access.create(adminSession, {
      staffPrincipalId: randomUUID(),
      email: 'empty-sessions@example.test',
      initialPassword: PASSWORD,
    });
    const result = await access.revokeSessions(
      adminSession,
      created.principal.id,
      created.principal.authorizationRevision,
    );
    expect(result).toMatchObject({ outcome: 'applied', sessionCount: 0 });
    expect(result.principal.authorizationRevision).toBe(2);
  });

  it('prevents an old revoke-sessions retry from revoking a later login', async () => {
    const created = await access.create(adminSession, {
      staffPrincipalId: randomUUID(),
      email: 'revoke-replay@example.test',
      initialPassword: PASSWORD,
    });
    const firstSession = await auth.login('revoke-replay@example.test', PASSWORD);
    const first = await access.revokeSessions(adminSession, created.principal.id, 1);
    expect(first).toMatchObject({ outcome: 'applied', sessionCount: 1 });
    await expect(auth.validate(firstSession.rawToken)).rejects.toBeInstanceOf(AuthenticationError);
    const laterSession = await auth.login('revoke-replay@example.test', PASSWORD);
    await expect(
      access.revokeSessions(adminSession, created.principal.id, 1),
    ).rejects.toMatchObject({
      statusCode: 409,
    });
    await expect(auth.validate(laterSession.rawToken)).resolves.toMatchObject({
      authorizationRevision: 2,
    });
  });

  it('makes disablement terminal and invalidates every existing staff session', async () => {
    const created = await access.create(adminSession, {
      staffPrincipalId: randomUUID(),
      email: 'disabled@example.test',
      initialPassword: PASSWORD,
    });
    const session = await auth.login('disabled@example.test', PASSWORD);
    const result = await access.disable(adminSession, created.principal.id, 1);
    expect(result).toMatchObject({
      outcome: 'applied',
      sessionCount: 1,
      principal: { status: 'disabled', authorizationRevision: 2 },
    });
    await expect(auth.validate(session.rawToken)).rejects.toBeInstanceOf(AuthenticationError);
    await expect(auth.login('disabled@example.test', PASSWORD)).rejects.toMatchObject({
      statusCode: 401,
    });
    await expect(
      access.grantRole(adminSession, created.principal.id, 'audit_reader', 2),
    ).rejects.toBeInstanceOf(ConflictError);
  });

  it('does not return a sensitive directory page when its access audit fails', async () => {
    const failure = jest
      .spyOn(audits, 'appendWithinTransaction')
      .mockRejectedValueOnce(new Error('synthetic'));
    await expect(access.list(adminSession, 20, undefined)).rejects.toBeInstanceOf(DatabaseError);
    failure.mockRestore();
  });

  it('rolls back role, revision and session invalidation when Audit fails', async () => {
    const created = await access.create(adminSession, {
      staffPrincipalId: randomUUID(),
      email: 'rollback@example.test',
      initialPassword: PASSWORD,
    });
    const targetSession = await auth.login('rollback@example.test', PASSWORD);
    const failure = jest
      .spyOn(audits, 'appendWithinTransaction')
      .mockRejectedValueOnce(new Error('synthetic'));
    await expect(
      access.grantRole(adminSession, created.principal.id, 'audit_reader', 1),
    ).rejects.toBeInstanceOf(DatabaseError);
    failure.mockRestore();
    expect((await access.get(adminSession, created.principal.id)).authorizationRevision).toBe(1);
    await expect(auth.validate(targetSession.rawToken)).resolves.toBeDefined();
  });

  it('rolls back staff creation when its Audit append fails', async () => {
    const id = randomUUID();
    const failure = jest
      .spyOn(audits, 'appendWithinTransaction')
      .mockRejectedValueOnce(new Error('synthetic'));
    await expect(
      access.create(adminSession, {
        staffPrincipalId: id,
        email: 'create-rollback@example.test',
        initialPassword: PASSWORD,
      }),
    ).rejects.toBeInstanceOf(DatabaseError);
    failure.mockRestore();
    const principal = await database.database
      .select()
      .from(staffPasswordCredentials)
      .where(eq(staffPasswordCredentials.staffPrincipalId, id));
    expect(principal).toHaveLength(0);
  });

  it('serializes competing revision mutations with one applied winner', async () => {
    const created = await access.create(adminSession, {
      staffPrincipalId: randomUUID(),
      email: 'revision-race@example.test',
      initialPassword: PASSWORD,
    });
    const blocker = await migrationClient.pool.connect();
    await blocker.query('BEGIN');
    await blocker.query('SELECT id FROM staff_principals WHERE id=$1 FOR UPDATE', [
      created.principal.id,
    ]);
    const attempts = [
      access.grantRole(adminSession, created.principal.id, 'audit_reader', 1),
      access.grantRole(adminSession, created.principal.id, 'knowledge_editor', 1),
    ];
    await waitForLockWaiters('staff_principals', 2);
    await blocker.query('COMMIT');
    blocker.release();
    const results = await Promise.allSettled(attempts);
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter((result) => result.status === 'rejected')).toHaveLength(1);
    const current = await access.get(adminSession, created.principal.id);
    expect(current.authorizationRevision).toBe(2);
    expect(current.roleKeys).toHaveLength(1);
  });

  it('authorizes reviewer metadata access from a real staff session and audits before return', async () => {
    const created = await access.create(adminSession, {
      staffPrincipalId: randomUUID(),
      email: 'review-boundary@example.test',
      initialPassword: PASSWORD,
    });
    await access.grantRole(adminSession, created.principal.id, 'safety_reviewer', 1);
    const staff = await auth.login('review-boundary@example.test', PASSWORD);
    const riskEventId = randomUUID();
    const queueId = randomUUID();
    const now = new Date();
    await database.database.insert(riskEvents).values({
      id: riskEventId,
      userId: null,
      conversationId: null,
      aiTurnId: null,
      triggerMessageId: null,
      clientRequestId: randomUUID(),
      isIncognito: true,
      level: 'HIGH',
      riskCategories: ['self_harm'],
      reasonCodes: ['SELF_HARM_IDEATION'],
      detectionSource: 'hybrid',
      policyVersion: 'synthetic-admin-test',
      classifierKey: null,
      classifierVersion: null,
      createdAt: now,
      retentionUntil: new Date(now.getTime() + 86_400_000),
    });
    await database.database.insert(humanReviewQueueItems).values({
      id: queueId,
      riskEventId,
      priority: 'high',
      state: 'pending',
      createdAt: now,
    });
    await expect(reviewQueue.get(staff, riskEventId, now)).resolves.toMatchObject({
      queueItem: { id: queueId },
      riskEvent: { id: riskEventId },
    });
    const viewed = await database.database
      .select()
      .from(auditLogs)
      .where(eq(auditLogs.resourceId, riskEventId));
    expect(viewed).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ action: 'risk_event_viewed', actorId: staff.id }),
      ]),
    );
  });

  it('fails Admin HTTP routes closed when the feature is disabled without stopping other APIs', async () => {
    env.ADMIN_AUTH_ENABLED = false;
    await request(app.getHttpServer())
      .post('/admin/auth/login')
      .set('Origin', ADMIN_ORIGIN)
      .send({ email: adminEmail, password: PASSWORD })
      .expect(503);
    await request(app.getHttpServer()).get('/health').expect(200);
    env.ADMIN_AUTH_ENABLED = true;
  });
});
