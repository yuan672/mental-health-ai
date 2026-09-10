import { randomUUID } from 'node:crypto';
import {
  aiTurns,
  and,
  consents,
  conversations,
  count,
  createDatabaseClient,
  eq,
  messages,
  migrate,
  quotaConsumptions,
  riskEvents,
  sessions,
  users,
} from '@mental-health/database';
import type { INestApplication } from '@nestjs/common';
import { Test, type TestingModule } from '@nestjs/testing';
import { resolve } from 'node:path';
import request from 'supertest';
import { AiOrchestrationService } from '../src/ai/ai-orchestration.service';
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
import { AppModule } from '../src/app.module';
import { hashSessionToken } from '../src/auth/sessions.service';
import { AppExceptionFilter } from '../src/common/filters/app-exception.filter';
import { env } from '../src/config/env';
import { ConsentsService } from '../src/consents/consents.service';
import { DatabaseService } from '../src/database/database.service';
import { QuotaService } from '../src/quota/quota.service';
import {
  OUTPUT_SAFETY_CLASSIFIER,
  type OutputSafetyClassifier,
  type OutputSafetyClassifierResult,
} from '../src/safety/output/output-safety-classifier';
import {
  RISK_CLASSIFIER,
  type RiskClassifier,
  type RiskClassifierResult,
} from '../src/safety/risk/risk-classifier';
import type { SafetyAssessmentContext } from '../src/safety/safety.types';

const WEB_ORIGIN = 'http://localhost:5173';

type Deferred<T = void> = {
  promise: Promise<T>;
  resolve: (value: T | PromiseLike<T>) => void;
  reject: (reason?: unknown) => void;
};

