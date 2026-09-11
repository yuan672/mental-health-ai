import { randomBytes, randomUUID } from 'node:crypto';
import {
  createDatabaseClient,
  eq,
  knowledgeArticles,
  knowledgeArticleSources,
  knowledgeArticleVersions,
  migrate,
  sessions,
  users,
} from '@mental-health/database';
import { Injectable, type INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { resolve } from 'node:path';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { hashSessionToken } from '../src/auth/sessions.service';
import { AppExceptionFilter } from '../src/common/filters/app-exception.filter';
import { DatabaseService } from '../src/database/database.service';
import { KnowledgeFixtureService } from '../src/knowledge/knowledge-fixture.service';
import { KnowledgePublicationRepository } from '../src/knowledge/knowledge-publication.repository';
import { KnowledgePublicationService } from '../src/knowledge/knowledge-publication.service';
import { KnowledgeRepository } from '../src/knowledge/knowledge.repository';
import {
  knowledgeArticleDetailResponseSchema,
  knowledgeArticleListResponseSchema,
} from '../src/knowledge/knowledge.schemas';
import { KnowledgeService } from '../src/knowledge/knowledge.service';

const DAY_MS = 86_400_000;

type Deferred = Readonly<{
  promise: Promise<void>;
  resolve: () => void;
}>;

function createDeferred(): Deferred {
  let resolve!: () => void;
  const promise = new Promise<void>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

function syntheticManifest(articleKey: string, version = 1, marker = 'one') {
  return {
    articleKey,
    version,
    title: `合成测试标题 ${marker}`,
    summary: `合成测试摘要 ${marker}`,
    contentOrigin: 'synthetic_fixture',
    reviewStatus: 'unverified',
    reviewedBy: null,
    reviewedAt: null,
    contentBlocks: [
      { type: 'heading', level: 2, text: `合成标题 ${marker}` },
      { type: 'paragraph', text: `<script>synthetic-${marker}()</script>` },
    ],
    sources: [
      {
        publisherName: `合成发布者 ${marker}`,
        sourceTitle: `合成来源 ${marker}`,
        sourceUrl: `https://synthetic.invalid/${articleKey}/${version}/${marker}`,
        sourcePublishedAt: null,
        sourceVersionLabel: `synthetic-${marker}`,
        sourceLocator: null,
        retrievedAt: '2026-09-11T00:00:00.000Z',
      },
    ],
  };
}

@Injectable()
class ObservableKnowledgeRepository extends KnowledgeRepository {
  private readHook: (() => Promise<void>) | null = null;

  setReadHook(hook: (() => Promise<void>) | null): void {
    this.readHook = hook;
  }

  protected override async afterPublishedVersionsRead(): Promise<void> {
    await this.readHook?.();
  }
}

describe('Phase 5E-1 Knowledge Base backend integration', () => {
  let app: INestApplication;
  let migrationClient: ReturnType<typeof createDatabaseClient>;
  let database: DatabaseService;
  let fixtures: KnowledgeFixtureService;
  let publication: KnowledgePublicationService;
  let publicationRepository: KnowledgePublicationRepository;
  let knowledge: KnowledgeService;
  let repository: ObservableKnowledgeRepository;

  beforeAll(async () => {
    const url = process.env.TEST_DATABASE_URL;
    if (!url) throw new Error('TEST_DATABASE_URL is required for integration tests');
    const databaseName = decodeURIComponent(new URL(url).pathname.slice(1));
    if (!databaseName.endsWith('_test')) {
      throw new Error('Integration tests refuse to reset a database without an _test suffix');
    }
    migrationClient = createDatabaseClient(url);
    await migrationClient.pool.query('DROP SCHEMA IF EXISTS drizzle CASCADE');
    await migrationClient.pool.query('DROP SCHEMA public CASCADE');
    await migrationClient.pool.query('CREATE SCHEMA public');
    await migrate(migrationClient.database, {
      migrationsFolder: resolve(process.cwd(), '../../database/migrations'),
    });

    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(KnowledgeRepository)
      .useClass(ObservableKnowledgeRepository)
      .compile();
    app = moduleRef.createNestApplication();
    app.useLogger(false);
    app.useGlobalFilters(new AppExceptionFilter());
    await app.init();
    database = moduleRef.get(DatabaseService);
    fixtures = moduleRef.get(KnowledgeFixtureService);
    publication = moduleRef.get(KnowledgePublicationService);
    publicationRepository = moduleRef.get(KnowledgePublicationRepository);
    knowledge = moduleRef.get(KnowledgeService);
    repository = moduleRef.get(KnowledgeRepository);
  }, 60_000);

  beforeEach(async () => {
    repository.setReadHook(null);
    await migrationClient.pool.query('TRUNCATE TABLE knowledge_articles CASCADE');
    await migrationClient.pool.query('TRUNCATE TABLE users CASCADE');
  });

  afterAll(async () => {
    if (app) await app.close();
    if (migrationClient) await migrationClient.pool.end();
  });

  async function createAuthContext() {
    const userId = randomUUID();
    const rawToken = randomBytes(32).toString('base64url');
    const csrfToken = randomBytes(32).toString('base64url');
    const now = new Date();
    await database.database.insert(users).values({ id: userId, createdAt: now });
    await database.database.insert(sessions).values({
      id: randomUUID(),
      userId,
      tokenHash: hashSessionToken(rawToken),
      createdAt: now,
      expiresAt: new Date(now.getTime() + 7 * DAY_MS),
      revokedAt: null,
    });
    return {
      userId,
      cookie: `mh_session=${rawToken}; mh_csrf=${csrfToken}`,
      csrfToken,
    };
  }

  it('publishes exact synthetic fixtures idempotently without rewriting evidence', async () => {
    const manifest = syntheticManifest('synthetic-idempotency');
    const first = await fixtures.publishSynthetic(manifest, new Date('2026-09-11T08:00:00Z'));
    const replay = await fixtures.publishSynthetic(manifest, new Date('2026-09-12T08:00:00Z'));
    expect(first).toEqual(expect.objectContaining({ disposition: 'published', version: 1 }));
    expect(replay).toEqual({ ...first, disposition: 'existing' });

    const [version] = await database.database.select().from(knowledgeArticleVersions);
    const [source] = await database.database.select().from(knowledgeArticleSources);
    expect(version?.publishedAt?.toISOString()).toBe('2026-09-11T08:00:00.000Z');
    expect(version?.reviewedAt).toBeNull();
    expect(source?.sourceTitle).toBe('合成来源 one');
    await expect(
      fixtures.publishSynthetic(
        syntheticManifest('synthetic-idempotency', 1, 'changed'),
        new Date('2026-09-13T08:00:00Z'),
      ),
    ).rejects.toMatchObject({ code: 'KNOWLEDGE_PUBLICATION_CONFLICT' });
  });

  it('publishes versions sequentially and keeps old publish/withdraw retries scoped', async () => {
    const key = 'synthetic-version-lifecycle';
    await fixtures.publishSynthetic(
      syntheticManifest(key, 1, 'v1'),
      new Date('2026-09-11T08:00:00Z'),
    );
    const second = await fixtures.publishSynthetic(
      syntheticManifest(key, 2, 'v2'),
      new Date('2026-09-12T08:00:00Z'),
    );
    const oldWithdrawal = await publication.withdraw(key, 1, new Date('2026-09-13T08:00:00Z'));
    expect(oldWithdrawal).toEqual(
      expect.objectContaining({
        disposition: 'existing',
        version: 1,
        withdrawnAt: '2026-09-12T08:00:00.000Z',
      }),
    );
    const detail = await knowledge.get(key);
    expect(detail.data.article).toEqual(
      expect.objectContaining({ version: 2, publishedAt: second.publishedAt }),
    );
    await expect(fixtures.publishSynthetic(syntheticManifest(key, 1, 'v1'))).rejects.toMatchObject({
      code: 'KNOWLEDGE_PUBLICATION_CONFLICT',
    });
    await expect(fixtures.publishSynthetic(syntheticManifest(key, 4, 'v4'))).rejects.toMatchObject({
      code: 'KNOWLEDGE_PUBLICATION_CONFLICT',
    });
  });

  it('serializes concurrent identical and conflicting publication attempts', async () => {
    const key = 'synthetic-concurrent-publication';
    await fixtures.publishSynthetic(syntheticManifest(key, 1, 'v1'));
    const exact = syntheticManifest(key, 2, 'v2');
    const exactResults = await Promise.all([
      fixtures.publishSynthetic(exact),
      fixtures.publishSynthetic(exact),
      fixtures.publishSynthetic(exact),
    ]);
    expect(exactResults.map((result) => result.disposition).sort()).toEqual([
      'existing',
      'existing',
      'published',
    ]);

    const conflictKey = 'synthetic-concurrent-conflict';
    await fixtures.publishSynthetic(syntheticManifest(conflictKey, 1, 'v1'));
    const conflictResults = await Promise.allSettled([
      fixtures.publishSynthetic(syntheticManifest(conflictKey, 2, 'candidate-a')),
      fixtures.publishSynthetic(syntheticManifest(conflictKey, 2, 'candidate-b')),
    ]);
    expect(conflictResults.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    expect(conflictResults.filter((result) => result.status === 'rejected')).toHaveLength(1);
    const [conflictArticle] = await database.database
      .select({ id: knowledgeArticles.id })
      .from(knowledgeArticles)
      .where(eq(knowledgeArticles.articleKey, conflictKey));
    const versions = await database.database
      .select()
      .from(knowledgeArticleVersions)
      .where(eq(knowledgeArticleVersions.articleId, conflictArticle!.id))
      .orderBy(knowledgeArticleVersions.version);
    expect(versions.filter((version) => version.version === 2)).toHaveLength(1);
    expect(
      versions.filter(
        (version) => version.version === 2 && version.publicationStatus === 'published',
      ),
    ).toHaveLength(1);
  });

  it('rejects a later version while its immediate predecessor is still uncommitted', async () => {
    const key = 'synthetic-concurrent-order';
    await fixtures.publishSynthetic(syntheticManifest(key, 1, 'v1'));
    const articleLocked = createDeferred();
    const allowSecondVersion = createDeferred();
    const originalEnsure = publicationRepository.ensureAndLockArticle.bind(publicationRepository);
    const spy = jest
      .spyOn(publicationRepository, 'ensureAndLockArticle')
      .mockImplementationOnce(async (...parameters) => {
        const article = await originalEnsure(...parameters);
        articleLocked.resolve();
        await allowSecondVersion.promise;
        return article;
      });
    try {
      const second = fixtures.publishSynthetic(syntheticManifest(key, 2, 'v2'));
      await articleLocked.promise;
      await expect(
        fixtures.publishSynthetic(syntheticManifest(key, 3, 'v3')),
      ).rejects.toMatchObject({ code: 'KNOWLEDGE_PUBLICATION_CONFLICT' });
      allowSecondVersion.resolve();
      await expect(second).resolves.toEqual(expect.objectContaining({ version: 2 }));
    } finally {
      allowSecondVersion.resolve();
      spy.mockRestore();
    }
    const detail = await knowledge.get(key);
    expect(detail.data.article.version).toBe(2);
  });

  it('rolls replacement back atomically when source persistence fails', async () => {
    const key = 'synthetic-atomic-replacement';
    await fixtures.publishSynthetic(
      syntheticManifest(key, 1, 'v1'),
      new Date('2026-09-11T08:00:00Z'),
    );
    const spy = jest
      .spyOn(publicationRepository, 'insertSources')
      .mockRejectedValueOnce(new Error('synthetic source persistence failure'));
    try {
      await expect(
        fixtures.publishSynthetic(
          syntheticManifest(key, 2, 'v2'),
          new Date('2026-09-12T08:00:00Z'),
        ),
      ).rejects.toThrow('synthetic source persistence failure');
    } finally {
      spy.mockRestore();
    }
    const articles = await database.database
      .select({ articleId: knowledgeArticles.id })
      .from(knowledgeArticles)
      .where(eq(knowledgeArticles.articleKey, key));
    const versions = await database.database
      .select()
      .from(knowledgeArticleVersions)
      .where(eq(knowledgeArticleVersions.articleId, articles[0]!.articleId));
    expect(versions).toHaveLength(1);
    expect(versions[0]).toEqual(
      expect.objectContaining({ version: 1, publicationStatus: 'published', withdrawnAt: null }),
    );
  });

  it('serves authenticated, paginated, strictly validated list and detail responses', async () => {
    const auth = await createAuthContext();
    await fixtures.publishSynthetic(
      syntheticManifest('synthetic-list-one', 1, 'one'),
      new Date('2026-09-11T08:00:00Z'),
    );
    await fixtures.publishSynthetic(
      syntheticManifest('synthetic-list-two', 1, 'two'),
      new Date('2026-09-11T09:00:00Z'),
    );
    await fixtures.publishSynthetic(
      syntheticManifest('synthetic-list-three', 1, 'three'),
      new Date('2026-09-11T10:00:00Z'),
    );

    await request(app.getHttpServer()).get('/knowledge/articles').expect(401);
    const first = await request(app.getHttpServer())
      .get('/knowledge/articles?limit=2')
      .set('Cookie', auth.cookie)
      .expect('Cache-Control', 'private, no-store')
      .expect(200);
    const firstPage = knowledgeArticleListResponseSchema.parse(first.body);
    expect(firstPage.data.items.map((item) => item.articleKey)).toEqual([
      'synthetic-list-three',
      'synthetic-list-two',
    ]);
    expect(firstPage.data.nextCursor).not.toBeNull();
    const second = await request(app.getHttpServer())
      .get(`/knowledge/articles?limit=2&cursor=${firstPage.data.nextCursor}`)
      .set('Cookie', auth.cookie)
      .expect(200);
    expect(knowledgeArticleListResponseSchema.parse(second.body).data.items).toHaveLength(1);
    await request(app.getHttpServer())
      .get('/knowledge/articles?cursor=not-a-valid-cursor')
      .set('Cookie', auth.cookie)
      .expect(400);

    const detail = await request(app.getHttpServer())
      .get('/knowledge/articles/synthetic-list-one')
      .set('Cookie', auth.cookie)
      .expect('Cache-Control', 'private, no-store')
      .expect(200);
    const parsed = knowledgeArticleDetailResponseSchema.parse(detail.body);
    expect(parsed.data.article).toEqual(
      expect.objectContaining({
        contentOrigin: 'synthetic_fixture',
        reviewStatus: 'unverified',
        reviewedAt: null,
      }),
    );
    expect(parsed.data.article.contentBlocks[1]).toEqual({
      type: 'paragraph',
      text: '<script>synthetic-one()</script>',
    });
    expect(JSON.stringify(parsed)).not.toContain('reviewedBy');
    await request(app.getHttpServer())
      .post('/knowledge/articles')
      .set('Cookie', auth.cookie)
      .set('Origin', 'http://localhost:5173')
      .set('x-csrf-token', auth.csrfToken)
      .send({})
      .expect(404);
  });

  it('hides withdrawn and environment-ineligible content behind the same boundary', async () => {
    const auth = await createAuthContext();
    const key = 'synthetic-hidden-knowledge';
    await fixtures.publishSynthetic(syntheticManifest(key));
    expect(
      await repository.findPublishedByKey({ articleKey: key, permitSynthetic: false }),
    ).toBeNull();
    await publication.withdraw(key, 1);
    const response = await request(app.getHttpServer())
      .get(`/knowledge/articles/${key}`)
      .set('Cookie', auth.cookie)
      .expect(404);
    expect(response.body.error.code).toBe('KNOWLEDGE_ARTICLE_NOT_FOUND');
  });

  it('does not expose an unverified curated draft', async () => {
    const auth = await createAuthContext();
    const articleId = randomUUID();
    const now = new Date('2026-09-11T08:00:00Z');
    await database.database.insert(knowledgeArticles).values({
      id: articleId,
      articleKey: 'curated-unverified-draft',
      createdAt: now,
    });
    await database.database.insert(knowledgeArticleVersions).values({
      id: randomUUID(),
      articleId,
      version: 1,
      title: '未核验草稿',
      summary: '不应出现在用户读取接口',
      contentBlocks: [{ type: 'paragraph', text: '未发布正文' }],
      publicationStatus: 'draft',
      reviewStatus: 'unverified',
      contentOrigin: 'curated',
      reviewedBy: null,
      reviewedAt: null,
      publishedAt: null,
      withdrawnAt: null,
      createdAt: now,
    });

    const list = await request(app.getHttpServer())
      .get('/knowledge/articles')
      .set('Cookie', auth.cookie)
      .expect(200);
    expect(list.body.data.items).toEqual([]);
    await request(app.getHttpServer())
      .get('/knowledge/articles/curated-unverified-draft')
      .set('Cookie', auth.cookie)
      .expect(404);
  });

  it('returns one consistent detail view if withdrawal commits between version and source reads', async () => {
    const key = 'synthetic-consistent-detail';
    await fixtures.publishSynthetic(syntheticManifest(key));
    const versionRead = createDeferred();
    const allowSourcesRead = createDeferred();
    repository.setReadHook(async () => {
      repository.setReadHook(null);
      versionRead.resolve();
      await allowSourcesRead.promise;
    });
    const pendingDetail = knowledge.get(key);
    await versionRead.promise;
    await publication.withdraw(key, 1);
    allowSourcesRead.resolve();
    const detail = await pendingDetail;
    expect(detail.data.article.sources).toHaveLength(1);
    await expect(knowledge.get(key)).rejects.toMatchObject({
      code: 'KNOWLEDGE_ARTICLE_NOT_FOUND',
    });
  });

  it('maps read storage failures to safe errors without returning article content', async () => {
    const auth = await createAuthContext();
    const spy = jest
      .spyOn(repository, 'findPublishedByKey')
      .mockRejectedValueOnce(new Error('synthetic raw storage detail'));
    try {
      const response = await request(app.getHttpServer())
        .get('/knowledge/articles/synthetic-storage-failure')
        .set('Cookie', auth.cookie)
        .expect(500);
      expect(response.body.error).toEqual({
        code: 'DATABASE_ERROR',
        message: '数据服务暂时不可用',
      });
      expect(JSON.stringify(response.body)).not.toContain('synthetic raw storage detail');
    } finally {
      spy.mockRestore();
    }
  });
});
