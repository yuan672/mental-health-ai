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
    }>;

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
    private readonly consents: ConsentsService,
    private readonly contextService: ConversationContextService,
    private readonly conversations: ConversationService,
    private readonly logging: AiOperationalLoggingService,
    @Inject(LLM_PROVIDER) private readonly provider: LLMProvider,
    @Inject(POST_GENERATION_SAFETY_GATE)
    private readonly postGenerationSafety: PostGenerationSafetyGate,
    @Inject(PRE_GENERATION_SAFETY_GATE)
    private readonly preGenerationSafety: PreGenerationSafetyGate,
    private readonly prompts: PromptService,
    private readonly quota: QuotaService,
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
    const prompt = this.prompts.getSupportiveChatPrompt();
    const claimed = await this.aiTurns.claim({
      userId: principal.userId,
      conversationId: conversation.id,
      clientRequestId: input.clientRequestId,
      promptKey: prompt.key,
      promptVersion: prompt.version,
      now,
    });
    if (!claimed.created) {
      return { kind: 'existing', turn: claimed.turn };
    }

    try {
      if (!(await this.quota.canUseAI(principal.userId, now))) {
        throw new QuotaExceededError();
      }
      if (signal.aborted) {
        throw signal.reason;
      }
      await this.preGenerationSafety.check(
        {
          userId: principal.userId,
          conversationId: conversation.id,
          message: input.message,
        },
        signal,
      );
      const context = await this.contextService.buildPersistentContext(
        principal.userId,
        conversation.id,
        input.message,
        now,
      );
      if (signal.aborted) {
        throw signal.reason;
      }
      const started = await this.aiTurns.start(claimed.turn, input.message, now);
      return { kind: 'ready', turn: started, context };
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

  async *streamPreparedTurn(
    prepared: Extract<PreparedAiTurn, { kind: 'ready' }>,
    clientSignal: AbortSignal,
  ): AsyncIterable<AiStreamEvent> {
    const { turn, context } = prepared;
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
        const wait = buffer.millisecondsUntilFlush();
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
          for (const candidate of buffer.append(event.text)) {
            const approved = await this.approveSegment(
              turn,
              candidate,
              approvedText,
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

      const remainder = buffer.flush();
      if (remainder) {
        const approved = await this.approveSegment(
          turn,
          remainder,
          approvedText,
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
      const timedOut =
        error instanceof ProviderEventTimeout ||
        generationController.signal.reason instanceof ProviderEventTimeout;
      const clientCancelled = clientSignal.aborted && !timedOut;
      const category = timedOut ? 'timeout' : failureCategory(error);

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

  private async approveSegment(
    turn: AiTurnRecord,
    candidateSegment: string,
    previouslyApprovedText: string,
    signal: AbortSignal,
  ): Promise<string> {
    return this.postGenerationSafety.approve(
      {
        userId: turn.userId,
        conversationId: turn.conversationId,
        candidateSegment,
        previouslyApprovedText,
      },
      signal,
    );
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
