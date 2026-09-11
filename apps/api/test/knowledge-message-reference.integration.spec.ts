import { randomUUID } from 'node:crypto';
import {
  assistantMessageKnowledgeReferences,
  conversations,
  createDatabaseClient,
  eq,
  knowledgeArticleSources,
  knowledgeArticleVersions,
  knowledgeArticles,
  messages,
  migrate,
  users,
} from '@mental-health/database';
import { resolve } from 'node:path';
import { DatabaseService } from '../src/database/database.service';
import {
  KnowledgeMessageReferenceRepository,
  KnowledgeReferenceInvariantError,
} from '../src/knowledge/knowledge-message-reference.repository';

describe('KnowledgeMessageReferenceRepository', () => {
  let client: ReturnType<typeof createDatabaseClient>;
  let repository: KnowledgeMessageReferenceRepository;

  beforeAll(async () => {
    const url = process.env.TEST_DATABASE_URL;
    if (!url) throw new Error('TEST_DATABASE_URL is required for Knowledge reference tests');
    const databaseName = decodeURIComponent(new URL(url).pathname.slice(1));
    if (!databaseName.endsWith('_test')) {
      throw new Error('Knowledge reference tests refuse a database without an _test suffix');
    }
    client = createDatabaseClient(url);
    await client.pool.query('DROP SCHEMA IF EXISTS drizzle CASCADE');
    await client.pool.query('DROP SCHEMA public CASCADE');
    await client.pool.query('CREATE SCHEMA public');
    await migrate(client.database, {
      migrationsFolder: resolve(process.cwd(), '../../database/migrations'),
    });
    repository = new KnowledgeMessageReferenceRepository({
      database: client.database,
    } as unknown as DatabaseService);
  });

  beforeEach(async () => {
    await client.pool.query('TRUNCATE TABLE knowledge_articles CASCADE');
    await client.pool.query('TRUNCATE TABLE users CASCADE');
  });

  afterAll(async () => {
    await client.pool.end();
  });

  async function createConversation(userId = randomUUID()): Promise<{
    userId: string;
    conversationId: string;
  }> {
    const conversationId = randomUUID();
    const now = new Date('2026-09-11T08:00:00.000Z');
    await client.database.insert(users).values({ id: userId, createdAt: now });
    await client.database.insert(conversations).values({
      id: conversationId,
      userId,
      createdAt: now,
      expiresAt: new Date('2026-12-10T08:00:00.000Z'),
      isSaved: false,
      deletedAt: null,
    });
    return { userId, conversationId };
  }

  async function createAssistantMessage(
    conversationId: string,
    sequenceNumber = 1,
  ): Promise<string> {
    const messageId = randomUUID();
    await client.database.insert(messages).values({
      id: messageId,
      conversationId,
      role: 'assistant',
      sequenceNumber,
      content: 'synthetic approved answer',
      createdAt: new Date('2026-09-11T08:00:00.000Z'),
    });
    return messageId;
  }

  async function createPublishedVersion(
    articleKey: string,
    publisherName: string,
  ): Promise<string> {
    const articleId = randomUUID();
    const versionId = randomUUID();
    const now = new Date('2026-09-11T08:00:00.000Z');
    await client.database.insert(knowledgeArticles).values({
      id: articleId,
      articleKey,
      createdAt: now,
    });
    await client.database.insert(knowledgeArticleVersions).values({
      id: versionId,
      articleId,
      version: 1,
      title: `合成标题 ${articleKey}`,
      summary: '合成摘要',
      contentBlocks: [{ type: 'paragraph', text: '合成正文' }],
      publicationStatus: 'draft',
      reviewStatus: 'unverified',
      contentOrigin: 'synthetic_fixture',
      reviewedBy: null,
      reviewedAt: null,
      publishedAt: null,
      withdrawnAt: null,
      createdAt: now,
    });
    await client.database.insert(knowledgeArticleSources).values({
      id: randomUUID(),
      articleVersionId: versionId,
      ordinal: 1,
      publisherName,
      sourceTitle: `合成来源 ${articleKey}`,
      sourceUrl: `https://synthetic.invalid/${articleKey}`,
      sourcePublishedAt: null,
      sourceVersionLabel: 'synthetic-v1',
      sourceLocator: 'synthetic locator',
      retrievedAt: now,
    });
    await client.database
      .update(knowledgeArticleVersions)
      .set({ publicationStatus: 'published', publishedAt: now })
      .where(eq(knowledgeArticleVersions.id, versionId));
    return versionId;
  }

  it('persists deterministic order and hydrates exact evidence only for the owner', async () => {
    const owner = await createConversation();
    const other = await createConversation();
    const assistantMessageId = await createAssistantMessage(owner.conversationId);
    const firstVersionId = await createPublishedVersion('synthetic-reference-a', '合成发布者 A');
    const secondVersionId = await createPublishedVersion('synthetic-reference-b', '合成发布者 B');

    await client.database.transaction(async (transaction) => {
      await repository.persistWithinTransaction(transaction, {
        assistantMessageId,
        articleVersionIds: [secondVersionId, firstVersionId],
      });
    });

    const owned = await repository.findOwnedByMessageIds(owner.userId, [assistantMessageId]);
    expect(owned).toHaveLength(2);
    expect(owned.map((reference) => reference.articleVersionId)).toEqual([
      secondVersionId,
      firstVersionId,
    ]);
    expect(owned.map((reference) => reference.ordinal)).toEqual([1, 2]);
    expect(owned[0]).toEqual(
      expect.objectContaining({
        assistantMessageId,
        articleKey: 'synthetic-reference-b',
        version: 1,
        publicationStatus: 'published',
        contentOrigin: 'synthetic_fixture',
        reviewStatus: 'unverified',
        reviewedAt: null,
        sources: [
          expect.objectContaining({
            ordinal: 1,
            publisherName: '合成发布者 B',
            sourceUrl: 'https://synthetic.invalid/synthetic-reference-b',
          }),
        ],
      }),
    );
    await expect(
      repository.findOwnedByMessageIds(other.userId, [assistantMessageId]),
    ).resolves.toEqual([]);
  });

  it('rolls back the assistant message and every reference if reference persistence fails', async () => {
    const owner = await createConversation();
    const assistantMessageId = randomUUID();
    const validVersionId = await createPublishedVersion('synthetic-atomic-reference', '合成发布者');

    await expect(
      client.database.transaction(async (transaction) => {
        await transaction.insert(messages).values({
          id: assistantMessageId,
          conversationId: owner.conversationId,
          role: 'assistant',
          sequenceNumber: 1,
          content: 'synthetic answer that must roll back',
          createdAt: new Date('2026-09-11T08:00:00.000Z'),
        });
        await repository.persistWithinTransaction(transaction, {
          assistantMessageId,
          articleVersionIds: [validVersionId, randomUUID()],
        });
      }),
    ).rejects.toBeDefined();

    const storedMessage = await client.database
      .select({ id: messages.id })
      .from(messages)
      .where(eq(messages.id, assistantMessageId));
    const storedReferences = await client.database
      .select()
      .from(assistantMessageKnowledgeReferences)
      .where(eq(assistantMessageKnowledgeReferences.assistantMessageId, assistantMessageId));
    expect(storedMessage).toEqual([]);
    expect(storedReferences).toEqual([]);
  });

  it('rejects empty, duplicate, and oversized reference sets before writing', async () => {
    const owner = await createConversation();
    const assistantMessageId = await createAssistantMessage(owner.conversationId);
    const versionId = await createPublishedVersion('synthetic-reference-invariants', '合成发布者');

    await client.database.transaction(async (transaction) => {
      await expect(
        repository.persistWithinTransaction(transaction, {
          assistantMessageId,
          articleVersionIds: [],
        }),
      ).rejects.toBeInstanceOf(KnowledgeReferenceInvariantError);
      await expect(
        repository.persistWithinTransaction(transaction, {
          assistantMessageId,
          articleVersionIds: [versionId, versionId],
        }),
      ).rejects.toBeInstanceOf(KnowledgeReferenceInvariantError);
      await expect(
        repository.persistWithinTransaction(transaction, {
          assistantMessageId,
          articleVersionIds: [versionId, randomUUID(), randomUUID()],
        }),
      ).rejects.toBeInstanceOf(KnowledgeReferenceInvariantError);
    });

    const stored = await client.database.select().from(assistantMessageKnowledgeReferences);
    expect(stored).toEqual([]);
  });
});
