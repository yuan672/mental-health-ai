import { Inject, Injectable } from '@nestjs/common';
import type { AiStreamEvent } from '@mental-health/types';
import {
  AIChatDisabledError,
  AIProviderError,
  AIProviderTimeoutError,
  AITurnInProgressError,
  InternalServerError,
  QuotaExceededError,
} from '../common/errors';
import { env } from '../config/env';
import { ConsentsService } from '../consents/consents.service';
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
import { AiTurnService } from './turns/ai-turn.service';
import type { AiTurnRecord } from './turns/ai-turn.repository';
import type { AiChatRequest } from './ai.schemas';
import { PromptService } from './prompts/prompt.service';
import {
  CrisisFlowService,
  type TrustedSafetyResponse,
} from '../safety/crisis/crisis-flow.service';
import { AuditLogService } from '../safety/audit/audit-log.service';
import { SafetyOperationalLoggingService } from '../safety/logging/safety-operational-logging.service';
import type { RiskDecision } from '../safety/safety.types';
import { TrustedSafetyTemplateRegistry } from '../safety/templates/trusted-safety-template.registry';

export type AuthenticatedAiPrincipal = Readonly<{
  userId: string;
  sessionId: string;
}>;

export type PreparedAiTurn =
  | Readonly<{ kind: 'existing'; turn: AiTurnRecord }>
  | Readonly<{
      kind: 'ready';
      turn: AiTurnRecord;
      context: ConversationContext;
      riskDecision: RiskDecision;
    }>
  | Readonly<{
      kind: 'trusted';
      turn: AiTurnRecord & { assistantMessageId: string };
      response: TrustedSafetyResponse;
    }>
  | Readonly<{
      kind: 'unpersisted_trusted';
      turn: AiTurnRecord;
      response: TrustedSafetyResponse;
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

class ProviderEventTimeout extends Error {
  constructor(public readonly phase: ProviderTimeoutPhase) {
    super(`Provider stream timed out: ${phase}`);
    this.name = ProviderEventTimeout.name;
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

@Injectable()
export class AiOrchestrationService {
  constructor(
    private readonly aiTurns: AiTurnService,
    private readonly audits: AuditLogService,
    private readonly consents: ConsentsService,
    private readonly contextService: ConversationContextService,
    private readonly conversations: ConversationService,
    private readonly crisisFlow: CrisisFlowService,
    private readonly logging: AiOperationalLoggingService,
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

  async preparePersistentTurn(
    principal: AuthenticatedAiPrincipal,
    input: AiChatRequest,
    signal: AbortSignal,
    now = new Date(),
  ): Promise<PreparedAiTurn> {
    if (!env.AI_CHAT_ENABLED) {
      throw new AIChatDisabledError();
    }
    await this.consents.ensureRequiredConsentsActive(principal.userId);

    const existing = await this.aiTurns.findByClientRequestId(
      principal.userId,
      input.clientRequestId,
    );
    if (existing) {
      await this.conversations.get(principal.userId, existing.conversationId, now);
      return { kind: 'existing', turn: existing };
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
      return { kind: 'existing', turn: claimed.turn };
    }

    try {
      const quotaAvailable = await this.quota.canUseAI(principal.userId, now);
      if (signal.aborted) {
        throw signal.reason;
      }
      const riskDecision = await this.preGenerationSafety.check(
        {
          turnId: claimed.turn.id,
          userId: principal.userId,
          target: { kind: 'conversation', conversationId: conversation.id },
          message: input.message,
          now,
        },
        signal,
      );

      const trustedResponse = this.trustedResponseFor(riskDecision, quotaAvailable);
      if (trustedResponse) {
        try {
          const completed = await this.aiTurns.completeTrusted(
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
          );
          return { kind: 'trusted', turn: completed, response: trustedResponse };
        } catch {
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
          return { kind: 'unpersisted_trusted', turn: claimed.turn, response: trustedResponse };
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

      const prompt = this.generationPromptFor(riskDecision);
      const context = await this.contextService.buildPersistentContext(
        principal.userId,
        conversation.id,
        input.message,
        now,
        prompt.key as 'supportive-chat' | 'supportive-chat-safety' | 'high-risk-support',
      );
      if (signal.aborted) {
        throw signal.reason;
      }
      const started = await this.aiTurns.start(
        claimed.turn,
        input.message,
        prompt,
        riskDecision,
        now,
      );
      return { kind: 'ready', turn: started, context, riskDecision };
    } catch (error) {
      const cancelled = signal.aborted;
      await this.aiTurns.finish(
        claimed.turn,
        cancelled ? 'cancelled' : 'failed',
        cancelled ? 'CANCELLED_BEFORE_PROVIDER' : this.safeFailureCode(error),
        new Date(),
      );
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

  async *streamPreparedTurn(
    prepared: Extract<PreparedAiTurn, { kind: 'ready' }>,
    clientSignal: AbortSignal,
  ): AsyncIterable<AiStreamEvent> {
    const { turn, context, riskDecision } = prepared;
    const metadata = { userId: turn.userId, conversationId: turn.conversationId, turnId: turn.id };
    const generationStartedAt = Date.now();
    const generationController = new AbortController();
    const onClientAbort = (): void =>
      generationController.abort(clientSignal.reason ?? new Error('client_disconnect'));
    clientSignal.addEventListener('abort', onClientAbort, { once: true });
    if (clientSignal.aborted) {
      onClientAbort();
    }
    const totalTimer = setTimeout(
      () => generationController.abort(new ProviderEventTimeout('total')),
      env.LLM_TOTAL_TIMEOUT_MS,
    );
    totalTimer.unref();

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

    yield {
      type: 'turn.started',
      data: { turnId: turn.id, conversationId: turn.conversationId },
    };

    try {
      if (generationController.signal.aborted) {
        throw generationController.signal.reason;
      }
      const stream = this.provider.streamChat(
        {
          requestId: turn.id,
          messages: context.messages,
          maxOutputTokens: env.LLM_MAX_OUTPUT_TOKENS,
        },
        { signal: generationController.signal },
      );
      const iterator = stream[Symbol.asyncIterator]();
      providerIterator = iterator;
      providerInvoked = true;
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
              turn,
              due,
              approvedText,
              riskDecision,
              generationController.signal,
            );
            if (approved.length > 0) {
              approvedText += approved;
              deliveredSegments += 1;
              segmentSequence += 1;
              yield {
                type: 'message.segment',
                data: { turnId: turn.id, sequence: segmentSequence, text: approved },
              };
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
          if (useFullBuffer) {
            fullBufferedText += event.text;
            pending = iterator.next();
            continue;
          }
          for (const candidate of buffer.append(event.text)) {
            const approved = await this.approveSegment(
              turn,
              candidate,
              approvedText,
              riskDecision,
              generationController.signal,
            );
            if (approved.length > 0) {
              approvedText += approved;
              deliveredSegments += 1;
              segmentSequence += 1;
              yield {
                type: 'message.segment',
                data: { turnId: turn.id, sequence: segmentSequence, text: approved },
              };
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
          turn,
          remainder,
          approvedText,
          riskDecision,
          generationController.signal,
        );
        if (approved.length > 0) {
          approvedText += approved;
          deliveredSegments += 1;
          segmentSequence += 1;
          yield {
            type: 'message.segment',
            data: { turnId: turn.id, sequence: segmentSequence, text: approved },
          };
        }
      }

      if (approvedText.length === 0) {
        throw new LLMProviderFailure('malformed_stream', true, providerMetadata.requestId);
      }
      const completed = await this.aiTurns.complete(turn, approvedText, new Date());
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
          turnId: turn.id,
          assistantMessageId: completed.assistantMessageId,
          finishReason: completedReason,
        },
      };
    } catch (error) {
      buffer.clear();
      if (error instanceof OutputSafetyReplacement) {
        if (!generationController.signal.aborted) {
          generationController.abort(new Error('output_safety_stopped'));
        }
        let sideEffectError: unknown = null;
        try {
          if (deliveredSegments === 0) {
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
        approvedText += error.text;
        segmentSequence += 1;
        yield {
          type: 'message.segment',
          data: { turnId: turn.id, sequence: segmentSequence, text: error.text },
        };
        if (sideEffectError) {
          await this.finishAfterSafetyPersistenceFailure(turn);
          throw sideEffectError;
        }
        let completed;
        try {
          completed = await this.aiTurns.complete(turn, approvedText, new Date());
        } catch (persistenceError) {
          await this.finishAfterSafetyPersistenceFailure(turn);
          throw persistenceError;
        }
        yield {
          type: 'turn.completed',
          data: {
            turnId: turn.id,
            assistantMessageId: completed.assistantMessageId,
            finishReason: 'content_filter',
          },
        };
        return;
      }
      const timedOut =
        error instanceof ProviderEventTimeout ||
        generationController.signal.reason instanceof ProviderEventTimeout;
      const clientCancelled = clientSignal.aborted && !timedOut;
      const category = timedOut ? 'timeout' : failureCategory(error);

      if (
        riskDecision.status === 'assessed' &&
        riskDecision.level === 'HIGH' &&
        !clientCancelled &&
        deliveredSegments === 0
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
        yield {
          type: 'message.segment',
          data: { turnId: turn.id, sequence: 1, text: fallback.content },
        };
        if (fallbackFailure) {
          await this.finishAfterSafetyPersistenceFailure(turn);
          throw fallbackFailure;
        }
        try {
          const completed = await this.aiTurns.complete(turn, fallback.content, new Date());
          yield {
            type: 'turn.completed',
            data: {
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

      const shouldRefund = deliveredSegments === 0 && (!clientCancelled || !providerInvoked);
      if (shouldRefund) {
        await this.quota.refundQuota(turn.userId, turn.id);
      }
      await this.aiTurns.finish(
        turn,
        clientCancelled ? 'cancelled' : 'failed',
        clientCancelled ? 'CLIENT_CANCELLED' : category.toUpperCase(),
        new Date(),
      );

      if (clientCancelled) {
        this.logging.turnCancelled(metadata, 'client_disconnect', Date.now() - generationStartedAt);
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
      clearTimeout(totalTimer);
      clientSignal.removeEventListener('abort', onClientAbort);
      if (!generationController.signal.aborted) {
        generationController.abort(new Error('stream_cleanup'));
      }
      await providerIterator?.return?.();
      buffer.clear();
    }
  }

  private async finishAfterSafetyPersistenceFailure(turn: AiTurnRecord): Promise<void> {
    try {
      await this.aiTurns.finish(turn, 'failed', 'SAFETY_RESPONSE_PERSISTENCE_FAILED', new Date());
    } catch {
      // The public stream still fails closed even if the database remains unavailable.
    }
  }

  private async approveSegment(
    turn: AiTurnRecord,
    candidateSegment: string,
    previouslyApprovedText: string,
    riskDecision: RiskDecision,
    signal: AbortSignal,
  ): Promise<string> {
    const result = await this.postGenerationSafety.approve(
      {
        userId: turn.userId,
        turnId: turn.id,
        conversationId: turn.conversationId,
        candidateSegment,
        previouslyApprovedText,
        riskDecision,
      },
      signal,
    );
    if (result.status === 'replacement') {
      throw new OutputSafetyReplacement(result.text, result.cause);
    }
    return result.text;
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
}
