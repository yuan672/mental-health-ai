import { randomUUID } from 'node:crypto';
import {
  aiTurns,
  auditLogs,
  consentDecisions,
  consents,
  conversations as conversationRows,
  count,
  createDatabaseClient,
  eq,
  humanReviewQueueItems,
  messages,
  migrate,
  quotaConsumptions,
  riskEvents,
  sessions,
  users,
} from '@mental-health/database';
import type { AiStreamEvent } from '@mental-health/types';
import type { INestApplication } from '@nestjs/common';
import { Test, type TestingModule } from '@nestjs/testing';
import { resolve } from 'node:path';
import request from 'supertest';
import { AiOrchestrationService } from '../src/ai/ai-orchestration.service';
import { InMemoryIncognitoContextStore } from '../src/ai/incognito/incognito-context.store';
import { IncognitoGenerationAdmissionService } from '../src/ai/incognito/incognito-generation-admission.service';
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
  type PreGenerationSafetyGate,
} from '../src/ai/safety/safety-gates';
import { AiTurnService } from '../src/ai/turns/ai-turn.service';
import { ConsentExecutionCoordinator } from '../src/consents/runtime/consent-execution.coordinator';
import { AppModule } from '../src/app.module';
import { hashSessionToken } from '../src/auth/sessions.service';
import { AuthorizationError, DatabaseError } from '../src/common/errors';
import { ConversationService } from '../src/conversations/conversation.service';
import { env } from '../src/config/env';
import { DatabaseService } from '../src/database/database.service';
import { MessageService } from '../src/messages/message.service';
import { QuotaService } from '../src/quota/quota.service';
import { AuditLogService } from '../src/safety/audit/audit-log.service';
import { SafetyContextBuilder } from '../src/safety/context/safety-context.builder';
import { CrisisFlowService } from '../src/safety/crisis/crisis-flow.service';
import {
  OUTPUT_SAFETY_CLASSIFIER,
  OutputSafetyClassifierUnavailableError,
  type OutputSafetyClassifier,
  type OutputSafetyClassifierResult,
} from '../src/safety/output/output-safety-classifier';
import { RiskEventService } from '../src/safety/persistence/risk-event.service';
import { SafetyProductionReadinessService } from '../src/safety/readiness/safety-production-readiness.service';
import {
  RISK_CLASSIFIER,
  RiskClassifierUnavailableError,
  type RiskClassifier,
  type RiskClassifierResult,
} from '../src/safety/risk/risk-classifier';
import { HumanReviewQueueService } from '../src/safety/review/human-review-queue.service';
import {
  SAFETY_REVIEWER_AUTHORIZER,
  type SafetyReviewerAuthorizer,
} from '../src/safety/review/safety-reviewer-authorizer';
import type {
  AssessedRiskDecision,
  RiskLevel,
  SafetyAssessmentContext,
} from '../src/safety/safety.types';

const NOW = new Date('2026-09-10T08:00:00.000Z');

function assessedDecision(level: RiskLevel): AssessedRiskDecision {
  return {
    status: 'assessed',
    level,
    harmSubject: 'SELF',
    categories: ['SELF_HARM'],
    reasonCodes: ['SELF_HARM_IDEATION'],
    policyFlags: [],
    route:
      level === 'CRITICAL'
        ? 'CRISIS_RESPONSE'
        : level === 'HIGH'
          ? 'ALLOW_CONTROLLED_FULL_BUFFER'
          : level === 'MEDIUM'
            ? 'ALLOW_WITH_SAFETY_INSTRUCTION'
            : 'ALLOW_NORMAL_GENERATION',
    bufferingMode: level === 'CRITICAL' ? 'none' : level === 'HIGH' ? 'full' : 'semantic',
    detectionSource: 'hybrid',
    policyVersion: 'test-v1',
    classifierKey: 'risk-classification',
    classifierVersion: 'test-v1',
  };
}

type RiskMode = 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL' | 'THIRD_PARTY_CRITICAL' | 'UNAVAILABLE';

class FakeRiskClassifier implements RiskClassifier {
  mode: RiskMode = 'LOW';
  calls = 0;
  delayMilliseconds = 0;

  reset(mode: RiskMode): void {
    this.mode = mode;
    this.calls = 0;
    this.delayMilliseconds = 0;
  }

  async classify(
    requestId: string,
    context: SafetyAssessmentContext,
    signal: AbortSignal,
  ): Promise<RiskClassifierResult> {
    void requestId;
    void context;
    void signal;
    this.calls += 1;
    if (this.delayMilliseconds > 0) {
      await new Promise((resolve) => setTimeout(resolve, this.delayMilliseconds));
    }
    if (this.mode === 'UNAVAILABLE') {
      throw new RiskClassifierUnavailableError('provider');
    }
    const level = this.mode === 'THIRD_PARTY_CRITICAL' ? 'CRITICAL' : this.mode;
    const high = level === 'HIGH' || level === 'CRITICAL';
    return {
      candidateLevel: level,
      harmSubject: this.mode === 'THIRD_PARTY_CRITICAL' ? 'OTHER' : 'SELF',
      categories: high || level === 'MEDIUM' ? ['SELF_HARM'] : [],
      temporality: level === 'LOW' ? 'UNKNOWN' : 'CURRENT',
      ideation: level === 'LOW' ? 'NONE' : level === 'MEDIUM' ? 'PASSIVE' : 'ACTIVE',
      intent: high ? 'PRESENT' : 'ABSENT',
      plan: level === 'CRITICAL' ? 'PRESENT' : 'ABSENT',
      means: level === 'CRITICAL' ? 'PRESENT' : 'ABSENT',
      immediacy: level === 'CRITICAL' ? 'IMMINENT' : high ? 'POTENTIAL' : 'NONE',
      confidence: 0.95,
      reasonCodes:
        this.mode === 'THIRD_PARTY_CRITICAL'
          ? ['THIRD_PARTY_REPORT', 'IMMEDIATE_TIMEFRAME']
          : level === 'LOW'
            ? []
            : ['SELF_HARM_IDEATION'],
      classifierKey: 'risk-classification',
      classifierVersion: 'test-v1',
    };
  }
}

type OutputMode = 'ALLOW' | 'BLOCK' | 'UNAVAILABLE';

class FakeOutputSafetyClassifier implements OutputSafetyClassifier {
  decisions: OutputMode[] = ['ALLOW'];
  readonly candidates: string[] = [];
  readonly inputs: Array<Parameters<OutputSafetyClassifier['classify']>[0]> = [];
  delayMilliseconds = 0;

  reset(...decisions: OutputMode[]): void {
    this.decisions = decisions.length > 0 ? [...decisions] : ['ALLOW'];
    this.candidates.length = 0;
    this.inputs.length = 0;
    this.delayMilliseconds = 0;
  }

  async classify(
    input: Parameters<OutputSafetyClassifier['classify']>[0],
    signal: AbortSignal,
  ): Promise<OutputSafetyClassifierResult> {
    void signal;
    this.candidates.push(input.candidate);
    this.inputs.push(input);
    if (this.delayMilliseconds > 0) {
      await new Promise((resolve) => setTimeout(resolve, this.delayMilliseconds));
    }
    const decision = this.decisions.shift() ?? 'ALLOW';
    if (decision === 'UNAVAILABLE') {
      throw new OutputSafetyClassifierUnavailableError('provider');
    }
    return {
      decision,
      reasonCodes: decision === 'BLOCK' ? ['DIAGNOSIS_ASSERTION'] : [],
      classifierKey: 'output-safety-classification',
      classifierVersion: 'test-v1',
    };
  }
}

