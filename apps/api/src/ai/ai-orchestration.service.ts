import { Inject, Injectable } from '@nestjs/common';
import type {
  IncognitoAiChatRequest,
  IncognitoAiStreamEvent,
  IncognitoAiStreamEventV2,
  KnowledgeReference,
  PersistentAiChatRequest,
  PersistentAiStreamEvent,
  PersistentAiStreamEventV2,
} from '@mental-health/types';
import {
  AIChatDisabledError,
  AIProviderError,
  AIProviderTimeoutError,
  AITurnInProgressError,
  ConflictError,
  ConsentRequiredError,
  InternalServerError,
  QuotaExceededError,
  AIIncognitoContextLostError,
  ValidationError,
} from '../common/errors';
import { env } from '../config/env';
import { ConsentExecutionCoordinator } from '../consents/runtime/consent-execution.coordinator';
import { ConversationService } from '../conversations/conversation.service';
import { QuotaService } from '../quota/quota.service';
import {
  ConversationContextService,
  type ConversationContext,
} from './context/conversation-context.service';
import { AiOperationalLoggingService } from './logging/ai-operational-logging.service';
import {
  LLM_PROVIDER,
  LLMProviderFailure,
  type LLMFinishReason,
  type LLMProvider,
  type LLMProviderFailureCategory,
  type LLMProviderMetadata,
  type LLMProviderStreamEvent,
  type LLMTokenUsage,
} from './providers/llm-provider';
import {
  POST_GENERATION_SAFETY_GATE,
  PRE_GENERATION_SAFETY_GATE,
  type PostGenerationSafetyGate,
  type PreGenerationSafetyGate,
} from './safety/safety-gates';
import { SentenceSegmentBuffer } from './streaming/sentence-segment-buffer';
import { AiTurnCompletionResultUnknownError, AiTurnService } from './turns/ai-turn.service';
import type { AiTurnRecord } from './turns/ai-turn.repository';
import { PromptService } from './prompts/prompt.service';
import {
  CrisisFlowService,
  type TrustedSafetyResponse,
} from '../safety/crisis/crisis-flow.service';
import { AuditLogService } from '../safety/audit/audit-log.service';
import { SafetyOperationalLoggingService } from '../safety/logging/safety-operational-logging.service';
import type { RiskDecision } from '../safety/safety.types';
import { TrustedSafetyTemplateRegistry } from '../safety/templates/trusted-safety-template.registry';
import {
  AiExecutionTotalTimeoutError,
  type ActiveAiExecution,
  type ConsentBoundExecution,
} from './runtime/active-ai-execution.registry';
import { IncognitoGenerationAdmissionService } from './incognito/incognito-generation-admission.service';
import type { KnowledgeReferenceRepresentation } from '../common/http/knowledge-reference-capability';
import {
  KnowledgeRetrievalDeadlineExceededError,
  KnowledgeRetrievalService,
} from '../knowledge/knowledge-retrieval.service';
import {
  KNOWLEDGE_RETRIEVAL_POLICY_VERSION,
  type KnowledgePromptBundle,
} from '../knowledge/knowledge-retrieval.policy';
import { KnowledgeAiOperationalLoggingService } from './logging/knowledge-ai-operational-logging.service';
import {
  KNOWLEDGE_AUGMENTATION_CONFIG,
  type KnowledgeAugmentationConfig,
} from './grounding/knowledge-augmentation.config';
import type { GroundingContextReference } from './context/conversation-context.service';
import {
  GroundedResponseContractError,
  INSUFFICIENT_KNOWLEDGE_MESSAGE,
  parseGroundedProviderEnvelope,
} from './grounding/grounded-response.schema';
import { knowledgeReferenceSchema } from './ai-public.schemas';
import {
  INCOGNITO_CONTEXT_STORE,
  type IncognitoContextStore,
  type IncognitoGenerationClaim,
  IncognitoContextLimitError,
  IncognitoContextTerminatedError,
} from './incognito/incognito-context.store';

export type AuthenticatedAiPrincipal = Readonly<{
  userId: string;
  sessionId: string;
}>;

type PersistentAiTurnInput = Omit<PersistentAiChatRequest, 'mode'> & {
  mode?: 'persistent';
};

export type AiTurnExecutionDeadline = ConsentBoundExecution;

type PreparedKnowledgeGrounding = Readonly<{
  bundles: readonly KnowledgePromptBundle[];
}>;

type PreparedDeliveryState = {
  groundedCommitSucceeded: boolean;
  approvedSegmentWriteAccepted: boolean;
};

export type PreparedAiTurn =
  | Readonly<{ kind: 'existing'; turn: AiTurnRecord; deadlineAt: Date }>
  | Readonly<{
      kind: 'ready';
      turn: AiTurnRecord;
      context: ConversationContext;
      riskDecision: RiskDecision;
      execution: AiTurnExecutionDeadline;
      knowledgeRepresentation: KnowledgeReferenceRepresentation;
      deliveryState: PreparedDeliveryState;
      knowledgeGrounding: PreparedKnowledgeGrounding | null;
    }>
  | Readonly<{
      kind: 'trusted';
      turn: AiTurnRecord & { assistantMessageId: string };
      response: TrustedSafetyResponse;
      execution: AiTurnExecutionDeadline;
    }>
  | Readonly<{
      kind: 'unpersisted_trusted';
      turn: AiTurnRecord;
      response: TrustedSafetyResponse;
      execution: AiTurnExecutionDeadline;
    }>;

export type PreparedIncognitoTurn =
  | Readonly<{
      kind: 'ready';
      principal: AuthenticatedAiPrincipal;
      input: IncognitoAiChatRequest;
      context: ConversationContext;
      riskDecision: RiskDecision;
      generation: IncognitoGenerationClaim;
      quotaIdempotencyKey: string;
      execution: AiTurnExecutionDeadline;
      knowledgeRepresentation: KnowledgeReferenceRepresentation;
      deliveryState: PreparedDeliveryState;
      knowledgeGrounding: PreparedKnowledgeGrounding | null;
    }>
  | Readonly<{
      kind: 'trusted';
      principal: AuthenticatedAiPrincipal;
      input: IncognitoAiChatRequest;
      response: TrustedSafetyResponse;
      riskDecision: RiskDecision;
      generation: IncognitoGenerationClaim;
      execution: AiTurnExecutionDeadline;
    }>;

class OutputSafetyReplacement extends Error {
  constructor(
    public readonly text: string,
    public readonly cause: 'blocked' | 'classifier_unavailable',
  ) {
    super(`Output safety replacement: ${cause}`);
    this.name = OutputSafetyReplacement.name;
  }
}

type ProviderTimeoutPhase = 'first_token' | 'idle' | 'total';

type GroundedProviderCollectionState = {
  providerInvoked: boolean;
  providerIterator: AsyncIterator<LLMProviderStreamEvent> | null;
  providerMetadata: LLMProviderMetadata;
  usage: LLMTokenUsage;
  timeToFirstTokenMs: number | null;
  finishReason: LLMFinishReason | null;
};

class ProviderEventTimeout extends Error {
  constructor(public readonly phase: ProviderTimeoutPhase) {
    super(`Provider stream timed out: ${phase}`);
    this.name = ProviderEventTimeout.name;
  }
}

function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) {
    throw signal.reason ?? new Error('AI turn aborted');
  }
}

type WaitOutcome =
  { type: 'provider'; item: IteratorResult<LLMProviderStreamEvent> } | { type: 'segment_flush' };

function waitForProviderOrFlush(
  pending: Promise<IteratorResult<LLMProviderStreamEvent>>,
  providerTimeoutMilliseconds: number,
  segmentWaitMilliseconds: number | null,
  signal: AbortSignal,
  timeoutPhase: ProviderTimeoutPhase,
): Promise<WaitOutcome> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (callback: () => void): void => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(providerTimer);
      if (segmentTimer) {
        clearTimeout(segmentTimer);
      }
      signal.removeEventListener('abort', onAbort);
      callback();
    };
    const onAbort = (): void => finish(() => reject(signal.reason));
    const providerTimer = setTimeout(
      () => finish(() => reject(new ProviderEventTimeout(timeoutPhase))),
      Math.max(0, providerTimeoutMilliseconds),
    );
    const segmentTimer =
      segmentWaitMilliseconds === null
        ? null
        : setTimeout(
            () => finish(() => resolve({ type: 'segment_flush' })),
            Math.max(0, segmentWaitMilliseconds),
          );

    signal.addEventListener('abort', onAbort, { once: true });
    pending.then(
      (item) => finish(() => resolve({ type: 'provider', item })),
      (error: unknown) => finish(() => reject(error)),
    );
  });
}

function failureCategory(
  error: unknown,
): LLMProviderFailureCategory | 'persistence' | 'safety' | 'internal' {
  if (error instanceof LLMProviderFailure) {
    return error.category;
  }
  if (error instanceof ProviderEventTimeout) {
    return 'timeout';
  }
  if (error instanceof InternalServerError) {
    return 'internal';
  }
  return 'persistence';
}

const EMPTY_USAGE: LLMTokenUsage = {
  inputTokens: null,
  outputTokens: null,
  totalTokens: null,
};

const EMPTY_METADATA: LLMProviderMetadata = {
  provider: 'unknown',
  model: 'unknown',
  requestId: null,
};

const MAX_OUTPUT_CHARACTERS_PER_REQUESTED_TOKEN = 16;
const MAX_GROUNDED_RECONCILIATION_MS = 2_000;

