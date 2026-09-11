import { randomBytes, randomUUID } from 'node:crypto';
import {
  auditLogs,
  assistantMessageKnowledgeReferences,
  conversations,
  count,
  createDatabaseClient,
  eq,
  messages,
  migrate,
  knowledgeArticles,
  knowledgeArticleSources,
  knowledgeArticleVersions,
  riskEvents,
  sessions,
  users,
} from '@mental-health/database';
import { type INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { resolve } from 'node:path';
import request from 'supertest';
import { insertRequiredConsentFixtures } from './consent-fixtures';
import { AppModule } from '../src/app.module';
import { hashSessionToken } from '../src/auth/sessions.service';
import { AppExceptionFilter } from '../src/common/filters/app-exception.filter';
import { DatabaseService } from '../src/database/database.service';
import { QuotaService } from '../src/quota/quota.service';
import { AuditLogRepository } from '../src/safety/audit/audit-log.repository';

const WEB_ORIGIN = 'http://localhost:5173';
const DAY_MS = 24 * 60 * 60 * 1000;

type AuthContext = Readonly<{
  userId: string;
  sessionId: string;
  cookie: string;
  csrfToken: string;
}>;

describe('Phase 5A conversation access API integration', () => {
  let app: INestApplication;
  let migrationClient: ReturnType<typeof createDatabaseClient>;
  let database: DatabaseService;
  let quotaService: QuotaService;
  let audits: AuditLogRepository;

  beforeAll(async () => {
    const testDatabaseUrl = process.env.TEST_DATABASE_URL;
    if (!testDatabaseUrl) {
      throw new Error('TEST_DATABASE_URL is required for integration tests');
    }

    const databaseName = decodeURIComponent(new URL(testDatabaseUrl).pathname.slice(1));
    if (!databaseName.endsWith('_test')) {
      throw new Error('Integration tests refuse to reset a database without an _test suffix');
    }

    migrationClient = createDatabaseClient(testDatabaseUrl);
    await migrationClient.pool.query('DROP SCHEMA IF EXISTS drizzle CASCADE');
    await migrationClient.pool.query('DROP SCHEMA public CASCADE');
    await migrationClient.pool.query('CREATE SCHEMA public');
    await migrate(migrationClient.database, {
      migrationsFolder: resolve(process.cwd(), '../../database/migrations'),
    });

    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    app.useLogger(false);
    app.useGlobalFilters(new AppExceptionFilter());
    await app.init();

    database = moduleRef.get(DatabaseService);
    quotaService = moduleRef.get(QuotaService);
    audits = moduleRef.get(AuditLogRepository);
  }, 60_000);

  afterAll(async () => {
    if (app) await app.close();
    if (migrationClient) await migrationClient.pool.end();
  });

  async function createAuthContext(withRequiredConsents = false): Promise<AuthContext> {
    const userId = randomUUID();
    const sessionId = randomUUID();
    const rawToken = randomBytes(32).toString('base64url');
    const csrfToken = randomBytes(32).toString('base64url');
    const now = new Date();

    await database.database.insert(users).values({ id: userId, createdAt: now });
    await database.database.insert(sessions).values({
      id: sessionId,
      userId,
      tokenHash: hashSessionToken(rawToken),
      createdAt: now,
      expiresAt: new Date(now.getTime() + 7 * DAY_MS),
      revokedAt: null,
    });
    if (withRequiredConsents) {
      await insertRequiredConsentFixtures(database.database, userId, now);
    }

    return {
      userId,
      sessionId,
      cookie: `mh_session=${rawToken}; mh_csrf=${csrfToken}`,
      csrfToken,
    };
  }

  async function seedConversation(
    userId: string,
    options: Partial<{
      id: string;
      createdAt: Date;
      expiresAt: Date | null;
      isSaved: boolean;
      deletedAt: Date | null;
    }> = {},
  ) {
    const createdAt = options.createdAt ?? new Date();
    const isSaved = options.isSaved ?? false;
    const row = {
      id: options.id ?? randomUUID(),
      userId,
      createdAt,
      expiresAt:
        options.expiresAt === undefined
          ? isSaved
            ? null
            : new Date(createdAt.getTime() + 90 * DAY_MS)
          : options.expiresAt,
      isSaved,
      deletedAt: options.deletedAt ?? null,
    };
    await database.database.insert(conversations).values(row);
    return row;
  }

  async function seedMessage(
    conversationId: string,
    sequenceNumber: number,
    content = `synthetic-message-${sequenceNumber}`,
  ) {
    const row = {
      id: randomUUID(),
      conversationId,
      role: sequenceNumber % 2 === 0 ? ('assistant' as const) : ('user' as const),
      sequenceNumber,
      content,
      createdAt: new Date(Date.now() + sequenceNumber),
    };
    await database.database.insert(messages).values(row);
    return row;
  }

  function authenticatedGet(auth: AuthContext, path: string) {
    return request(app.getHttpServer()).get(path).set('Cookie', auth.cookie);
  }

  function authenticatedPost(auth: AuthContext, path: string) {
    return request(app.getHttpServer())
      .post(path)
      .set('Cookie', auth.cookie)
      .set('Origin', WEB_ORIGIN)
      .set('x-csrf-token', auth.csrfToken);
  }

  function authenticatedDelete(auth: AuthContext, path: string) {
    return request(app.getHttpServer())
      .delete(path)
      .set('Cookie', auth.cookie)
      .set('Origin', WEB_ORIGIN)
      .set('x-csrf-token', auth.csrfToken);
  }

  it('requires authentication for conversation, quota, and capability reads', async () => {
    const conversationsResponse = await request(app.getHttpServer())
      .get('/conversations')
      .expect(401);
    const quotaResponse = await request(app.getHttpServer()).get('/quota').expect(401);
    const capabilitiesResponse = await request(app.getHttpServer())
      .get('/capabilities')
      .expect(401);
    expect(conversationsResponse.headers['cache-control']).toBe('private, no-store');
    expect(quotaResponse.headers['cache-control']).toBe('private, no-store');
    expect(capabilitiesResponse.headers['cache-control']).toBe('private, no-store');
  });

  it('returns metadata-only active history with stable descending cursor pagination', async () => {
    const auth = await createAuthContext();
    const other = await createAuthContext();
    const base = Date.now();
    const newest = await seedConversation(auth.userId, {
      createdAt: new Date(base - 1_000),
    });
    const second = await seedConversation(auth.userId, {
      createdAt: new Date(base - 2_000),
    });
    const third = await seedConversation(auth.userId, {
      createdAt: new Date(base - 3_000),
    });
    const saved = await seedConversation(auth.userId, {
      createdAt: new Date(base - 120 * DAY_MS),
      isSaved: true,
    });
    await seedConversation(auth.userId, {
      createdAt: new Date(base - 100 * DAY_MS),
      expiresAt: new Date(base - 10 * DAY_MS),
    });
    await seedConversation(auth.userId, {
      createdAt: new Date(base - 500),
      deletedAt: new Date(base - 100),
    });
    await seedConversation(other.userId, { createdAt: new Date(base) });
    await seedMessage(newest.id, 1, 'list-secret-must-not-appear');

    const first = await authenticatedGet(auth, '/conversations?limit=2').expect(200);
    expect(first.headers['cache-control']).toBe('private, no-store');
    expect(first.body.data.conversations.map((item: { id: string }) => item.id)).toEqual([
      newest.id,
      second.id,
    ]);
    expect(Object.keys(first.body.data.conversations[0]).sort()).toEqual([
      'createdAt',
      'expiresAt',
      'id',
      'isSaved',
    ]);
    expect(JSON.stringify(first.body)).not.toMatch(
      /list-secret|preview|risk|provider|model|turn|title|summary/iu,
    );

    const secondPage = await authenticatedGet(
      auth,
      `/conversations?limit=2&cursor=${encodeURIComponent(first.body.data.nextCursor as string)}`,
    ).expect(200);
    expect(secondPage.body.data.conversations.map((item: { id: string }) => item.id)).toEqual([
      third.id,
      saved.id,
    ]);
    expect(secondPage.body.data.nextCursor).toBeNull();
  });

  it('uses id as the stable tie-breaker when conversation timestamps match', async () => {
    const auth = await createAuthContext();
    const createdAt = new Date();
    const ids = [randomUUID(), randomUUID(), randomUUID()];
    for (const id of ids) {
      await seedConversation(auth.userId, { id, createdAt });
    }

    const first = await authenticatedGet(auth, '/conversations?limit=2').expect(200);
    const expected = [...ids].sort((left, right) => right.localeCompare(left));
    expect(first.body.data.conversations.map((item: { id: string }) => item.id)).toEqual(
      expected.slice(0, 2),
    );
    const next = await authenticatedGet(
      auth,
      `/conversations?limit=2&cursor=${encodeURIComponent(first.body.data.nextCursor as string)}`,
    ).expect(200);
    expect(next.body.data.conversations.map((item: { id: string }) => item.id)).toEqual(
      expected.slice(2),
    );
  });

  it('rejects malformed, wrong-kind, and oversized pagination input safely', async () => {
    const auth = await createAuthContext();
    await authenticatedGet(auth, '/conversations?cursor=not-base64!').expect(400);
    await authenticatedGet(auth, '/conversations?cursor=eyJraW5kIjoibWVzc2FnZSJ9').expect(400);
    await authenticatedGet(auth, '/conversations?limit=101').expect(400);
  });

  it('gets only active owned conversation detail and applies no-store caching', async () => {
    const auth = await createAuthContext();
    const other = await createAuthContext();
    const active = await seedConversation(auth.userId);
    const expired = await seedConversation(auth.userId, {
      createdAt: new Date(Date.now() - 100 * DAY_MS),
      expiresAt: new Date(Date.now() - DAY_MS),
    });
    const deleted = await seedConversation(auth.userId, { deletedAt: new Date() });

    const response = await authenticatedGet(auth, `/conversations/${active.id}`).expect(200);
    expect(response.headers['cache-control']).toBe('private, no-store');
    expect(response.body.data.conversation).toEqual({
      id: active.id,
      createdAt: active.createdAt.toISOString(),
      expiresAt: active.expiresAt?.toISOString(),
      isSaved: false,
    });
    const notOwned = await authenticatedGet(other, `/conversations/${active.id}`).expect(404);
    const expiredResponse = await authenticatedGet(auth, `/conversations/${expired.id}`).expect(
      404,
    );
    const deletedResponse = await authenticatedGet(auth, `/conversations/${deleted.id}`).expect(
      404,
    );
    const missingResponse = await authenticatedGet(auth, `/conversations/${randomUUID()}`).expect(
      404,
    );
    for (const hiddenResponse of [notOwned, expiredResponse, deletedResponse, missingResponse]) {
      expect(hiddenResponse.headers['cache-control']).toBe('private, no-store');
    }
  });

  it('pages owned messages by sequence and exposes no internal AI or safety fields', async () => {
    const auth = await createAuthContext();
    const other = await createAuthContext();
    const conversation = await seedConversation(auth.userId);
    for (let sequence = 1; sequence <= 5; sequence += 1) {
      await seedMessage(conversation.id, sequence);
    }

    const first = await authenticatedGet(
      auth,
      `/conversations/${conversation.id}/messages?limit=2`,
    ).expect(200);
    expect(first.headers['cache-control']).toBe('private, no-store');
    expect(
      first.body.data.messages.map((message: { sequence: number }) => message.sequence),
    ).toEqual([4, 5]);
    expect(Object.keys(first.body.data.messages[0]).sort()).toEqual([
      'content',
      'createdAt',
      'id',
      'role',
      'sequence',
    ]);
    expect(JSON.stringify(first.body)).not.toMatch(
      /aiTurn|riskLevel|provider|classifier|prompt|token/iu,
    );

    const second = await authenticatedGet(
      auth,
      `/conversations/${conversation.id}/messages?limit=2&cursor=${encodeURIComponent(first.body.data.nextCursor as string)}`,
    ).expect(200);
    expect(
      second.body.data.messages.map((message: { sequence: number }) => message.sequence),
    ).toEqual([2, 3]);
    const third = await authenticatedGet(
      auth,
      `/conversations/${conversation.id}/messages?limit=2&cursor=${encodeURIComponent(second.body.data.nextCursor as string)}`,
    ).expect(200);
    expect(
      third.body.data.messages.map((message: { sequence: number }) => message.sequence),
    ).toEqual([1]);
    expect(third.body.data.nextCursor).toBeNull();
    await authenticatedGet(other, `/conversations/${conversation.id}/messages`).expect(404);
  });

  it('negotiates strict v2 history and fails a referenced v1 page closed with 406', async () => {
    const auth = await createAuthContext();
    const other = await createAuthContext();
    const conversation = await seedConversation(auth.userId);
    const assistant = await seedMessage(conversation.id, 2, '合成知识回复');
    const articleId = randomUUID();
    const articleVersionId = randomUUID();
    const reviewedAt = new Date('2026-09-01T00:00:00.000Z');
    const publishedAt = new Date('2026-09-02T00:00:00.000Z');
    const retrievedAt = new Date('2026-08-31T00:00:00.000Z');
    await database.database.insert(knowledgeArticles).values({
      id: articleId,
      articleKey: 'synthetic-history-reference',
      createdAt: reviewedAt,
    });
    await database.database.insert(knowledgeArticleVersions).values({
      id: articleVersionId,
      articleId,
      version: 1,
      title: '合成历史引用',
      summary: '仅用于协议测试',
      contentBlocks: [{ type: 'paragraph', text: '合成知识正文' }],
      publicationStatus: 'draft',
      reviewStatus: 'unverified',
      contentOrigin: 'synthetic_fixture',
      reviewedBy: null,
      reviewedAt: null,
      publishedAt: null,
      withdrawnAt: null,
      createdAt: reviewedAt,
    });
    await database.database.insert(knowledgeArticleSources).values({
      id: randomUUID(),
      articleVersionId,
      ordinal: 1,
      publisherName: '合成来源发布者',
      sourceTitle: '合成来源标题',
      sourceUrl: 'https://fixture.invalid/reference',
      sourcePublishedAt: null,
      sourceVersionLabel: 'fixture-v1',
      sourceLocator: 'synthetic-section',
      retrievedAt,
    });
    await database.database
      .update(knowledgeArticleVersions)
      .set({ publicationStatus: 'published', publishedAt })
      .where(eq(knowledgeArticleVersions.id, articleVersionId));
    await database.database.insert(assistantMessageKnowledgeReferences).values({
      assistantMessageId: assistant.id,
      articleVersionId,
      ordinal: 1,
    });

    const v1 = await authenticatedGet(auth, `/conversations/${conversation.id}/messages`).expect(
      406,
    );
    expect(v1.body).toEqual({
      success: false,
      error: {
        code: 'CLIENT_CAPABILITY_REQUIRED',
        message: '此内容需要更新客户端后查看',
      },
    });
    expect(v1.headers.vary).toContain('X-MH-Knowledge-References');
    expect(JSON.stringify(v1.body)).not.toContain('合成知识回复');

    const v2 = await authenticatedGet(auth, `/conversations/${conversation.id}/messages`)
      .set('X-MH-Knowledge-References', '1')
      .expect(200);
    expect(v2.headers['x-mh-knowledge-references']).toBe('1');
    expect(v2.headers.vary).toContain('X-MH-Knowledge-References');
    expect(v2.body.data.messages).toEqual([
      {
        id: assistant.id,
        role: 'assistant',
        content: '合成知识回复',
        sequence: 2,
        createdAt: assistant.createdAt.toISOString(),
        knowledgeReferences: [
          {
            articleKey: 'synthetic-history-reference',
            title: '合成历史引用',
            version: 1,
            contentOrigin: 'synthetic_fixture',
            reviewStatus: 'unverified',
            reviewedAt: null,
            availability: 'currently_published',
            sources: [
              {
                linkState: 'available',
                ordinal: 1,
                publisherName: '合成来源发布者',
                sourceTitle: '合成来源标题',
                sourceUrl: 'https://fixture.invalid/reference',
                sourcePublishedAt: null,
                sourceVersionLabel: 'fixture-v1',
                sourceLocator: 'synthetic-section',
                retrievedAt: retrievedAt.toISOString(),
              },
            ],
          },
        ],
      },
    ]);
    await authenticatedGet(other, `/conversations/${conversation.id}/messages`)
      .set('X-MH-Knowledge-References', '1')
      .expect(404);
    await authenticatedGet(auth, `/conversations/${conversation.id}/messages`)
      .set('X-MH-Knowledge-References', '2')
      .expect(400);
  });

  it('saves an active conversation idempotently and enforces CSRF and ownership', async () => {
    const auth = await createAuthContext();
    const other = await createAuthContext();
    const active = await seedConversation(auth.userId);
    const expired = await seedConversation(auth.userId, {
      createdAt: new Date(Date.now() - 100 * DAY_MS),
      expiresAt: new Date(Date.now() - DAY_MS),
    });

    await request(app.getHttpServer())
      .post(`/conversations/${active.id}/save`)
      .set('Cookie', auth.cookie)
      .expect(403);
    const first = await authenticatedPost(auth, `/conversations/${active.id}/save`).expect(200);
    const repeated = await authenticatedPost(auth, `/conversations/${active.id}/save`).expect(200);
    expect(first.body.data.conversation).toMatchObject({ isSaved: true, expiresAt: null });
    expect(repeated.body.data.conversation).toEqual(first.body.data.conversation);
    await authenticatedPost(other, `/conversations/${active.id}/save`).expect(404);
    await authenticatedPost(auth, `/conversations/${expired.id}/save`).expect(404);
  });

  it('deletes message content and writes one safe user audit in the same commit', async () => {
    const auth = await createAuthContext();
    const conversation = await seedConversation(auth.userId);
    const message = await seedMessage(conversation.id, 1, 'single-delete-secret');
    const riskEventId = randomUUID();
    await database.database.insert(riskEvents).values({
      id: riskEventId,
      userId: auth.userId,
      conversationId: conversation.id,
      aiTurnId: null,
      triggerMessageId: message.id,
      clientRequestId: randomUUID(),
      isIncognito: false,
      level: 'MEDIUM',
      riskCategories: ['SELF_HARM'],
      reasonCodes: ['AMBIGUOUS_SAFETY_SIGNAL'],
      detectionSource: 'hybrid',
      policyVersion: 'synthetic-test',
      classifierKey: null,
      classifierVersion: null,
      createdAt: new Date(),
      retentionUntil: new Date(Date.now() + 180 * DAY_MS),
    });

    await request(app.getHttpServer())
      .delete(`/conversations/${conversation.id}`)
      .set('Cookie', auth.cookie)
      .expect(403);
    expect(
      await database.database.select().from(messages).where(eq(messages.id, message.id)),
    ).toHaveLength(1);

    await authenticatedDelete(auth, `/conversations/${conversation.id}`).expect(200, {
      success: true,
      data: { deleted: true },
    });
    expect(
      await database.database.select().from(messages).where(eq(messages.id, message.id)),
    ).toHaveLength(0);
    await authenticatedGet(auth, `/conversations/${conversation.id}`).expect(404);

    const [riskEvent] = await database.database
      .select()
      .from(riskEvents)
      .where(eq(riskEvents.id, riskEventId));
    expect(riskEvent).toMatchObject({ id: riskEventId, conversationId: conversation.id });
    expect(riskEvent?.triggerMessageId).toBeNull();

    const deletionAudits = await database.database
      .select()
      .from(auditLogs)
      .where(eq(auditLogs.resourceId, conversation.id));
    expect(deletionAudits).toHaveLength(1);
    expect(deletionAudits[0]).toMatchObject({
      actorType: 'user',
      actorId: auth.userId,
      action: 'conversation_deleted',
      resourceType: 'conversation',
      safeMetadata: {},
    });
    expect(JSON.stringify(deletionAudits)).not.toContain('single-delete-secret');
  });

  it('rolls back conversation and message deletion when the audit write fails', async () => {
    const auth = await createAuthContext();
    const conversation = await seedConversation(auth.userId);
    const message = await seedMessage(conversation.id, 1, 'rollback-secret');
    const failure = jest
      .spyOn(audits, 'appendWithinTransaction')
      .mockRejectedValueOnce(new Error('synthetic audit failure'));

    await authenticatedDelete(auth, `/conversations/${conversation.id}`).expect(500);
    failure.mockRestore();

    const [persistedConversation] = await database.database
      .select()
      .from(conversations)
      .where(eq(conversations.id, conversation.id));
    expect(persistedConversation?.deletedAt).toBeNull();
    expect(
      await database.database.select().from(messages).where(eq(messages.id, message.id)),
    ).toHaveLength(1);
    await authenticatedGet(auth, `/conversations/${conversation.id}`).expect(200);
  });

  it('deletes all normal, saved, and expired history with one aggregate audit', async () => {
    const auth = await createAuthContext();
    const other = await createAuthContext();
    const normal = await seedConversation(auth.userId);
    const saved = await seedConversation(auth.userId, {
      createdAt: new Date(Date.now() - 120 * DAY_MS),
      isSaved: true,
    });
    const expired = await seedConversation(auth.userId, {
      createdAt: new Date(Date.now() - 120 * DAY_MS),
      expiresAt: new Date(Date.now() - 30 * DAY_MS),
    });
    const otherConversation = await seedConversation(other.userId);
    const normalMessage = await seedMessage(normal.id, 1, 'normal-delete-all-secret');
    await seedMessage(saved.id, 1, 'saved-delete-all-secret');
    await seedMessage(expired.id, 1, 'expired-delete-all-secret');
    await seedMessage(otherConversation.id, 1, 'other-user-secret');

    const riskEventId = randomUUID();
    await database.database.insert(riskEvents).values({
      id: riskEventId,
      userId: auth.userId,
      conversationId: normal.id,
      aiTurnId: null,
      triggerMessageId: normalMessage.id,
      clientRequestId: randomUUID(),
      isIncognito: false,
      level: 'MEDIUM',
      riskCategories: ['SELF_HARM'],
      reasonCodes: ['AMBIGUOUS_SAFETY_SIGNAL'],
      detectionSource: 'hybrid',
      policyVersion: 'synthetic-test',
      classifierKey: null,
      classifierVersion: null,
      createdAt: new Date(),
      retentionUntil: new Date(Date.now() + 180 * DAY_MS),
    });

    await request(app.getHttpServer())
      .delete('/conversations')
      .set('Cookie', auth.cookie)
      .expect(403);
    const response = await authenticatedDelete(auth, '/conversations').expect(200);
    expect(response.body).toEqual({
      success: true,
      data: { deleted: true, conversationCount: 3 },
    });
    expect((await authenticatedGet(auth, '/conversations')).body.data.conversations).toEqual([]);

    const ownedRows = await database.database
      .select()
      .from(conversations)
      .where(eq(conversations.userId, auth.userId));
    expect(ownedRows).toHaveLength(3);
    expect(ownedRows.every((row) => row.deletedAt !== null)).toBe(true);
    expect(
      await database.database.select().from(messages).where(eq(messages.conversationId, normal.id)),
    ).toHaveLength(0);
    expect(
      await database.database.select().from(messages).where(eq(messages.conversationId, saved.id)),
    ).toHaveLength(0);
    expect(
      await database.database
        .select()
        .from(messages)
        .where(eq(messages.conversationId, expired.id)),
    ).toHaveLength(0);
    expect(
      await database.database
        .select()
        .from(messages)
        .where(eq(messages.conversationId, otherConversation.id)),
    ).toHaveLength(1);
    expect(
      await database.database.select().from(riskEvents).where(eq(riskEvents.id, riskEventId)),
    ).toHaveLength(1);

    const aggregateAudits = await database.database
      .select()
      .from(auditLogs)
      .where(eq(auditLogs.resourceId, auth.userId));
    expect(aggregateAudits).toHaveLength(1);
    expect(aggregateAudits[0]).toMatchObject({
      actorType: 'user',
      actorId: auth.userId,
      action: 'conversation_history_deleted',
      resourceType: 'conversation_history',
      safeMetadata: { conversationCount: 3, messageCount: 3 },
    });

    const repeated = await authenticatedDelete(auth, '/conversations').expect(200);
    expect(repeated.body.data.conversationCount).toBe(0);
    const [auditCount] = await database.database
      .select({ value: count() })
      .from(auditLogs)
      .where(eq(auditLogs.resourceId, auth.userId));
    expect(auditCount?.value).toBe(1);
  });

  it('returns only the current user quota with correct remaining arithmetic', async () => {
    const auth = await createAuthContext();
    const other = await createAuthContext();
    const now = new Date();
    await quotaService.consumeQuota(auth.userId, randomUUID(), now);
    await quotaService.consumeQuota(other.userId, randomUUID(), now);
    await quotaService.consumeQuota(other.userId, randomUUID(), now);

    const response = await authenticatedGet(auth, '/quota').expect(200);
    expect(response.headers['cache-control']).toBe('private, no-store');
    expect(response.body.data.quota).toEqual({
      dailyLimit: 20,
      used: 1,
      remaining: 19,
      usageDate: expect.stringMatching(/^\d{4}-\d{2}-\d{2}$/u),
    });
    expect(JSON.stringify(response.body)).not.toMatch(
      /userId|ledger|idempotency|provider|token|subscription|plan/iu,
    );
  });

  it('returns only the configured public capability without readiness internals', async () => {
    const auth = await createAuthContext();
    const response = await authenticatedGet(auth, '/capabilities').expect(200);
    expect(response.headers['cache-control']).toBe('no-store');
    expect(response.body).toEqual({ success: true, data: { aiChatEnabled: true } });
    expect(JSON.stringify(response.body)).not.toMatch(
      /productionSafe|readiness|classifier|provider|crisis|secret/iu,
    );
  });

  it('does not create a second conversation when the first-message request is retried', async () => {
    const auth = await createAuthContext(true);
    const clientRequestId = randomUUID();
    const body = { mode: 'persistent', clientRequestId, message: '合成的首次对话重试测试消息。' };

    const first = await authenticatedPost(auth, '/ai/chat/stream').send(body).expect(200);
    expect(first.headers['content-type']).toContain('text/event-stream');
    const second = await authenticatedPost(auth, '/ai/chat/stream').send(body).expect(200);
    expect(second.headers['content-type']).toContain('application/json');
    expect(second.body.data.turn.status).toBe('completed');

    const [conversationCount] = await database.database
      .select({ value: count() })
      .from(conversations)
      .where(eq(conversations.userId, auth.userId));
    expect(conversationCount?.value).toBe(1);
  });
});
