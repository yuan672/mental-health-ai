import { randomUUID } from 'node:crypto';
import {
  aiTurns,
  assistantMessageKnowledgeReferences,
  createDatabaseClient,
  eq,
  messages,
  migrate,
  quotaConsumptions,
  users,
  type AppTransaction,
} from '@mental-health/database';
import type {
  IncognitoAiStreamEvent,
  IncognitoAiStreamEventV2,
  PersistentAiStreamEvent,
  PersistentAiStreamEventV2,
} from '@mental-health/types';
import { Inject, type INestApplication, Injectable } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { resolve } from 'node:path';
import { AppModule } from '../src/app.module';
import { AiOrchestrationService } from '../src/ai/ai-orchestration.service';
import { INSUFFICIENT_KNOWLEDGE_MESSAGE } from '../src/ai/grounding/grounded-response.schema';
import { parseAiStreamEventV2 } from '../src/ai/ai-public.schemas';
import { AiExecutionTotalTimeoutError } from '../src/ai/runtime/active-ai-execution.registry';
import {
  KNOWLEDGE_AUGMENTATION_CONFIG,
  type KnowledgeAugmentationConfig,
} from '../src/ai/grounding/knowledge-augmentation.config';
import { InMemoryIncognitoContextStore } from '../src/ai/incognito/incognito-context.store';
import { IncognitoContextsService } from '../src/ai/incognito/incognito-contexts.service';
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
import { AiTurnRepository } from '../src/ai/turns/ai-turn.repository';
import { AiTurnService } from '../src/ai/turns/ai-turn.service';
import { DatabaseService } from '../src/database/database.service';
import { ConversationAccessService } from '../src/conversation-access/conversation-access.service';
import { ConversationService } from '../src/conversations/conversation.service';
import { ConsentsService } from '../src/consents/consents.service';
import { KnowledgeFixtureService } from '../src/knowledge/knowledge-fixture.service';
import { KnowledgeMessageReferenceRepository } from '../src/knowledge/knowledge-message-reference.repository';
import { KnowledgePublicationService } from '../src/knowledge/knowledge-publication.service';
import { KnowledgeRetrievalPolicy } from '../src/knowledge/knowledge-retrieval.policy';
import { KnowledgeRetrievalRepository } from '../src/knowledge/knowledge-retrieval.repository';
import {
  KNOWLEDGE_RETRIEVAL_RUNTIME_CONFIG,
  KnowledgeRetrievalService,
  type KnowledgeRetrievalRuntimeConfig,
} from '../src/knowledge/knowledge-retrieval.service';
import { QuotaRepository } from '../src/quota/quota.repository';
import { QuotaService } from '../src/quota/quota.service';
import { AuditLogRepository } from '../src/safety/audit/audit-log.repository';
import { RiskEventRepository } from '../src/safety/persistence/risk-event.repository';
import type { RiskDecision } from '../src/safety/safety.types';
import { insertRequiredConsentFixtures } from './consent-fixtures';

type Deferred = Readonly<{ promise: Promise<void>; resolve: () => void }>;

function deferred(): Deferred {
  let resolve!: () => void;
  const promise = new Promise<void>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

const PROVIDER_METADATA = {
  provider: 'fake',
  model: 'synthetic-grounding-model',
  requestId: 'synthetic-grounding-trace',
} as const;

type GroundedMode =
  | 'success'
  | 'invalid_reference'
  | 'malformed'
  | 'insufficient_evidence'
  | 'contradictory_evidence';

class GroundingProvider implements LLMProvider {
  groundedMode: GroundedMode = 'success';
  finishReason: 'stop' | 'length' = 'stop';
  groundedAnswer = '这是经过完整输出安全检查的合成知识回答。';
  streamCalls = 0;
  groundedCalls = 0;
  ordinaryCalls = 0;
  requests: LLMChatRequest[] = [];
  pauseGroundedOutput = false;
  beforeStartTransport: (() => Promise<void>) | null = null;
  groundedPartial = deferred();
  groundedRelease = deferred();

  reset(): void {
    this.groundedMode = 'success';
    this.finishReason = 'stop';
    this.groundedAnswer = '这是经过完整输出安全检查的合成知识回答。';
    this.streamCalls = 0;
    this.groundedCalls = 0;
    this.ordinaryCalls = 0;
    this.requests = [];
    this.pauseGroundedOutput = false;
    this.beforeStartTransport = null;
    this.groundedPartial = deferred();
    this.groundedRelease = deferred();
  }

  chat(): Promise<LLMChatResult> {
    return Promise.reject(new LLMProviderFailure('unconfigured', false));
  }

  async *streamChat(
    request: LLMChatRequest,
    options: LLMCallOptions,
  ): AsyncIterable<LLMProviderStreamEvent> {
    await this.beforeStartTransport?.();
    await options.startTransport((signal) => {
      if (signal.aborted) throw signal.reason;
      return undefined;
    });
    this.streamCalls += 1;
    this.requests.push(request);
    yield { type: 'started', metadata: PROVIDER_METADATA };

    if (request.responseFormat === 'json') {
      this.groundedCalls += 1;
      const raw =
        this.groundedMode === 'malformed'
          ? '{not-json'
          : this.groundedMode === 'insufficient_evidence' ||
              this.groundedMode === 'contradictory_evidence'
            ? JSON.stringify({
                status: 'insufficient_evidence',
                answer: this.groundedMode === 'contradictory_evidence' ? '不得交付的猜测正文' : '',
                usedReferenceIds: [],
              })
            : JSON.stringify({
                status: 'supported',
                answer: this.groundedAnswer,
                usedReferenceIds: [this.groundedMode === 'invalid_reference' ? 'K2' : 'K1'],
              });
      const splitAt = Math.max(1, Math.floor(raw.length / 2));
      yield { type: 'text_delta', text: raw.slice(0, splitAt) };
      this.groundedPartial.resolve();
      if (this.pauseGroundedOutput) await this.groundedRelease.promise;
      if (options.signal.aborted) throw options.signal.reason;
      yield { type: 'text_delta', text: raw.slice(splitAt) };
    } else {
      this.ordinaryCalls += 1;
      yield { type: 'text_delta', text: '普通语义流式回复。' };
    }

    yield {
      type: 'completed',
      finishReason: this.finishReason,
      usage: { inputTokens: 12, outputTokens: 8, totalTokens: 20 },
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
    return Promise.resolve({ status: 'healthy', checkedAt: new Date(), latencyMs: 0 });
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
      policyVersion: 'knowledge-grounding-test',
      classifierKey: null,
      classifierVersion: null,
    });
  }
}

class ControllablePostGenerationGate implements PostGenerationSafetyGate {
  readonly productionSafe = false;
  replacement: string | null = null;
  candidates: PostGenerationSafetyInput[] = [];

  reset(): void {
    this.replacement = null;
    this.candidates = [];
  }