@Injectable()
export class AiOrchestrationService {
  constructor(
    private readonly aiTurns: AiTurnService,
    private readonly consentExecutions: ConsentExecutionCoordinator,
    private readonly audits: AuditLogService,
    private readonly contextService: ConversationContextService,
    private readonly conversations: ConversationService,
    private readonly crisisFlow: CrisisFlowService,
    private readonly incognitoAdmission: IncognitoGenerationAdmissionService,
    @Inject(INCOGNITO_CONTEXT_STORE)
    private readonly incognitoContexts: IncognitoContextStore,
    private readonly logging: AiOperationalLoggingService,
    @Inject(KNOWLEDGE_AUGMENTATION_CONFIG)
    private readonly knowledgeAugmentation: KnowledgeAugmentationConfig,
    private readonly knowledgeLogging: KnowledgeAiOperationalLoggingService,
    private readonly knowledgeRetrieval: KnowledgeRetrievalService,
    @Inject(LLM_PROVIDER) private readonly provider: LLMProvider,
    @Inject(POST_GENERATION_SAFETY_GATE)
    private readonly postGenerationSafety: PostGenerationSafetyGate,
    @Inject(PRE_GENERATION_SAFETY_GATE)
    private readonly preGenerationSafety: PreGenerationSafetyGate,
    private readonly prompts: PromptService,
    private readonly quota: QuotaService,
    private readonly safetyLogging: SafetyOperationalLoggingService,
    private readonly templates: TrustedSafetyTemplateRegistry,
  ) {}

  async prepareIncognitoTurn(
    principal: AuthenticatedAiPrincipal,
    input: IncognitoAiChatRequest,
    signal: AbortSignal,
    now = new Date(),
    knowledgeRepresentation: KnowledgeReferenceRepresentation = 'v1',
  ): Promise<PreparedIncognitoTurn> {
    const pendingExecution = this.consentExecutions.registerPending({
      userId: principal.userId,
      sessionId: principal.sessionId,
      clientSignal: signal,
    });

    let admission;
    let execution: ConsentBoundExecution;
    try {
      execution = await this.consentExecutions.bindRequired(pendingExecution);
      admission = await this.incognitoAdmission.claim({
        userId: principal.userId,
        sessionId: principal.sessionId,
        contextId: input.contextId,
        clientRequestId: input.clientRequestId,
        message: input.message,
        signal: execution.signal,
        execution,
        now,
      });
    } catch (error) {
      const contextTerminated = error instanceof IncognitoContextTerminatedError;
      const timedOut = contextTerminated
        ? false
        : this.synchronizeExecutionDeadline(pendingExecution, error);
      pendingExecution.dispose();
      if (contextTerminated) {
        throw new AIIncognitoContextLostError();
      }
      if (error instanceof AIIncognitoContextLostError) {
        throw error;
      }
      if (timedOut) {
        throw new AIProviderTimeoutError();
      }
      if (this.isConsentTermination(pendingExecution, error)) {
        throw new ConsentRequiredError();
      }
      throw error;
    }

    try {
      throwIfAborted(admission.generation.signal);
      if (admission.kind === 'trusted') {
        try {
          await this.consentExecutions.assertStillUsable(execution);
          const withUserMessage = this.incognitoContexts.append(
            principal.userId,
            principal.sessionId,
            input.contextId,
            admission.generation.id,
            { role: 'user', content: input.message },
            now,
          );
          if (withUserMessage) {
            this.incognitoContexts.append(
              principal.userId,
              principal.sessionId,
              input.contextId,
              admission.generation.id,
              { role: 'assistant', content: admission.response.content },
              now,
            );
          }
        } catch {
          // A trusted safety response remains deliverable even if the bounded runtime is full.
        }
        await this.consentExecutions.assertStillUsable(execution);
        throwIfAborted(execution.signal);
        throwIfAborted(admission.generation.signal);
        return {
          kind: 'trusted',
          principal,
          input,
          response: admission.response,
          riskDecision: admission.riskDecision,
          generation: admission.generation,
          execution,
        };
      }

      const preparedContext = await this.prepareKnowledgeContext(
        input.message,
        admission.riskDecision,
        knowledgeRepresentation,
        execution,
        () => {
          const prompt = this.generationPromptFor(admission.riskDecision);
          return this.contextService.buildIncognitoContext(
            admission.context.messages,
            input.message,
            prompt.key as 'supportive-chat' | 'supportive-chat-safety' | 'high-risk-support',
          );
        },
        (bundles) =>
          this.contextService.buildIncognitoGroundedContext(
            admission.context.messages,
            input.message,
            this.toGroundingContextReferences(bundles),
            admission.riskDecision.status === 'assessed' &&
              admission.riskDecision.route === 'ALLOW_WITH_SAFETY_INSTRUCTION',
          ),
      );
      const appended = this.incognitoContexts.append(
        principal.userId,
        principal.sessionId,
        input.contextId,
        admission.generation.id,
        { role: 'user', content: input.message },
        now,
      );
      if (!appended) {
        try {
          await this.quota.refundQuota(principal.userId, admission.quotaIdempotencyKey, now);
        } catch {
          // Context loss remains the authoritative client outcome. The idempotent
          // quota cleanup may be retried by the enclosing bounded cleanup path.
        }
        throw new AIIncognitoContextLostError();
      }
      await this.consentExecutions.assertStillUsable(execution);
      throwIfAborted(execution.signal);
      throwIfAborted(admission.generation.signal);
      return {
        kind: 'ready',
        principal,
        input,
        context: preparedContext.context,
        riskDecision: admission.riskDecision,
        generation: admission.generation,
        quotaIdempotencyKey: admission.quotaIdempotencyKey,
        execution,
        knowledgeRepresentation,
        deliveryState: {
          groundedCommitSucceeded: false,
          approvedSegmentWriteAccepted: false,
        },
        knowledgeGrounding: preparedContext.knowledgeGrounding,
      };
    } catch (error) {
      const contextTerminated =
        error instanceof IncognitoContextTerminatedError ||
        admission.generation.signal.reason instanceof IncognitoContextTerminatedError;
      const timedOut = contextTerminated
        ? false
        : this.synchronizeExecutionDeadline(execution, error);
      let cleanupError: unknown;
      try {
        if (admission.kind === 'generation') {
          await this.quota.refundQuota(principal.userId, admission.quotaIdempotencyKey, now);
        }
      } catch (cleanupFailure) {
        cleanupError = cleanupFailure;
      } finally {
        this.releaseIncognitoGeneration(principal, input.contextId, admission.generation.id);
        execution.dispose();
      }
      if (contextTerminated) {
        throw new AIIncognitoContextLostError();
      }
      if (error instanceof AIIncognitoContextLostError) {
        throw error;
      }
      if (timedOut) {
        throw new AIProviderTimeoutError();
      }
      if (this.isConsentTermination(execution, error)) {
        throw new ConsentRequiredError();
      }
      if (error instanceof IncognitoContextLimitError) {
        throw new ValidationError('无痕对话上下文已达到容量限制，请重新开始');
      }
      if (cleanupError) throw cleanupError;
      throw error;
    }
  }

