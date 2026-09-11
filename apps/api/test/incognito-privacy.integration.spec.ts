import { randomUUID } from 'node:crypto';
import {
  aiTurns,
  consentDecisions,
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
import type { IncognitoAiStreamEvent } from '@mental-health/types';
import type { INestApplication } from '@nestjs/common';
import { Test, type TestingModule } from '@nestjs/testing';
import { resolve } from 'node:path';
import request from 'supertest';
import { insertConsentFixture, insertRequiredConsentFixtures } from './consent-fixtures';
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
import { ConsentLifecycleRepository } from '../src/consents/consent-lifecycle.repository';
import { ConsentExecutionCoordinator } from '../src/consents/runtime/consent-execution.coordinator';
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

type ProviderMode = 'success' | 'fail-before-segment' | 'wait-for-release';

class ControlledGenerationProvider implements LLMProvider {
  mode: ProviderMode = 'success';
  streamCalls = 0;
  streamSignals: AbortSignal[] = [];
  dispatched = deferred();
  private releaseBarrier = deferred();

  reset(mode: ProviderMode = 'success'): void {
    this.releaseBarrier.resolve();
    this.mode = mode;
    this.streamCalls = 0;
    this.streamSignals = [];
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
    this.streamCalls += 1;
    this.streamSignals.push(options.signal);
    const metadata = { provider: 'fake', model: 'phase5c-fake', requestId: 'safe-trace' };
    this.dispatched.resolve();
    yield { type: 'started', metadata };
    if (this.mode === 'fail-before-segment') {
      throw new LLMProviderFailure('upstream', true, metadata.requestId);
    }
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
  let consentLifecycle: ConsentLifecycleRepository;
  let consentExecutions: ConsentExecutionCoordinator;
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
    consentLifecycle = moduleRef.get(ConsentLifecycleRepository);
    consentExecutions = moduleRef.get(ConsentExecutionCoordinator);
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
    await database.database.insert(users).values({ id: userId, createdAt: now });
    if (withRequiredConsents) {
      await insertRequiredConsentFixtures(database.database, userId, now);
    }
    return createSessionForUser(userId, now);
  }

  async function createSessionForUser(userId: string, now = new Date()): Promise<AuthFixture> {
    const sessionId = randomUUID();
    const rawToken = `phase5c-session-${randomUUID()}`;
    const csrfToken = `phase5c-csrf-${randomUUID()}`;
    const expiresAt = new Date(now.getTime() + 60 * 60 * 1000);
    await database.database.insert(sessions).values({
      id: sessionId,
      userId,
      tokenHash: hashSessionToken(rawToken),
      createdAt: now,
      expiresAt,
    });
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

  async function withdrawalRequest(
    auth: AuthFixture,
    consentType: 'privacy_policy' | 'terms_of_service',
  ) {
    const current = await consentsService.list(auth.userId, { limit: 20 });
    const consent = current.data.currentRequiredConsents.find(
      (candidate) => candidate.consentType === consentType,
    );
    if (!consent) throw new Error(`Synthetic ${consentType} Consent fixture is missing`);
    return mutation(auth, '/consents')
      .send({
        operationId: randomUUID(),
        action: 'withdraw',
        consentType,
        consentVersion: consent.consentVersion,
        expectedRevision: consent.stateRevision,
      })
      .expect(200);
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
    await withdrawalRequest(auth, 'privacy_policy');
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

  it('keeps an uncertain committed withdrawal fail closed and replays the same operationId', async () => {
    const auth = await createAuth();
    const contextId = await createContext(auth);
    const operationId = randomUUID();
    const body = {
      operationId,
      action: 'withdraw',
      consentType: 'privacy_policy',
      consentVersion: env.REQUIRED_PRIVACY_VERSION,
      expectedRevision: 1,
    } as const;
    const originalClearDependency = contexts.clearDependency.bind(contexts);
    const clearSpy = jest
      .spyOn(contexts, 'clearDependency')
      .mockImplementationOnce(() => {
        throw new Error('synthetic_cleanup_failure');
      })
      .mockImplementation(originalClearDependency);
    const decisionsBefore = await database.database
      .select({ value: count() })
      .from(consentDecisions)
      .where(eq(consentDecisions.userId, auth.userId));

    try {
      const uncertain = await mutation(auth, '/consents')
        .send(body)
        .expect('Cache-Control', 'private, no-store')
        .expect(503);
      expect(uncertain.body.error.code).toBe('CONSENT_RESULT_UNKNOWN');
      expect(contexts.get(auth.userId, auth.sessionId, contextId)).toBeNull();

      const replay = await mutation(auth, '/consents').send(body).expect(200);
      expect(replay.body.data).toMatchObject({
        receipt: { operationId, action: 'withdraw', outcome: 'applied' },
        current: { status: 'withdrawn', stateRevision: 2 },
      });
      expect(contexts.get(auth.userId, auth.sessionId, contextId)).toBeNull();
      const decisionsAfter = await database.database
        .select({ value: count() })
        .from(consentDecisions)
        .where(eq(consentDecisions.userId, auth.userId));
      expect(decisionsAfter).toEqual(decisionsBefore.map((row) => ({ value: row.value + 1 })));
    } finally {
      clearSpy.mockRestore();
    }
  });

  it('fails closed when a committed withdrawal loses its acknowledgement before runtime publication', async () => {
    provider.reset('wait-for-release');
    const auth = await createAuth();
    const contextId = await createContext(auth);
    const pendingStream = stream(auth, {
      mode: 'incognito',
      contextId,
      clientRequestId: randomUUID(),
      message: '合成的提交确认丢失竞态输入',
    }).then((response) => response);
    await provider.dispatched.promise;

    const operationId = randomUUID();
    const body = {
      operationId,
      action: 'withdraw',
      consentType: 'privacy_policy',
      consentVersion: env.REQUIRED_PRIVACY_VERSION,
      expectedRevision: 1,
    } as const;
    const committed = deferred();
    const dropAcknowledgement = deferred();
    const originalMutate = consentLifecycle.mutate.bind(consentLifecycle);
    const mutateSpy = jest
      .spyOn(consentLifecycle, 'mutate')
      .mockImplementationOnce(async (...args) => {
        await originalMutate(...args);
        committed.resolve();
        await dropAcknowledgement.promise;
        throw new Error('synthetic_commit_acknowledgement_lost');
      })
      .mockImplementation(originalMutate);
    const decisionsBefore = await database.database
      .select({ value: count() })
      .from(consentDecisions)
      .where(eq(consentDecisions.userId, auth.userId));

    try {
      const uncertainPromise = mutation(auth, '/consents')
        .send(body)
        .expect(503)
        .then((response) => response);
      await committed.promise;
      const committedOperation = await consentLifecycle.findOperation(auth.userId, operationId);
      expect(committedOperation).toMatchObject({
        operationId,
        decision: 'withdrawn',
        outcome: 'applied',
      });
      expect(contexts.get(auth.userId, auth.sessionId, contextId)).not.toBeNull();

      dropAcknowledgement.resolve();
      const uncertain = await uncertainPromise;
      expect(uncertain.body.error.code).toBe('CONSENT_RESULT_UNKNOWN');
      expect(provider.streamSignals).toHaveLength(1);
      expect(provider.streamSignals[0]?.aborted).toBe(true);
      expect(contexts.get(auth.userId, auth.sessionId, contextId)).toBeNull();

      mutateSpy.mockRestore();
      const replay = await mutation(auth, '/consents').send(body).expect(200);
      expect(replay.body.data).toMatchObject({
        receipt: { operationId, action: 'withdraw', outcome: 'applied' },
        current: { status: 'withdrawn', stateRevision: 2 },
      });
      const decisionsAfterReplay = await database.database
        .select({ value: count() })
        .from(consentDecisions)
        .where(eq(consentDecisions.userId, auth.userId));
      expect(decisionsAfterReplay).toEqual(
        decisionsBefore.map((row) => ({ value: row.value + 1 })),
      );

      await mutation(auth, '/consents')
        .send({
          operationId: randomUUID(),
          action: 'accept',
          consentType: 'privacy_policy',
          consentVersion: env.REQUIRED_PRIVACY_VERSION,
          documentKey: 'synthetic.privacy-policy',
          documentRevision: 'test-revision-2',
          expectedRevision: 2,
        })
        .expect(200);
      const replacementContextId = await createContext(auth);
      await mutation(auth, '/consents').send(body).expect(200);
      expect(contexts.get(auth.userId, auth.sessionId, replacementContextId)).not.toBeNull();

      provider.releaseLateResult();
      const response = await pendingStream;
      expect(response.text).not.toContain('这是合成且安全的回复。');
      expect(response.text).not.toContain('event: turn.completed');
    } finally {
      mutateSpy.mockRestore();
      dropAcknowledgement.resolve();
      provider.releaseLateResult();
    }
  });

  it('replays an old withdrawal without clearing a context bound to later reacceptance', async () => {
    const auth = await createAuth();
    const oldContextId = await createContext(auth);
    const withdrawalOperationId = randomUUID();
    const withdrawalBody = {
      operationId: withdrawalOperationId,
      action: 'withdraw',
      consentType: 'privacy_policy',
      consentVersion: env.REQUIRED_PRIVACY_VERSION,
      expectedRevision: 1,
    } as const;
    await mutation(auth, '/consents').send(withdrawalBody).expect(200);
    expect(contexts.get(auth.userId, auth.sessionId, oldContextId)).toBeNull();

    await mutation(auth, '/consents')
      .send({
        operationId: randomUUID(),
        action: 'accept',
        consentType: 'privacy_policy',
        consentVersion: env.REQUIRED_PRIVACY_VERSION,
        documentKey: 'synthetic.privacy-policy',
        documentRevision: 'test-revision-2',
        expectedRevision: 2,
      })
      .expect(200);
    const newContextId = await createContext(auth);

    const replay = await mutation(auth, '/consents').send(withdrawalBody).expect(200);
    expect(replay.body.data).toMatchObject({
      receipt: { operationId: withdrawalOperationId, action: 'withdraw', outcome: 'applied' },
      current: { status: 'accepted', stateRevision: 3 },
    });
    expect(contexts.get(auth.userId, auth.sessionId, newContextId)).not.toBeNull();
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
    provider.reset('wait-for-release');
    const auth = await createAuth();
    const contextId = await createContext(auth);
    const clientRequestId = randomUUID();
    const requestBody = {
      mode: 'incognito',
      contextId,
      clientRequestId,
      message: '合成并发幂等输入',
    };
    const firstResponsePromise = stream(auth, requestBody).then((response) => response);
    await provider.dispatched.promise;

    const previousGlobalExecutions = env.CONSENT_ACTIVE_EXECUTIONS_MAX_GLOBAL;
    const previousUserExecutions = env.CONSENT_ACTIVE_EXECUTIONS_MAX_PER_USER;
    const previousGlobalWaiters = env.CONSENT_LOCK_MAX_WAITERS_GLOBAL;
    const previousUserWaiters = env.CONSENT_LOCK_MAX_WAITERS_PER_USER;
    env.CONSENT_ACTIVE_EXECUTIONS_MAX_GLOBAL = Math.max(previousGlobalExecutions, 40);
    env.CONSENT_ACTIVE_EXECUTIONS_MAX_PER_USER = 20;
    env.CONSENT_LOCK_MAX_WAITERS_GLOBAL = Math.max(previousGlobalWaiters, 100);
    env.CONSENT_LOCK_MAX_WAITERS_PER_USER = 50;
    let responses: Awaited<ReturnType<typeof stream>>[];
    try {
      const duplicateResponses = await Promise.all(
        Array.from({ length: 19 }, () => stream(auth, requestBody)),
      );
      provider.releaseLateResult();
      responses = [await firstResponsePromise, ...duplicateResponses];
    } finally {
      provider.releaseLateResult();
      env.CONSENT_ACTIVE_EXECUTIONS_MAX_GLOBAL = previousGlobalExecutions;
      env.CONSENT_ACTIVE_EXECUTIONS_MAX_PER_USER = previousUserExecutions;
      env.CONSENT_LOCK_MAX_WAITERS_GLOBAL = previousGlobalWaiters;
      env.CONSENT_LOCK_MAX_WAITERS_PER_USER = previousUserWaiters;
    }

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

  it('refunds the quota ledger when Provider infrastructure fails before any approved segment', async () => {
    provider.reset('fail-before-segment');
    const auth = await createAuth();
    const contextId = await createContext(auth);
    const clientRequestId = randomUUID();
    const requestBody = {
      mode: 'incognito',
      contextId,
      clientRequestId,
      message: '合成的首段前 Provider 故障输入',
    };
    const response = await stream(auth, requestBody).expect(200);

    const events = parseSse(response.text);
    expect(events.map((event) => event.type)).toEqual(['turn.started', 'turn.failed']);
    expect(events.some((event) => event.type === 'message.segment')).toBe(false);
    expect(provider.streamCalls).toBe(1);
    expect((await quota.getUsage(auth.userId, new Date())).usedCount).toBe(0);
    const [ledgerCount] = await database.database
      .select({ value: count() })
      .from(quotaConsumptions)
      .where(eq(quotaConsumptions.userId, auth.userId));
    expect(Number(ledgerCount?.value)).toBe(0);
    expect(contexts.get(auth.userId, auth.sessionId, contextId)?.messages).toEqual([
      { role: 'user', content: '合成的首段前 Provider 故障输入' },
    ]);

    const replay = await stream(auth, requestBody).expect(409);
    expect(replay.body.error.code).toBe('AI_INCOGNITO_CONTEXT_LOST');
    expect(provider.streamCalls).toBe(1);
    expect(riskClassifier.calls).toBe(1);
  });

  it('rejects a refunded request after its context is lost across a quota day boundary', async () => {
    const auth = await createAuth();
    const beforeMidnight = new Date('2026-09-09T15:59:59.999Z');
    const afterMidnight = new Date('2026-09-09T16:00:00.000Z');
    const context = await consentExecutions.createIncognitoContext({
      userId: auth.userId,
      sessionId: auth.sessionId,
      sessionExpiresAt: new Date('2026-09-10T16:00:00.000Z'),
      signal: new AbortController().signal,
      deadlineAt: new Date(Date.now() + 30_000),
      now: beforeMidnight,
    });
    const clientRequestId = randomUUID();
    const key = deriveIncognitoQuotaIdempotencyKey(auth.userId, auth.sessionId, clientRequestId);
    await quota.consumeQuota(auth.userId, key, beforeMidnight);
    await expect(quota.refundQuota(auth.userId, key, afterMidnight)).resolves.toBe(true);
    contexts.end(auth.userId, auth.sessionId, context.id);

    await expect(
      orchestration.prepareIncognitoTurn(
        { userId: auth.userId, sessionId: auth.sessionId },
        {
          mode: 'incognito',
          contextId: context.id,
          clientRequestId,
          message: '合成的跨日退款后旧上下文请求',
        },
        new AbortController().signal,
        afterMidnight,
      ),
    ).rejects.toMatchObject({ code: 'AI_INCOGNITO_CONTEXT_LOST', statusCode: 409 });
    expect(provider.streamCalls).toBe(0);
    expect(riskClassifier.calls).toBe(0);
    expect(await quota.getUsage(auth.userId, beforeMidnight)).toMatchObject({ usedCount: 0 });
    expect(await quota.getUsage(auth.userId, afterMidnight)).toMatchObject({ usedCount: 0 });
  });

  it('keeps one quota consumption when the client cancels after Provider dispatch', async () => {
    provider.reset('wait-for-release');
    const auth = await createAuth();
    const contextId = await createContext(auth);
    const clientController = new AbortController();
    const prepared = await orchestration.prepareIncognitoTurn(
      { userId: auth.userId, sessionId: auth.sessionId },
      {
        mode: 'incognito',
        contextId,
        clientRequestId: randomUUID(),
        message: '合成的 Provider 启动后取消输入',
      },
      clientController.signal,
    );
    if (prepared.kind !== 'ready') throw new Error('Expected a ready Incognito generation');
    const generated = orchestration.streamPreparedIncognitoTurn(prepared, clientController.signal);
    const iterator = generated[Symbol.asyncIterator]();
    await expect(iterator.next()).resolves.toMatchObject({
      value: { type: 'turn.started', data: { mode: 'incognito' } },
    });
    const pending = iterator.next();
    await provider.dispatched.promise;
    clientController.abort(new Error('synthetic_client_cancel'));
    provider.releaseLateResult();

    await expect(pending).rejects.toMatchObject({ code: 'AI_PROVIDER_UNAVAILABLE' });
    expect(provider.streamCalls).toBe(1);
    expect((await quota.getUsage(auth.userId, new Date())).usedCount).toBe(1);
    const [ledgerCount] = await database.database
      .select({ value: count() })
      .from(quotaConsumptions)
      .where(eq(quotaConsumptions.userId, auth.userId));
    expect(Number(ledgerCount?.value)).toBe(1);
    expect(contexts.get(auth.userId, auth.sessionId, contextId)?.messages).toEqual([
      { role: 'user', content: '合成的 Provider 启动后取消输入' },
    ]);
  });

  it('cancels an in-flight generation at context session expiry and rejects late output', async () => {
    provider.reset('wait-for-release');
    const auth = await createAuth();
    const now = new Date();
    const context = await consentExecutions.createIncognitoContext({
      userId: auth.userId,
      sessionId: auth.sessionId,
      sessionExpiresAt: new Date(now.getTime() + 100),
      signal: new AbortController().signal,
      deadlineAt: new Date(Date.now() + 30_000),
      now,
    });
    const prepared = await orchestration.prepareIncognitoTurn(
      { userId: auth.userId, sessionId: auth.sessionId },
      {
        mode: 'incognito',
        contextId: context.id,
        clientRequestId: randomUUID(),
        message: '合成的 Session 到期竞态输入',
      },
      new AbortController().signal,
      now,
    );
    if (prepared.kind !== 'ready') throw new Error('Expected a ready Incognito generation');
    const generated = orchestration.streamPreparedIncognitoTurn(
      prepared,
      new AbortController().signal,
    );
    const iterator = generated[Symbol.asyncIterator]();
    const visibleEvents: IncognitoAiStreamEvent[] = [];
    const started = await iterator.next();
    if (!started.done) visibleEvents.push(started.value);
    const pending = iterator.next();
    await provider.dispatched.promise;
    expect(contexts.purgeExpired(new Date(now.getTime() + 101))).toBe(1);
    provider.releaseLateResult();

    await expect(pending).rejects.toMatchObject({ code: 'AI_PROVIDER_UNAVAILABLE' });
    expect(visibleEvents.map((event) => event.type)).toEqual(['turn.started']);
    expect(visibleEvents.some((event) => event.type === 'message.segment')).toBe(false);
    expect(visibleEvents.some((event) => event.type === 'turn.completed')).toBe(false);
    expect(
      contexts.get(auth.userId, auth.sessionId, context.id, new Date(now.getTime() + 101)),
    ).toBeNull();
    expect(provider.streamCalls).toBe(1);
  });

  it('does not disclose or mutate an Incognito context across users or sessions', async () => {
    const owner = await createAuth();
    const sameUserOtherSession = await createSessionForUser(owner.userId);
    const otherUser = await createAuth();
    const contextId = await createContext(owner);
    const body = {
      mode: 'incognito',
      contextId,
      clientRequestId: randomUUID(),
      message: '合成的 ownership 输入',
    };

    const crossSession = await stream(sameUserOtherSession, body).expect(409);
    const crossUser = await stream(otherUser, { ...body, clientRequestId: randomUUID() }).expect(
      409,
    );
    expect(crossSession.body.error.code).toBe('AI_INCOGNITO_CONTEXT_LOST');
    expect(crossUser.body.error.code).toBe('AI_INCOGNITO_CONTEXT_LOST');
    expect(provider.streamCalls).toBe(0);
    expect(riskClassifier.calls).toBe(0);

    await endContext(sameUserOtherSession, contextId).expect(200);
    await endContext(otherUser, contextId).expect(200);
    expect(contexts.get(owner.userId, owner.sessionId, contextId)).not.toBeNull();

    await stream(owner, { ...body, clientRequestId: randomUUID() }).expect(200);
    expect(provider.streamCalls).toBe(1);
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

  it('serializes withdrawal with consent lookup and makes the prepared result unusable', async () => {
    const auth = await createAuth();
    const contextId = await createContext(auth);
    const entered = deferred();
    const release = deferred();
    const originalFindProjection = consentLifecycle.findProjection.bind(consentLifecycle);
    const findProjection = jest
      .spyOn(consentLifecycle, 'findProjection')
      .mockImplementationOnce(async (...args) => {
        entered.resolve();
        await release.promise;
        return originalFindProjection(...args);
      });
    const preparation = orchestration
      .prepareIncognitoTurn(
        { userId: auth.userId, sessionId: auth.sessionId },
        {
          mode: 'incognito',
          contextId,
          clientRequestId: randomUUID(),
          message: '合成的 Consent 查询竞态输入',
        },
        new AbortController().signal,
      )
      .then(
        (value) => ({ status: 'fulfilled' as const, value }),
        (reason: unknown) => ({ status: 'rejected' as const, reason }),
      );
    await entered.promise;

    const withdrawal = mutation(auth, '/consents')
      .send({
        operationId: randomUUID(),
        action: 'withdraw',
        consentType: 'privacy_policy',
        consentVersion: env.REQUIRED_PRIVACY_VERSION,
        expectedRevision: 1,
      })
      .expect(200);
    release.resolve();
    await withdrawal;
    const preparationOutcome = await preparation;
    if (preparationOutcome.status === 'fulfilled') {
      expect(preparationOutcome.value.kind).toBe('ready');
      if (preparationOutcome.value.kind !== 'ready') {
        throw new Error('Synthetic LOW-risk preparation must use the ready path');
      }
      const preparedStream = orchestration.streamPreparedIncognitoTurn(
        preparationOutcome.value,
        new AbortController().signal,
      );
      const iterator = preparedStream[Symbol.asyncIterator]();
      await expect(iterator.next()).resolves.toMatchObject({
        done: false,
        value: { type: 'turn.started' },
      });
      await expect(iterator.next()).rejects.toBeDefined();
    } else {
      expect(preparationOutcome.reason).toEqual(
        expect.objectContaining({ message: 'consent_withdrawn' }),
      );
    }
    findProjection.mockRestore();

    expect(contexts.get(auth.userId, auth.sessionId, contextId)).toBeNull();
    expect(provider.streamCalls).toBe(0);
    // The classifier may be entered before withdrawal wins the next lock, or skipped
    // when withdrawal wins first. Either ordering must remain at-most-once and must
    // not dispatch the generation Provider.
    expect(riskClassifier.calls).toBeLessThanOrEqual(1);
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

    const privacyConsent = await consentsService.list(auth.userId, { limit: 20 });
    const privacy = privacyConsent.data.currentRequiredConsents.find(
      (consent) => consent.consentType === 'privacy_policy',
    );
    if (!privacy) throw new Error('Synthetic privacy Consent fixture is missing');
    await consentsService.mutate(auth.userId, {
      operationId: randomUUID(),
      action: 'withdraw',
      consentType: 'privacy_policy',
      consentVersion: env.REQUIRED_PRIVACY_VERSION,
      expectedRevision: privacy.stateRevision,
    });
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

    await withdrawalRequest(auth, 'privacy_policy');
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
    await insertConsentFixture(database.database, {
      userId: auth.userId,
      consentType: 'terms_of_service',
      consentVersion: '0.9',
      status: 'withdrawn',
      acceptedAt: new Date(Date.now() - 20_000),
      withdrawnAt: new Date(Date.now() - 10_000),
      documentBound: false,
    });
    await insertConsentFixture(database.database, {
      userId: auth.userId,
      consentType: 'privacy_policy',
      consentVersion: '0.9',
      acceptedAt: new Date(Date.now() - 30_000),
      documentBound: false,
    });

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
          isCurrentRequired: true,
          status: 'accepted',
          documentEvidenceStatus: 'verified',
          acceptableDocument: expect.objectContaining({
            documentKey: 'synthetic.terms-of-service',
            documentRevision: 'test-revision-2',
          }),
        }),
        expect.objectContaining({
          consentType: 'privacy_policy',
          consentVersion: env.REQUIRED_PRIVACY_VERSION,
          isCurrentRequired: true,
          status: 'accepted',
          documentEvidenceStatus: 'verified',
          acceptableDocument: expect.objectContaining({
            documentKey: 'synthetic.privacy-policy',
            documentRevision: 'test-revision-2',
          }),
        }),
      ]),
    );
    expect(first.body.data.consentStates).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          consentType: 'terms_of_service',
          consentVersion: '0.9',
          isCurrentRequired: false,
          status: 'withdrawn',
          stateRevision: 2,
          documentKey: null,
          documentRevision: null,
          documentEvidenceStatus: 'unmapped_legacy',
          acceptableDocument: null,
          acceptanceEnabled: false,
          withdrawalEnabled: false,
        }),
        expect.objectContaining({
          consentType: 'privacy_policy',
          consentVersion: '0.9',
          isCurrentRequired: false,
          status: 'accepted',
          stateRevision: 1,
          documentKey: null,
          documentRevision: null,
          documentEvidenceStatus: 'unmapped_legacy',
          acceptableDocument: null,
          acceptanceEnabled: false,
          withdrawalEnabled: true,
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
    expect(second.body.data.nextCursor).toEqual(expect.any(String));
    const third = await request(app.getHttpServer())
      .get(`/consents?limit=2&cursor=${encodeURIComponent(second.body.data.nextCursor as string)}`)
      .set('Cookie', auth.cookie)
      .expect(200);
    expect(third.body.data.consents).toHaveLength(1);
    expect(third.body.data.nextCursor).toBeNull();
    const history = [
      ...first.body.data.consents,
      ...second.body.data.consents,
      ...third.body.data.consents,
    ] as Array<Record<string, unknown>>;
    expect(history).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          action: 'accept',
          consentVersion: '0.9',
          documentKey: null,
          documentRevision: null,
          documentEvidenceStatus: 'unmapped_legacy',
        }),
        expect.objectContaining({
          action: 'withdraw',
          consentVersion: '0.9',
          targetDocumentKey: null,
          targetDocumentRevision: null,
          targetDocumentEvidenceStatus: 'unmapped_legacy',
        }),
      ]),
    );
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