  approve(input: PostGenerationSafetyInput) {
    this.candidates.push(input);
    return Promise.resolve(
      this.replacement === null
        ? ({ status: 'approved', text: input.candidateSegment } as const)
        : ({
            status: 'replacement',
            text: this.replacement,
            cause: 'blocked',
          } as const),
    );
  }
}

@Injectable()
class HookedKnowledgeRetrievalService extends KnowledgeRetrievalService {
  beforeRecheck: (() => Promise<void>) | null = null;
  afterRecheck: (() => Promise<void>) | null = null;
  retrieveCalls = 0;

  constructor(
    repository: KnowledgeRetrievalRepository,
    policy: KnowledgeRetrievalPolicy,
    @Inject(KNOWLEDGE_RETRIEVAL_RUNTIME_CONFIG) config: KnowledgeRetrievalRuntimeConfig,
  ) {
    super(repository, policy, config);
  }

  override async retrieve(input: Parameters<KnowledgeRetrievalService['retrieve']>[0]) {
    this.retrieveCalls += 1;
    return super.retrieve(input);
  }

  override async recheckCurrent(input: Parameters<KnowledgeRetrievalService['recheckCurrent']>[0]) {
    await this.beforeRecheck?.();
    const result = await super.recheckCurrent(input);
    await this.afterRecheck?.();
    return result;
  }

  reset(): void {
    this.beforeRecheck = null;
    this.afterRecheck = null;
    this.retrieveCalls = 0;
  }
}

@Injectable()
class CommitAcknowledgementLosingAiTurnRepository extends AiTurnRepository {
  loseStartWhileCommitPending = false;
  loseNextGroundedAcknowledgement = false;
  loseWhileCommitPending = false;
  startCommitReached = deferred();
  releaseStartCommit = deferred();
  groundedCommitReached = deferred();
  releaseGroundedCommit = deferred();
  reconciliationBeforeLock = deferred();
  allowReconciliationLock = deferred();
  reconciliationAfterLock = deferred();
  private holdGroundedCommit = false;
  private holdStartCommit = false;
  private inFlightStart: Promise<Awaited<ReturnType<AiTurnRepository['start']>>> | null = null;
  private inFlightGroundedCommit: Promise<
    Awaited<ReturnType<AiTurnRepository['completeGrounded']>>
  > | null = null;

  constructor(
    audits: AuditLogRepository,
    database: DatabaseService,
    knowledgeReferences: KnowledgeMessageReferenceRepository,
    quota: QuotaRepository,
    riskEvents: RiskEventRepository,
  ) {
    super(audits, database, knowledgeReferences, quota, riskEvents);
  }

  override async start(input: Parameters<AiTurnRepository['start']>[0]) {
    if (this.loseStartWhileCommitPending) {
      this.loseStartWhileCommitPending = false;
      this.holdStartCommit = true;
      const inFlight = super.start(input);
      this.inFlightStart = inFlight;
      void inFlight.catch(() => undefined);
      await this.startCommitReached.promise;
      throw new Error('synthetic_start_commit_acknowledgement_lost_while_pending');
    }
    return super.start(input);
  }

  override async completeGrounded(input: Parameters<AiTurnRepository['completeGrounded']>[0]) {
    if (this.loseWhileCommitPending) {
      this.loseWhileCommitPending = false;
      this.holdGroundedCommit = true;
      const inFlight = super.completeGrounded(input);
      this.inFlightGroundedCommit = inFlight;
      void inFlight.catch(() => undefined);
      await this.groundedCommitReached.promise;
      throw new Error('synthetic_commit_acknowledgement_lost_while_pending');
    }
    const result = await super.completeGrounded(input);
    if (this.loseNextGroundedAcknowledgement) {
      this.loseNextGroundedAcknowledgement = false;
      throw new Error('synthetic_commit_acknowledgement_lost');
    }
    return result;
  }

  protected override async beforeGroundedCompletionCommit(
    _transaction: AppTransaction,
  ): Promise<void> {
    void _transaction;
    if (!this.holdGroundedCommit) return;
    this.groundedCommitReached.resolve();
    await this.releaseGroundedCommit.promise;
    this.holdGroundedCommit = false;
  }

  protected override async beforeStartCommit(_transaction: AppTransaction): Promise<void> {
    void _transaction;
    if (!this.holdStartCommit) return;
    this.startCommitReached.resolve();
    await this.releaseStartCommit.promise;
    this.holdStartCommit = false;
  }

  protected override async beforeGroundedCompletionReconciliationLock(
    _transaction: AppTransaction,
  ): Promise<void> {
    void _transaction;
    if (!this.inFlightGroundedCommit) return;
    this.reconciliationBeforeLock.resolve();
    await this.allowReconciliationLock.promise;
  }

  protected override async afterGroundedCompletionReconciliationLock(
    _transaction: AppTransaction,
  ): Promise<void> {
    void _transaction;
    if (!this.inFlightGroundedCommit) return;
    this.reconciliationAfterLock.resolve();
    await this.inFlightGroundedCommit;
    this.inFlightGroundedCommit = null;
  }

  reset(): void {
    this.loseStartWhileCommitPending = false;
    this.loseNextGroundedAcknowledgement = false;
    this.loseWhileCommitPending = false;
    this.startCommitReached = deferred();
    this.releaseStartCommit = deferred();
    this.groundedCommitReached = deferred();
    this.releaseGroundedCommit = deferred();
    this.reconciliationBeforeLock = deferred();
    this.allowReconciliationLock = deferred();
    this.reconciliationAfterLock = deferred();
    this.holdGroundedCommit = false;
    this.holdStartCommit = false;
    this.inFlightStart = null;
    this.inFlightGroundedCommit = null;
  }

  async settleInFlightStart(): Promise<void> {
    await this.inFlightStart;
    this.inFlightStart = null;
  }

  async settleInFlightGroundedCommit(): Promise<void> {
    await this.inFlightGroundedCommit;
    this.inFlightGroundedCommit = null;
  }
}

function syntheticManifest(articleKey: string, marker: string) {
  return {
    articleKey,
    version: 1,
    title: `合成知识标题 ${marker}`,
    summary: `合成知识摘要 ${marker}`,
    contentOrigin: 'synthetic_fixture',
    reviewStatus: 'unverified',
    reviewedBy: null,
    reviewedAt: null,
    contentBlocks: [
      { type: 'heading', level: 2, text: `合成知识 ${marker}` },
      { type: 'paragraph', text: `这是只用于测试的合成知识正文 ${marker}。` },
    ],
    sources: [
      {
        publisherName: '合成测试发布者',
        sourceTitle: `合成测试来源 ${marker}`,
        sourceUrl: `https://synthetic.invalid/${articleKey}/1`,
        sourcePublishedAt: null,
        sourceVersionLabel: 'synthetic-v1',
        sourceLocator: '合成测试定位',
        retrievedAt: '2026-09-11T00:00:00.000Z',
      },
    ],
  };
}