  async preparePersistentTurn(
    principal: AuthenticatedAiPrincipal,
    input: PersistentAiTurnInput,
    signal: AbortSignal,
    now = new Date(),
    knowledgeRepresentation: KnowledgeReferenceRepresentation = 'v1',
  ): Promise<PreparedAiTurn> {
    const pendingExecution = this.consentExecutions.registerPending({
      userId: principal.userId,
      sessionId: principal.sessionId,
      clientSignal: signal,
    });

    let execution: ConsentBoundExecution;
    try {
      if (!env.AI_CHAT_ENABLED) {
        throw new AIChatDisabledError();
      }
      execution = await this.consentExecutions.bindRequired(pendingExecution);
      throwIfAborted(execution.signal);

      const existing = await this.aiTurns.findByClientRequestId(
        principal.userId,
        input.clientRequestId,
      );
      if (existing) {
        try {
          this.assertPersistentConversationBinding(existing, input.conversationId);
          await this.conversations.get(principal.userId, existing.conversationId, now);
          this.synchronizeExecutionDeadline(execution);
          throwIfAborted(execution.signal);
        } finally {
          execution.dispose();
        }
        return { kind: 'existing', turn: existing, deadlineAt: execution.deadlineAt };
      }

      const conversation = input.conversationId
        ? await this.conversations.get(principal.userId, input.conversationId, now)
        : await this.conversations.create(principal.userId, now);
      const routingPrompt = this.prompts.getSafetyRoutingPrompt();
      const claimed = await this.aiTurns.claim({
        userId: principal.userId,
        conversationId: conversation.id,
        clientRequestId: input.clientRequestId,
        promptKey: routingPrompt.key,
        promptVersion: routingPrompt.version,
        now,
      });
      if (!claimed.created) {
        try {
          this.assertPersistentConversationBinding(claimed.turn, input.conversationId);
          this.synchronizeExecutionDeadline(execution);
          throwIfAborted(execution.signal);
        } finally {
          execution.dispose();
        }
        return { kind: 'existing', turn: claimed.turn, deadlineAt: execution.deadlineAt };
      }

      try {
        const quotaAvailable = await this.quota.canUseAI(principal.userId, now);
        throwIfAborted(execution.signal);
        const riskDecision = await this.preGenerationSafety.check(
          {
            turnId: claimed.turn.id,
            userId: principal.userId,
            target: { kind: 'conversation', conversationId: conversation.id },
            message: input.message,
            now,
          },
          execution.signal,
          execution,
        );
        throwIfAborted(execution.signal);

        const trustedResponse = this.trustedResponseFor(riskDecision, quotaAvailable);
        if (trustedResponse) {
          try {
            await this.consentExecutions.assertStillUsable(execution);
            const completed = await this.consentExecutions.runWhileUsable(execution, () =>
              this.aiTurns.completeTrusted(
                claimed.turn,
                {
                  userMessageContent: input.message,
                  assistantContent: trustedResponse.content,
                  promptKey: trustedResponse.templateKey,
                  promptVersion: trustedResponse.templateVersion,
                  riskDecision,
                  templateKey: trustedResponse.templateKey,
                  templateVersion: trustedResponse.templateVersion,
                },
                now,
              ),
            );
            await this.consentExecutions.assertStillUsable(execution);
            throwIfAborted(execution.signal);
            return { kind: 'trusted', turn: completed, response: trustedResponse, execution };
          } catch (error) {
            this.synchronizeExecutionDeadline(execution, error);
            if (execution.signal.aborted) {
              throw execution.signal.reason ?? error;
            }
            this.safetyLogging.crisisPersistenceFailed({ turnId: claimed.turn.id });
            try {
              await this.aiTurns.finish(
                claimed.turn,
                'failed',
                'TRUSTED_SAFETY_PERSISTENCE_FAILED',
                new Date(),
              );
            } catch {
              // The trusted response remains deliverable even when persistence is unavailable.
            }
            return {
              kind: 'unpersisted_trusted',
              turn: claimed.turn,
              response: trustedResponse,
              execution,
            };
          }
        }

        if (!quotaAvailable) {
          await this.aiTurns.failAfterSafetyDecision(
            claimed.turn,
            riskDecision,
            'QUOTA_EXCEEDED',
            now,
          );
          throw new QuotaExceededError();
        }

        const preparedContext = await this.prepareKnowledgeContext(
          input.message,
          riskDecision,
          knowledgeRepresentation,
          execution,
          () => {
            const prompt = this.generationPromptFor(riskDecision);
            return this.contextService.buildPersistentContext(
              principal.userId,
              conversation.id,
              input.message,
              now,
              prompt.key as 'supportive-chat' | 'supportive-chat-safety' | 'high-risk-support',
            );
          },
          (bundles) =>
            this.contextService.buildPersistentGroundedContext(
              principal.userId,
              conversation.id,
              input.message,
              this.toGroundingContextReferences(bundles),
              now,
              riskDecision.status === 'assessed' &&
                riskDecision.route === 'ALLOW_WITH_SAFETY_INSTRUCTION',
            ),
        );
        throwIfAborted(execution.signal);
        await this.consentExecutions.assertStillUsable(execution);
        const started = await this.consentExecutions.runWhileUsable(execution, () =>
          this.aiTurns.start(
            claimed.turn,
            input.message,
            {
              key: preparedContext.context.promptKey,
              version: preparedContext.context.promptVersion,
            },
            riskDecision,
            now,
          ),
        );
        await this.consentExecutions.assertStillUsable(execution);
        throwIfAborted(execution.signal);
        return {
          kind: 'ready',
          turn: started,
          context: preparedContext.context,
          riskDecision,
          execution,
          knowledgeRepresentation,
          deliveryState: {
            groundedCommitSucceeded: false,
            approvedSegmentWriteAccepted: false,
          },
          knowledgeGrounding: preparedContext.knowledgeGrounding,
        };
      } catch (error) {
        const timedOut = this.synchronizeExecutionDeadline(execution, error);
        const cancelled = execution.signal.aborted && !timedOut;
        try {
          // This transaction locks the turn before refunding. It therefore orders cleanup
          // after an in-flight start transaction and cannot miss a consumption merely because
          // the start COMMIT acknowledgement was lost.
          await this.aiTurns.settleBeforeProviderFailure(
            claimed.turn,
            cancelled ? 'cancelled' : 'failed',
            cancelled
              ? 'CANCELLED_BEFORE_PROVIDER'
              : timedOut
                ? 'TOTAL_TIMEOUT_BEFORE_PROVIDER'
                : this.safeFailureCode(error),
            new Date(),
          );
        } finally {
          execution.dispose();
        }
        if (timedOut) {
          throw new AIProviderTimeoutError();
        }
        if (this.isConsentTermination(execution, error)) {
          throw new ConsentRequiredError();
        }
        throw error;
      }
    } catch (error) {
      const timedOut = this.synchronizeExecutionDeadline(pendingExecution, error);
      pendingExecution.dispose();
      if (timedOut) {
        throw new AIProviderTimeoutError();
      }
      if (this.isConsentTermination(pendingExecution, error)) {
        throw new ConsentRequiredError();
      }
      throw error;
    }
  }

  private trustedResponseFor(
    decision: RiskDecision,
    quotaAvailable: boolean,
  ): TrustedSafetyResponse | null {
    if (decision.status === 'unavailable') {
      return this.asTrustedResponse(this.templates.get('classifier-unavailable'));
    }
    if (decision.route === 'CRISIS_RESPONSE') {
      return this.crisisFlow.build(decision.harmSubject);
    }
    if (decision.level === 'HIGH' && !quotaAvailable) {
      return this.asTrustedResponse(this.templates.get('high-quota-fallback'));
    }
    return null;
  }

  private asTrustedResponse(
    template: Readonly<{
      key: string;
      version: string;
      content: string;
    }>,
  ): TrustedSafetyResponse {
    return {
      templateKey: template.key,
      templateVersion: template.version,
      content: template.content,
    };
  }

  private generationPromptFor(decision: RiskDecision): Readonly<{ key: string; version: string }> {
    if (decision.status === 'unavailable') {
      return this.prompts.getSupportiveChatPrompt();
    }
    if (decision.route === 'ALLOW_CONTROLLED_FULL_BUFFER') {
      return this.prompts.getHighRiskSupportPrompt();
    }
    if (decision.route === 'ALLOW_WITH_SAFETY_INSTRUCTION') {
      return this.prompts.getSupportiveChatSafetyPrompt();
    }
    return this.prompts.getSupportiveChatPrompt();
  }

  private async prepareKnowledgeContext(
    query: string,
    riskDecision: RiskDecision,
    representation: KnowledgeReferenceRepresentation,
    execution: ConsentBoundExecution,
    buildOrdinaryContext: () => ConversationContext | Promise<ConversationContext>,
    buildGroundedContext: (
      bundles: readonly KnowledgePromptBundle[],
    ) => ConversationContext | Promise<ConversationContext>,
  ): Promise<
    Readonly<{
      context: ConversationContext;
      knowledgeGrounding: PreparedKnowledgeGrounding | null;
    }>
  > {
    const eligible =
      this.knowledgeAugmentation.enabled &&
      representation === 'v2' &&
      riskDecision.status === 'assessed' &&
      (riskDecision.level === 'LOW' || riskDecision.level === 'MEDIUM') &&
      (riskDecision.route === 'ALLOW_NORMAL_GENERATION' ||
        riskDecision.route === 'ALLOW_WITH_SAFETY_INSTRUCTION');
    if (!eligible) {
      return { context: await buildOrdinaryContext(), knowledgeGrounding: null };
    }

    const startedAt = Date.now();
    const logOutcome = (
      outcome: 'hit' | 'no_hit' | 'unavailable' | 'corpus_limit_exceeded',
      policyVersion: string,
      selectedCount: number,
    ): void => {
      this.knowledgeLogging.retrievalCompleted({
        outcome,
        policyVersion,
        durationMs: Date.now() - startedAt,
        selectedCount,
      });
    };

    try {
      await this.consentExecutions.assertStillUsable(execution);
      throwIfAborted(execution.signal);
      const result = await this.knowledgeRetrieval.retrieve({
        query,
        signal: execution.signal,
        deadlineAt: execution.deadlineAt,
      });
      await this.consentExecutions.assertStillUsable(execution);
      throwIfAborted(execution.signal);

      if (result.kind !== 'hit') {
        logOutcome(result.kind, result.policyVersion, 0);
        return { context: await buildOrdinaryContext(), knowledgeGrounding: null };
      }

      let groundedContext: ConversationContext;
      try {
        groundedContext = await buildGroundedContext(result.bundles);
      } catch (error) {
        this.throwIfKnowledgePreparationTerminated(error, execution);
        logOutcome('unavailable', result.policyVersion, 0);
        return { context: await buildOrdinaryContext(), knowledgeGrounding: null };
      }

      await this.consentExecutions.assertStillUsable(execution);
      throwIfAborted(execution.signal);
      const currentness = await this.knowledgeRetrieval.recheckCurrent({
        bundles: result.bundles,
        signal: execution.signal,
        deadlineAt: execution.deadlineAt,
      });
      await this.consentExecutions.assertStillUsable(execution);
      throwIfAborted(execution.signal);

      if (currentness.kind !== 'current') {
        logOutcome(
          currentness.kind === 'stale' ? 'no_hit' : 'unavailable',
          result.policyVersion,
          0,
        );
        return { context: await buildOrdinaryContext(), knowledgeGrounding: null };
      }

      logOutcome('hit', result.policyVersion, result.bundles.length);
      return {
        context: groundedContext,
        knowledgeGrounding: { bundles: result.bundles },
      };
    } catch (error) {
      this.throwIfKnowledgePreparationTerminated(error, execution);
      logOutcome('unavailable', KNOWLEDGE_RETRIEVAL_POLICY_VERSION, 0);
      return { context: await buildOrdinaryContext(), knowledgeGrounding: null };
    }
  }

  private throwIfKnowledgePreparationTerminated(
    error: unknown,
    execution: ConsentBoundExecution,
  ): void {
    this.synchronizeExecutionDeadline(execution, error);
    if (this.isConsentTermination(execution, error)) {
      throw new ConsentRequiredError();
    }
    if (execution.signal.aborted) {
      throw execution.signal.reason ?? error;
    }
    if (
      error instanceof KnowledgeRetrievalDeadlineExceededError ||
      execution.deadlineAt.getTime() <= Date.now()
    ) {
      const timeout = new AiExecutionTotalTimeoutError();
      execution.abort(timeout);
      throw timeout;
    }
  }

  private toGroundingContextReferences(
    bundles: readonly KnowledgePromptBundle[],
  ): readonly GroundingContextReference[] {
    return bundles.map((bundle) => ({
      referenceId: bundle.referenceId,
      title: bundle.title,
      summary: bundle.summary,
      contentBlocks: bundle.blocks.map((selected) => selected.block),
    }));
  }

