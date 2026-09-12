import { randomUUID } from 'node:crypto';
import { auditLogs, count, createDatabaseClient, eq, migrate } from '@mental-health/database';
import type { INestApplication } from '@nestjs/common';
import { Test, type TestingModule } from '@nestjs/testing';
import { resolve } from 'node:path';
import request from 'supertest';
import { AdminAuditReadRepository } from '../src/admin/admin-audit-read.repository';
import { AdminAuditReadService } from '../src/admin/admin-audit-read.service';
import { AdminKnowledgeService } from '../src/admin/admin-knowledge.service';
import { StaffAccessService } from '../src/admin/staff-access.service';
import { StaffAuthService, type CreatedStaffSession } from '../src/admin/staff-auth.service';
import { StaffBootstrapService } from '../src/admin/staff-bootstrap.service';
import { AppModule } from '../src/app.module';
import { createCorsOptions } from '../src/common/http/cors-options';
import { AppExceptionFilter } from '../src/common/filters/app-exception.filter';
import { encodeOpaqueCursor } from '../src/common/pagination/opaque-cursor';
import { env } from '../src/config/env';
import { DatabaseService } from '../src/database/database.service';
import { AuditLogRepository } from '../src/safety/audit/audit-log.repository';

const ADMIN_ORIGIN = 'http://localhost:5174';
const PASSWORD = 'Synthetic-Audit-Password-9!';

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

