import { randomUUID } from 'node:crypto';
import {
  auditLogs,
  count,
  createDatabaseClient,
  eq,
  humanReviewQueueItems,
  migrate,
  riskEvents,
  conversations,
  users,
} from '@mental-health/database';
import type { INestApplication } from '@nestjs/common';
import { Test, type TestingModule } from '@nestjs/testing';
import { resolve } from 'node:path';
import request from 'supertest';
import { AdminSafetyReviewService } from '../src/admin/admin-safety-review.service';
import { StaffAccessService } from '../src/admin/staff-access.service';
import { StaffAuthService } from '../src/admin/staff-auth.service';
import { StaffBootstrapService } from '../src/admin/staff-bootstrap.service';
import { AppModule } from '../src/app.module';
import { AuthorizationError } from '../src/common/errors';
import { AppExceptionFilter } from '../src/common/filters/app-exception.filter';
import { createCorsOptions } from '../src/common/http/cors-options';
import { env } from '../src/config/env';
import { DatabaseService } from '../src/database/database.service';
import { AuditLogRepository } from '../src/safety/audit/audit-log.repository';

const ADMIN_ORIGIN = 'http://localhost:5174';
const WEB_ORIGIN = 'http://localhost:5173';
const PASSWORD = 'Synthetic-Safety-Reviewer-9!';

type StaffSession = Awaited<ReturnType<StaffAuthService['login']>>;

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}

async function withTimeout(signal: Promise<void>, label: string): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      signal,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`Timed out waiting for ${label}`)), 10_000);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function staffCookie(session: StaffSession): string {
  return `mh_staff_session=${session.rawToken}; mh_staff_csrf=${session.csrfToken}`;
}