  async *streamPreparedTurn(
    prepared: Extract<PreparedAiTurn, { kind: 'ready' }>,
    clientSignal: AbortSignal,
  ): AsyncIterable<PersistentAiStreamEvent | PersistentAiStreamEventV2> {
    const { turn, context, riskDecision } = prepared;
    const metadata = { userId: turn.userId, conversationId: turn.conversationId, turnId: turn.id };
    const generationStartedAt = Date.now();
    const generationController = new AbortController();
    const onExecutionAbort = (): void =>
      generationController.abort(prepared.execution.signal.reason ?? new Error('turn_aborted'));
    const onClientAbort = (): void =>
      generationController.abort(clientSignal.reason ?? new Error('client_disconnect'));
    prepared.execution.signal.addEventListener('abort', onExecutionAbort, { once: true });
    clientSignal.addEventListener('abort', onClientAbort, { once: true });
    if (prepared.execution.signal.aborted) {
      onExecutionAbort();
    }
    if (clientSignal.aborted) {
      onClientAbort();
    }

    const buffer = new SentenceSegmentBuffer(
      env.AI_SEGMENT_MAX_CHARACTERS,
      env.AI_SEGMENT_MAX_WAIT_MS,
    );
    const useFullBuffer = riskDecision.bufferingMode === 'full';
    let fullBufferedText = '';
    let approvedText = '';
    let deliveredSegments = 0;
    let segmentSequence = 0;
    let providerMetadata = EMPTY_METADATA;
    let usage = EMPTY_USAGE;
    let timeToFirstTokenMs: number | null = null;
    let completedReason: LLMFinishReason | null = null;
    let providerInvoked = false;
    let providerIterator: AsyncIterator<LLMProviderStreamEvent> | null = null;
    let receivedOutputCharacters = 0;
    let lifecycleSettled = false;
    const hasAcceptedApprovedSegment = (): boolean =>
      deliveredSegments > 0 || prepared.deliveryState.approvedSegmentWriteAccepted;

    try {
      yield {
        type: 'turn.started',
        data: { mode: 'persistent', turnId: turn.id, conversationId: turn.conversationId },
      };
      if (generationController.signal.aborted) {
        throw generationController.signal.reason;
      }
      if (prepared.knowledgeGrounding) {
        const groundedState: GroundedProviderCollectionState = {
          providerInvoked: false,
          providerIterator: null,
          providerMetadata: EMPTY_METADATA,
          usage: EMPTY_USAGE,
          timeToFirstTokenMs: null,
          finishReason: null,
        };
        let rawResponse: string;
        try {
          rawResponse = await this.collectGroundedProviderResponse(
            {
              requestId: turn.id,
              context,
              execution: prepared.execution,
              signal: generationController.signal,
              generationStartedAt,
              logMetadata: metadata,
            },
            groundedState,
          );
        } finally {
          providerInvoked = groundedState.providerInvoked;
          providerIterator = groundedState.providerIterator;
          providerMetadata = groundedState.providerMetadata;
          usage = groundedState.usage;
          timeToFirstTokenMs = groundedState.timeToFirstTokenMs;
          completedReason = groundedState.finishReason;
        }
        if (completedReason === null) {
          throw new LLMProviderFailure('malformed_stream', true, providerMetadata.requestId);
        }
        const groundedFinishReason = completedReason;

        const grounded = this.parseGroundedResponse(
          rawResponse,
          prepared.knowledgeGrounding.bundles,
          context,
          providerMetadata,
        );
        const approved = await this.approveSegment(
          {
            userId: turn.userId,
            operationId: turn.id,
            target: { kind: 'conversation', conversationId: turn.conversationId },
          },
          grounded.answer,
          '',
          riskDecision,
          generationController.signal,
          prepared.execution,
        );
        if (approved.length === 0) {
          throw new LLMProviderFailure('malformed_stream', true, providerMetadata.requestId);
        }

        approvedText = approved;
        throwIfAborted(generationController.signal);
        await this.consentExecutions.assertStillUsable(prepared.execution);
        const completed = await this.consentExecutions.runWhileUsable(
          prepared.execution,
          async () => {
            const result =
              grounded.delivery.deliveryMode === 'immediate'
                ? await this.aiTurns.complete(turn, approved, new Date())
                : await this.aiTurns.completeGrounded(
                    turn,
                    approved,
                    grounded.bundles.map((bundle) => bundle.versionId),
                    new Date(),
                    Math.max(
                      1,
                      Math.min(
                        MAX_GROUNDED_RECONCILIATION_MS,
                        prepared.execution.deadlineAt.getTime() - Date.now(),
                      ),
                    ),
                  );
            prepared.deliveryState.groundedCommitSucceeded = true;
            lifecycleSettled = true;
            return result;
          },
        );

        this.logging.turnCompleted(metadata, {
          provider: providerMetadata.provider,
          model: providerMetadata.model,
          providerRequestId: providerMetadata.requestId,
          durationMs: Date.now() - generationStartedAt,
          timeToFirstTokenMs,
          usage,
          finishReason: groundedFinishReason,
        });
        segmentSequence = 1;
        yield {
          type: 'message.segment',
          data: {
            mode: 'persistent',
            turnId: turn.id,
            sequence: segmentSequence,
            text: approved,
            deliveryMode: grounded.delivery.deliveryMode,
          },
        } satisfies PersistentAiStreamEventV2;
        deliveredSegments = 1;
        yield {
          type: 'turn.completed',
          data: {
            mode: 'persistent',
            turnId: turn.id,
            assistantMessageId: completed.assistantMessageId,
            finishReason: groundedFinishReason,
            ...grounded.delivery,
          },
        } satisfies PersistentAiStreamEventV2;
        return;
      }

      const stream = this.provider.streamChat(
        {
          requestId: turn.id,
          messages: context.messages,
          maxOutputTokens: env.LLM_MAX_OUTPUT_TOKENS,
        },
        {
          signal: generationController.signal,
          startTransport: async (startTransport) =>
            this.consentExecutions.starter(
              prepared.execution,
              'generation',
              generationController.signal,
            )((signal) => {
              providerInvoked = true;
              return startTransport(signal);
            }),
        },
      );
      const iterator = stream[Symbol.asyncIterator]();
      providerIterator = iterator;
      let pending = iterator.next();
      let providerDeadline = Date.now() + env.LLM_FIRST_TOKEN_TIMEOUT_MS;
      let hasTextDelta = false;

      while (completedReason === null) {
        const wait = useFullBuffer ? null : buffer.millisecondsUntilFlush();
        const outcome = await waitForProviderOrFlush(
          pending,
          providerDeadline - Date.now(),
          wait,
          generationController.signal,
          hasTextDelta ? 'idle' : 'first_token',
        );

        if (outcome.type === 'segment_flush') {
          const due = buffer.flushIfDue();
          if (due) {
            const approved = await this.approveSegment(
              {
                userId: turn.userId,
                operationId: turn.id,
                target: { kind: 'conversation', conversationId: turn.conversationId },
              },
              due,
              approvedText,
              riskDecision,
              generationController.signal,
              prepared.execution,
            );
            if (approved.length > 0) {
              approvedText += approved;
              segmentSequence += 1;
              yield {
                type: 'message.segment',
                data: {
                  mode: 'persistent',
                  turnId: turn.id,
                  sequence: segmentSequence,
                  text: approved,
                },
              };
              deliveredSegments += 1;
            }
          }
          continue;
        }

        if (outcome.item.done) {
          throw new LLMProviderFailure('malformed_stream', true, providerMetadata.requestId);
        }
        const event = outcome.item.value;
        providerDeadline = hasTextDelta
          ? Date.now() + env.LLM_STREAM_IDLE_TIMEOUT_MS
          : generationStartedAt + env.LLM_FIRST_TOKEN_TIMEOUT_MS;

        if (event.type === 'started') {
          providerMetadata = event.metadata;
          this.logging.turnStarted(metadata, event.metadata.provider, event.metadata.model);
          if (!hasTextDelta) {
            providerDeadline = generationStartedAt + env.LLM_FIRST_TOKEN_TIMEOUT_MS;
          }
          pending = iterator.next();
          continue;
        }
        if (event.type === 'usage') {
          usage = event.usage;
          pending = iterator.next();
          continue;
        }
        if (event.type === 'text_delta') {
          if (!hasTextDelta) {
            hasTextDelta = true;
            timeToFirstTokenMs = Date.now() - generationStartedAt;
            this.logging.firstSegment(metadata, timeToFirstTokenMs);
          }
          providerDeadline = Date.now() + env.LLM_STREAM_IDLE_TIMEOUT_MS;
          receivedOutputCharacters += Array.from(event.text).length;
          if (
            receivedOutputCharacters >
            env.LLM_MAX_OUTPUT_TOKENS * MAX_OUTPUT_CHARACTERS_PER_REQUESTED_TOKEN
          ) {
            throw new LLMProviderFailure('malformed_stream', true, providerMetadata.requestId);
          }
          if (useFullBuffer) {
            fullBufferedText += event.text;
            pending = iterator.next();
            continue;
          }
          for (const candidate of buffer.append(event.text)) {
            const approved = await this.approveSegment(
              {
                userId: turn.userId,
                operationId: turn.id,
                target: { kind: 'conversation', conversationId: turn.conversationId },
              },
              candidate,
              approvedText,
              riskDecision,
              generationController.signal,
              prepared.execution,
            );
            if (approved.length > 0) {
              approvedText += approved;
              segmentSequence += 1;
              yield {
                type: 'message.segment',
                data: {
                  mode: 'persistent',
                  turnId: turn.id,
                  sequence: segmentSequence,
                  text: approved,
                },
              };
              deliveredSegments += 1;
            }
          }
          pending = iterator.next();
          continue;
        }

        providerMetadata = event.metadata;
        usage = event.usage;
        completedReason = event.finishReason;
      }

      const remainder = useFullBuffer ? fullBufferedText : buffer.flush();
      if (remainder) {
        const approved = await this.approveSegment(
          {
            userId: turn.userId,
            operationId: turn.id,
            target: { kind: 'conversation', conversationId: turn.conversationId },
          },
          remainder,
          approvedText,
          riskDecision,
          generationController.signal,
          prepared.execution,
        );
        if (approved.length > 0) {
          approvedText += approved;
          segmentSequence += 1;
          yield {
            type: 'message.segment',
            data: {
              mode: 'persistent',
              turnId: turn.id,
              sequence: segmentSequence,
              text: approved,
            },
          };
          deliveredSegments += 1;
        }
      }

      if (approvedText.length === 0) {
        throw new LLMProviderFailure('malformed_stream', true, providerMetadata.requestId);
      }
      throwIfAborted(generationController.signal);
      await this.consentExecutions.assertStillUsable(prepared.execution);
      const completed = await this.consentExecutions.runWhileUsable(prepared.execution, () =>
        this.aiTurns.complete(turn, approvedText, new Date()),
      );
      lifecycleSettled = true;
      await this.consentExecutions.assertStillUsable(prepared.execution);
      throwIfAborted(generationController.signal);
      this.logging.turnCompleted(metadata, {
        provider: providerMetadata.provider,
        model: providerMetadata.model,
        providerRequestId: providerMetadata.requestId,
        durationMs: Date.now() - generationStartedAt,
        timeToFirstTokenMs,
        usage,
        finishReason: completedReason,
      });
      yield {
        type: 'turn.completed',
        data: {
          mode: 'persistent',
          turnId: turn.id,
          assistantMessageId: completed.assistantMessageId,
          finishReason: completedReason,
        },
      };
    } catch (error) {
      buffer.clear();
      if (error instanceof AiTurnCompletionResultUnknownError) {
        lifecycleSettled = true;
        this.knowledgeLogging.groundingCompletionResultUnknown(
          turn.id,
          Date.now() - generationStartedAt,
        );
        return;
      }
      if (prepared.deliveryState.groundedCommitSucceeded) {
        throw error;
      }
      if (error instanceof OutputSafetyReplacement) {
        if (!generationController.signal.aborted) {
          generationController.abort(new Error('output_safety_stopped'));
        }
        try {
          await providerIterator?.return?.();
        } catch {
          // Safety replacement remains trusted even if upstream teardown reports an error.
        }
        providerIterator = null;
        let sideEffectError: unknown = null;
        try {
          if (!hasAcceptedApprovedSegment()) {
            await this.quota.refundQuota(turn.userId, turn.id);
          }
          await this.audits.append({
            actorType: 'system',
            actorId: null,
            action: 'safety_output_blocked',
            resourceType: 'ai_turn',
            resourceId: turn.id,
            idempotencyKey: `safety-output-stopped:${turn.id}`,
            safeMetadata: {},
            occurredAt: new Date(),
          });
        } catch (sideEffectFailure) {
          sideEffectError = sideEffectFailure;
        }
        throwIfAborted(prepared.execution.signal);
        throwIfAborted(clientSignal);
        approvedText += error.text;
        segmentSequence += 1;
        yield {
          type: 'message.segment',
          data: {
            mode: 'persistent',
            turnId: turn.id,
            sequence: segmentSequence,
            text: error.text,
          },
        };
        if (sideEffectError) {
          await this.finishAfterSafetyPersistenceFailure(turn);
          throw sideEffectError;
        }
        let completed;
        try {
          throwIfAborted(prepared.execution.signal);
          throwIfAborted(clientSignal);
          await this.consentExecutions.assertStillUsable(prepared.execution);
          completed = await this.consentExecutions.runWhileUsable(prepared.execution, () =>
            this.aiTurns.complete(turn, approvedText, new Date()),
          );
          lifecycleSettled = true;
        } catch (persistenceError) {
          await this.finishAfterSafetyPersistenceFailure(turn);
          throw persistenceError;
        }
        yield {
          type: 'turn.completed',
          data: {
            mode: 'persistent',
            turnId: turn.id,
            assistantMessageId: completed.assistantMessageId,
            finishReason: 'content_filter',
          },
        };
        return;
      }
      const executionTimedOut = this.synchronizeExecutionDeadline(prepared.execution, error);
      const timedOut =
        executionTimedOut ||
        error instanceof ProviderEventTimeout ||
        generationController.signal.reason instanceof ProviderEventTimeout ||
        generationController.signal.reason instanceof AiExecutionTotalTimeoutError ||
        prepared.execution.signal.reason instanceof AiExecutionTotalTimeoutError;
      const cancelled = (clientSignal.aborted || prepared.execution.signal.aborted) && !timedOut;
      const category = timedOut ? 'timeout' : failureCategory(error);

      if (
        riskDecision.status === 'assessed' &&
        riskDecision.level === 'HIGH' &&
        !cancelled &&
        !hasAcceptedApprovedSegment() &&
        !prepared.execution.signal.aborted
      ) {
        const fallback = this.templates.get('high-generation-fallback');
        let fallbackFailure: unknown = null;
        try {
          await this.quota.refundQuota(turn.userId, turn.id);
          await this.audits.append({
            actorType: 'system',
            actorId: null,
            action: 'trusted_safety_response_created',
            resourceType: 'ai_turn',
            resourceId: turn.id,
            idempotencyKey: `high-generation-fallback:${turn.id}`,
            safeMetadata: { templateKey: fallback.key, templateVersion: fallback.version },
            occurredAt: new Date(),
          });
        } catch (sideEffectError) {
          fallbackFailure = sideEffectError;
        }
        throwIfAborted(prepared.execution.signal);
        throwIfAborted(clientSignal);
        yield {
          type: 'message.segment',
          data: {
            mode: 'persistent',
            turnId: turn.id,
            sequence: 1,
            text: fallback.content,
          },
        };
        if (fallbackFailure) {
          await this.finishAfterSafetyPersistenceFailure(turn);
          throw fallbackFailure;
        }
        try {
          throwIfAborted(prepared.execution.signal);
          throwIfAborted(clientSignal);
          await this.consentExecutions.assertStillUsable(prepared.execution);
          const completed = await this.consentExecutions.runWhileUsable(prepared.execution, () =>
            this.aiTurns.complete(turn, fallback.content, new Date()),
          );
          lifecycleSettled = true;
          yield {
            type: 'turn.completed',
            data: {
              mode: 'persistent',
              turnId: turn.id,
              assistantMessageId: completed.assistantMessageId,
              finishReason: 'content_filter',
            },
          };
          return;
        } catch (persistenceError) {
          await this.finishAfterSafetyPersistenceFailure(turn);
          throw persistenceError;
        }
      }

      if (!providerInvoked) {
        await this.aiTurns.settleBeforeProviderFailure(
          turn,
          cancelled ? 'cancelled' : 'failed',
          cancelled
            ? 'CANCELLED_BEFORE_PROVIDER'
            : timedOut
              ? 'TOTAL_TIMEOUT_BEFORE_PROVIDER'
              : category.toUpperCase(),
          new Date(),
        );
      } else {
        const shouldRefund =
          !hasAcceptedApprovedSegment() && completedReason !== 'length' && !cancelled;
        if (shouldRefund) {
          await this.aiTurns.settleBeforeProviderFailure(
            turn,
            'failed',
            category.toUpperCase(),
            new Date(),
          );
        } else {
          await this.aiTurns.finish(
            turn,
            cancelled ? 'cancelled' : 'failed',
            cancelled
              ? clientSignal.aborted
                ? 'CLIENT_CANCELLED'
                : 'EXECUTION_CANCELLED'
              : category.toUpperCase(),
            new Date(),
          );
        }
      }
      lifecycleSettled = true;

      if (cancelled) {
        this.logging.turnCancelled(
          metadata,
          clientSignal.aborted ? 'client_disconnect' : 'user',
          Date.now() - generationStartedAt,
        );
        throw new AIProviderError('AI 对话已取消');
      }
      this.logging.turnFailed(metadata, category, Date.now() - generationStartedAt);
      if (timedOut) {
        throw new AIProviderTimeoutError();
      }
      if (error instanceof AIProviderError) {
        throw error;
      }
      throw new AIProviderError();
    } finally {
      if (!lifecycleSettled && !prepared.deliveryState.groundedCommitSucceeded) {
        try {
          const timedOut = prepared.execution.signal.reason instanceof AiExecutionTotalTimeoutError;
          if (
            !providerInvoked ||
            (timedOut && !hasAcceptedApprovedSegment() && completedReason !== 'length')
          ) {
            const aborted = prepared.execution.signal.aborted || clientSignal.aborted;
            await this.aiTurns.settleBeforeProviderFailure(
              turn,
              timedOut ? 'failed' : 'cancelled',
              providerInvoked
                ? 'TIMEOUT'
                : timedOut
                  ? 'TOTAL_TIMEOUT_BEFORE_PROVIDER'
                  : aborted
                    ? 'CANCELLED_BEFORE_PROVIDER'
                    : 'STREAM_DELIVERY_TERMINATED',
              new Date(),
            );
          } else {
            await this.aiTurns.finish(
              turn,
              timedOut ? 'failed' : 'cancelled',
              timedOut ? 'TIMEOUT' : 'STREAM_DELIVERY_TERMINATED',
              new Date(),
            );
          }
        } catch {
          // The stream is already terminating; idempotent cleanup may be reconciled later.
        }
      }
      prepared.execution.dispose();
      prepared.execution.signal.removeEventListener('abort', onExecutionAbort);
      clientSignal.removeEventListener('abort', onClientAbort);
      if (!generationController.signal.aborted) {
        generationController.abort(new Error('stream_cleanup'));
      }
      await providerIterator?.return?.();
      buffer.clear();
    }
  }