describe('Knowledge-grounded AI integration boundary', () => {
  let app: INestApplication;
  let migrationClient: ReturnType<typeof createDatabaseClient>;
  let database: DatabaseService;
  let conversations: ConversationService;
  let consents: ConsentsService;
  let conversationAccess: ConversationAccessService;
  let fixtures: KnowledgeFixtureService;
  let incognitoContexts: IncognitoContextsService;
  let incognitoStore: InMemoryIncognitoContextStore;
  let orchestration: AiOrchestrationService;
  let publication: KnowledgePublicationService;
  let quota: QuotaService;
  let retrieval: HookedKnowledgeRetrievalService;
  let turns: CommitAcknowledgementLosingAiTurnRepository;
  let turnService: AiTurnService;
  const provider = new GroundingProvider();
  const preGate = new AllowingPreGenerationGate();
  const postGate = new ControllablePostGenerationGate();
  const augmentation: KnowledgeAugmentationConfig = { enabled: true };
  const retrievalConfig: KnowledgeRetrievalRuntimeConfig = {
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

    migrationClient = createDatabaseClient(databaseUrl);
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
      .overrideProvider(KNOWLEDGE_AUGMENTATION_CONFIG)
      .useValue(augmentation)
      .overrideProvider(KNOWLEDGE_RETRIEVAL_RUNTIME_CONFIG)
      .useValue(retrievalConfig)
      .overrideProvider(KnowledgeRetrievalService)
      .useClass(HookedKnowledgeRetrievalService)
      .overrideProvider(AiTurnRepository)
      .useClass(CommitAcknowledgementLosingAiTurnRepository)
      .compile();
    app = moduleRef.createNestApplication();
    app.useLogger(false);
    await app.init();

    database = moduleRef.get(DatabaseService);
    conversations = moduleRef.get(ConversationService);
    consents = moduleRef.get(ConsentsService);
    conversationAccess = moduleRef.get(ConversationAccessService);
    fixtures = moduleRef.get(KnowledgeFixtureService);
    incognitoContexts = moduleRef.get(IncognitoContextsService);
    incognitoStore = moduleRef.get(InMemoryIncognitoContextStore);
    orchestration = moduleRef.get(AiOrchestrationService);
    publication = moduleRef.get(KnowledgePublicationService);
    quota = moduleRef.get(QuotaService);
    retrieval = moduleRef.get(KnowledgeRetrievalService);
    turns = moduleRef.get(AiTurnRepository);
    turnService = moduleRef.get(AiTurnService);
  }, 60_000);

  beforeEach(async () => {
    await migrationClient.pool.query('TRUNCATE TABLE users, knowledge_articles CASCADE');
    provider.reset();
    postGate.reset();
    retrieval.reset();
    turns.reset();
  });

  afterAll(async () => {
    if (app) await app.close();
    if (migrationClient) await migrationClient.pool.end();
  });

  async function createUser(): Promise<string> {
    const userId = randomUUID();
    const now = new Date();
    await database.database.insert(users).values({ id: userId, createdAt: now });
    await insertRequiredConsentFixtures(database.database, userId, now);
    return userId;
  }

  async function withdrawCurrentTerms(userId: string): Promise<void> {
    const consentState = await consents.list(userId, { limit: 20 });
    const current = consentState.data.currentRequiredConsents.find(
      (item) => item.consentType === 'terms_of_service',
    );
    if (!current) throw new Error('Expected current terms consent');
    await consents.mutate(userId, {
      operationId: randomUUID(),
      action: 'withdraw',
      consentType: current.consentType,
      consentVersion: current.consentVersion,
      expectedRevision: current.stateRevision,
    });
  }

  async function preparePersistent(userId: string, message: string, representation: 'v1' | 'v2') {
    const now = new Date();
    const conversation = await conversations.create(userId, now);
    const prepared = await orchestration.preparePersistentTurn(
      { userId, sessionId: randomUUID() },
      { clientRequestId: randomUUID(), conversationId: conversation.id, message },
      new AbortController().signal,
      now,
      representation,
    );
    if (prepared.kind !== 'ready') throw new Error('Expected a prepared AI turn');
    return prepared;
  }

  async function collectPersistent(
    prepared: Awaited<ReturnType<typeof preparePersistent>>,
    signal = new AbortController().signal,
  ): Promise<Array<PersistentAiStreamEvent | PersistentAiStreamEventV2>> {
    const events: Array<PersistentAiStreamEvent | PersistentAiStreamEventV2> = [];
    for await (const event of orchestration.streamPreparedTurn(prepared, signal)) {
      events.push(event);
    }
    return events;
  }

  async function collectIncognito(
    prepared: Extract<
      Awaited<ReturnType<AiOrchestrationService['prepareIncognitoTurn']>>,
      { kind: 'ready' }
    >,
    signal = new AbortController().signal,
  ): Promise<Array<IncognitoAiStreamEvent | IncognitoAiStreamEventV2>> {
    const events: Array<IncognitoAiStreamEvent | IncognitoAiStreamEventV2> = [];
    for await (const event of orchestration.streamPreparedIncognitoTurn(prepared, signal)) {
      events.push(event);
    }
    return events;
  }

  it('keeps v1 and a v2 no-hit on the existing immediate semantic-streaming path', async () => {
    const userId = await createUser();
    await fixtures.publishSynthetic(syntheticManifest('v1-disabled', 'v1unique'));

    const v1 = await preparePersistent(userId, 'v1unique', 'v1');
    const v1Events = await collectPersistent(v1);
    expect(retrieval.retrieveCalls).toBe(0);
    expect(provider.groundedCalls).toBe(0);
    expect(provider.ordinaryCalls).toBe(1);
    expect(v1Events).toEqual([
      expect.objectContaining({ type: 'turn.started' }),
      expect.objectContaining({ type: 'message.segment' }),
      expect.objectContaining({ type: 'turn.completed' }),
    ]);

    const noHit = await preparePersistent(userId, 'unrelated-no-hit-token', 'v2');
    const noHitEvents = await collectPersistent(noHit);
    expect(retrieval.retrieveCalls).toBe(1);
    expect(provider.groundedCalls).toBe(0);
    expect(provider.ordinaryCalls).toBe(2);
    expect(noHitEvents).toEqual([
      expect.objectContaining({ type: 'turn.started' }),
      expect.objectContaining({ type: 'message.segment' }),
      expect.objectContaining({ type: 'turn.completed' }),
    ]);
  });

  it('delivers and persists only the fixed no-reference explanation for insufficient evidence', async () => {
    const userId = await createUser();
    await fixtures.publishSynthetic(
      syntheticManifest('insufficient-context', 'insufficientunique'),
    );
    provider.groundedMode = 'insufficient_evidence';
    const prepared = await preparePersistent(userId, 'insufficientunique', 'v2');
    const events = await collectPersistent(prepared);
    for (const event of events) expect(() => parseAiStreamEventV2(event)).not.toThrow();
    expect(events.filter((event) => event.type === 'message.segment')).toEqual([
      expect.objectContaining({
        data: expect.objectContaining({
          text: INSUFFICIENT_KNOWLEDGE_MESSAGE,
          deliveryMode: 'immediate',
        }),
      }),
    ]);
    expect(events.at(-1)).toMatchObject({
      type: 'turn.completed',
      data: {
        deliveryMode: 'immediate',
        knowledgeReferences: [],
      },
    });
    expect(provider.streamCalls).toBe(1);
    expect(provider.ordinaryCalls).toBe(0);
    expect(postGate.candidates).toEqual([
      expect.objectContaining({ candidateSegment: INSUFFICIENT_KNOWLEDGE_MESSAGE }),
    ]);
    const stored = await database.database
      .select({ content: messages.content })
      .from(messages)
      .where(eq(messages.role, 'assistant'));
    expect(stored).toEqual([{ content: INSUFFICIENT_KNOWLEDGE_MESSAGE }]);
    await expect(
      database.database.select().from(assistantMessageKnowledgeReferences),
    ).resolves.toHaveLength(0);
    await expect(quota.getUsage(userId, new Date())).resolves.toMatchObject({ usedCount: 1 });
    await expect(
      conversationAccess.listMessages(
        userId,
        prepared.turn.conversationId,
        { limit: 20, cursor: undefined },
        'v2',
        new Date(),
      ),
    ).resolves.toMatchObject({
      data: {
        messages: expect.arrayContaining([
          expect.objectContaining({
            role: 'assistant',
            content: INSUFFICIENT_KNOWLEDGE_MESSAGE,
            knowledgeReferences: [],
          }),
        ]),
      },
    });
    const replay = await orchestration.preparePersistentTurn(
      { userId, sessionId: randomUUID() },
      {
        clientRequestId: prepared.turn.clientRequestId,
        conversationId: prepared.turn.conversationId,
        message: 'insufficientunique',
      },
      new AbortController().signal,
      new Date(),
      'v2',
    );
    expect(replay.kind).toBe('existing');
    expect(provider.streamCalls).toBe(1);
  });

  it('keeps insufficient-evidence Incognito output ephemeral and reference-free without regenerating', async () => {
    const userId = await createUser();
    const sessionId = randomUUID();
    await fixtures.publishSynthetic(
      syntheticManifest('incognito-insufficient', 'incognitoinsufficient'),
    );
    provider.groundedMode = 'insufficient_evidence';
    const context = await incognitoContexts.create(
      { id: sessionId, userId, expiresAt: new Date(Date.now() + 60_000), revokedAt: null },
      new Date(),
    );
    const prepared = await orchestration.prepareIncognitoTurn(
      { userId, sessionId },
      {
        mode: 'incognito',
        clientRequestId: randomUUID(),
        contextId: context.id,
        message: 'incognitoinsufficient',
      },
      new AbortController().signal,
      new Date(),
      'v2',
    );
    if (prepared.kind !== 'ready') throw new Error('Expected a prepared Incognito turn');
    const events = await collectIncognito(prepared);
    for (const event of events) expect(() => parseAiStreamEventV2(event)).not.toThrow();
    expect(events.at(-1)).toMatchObject({
      type: 'turn.completed',
      data: { deliveryMode: 'immediate', knowledgeReferences: [] },
    });
    expect(provider.streamCalls).toBe(1);
    expect(provider.ordinaryCalls).toBe(0);
    expect(postGate.candidates).toEqual([
      expect.objectContaining({ candidateSegment: INSUFFICIENT_KNOWLEDGE_MESSAGE }),
    ]);
    expect(incognitoStore.get(userId, sessionId, context.id, new Date())?.messages).toEqual([
      { role: 'user', content: 'incognitoinsufficient' },
      { role: 'assistant', content: INSUFFICIENT_KNOWLEDGE_MESSAGE },
    ]);
    await expect(database.database.select().from(messages)).resolves.toHaveLength(0);
    await expect(database.database.select().from(aiTurns)).resolves.toHaveLength(0);
    await expect(
      database.database.select().from(assistantMessageKnowledgeReferences),
    ).resolves.toHaveLength(0);
  });

  it('full-buffers a v2 hit, safety-checks once, and commits text plus exact references atomically', async () => {
    const userId = await createUser();
    await fixtures.publishSynthetic(syntheticManifest('grounded-hit', 'groundingunique'));
    provider.pauseGroundedOutput = true;
    const prepared = await preparePersistent(userId, 'groundingunique', 'v2');
    const stream = orchestration.streamPreparedTurn(prepared, new AbortController().signal);
    const iterator = stream[Symbol.asyncIterator]();

    await expect(iterator.next()).resolves.toMatchObject({ value: { type: 'turn.started' } });
    let visibleBeforeCompletion = false;
    const pendingVisible = iterator.next().then((result) => {
      visibleBeforeCompletion = true;
      return result;
    });
    await provider.groundedPartial.promise;
    await Promise.resolve();
    expect(visibleBeforeCompletion).toBe(false);
    expect(postGate.candidates).toHaveLength(0);

    provider.groundedRelease.resolve();
    await expect(pendingVisible).resolves.toMatchObject({
      value: {
        type: 'message.segment',
        data: {
          text: provider.groundedAnswer,
          deliveryMode: 'commit_with_references',
        },
      },
    });
    const completion = await iterator.next();
    expect(completion).toMatchObject({
      value: {
        type: 'turn.completed',
        data: {
          deliveryMode: 'commit_with_references',
          knowledgeReferences: [
            expect.objectContaining({
              articleKey: 'grounded-hit',
              version: 1,
              contentOrigin: 'synthetic_fixture',
              reviewStatus: 'unverified',
            }),
          ],
        },
      },
    });
    await expect(iterator.next()).resolves.toEqual({ done: true, value: undefined });
    expect(postGate.candidates).toEqual([
      expect.objectContaining({
        candidateSegment: provider.groundedAnswer,
        previouslyApprovedText: '',
      }),
    ]);

    const persistedMessages = await database.database
      .select()
      .from(messages)
      .where(eq(messages.conversationId, prepared.turn.conversationId));
    const assistant = persistedMessages.find((message) => message.role === 'assistant');
    expect(assistant?.content).toBe(provider.groundedAnswer);
    const storedReferences = await database.database
      .select()
      .from(assistantMessageKnowledgeReferences);
    expect(storedReferences).toEqual([
      expect.objectContaining({ assistantMessageId: assistant?.id, ordinal: 1 }),
    ]);

    await expect(
      conversationAccess.listMessages(
        userId,
        prepared.turn.conversationId,
        { limit: 20, cursor: undefined },
        'v1',
        new Date(),
      ),
    ).rejects.toMatchObject({ code: 'CLIENT_CAPABILITY_REQUIRED' });
    await expect(
      conversationAccess.listMessages(
        userId,
        prepared.turn.conversationId,
        { limit: 20, cursor: undefined },
        'v2',
        new Date(),
      ),
    ).resolves.toMatchObject({
      data: {
        messages: [
          expect.objectContaining({ role: 'user', knowledgeReferences: [] }),
          expect.objectContaining({
            role: 'assistant',
            content: provider.groundedAnswer,
            knowledgeReferences: [expect.objectContaining({ articleKey: 'grounded-hit' })],
          }),
        ],
      },
    });
  });

  it.each([
    { mode: 'invalid_reference' as const, finishReason: 'stop' as const, expectedUsage: 0 },
    { mode: 'invalid_reference' as const, finishReason: 'length' as const, expectedUsage: 1 },
    { mode: 'contradictory_evidence' as const, finishReason: 'stop' as const, expectedUsage: 0 },
  ])(
    'rejects $mode without content or references and applies $finishReason billing',
    async ({ mode, finishReason, expectedUsage }) => {
      const userId = await createUser();
      await fixtures.publishSynthetic(syntheticManifest('invalid-reference', 'invalidrefunique'));
      provider.groundedMode = mode;
      provider.finishReason = finishReason;
      const prepared = await preparePersistent(userId, 'invalidrefunique', 'v2');

      await expect(collectPersistent(prepared)).rejects.toMatchObject({
        code: 'AI_PROVIDER_UNAVAILABLE',
      });
      expect(postGate.candidates).toHaveLength(0);
      await expect(quota.getUsage(userId, new Date())).resolves.toMatchObject({
        usedCount: expectedUsage,
      });
      await expect(
        database.database.select().from(assistantMessageKnowledgeReferences),
      ).resolves.toHaveLength(0);
      const assistant = await database.database
        .select()
        .from(messages)
        .where(eq(messages.role, 'assistant'));
      expect(assistant).toHaveLength(0);
    },
  );

  it('uses a trusted immediate replacement and discards grounded references when output safety blocks', async () => {
    const userId = await createUser();
    await fixtures.publishSynthetic(syntheticManifest('blocked-grounding', 'blockedunique'));
    postGate.replacement = '这是不依赖模型与知识引用的可信安全替换。';
    const prepared = await preparePersistent(userId, 'blockedunique', 'v2');

    const events = await collectPersistent(prepared);
    expect(events).toEqual([
      expect.objectContaining({ type: 'turn.started' }),
      expect.objectContaining({
        type: 'message.segment',
        data: expect.objectContaining({ text: postGate.replacement }),
      }),
      expect.objectContaining({
        type: 'turn.completed',
        data: expect.not.objectContaining({ knowledgeReferences: expect.anything() }),
      }),
    ]);
    await expect(quota.getUsage(userId, new Date())).resolves.toMatchObject({ usedCount: 0 });
    await expect(
      database.database.select().from(assistantMessageKnowledgeReferences),
    ).resolves.toHaveLength(0);
    const assistant = await database.database
      .select({ content: messages.content })
      .from(messages)
      .where(eq(messages.role, 'assistant'));
    expect(assistant).toEqual([{ content: postGate.replacement }]);
  });

  it('reconciles a lost post-commit acknowledgement without duplicating the assistant or references', async () => {
    const userId = await createUser();
    await fixtures.publishSynthetic(syntheticManifest('ack-loss', 'acklossunique'));
    turns.loseNextGroundedAcknowledgement = true;
    const prepared = await preparePersistent(userId, 'acklossunique', 'v2');

    const events = await collectPersistent(prepared);
    expect(events.at(-1)).toMatchObject({ type: 'turn.completed' });
    const assistantRows = await database.database
      .select()
      .from(messages)
      .where(eq(messages.role, 'assistant'));
    expect(assistantRows).toHaveLength(1);
    await expect(
      database.database.select().from(assistantMessageKnowledgeReferences),
    ).resolves.toHaveLength(1);
    const [turn] = await database.database
      .select()
      .from(aiTurns)
      .where(eq(aiTurns.id, prepared.turn.id));
    expect(turn).toMatchObject({ status: 'completed', assistantMessageId: assistantRows[0]?.id });
  });

  it('waits for an in-flight commit outcome before reconciling a lost acknowledgement', async () => {
    const userId = await createUser();
    await fixtures.publishSynthetic(syntheticManifest('pending-ack-loss', 'pendingackunique'));
    turns.loseWhileCommitPending = true;
    const prepared = await preparePersistent(userId, 'pendingackunique', 'v2');

    try {
      const collecting = collectPersistent(prepared);
      await turns.groundedCommitReached.promise;
      await turns.reconciliationBeforeLock.promise;
      turns.allowReconciliationLock.resolve();

      let reconciliationAcquiredLock = false;
      void turns.reconciliationAfterLock.promise.then(() => {
        reconciliationAcquiredLock = true;
      });
      await new Promise<void>((resolveImmediate) => setImmediate(resolveImmediate));
      expect(reconciliationAcquiredLock).toBe(false);

      turns.releaseGroundedCommit.resolve();
      const events = await collecting;
      await turns.reconciliationAfterLock.promise;
      expect(events.at(-1)).toMatchObject({ type: 'turn.completed' });
      await expect(quota.getUsage(userId, new Date())).resolves.toMatchObject({ usedCount: 1 });
      await expect(
        database.database.select().from(assistantMessageKnowledgeReferences),
      ).resolves.toHaveLength(1);
    } finally {
      turns.allowReconciliationLock.resolve();
      turns.releaseGroundedCommit.resolve();
      await turns.settleInFlightGroundedCommit();
    }
  });

  it('keeps an indeterminate in-flight commit authoritative without refunding or forcing failure', async () => {
    const userId = await createUser();
    await fixtures.publishSynthetic(syntheticManifest('pending-timeout', 'pendingtimeoutunique'));
    turns.loseWhileCommitPending = true;
    const prepared = await preparePersistent(userId, 'pendingtimeoutunique', 'v2');
    const originalComplete = turnService.completeGrounded.bind(turnService);
    const timeoutSpy = jest
      .spyOn(turnService, 'completeGrounded')
      .mockImplementationOnce((turn, content, versionIds, now) =>
        originalComplete(turn, content, versionIds, now, 50),
      );
    const stream = orchestration.streamPreparedTurn(prepared, new AbortController().signal);
    const iterator = stream[Symbol.asyncIterator]();

    try {
      await expect(iterator.next()).resolves.toMatchObject({ value: { type: 'turn.started' } });
      const pendingResult = iterator.next();
      await turns.groundedCommitReached.promise;
      await turns.reconciliationBeforeLock.promise;
      turns.allowReconciliationLock.resolve();
      await expect(pendingResult).resolves.toEqual({ done: true, value: undefined });

      await expect(quota.getUsage(userId, new Date())).resolves.toMatchObject({ usedCount: 1 });
      const [beforeCommitFinishes] = await database.database
        .select()
        .from(aiTurns)
        .where(eq(aiTurns.id, prepared.turn.id));
      expect(beforeCommitFinishes).toMatchObject({ status: 'streaming' });

      turns.releaseGroundedCommit.resolve();
      await turns.settleInFlightGroundedCommit();
      const [committed] = await database.database
        .select()
        .from(aiTurns)
        .where(eq(aiTurns.id, prepared.turn.id));
      expect(committed).toMatchObject({ status: 'completed' });
      await expect(
        database.database.select().from(assistantMessageKnowledgeReferences),
      ).resolves.toHaveLength(1);
    } finally {
      timeoutSpy.mockRestore();
      turns.allowReconciliationLock.resolve();
      turns.releaseGroundedCommit.resolve();
      await turns.settleInFlightGroundedCommit();
    }
  });

  it('keeps an authoritative grounded commit when execution terminates in the coordinator post-check', async () => {
    const userId = await createUser();
    await fixtures.publishSynthetic(syntheticManifest('post-check-commit', 'postcheckunique'));
    const prepared = await preparePersistent(userId, 'postcheckunique', 'v2');
    const originalComplete = turnService.completeGrounded.bind(turnService);
    const completeSpy = jest
      .spyOn(turnService, 'completeGrounded')
      .mockImplementationOnce(async (...input) => {
        const completed = await originalComplete(...input);
        prepared.execution.abort(new Error('synthetic_post_commit_termination'));
        return completed;
      });

    try {
      await expect(collectPersistent(prepared)).rejects.toThrow(
        'synthetic_post_commit_termination',
      );
      expect(prepared.deliveryState.groundedCommitSucceeded).toBe(true);
      await expect(quota.getUsage(userId, new Date())).resolves.toMatchObject({ usedCount: 1 });
      const [turn] = await database.database
        .select()
        .from(aiTurns)
        .where(eq(aiTurns.id, prepared.turn.id));
      expect(turn).toMatchObject({ status: 'completed' });
      await expect(
        database.database.select().from(assistantMessageKnowledgeReferences),
      ).resolves.toHaveLength(1);
    } finally {
      completeSpy.mockRestore();
    }
  });

  it('falls back to ordinary generation when the exact article version is withdrawn before final recheck', async () => {
    const userId = await createUser();
    await fixtures.publishSynthetic(syntheticManifest('stale-before-freeze', 'staleunique'));
    const recheckReached = deferred();
    const releaseRecheck = deferred();
    retrieval.beforeRecheck = async () => {
      recheckReached.resolve();
      await releaseRecheck.promise;
    };

    const preparing = preparePersistent(userId, 'staleunique', 'v2');
    await recheckReached.promise;
    await publication.withdraw('stale-before-freeze', 1, new Date());
    releaseRecheck.resolve();
    const prepared = await preparing;
    const events = await collectPersistent(prepared);

    expect(provider.groundedCalls).toBe(0);
    expect(provider.ordinaryCalls).toBe(1);
    expect(events).toEqual([
      expect.objectContaining({ type: 'turn.started' }),
      expect.objectContaining({ type: 'message.segment' }),
      expect.objectContaining({ type: 'turn.completed' }),
    ]);
    await expect(
      database.database.select().from(assistantMessageKnowledgeReferences),
    ).resolves.toHaveLength(0);
  });

  it('freezes the exact version when withdrawal happens after the final currentness recheck', async () => {
    const userId = await createUser();
    await fixtures.publishSynthetic(syntheticManifest('frozen-after-recheck', 'freezeunique'));
    const recheckCompleted = deferred();
    const releaseRecheckResult = deferred();
    retrieval.afterRecheck = async () => {
      recheckCompleted.resolve();
      await releaseRecheckResult.promise;
    };

    const preparing = preparePersistent(userId, 'freezeunique', 'v2');
    await recheckCompleted.promise;
    await publication.withdraw('frozen-after-recheck', 1, new Date());
    releaseRecheckResult.resolve();
    const prepared = await preparing;
    const events = await collectPersistent(prepared);

    expect(provider.groundedCalls).toBe(1);
    expect(events.at(-1)).toMatchObject({
      type: 'turn.completed',
      data: {
        deliveryMode: 'commit_with_references',
        knowledgeReferences: [
          expect.objectContaining({
            articleKey: 'frozen-after-recheck',
            availability: 'currently_published',
          }),
        ],
      },
    });
    await expect(
      conversationAccess.listMessages(
        userId,
        prepared.turn.conversationId,
        { limit: 20, cursor: undefined },
        'v2',
        new Date(),
      ),
    ).resolves.toMatchObject({
      data: {
        messages: [
          expect.objectContaining({ role: 'user' }),
          expect.objectContaining({
            role: 'assistant',
            knowledgeReferences: [
              expect.objectContaining({
                articleKey: 'frozen-after-recheck',
                availability: 'no_longer_available',
              }),
            ],
          }),
        ],
      },
    });
  });

  it('returns grounded references for Incognito without persisting ordinary messages or references', async () => {
    const userId = await createUser();
    const sessionId = randomUUID();
    await fixtures.publishSynthetic(syntheticManifest('incognito-grounded', 'incognitounique'));
    const context = await incognitoContexts.create(
      {
        id: sessionId,
        userId,
        expiresAt: new Date(Date.now() + 60_000),
        revokedAt: null,
      },
      new Date(),
    );
    const prepared = await orchestration.prepareIncognitoTurn(
      { userId, sessionId },
      {
        mode: 'incognito',
        clientRequestId: randomUUID(),
        contextId: context.id,
        message: 'incognitounique',
      },
      new AbortController().signal,
      new Date(),
      'v2',
    );
    if (prepared.kind !== 'ready') throw new Error('Expected a prepared Incognito turn');

    const events = await collectIncognito(prepared);
    expect(events.at(-1)).toMatchObject({
      type: 'turn.completed',
      data: {
        deliveryMode: 'commit_with_references',
        knowledgeReferences: [expect.objectContaining({ articleKey: 'incognito-grounded' })],
      },
    });
    await expect(database.database.select().from(messages)).resolves.toHaveLength(0);
    await expect(database.database.select().from(aiTurns)).resolves.toHaveLength(0);
    await expect(
      database.database.select().from(assistantMessageKnowledgeReferences),
    ).resolves.toHaveLength(0);
    expect(incognitoStore.get(userId, sessionId, context.id, new Date())?.messages).toEqual([
      { role: 'user', content: 'incognitounique' },
      { role: 'assistant', content: provider.groundedAnswer },
    ]);
  });

  it('refunds an unrecoverable grounded Incognito answer when its first segment is not acknowledged', async () => {
    const userId = await createUser();
    const sessionId = randomUUID();
    await fixtures.publishSynthetic(
      syntheticManifest('incognito-unacknowledged', 'incognitounackunique'),
    );
    const context = await incognitoContexts.create(
      {
        id: sessionId,
        userId,
        expiresAt: new Date(Date.now() + 60_000),
        revokedAt: null,
      },
      new Date(),
    );
    const prepared = await orchestration.prepareIncognitoTurn(
      { userId, sessionId },
      {
        mode: 'incognito',
        clientRequestId: randomUUID(),
        contextId: context.id,
        message: 'incognitounackunique',
      },
      new AbortController().signal,
      new Date(),
      'v2',
    );
    if (prepared.kind !== 'ready') throw new Error('Expected a prepared Incognito turn');
    const stream = orchestration.streamPreparedIncognitoTurn(
      prepared,
      new AbortController().signal,
    );
    const iterator = stream[Symbol.asyncIterator]();

    await expect(iterator.next()).resolves.toMatchObject({ value: { type: 'turn.started' } });
    await expect(iterator.next()).resolves.toMatchObject({
      value: {
        type: 'message.segment',
        data: { deliveryMode: 'commit_with_references' },
      },
    });
    prepared.execution.abort(new AiExecutionTotalTimeoutError());
    await iterator.return?.();
    orchestration.retireGroundedIncognitoDelivery(prepared);

    expect(provider.groundedCalls).toBe(1);
    await expect(quota.getUsage(userId, new Date())).resolves.toMatchObject({ usedCount: 0 });
    expect(incognitoStore.get(userId, sessionId, context.id, new Date())).toBeNull();
  });

  it('keeps the charge when Incognito context termination wins after grounded dispatch', async () => {
    const userId = await createUser();
    const sessionId = randomUUID();
    await fixtures.publishSynthetic(
      syntheticManifest('incognito-context-first', 'incognitocontextfirstunique'),
    );
    const context = await incognitoContexts.create(
      {
        id: sessionId,
        userId,
        expiresAt: new Date(Date.now() + 60_000),
        revokedAt: null,
      },
      new Date(),
    );
    provider.pauseGroundedOutput = true;
    const prepared = await orchestration.prepareIncognitoTurn(
      { userId, sessionId },
      {
        mode: 'incognito',
        clientRequestId: randomUUID(),
        contextId: context.id,
        message: 'incognitocontextfirstunique',
      },
      new AbortController().signal,
      new Date(),
      'v2',
    );
    if (prepared.kind !== 'ready') throw new Error('Expected a prepared Incognito turn');
    const stream = orchestration.streamPreparedIncognitoTurn(
      prepared,
      new AbortController().signal,
    );
    const iterator = stream[Symbol.asyncIterator]();

    try {
      await expect(iterator.next()).resolves.toMatchObject({ value: { type: 'turn.started' } });
      const pendingSegment = iterator.next();
      await provider.groundedPartial.promise;
      expect(incognitoStore.end(userId, sessionId, context.id)).toBe(true);
      prepared.execution.abort(new AiExecutionTotalTimeoutError());
      provider.groundedRelease.resolve();

      await expect(pendingSegment).rejects.toMatchObject({
        code: 'AI_INCOGNITO_CONTEXT_LOST',
        statusCode: 409,
      });
      expect(provider.groundedCalls).toBe(1);
      await expect(quota.getUsage(userId, new Date())).resolves.toMatchObject({ usedCount: 1 });
      expect(incognitoStore.get(userId, sessionId, context.id, new Date())).toBeNull();
    } finally {
      provider.groundedRelease.resolve();
      await iterator.return?.();
    }
  });

  it('refunds and releases an Incognito claim when delivery closes after turn.started', async () => {
    const userId = await createUser();
    const sessionId = randomUUID();
    const context = await incognitoContexts.create(
      {
        id: sessionId,
        userId,
        expiresAt: new Date(Date.now() + 60_000),
        revokedAt: null,
      },
      new Date(),
    );
    const prepared = await orchestration.prepareIncognitoTurn(
      { userId, sessionId },
      {
        mode: 'incognito',
        clientRequestId: randomUUID(),
        contextId: context.id,
        message: 'synthetic-first-frame-close',
      },
      new AbortController().signal,
      new Date(),
      'v2',
    );
    if (prepared.kind !== 'ready') throw new Error('Expected a prepared Incognito turn');

    const stream = orchestration.streamPreparedIncognitoTurn(
      prepared,
      new AbortController().signal,
    );
    const iterator = stream[Symbol.asyncIterator]();
    await expect(iterator.next()).resolves.toMatchObject({ value: { type: 'turn.started' } });
    await iterator.return?.();

    expect(provider.streamCalls).toBe(0);
    await expect(quota.getUsage(userId, new Date())).resolves.toMatchObject({ usedCount: 0 });
    const next = await orchestration.prepareIncognitoTurn(
      { userId, sessionId },
      {
        mode: 'incognito',
        clientRequestId: randomUUID(),
        contextId: context.id,
        message: 'synthetic-next-claim',
      },
      new AbortController().signal,
      new Date(),
      'v2',
    );
    expect(next.kind).toBe('ready');
    await orchestration.cancelPreparedIncognitoTurnBeforeProvider(next);
  });

  it('refunds a Persistent start committed just before the client cancellation post-check', async () => {
    const userId = await createUser();
    await fixtures.publishSynthetic(syntheticManifest('start-post-check', 'startpostcheckunique'));
    const conversation = await conversations.create(userId, new Date());
    const clientRequestId = randomUUID();
    const controller = new AbortController();
    const startCommitted = deferred();
    const releaseStartResult = deferred();
    const originalStart = turnService.start.bind(turnService);
    const startSpy = jest.spyOn(turnService, 'start').mockImplementationOnce(async (...input) => {
      const started = await originalStart(...input);
      startCommitted.resolve();
      await releaseStartResult.promise;
      return started;
    });

    try {
      const preparing = orchestration.preparePersistentTurn(
        { userId, sessionId: randomUUID() },
        {
          clientRequestId,
          conversationId: conversation.id,
          message: 'startpostcheckunique',
        },
        controller.signal,
        new Date(),
        'v2',
      );
      await startCommitted.promise;
      controller.abort(new Error('synthetic_cancel_after_start_commit'));
      releaseStartResult.resolve();
      await expect(preparing).rejects.toThrow('synthetic_cancel_after_start_commit');

      expect(provider.streamCalls).toBe(0);
      await expect(quota.getUsage(userId, new Date())).resolves.toMatchObject({ usedCount: 0 });
      const [turn] = await database.database
        .select()
        .from(aiTurns)
        .where(eq(aiTurns.clientRequestId, clientRequestId));
      expect(turn).toMatchObject({ status: 'cancelled' });
    } finally {
      releaseStartResult.resolve();
      startSpy.mockRestore();
    }
  });

  it('orders cleanup after an in-flight Persistent start commit whose acknowledgement is lost', async () => {
    const userId = await createUser();
    await fixtures.publishSynthetic(
      syntheticManifest('start-pending-ack-loss', 'startpendingackunique'),
    );
    const conversation = await conversations.create(userId, new Date());
    const clientRequestId = randomUUID();
    turns.loseStartWhileCommitPending = true;

    const preparing = orchestration.preparePersistentTurn(
      { userId, sessionId: randomUUID() },
      {
        clientRequestId,
        conversationId: conversation.id,
        message: 'startpendingackunique',
      },
      new AbortController().signal,
      new Date(),
      'v2',
    );

    try {
      await turns.startCommitReached.promise;
      let cleanupSettled = false;
      void preparing.then(
        () => {
          cleanupSettled = true;
        },
        () => {
          cleanupSettled = true;
        },
      );
      await new Promise<void>((resolveImmediate) => setImmediate(resolveImmediate));
      expect(cleanupSettled).toBe(false);

      turns.releaseStartCommit.resolve();
      await expect(preparing).rejects.toMatchObject({ code: 'DATABASE_ERROR' });
      await turns.settleInFlightStart();

      expect(provider.streamCalls).toBe(0);
      await expect(quota.getUsage(userId, new Date())).resolves.toMatchObject({ usedCount: 0 });
      const [turn] = await database.database
        .select()
        .from(aiTurns)
        .where(eq(aiTurns.clientRequestId, clientRequestId));
      expect(turn).toMatchObject({ status: 'failed', failureCode: 'PREPARATION_FAILED' });
      const persisted = await database.database
        .select()
        .from(messages)
        .where(eq(messages.conversationId, conversation.id));
      expect(persisted).toEqual([
        expect.objectContaining({ role: 'user', content: 'startpendingackunique' }),
      ]);
    } finally {
      turns.releaseStartCommit.resolve();
      await turns.settleInFlightStart();
    }
  });

  it('withdraws consent while the lazy grounded stream is paused before transport dispatch', async () => {
    const userId = await createUser();
    await fixtures.publishSynthetic(
      syntheticManifest('withdraw-before-dispatch', 'withdrawdispatchunique'),
    );
    const beforeTransport = deferred();
    const releaseTransport = deferred();
    provider.beforeStartTransport = async () => {
      beforeTransport.resolve();
      await releaseTransport.promise;
    };
    const prepared = await preparePersistent(userId, 'withdrawdispatchunique', 'v2');

    try {
      const collecting = collectPersistent(prepared);
      await beforeTransport.promise;
      await withdrawCurrentTerms(userId);
      releaseTransport.resolve();
      await expect(collecting).rejects.toBeDefined();

      expect(provider.streamCalls).toBe(0);
      await expect(quota.getUsage(userId, new Date())).resolves.toMatchObject({ usedCount: 0 });
      const [turn] = await database.database
        .select()
        .from(aiTurns)
        .where(eq(aiTurns.id, prepared.turn.id));
      expect(turn).toMatchObject({ status: 'cancelled' });
      await expect(
        database.database.select().from(assistantMessageKnowledgeReferences),
      ).resolves.toHaveLength(0);
    } finally {
      releaseTransport.resolve();
    }
  });

  it('aborts a dispatched grounded stream on consent withdrawal without refunding its usage', async () => {
    const userId = await createUser();
    await fixtures.publishSynthetic(
      syntheticManifest('withdraw-after-dispatch', 'withdrawafterdispatchunique'),
    );
    provider.pauseGroundedOutput = true;
    const prepared = await preparePersistent(userId, 'withdrawafterdispatchunique', 'v2');
    const stream = orchestration.streamPreparedTurn(prepared, new AbortController().signal);
    const iterator = stream[Symbol.asyncIterator]();

    try {
      await expect(iterator.next()).resolves.toMatchObject({ value: { type: 'turn.started' } });
      const pending = iterator.next();
      await provider.groundedPartial.promise;
      await withdrawCurrentTerms(userId);
      provider.groundedRelease.resolve();

      await expect(pending).rejects.toBeDefined();
      expect(provider.streamCalls).toBe(1);
      expect(postGate.candidates).toHaveLength(0);
      await expect(quota.getUsage(userId, new Date())).resolves.toMatchObject({ usedCount: 1 });
      const [turn] = await database.database
        .select()
        .from(aiTurns)
        .where(eq(aiTurns.id, prepared.turn.id));
      expect(turn).toMatchObject({ status: 'cancelled' });
      await expect(
        database.database.select().from(assistantMessageKnowledgeReferences),
      ).resolves.toHaveLength(0);
    } finally {
      provider.groundedRelease.resolve();
    }
  });

  it('never dispatches when cancelled before the grounded provider starts', async () => {
    const userId = await createUser();
    await fixtures.publishSynthetic(syntheticManifest('cancel-before', 'cancelbeforeunique'));
    const prepared = await preparePersistent(userId, 'cancelbeforeunique', 'v2');
    const controller = new AbortController();
    controller.abort(new Error('synthetic_client_cancelled'));

    await expect(collectPersistent(prepared, controller.signal)).rejects.toBeDefined();
    expect(provider.streamCalls).toBe(0);
    await expect(quota.getUsage(userId, new Date())).resolves.toMatchObject({ usedCount: 0 });
    await expect(
      database.database.select().from(assistantMessageKnowledgeReferences),
    ).resolves.toHaveLength(0);
  });

  it('cancels an already-dispatched grounded stream without late output or references', async () => {
    const userId = await createUser();
    await fixtures.publishSynthetic(syntheticManifest('cancel-after', 'cancelafterunique'));
    provider.pauseGroundedOutput = true;
    const prepared = await preparePersistent(userId, 'cancelafterunique', 'v2');
    const controller = new AbortController();
    const stream = orchestration.streamPreparedTurn(prepared, controller.signal);
    const iterator = stream[Symbol.asyncIterator]();
    await expect(iterator.next()).resolves.toMatchObject({ value: { type: 'turn.started' } });
    const pending = iterator.next();
    await provider.groundedPartial.promise;
    controller.abort(new Error('synthetic_client_cancelled_after_dispatch'));
    provider.groundedRelease.resolve();

    await expect(pending).rejects.toBeDefined();
    expect(provider.streamCalls).toBe(1);
    expect(postGate.candidates).toHaveLength(0);
    await expect(quota.getUsage(userId, new Date())).resolves.toMatchObject({ usedCount: 1 });
    await expect(
      database.database.select().from(assistantMessageKnowledgeReferences),
    ).resolves.toHaveLength(0);
    const assistant = await database.database
      .select()
      .from(messages)
      .where(eq(messages.role, 'assistant'));
    expect(assistant).toHaveLength(0);
    await expect(
      database.database
        .select()
        .from(quotaConsumptions)
        .where(eq(quotaConsumptions.userId, userId)),
    ).resolves.toHaveLength(1);
  });
});
