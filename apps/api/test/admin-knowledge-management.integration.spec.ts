import { randomUUID } from 'node:crypto';
import {
  auditLogs,
  createDatabaseClient,
  eq,
  knowledgeArticles,
  knowledgeArticleVersions,
  migrate,
} from '@mental-health/database';
import type { INestApplication } from '@nestjs/common';
import { Test, type TestingModule } from '@nestjs/testing';
import { resolve } from 'node:path';
import request from 'supertest';
import { AdminKnowledgeRepository } from '../src/admin/admin-knowledge.repository';
import { AdminKnowledgeService } from '../src/admin/admin-knowledge.service';
import { StaffAccessService } from '../src/admin/staff-access.service';
import type { StaffRole } from '../src/admin/staff-access.types';
import { StaffAuthService } from '../src/admin/staff-auth.service';
import { StaffBootstrapService } from '../src/admin/staff-bootstrap.service';
import { AppModule } from '../src/app.module';
import { AuthorizationError } from '../src/common/errors';
import { AppExceptionFilter } from '../src/common/filters/app-exception.filter';
import { createCorsOptions } from '../src/common/http/cors-options';
import { env } from '../src/config/env';
import { DatabaseService } from '../src/database/database.service';
import { KnowledgeFixtureService } from '../src/knowledge/knowledge-fixture.service';
import { KnowledgePublicationRepository } from '../src/knowledge/knowledge-publication.repository';
import { KnowledgePublicationService } from '../src/knowledge/knowledge-publication.service';
import { AuditLogRepository } from '../src/safety/audit/audit-log.repository';

const ADMIN_ORIGIN = 'http://localhost:5174';
const WEB_ORIGIN = 'http://localhost:5173';
const PASSWORD = 'Synthetic-Knowledge-Staff-9!';

type StaffSession = Awaited<ReturnType<StaffAuthService['login']>>;

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}