  async *streamPreparedIncognitoTurn(
    prepared: Extract<PreparedIncognitoTurn, { kind: 'ready' }>,
    clientSignal: AbortSignal,
  ): AsyncIterable<IncognitoAiStreamEvent | IncognitoAiStreamEventV2> {
    const { context, generation, input, principal, riskDecision } = prepared;
    const metadata = { userId: principal.userId, turnId: generation.id };
    const generationStartedAt = Date.now();
    const generationController = new AbortController();
    const onRuntimeAbort = (): void =>
      generationController.abort(generation.signal.reason ?? new Error('incognito_ended'));
    const onClientAbort = (): void =>
      generationController.abort(clientSignal.reason ?? new Error('client_disconnect'));
    generation.signal.addEventListener('abort', onRuntimeAbort, { once: true });
    clientSignal.addEventListener('abort', onClientAbort, { once: true });
    if (generation.signal.aborted) onRuntimeAbort();
    if (clientSignal.aborted) onClientAbort();

    const buffer = new SentenceSegmentBuffer(
      env.AI_SEGMENT_MAX_CHARACTERS,
      env.AI_SEGMENT_MAX_WAIT_MS,
    );
    const useFullBuffer = riskDecision.bufferingMode === 'full';
    let fullBufferedText = '';
    let approvedText = '';
    let deliveredSegments = 0;
    let segmentSequence = 0;
    let providerMetadata = EMPTY_METADATA;
    let usage = EMPTY_USAGE;
    let timeToFirstTokenMs: number | null = null;
    let completedReason: LLMFinishReason | null = null;
    let providerInvoked = false;
    let providerIterator: AsyncIterator<LLMProviderStreamEvent> | null = null;
    let receivedOutputCharacters = 0;
    let lifecycleSettled = false;
    const hasAcceptedApprovedSegment = (): boolean =>
      deliveredSegments > 0 || prepared.deliveryState.approvedSegmentWriteAccepted;

    try {
      yield {
        type: 'turn.started',
        data: { mode: 'incognito', generationId: generation.id },
      };
      throwIfAborted(generation.signal);
      if (prepared.knowledgeGrounding) {
        const groundedState: GroundedProviderCollectionState = {
          providerInvoked: false,
          providerIterator: null,
          providerMetadata: EMPTY_METADATA,
          usage: EMPTY_USAGE,
          timeToFirstTokenMs: null,
          finishReason: null,
        };
        let rawResponse: string;
        try {
          rawResponse = await this.collectGroundedProviderResponse(
            {
              requestId: generation.id,
              context,
              execution: prepared.execution,
              signal: generationController.signal,
              generationStartedAt,
              logMetadata: metadata,
            },
            groundedState,
          );
        } finally {
          providerInvoked = groundedState.providerInvoked;
          providerIterator = groundedState.providerIterator;
          providerMetadata = groundedState.providerMetadata;
          usage = groundedState.usage;
          timeToFirstTokenMs = groundedState.timeToFirstTokenMs;
          completedReason = groundedState.finishReason;
        }
        if (completedReason === null) {
          throw new LLMProviderFailure('malformed_stream', true, providerMetadata.requestId);
        }
        const groundedFinishReason = completedReason;

        const grounded = this.parseGroundedResponse(
          rawResponse,
          prepared.knowledgeGrounding.bundles,
          context,
          providerMetadata,
        );
        const approved = await this.approveSegment(
          {
            userId: principal.userId,
            operationId: generation.id,
            target: {
              kind: 'incognito',
              contextId: input.contextId,
              sessionId: principal.sessionId,
            },
          },
          grounded.answer,
          '',
          riskDecision,
          generationController.signal,
          prepared.execution,
        );
        if (approved.length === 0) {
          throw new LLMProviderFailure('malformed_stream', true, providerMetadata.requestId);
        }

        approvedText = approved;
        throwIfAborted(generation.signal);
        await this.consentExecutions.assertStillUsable(prepared.execution);
        const appended = await this.consentExecutions.runWhileUsable(
          prepared.execution,
          async () => {
            const result = this.incognitoContexts.append(
              principal.userId,
              principal.sessionId,
              input.contextId,
              generation.id,
              { role: 'assistant', content: approved },
              new Date(),
            );
            if (result) {
              prepared.deliveryState.groundedCommitSucceeded = true;
              lifecycleSettled = true;
            }
            return result;
          },
        );
        if (!appended) throw new AIIncognitoContextLostError();

        this.logging.turnCompleted(metadata, {
          provider: providerMetadata.provider,
          model: providerMetadata.model,
          providerRequestId: providerMetadata.requestId,
          durationMs: Date.now() - generationStartedAt,
          timeToFirstTokenMs,
          usage,
          finishReason: groundedFinishReason,
        });
        segmentSequence = 1;
        yield {
          type: 'message.segment',
          data: {
            mode: 'incognito',
            generationId: generation.id,
            sequence: segmentSequence,
            text: approved,
            deliveryMode: grounded.delivery.deliveryMode,
          },
        } satisfies IncognitoAiStreamEventV2;
        deliveredSegments = 1;
        yield {
          type: 'turn.completed',
          data: {
            mode: 'incognito',
            generationId: generation.id,
            finishReason: groundedFinishReason,
            ...grounded.delivery,
          },
        } satisfies IncognitoAiStreamEventV2;
        return;
      }

      const stream = this.provider.streamChat(
        {
          requestId: generation.id,
          messages: context.messages,
          maxOutputTokens: env.LLM_MAX_OUTPUT_TOKENS,
        },
        {
          signal: generationController.signal,
          startTransport: async (startTransport) =>
            this.consentExecutions.starter(
              prepared.execution,
              'generation',
              generationController.signal,
            )((signal) => {
              providerInvoked = true;
              return startTransport(signal);
            }),
        },
      );
      const iterator = stream[Symbol.asyncIterator]();
      providerIterator = iterator;
      let pending = iterator.next();
      let providerDeadline = Date.now() + env.LLM_FIRST_TOKEN_TIMEOUT_MS;
      let hasTextDelta = false;

      while (completedReason === null) {
        const wait = useFullBuffer ? null : buffer.millisecondsUntilFlush();
        const outcome = await waitForProviderOrFlush(
          pending,
          providerDeadline - Date.now(),
          wait,
          generationController.signal,
          hasTextDelta ? 'idle' : 'first_token',
        );

        if (outcome.type === 'segment_flush') {
          const due = buffer.flushIfDue();
          if (due) {
            const approved = await this.approveSegment(
              {
                userId: principal.userId,
                operationId: generation.id,
                target: {
                  kind: 'incognito',
                  contextId: input.contextId,
                  sessionId: principal.sessionId,
                },
              },
              due,
              approvedText,
              riskDecision,
              generationController.signal,
              prepared.execution,
            );
            throwIfAborted(generation.signal);
            if (approved.length > 0) {
              approvedText += approved;
              segmentSequence += 1;
              yield {
                type: 'message.segment',
                data: {
                  mode: 'incognito',
                  generationId: generation.id,
                  sequence: segmentSequence,
                  text: approved,
                },
              };
              deliveredSegments += 1;
            }
          }
          continue;
        }

        if (outcome.item.done) {
          throw new LLMProviderFailure('malformed_stream', true, providerMetadata.requestId);
        }
        const event = outcome.item.value;
        providerDeadline = hasTextDelta
          ? Date.now() + env.LLM_STREAM_IDLE_TIMEOUT_MS
          : generationStartedAt + env.LLM_FIRST_TOKEN_TIMEOUT_MS;

        if (event.type === 'started') {
          providerMetadata = event.metadata;
          this.logging.turnStarted(metadata, event.metadata.provider, event.metadata.model);
          pending = iterator.next();
          continue;
        }
        if (event.type === 'usage') {
          usage = event.usage;
          pending = iterator.next();
          continue;
        }
        if (event.type === 'text_delta') {
          if (!hasTextDelta) {
            hasTextDelta = true;
            timeToFirstTokenMs = Date.now() - generationStartedAt;
            this.logging.firstSegment(metadata, timeToFirstTokenMs);
          }
          providerDeadline = Date.now() + env.LLM_STREAM_IDLE_TIMEOUT_MS;
          receivedOutputCharacters += Array.from(event.text).length;
          if (
            receivedOutputCharacters >
            env.LLM_MAX_OUTPUT_TOKENS * MAX_OUTPUT_CHARACTERS_PER_REQUESTED_TOKEN
          ) {
            throw new LLMProviderFailure('malformed_stream', true, providerMetadata.requestId);
          }
          if (useFullBuffer) {
            fullBufferedText += event.text;
            pending = iterator.next();
            continue;
          }
          for (const candidate of buffer.append(event.text)) {
            const approved = await this.approveSegment(
              {
                userId: principal.userId,
                operationId: generation.id,
                target: {
                  kind: 'incognito',
                  contextId: input.contextId,
                  sessionId: principal.sessionId,
                },
              },
              candidate,
              approvedText,
              riskDecision,
              generationController.signal,
              prepared.execution,
            );
            throwIfAborted(generation.signal);
            if (approved.length > 0) {
              approvedText += approved;
              segmentSequence += 1;
              yield {
                type: 'message.segment',
                data: {
                  mode: 'incognito',
                  generationId: generation.id,
                  sequence: segmentSequence,
                  text: approved,
                },
              };
              deliveredSegments += 1;
            }
          }
          pending = iterator.next();
          continue;
        }

        providerMetadata = event.metadata;
        usage = event.usage;
        completedReason = event.finishReason;
      }

      const remainder = useFullBuffer ? fullBufferedText : buffer.flush();
      if (remainder) {
        const approved = await this.approveSegment(
          {
            userId: principal.userId,
            operationId: generation.id,
            target: {
              kind: 'incognito',
              contextId: input.contextId,
              sessionId: principal.sessionId,
            },
          },
          remainder,
          approvedText,
          riskDecision,
          generationController.signal,
          prepared.execution,
        );
        throwIfAborted(generation.signal);
        if (approved.length > 0) {
          approvedText += approved;
          segmentSequence += 1;
          yield {
            type: 'message.segment',
            data: {
              mode: 'incognito',
              generationId: generation.id,
              sequence: segmentSequence,
              text: approved,
            },
          };
          deliveredSegments += 1;
        }
      }

      if (approvedText.length === 0) {
        throw new LLMProviderFailure('malformed_stream', true, providerMetadata.requestId);
      }
      throwIfAborted(generation.signal);
      await this.consentExecutions.assertStillUsable(prepared.execution);
      const appended = this.incognitoContexts.append(
        principal.userId,
        principal.sessionId,
        input.contextId,
        generation.id,
        { role: 'assistant', content: approvedText },
        new Date(),
      );
      if (!appended) throw new AIIncognitoContextLostError();
      lifecycleSettled = true;
      await this.consentExecutions.assertStillUsable(prepared.execution);
      this.logging.turnCompleted(metadata, {
        provider: providerMetadata.provider,
        model: providerMetadata.model,
        providerRequestId: providerMetadata.requestId,
        durationMs: Date.now() - generationStartedAt,
        timeToFirstTokenMs,
        usage,
        finishReason: completedReason,
      });
      yield {
        type: 'turn.completed',
        data: {
          mode: 'incognito',
          generationId: generation.id,
          finishReason: completedReason,
        },
      };
    } catch (error) {
      buffer.clear();
      if (prepared.deliveryState.groundedCommitSucceeded) {
        throw error;
      }
      if (error instanceof OutputSafetyReplacement) {
        if (!generationController.signal.aborted) {
          generationController.abort(new Error('output_safety_stopped'));
        }
        try {
          await providerIterator?.return?.();
        } catch {
          // The trusted replacement is independent of upstream teardown.
        }
        providerIterator = null;
        let sideEffectError: unknown = null;
        try {
          if (!hasAcceptedApprovedSegment()) {
            await this.quota.refundQuota(principal.userId, prepared.quotaIdempotencyKey);
          }
          await this.audits.append({
            actorType: 'system',
            actorId: null,
            action: 'safety_output_blocked',
            resourceType: 'ai_generation',
            resourceId: generation.id,
            idempotencyKey: `safety-output-stopped:${generation.id}`,
            safeMetadata: {},
            occurredAt: new Date(),
          });
        } catch (sideEffectFailure) {
          sideEffectError = sideEffectFailure;
        }
        throwIfAborted(generation.signal);
        approvedText += error.text;
        segmentSequence += 1;
        yield {
          type: 'message.segment',
          data: {
            mode: 'incognito',
            generationId: generation.id,
            sequence: segmentSequence,
            text: error.text,
          },
        };
        if (sideEffectError) throw sideEffectError;
        await this.consentExecutions.assertStillUsable(prepared.execution);
        const appended = this.incognitoContexts.append(
          principal.userId,
          principal.sessionId,
          input.contextId,
          generation.id,
          { role: 'assistant', content: approvedText },
          new Date(),
        );
        if (!appended) throw new AIIncognitoContextLostError();
        lifecycleSettled = true;
        await this.consentExecutions.assertStillUsable(prepared.execution);
        yield {
          type: 'turn.completed',
          data: {
            mode: 'incognito',
            generationId: generation.id,
            finishReason: 'content_filter',
          },
        };
        return;
      }

      const generationEndedFirst =
        generation.signal.reason instanceof IncognitoContextTerminatedError;
      const executionTimedOut = generationEndedFirst
        ? false
        : this.synchronizeExecutionDeadline(prepared.execution, error);
      const timedOut =
        !generationEndedFirst &&
        (executionTimedOut ||
          error instanceof ProviderEventTimeout ||
          generationController.signal.reason instanceof ProviderEventTimeout ||
          prepared.execution.signal.reason instanceof AiExecutionTotalTimeoutError);
      const cancelled = (clientSignal.aborted || generation.signal.aborted) && !timedOut;
      const category = timedOut ? 'timeout' : failureCategory(error);

      if (
        riskDecision.status === 'assessed' &&
        riskDecision.level === 'HIGH' &&
        !cancelled &&
        !hasAcceptedApprovedSegment() &&
        !generation.signal.aborted
      ) {
        const fallback = this.templates.get('high-generation-fallback');
        let fallbackFailure: unknown = null;
        try {
          await this.quota.refundQuota(principal.userId, prepared.quotaIdempotencyKey);
          await this.audits.append({
            actorType: 'system',
            actorId: null,
            action: 'trusted_safety_response_created',
            resourceType: 'ai_generation',
            resourceId: generation.id,
            idempotencyKey: `high-generation-fallback:${generation.id}`,
            safeMetadata: { templateKey: fallback.key, templateVersion: fallback.version },
            occurredAt: new Date(),
          });
        } catch (sideEffectError) {
          fallbackFailure = sideEffectError;
        }
        throwIfAborted(generation.signal);
        yield {
          type: 'message.segment',
          data: {
            mode: 'incognito',
            generationId: generation.id,
            sequence: 1,
            text: fallback.content,
          },
        };
        if (fallbackFailure) throw fallbackFailure;
        await this.consentExecutions.assertStillUsable(prepared.execution);
        const appended = this.incognitoContexts.append(
          principal.userId,
          principal.sessionId,
          input.contextId,
          generation.id,
          { role: 'assistant', content: fallback.content },
          new Date(),
        );
        if (!appended) throw new AIIncognitoContextLostError();
        lifecycleSettled = true;
        await this.consentExecutions.assertStillUsable(prepared.execution);
        yield {
          type: 'turn.completed',
          data: {
            mode: 'incognito',
            generationId: generation.id,
            finishReason: 'content_filter',
          },
        };
        return;
      }

      const shouldRefund =
        !hasAcceptedApprovedSegment() &&
        completedReason !== 'length' &&
        (!cancelled || !providerInvoked);
      if (shouldRefund) {
        await this.quota.refundQuota(principal.userId, prepared.quotaIdempotencyKey);
      }
      if (cancelled) {
        this.logging.turnCancelled(metadata, 'client_disconnect', Date.now() - generationStartedAt);
        if (generationEndedFirst) throw new AIIncognitoContextLostError();
        throw new AIProviderError('AI 对话已取消');
      }
      this.logging.turnFailed(metadata, category, Date.now() - generationStartedAt);
      if (timedOut) throw new AIProviderTimeoutError();
      if (error instanceof AIProviderError) throw error;
      throw new AIProviderError();
    } finally {
      const timedOut =
        !(generation.signal.reason instanceof IncognitoContextTerminatedError) &&
        prepared.execution.signal.reason instanceof AiExecutionTotalTimeoutError;
      const shouldRefundOnTermination =
        (!lifecycleSettled &&
          !prepared.deliveryState.groundedCommitSucceeded &&
          !providerInvoked) ||
        (timedOut && !hasAcceptedApprovedSegment() && completedReason !== 'length');
      if (shouldRefundOnTermination) {
        try {
          await this.quota.refundQuota(principal.userId, prepared.quotaIdempotencyKey);
        } catch {
          // The stream is already terminating; the idempotent refund can be reconciled later.
        }
      }
      this.releaseIncognitoGeneration(principal, input.contextId, generation.id);
      prepared.execution.dispose();
      generation.signal.removeEventListener('abort', onRuntimeAbort);
      clientSignal.removeEventListener('abort', onClientAbort);
      if (!generationController.signal.aborted) {
        generationController.abort(new Error('stream_cleanup'));
      }
      await providerIterator?.return?.();
      buffer.clear();
    }
  }

