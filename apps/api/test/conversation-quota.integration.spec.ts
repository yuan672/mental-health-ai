import { randomUUID } from 'node:crypto';
import {
  and,
  conversations,
  count,
  createDatabaseClient,
  dailyUsageQuotas,
  eq,
  messages,
  migrate,
  quotaConsumptions,
  users,
} from '@mental-health/database';
import { type INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { resolve } from 'node:path';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { AppExceptionFilter } from '../src/common/filters/app-exception.filter';
import { ConversationService } from '../src/conversations/conversation.service';
import { DatabaseService } from '../src/database/database.service';
import { MessageService } from '../src/messages/message.service';
import { QuotaPolicyService } from '../src/quota/quota-policy.service';
import { QuotaService } from '../src/quota/quota.service';

const BASE_NOW = new Date('2026-09-09T08:00:00.000Z');
const DAY_MS = 24 * 60 * 60 * 1000;

describe('Phase 2B conversation and quota integration', () => {
  let app: INestApplication;
  let migrationClient: ReturnType<typeof createDatabaseClient>;
  let databaseService: DatabaseService;
  let conversationService: ConversationService;
  let messageService: MessageService;
  let quotaPolicy: QuotaPolicyService;
  let quotaService: QuotaService;
  let userId: string;
  let otherUserId: string;

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

    databaseService = moduleRef.get(DatabaseService);
    conversationService = moduleRef.get(ConversationService);
    messageService = moduleRef.get(MessageService);
    quotaPolicy = moduleRef.get(QuotaPolicyService);
    quotaService = moduleRef.get(QuotaService);

    userId = randomUUID();
    otherUserId = randomUUID();
    await databaseService.database.insert(users).values([
      { id: userId, createdAt: BASE_NOW },
      { id: otherUserId, createdAt: BASE_NOW },
    ]);
  }, 60_000);

  afterAll(async () => {
    if (app) {
      await app.close();
    }
    if (migrationClient) {
      await migrationClient.pool.end();
    }
  });

  it('applies every migration and keeps incognito outside PostgreSQL', async () => {
    const tables = await migrationClient.pool.query<{ table_name: string }>(
      "select table_name from information_schema.tables where table_schema = 'public' order by table_name",
    );
    expect(tables.rows.map((row) => row.table_name)).toEqual(
      expect.arrayContaining([
        'conversations',
        'daily_usage_quotas',
        'messages',
        'quota_consumptions',
      ]),
    );
    expect(tables.rows.map((row) => row.table_name).join(' ')).not.toMatch(/incognito/u);

    const columns = await migrationClient.pool.query<{ column_name: string }>(
      "select column_name from information_schema.columns where table_schema = 'public' and table_name in ('conversations', 'messages')",
    );
    expect(columns.rows.map((row) => row.column_name)).not.toEqual(
      expect.arrayContaining(['is_incognito', 'incognito', 'mode']),
    );
  });

  it('does not expose Phase 3 or Phase 5 HTTP APIs', async () => {
    await request(app.getHttpServer()).get('/quota').expect(404);
    await request(app.getHttpServer()).get('/conversations').expect(404);
    await request(app.getHttpServer()).post('/conversations').send({}).expect(404);
  });

  it('reports an unconsumed configured daily quota', async () => {
    const now = new Date('2026-09-09T15:59:59.000Z');
    expect(quotaPolicy.getDailyLimit(userId)).toBe(20);
    expect(await quotaService.getUsage(userId, now)).toEqual({
      userId,
      usageDate: '2026-09-09',
      dailyLimit: 20,
      usedCount: 0,
      remaining: 20,
    });
    await expect(quotaService.canUseAI(userId, now)).resolves.toBe(true);
  });

  it('consumes once for an idempotency key', async () => {
    const now = new Date('2026-09-09T09:00:00.000Z');
    const idempotencyKey = randomUUID();
    const first = await quotaService.consumeQuota(userId, idempotencyKey, now);
    const repeated = await quotaService.consumeQuota(userId, idempotencyKey, now);

    expect(first).toMatchObject({ usedCount: 1, remaining: 19 });
    expect(repeated).toEqual(first);

    const [ledgerCount] = await databaseService.database
      .select({ value: count() })
      .from(quotaConsumptions)
      .where(
        and(eq(quotaConsumptions.userId, userId), eq(quotaConsumptions.usageDate, '2026-09-09')),
      );
    expect(ledgerCount?.value).toBe(1);
  });

  it('deduplicates concurrent consumption with the same idempotency key', async () => {
    const retryUserId = randomUUID();
    const idempotencyKey = randomUUID();
    await databaseService.database.insert(users).values({ id: retryUserId });

    const results = await Promise.all(
      Array.from({ length: 10 }, () =>
        quotaService.consumeQuota(retryUserId, idempotencyKey, BASE_NOW),
      ),
    );

    expect(results.every((result) => result.usedCount === 1 && result.remaining === 19)).toBe(true);
    const usage = await quotaService.getUsage(retryUserId, BASE_NOW);
    expect(usage).toMatchObject({ usedCount: 1, remaining: 19 });

    const [ledgerCount] = await databaseService.database
      .select({ value: count() })
      .from(quotaConsumptions)
      .where(
        and(
          eq(quotaConsumptions.userId, retryUserId),
          eq(quotaConsumptions.usageDate, '2026-09-09'),
        ),
      );
    expect(ledgerCount?.value).toBe(1);
  });

  it('uses the Asia/Shanghai calendar-day boundary and isolates users', async () => {
    const beforeMidnight = new Date('2026-09-09T15:59:59.000Z');
    const afterMidnight = new Date('2026-09-09T16:00:00.000Z');

    expect(quotaPolicy.getUsageDate(beforeMidnight)).toBe('2026-09-09');
    expect(quotaPolicy.getUsageDate(afterMidnight)).toBe('2026-09-10');
    await quotaService.consumeQuota(userId, randomUUID(), beforeMidnight);

    expect(await quotaService.getUsage(userId, afterMidnight)).toMatchObject({
      usageDate: '2026-09-10',
      usedCount: 0,
    });
    expect(await quotaService.getUsage(otherUserId, beforeMidnight)).toMatchObject({
      usedCount: 0,
    });
  });

  it('never exceeds the daily limit under concurrent consumption', async () => {
    const concurrentUserId = randomUUID();
    await databaseService.database.insert(users).values({ id: concurrentUserId });

    const attempts = await Promise.allSettled(
      Array.from({ length: 25 }, () =>
        quotaService.consumeQuota(concurrentUserId, randomUUID(), BASE_NOW),
      ),
    );
    const succeeded = attempts.filter((attempt) => attempt.status === 'fulfilled');
    const rejected = attempts.filter((attempt) => attempt.status === 'rejected');

    expect(succeeded).toHaveLength(20);
    expect(rejected).toHaveLength(5);
    for (const attempt of rejected) {
      if (attempt.status === 'rejected') {
        expect(attempt.reason).toMatchObject({ code: 'QUOTA_EXCEEDED', statusCode: 429 });
      }
    }

    expect(await quotaService.getUsage(concurrentUserId, BASE_NOW)).toMatchObject({
      dailyLimit: 20,
      usedCount: 20,
      remaining: 0,
    });
    await expect(quotaService.canUseAI(concurrentUserId, BASE_NOW)).resolves.toBe(false);

    const [aggregate] = await databaseService.database
      .select({ usedCount: dailyUsageQuotas.usedCount })
      .from(dailyUsageQuotas)
      .where(
        and(
          eq(dailyUsageQuotas.userId, concurrentUserId),
          eq(dailyUsageQuotas.usageDate, '2026-09-09'),
        ),
      );
    expect(aggregate?.usedCount).toBe(20);

    const [consumptionCount] = await databaseService.database
      .select({ value: count() })
      .from(quotaConsumptions)
      .where(
        and(
          eq(quotaConsumptions.userId, concurrentUserId),
          eq(quotaConsumptions.usageDate, '2026-09-09'),
        ),
      );
    expect(consumptionCount?.value).toBe(20);
  });

  it('creates only ordinary persisted conversations with a 90-day expiry', async () => {
    const conversation = await conversationService.create(userId, BASE_NOW);

    expect(conversation).toMatchObject({
      userId,
      createdAt: BASE_NOW,
      isSaved: false,
      deletedAt: null,
    });
    expect(conversation.expiresAt?.getTime()).toBe(BASE_NOW.getTime() + 90 * DAY_MS);
  });

  it('enforces conversation ownership without distinguishing another owner', async () => {
    const conversation = await conversationService.create(userId, BASE_NOW);

    await expect(conversationService.get(userId, conversation.id, BASE_NOW)).resolves.toMatchObject(
      {
        id: conversation.id,
      },
    );
    await expect(
      conversationService.get(otherUserId, conversation.id, BASE_NOW),
    ).rejects.toMatchObject({ code: 'NOT_FOUND', statusCode: 404 });
    await expect(conversationService.get(userId, randomUUID(), BASE_NOW)).rejects.toMatchObject({
      code: 'NOT_FOUND',
      statusCode: 404,
    });
  });

  it('saves active conversations idempotently and never revives expired conversations', async () => {
    const conversation = await conversationService.create(userId, BASE_NOW);
    const first = await conversationService.save(userId, conversation.id, BASE_NOW);
    const repeated = await conversationService.save(userId, conversation.id, BASE_NOW);

    expect(first).toMatchObject({ isSaved: true, expiresAt: null });
    expect(repeated).toMatchObject({ isSaved: true, expiresAt: null });
    await expect(
      conversationService.get(userId, conversation.id, new Date(BASE_NOW.getTime() + 100 * DAY_MS)),
    ).resolves.toMatchObject({ id: conversation.id, isSaved: true });

    const expired = await conversationService.create(
      userId,
      new Date(BASE_NOW.getTime() - 91 * DAY_MS),
    );
    await messageService.appendMessage(
      userId,
      expired.id,
      'user',
      'expired-sensitive-message',
      new Date(BASE_NOW.getTime() - 91 * DAY_MS),
    );
    await expect(conversationService.get(userId, expired.id, BASE_NOW)).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
    await expect(messageService.readMessages(userId, expired.id, BASE_NOW)).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
    await expect(conversationService.save(userId, expired.id, BASE_NOW)).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
  });

  it('appends messages in order and enforces parent ownership', async () => {
    const conversation = await conversationService.create(userId, BASE_NOW);
    const first = await messageService.appendMessage(
      userId,
      conversation.id,
      'user',
      'first-sensitive-message',
      BASE_NOW,
    );
    const second = await messageService.appendMessage(
      userId,
      conversation.id,
      'assistant',
      'second-sensitive-message',
      BASE_NOW,
    );

    expect([first.sequenceNumber, second.sequenceNumber]).toEqual([1, 2]);
    await expect(messageService.readMessages(userId, conversation.id, BASE_NOW)).resolves.toEqual([
      expect.objectContaining({ id: first.id, sequenceNumber: 1, role: 'user' }),
      expect.objectContaining({ id: second.id, sequenceNumber: 2, role: 'assistant' }),
    ]);
    await expect(
      messageService.readMessages(otherUserId, conversation.id, BASE_NOW),
    ).rejects.toMatchObject({ code: 'NOT_FOUND', statusCode: 404 });
    await expect(
      messageService.appendMessage(
        otherUserId,
        conversation.id,
        'user',
        'must-not-be-written',
        BASE_NOW,
      ),
    ).rejects.toMatchObject({ code: 'NOT_FOUND', statusCode: 404 });
  });

  it('allocates unique ordered sequences under concurrent message appends', async () => {
    const conversation = await conversationService.create(userId, BASE_NOW);
    const appended = await Promise.all(
      Array.from({ length: 20 }, (_, index) =>
        messageService.appendMessage(
          userId,
          conversation.id,
          index % 2 === 0 ? 'user' : 'assistant',
          `concurrent-sensitive-message-${index}`,
          BASE_NOW,
        ),
      ),
    );

    const sequences = appended.map((message) => message.sequenceNumber).sort((a, b) => a - b);
    expect(sequences).toEqual(Array.from({ length: 20 }, (_, index) => index + 1));

    const read = await messageService.readMessages(userId, conversation.id, BASE_NOW);
    expect(read.map((message) => message.sequenceNumber)).toEqual(sequences);
  });

  it('marks a conversation deleted and immediately hard-deletes message content', async () => {
    const conversation = await conversationService.create(userId, BASE_NOW);
    await messageService.appendMessage(
      userId,
      conversation.id,
      'user',
      'delete-this-sensitive-message',
      BASE_NOW,
    );

    await conversationService.delete(userId, conversation.id, BASE_NOW);

    const [messageCount] = await databaseService.database
      .select({ value: count() })
      .from(messages)
      .where(eq(messages.conversationId, conversation.id));
    const [tombstone] = await databaseService.database
      .select({ deletedAt: conversations.deletedAt })
      .from(conversations)
      .where(eq(conversations.id, conversation.id));

    expect(messageCount?.value).toBe(0);
    expect(tombstone?.deletedAt).toEqual(BASE_NOW);
    await expect(conversationService.get(userId, conversation.id, BASE_NOW)).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
  });

  it('physically purges expired and deleted metadata in bounded batches', async () => {
    const oldCreation = new Date(BASE_NOW.getTime() - 91 * DAY_MS);
    const expired = await conversationService.create(userId, oldCreation);
    const deleted = await conversationService.create(userId, BASE_NOW);
    await conversationService.delete(userId, deleted.id, BASE_NOW);
    const active = await conversationService.create(userId, BASE_NOW);

    const firstBatch = await conversationService.purgeExpired(BASE_NOW, 1);
    const secondBatch = await conversationService.purgeExpired(BASE_NOW, 10);
    expect(firstBatch).toBe(1);
    expect(secondBatch).toBeGreaterThanOrEqual(1);

    const remaining = await databaseService.database
      .select({ id: conversations.id })
      .from(conversations)
      .where(eq(conversations.id, active.id));
    const removed = await databaseService.database
      .select({ id: conversations.id })
      .from(conversations)
      .where(eq(conversations.id, expired.id));
    const deletedRemoved = await databaseService.database
      .select({ id: conversations.id })
      .from(conversations)
      .where(eq(conversations.id, deleted.id));

    expect(remaining).toHaveLength(1);
    expect(removed).toHaveLength(0);
    expect(deletedRemoved).toHaveLength(0);
  });
});