function deferred<T = void>(): Deferred<T> {
  let resolve!: Deferred<T>['resolve'];
  let reject!: Deferred<T>['reject'];
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

type ProviderMode = 'success' | 'wait-for-release';

class ControlledGenerationProvider implements LLMProvider {
  mode: ProviderMode = 'success';
  streamCalls = 0;
  dispatched = deferred();
  private releaseBarrier = deferred();

  reset(mode: ProviderMode = 'success'): void {
    this.releaseBarrier.resolve();
    this.mode = mode;
    this.streamCalls = 0;
    this.dispatched = deferred();
    this.releaseBarrier = deferred();
  }

  releaseLateResult(): void {
    this.releaseBarrier.resolve();
  }

  chat(): Promise<LLMChatResult> {
    return Promise.reject(new LLMProviderFailure('unconfigured', false));
  }

  async *streamChat(
    request: LLMChatRequest,
    options: LLMCallOptions,
  ): AsyncIterable<LLMProviderStreamEvent> {
    void request;
    void options;
    this.streamCalls += 1;
    const metadata = { provider: 'fake', model: 'phase5c-fake', requestId: 'safe-trace' };
    this.dispatched.resolve();
    yield { type: 'started', metadata };
    if (this.mode === 'wait-for-release') {
      // Deliberately ignore AbortSignal until released. This simulates a late, badly behaved
      // upstream result so the application boundary—not the fake—must reject it.
      await this.releaseBarrier.promise;
    }
    yield { type: 'text_delta', text: '这是合成且安全的回复。' };
    yield {
      type: 'completed',
      finishReason: 'stop',
      usage: { inputTokens: 2, outputTokens: 3, totalTokens: 5 },
      metadata,
    };
  }

  classifyRisk(): Promise<LLMRiskClassificationCandidate> {
    return Promise.reject(new LLMUnsupportedCapabilityError('classifyRisk'));
  }

  embed(): Promise<LLMEmbeddingResult> {
    return Promise.reject(new LLMUnsupportedCapabilityError('embed'));
  }

  healthCheck(): Promise<LLMHealthStatus> {
    return Promise.resolve({ status: 'healthy', checkedAt: new Date(), latencyMs: 0 });
  }
}

class ControlledRiskClassifier implements RiskClassifier {
  calls = 0;
  candidateLevel: RiskClassifierResult['candidateLevel'] = 'LOW';

  reset(level: RiskClassifierResult['candidateLevel'] = 'LOW'): void {
    this.calls = 0;
    this.candidateLevel = level;
  }

  classify(
    requestId: string,
    context: SafetyAssessmentContext,
    signal: AbortSignal,
  ): Promise<RiskClassifierResult> {
    void requestId;
    void context;
    void signal;
    this.calls += 1;
    const elevated = this.candidateLevel !== 'LOW';
    return Promise.resolve({
      candidateLevel: this.candidateLevel,
      harmSubject: elevated ? 'SELF' : 'UNKNOWN',
      categories: elevated ? ['SELF_HARM'] : [],
      temporality: elevated ? 'CURRENT' : 'UNKNOWN',
      ideation: elevated ? 'PASSIVE' : 'NONE',
      intent: 'ABSENT',
      plan: 'ABSENT',
      means: 'ABSENT',
      immediacy: 'NONE',
      confidence: 0.95,
      reasonCodes: elevated ? ['SELF_HARM_IDEATION'] : [],
      classifierKey: 'risk-classification',
      classifierVersion: 'phase5c-test-v1',
    });
  }
}

class AllowingOutputClassifier implements OutputSafetyClassifier {
  calls = 0;

  reset(): void {
    this.calls = 0;
  }

  classify(
    input: Parameters<OutputSafetyClassifier['classify']>[0],
    signal: AbortSignal,
  ): Promise<OutputSafetyClassifierResult> {
    void input;
    void signal;
    this.calls += 1;
    return Promise.resolve({
      decision: 'ALLOW',
      reasonCodes: [],
      classifierKey: 'output-safety-classification',
      classifierVersion: 'phase5c-test-v1',
    });
  }
}

type AuthFixture = {
  userId: string;
  sessionId: string;
  rawToken: string;
  csrfToken: string;
  cookie: string;
  expiresAt: Date;
};

type ParsedSseEvent = {
  type: string;
  data: Record<string, unknown>;
};

function parseSse(text: string): ParsedSseEvent[] {
  return text
    .split(/\r?\n\r?\n/u)
    .map((frame) => frame.trim())
    .filter(Boolean)
    .map((frame) => {
      const eventLine = frame.split(/\r?\n/u).find((line) => line.startsWith('event: '));
      const dataLine = frame.split(/\r?\n/u).find((line) => line.startsWith('data: '));
      if (!eventLine || !dataLine) throw new Error(`Invalid SSE frame: ${frame}`);
      return {
        type: eventLine.slice('event: '.length),
        data: JSON.parse(dataLine.slice('data: '.length)) as Record<string, unknown>,
      };
    });
}

describe('Phase 5C Incognito and privacy API integration', () => {
  let app: INestApplication;
  let moduleRef: TestingModule;
  let migrationClient: ReturnType<typeof createDatabaseClient>;
  let database: DatabaseService;
  let orchestration: AiOrchestrationService;
  let contexts: InMemoryIncognitoContextStore;
  let consentsService: ConsentsService;
  let quota: QuotaService;
  const provider = new ControlledGenerationProvider();
  const riskClassifier = new ControlledRiskClassifier();
  const outputClassifier = new AllowingOutputClassifier();

  beforeAll(async () => {
    const url = process.env.TEST_DATABASE_URL;
    if (!url) throw new Error('TEST_DATABASE_URL is required for Phase 5C integration tests');
    const databaseName = decodeURIComponent(new URL(url).pathname.slice(1));
    if (!databaseName.endsWith('_test')) {
      throw new Error('Phase 5C integration tests refuse a database without an _test suffix');
    }

    migrationClient = createDatabaseClient(url);
    await migrationClient.pool.query('DROP SCHEMA IF EXISTS drizzle CASCADE');
    await migrationClient.pool.query('DROP SCHEMA public CASCADE');
    await migrationClient.pool.query('CREATE SCHEMA public');
    await migrate(migrationClient.database, {
      migrationsFolder: resolve(process.cwd(), '../../database/migrations'),
    });

    moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(LLM_PROVIDER)
      .useValue(provider)
      .overrideProvider(RISK_CLASSIFIER)
      .useValue(riskClassifier)
      .overrideProvider(OUTPUT_SAFETY_CLASSIFIER)
      .useValue(outputClassifier)
      .compile();
    app = moduleRef.createNestApplication();
    app.useLogger(false);
    app.useGlobalFilters(new AppExceptionFilter());
    await app.init();

    database = moduleRef.get(DatabaseService);
    orchestration = moduleRef.get(AiOrchestrationService);
    contexts = moduleRef.get(InMemoryIncognitoContextStore);
    consentsService = moduleRef.get(ConsentsService);
    quota = moduleRef.get(QuotaService);
  }, 60_000);

  beforeEach(() => {
    provider.reset();
    riskClassifier.reset();
    outputClassifier.reset();
    env.AI_CHAT_ENABLED = true;
  });

  afterAll(async () => {
    env.AI_CHAT_ENABLED = true;
    if (app) await app.close();
    if (migrationClient) await migrationClient.pool.end();
  });

  async function createAuth(withRequiredConsents = true): Promise<AuthFixture> {
    const now = new Date();
    const userId = randomUUID();
    const sessionId = randomUUID();
    const rawToken = `phase5c-session-${randomUUID()}`;
    const csrfToken = `phase5c-csrf-${randomUUID()}`;
    const expiresAt = new Date(now.getTime() + 60 * 60 * 1000);
    await database.database.insert(users).values({ id: userId, createdAt: now });
    await database.database.insert(sessions).values({
      id: sessionId,
      userId,
      tokenHash: hashSessionToken(rawToken),
      createdAt: now,
      expiresAt,
    });
    if (withRequiredConsents) {
      await database.database.insert(consents).values([
        {
          id: randomUUID(),
          userId,
          consentType: 'terms_of_service',
          consentVersion: env.REQUIRED_TERMS_VERSION,
          status: 'accepted',
          acceptedAt: now,
        },
        {
          id: randomUUID(),
          userId,
          consentType: 'privacy_policy',
          consentVersion: env.REQUIRED_PRIVACY_VERSION,
          status: 'accepted',
          acceptedAt: now,
        },
      ]);
    }
    return {
      userId,
      sessionId,
      rawToken,
      csrfToken,
      cookie: `mh_session=${rawToken}; mh_csrf=${csrfToken}`,
      expiresAt,
    };
  }

  function mutation(auth: AuthFixture, path: string) {
    return request(app.getHttpServer())
      .post(path)
      .set('Origin', WEB_ORIGIN)
      .set('Cookie', auth.cookie)
      .set('x-csrf-token', auth.csrfToken);
  }

  async function createContext(auth: AuthFixture): Promise<string> {
    const response = await mutation(auth, '/incognito-contexts')
      .send({})
      .expect(201)
      .expect('Cache-Control', 'private, no-store');
    return response.body.data.context.id as string;
  }

  function endContext(auth: AuthFixture, contextId: string) {
    return request(app.getHttpServer())
      .delete(`/incognito-contexts/${contextId}`)
      .set('Origin', WEB_ORIGIN)
      .set('Cookie', auth.cookie)
      .set('x-csrf-token', auth.csrfToken);
  }

  function stream(auth: AuthFixture, body: Record<string, unknown>) {
    return mutation(auth, '/ai/chat/stream').send(body);
  }

  async function chatRowCounts() {
    const [conversationCount] = await database.database
      .select({ value: count() })
      .from(conversations);
    const [messageCount] = await database.database.select({ value: count() }).from(messages);
    const [turnCount] = await database.database.select({ value: count() }).from(aiTurns);
    return {
      conversations: Number(conversationCount?.value ?? -1),
      messages: Number(messageCount?.value ?? -1),
      aiTurns: Number(turnCount?.value ?? -1),
    };
  }

  it('protects context lifecycle with authentication, CSRF, consent, AI enablement and no-store', async () => {
    await request(app.getHttpServer()).post('/incognito-contexts').send({}).expect(401);

    const auth = await createAuth();
    await request(app.getHttpServer())
      .post('/incognito-contexts')
      .set('Origin', WEB_ORIGIN)
      .set('Cookie', auth.cookie)
      .send({})
      .expect(403);

    const noConsent = await createAuth(false);
    await mutation(noConsent, '/incognito-contexts')
      .send({})
      .expect(400)
      .expect(({ body }) => expect(body.error.code).toBe('CONSENT_REQUIRED'));

    env.AI_CHAT_ENABLED = false;
    await mutation(auth, '/incognito-contexts')
      .send({})
      .expect(503)
      .expect(({ body }) => expect(body.error.code).toBe('AI_CHAT_DISABLED'));
    expect(provider.streamCalls).toBe(0);
    expect(riskClassifier.calls).toBe(0);
  });

  it('ends idempotently without existence disclosure even after consent withdrawal and AI disablement', async () => {
    const auth = await createAuth();
    const contextId = await createContext(auth);
    await database.database
      .update(consents)
      .set({ status: 'withdrawn', withdrawnAt: new Date() })
      .where(
        and(
          eq(consents.userId, auth.userId),
          eq(consents.consentType, 'privacy_policy'),
          eq(consents.consentVersion, env.REQUIRED_PRIVACY_VERSION),
        ),
      );
    env.AI_CHAT_ENABLED = false;

    const first = await endContext(auth, contextId)
      .expect(200)
      .expect('Cache-Control', 'private, no-store');
    const second = await endContext(auth, contextId).expect(200);
    const unknown = await endContext(auth, randomUUID()).expect(200);
    expect(first.body).toEqual({ success: true, data: { ended: true } });
    expect(second.body).toEqual(first.body);
    expect(unknown.body).toEqual(first.body);
    expect(contexts.get(auth.userId, auth.sessionId, contextId)).toBeNull();
  });

  it('streams a complete LOW Incognito turn with runtime-only identifiers and zero chat rows', async () => {
    const auth = await createAuth();
    const contextId = await createContext(auth);
    const before = await chatRowCounts();
    const clientRequestId = randomUUID();
    const response = await stream(auth, {
      mode: 'incognito',
      contextId,
      clientRequestId,
      message: '合成的普通压力表达',
    })
      .expect(200)
      .expect('content-type', /text\/event-stream/u)
      .expect('Cache-Control', 'no-cache, no-transform');

    const events = parseSse(response.text);
    expect(events.map((event) => event.type)).toEqual([
      'turn.started',
      'message.segment',
      'turn.completed',
    ]);
    const generationIds = events.map((event) => event.data.generationId);
    expect(new Set(generationIds).size).toBe(1);
    for (const event of events) {
      expect(event.data.mode).toBe('incognito');
      expect(event.data).not.toHaveProperty('turnId');
      expect(event.data).not.toHaveProperty('conversationId');
      expect(event.data).not.toHaveProperty('assistantMessageId');
    }
    expect(provider.streamCalls).toBe(1);
    expect(riskClassifier.calls).toBe(1);
    expect(outputClassifier.calls).toBeGreaterThan(0);
    expect(await chatRowCounts()).toEqual(before);
    expect((await quota.getUsage(auth.userId, new Date())).usedCount).toBe(1);
    expect(contexts.get(auth.userId, auth.sessionId, contextId)?.messages).toEqual([
      { role: 'user', content: '合成的普通压力表达' },
      { role: 'assistant', content: '这是合成且安全的回复。' },
    ]);
  });

  it('allows only one of 20 concurrent submissions with the same clientRequestId', async () => {
    const auth = await createAuth();
    const contextId = await createContext(auth);
    const clientRequestId = randomUUID();
    const responses = await Promise.all(
      Array.from({ length: 20 }, () =>
        stream(auth, {
          mode: 'incognito',
          contextId,
          clientRequestId,
          message: '合成并发幂等输入',
        }),
      ),
    );

    expect(responses.filter((response) => response.status === 200)).toHaveLength(1);
    expect(responses.filter((response) => response.status === 409)).toHaveLength(19);
    expect(provider.streamCalls).toBe(1);
    expect(riskClassifier.calls).toBe(1);
    expect((await quota.getUsage(auth.userId, new Date())).usedCount).toBe(1);
    const [ledgerCount] = await database.database
      .select({ value: count() })
      .from(quotaConsumptions)
      .where(eq(quotaConsumptions.userId, auth.userId));
    expect(Number(ledgerCount?.value)).toBe(1);
  });

  it('rejects a different request while a context generation is active and permits it after release', async () => {
    provider.reset('wait-for-release');
    const auth = await createAuth();
    const contextId = await createContext(auth);
    const first = stream(auth, {
      mode: 'incognito',
      contextId,
      clientRequestId: randomUUID(),
      message: '合成的第一条并发输入',
    });
    const firstResult = first.then((response) => response);
    await provider.dispatched.promise;

    const second = await stream(auth, {
      mode: 'incognito',
      contextId,
      clientRequestId: randomUUID(),
      message: '合成的第二条并发输入',
    }).expect(409);
    expect(second.body.error.code).toBe('AI_TURN_IN_PROGRESS');
    expect(provider.streamCalls).toBe(1);
    expect(riskClassifier.calls).toBe(1);

    provider.releaseLateResult();
    expect((await firstResult).status).toBe(200);

    provider.reset();
    await stream(auth, {
      mode: 'incognito',
      contextId,
      clientRequestId: randomUUID(),
      message: '合成的释放后输入',
    }).expect(200);
    expect(provider.streamCalls).toBe(1);
  });

  it('fails closed without Provider access when runtime memory is gone but the quota ledger exists', async () => {
    const auth = await createAuth();
    const contextId = await createContext(auth);
    const clientRequestId = randomUUID();
    const key = deriveIncognitoQuotaIdempotencyKey(auth.userId, auth.sessionId, clientRequestId);
    await quota.consumeQuota(auth.userId, key, new Date());
    contexts.end(auth.userId, auth.sessionId, contextId);

    const response = await stream(auth, {
      mode: 'incognito',
      contextId,
      clientRequestId,
      message: '合成的丢失上下文重试',
    }).expect(409);
    expect(response.body.error.code).toBe('AI_INCOGNITO_CONTEXT_LOST');
    expect(provider.streamCalls).toBe(0);
    expect(riskClassifier.calls).toBe(0);
    expect((await quota.getUsage(auth.userId, new Date())).usedCount).toBe(1);
  });

  it('cancels a late Provider result after explicit end and never appends it', async () => {
    provider.reset('wait-for-release');
    const auth = await createAuth();
    const contextId = await createContext(auth);
    const pending = stream(auth, {
      mode: 'incognito',
      contextId,
      clientRequestId: randomUUID(),
      message: '合成的结束竞态输入',
    });
    const responsePromise = pending.then((response) => response);
    await provider.dispatched.promise;
    await endContext(auth, contextId).expect(200);
    provider.releaseLateResult();

    const response = await responsePromise;
    expect(response.text).not.toContain('这是合成且安全的回复。');
    expect(response.text).not.toContain('event: turn.completed');
    expect(contexts.get(auth.userId, auth.sessionId, contextId)).toBeNull();
  });

  it('registers cancellation before consent lookup and clears a query-in-flight context on withdrawal', async () => {
    const auth = await createAuth();
    const contextId = await createContext(auth);
    const entered = deferred();
    const release = deferred();
    const originalEnsure = consentsService.ensureRequiredConsentsActive.bind(consentsService);
    const ensure = jest
      .spyOn(consentsService, 'ensureRequiredConsentsActive')
      .mockImplementationOnce(async (userId) => {
        entered.resolve();
        await release.promise;
        return originalEnsure(userId);
      });
    const preparation = orchestration.prepareIncognitoTurn(
      { userId: auth.userId, sessionId: auth.sessionId },
      {
        mode: 'incognito',
        contextId,
        clientRequestId: randomUUID(),
        message: '合成的 Consent 查询竞态输入',
      },
      new AbortController().signal,
    );
    await entered.promise;

    await mutation(auth, '/consents')
      .send({
        consentType: 'privacy_policy',
        consentVersion: env.REQUIRED_PRIVACY_VERSION,
        action: 'withdraw',
      })
      .expect(200);
    release.resolve();
    await expect(preparation).rejects.toBeDefined();
    ensure.mockRestore();

    expect(contexts.get(auth.userId, auth.sessionId, contextId)).toBeNull();
    expect(provider.streamCalls).toBe(0);
    expect(riskClassifier.calls).toBe(0);
  });

  it('cancels after admission but before Provider dispatch without retaining quota', async () => {
    const auth = await createAuth();
    const contextId = await createContext(auth);
    const prepared = await orchestration.prepareIncognitoTurn(
      { userId: auth.userId, sessionId: auth.sessionId },
      {
        mode: 'incognito',
        contextId,
        clientRequestId: randomUUID(),
        message: '合成的 Provider 调用前撤回输入',
      },
      new AbortController().signal,
    );
    expect(prepared.kind).toBe('ready');
    expect((await quota.getUsage(auth.userId, new Date())).usedCount).toBe(1);

    await consentsService.withdraw(auth.userId, 'privacy_policy', env.REQUIRED_PRIVACY_VERSION);
    await orchestration.cancelPreparedIncognitoTurnBeforeProvider(prepared);

    expect(provider.streamCalls).toBe(0);
    expect(contexts.get(auth.userId, auth.sessionId, contextId)).toBeNull();
    expect((await quota.getUsage(auth.userId, new Date())).usedCount).toBe(0);
  });

  it('rejects late Provider output after consent withdrawal during generation', async () => {
    provider.reset('wait-for-release');
    const auth = await createAuth();
    const contextId = await createContext(auth);
    const pending = stream(auth, {
      mode: 'incognito',
      contextId,
      clientRequestId: randomUUID(),
      message: '合成的 Provider 已启动撤回输入',
    });
    const responsePromise = pending.then((response) => response);
    await provider.dispatched.promise;

    await mutation(auth, '/consents')
      .send({
        consentType: 'privacy_policy',
        consentVersion: env.REQUIRED_PRIVACY_VERSION,
        action: 'withdraw',
      })
      .expect(200);
    provider.releaseLateResult();

    const response = await responsePromise;
    expect(response.text).not.toContain('这是合成且安全的回复。');
    expect(response.text).not.toContain('event: turn.completed');
    expect(contexts.get(auth.userId, auth.sessionId, contextId)).toBeNull();
    expect(provider.streamCalls).toBe(1);
  });

  it('clears an active Incognito context on logout and rejects late output', async () => {
    provider.reset('wait-for-release');
    const auth = await createAuth();
    const contextId = await createContext(auth);
    const pending = stream(auth, {
      mode: 'incognito',
      contextId,
      clientRequestId: randomUUID(),
      message: '合成的退出竞态输入',
    });
    const responsePromise = pending.then((response) => response);
    await provider.dispatched.promise;

    await mutation(auth, '/auth/logout').send({}).expect(200);
    provider.releaseLateResult();
    const response = await responsePromise;
    expect(response.text).not.toContain('这是合成且安全的回复。');
    expect(response.text).not.toContain('event: turn.completed');
    expect(contexts.get(auth.userId, auth.sessionId, contextId)).toBeNull();
  });

  it('returns sanitized current consent state and bounded cursor history with no-store', async () => {
    const auth = await createAuth();
    await database.database.insert(consents).values([
      {
        id: randomUUID(),
        userId: auth.userId,
        consentType: 'terms_of_service',
        consentVersion: '0.9',
        status: 'withdrawn',
        acceptedAt: new Date(Date.now() - 20_000),
        withdrawnAt: new Date(Date.now() - 10_000),
      },
      {
        id: randomUUID(),
        userId: auth.userId,
        consentType: 'privacy_policy',
        consentVersion: '0.9',
        status: 'accepted',
        acceptedAt: new Date(Date.now() - 30_000),
      },
    ]);

    const first = await request(app.getHttpServer())
      .get('/consents?limit=2')
      .set('Cookie', auth.cookie)
      .expect(200)
      .expect('Cache-Control', 'private, no-store');
    expect(first.body.data.currentRequiredConsents).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          consentType: 'terms_of_service',
          consentVersion: env.REQUIRED_TERMS_VERSION,
          status: 'accepted',
        }),
        expect.objectContaining({
          consentType: 'privacy_policy',
          consentVersion: env.REQUIRED_PRIVACY_VERSION,
          status: 'accepted',
        }),
      ]),
    );
    expect(first.body.data.consents).toHaveLength(2);
    expect(first.body.data.nextCursor).toEqual(expect.any(String));
    const serialized = JSON.stringify(first.body);
    expect(serialized).not.toContain('"userId"');
    expect(serialized).not.toContain('"id"');

    const second = await request(app.getHttpServer())
      .get(`/consents?limit=2&cursor=${encodeURIComponent(first.body.data.nextCursor as string)}`)
      .set('Cookie', auth.cookie)
      .expect(200);
    expect(second.body.data.consents).toHaveLength(2);
    expect(second.body.data.nextCursor).toBeNull();
  });

  it('rejects implicit and mixed persistent/Incognito request shapes before any classifier or Provider call', async () => {
    const auth = await createAuth();
    const contextId = await createContext(auth);
    const common = { clientRequestId: randomUUID(), message: '合成协议验证输入' };
    await stream(auth, { ...common, contextId }).expect(400);
    await stream(auth, {
      ...common,
      mode: 'persistent',
      contextId,
    }).expect(400);
    await stream(auth, {
      ...common,
      mode: 'incognito',
      contextId,
      conversationId: randomUUID(),
    }).expect(400);
    expect(provider.streamCalls).toBe(0);
    expect(riskClassifier.calls).toBe(0);
  });

  it('keeps Incognito psychological content and identifiers out of PostgreSQL safety storage', async () => {
    riskClassifier.reset('MEDIUM');
    const auth = await createAuth();
    const contextId = await createContext(auth);
    const clientRequestId = randomUUID();
    const sensitiveFixture = '合成敏感正文-不得进入数据库';
    await stream(auth, {
      mode: 'incognito',
      contextId,
      clientRequestId,
      message: sensitiveFixture,
    }).expect(200);

    const [event] = await database.database
      .select()
      .from(riskEvents)
      .where(eq(riskEvents.clientRequestId, clientRequestId));
    expect(event).toMatchObject({ userId: auth.userId, isIncognito: true, level: 'MEDIUM' });
    const serialized = JSON.stringify(event);
    expect(serialized).not.toContain(sensitiveFixture);
    expect(serialized).not.toContain(contextId);
    expect(serialized).not.toContain(auth.sessionId);

    const tables = await migrationClient.pool.query<{ table_name: string }>(
      "select table_name from information_schema.tables where table_schema = 'public'",
    );
    expect(tables.rows.map((row) => row.table_name).join(' ')).not.toMatch(/incognito/u);
    const riskColumns = await migrationClient.pool.query<{ column_name: string }>(
      "select column_name from information_schema.columns where table_schema = 'public' and table_name = 'risk_events'",
    );
    expect(riskColumns.rows.map((row) => row.column_name)).not.toEqual(
      expect.arrayContaining([
        'message',
        'content',
        'message_hash',
        'content_hash',
        'session_id',
        'context_id',
      ]),
    );
  });
});