  releasePreparedIncognitoTurn(prepared: PreparedIncognitoTurn): void {
    this.releaseIncognitoGeneration(
      prepared.principal,
      prepared.input.contextId,
      prepared.generation.id,
    );
    prepared.execution.dispose();
  }

  retireGroundedIncognitoDelivery(
    prepared: Extract<PreparedIncognitoTurn, { kind: 'ready' }>,
  ): void {
    this.incognitoContexts.end(
      prepared.principal.userId,
      prepared.principal.sessionId,
      prepared.input.contextId,
    );
  }

  async cancelPreparedIncognitoTurnBeforeProvider(prepared: PreparedIncognitoTurn): Promise<void> {
    try {
      if (prepared.kind === 'ready') {
        await this.quota.refundQuota(prepared.principal.userId, prepared.quotaIdempotencyKey);
      }
    } finally {
      this.releasePreparedIncognitoTurn(prepared);
    }
  }

  async cancelPreparedPersistentTurnBeforeProvider(prepared: PreparedAiTurn): Promise<void> {
    try {
      if (prepared.kind === 'ready') {
        const timedOut = prepared.execution.signal.reason instanceof AiExecutionTotalTimeoutError;
        await this.aiTurns.settleBeforeProviderFailure(
          prepared.turn,
          timedOut ? 'failed' : 'cancelled',
          timedOut ? 'TOTAL_TIMEOUT_BEFORE_PROVIDER' : 'CANCELLED_BEFORE_PROVIDER',
          new Date(),
        );
      }
    } finally {
      if (prepared.kind !== 'existing') prepared.execution.dispose();
    }
  }

