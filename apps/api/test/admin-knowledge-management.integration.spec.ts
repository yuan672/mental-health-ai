import { randomUUID } from 'node:crypto';
import {
  auditLogs,
  createDatabaseClient,
  eq,
  knowledgeArticles,
  knowledgeArticleSources,
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
import { AuthorizationError, KnowledgePublicationConflictError } from '../src/common/errors';
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
    const publishedFirst = await publication.publishCurated(manifest);
    expect(publishedFirst).toEqual(
      expect.objectContaining({ version: 1, disposition: 'published' }),
    );
    await expect(publication.publishCurated(manifest)).resolves.toEqual({
      ...publishedFirst,
      disposition: 'existing',
    });
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

  it('rejects CLI creation past every unresolved predecessor and resumes only after retirement', async () => {
    const unresolvedKey = 'cli-new-target-unresolved';
    await createDraft(unresolvedKey, 1, 'unresolved-v1').expect(201);
    await expect(
      publication.publishCurated({
        articleKey: unresolvedKey,
        version: 2,
        ...candidate('unresolved-v2'),
        contentOrigin: 'curated',
        reviewStatus: 'source_verified',
        reviewedBy: 'synthetic-cli-reviewer',
        reviewedAt: '2026-09-12T02:00:00.000Z',
      }),
    ).rejects.toBeInstanceOf(KnowledgePublicationConflictError);
    const unresolvedRows = await database.database
      .select({ version: knowledgeArticleVersions.version })
      .from(knowledgeArticleVersions)
      .innerJoin(knowledgeArticles, eq(knowledgeArticles.id, knowledgeArticleVersions.articleId))
      .where(eq(knowledgeArticles.articleKey, unresolvedKey));
    expect(unresolvedRows).toEqual([{ version: 1 }]);

    const orderedKey = 'cli-new-target-retired-predecessor';
    const first = await createDraft(orderedKey, 1, 'ordered-v1').expect(201);
    const firstRevision = first.body.data.state.draftRevision as number;
    await verifySources(orderedKey, 1, firstRevision).expect(201);
    await publishVersion(orderedKey, 1, firstRevision).expect(201);
    const second = await createDraft(orderedKey, 2, 'ordered-v2').expect(201);
    const secondRevision = second.body.data.state.draftRevision as number;
    await verifySources(orderedKey, 2, secondRevision).expect(201);
    const thirdManifest = {
      articleKey: orderedKey,
      version: 3,
      ...candidate('ordered-v3'),
      contentOrigin: 'curated' as const,
      reviewStatus: 'source_verified' as const,
      reviewedBy: 'synthetic-cli-reviewer',
      reviewedAt: '2026-09-12T03:00:00.000Z',
    };
    await expect(publication.publishCurated(thirdManifest)).rejects.toBeInstanceOf(
      KnowledgePublicationConflictError,
    );
    await mutationHeaders(
      request(app.getHttpServer()).post(
        `/admin/knowledge/articles/${orderedKey}/versions/2/withdraw`,
      ),
      publisher,
    )
      .send({ expectedDraftRevision: secondRevision })
      .expect(201);
    await expect(publication.publishCurated(thirdManifest)).resolves.toMatchObject({
      disposition: 'published',
      version: 3,
    });
  });

  it('serializes new-target CLI publication with predecessor resolution in both lock orders', async () => {
    async function prepareSequence(key: string) {
      const first = await createDraft(key, 1, `${key}-v1`).expect(201);
      const firstRevision = first.body.data.state.draftRevision as number;
      await verifySources(key, 1, firstRevision).expect(201);
      await publishVersion(key, 1, firstRevision).expect(201);
      const second = await createDraft(key, 2, `${key}-v2`).expect(201);
      const secondRevision = second.body.data.state.draftRevision as number;
      await verifySources(key, 2, secondRevision).expect(201);
      return {
        secondRevision,
        thirdManifest: {
          articleKey: key,
          version: 3,
          ...candidate(`${key}-v3`),
          contentOrigin: 'curated' as const,
          reviewStatus: 'source_verified' as const,
          reviewedBy: 'synthetic-cli-reviewer',
          reviewedAt: '2026-09-12T03:30:00.000Z',
        },
      };
    }

    const cliFirst = await prepareSequence('new-target-cli-first');
    const cliObservedPredecessor = deferred();
    const releaseCli = deferred();
    const originalListVersions = publicationRepository.listVersions.bind(publicationRepository);
    const cliSpy = jest
      .spyOn(publicationRepository, 'listVersions')
      .mockImplementationOnce(async (...args) => {
        const versions = await originalListVersions(...args);
        cliObservedPredecessor.resolve();
        await releaseCli.promise;
        return versions;
      });
    try {
      const cli = publication.publishCurated(cliFirst.thirdManifest);
      await withTimeout(cliObservedPredecessor.promise, 'CLI unresolved predecessor barrier');
      const http = publishVersion('new-target-cli-first', 2, cliFirst.secondRevision).then(
        (value) => value,
      );
      await withTimeout(waitForKnowledgeLockWaiter(migrationClient), 'HTTP predecessor lock');
      releaseCli.resolve();
      await expect(cli).rejects.toBeInstanceOf(KnowledgePublicationConflictError);
      await expect(http).resolves.toMatchObject({ status: 201 });
    } finally {
      releaseCli.resolve();
      cliSpy.mockRestore();
    }
    const cliFirstVersions = await database.database
      .select({ version: knowledgeArticleVersions.version })
      .from(knowledgeArticleVersions)
      .innerJoin(knowledgeArticles, eq(knowledgeArticles.id, knowledgeArticleVersions.articleId))
      .where(eq(knowledgeArticles.articleKey, 'new-target-cli-first'));
    expect(cliFirstVersions.map((item) => item.version).sort()).toEqual([1, 2]);

    const httpFirst = await prepareSequence('new-target-http-first');
    const httpEntered = deferred();
    const releaseHttp = deferred();
    const originalMarkPublished = repository.markPublished.bind(repository);
    const httpSpy = jest
      .spyOn(repository, 'markPublished')
      .mockImplementationOnce(async (...args) => {
        httpEntered.resolve();
        await releaseHttp.promise;
        return originalMarkPublished(...args);
      });
    try {
      const http = publishVersion('new-target-http-first', 2, httpFirst.secondRevision).then(
        (value) => value,
      );
      await withTimeout(httpEntered.promise, 'HTTP predecessor publication barrier');
      const cli = publication.publishCurated(httpFirst.thirdManifest);
      await withTimeout(waitForKnowledgeLockWaiter(migrationClient), 'CLI new-target lock');
      releaseHttp.resolve();
      await expect(http).resolves.toMatchObject({ status: 201 });
      await expect(cli).resolves.toMatchObject({ disposition: 'published', version: 3 });
    } finally {
      releaseHttp.resolve();
      httpSpy.mockRestore();
    }
    const current = await request(app.getHttpServer())
      .get('/admin/knowledge/articles/new-target-http-first/versions/3/status')
      .set('Origin', ADMIN_ORIGIN)
      .set('Cookie', staffCookie(publisher))
      .expect(200);
    expect(current.body.data.state).toEqual(
      expect.objectContaining({ version: 3, publicationStatus: 'published' }),
    );
  });

  it('serializes exact source evidence mutation and review in both PostgreSQL lock orders', async () => {
    const mutationFirstKey = 'source-mutation-first';
    const mutationFirst = await createDraft(mutationFirstKey, 1, 'before-mutation').expect(201);
    const mutationFirstRevision = mutationFirst.body.data.state.draftRevision as number;
    const [mutationFirstSource] = await database.database
      .select()
      .from(knowledgeArticleSources)
      .innerJoin(
        knowledgeArticleVersions,
        eq(knowledgeArticleVersions.id, knowledgeArticleSources.articleVersionId),
      )
      .innerJoin(knowledgeArticles, eq(knowledgeArticles.id, knowledgeArticleVersions.articleId))
      .where(eq(knowledgeArticles.articleKey, mutationFirstKey));
    const mutationClient = await migrationClient.pool.connect();
    try {
      await mutationClient.query('BEGIN');
      await mutationClient.query(
        `UPDATE knowledge_article_sources
         SET source_title = $1
         WHERE id = $2`,
        ['合成来源标题 after-mutation', mutationFirstSource!.knowledge_article_sources.id],
      );
      const review = verifySources(mutationFirstKey, 1, mutationFirstRevision).then(
        (value) => value,
      );
      await withTimeout(
        waitForKnowledgeVersionLockWaiter(migrationClient),
        'source review exact-version lock',
      );
      await mutationClient.query('COMMIT');
      const reviewResponse = await review;
      expect(reviewResponse.status).toBe(409);
    } finally {
      await mutationClient.query('ROLLBACK').catch(() => undefined);
      mutationClient.release();
    }
    const mutationFirstState = await request(app.getHttpServer())
      .get(`/admin/knowledge/articles/${mutationFirstKey}/versions/1/review-candidate`)
      .set('Origin', ADMIN_ORIGIN)
      .set('Cookie', staffCookie(reviewer))
      .expect(200);
    expect(mutationFirstState.body.data.state.reviewStatus).toBe('unverified');
    expect(mutationFirstState.body.data.state.draftRevision).toBeGreaterThan(mutationFirstRevision);
    expect(mutationFirstState.body.data.candidate.sources[0].sourceTitle).toBe(
      '合成来源标题 after-mutation',
    );

    const reviewFirstKey = 'source-review-first';
    const reviewFirst = await createDraft(reviewFirstKey, 1, 'review-first').expect(201);
    const reviewFirstRevision = reviewFirst.body.data.state.draftRevision as number;
    const [reviewFirstSource] = await database.database
      .select()
      .from(knowledgeArticleSources)
      .innerJoin(
        knowledgeArticleVersions,
        eq(knowledgeArticleVersions.id, knowledgeArticleSources.articleVersionId),
      )
      .innerJoin(knowledgeArticles, eq(knowledgeArticles.id, knowledgeArticleVersions.articleId))
      .where(eq(knowledgeArticles.articleKey, reviewFirstKey));
    const reviewEntered = deferred();
    const releaseReview = deferred();
    const originalMarkSourceVerified = repository.markSourceVerified.bind(repository);
    const reviewSpy = jest
      .spyOn(repository, 'markSourceVerified')
      .mockImplementationOnce(async (...args) => {
        reviewEntered.resolve();
        await releaseReview.promise;
        return originalMarkSourceVerified(...args);
      });
    const blockedClient = await migrationClient.pool.connect();
    let sourceMutation: Promise<void> | undefined;
    try {
      const review = verifySources(reviewFirstKey, 1, reviewFirstRevision).then((value) => value);
      await withTimeout(reviewEntered.promise, 'source review transaction barrier');
      const blockedPid = await blockedClient.query<{ pid: number }>(
        'SELECT pg_backend_pid() AS pid',
      );
      sourceMutation = (async () => {
        await blockedClient.query('BEGIN');
        try {
          await blockedClient.query(
            `UPDATE knowledge_article_sources
             SET source_title = $1
             WHERE id = $2`,
            [
              '合成来源标题 forbidden-after-review',
              reviewFirstSource!.knowledge_article_sources.id,
            ],
          );
          await blockedClient.query('COMMIT');
        } catch (error) {
          await blockedClient.query('ROLLBACK');
          throw error;
        }
      })();
      await withTimeout(
        waitForKnowledgeVersionLockWaiter(migrationClient, blockedPid.rows[0]!.pid),
        'source mutation exact-version lock',
      );
      releaseReview.resolve();
      await expect(review).resolves.toMatchObject({ status: 201 });
      await expect(sourceMutation).rejects.toThrow('verified or published knowledge sources');
    } finally {
      releaseReview.resolve();
      reviewSpy.mockRestore();
      await sourceMutation?.catch(() => undefined);
      blockedClient.release();
    }
    const reviewFirstState = await request(app.getHttpServer())
      .get(`/admin/knowledge/articles/${reviewFirstKey}/versions/1/review-candidate`)
      .set('Origin', ADMIN_ORIGIN)
      .set('Cookie', staffCookie(reviewer))
      .expect(200);
    expect(reviewFirstState.body.data.state.reviewStatus).toBe('source_verified');
    expect(reviewFirstState.body.data.candidate.sources[0].sourceTitle).toBe(
      '合成来源标题 review-first',
    );
  });

  it('reads candidate revision and sources from one repeatable-read snapshot', async () => {
    const key = 'candidate-consistent-snapshot';
    const created = await createDraft(key, 1, 'snapshot-before').expect(201);
    const originalRevision = created.body.data.state.draftRevision as number;
    const [source] = await database.database
      .select()
      .from(knowledgeArticleSources)
      .innerJoin(
        knowledgeArticleVersions,
        eq(knowledgeArticleVersions.id, knowledgeArticleSources.articleVersionId),
      )
      .innerJoin(knowledgeArticles, eq(knowledgeArticles.id, knowledgeArticleVersions.articleId))
      .where(eq(knowledgeArticles.articleKey, key));
    const sourceReadEntered = deferred();
    const releaseSourceRead = deferred();
    const originalListSources = repository.listSources.bind(repository);
    const sourceSpy = jest
      .spyOn(repository, 'listSources')
      .mockImplementationOnce(async (...args) => {
        sourceReadEntered.resolve();
        await releaseSourceRead.promise;
        return originalListSources(...args);
      });
    try {
      const read = request(app.getHttpServer())
        .get(`/admin/knowledge/articles/${key}/versions/1/review-candidate`)
        .set('Origin', ADMIN_ORIGIN)
        .set('Cookie', staffCookie(reviewer))
        .then((value) => value);
      await withTimeout(sourceReadEntered.promise, 'candidate source read barrier');
      await migrationClient.pool.query(
        `UPDATE knowledge_article_sources
         SET source_title = $1
         WHERE id = $2`,
        ['合成来源标题 snapshot-after', source!.knowledge_article_sources.id],
      );
      releaseSourceRead.resolve();
      const snapshot = await read;
      expect(snapshot.status).toBe(200);
      expect(snapshot.body.data.state.draftRevision).toBe(originalRevision);
      expect(snapshot.body.data.candidate.sources[0].sourceTitle).toBe(
        '合成来源标题 snapshot-before',
      );
    } finally {
      releaseSourceRead.resolve();
      sourceSpy.mockRestore();
    }
    const refreshed = await request(app.getHttpServer())
      .get(`/admin/knowledge/articles/${key}/versions/1/review-candidate`)
      .set('Origin', ADMIN_ORIGIN)
      .set('Cookie', staffCookie(reviewer))
      .expect(200);
    expect(refreshed.body.data.state.draftRevision).toBeGreaterThan(originalRevision);
    expect(refreshed.body.data.candidate.sources[0].sourceTitle).toBe(
      '合成来源标题 snapshot-after',
    );
  });

  it('preserves legal CLI reviewer evidence across HTTP no-change review responses', async () => {
    const key = 'cli-reviewer-evidence';
    const reviewedAt = '2026-09-12T04:00:00.000Z';
    await publication.publishCurated({
      articleKey: key,
      version: 1,
      ...candidate('cli-evidence'),
      contentOrigin: 'curated',
      reviewStatus: 'source_verified',
      reviewedBy: 'synthetic-cli-reviewer',
      reviewedAt,
    });
    const status = await request(app.getHttpServer())
      .get(`/admin/knowledge/articles/${key}/versions/1/status`)
      .set('Origin', ADMIN_ORIGIN)
      .set('Cookie', staffCookie(reviewer))
      .expect(200);
    const revision = status.body.data.state.draftRevision as number;

    const publishedReplay = await verifySources(key, 1, revision).expect(201);
    expect(publishedReplay.body.data).toEqual(
      expect.objectContaining({
        disposition: 'no_change',
        reviewedBy: 'synthetic-cli-reviewer',
        reviewedAt,
      }),
    );
    await publication.withdraw(key, 1, new Date('2027-09-12T05:00:00.000Z'));
    const withdrawnReplay = await verifySources(key, 1, revision).expect(201);
    expect(withdrawnReplay.body.data.reviewedBy).toBe('synthetic-cli-reviewer');

    const auditFailure = jest
      .spyOn(audits, 'appendWithinTransaction')
      .mockRejectedValueOnce(new Error('synthetic audit failure'));
    const failed = await verifySources(key, 1, revision).expect(500);
    auditFailure.mockRestore();
    expect(JSON.stringify(failed.body)).not.toContain('synthetic-cli-reviewer');
    await verifySources(key, 1, revision).expect(201);
    const reviewAudits = await database.database
      .select()
      .from(auditLogs)
      .where(eq(auditLogs.action, 'knowledge_source_verified'));
    expect(reviewAudits).toHaveLength(3);
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

async function waitForKnowledgeVersionLockWaiter(
  client: ReturnType<typeof createDatabaseClient>,
  waiterPid?: number,
): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    const result = await client.pool.query<{ count: number }>(
      `SELECT count(*)::int AS count FROM pg_stat_activity
       WHERE pid <> pg_backend_pid()
         AND wait_event_type = 'Lock'
         AND ($1::int IS NULL OR pid = $1)
         AND ($1::int IS NOT NULL OR query ILIKE '%knowledge_article_versions%')`,
      [waiterPid ?? null],
    );
    if ((result.rows[0]?.count ?? 0) > 0) return;
    await new Promise<void>((settle) => setImmediate(settle));
  }
  throw new Error('Timed out waiting for the Knowledge version row-lock waiter');
}