describe('Admin Risk Event and Human Review backend', () => {
  let app: INestApplication;
  let moduleRef: TestingModule;
  let migrationClient: ReturnType<typeof createDatabaseClient>;
  let database: DatabaseService;
  let bootstrap: StaffBootstrapService;
  let auth: StaffAuthService;
  let access: StaffAccessService;
  let safetyReview: AdminSafetyReviewService;
  let audits: AuditLogRepository;
  let administrator: StaffSession;
  let reviewerA: StaffSession;
  let reviewerB: StaffSession;

  async function createReviewer(email: string): Promise<StaffSession> {
    const created = await access.create(administrator, {
      staffPrincipalId: randomUUID(),
      email,
      initialPassword: PASSWORD,
    });
    await access.grantRole(administrator, created.principal.id, 'safety_reviewer', 1);
    return auth.login(email, PASSWORD);
  }

  async function insertRiskEvent(
    input: Partial<typeof riskEvents.$inferInsert> = {},
  ): Promise<typeof riskEvents.$inferSelect> {
    const now = input.createdAt ?? new Date();
    const [record] = await database.database
      .insert(riskEvents)
      .values({
        id: input.id ?? randomUUID(),
        userId: input.userId ?? null,
        conversationId: input.conversationId ?? null,
        aiTurnId: input.aiTurnId ?? null,
        triggerMessageId: input.triggerMessageId ?? null,
        clientRequestId: input.clientRequestId ?? randomUUID(),
        isIncognito: input.isIncognito ?? true,
        level: input.level ?? 'HIGH',
        riskCategories: input.riskCategories ?? ['SELF_HARM'],
        reasonCodes: input.reasonCodes ?? ['SELF_HARM_IDEATION'],
        detectionSource: input.detectionSource ?? 'hybrid',
        policyVersion: input.policyVersion ?? 'synthetic-admin-safety-v1',
        classifierKey: input.classifierKey ?? null,
        classifierVersion: input.classifierVersion ?? null,
        createdAt: now,
        retentionUntil: input.retentionUntil ?? new Date(now.getTime() + 86_400_000),
      })
      .returning();
    if (!record) throw new Error('Expected synthetic Risk Event');
    return record;
  }

  async function insertQueueItem(
    riskEventId: string,
    input: Partial<typeof humanReviewQueueItems.$inferInsert> = {},
  ): Promise<typeof humanReviewQueueItems.$inferSelect> {
    const [record] = await database.database
      .insert(humanReviewQueueItems)
      .values({
        id: input.id ?? randomUUID(),
        riskEventId,
        priority: input.priority ?? 'high',
        state: input.state ?? 'pending',
        assignedReviewerId: input.assignedReviewerId ?? null,
        createdAt: input.createdAt ?? new Date(),
        startedAt: input.startedAt ?? null,
        reviewedAt: input.reviewedAt ?? null,
        resolutionCode: input.resolutionCode ?? null,
      })
      .returning();
    if (!record) throw new Error('Expected synthetic Review Queue item');
    return record;
  }

  async function waitForLockWaiters(minimum: number): Promise<void> {
    const deadline = Date.now() + 10_000;
    while (Date.now() < deadline) {
      const result = await migrationClient.pool.query<{ value: number }>(
        `SELECT count(*)::int AS value FROM pg_stat_activity
         WHERE pid <> pg_backend_pid()
           AND wait_event_type = 'Lock'
           AND query ILIKE '%human_review_queue_items%'`,
      );
      if ((result.rows[0]?.value ?? 0) >= minimum) return;
      await new Promise<void>((settle) => setImmediate(settle));
    }
    throw new Error(`Timed out waiting for ${minimum} queue row-lock waiters`);
  }

  beforeAll(async () => {
    const url = process.env.TEST_DATABASE_URL;
    if (!url) throw new Error('TEST_DATABASE_URL is required');
    const databaseName = decodeURIComponent(new URL(url).pathname.slice(1));
    if (!databaseName.endsWith('_test')) throw new Error('Refusing non-test database');

    migrationClient = createDatabaseClient(url);
    await migrationClient.pool.query('DROP SCHEMA IF EXISTS drizzle CASCADE');
    await migrationClient.pool.query('DROP SCHEMA public CASCADE');
    await migrationClient.pool.query('CREATE SCHEMA public');
    await migrate(migrationClient.database, {
      migrationsFolder: resolve(process.cwd(), '../../database/migrations'),
    });

    env.ADMIN_AUTH_ENABLED = true;
    moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    app.useLogger(false);
    app.useGlobalFilters(new AppExceptionFilter());
    app.enableCors(createCorsOptions());
    await app.init();

    database = moduleRef.get(DatabaseService);
    bootstrap = moduleRef.get(StaffBootstrapService);
    auth = moduleRef.get(StaffAuthService);
    access = moduleRef.get(StaffAccessService);
    safetyReview = moduleRef.get(AdminSafetyReviewService);
    audits = moduleRef.get(AuditLogRepository);

    const adminEmail = 'admin-safety-root@example.test';
    await bootstrap.bootstrap({
      staffPrincipalId: randomUUID(),
      email: adminEmail,
      password: PASSWORD,
    });
    administrator = await auth.login(adminEmail, PASSWORD);
    reviewerA = await createReviewer('safety-reviewer-a@example.test');
    reviewerB = await createReviewer('safety-reviewer-b@example.test');
  }, 90_000);

  beforeEach(async () => {
    await database.database.delete(riskEvents);
  });

  afterAll(async () => {
    env.ADMIN_AUTH_ENABLED = false;
    await app.close();
    await migrationClient.pool.end();
  });

  it('enforces the separate staff domain, trusted origin, and service-level least privilege', async () => {
    await insertRiskEvent();
    await request(app.getHttpServer())
      .get('/admin/risk-events')
      .set('Origin', ADMIN_ORIGIN)
      .set('Cookie', 'mh_session=ordinary-session')
      .expect(401);
    await request(app.getHttpServer())
      .get('/admin/risk-events')
      .set('Origin', WEB_ORIGIN)
      .set('Cookie', staffCookie(reviewerA))
      .expect(403);
    await request(app.getHttpServer())
      .get('/admin/risk-events')
      .set('Origin', ADMIN_ORIGIN)
      .set('Cookie', staffCookie(administrator))
      .expect(403);
    await expect(
      safetyReview.listRiskEvents(
        { id: reviewerA.id, sessionId: randomUUID(), authorizationRevision: 1 },
        { limit: 20 },
      ),
    ).rejects.toBeInstanceOf(AuthorizationError);
  });

  it('returns only bounded Risk metadata and audits list/detail reads before returning', async () => {
    const userId = randomUUID();
    const conversationId = randomUUID();
    const now = new Date('2026-09-12T03:00:00.000Z');
    await database.database.insert(users).values({ id: userId, createdAt: now });
    await database.database.insert(conversations).values({
      id: conversationId,
      userId,
      createdAt: now,
      expiresAt: new Date(now.getTime() + 86_400_000),
      isSaved: false,
      deletedAt: null,
    });
    const event = await insertRiskEvent({
      userId,
      conversationId,
      clientRequestId: randomUUID(),
      isIncognito: false,
      level: 'MEDIUM',
      createdAt: now,
    });

    const list = await request(app.getHttpServer())
      .get('/admin/risk-events?level=MEDIUM&limit=20')
      .set('Origin', ADMIN_ORIGIN)
      .set('Cookie', staffCookie(reviewerA))
      .expect('Cache-Control', 'private, no-store')
      .expect(200);
    expect(list.body.data.riskEvents).toEqual([
      expect.objectContaining({
        id: event.id,
        level: 'MEDIUM',
        isIncognito: false,
        ordinaryContextReferenceAvailable: true,
      }),
    ]);
    const serialized = JSON.stringify(list.body);
    for (const forbidden of [
      'userId',
      'clientRequestId',
      'conversationId',
      'triggerMessageId',
      'aiTurnId',
      'message',
      'prompt',
    ]) {
      expect(serialized).not.toContain(forbidden);
    }

    const detail = await request(app.getHttpServer())
      .get(`/admin/risk-events/${event.id}`)
      .set('Origin', ADMIN_ORIGIN)
      .set('Cookie', staffCookie(reviewerA))
      .expect(200);
    expect(detail.body.data).toMatchObject({
      riskEvent: { id: event.id, level: 'MEDIUM' },
      reviewQueueItem: null,
    });

    const accessAudits = await database.database
      .select()
      .from(auditLogs)
      .where(eq(auditLogs.actorId, reviewerA.id));
    expect(accessAudits).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          action: 'risk_event_list_accessed',
          resourceType: 'risk_event_query',
          safeMetadata: { filterCategory: 'level', returnedCount: 1 },
        }),
        expect.objectContaining({
          action: 'risk_event_viewed',
          resourceId: event.id,
          actorType: 'staff',
          safeMetadata: {},
        }),
      ]),
    );
  });

  it('binds opaque Risk cursors to filters and orders equal timestamps without duplication', async () => {
    const createdAt = new Date('2026-09-12T04:00:00.000Z');
    const ids = [randomUUID(), randomUUID(), randomUUID()].sort().reverse();
    for (const id of ids) {
      await insertRiskEvent({ id, level: 'CRITICAL', isIncognito: true, createdAt });
    }

    const first = await request(app.getHttpServer())
      .get('/admin/risk-events?level=CRITICAL&isIncognito=true&limit=1')
      .set('Origin', ADMIN_ORIGIN)
      .set('Cookie', staffCookie(reviewerA))
      .expect(200);
    expect(first.body.data.riskEvents.map((row: { id: string }) => row.id)).toEqual([ids[0]]);
    expect(first.body.data.nextCursor).toEqual(expect.any(String));

    const second = await request(app.getHttpServer())
      .get(
        `/admin/risk-events?level=CRITICAL&isIncognito=true&limit=2&cursor=${first.body.data.nextCursor}`,
      )
      .set('Origin', ADMIN_ORIGIN)
      .set('Cookie', staffCookie(reviewerA))
      .expect(200);
    expect(second.body.data.riskEvents.map((row: { id: string }) => row.id)).toEqual(ids.slice(1));
    expect(
      new Set([...first.body.data.riskEvents, ...second.body.data.riskEvents].map((row) => row.id))
        .size,
    ).toBe(3);

    await request(app.getHttpServer())
      .get(`/admin/risk-events?level=HIGH&limit=1&cursor=${first.body.data.nextCursor}`)
      .set('Origin', ADMIN_ORIGIN)
      .set('Cookie', staffCookie(reviewerA))
      .expect(400);
    await request(app.getHttpServer())
      .get('/admin/risk-events?limit=51')
      .set('Origin', ADMIN_ORIGIN)
      .set('Cookie', staffCookie(reviewerA))
      .expect(400);
  });

  it('orders queue work by priority then age and binds queue cursors to filters', async () => {
    const base = new Date('2026-09-12T05:00:00.000Z');
    const highRisk = await insertRiskEvent({ level: 'HIGH', createdAt: base });
    const urgentLaterRisk = await insertRiskEvent({
      level: 'CRITICAL',
      createdAt: new Date(base.getTime() + 2_000),
    });
    const urgentEarlierRisk = await insertRiskEvent({
      level: 'CRITICAL',
      createdAt: new Date(base.getTime() + 1_000),
    });
    const high = await insertQueueItem(highRisk.id, { priority: 'high', createdAt: base });
    const urgentLater = await insertQueueItem(urgentLaterRisk.id, {
      priority: 'urgent',
      createdAt: new Date(base.getTime() + 2_000),
    });
    const urgentEarlier = await insertQueueItem(urgentEarlierRisk.id, {
      priority: 'urgent',
      createdAt: new Date(base.getTime() + 1_000),
    });

    const first = await request(app.getHttpServer())
      .get('/admin/review-queue?state=pending&limit=2')
      .set('Origin', ADMIN_ORIGIN)
      .set('Cookie', staffCookie(reviewerA))
      .expect(200);
    expect(
      first.body.data.queueItems.map((row: { queueItem: { id: string } }) => row.queueItem.id),
    ).toEqual([urgentEarlier.id, urgentLater.id]);

    const second = await request(app.getHttpServer())
      .get(`/admin/review-queue?state=pending&limit=2&cursor=${first.body.data.nextCursor}`)
      .set('Origin', ADMIN_ORIGIN)
      .set('Cookie', staffCookie(reviewerA))
      .expect(200);
    expect(
      second.body.data.queueItems.map((row: { queueItem: { id: string } }) => row.queueItem.id),
    ).toEqual([high.id]);

    await request(app.getHttpServer())
      .get(`/admin/review-queue?state=resolved&limit=2&cursor=${first.body.data.nextCursor}`)
      .set('Origin', ADMIN_ORIGIN)
      .set('Cookie', staffCookie(reviewerA))
      .expect(400);
  });

  it('requires staff CSRF and permits exactly one claimant under a real PostgreSQL row lock', async () => {
    const event = await insertRiskEvent({ level: 'HIGH' });
    const item = await insertQueueItem(event.id);
    await request(app.getHttpServer())
      .post(`/admin/review-queue/${item.id}/claim`)
      .set('Origin', ADMIN_ORIGIN)
      .set('Cookie', staffCookie(reviewerA))
      .send({})
      .expect(403);

    const blocker = await migrationClient.pool.connect();
    await blocker.query('BEGIN');
    await blocker.query('SELECT id FROM human_review_queue_items WHERE id=$1 FOR UPDATE', [
      item.id,
    ]);
    try {
      const attempts = [reviewerA, reviewerB].map((reviewer) =>
        request(app.getHttpServer())
          .post(`/admin/review-queue/${item.id}/claim`)
          .set('Origin', ADMIN_ORIGIN)
          .set('Cookie', staffCookie(reviewer))
          .set('x-staff-csrf-token', reviewer.csrfToken)
          .send({})
          .then((response) => response),
      );
      await waitForLockWaiters(2);
      await blocker.query('COMMIT');
      const results = await Promise.all(attempts);
      expect(results.map((result) => result.status).sort()).toEqual([201, 409]);
    } finally {
      await blocker.query('ROLLBACK').catch(() => undefined);
      blocker.release();
    }

    const [current] = await database.database
      .select()
      .from(humanReviewQueueItems)
      .where(eq(humanReviewQueueItems.id, item.id));
    expect(current).toMatchObject({ state: 'in_review' });
    expect([reviewerA.id, reviewerB.id]).toContain(current?.assignedReviewerId);
    const [started] = await database.database
      .select({ value: count() })
      .from(auditLogs)
      .where(eq(auditLogs.idempotencyKey, `review-started:${item.id}`));
    expect(started?.value).toBe(1);
  });

  it('allows only the assignee to resolve and commits one bounded resolution under contention', async () => {
    const event = await insertRiskEvent({ level: 'CRITICAL' });
    const item = await insertQueueItem(event.id, { priority: 'urgent' });
    await request(app.getHttpServer())
      .post(`/admin/review-queue/${item.id}/claim`)
      .set('Origin', ADMIN_ORIGIN)
      .set('Cookie', staffCookie(reviewerA))
      .set('x-staff-csrf-token', reviewerA.csrfToken)
      .send({})
      .expect(201);
    await request(app.getHttpServer())
      .post(`/admin/review-queue/${item.id}/resolve`)
      .set('Origin', ADMIN_ORIGIN)
      .set('Cookie', staffCookie(reviewerB))
      .set('x-staff-csrf-token', reviewerB.csrfToken)
      .send({ resolutionCode: 'false_positive' })
      .expect(409);

    const blocker = await migrationClient.pool.connect();
    await blocker.query('BEGIN');
    await blocker.query('SELECT id FROM human_review_queue_items WHERE id=$1 FOR UPDATE', [
      item.id,
    ]);
    try {
      const attempts = ['confirmed_risk', 'action_recorded'].map((resolutionCode) =>
        request(app.getHttpServer())
          .post(`/admin/review-queue/${item.id}/resolve`)
          .set('Origin', ADMIN_ORIGIN)
          .set('Cookie', staffCookie(reviewerA))
          .set('x-staff-csrf-token', reviewerA.csrfToken)
          .send({ resolutionCode })
          .then((response) => response),
      );
      await waitForLockWaiters(2);
      await blocker.query('COMMIT');
      const results = await Promise.all(attempts);
      expect(results.map((result) => result.status).sort()).toEqual([201, 409]);
    } finally {
      await blocker.query('ROLLBACK').catch(() => undefined);
      blocker.release();
    }

    const [current] = await database.database
      .select()
      .from(humanReviewQueueItems)
      .where(eq(humanReviewQueueItems.id, item.id));
    expect(current).toMatchObject({
      state: 'resolved',
      assignedReviewerId: reviewerA.id,
    });
    expect(['confirmed_risk', 'action_recorded']).toContain(current?.resolutionCode);
    const [resolved] = await database.database
      .select({ value: count() })
      .from(auditLogs)
      .where(eq(auditLogs.idempotencyKey, `review-resolved:${item.id}`));
    expect(resolved?.value).toBe(1);
  });

  it('rolls back queue state and withholds sensitive reads when their Audit append fails', async () => {
    const event = await insertRiskEvent({ level: 'HIGH' });
    const item = await insertQueueItem(event.id);

    const listFailure = jest
      .spyOn(audits, 'appendWithinTransaction')
      .mockRejectedValueOnce(new Error('synthetic audit failure'));
    const list = await request(app.getHttpServer())
      .get('/admin/risk-events')
      .set('Origin', ADMIN_ORIGIN)
      .set('Cookie', staffCookie(reviewerA))
      .expect(500);
    expect(list.body.data).toBeUndefined();
    listFailure.mockRestore();

    const claimFailure = jest
      .spyOn(audits, 'appendWithinTransaction')
      .mockRejectedValueOnce(new Error('synthetic audit failure'));
    await request(app.getHttpServer())
      .post(`/admin/review-queue/${item.id}/claim`)
      .set('Origin', ADMIN_ORIGIN)
      .set('Cookie', staffCookie(reviewerA))
      .set('x-staff-csrf-token', reviewerA.csrfToken)
      .send({})
      .expect(500);
    claimFailure.mockRestore();

    const [afterFailure] = await database.database
      .select()
      .from(humanReviewQueueItems)
      .where(eq(humanReviewQueueItems.id, item.id));
    expect(afterFailure).toMatchObject({
      state: 'pending',
      assignedReviewerId: null,
      startedAt: null,
    });

    await request(app.getHttpServer())
      .post(`/admin/review-queue/${item.id}/claim`)
      .set('Origin', ADMIN_ORIGIN)
      .set('Cookie', staffCookie(reviewerA))
      .set('x-staff-csrf-token', reviewerA.csrfToken)
      .send({})
      .expect(201);
    const resolveFailure = jest
      .spyOn(audits, 'appendWithinTransaction')
      .mockRejectedValueOnce(new Error('synthetic audit failure'));
    await request(app.getHttpServer())
      .post(`/admin/review-queue/${item.id}/resolve`)
      .set('Origin', ADMIN_ORIGIN)
      .set('Cookie', staffCookie(reviewerA))
      .set('x-staff-csrf-token', reviewerA.csrfToken)
      .send({ resolutionCode: 'confirmed_risk' })
      .expect(500);
    resolveFailure.mockRestore();

    const [afterResolveFailure] = await database.database
      .select()
      .from(humanReviewQueueItems)
      .where(eq(humanReviewQueueItems.id, item.id));
    expect(afterResolveFailure).toMatchObject({
      state: 'in_review',
      assignedReviewerId: reviewerA.id,
      reviewedAt: null,
      resolutionCode: null,
    });
  });

  it('invalidates old reviewer sessions after revocation without reviving a completed read', async () => {
    const event = await insertRiskEvent({ level: 'HIGH' });
    const auditEntered = deferred();
    const releaseAudit = deferred();
    const appendOriginal = audits.appendWithinTransaction.bind(audits);
    const append = jest
      .spyOn(audits, 'appendWithinTransaction')
      .mockImplementationOnce(
        async (...args: Parameters<AuditLogRepository['appendWithinTransaction']>) => {
          auditEntered.resolve();
          await releaseAudit.promise;
          return appendOriginal(...args);
        },
      );

    const inFlight = request(app.getHttpServer())
      .get(`/admin/risk-events/${event.id}`)
      .set('Origin', ADMIN_ORIGIN)
      .set('Cookie', staffCookie(reviewerB))
      .then((response) => response);
    await withTimeout(auditEntered.promise, 'authorized Risk read');
    const principal = await access.get(administrator, reviewerB.id);
    await access.revokeRole(
      administrator,
      reviewerB.id,
      'safety_reviewer',
      principal.authorizationRevision,
    );
    releaseAudit.resolve();
    const completed = await inFlight;
    expect(completed.status).toBe(200);
    append.mockRestore();

    await request(app.getHttpServer())
      .get(`/admin/risk-events/${event.id}`)
      .set('Origin', ADMIN_ORIGIN)
      .set('Cookie', staffCookie(reviewerB))
      .expect(401);
    await expect(safetyReview.getRiskEvent(reviewerB, event.id)).rejects.toBeInstanceOf(
      AuthorizationError,
    );

    const principalAfter = await access.get(administrator, reviewerB.id);
    await access.grantRole(
      administrator,
      reviewerB.id,
      'safety_reviewer',
      principalAfter.authorizationRevision,
    );
    reviewerB = await auth.login('safety-reviewer-b@example.test', PASSWORD);
  });

  it('returns controlled missing/conflict errors without exposing resource existence', async () => {
    await request(app.getHttpServer())
      .get(`/admin/risk-events/${randomUUID()}`)
      .set('Origin', ADMIN_ORIGIN)
      .set('Cookie', staffCookie(reviewerA))
      .expect(404);
    await request(app.getHttpServer())
      .post(`/admin/review-queue/${randomUUID()}/claim`)
      .set('Origin', ADMIN_ORIGIN)
      .set('Cookie', staffCookie(reviewerA))
      .set('x-staff-csrf-token', reviewerA.csrfToken)
      .send({})
      .expect(409);
    await request(app.getHttpServer())
      .post(`/admin/review-queue/${randomUUID()}/resolve`)
      .set('Origin', ADMIN_ORIGIN)
      .set('Cookie', staffCookie(reviewerA))
      .set('x-staff-csrf-token', reviewerA.csrfToken)
      .send({ resolutionCode: 'arbitrary-text' })
      .expect(400);
  });
});