class FakeGenerationProvider implements LLMProvider {
  chunks = ['安全的第一句。', '安全的第二句。'];
  failAfterChunks = false;
  streamCalls = 0;
  readersReleased = 0;

  reset(...chunks: string[]): void {
    this.chunks = chunks.length > 0 ? [...chunks] : ['安全回复。'];
    this.streamCalls = 0;
    this.readersReleased = 0;
    this.failAfterChunks = false;
  }

  failWithProviderError(...chunks: string[]): void {
    this.reset(...chunks);
    this.failAfterChunks = true;
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
    const metadata = { provider: 'fake', model: 'fake', requestId: 'safe-trace' };
    try {
      yield { type: 'started', metadata };
      for (const text of this.chunks) yield { type: 'text_delta', text };
      if (this.failAfterChunks) {
        throw new LLMProviderFailure('upstream', true, metadata.requestId);
      }
      yield {
        type: 'completed',
        finishReason: 'stop',
        usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
        metadata,
      };
    } finally {
      this.readersReleased += 1;
    }
  }

  classifyRisk(): Promise<LLMRiskClassificationCandidate> {
    return Promise.reject(new LLMUnsupportedCapabilityError('classifyRisk'));
  }

  embed(): Promise<LLMEmbeddingResult> {
    return Promise.reject(new LLMUnsupportedCapabilityError('embed'));
  }

  healthCheck(): Promise<LLMHealthStatus> {
    return Promise.resolve({ status: 'healthy', checkedAt: NOW, latencyMs: 0 });
  }
}