  enforcePreparedExecutionDeadline(
    prepared: Exclude<PreparedAiTurn, { kind: 'existing' }> | PreparedIncognitoTurn,
  ): void {
    this.synchronizeExecutionDeadline(prepared.execution);
  }

  preProviderTerminationError(
    prepared: Exclude<PreparedAiTurn, { kind: 'existing' }> | PreparedIncognitoTurn,
  ): AIProviderError | AIProviderTimeoutError | AIIncognitoContextLostError | ConsentRequiredError {
    const executionReason = prepared.execution.signal.reason;
    if (
      'generation' in prepared &&
      prepared.generation.signal.reason instanceof IncognitoContextTerminatedError
    ) {
      return new AIIncognitoContextLostError();
    }
    if (executionReason instanceof AiExecutionTotalTimeoutError) {
      return new AIProviderTimeoutError();
    }
    if (
      executionReason instanceof ConsentRequiredError ||
      (executionReason instanceof Error && executionReason.message === 'consent_withdrawn')
    ) {
      return new ConsentRequiredError();
    }
    if ('generation' in prepared && prepared.generation.signal.aborted) {
      return new AIIncognitoContextLostError();
    }
    return new AIProviderError('AI 对话已取消');
  }

  private synchronizeExecutionDeadline(
    execution: Pick<ActiveAiExecution, 'signal' | 'deadlineAt' | 'abort'>,
    error?: unknown,
  ): boolean {
    if (
      !execution.signal.aborted &&
      (error instanceof AiExecutionTotalTimeoutError ||
        execution.deadlineAt.getTime() <= Date.now())
    ) {
      execution.abort(
        error instanceof AiExecutionTotalTimeoutError ? error : new AiExecutionTotalTimeoutError(),
      );
    }
    return (
      error instanceof AiExecutionTotalTimeoutError ||
      execution.signal.reason instanceof AiExecutionTotalTimeoutError
    );
  }

