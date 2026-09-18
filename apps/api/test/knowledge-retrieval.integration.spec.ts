import type { AppTransaction } from '@mental-health/database';
import { createDatabaseClient, migrate, sql } from '@mental-health/database';
import { type INestApplication, Injectable } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { resolve } from 'node:path';
import { AppModule } from '../src/app.module';
import { KnowledgeFixtureService } from '../src/knowledge/knowledge-fixture.service';
import { KnowledgePublicationService } from '../src/knowledge/knowledge-publication.service';
import { KnowledgeRetrievalPolicy } from '../src/knowledge/knowledge-retrieval.policy';
import { KnowledgeRetrievalRepository } from '../src/knowledge/knowledge-retrieval.repository';
import {
  KNOWLEDGE_RETRIEVAL_RUNTIME_CONFIG,
  KnowledgeRetrievalService,
  type KnowledgeRetrievalRuntimeConfig,
} from '../src/knowledge/knowledge-retrieval.service';

type Deferred = Readonly<{ promise: Promise<void>; resolve: () => void }>;

function deferred(): Deferred {
  let resolve!: () => void;
  const promise = new Promise<void>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

function curatedManifest(articleKey: string, version = 1, marker = 'work-stress') {
  return {
    articleKey,
    version,
    title: `工作压力合成标题 ${marker}`,
    summary: `了解工作压力和日常自我照顾 ${marker}`,
    contentOrigin: 'curated',
    reviewStatus: 'source_verified',
    reviewedBy: 'synthetic-test-reviewer',
    reviewedAt: '2026-09-11T07:00:00.000Z',
    contentBlocks: [
      { type: 'heading', level: 2, text: `工作压力 ${marker}` },
      { type: 'paragraph', text: `工作压力时可以考虑一些日常自我照顾方式。${marker}` },
    ],
    sources: [
      {
        publisherName: '合成测试发布者',
        sourceTitle: `合成测试来源 ${marker}`,
        sourceUrl: `https://synthetic.invalid/${articleKey}/${version}/${marker}`,
        sourcePublishedAt: null,
        sourceVersionLabel: `synthetic-${version}`,
        sourceLocator: '合成测试章节',
        retrievedAt: '2026-09-11T00:00:00.000Z',
      },
    ],
  };
}

function syntheticManifest(articleKey: string, marker = 'synthetic-stress') {
  const curated = curatedManifest(articleKey, 1, marker);
  return {
    ...curated,
    contentOrigin: 'synthetic_fixture',
    reviewStatus: 'unverified',
    reviewedBy: null,
    reviewedAt: null,
  };
}

@Injectable()
class ObservableKnowledgeRetrievalRepository extends KnowledgeRetrievalRepository {
  private candidateHook: ((transaction: AppTransaction) => Promise<void>) | null = null;

  setCandidateHook(hook: ((transaction: AppTransaction) => Promise<void>) | null): void {
    this.candidateHook = hook;
  }

  protected override async afterCandidateVersionsRead(transaction: AppTransaction): Promise<void> {
    await this.candidateHook?.(transaction);
  }
}

describe('Knowledge retrieval PostgreSQL boundary', () => {
  let app: INestApplication;
  let databaseClient: ReturnType<typeof createDatabaseClient>;
  let fixtures: KnowledgeFixtureService;
  let publication: KnowledgePublicationService;
  let repository: ObservableKnowledgeRetrievalRepository;
  let retrieval: KnowledgeRetrievalService;
  const config: KnowledgeRetrievalRuntimeConfig = {
    appEnvironment: 'test',
    syntheticFixturesEnabled: true,
    statementTimeoutMs: 1_000,
    contextTokenBudget: 1_000,
  };

  beforeAll(async () => {
    const databaseUrl = process.env.TEST_DATABASE_URL;
    if (!databaseUrl) throw new Error('TEST_DATABASE_URL is required for integration tests');
    const databaseName = decodeURIComponent(new URL(databaseUrl).pathname.slice(1));
    if (!databaseName.endsWith('_test')) {
      throw new Error('Integration tests refuse to reset a database without an _test suffix');
    }

    databaseClient = createDatabaseClient(databaseUrl);
    await databaseClient.pool.query('DROP SCHEMA IF EXISTS drizzle CASCADE');
    await databaseClient.pool.query('DROP SCHEMA public CASCADE');
    await databaseClient.pool.query('CREATE SCHEMA public');
    await migrate(databaseClient.database, {
      migrationsFolder: resolve(process.cwd(), '../../database/migrations'),
    });

    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(KnowledgeRetrievalRepository)
      .useClass(ObservableKnowledgeRetrievalRepository)
      .overrideProvider(KNOWLEDGE_RETRIEVAL_RUNTIME_CONFIG)
      .useValue(config)
      .compile();
    app = moduleRef.createNestApplication();
    app.useLogger(false);
    await app.init();
    fixtures = moduleRef.get(KnowledgeFixtureService);
    publication = moduleRef.get(KnowledgePublicationService);
    repository = moduleRef.get(KnowledgeRetrievalRepository);
    retrieval = moduleRef.get(KnowledgeRetrievalService);
  }, 60_000);

  beforeEach(async () => {
    repository.setCandidateHook(null);
    await databaseClient.pool.query('TRUNCATE TABLE knowledge_articles CASCADE');
  });

  afterAll(async () => {
    if (app) await app.close();
    if (databaseClient) await databaseClient.pool.end();
  });

  it('keeps synthetic fixtures behind the explicit retrieval flag', async () => {
    await fixtures.publishSynthetic(syntheticManifest('synthetic-retrieval'));
    const noFixtureService = new KnowledgeRetrievalService(
      repository,
      new KnowledgeRetrievalPolicy(),
      { ...config, syntheticFixturesEnabled: false },
    );
    const signal = new AbortController().signal;
    const deadlineAt = new Date(Date.now() + 5_000);

    await expect(
      noFixtureService.retrieve({ query: '工作压力和日常自我照顾', signal, deadlineAt }),
    ).resolves.toMatchObject({ kind: 'no_hit' });
    await expect(
      retrieval.retrieve({ query: '工作压力和日常自我照顾', signal, deadlineAt }),
    ).resolves.toMatchObject({
      kind: 'hit',
      bundles: [expect.objectContaining({ articleKey: 'synthetic-retrieval', version: 1 })],
    });
  });

  it('returns the explicit capacity outcome when the 51st eligible current version exists', async () => {
    for (let index = 0; index < 51; index += 1) {
      await fixtures.publishSynthetic(
        syntheticManifest(
          `synthetic-capacity-${String(index).padStart(2, '0')}`,
          `marker-${index}`,
        ),
      );
    }

    await expect(
      retrieval.retrieve({
        query: '工作压力',
        signal: new AbortController().signal,
        deadlineAt: new Date(Date.now() + 10_000),
      }),
    ).resolves.toMatchObject({ kind: 'corpus_limit_exceeded' });
  }, 30_000);

  it('holds one repeatable-read body/source snapshot and later marks the exact version stale', async () => {
    await publication.publishCurated(curatedManifest('snapshot-currentness', 1, 'version-one'));
    const candidateRead = deferred();
    const releaseRead = deferred();
    repository.setCandidateHook(async () => {
      candidateRead.resolve();
      await releaseRead.promise;
    });

    const signal = new AbortController().signal;
    const deadlineAt = new Date(Date.now() + 10_000);
    const pending = retrieval.retrieve({ query: '工作压力和日常自我照顾', signal, deadlineAt });
    await candidateRead.promise;
    await publication.publishCurated(curatedManifest('snapshot-currentness', 2, 'version-two'));
    releaseRead.resolve();
    const snapshot = await pending;
    repository.setCandidateHook(null);

    expect(snapshot).toMatchObject({
      kind: 'hit',
      bundles: [
        expect.objectContaining({
          articleKey: 'snapshot-currentness',
          version: 1,
          sources: [expect.objectContaining({ sourceVersionLabel: 'synthetic-1' })],
        }),
      ],
    });
    if (snapshot.kind !== 'hit') throw new Error('Expected the version-one snapshot');
    await expect(
      retrieval.recheckCurrent({ bundles: snapshot.bundles, signal, deadlineAt }),
    ).resolves.toEqual({ kind: 'stale' });
  });

  it('applies a transaction-local statement timeout and fails soft without a late result', async () => {
    await publication.publishCurated(curatedManifest('statement-timeout'));
    repository.setCandidateHook(async (transaction) => {
      await transaction.execute(sql`SELECT pg_sleep(0.1)`);
    });
    const timeoutService = new KnowledgeRetrievalService(
      repository,
      new KnowledgeRetrievalPolicy(),
      { ...config, statementTimeoutMs: 20 },
    );

    await expect(
      timeoutService.retrieve({
        query: '工作压力',
        signal: new AbortController().signal,
        deadlineAt: new Date(Date.now() + 5_000),
      }),
    ).resolves.toEqual({
      kind: 'unavailable',
      policyVersion: 'lexical-sections-v2',
      reason: 'storage_timeout',
    });
  });
});
