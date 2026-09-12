import { randomUUID } from 'node:crypto';
import {
  aiTurns,
  auditLogs,
  conversations,
  count,
  createDatabaseClient,
  eq,
  migrate,
  quotaConsumptions,
  users,
} from '@mental-health/database';
import type { INestApplication } from '@nestjs/common';
import { Test, type TestingModule } from '@nestjs/testing';
import { resolve } from 'node:path';
import request from 'supertest';
import { AdminAiTurnMetadataRepository } from '../src/admin/admin-ai-turn-metadata.repository';
import { AdminAiTurnMetadataService } from '../src/admin/admin-ai-turn-metadata.service';
import type { AdminAiTurnStatus } from '../src/admin/admin-ai-turn-metadata.schemas';
import { StaffAccessService } from '../src/admin/staff-access.service';
import { StaffAuthService, type CreatedStaffSession } from '../src/admin/staff-auth.service';
import { StaffBootstrapService } from '../src/admin/staff-bootstrap.service';
import { AppModule } from '../src/app.module';
import { AppExceptionFilter } from '../src/common/filters/app-exception.filter';
import { createCorsOptions } from '../src/common/http/cors-options';
import { encodeOpaqueCursor } from '../src/common/pagination/opaque-cursor';
import { env } from '../src/config/env';
import { DatabaseService } from '../src/database/database.service';
import { AuditLogRepository } from '../src/safety/audit/audit-log.repository';

const ADMIN_ORIGIN = 'http://localhost:5174';
const PASSWORD = 'Synthetic-Ai-Metadata-Password-9!';

type Deferred = Readonly<{ promise: Promise<void>; resolve: () => void }>;

function deferred(): Deferred {
  let resolve!: () => void;
  const promise = new Promise<void>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}

async function within<T>(promise: Promise<T>, label: string, timeoutMs = 10_000): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`Timed out waiting for ${label}`)), timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function staffCookie(session: CreatedStaffSession): string {
  return `mh_staff_session=${session.rawToken}`;
}

