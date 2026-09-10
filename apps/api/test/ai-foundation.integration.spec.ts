import { randomUUID } from 'node:crypto';
import {
  aiTurns,
  and,
  consents,
  count,
  createDatabaseClient,
  eq,
  migrate,
  quotaConsumptions,
  sessions,
  users,
} from '@mental-health/database';
import { type INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { resolve } from 'node:path';
import request from 'supertest';
import { AiOrchestrationService } from '../src/ai/ai-orchestration.service';
import { ConversationContextService } from '../src/ai/context/conversation-context.service';
import { IncognitoGenerationAdmissionService } from '../src/ai/incognito/incognito-generation-admission.service';
import {
  deriveIncognitoQuotaIdempotencyKey,
  InMemoryIncognitoContextStore,
} from '../src/ai/incognito/incognito-context.store';
import {
  LLM_PROVIDER,
  LLMProviderFailure,
  LLMUnsupportedCapabilityError,
  type LLMCallOptions,
  type LLMChatRequest,
  type LLMChatResult,
  type LLMEmbeddingResult,
  type LLMHealthStatus,
  type LLMProvider,
  type LLMProviderStreamEvent,
  type LLMRiskClassificationCandidate,
} from '../src/ai/providers/llm-provider';
import {
  POST_GENERATION_SAFETY_GATE,
  PRE_GENERATION_SAFETY_GATE,
  type PostGenerationSafetyGate,
  type PostGenerationSafetyInput,
  type PreGenerationSafetyGate,
} from '../src/ai/safety/safety-gates';
import type { RiskDecision } from '../src/safety/safety.types';
import { AiTurnService } from '../src/ai/turns/ai-turn.service';
import { AppModule } from '../src/app.module';
import { hashSessionToken, SessionsService } from '../src/auth/sessions.service';
import { AppExceptionFilter } from '../src/common/filters/app-exception.filter';
import { env } from '../src/config/env';
import { ConversationService } from '../src/conversations/conversation.service';
import { DatabaseService } from '../src/database/database.service';
import { MessageService } from '../src/messages/message.service';
import { QuotaService } from '../src/quota/quota.service';

const BASE_NOW = new Date('2026-09-09T08:00:00.000Z');
const PROVIDER_METADATA = {
  provider: 'fake',
  model: 'fake-stream-model',
  requestId: 'safe-fake-trace',
} as const;
type FakeMode =
  | 'success'
  | 'fail-before-segment'
  | 'fail-after-segment'
  | 'wait-for-abort'
  | 'wait-after-segment'
  | 'stream-until-abort';

class FakeStreamingProvider implements LLMProvider {
  mode: FakeMode = 'success';
  streamCalls = 0;
  dispatched: Promise<void> = Promise.resolve();
  private resolveDispatched: (() => void) | null = null;

  reset(mode: FakeMode): void {
    this.mode = mode;
    this.streamCalls = 0;
    this.dispatched = new Promise((resolve) => {
      this.resolveDispatched = resolve;
    });
  }

  chat(): Promise<LLMChatResult> {
    return Promise.reject(new LLMProviderFailure('unconfigured', false));
  }

  async *streamChat(
    request: LLMChatRequest,
    options: LLMCallOptions,
  ): AsyncIterable<LLMProviderStreamEvent> {
    void request;
    this.streamCalls += 1;
    this.resolveDispatched?.();
    yield { type: 'started', metadata: PROVIDER_METADATA };

    if (this.mode === 'fail-before-segment') {
      throw new LLMProviderFailure('upstream', true, PROVIDER_METADATA.requestId);
    }
    if (this.mode === 'wait-for-abort') {
      await new Promise<never>((_resolve, reject) => {
        const rejectAbort = (): void =>
          reject(new LLMProviderFailure('aborted', false, PROVIDER_METADATA.requestId));
        if (options.signal.aborted) {
          rejectAbort();
          return;
        }
        options.signal.addEventListener('abort', rejectAbort, { once: true });
      });
    }

    yield { type: 'text_delta', text: '已批准的第一句。' };
    if (this.mode === 'wait-after-segment') {
      await new Promise<never>((_resolve, reject) => {
        const rejectAbort = (): void =>
          reject(new LLMProviderFailure('aborted', false, PROVIDER_METADATA.requestId));
        if (options.signal.aborted) {
          rejectAbort();
          return;
        }
        options.signal.addEventListener('abort', rejectAbort, { once: true });
      });
    }
    if (this.mode === 'stream-until-abort') {
      while (!options.signal.aborted) {
        await new Promise<void>((resolve, reject) => {
          const timer = setTimeout(() => {
            options.signal.removeEventListener('abort', rejectAbort);
            resolve();
          }, 10);
          const rejectAbort = (): void => {
            clearTimeout(timer);
            reject(new LLMProviderFailure('aborted', false, PROVIDER_METADATA.requestId));
          };
          options.signal.addEventListener('abort', rejectAbort, { once: true });
        });
        yield { type: 'text_delta', text: '续' };
      }
      throw new LLMProviderFailure('aborted', false, PROVIDER_METADATA.requestId);
    }
    if (this.mode === 'fail-after-segment') {
      throw new LLMProviderFailure('network', true, PROVIDER_METADATA.requestId);
    }
    yield { type: 'text_delta', text: '这是第二句。' };
    yield {
      type: 'completed',
      finishReason: 'stop',
      usage: { inputTokens: 10, outputTokens: 8, totalTokens: 18 },
      metadata: PROVIDER_METADATA,
    };
  }

  classifyRisk(): Promise<LLMRiskClassificationCandidate> {
    return Promise.reject(new LLMUnsupportedCapabilityError('classifyRisk'));
  }

  embed(): Promise<LLMEmbeddingResult> {
    return Promise.reject(new LLMUnsupportedCapabilityError('embed'));
  }

  healthCheck(): Promise<LLMHealthStatus> {
    return Promise.resolve({ status: 'healthy', checkedAt: BASE_NOW, latencyMs: 0 });
  }
}

class RecordingPostGenerationGate implements PostGenerationSafetyGate {
  readonly productionSafe = false;
  readonly approved: string[] = [];

  reset(): void {
    this.approved.length = 0;
  }

  approve(input: PostGenerationSafetyInput) {
    this.approved.push(input.candidateSegment);
    return Promise.resolve({ status: 'approved' as const, text: input.candidateSegment });
  }
}

class AllowingPreGenerationGate implements PreGenerationSafetyGate {
  readonly productionSafe = false;

  check(): Promise<RiskDecision> {
    return Promise.resolve({
      status: 'assessed',
      level: 'LOW',
      harmSubject: 'UNKNOWN',
      categories: [],
      reasonCodes: [],
      policyFlags: [],
      route: 'ALLOW_NORMAL_GENERATION',
      bufferingMode: 'semantic',
      detectionSource: 'deterministic',
      policyVersion: 'phase-3-test-gate',
      classifierKey: null,
      classifierVersion: null,
    });
  }
}

describe('Phase 3 AI foundation integration', () => {
  let app: INestApplication;
  let migrationClient: ReturnType<typeof createDatabaseClient>;
  let databaseService: DatabaseService;
  let conversationsService: ConversationService;
  let contextService: ConversationContextService;
  let messagesService: MessageService;
  let orchestration: AiOrchestrationService;
  let quotaService: QuotaService;
  let sessionsService: SessionsService;
  let turnsService: AiTurnService;
  let incognitoStore: InMemoryIncognitoContextStore;
  let incognitoAdmission: IncognitoGenerationAdmissionService;
  const provider = new FakeStreamingProvider();
  const postGate = new RecordingPostGenerationGate();
  const preGate = new AllowingPreGenerationGate();

  beforeAll(async () => {
    const testDatabaseUrl = process.env.TEST_DATABASE_URL;
    if (!testDatabaseUrl) throw new Error('TEST_DATABASE_URL is required for integration tests');
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

    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(LLM_PROVIDER)
      .useValue(provider)
      .overrideProvider(PRE_GENERATION_SAFETY_GATE)
      .useValue(preGate)
      .overrideProvider(POST_GENERATION_SAFETY_GATE)
      .useValue(postGate)
      .compile();
    app = moduleRef.createNestApplication();
    app.useLogger(false);
    app.useGlobalFilters(new AppExceptionFilter());
    await app.init();

    databaseService = moduleRef.get(DatabaseService);
    conversationsService = moduleRef.get(ConversationService);
    contextService = moduleRef.get(ConversationContextService);
    messagesService = moduleRef.get(MessageService);
    orchestration = moduleRef.get(AiOrchestrationService);
    quotaService = moduleRef.get(QuotaService);
    sessionsService = moduleRef.get(SessionsService);
    turnsService = moduleRef.get(AiTurnService);
    incognitoStore = moduleRef.get(InMemoryIncognitoContextStore);
    incognitoAdmission = moduleRef.get(IncognitoGenerationAdmissionService);
  }, 60_000);

  beforeEach(() => {
    provider.reset('success');
    postGate.reset();
  });

  afterAll(async () => {
    if (app) await app.close();
    if (migrationClient) await migrationClient.pool.end();
  });

  async function createUser(withConsent = true): Promise<string> {
    const userId = randomUUID();
    await databaseService.database.insert(users).values({ id: userId, createdAt: BASE_NOW });
    if (withConsent) {
      await databaseService.database.insert(consents).values([
        {
          id: randomUUID(),
          userId,
          consentType: 'terms_of_service',
          consentVersion: '1.0',
          status: 'accepted',
          acceptedAt: BASE_NOW,
        },
        {
          id: randomUUID(),
          userId,
          consentType: 'privacy_policy',
          consentVersion: '1.0',
          status: 'accepted',
          acceptedAt: BASE_NOW,
        },
      ]);
    }
    return userId;
  }

  async function collect(
    prepared: Awaited<ReturnType<AiOrchestrationService['preparePersistentTurn']>>,
    signal = new AbortController().signal,
  ) {
    if (prepared.kind !== 'ready') throw new Error('Expected a newly prepared turn');
    const events = [];
    for await (const event of orchestration.streamPreparedTurn(prepared, signal)) {
      events.push(event);
    }
    return events;
  }

  it('applies every migration to empty PostgreSQL and creates only the approved AI-turn state', async () => {
    const table = await migrationClient.pool.query<{ column_name: string }>(
      "select column_name from information_schema.columns where table_schema = 'public' and table_name = 'ai_turns' order by ordinal_position",
    );
    expect(table.rows.map((row) => row.column_name)).toEqual([
      'id',
      'user_id',
      'conversation_id',
      'client_request_id',
      'status',
      'prompt_key',
      'prompt_version',
      'user_message_id',
      'assistant_message_id',
      'failure_code',
      'lease_expires_at',
      'created_at',
      'started_at',
      'completed_at',
    ]);
    expect(table.rows.map((row) => row.column_name)).not.toContain('request_fingerprint');
  });

  it('persists a successful turn only after gated, incremental provider output completes', async () => {
    const userId = await createUser();
    const conversation = await conversationsService.create(userId, BASE_NOW);
    const prepared = await orchestration.preparePersistentTurn(
      { userId, sessionId: randomUUID() },
      {
        clientRequestId: randomUUID(),
        conversationId: conversation.id,
        message: 'synthetic-user-message',
      },
      new AbortController().signal,
      BASE_NOW,
    );
    const events = await collect(prepared);

    expect(events.map((event) => event.type)).toEqual([
      'turn.started',
      'message.segment',
      'message.segment',
      'turn.completed',
    ]);
    expect(postGate.approved).toEqual(['已批准的第一句。', '这是第二句。']);
    expect(provider.streamCalls).toBe(1);
    expect(await quotaService.getUsage(userId, BASE_NOW)).toMatchObject({ usedCount: 1 });

    const persisted = await messagesService.readMessages(userId, conversation.id, BASE_NOW);
    expect(
      persisted.map((message) => [message.role, message.sequenceNumber, message.content]),
    ).toEqual([
      ['user', 1, 'synthetic-user-message'],
      ['assistant', 2, '已批准的第一句。这是第二句。'],
    ]);
    const completedEvent = events.at(-1);
    expect(completedEvent).toMatchObject({
      type: 'turn.completed',
      data: { assistantMessageId: persisted[1]?.id, finishReason: 'stop' },
    });
  });

  it('invokes the post-generation gate before each segment becomes observable', async () => {
    const userId = await createUser();
    const conversation = await conversationsService.create(userId, BASE_NOW);
    const prepared = await orchestration.preparePersistentTurn(
      { userId, sessionId: randomUUID() },
      {
        clientRequestId: randomUUID(),
        conversationId: conversation.id,
        message: 'synthetic-order',
      },
      new AbortController().signal,
      BASE_NOW,
    );
    if (prepared.kind !== 'ready') throw new Error('Expected a ready turn');
    const stream = orchestration.streamPreparedTurn(prepared, new AbortController().signal);
    const iterator = stream[Symbol.asyncIterator]();
    await expect(iterator.next()).resolves.toMatchObject({ value: { type: 'turn.started' } });
    const firstSegment = await iterator.next();
    expect(postGate.approved).toEqual(['已批准的第一句。']);
    expect(firstSegment).toMatchObject({ value: { type: 'message.segment' } });
    while (!(await iterator.next()).done) {
      // Finish the turn so the test does not leave an active database lease.
    }
  });

  it('deduplicates the same clientRequestId even when a retry submits different text', async () => {
    const userId = await createUser();
    const conversation = await conversationsService.create(userId, BASE_NOW);
    const clientRequestId = randomUUID();
    const principal = { userId, sessionId: randomUUID() };
    const first = await orchestration.preparePersistentTurn(
      principal,
      { clientRequestId, conversationId: conversation.id, message: 'first-sensitive-text' },
      new AbortController().signal,
      BASE_NOW,
    );
    await collect(first);

    const duplicate = await orchestration.preparePersistentTurn(
      principal,
      { clientRequestId, conversationId: conversation.id, message: 'different-sensitive-text' },
      new AbortController().signal,
      BASE_NOW,
    );
    expect(duplicate).toMatchObject({ kind: 'existing', turn: { status: 'completed' } });
    expect(provider.streamCalls).toBe(1);
    expect(await quotaService.getUsage(userId, BASE_NOW)).toMatchObject({ usedCount: 1 });
    const persisted = await messagesService.readMessages(userId, conversation.id, BASE_NOW);
    expect(persisted).toHaveLength(2);
    expect(JSON.stringify(persisted)).not.toContain('different-sensitive-text');
  });

  it('serializes concurrent claims with the same clientRequestId into one turn', async () => {
    const userId = await createUser();
    const conversation = await conversationsService.create(userId, BASE_NOW);
    const clientRequestId = randomUUID();
    const claim = {
      userId,
      conversationId: conversation.id,
      clientRequestId,
      promptKey: 'supportive-chat',
      promptVersion: 'test',
      now: BASE_NOW,
    };

    const [first, second] = await Promise.all([
      turnsService.claim(claim),
      turnsService.claim(claim),
    ]);
    expect([first.created, second.created].sort()).toEqual([false, true]);
    expect(first.turn.id).toBe(second.turn.id);

    const [countResult] = await databaseService.database
      .select({ value: count() })
      .from(aiTurns)
      .where(and(eq(aiTurns.userId, userId), eq(aiTurns.clientRequestId, clientRequestId)));
    expect(countResult?.value).toBe(1);
  });

  it('enforces one active generation per conversation with a database constraint', async () => {
    const userId = await createUser();
    const conversation = await conversationsService.create(userId, BASE_NOW);
    const input = {
      userId,
      conversationId: conversation.id,
      promptKey: 'supportive-chat',
      promptVersion: 'test',
      now: BASE_NOW,
    };

    const attempts = await Promise.allSettled([
      turnsService.claim({ ...input, clientRequestId: randomUUID() }),
      turnsService.claim({ ...input, clientRequestId: randomUUID() }),
    ]);
    expect(attempts.filter((attempt) => attempt.status === 'fulfilled')).toHaveLength(1);
    const rejected = attempts.find((attempt) => attempt.status === 'rejected');
    expect(rejected).toMatchObject({ reason: { code: 'AI_TURN_IN_PROGRESS', statusCode: 409 } });
  });

  it('recovers a stale claimed turn after its lease expires', async () => {
    const userId = await createUser();
    const conversation = await conversationsService.create(userId, BASE_NOW);
    const staleId = randomUUID();
    await databaseService.database.insert(aiTurns).values({
      id: staleId,
      userId,
      conversationId: conversation.id,
      clientRequestId: randomUUID(),
      status: 'claimed',
      promptKey: 'supportive-chat',
      promptVersion: 'test',
      leaseExpiresAt: new Date(BASE_NOW.getTime() - 1),
      createdAt: new Date(BASE_NOW.getTime() - 10_000),
      startedAt: new Date(BASE_NOW.getTime() - 10_000),
    });

    const recovered = await turnsService.claim({
      userId,
      conversationId: conversation.id,
      clientRequestId: randomUUID(),
      promptKey: 'supportive-chat',
      promptVersion: 'test',
      now: BASE_NOW,
    });
    expect(recovered).toMatchObject({ created: true, turn: { status: 'claimed' } });
    const [stale] = await databaseService.database
      .select()
      .from(aiTurns)
      .where(eq(aiTurns.id, staleId));
    expect(stale).toMatchObject({ status: 'failed', failureCode: 'STALE_TURN' });
  });

  it('refunds provider failure before delivery and retains only the user message', async () => {
    provider.reset('fail-before-segment');
    const userId = await createUser();
    const conversation = await conversationsService.create(userId, BASE_NOW);
    const prepared = await orchestration.preparePersistentTurn(
      { userId, sessionId: randomUUID() },
      {
        clientRequestId: randomUUID(),
        conversationId: conversation.id,
        message: 'synthetic-failure',
      },
      new AbortController().signal,
      BASE_NOW,
    );

    await expect(collect(prepared)).rejects.toMatchObject({ code: 'AI_PROVIDER_UNAVAILABLE' });
    expect(await quotaService.getUsage(userId, BASE_NOW)).toMatchObject({ usedCount: 0 });
    expect(await messagesService.readMessages(userId, conversation.id, BASE_NOW)).toEqual([
      expect.objectContaining({ role: 'user', content: 'synthetic-failure' }),
    ]);
  });

  it('charges once but never saves a partial assistant message after delivered output fails', async () => {
    provider.reset('fail-after-segment');
    const userId = await createUser();
    const conversation = await conversationsService.create(userId, BASE_NOW);
    const prepared = await orchestration.preparePersistentTurn(
      { userId, sessionId: randomUUID() },
      {
        clientRequestId: randomUUID(),
        conversationId: conversation.id,
        message: 'synthetic-partial',
      },
      new AbortController().signal,
      BASE_NOW,
    );
    if (prepared.kind !== 'ready') throw new Error('Expected ready');
    const stream = orchestration.streamPreparedTurn(prepared, new AbortController().signal);
    const iterator = stream[Symbol.asyncIterator]();
    await iterator.next();
    await expect(iterator.next()).resolves.toMatchObject({ value: { type: 'message.segment' } });
    await expect(iterator.next()).rejects.toMatchObject({ code: 'AI_PROVIDER_UNAVAILABLE' });

    expect(await quotaService.getUsage(userId, BASE_NOW)).toMatchObject({ usedCount: 1 });
    const persisted = await messagesService.readMessages(userId, conversation.id, BASE_NOW);
    expect(persisted).toHaveLength(1);
    expect(persisted[0]).toMatchObject({ role: 'user', content: 'synthetic-partial' });
  });

  it('refunds cancellation before provider dispatch', async () => {
    const userId = await createUser();
    const conversation = await conversationsService.create(userId, BASE_NOW);
    const controller = new AbortController();
    const prepared = await orchestration.preparePersistentTurn(
      { userId, sessionId: randomUUID() },
      {
        clientRequestId: randomUUID(),
        conversationId: conversation.id,
        message: 'synthetic-cancel',
      },
      controller.signal,
      BASE_NOW,
    );
    controller.abort(new Error('cancel-before-dispatch'));

    await expect(collect(prepared, controller.signal)).rejects.toMatchObject({
      code: 'AI_PROVIDER_UNAVAILABLE',
    });
    expect(provider.streamCalls).toBe(0);
    expect(await quotaService.getUsage(userId, BASE_NOW)).toMatchObject({ usedCount: 0 });
  });

  it('propagates client cancellation after dispatch and charges exactly once', async () => {
    provider.reset('wait-for-abort');
    const userId = await createUser();
    const conversation = await conversationsService.create(userId, BASE_NOW);
    const controller = new AbortController();
    const prepared = await orchestration.preparePersistentTurn(
      { userId, sessionId: randomUUID() },
      {
        clientRequestId: randomUUID(),
        conversationId: conversation.id,
        message: 'synthetic-abort',
      },
      controller.signal,
      BASE_NOW,
    );
    if (prepared.kind !== 'ready') throw new Error('Expected ready');
    const stream = orchestration.streamPreparedTurn(prepared, controller.signal);
    const iterator = stream[Symbol.asyncIterator]();
    await iterator.next();
    const pending = iterator.next();
    await provider.dispatched;
    controller.abort(new Error('client_disconnect'));
    await expect(pending).rejects.toMatchObject({ code: 'AI_PROVIDER_UNAVAILABLE' });
    expect(await quotaService.getUsage(userId, BASE_NOW)).toMatchObject({ usedCount: 1 });
    const [turn] = await databaseService.database
      .select({ status: aiTurns.status })
      .from(aiTurns)
      .where(eq(aiTurns.id, prepared.turn.id));
    expect(turn?.status).toBe('cancelled');
  });

  it('maps first-token timeout to 504 and refunds when nothing was delivered', async () => {
    provider.reset('wait-for-abort');
    const userId = await createUser();
    const conversation = await conversationsService.create(userId, BASE_NOW);
    const prepared = await orchestration.preparePersistentTurn(
      { userId, sessionId: randomUUID() },
      {
        clientRequestId: randomUUID(),
        conversationId: conversation.id,
        message: 'synthetic-timeout',
      },
      new AbortController().signal,
      BASE_NOW,
    );

    await expect(collect(prepared)).rejects.toMatchObject({
      code: 'AI_PROVIDER_TIMEOUT',
      statusCode: 504,
    });
    expect(await quotaService.getUsage(userId, BASE_NOW)).toMatchObject({ usedCount: 0 });
  });

  it('maps stream idle timeout to 504 and keeps the charge after an approved segment', async () => {
    provider.reset('wait-after-segment');
    const userId = await createUser();
    const conversation = await conversationsService.create(userId, BASE_NOW);
    const prepared = await orchestration.preparePersistentTurn(
      { userId, sessionId: randomUUID() },
      {
        clientRequestId: randomUUID(),
        conversationId: conversation.id,
        message: 'synthetic-idle-timeout',
      },
      new AbortController().signal,
      BASE_NOW,
    );

    await expect(collect(prepared)).rejects.toMatchObject({
      code: 'AI_PROVIDER_TIMEOUT',
      statusCode: 504,
    });
    expect(await quotaService.getUsage(userId, BASE_NOW)).toMatchObject({ usedCount: 1 });
    if (prepared.kind !== 'ready') throw new Error('Expected ready');
    const persisted = await turnsService.findByClientRequestId(
      userId,
      prepared.turn.clientRequestId,
    );
    expect(persisted).toMatchObject({ status: 'failed', assistantMessageId: null });
  });

  it('enforces total timeout while deltas continue and never completes a partial response', async () => {
    provider.reset('stream-until-abort');
    const originalTotalTimeout = env.LLM_TOTAL_TIMEOUT_MS;
    env.LLM_TOTAL_TIMEOUT_MS = 100;
    try {
      const userId = await createUser();
      const conversation = await conversationsService.create(userId, BASE_NOW);
      const prepared = await orchestration.preparePersistentTurn(
        { userId, sessionId: randomUUID() },
        {
          clientRequestId: randomUUID(),
          conversationId: conversation.id,
          message: 'synthetic-total-timeout',
        },
        new AbortController().signal,
        BASE_NOW,
      );

      await expect(collect(prepared)).rejects.toMatchObject({
        code: 'AI_PROVIDER_TIMEOUT',
        statusCode: 504,
      });
      expect(await quotaService.getUsage(userId, BASE_NOW)).toMatchObject({ usedCount: 1 });
      if (prepared.kind !== 'ready') throw new Error('Expected ready');
      const persisted = await turnsService.findByClientRequestId(
        userId,
        prepared.turn.clientRequestId,
      );
      expect(persisted).toMatchObject({ status: 'failed', assistantMessageId: null });
    } finally {
      env.LLM_TOTAL_TIMEOUT_MS = originalTotalTimeout;
    }
  });

  it('rejects missing, withdrawn, and outdated required consent before ownership or provider access', async () => {
    const missingConsentUser = await createUser(false);
    const withdrawnConsentUser = await createUser(false);
    const outdatedConsentUser = await createUser(false);

    await databaseService.database.insert(consents).values([
      {
        id: randomUUID(),
        userId: withdrawnConsentUser,
        consentType: 'terms_of_service',
        consentVersion: '1.0',
        status: 'accepted',
        acceptedAt: BASE_NOW,
      },
      {
        id: randomUUID(),
        userId: withdrawnConsentUser,
        consentType: 'privacy_policy',
        consentVersion: '1.0',
        status: 'withdrawn',
        acceptedAt: BASE_NOW,
        withdrawnAt: BASE_NOW,
      },
      {
        id: randomUUID(),
        userId: outdatedConsentUser,
        consentType: 'terms_of_service',
        consentVersion: '0.9',
        status: 'accepted',
        acceptedAt: BASE_NOW,
      },
      {
        id: randomUUID(),
        userId: outdatedConsentUser,
        consentType: 'privacy_policy',
        consentVersion: '0.9',
        status: 'accepted',
        acceptedAt: BASE_NOW,
      },
    ]);

    for (const userId of [missingConsentUser, withdrawnConsentUser, outdatedConsentUser]) {
      await expect(
        orchestration.preparePersistentTurn(
          { userId, sessionId: randomUUID() },
          {
            clientRequestId: randomUUID(),
            conversationId: randomUUID(),
            message: 'must-not-reach-provider',
          },
          new AbortController().signal,
          BASE_NOW,
        ),
      ).rejects.toMatchObject({ code: 'CONSENT_REQUIRED' });

      const [turnCount] = await databaseService.database
        .select({ value: count() })
        .from(aiTurns)
        .where(eq(aiTurns.userId, userId));
      expect(turnCount?.value).toBe(0);
    }
    expect(provider.streamCalls).toBe(0);
  });

  it('checks ownership before claiming an AI turn', async () => {
    const owner = await createUser();
    const conversation = await conversationsService.create(owner, BASE_NOW);

    const attacker = await createUser();
    await expect(
      orchestration.preparePersistentTurn(
        { userId: attacker, sessionId: randomUUID() },
        { clientRequestId: randomUUID(), conversationId: conversation.id, message: 'not-sent' },
        new AbortController().signal,
        BASE_NOW,
      ),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
    const [attackerTurns] = await databaseService.database
      .select({ value: count() })
      .from(aiTurns)
      .where(eq(aiTurns.userId, attacker));
    expect(attackerTurns?.value).toBe(0);
  });

  it('assembles owned ordered context from the newest whole messages', async () => {
    const userId = await createUser();
    const conversation = await conversationsService.create(userId, BASE_NOW);
    for (let index = 1; index <= 25; index += 1) {
      await messagesService.appendMessage(
        userId,
        conversation.id,
        index % 2 === 0 ? 'assistant' : 'user',
        `history-${index}`,
        BASE_NOW,
      );
    }

    const context = await contextService.buildPersistentContext(
      userId,
      conversation.id,
      'current-message',
      BASE_NOW,
    );
    expect(context.messages[0]?.role).toBe('system');
    expect(context.messages.at(-1)).toEqual({ role: 'user', content: 'current-message' });
    expect(context.messages.slice(1, -1)).toHaveLength(20);
    expect(context.messages[1]?.content).toBe('history-6');
    expect(context.messages.at(-2)?.content).toBe('history-25');
  });

  it('serves authenticated CSRF-protected SSE without provider internals', async () => {
    const userId = await createUser();
    const conversation = await conversationsService.create(userId, BASE_NOW);
    const rawToken = 'synthetic-session-token';
    const sessionId = randomUUID();
    await databaseService.database.insert(sessions).values({
      id: sessionId,
      userId,
      tokenHash: hashSessionToken(rawToken),
      createdAt: BASE_NOW,
      expiresAt: new Date(Date.now() + 60_000),
    });
    const response = await request(app.getHttpServer())
      .post('/ai/chat/stream')
      .set('Origin', 'http://localhost:5173')
      .set('Cookie', `mh_session=${rawToken}; mh_csrf=synthetic-csrf`)
      .set('x-csrf-token', 'synthetic-csrf')
      .send({
        clientRequestId: randomUUID(),
        conversationId: conversation.id,
        message: 'synthetic-http-message',
      })
      .expect(200)
      .expect('content-type', /text\/event-stream/u);

    expect(response.text).toContain('event: turn.started');
    expect(response.text).toContain('event: message.segment');
    expect(response.text).toContain('event: turn.completed');
    expect(response.headers['cache-control']).toBe('no-cache, no-transform');
    expect(response.headers['x-accel-buffering']).toBe('no');
    expect(response.text).not.toContain('fake-stream-model');
    expect(response.text).not.toContain('safe-fake-trace');
    expect(response.text).not.toContain('promptVersion');
    expect(response.text).not.toContain('inputTokens');
  });

  it('uses the existing authentication boundary for the streaming endpoint', async () => {
    await request(app.getHttpServer())
      .post('/ai/chat/stream')
      .set('Origin', 'http://localhost:5173')
      .send({ clientRequestId: randomUUID(), message: 'synthetic-unauthorized' })
      .expect(401)
      .expect({
        success: false,
        error: { code: 'UNAUTHENTICATED', message: '请先登录' },
      });
    expect(provider.streamCalls).toBe(0);
  });

  it('clears session-scoped incognito context when logout revokes the session', async () => {
    const userId = await createUser();
    const sessionId = randomUUID();
    await databaseService.database.insert(sessions).values({
      id: sessionId,
      userId,
      tokenHash: hashSessionToken('synthetic-incognito-session'),
      createdAt: BASE_NOW,
      expiresAt: new Date(BASE_NOW.getTime() + 60_000),
    });
    const context = incognitoStore.create(userId, sessionId, BASE_NOW);
    incognitoStore.append(
      userId,
      sessionId,
      context.id,
      { role: 'user', content: 'ephemeral-only' },
      BASE_NOW,
    );

    await sessionsService.revoke({
      id: sessionId,
      userId,
      expiresAt: new Date(BASE_NOW.getTime() + 60_000),
      revokedAt: null,
    });

    expect(incognitoStore.get(userId, sessionId, context.id, BASE_NOW)).toBeNull();
  });

  it('fails closed before provider access when incognito memory is lost after quota consumption', async () => {
    const userId = await createUser();
    const sessionId = randomUUID();
    const clientRequestId = randomUUID();
    const context = incognitoStore.create(userId, sessionId, BASE_NOW);
    const quotaIdempotencyKey = deriveIncognitoQuotaIdempotencyKey(
      userId,
      sessionId,
      clientRequestId,
    );

    await quotaService.consumeQuota(userId, quotaIdempotencyKey, BASE_NOW);
    expect(incognitoStore.end(userId, sessionId, context.id)).toBe(true);

    await expect(
      incognitoAdmission.claim({
        userId,
        sessionId,
        contextId: context.id,
        clientRequestId,
        message: 'must-not-reach-provider-after-context-loss',
        signal: new AbortController().signal,
        now: BASE_NOW,
      }),
    ).rejects.toMatchObject({ code: 'AI_INCOGNITO_CONTEXT_LOST', statusCode: 409 });

    expect(provider.streamCalls).toBe(0);
    expect(await quotaService.getUsage(userId, BASE_NOW)).toMatchObject({ usedCount: 1 });
    const [ledgerCount] = await databaseService.database
      .select({ value: count() })
      .from(quotaConsumptions)
      .where(
        and(
          eq(quotaConsumptions.userId, userId),
          eq(quotaConsumptions.idempotencyKey, quotaIdempotencyKey),
        ),
      );
    expect(ledgerCount?.value).toBe(1);
  });

  it('does not leave duplicate quota ledger entries for one completed turn', async () => {
    const userId = await createUser();
    const conversation = await conversationsService.create(userId, BASE_NOW);
    const clientRequestId = randomUUID();
    const prepared = await orchestration.preparePersistentTurn(
      { userId, sessionId: randomUUID() },
      { clientRequestId, conversationId: conversation.id, message: 'synthetic-ledger' },
      new AbortController().signal,
      BASE_NOW,
    );
    await collect(prepared);
    if (prepared.kind !== 'ready') throw new Error('Expected ready');

    const [ledger] = await databaseService.database
      .select({ value: count() })
      .from(quotaConsumptions)
      .where(
        and(
          eq(quotaConsumptions.userId, userId),
          eq(quotaConsumptions.idempotencyKey, prepared.turn.id),
        ),
      );
    expect(ledger?.value).toBe(1);
  });
});