async function withTimeout<T>(promise: Promise<T>, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
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

function candidate(marker: string) {
  return {
    title: `合成知识标题 ${marker}`,
    summary: `合成知识摘要 ${marker}`,
    contentBlocks: [
      { type: 'heading' as const, level: 2 as const, text: `合成章节 ${marker}` },
      { type: 'paragraph' as const, text: `<script>synthetic-${marker}()</script>` },
    ],
    sources: [
      {
        publisherName: `合成来源发布者 ${marker}`,
        sourceTitle: `合成来源标题 ${marker}`,
        sourceUrl: `https://source.test.invalid/${marker}`,
        sourcePublishedAt: null,
        sourceVersionLabel: `fixture-${marker}`,
        sourceLocator: 'section-1',
        retrievedAt: '2026-09-12T01:00:00.000Z',
      },
    ],
  };
}

describe('Phase 6 Batch 3 Admin Knowledge Management backend', () => {
  let app: INestApplication;
  let moduleRef: TestingModule;
  let migrationClient: ReturnType<typeof createDatabaseClient>;
  let database: DatabaseService;
  let bootstrap: StaffBootstrapService;
  let auth: StaffAuthService;
  let access: StaffAccessService;
  let service: AdminKnowledgeService;
  let repository: AdminKnowledgeRepository;
  let audits: AuditLogRepository;
  let publication: KnowledgePublicationService;
  let publicationRepository: KnowledgePublicationRepository;
  let fixtures: KnowledgeFixtureService;
  let administrator: StaffSession;
  let editor: StaffSession;
  let reviewer: StaffSession;
  let publisher: StaffSession;

  async function createStaff(email: string, role: StaffRole): Promise<StaffSession> {
    const created = await access.create(administrator, {
      staffPrincipalId: randomUUID(),
      email,
      initialPassword: PASSWORD,
    });
    await access.grantRole(administrator, created.principal.id, role, 1);
    return auth.login(email, PASSWORD);
  }

  function mutationHeaders(agent: request.Test, session: StaffSession): request.Test {
    return agent
      .set('Origin', ADMIN_ORIGIN)
      .set('Cookie', staffCookie(session))
      .set('x-staff-csrf-token', session.csrfToken);
  }

  function createDraft(articleKey: string, version: number, marker: string) {
    return mutationHeaders(
      request(app.getHttpServer()).post(
        `/admin/knowledge/articles/${articleKey}/versions/${version}`,
      ),
      editor,
    ).send(candidate(marker));
  }

  function verifySources(articleKey: string, version: number, revision: number) {
    return mutationHeaders(
      request(app.getHttpServer()).post(
        `/admin/knowledge/articles/${articleKey}/versions/${version}/source-review`,
      ),
      reviewer,
    ).send({ expectedDraftRevision: revision, confirmation: 'source_verified' });
  }

  function publishVersion(articleKey: string, version: number, revision: number) {
    return mutationHeaders(
      request(app.getHttpServer()).post(
        `/admin/knowledge/articles/${articleKey}/versions/${version}/publish`,
      ),
      publisher,
    ).send({ expectedDraftRevision: revision });
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
    service = moduleRef.get(AdminKnowledgeService);
    repository = moduleRef.get(AdminKnowledgeRepository);
    audits = moduleRef.get(AuditLogRepository);
    publication = moduleRef.get(KnowledgePublicationService);
    publicationRepository = moduleRef.get(KnowledgePublicationRepository);
    fixtures = moduleRef.get(KnowledgeFixtureService);

    const adminEmail = 'admin-knowledge-root@example.test';
    await bootstrap.bootstrap({
      staffPrincipalId: randomUUID(),
      email: adminEmail,
      password: PASSWORD,
    });
    administrator = await auth.login(adminEmail, PASSWORD);
    editor = await createStaff('knowledge-editor@example.test', 'knowledge_editor');
    reviewer = await createStaff(
      'knowledge-source-reviewer@example.test',
      'knowledge_source_reviewer',
    );
    publisher = await createStaff('knowledge-publisher@example.test', 'knowledge_publisher');
  }, 90_000);

  beforeEach(async () => {
    await database.database.delete(knowledgeArticles);
    await database.database.delete(auditLogs);
  });

  afterAll(async () => {
    env.ADMIN_AUTH_ENABLED = false;
    await app.close();
    await migrationClient.pool.end();
  });

  it('enforces the Staff domain, trusted origin, CSRF, exact roles, and service authorization', async () => {
    await request(app.getHttpServer())
      .get('/admin/knowledge/articles')
      .set('Origin', ADMIN_ORIGIN)
      .set('Cookie', 'mh_session=ordinary-session')
      .expect(401);
    await request(app.getHttpServer())
      .get('/admin/knowledge/articles')
      .set('Origin', WEB_ORIGIN)
      .set('Cookie', staffCookie(editor))
      .expect(403);
    await request(app.getHttpServer())
      .get('/admin/knowledge/articles')
      .set('Origin', ADMIN_ORIGIN)
      .set('Cookie', staffCookie(administrator))
      .expect(403);
    await request(app.getHttpServer())
      .post('/admin/knowledge/articles/role-boundary/versions/1')
      .set('Origin', ADMIN_ORIGIN)
      .set('Cookie', staffCookie(editor))
      .send(candidate('role-boundary'))
      .expect(403);
    await createDraft('role-boundary', 1, 'role-boundary').expect(201);
    const status = await request(app.getHttpServer())
      .get('/admin/knowledge/articles/role-boundary/versions/1/status')
      .set('Origin', ADMIN_ORIGIN)
      .set('Cookie', staffCookie(reviewer))
      .expect('Cache-Control', 'private, no-store')
      .expect(200);
    await mutationHeaders(
      request(app.getHttpServer()).post(
        '/admin/knowledge/articles/role-boundary/versions/1/publish',
      ),
      reviewer,
    )
      .send({ expectedDraftRevision: status.body.data.state.draftRevision })
      .expect(403);
    await expect(
      service.list(
        { id: editor.id, sessionId: randomUUID(), authorizationRevision: 2 },
        { limit: 20 },
      ),
    ).rejects.toBeInstanceOf(AuthorizationError);
  });

  it('creates exact candidates idempotently and serializes concurrent first submissions', async () => {
    const key = 'exact-create-retry';
    const first = await createDraft(key, 1, 'exact').expect(201);
    const revision = first.body.data.state.draftRevision;
    expect(revision).toBeGreaterThan(1);
    const replay = await createDraft(key, 1, 'exact').expect(201);
    expect(replay.body.data).toEqual(
      expect.objectContaining({ disposition: 'no_change', state: { ...first.body.data.state } }),
    );
    await createDraft(key, 1, 'different').expect(409);

    const concurrentKey = 'concurrent-create';
    const attempts = await Promise.all(
      Array.from({ length: 12 }, () => createDraft(concurrentKey, 1, 'same')),
    );
    expect(attempts.filter((response) => response.status === 201)).toHaveLength(12);
    expect(
      attempts.filter((response) => response.body.data.disposition === 'applied'),
    ).toHaveLength(1);
    const [article] = await database.database
      .select({ id: knowledgeArticles.id })
      .from(knowledgeArticles)
      .where(eq(knowledgeArticles.articleKey, concurrentKey));
    const rows = await database.database
      .select()
      .from(knowledgeArticleVersions)
      .where(eq(knowledgeArticleVersions.articleId, article!.id));
    expect(rows).toHaveLength(1);
  });

  it('uses a strict opaque revision and a real row-lock barrier between edit and review', async () => {
    const key = 'edit-review-race';
    const created = await createDraft(key, 1, 'before').expect(201);
    const revision = created.body.data.state.draftRevision as number;
    const replacementEntered = deferred();
    const releaseReplacement = deferred();
    const originalReplace = repository.replaceCandidate.bind(repository);
    const spy = jest
      .spyOn(repository, 'replaceCandidate')
      .mockImplementationOnce(async (...args) => {
        replacementEntered.resolve();
        await releaseReplacement.promise;
        return originalReplace(...args);
      });
    try {
      const replacement = mutationHeaders(
        request(app.getHttpServer()).put(`/admin/knowledge/articles/${key}/versions/1/draft`),
        editor,
      ).send({ expectedDraftRevision: revision, candidate: candidate('after') });
      const replacementPromise = replacement.then((value) => value);
      await withTimeout(replacementEntered.promise, 'replacement transaction barrier');
      const reviewPromise = verifySources(key, 1, revision).then((value) => value);
      await withTimeout(waitForKnowledgeLockWaiter(migrationClient), 'review row-lock wait');
      releaseReplacement.resolve();
      const [updated, review] = await Promise.all([replacementPromise, reviewPromise]);
      expect(updated.status).toBe(200);
      expect(updated.body.data.state.draftRevision).toBeGreaterThan(revision);
      expect(review.status).toBe(409);
      await mutationHeaders(
        request(app.getHttpServer()).put(`/admin/knowledge/articles/${key}/versions/1/draft`),
        editor,
      )
        .send({ expectedDraftRevision: revision, candidate: candidate('after') })
        .expect(409);
    } finally {
      releaseReplacement.resolve();
      spy.mockRestore();
    }
  });

  it('freezes reviewed evidence, preserves reviewer identity, and omits source URLs for publishers', async () => {
    const key = 'review-freeze';
    const created = await createDraft(key, 1, 'review').expect(201);
    const revision = created.body.data.state.draftRevision as number;
    const verified = await verifySources(key, 1, revision).expect(201);
    expect(verified.body.data).toEqual(
      expect.objectContaining({
        disposition: 'applied',
        reviewedBy: reviewer.id,
        draftRevision: revision,
      }),
    );
    const replay = await verifySources(key, 1, revision).expect(201);
    expect(replay.body.data).toEqual({ ...verified.body.data, disposition: 'no_change' });
    await mutationHeaders(
      request(app.getHttpServer()).put(`/admin/knowledge/articles/${key}/versions/1/draft`),
      editor,
    )
      .send({ expectedDraftRevision: revision, candidate: candidate('forbidden') })
      .expect(409);
    const state = await request(app.getHttpServer())
      .get(`/admin/knowledge/articles/${key}/versions/1/publication-state`)
      .set('Origin', ADMIN_ORIGIN)
      .set('Cookie', staffCookie(publisher))
      .expect(200);
    expect(state.body.data.sources[0]).not.toHaveProperty('sourceUrl');
    expect(state.body.data.reviewedBy).toBe(reviewer.id);
  });

  it('publishes predecessors despite higher drafts and scopes old withdrawal retries', async () => {
    const key = 'ordered-publication';
    const first = await createDraft(key, 1, 'v1').expect(201);
    const firstRevision = first.body.data.state.draftRevision as number;
    const firstReview = await verifySources(key, 1, firstRevision).expect(201);
    const second = await createDraft(key, 2, 'v2').expect(201);
    const secondRevision = second.body.data.state.draftRevision as number;
    await verifySources(key, 2, secondRevision).expect(201);
    await publishVersion(key, 2, secondRevision).expect(409);

    const manifest = {
      articleKey: key,
      version: 1,
      ...candidate('v1'),
      contentOrigin: 'curated' as const,
      reviewStatus: 'source_verified' as const,
      reviewedBy: reviewer.id,
      reviewedAt: firstReview.body.data.reviewedAt as string,
    };
    await expect(publication.publishCurated(manifest)).resolves.toEqual(
      expect.objectContaining({ version: 1, disposition: 'published' }),
    );
    await publishVersion(key, 2, secondRevision).expect(201);
    const oldRetry = await mutationHeaders(
      request(app.getHttpServer()).post(`/admin/knowledge/articles/${key}/versions/1/withdraw`),
      publisher,
    )
      .send({ expectedDraftRevision: firstRevision })
      .expect(201);
    expect(oldRetry.body.data.disposition).toBe('no_change');
    const secondStatus = await request(app.getHttpServer())
      .get(`/admin/knowledge/articles/${key}/versions/2/status`)
      .set('Origin', ADMIN_ORIGIN)
      .set('Cookie', staffCookie(publisher))
      .expect(200);
    expect(secondStatus.body.data.state.publicationStatus).toBe('published');

    const third = await createDraft(key, 3, 'v3').expect(201);
    const thirdRevision = third.body.data.state.draftRevision as number;
    await verifySources(key, 3, thirdRevision).expect(201);
    await mutationHeaders(
      request(app.getHttpServer()).post(`/admin/knowledge/articles/${key}/versions/3/withdraw`),
      publisher,
    )
      .send({ expectedDraftRevision: thirdRevision })
      .expect(201);
    await publishVersion(key, 3, thirdRevision).expect(409);
  });

  it('serializes CLI and Staff HTTP publication in both lock orders', async () => {
    async function prepare(key: string, marker: string) {
      const created = await createDraft(key, 1, marker).expect(201);
      const draftRevision = created.body.data.state.draftRevision as number;
      const reviewed = await verifySources(key, 1, draftRevision).expect(201);
      return {
        draftRevision,
        manifest: {
          articleKey: key,
          version: 1,
          ...candidate(marker),
          contentOrigin: 'curated' as const,
          reviewStatus: 'source_verified' as const,
          reviewedBy: reviewer.id,
          reviewedAt: reviewed.body.data.reviewedAt as string,
        },
      };
    }

    const httpFirst = await prepare('http-first-publication', 'http-first');
    const httpEntered = deferred();
    const releaseHttp = deferred();
    const originalAdminPublish = repository.markPublished.bind(repository);
    const httpSpy = jest
      .spyOn(repository, 'markPublished')
      .mockImplementationOnce(async (...args) => {
        httpEntered.resolve();
        await releaseHttp.promise;
        return originalAdminPublish(...args);
      });
    try {
      const http = publishVersion('http-first-publication', 1, httpFirst.draftRevision).then(
        (value) => value,
      );
      await withTimeout(httpEntered.promise, 'HTTP publication barrier');
      const cli = publication.publishCurated(httpFirst.manifest);
      await withTimeout(waitForKnowledgeLockWaiter(migrationClient), 'CLI publication lock');
      releaseHttp.resolve();
      await expect(http).resolves.toMatchObject({ status: 201 });
      await expect(cli).resolves.toMatchObject({ disposition: 'existing', version: 1 });
    } finally {
      releaseHttp.resolve();
      httpSpy.mockRestore();
    }

    const cliFirst = await prepare('cli-first-publication', 'cli-first');
    const cliEntered = deferred();
    const releaseCli = deferred();
    const originalCliPublish = publicationRepository.publishDraft.bind(publicationRepository);
    const cliSpy = jest
      .spyOn(publicationRepository, 'publishDraft')
      .mockImplementationOnce(async (...args) => {
        cliEntered.resolve();
        await releaseCli.promise;
        return originalCliPublish(...args);
      });
    try {
      const cli = publication.publishCurated(cliFirst.manifest);
      await withTimeout(cliEntered.promise, 'CLI publication barrier');
      const http = publishVersion('cli-first-publication', 1, cliFirst.draftRevision).then(
        (value) => value,
      );
      await withTimeout(waitForKnowledgeLockWaiter(migrationClient), 'HTTP publication lock');
      releaseCli.resolve();
      await expect(cli).resolves.toMatchObject({ disposition: 'published', version: 1 });
      const httpResponse = await http;
      expect(httpResponse.status).toBe(201);
      expect(httpResponse.body.data.disposition).toBe('no_change');
    } finally {
      releaseCli.resolve();
      cliSpy.mockRestore();
    }
  });

  it('rolls back mutations and withholds sensitive reads when Audit persistence fails', async () => {
    const key = 'audit-atomicity';
    const mutationFailure = jest
      .spyOn(audits, 'appendWithinTransaction')
      .mockRejectedValueOnce(new Error('synthetic audit failure'));
    await createDraft(key, 1, 'secret-candidate').expect(500);
    mutationFailure.mockRestore();
    expect(
      await database.database
        .select()
        .from(knowledgeArticles)
        .where(eq(knowledgeArticles.articleKey, key)),
    ).toHaveLength(0);

    await createDraft(key, 1, 'secret-candidate').expect(201);
    const readFailure = jest
      .spyOn(audits, 'appendWithinTransaction')
      .mockRejectedValueOnce(new Error('synthetic audit failure'));
    const response = await request(app.getHttpServer())
      .get(`/admin/knowledge/articles/${key}/versions/1/draft`)
      .set('Origin', ADMIN_ORIGIN)
      .set('Cookie', staffCookie(editor))
      .expect(500);
    readFailure.mockRestore();
    expect(JSON.stringify(response.body)).not.toContain('secret-candidate');

    const rows = await database.database
      .select()
      .from(auditLogs)
      .where(eq(auditLogs.resourceType, 'knowledge_article_version'));
    expect(rows.length).toBeGreaterThan(0);
    expect(JSON.stringify(rows)).not.toMatch(/secret-candidate|source\.test\.invalid|<script>/u);
  });

  it('reports an unknown result only after work completed when commit acknowledgement is lost', async () => {
    const key = 'commit-acknowledgement-loss';
    const originalTransaction = repository.transaction.bind(repository);
    const spy = jest.spyOn(repository, 'transaction').mockImplementationOnce(async (work) => {
      const committed = await originalTransaction(work);
      void committed;
      throw new Error('synthetic lost commit acknowledgement');
    });
    try {
      const unknown = await createDraft(key, 1, 'ack-loss').expect(503);
      expect(unknown.body).toEqual({
        success: false,
        error: expect.objectContaining({ code: 'ADMIN_KNOWLEDGE_RESULT_UNKNOWN' }),
      });
    } finally {
      spy.mockRestore();
    }
    const status = await request(app.getHttpServer())
      .get(`/admin/knowledge/articles/${key}/versions/1/status`)
      .set('Origin', ADMIN_ORIGIN)
      .set('Cookie', staffCookie(editor))
      .expect(200);
    expect(status.body.data.state.publicationStatus).toBe('draft');
    const replay = await createDraft(key, 1, 'ack-loss').expect(201);
    expect(replay.body.data.disposition).toBe('no_change');
    const versions = await database.database.select().from(knowledgeArticleVersions);
    expect(versions).toHaveLength(1);
  });

  it('keeps protected synthetic fixtures outside every Admin HTTP projection', async () => {
    await fixtures.publishSynthetic({
      articleKey: 'protected-synthetic-fixture',
      version: 1,
      ...candidate('synthetic'),
      contentOrigin: 'synthetic_fixture',
      reviewStatus: 'unverified',
      reviewedBy: null,
      reviewedAt: null,
    });
    const directory = await request(app.getHttpServer())
      .get('/admin/knowledge/articles')
      .set('Origin', ADMIN_ORIGIN)
      .set('Cookie', staffCookie(editor))
      .expect(200);
    expect(directory.body.data.items).toEqual([]);
    await request(app.getHttpServer())
      .get('/admin/knowledge/articles/protected-synthetic-fixture/versions/1/status')
      .set('Origin', ADMIN_ORIGIN)
      .set('Cookie', staffCookie(editor))
      .expect(404);
  });
});

async function waitForKnowledgeLockWaiter(
  client: ReturnType<typeof createDatabaseClient>,
): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    const result = await client.pool.query<{ count: number }>(
      `SELECT count(*)::int AS count FROM pg_stat_activity
       WHERE pid <> pg_backend_pid()
         AND wait_event_type = 'Lock'
         AND query ILIKE '%knowledge_articles%'`,
    );
    if ((result.rows[0]?.count ?? 0) > 0) return;
    await new Promise<void>((settle) => setImmediate(settle));
  }
  throw new Error('Timed out waiting for the Knowledge article row-lock waiter');
}