describe('Admin Audit Read backend', () => {
  let app: INestApplication;
  let moduleRef: TestingModule;
  let migrationClient: ReturnType<typeof createDatabaseClient>;
  let database: DatabaseService;
  let audits: AuditLogRepository;
  let repository: AdminAuditReadRepository;
  let service: AdminAuditReadService;
  let knowledge: AdminKnowledgeService;
  let access: StaffAccessService;
  let auth: StaffAuthService;
  let administrator: CreatedStaffSession;
  let reader: CreatedStaffSession;
  let knowledgeEditor: CreatedStaffSession;
  let readerEmail: string;

  async function insertStoredAudit(
    input: Partial<typeof auditLogs.$inferInsert> &
      Pick<typeof auditLogs.$inferInsert, 'action' | 'resourceType' | 'safeMetadata'>,
  ): Promise<typeof auditLogs.$inferSelect> {
    const occurredAt = input.occurredAt ?? new Date();
    const [row] = await database.database
      .insert(auditLogs)
      .values({
        id: input.id ?? randomUUID(),
        actorType: input.actorType ?? 'staff',
        actorId: input.actorId === undefined ? reader.id : input.actorId,
        action: input.action,
        resourceType: input.resourceType,
        resourceId: input.resourceId ?? randomUUID(),
        idempotencyKey: input.idempotencyKey ?? `synthetic-audit:${randomUUID()}`,
        occurredAt,
        safeMetadata: input.safeMetadata,
        retentionUntil:
          input.retentionUntil ?? new Date(occurredAt.getTime() + 30 * 24 * 60 * 60 * 1_000),
      })
      .returning();
    if (!row) throw new Error('Expected synthetic Audit row');
    return row;
  }

  async function auditCount(action = 'audit_log_accessed'): Promise<number> {
    const [row] = await database.database
      .select({ value: count() })
      .from(auditLogs)
      .where(eq(auditLogs.action, action));
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
    audits = moduleRef.get(AuditLogRepository);
    repository = moduleRef.get(AdminAuditReadRepository);
    service = moduleRef.get(AdminAuditReadService);
    knowledge = moduleRef.get(AdminKnowledgeService);
    access = moduleRef.get(StaffAccessService);
    auth = moduleRef.get(StaffAuthService);
    const bootstrap = moduleRef.get(StaffBootstrapService);

    const administratorEmail = 'audit-admin@example.test';
    await bootstrap.bootstrap({
      staffPrincipalId: randomUUID(),
      email: administratorEmail,
      password: PASSWORD,
    });
    administrator = await auth.login(administratorEmail, PASSWORD);

    readerEmail = 'audit-reader@example.test';
    const created = await access.create(administrator, {
      staffPrincipalId: randomUUID(),
      email: readerEmail,
      initialPassword: PASSWORD,
    });
    await access.grantRole(
      administrator,
      created.principal.id,
      'audit_reader',
      created.principal.authorizationRevision,
    );
    reader = await auth.login(readerEmail, PASSWORD);

    const editorEmail = 'audit-knowledge-editor@example.test';
    const editor = await access.create(administrator, {
      staffPrincipalId: randomUUID(),
      email: editorEmail,
      initialPassword: PASSWORD,
    });
    await access.grantRole(
      administrator,
      editor.principal.id,
      'knowledge_editor',
      editor.principal.authorizationRevision,
    );
    knowledgeEditor = await auth.login(editorEmail, PASSWORD);
  }, 90_000);

  beforeEach(async () => {
    await database.database.delete(auditLogs);
  });

  afterAll(async () => {
    env.ADMIN_AUTH_ENABLED = false;
    await app.close();
    await migrationClient.pool.end();
  });

  it('enforces the Admin boundary and database permission without requiring CSRF for GET', async () => {
    await insertStoredAudit({
      action: 'staff_principal_created',
      resourceType: 'staff_principal',
      safeMetadata: {},
    });

    await request(app.getHttpServer())
      .get('/admin/audit-logs')
      .set('Origin', ADMIN_ORIGIN)
      .set('Cookie', 'mh_session=ordinary-session')
      .expect(401);
    await request(app.getHttpServer())
      .get('/admin/audit-logs')
      .set('Origin', ADMIN_ORIGIN)
      .set('Cookie', staffCookie(administrator))
      .expect(403);
    await request(app.getHttpServer())
      .get('/admin/audit-logs')
      .set('Cookie', staffCookie(reader))
      .expect(403);
    await request(app.getHttpServer())
      .get('/admin/audit-logs')
      .set('Origin', 'http://localhost:5173')
      .set('Cookie', staffCookie(reader))
      .expect(403);

    const success = await request(app.getHttpServer())
      .get('/admin/audit-logs')
      .set('Origin', ADMIN_ORIGIN)
      .set('Cookie', staffCookie(reader))
      .expect('Cache-Control', 'private, no-store')
      .expect(200);
    expect(success.body.data.records).toHaveLength(1);
    expect(await auditCount()).toBe(1);

    await expect(
      service.list(
        { id: reader.id, sessionId: randomUUID(), authorizationRevision: 1 },
        { limit: 20 },
      ),
    ).rejects.toMatchObject({ statusCode: 403 });

    env.ADMIN_AUTH_ENABLED = false;
    await request(app.getHttpServer())
      .get('/admin/audit-logs')
      .set('Origin', ADMIN_ORIGIN)
      .set('Cookie', staffCookie(reader))
      .expect(503);
    await request(app.getHttpServer()).get('/health').expect(200);
    env.ADMIN_AUTH_ENABLED = true;
  });

  it('returns only the bounded Staff/Knowledge projection and excludes sensitive Audit domains', async () => {
    const visible = await insertStoredAudit({
      action: 'staff_role_granted',
      resourceType: 'staff_principal',
      safeMetadata: { roleKey: 'audit_reader', resultingAuthorizationRevision: 2 },
      idempotencyKey: 'must-not-leak',
    });
    await insertStoredAudit({
      actorType: 'user',
      actorId: randomUUID(),
      action: 'mood_entry_deleted',
      resourceType: 'mood_entry',
      safeMetadata: {},
    });
    await insertStoredAudit({
      actorType: 'system',
      actorId: null,
      action: 'risk_event_created',
      resourceType: 'risk_event',
      safeMetadata: {},
    });

    const response = await request(app.getHttpServer())
      .get('/admin/audit-logs')
      .set('Origin', ADMIN_ORIGIN)
      .set('Cookie', staffCookie(reader))
      .expect(200);
    expect(response.body.data.records).toEqual([
      {
        id: visible.id,
        actor: { type: 'staff', id: reader.id },
        action: 'staff_role_granted',
        resource: { type: 'staff_principal', id: visible.resourceId },
        occurredAt: visible.occurredAt.toISOString(),
        retentionUntil: visible.retentionUntil.toISOString(),
        safeMetadata: { roleKey: 'audit_reader', resultingAuthorizationRevision: 2 },
      },
    ]);
    const serialized = JSON.stringify(response.body);
    for (const forbidden of [
      'must-not-leak',
      'idempotencyKey',
      'mood_entry_deleted',
      'risk_event_created',
      'message',
      'prompt',
      'email',
      'cookie',
      'csrf',
    ]) {
      expect(serialized.toLowerCase()).not.toContain(forbidden.toLowerCase());
    }
  });

  it('reads the bounded shape emitted by an existing Staff access writer', async () => {
    await access.get(administrator, reader.id);

    const response = await request(app.getHttpServer())
      .get('/admin/audit-logs?action=staff_directory_accessed')
      .set('Origin', ADMIN_ORIGIN)
      .set('Cookie', staffCookie(reader))
      .expect(200);
    expect(response.body.data.records).toEqual([
      expect.objectContaining({
        actor: { type: 'staff', id: administrator.id },
        action: 'staff_directory_accessed',
        resource: { type: 'staff_principal_query', id: reader.id },
        safeMetadata: { filterCategory: 'id', returnedCount: 1 },
      }),
    ]);
  });

  it('reads the bounded shape emitted by an existing Knowledge access writer', async () => {
    await knowledge.list(knowledgeEditor, { limit: 20 });

    const response = await request(app.getHttpServer())
      .get('/admin/audit-logs?action=knowledge_directory_accessed')
      .set('Origin', ADMIN_ORIGIN)
      .set('Cookie', staffCookie(reader))
      .expect(200);
    expect(response.body.data.records).toEqual([
      expect.objectContaining({
        actor: { type: 'staff', id: knowledgeEditor.id },
        action: 'knowledge_directory_accessed',
        resource: {
          type: 'knowledge_article_query',
          id: '00000000-0000-0000-0000-000000000001',
        },
        safeMetadata: { filterCategory: 'all', returnedCount: 0 },
      }),
    ]);
  });

  it('fails the whole page for a malformed sentinel row and rolls back its access Audit', async () => {
    const now = new Date();
    await insertStoredAudit({
      action: 'staff_principal_created',
      resourceType: 'staff_principal',
      safeMetadata: {},
      occurredAt: now,
    });
    await insertStoredAudit({
      actorType: 'user',
      actorId: randomUUID(),
      action: 'staff_principal_created',
      resourceType: 'staff_principal',
      safeMetadata: { arbitrary: 'must-not-leak' },
      occurredAt: new Date(now.getTime() - 1_000),
    });

    const response = await request(app.getHttpServer())
      .get('/admin/audit-logs?action=staff_principal_created&limit=1')
      .set('Origin', ADMIN_ORIGIN)
      .set('Cookie', staffCookie(reader))
      .expect(500);
    expect(response.body.data).toBeUndefined();
    expect(JSON.stringify(response.body)).not.toContain('must-not-leak');
    expect(await auditCount()).toBe(0);
  });

  it('binds compact cursors to the fixed window and filters without duplicates', async () => {
    const occurredAt = new Date(Date.now() - 60_000);
    const ids = [randomUUID(), randomUUID(), randomUUID()].sort().reverse();
    for (const id of ids) {
      await insertStoredAudit({
        id,
        action: 'knowledge_publication_state_viewed',
        resourceType: 'knowledge_article_version',
        safeMetadata: { accessCategory: 'publication', version: 1 },
        occurredAt,
      });
    }

    const first = await request(app.getHttpServer())
      .get(
        '/admin/audit-logs?action=knowledge_publication_state_viewed&resourceType=knowledge_article_version&limit=1',
      )
      .set('Origin', ADMIN_ORIGIN)
      .set('Cookie', staffCookie(reader))
      .expect(200);
    expect(first.body.data.records.map((row: { id: string }) => row.id)).toEqual([ids[0]]);
    expect(first.body.data.nextCursor).toEqual(expect.any(String));
    expect(first.body.data.nextCursor.length).toBeLessThanOrEqual(512);

    const fixedCeilingId = randomUUID();
    await insertStoredAudit({
      id: fixedCeilingId,
      action: 'knowledge_publication_state_viewed',
      resourceType: 'knowledge_article_version',
      safeMetadata: { accessCategory: 'publication', version: 1 },
      occurredAt: new Date(first.body.data.period.occurredBefore),
    });

    const second = await request(app.getHttpServer())
      .get(`/admin/audit-logs?limit=2&cursor=${first.body.data.nextCursor}`)
      .set('Origin', ADMIN_ORIGIN)
      .set('Cookie', staffCookie(reader))
      .expect(200);
    expect(second.body.data.records.map((row: { id: string }) => row.id)).toEqual(ids.slice(1));
    expect(
      new Set([...first.body.data.records, ...second.body.data.records].map((row) => row.id)).size,
    ).toBe(3);
    expect(second.body.data.records.map((row: { id: string }) => row.id)).not.toContain(
      fixedCeilingId,
    );

    await request(app.getHttpServer())
      .get(`/admin/audit-logs?action=staff_principal_created&cursor=${first.body.data.nextCursor}`)
      .set('Origin', ADMIN_ORIGIN)
      .set('Cookie', staffCookie(reader))
      .expect(400);
    await request(app.getHttpServer())
      .get(`/admin/audit-logs?cursor=${first.body.data.nextCursor}.`)
      .set('Origin', ADMIN_ORIGIN)
      .set('Cookie', staffCookie(reader))
      .expect(400);

    const cursor = JSON.parse(
      Buffer.from(first.body.data.nextCursor, 'base64url').toString('utf8'),
    ) as Record<string, unknown>;
    const malformedCursors = [
      encodeOpaqueCursor({
        ...cursor,
        b: new Date(Date.now() + 60_000).toISOString(),
      }),
      encodeOpaqueCursor({
        ...cursor,
        m: 'd',
        f: new Date(Date.parse(String(cursor.b)) - 6 * 24 * 60 * 60 * 1_000).toISOString(),
      }),
      encodeOpaqueCursor({
        ...cursor,
        t: new Date(Date.parse(String(cursor.f)) - 1).toISOString(),
      }),
    ];
    for (const malformedCursor of malformedCursors) {
      await request(app.getHttpServer())
        .get(`/admin/audit-logs?cursor=${malformedCursor}`)
        .set('Origin', ADMIN_ORIGIN)
        .set('Cookie', staffCookie(reader))
        .expect(400);
    }

    await request(app.getHttpServer())
      .get(`/admin/audit-logs?resourceType=staff_principal&cursor=${first.body.data.nextCursor}`)
      .set('Origin', ADMIN_ORIGIN)
      .set('Cookie', staffCookie(reader))
      .expect(400);
    await request(app.getHttpServer())
      .get(
        `/admin/audit-logs?occurredFrom=${encodeURIComponent(
          new Date(Date.parse(first.body.data.period.occurredFrom) + 1).toISOString(),
        )}&occurredBefore=${encodeURIComponent(
          first.body.data.period.occurredBefore,
        )}&cursor=${first.body.data.nextCursor}`,
      )
      .set('Origin', ADMIN_ORIGIN)
      .set('Cookie', staffCookie(reader))
      .expect(400);
  });

  it('validates explicit time windows and hides expired rows before physical purge', async () => {
    const now = new Date();
    const visible = await insertStoredAudit({
      action: 'staff_principal_created',
      resourceType: 'staff_principal',
      safeMetadata: {},
      occurredAt: new Date(now.getTime() - 60_000),
      retentionUntil: new Date(now.getTime() + 60_000),
    });
    await insertStoredAudit({
      action: 'staff_principal_created',
      resourceType: 'staff_principal',
      safeMetadata: {},
      occurredAt: new Date(now.getTime() - 30_000),
      retentionUntil: now,
    });

    const response = await request(app.getHttpServer())
      .get(
        `/admin/audit-logs?action=staff_principal_created&occurredFrom=${encodeURIComponent(
          new Date(now.getTime() - 120_000).toISOString(),
        )}&occurredBefore=${encodeURIComponent(now.toISOString())}`,
      )
      .set('Origin', ADMIN_ORIGIN)
      .set('Cookie', staffCookie(reader))
      .expect(200);
    expect(response.body.data.records.map((row: { id: string }) => row.id)).toEqual([visible.id]);

    const invalidRanges = [
      `occurredFrom=${encodeURIComponent(now.toISOString())}`,
      `occurredFrom=${encodeURIComponent(now.toISOString())}&occurredBefore=${encodeURIComponent(
        now.toISOString(),
      )}`,
      `occurredFrom=${encodeURIComponent(
        new Date(now.getTime() - 32 * 24 * 60 * 60 * 1_000).toISOString(),
      )}&occurredBefore=${encodeURIComponent(now.toISOString())}`,
      `occurredFrom=${encodeURIComponent(now.toISOString())}&occurredBefore=${encodeURIComponent(
        new Date(now.getTime() + 60_000).toISOString(),
      )}`,
    ];
    for (const query of invalidRanges) {
      await request(app.getHttpServer())
        .get(`/admin/audit-logs?${query}`)
        .set('Origin', ADMIN_ORIGIN)
        .set('Cookie', staffCookie(reader))
        .expect(400);
    }
    await request(app.getHttpServer())
      .get('/admin/audit-logs?action=staff_role_granted&resourceType=knowledge_article_version')
      .set('Origin', ADMIN_ORIGIN)
      .set('Cookie', staffCookie(reader))
      .expect(400);
  });

  it('audits empty and subsequent pages exactly once without recursively reading itself', async () => {
    const first = await request(app.getHttpServer())
      .get('/admin/audit-logs?action=audit_log_accessed')
      .set('Origin', ADMIN_ORIGIN)
      .set('Cookie', staffCookie(reader))
      .expect(200);
    expect(first.body.data.records).toEqual([]);
    expect(await auditCount()).toBe(1);

    const second = await request(app.getHttpServer())
      .get('/admin/audit-logs?action=audit_log_accessed')
      .set('Origin', ADMIN_ORIGIN)
      .set('Cookie', staffCookie(reader))
      .expect(200);
    expect(second.body.data.records).toHaveLength(1);
    expect(second.body.data.records[0]).toMatchObject({
      action: 'audit_log_accessed',
      resource: { type: 'audit_log_query', id: reader.id },
      safeMetadata: { filterCategory: 'action', pageKind: 'initial', returnedCount: 0 },
    });
    expect(await auditCount()).toBe(2);
  });

  it('withholds a page when the required access Audit is not inserted', async () => {
    await insertStoredAudit({
      action: 'staff_principal_created',
      resourceType: 'staff_principal',
      safeMetadata: {},
    });
    const failure = jest
      .spyOn(audits, 'appendRequiredWithinTransaction')
      .mockRejectedValueOnce(new Error('synthetic required Audit failure'));
    try {
      const response = await request(app.getHttpServer())
        .get('/admin/audit-logs')
        .set('Origin', ADMIN_ORIGIN)
        .set('Cookie', staffCookie(reader))
        .expect(500);
      expect(response.body.data).toBeUndefined();
    } finally {
      failure.mockRestore();
    }
    expect(await auditCount()).toBe(0);

    const idempotencyKey = `required-audit:${randomUUID()}`;
    const input = {
      actorType: 'staff' as const,
      actorId: reader.id,
      action: 'audit_log_accessed' as const,
      resourceType: 'audit_log_query' as const,
      resourceId: reader.id,
      idempotencyKey,
      safeMetadata: { filterCategory: 'all', pageKind: 'initial', returnedCount: 0 },
      occurredAt: new Date(),
    };
    await expect(
      repository.readTransaction(async (tx) => {
        await audits.appendRequiredWithinTransaction(tx, input);
        await audits.appendRequiredWithinTransaction(tx, input);
      }),
    ).rejects.toThrow('Required access audit was not inserted');
    const [rolledBack] = await database.database
      .select({ value: count() })
      .from(auditLogs)
      .where(eq(auditLogs.idempotencyKey, idempotencyKey));
    expect(rolledBack?.value).toBe(0);
  });

  it('reports commit acknowledgement loss without claiming rollback and permits a newly audited retry', async () => {
    await insertStoredAudit({
      action: 'staff_principal_created',
      resourceType: 'staff_principal',
      safeMetadata: {},
    });
    const original = repository.readTransaction.bind(repository);
    const acknowledgementLoss = jest
      .spyOn(repository, 'readTransaction')
      .mockImplementationOnce(async (work) => {
        await original(work);
        throw new Error('synthetic commit acknowledgement loss');
      });
    try {
      const unknown = await request(app.getHttpServer())
        .get('/admin/audit-logs')
        .set('Origin', ADMIN_ORIGIN)
        .set('Cookie', staffCookie(reader))
        .expect(500);
      expect(unknown.body.data).toBeUndefined();
    } finally {
      acknowledgementLoss.mockRestore();
    }
    expect(await auditCount()).toBe(1);

    await request(app.getHttpServer())
      .get('/admin/audit-logs')
      .set('Origin', ADMIN_ORIGIN)
      .set('Cookie', staffCookie(reader))
      .expect(200);
    expect(await auditCount()).toBe(2);
  });

  it('uses a complete PostgreSQL snapshot when purge overlaps the read', async () => {
    const now = new Date();
    const target = await insertStoredAudit({
      action: 'staff_principal_created',
      resourceType: 'staff_principal',
      safeMetadata: {},
      occurredAt: new Date(now.getTime() - 60_000),
      retentionUntil: new Date(now.getTime() + 60_000),
    });
    const selected = deferred();
    const release = deferred();
    const originalList = repository.list.bind(repository);
    const listBarrier = jest
      .spyOn(repository, 'list')
      .mockImplementationOnce(async (...args: Parameters<AdminAuditReadRepository['list']>) => {
        selected.resolve();
        await release.promise;
        return originalList(...args);
      });
    const inFlight = request(app.getHttpServer())
      .get('/admin/audit-logs?action=staff_principal_created')
      .set('Origin', ADMIN_ORIGIN)
      .set('Cookie', staffCookie(reader))
      .then((response) => response);
    try {
      await within(selected.promise, 'authorized Audit snapshot before data selection');
      expect(await audits.purgeExpired(new Date(now.getTime() + 120_000), 10)).toBe(1);
      release.resolve();
      const completed = await within(inFlight, 'snapshot-first Audit response');
      expect(completed.status).toBe(200);
      expect(completed.body.data.records.map((row: { id: string }) => row.id)).toContain(target.id);
    } finally {
      release.resolve();
      listBarrier.mockRestore();
      await Promise.allSettled([inFlight]);
    }

    const afterPurge = await request(app.getHttpServer())
      .get('/admin/audit-logs?action=staff_principal_created')
      .set('Origin', ADMIN_ORIGIN)
      .set('Cookie', staffCookie(reader))
      .expect(200);
    expect(afterPurge.body.data.records).toEqual([]);

    const purgeFirst = await insertStoredAudit({
      action: 'staff_principal_created',
      resourceType: 'staff_principal',
      safeMetadata: {},
      retentionUntil: new Date(now.getTime() + 60_000),
    });
    expect(await audits.purgeExpired(new Date(now.getTime() + 120_000), 10)).toBeGreaterThan(0);
    const omitted = await request(app.getHttpServer())
      .get('/admin/audit-logs?action=staff_principal_created')
      .set('Origin', ADMIN_ORIGIN)
      .set('Cookie', staffCookie(reader))
      .expect(200);
    expect(omitted.body.data.records.map((row: { id: string }) => row.id)).not.toContain(
      purgeFirst.id,
    );
  });

  it('allows only the authorized snapshot order and rejects the revoked Staff session thereafter', async () => {
    await insertStoredAudit({
      action: 'staff_principal_created',
      resourceType: 'staff_principal',
      safeMetadata: {},
    });
    const selected = deferred();
    const release = deferred();
    const originalList = repository.list.bind(repository);
    const barrier = jest
      .spyOn(repository, 'list')
      .mockImplementationOnce(async (...args: Parameters<AdminAuditReadRepository['list']>) => {
        selected.resolve();
        await release.promise;
        return originalList(...args);
      });
    const inFlight = request(app.getHttpServer())
      .get('/admin/audit-logs')
      .set('Origin', ADMIN_ORIGIN)
      .set('Cookie', staffCookie(reader))
      .then((response) => response);
    try {
      await within(selected.promise, 'authorized Audit snapshot before data selection');
      const current = await access.get(administrator, reader.id);
      await access.revokeRole(
        administrator,
        reader.id,
        'audit_reader',
        current.authorizationRevision,
      );
      release.resolve();
      const completed = await within(inFlight, 'authorization-first Audit response');
      expect(completed.status).toBe(200);
    } finally {
      release.resolve();
      barrier.mockRestore();
      await Promise.allSettled([inFlight]);
    }

    await request(app.getHttpServer())
      .get('/admin/audit-logs')
      .set('Origin', ADMIN_ORIGIN)
      .set('Cookie', staffCookie(reader))
      .expect(401);
    await expect(service.list(reader, { limit: 20 })).rejects.toMatchObject({ statusCode: 403 });

    const current = await access.get(administrator, reader.id);
    await access.grantRole(administrator, reader.id, 'audit_reader', current.authorizationRevision);
    reader = await auth.login(readerEmail, PASSWORD);
  });
});
