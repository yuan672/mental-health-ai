import 'reflect-metadata';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  ageVerifications,
  consentDecisions,
  consents,
  createDatabaseClient,
  eq,
  knowledgeArticles,
  knowledgeArticleSources,
  knowledgeArticleVersions,
  migrate,
  passwordCredentials,
  users,
} from '@mental-health/database';
import { argon2id, hash } from 'argon2';
import { assertE2eSeedEnvironment } from './e2e-seed-guard';

const E2E_USER_ID = '51000000-0000-4000-8000-000000000001';
const E2E_EMAIL = 'phase5b-e2e@example.test';
const E2E_PASSWORD = 'Synthetic-E2E-Password-9!';

async function run(): Promise<void> {
  const connectionString = process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL;
  if (!connectionString) throw new Error('TEST_DATABASE_URL is required');
  assertE2eSeedEnvironment(process.env.APP_ENV, connectionString);

  const client = createDatabaseClient(connectionString);
  try {
    await client.pool.query('DROP SCHEMA IF EXISTS drizzle CASCADE');
    await client.pool.query('DROP SCHEMA public CASCADE');
    await client.pool.query('CREATE SCHEMA public');
    const migrationsFolder = [
      resolve(process.cwd(), 'database/migrations'),
      resolve(process.cwd(), '../../database/migrations'),
    ].find((candidate) => existsSync(candidate));
    if (!migrationsFolder) throw new Error('Database migrations folder was not found');
    await migrate(client.database, {
      migrationsFolder,
    });

    const now = new Date();
    const passwordHash = await hash(E2E_PASSWORD, {
      type: argon2id,
      memoryCost: 65_536,
      timeCost: 3,
      parallelism: 1,
      hashLength: 32,
    });
    await client.database.transaction(async (transaction) => {
      await transaction.insert(users).values({ id: E2E_USER_ID, createdAt: now });
      await transaction.insert(passwordCredentials).values({
        userId: E2E_USER_ID,
        email: E2E_EMAIL,
        passwordHash,
        createdAt: now,
      });
      await transaction.insert(ageVerifications).values({
        userId: E2E_USER_ID,
        ageVerified: true,
        verificationMethod: 'synthetic_e2e_seed',
        verifiedAt: now,
      });
      await transaction.insert(consents).values([
        {
          id: '51000000-0000-4000-8000-000000000011',
          userId: E2E_USER_ID,
          consentType: 'terms_of_service',
          consentVersion: process.env.REQUIRED_TERMS_VERSION ?? '1.1',
          status: 'accepted',
          acceptedAt: now,
          withdrawnAt: null,
          stateRevision: 1,
          effectiveAt: now,
        },
        {
          id: '51000000-0000-4000-8000-000000000012',
          userId: E2E_USER_ID,
          consentType: 'privacy_policy',
          consentVersion: process.env.REQUIRED_PRIVACY_VERSION ?? '1.1',
          status: 'accepted',
          acceptedAt: now,
          withdrawnAt: null,
          stateRevision: 1,
          effectiveAt: now,
        },
      ]);
      await transaction.insert(consentDecisions).values([
        {
          id: '51000000-0000-4000-8000-000000000021',
          consentId: '51000000-0000-4000-8000-000000000011',
          userId: E2E_USER_ID,
          consentType: 'terms_of_service',
          consentVersion: process.env.REQUIRED_TERMS_VERSION ?? '1.1',
          operationId: '51000000-0000-4000-8000-000000000031',
          decision: 'accepted',
          outcome: 'applied',
          priorRevision: 0,
          resultingRevision: 1,
          occurredAt: now,
          documentKey: 'synthetic.terms-of-service',
          documentRevision: 'test-revision-2',
          targetAcceptanceDecisionId: null,
          decisionSource: 'registration',
        },
        {
          id: '51000000-0000-4000-8000-000000000022',
          consentId: '51000000-0000-4000-8000-000000000012',
          userId: E2E_USER_ID,
          consentType: 'privacy_policy',
          consentVersion: process.env.REQUIRED_PRIVACY_VERSION ?? '1.1',
          operationId: '51000000-0000-4000-8000-000000000032',
          decision: 'accepted',
          outcome: 'applied',
          priorRevision: 0,
          resultingRevision: 1,
          occurredAt: now,
          documentKey: 'synthetic.privacy-policy',
          documentRevision: 'test-revision-2',
          targetAcceptanceDecisionId: null,
          decisionSource: 'registration',
        },
      ]);
      await transaction.insert(knowledgeArticles).values({
        id: '51000000-0000-4000-8000-000000000041',
        articleKey: 'synthetic-stress-basics',
        createdAt: now,
      });
      await transaction.insert(knowledgeArticleVersions).values({
        id: '51000000-0000-4000-8000-000000000042',
        articleId: '51000000-0000-4000-8000-000000000041',
        version: 1,
        title: '合成测试：认识日常压力',
        summary: '用于验证知识中心阅读流程的合成内容，不是正式健康资料。',
        contentBlocks: [
          { type: 'heading', level: 2, text: '留意当下的感受' },
          { type: 'paragraph', text: '这段合成正文只用于自动化测试。' },
          { type: 'list', style: 'unordered', items: ['暂停片刻', '向可信任的人表达感受'] },
          { type: 'callout', tone: 'important', text: '测试内容不能替代专业支持。' },
        ],
        publicationStatus: 'draft',
        reviewStatus: 'unverified',
        contentOrigin: 'synthetic_fixture',
        reviewedBy: null,
        reviewedAt: null,
        publishedAt: null,
        withdrawnAt: null,
        createdAt: now,
      });
      await transaction.insert(knowledgeArticleSources).values({
        id: '51000000-0000-4000-8000-000000000043',
        articleVersionId: '51000000-0000-4000-8000-000000000042',
        ordinal: 1,
        publisherName: '合成测试发布者',
        sourceTitle: '合成测试来源文档',
        sourceUrl: 'https://source.synthetic.test/knowledge/stress-basics',
        sourcePublishedAt: null,
        sourceVersionLabel: 'fixture-v1',
        sourceLocator: '合成章节 1',
        retrievedAt: now,
      });
      await transaction
        .update(knowledgeArticleVersions)
        .set({ publicationStatus: 'published', publishedAt: now })
        .where(eq(knowledgeArticleVersions.id, '51000000-0000-4000-8000-000000000042'));
    });
  } finally {
    await client.pool.end();
  }
}

void run().catch(() => {
  process.stderr.write(JSON.stringify({ level: 'error', event: 'phase5b_e2e_seed_failed' }) + '\n');
  process.exitCode = 1;
});