describe('Admin Persistent AI Turn metadata backend', () => {
  let app: INestApplication;
  let moduleRef: TestingModule;
  let migrationClient: ReturnType<typeof createDatabaseClient>;
  let database: DatabaseService;
  let repository: AdminAiTurnMetadataRepository;
  let service: AdminAiTurnMetadataService;
  let audits: AuditLogRepository;
  let access: StaffAccessService;
  let auth: StaffAuthService;
  let administrator: CreatedStaffSession;
  let qualityReviewer: CreatedStaffSession;
  let auditReader: CreatedStaffSession;
  let qualityReviewerEmail: string;

  async function createStaffWithRole(
    email: string,
    role: 'audit_reader' | 'ai_quality_reviewer',
  ): Promise<CreatedStaffSession> {
    const created = await access.create(administrator, {
      staffPrincipalId: randomUUID(),
      email,
      initialPassword: PASSWORD,
    });
    await access.grantRole(
      administrator,
      created.principal.id,
      role,
      created.principal.authorizationRevision,
    );
    return auth.login(email, PASSWORD);
  }

  async function insertTurn(
    input: Readonly<{
      id?: string;
      status?: AdminAiTurnStatus;
      promptKey?: string;
      promptVersion?: string;
      failureCode?: string | null;
      createdAt?: Date;
      startedAt?: Date;
      completedAt?: Date | null;
      leaseExpiresAt?: Date;
      saved?: boolean;
      expiresAt?: Date | null;
      deletedAt?: Date | null;
    }> = {},
  ) {
    const now = new Date();
    const createdAt = input.createdAt ?? new Date(now.getTime() - 60_000);
    const startedAt = input.startedAt ?? createdAt;
    const status = input.status ?? 'completed';
    const userId = randomUUID();
    const conversationId = randomUUID();
    const turnId = input.id ?? randomUUID();
    const saved = input.saved ?? false;
    await database.database.insert(users).values({ id: userId, createdAt });
    await database.database.insert(conversations).values({
      id: conversationId,
      userId,
      createdAt,
      isSaved: saved,
      expiresAt:
        input.expiresAt === undefined
          ? saved
            ? null
            : new Date(now.getTime() + 24 * 60 * 60 * 1_000)
          : input.expiresAt,
      deletedAt: input.deletedAt ?? null,
    });
    await database.database.insert(aiTurns).values({
      id: turnId,
      userId,
      conversationId,
      clientRequestId: randomUUID(),
      status,
      promptKey: input.promptKey ?? 'supportive-chat',
      promptVersion: input.promptVersion ?? '1',
      failureCode: input.failureCode ?? null,
      leaseExpiresAt: input.leaseExpiresAt ?? new Date(now.getTime() + 60_000),
      createdAt,
      startedAt,
      completedAt:
        input.completedAt === undefined
          ? status === 'claimed' || status === 'streaming'
            ? null
            : new Date(startedAt.getTime() + 4_000)
          : input.completedAt,
    });
    return { turnId, userId, conversationId, createdAt, startedAt };
  }

  async function accessAuditCount(): Promise<number> {
    const [row] = await database.database
      .select({ value: count() })
      .from(auditLogs)
      .where(eq(auditLogs.action, 'ai_quality_metadata_accessed'));
    return row?.value ?? 0;
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
    repository = moduleRef.get(AdminAiTurnMetadataRepository);
    service = moduleRef.get(AdminAiTurnMetadataService);
    audits = moduleRef.get(AuditLogRepository);
    access = moduleRef.get(StaffAccessService);
    auth = moduleRef.get(StaffAuthService);
    const bootstrap = moduleRef.get(StaffBootstrapService);

    const administratorEmail = 'ai-metadata-admin@example.test';
    await bootstrap.bootstrap({
      staffPrincipalId: randomUUID(),
      email: administratorEmail,
      password: PASSWORD,
    });
    administrator = await auth.login(administratorEmail, PASSWORD);
    qualityReviewerEmail = 'ai-metadata-reviewer@example.test';
    qualityReviewer = await createStaffWithRole(qualityReviewerEmail, 'ai_quality_reviewer');
    auditReader = await createStaffWithRole('ai-metadata-audit@example.test', 'audit_reader');
  }, 90_000);

  beforeEach(async () => {
    await database.database.delete(auditLogs);
    await database.database.delete(users);
  });

  afterAll(async () => {
    env.ADMIN_AUTH_ENABLED = false;
    await app.close();
    await migrationClient.pool.end();
  });

  it('enforces origin, Staff Session, explicit role, and transaction authorization on GET', async () => {
    await insertTurn();
    await request(app.getHttpServer())
      .get('/admin/ai-quality/turns')
      .set('Origin', ADMIN_ORIGIN)
      .set('Cookie', 'mh_session=ordinary-session')
      .expect(401);
    await request(app.getHttpServer())
      .get('/admin/ai-quality/turns')
      .set('Origin', ADMIN_ORIGIN)
      .set('Cookie', staffCookie(administrator))
      .expect(403);
    await request(app.getHttpServer())
      .get('/admin/ai-quality/turns')
      .set('Origin', ADMIN_ORIGIN)
      .set('Cookie', staffCookie(auditReader))
      .expect(403);
    await request(app.getHttpServer())
      .get('/admin/ai-quality/turns')
      .set('Cookie', staffCookie(qualityReviewer))
      .expect(403);
    await request(app.getHttpServer())
      .get('/admin/ai-quality/turns')
      .set('Origin', 'http://localhost:5173')
      .set('Cookie', staffCookie(qualityReviewer))
      .expect(403);

    const previousChat = env.AI_CHAT_ENABLED;
    const previousKnowledge = env.AI_KNOWLEDGE_ENABLED;
    env.AI_CHAT_ENABLED = false;
    env.AI_KNOWLEDGE_ENABLED = false;
    try {
      await request(app.getHttpServer())
        .get('/admin/ai-quality/turns')
        .set('Origin', ADMIN_ORIGIN)
        .set('Cookie', staffCookie(qualityReviewer))
        .expect('Cache-Control', 'private, no-store')
        .expect(200);
    } finally {
      env.AI_CHAT_ENABLED = previousChat;
      env.AI_KNOWLEDGE_ENABLED = previousKnowledge;
    }
    expect(await accessAuditCount()).toBe(1);
    const [listAudit] = await database.database
      .select()
      .from(auditLogs)
      .where(eq(auditLogs.action, 'ai_quality_metadata_accessed'));
    expect(listAudit).toMatchObject({
      actorType: 'staff',
      actorId: qualityReviewer.id,
      resourceType: 'ai_turn_query',
      resourceId: qualityReviewer.id,
      safeMetadata: { accessCategory: 'list', filterCategory: 'all', returnedCount: 1 },
    });

    await request(app.getHttpServer())
      .get('/admin/audit-logs')
      .set('Origin', ADMIN_ORIGIN)
      .set('Cookie', staffCookie(qualityReviewer))
      .expect(403);

    await expect(
      service.list(
        { id: qualityReviewer.id, sessionId: randomUUID(), authorizationRevision: 1 },
        { limit: 20 },
      ),
    ).rejects.toMatchObject({ statusCode: 403 });
    await expect(service.get(qualityReviewer, 'not-a-uuid')).rejects.toMatchObject({
      statusCode: 400,
    });

    env.ADMIN_AUTH_ENABLED = false;
    await request(app.getHttpServer())
      .get('/admin/ai-quality/turns')
      .set('Origin', ADMIN_ORIGIN)
      .set('Cookie', staffCookie(qualityReviewer))
      .expect(503);
    await request(app.getHttpServer()).get('/health').expect(200);
    env.ADMIN_AUTH_ENABLED = true;
  });

  it('returns only bounded lifecycle metadata and does not consume quota', async () => {
    const failed = await insertTurn({ status: 'failed', failureCode: 'NETWORK' });
    const active = await insertTurn({
      status: 'streaming',
      failureCode: 'INTERNAL',
      completedAt: new Date(Date.now() + 60_000),
      leaseExpiresAt: new Date(Date.now() - 1),
    });
    const unavailablePrompt = await insertTurn({
      promptKey: 'Unsafe Prompt Name',
      promptVersion: 'bad version',
    });

    const response = await request(app.getHttpServer())
      .get('/admin/ai-quality/turns?limit=20')
      .set('Origin', ADMIN_ORIGIN)
      .set('Cookie', staffCookie(qualityReviewer))
      .expect(200);
    expect(response.body.data.turns).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          turnId: failed.turnId,
          status: 'failed',
          promptIdentity: { availability: 'available', key: 'supportive-chat', version: '1' },
          failureCategory: 'provider_unavailable',
          lifecycleDurationMs: 4_000,
          leaseState: 'not_applicable',
        }),
        expect.objectContaining({
          turnId: active.turnId,
          status: 'streaming',
          failureCategory: 'unknown',
          terminalAt: null,
          lifecycleDurationMs: null,
          leaseState: 'expired',
        }),
        expect.objectContaining({
          turnId: unavailablePrompt.turnId,
          promptIdentity: { availability: 'unavailable' },
        }),
      ]),
    );
    const serialized = JSON.stringify(response.body);
    for (const forbidden of [
      failed.userId,
      failed.conversationId,
      'clientRequestId',
      'userMessageId',
      'assistantMessageId',
      'failureCode',
      'NETWORK',
      'Unsafe Prompt Name',
      'bad version',
      'message',
      'content',
      'quota',
      'risk',
      'providerRequestId',
      'inputTokens',
      'outputTokens',
      'modelName',
      'citation',
    ]) {
      expect(serialized.toLowerCase()).not.toContain(forbidden.toLowerCase());
    }
    const [usage] = await database.database.select({ value: count() }).from(quotaConsumptions);
    expect(usage?.value ?? 0).toBe(0);
  });

  it('paginates by the internal createdAt/id keyset and validates every continuation', async () => {
    const createdAt = new Date(Date.now() - 60_000);
    const ids = [randomUUID(), randomUUID(), randomUUID()].sort().reverse();
    for (const id of ids)
      await insertTurn({ id, status: 'failed', failureCode: 'TIMEOUT', createdAt });

    const first = await request(app.getHttpServer())
      .get('/admin/ai-quality/turns?status=failed&limit=1')
      .set('Origin', ADMIN_ORIGIN)
      .set('Cookie', staffCookie(qualityReviewer))
      .expect(200);
    expect(first.body.data.turns.map((turn: { turnId: string }) => turn.turnId)).toEqual([ids[0]]);
    expect(first.body.data.nextCursor).toEqual(expect.any(String));
    expect(first.body.data.nextCursor.length).toBeLessThanOrEqual(512);

    const fixedCeiling = await insertTurn({
      status: 'failed',
      failureCode: 'TIMEOUT',
      createdAt: new Date(first.body.data.period.createdBefore),
    });
    const second = await request(app.getHttpServer())
      .get(`/admin/ai-quality/turns?limit=2&cursor=${first.body.data.nextCursor}`)
      .set('Origin', ADMIN_ORIGIN)
      .set('Cookie', staffCookie(qualityReviewer))
      .expect(200);
    expect(second.body.data.turns.map((turn: { turnId: string }) => turn.turnId)).toEqual(
      ids.slice(1),
    );
    expect(second.body.data.turns.map((turn: { turnId: string }) => turn.turnId)).not.toContain(
      fixedCeiling.turnId,
    );

    await request(app.getHttpServer())
      .get(`/admin/ai-quality/turns?status=completed&cursor=${first.body.data.nextCursor}`)
      .set('Origin', ADMIN_ORIGIN)
      .set('Cookie', staffCookie(qualityReviewer))
      .expect(400);
    await request(app.getHttpServer())
      .get(`/admin/ai-quality/turns?cursor=${first.body.data.nextCursor}.`)
      .set('Origin', ADMIN_ORIGIN)
      .set('Cookie', staffCookie(qualityReviewer))
      .expect(400);

    const cursor = JSON.parse(
      Buffer.from(first.body.data.nextCursor, 'base64url').toString('utf8'),
    ) as Record<string, unknown>;
    for (const malformedCursor of [
      encodeOpaqueCursor({ ...cursor, b: new Date(Date.now() + 60_000).toISOString() }),
      encodeOpaqueCursor({
        ...cursor,
        m: 'd',
        f: new Date(Date.parse(String(cursor.b)) - 6 * 24 * 60 * 60 * 1_000).toISOString(),
      }),
      encodeOpaqueCursor({
        ...cursor,
        t: new Date(Date.parse(String(cursor.f)) - 1).toISOString(),
      }),
    ]) {
      await request(app.getHttpServer())
        .get(`/admin/ai-quality/turns?cursor=${malformedCursor}`)
        .set('Origin', ADMIN_ORIGIN)
        .set('Cookie', staffCookie(qualityReviewer))
        .expect(400);
    }
  });

  it('validates explicit time windows and hides deleted or expired parent conversations', async () => {
    const now = new Date();
    const visible = await insertTurn({ createdAt: new Date(now.getTime() - 60_000) });
    const saved = await insertTurn({
      createdAt: new Date(now.getTime() - 50_000),
      saved: true,
      expiresAt: null,
    });
    const expired = await insertTurn({
      createdAt: new Date(now.getTime() - 40_000),
      expiresAt: new Date(now.getTime() - 1),
    });
    const deleted = await insertTurn({
      createdAt: new Date(now.getTime() - 30_000),
      deletedAt: now,
    });

    const response = await request(app.getHttpServer())
      .get(
        `/admin/ai-quality/turns?createdFrom=${encodeURIComponent(
          new Date(now.getTime() - 120_000).toISOString(),
        )}&createdBefore=${encodeURIComponent(now.toISOString())}`,
      )
      .set('Origin', ADMIN_ORIGIN)
      .set('Cookie', staffCookie(qualityReviewer))
      .expect(200);
    expect(response.body.data.turns.map((turn: { turnId: string }) => turn.turnId).sort()).toEqual(
      [visible.turnId, saved.turnId].sort(),
    );
    for (const hidden of [expired.turnId, deleted.turnId, randomUUID()]) {
      await request(app.getHttpServer())
        .get(`/admin/ai-quality/turns/${hidden}`)
        .set('Origin', ADMIN_ORIGIN)
        .set('Cookie', staffCookie(qualityReviewer))
        .expect(404);
    }
    await request(app.getHttpServer())
      .get('/admin/ai-quality/turns/not-a-uuid')
      .set('Origin', ADMIN_ORIGIN)
      .set('Cookie', staffCookie(qualityReviewer))
      .expect(400);

    for (const query of [
      `createdFrom=${encodeURIComponent(now.toISOString())}`,
      `createdFrom=${encodeURIComponent(now.toISOString())}&createdBefore=${encodeURIComponent(
        now.toISOString(),
      )}`,
      `createdFrom=${encodeURIComponent(
        new Date(now.getTime() - 32 * 24 * 60 * 60 * 1_000).toISOString(),
      )}&createdBefore=${encodeURIComponent(now.toISOString())}`,
      `createdFrom=${encodeURIComponent(now.toISOString())}&createdBefore=${encodeURIComponent(
        new Date(now.getTime() + 60_000).toISOString(),
      )}`,
    ]) {
      await request(app.getHttpServer())
        .get(`/admin/ai-quality/turns?${query}`)
        .set('Origin', ADMIN_ORIGIN)
        .set('Cookie', staffCookie(qualityReviewer))
        .expect(400);
    }
  });

  it('returns detail without linked identifiers and emits a readable bounded access Audit', async () => {
    const turn = await insertTurn({
      status: 'failed',
      failureCode: 'SAFETY_RESPONSE_PERSISTENCE_FAILED',
    });
    const detail = await request(app.getHttpServer())
      .get(`/admin/ai-quality/turns/${turn.turnId}`)
      .set('Origin', ADMIN_ORIGIN)
      .set('Cookie', staffCookie(qualityReviewer))
      .expect(200);
    expect(detail.body.data.turn).toMatchObject({
      turnId: turn.turnId,
      failureCategory: 'persistence',
    });

    const auditResponse = await request(app.getHttpServer())
      .get('/admin/audit-logs?action=ai_quality_metadata_accessed')
      .set('Origin', ADMIN_ORIGIN)
      .set('Cookie', staffCookie(auditReader))
      .expect(200);
    expect(auditResponse.body.data.records).toEqual([
      expect.objectContaining({
        actor: { type: 'staff', id: qualityReviewer.id },
        action: 'ai_quality_metadata_accessed',
        resource: { type: 'ai_turn', id: turn.turnId },
        safeMetadata: { accessCategory: 'detail', filterCategory: 'id', returnedCount: 1 },
      }),
    ]);
    expect(JSON.stringify(auditResponse.body)).not.toContain('persistence');
  });

  it('audits an empty list with the actual zero result count', async () => {
    const response = await request(app.getHttpServer())
      .get('/admin/ai-quality/turns?status=claimed')
      .set('Origin', ADMIN_ORIGIN)
      .set('Cookie', staffCookie(qualityReviewer))
      .expect(200);
    expect(response.body.data.turns).toEqual([]);
    const [audit] = await database.database
      .select()
      .from(auditLogs)
      .where(eq(auditLogs.action, 'ai_quality_metadata_accessed'));
    expect(audit).toMatchObject({
      resourceType: 'ai_turn_query',
      resourceId: qualityReviewer.id,
      safeMetadata: { accessCategory: 'list', filterCategory: 'status', returnedCount: 0 },
    });
  });

  it('withholds metadata when required Audit insertion fails or commit acknowledgement is lost', async () => {
    const turn = await insertTurn();
    const requiredAuditFailure = jest
      .spyOn(audits, 'appendRequiredWithinTransaction')
      .mockRejectedValueOnce(new Error('synthetic required Audit failure'));
    const failed = await request(app.getHttpServer())
      .get(`/admin/ai-quality/turns/${turn.turnId}`)
      .set('Origin', ADMIN_ORIGIN)
      .set('Cookie', staffCookie(qualityReviewer))
      .expect(500);
    expect(failed.body.data).toBeUndefined();
    expect(await accessAuditCount()).toBe(0);
    requiredAuditFailure.mockRestore();

    const originalTransaction = repository.readTransaction.bind(repository);
    const acknowledgementLoss = jest
      .spyOn(repository, 'readTransaction')
      .mockImplementationOnce(async (work) => {
        await originalTransaction(work);
        throw new Error('synthetic commit acknowledgement loss');
      });
    const unknown = await request(app.getHttpServer())
      .get(`/admin/ai-quality/turns/${turn.turnId}`)
      .set('Origin', ADMIN_ORIGIN)
      .set('Cookie', staffCookie(qualityReviewer))
      .expect(500);
    expect(unknown.body.data).toBeUndefined();
    expect(await accessAuditCount()).toBe(1);
    acknowledgementLoss.mockRestore();

    await request(app.getHttpServer())
      .get(`/admin/ai-quality/turns/${turn.turnId}`)
      .set('Origin', ADMIN_ORIGIN)
      .set('Cookie', staffCookie(qualityReviewer))
      .expect(200);
    expect(await accessAuditCount()).toBe(2);
  });

  it('returns one complete old snapshot when hard deletion overlaps a read and omits it thereafter', async () => {
    const turn = await insertTurn();
    const selected = deferred();
    const release = deferred();
    const originalList = repository.list.bind(repository);
    const barrier = jest
      .spyOn(repository, 'list')
      .mockImplementationOnce(
        async (...args: Parameters<AdminAiTurnMetadataRepository['list']>) => {
          selected.resolve();
          await release.promise;
          return originalList(...args);
        },
      );
    const inFlight = request(app.getHttpServer())
      .get('/admin/ai-quality/turns')
      .set('Origin', ADMIN_ORIGIN)
      .set('Cookie', staffCookie(qualityReviewer))
      .then((response) => response);
    try {
      await within(selected.promise, 'authorized AI Turn snapshot before selection');
      await database.database
        .delete(conversations)
        .where(eq(conversations.id, turn.conversationId));
      release.resolve();
      const completed = await within(inFlight, 'snapshot-first AI Turn response');
      expect(completed.status).toBe(200);
      expect(completed.body.data.turns.map((row: { turnId: string }) => row.turnId)).toContain(
        turn.turnId,
      );
    } finally {
      release.resolve();
      barrier.mockRestore();
      await Promise.allSettled([inFlight]);
    }

    expect(
      await database.database.select().from(aiTurns).where(eq(aiTurns.id, turn.turnId)),
    ).toHaveLength(0);
    await request(app.getHttpServer())
      .get(`/admin/ai-quality/turns/${turn.turnId}`)
      .set('Origin', ADMIN_ORIGIN)
      .set('Cookie', staffCookie(qualityReviewer))
      .expect(404);

    const purgeFirst = await insertTurn();
    await database.database
      .delete(conversations)
      .where(eq(conversations.id, purgeFirst.conversationId));
    const afterPurge = await request(app.getHttpServer())
      .get('/admin/ai-quality/turns')
      .set('Origin', ADMIN_ORIGIN)
      .set('Cookie', staffCookie(qualityReviewer))
      .expect(200);
    expect(afterPurge.body.data.turns.map((row: { turnId: string }) => row.turnId)).not.toContain(
      purgeFirst.turnId,
    );
  });

  it('allows only the authorized snapshot order and rejects the revoked Staff session thereafter', async () => {
    await insertTurn();
    const selected = deferred();
    const release = deferred();
    const originalList = repository.list.bind(repository);
    const barrier = jest
      .spyOn(repository, 'list')
      .mockImplementationOnce(
        async (...args: Parameters<AdminAiTurnMetadataRepository['list']>) => {
          selected.resolve();
          await release.promise;
          return originalList(...args);
        },
      );
    const inFlight = request(app.getHttpServer())
      .get('/admin/ai-quality/turns')
      .set('Origin', ADMIN_ORIGIN)
      .set('Cookie', staffCookie(qualityReviewer))
      .then((response) => response);
    try {
      await within(selected.promise, 'authorized AI metadata snapshot before selection');
      const current = await access.get(administrator, qualityReviewer.id);
      await access.revokeRole(
        administrator,
        qualityReviewer.id,
        'ai_quality_reviewer',
        current.authorizationRevision,
      );
      release.resolve();
      const completed = await within(inFlight, 'authorization-first AI metadata response');
      expect(completed.status).toBe(200);
    } finally {
      release.resolve();
      barrier.mockRestore();
      await Promise.allSettled([inFlight]);
    }

    await request(app.getHttpServer())
      .get('/admin/ai-quality/turns')
      .set('Origin', ADMIN_ORIGIN)
      .set('Cookie', staffCookie(qualityReviewer))
      .expect(401);
    await expect(service.list(qualityReviewer, { limit: 20 })).rejects.toMatchObject({
      statusCode: 403,
    });

    const current = await access.get(administrator, qualityReviewer.id);
    await access.grantRole(
      administrator,
      qualityReviewer.id,
      'ai_quality_reviewer',
      current.authorizationRevision,
    );
    qualityReviewer = await auth.login(qualityReviewerEmail, PASSWORD);
  });
});