describe('Phase 4 AI safety integration', () => {
  let app: INestApplication;
  let moduleRef: TestingModule;
  let migrationClient: ReturnType<typeof createDatabaseClient>;
  let database: DatabaseService;
  let conversations: ConversationService;
  let messagesService: MessageService;
  let orchestration: AiOrchestrationService;
  let quota: QuotaService;
  let incognito: IncognitoGenerationAdmissionService;
  let consentExecutions: ConsentExecutionCoordinator;
  let incognitoStore: InMemoryIncognitoContextStore;
  let riskEventService: RiskEventService;
  let reviewQueue: HumanReviewQueueService;
  let audits: AuditLogService;
  let safetyContexts: SafetyContextBuilder;
  let aiTurnsService: AiTurnService;
  const riskClassifier = new FakeRiskClassifier();
  const outputClassifier = new FakeOutputSafetyClassifier();
  const provider = new FakeGenerationProvider();

  beforeAll(async () => {
    const url = process.env.TEST_DATABASE_URL;
    if (!url) throw new Error('TEST_DATABASE_URL is required');
    const databaseName = decodeURIComponent(new URL(url).pathname.slice(1));
    if (!databaseName.endsWith('_test')) {
      throw new Error('Safety integration tests refuse non-test databases');
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
    await app.init();

    database = moduleRef.get(DatabaseService);
    conversations = moduleRef.get(ConversationService);
    messagesService = moduleRef.get(MessageService);
    orchestration = moduleRef.get(AiOrchestrationService);
    quota = moduleRef.get(QuotaService);
    incognito = moduleRef.get(IncognitoGenerationAdmissionService);
    consentExecutions = moduleRef.get(ConsentExecutionCoordinator);
    incognitoStore = moduleRef.get(InMemoryIncognitoContextStore);
    riskEventService = moduleRef.get(RiskEventService);
    reviewQueue = moduleRef.get(HumanReviewQueueService);
    audits = moduleRef.get(AuditLogService);
    safetyContexts = moduleRef.get(SafetyContextBuilder);
    aiTurnsService = moduleRef.get(AiTurnService);
  }, 60_000);

  beforeEach(() => {
    riskClassifier.reset('LOW');
    outputClassifier.reset('ALLOW', 'ALLOW');
    provider.reset('安全的第一句。', '安全的第二句。');
  });

  afterAll(async () => {
    if (app) await app.close();
    if (migrationClient) await migrationClient.pool.end();
  });

  async function createUser(withRequiredConsents = true): Promise<string> {
    const userId = randomUUID();
    await database.database.insert(users).values({ id: userId, createdAt: NOW });
    if (withRequiredConsents) {
      await insertConsentFixture(userId, 'terms_of_service', '1.1', 'accepted');
      await insertConsentFixture(userId, 'privacy_policy', '1.1', 'accepted');
    }
    return userId;
  }

  async function insertConsentFixture(
    userId: string,
    consentType: 'terms_of_service' | 'privacy_policy',
    consentVersion: string,
    status: 'accepted' | 'withdrawn',
  ): Promise<void> {
    const consentId = randomUUID();
    const acceptanceDecisionId = randomUUID();
    const document =
      consentVersion === '1.1'
        ? {
            documentKey: `synthetic.${consentType === 'terms_of_service' ? 'terms-of-service' : 'privacy-policy'}`,
            documentRevision: 'test-revision-2',
            decisionSource: 'registration' as const,
          }
        : {
            documentKey: null,
            documentRevision: null,
            decisionSource: 'legacy_backfill' as const,
          };
    await database.database.transaction(async (transaction) => {
      await transaction.insert(consents).values({
        id: consentId,
        userId,
        consentType,
        consentVersion,
        status,
        acceptedAt: NOW,
        withdrawnAt: status === 'withdrawn' ? NOW : null,
        stateRevision: status === 'withdrawn' ? 2 : 1,
        effectiveAt: NOW,
      });
      await transaction.insert(consentDecisions).values({
        id: acceptanceDecisionId,
        consentId,
        userId,
        consentType,
        consentVersion,
        operationId: randomUUID(),
        decision: 'accepted',
        outcome: 'applied',
        priorRevision: 0,
        resultingRevision: 1,
        occurredAt: NOW,
        documentKey: document.documentKey,
        documentRevision: document.documentRevision,
        targetAcceptanceDecisionId: null,
        decisionSource: document.decisionSource,
      });
      if (status === 'withdrawn') {
        await transaction.insert(consentDecisions).values({
          id: randomUUID(),
          consentId,
          userId,
          consentType,
          consentVersion,
          operationId: randomUUID(),
          decision: 'withdrawn',
          outcome: 'applied',
          priorRevision: 1,
          resultingRevision: 2,
          occurredAt: NOW,
          documentKey: null,
          documentRevision: null,
          targetAcceptanceDecisionId: acceptanceDecisionId,
          decisionSource: 'privacy_ui',
        });
      }
    });
  }

  async function exhaustQuota(userId: string): Promise<void> {
    for (let index = 0; index < 20; index += 1) {
      await quota.consumeQuota(userId, `fixture-${index}-${randomUUID()}`, NOW);
    }
  }

  async function prepare(userId: string, message = '测试安全消息', conversationId?: string) {
    return orchestration.preparePersistentTurn(
      { userId, sessionId: randomUUID() },
      {
        clientRequestId: randomUUID(),
        ...(conversationId ? { conversationId } : {}),
        message,
      },
      new AbortController().signal,
      NOW,
    );
  }

  async function collect(
    prepared: Extract<Awaited<ReturnType<typeof prepare>>, { kind: 'ready' }>,
  ) {
    const events = [];
    for await (const event of orchestration.streamPreparedTurn(
      prepared,
      new AbortController().signal,
    )) {
      events.push(event);
    }
    return events;
  }

  async function createAuthenticatedSession(userId: string): Promise<string> {
    const rawToken = `phase4-session-${randomUUID()}`;
    await database.database.insert(sessions).values({
      id: randomUUID(),
      userId,
      tokenHash: hashSessionToken(rawToken),
      createdAt: NOW,
      expiresAt: new Date(Date.now() + 60_000),
    });
    return rawToken;
  }

  type TrustedPersistenceFailureStage = 'risk_event' | 'review_queue' | 'audit' | 'commit';

  async function installTrustedPersistenceFailure(stage: TrustedPersistenceFailureStage) {
    const target =
      stage === 'risk_event'
        ? { table: 'risk_events', timing: 'BEFORE INSERT' }
        : stage === 'review_queue'
          ? { table: 'human_review_queue_items', timing: 'BEFORE INSERT' }
          : stage === 'audit'
            ? { table: 'audit_logs', timing: 'BEFORE INSERT' }
            : { table: 'ai_turns', timing: 'COMMIT' };
    await migrationClient.pool.query(`
      CREATE OR REPLACE FUNCTION phase4_audit_injected_failure()
      RETURNS trigger AS $function$
      BEGIN
        RAISE EXCEPTION 'synthetic Phase 4 persistence failure';
        RETURN NEW;
      END;
      $function$ LANGUAGE plpgsql
    `);
    if (target.timing === 'COMMIT') {
      await migrationClient.pool.query(`
        CREATE CONSTRAINT TRIGGER phase4_audit_failure
        AFTER UPDATE ON ai_turns
        DEFERRABLE INITIALLY DEFERRED
        FOR EACH ROW WHEN (NEW.status = 'completed')
        EXECUTE FUNCTION phase4_audit_injected_failure()
      `);
    } else {
      await migrationClient.pool.query(`
        CREATE TRIGGER phase4_audit_failure
        ${target.timing} ON ${target.table}
        FOR EACH ROW EXECUTE FUNCTION phase4_audit_injected_failure()
      `);
    }
    return async (): Promise<void> => {
      await migrationClient.pool.query(
        `DROP TRIGGER IF EXISTS phase4_audit_failure ON ${target.table}`,
      );
      await migrationClient.pool.query('DROP FUNCTION IF EXISTS phase4_audit_injected_failure()');
    };
  }

  it('applies all migrations to an empty database with the three safety tables', async () => {
    const result = await migrationClient.pool.query<{ table_name: string }>(
      `SELECT table_name FROM information_schema.tables
       WHERE table_schema = 'public'
       AND table_name IN ('risk_events', 'human_review_queue_items', 'audit_logs')
       ORDER BY table_name`,
    );
    expect(result.rows.map((row) => row.table_name)).toEqual([
      'audit_logs',
      'human_review_queue_items',
      'risk_events',
    ]);
  });

  it('fails closed to a trusted response when classification is unavailable', async () => {
    const userId = await createUser();
    riskClassifier.reset('UNAVAILABLE');
    const prepared = await prepare(userId);

    expect(prepared.kind).toBe('trusted');
    expect(provider.streamCalls).toBe(0);
    expect((await quota.getUsage(userId, NOW)).usedCount).toBe(0);
    const [eventCount] = await database.database.select({ value: count() }).from(riskEvents);
    expect(Number(eventCount?.value)).toBe(0);
  });

  it('applies the turn total deadline to input risk classification before provider generation', async () => {
    const previousTotalTimeout = env.LLM_TOTAL_TIMEOUT_MS;
    env.LLM_TOTAL_TIMEOUT_MS = 500;
    try {
      const userId = await createUser();
      riskClassifier.delayMilliseconds = 800;
      await expect(prepare(userId, '输入分类总截止时间测试')).rejects.toMatchObject({
        code: 'AI_PROVIDER_TIMEOUT',
        statusCode: 504,
      });
      expect(riskClassifier.calls).toBe(1);
      expect(provider.streamCalls).toBe(0);
      const [turn] = await database.database
        .select()
        .from(aiTurns)
        .where(eq(aiTurns.userId, userId));
      expect(turn).toMatchObject({
        status: 'failed',
        failureCode: 'TOTAL_TIMEOUT_BEFORE_PROVIDER',
      });
    } finally {
      env.LLM_TOTAL_TIMEOUT_MS = previousTotalTimeout;
    }
  });

  it.each(['missing', 'withdrawn', 'outdated'] as const)(
    'keeps both safety classification and generation at call count zero when consent is %s',
    async (consentState) => {
      const userId = await createUser(false);
      if (consentState !== 'missing') {
        const version = consentState === 'outdated' ? '1.0' : '1.1';
        await insertConsentFixture(userId, 'terms_of_service', version, 'accepted');
        await insertConsentFixture(
          userId,
          'privacy_policy',
          version,
          consentState === 'withdrawn' ? 'withdrawn' : 'accepted',
        );
      }

      await expect(prepare(userId, '不得进入任何分类器')).rejects.toMatchObject({
        code: 'CONSENT_REQUIRED',
      });
      expect(riskClassifier.calls).toBe(0);
      expect(provider.streamCalls).toBe(0);
      const [turnCount] = await database.database
        .select({ value: count() })
        .from(aiTurns)
        .where(eq(aiTurns.userId, userId));
      expect(Number(turnCount?.value)).toBe(0);
    },
  );

  it('uses a distinct deterministic third-party crisis response without normal generation', async () => {
    const userId = await createUser();
    riskClassifier.reset('THIRD_PARTY_CRITICAL');
    const prepared = await prepare(userId, '朋友说他现在有即时危险。');

    expect(prepared.kind).toBe('trusted');
    if (prepared.kind !== 'trusted') throw new Error('Expected trusted response');
    expect(prepared.response.templateKey).toBe('crisis-third-party');
    expect(prepared.response.content).not.toContain('你正处于');
    expect(provider.streamCalls).toBe(0);

    const [event] = await database.database
      .select()
      .from(riskEvents)
      .where(eq(riskEvents.aiTurnId, prepared.turn.id));
    expect(event).toMatchObject({ level: 'CRITICAL', isIncognito: false });
    const [queueItem] = await database.database
      .select()
      .from(humanReviewQueueItems)
      .where(eq(humanReviewQueueItems.riskEventId, event!.id));
    expect(queueItem).toMatchObject({ priority: 'urgent', state: 'pending' });
    expect((await quota.getUsage(userId, NOW)).usedCount).toBe(0);
  });

  it('streams a deterministic CRITICAL response without exposing internal risk metadata', async () => {
    const userId = await createUser();
    const conversation = await conversations.create(userId, NOW);
    const rawToken = `phase4-session-${randomUUID()}`;
    await database.database.insert(sessions).values({
      id: randomUUID(),
      userId,
      tokenHash: hashSessionToken(rawToken),
      createdAt: NOW,
      expiresAt: new Date(Date.now() + 60_000),
    });
    riskClassifier.reset('CRITICAL');
    const response = await request(app.getHttpServer())
      .post('/ai/chat/stream')
      .set('Origin', 'http://localhost:5173')
      .set('Cookie', `mh_session=${rawToken}; mh_csrf=synthetic-csrf`)
      .set('x-csrf-token', 'synthetic-csrf')
      .send({
        mode: 'persistent',
        clientRequestId: randomUUID(),
        conversationId: conversation.id,
        message: '合成的危机路由测试输入',
      })
      .expect(200)
      .expect('content-type', /text\/event-stream/u);

    expect(response.text).toContain('event: message.segment');
    expect(response.text).toContain('event: turn.completed');
    expect(response.text).not.toContain('CRITICAL');
    expect(response.text).not.toContain('riskLevel');
    expect(response.text).not.toContain('合成的危机路由测试输入');
    expect(provider.streamCalls).toBe(0);
  });

  it.each(['risk_event', 'review_queue', 'audit', 'commit'] as const)(
    'delivers the minimum trusted crisis response and rolls back on %s persistence failure',
    async (failureStage) => {
      const userId = await createUser();
      const conversation = await conversations.create(userId, NOW);
      const rawToken = await createAuthenticatedSession(userId);
      const clientRequestId = randomUUID();
      riskClassifier.reset('CRITICAL');
      const [queueBefore] = await database.database
        .select({ value: count() })
        .from(humanReviewQueueItems);
      const [auditsBefore] = await database.database.select({ value: count() }).from(auditLogs);
      const removeFailure = await installTrustedPersistenceFailure(failureStage);
      const response = await (async () => {
        try {
          return await request(app.getHttpServer())
            .post('/ai/chat/stream')
            .set('Origin', 'http://localhost:5173')
            .set('Cookie', `mh_session=${rawToken}; mh_csrf=synthetic-csrf`)
            .set('x-csrf-token', 'synthetic-csrf')
            .send({
              mode: 'persistent',
              clientRequestId,
              conversationId: conversation.id,
              message: '合成的危机持久化故障输入',
            })
            .expect(200)
            .expect('content-type', /text\/event-stream/u);
        } finally {
          await removeFailure();
        }
      })();

      expect(response.text).toContain('event: message.segment');
      expect(response.text).toContain('event: turn.failed');
      expect(response.text).not.toContain('event: turn.completed');
      expect(response.text).not.toContain('assistantMessageId');
      expect(response.text).not.toMatch(/真人.*(接管|联系)|队列.*创建/u);
      expect(provider.streamCalls).toBe(0);
      expect(riskClassifier.calls).toBe(1);

      const [turn] = await database.database
        .select()
        .from(aiTurns)
        .where(eq(aiTurns.clientRequestId, clientRequestId));
      expect(turn).toMatchObject({ status: 'failed', assistantMessageId: null });
      const [messageCount] = await database.database
        .select({ value: count() })
        .from(messages)
        .where(eq(messages.conversationId, conversation.id));
      const [eventCount] = await database.database
        .select({ value: count() })
        .from(riskEvents)
        .where(eq(riskEvents.clientRequestId, clientRequestId));
      const [queueAfter] = await database.database
        .select({ value: count() })
        .from(humanReviewQueueItems);
      const [auditsAfter] = await database.database.select({ value: count() }).from(auditLogs);
      expect(Number(messageCount?.value)).toBe(0);
      expect(Number(eventCount?.value)).toBe(0);
      expect(Number(queueAfter?.value)).toBe(Number(queueBefore?.value));
      expect(Number(auditsAfter?.value)).toBe(Number(auditsBefore?.value));

      const retry = await request(app.getHttpServer())
        .post('/ai/chat/stream')
        .set('Origin', 'http://localhost:5173')
        .set('Cookie', `mh_session=${rawToken}; mh_csrf=synthetic-csrf`)
        .set('x-csrf-token', 'synthetic-csrf')
        .send({
          mode: 'persistent',
          clientRequestId,
          conversationId: conversation.id,
          message: '同一请求重试不得重建安全副作用',
        })
        .expect(200)
        .expect('content-type', /application\/json/u);
      expect(retry.body.data.turn).toMatchObject({ id: turn!.id, status: 'failed' });
      expect(riskClassifier.calls).toBe(1);
      expect(provider.streamCalls).toBe(0);
    },
  );

  it('does not return a late crisis delivery after the request is cancelled during persistence', async () => {
    const userId = await createUser();
    const conversation = await conversations.create(userId, NOW);
    const clientRequestId = randomUUID();
    riskClassifier.reset('CRITICAL');
    const controller = new AbortController();
    let persistenceStarted!: () => void;
    let releasePersistence!: () => void;
    const started = new Promise<void>((resolve) => {
      persistenceStarted = resolve;
    });
    const release = new Promise<void>((resolve) => {
      releasePersistence = resolve;
    });
    const persistence = jest
      .spyOn(aiTurnsService, 'completeTrusted')
      .mockImplementationOnce(async () => {
        persistenceStarted();
        await release;
        throw new Error('synthetic delayed persistence failure');
      });
    const pending = orchestration.preparePersistentTurn(
      { userId, sessionId: randomUUID() },
      { clientRequestId, conversationId: conversation.id, message: '合成危机取消测试' },
      controller.signal,
      NOW,
    );
    await started;
    controller.abort(new Error('synthetic client disconnect'));
    releasePersistence();
    try {
      await expect(pending).rejects.toThrow('synthetic client disconnect');
    } finally {
      persistence.mockRestore();
    }

    expect(provider.streamCalls).toBe(0);
    const [turn] = await database.database
      .select()
      .from(aiTurns)
      .where(eq(aiTurns.clientRequestId, clientRequestId));
    expect(turn).toMatchObject({ status: 'cancelled', assistantMessageId: null });
  });

  it('persists MEDIUM as minimal metadata without a review queue item', async () => {
    const userId = await createUser();
    riskClassifier.reset('MEDIUM');
    const prepared = await prepare(userId, '有时候觉得消失就好了。');
    expect(prepared.kind).toBe('ready');
    if (prepared.kind !== 'ready') throw new Error('Expected generation');

    const [event] = await database.database
      .select()
      .from(riskEvents)
      .where(eq(riskEvents.aiTurnId, prepared.turn.id));
    expect(event).toMatchObject({
      level: 'MEDIUM',
      userId,
      isIncognito: false,
    });
    expect(JSON.stringify(event)).not.toContain('有时候觉得');
    const [queueCount] = await database.database
      .select({ value: count() })
      .from(humanReviewQueueItems)
      .where(eq(humanReviewQueueItems.riskEventId, event!.id));
    expect(Number(queueCount?.value)).toBe(0);
  });

  it('full-buffers HIGH output and checks the complete candidate before one SSE segment', async () => {
    const userId = await createUser();
    riskClassifier.reset('HIGH');
    const prepared = await prepare(userId);
    expect(prepared.kind).toBe('ready');
    if (prepared.kind !== 'ready') throw new Error('Expected generation');
    expect(prepared.riskDecision.bufferingMode).toBe('full');

    const events = await collect(prepared);
    expect(outputClassifier.candidates).toEqual(['安全的第一句。安全的第二句。']);
    expect(events.map((event) => event.type)).toEqual([
      'turn.started',
      'message.segment',
      'turn.completed',
    ]);
    expect(provider.streamCalls).toBe(1);

    const [event] = await database.database
      .select()
      .from(riskEvents)
      .where(eq(riskEvents.aiTurnId, prepared.turn.id));
    const [queueItem] = await database.database
      .select()
      .from(humanReviewQueueItems)
      .where(eq(humanReviewQueueItems.riskEventId, event!.id));
    expect(event?.level).toBe('HIGH');
    expect(queueItem?.priority).toBe('high');
  });

  it('bounds HIGH full buffering even when a provider exceeds the requested output size', async () => {
    const previousMaxTokens = env.LLM_MAX_OUTPUT_TOKENS;
    env.LLM_MAX_OUTPUT_TOKENS = 1;
    try {
      const userId = await createUser();
      riskClassifier.reset('HIGH');
      provider.reset('超'.repeat(17));
      const prepared = await prepare(userId);
      if (prepared.kind !== 'ready') throw new Error('Expected generation');

      const events = await collect(prepared);
      const text = events
        .filter((event) => event.type === 'message.segment')
        .map((event) => event.data.text)
        .join('');
      expect(text).toContain('无法安全地继续生成');
      expect(text).not.toContain('超'.repeat(17));
      expect(outputClassifier.candidates).toHaveLength(0);
      expect((await quota.getUsage(userId, NOW)).usedCount).toBe(0);
    } finally {
      env.LLM_MAX_OUTPUT_TOKENS = previousMaxTokens;
    }
  });

  it('uses a trusted HIGH fallback on generation outage and refunds ordinary quota', async () => {
    const userId = await createUser();
    riskClassifier.reset('HIGH');
    provider.failWithProviderError('尚未审核的部分内容');
    const prepared = await prepare(userId);
    if (prepared.kind !== 'ready') throw new Error('Expected generation');

    const events = await collect(prepared);
    const text = events
      .filter((event) => event.type === 'message.segment')
      .map((event) => event.data.text)
      .join('');
    expect(text).toContain('无法安全地继续生成');
    expect(text).not.toContain('尚未审核');
    expect(events.at(-1)?.type).toBe('turn.completed');
    expect((await quota.getUsage(userId, NOW)).usedCount).toBe(0);
  });

  it.each(['HIGH', 'CRITICAL'] as const)(
    'quota exhausted + %s uses safety response without another quota consumption',
    async (level) => {
      const userId = await createUser();
      await exhaustQuota(userId);
      riskClassifier.reset(level);
      const prepared = await prepare(userId);

      expect(prepared.kind).toBe('trusted');
      expect(provider.streamCalls).toBe(0);
      expect((await quota.getUsage(userId, NOW)).usedCount).toBe(20);
      if (prepared.kind === 'trusted') {
        expect(prepared.response.templateKey).toBe(
          level === 'HIGH' ? 'high-quota-fallback' : 'crisis-self',
        );
      }
    },
  );

  it('blocks the first unsafe provider segment, aborts upstream, refunds, and persists only replacement', async () => {
    const userId = await createUser();
    outputClassifier.reset('BLOCK');
    provider.reset('候选但未批准的内容。');
    const prepared = await prepare(userId);
    if (prepared.kind !== 'ready') throw new Error('Expected generation');

    const events: AiStreamEvent[] = [];
    for await (const event of orchestration.streamPreparedTurn(
      prepared,
      new AbortController().signal,
    )) {
      if (event.type === 'message.segment') {
        expect(provider.readersReleased).toBe(1);
      }
      events.push(event);
    }
    const replacement = events.find((event) => event.type === 'message.segment');
    expect(replacement?.type === 'message.segment' ? replacement.data.text : '').not.toContain(
      '候选但未批准',
    );
    expect(events.at(-1)?.type).toBe('turn.completed');
    expect(provider.readersReleased).toBe(1);
    expect((await quota.getUsage(userId, NOW)).usedCount).toBe(0);

    const persisted = await messagesService.readMessages(userId, prepared.turn.conversationId, NOW);
    const assistant = persisted.find((message) => message.role === 'assistant');
    expect(assistant?.content).not.toContain('候选但未批准');
    expect(assistant?.content).toContain('不能继续');
    const [audit] = await database.database
      .select()
      .from(auditLogs)
      .where(eq(auditLogs.idempotencyKey, `safety-output-stopped:${prepared.turn.id}`));
    expect(audit?.action).toBe('safety_output_blocked');
  });

  it('retains quota after a safe prefix then replaces a blocked later segment', async () => {
    const userId = await createUser();
    outputClassifier.reset('ALLOW', 'BLOCK');
    provider.reset('已批准的安全前缀。', '未批准的候选后缀。');
    const prepared = await prepare(userId);
    if (prepared.kind !== 'ready') throw new Error('Expected generation');

    const events = await collect(prepared);
    const segments = events
      .filter((event) => event.type === 'message.segment')
      .map((event) => event.data.text);
    expect(segments[0]).toBe('已批准的安全前缀。');
    expect(outputClassifier.inputs[1]?.previouslyApprovedText).toBe('已批准的安全前缀。');
    expect(segments.join('')).not.toContain('未批准的候选后缀');
    expect((await quota.getUsage(userId, NOW)).usedCount).toBe(1);
    const persisted = await messagesService.readMessages(userId, prepared.turn.conversationId, NOW);
    expect(persisted.at(-1)?.content).toBe(segments.join(''));
  });

  it('fails output classification closed and sends a classifier-independent trusted replacement', async () => {
    const userId = await createUser();
    outputClassifier.reset('UNAVAILABLE');
    provider.reset('候选内容。');
    const prepared = await prepare(userId);
    if (prepared.kind !== 'ready') throw new Error('Expected generation');

    const events = await collect(prepared);
    const text = events
      .filter((event) => event.type === 'message.segment')
      .map((event) => event.data.text)
      .join('');
    expect(text).toContain('无法确认后续内容是否安全');
    expect(text).not.toContain('候选内容');
    expect(provider.readersReleased).toBe(1);
    expect((await quota.getUsage(userId, NOW)).usedCount).toBe(0);
  });

  it('prevents a late output classifier result from writing after timeout and stale-turn recovery', async () => {
    const previousTotalTimeout = env.LLM_TOTAL_TIMEOUT_MS;
    const previousLeaseMargin = env.LLM_LEASE_SAFETY_MARGIN_MS;
    env.LLM_TOTAL_TIMEOUT_MS = 500;
    env.LLM_LEASE_SAFETY_MARGIN_MS = 1;
    try {
      const userId = await createUser();
      const conversation = await conversations.create(userId, NOW);
      outputClassifier.delayMilliseconds = 800;
      const oldPrepared = await prepare(userId, '旧请求', conversation.id);
      if (oldPrepared.kind !== 'ready') throw new Error('Expected old generation');
      const emitted: AiStreamEvent[] = [];
      const oldExecution = (async () => {
        try {
          for await (const event of orchestration.streamPreparedTurn(
            oldPrepared,
            new AbortController().signal,
          )) {
            emitted.push(event);
          }
          return null;
        } catch (error) {
          return error;
        }
      })();

      await new Promise((resolve) => setTimeout(resolve, 550));
      env.LLM_TOTAL_TIMEOUT_MS = 5_000;
      const newPrepared = await orchestration.preparePersistentTurn(
        { userId, sessionId: randomUUID() },
        {
          clientRequestId: randomUUID(),
          conversationId: conversation.id,
          message: '租约过期后的新请求',
        },
        new AbortController().signal,
        new Date(NOW.getTime() + 1_000),
      );
      if (newPrepared.kind !== 'ready') throw new Error('Expected replacement generation');

      const oldError = await oldExecution;
      expect(oldError).toMatchObject({ code: 'AI_PROVIDER_TIMEOUT', statusCode: 504 });
      expect(emitted.map((event) => event.type)).toEqual(['turn.started']);
      const oldTurn = await aiTurnsService.findByClientRequestId(
        userId,
        oldPrepared.turn.clientRequestId,
      );
      const replacementTurn = await aiTurnsService.findByClientRequestId(
        userId,
        newPrepared.turn.clientRequestId,
      );
      expect(oldTurn).toMatchObject({ status: 'failed', failureCode: 'STALE_TURN' });
      expect(oldTurn?.assistantMessageId).toBeNull();
      expect(replacementTurn).toMatchObject({ status: 'streaming' });
      expect((await quota.getUsage(userId, new Date(NOW.getTime() + 1_000))).usedCount).toBe(1);
      expect(provider.readersReleased).toBe(1);

      await aiTurnsService.finish(newPrepared.turn, 'failed', 'TEST_CLEANUP', new Date());
      newPrepared.execution.dispose();
    } finally {
      env.LLM_TOTAL_TIMEOUT_MS = previousTotalTimeout;
      env.LLM_LEASE_SAFETY_MARGIN_MS = previousLeaseMargin;
    }
  });

  it('cancels in-flight output classification without emitting its late result', async () => {
    const userId = await createUser();
    outputClassifier.delayMilliseconds = 50;
    const prepared = await prepare(userId, '取消输出分类测试');
    if (prepared.kind !== 'ready') throw new Error('Expected generation');
    const controller = new AbortController();
    const emitted: AiStreamEvent[] = [];
    const execution = (async () => {
      try {
        for await (const event of orchestration.streamPreparedTurn(prepared, controller.signal)) {
          emitted.push(event);
        }
        return null;
      } catch (error) {
        return error;
      }
    })();
    await new Promise((resolve) => setTimeout(resolve, 10));
    controller.abort(new Error('synthetic client disconnect'));
    const error = await execution;

    expect(error).toMatchObject({ code: 'AI_PROVIDER_UNAVAILABLE' });
    expect(emitted.map((event) => event.type)).toEqual(['turn.started']);
    const turn = await aiTurnsService.findByClientRequestId(userId, prepared.turn.clientRequestId);
    expect(turn).toMatchObject({ status: 'cancelled', assistantMessageId: null });
    expect(provider.readersReleased).toBe(1);
    expect((await quota.getUsage(userId, NOW)).usedCount).toBe(1);
  });

  it('deduplicates 20 concurrent HIGH safety side effects for one ordinary turn', async () => {
    const userId = await createUser();
    const conversation = await conversations.create(userId, NOW);
    const clientRequestId = randomUUID();
    riskClassifier.reset('HIGH');

    const previousGlobalLimit = env.CONSENT_ACTIVE_EXECUTIONS_MAX_GLOBAL;
    const previousUserLimit = env.CONSENT_ACTIVE_EXECUTIONS_MAX_PER_USER;
    const previousGlobalWaiterLimit = env.CONSENT_LOCK_MAX_WAITERS_GLOBAL;
    const previousUserWaiterLimit = env.CONSENT_LOCK_MAX_WAITERS_PER_USER;
    env.CONSENT_ACTIVE_EXECUTIONS_MAX_GLOBAL = Math.max(previousGlobalLimit, 40);
    env.CONSENT_ACTIVE_EXECUTIONS_MAX_PER_USER = 20;
    env.CONSENT_LOCK_MAX_WAITERS_GLOBAL = Math.max(previousGlobalWaiterLimit, 100);
    env.CONSENT_LOCK_MAX_WAITERS_PER_USER = 50;
    let attempts;
    try {
      attempts = await Promise.all(
        Array.from({ length: 20 }, () =>
          orchestration.preparePersistentTurn(
            { userId, sessionId: randomUUID() },
            { clientRequestId, conversationId: conversation.id, message: '并发安全测试消息。' },
            new AbortController().signal,
            NOW,
          ),
        ),
      );
    } finally {
      env.CONSENT_ACTIVE_EXECUTIONS_MAX_GLOBAL = previousGlobalLimit;
      env.CONSENT_ACTIVE_EXECUTIONS_MAX_PER_USER = previousUserLimit;
      env.CONSENT_LOCK_MAX_WAITERS_GLOBAL = previousGlobalWaiterLimit;
      env.CONSENT_LOCK_MAX_WAITERS_PER_USER = previousUserWaiterLimit;
    }
    const turnId = attempts[0]!.turn.id;
    const [turnCount] = await database.database
      .select({ value: count() })
      .from(aiTurns)
      .where(eq(aiTurns.clientRequestId, clientRequestId));
    const [eventCount] = await database.database
      .select({ value: count() })
      .from(riskEvents)
      .where(eq(riskEvents.aiTurnId, turnId));
    const [event] = await database.database
      .select({ id: riskEvents.id })
      .from(riskEvents)
      .where(eq(riskEvents.aiTurnId, turnId));
    const [queueCount] = await database.database
      .select({ value: count() })
      .from(humanReviewQueueItems)
      .where(eq(humanReviewQueueItems.riskEventId, event!.id));
    const [auditCount] = await database.database
      .select({ value: count() })
      .from(auditLogs)
      .where(eq(auditLogs.resourceId, event!.id));

    expect(Number(turnCount?.value)).toBe(1);
    expect(Number(eventCount?.value)).toBe(1);
    expect(Number(queueCount?.value)).toBe(1);
    expect(Number(auditCount?.value)).toBe(2);
  });

  it('deduplicates 20 concurrent Incognito CRITICAL events without persisting content', async () => {
    const userId = await createUser();
    const sessionId = randomUUID();
    // The runtime store's background cleanup uses the real clock. Keep this concurrency
    // fixture on that same clock so a historical business timestamp cannot make the context
    // expire during the deliberately contended Consent-lock sequence.
    const contextNow = new Date();
    const runtimeContext = await consentExecutions.createIncognitoContext({
      userId,
      sessionId,
      sessionExpiresAt: new Date(contextNow.getTime() + 60_000),
      signal: new AbortController().signal,
      deadlineAt: new Date(contextNow.getTime() + 30_000),
      now: contextNow,
    });
    const clientRequestId = randomUUID();
    riskClassifier.reset('CRITICAL');

    const previousGlobalLimit = env.CONSENT_ACTIVE_EXECUTIONS_MAX_GLOBAL;
    const previousUserLimit = env.CONSENT_ACTIVE_EXECUTIONS_MAX_PER_USER;
    const previousGlobalWaiterLimit = env.CONSENT_LOCK_MAX_WAITERS_GLOBAL;
    const previousUserWaiterLimit = env.CONSENT_LOCK_MAX_WAITERS_PER_USER;
    env.CONSENT_ACTIVE_EXECUTIONS_MAX_GLOBAL = Math.max(previousGlobalLimit, 40);
    env.CONSENT_ACTIVE_EXECUTIONS_MAX_PER_USER = 20;
    env.CONSENT_LOCK_MAX_WAITERS_GLOBAL = Math.max(previousGlobalWaiterLimit, 100);
    env.CONSENT_LOCK_MAX_WAITERS_PER_USER = 50;
    let results: PromiseSettledResult<Awaited<ReturnType<typeof incognito.claim>>>[];
    try {
      results = await Promise.allSettled(
        Array.from({ length: 20 }, async () => {
          const pending = consentExecutions.registerPending({
            userId,
            sessionId,
            clientSignal: new AbortController().signal,
          });
          let execution: Awaited<ReturnType<typeof consentExecutions.bindRequired>> | null = null;
          try {
            execution = await consentExecutions.bindRequired(pending);
            return await incognito.claim({
              userId,
              sessionId,
              contextId: runtimeContext.id,
              clientRequestId,
              message: '合成的紧急风险测试表达。',
              signal: execution.signal,
              execution,
              now: contextNow,
            });
          } finally {
            (execution ?? pending).dispose();
          }
        }),
      );
    } finally {
      env.CONSENT_ACTIVE_EXECUTIONS_MAX_GLOBAL = previousGlobalLimit;
      env.CONSENT_ACTIVE_EXECUTIONS_MAX_PER_USER = previousUserLimit;
      env.CONSENT_LOCK_MAX_WAITERS_GLOBAL = previousGlobalWaiterLimit;
      env.CONSENT_LOCK_MAX_WAITERS_PER_USER = previousUserWaiterLimit;
    }
    const fulfilled = results.filter(
      (result): result is PromiseFulfilledResult<Awaited<ReturnType<typeof incognito.claim>>> =>
        result.status === 'fulfilled',
    );
    expect(fulfilled).toHaveLength(1);
    expect(fulfilled[0]?.value.kind).toBe('trusted');
    const rejected = results.filter(
      (result): result is PromiseRejectedResult => result.status === 'rejected',
    );
    expect(rejected).toHaveLength(19);
    expect(rejected.map((result) => result.reason)).toEqual(
      Array.from({ length: 19 }, () =>
        expect.objectContaining({ code: 'AI_TURN_IN_PROGRESS', statusCode: 409 }),
      ),
    );
    expect(riskClassifier.calls).toBe(1);
    if (fulfilled[0]) {
      incognitoStore.releaseGeneration(
        userId,
        sessionId,
        runtimeContext.id,
        fulfilled[0].value.generation.id,
      );
    }
    const [eventCount] = await database.database
      .select({ value: count() })
      .from(riskEvents)
      .where(eq(riskEvents.clientRequestId, clientRequestId));
    const [event] = await database.database
      .select()
      .from(riskEvents)
      .where(eq(riskEvents.clientRequestId, clientRequestId));
    const [queueCount] = await database.database
      .select({ value: count() })
      .from(humanReviewQueueItems)
      .where(eq(humanReviewQueueItems.riskEventId, event!.id));
    const [ledgerCount] = await database.database
      .select({ value: count() })
      .from(quotaConsumptions)
      .where(eq(quotaConsumptions.userId, userId));
    const [auditCount] = await database.database
      .select({ value: count() })
      .from(auditLogs)
      .where(eq(auditLogs.resourceId, event!.id));

    expect(Number(eventCount?.value)).toBe(1);
    expect(event).toMatchObject({
      userId,
      conversationId: null,
      aiTurnId: null,
      triggerMessageId: null,
      isIncognito: true,
    });
    expect(JSON.stringify(event)).not.toContain('合成的紧急风险');
    expect(Number(queueCount?.value)).toBe(1);
    expect(Number(auditCount?.value)).toBe(3);
    expect(Number(ledgerCount?.value)).toBe(0);
  });

  it('keeps the first Incognito safety decision for a reused clientRequestId', async () => {
    const userId = await createUser();
    const clientRequestId = randomUUID();
    const medium = assessedDecision('MEDIUM');
    const critical = assessedDecision('CRITICAL');

    const first = await riskEventService.persistIncognito({
      userId,
      clientRequestId,
      decision: medium,
      now: NOW,
    });
    const duplicate = await riskEventService.persistIncognito({
      userId,
      clientRequestId,
      decision: critical,
      response: moduleRef.get(CrisisFlowService).build('SELF'),
      now: NOW,
    });

    expect(duplicate?.id).toBe(first?.id);
    expect(duplicate?.level).toBe('MEDIUM');
    const [queueCount] = await database.database
      .select({ value: count() })
      .from(humanReviewQueueItems)
      .where(eq(humanReviewQueueItems.riskEventId, first!.id));
    const [auditCount] = await database.database
      .select({ value: count() })
      .from(auditLogs)
      .where(eq(auditLogs.resourceId, first!.id));
    expect(Number(queueCount?.value)).toBe(0);
    expect(Number(auditCount?.value)).toBe(1);
  });

  it('scopes Incognito idempotency per user and reassesses a new clientRequestId', async () => {
    const firstUserId = await createUser();
    const secondUserId = await createUser();
    const sharedClientRequestId = randomUUID();
    const first = await riskEventService.persistIncognito({
      userId: firstUserId,
      clientRequestId: sharedClientRequestId,
      decision: assessedDecision('MEDIUM'),
      now: NOW,
    });
    const otherUser = await riskEventService.persistIncognito({
      userId: secondUserId,
      clientRequestId: sharedClientRequestId,
      decision: assessedDecision('HIGH'),
      now: NOW,
    });
    const escalatedNewRequest = await riskEventService.persistIncognito({
      userId: firstUserId,
      clientRequestId: randomUUID(),
      decision: assessedDecision('CRITICAL'),
      response: moduleRef.get(CrisisFlowService).build('SELF'),
      now: NOW,
    });

    expect(new Set([first!.id, otherUser!.id, escalatedNewRequest!.id]).size).toBe(3);
    expect(first?.level).toBe('MEDIUM');
    expect(otherUser?.level).toBe('HIGH');
    expect(escalatedNewRequest?.level).toBe('CRITICAL');
    const [escalatedQueueCount] = await database.database
      .select({ value: count() })
      .from(humanReviewQueueItems)
      .where(eq(humanReviewQueueItems.riskEventId, escalatedNewRequest!.id));
    expect(Number(escalatedQueueCount?.value)).toBe(1);
  });

  it('keeps RiskEvent retention independent through Message, AI Turn, and Conversation deletion', async () => {
    const userId = await createUser();
    riskClassifier.reset('CRITICAL');
    const prepared = await prepare(userId);
    if (prepared.kind !== 'trusted') throw new Error('Expected trusted crisis response');
    const [eventBefore] = await database.database
      .select()
      .from(riskEvents)
      .where(eq(riskEvents.aiTurnId, prepared.turn.id));

    await database.database
      .delete(messages)
      .where(eq(messages.conversationId, prepared.turn.conversationId));
    let [event] = await database.database
      .select()
      .from(riskEvents)
      .where(eq(riskEvents.id, eventBefore!.id));
    expect(event).toMatchObject({ triggerMessageId: null, aiTurnId: prepared.turn.id });

    await database.database.delete(aiTurns).where(eq(aiTurns.id, prepared.turn.id));
    [event] = await database.database
      .select()
      .from(riskEvents)
      .where(eq(riskEvents.id, eventBefore!.id));
    expect(event).toMatchObject({ aiTurnId: null, conversationId: prepared.turn.conversationId });

    await database.database
      .delete(conversationRows)
      .where(eq(conversationRows.id, prepared.turn.conversationId));
    [event] = await database.database
      .select()
      .from(riskEvents)
      .where(eq(riskEvents.id, eventBefore!.id));
    expect(event).toMatchObject({ conversationId: null, userId });

    await database.database.delete(riskEvents).where(eq(riskEvents.id, eventBefore!.id));
    const [queueCount] = await database.database
      .select({ value: count() })
      .from(humanReviewQueueItems)
      .where(eq(humanReviewQueueItems.riskEventId, eventBefore!.id));
    expect(Number(queueCount?.value)).toBe(0);
  });

  it('keeps RiskEvent metadata when chat and user records are deleted, then cascades its queue', async () => {
    const userId = await createUser();
    riskClassifier.reset('CRITICAL');
    const prepared = await prepare(userId);
    if (prepared.kind !== 'trusted') throw new Error('Expected trusted crisis response');
    const [eventBefore] = await database.database
      .select()
      .from(riskEvents)
      .where(eq(riskEvents.aiTurnId, prepared.turn.id));
    expect(eventBefore).toBeDefined();

    await database.database.delete(users).where(eq(users.id, userId));
    const [eventAfter] = await database.database
      .select()
      .from(riskEvents)
      .where(eq(riskEvents.id, eventBefore!.id));
    expect(eventAfter).toMatchObject({
      userId: null,
      conversationId: null,
      aiTurnId: null,
      triggerMessageId: null,
    });
    const [queueBeforeDelete] = await database.database
      .select({ value: count() })
      .from(humanReviewQueueItems)
      .where(eq(humanReviewQueueItems.riskEventId, eventBefore!.id));
    expect(Number(queueBeforeDelete?.value)).toBe(1);

    await database.database.delete(riskEvents).where(eq(riskEvents.id, eventBefore!.id));
    const [queueAfterDelete] = await database.database
      .select({ value: count() })
      .from(humanReviewQueueItems)
      .where(eq(humanReviewQueueItems.riskEventId, eventBefore!.id));
    expect(Number(queueAfterDelete?.value)).toBe(0);
  });

  it('purges RiskEvent and AuditLog on independent bounded retention policies', async () => {
    const userId = await createUser();
    const createdAt = new Date('2025-01-01T00:00:00.000Z');
    const decision = {
      status: 'assessed' as const,
      level: 'MEDIUM' as const,
      harmSubject: 'UNKNOWN' as const,
      categories: ['SELF_HARM'] as const,
      reasonCodes: ['PASSIVE_DEATH_WISH'] as const,
      policyFlags: [] as const,
      route: 'ALLOW_WITH_SAFETY_INSTRUCTION' as const,
      bufferingMode: 'semantic' as const,
      detectionSource: 'hybrid' as const,
      policyVersion: 'test',
      classifierKey: 'risk-classification',
      classifierVersion: 'test',
    };
    const event = await riskEventService.persistIncognito({
      userId,
      clientRequestId: randomUUID(),
      decision,
      now: createdAt,
    });
    expect(event).toBeDefined();
    expect(await riskEventService.purgeExpired(NOW, 1)).toBe(1);
    expect(await audits.purgeExpired(NOW, 10)).toBeGreaterThanOrEqual(1);
  });

  it('defaults ordinary, forged, and missing reviewer principals to deny at the service boundary', async () => {
    const ordinaryUserId = await createUser();
    for (const principal of [
      { id: ordinaryUserId },
      { id: 'forged-reviewer-id' },
      undefined as unknown as { id: string },
    ]) {
      await expect(reviewQueue.get(principal, randomUUID())).rejects.toBeInstanceOf(
        AuthorizationError,
      );
    }
  });

  it('returns reviewer-sensitive queue context only after an access audit commits', async () => {
    const userId = await createUser();
    const event = await riskEventService.persistIncognito({
      userId,
      clientRequestId: randomUUID(),
      decision: assessedDecision('CRITICAL'),
      response: moduleRef.get(CrisisFlowService).build('SELF'),
      now: NOW,
    });
    const reviewerId = `authorized-reviewer-${randomUUID()}`;
    const authorizer = moduleRef.get<SafetyReviewerAuthorizer>(SAFETY_REVIEWER_AUTHORIZER);
    const authorization = jest.spyOn(authorizer, 'authorize').mockResolvedValueOnce();
    const reviewContext = await reviewQueue.get({ id: reviewerId }, event!.id, NOW);
    authorization.mockRestore();

    expect(reviewContext?.queueItem.riskEventId).toBe(event!.id);
    expect(reviewContext?.riskEvent).toMatchObject({
      id: event!.id,
      level: 'CRITICAL',
    });
    const accessAudits = await database.database
      .select()
      .from(auditLogs)
      .where(eq(auditLogs.resourceId, event!.id));
    expect(accessAudits).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          actorId: reviewerId,
          action: 'risk_event_viewed',
          resourceType: 'risk_event',
        }),
      ]),
    );
  });

  it('does not return reviewer-sensitive queue context when its access audit fails', async () => {
    const userId = await createUser();
    const event = await riskEventService.persistIncognito({
      userId,
      clientRequestId: randomUUID(),
      decision: assessedDecision('CRITICAL'),
      response: moduleRef.get(CrisisFlowService).build('SELF'),
      now: NOW,
    });
    const authorizer = moduleRef.get<SafetyReviewerAuthorizer>(SAFETY_REVIEWER_AUTHORIZER);
    const authorization = jest.spyOn(authorizer, 'authorize').mockResolvedValueOnce();
    const removeFailure = await installTrustedPersistenceFailure('audit');
    let returnedSensitiveContext = false;
    try {
      await expect(
        reviewQueue.get({ id: `authorized-reviewer-${randomUUID()}` }, event!.id, NOW).then(() => {
          returnedSensitiveContext = true;
        }),
      ).rejects.toBeInstanceOf(DatabaseError);
    } finally {
      authorization.mockRestore();
      await removeFailure();
    }
    expect(returnedSensitiveContext).toBe(false);
    const accessAudits = await database.database
      .select()
      .from(auditLogs)
      .where(eq(auditLogs.resourceId, event!.id));
    expect(accessAudits.filter((entry) => entry.action === 'risk_event_viewed')).toHaveLength(0);
  });

  it('reports production readiness false while verified resources and policy approvals are absent', () => {
    const readiness = moduleRef.get(SafetyProductionReadinessService);
    const pre = moduleRef.get<PreGenerationSafetyGate>(PRE_GENERATION_SAFETY_GATE);
    const post = moduleRef.get<PostGenerationSafetyGate>(POST_GENERATION_SAFETY_GATE);
    const result = readiness.evaluate(pre, post);
    expect(result.productionSafe).toBe(false);
    expect(result.checks).toEqual(
      expect.arrayContaining([
        { key: 'verified_crisis_resources', ready: false },
        { key: 'gates_declare_production_safe', ready: false },
      ]),
    );
  });

  it('builds bounded safety context without a system prompt or unrelated old history', async () => {
    const userId = await createUser();
    const conversation = await conversations.create(userId, NOW);
    await database.database.insert(messages).values(
      Array.from({ length: 12 }, (_, index) => ({
        id: randomUUID(),
        conversationId: conversation.id,
        role: index % 2 === 0 ? ('user' as const) : ('assistant' as const),
        sequenceNumber: index + 1,
        content: `历史消息-${index + 1}`,
        createdAt: NOW,
      })),
    );
    const context = await safetyContexts.build(
      userId,
      { kind: 'conversation', conversationId: conversation.id },
      '当前消息',
      NOW,
    );
    expect(context.messages).toHaveLength(9);
    expect(context.messages.at(0)?.content).toBe('历史消息-5');
    expect(context.messages.at(-1)).toEqual({ role: 'user', content: '当前消息' });
    expect(context.messages.map((message) => String(message.role))).not.toContain('system');
  });

  it('isolates Incognito safety context by both user and session', async () => {
    const userId = await createUser();
    const sessionId = randomUUID();
    const own = incognitoStore.create(userId, sessionId, new Date(NOW.getTime() + 60_000), [], NOW);
    const ownGeneration = incognitoStore.claimGeneration(
      userId,
      sessionId,
      own.id,
      randomUUID(),
      new AbortController().signal,
      NOW,
    );
    if (!ownGeneration) throw new Error('Expected an Incognito generation claim');
    incognitoStore.append(
      userId,
      sessionId,
      own.id,
      ownGeneration.id,
      { role: 'user', content: '自己的最近上下文' },
      NOW,
    );
    incognitoStore.releaseGeneration(userId, sessionId, own.id, ownGeneration.id);
    const other = incognitoStore.create(
      userId,
      randomUUID(),
      new Date(NOW.getTime() + 60_000),
      [],
      NOW,
    );
    const otherGeneration = incognitoStore.claimGeneration(
      userId,
      other.sessionId,
      other.id,
      randomUUID(),
      new AbortController().signal,
      NOW,
    );
    if (!otherGeneration) throw new Error('Expected an Incognito generation claim');
    incognitoStore.append(
      userId,
      other.sessionId,
      other.id,
      otherGeneration.id,
      { role: 'user', content: '不得泄露的其他会话内容' },
      NOW,
    );

    const context = await safetyContexts.build(
      userId,
      { kind: 'incognito', contextId: own.id, sessionId },
      '当前无痕输入',
      NOW,
    );
    expect(JSON.stringify(context)).toContain('自己的最近上下文');
    expect(JSON.stringify(context)).not.toContain('不得泄露');
  });
});