  private isConsentTermination(
    execution: Pick<ActiveAiExecution, 'signal'>,
    error?: unknown,
  ): boolean {
    const isWithdrawal = (value: unknown): boolean =>
      value instanceof ConsentRequiredError ||
      (value instanceof Error && value.message === 'consent_withdrawn');
    return isWithdrawal(error) || isWithdrawal(execution.signal.reason);
  }

  private releaseIncognitoGeneration(
    principal: AuthenticatedAiPrincipal,
    contextId: string,
    generationId: string,
  ): void {
    this.incognitoContexts.releaseGeneration(
      principal.userId,
      principal.sessionId,
      contextId,
      generationId,
    );
  }

  private async finishAfterSafetyPersistenceFailure(turn: AiTurnRecord): Promise<void> {
    try {
      await this.aiTurns.finish(turn, 'failed', 'SAFETY_RESPONSE_PERSISTENCE_FAILED', new Date());
    } catch {
      // The public stream still fails closed even if the database remains unavailable.
    }
  }

  private async approveSegment(
    operation: Readonly<{
      userId: string;
      operationId: string;
      target: import('../safety/safety.types').SafetyTarget;
    }>,
    candidateSegment: string,
    previouslyApprovedText: string,
    riskDecision: RiskDecision,
    signal: AbortSignal,
    execution: ConsentBoundExecution,
  ): Promise<string> {
    const result = await this.postGenerationSafety.approve(
      {
        userId: operation.userId,
        turnId: operation.operationId,
        target: operation.target,
        candidateSegment,
        previouslyApprovedText,
        riskDecision,
      },
      signal,
      execution,
    );
    await this.consentExecutions.assertStillUsable(execution);
    throwIfAborted(signal);
    if (result.status === 'replacement') {
      throw new OutputSafetyReplacement(result.text, result.cause);
    }
    return result.text;
  }

  private parseGroundedResponse(
    rawResponse: string,
    offeredBundles: readonly KnowledgePromptBundle[],
    context: ConversationContext,
    providerMetadata: LLMProviderMetadata,
  ): Readonly<{
    answer: string;
    bundles: readonly KnowledgePromptBundle[];
    delivery:
      | { deliveryMode: 'immediate'; knowledgeReferences: [] }
      | {
          deliveryMode: 'commit_with_references';
          knowledgeReferences: [KnowledgeReference, ...KnowledgeReference[]];
        };
  }> {
    try {
      const envelope = parseGroundedProviderEnvelope(
        rawResponse,
        offeredBundles.map((bundle) => bundle.referenceId),
      );
      if (envelope.status === 'insufficient_evidence') {
        return {
          answer: INSUFFICIENT_KNOWLEDGE_MESSAGE,
          bundles: [],
          delivery: { deliveryMode: 'immediate', knowledgeReferences: [] },
        };
      }
      const used = new Set(envelope.usedReferenceIds);
      const bundles = offeredBundles.filter((bundle) => used.has(bundle.referenceId));
      if (bundles.length !== used.size) {
        throw new GroundedResponseContractError('invalid_reference');
      }
      const references = bundles.map((bundle) =>
        knowledgeReferenceSchema.parse({
          articleKey: bundle.articleKey,
          title: bundle.title,
          version: bundle.version,
          contentOrigin: bundle.contentOrigin,
          reviewStatus: bundle.reviewStatus,
          reviewedAt: bundle.reviewedAt,
          availability: 'currently_published',
          sources: [...bundle.sources]
            .sort((left, right) => left.ordinal - right.ordinal)
            .map((source) => ({
              ordinal: source.ordinal,
              publisherName: source.publisherName,
              sourceTitle: source.sourceTitle,
              sourcePublishedAt: source.sourcePublishedAt,
              sourceVersionLabel: source.sourceVersionLabel,
              sourceLocator: source.sourceLocator,
              retrievedAt: source.retrievedAt,
              linkState: 'available' as const,
              sourceUrl: source.sourceUrl,
            })),
        }),
      );
      const firstReference = references[0];
      if (!firstReference) {
        throw new GroundedResponseContractError('invalid_reference');
      }
      return {
        answer: envelope.answer,
        bundles,
        delivery: {
          deliveryMode: 'commit_with_references',
          knowledgeReferences: [firstReference, ...references.slice(1)],
        },
      };
    } catch (error) {
      const reason =
        error instanceof GroundedResponseContractError ? error.reason : 'invalid_reference';
      this.knowledgeLogging.groundingRejected(reason, context.promptKey, context.promptVersion);
      throw new LLMProviderFailure('malformed_stream', true, providerMetadata.requestId);
    }
  }

  private async collectGroundedProviderResponse(
    input: Readonly<{
      requestId: string;
      context: ConversationContext;
      execution: ConsentBoundExecution;
      signal: AbortSignal;
      generationStartedAt: number;
      logMetadata: Readonly<{ userId: string; conversationId?: string; turnId: string }>;
    }>,
    state: GroundedProviderCollectionState,
  ): Promise<string> {
    const stream = this.provider.streamChat(
      {
        requestId: input.requestId,
        messages: input.context.messages,
        maxOutputTokens: env.LLM_MAX_OUTPUT_TOKENS,
        temperature: 0,
        responseFormat: 'json',
      },
      {
        signal: input.signal,
        startTransport: async (startTransport) =>
          this.consentExecutions.starter(
            input.execution,
            'generation',
            input.signal,
          )((signal) => {
            state.providerInvoked = true;
            return startTransport(signal);
          }),
      },
    );
    const iterator = stream[Symbol.asyncIterator]();
    state.providerIterator = iterator;
    let pending = iterator.next();
    let providerDeadline = Date.now() + env.LLM_FIRST_TOKEN_TIMEOUT_MS;
    let hasTextDelta = false;
    let rawResponse = '';
    let receivedOutputCharacters = 0;

    while (state.finishReason === null) {
      const outcome = await waitForProviderOrFlush(
        pending,
        providerDeadline - Date.now(),
        null,
        input.signal,
        hasTextDelta ? 'idle' : 'first_token',
      );
      if (outcome.type !== 'provider' || outcome.item.done) {
        throw new LLMProviderFailure('malformed_stream', true, state.providerMetadata.requestId);
      }
      const event = outcome.item.value;
      if (event.type === 'started') {
        state.providerMetadata = event.metadata;
        this.logging.turnStarted(input.logMetadata, event.metadata.provider, event.metadata.model);
        pending = iterator.next();
        continue;
      }
      if (event.type === 'usage') {
        state.usage = event.usage;
        pending = iterator.next();
        continue;
      }
      if (event.type === 'text_delta') {
        if (!hasTextDelta) {
          hasTextDelta = true;
          state.timeToFirstTokenMs = Date.now() - input.generationStartedAt;
          this.logging.firstSegment(input.logMetadata, state.timeToFirstTokenMs);
        }
        providerDeadline = Date.now() + env.LLM_STREAM_IDLE_TIMEOUT_MS;
        receivedOutputCharacters += Array.from(event.text).length;
        if (
          receivedOutputCharacters >
          env.LLM_MAX_OUTPUT_TOKENS * MAX_OUTPUT_CHARACTERS_PER_REQUESTED_TOKEN
        ) {
          throw new LLMProviderFailure('malformed_stream', true, state.providerMetadata.requestId);
        }
        rawResponse += event.text;
        pending = iterator.next();
        continue;
      }

      state.providerMetadata = event.metadata;
      state.usage = event.usage;
      state.finishReason = event.finishReason;
    }

    if (!hasTextDelta || rawResponse.length === 0) {
      throw new LLMProviderFailure('malformed_stream', true, state.providerMetadata.requestId);
    }
    return rawResponse;
  }

  private safeFailureCode(error: unknown): string {
    if (error instanceof QuotaExceededError) {
      return 'QUOTA_EXCEEDED';
    }
    if (error instanceof AITurnInProgressError) {
      return 'AI_TURN_IN_PROGRESS';
    }
    return 'PREPARATION_FAILED';
  }

  private assertPersistentConversationBinding(
    turn: AiTurnRecord,
    conversationId: string | undefined,
  ): void {
    if (conversationId !== undefined && turn.conversationId !== conversationId) {
      throw new ConflictError('客户端请求与原对话不一致');
    }
  }
}
