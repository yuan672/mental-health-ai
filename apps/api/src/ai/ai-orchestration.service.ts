import { Inject, Injectable } from '@nestjs/common';
import type {
  IncognitoAiChatRequest,
  IncognitoAiStreamEvent,
  PersistentAiChatRequest,
  PersistentAiStreamEvent,
} from '@mental-health/types';
import {
  AIChatDisabledError,
  AIProviderError,
  AIProviderTimeoutError,
  AITurnInProgressError,
  ConflictError,
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
import { AiTurnService } from './turns/ai-turn.service';
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
  type ConsentBoundExecution,
} from './runtime/active-ai-execution.registry';
import { IncognitoGenerationAdmissionService } from './incognito/incognito-generation-admission.service';
import {
  INCOGNITO_CONTEXT_STORE,
  type IncognitoContextStore,
  type IncognitoGenerationClaim,
  IncognitoContextLimitError,
} from './incognito/incognito-context.store';

export type AuthenticatedAiPrincipal = Readonly<{
  userId: string;
  sessionId: string;
}>;

type PersistentAiTurnInput = Omit<PersistentAiChatRequest, 'mode'> & {
  mode?: 'persistent';
};

export type AiTurnExecutionDeadline = ConsentBoundExecution;

export type PreparedAiTurn =
  | Readonly<{ kind: 'existing'; turn: AiTurnRecord }>
  | Readonly<{
      kind: 'ready';
      turn: AiTurnRecord;
      context: ConversationContext;
      riskDecision: RiskDecision;
      execution: AiTurnExecutionDeadline;
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
      pendingExecution.dispose();
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

      const prompt = this.generationPromptFor(admission.riskDecision);
      const context = this.contextService.buildIncognitoContext(
        admission.context.messages,
        input.message,
        prompt.key as 'supportive-chat' | 'supportive-chat-safety' | 'high-risk-support',
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
        await this.quota.refundQuota(principal.userId, admission.quotaIdempotencyKey, now);
        throw new AIIncognitoContextLostError();
      }
      await this.consentExecutions.assertStillUsable(execution);
      throwIfAborted(execution.signal);
      throwIfAborted(admission.generation.signal);
      return {
        kind: 'ready',
        principal,
        input,
        context,
        riskDecision: admission.riskDecision,
        generation: admission.generation,
        quotaIdempotencyKey: admission.quotaIdempotencyKey,
        execution,
      };
    } catch (error) {
      if (admission.kind === 'generation') {
        await this.quota.refundQuota(principal.userId, admission.quotaIdempotencyKey, now);
      }
      this.releaseIncognitoGeneration(principal, input.contextId, admission.generation.id);
      execution.dispose();
      if (error instanceof IncognitoContextLimitError) {
        throw new ValidationError('无痕对话上下文已达到容量限制，请重新开始');
      }
      throw error;
    }
  }

  async preparePersistentTurn(
    principal: AuthenticatedAiPrincipal,
    input: PersistentAiTurnInput,
    signal: AbortSignal,
    now = new Date(),
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
        } finally {
          execution.dispose();
        }
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
        try {
          this.assertPersistentConversationBinding(claimed.turn, input.conversationId);
        } finally {
          execution.dispose();
        }
        return { kind: 'existing', turn: claimed.turn };
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

        const prompt = this.generationPromptFor(riskDecision);
        const context = await this.contextService.buildPersistentContext(
          principal.userId,
          conversation.id,
          input.message,
          now,
          prompt.key as 'supportive-chat' | 'supportive-chat-safety' | 'high-risk-support',
        );
        throwIfAborted(execution.signal);
        await this.consentExecutions.assertStillUsable(execution);
        const started = await this.consentExecutions.runWhileUsable(execution, () =>
          this.aiTurns.start(claimed.turn, input.message, prompt, riskDecision, now),
        );
        await this.consentExecutions.assertStillUsable(execution);
        throwIfAborted(execution.signal);
        return { kind: 'ready', turn: started, context, riskDecision, execution };
      } catch (error) {
        const timedOut = execution.signal.reason instanceof AiExecutionTotalTimeoutError;
        const cancelled = execution.signal.aborted && !timedOut;
        try {
          await this.aiTurns.finish(
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
        throw error;
      }
    } catch (error) {
      pendingExecution.dispose();
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
  ): AsyncIterable<PersistentAiStreamEvent> {
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

    yield {
      type: 'turn.started',
      data: { mode: 'persistent', turnId: turn.id, conversationId: turn.conversationId },
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
        {
          signal: generationController.signal,
          startTransport: this.consentExecutions.starter(
            prepared.execution,
            'generation',
            generationController.signal,
          ),
        },
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
              deliveredSegments += 1;
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
              deliveredSegments += 1;
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
          deliveredSegments += 1;
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
      const timedOut =
        error instanceof ProviderEventTimeout ||
        generationController.signal.reason instanceof ProviderEventTimeout ||
        generationController.signal.reason instanceof AiExecutionTotalTimeoutError ||
        prepared.execution.signal.reason instanceof AiExecutionTotalTimeoutError;
      const clientCancelled = clientSignal.aborted && !timedOut;
      const category = timedOut ? 'timeout' : failureCategory(error);

      if (
        riskDecision.status === 'assessed' &&
        riskDecision.level === 'HIGH' &&
        !clientCancelled &&
        deliveredSegments === 0 &&
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
  ): AsyncIterable<IncognitoAiStreamEvent> {
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

    yield {
      type: 'turn.started',
      data: { mode: 'incognito', generationId: generation.id },
    };

    try {
      throwIfAborted(generation.signal);
      const stream = this.provider.streamChat(
        {
          requestId: generation.id,
          messages: context.messages,
          maxOutputTokens: env.LLM_MAX_OUTPUT_TOKENS,
        },
        {
          signal: generationController.signal,
          startTransport: this.consentExecutions.starter(
            prepared.execution,
            'generation',
            generationController.signal,
          ),
        },
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
              deliveredSegments += 1;
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
              deliveredSegments += 1;
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
          deliveredSegments += 1;
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
          if (deliveredSegments === 0) {
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

      const timedOut =
        error instanceof ProviderEventTimeout ||
        generationController.signal.reason instanceof ProviderEventTimeout ||
        prepared.execution.signal.reason instanceof AiExecutionTotalTimeoutError;
      const cancelled = (clientSignal.aborted || generation.signal.aborted) && !timedOut;
      const category = timedOut ? 'timeout' : failureCategory(error);

      if (
        riskDecision.status === 'assessed' &&
        riskDecision.level === 'HIGH' &&
        !cancelled &&
        deliveredSegments === 0 &&
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

      const shouldRefund = deliveredSegments === 0 && (!cancelled || !providerInvoked);
      if (shouldRefund) {
        await this.quota.refundQuota(principal.userId, prepared.quotaIdempotencyKey);
      }
      if (cancelled) {
        this.logging.turnCancelled(metadata, 'client_disconnect', Date.now() - generationStartedAt);
        throw new AIProviderError('AI 对话已取消');
      }
      this.logging.turnFailed(metadata, category, Date.now() - generationStartedAt);
      if (timedOut) throw new AIProviderTimeoutError();
      if (error instanceof AIProviderError) throw error;
      throw new AIProviderError();
    } finally {
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
    let failure: unknown = null;
    try {
      if (prepared.kind === 'ready') {
        try {
          await this.quota.refundQuota(prepared.turn.userId, prepared.turn.id);
        } catch (error) {
          failure = error;
        }
        try {
          await this.aiTurns.finish(
            prepared.turn,
            'cancelled',
            'CANCELLED_BEFORE_PROVIDER',
            new Date(),
          );
        } catch (error) {
          failure ??= error;
        }
      }
    } finally {
      if (prepared.kind !== 'existing') prepared.execution.dispose();
    }
    if (failure) throw failure;
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
