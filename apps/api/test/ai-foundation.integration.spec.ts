import { randomUUID } from 'node:crypto';
import {
  aiTurns,
  and,
  auditLogs,
  conversations,
  count,
  createDatabaseClient,
  eq,
  migrate,
  messages,
  quotaConsumptions,
  sessions,
  users,
} from '@mental-health/database';
import { type INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { resolve } from 'node:path';
import request from 'supertest';
import { insertConsentFixture, insertRequiredConsentFixtures } from './consent-fixtures';
import { AiOrchestrationService } from '../src/ai/ai-orchestration.service';
import { ConversationContextService } from '../src/ai/context/conversation-context.service';
import { IncognitoGenerationAdmissionService } from '../src/ai/incognito/incognito-generation-admission.service';
import { IncognitoContextsService } from '../src/ai/incognito/incognito-contexts.service';
import { ConsentExecutionCoordinator } from '../src/consents/runtime/consent-execution.coordinator';
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
  | 'wait-before-completion'
  | 'stream-until-abort';

class FakeStreamingProvider implements LLMProvider {
  mode: FakeMode = 'success';
  streamCalls = 0;
  dispatched: Promise<void> = Promise.resolve();
  private resolveDispatched: (() => void) | null = null;
  private completionReleased: Promise<void> = Promise.resolve();
  private resolveCompletion: (() => void) | null = null;

  reset(mode: FakeMode): void {
    this.resolveCompletion?.();
    this.mode = mode;
    this.streamCalls = 0;
    this.dispatched = new Promise((resolve) => {
      this.resolveDispatched = resolve;
    });
    this.completionReleased =
      mode === 'wait-before-completion'
        ? new Promise((resolve) => {
            this.resolveCompletion = resolve;
          })
        : Promise.resolve();
    if (mode !== 'wait-before-completion') {
      this.resolveCompletion = null;
    }
  }

  releaseCompletion(): void {
    this.resolveCompletion?.();
    this.resolveCompletion = null;
  }

  chat(): Promise<LLMChatResult> {
    return Promise.reject(new LLMProviderFailure('unconfigured', false));
  }

  async *streamChat(
    request: LLMChatRequest,
    options: LLMCallOptions,
  ): AsyncIterable<LLMProviderStreamEvent> {
    void request;
    await options.startTransport((signal) => {
      if (signal.aborted) throw signal.reason;
      return undefined;
    });
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
    if (this.mode === 'wait-before-completion') {
      await this.completionReleased;
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
  let incognitoContexts: IncognitoContextsService;
  let consentExecutions: ConsentExecutionCoordinator;
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
    incognitoContexts = moduleRef.get(IncognitoContextsService);
    consentExecutions = moduleRef.get(ConsentExecutionCoordinator);
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
      await insertRequiredConsentFixtures(databaseService.database, userId, BASE_NOW);
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
    expect(
      await databaseService.database
        .select()
        .from(quotaConsumptions)
        .where(eq(quotaConsumptions.userId, userId)),
    ).toHaveLength(1);

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

  it('refunds and cancels a prepared turn when delivery closes after turn.started but before dispatch', async () => {
    const userId = await createUser();
    const conversation = await conversationsService.create(userId, BASE_NOW);
    const prepared = await orchestration.preparePersistentTurn(
      { userId, sessionId: randomUUID() },
      {
        clientRequestId: randomUUID(),
        conversationId: conversation.id,
        message: 'synthetic-first-frame-close',
      },
      new AbortController().signal,
      BASE_NOW,
    );
    if (prepared.kind !== 'ready') throw new Error('Expected a ready turn');

    const stream = orchestration.streamPreparedTurn(prepared, new AbortController().signal);
    const iterator = stream[Symbol.asyncIterator]();
    await expect(iterator.next()).resolves.toMatchObject({
      done: false,
      value: { type: 'turn.started' },
    });
    await iterator.return?.();

    expect(provider.streamCalls).toBe(0);
    expect(await quotaService.getUsage(userId, BASE_NOW)).toMatchObject({ usedCount: 0 });
    await expect(
      turnsService.findByClientRequestId(userId, prepared.turn.clientRequestId),
    ).resolves.toMatchObject({
      status: 'cancelled',
      failureCode: 'STREAM_DELIVERY_TERMINATED',
      assistantMessageId: null,
    });
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

  it('does not return retained-turn replay metadata after the execution deadline passes', async () => {
    const userId = await createUser();
    const conversation = await conversationsService.create(userId, BASE_NOW);
    const clientRequestId = randomUUID();
    const principal = { userId, sessionId: randomUUID() };
    const first = await orchestration.preparePersistentTurn(
      principal,
      { clientRequestId, conversationId: conversation.id, message: 'synthetic-first-request' },
      new AbortController().signal,
      BASE_NOW,
    );
    await collect(first);

    const originalFind = turnsService.findByClientRequestId.bind(turnsService);
    const dateSpy = jest.spyOn(Date, 'now');
    const expiredNow = Date.now() + env.LLM_TOTAL_TIMEOUT_MS + 1_000;
    const findSpy = jest
      .spyOn(turnsService, 'findByClientRequestId')
      .mockImplementationOnce(async (...input) => {
        const result = await originalFind(...input);
        dateSpy.mockReturnValue(expiredNow);
        return result;
      });

    try {
      await expect(
        orchestration.preparePersistentTurn(
          principal,
          { clientRequestId, conversationId: conversation.id, message: 'synthetic-replay' },
          new AbortController().signal,
          BASE_NOW,
        ),
      ).rejects.toMatchObject({ code: 'AI_PROVIDER_TIMEOUT', statusCode: 504 });
    } finally {
      findSpy.mockRestore();
      dateSpy.mockRestore();
    }

    expect(provider.streamCalls).toBe(1);
    expect(await quotaService.getUsage(userId, BASE_NOW)).toMatchObject({ usedCount: 1 });
  });

  it('does not return claim-race replay metadata after the execution deadline passes', async () => {
    const userId = await createUser();
    const conversation = await conversationsService.create(userId, BASE_NOW);
    const clientRequestId = randomUUID();
    const principal = { userId, sessionId: randomUUID() };
    const first = await orchestration.preparePersistentTurn(
      principal,
      { clientRequestId, conversationId: conversation.id, message: 'synthetic-first-request' },
      new AbortController().signal,
      BASE_NOW,
    );
    await collect(first);

    const originalClaim = turnsService.claim.bind(turnsService);
    const dateSpy = jest.spyOn(Date, 'now');
    const expiredNow = Date.now() + env.LLM_TOTAL_TIMEOUT_MS + 1_000;
    const findSpy = jest.spyOn(turnsService, 'findByClientRequestId').mockResolvedValueOnce(null);
    const claimSpy = jest.spyOn(turnsService, 'claim').mockImplementationOnce(async (...input) => {
      const result = await originalClaim(...input);
      expect(result.created).toBe(false);
      dateSpy.mockReturnValue(expiredNow);
      return result;
    });

    try {
      await expect(
        orchestration.preparePersistentTurn(
          principal,
          { clientRequestId, conversationId: conversation.id, message: 'synthetic-race-replay' },
          new AbortController().signal,
          BASE_NOW,
        ),
      ).rejects.toMatchObject({ code: 'AI_PROVIDER_TIMEOUT', statusCode: 504 });
    } finally {
      claimSpy.mockRestore();
      findSpy.mockRestore();
      dateSpy.mockRestore();
    }

    expect(provider.streamCalls).toBe(1);
    expect(await quotaService.getUsage(userId, BASE_NOW)).toMatchObject({ usedCount: 1 });
  });

  it('rejects replay metadata when the supplied original conversation does not match', async () => {
    const userId = await createUser();
    const original = await conversationsService.create(userId, BASE_NOW);
    const unrelated = await conversationsService.create(userId, BASE_NOW);
    const clientRequestId = randomUUID();
    const principal = { userId, sessionId: randomUUID() };
    const first = await orchestration.preparePersistentTurn(
      principal,
      { clientRequestId, conversationId: original.id, message: 'synthetic-original' },
      new AbortController().signal,
      BASE_NOW,
    );
    await collect(first);

    await expect(
      orchestration.preparePersistentTurn(
        principal,
        { clientRequestId, conversationId: unrelated.id, message: 'synthetic-recovery' },
        new AbortController().signal,
        BASE_NOW,
      ),
    ).rejects.toMatchObject({ code: 'CONFLICT', statusCode: 409 });
    expect(provider.streamCalls).toBe(1);
    expect(await quotaService.getUsage(userId, BASE_NOW)).toMatchObject({ usedCount: 1 });
    expect(await messagesService.readMessages(userId, unrelated.id, BASE_NOW)).toHaveLength(0);
  });

  it('never recreates a purged new-chat conversation when recovery binds its original id', async () => {
    const userId = await createUser();
    const clientRequestId = randomUUID();
    const principal = { userId, sessionId: randomUUID() };
    const first = await orchestration.preparePersistentTurn(
      principal,
      { clientRequestId, message: 'synthetic-new-chat' },
      new AbortController().signal,
      BASE_NOW,
    );
    if (first.kind !== 'ready') throw new Error('Expected a ready turn');
    const originalConversationId = first.turn.conversationId;
    await collect(first);
    await conversationsService.delete(userId, originalConversationId, BASE_NOW);
    expect(await conversationsService.purgeExpired(BASE_NOW, 10)).toBe(1);

    await expect(
      orchestration.preparePersistentTurn(
        principal,
        {
          clientRequestId,
          conversationId: originalConversationId,
          message: 'synthetic-bound-recovery',
        },
        new AbortController().signal,
        BASE_NOW,
      ),
    ).rejects.toMatchObject({ code: 'NOT_FOUND', statusCode: 404 });

    expect(provider.streamCalls).toBe(1);
    expect(await quotaService.getUsage(userId, BASE_NOW)).toMatchObject({ usedCount: 1 });
    const retainedQuotaLedger = await databaseService.database
      .select()
      .from(quotaConsumptions)
      .where(eq(quotaConsumptions.userId, userId));
    expect(retainedQuotaLedger).toHaveLength(1);
    expect(
      await databaseService.database
        .select()
        .from(conversations)
        .where(eq(conversations.userId, userId)),
    ).toHaveLength(0);
    expect(
      await databaseService.database.select().from(aiTurns).where(eq(aiTurns.userId, userId)),
    ).toHaveLength(0);
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

  it('does not redirect concurrent duplicate claims to a different conversation', async () => {
    const userId = await createUser();
    const firstConversation = await conversationsService.create(userId, BASE_NOW);
    const secondConversation = await conversationsService.create(userId, BASE_NOW);
    const clientRequestId = randomUUID();
    const common = {
      userId,
      clientRequestId,
      promptKey: 'supportive-chat',
      promptVersion: 'test',
      now: BASE_NOW,
    };

    const attempts = await Promise.allSettled([
      turnsService.claim({ ...common, conversationId: firstConversation.id }),
      turnsService.claim({ ...common, conversationId: secondConversation.id }),
    ]);
    expect(attempts.filter((attempt) => attempt.status === 'fulfilled')).toHaveLength(1);
    expect(attempts.filter((attempt) => attempt.status === 'rejected')).toHaveLength(1);
    const rejected = attempts.find((attempt) => attempt.status === 'rejected');
    expect(rejected).toMatchObject({ reason: { code: 'CONFLICT', statusCode: 409 } });

    const rows = await databaseService.database
      .select()
      .from(aiTurns)
      .where(and(eq(aiTurns.userId, userId), eq(aiTurns.clientRequestId, clientRequestId)));
    expect(rows).toHaveLength(1);
    expect([firstConversation.id, secondConversation.id]).toContain(rows[0]?.conversationId);
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

  it('does not persist a late assistant response after its conversation is deleted', async () => {
    provider.reset('wait-before-completion');
    const userId = await createUser();
    const conversation = await conversationsService.create(userId, BASE_NOW);
    const rawToken = `synthetic-delete-race-${randomUUID()}`;
    const csrfToken = 'synthetic-delete-race-csrf';
    await databaseService.database.insert(sessions).values({
      id: randomUUID(),
      userId,
      tokenHash: hashSessionToken(rawToken),
      createdAt: BASE_NOW,
      expiresAt: new Date(Date.now() + 60_000),
    });

    const prepared = await orchestration.preparePersistentTurn(
      { userId, sessionId: randomUUID() },
      {
        clientRequestId: randomUUID(),
        conversationId: conversation.id,
        message: 'synthetic-delete-race-user-content',
      },
      new AbortController().signal,
      BASE_NOW,
    );
    if (prepared.kind !== 'ready') throw new Error('Expected a ready turn');
    const stream = orchestration.streamPreparedTurn(prepared, new AbortController().signal);
    const iterator = stream[Symbol.asyncIterator]();
    await expect(iterator.next()).resolves.toMatchObject({ value: { type: 'turn.started' } });
    await expect(iterator.next()).resolves.toMatchObject({ value: { type: 'message.segment' } });
    const pendingProviderCompletion = iterator.next();
    await provider.dispatched;

    await request(app.getHttpServer())
      .delete(`/conversations/${conversation.id}`)
      .set('Origin', 'http://localhost:5173')
      .set('Cookie', `mh_session=${rawToken}; mh_csrf=${csrfToken}`)
      .set('x-csrf-token', csrfToken)
      .expect(200);
    expect(
      await databaseService.database
        .select()
        .from(messages)
        .where(eq(messages.conversationId, conversation.id)),
    ).toHaveLength(0);
    await request(app.getHttpServer())
      .get(`/conversations/${conversation.id}`)
      .set('Cookie', `mh_session=${rawToken}; mh_csrf=${csrfToken}`)
      .expect(404)
      .expect('Cache-Control', 'private, no-store');

    provider.releaseCompletion();
    await expect(pendingProviderCompletion).resolves.toMatchObject({
      value: { type: 'message.segment' },
    });
    await expect(iterator.next()).rejects.toMatchObject({ code: 'AI_PROVIDER_UNAVAILABLE' });

    expect(
      await databaseService.database
        .select()
        .from(messages)
        .where(eq(messages.conversationId, conversation.id)),
    ).toHaveLength(0);
    const [deletedConversation] = await databaseService.database
      .select()
      .from(conversations)
      .where(eq(conversations.id, conversation.id));
    expect(deletedConversation?.deletedAt).not.toBeNull();
    const [failedTurn] = await databaseService.database
      .select()
      .from(aiTurns)
      .where(eq(aiTurns.id, prepared.turn.id));
    expect(failedTurn).toMatchObject({ status: 'failed', assistantMessageId: null });
    expect(await quotaService.getUsage(userId, BASE_NOW)).toMatchObject({ usedCount: 1 });
    const [ledgerCount] = await databaseService.database
      .select({ value: count() })
      .from(quotaConsumptions)
      .where(
        and(
          eq(quotaConsumptions.userId, userId),
          eq(quotaConsumptions.idempotencyKey, prepared.turn.id),
        ),
      );
    expect(ledgerCount?.value).toBe(1);
    const deletionAudits = await databaseService.database
      .select()
      .from(auditLogs)
      .where(eq(auditLogs.resourceId, conversation.id));
    expect(deletionAudits).toHaveLength(1);
    expect(JSON.stringify(deletionAudits)).not.toMatch(
      /delete-race-user-content|已批准|这是第二句/u,
    );
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
    // Leave enough budget for the real database-backed preparation path even under CI load,
    // while still exercising the registry's total-turn deadline during a live provider stream.
    env.LLM_TOTAL_TIMEOUT_MS = 1_000;
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
      expect(provider.streamCalls).toBe(1);
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

    await insertConsentFixture(databaseService.database, {
      userId: withdrawnConsentUser,
      consentType: 'terms_of_service',
      consentVersion: '1.1',
      acceptedAt: BASE_NOW,
    });
    await insertConsentFixture(databaseService.database, {
      userId: withdrawnConsentUser,
      consentType: 'privacy_policy',
      consentVersion: '1.1',
      status: 'withdrawn',
      acceptedAt: BASE_NOW,
      withdrawnAt: BASE_NOW,
    });
    await insertConsentFixture(databaseService.database, {
      userId: outdatedConsentUser,
      consentType: 'terms_of_service',
      consentVersion: '0.9',
      acceptedAt: BASE_NOW,
      documentBound: false,
    });
    await insertConsentFixture(databaseService.database, {
      userId: outdatedConsentUser,
      consentType: 'privacy_policy',
      consentVersion: '0.9',
      acceptedAt: BASE_NOW,
      documentBound: false,
    });

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
        mode: 'persistent',
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
    expect(response.text).not.toContain('deliveryMode');
    expect(response.text).not.toContain('knowledgeReferences');

    const v2Response = await request(app.getHttpServer())
      .post('/ai/chat/stream')
      .set('Origin', 'http://localhost:5173')
      .set('Cookie', `mh_session=${rawToken}; mh_csrf=synthetic-csrf`)
      .set('x-csrf-token', 'synthetic-csrf')
      .set('X-MH-Knowledge-References', '1')
      .send({
        mode: 'persistent',
        clientRequestId: randomUUID(),
        conversationId: conversation.id,
        message: 'synthetic-v2-http-message',
      })
      .expect(200)
      .expect('content-type', /text\/event-stream/u);
    expect(v2Response.headers['x-mh-knowledge-references']).toBe('1');
    expect(v2Response.headers.vary).toContain('X-MH-Knowledge-References');
    expect(v2Response.text).toContain('"deliveryMode":"immediate"');
    expect(v2Response.text).toContain('"knowledgeReferences":[]');

    await request(app.getHttpServer())
      .post('/ai/chat/stream')
      .set('Origin', 'http://localhost:5173')
      .set('Cookie', `mh_session=${rawToken}; mh_csrf=synthetic-csrf`)
      .set('x-csrf-token', 'synthetic-csrf')
      .set('X-MH-Knowledge-References', 'unsupported')
      .send({
        mode: 'persistent',
        clientRequestId: randomUUID(),
        conversationId: conversation.id,
        message: 'must-not-reach-provider',
      })
      .expect(400)
      .expect({
        success: false,
        error: { code: 'VALIDATION_ERROR', message: '不支持的知识引用协议版本' },
      });
  });

  it('returns a bounded timeout before SSE headers when the deadline passes before its timer runs', async () => {
    const now = new Date();
    const userId = await createUser();
    const conversation = await conversationsService.create(userId, now);
    const rawToken = `synthetic-pre-stream-timeout-${randomUUID()}`;
    await databaseService.database.insert(sessions).values({
      id: randomUUID(),
      userId,
      tokenHash: hashSessionToken(rawToken),
      createdAt: now,
      expiresAt: new Date(now.getTime() + 60_000),
    });
    const originalPrepare = orchestration.preparePersistentTurn.bind(orchestration);
    const prepareSpy = jest
      .spyOn(orchestration, 'preparePersistentTurn')
      .mockImplementationOnce(async (...input) => {
        const prepared = await originalPrepare(...input);
        if (prepared.kind !== 'ready') throw new Error('Expected a ready Persistent turn');
        prepared.execution.deadlineAt.setTime(Date.now() - 1);
        return prepared;
      });

    try {
      await request(app.getHttpServer())
        .post('/ai/chat/stream')
        .set('Origin', 'http://localhost:5173')
        .set('Cookie', `mh_session=${rawToken}; mh_csrf=synthetic-csrf`)
        .set('x-csrf-token', 'synthetic-csrf')
        .send({
          mode: 'persistent',
          clientRequestId: randomUUID(),
          conversationId: conversation.id,
          message: 'synthetic-pre-stream-timeout',
        })
        .expect(504)
        .expect({
          success: false,
          error: { code: 'AI_PROVIDER_TIMEOUT', message: 'AI 服务响应超时，请稍后重试' },
        });

      expect(provider.streamCalls).toBe(0);
      expect(await quotaService.getUsage(userId, now)).toMatchObject({ usedCount: 0 });
      const [turn] = await databaseService.database
        .select()
        .from(aiTurns)
        .where(eq(aiTurns.conversationId, conversation.id));
      expect(turn).toMatchObject({
        status: 'failed',
        failureCode: 'TOTAL_TIMEOUT_BEFORE_PROVIDER',
      });
    } finally {
      prepareSpy.mockRestore();
    }
  });

  it('returns the same bounded timeout for Incognito before SSE headers when its timer is delayed', async () => {
    const now = new Date();
    const userId = await createUser();
    const sessionId = randomUUID();
    const rawToken = `synthetic-incognito-pre-stream-timeout-${randomUUID()}`;
    await databaseService.database.insert(sessions).values({
      id: sessionId,
      userId,
      tokenHash: hashSessionToken(rawToken),
      createdAt: now,
      expiresAt: new Date(now.getTime() + 60_000),
    });
    const context = await incognitoContexts.create(
      {
        id: sessionId,
        userId,
        expiresAt: new Date(now.getTime() + 60_000),
        revokedAt: null,
      },
      now,
    );
    const originalPrepare = orchestration.prepareIncognitoTurn.bind(orchestration);
    const prepareSpy = jest
      .spyOn(orchestration, 'prepareIncognitoTurn')
      .mockImplementationOnce(async (...input) => {
        const prepared = await originalPrepare(...input);
        if (prepared.kind !== 'ready') throw new Error('Expected a ready Incognito turn');
        prepared.execution.deadlineAt.setTime(Date.now() - 1);
        return prepared;
      });

    try {
      await request(app.getHttpServer())
        .post('/ai/chat/stream')
        .set('Origin', 'http://localhost:5173')
        .set('Cookie', `mh_session=${rawToken}; mh_csrf=synthetic-csrf`)
        .set('x-csrf-token', 'synthetic-csrf')
        .send({
          mode: 'incognito',
          clientRequestId: randomUUID(),
          contextId: context.id,
          message: 'synthetic-incognito-pre-stream-timeout',
        })
        .expect(504)
        .expect({
          success: false,
          error: { code: 'AI_PROVIDER_TIMEOUT', message: 'AI 服务响应超时，请稍后重试' },
        });

      expect(provider.streamCalls).toBe(0);
      expect(await quotaService.getUsage(userId, now)).toMatchObject({ usedCount: 0 });
    } finally {
      prepareSpy.mockRestore();
    }
  });

  it('returns Consent-required instead of hanging when Incognito is revoked after prepare', async () => {
    const now = new Date();
    const userId = await createUser();
    const sessionId = randomUUID();
    const rawToken = `synthetic-pre-stream-consent-${randomUUID()}`;
    await databaseService.database.insert(sessions).values({
      id: sessionId,
      userId,
      tokenHash: hashSessionToken(rawToken),
      createdAt: now,
      expiresAt: new Date(now.getTime() + 60_000),
    });
    const context = await incognitoContexts.create(
      {
        id: sessionId,
        userId,
        expiresAt: new Date(now.getTime() + 60_000),
        revokedAt: null,
      },
      now,
    );
    const originalPrepare = orchestration.prepareIncognitoTurn.bind(orchestration);
    const prepareSpy = jest
      .spyOn(orchestration, 'prepareIncognitoTurn')
      .mockImplementationOnce(async (...input) => {
        const prepared = await originalPrepare(...input);
        if (prepared.kind !== 'ready') throw new Error('Expected a ready Incognito turn');
        prepared.execution.abort(new Error('consent_withdrawn'));
        return prepared;
      });

    try {
      await request(app.getHttpServer())
        .post('/ai/chat/stream')
        .set('Origin', 'http://localhost:5173')
        .set('Cookie', `mh_session=${rawToken}; mh_csrf=synthetic-csrf`)
        .set('x-csrf-token', 'synthetic-csrf')
        .send({
          mode: 'incognito',
          clientRequestId: randomUUID(),
          contextId: context.id,
          message: 'synthetic-pre-stream-consent-withdrawal',
        })
        .expect(400)
        .expect({
          success: false,
          error: { code: 'CONSENT_REQUIRED', message: '请接受当前版本的必要条款' },
        });

      expect(provider.streamCalls).toBe(0);
      expect(await quotaService.getUsage(userId, now)).toMatchObject({ usedCount: 0 });
    } finally {
      prepareSpy.mockRestore();
    }
  });

  it('uses the existing authentication boundary for the streaming endpoint', async () => {
    await request(app.getHttpServer())
      .post('/ai/chat/stream')
      .set('Origin', 'http://localhost:5173')
      .send({
        mode: 'persistent',
        clientRequestId: randomUUID(),
        message: 'synthetic-unauthorized',
      })
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
    const context = incognitoStore.create(
      userId,
      sessionId,
      new Date(BASE_NOW.getTime() + 60_000),
      [],
      BASE_NOW,
    );
    const generation = incognitoStore.claimGeneration(
      userId,
      sessionId,
      context.id,
      randomUUID(),
      new AbortController().signal,
      BASE_NOW,
    );
    if (!generation) throw new Error('Expected an Incognito generation claim');
    incognitoStore.append(
      userId,
      sessionId,
      context.id,
      generation.id,
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
    const context = incognitoStore.create(
      userId,
      sessionId,
      new Date(BASE_NOW.getTime() + 60_000),
      [],
      BASE_NOW,
    );
    const quotaIdempotencyKey = deriveIncognitoQuotaIdempotencyKey(
      userId,
      sessionId,
      clientRequestId,
    );

    await quotaService.consumeQuota(userId, quotaIdempotencyKey, BASE_NOW);
    expect(incognitoStore.end(userId, sessionId, context.id)).toBe(true);

    const pendingExecution = consentExecutions.registerPending({
      userId,
      sessionId,
      clientSignal: new AbortController().signal,
    });
    const execution = await consentExecutions.bindRequired(pendingExecution);
    await expect(
      incognitoAdmission.claim({
        userId,
        sessionId,
        contextId: context.id,
        clientRequestId,
        message: 'must-not-reach-provider-after-context-loss',
        signal: new AbortController().signal,
        execution,
        now: BASE_NOW,
      }),
    ).rejects.toMatchObject({ code: 'AI_INCOGNITO_CONTEXT_LOST', statusCode: 409 });
    execution.dispose();

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
